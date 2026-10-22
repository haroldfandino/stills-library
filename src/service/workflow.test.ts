import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { DriveFile, ProjectRow, RootVerification, SourceKey } from '../google/types.js';
import type { GoogleWorkspace } from '../google/workspace.js';
import { planRenames } from '../core/extraction.js';
import type { WorkflowFunctions } from './workflow.js';
import { JsonStore } from './storage.js';
import { WorkflowService } from './workflow.js';

const PROJECT = '[203SB]Airwaav_Brager';
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

class FakeWorkspace {
  rows: ProjectRow[] = [{ source: 'screenbridge', rowNumber: 2, name: PROJECT, status: 'To Do' }];
  files: DriveFile[] = [];
  statusChanges: string[] = [];
  uploads = 0;
  verifications = 0;
  failAfterCreate = false;
  failVerification = false;
  existingYear = '2026';
  duplicateAfterVerify = false;

  async verifyRoots(): Promise<Record<SourceKey, RootVerification>> {
    return {
      screenbridge: { source: 'screenbridge', sheetOk: true, folderOk: true, requiresPicker: false },
      filmkraft: { source: 'filmkraft', sheetOk: true, folderOk: true, requiresPicker: false },
    };
  }

  async preflightProjectDestination(): Promise<void> {}

  async listProjects(source?: SourceKey): Promise<ProjectRow[]> {
    return this.rows.filter(row => !source || row.source === source).map(row => ({ ...row }));
  }

  async updateStatus(row: ProjectRow, next: 'To Do' | 'In Process' | 'Done' | 'Skip', expected: string): Promise<ProjectRow> {
    const current = this.rows.find(item => item.source === row.source && item.rowNumber === row.rowNumber);
    if (!current || current.name !== row.name || current.status !== expected) throw new Error('Sheet status changed');
    current.status = next;
    this.statusChanges.push(next);
    return { ...current };
  }

  async findOrCreateProjectFolder(source: SourceKey, name: string, year?: string): Promise<DriveFile> {
    expect(source).toBe('screenbridge');
    expect(name).toBe(PROJECT);
    if (year !== this.existingYear) throw new Error(`${name} already exists under ${this.existingYear}, not ${year}.`);
    return { id: 'project-folder', name, mimeType: 'application/vnd.google-apps.folder',
      parents: ['year-folder'], webViewLink: 'https://drive.google.com/drive/folders/project-folder' };
  }

  async getFile(id: string): Promise<DriveFile> {
    if (id === 'project-folder') return this.findOrCreateProjectFolder('screenbridge', PROJECT, this.existingYear);
    const item = this.files.find(file => file.id === id);
    if (!item) throw new Error('Missing Drive file');
    return { ...item };
  }

  async ensureFolderAuthorized(id: string): Promise<DriveFile> {
    return this.getFile(id);
  }

  async verifyProjectFolder(source: SourceKey, name: string, year: string, id: string): Promise<DriveFile> {
    expect(source).toBe('screenbridge');
    expect(name).toBe(PROJECT);
    expect(year).toBe(this.existingYear);
    return this.ensureFolderAuthorized(id);
  }

  async listFolderFiles(folderId: string): Promise<DriveFile[]> {
    expect(folderId).toBe('project-folder');
    return this.files.map(file => ({ ...file }));
  }

  async uploadPng(input: { folderId: string; filePath: string; fileName: string; uploadId: string }): Promise<DriveFile> {
    this.uploads++;
    const bytes = await fs.readFile(input.filePath);
    const created: DriveFile = { id: randomUUID(), name: input.fileName, mimeType: 'image/png',
      parents: [input.folderId], size: String(bytes.length), md5Checksum: createHash('md5').update(bytes).digest('hex'),
      appProperties: { stillsLibraryUploadId: input.uploadId } };
    this.files.push(created);
    if (this.failAfterCreate) { this.failAfterCreate = false; throw new Error('Connection lost after Drive committed upload'); }
    return { ...created };
  }

