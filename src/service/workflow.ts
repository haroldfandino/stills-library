import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { GoogleWorkspace } from '../google/workspace.js';
import type { DriveFile, ProjectRow } from '../google/types.js';
import {
  discoverProjectVideos, discoverProjectFolderVideos, type VideoCandidate,
} from '../core/media.js';
import {
  analyzeVideos, exportApprovedFrames, planRenames, stageAndRenameApprovedStills,
  type AnalysisRecord, type CommandSpec, type ExportedStill,
} from '../core/extraction.js';
import type { AppState, Naming, Project, Session, SessionStatus, Studio } from '../shared/contracts.js';
import { dataDir } from '../shared/runtime.js';
import { JsonStore } from './storage.js';

export interface WorkflowFunctions {
  discoverProjectVideos: typeof discoverProjectVideos;
  discoverProjectFolderVideos: typeof discoverProjectFolderVideos;
  analyzeVideos: typeof analyzeVideos;
  exportApprovedFrames: typeof exportApprovedFrames;
  planRenames: typeof planRenames;
  stageAndRenameApprovedStills: typeof stageAndRenameApprovedStills;
}

export interface WorkflowOptions {
  store: JsonStore;
  getWorkspace: () => GoogleWorkspace;
  extractTool: () => CommandSpec;
  renameTool: () => CommandSpec;
  ffprobePath?: () => string;
  onChange?: () => void;
  stagingRoot?: string;
  previewUrl?: (absolutePath: string) => string;
  functions?: Partial<WorkflowFunctions>;
}

type UploadStatus = 'planned' | 'attempting' | 'verified';

interface PlannedUpload {
  videoId: string;
  frameId: number;
  sourcePath: string;
  renamedPath: string;
  targetName: string;
  size: number;
  md5: string;
  uploadId: string;
  status: UploadStatus;
  fileId?: string;
}

const TERMINAL = new Set<SessionStatus>(['done', 'skipped']);
const PNG_MIME = 'image/png';

function codeFromName(name: string): string | undefined {
  return /^\[([A-Z0-9]+)\]/i.exec(name.trim())?.[1].toUpperCase();
}

function projectYear(session: Session): string {
  if (session.naming?.year) {
    if (!/^20\d{2}$/.test(session.naming.year)) throw new Error('Delivery year must be a four-digit 20xx year.');
    return session.naming.year;
  }
  if (codeFromName(session.projectName) === '203SB') return '2026';
  const values = new Set<string>();
  const inspect = (text: string) => {
    for (const match of text.matchAll(/(?:^|[^0-9])(20\d{2})(?=$|[^0-9])/g)) values.add(match[1]);
  };
  inspect(session.projectName);
  if (session.sourcePath) inspect(path.basename(session.sourcePath));
  if (values.size === 1) return [...values][0];
  throw new Error(`Cannot determine the delivery year for ${session.projectName}. Add a year to the project name or source folder before delivery.`);
}

function projectFromRow(row: ProjectRow): Project {
  const code = codeFromName(row.name);
  return {
    id: code ?? `row-${row.rowNumber}`,
    studio: row.source,
    name: row.name,
    status: row.status,
    code,
    row: row.rowNumber,
  };
}

function defaultNaming(projectName: string): Naming {
  const code = codeFromName(projectName);
  const years = new Set(projectName.match(/20\d{2}/g) ?? []);
  const year = years.size === 1 ? [...years][0] : String(new Date().getFullYear());
  if (code === '203SB') return { project: 'Airwaav_Brager', type: 'PremiumAd', year };
  if (code === '1289') return { project: 'Net32_2026', type: 'Brand_Refresh', year };
  const withoutCode = projectName.replace(/^\[[^\]]+\]/, '').replace(/^[_\s-]+/, '');
  const project = withoutCode.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return { project, type: '', year };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertStudio(value: string): asserts value is Studio {
  if (value !== 'filmkraft' && value !== 'screenbridge') throw new Error(`Unknown studio: ${value}`);
}

function clone<T>(value: T): T { return structuredClone(value); }

