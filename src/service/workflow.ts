import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { totalmem } from 'node:os';
import { reviewCapacity } from '../shared/review-capacity';
import type { GoogleWorkspace } from '../google/workspace.js';
import type { DriveFile, ProjectRow } from '../google/types.js';
import {
  discoverProjectVideos, discoverProjectFolderVideos, findProjectFolder, type VideoCandidate,
} from '../core/media.js';
import {
  analyzeVideos, exportApprovedFrames, planRenames, stageAndRenameApprovedStills,
  type AnalysisRecord, type CommandSpec, type ExportedStill,
} from '../core/extraction.js';
import type { AppState, BatchRun, Naming, Project, Session, SessionStatus, Studio } from '../shared/contracts.js';
import { dataDir } from '../shared/runtime.js';
import { JsonStore } from './storage.js';
import { planDeliveryFolders } from '../core/version-folders.js';
import { suggestProjectYear } from '../core/project-year.js';
import { previewPath } from '../shared/preview-path.js';
import { sessionView } from './view-state.js';
import { revisionSteps } from './revision-steps.js';

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
  /** Absent only on older, flat delivery plans. */
  folderId?: string;
  versionName?: string;
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
  throw new Error(`Cannot determine the delivery year for ${session.projectName}. Choose the delivery year in the stills naming review before approving delivery.`);
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
  const year = years.size === 1 ? [...years][0] : '';
  if (code === '203SB') return { project: 'Airwaav_Brager', type: 'PremiumAd', year };
  if (code === '1289') return { project: 'Net32_2026', type: 'Brand_Refresh', year };
  const withoutCode = projectName.replace(/^\[[^\]]+\]/, '').replace(/^[_\s-]+/, '');
  const project = withoutCode.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const split = project.indexOf('_');
  return { project: split > 0 ? project.slice(0, split) : project || 'Project',
    type: split > 0 ? project.slice(split + 1) : 'Library', year };
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
        || !Number.isSafeInteger(item.size) || (item.versionName && !item.folderId)) {
      throw new Error('Saved upload plan is incomplete; no files will be uploaded.');
    }
    return item;
  });
}

function versionFolders(session: Session): Record<string, string> {
  const selected = new Set(session.selectedVideoIds);
  const videos = session.videos.filter(video => selected.has(video.id));
  if (videos.length !== selected.size) throw new Error('Approved video is missing from the saved session.');
  return Object.fromEntries(planDeliveryFolders(videos, session.projectName));
}