  async verifyUploadedPng(fileId: string, folderId: string, fileName: string, md5: string, size: number, uploadId: string): Promise<DriveFile> {
    this.verifications++;
    if (this.failVerification) throw new Error('Drive metadata verification failed');
    const file = this.files.find(item => item.id === fileId);
    if (!file || !file.parents?.includes(folderId) || file.name !== fileName || file.size !== String(size)
        || file.md5Checksum !== md5 || file.appProperties?.stillsLibraryUploadId !== uploadId) throw new Error('Drive metadata mismatch');
    if (this.duplicateAfterVerify) {
      this.files.push({ ...file, id: 'concurrent-duplicate' });
      this.duplicateAfterVerify = false;
    }
    return { ...file };
  }
}

async function setup(workspace = new FakeWorkspace(), overrides: Partial<WorkflowFunctions> = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stills-workflow-'));
  tempDirs.push(directory);
  const store = new JsonStore(directory);
  const counters = { analyses: 0, exports: 0 };
  const functions: Partial<WorkflowFunctions> = {
    discoverProjectVideos: async () => ({ projectFolder: '/source/[203SB]Airwaav_Brager',
      deliveryFolder: '/source/[203SB]Airwaav_Brager/11_FINAL_DELIVERY/01_Videos', warnings: [],
      videos: [{ id: 'video-1', path: '/source/video.mp4', name: 'Airwaav_30_Social_H264.mp4',
        durationSec: 30, aspect: 'horizontal', codec: 'h264', format: 'mp4', variant: 'Main',
        selected: true, width: 1920, height: 1080, channel: 'social', voiceover: 'none',
        declaredDurationSec: 30 }] }),
    discoverProjectFolderVideos: async ({ projectFolder }) => ({ projectFolder,
      deliveryFolder: path.join(projectFolder, '11_FINAL_DELIVERY', '01_Videos'), warnings: [],
      videos: [{ id: 'video-1', path: path.join(projectFolder, 'video.mp4'), name: 'Airwaav_30_Social_H264.mp4',
        durationSec: 30, aspect: 'horizontal', codec: 'h264', format: 'mp4', variant: 'Main',
        selected: true, width: 1920, height: 1080, channel: 'social', voiceover: 'none',
        declaredDurationSec: 30 }] }),
    analyzeVideos: async () => {
      counters.analyses++;
      return { analyses: [{ videoId: 'video-1', videoName: 'Airwaav_30_Social_H264.mp4',
        analysisPath: '/staging/analysis.json', candidateFrameIds: [7], selectedFrameIds: [7], warnings: [] }],
        frames: [{ id: 'video-1:7', videoId: 'video-1', frameId: 7,
          videoName: 'Airwaav_30_Social_H264.mp4', previewPath: '/staging/preview.png',
          timecode: '00:00:01.000', shotId: 1, score: 0.9, reasons: [], selected: true }] };
    },
    exportApprovedFrames: async (_analyses, _ids, stagingRoot) => {
      counters.exports++;
      const file = path.join(stagingRoot, 'exported.png');
      await fs.writeFile(file, PNG);
      return [{ videoId: 'video-1', videoName: 'Airwaav_30_Social_H264.mp4', frameId: 7,
        sourcePath: file, shotId: 1, timestampSec: 1, score: 0.9 }];
    },
    stageAndRenameApprovedStills: async (plan, stagingRoot) => {
      const folder = path.join(stagingRoot, 'renamed-test');
      await fs.mkdir(folder, { recursive: true });
      const files = await Promise.all(plan.items.map(async item => {
        const renamedPath = path.join(folder, item.targetName);
        await fs.copyFile(item.sourcePath, renamedPath);
        return { ...item, renamedPath };
      }));
      return { stagingFolder: folder, files };
    },
  };
  const create = async () => {
    const service = new WorkflowService({ store: new JsonStore(directory),
      getWorkspace: () => workspace as unknown as GoogleWorkspace,
      extractTool: () => ({ command: 'unused' }), renameTool: () => ({ command: 'unused' }),
      functions: { ...functions, ...overrides }, stagingRoot: path.join(directory, 'staging') });
    await service.initialize();
    return service;
  };
  await store.load();
  return { service: await create(), create, workspace, counters, directory };
}