async function fingerprint(file: string): Promise<{ size: number; md5: string }> {
  const size = (await fs.stat(file)).size;
  const hash = createHash('md5');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return { size, md5: hash.digest('hex') };
}

function uploadedItems(session: Session): PlannedUpload[] {
  if (!session.uploadResults?.length) return [];
  return session.uploadResults.map(raw => {
    const item = raw as PlannedUpload;
    if (!item || !['planned', 'attempting', 'verified'].includes(item.status)
        || !item.targetName || !item.renamedPath || !item.md5 || !item.uploadId
        || !Number.isSafeInteger(item.size)) {
      throw new Error('Saved upload plan is incomplete; no files will be uploaded.');
    }
    return item;
  });
}

/** Serial, persisted orchestration for the two human approval gates. */
export class WorkflowService {
  private readonly store: JsonStore;
  private readonly options: WorkflowOptions;
  private readonly functions: WorkflowFunctions;
  private readonly stagingRoot: string;
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(options: WorkflowOptions) {
    this.options = options;
    this.store = options.store;
    this.stagingRoot = options.stagingRoot ?? path.join(dataDir(), 'staging');
    this.functions = {
      discoverProjectVideos, discoverProjectFolderVideos, analyzeVideos, exportApprovedFrames, planRenames,
      stageAndRenameApprovedStills, ...options.functions,
    };
  }

  async initialize(): Promise<void> {
    await this.store.load();
    await fs.mkdir(this.stagingRoot, { recursive: true, mode: 0o700 });
    this.notify();
  }

  /** Main enriches this snapshot with the authenticated Google account. */
  getState(): AppState {
    const data = this.store.get();
    return {
      authenticated: false,
      configured: Boolean(data.config.googleClientId),
      projects: data.projects,
      sessions: data.sessions.map(session => this.withPreviewUrls(session)),
      currentSessionId: data.currentSessionId,
      sourceRoots: data.config.sourceRoots,
      destinationFolders: data.config.destinationFolders,
    };
  }

  notify(): void {
    try { this.options.onChange?.(); } catch { /* A UI subscriber cannot break persistence. */ }
  }

  getSession(id: string): Session | undefined {
    const session = this.store.get().sessions.find(item => item.id === id);
    return session ? this.withPreviewUrls(session) : undefined;
  }

  listProjects(): Promise<Project[]> {
    return this.serial(async () => this.refreshProjects());
  }

  configureGoogle(clientId: string): Promise<void> {
    return this.serial(async () => {
      const value = clientId.trim();
      if (!value || !value.endsWith('.apps.googleusercontent.com')) {
        throw new Error('Enter a Google desktop OAuth client ID ending in .apps.googleusercontent.com.');
      }
      await this.store.update(data => { data.config.googleClientId = value; });
      this.notify();
    });
  }

  setSource(studio: Studio, sourceRoot: string): Promise<void> {
    return this.serial(async () => {
      assertStudio(studio);
      const resolved = path.resolve(sourceRoot);
      if (!(await fs.stat(resolved)).isDirectory()) throw new Error(`${resolved} is not a folder.`);
      await this.store.update(data => { data.config.sourceRoots[studio] = resolved; });
      this.notify();
    });
  }

