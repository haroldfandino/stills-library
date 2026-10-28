import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { DriveFile, ProjectRow, RootVerification, SourceKey } from '../google/types.js';
import type { GoogleWorkspace } from '../google/workspace.js';
import { planRenames } from '../core/extraction.js';
import type { VideoCandidate } from '../core/media.js';
import type { AppState } from '../shared/contracts.js';
import type { WorkflowFunctions } from './workflow.js';
import { JsonStore } from './storage.js';
import { WorkflowService } from './workflow.js';

const PROJECT = '[203SB]Airwaav_Brager';
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

class FakeWorkspace {
  rows: ProjectRow[] = [{ source: 'screenbridge', rowNumber: 2, name: PROJECT, status: 'To Do' }];
  files: DriveFile[] = [];
  folders: DriveFile[] = [];
  versionCreates = 0;
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
    const item = [...this.files, ...this.folders].find(file => file.id === id);
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
    await this.getFile(folderId);
    return [...this.files, ...this.folders].filter(file => file.parents?.includes(folderId) && !(file as DriveFile & { trashed?: boolean }).trashed).map(file => ({ ...file }));
  }

  async ensureVersionDestination(projectFolderId: string, versionName: string): Promise<DriveFile> {
    let folder = this.folders.find(item => item.name === versionName && item.parents?.includes(projectFolderId) && !(item as DriveFile & { trashed?: boolean }).trashed);
    if (!folder) {
      this.versionCreates++;
      folder = { id: `version-${this.versionCreates}`, name: versionName,
        mimeType: 'application/vnd.google-apps.folder', parents: [projectFolderId] };
      this.folders.push(folder);
    }
    return this.verifyVersionDestination(projectFolderId, versionName, folder.id);
  }

  async verifyVersionDestination(projectFolderId: string, versionName: string, folderId: string): Promise<DriveFile> {
    const folder = await this.getFile(folderId);
    if (folder.mimeType !== 'application/vnd.google-apps.folder' || folder.name !== versionName
        || folder.parents?.length !== 1 || folder.parents[0] !== projectFolderId) {
      throw new Error('Version folder moved or changed');
    }
    return folder;
  }

  async reviseVerifiedPng(fileId: string, folderId: string, previousName: string, nextName: string | null, md5: string, size: number, uploadId: string, previousAliases: string[] = []): Promise<void> {
    const file = this.files.find(item => item.id === fileId)! as DriveFile & { trashed?: boolean };
    if (!file || file.md5Checksum !== md5 || file.size !== String(size) || file.appProperties?.stillsLibraryUploadId !== uploadId || !file.parents?.includes(folderId)) throw new Error('Ownership mismatch');
    if (nextName === null && file.trashed) return;
    if (file.trashed || (file.name !== previousName && file.name !== nextName && !previousAliases.includes(file.name))) throw new Error('Unexpected name');
    if (nextName === null) file.trashed = true;
    else file.name = nextName;
  }

  async trashEmptyDeliveryFolder(id: string, parentId: string, name: string): Promise<boolean> {
    const folder = this.folders.find(file => file.id === id)! as DriveFile & { trashed?: boolean };
    if (!folder || folder.name !== name || folder.parents?.[0] !== parentId) throw new Error('Changed folder');
    if (folder.trashed) return true;
    if ((await this.listFolderFiles(id)).length) return false;
    folder.trashed = true;
    return true;
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
      const folder = path.join(stagingRoot, `renamed-test-${randomUUID()}`);
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
  await store.update(data => {
    data.config.sourceRoots = { filmkraft: directory, screenbridge: directory };
  });
  return { service: await create(), create, workspace, counters, directory };
}

const VERSION_NAMES = ['01_Mustela_Baby', '02_Mustela_Parents'];