/** Persisted review gates and a bounded preparation/upload pipeline. */
export class WorkflowService {
  private readonly store: JsonStore;
  private readonly options: WorkflowOptions;
  private readonly functions: WorkflowFunctions;
  private readonly stagingRoot: string;
  private mutationChain: Promise<void> = Promise.resolve();
  private batchWorker?: Promise<void>;
  private reportChain: Promise<void> = Promise.resolve();
  private uploadChain: Promise<void> = Promise.resolve();
  private deliveryMessages = new Map<string, string>();
  private deliveryMessage(id: string, message: string): void { this.deliveryMessages.set(id, message); this.notify(); }
  get automaticRunning(): boolean { return this.store.read(value => value.batch?.status === 'running'); }

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
    for (const session of this.store.get().sessions) {
      // Older versions could reopen a delivery without retaining its ownership
      // journal. Recover that journal before exposing revision controls.
      if (session.status === 'awaiting_stills' && session.previousDeliveryManifest && !session.revision && !session.uploadResults?.length) {
        try {
          const archived = JSON.parse(await fs.readFile(session.previousDeliveryManifest, 'utf8')) as Session;
          const uploads = uploadedItems(archived);
          if (archived.id !== session.id || archived.projectName !== session.projectName || archived.studio !== session.studio
              || archived.status !== 'done' || !archived.destinationFolderId || !uploads.length
              || uploads.some(item => item.status !== 'verified' || !item.fileId)) throw new Error('Previous delivery evidence is incomplete.');
          await this.saveSession({ ...session, destinationFolderId: archived.destinationFolderId, destinationUrl: archived.destinationUrl,
            versionFolders: archived.versionFolders, exports: undefined, error: undefined,
            revision: { id: randomUUID(), uploads, exports: archived.exports ?? [], phase: 'staging' },
            message: 'Adjust the saved selection, then apply the revision to update Drive.' });
        } catch (error) {
          await this.saveSession({ ...session, error: `Cannot restore the previous delivery for revision: ${errorMessage(error)}` });
        }
      }
      if (['discovering', 'analyzing', 'exporting', 'uploading'].includes(session.status)) {
        await this.saveSession({ ...session, status: 'error', lastPhase: session.status,
          error: 'The app closed before this step finished. Resume to continue from the saved approval.',
          message: 'Interrupted work is ready to resume.' });
      }
    }
    this.notify();
  }

  /** Main enriches this snapshot with the authenticated Google account. */
  getState(includeDetails = true): AppState {
    const data = includeDetails ? this.store.get() : this.store.read(value => ({ ...value,
      sessions: value.sessions.map(session => sessionView(session, true)) }));
    return {
      reviewLimit: reviewCapacity(totalmem()),
      authenticated: false,
      configured: Boolean(data.config.googleClientId),
      projects: data.projects,
      sessions: includeDetails ? data.sessions.map(session => this.withPreviewUrls(session)) : data.sessions.map(session => ({ ...session, message: this.deliveryMessages.get(session.id) ?? session.message })),
      currentSessionId: data.currentSessionId,
      batch: data.batch,
      sourceRoots: data.config.sourceRoots,
      additionalSources: data.config.additionalSources,
      destinationFolders: data.config.destinationFolders,
    };
  }

  notify(): void {
    try { this.options.onChange?.(); } catch { /* A UI subscriber cannot break persistence. */ }
  }

  getSession(id: string): Session | undefined {
    const session = this.store.read(value => value.sessions.find(item => item.id === id));
    return session ? this.withPreviewUrls(session) : undefined;
  }

  getSessionView(id: string): Session | undefined {
    const session = this.store.read(value => {
      const found = value.sessions.find(item => item.id === id);
      return found ? sessionView(found) : undefined;
    });
    return session ? this.withPreviewUrls(session) : undefined;
  }

  async startBatch(approveAll: boolean): Promise<BatchRun> {
    if (approveAll !== true) throw new Error('Automatic delivery requires explicit approval of all suggested selections.');
    if (this.batchWorker && !this.automaticRunning) await this.batchWorker;
    await this.serial(async () => {
      if (this.batchWorker) throw new Error('The automatic queue is already running.');
      const prior = this.store.get().batch;
      if (prior && prior.status !== 'complete') {
        await this.store.update(data => { data.batch!.status = 'running'; data.batch!.pauseRequested = false; data.batch!.error = undefined; });
        return;
      }
      if (this.store.get().sessions.some(s => !TERMINAL.has(s.status) && !s.deferred)) {
        throw new Error('Finish the current manual review before starting automatic delivery.');
      }
      const projects = await this.refreshProjects();
      const id = randomUUID();
      const reportPath = path.join(this.stagingRoot, 'batch-reports', id, 'report.html');
      const now = new Date().toISOString();
      await this.store.update(data => { data.batch = { id, status: 'running', startedAt: now, updatedAt: now,
        reportPath, entries: projects.filter(p => p.status === 'To Do').map(project => ({ project, status: 'pending' })),
        excluded: projects.filter(p => p.status !== 'To Do') }; });
    });
    await this.writeBatchReport();
    this.continueBatch();
    return this.store.get().batch!;
  }

  async pauseBatch(): Promise<void> {
    await this.store.update(data => { if (data.batch?.status === 'running') data.batch.pauseRequested = true; });
    this.notify();
  }

  async retryBatchFailures(): Promise<BatchRun> {
    if (this.batchWorker && !this.automaticRunning) await this.batchWorker;
    if (this.batchWorker || this.automaticRunning) throw new Error('Pause the automatic queue before retrying flagged projects.');
    if (!this.store.get().batch) throw new Error('No automatic queue is saved.');
    await this.store.update(data => {
      data.batch!.status = 'paused';
      for (const entry of data.batch!.entries) {
        if (entry.status === 'failed') { entry.status = 'pending'; entry.reason = undefined; }
      }
    });
    return this.startBatch(true);
  }

  /** Called after Google initialization; the persisted authorization survives restarts. */
  continueBatch(): void {
    if (this.batchWorker || !this.automaticRunning) return;
    this.batchWorker = this.runBatch().catch(async error => {
      await this.store.update(data => { if (data.batch) { data.batch.status = 'paused'; data.batch.error = errorMessage(error); } });
      await this.writeBatchReport();
    }).finally(() => { this.batchWorker = undefined; this.notify(); });
    this.notify();
  }

  private writeBatchReport(): Promise<void> {
    const result = this.reportChain.then(() => this.writeBatchReportNow());
    this.reportChain = result.catch(() => {});
    return result;
  }

  private async writeBatchReportNow(): Promise<void> {
    const run = this.store.get().batch;
    if (!run) return;
    const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
    const counts = ['done', 'skipped', 'failed', 'pending', 'running'].map(s => `${run.entries.filter(e => e.status === s).length} ${s}`).join(' · ');
    const rows = run.entries.map(e => `<tr><td>${esc(e.project.studio)}</td><td>${esc(e.project.name)}</td><td>${esc(e.status)}</td><td>${esc(e.year)}</td><td>${esc(e.videos)}</td><td>${esc(e.stills)}</td><td>${e.destinationUrl ? `<a href="${esc(e.destinationUrl)}">Open Drive</a>` : ''}</td><td>${esc(e.reason)}</td></tr>`).join('');
    const html = `<!doctype html><meta charset="utf-8"><title>Stills Library run report</title><style>body{font:15px system-ui;margin:40px;color:#162021}table{border-collapse:collapse;width:100%}td,th{padding:12px;border-bottom:1px solid #ddd;text-align:left}th{background:#eee}a{color:#06705a}</style><h1>Stills Library — automatic delivery</h1><p>${esc(run.status)} · Started ${esc(run.startedAt)} · Updated ${esc(run.updatedAt)}</p><p>${esc(counts)}</p><p>${esc(run.error)}</p><p>Suggested clips and stills approved automatically, including each video's final frame. Year inferred from source video dates. Source videos and existing Drive files are preserved.</p><table><thead><tr><th>Studio</th><th>Project</th><th>Result</th><th>Year</th><th>Videos</th><th>PNGs</th><th>Exports</th><th>Details</th></tr></thead><tbody>${rows}</tbody></table><h2>Already outside the To Do queue</h2><ul>${run.excluded.map(p => `<li>${esc(p.name)} — ${esc(p.status)}</li>`).join('')}</ul>`;
    await fs.mkdir(path.dirname(run.reportPath), { recursive: true });
    for (const [file, text] of [[run.reportPath, html], [path.join(path.dirname(run.reportPath), 'report.json'), JSON.stringify(run, null, 2)]]) {
      const temp = `${file}.tmp`;
      await fs.writeFile(temp, text);
      await fs.rename(temp, file);
    }
    this.notify();
  }

  private async runBatch(): Promise<void> {
    let delivery: Promise<void> = Promise.resolve();
    const scheduled = new Set<number>();
    let deliveryFailure: unknown;
    try {
      while (this.automaticRunning && !this.store.get().batch!.pauseRequested) {
        if (deliveryFailure) throw deliveryFailure;
        const run = this.store.get().batch!;
        const index = run.entries.findIndex((e, i) => !scheduled.has(i) && (e.status === 'pending' || e.status === 'running'));
        if (index < 0) break;
        const roots = [...Object.values(this.store.get().config.sourceRoots), ...(this.store.get().config.additionalSources ?? []).map(source => source.path)];
        for (const root of roots) {
          if (!root || !(await fs.stat(root)).isDirectory()) throw new Error('A source mount is unavailable. Restore the source mounts, then resume the automatic queue.');
          await fs.readdir(root);
        }
        await this.store.update(data => { data.batch!.entries[index].status = 'running'; });
        await this.writeBatchReport();
        try {
          const session = await this.prepareBatchEntry(index, roots);
          if (session.status === 'exporting' && !session.error) {
            // Keep preparing while completed exports wait in a FIFO upload queue.
            // Every queued session is persisted and can resume without re-analysis.
            scheduled.add(index);
            delivery = delivery.then(async () => {
              if (deliveryFailure || this.store.get().batch!.pauseRequested) return;
              await this.deliverBatchEntry(index, session);
            }).catch(error => { deliveryFailure = error; });
          } else await this.finishBatchEntry(index, session);
        } catch (error) {
          await this.failBatchEntry(index, error);
        }
      }
    } finally {
      // Finish the current upload; queued exports stay saved when paused.
      await delivery;
    }
    if (deliveryFailure) throw deliveryFailure;
    await this.store.update(data => {
      const run = data.batch!;
      run.status = run.pauseRequested ? 'paused' : 'complete';
      run.updatedAt = new Date().toISOString();
    });
    await this.writeBatchReport();
  }

  private async prepareBatchEntry(index: number, roots: string[]): Promise<Session> {
    const run = this.store.get().batch!;
    const entry = run.entries[index];
    let session = entry.sessionId ? this.getSession(entry.sessionId) : this.store.get().sessions.find(s =>
      s.automaticRunId === run.id && s.studio === entry.project.studio && s.projectId === entry.project.id);
    if (!session) {
      const p = entry.project;
      const sourceCode = p.code ?? /^(\d{4}|\d{3}SB)[_ -]/i.exec(p.name)?.[1];
      const matches: string[] = [];
      let found: Awaited<ReturnType<typeof discoverProjectFolderVideos>> | undefined;
      for (const root of new Set(roots)) {
        const folder = await findProjectFolder(root, sourceCode, p.name);
        if (!folder) continue;
        matches[0] = folder;
        found = await this.functions.discoverProjectFolderVideos({ projectFolder: folder, projectCode: sourceCode,
          ffprobePath: this.options.ffprobePath?.() ?? this.store.get().config.ffprobeExecutable });
        if (found.videos.length) break;
      }
      if (matches.length > 1) throw new Error('Multiple source folders match this project across the studios. Review the source manually.');
      if (matches.length && p.code && this.store.get().projects.filter(other => other.studio === p.studio && other.code === p.code).length > 1) {
        const normalize = (name: string) => name.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
        if (normalize(path.basename(matches[0])) !== normalize(p.name)) {
          const concept = /(?:^|[_ -])Concept[_ -]?([A-Z0-9]+)$/i.exec(p.name)?.[1];
          const relevant = concept ? found?.videos.filter(video => new RegExp(`(?:^|[\\/_ -])Concept[_ -]?${concept}(?=$|[\\/_ .-])`, 'i').test(video.path)) : [];
          if (!relevant?.length) throw new Error('This project code is shared by multiple Sheet rows. No unambiguous matching concept was found; automatic delivery is paused for this project.');
          found = { ...found!, videos: relevant };

        }
      }
      const missing = !found?.videos.length;
      // Recheck the Sheet immediately before creating a session or skipping.
      const row = (await this.options.getWorkspace().listProjects(p.studio)).find(r => r.rowNumber === p.row);
      if (!row || row.name !== p.name || row.status !== 'To Do') throw new Error('The queue row changed since this run started.');
      const id = randomUUID();
      const stagingPath = path.join(this.stagingRoot, id);
      await fs.mkdir(stagingPath, { recursive: false });
      const now = new Date().toISOString();
      const suggestion = suggestProjectYear(found?.videos ?? [], p.name);
      session = { id, projectId: p.id, projectName: p.name, projectRow: p.row, studio: p.studio,
        status: 'discovering', videos: found?.videos ?? [], frames: [], selectedVideoIds: [], selectedFrameIds: [],
        sourcePath: matches[0], manualSourcePath: matches[0], stagingPath, manifestPath: path.join(stagingPath, 'manifest.json'),
        naming: { ...defaultNaming(p.name), year: suggestion.year }, yearSuggestion: suggestion,
        automaticRunId: run.id, createdAt: now, updatedAt: now };
      await this.store.update(data => { data.sessions.push(session!); data.currentSessionId = id; data.batch!.entries[index].sessionId = id; });
      await this.saveSession(session);
      if (missing) {
        const reason = matches.length ? found?.warnings.join(' ') || 'No delivery videos found.' : 'Source folder not found in Active or Archived projects in either studio.';
        session = await this.skipWork(id);
        session = await this.saveSession({ ...session, message: reason });
      } else {
        const workspace = this.options.getWorkspace();
        const access = (await workspace.verifyRoots())[p.studio];
        if (!access.sheetOk || !access.folderOk) throw new Error([access.sheetError, access.folderError].filter(Boolean).join(' ') || 'Google access is unavailable.');
        await workspace.preflightProjectDestination(p.studio, p.name);
        await this.ensureInProcess(workspace, session, true);
        session = await this.saveSession({ ...session, status: 'awaiting_videos', lastPhase: 'awaiting_videos',
          selectedVideoIds: session.videos.filter(v => v.selected).map(v => v.id), message: 'Automatic video selection approved for this queue run.' });
      }
    }
    if (session.status === 'error' && session.lastPhase === 'discovering' && !session.videos.length) {
      // A quota/network failure can interrupt the guarded Skip write. Recheck
      // the source before retrying that decision instead of failing forever.
      const p = entry.project;
      const code = p.code ?? /^(\d{4}|\d{3}SB)[_ -]/i.exec(p.name)?.[1];
      const folders: string[] = [];
      for (const root of new Set(roots)) {
        const folder = await findProjectFolder(root, code, p.name);
        if (folder) { folders.push(folder); break; }
      }
      if (folders.length > 1) throw new Error('Multiple source folders match this project.');
      const found = folders.length ? await this.functions.discoverProjectFolderVideos({ projectFolder: folders[0], projectCode: code,
        ffprobePath: this.options.ffprobePath?.() ?? this.store.get().config.ffprobeExecutable }) : undefined;
      if (!found?.videos.length) {
        session = await this.skipWork(session.id);
        session = await this.saveSession({ ...session, message: folders.length ? found?.warnings.join(' ') || 'No delivery videos found.' : 'Source folder not found in Active or Archived projects in either studio.' });
      } else session = await this.saveSession({ ...session, manualSourcePath: folders[0] });
    }
    if (session.status === 'error' || session.status === 'exporting' || session.status === 'uploading') session = await this.resumeWork(session.id, true);
    if (session.status === 'discovering') session = await this.discover(session, true);
    if (session.status === 'awaiting_videos') session = await this.approveVideosWork(session.id, session.videos.filter(v => v.selected).map(v => v.id));
    if (session.status === 'awaiting_stills' && !session.error) session = await this.approveStillsWork(session.id,
      session.frames.filter(f => f.selected || f.finalFrame).map(f => f.id), session.naming!, true);
    return session;
  }

  private async deliverBatchEntry(index: number, session: Session): Promise<void> {
    try { await this.finishBatchEntry(index, await this.deliver(session)); }
    catch (error) { await this.failBatchEntry(index, error); }
  }

  private async finishBatchEntry(index: number, session: Session): Promise<void> {
    if (!TERMINAL.has(session.status)) throw new Error(session.error || `Project stopped at ${session.status}.`);
    await this.store.update(data => { Object.assign(data.batch!.entries[index], {
      sessionId: session!.id, status: session!.status === 'done' ? 'done' : 'skipped', reason: session!.message,
      year: session!.naming?.year, videos: session!.selectedVideoIds.length, stills: session!.uploadResults?.length ?? 0,
      destinationUrl: session!.status === 'done' ? session!.destinationUrl : undefined }); });
    await this.store.update(data => { data.batch!.updatedAt = new Date().toISOString(); });
    await this.writeBatchReport();
  }

  private async failBatchEntry(index: number, error: unknown): Promise<void> {
    const entry = this.store.get().batch!.entries[index];
    const session = entry.sessionId ? this.getSession(entry.sessionId) : undefined;
    if (session) {
      const latest = this.requireSession(session.id);
      await this.saveSession({ ...latest, deferred: true, status: 'error',
        lastPhase: latest.lastPhase ?? latest.status, error: errorMessage(error), message: 'Automatic delivery needs attention.' });
    }
    const latest = session ? this.requireSession(session.id) : undefined;
    await this.store.update(data => { Object.assign(data.batch!.entries[index], { status: 'failed', sessionId: session?.id,
      reason: errorMessage(error), year: latest?.naming?.year, videos: latest?.selectedVideoIds.length,
      stills: latest?.uploadResults ? uploadedItems(latest).filter(item => item.status === 'verified').length : 0,
      destinationUrl: latest?.destinationFolderId ? latest.destinationUrl : undefined }); });
    await this.store.update(data => { data.batch!.updatedAt = new Date().toISOString(); });
    await this.writeBatchReport();
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

  addSource(sourcePath: string, url: string): Promise<void> {
    return this.serial(async () => {
      if (this.automaticRunning) throw new Error('Pause the queue before changing sources.');
      const parsed = new URL(url);
      if (parsed.hostname !== 'drive.google.com' || !/^\/drive\/folders\/[a-zA-Z0-9_-]+$/.test(parsed.pathname)) throw new Error('Expected a Google Drive folder URL.');
      const resolved = await fs.realpath(sourcePath);
      if (!(await fs.stat(resolved)).isDirectory()) throw new Error('Mounted Drive source is unavailable.');
      await this.store.update(data => {
        const sources = data.config.additionalSources ??= [];
        if (!sources.some(source => source.path.toLowerCase() === resolved.toLowerCase())) sources.push({ path: resolved, url, label: path.basename(resolved) });
      });
      this.notify();
    });
  }

  async retryMissingSources(approveAll: boolean): Promise<BatchRun> {
    if (this.batchWorker && !this.automaticRunning) await this.batchWorker;
    if (!approveAll || this.batchWorker || this.automaticRunning) throw new Error('Stop the queue and explicitly approve the retry.');
    const previous = this.store.get().batch;
    if (!previous || previous.status !== 'complete') throw new Error('Finish the previous batch first.');
    const workspace = this.options.getWorkspace();
    const rows = await workspace.listProjects();
    const entries: BatchRun['entries'] = [];
    for (const entry of previous.entries) {
      if (entry.status === 'done') continue;
      const row = rows.find(row => row.source === entry.project.studio && row.rowNumber === entry.project.row && row.name === entry.project.name);
      if (!row || row.status === 'Done') continue;
      if (entry.status === 'skipped') {
        if (row.status === 'Skip') await workspace.updateStatus(row, 'To Do', 'Skip');
        else if (row.status !== 'To Do') throw new Error(`Unexpected changed row for ${row.name}.`);
        entries.push({ project: { ...entry.project, status: 'To Do' }, status: 'pending' });
      } else entries.push({ ...entry, status: 'pending', reason: undefined });
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.store.update(data => {
      data.batch = { id, status: 'running', entries, startedAt: now, updatedAt: now,
        reportPath: path.join(this.stagingRoot, 'batch-reports', id, 'report.html'),
        excluded: [...previous.excluded, ...previous.entries.filter(e => e.status === 'done').map(e => ({ ...e.project, status: 'Done' as const }))] };
    });
    await this.writeBatchReport();
    this.continueBatch();
    return this.store.get().batch!;
  }

  setSource(studio: Studio, sourceRoot: string): Promise<void> {
    return this.serial(async () => {
      if (this.automaticRunning) throw new Error('Pause the automatic queue before changing source roots.');
      assertStudio(studio);
      if (!sourceRoot.trim()) throw new Error('Choose the mounted studio source folder first.');
      const resolved = path.resolve(sourceRoot);
      if (!(await fs.stat(resolved)).isDirectory()) throw new Error(`${resolved} is not a folder.`);
      await this.store.update(data => { data.config.sourceRoots[studio] = resolved; });
      this.notify();
    });
  }

  setProjectSource(sessionId: string, projectFolder: string): Promise<Session> {
    this.assertManualSession(sessionId);
    return this.serial(async () => {
      const session = this.requireSession(sessionId);
      this.assertReviewSlot(sessionId);
      if (!(session.status === 'awaiting_videos'
          || session.status === 'skipped'
          || (session.status === 'error' && session.lastPhase === 'discovering'))) {
        throw new Error('Choose a project source before approving videos.');
      }
      const folder = await fs.realpath(projectFolder);
      if (!(await fs.stat(folder)).isDirectory()) throw new Error('Selected project source is not a folder.');
      if (session.revision || uploadedItems(session).some(item => item.status !== 'planned')) throw new Error('Keep the existing source for a project with delivery records.');
      const expectedCode = codeFromName(session.projectName);
      const chosenCode = codeFromName(path.basename(folder));
      if (expectedCode && chosenCode && expectedCode !== chosenCode) {
        throw new Error(`Selected folder [${chosenCode}] does not match Stills project [${expectedCode}].`);
      }
      if (session.status === 'skipped') {
        const workspace = this.options.getWorkspace();
        const row = await this.currentRow(workspace, session);
        if (row.status !== 'Skip') throw new Error('The skipped spreadsheet row changed. Refresh projects before choosing its source.');
        await workspace.updateStatus(row, 'To Do', 'Skip');
        await this.setProjectStatus(session, 'To Do');
      }
      const updated = await this.saveSession({ ...session,
        sourcePath: folder, manualSourcePath: folder, deferred: false,
        status: 'discovering', lastPhase: 'discovering', error: undefined,
        videos: [], frames: [], selectedVideoIds: [], selectedFrameIds: [],
        analyses: undefined, exports: undefined, uploadResults: undefined, versionFolders: undefined,
        message: `Scanning the selected source folder: ${folder}.`,
      });
      return this.discover(updated, true);
    });
  }

  prepare(studio: Studio, projectId: string): Promise<Session> {
    return this.serial(async () => {
      if (this.automaticRunning) throw new Error('Pause the automatic queue before preparing a project manually.');
      assertStudio(studio);
      const projects = await this.refreshProjects(studio);
      const matchingCode = projects.filter(item => item.studio === studio && item.code === projectId.toUpperCase());
      if (matchingCode.length > 1) {
        throw new Error(`Project code ${projectId} matches multiple Stills rows. Choose a specific row: ${matchingCode.map(item => `${item.id} (${item.name})`).join(', ')}.`);
      }
      const project = projects.find(item => item.studio === studio && item.id === projectId);
      if (!project) throw new Error(`Project ${projectId} is absent from the ${studio} Stills tab.`);
      const existing = this.store.get().sessions.find(item => item.studio === studio
        && item.projectId === projectId && !TERMINAL.has(item.status));
      if (existing) {
        if (existing.deferred) {
          this.assertReviewSlot(existing.id);
          await this.store.update(data => { data.sessions.find(s => s.id === existing.id)!.deferred = false; });
          this.notify();
        }
        return this.withPreviewUrls(this.requireSession(existing.id));
      }
      this.assertReviewSlot();
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
    this.assertManualSession(sessionId);
    return this.serial(() => this.approveVideosWork(sessionId, videoIds));
  }

  private async approveVideosWork(sessionId: string, videoIds: string[]): Promise<Session> {
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
    const yearSuggestion = suggestProjectYear(session.videos.map(video => ({ ...video, selected: selected.has(video.id) })), session.projectName);
    const updated = await this.saveSession({ ...session,
      videos: session.videos.map(video => ({ ...video, selected: selected.has(video.id) })),
      yearSuggestion,
      naming: { ...(session.naming ?? defaultNaming(session.projectName)), year: yearSuggestion.year },
      selectedVideoIds: videoIds, status: 'analyzing', lastPhase: 'analyzing', error: undefined,
      message: `Analyzing ${videoIds.length} approved ${videoIds.length === 1 ? 'video' : 'videos'}.`,
    });
    return this.analyze(updated);
  }

  approveStills(sessionId: string, frameIds: string[], naming: Naming): Promise<Session> {
    this.assertManualSession(sessionId);
    return this.serial(() => this.approveStillsWork(sessionId, frameIds, naming));
  }

  private async approveStillsWork(sessionId: string, frameIds: string[], naming: Naming, prepareOnly = false): Promise<Session> {
    const session = this.requireSession(sessionId);
    if (session.status !== 'awaiting_stills') throw new Error('This session is not awaiting still approval.');
    if (session.previousDeliveryManifest && !session.revision) throw new Error('Restore the previous delivery evidence before applying a revision.');
    if ((!frameIds.length && !session.revision) || new Set(frameIds).size !== frameIds.length) throw new Error('Choose at least one distinct still.');
    if (session.revision && naming.year !== session.naming?.year) throw new Error('Keep the existing delivery year when revising a project.');
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
      versionFolders: session.revision ? session.versionFolders : versionFolders(session),
      naming: { project: naming.project.trim(), type: naming.type.trim(), year: naming.year },
      // A pre-upload failure returns to still review. Reapproval may change the
      // frame set or destination year, so the earlier export and folder cannot
      // remain the delivery plan.
      exports: undefined, uploadResults: undefined, destinationFolderId: session.revision ? session.destinationFolderId : undefined,
      destinationUrl: session.revision ? session.destinationUrl : `https://drive.google.com/drive/folders/${this.store.get().config.destinationFolders[session.studio]}`,
      status: 'exporting', lastPhase: 'exporting', error: undefined,
      message: `Exporting ${frameIds.length} approved ${frameIds.length === 1 ? 'frame' : 'frames'}.`,
    });
    return this.deliver(updated, prepareOnly);
  }

  skip(sessionId: string): Promise<Session> {
    this.assertManualSession(sessionId);
    return this.serial(() => this.skipWork(sessionId));
  }

  private async skipWork(sessionId: string): Promise<Session> {
    const session = this.requireSession(sessionId);
    if (TERMINAL.has(session.status)) throw new Error('This project is already complete or skipped.');
    if (session.revision) throw new Error('Finish the delivery revision before skipping this project.');
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
  }

  /** Reopen saved suggestions; Drive changes happen only after revision approval. */
  private assertReviewSlot(excludeId?: string): void {
    const count = this.store.read(data => data.sessions.filter(s => s.id !== excludeId && !TERMINAL.has(s.status) && !s.deferred).length);
    const limit = reviewCapacity(totalmem());
    if (count >= limit) throw new Error(`You can keep ${limit} reviews open on this computer. Close a review to open another; its draft will be kept.`);
  }

  setReviewOpen(sessionId: string, open: boolean): Promise<Session> {
    this.assertManualSession(sessionId);
    return this.serial(async () => {
      const session = this.requireSession(sessionId);
      if (!['awaiting_videos', 'awaiting_stills', 'error'].includes(session.status)) throw new Error('Only a project waiting for human review can be opened or closed.');
      if (open) this.assertReviewSlot(sessionId);
      // Do not change updatedAt: local drafts are tied to this saved revision.
      await this.store.update(data => {
        const saved = data.sessions.find(s => s.id === sessionId)!;
        saved.deferred = !open;
      });
      this.notify();
      return this.withPreviewUrls(this.requireSession(sessionId));
    });
  }

  setReviewed(studio: Studio, projectId: string, reviewed: boolean): Promise<void> {
    return this.serial(async () => {
      if (this.automaticRunning) throw new Error('Wait for automatic processing to finish before marking a human review.');
      const project = this.store.read(data => data.projects.find(p => p.studio === studio && p.id === projectId));
      if (!project) throw new Error('Refresh projects before marking a review.');
      const active = this.store.read(data => data.sessions.some(s => s.studio === studio && s.projectId === projectId && !TERMINAL.has(s.status) && !s.deferred));
      if (active) throw new Error('Save or finish the current review before marking this project Reviewed.');
      const workspace = this.options.getWorkspace();
      const row = (await workspace.listProjects(studio)).find(r => r.rowNumber === project.row);
      if (!row || row.name !== project.name || row.status !== project.status) throw new Error('The spreadsheet row changed. Refresh projects before marking a review.');
      if (!['Done', 'Reviewed'].includes(row.status)) throw new Error('Only a completed delivery can be marked Reviewed.');
      const status = reviewed ? 'Reviewed' : 'Done';
      await workspace.updateStatus(row, status, row.status);
      await this.store.update(data => { const p = data.projects.find(p => p.studio === studio && p.id === projectId); if (p) p.status = status; });
      this.notify();
    });
  }

  reviewAgain(sessionId: string): Promise<Session> {
    this.assertManualSession(sessionId);
    return this.serial(async () => {
      const session = this.requireSession(sessionId);
      if (session.status !== 'done') throw new Error('Only a completed delivery can be reopened for still review.');
      this.assertReviewSlot(sessionId);
      if (!session.stagingPath || !session.analyses?.length || !session.frames.length) {
        throw new Error('Saved analysis is unavailable; prepare a new project review.');
      }
      const uploads = uploadedItems(session);
      if (!session.destinationFolderId || uploads.some(item => item.status !== 'verified' || !item.fileId)) throw new Error('A verified delivery is required for revision.');
      const workspace = this.options.getWorkspace();
      const row = await this.currentRow(workspace, session);
      // In Process also permits recovery if the previous reopen stopped after
      // the guarded Sheet write but before the local review state was saved.
      if (!['Done', 'Reviewed', 'In Process'].includes(row.status)) throw new Error(`Cannot reopen a row marked ${row.status}.`);
      const archive = path.join(session.stagingPath, `completed-delivery-${randomUUID()}.json`);
      await fs.writeFile(archive, JSON.stringify(session, null, 2), { mode: 0o600, flag: 'wx' });
      if (row.status === 'Done' || row.status === 'Reviewed') await workspace.updateStatus(row, 'In Process', row.status);
      const reopened = await this.saveSession({ ...session,
        status: 'awaiting_stills', lastPhase: 'awaiting_stills', error: undefined,
        exports: undefined, uploadResults: undefined,
        revision: { id: randomUUID(), uploads, exports: session.exports ?? [], phase: 'staging' },
        versionFolders: session.versionFolders, previousDeliveryManifest: archive,
        message: 'Adjust the saved selection, then apply the revision to remove, add and renumber Drive stills.',
      });
      await this.store.update(data => { data.currentSessionId = session.id; });
      await this.setProjectStatus(reopened, 'In Process');
      return this.withPreviewUrls(reopened);
    });
  }

  resume(sessionId: string): Promise<Session> {
    this.assertManualSession(sessionId);
    return this.serial(async () => {
      if (this.requireSession(sessionId).deferred) {
        this.assertReviewSlot(sessionId);
        await this.store.update(data => { data.sessions.find(s => s.id === sessionId)!.deferred = false; });
      }
      return this.resumeWork(sessionId);
    });
  }

  private async resumeWork(sessionId: string, prepareOnly = false): Promise<Session> {
    const session = this.requireSession(sessionId);
    if (TERMINAL.has(session.status) || session.status === 'awaiting_videos' || session.status === 'awaiting_stills') {
      return this.withPreviewUrls(session);
    }
    const phase = session.status === 'error' ? session.lastPhase : session.status;
    if (phase === 'awaiting_stills' || phase === 'awaiting_videos') return this.saveSession({ ...session, status: phase, error: undefined });
    if (phase === 'discovering') return this.discover(session, true);
    if (phase === 'analyzing') return this.analyze(session);
    if (phase === 'exporting' || phase === 'uploading') return this.deliver(session, prepareOnly);
    throw new Error(`Cannot resume a session in ${session.status}.`);
  }

  private assertManualSession(sessionId: string): void {
    if (this.automaticRunning && this.store.get().batch?.entries.some(e => e.sessionId === sessionId && ['pending', 'running'].includes(e.status))) {
      throw new Error('This project is managed by the automatic queue. Pause the queue before editing it.');
    }
  }

  private async serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.mutationChain.then(work);
    this.mutationChain = result.then(() => undefined, () => undefined);
    return result;
  }

  private withPreviewUrls(session: Session): Session {
    const result = clone(session);
    result.message = this.deliveryMessages.get(session.id) ?? result.message;
    if (result.status === 'awaiting_stills' && result.versionFolders === undefined) {
      result.versionFolders = versionFolders(result);
    }
    if (this.options.previewUrl) {
      result.frames = result.frames.map(frame => ({ ...frame,
        previewUrl: this.options.previewUrl!(previewPath(frame.previewPath, session.stagingPath, session.id, this.stagingRoot)),
      }));
    }
    return result;
  }

  private async ensureDeliveryPath(workspace: GoogleWorkspace, root: string, route: string): Promise<DriveFile> {
    let folder: DriveFile | undefined;
    for (const name of route.split('/')) {
      folder = await workspace.ensureVersionDestination(folder?.id ?? root, name);
    }
    return folder!;
  }

  private async verifyDeliveryPath(workspace: GoogleWorkspace, root: string, route: string, id: string): Promise<void> {
    const parts = route.split('/');
    if (parts.length === 1) { await workspace.verifyVersionDestination(root, route, id); return; }
    let parent = root;
    for (let index = 0; index < parts.length; index++) {
      const matches = (await workspace.listFolderFiles(parent)).filter(file => file.name === parts[index]);
      if (matches.length !== 1) throw new Error('Delivery folder path is missing or ambiguous.');
      const expected = index === parts.length - 1 ? id : matches[0].id;
      await workspace.verifyVersionDestination(parent, parts[index], expected);
      parent = expected;
    }
  }

  /** Explicit maintenance of this app's verified PNGs; no sources or unrelated files are changed. */
  organizeRatios(sessionId: string): Promise<Session> {
    return this.serial(async () => {
      if (this.automaticRunning) throw new Error('Pause the queue before organizing delivered files.');
      let current = this.requireSession(sessionId);
      if (current.status !== 'done' || !current.destinationFolderId || !current.stagingPath) throw new Error('Only completed deliveries can be organized.');
      const workspace = this.options.getWorkspace();
      const root = current.destinationFolderId;
      await workspace.verifyProjectFolder(current.studio, current.projectName, projectYear(current), root);
      const plan = versionFolders(current);
      const items = uploadedItems(current);
      if (!items.length || items.some(item => item.status !== 'verified' || !item.fileId)) throw new Error('Delivery must contain verified files.');
      const audit = path.join(current.stagingPath, 'before-aspect-organization.json');
      try { await fs.writeFile(audit, JSON.stringify(current, null, 2), { flag: 'wx' }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const destinations = new Map<string, string>();
      for (const route of new Set(Object.values(plan))) destinations.set(route, (await this.ensureDeliveryPath(workspace, root, route)).id);
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        const route = plan[item.videoId];
        const destination = route ? destinations.get(route)! : root;
        const previous = item.folderId ?? root;
        if (previous !== destination) {
          if (item.versionName) await this.verifyDeliveryPath(workspace, root, item.versionName, previous);
          await this.verifyDeliveryPath(workspace, root, route, destination);
          await workspace.relocateVerifiedPng(item.fileId!, previous, destination, item.targetName, item.md5, item.size, item.uploadId);
        } else await workspace.verifyUploadedPng(item.fileId!, destination, item.targetName, item.md5, item.size, item.uploadId);
        items[index] = { ...item, folderId: destination, versionName: route };
        current = await this.saveSession({ ...current, uploadResults: items, message: `Organized ${index + 1} of ${items.length} PNGs by aspect ratio.` });
      }
      current = await this.saveSession({ ...current, versionFolders: plan, message: `Verified ${items.length} PNGs organized by aspect ratio.` });
      await this.writeBatchReport();
      return current;
    });
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
    const counts = new Map<string, number>();
    for (const project of fresh) {
      const key = `${project.studio}:${project.id}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const project of fresh) {
      if (counts.get(`${project.studio}:${project.id}`)! > 1) project.id = `row-${project.row}`;
    }
    const ids = new Set<string>();
    for (const project of fresh) {
      const key = `${project.studio}:${project.id}`;
      if (ids.has(key)) throw new Error(`Duplicate row returned from Stills sheet: ${key}`);
      ids.add(key);
    }
    const migrated: Session[] = [];
    await this.store.update(data => {
      const prior = studio ? data.projects.filter(project => project.studio !== studio) : [];
      // A newly repeated code must not detach an existing session from its row.
      // Match both row and original name before changing its local identifier.
      for (const session of data.sessions) {
        const project = fresh.find(item => item.studio === session.studio
          && item.row === session.projectRow && item.name === session.projectName);
        if (project && project.id !== session.projectId) {
          session.projectId = project.id;
          migrated.push(clone(session));
        }
      }
      data.projects = [...prior, ...fresh.map(project => {
        const active = data.sessions.find(session => session.studio === project.studio
          && session.projectId === project.id && !TERMINAL.has(session.status));
        return { ...project, sourcePath: active?.sourcePath };
      })];
    });
    await Promise.all(migrated.map(session => this.writeManifest(session)));
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

  private async ensureDeliveryAllowed(workspace: GoogleWorkspace, session: Session): Promise<void> {
    const row = await this.currentRow(workspace, session);
    if (row.status === 'In Process') return;
    const items = uploadedItems(session);
    // A crash can occur after the final Sheet update but before the local Done
    // state is saved. Only a fully delivered plan may recover that final step.
    if (row.status === 'Done' && ((items.length && items.every(item => item.status === 'verified'))
        || (session.revision?.phase === 'ready' && session.selectedFrameIds.length === 0 && session.exports?.length === 0))) return;
    throw new Error(`Stills row changed to ${row.status}; delivery is paused. Restore In Process before resuming.`);
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
      const config = this.store.get().config;
      if (!current.manualSourcePath && !config.sourceRoots[current.studio]?.trim()) {
        throw new Error(`Choose the ${current.studio === 'filmkraft' ? 'Filmkraft' : 'Screenbridge'} source folder in Setup before preparing a project.`);
      }
      const workspace = this.options.getWorkspace();
      const access = (await workspace.verifyRoots())[current.studio];
      if (!access?.sheetOk || !access.folderOk) {
        throw new Error([access?.sheetError, access?.folderError].filter(Boolean).join(' ') || 'Google Sheet or Drive destination is unavailable.');
      }
      await workspace.preflightProjectDestination(current.studio, current.projectName);
      await this.ensureInProcess(workspace, current, allowExistingSheet);
      const projectCode = codeFromName(current.projectName);
      const ffprobePath = this.options.ffprobePath?.() ?? config.ffprobeExecutable;
      let found = current.manualSourcePath
        ? await this.functions.discoverProjectFolderVideos({
          projectFolder: current.manualSourcePath, projectCode, ffprobePath, scanSelectedFolder: true,
        })
        : projectCode
          ? await this.functions.discoverProjectVideos({
            sourceRoot: config.sourceRoots[current.studio], projectCode, projectName: current.projectName, ffprobePath,
          })
          : (() => { throw new Error('This Stills row has no bracketed project code. Choose its project source folder, then resume.'); })();
      if (!found.videos.length && !current.manualSourcePath) {
        for (const source of config.additionalSources ?? []) {
          const folder = await findProjectFolder(source.path, projectCode, current.projectName);
          if (!folder) continue;
          found = await this.functions.discoverProjectFolderVideos({ projectFolder: folder, projectCode, ffprobePath });
          if (found.videos.length) break;
        }
      }
      current = await this.saveSession({ ...current,
        sourcePath: found.projectFolder ?? config.sourceRoots[current.studio],
        videos: found.videos, selectedVideoIds: found.videos.filter(video => video.selected).map(video => video.id),
        yearSuggestion: suggestProjectYear(found.videos, current.projectName),
        naming: { ...(current.naming ?? defaultNaming(current.projectName)), year: suggestProjectYear(found.videos, current.projectName).year },
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
        path.join(path.dirname(this.options.ffprobePath?.() ?? this.store.get().config.ffprobeExecutable ?? 'ffprobe'), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
      );
      if (!result.frames.length) throw new Error('Extract Stills returned no candidate frames.');
      current = await this.saveSession({ ...current,
        analyses: result.analyses, frames: result.frames,
        versionFolders: versionFolders(current),
        selectedFrameIds: result.frames.filter(frame => frame.selected).map(frame => frame.id),
        status: 'awaiting_stills', lastPhase: 'awaiting_stills',
        message: `Review ${result.frames.length} candidate frames before PNG export.`,
      });
      return this.withPreviewUrls(current);
    } catch (error) { return this.fail(this.requireSession(current.id), error, 'analyzing'); }
  }

  private async deliver(session: Session, prepareOnly = false): Promise<Session> {
    let current = session;
    let releaseUpload: (() => void) | undefined;
    try {
      if (!current.stagingPath || !current.naming || (!current.selectedFrameIds.length && !current.revision)) {
        throw new Error('Approved stills or staging folder are missing.');
      }
      const stagingPath = current.stagingPath;
      const naming = current.naming;
      const selectedFrameIds = current.selectedFrameIds;
      const workspace = this.options.getWorkspace();
      await this.ensureDeliveryAllowed(workspace, current);
      let exports = current.exports as ExportedStill[] | undefined;
      if (!exports) {
        current = await this.saveSession({ ...current, status: 'exporting', lastPhase: 'exporting',
          error: undefined, message: 'Exporting only the approved PNG frames.' });
        const retained = current.revision ? (current.revision.exports as ExportedStill[]).filter(file => selectedFrameIds.includes(`${file.videoId}:${file.frameId}`)).map(file => {
          const prior = (current.revision!.uploads as PlannedUpload[]).find(item => item.videoId === file.videoId && item.frameId === file.frameId);
          return { ...file, sourcePath: prior?.renamedPath ?? file.sourcePath };
        }) : [];
        const retainedIds = new Set(retained.map(file => `${file.videoId}:${file.frameId}`));
        const additions = selectedFrameIds.filter(id => !retainedIds.has(id));
        exports = [...retained, ...(additions.length ? await this.functions.exportApprovedFrames(
          current.analyses as AnalysisRecord[], additions, stagingPath, this.options.extractTool(),
        ) : [])];
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
      if (prepareOnly) return this.saveSession({ ...current, status: 'exporting', lastPhase: 'exporting',
        error: undefined, message: 'PNGs prepared; waiting for the upload slot.' });
      const previousUpload = this.uploadChain;
      this.uploadChain = new Promise<void>(resolve => { releaseUpload = resolve; });
      await previousUpload;
      // Export can take minutes; recheck the row before creating Drive folders.
      await this.ensureDeliveryAllowed(workspace, current);
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
        const destinations = new Map<string, DriveFile>();
        for (const file of exports) {
          const versionName = current.versionFolders?.[file.videoId] ?? '';
          if (!destinations.has(versionName)) {
            destinations.set(versionName, versionName
              ? await this.ensureDeliveryPath(workspace, folder.id, versionName) : folder);
          }
        }
        const plan = exports.length ? this.functions.planRenames(exports, {
          projectName: naming.project, projectType: naming.type,
        }) : { projectName: naming.project, projectType: naming.type, items: [] };
        const priorItems = current.revision?.uploads as PlannedUpload[] | undefined;
        const ownedIds = new Set(priorItems?.map(item => item.fileId));
        const existingByFolder = new Map<string, DriveFile[]>();
        for (const destination of destinations.values()) {
          existingByFolder.set(destination.id, await workspace.listFolderFiles(destination.id));
        }
        for (const file of plan.items) {
          const destination = destinations.get(current.versionFolders?.[file.videoId] ?? '')!;
          if (existingByFolder.get(destination.id)!.some(existing => !ownedIds.has(existing.id) && existing.name.toLowerCase() === file.targetName.toLowerCase())) {
            throw new Error(`Destination already contains ${file.targetName}; upload stopped without overwriting it.`);
          }
        }
        const renamed = plan.items.length ? await this.functions.stageAndRenameApprovedStills(
          plan, stagingPath, this.options.renameTool(),
        ) : { files: [] };
        items = [];
        for (const file of renamed.files) {
          const { size, md5 } = await fingerprint(file.renamedPath);
          const prior = priorItems?.find(item => item.videoId === file.videoId && item.frameId === file.frameId);
          if (prior && (prior.md5 !== md5 || prior.size !== size)) throw new Error('Retained still differs from its verified delivery.');
          items.push({ videoId: file.videoId, frameId: file.frameId,
            sourcePath: file.sourcePath, renamedPath: file.renamedPath,
            targetName: file.targetName, size, md5, uploadId: prior?.uploadId ?? randomUUID(), status: prior ? 'verified' : 'planned', fileId: prior?.fileId,
            folderId: destinations.get(current.versionFolders?.[file.videoId] ?? '')!.id,
            versionName: current.versionFolders?.[file.videoId] });
        }
        current = await this.saveSession({ ...current, status: 'uploading', lastPhase: 'uploading',
          uploadResults: items, message: current.revision ? `Updating Drive: keeping ${items.filter(item => item.status === 'verified').length} existing stills; uploading ${items.filter(item => item.status !== 'verified').length} additions only.` : `Ready to upload ${items.length} approved PNGs.` });
      } else if (current.status !== 'uploading') {
        current = await this.saveSession({ ...current, status: 'uploading', lastPhase: 'uploading',
          error: undefined, message: 'Resuming verified Drive delivery.' });
      }
      // A saved upload plan is immutable across restarts. Legacy plans without
      // folder metadata stay flat; a partial version plan must never fall back.
      const routes = new Map<string, string>();
      const plannedIds = items.map(item => `${item.videoId}:${item.frameId}`);
      if (items.length !== approvedOrder.size || new Set(plannedIds).size !== items.length
          || plannedIds.some(id => !approvedOrder.has(id))) {
        throw new Error('Saved upload plan does not match the approved stills.');
      }
      for (const item of items) {
        const expectedVersion = current.versionFolders?.[item.videoId];
        if (item.versionName !== expectedVersion || (expectedVersion && !item.folderId)
            || (!item.versionName && item.folderId && item.folderId !== folder.id)) {
          throw new Error('Saved upload destination differs from the reviewed version folder.');
        }
        const folderId = item.folderId ?? folder.id;
        const previousName = routes.get(folderId);
        if (previousName !== undefined && previousName !== (item.versionName ?? '')) {
          throw new Error('Different video versions share a saved destination folder.');
        }
        routes.set(folderId, item.versionName ?? '');
      }
      const verifyRoutes = async () => {
        await workspace.verifyProjectFolder(current.studio, current.projectName, projectYear(current), folder.id);
        for (const [folderId, versionName] of routes) {
          if (versionName) await this.verifyDeliveryPath(workspace, folder.id, versionName, folderId);
        }
      };
      await verifyRoutes();
      if (current.revision && current.revision.phase !== 'ready') {
        const prior = current.revision.uploads as PlannedUpload[];
        const temporary = (item: PlannedUpload) => `stills-revision-${current.revision!.id}-${item.uploadId}.png`;
        const retainedById = new Map(items.filter(item => item.fileId).map(item => [item.fileId!, item]));
        const removed = prior.filter(item => !retainedById.has(item.fileId!));
        const changed = prior.filter(item => retainedById.has(item.fileId!) && retainedById.get(item.fileId!)!.targetName !== item.targetName);
        const priorRoutes = new Map(prior.map(item => [item.folderId ?? folder.id, item.versionName]));
        await revisionSteps([...priorRoutes], async ([folderId, route]) => { if (route) await this.verifyDeliveryPath(workspace, folder.id, route, folderId); });
        // Only retained files that change names need temporary names. Removed
        // files can go straight to Trash, including older interrupted temp names.
        if (current.revision.phase === 'staging') {
          await revisionSteps(changed, async (item, i) => {
            this.deliveryMessage(current.id, `Preparing renumbering: ${i + 1} of ${changed.length} retained stills. No stills are being uploaded.`);
            await workspace.reviseVerifiedPng(item.fileId!, item.folderId ?? folder.id, item.targetName, temporary(item), item.md5, item.size, item.uploadId);
          });
          current = await this.saveSession({ ...current, revision: { ...current.revision, phase: 'finishing' } });
        }
        // Free all removed filenames before assigning final names to retained files.
        await revisionSteps(removed, async (item, i) => {
          this.deliveryMessage(current.id, `Removing skipped stills: ${i + 1} of ${removed.length}. Moving files to Drive Trash.`);
          await workspace.reviseVerifiedPng(item.fileId!, item.folderId ?? folder.id, item.targetName, null, item.md5, item.size, item.uploadId, [temporary(item)]);
        });
        const retained = prior.filter(item => retainedById.has(item.fileId!));
        await revisionSteps(retained, async (item, i) => {
          this.deliveryMessage(current.id, `Renumbering existing stills: ${i + 1} of ${retained.length}. Keeping the existing Drive files.`);
          await workspace.reviseVerifiedPng(item.fileId!, item.folderId ?? folder.id, item.targetName, retainedById.get(item.fileId!)!.targetName, item.md5, item.size, item.uploadId, [temporary(item)]);
        });
        current = await this.saveSession({ ...current, revision: { ...current.revision!, phase: 'ready' } });
      }
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        if (current.revision) {
          const originalIds = new Set((current.revision.uploads as PlannedUpload[]).map(old => old.uploadId));
          const added = items.filter(file => !originalIds.has(file.uploadId));
          this.deliveryMessage(current.id, item.status === 'verified'
            ? `Verifying existing stills: ${index + 1} of ${items.length}. No re-upload is needed.`
            : `Uploading new stills only: ${added.filter(file => file.status === 'verified').length + 1} of ${added.length}.`);
        }
        const folderId = item.folderId ?? folder.id;
        const local = await fingerprint(item.renamedPath);
        if (local.size !== item.size || local.md5 !== item.md5) {
          throw new Error(`Staging PNG changed after approval: ${item.targetName}`);
        }
        if (item.status === 'verified') {
          if (!item.fileId) throw new Error(`Missing Drive file ID for ${item.targetName}.`);
          await workspace.verifyUploadedPng(item.fileId, folderId, item.targetName, item.md5, item.size, item.uploadId);
          continue;
        }
        const matches = (await workspace.listFolderFiles(folderId)).filter(file =>
          file.name.toLowerCase() === item.targetName.toLowerCase());
        if (matches.length) {
          if (item.status !== 'attempting' || matches.length !== 1
              || matches[0].name !== item.targetName || matches[0].mimeType !== PNG_MIME
              || matches[0].size !== String(item.size)
              || matches[0].md5Checksum?.toLowerCase() !== item.md5.toLowerCase()
              || matches[0].appProperties?.stillsLibraryUploadId !== item.uploadId) {
            throw new Error(`Destination already contains ${item.targetName}; upload stopped without overwriting it.`);
          }
          await workspace.verifyUploadedPng(matches[0].id, folderId, item.targetName, item.md5, item.size, item.uploadId);
          items[index] = { ...item, status: 'verified', fileId: matches[0].id };
        } else {
          await this.ensureDeliveryAllowed(workspace, current);
          if (item.versionName) await this.verifyDeliveryPath(workspace, folder.id, item.versionName, folderId);
          if (item.status !== 'attempting') {
            items[index] = { ...item, status: 'attempting' };
            current = await this.saveSession({ ...current, uploadResults: items });
          }
          const uploaded = await workspace.uploadPng({ folderId,
            filePath: item.renamedPath, fileName: item.targetName, uploadId: item.uploadId });
          items[index] = { ...items[index], status: 'verified', fileId: uploaded.id };
        }
        current = await this.saveSession({ ...current, uploadResults: items,
          message: `Verified ${items.filter(entry => entry.status === 'verified').length} of ${items.length} PNGs in Drive.` });
      }
      for (const item of items) {
        if (!item.fileId || item.status !== 'verified') throw new Error(`Upload incomplete: ${item.targetName}`);
        await workspace.verifyUploadedPng(item.fileId, item.folderId ?? folder.id, item.targetName, item.md5, item.size, item.uploadId);
      }
      const finalFiles = new Map<string, DriveFile[]>();
      for (const folderId of routes.keys()) finalFiles.set(folderId, await workspace.listFolderFiles(folderId));
      for (const item of items) {
        const matches = finalFiles.get(item.folderId ?? folder.id)!.filter(file => file.name.toLowerCase() === item.targetName.toLowerCase());
        if (matches.length !== 1 || matches[0].id !== item.fileId) {
          throw new Error(`Drive contains a new filename conflict for ${item.targetName}; Stills row remains In Process.`);
        }
      }
      await verifyRoutes();
      if (current.revision) {
        if (!current.revision.folderCleanup) {
          const cleanup = new Map<string, { id: string; parentId: string; name: string; status: 'planned' | 'trashed' | 'kept' }>();
          const unused = new Map((current.revision.uploads as PlannedUpload[])
            .filter(item => item.folderId && item.folderId !== folder.id && !routes.has(item.folderId))
            .map(item => [item.folderId!, item.versionName]));
          for (const [folderId, route] of unused) {
            if (!route) throw new Error('Missing reviewed folder path for cleanup.');
            const parts = route.split('/');
            let child = await workspace.getFile(folderId);
            for (let index = parts.length - 1; index >= 0; index--) {
              if (child.name !== parts[index] || child.mimeType !== 'application/vnd.google-apps.folder' || child.parents?.length !== 1
                  || (index === 0 && child.parents[0] !== folder.id)) throw new Error('Delivery folder ancestry changed; cleanup stopped.');
              if (!routes.has(child.id)) cleanup.set(child.id, { id: child.id, parentId: child.parents[0], name: child.name, status: 'planned' });
              if (index > 0) child = await workspace.getFile(child.parents[0]);
            }
          }
          // Every leaf must be attempted before its aspect parent.
          const folders = [...cleanup.values()].sort((a, b) => Number(a.parentId === folder.id) - Number(b.parentId === folder.id));
          current = await this.saveSession({ ...current, revision: { ...current.revision, folderCleanup: folders } });
        }
        for (let index = 0; index < current.revision!.folderCleanup!.length; index++) {
          const entry = current.revision!.folderCleanup![index];
          if (entry.status !== 'planned') continue;
          this.deliveryMessage(current.id, `Cleaning empty video folders: ${index + 1} of ${current.revision!.folderCleanup!.length}.`);
          const trashed = await workspace.trashEmptyDeliveryFolder(entry.id, entry.parentId, entry.name);
          const folders = current.revision!.folderCleanup!.map((item, i) => i === index ? { ...item, status: trashed ? 'trashed' as const : 'kept' as const } : item);
          current = await this.saveSession({ ...current, revision: { ...current.revision!, folderCleanup: folders } });
        }
      }
      const row = await this.currentRow(workspace, current);
      if (row.status === 'In Process') await workspace.updateStatus(row, 'Done', 'In Process');
      else if (row.status !== 'Done') throw new Error(`Stills row is ${row.status}; cannot mark Done.`);
      await this.setProjectStatus(current, 'Done');
      return this.saveSession({ ...current, revision: undefined, status: 'done', lastPhase: 'done', error: undefined,
        message: `Verified ${items.length} PNGs in Drive and marked the Stills row Done.` });
    } catch (error) {
      const latest = this.requireSession(current.id);
      const phase = latest.status === 'uploading' ? 'uploading' : 'exporting';
      if (phase === 'exporting' && !latest.uploadResults?.length) {
        return this.saveSession({ ...latest, status: 'awaiting_stills', lastPhase: 'awaiting_stills',
          error: errorMessage(error), message: 'Delivery paused before upload. Resolve the error, then approve again.' });
      }
      return this.fail(latest, error, phase);
    } finally {
      if (this.deliveryMessages.delete(current.id)) this.notify();
      releaseUpload?.();
    }
  }
}