describe('WorkflowService approval and delivery', () => {
  test('human Skip updates the Stills row before any upload', async () => {
    const { service, workspace } = await setup();
    const discovered = await service.prepare('screenbridge', '203SB');
    const skipped = await service.skip(discovered.id);
    expect(skipped.status).toBe('skipped');
    expect(workspace.statusChanges).toEqual(['In Process', 'Skip']);
    expect(workspace.uploads).toBe(0);
  });

  test('stops at both approval gates and marks Done only after verified delivery', async () => {
    const { service, workspace, counters } = await setup();
    const discovered = await service.prepare('screenbridge', '203SB');
    expect(discovered.status).toBe('awaiting_videos');
    expect(workspace.statusChanges).toEqual(['In Process']);
    expect(counters.analyses).toBe(0);
    expect(workspace.uploads).toBe(0);

    const analyzed = await service.approveVideos(discovered.id, ['video-1']);
    expect(analyzed.status).toBe('awaiting_stills');
    expect(counters.analyses).toBe(1);
    expect(counters.exports).toBe(0);
    expect(workspace.uploads).toBe(0);

    const done = await service.approveStills(analyzed.id, ['video-1:7'], { project: 'Airwaav', type: 'Brager', year: '2026' });
    expect(done.status, done.error).toBe('done');
    expect(done.destinationUrl).toBe('https://drive.google.com/drive/folders/project-folder');
    expect(workspace.statusChanges).toEqual(['In Process', 'Done']);
    expect(workspace.uploads).toBe(1);
    expect(workspace.verifications).toBeGreaterThan(0);
    expect(service.getState().projects.find(project => project.id === '203SB')?.status).toBe('Done');
    expect(JSON.parse(await fs.readFile(done.manifestPath!, 'utf8')).status).toBe('done');
  });

  test('preexisting filename collision returns to naming review without uploading', async () => {
    const { service, workspace } = await setup();
    const discovered = await service.prepare('screenbridge', '203SB');
    const analyzed = await service.approveVideos(discovered.id, ['video-1']);
    workspace.files.push({ id: 'preexisting', name: 'Airwaav_Brager_Still_01.png',
      mimeType: 'image/png', parents: ['project-folder'], size: String(PNG.length),
      md5Checksum: createHash('md5').update(PNG).digest('hex') });
    const paused = await service.approveStills(analyzed.id, ['video-1:7'], { project: 'Airwaav', type: 'Brager', year: '2026' });
    expect(paused.status).toBe('awaiting_stills');
    expect(paused.error).toMatch(/Destination already contains/);
    expect(workspace.uploads).toBe(0);
    expect(workspace.statusChanges).toEqual(['In Process']);
  });

  test('wrong destination year returns to still review so it can be corrected', async () => {
    const { service, workspace } = await setup();
    const discovered = await service.prepare('screenbridge', '203SB');
    const analyzed = await service.approveVideos(discovered.id, ['video-1']);
    const paused = await service.approveStills(analyzed.id, ['video-1:7'],
      { project: 'Airwaav', type: 'Brager', year: '2025' });
    expect(paused.status).toBe('awaiting_stills');
    expect(paused.error).toMatch(/already exists under 2026/);
    expect(workspace.uploads).toBe(0);
    const done = await service.approveStills(paused.id, ['video-1:7'],
      { project: 'Airwaav', type: 'Brager', year: '2026' });
    expect(done.status).toBe('done');
  });

  test('reapproval discards a pre-upload export and resolves a changed destination year', async () => {
    const workspace = new FakeWorkspace();
    let firstPlan = true;
    const { service, counters } = await setup(workspace, {
      planRenames: (files, tags, existing) => {
        if (firstPlan) {
          firstPlan = false;
          throw new Error('Review the delivery plan');
        }
        return planRenames(files, tags, existing);
      },
    });
    const discovered = await service.prepare('screenbridge', '203SB');
    const analyzed = await service.approveVideos(discovered.id, ['video-1']);
    const paused = await service.approveStills(analyzed.id, ['video-1:7'],
      { project: 'Airwaav', type: 'Brager', year: '2026' });
    expect(paused.status).toBe('awaiting_stills');
    expect(paused.destinationFolderId).toBe('project-folder');
    workspace.existingYear = '2027';
    const done = await service.approveStills(paused.id, ['video-1:7'],
      { project: 'Airwaav', type: 'Brager', year: '2027' });
    expect(done.status).toBe('done');
    expect(counters.exports).toBe(2);
  });

  test('records a reviewer skip without exporting or uploading', async () => {
    const { service, workspace, counters } = await setup();
    const review = await service.prepare('screenbridge', '203SB');
    const skipped = await service.skip(review.id);
    expect(skipped.status).toBe('skipped');
    expect(workspace.statusChanges).toEqual(['In Process', 'Skip']);
    expect(counters.analyses).toBe(0);
    expect(counters.exports).toBe(0);
    expect(workspace.uploads).toBe(0);
  });

  test('recovers its attempted upload after a connection loss without uploading twice', async () => {
    const { service, create, workspace } = await setup();
    const discovered = await service.prepare('screenbridge', '203SB');
    const analyzed = await service.approveVideos(discovered.id, ['video-1']);
    workspace.failAfterCreate = true;
    const paused = await service.approveStills(analyzed.id, ['video-1:7'], { project: 'Airwaav', type: 'Brager', year: '2026' });
    expect(paused.status).toBe('error');
    expect(workspace.statusChanges).toEqual(['In Process']);
    expect(workspace.uploads).toBe(1);
    const restarted = await create();
    const done = await restarted.resume(paused.id);
    expect(done.status, done.error).toBe('done');
    expect(workspace.uploads).toBe(1);
    expect(workspace.files).toHaveLength(1);
    expect(workspace.statusChanges).toEqual(['In Process', 'Done']);
  });

  test('does not adopt an identical external file after a lost upload response', async () => {
    const { service, create, workspace } = await setup();
    const discovered = await service.prepare('screenbridge', '203SB');
    const analyzed = await service.approveVideos(discovered.id, ['video-1']);
    workspace.failAfterCreate = true;
    const paused = await service.approveStills(analyzed.id, ['video-1:7'],
      { project: 'Airwaav', type: 'Brager', year: '2026' });
    expect(paused.status).toBe('error');
    workspace.files[0].appProperties = { stillsLibraryUploadId: randomUUID() };
    const restarted = await create();
    const blocked = await restarted.resume(paused.id);
    expect(blocked.status).toBe('error');
    expect(blocked.error).toMatch(/Destination already contains/);
    expect(workspace.uploads).toBe(1);
    expect(workspace.statusChanges).toEqual(['In Process']);
  });

  test('does not mark Done when Drive metadata verification fails', async () => {
    const { service, workspace } = await setup();
    const discovered = await service.prepare('screenbridge', '203SB');
    const analyzed = await service.approveVideos(discovered.id, ['video-1']);
    workspace.failVerification = true;
    const paused = await service.approveStills(analyzed.id, ['video-1:7'], { project: 'Airwaav', type: 'Brager', year: '2026' });
    expect(paused.status).toBe('error');
    expect(workspace.statusChanges).toEqual(['In Process']);
    expect(workspace.uploads).toBe(1);
  });

  test('does not mark Done if a concurrent duplicate appears after upload verification', async () => {
    const { service, workspace } = await setup();
    const discovered = await service.prepare('screenbridge', '203SB');
    const analyzed = await service.approveVideos(discovered.id, ['video-1']);
    workspace.duplicateAfterVerify = true;
    const paused = await service.approveStills(analyzed.id, ['video-1:7'],
      { project: 'Airwaav', type: 'Brager', year: '2026' });
    expect(paused.status).toBe('error');
    expect(paused.error).toMatch(/new filename conflict/);
    expect(workspace.statusChanges).toEqual(['In Process']);
  });

  test('numbers PNGs in the approved frame order even when the extractor returns files out of order', async () => {
    const { service } = await setup(new FakeWorkspace(), {
      analyzeVideos: async () => ({
        analyses: [{ videoId: 'video-1', videoName: 'Airwaav_30_Social_H264.mp4',
          analysisPath: '/staging/analysis.json', candidateFrameIds: [7, 8], selectedFrameIds: [7, 8], warnings: [] }],
        frames: [7, 8].map(id => ({ id: `video-1:${id}`, videoId: 'video-1', frameId: id,
          videoName: 'Airwaav_30_Social_H264.mp4', previewPath: `/staging/${id}.png`,
          timecode: `00:00:${id}.000`, shotId: id, score: 0.9, reasons: [], selected: true })),
      }),
      exportApprovedFrames: async (_analyses, _ids, stagingRoot) => {
        const output = [];
        for (const id of [8, 7]) {
          const file = path.join(stagingRoot, `${id}.png`);
          await fs.writeFile(file, Buffer.concat([PNG, Buffer.from([id])]));
          output.push({ videoId: 'video-1', videoName: 'Airwaav_30_Social_H264.mp4',
            frameId: id, sourcePath: file, shotId: id, timestampSec: id, score: 0.9 });
        }
        return output;
      },
    });
    const discovered = await service.prepare('screenbridge', '203SB');
    const analyzed = await service.approveVideos(discovered.id, ['video-1']);
    const done = await service.approveStills(analyzed.id, ['video-1:7', 'video-1:8'],
      { project: 'Airwaav', type: 'Brager', year: '2026' });
    expect(done.status).toBe('done');
    expect((done.uploadResults as { frameId: number; targetName: string }[]).map(item => [item.frameId, item.targetName]))
      .toEqual([[7, 'Airwaav_Brager_Still_01.png'], [8, 'Airwaav_Brager_Still_02.png']]);
  });

  test('lets a reviewer select a source folder for a row without a project code', async () => {
    const workspace = new FakeWorkspace();
    workspace.rows[0].name = 'Uncoded_Client_Project';
    const { service, directory } = await setup(workspace);
    const sourceRoot = path.join(directory, 'source');
    const selectedFolder = path.join(sourceRoot, 'Uncoded_Client_Project');
    await fs.mkdir(selectedFolder, { recursive: true });
    await service.setSource('screenbridge', sourceRoot);
    const paused = await service.prepare('screenbridge', 'row-2');
    expect(paused.status).toBe('error');
    expect(paused.error).toMatch(/Choose its project source folder/);
    expect(workspace.statusChanges).toEqual(['In Process']);
    await expect(service.setProjectSource(paused.id, directory)).rejects.toThrow(/inside the configured studio source root/);
    const discovered = await service.setProjectSource(paused.id, selectedFolder);
    expect(discovered.status).toBe('awaiting_videos');
    expect(discovered.manualSourcePath).toBe(await fs.realpath(selectedFolder));
    expect(discovered.videos).toHaveLength(1);
  });

  test('rejects a manually chosen folder with another project code', async () => {
    const { service, directory } = await setup();
    const sourceRoot = path.join(directory, 'source');
    const wrongFolder = path.join(sourceRoot, '[9999]Different_Project');
    await fs.mkdir(wrongFolder, { recursive: true });
    await service.setSource('screenbridge', sourceRoot);
    const review = await service.prepare('screenbridge', '203SB');
    expect(review.status).toBe('awaiting_videos');
    await expect(service.setProjectSource(review.id, wrongFolder)).rejects.toThrow(/does not match Stills project/);
    expect(service.getSession(review.id)?.status).toBe('awaiting_videos');
  });
});