  setProjectSource(sessionId: string, projectFolder: string): Promise<Session> {
    return this.serial(async () => {
      const session = this.requireSession(sessionId);
      if (!(session.status === 'awaiting_videos'
          || (session.status === 'error' && session.lastPhase === 'discovering'))) {
        throw new Error('Choose a project source before approving videos.');
      }
      const sourceRoot = await fs.realpath(this.store.get().config.sourceRoots[session.studio]);
      const folder = await fs.realpath(projectFolder);
      if (!(await fs.stat(folder)).isDirectory()) throw new Error('Selected project source is not a folder.');
      const relative = path.relative(sourceRoot, folder);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('Project source must be a folder inside the configured studio source root.');
      }
      const expectedCode = codeFromName(session.projectName);
      const chosenCode = codeFromName(path.basename(folder));
      if (expectedCode && chosenCode && expectedCode !== chosenCode) {
        throw new Error(`Selected folder [${chosenCode}] does not match Stills project [${expectedCode}].`);
      }
      const updated = await this.saveSession({ ...session,
        sourcePath: folder, manualSourcePath: folder,
        status: 'discovering', lastPhase: 'discovering', error: undefined,
        videos: [], frames: [], selectedVideoIds: [], selectedFrameIds: [],
        message: `Scanning the selected source folder: ${folder}.`,
      });
      return this.discover(updated, true);
    });
  }

  prepare(studio: Studio, projectId: string): Promise<Session> {
    return this.serial(async () => {
      assertStudio(studio);
      const projects = await this.refreshProjects(studio);
      const project = projects.find(item => item.studio === studio && item.id === projectId);
      if (!project) throw new Error(`Project ${projectId} is absent from the ${studio} Stills tab.`);
      const existing = this.store.get().sessions.find(item => item.studio === studio
        && item.projectId === projectId && !TERMINAL.has(item.status));
      if (existing) return this.withPreviewUrls(existing);
      const active = this.store.get().sessions.find(item => !TERMINAL.has(item.status));
      if (active) throw new Error(`Finish or skip ${active.projectName} before preparing another project.`);
      if (project.status !== 'To Do') throw new Error(`${project.name} is ${project.status}; only To Do rows can start.`);
      const now = new Date().toISOString();
      const id = randomUUID();
      const stagingPath = path.join(this.stagingRoot, id);
      await fs.mkdir(stagingPath, { recursive: false, mode: 0o700 });
      const session: Session = {
        id, studio, projectId, projectName: project.name, projectRow: project.row,
        status: 'discovering', videos: [], frames: [], selectedVideoIds: [], selectedFrameIds: [],
        naming: defaultNaming(project.name),
        stagingPath, sourcePath: this.store.get().config.sourceRoots[studio],
        destinationUrl: `https://drive.google.com/drive/folders/${this.store.get().config.destinationFolders[studio]}`,
        manifestPath: path.join(stagingPath, 'manifest.json'),
        message: 'Checking access and finding delivery videos.', createdAt: now, updatedAt: now,
      };
      await this.store.update(data => { data.sessions.push(session); data.currentSessionId = id; });
      await this.writeManifest(session);
      this.notify();
      return this.discover(session, false);
    });
  }

  approveVideos(sessionId: string, videoIds: string[]): Promise<Session> {
    return this.serial(async () => {
      const session = this.requireSession(sessionId);
      if (session.status !== 'awaiting_videos') throw new Error('This session is not awaiting video approval.');
      if (!videoIds.length || new Set(videoIds).size !== videoIds.length) throw new Error('Choose at least one distinct video.');
      const known = new Map(session.videos.map(video => [video.id, video]));
      for (const id of videoIds) {
        const video = known.get(id) as VideoCandidate | undefined;
        if (!video) throw new Error(`Unknown video selection: ${id}`);
        if (video.probeError || !video.durationSec || video.aspect === 'unknown') {
          throw new Error(`${video.name} could not be inspected. Choose a valid delivery video.`);
        }
      }
      const selected = new Set(videoIds);
      const updated = await this.saveSession({ ...session,
        videos: session.videos.map(video => ({ ...video, selected: selected.has(video.id) })),
        selectedVideoIds: videoIds, status: 'analyzing', lastPhase: 'analyzing', error: undefined,
        message: `Analyzing ${videoIds.length} approved ${videoIds.length === 1 ? 'video' : 'videos'}.`,
      });
      return this.analyze(updated);
    });
  }

  approveStills(sessionId: string, frameIds: string[], naming: Naming): Promise<Session> {
    return this.serial(async () => {
      const session = this.requireSession(sessionId);
      if (session.status !== 'awaiting_stills') throw new Error('This session is not awaiting still approval.');
      if (!frameIds.length || new Set(frameIds).size !== frameIds.length) throw new Error('Choose at least one distinct still.');
      const allowed = new Set(session.frames.map(frame => frame.id));
      for (const id of frameIds) if (!allowed.has(id)) throw new Error(`Unknown still selection: ${id}`);
      // Validate before starting an export, so a typo leaves the review screen intact.
      for (const [label, value] of [['Project', naming.project], ['Type', naming.type]]) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value.trim())) {
          throw new Error(`${label} tag must contain letters, numbers, underscores or hyphens.`);
        }
      }
      if (!naming.year || !/^20\d{2}$/.test(naming.year)) {
        throw new Error('Delivery year must be a four-digit 20xx year.');
      }
      const chosen = new Set(frameIds);
      const updated = await this.saveSession({ ...session,
        selectedFrameIds: frameIds, frames: session.frames.map(frame => ({ ...frame, selected: chosen.has(frame.id) })),
        naming: { project: naming.project.trim(), type: naming.type.trim(), year: naming.year },
        // A pre-upload failure returns to still review. Reapproval may change the
        // frame set or destination year, so the earlier export and folder cannot
        // remain the delivery plan.
        exports: undefined, uploadResults: undefined, destinationFolderId: undefined,
        destinationUrl: `https://drive.google.com/drive/folders/${this.store.get().config.destinationFolders[session.studio]}`,
        status: 'exporting', lastPhase: 'exporting', error: undefined,
        message: `Exporting ${frameIds.length} approved ${frameIds.length === 1 ? 'frame' : 'frames'}.`,
      });
      return this.deliver(updated);
    });
  }

  skip(sessionId: string): Promise<Session> {
    return this.serial(async () => {
      const session = this.requireSession(sessionId);
      if (TERMINAL.has(session.status)) throw new Error('This project is already complete or skipped.');
      if (uploadedItems(session).some(item => item.status !== 'planned')) {
        throw new Error('This project has an attempted Drive upload. Resolve delivery before skipping it.');
      }
      const workspace = this.options.getWorkspace();
      const row = await this.currentRow(workspace, session);
      if (!['To Do', 'In Process', 'Skip'].includes(row.status)) {
        throw new Error(`Cannot skip a row marked ${row.status}.`);
      }
      if (row.status !== 'Skip') await workspace.updateStatus(row, 'Skip', row.status);
      await this.setProjectStatus(session, 'Skip');
      return this.saveSession({ ...session, status: 'skipped', error: undefined, message: 'Skipped by reviewer.' });
    });
  }

  resume(sessionId: string): Promise<Session> {
    return this.serial(async () => {
      const session = this.requireSession(sessionId);
      if (TERMINAL.has(session.status) || session.status === 'awaiting_videos' || session.status === 'awaiting_stills') {
        return this.withPreviewUrls(session);
      }
      const phase = session.status === 'error' ? session.lastPhase : session.status;
      if (phase === 'discovering') return this.discover(session, true);
      if (phase === 'analyzing') return this.analyze(session);
      if (phase === 'exporting' || phase === 'uploading') return this.deliver(session);
      throw new Error(`Cannot resume a session in ${session.status}.`);
    });
  }

  private async serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.mutationChain.then(work);
    this.mutationChain = result.then(() => undefined, () => undefined);
    return result;
  }

  private withPreviewUrls(session: Session): Session {
    const result = clone(session);
    if (this.options.previewUrl) {
      result.frames = result.frames.map(frame => ({ ...frame,
        previewUrl: this.options.previewUrl!(frame.previewPath),
      }));
    }
    return result;
  }

  private requireSession(id: string): Session {
    const session = this.store.get().sessions.find(item => item.id === id);
    if (!session) throw new Error(`Unknown session: ${id}`);
    return session;
  }

  private async writeManifest(session: Session): Promise<void> {
    if (!session.manifestPath) throw new Error('Session manifest path is missing.');
    const temp = `${session.manifestPath}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(session, null, 2), { mode: 0o600 });
    await fs.rename(temp, session.manifestPath);
  }

  private async saveSession(session: Session): Promise<Session> {
    const next = { ...session, updatedAt: new Date().toISOString() };
    await this.store.update(data => {
      const index = data.sessions.findIndex(item => item.id === next.id);
      if (index < 0) throw new Error(`Unknown session: ${next.id}`);
      data.sessions[index] = next;
    });
    await this.writeManifest(next);
    this.notify();
    return clone(next);
  }

  private async refreshProjects(studio?: Studio): Promise<Project[]> {
    const rows = await this.options.getWorkspace().listProjects(studio);
    const fresh = rows.map(projectFromRow);
    const ids = new Set<string>();
    for (const project of fresh) {
      const key = `${project.studio}:${project.id}`;
      if (ids.has(key)) throw new Error(`Duplicate project code in Stills sheet: ${key}`);
      ids.add(key);
    }
    await this.store.update(data => {
      const prior = studio ? data.projects.filter(project => project.studio !== studio) : [];
      data.projects = [...prior, ...fresh.map(project => {
        const active = data.sessions.find(session => session.studio === project.studio
          && session.projectId === project.id && !TERMINAL.has(session.status));
        return { ...project, sourcePath: active?.sourcePath };
      })];
    });
    this.notify();
    return this.store.get().projects;
  }

  private async setProjectStatus(session: Session, status: string): Promise<void> {
    await this.store.update(data => {
      const project = data.projects.find(item => item.studio === session.studio && item.id === session.projectId);
      if (project) project.status = status;
    });
    this.notify();
  }

  private async currentRow(workspace: GoogleWorkspace, session: Session): Promise<ProjectRow> {
    const row = (await workspace.listProjects(session.studio)).find(item => item.rowNumber === session.projectRow);
    if (!row || row.name !== session.projectName) throw new Error('Stills sheet row changed; refresh projects before continuing.');
    return row;
  }

  private async ensureInProcess(workspace: GoogleWorkspace, session: Session, allowExisting: boolean): Promise<void> {
    const row = await this.currentRow(workspace, session);
    if (row.status === 'To Do') await workspace.updateStatus(row, 'In Process', 'To Do');
    else if (!(allowExisting && row.status === 'In Process')) {
      throw new Error(`${session.projectName} changed to ${row.status} in the Stills sheet.`);
    }
    await this.setProjectStatus(session, 'In Process');
  }

  private async fail(session: Session, error: unknown, phase: SessionStatus): Promise<Session> {
    return this.saveSession({ ...session, status: 'error', lastPhase: phase,
      error: errorMessage(error), message: `Paused during ${phase.replace(/_/g, ' ')}.`,
    });
  }

  private async discover(session: Session, allowExistingSheet: boolean): Promise<Session> {
    let current = await this.saveSession({ ...session, status: 'discovering', lastPhase: 'discovering',
      error: undefined, message: 'Checking access and finding delivery videos.' });
    try {
      const workspace = this.options.getWorkspace();
      const access = (await workspace.verifyRoots())[current.studio];
      if (!access?.sheetOk || !access.folderOk) {
        throw new Error([access?.sheetError, access?.folderError].filter(Boolean).join(' ') || 'Google Sheet or Drive destination is unavailable.');
      }
      await workspace.preflightProjectDestination(current.studio, current.projectName);
      await this.ensureInProcess(workspace, current, allowExistingSheet);
      const config = this.store.get().config;
      const projectCode = codeFromName(current.projectName);
      const ffprobePath = this.options.ffprobePath?.() ?? config.ffprobeExecutable;
      const found = current.manualSourcePath
        ? await this.functions.discoverProjectFolderVideos({
          projectFolder: current.manualSourcePath, projectCode, ffprobePath,
        })
        : projectCode
          ? await this.functions.discoverProjectVideos({
            sourceRoot: config.sourceRoots[current.studio], projectCode, ffprobePath,
          })
          : (() => { throw new Error('This Stills row has no bracketed project code. Choose its project source folder, then resume.'); })();
      current = await this.saveSession({ ...current,
        sourcePath: found.projectFolder ?? config.sourceRoots[current.studio],
        videos: found.videos, selectedVideoIds: found.videos.filter(video => video.selected).map(video => video.id),
        message: found.warnings.length ? found.warnings.join(' ') : `Found ${found.videos.length} delivery videos.`,
      });
      if (!found.videos.length) throw new Error(found.warnings.join(' ') || 'No delivery videos were found.');
      return this.saveSession({ ...current, status: 'awaiting_videos', lastPhase: 'awaiting_videos' });
    } catch (error) { return this.fail(this.requireSession(current.id), error, 'discovering'); }
  }

  private async analyze(session: Session): Promise<Session> {
    let current = await this.saveSession({ ...session, status: 'analyzing', lastPhase: 'analyzing',
      error: undefined, message: `Analyzing ${session.selectedVideoIds.length} approved videos.` });
    try {
      if (!current.stagingPath) throw new Error('Staging folder is missing.');
      const result = await this.functions.analyzeVideos(
        current.videos as VideoCandidate[], current.stagingPath, this.options.extractTool(),
      );
      if (!result.frames.length) throw new Error('Extract Stills returned no candidate frames.');
      current = await this.saveSession({ ...current,
        analyses: result.analyses, frames: result.frames,
        selectedFrameIds: result.frames.filter(frame => frame.selected).map(frame => frame.id),
        status: 'awaiting_stills', lastPhase: 'awaiting_stills',
        message: `Review ${result.frames.length} candidate frames before PNG export.`,
      });
      return this.withPreviewUrls(current);
    } catch (error) { return this.fail(this.requireSession(current.id), error, 'analyzing'); }
  }

  private async deliver(session: Session): Promise<Session> {
    let current = session;
    try {
      if (!current.stagingPath || !current.naming || !current.selectedFrameIds.length) {
        throw new Error('Approved stills or staging folder are missing.');
      }
      const stagingPath = current.stagingPath;
      const naming = current.naming;
      const selectedFrameIds = current.selectedFrameIds;
      const workspace = this.options.getWorkspace();
      let exports = current.exports as ExportedStill[] | undefined;
      if (!exports?.length) {
        current = await this.saveSession({ ...current, status: 'exporting', lastPhase: 'exporting',
          error: undefined, message: 'Exporting only the approved PNG frames.' });
        exports = await this.functions.exportApprovedFrames(
          current.analyses as AnalysisRecord[], selectedFrameIds,
          stagingPath, this.options.extractTool(),
        );
        current = await this.saveSession({ ...current, exports });
      }
      const approvedOrder = new Map(selectedFrameIds.map((id, index) => [id, index]));
      const exportedIds = exports.map(file => `${file.videoId}:${file.frameId}`);
      if (exports.length !== approvedOrder.size || new Set(exportedIds).size !== exports.length
          || exportedIds.some(id => !approvedOrder.has(id))) {
        throw new Error('Exported frames do not match the approved still IDs.');
      }
      exports = [...exports].sort((a, b) =>
        approvedOrder.get(`${a.videoId}:${a.frameId}`)! - approvedOrder.get(`${b.videoId}:${b.frameId}`)!);
      current = await this.saveSession({ ...current, exports });
      let folder: DriveFile;
      if (current.destinationFolderId) {
        folder = await workspace.verifyProjectFolder(current.studio, current.projectName,
          projectYear(current), current.destinationFolderId);
      } else {
        folder = await workspace.findOrCreateProjectFolder(current.studio, current.projectName, projectYear(current));
        current = await this.saveSession({ ...current, destinationFolderId: folder.id,
          destinationUrl: `https://drive.google.com/drive/folders/${folder.id}` });
      }
      let items = uploadedItems(current);
      if (!items.length) {
        const existing = await workspace.listFolderFiles(folder.id);
        const plan = this.functions.planRenames(exports, {
          projectName: naming.project, projectType: naming.type,
        }, existing.map(file => file.name));
        const renamed = await this.functions.stageAndRenameApprovedStills(
          plan, stagingPath, this.options.renameTool(),
        );
        items = [];
        for (const file of renamed.files) {
          const { size, md5 } = await fingerprint(file.renamedPath);
          items.push({ videoId: file.videoId, frameId: file.frameId,
            sourcePath: file.sourcePath, renamedPath: file.renamedPath,
            targetName: file.targetName, size, md5, uploadId: randomUUID(), status: 'planned' });
        }
        current = await this.saveSession({ ...current, status: 'uploading', lastPhase: 'uploading',
          uploadResults: items, message: `Ready to upload ${items.length} approved PNGs.` });
      } else if (current.status !== 'uploading') {
        current = await this.saveSession({ ...current, status: 'uploading', lastPhase: 'uploading',
          error: undefined, message: 'Resuming verified Drive delivery.' });
      }
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        const local = await fingerprint(item.renamedPath);
        if (local.size !== item.size || local.md5 !== item.md5) {
          throw new Error(`Staging PNG changed after approval: ${item.targetName}`);
        }
        if (item.status === 'verified') {
          if (!item.fileId) throw new Error(`Missing Drive file ID for ${item.targetName}.`);
          await workspace.verifyUploadedPng(item.fileId, folder.id, item.targetName, item.md5, item.size, item.uploadId);
          continue;
        }
        const matches = (await workspace.listFolderFiles(folder.id)).filter(file =>
          file.name.toLowerCase() === item.targetName.toLowerCase());
        if (matches.length) {
          if (item.status !== 'attempting' || matches.length !== 1
              || matches[0].name !== item.targetName || matches[0].mimeType !== PNG_MIME
              || matches[0].size !== String(item.size)
              || matches[0].md5Checksum?.toLowerCase() !== item.md5.toLowerCase()
              || matches[0].appProperties?.stillsLibraryUploadId !== item.uploadId) {
            throw new Error(`Destination already contains ${item.targetName}; upload stopped without overwriting it.`);
          }
          await workspace.verifyUploadedPng(matches[0].id, folder.id, item.targetName, item.md5, item.size, item.uploadId);
          items[index] = { ...item, status: 'verified', fileId: matches[0].id };
        } else {
          if (item.status !== 'attempting') {
            items[index] = { ...item, status: 'attempting' };
            current = await this.saveSession({ ...current, uploadResults: items });
          }
          const uploaded = await workspace.uploadPng({ folderId: folder.id,
            filePath: item.renamedPath, fileName: item.targetName, uploadId: item.uploadId });
          items[index] = { ...items[index], status: 'verified', fileId: uploaded.id };
        }
        current = await this.saveSession({ ...current, uploadResults: items,
          message: `Verified ${items.filter(entry => entry.status === 'verified').length} of ${items.length} PNGs in Drive.` });
      }
      for (const item of items) {
        if (!item.fileId || item.status !== 'verified') throw new Error(`Upload incomplete: ${item.targetName}`);
        await workspace.verifyUploadedPng(item.fileId, folder.id, item.targetName, item.md5, item.size, item.uploadId);
      }
      const finalFiles = await workspace.listFolderFiles(folder.id);
      for (const item of items) {
        const matches = finalFiles.filter(file => file.name.toLowerCase() === item.targetName.toLowerCase());
        if (matches.length !== 1 || matches[0].id !== item.fileId) {
          throw new Error(`Drive contains a new filename conflict for ${item.targetName}; Stills row remains In Process.`);
        }
      }
      await workspace.verifyProjectFolder(current.studio, current.projectName, projectYear(current), folder.id);
      const row = await this.currentRow(workspace, current);
      if (row.status === 'In Process') await workspace.updateStatus(row, 'Done', 'In Process');
      else if (row.status !== 'Done') throw new Error(`Stills row is ${row.status}; cannot mark Done.`);
      await this.setProjectStatus(current, 'Done');
      return this.saveSession({ ...current, status: 'done', lastPhase: 'done', error: undefined,
        message: `Verified ${items.length} PNGs in Drive and marked the Stills row Done.` });
    } catch (error) {
      const latest = this.requireSession(current.id);
      const phase = latest.status === 'uploading' ? 'uploading' : 'exporting';
      if (phase === 'exporting' && !uploadedItems(latest).length) {
        return this.saveSession({ ...latest, status: 'awaiting_stills', lastPhase: 'awaiting_stills',
          error: errorMessage(error), message: 'Review the delivery name and year, then retry.' });
      }
      return this.fail(latest, error, phase);
    }
  }
}