async function waitBatch(service: WorkflowService) {
  for (let i = 0; i < 400; i++) {
    if (service.getState().batch?.status !== 'running') {
      // The final status is persisted before the worker finishes writing its
      // report. Drain it before fixture cleanup removes the state directory.
      await (service as unknown as { batchWorker?: Promise<void> }).batchWorker;
      return service.getState().batch!;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Batch did not finish');
}

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Expected pipeline state was not reached');
}

test('automatic pipeline resumes a committed upload without re-exporting or duplicating it', async () => {
  const fixture = await setup();
  const session = await fixture.service.prepare('screenbridge', '203SB');
  await fixture.service.approveVideos(session.id, ['video-1']);
  fixture.workspace.failAfterCreate = true;
  const failed = await fixture.service.approveStills(session.id, ['video-1:7'], { project: 'Airwaav', type: 'Brager', year: '2026' });
  expect(failed.status).toBe('error');
  const store = new JsonStore(fixture.directory);
  await store.load();
  await store.update(data => {
    data.batch = { id: 'restart-pipeline', status: 'paused', startedAt: '', updatedAt: '',
      reportPath: path.join(fixture.directory, 'report.html'), excluded: [],
      entries: [{ project: data.projects[0], sessionId: session.id, status: 'running' }] };
  });
  const restarted = await fixture.create();
  await restarted.startBatch(true);
  const run = await waitBatch(restarted);
  expect(run.entries[0].status).toBe('done');
  expect(fixture.workspace.uploads).toBe(1);
  expect(fixture.counters.exports).toBe(1);
  expect(fixture.workspace.files).toHaveLength(1);
});

describe('overlapping preparation and single-project delivery', () => {
  test('queues saves from separate human reviews with one uploader and distinct destinations', async () => {
    const workspace = new FakeWorkspace();
    workspace.rows = [203, 204].map((code, i) => ({ source: 'screenbridge', rowNumber: i + 2, name: `[${code}SB]Project_2026`, status: 'To Do' }));
    const folders = new Map<string, DriveFile>();
    workspace.findOrCreateProjectFolder = async (_source, name) => {
      const folder = { id: name, name, mimeType: 'application/vnd.google-apps.folder', parents: ['year-folder'] };
      folders.set(name, folder); return folder;
    };
    const getFile = workspace.getFile.bind(workspace);
    workspace.getFile = async id => folders.get(id) ?? getFile(id);
    workspace.verifyProjectFolder = async (_source, name, _year, id) => {
      const folder = await workspace.getFile(id); expect(folder.name).toBe(name); return folder;
    };
    const fixture = await setup(workspace);
    const first = await fixture.service.prepare('screenbridge', '203SB');
    await fixture.service.approveVideos(first.id, ['video-1']);
    const second = await fixture.service.prepare('screenbridge', '204SB');
    await fixture.service.approveVideos(second.id, ['video-1']);
    const gate = latch();
    const originalUpload = workspace.uploadPng.bind(workspace);
    let active = 0, peak = 0, calls = 0;
    workspace.uploadPng = async input => {
      active++; peak = Math.max(peak, active);
      try { if (calls++ === 0) await gate.promise; return await originalUpload(input); }
      finally { active--; }
    };
    const saveA = fixture.service.approveStills(first.id, ['video-1:7'], { project: 'ProjectA', type: 'Final', year: '2026' });
    await until(() => active === 1);
    const saveB = fixture.service.approveStills(second.id, ['video-1:7'], { project: 'ProjectB', type: 'Final', year: '2026' });
    expect(fixture.service.getSession(second.id)?.status).toBe('awaiting_stills');
    gate.release();
    expect((await saveA).status).toBe('done');
    expect((await saveB).status).toBe('done');
    expect(peak).toBe(1);
    expect(workspace.files.map(f => f.name).sort()).toEqual(['ProjectA_Final_Still_01.png', 'ProjectB_Final_Still_01.png']);
    expect(fixture.service.getSession(first.id)?.destinationFolderId).not.toBe(fixture.service.getSession(second.id)?.destinationFolderId);
  });

  test.each([false, true])('prepares the whole backlog, preserves waiting exports on pause (upload failure: %s)', async (failUpload) => {
    const workspace = new FakeWorkspace();
    workspace.rows = [203, 204, 205].map((code, i) => ({ source: 'screenbridge', rowNumber: i + 2,
      name: `[${code}SB]Project_2026`, status: 'To Do' }));
    const folders = new Map<string, DriveFile>();
    workspace.findOrCreateProjectFolder = async (_source, name) => {
      const folder = { id: name, name, mimeType: 'application/vnd.google-apps.folder', parents: ['year-folder'] };
      folders.set(name, folder);
      return folder;
    };
    const getFile = workspace.getFile.bind(workspace);
    workspace.getFile = async id => folders.get(id) ?? getFile(id);
    workspace.verifyProjectFolder = async (_source, name, _year, id) => {
      const folder = await workspace.getFile(id);
      expect(folder.name).toBe(name);
      return folder;
    };
    const gate = latch();
    const originalUpload = workspace.uploadPng.bind(workspace);
    let activeUploads = 0;
    let maxUploads = 0;
    let calls = 0;
    workspace.uploadPng = async input => {
      activeUploads++;
      maxUploads = Math.max(maxUploads, activeUploads);
      const first = calls++ === 0;
      try {
        if (first) { await gate.promise; if (failUpload) throw new Error('Temporary upload failure'); }
        return await originalUpload(input);
      } finally { activeUploads--; }
    };
    const fixture = await setup(workspace);
    for (const row of workspace.rows) await fs.mkdir(path.join(fixture.directory, '02_ActiveProjects', row.name), { recursive: true });
    await fixture.service.startBatch(true);
    try {
      await until(() => fixture.counters.exports === 3 && activeUploads === 1);
      expect(fixture.counters.analyses).toBe(3);
      expect(fixture.service.getState().batch!.entries.map(e => e.status)).toEqual(['running', 'running', 'running']);
      const firstSession = fixture.service.getState().batch!.entries[0].sessionId!;
      expect(() => fixture.service.resume(firstSession)).toThrow(/automatic queue/);
      await expect(fixture.service.prepare('screenbridge', '203SB')).rejects.toThrow(/automatic queue/);
      await expect(fixture.service.setSource('screenbridge', fixture.directory)).rejects.toThrow(/automatic queue/);
      await fixture.service.pauseBatch();
    } finally { gate.release(); }
    const paused = await waitBatch(fixture.service);
    expect(paused.status).toBe('paused');
    expect(paused.entries.map(e => e.status)).toEqual([failUpload ? 'failed' : 'done', 'running', 'running']);
    expect(maxUploads).toBe(1);
    expect(fixture.counters.analyses).toBe(3);
    await fixture.service.startBatch(true);
    const finished = await waitBatch(fixture.service);
    expect(finished.status).toBe('complete');
    expect(finished.entries[1].status).toBe('done');
    expect(finished.entries[2].status).toBe('done');
    expect(fixture.counters.exports).toBe(3);
    expect(fixture.counters.analyses).toBe(3);
    expect(maxUploads).toBe(1);
  });
});

describe('explicit automatic queue', () => {
  test('does not reuse one source folder for different rows sharing a code', async () => {
    const fixture = await setup();
    fixture.workspace.rows.push({ source: 'screenbridge', rowNumber: 3, name: '[203SB]Different_Client', status: 'To Do' });
    await fs.mkdir(path.join(fixture.directory, '01_ActiveProjects', PROJECT), { recursive: true });
    await fixture.service.startBatch(true);
    const batch = await waitBatch(fixture.service);
    expect(batch.entries.map(e => e.status)).toEqual(['done', 'failed']);
    expect(batch.entries[1].reason).toMatch(/shared by multiple/);
    expect(fixture.workspace.rows[1].status).toBe('To Do');
    expect(fixture.workspace.uploads).toBe(1);
  });
  test('retries missing projects from added Drive roots without redoing completed deliveries', async () => {
    const fixture = await setup();
    await fixture.service.startBatch(true);
    while (fixture.service.automaticRunning) await new Promise(resolve => setTimeout(resolve, 5));
    expect(fixture.service.getState().batch?.entries[0].status).toBe('skipped');
    const drive = path.join(fixture.directory, '03_ArchivedProjects');
    await fs.mkdir(path.join(drive, '2025', PROJECT), { recursive: true });
    await fixture.service.addSource(drive, 'https://drive.google.com/drive/folders/example');
    await fixture.service.retryMissingSources(true);
    while (fixture.service.automaticRunning) await new Promise(resolve => setTimeout(resolve, 5));
    expect(fixture.service.getState().batch?.entries[0].status).toBe('done');
    expect(fixture.workspace.uploads).toBe(1);
    await fixture.service.retryMissingSources(true);
    while (fixture.service.automaticRunning) await new Promise(resolve => setTimeout(resolve, 5));
    expect(fixture.workspace.uploads).toBe(1);
  });
  test('skips missing sources, delivers an archived project, and preserves existing Done rows', async () => {
    const fixture = await setup();
    fixture.workspace.rows.unshift({ source: 'screenbridge', rowNumber: 3, name: '[999]Missing', status: 'To Do' });
    fixture.workspace.rows.push({ source: 'screenbridge', rowNumber: 4, name: '[888]Already_Done', status: 'Done' });
    await fs.mkdir(path.join(fixture.directory, '02_ArchivedProjects', '2025', PROJECT), { recursive: true });
    await expect(fixture.service.startBatch(false)).rejects.toThrow(/explicit approval/);
    await fixture.service.startBatch(true);
    const batch = await waitBatch(fixture.service);
    expect(batch.status).toBe('complete');
    expect(batch.entries.map(e => e.status)).toEqual(['skipped', 'done']);
    expect(batch.excluded[0].status).toBe('Done');
    expect(fixture.workspace.uploads).toBe(1);
    expect(await fs.readFile(batch.reportPath, 'utf8')).toContain('Open Drive');
    const restored = await fixture.create();
    expect(restored.getState().batch?.entries).toEqual(batch.entries);
  });

  test('records technical failures separately and continues to the next project', async () => {
    const fixture = await setup(new FakeWorkspace(), { analyzeVideos: async () => { throw new Error('Decoder failed'); } });
    fixture.workspace.rows.push({ source: 'screenbridge', rowNumber: 3, name: '[999]Missing', status: 'To Do' });
    await fs.mkdir(path.join(fixture.directory, '01_ActiveProjects', PROJECT), { recursive: true });
    await fixture.service.startBatch(true);
    const batch = await waitBatch(fixture.service);
    expect(batch.entries.map(e => e.status)).toEqual(['failed', 'skipped']);
    expect(fixture.workspace.rows[0].status).toBe('In Process');
    expect(fixture.service.getSession(batch.entries[0].sessionId!)?.deferred).toBe(true);
    expect(fixture.workspace.uploads).toBe(0);
  });

  test('pauses on unavailable mounts without changing the Sheet', async () => {
    const fixture = await setup();
    const store = new JsonStore(fixture.directory);
    await store.load();
    await store.update(data => { data.config.sourceRoots.filmkraft = path.join(fixture.directory, 'offline'); });
    const service = await fixture.create();
    await service.startBatch(true);
    expect((await waitBatch(service)).status).toBe('paused');
    expect(fixture.workspace.statusChanges).toEqual([]);
  });

  test('retries failed delivery using saved approval and keeps completed entries intact', async () => {
    const fixture = await setup();
    fixture.workspace.existingYear = '2025';
    await fs.mkdir(path.join(fixture.directory, '01_ActiveProjects', PROJECT), { recursive: true });
    await fixture.service.startBatch(true);
    expect((await waitBatch(fixture.service)).entries[0].status).toBe('failed');
    fixture.workspace.existingYear = String(new Date().getUTCFullYear());
    const restored = await fixture.create();
    await restored.retryBatchFailures();
    expect((await waitBatch(restored)).entries[0].status).toBe('done');
    expect(fixture.workspace.uploads).toBe(1);
  });
});
const NAMING = { project: 'Mustela', type: 'Brand', year: '2026' };

async function setupVersions(workspace = new FakeWorkspace()) {
  const counts = { analyses: 0, exports: 0 };
  const videos: VideoCandidate[] = VERSION_NAMES.map((version, index) => ({
    id: `video-${index + 1}`,
    path: `C:\\source\\${PROJECT}\\11_FINAL_DELIVERY\\01_Videos\\${version}\\Mustela_30_Social_H264.mp4`,
    name: 'Mustela_30_Social_H264.mp4', variant: 'Main', durationSec: 30,
    aspect: 'horizontal', codec: 'h264', format: 'mp4', selected: true,
    width: 1920, height: 1080, channel: 'social', voiceover: 'none', declaredDurationSec: 30,
  }));
  const result = await setup(workspace, {
    discoverProjectVideos: async () => ({ projectFolder: `C:\\source\\${PROJECT}`,
      deliveryFolder: `C:\\source\\${PROJECT}\\11_FINAL_DELIVERY\\01_Videos`, warnings: [], videos }),
    analyzeVideos: async () => {
      counts.analyses++;
      return {
        analyses: videos.map(video => ({ videoId: video.id, videoName: video.name,
          analysisPath: `/staging/${video.id}/analysis.json`, candidateFrameIds: [7, 8], selectedFrameIds: [7], warnings: [] })),
        frames: videos.flatMap(video => [7, 8].map(frameId => ({ id: `${video.id}:${frameId}`, videoId: video.id,
          frameId, videoName: video.name, previewPath: `/staging/${video.id}/${frameId}.jpg`,
          timecode: `00:00:0${frameId}.000`, shotId: frameId, score: 0.9, reasons: [], selected: frameId === 7 }))),
      };
    },
    exportApprovedFrames: async (_analyses, ids, stagingRoot) => {
      counts.exports++;
      return Promise.all([...ids].reverse().map(async id => {
        const [videoId, frame] = id.split(':');
        const frameId = Number(frame);
        const sourcePath = path.join(stagingRoot, `${videoId}-${frameId}.png`);
        await fs.writeFile(sourcePath, Buffer.concat([PNG, Buffer.from(id)]));
        return { videoId, videoName: videos.find(video => video.id === videoId)!.name,
          frameId, sourcePath, shotId: frameId, timestampSec: frameId, score: 0.9 };
      }));
    },
  });
  const discovered = await result.service.prepare('screenbridge', '203SB');
  const analyzed = await result.service.approveVideos(discovered.id, videos.map(video => video.id));
  expect(analyzed.status, analyzed.error).toBe('awaiting_stills');
  return { ...result, counters: counts, analyzed };
}

async function editSavedState(directory: string, edit: (state: AppState) => void): Promise<void> {
  const stateFile = path.join(directory, 'state.json');
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8')) as AppState;
  edit(state);
  await fs.writeFile(stateFile, JSON.stringify(state));
}

interface TestUpload {
  videoId: string;
  targetName: string;
  fileId?: string;
  folderId?: string;
  versionName?: string;
  status: string;
}

describe('creative-version workflow routing', () => {
  test('delivers exact numbered source versions separately with global approved-order numbering', async () => {
    const { service, workspace, analyzed } = await setupVersions();
    expect(analyzed.versionFolders).toEqual({ 'video-1': VERSION_NAMES[0], 'video-2': VERSION_NAMES[1] });
    const done = await service.approveStills(analyzed.id, ['video-2:7', 'video-1:7'], NAMING);
    expect(done.status, done.error).toBe('done');
    const items = done.uploadResults as TestUpload[];
    expect(items.map(item => [item.videoId, item.targetName, item.versionName])).toEqual([
      ['video-2', 'Mustela_Brand_Still_01.png', VERSION_NAMES[1]],
      ['video-1', 'Mustela_Brand_Still_02.png', VERSION_NAMES[0]],
    ]);
    expect(new Set(items.map(item => item.folderId)).size).toBe(2);
    for (const item of items) {
      expect(workspace.files.find(file => file.id === item.fileId)?.parents).toEqual([item.folderId]);
      expect(workspace.folders.find(folder => folder.id === item.folderId)?.name).toBe(item.versionName);
    }
    expect(workspace.files.every(file => !file.parents?.includes('project-folder'))).toBe(true);
    expect(workspace.statusChanges).toEqual(['In Process', 'Done']);
  });

  test('delivers nested aspect/version paths and persists routes across restart', async () => {
    const { create, directory, workspace, analyzed } = await setupVersions();
    await editSavedState(directory, state => {
      const session = state.sessions[0];
      session.videos[1].aspect = 'square';
      session.versionFolders = { 'video-1': `Horizontal/${VERSION_NAMES[0]}`, 'video-2': `Square/${VERSION_NAMES[1]}` };
    });
    workspace.failAfterCreate = true;
    const service = await create();
    const paused = await service.approveStills(analyzed.id, ['video-1:7', 'video-2:7'], NAMING);
    expect(paused.status).toBe('error');
    const done = await (await create()).resume(analyzed.id);
    expect(done.status, done.error).toBe('done');
    expect(workspace.uploads).toBe(2);
    const routes = done.uploadResults as TestUpload[];
    for (const item of routes) {
      const leaf = await workspace.getFile(item.folderId!);
      const aspect = await workspace.getFile(leaf.parents![0]);
      expect(`${aspect.name}/${leaf.name}`).toBe(item.versionName);
    }
  });

  test('checks filename conflicts only in the approved target version folder', async () => {
    const { service, workspace, analyzed } = await setupVersions();
    const first = await workspace.ensureVersionDestination('project-folder', VERSION_NAMES[0]);
    const second = await workspace.ensureVersionDestination('project-folder', VERSION_NAMES[1]);
    const prior = { id: 'other-version-image', name: 'Mustela_Brand_Still_01.png', mimeType: 'image/png', parents: [second.id] };
    workspace.files.push(prior);
    const done = await service.approveStills(analyzed.id, ['video-1:7'], NAMING);
    expect(done.status, done.error).toBe('done');
    expect(workspace.uploads).toBe(1);
    expect(workspace.files.find(file => file.id !== prior.id)?.parents).toEqual([first.id]);
    expect(workspace.files.find(file => file.id === prior.id)).toEqual(prior);

    const blockedSetup = await setupVersions();
    const blockedFolder = await blockedSetup.workspace.ensureVersionDestination('project-folder', VERSION_NAMES[0]);
    blockedSetup.workspace.files.push({ ...prior, parents: [blockedFolder.id] });
    const blocked = await blockedSetup.service.approveStills(blockedSetup.analyzed.id, ['video-1:7'], NAMING);
    expect(blocked.status).toBe('awaiting_stills');
    expect(blocked.error).toContain('Destination already contains');
    expect(blockedSetup.workspace.uploads).toBe(0);
  });

  test('resumes a version upload committed before a lost response without creating duplicate folders or PNGs', async () => {
    const { service, create, workspace, analyzed } = await setupVersions();
    workspace.failAfterCreate = true;
    const paused = await service.approveStills(analyzed.id, ['video-1:7', 'video-2:7'], NAMING);
    expect(paused.status).toBe('error');
    expect(workspace.uploads).toBe(1);
    expect(workspace.versionCreates).toBe(2);
    const routes = (paused.uploadResults as TestUpload[]).map(item => [item.folderId, item.versionName]);
    const resumed = await (await create()).resume(paused.id);
    expect(resumed.status, resumed.error).toBe('done');
    expect(workspace.uploads).toBe(2);
    expect(workspace.files).toHaveLength(2);
    expect(workspace.versionCreates).toBe(2);
    expect((resumed.uploadResults as TestUpload[]).map(item => [item.folderId, item.versionName])).toEqual(routes);
  });

  test('keeps the Sheet In Process if a version folder moves during upload', async () => {
    const { service, workspace, analyzed } = await setupVersions();
    const upload = workspace.uploadPng.bind(workspace);
    workspace.uploadPng = async input => {
      const result = await upload(input);
      workspace.folders.find(folder => folder.id === input.folderId)!.parents = ['another-project'];
      return result;
    };
    const paused = await service.approveStills(analyzed.id, ['video-1:7'], NAMING);
    expect(paused.status).toBe('error');
    expect(paused.error).toContain('Version folder moved or changed');
    expect(workspace.statusChanges).toEqual(['In Process']);
    expect(workspace.uploads).toBe(1);
  });

  test('resumes an old flat upload plan without rerouting videos into new version folders', async () => {
    const { service, create, workspace, directory, analyzed } = await setupVersions();
    workspace.failAfterCreate = true;
    const paused = await service.approveStills(analyzed.id, ['video-1:7', 'video-2:7'], NAMING);
    await editSavedState(directory, state => {
      const session = state.sessions.find(item => item.id === paused.id)!;
      delete session.versionFolders;
      for (const item of session.uploadResults as TestUpload[]) {
        delete item.folderId;
        delete item.versionName;
      }
    });
    workspace.files[0].parents = ['project-folder'];
    workspace.folders = [];
    workspace.versionCreates = 0;
    const done = await (await create()).resume(paused.id);
    expect(done.status, done.error).toBe('done');
    expect(workspace.versionCreates).toBe(0);
    expect(workspace.uploads).toBe(2);
    expect(workspace.files.every(file => file.parents?.[0] === 'project-folder')).toBe(true);
    expect((done.uploadResults as TestUpload[]).every(item => !item.folderId && !item.versionName)).toBe(true);
  });

  test('rejects an incomplete saved version route instead of falling back to the project folder', async () => {
    const { service, create, workspace, directory, analyzed } = await setupVersions();
    workspace.failAfterCreate = true;
    const paused = await service.approveStills(analyzed.id, ['video-1:7', 'video-2:7'], NAMING);
    await editSavedState(directory, state => {
      delete (state.sessions[0].uploadResults as TestUpload[])[1].folderId;
    });
    const resumed = await (await create()).resume(paused.id);
    expect(resumed.status).toBe('error');
    expect(resumed.error).toContain('Saved upload plan is incomplete');
    expect(workspace.uploads).toBe(1);
    expect(workspace.statusChanges).toEqual(['In Process']);
  });
});

test('GUI summaries omit candidate history while on-demand details and full status remain available', async () => {
  const { service, analyzed } = await setupVersions();
  const summary = service.getState(false).sessions.find(session => session.id === analyzed.id)!;
  expect(summary.frames).toEqual([]);
  expect(summary.analyses).toBeUndefined();
  const detail = service.getSessionView(analyzed.id)!;
  expect(detail.frames).toEqual(analyzed.frames);
  expect(detail.analyses).toBeUndefined();
  expect(service.getState().sessions.find(session => session.id === analyzed.id)?.analyses).toEqual(analyzed.analyses);
});

describe('reviewing a completed delivery again', () => {
  test('limits open reviews and frees a slot without changing the closed project revision', async () => {
    const { service, create, directory, analyzed } = await setupVersions();
    const done = await service.approveStills(analyzed.id, ['video-1:7'], NAMING);
    const limit = service.getState().reviewLimit!;
    await editSavedState(directory, state => {
      for (let i = 0; i < limit; i++) state.sessions.push({ ...state.sessions[0], id: `open-${i}`, status: 'awaiting_videos', deferred: false });
    });
    const loaded = await create();
    await expect(loaded.reviewAgain(done.id)).rejects.toThrow(`keep ${limit} reviews open`);
    const before = loaded.getSession('open-0')!;
    await loaded.setReviewOpen('open-0', false);
    expect(loaded.getSession('open-0')).toMatchObject({ deferred: true, updatedAt: before.updatedAt, selectedFrameIds: before.selectedFrameIds });
    await loaded.reviewAgain(done.id);
    await expect(loaded.setReviewOpen('open-0', true)).rejects.toThrow(`keep ${limit} reviews open`);
    await loaded.setReviewOpen(done.id, false);
    await loaded.setReviewOpen('open-0', true);
    expect(loaded.getSession('open-0')?.deferred).toBe(false);
  });
  test('human review toggles Done and Reviewed without changing a delivery, and reopening clears the mark', async () => {
    const { service, workspace, counters, analyzed } = await setupVersions();
    const done = await service.approveStills(analyzed.id, ['video-1:7'], NAMING);
    const before = structuredClone(workspace.files);
    await service.setReviewed(done.studio, done.projectId, true);
    expect(workspace.rows[0].status).toBe('Reviewed');
    expect(service.getState().projects.find(p => p.id === done.projectId)?.status).toBe('Reviewed');
    await service.setReviewed(done.studio, done.projectId, false);
    expect(workspace.rows[0].status).toBe('Done');
    await service.setReviewed(done.studio, done.projectId, true);
    expect(workspace.files).toEqual(before);
    expect(counters).toEqual({ analyses: 1, exports: 1 });
    await service.reviewAgain(done.id);
    expect(workspace.rows[0].status).toBe('In Process');
    await expect(service.setReviewed(done.studio, done.projectId, true)).rejects.toThrow('Save or finish');
  });

  test('refuses a stale human review checkbox when the sheet changes', async () => {
    const { service, workspace, analyzed } = await setupVersions();
    const done = await service.approveStills(analyzed.id, ['video-1:7'], NAMING);
    workspace.rows[0].status = 'Skip';
    await expect(service.setReviewed(done.studio, done.projectId, true)).rejects.toThrow('row changed');
    expect(workspace.rows[0].status).toBe('Skip');
  });

  test('archives delivery evidence and requires a fresh approval while retaining preview suggestions', async () => {
    const { service, create, workspace, counters, analyzed } = await setupVersions();
    const done = await service.approveStills(analyzed.id, ['video-1:7'], NAMING);
    expect(done.status).toBe('done');
    const savedPreviews = done.frames.map(frame => ({ ...frame }));
    const deliveredFiles = structuredClone(workspace.files);
    const reopened = await service.reviewAgain(done.id);
    expect(reopened.id).toBe(done.id);
    expect(reopened.status).toBe('awaiting_stills');
    expect(reopened.selectedFrameIds).toEqual(['video-1:7']);
    expect(reopened.frames).toEqual(savedPreviews);
    expect(reopened.analyses).toEqual(done.analyses);
    expect(reopened.exports).toBeUndefined();
    expect(reopened.uploadResults).toBeUndefined();
    expect(reopened.destinationFolderId).toBe('project-folder');
    const archived = JSON.parse(await fs.readFile(reopened.previousDeliveryManifest!, 'utf8'));
    expect(archived.status).toBe('done');
    expect(archived.uploadResults).toEqual(done.uploadResults);
    expect(archived.destinationFolderId).toBe('project-folder');
    expect(workspace.files).toEqual(deliveredFiles);
    expect(workspace.statusChanges).toEqual(['In Process', 'Done', 'In Process']);
    expect(counters).toEqual({ analyses: 1, exports: 1 });
    expect(workspace.uploads).toBe(1);

    const restarted = await create();
    expect((await restarted.resume(reopened.id)).status).toBe('awaiting_stills');
    expect(counters.exports).toBe(1);
    expect(workspace.uploads).toBe(1);
    const deliveredAgain = await restarted.approveStills(reopened.id, ['video-2:8'], { ...NAMING, type: 'Revised' });
    expect(deliveredAgain.status, deliveredAgain.error).toBe('done');
    expect(counters.exports).toBe(2);
    expect(workspace.uploads).toBe(2);
    expect(workspace.files.find(file => file.id === deliveredFiles[0].id)).toMatchObject({ trashed: true });
  });

  test.each([1, 2, 3])('recovers revision interruption at operation %s without duplicate uploads', async failAt => {
    const { service, create, workspace, counters, analyzed } = await setupVersions();
    const done = await service.approveStills(analyzed.id, ['video-1:7', 'video-1:8'], NAMING);
    const retainedId = workspace.files[1].id;
    await service.reviewAgain(done.id);
    const original = workspace.reviseVerifiedPng.bind(workspace);
    let calls = 0;
    workspace.reviseVerifiedPng = async (...args) => {
      await original(...args);
      if (++calls === failAt) throw new Error('Connection lost after revision committed');
    };
    const failed = await service.approveStills(done.id, ['video-1:8', 'video-2:7'], NAMING);
    expect(failed.status).toBe('error');
    const resumed = await (await create()).resume(done.id);
    expect(resumed.status, resumed.error).toBe('done');
    expect(workspace.uploads).toBe(3);
    expect(counters).toEqual({ analyses: 1, exports: 2 });
    const active = workspace.files.filter(file => !(file as DriveFile & { trashed?: boolean }).trashed);
    expect(active).toHaveLength(2);
    expect(active[0].id).toBe(retainedId);
    expect(active.map(file => file.name)).toEqual([expect.stringMatching(/_01\.png$/), expect.stringMatching(/_02\.png$/)]);
    expect(resumed.revision).toBeUndefined();
  });

  test('removal-only revision preserves retained file IDs, performs zero uploads, and trashes empty video folders', async () => {
    const { service, workspace, counters, analyzed } = await setupVersions();
    const done = await service.approveStills(analyzed.id, ['video-1:7', 'video-2:7'], NAMING);
    const retainedId = workspace.files[1].id;
    const oldFolder = workspace.files[0].parents![0];
    await service.reviewAgain(done.id);
    const result = await service.approveStills(done.id, ['video-2:7'], NAMING);
    expect(result.status, result.error).toBe('done');
    expect(workspace.uploads).toBe(2);
    expect(counters.exports).toBe(1);
    expect(workspace.files[1].id).toBe(retainedId);
    expect(workspace.files[1].name).toMatch(/_01\.png$/);
    expect(workspace.files[0]).toMatchObject({ trashed: true });
    expect(workspace.folders.find(folder => folder.id === oldFolder)).toMatchObject({ trashed: true });
  });

  test('resumes the old all-files temporary-name checkpoint without reuploading', async () => {
    const { service, create, workspace, analyzed } = await setupVersions();
    const done = await service.approveStills(analyzed.id, ['video-1:7', 'video-2:7'], NAMING);
    await service.reviewAgain(done.id);
    const revise = workspace.reviseVerifiedPng.bind(workspace);
    workspace.reviseVerifiedPng = async () => { throw new Error('Paused'); };
    const failed = await service.approveStills(done.id, ['video-2:7'], NAMING);
    expect(failed.status).toBe('error');
    for (const file of workspace.files) file.name = `stills-revision-${failed.revision!.id}-${file.appProperties!.stillsLibraryUploadId}.png`;
    workspace.reviseVerifiedPng = revise;
    const resumed = await (await create()).resume(done.id);
    expect(resumed.status, resumed.error).toBe('done');
    expect(workspace.uploads).toBe(2);
  });

  test('removes an unused aspect folder after its last version folder is empty', async () => {
    const { service, create, workspace, directory, analyzed } = await setupVersions();
    await editSavedState(directory, state => {
      state.sessions.find(item => item.id === analyzed.id)!.videos[1].aspect = 'vertical';
    });
    const current = await create();
    const done = await current.approveStills(analyzed.id, ['video-1:7', 'video-2:7'], NAMING);
    await current.reviewAgain(done.id);
    const revised = await current.approveStills(done.id, ['video-2:7'], NAMING);
    expect(revised.status, revised.error).toBe('done');
    expect(workspace.folders.find(folder => folder.name === 'Horizontal')).toMatchObject({ trashed: true });
    expect(workspace.folders.find(folder => folder.name === 'Vertical')).not.toHaveProperty('trashed');
    expect(workspace.uploads).toBe(2);
  });

  test('recovers a folder cleanup committed before the response was received', async () => {
    const { service, create, workspace, analyzed } = await setupVersions();
    const done = await service.approveStills(analyzed.id, ['video-1:7', 'video-2:7'], NAMING);
    await service.reviewAgain(done.id);
    const cleanup = workspace.trashEmptyDeliveryFolder.bind(workspace);
    let failed = false;
    workspace.trashEmptyDeliveryFolder = async (...args) => {
      const result = await cleanup(...args);
      if (!failed) { failed = true; throw new Error('Lost cleanup response'); }
      return result;
    };
    const paused = await service.approveStills(done.id, ['video-2:7'], NAMING);
    expect(paused.status).toBe('error');
    const resumed = await (await create()).resume(done.id);
    expect(resumed.status, resumed.error).toBe('done');
    expect(workspace.uploads).toBe(2);
  });

  test('keeps a removed video folder containing unrelated files', async () => {
    const { service, workspace, analyzed } = await setupVersions();
    const done = await service.approveStills(analyzed.id, ['video-1:7', 'video-2:7'], NAMING);
    const oldFolder = workspace.files[0].parents![0];
    workspace.files.push({ id: 'unrelated', name: 'notes.txt', mimeType: 'text/plain', parents: [oldFolder] });
    await service.reviewAgain(done.id);
    const result = await service.approveStills(done.id, ['video-2:7'], NAMING);
    expect(result.status, result.error).toBe('done');
    expect(workspace.folders.find(folder => folder.id === oldFolder)).not.toHaveProperty('trashed');
    expect(workspace.files.find(file => file.id === 'unrelated')).not.toHaveProperty('trashed');
  });

  test('upgrades a previously reopened review from its archived delivery without touching Drive', async () => {
    const { service, create, directory, workspace, analyzed } = await setupVersions();
    const done = await service.approveStills(analyzed.id, ['video-1:7'], NAMING);
    await service.reviewAgain(done.id);
    await editSavedState(directory, state => {
      const session = state.sessions.find(item => item.id === done.id)!;
      delete session.revision; delete session.destinationFolderId;
      session.selectedFrameIds = [];
    });
    const upgraded = await create();
    expect(upgraded.getSession(done.id)?.revision?.uploads).toEqual(done.uploadResults);
    expect(upgraded.getSession(done.id)?.selectedFrameIds).toEqual([]);
    expect(workspace.uploads).toBe(1);
    const revised = await upgraded.approveStills(done.id, ['video-1:8'], NAMING);
    expect(revised.status, revised.error).toBe('done');
    expect(workspace.files[0]).toMatchObject({ trashed: true });
  });

  test('uses retained delivery copies when original export paths are no longer present', async () => {
    const { service, workspace, analyzed } = await setupVersions();
    const done = await service.approveStills(analyzed.id, ['video-1:7', 'video-1:8'], NAMING);
    for (const item of done.exports as { sourcePath: string }[]) await fs.unlink(item.sourcePath);
    await service.reviewAgain(done.id);
    const revised = await service.approveStills(done.id, ['video-1:8'], NAMING);
    expect(revised.status, revised.error).toBe('done');
    expect(workspace.uploads).toBe(2);
  });

  test('can remove all stills, then add a new selection without reanalysis', async () => {
    const { service, workspace, counters, analyzed } = await setupVersions();
    const done = await service.approveStills(analyzed.id, ['video-1:7'], NAMING);
    await service.reviewAgain(done.id);
    await expect(service.skip(done.id)).rejects.toThrow('revision');
    const empty = await service.approveStills(done.id, [], NAMING);
    expect(empty.status, empty.error).toBe('done');
    expect(empty.uploadResults).toEqual([]);
    await service.reviewAgain(done.id);
    const added = await service.approveStills(done.id, ['video-2:8'], NAMING);
    expect(added.status, added.error).toBe('done');
    expect(workspace.uploads).toBe(2);
    expect(counters.analyses).toBe(1);
  });

  test.each(['Skip', 'To Do'])('rechecks the Sheet and refuses to reopen a row now marked %s', async status => {
    const { service, workspace, counters, analyzed } = await setupVersions();
    const done = await service.approveStills(analyzed.id, ['video-1:7'], NAMING);
    workspace.rows[0].status = status;
    await expect(service.reviewAgain(done.id)).rejects.toThrow(`Cannot reopen a row marked ${status}`);
    expect(service.getSession(done.id)?.status).toBe('done');
    expect(counters.exports).toBe(1);
    expect(workspace.uploads).toBe(1);
    expect(workspace.statusChanges).toEqual(['In Process', 'Done']);
  });

  test('refuses unfinished delivery but allows reopening alongside another human review', async () => {
    const { service, create, directory, analyzed } = await setupVersions();
    await expect(service.reviewAgain(analyzed.id)).rejects.toThrow('Only a completed delivery');
    const done = await service.approveStills(analyzed.id, ['video-1:7'], NAMING);
    await editSavedState(directory, state => {
      state.sessions.push({ ...state.sessions[0], id: 'another-session', projectName: '[204SB]Other', status: 'awaiting_videos' });
    });
    expect((await (await create()).reviewAgain(done.id)).status).toBe('awaiting_stills');
  });
});

describe('WorkflowService approval and delivery', () => {
  test('lists repeated project codes with distinct row IDs and rejects ambiguous preparation', async () => {
    const { service, workspace } = await setup();
    workspace.rows.push(
      { source: 'screenbridge', rowNumber: 3, name: '[203SB]Another_Campaign', status: 'To Do' },
      { source: 'filmkraft', rowNumber: 2, name: '[203SB]Separate_Studio', status: 'To Do' },
    );
    const projects = await service.listProjects();
    expect(projects.map(project => [project.studio, project.id, project.code])).toEqual([
      ['screenbridge', 'row-2', '203SB'], ['screenbridge', 'row-3', '203SB'], ['filmkraft', '203SB', '203SB'],
    ]);
    await expect(service.prepare('screenbridge', '203SB')).rejects.toThrow(/multiple Stills rows.*row-2.*row-3/);
    expect(workspace.statusChanges).toEqual([]);
    const selected = await service.prepare('screenbridge', 'row-3');
    expect(selected.projectId).toBe('row-3');
    expect(selected.projectRow).toBe(3);
    expect(selected.projectName).toBe('[203SB]Another_Campaign');
    expect(workspace.rows[0].status).toBe('To Do');
    expect(workspace.rows[1].status).toBe('In Process');
  });

  test('keeps an existing session attached to its exact row when its code becomes duplicated', async () => {
    const { service, workspace } = await setup();
    const original = await service.prepare('screenbridge', '203SB');
    workspace.rows.push({ source: 'screenbridge', rowNumber: 3, name: '[203SB]Another_Campaign', status: 'To Do' });
    await service.listProjects();
    expect(service.getSession(original.id)?.projectId).toBe('row-2');
    expect(JSON.parse(await fs.readFile(original.manifestPath!, 'utf8')).projectId).toBe('row-2');
    expect((await service.prepare('screenbridge', 'row-2')).id).toBe(original.id);
    await expect(service.prepare('screenbridge', '203SB')).rejects.toThrow(/multiple Stills rows/);
    expect(workspace.statusChanges).toEqual(['In Process']);
  });

  test('rejects an empty source root instead of using the working directory', async () => {
    const { service } = await setup();
    await expect(service.setSource('screenbridge', '  ')).rejects.toThrow(/Choose the mounted studio source folder/);
  });

  test('requires a configured source root before changing the Sheet', async () => {
    const { create, workspace, directory } = await setup();
    const stateFile = path.join(directory, 'state.json');
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    state.config.sourceRoots.screenbridge = '';
    await fs.writeFile(stateFile, JSON.stringify(state));
    const service = await create();
    const paused = await service.prepare('screenbridge', '203SB');
    expect(paused.status).toBe('error');
    expect(paused.error).toContain('Choose the Screenbridge source folder in Setup');
    expect(workspace.statusChanges).toEqual([]);
  });

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
    expect(discovered.naming?.year).toBe(String(new Date().getUTCFullYear()));
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

  test.each(['Done', 'Skip', 'To Do'])('pauses before export when a reviewed Sheet row changes to %s', async status => {
    const { service, workspace, counters } = await setup();
    const discovered = await service.prepare('screenbridge', '203SB');
    const analyzed = await service.approveVideos(discovered.id, ['video-1']);
    workspace.rows[0].status = status;
    const paused = await service.approveStills(analyzed.id, ['video-1:7'],
      { project: 'Airwaav', type: 'Brager', year: '2026' });
    expect(paused.status).toBe('awaiting_stills');
    expect(paused.error).toContain(`Stills row changed to ${status}`);
    expect(counters.exports).toBe(0);
    expect(workspace.uploads).toBe(0);
  });

  test('rechecks the Sheet after a long export and before creating the destination', async () => {
    const workspace = new FakeWorkspace();
    let foldersCreated = 0;
    workspace.findOrCreateProjectFolder = async () => {
      foldersCreated++;
      throw new Error('Should not create a folder');
    };
    const { service } = await setup(workspace, {
      exportApprovedFrames: async (_analyses, _ids, stagingRoot) => {
        const sourcePath = path.join(stagingRoot, 'exported.png');
        await fs.writeFile(sourcePath, PNG);
        workspace.rows[0].status = 'Skip';
        return [{ videoId: 'video-1', videoName: 'Airwaav_30_Social_H264.mp4', frameId: 7,
          sourcePath, shotId: 1, timestampSec: 1, score: 0.9 }];
      },
    });
    const discovered = await service.prepare('screenbridge', '203SB');
    const analyzed = await service.approveVideos(discovered.id, ['video-1']);
    const paused = await service.approveStills(analyzed.id, ['video-1:7'],
      { project: 'Airwaav', type: 'Brager', year: '2026' });
    expect(paused.error).toContain('Stills row changed to Skip');
    expect(foldersCreated).toBe(0);
    expect(workspace.uploads).toBe(0);
  });

  test('recovers a completed Sheet update after a crash without uploading again', async () => {
    const { service, create, workspace, directory } = await setup();
    const discovered = await service.prepare('screenbridge', '203SB');
    const analyzed = await service.approveVideos(discovered.id, ['video-1']);
    const done = await service.approveStills(analyzed.id, ['video-1:7'],
      { project: 'Airwaav', type: 'Brager', year: '2026' });
    const stateFile = path.join(directory, 'state.json');
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    state.sessions[0].status = 'uploading';
    state.sessions[0].lastPhase = 'uploading';
    await fs.writeFile(stateFile, JSON.stringify(state));
    const restarted = await create();
    expect(restarted.getSession(done.id)?.status).toBe('error');
    expect(restarted.getSession(done.id)?.lastPhase).toBe('uploading');
    expect((await restarted.resume(done.id)).status).toBe('done');
    expect(workspace.uploads).toBe(1);
    expect(workspace.statusChanges).toEqual(['In Process', 'Done']);
  });

  test('makes an interrupted analysis resumable after restarting the app', async () => {
    const { service, create, counters, directory } = await setup();
    const discovered = await service.prepare('screenbridge', '203SB');
    const stateFile = path.join(directory, 'state.json');
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    state.sessions[0].status = 'analyzing';
    state.sessions[0].lastPhase = 'analyzing';
    await fs.writeFile(stateFile, JSON.stringify(state));
    const restarted = await create();
    const paused = restarted.getSession(discovered.id);
    expect(paused?.status).toBe('error');
    expect(paused?.lastPhase).toBe('analyzing');
    expect(counters.analyses).toBe(0);
    expect((await restarted.resume(discovered.id)).status).toBe('awaiting_stills');
    expect(counters.analyses).toBe(1);
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
    const outside = await service.setProjectSource(paused.id, directory);
    expect(outside.status).toBe('awaiting_videos');
    expect(outside.manualSourcePath).toBe(await fs.realpath(directory));
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

  test('recovers a skipped project with a manually selected source and stops for video approval', async () => {
    const { service, directory, workspace } = await setup();
    const review = await service.prepare('screenbridge', '203SB');
    await service.skip(review.id);
    const chosen = path.join(directory, 'Selected final videos');
    await fs.mkdir(chosen);
    const recovered = await service.setProjectSource(review.id, chosen);
    expect(recovered.status).toBe('awaiting_videos');
    expect(recovered.manualSourcePath).toBe(await fs.realpath(chosen));
    expect(workspace.statusChanges).toEqual(['In Process', 'Skip', 'To Do', 'In Process']);
    expect(workspace.uploads).toBe(0);
  });
});


describe('recovering legacy Picker access failures', () => {
  test('opens and resumes an existing review without waiting behind another project upload', async () => {
    const fixture = await setup();
    const prepared = await fixture.service.prepare('screenbridge', '203SB');
    await fixture.service.setReviewOpen(prepared.id, false);
    const gate = latch();
    const slow = (fixture.service as any).serial(() => gate.promise);
    try {
      const resumed = await fixture.service.resume(prepared.id);
      expect(resumed).toMatchObject({ status: 'awaiting_videos', deferred: false, updatedAt: prepared.updatedAt });
      await fixture.service.setReviewOpen(prepared.id, false);
      expect(fixture.service.getSession(prepared.id)?.deferred).toBe(true);
      expect(fixture.counters).toEqual({ analyses: 0, exports: 0 });
      expect(fixture.workspace.uploads).toBe(0);
    } finally { gate.release(); await slow; }
  });
  test('resumes saved video discovery without waiting for another project or probing videos again', async () => {
    let discoveries = 0;
    const fixture = await setup(undefined, { discoverProjectVideos: async () => {
      discoveries++;
      return { projectFolder: '/saved', deliveryFolder: '/saved/delivery', warnings: [], videos: [{
        id: 'cached', name: 'Airwaav_30.mp4', path: '/saved/Airwaav_30.mp4', durationSec: 30, aspect: 'horizontal',
        codec: 'h264', format: 'mp4', variant: 'Main', selected: true, width: 1920, height: 1080,
        channel: 'social', voiceover: 'none', declaredDurationSec: 30,
      }] };
    } });
    const prepared = await fixture.service.prepare('screenbridge', '203SB');
    await editSavedState(fixture.directory, data => {
      const s = data.sessions.find(s => s.id === prepared.id)!;
      s.status = 'error'; s.lastPhase = 'discovering'; s.error = 'Google Picker access is required for this project.'; s.deferred = true;
    });
    const loaded = await fixture.create();
    const gate = latch();
    const slow = (loaded as any).serial(() => gate.promise);
    try {
      const one = loaded.resume(prepared.id);
      const duplicate = loaded.resume(prepared.id);
      expect(duplicate).toBe(one);
      const resumed = await one;
      expect(resumed).toMatchObject({ status: 'awaiting_videos', deferred: false, error: undefined, selectedVideoIds: ['cached'] });
      expect(discoveries).toBe(1);
      expect(fixture.counters).toEqual({ analyses: 0, exports: 0 });
      expect(fixture.workspace.uploads).toBe(0);
    } finally { gate.release(); await slow; }
  });
  test('keeps other recovered projects closed and reports real access failures without losing cached videos', async () => {
    const fixture = await setup();
    const prepared = await fixture.service.prepare('screenbridge', '203SB');
    await editSavedState(fixture.directory, data => {
      const s = data.sessions.find(s => s.id === prepared.id)!;
      s.status = 'error'; s.lastPhase = 'discovering'; s.error = 'Google Picker access is required.'; s.deferred = true;
    });
    const loaded = await fixture.create();
    fixture.workspace.preflightProjectDestination = async () => { throw new Error('Destination year is ambiguous.'); };
    const failed = await loaded.recoverDriveAccess(prepared.id);
    expect(failed).toMatchObject({ status: 'error', deferred: true, error: 'Destination year is ambiguous.' });
    expect(failed.videos).toEqual(prepared.videos);
    expect(fixture.workspace.uploads).toBe(0);
    expect(fixture.counters).toEqual({ analyses: 0, exports: 0 });
  });
});
