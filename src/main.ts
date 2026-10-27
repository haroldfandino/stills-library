import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { app, BrowserWindow, dialog, ipcMain, protocol, shell, powerSaveBlocker } from 'electron';
import type { AppState, Studio } from './shared/contracts';
import { dataDir } from './shared/runtime';
import { resolveTools } from './shared/tool-paths';
import { SOURCE_CONFIG, GoogleAuth, GoogleWorkspace } from './google';
import type { SourceConfigs } from './google';
import { JsonStore } from './service/storage';
import { ElectronClientCredentialsStore, ElectronTokenStore } from './service/token-store';
import { parseDesktopCredentials } from './google/desktop-credentials';
import { startRpcServer } from './service/rpc';
import { WorkflowService } from './service/workflow';
import type { CommandSpec } from './core/extraction';
import { runtimeJournal } from './service/runtime-journal';

protocol.registerSchemesAsPrivileged([
  { scheme: 'stills-preview', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
// Newly created AppData can be redirected by Windows. Resolve it again before
// assigning the instance lock, state store, staging root, and local service.
const directory = dataDir();
// Each explicit data directory has its own app instance and local CLI service.
app.setPath('userData', directory);
const journal = runtimeJournal(directory);
process.on('uncaughtExceptionMonitor', error => journal('uncaught-exception', { message: error.message, stack: error.stack }));
app.on('child-process-gone', (_event, details) => journal('child-process-gone', { ...details }));
const squirrelEvent = process.platform === 'win32' ? process.argv.find(arg => /^--squirrel-(install|updated|uninstall|obsolete)$/.test(arg)) : undefined;
const gotLock = !squirrelEvent && app.requestSingleInstanceLock();
if (squirrelEvent) {
  if (squirrelEvent === '--squirrel-obsolete') app.quit();
  else {
    const updater = path.resolve(path.dirname(process.execPath), '..', 'Update.exe');
    const operation = squirrelEvent === '--squirrel-uninstall' ? '--removeShortcut' : '--createShortcut';
    const child = spawn(updater, [operation, path.basename(process.execPath)], { windowsHide: true });
    child.once('error', () => app.quit());
    child.once('exit', () => app.quit());
  }
} else if (!gotLock) app.quit();
const stagingRoot = path.join(directory, 'staging');
const store = new JsonStore(directory);
const tokenStore = new ElectronTokenStore(directory);
const clientCredentialsStore = new ElectronClientCredentialsStore(directory);
const previewFiles = new Map<string, string>();
let window: BrowserWindow | null = null;
let service: WorkflowService;
let auth: GoogleAuth | null = null;
let email: string | undefined;
let rpcServer: Awaited<ReturnType<typeof startRpcServer>> | null = null;
let backgroundError: string | undefined;
let wakeLock: number | undefined;
let authorizationUrl: string | undefined;

function assertStudio(value: unknown): asserts value is Studio {
  if (value !== 'filmkraft' && value !== 'screenbridge') throw new Error('Choose Filmkraft or Screenbridge.');
}

function currentWorkspace(): GoogleWorkspace {
  if (!auth) throw new Error('Set a Google desktop OAuth client ID in Setup, then sign in.');
  const config = store.get().config;
  const sources: SourceConfigs = {
    filmkraft: { ...SOURCE_CONFIG.filmkraft, destinationFolderId: config.destinationFolders.filmkraft },
    screenbridge: { ...SOURCE_CONFIG.screenbridge, destinationFolderId: config.destinationFolders.screenbridge },
  };
  return new GoogleWorkspace({ auth, sources, interactive: !service?.automaticRunning });
}

function tools() {
  return resolveTools(store.get().config, { root: path.resolve(__dirname, '..'), resourcesPath: process.resourcesPath, packaged: app.isPackaged });
}
function extractTool(): CommandSpec { return tools().extract; }
function renameTool(): CommandSpec { return tools().rename; }
function ffprobePath(): string { return tools().ffprobe; }

function previewUrl(filePath: string): string {
  const key = crypto.createHash('sha256').update(filePath).digest('hex');
  previewFiles.set(key, filePath);
  return `stills-preview://frame/${key}`;
}

function state(includeDetails = false): AppState {
  const googleClientId = store.read(value => value.config.googleClientId);
  return { ...service.getState(includeDetails), accountEmail: email, authenticated: Boolean(email),
    configured: Boolean(googleClientId), googleClientId, error: backgroundError };
}

function broadcast(): void {
  if (service?.automaticRunning && wakeLock === undefined) wakeLock = powerSaveBlocker.start('prevent-app-suspension');
  if (!service?.automaticRunning && wakeLock !== undefined) { powerSaveBlocker.stop(wakeLock); wakeLock = undefined; }
  if (!window || window.isDestroyed()) return;
  window.webContents.send('stills:state', state());
}

async function initializeGoogle(): Promise<void> {
  const clientId = store.get().config.googleClientId.trim();
  const credentials = await clientCredentialsStore.load().catch(() => {
    backgroundError = 'Saved Google credentials could not be opened on this computer. Import the Desktop OAuth JSON again in Setup.';
    return null;
  });
  auth = clientId ? new GoogleAuth({
    clientId, tokenStore, expectedEmail: 'harold@filmkraft.tv',
    clientSecret: credentials?.clientId === clientId ? credentials.clientSecret : undefined,
    openBrowser: url => { authorizationUrl = url; return shell.openExternal(url); },
    timeoutMs: 600_000,
  }) : null;
}

async function confirmRoots(): Promise<void> {
  const workspace = currentWorkspace();
  let roots = await workspace.verifyRoots();
  if (Object.values(roots).some(root => root.requiresPicker)) {
    if (!auth) throw new Error('Google sign-in is required.');
    const fileIds = Object.values(workspace.sources).flatMap(item => [item.spreadsheetId, item.destinationFolderId]);
    await auth.pickFiles({ fileIds, allowFolders: true, allowMultiple: true });
    roots = await workspace.verifyRoots();
  }
  const failures = Object.values(roots).flatMap(root => [root.sheetOk ? '' : `${root.source} Stills sheet: ${root.sheetError}`,
    root.folderOk ? '' : `${root.source} destination: ${root.folderError}`]).filter(Boolean);
  if (failures.length) throw new Error(`Google access is incomplete. ${failures.join(' ')}`);
  const nested = await workspace.destinationFolderGrantTargets();
  const missing = nested.filter(folder => folder.isAppAuthorized === false);
  if (missing.length) {
    if (!auth) throw new Error('Google sign-in is required.');
    await auth.pickFiles({ fileIds: missing.map(folder => folder.id), allowFolders: true, allowMultiple: true });
    const notGranted: string[] = [];
    for (const folder of missing) {
      if ((await workspace.getFile(folder.id)).isAppAuthorized === false) notGranted.push(folder.name);
    }
    if (notGranted.length) {
      throw new Error(`Google Picker did not grant Stills Library access to: ${notGranted.join(', ')}. Sign in again and select these folders.`);
    }
  }
}

async function allowedLocalPath(input: string): Promise<string> {
  if (typeof input !== 'string' || !input) throw new Error('Choose a local path.');
  const candidate = await fs.realpath(input);
  const roots = [...Object.values(store.get().config.sourceRoots), ...(store.get().config.additionalSources ?? []).map(source => source.path), stagingRoot];
  for (const root of roots) {
    if (!root.trim()) continue;
    let realRoot: string;
    try { realRoot = await fs.realpath(root); } catch { continue; }
    const relative = path.relative(realRoot, candidate);
    if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
      return candidate;
    }
  }
  throw new Error('Only configured source and staging paths can be opened.');
}

async function dispatch(method: string, args: unknown[], origin: 'gui' | 'cli'): Promise<unknown> {
  if (service.automaticRunning && ['prepare', 'approveVideos', 'approveStills', 'skip', 'resume', 'reviewAgain', 'setSource', 'setProjectSource', 'chooseRoots', 'chooseProjectSource', 'signOut', 'configureGoogle', 'importGoogleCredentials'].includes(method)) {
    throw new Error('Pause the automatic queue after its current project before making manual changes.');
  }
  switch (method) {
    case 'addSource': return service.addSource(String(args[0]), String(args[1]));
    case 'retryMissingSources': return service.retryMissingSources(args[0] === true);
    case 'authorizationUrl': return authorizationUrl;
    case 'organizeRatios': return service.organizeRatios(String(args[0] ?? ''));
    case 'retryBatch': return service.retryBatchFailures();
    case 'grantQueueFolders': {
      if (service.automaticRunning) throw new Error('Pause the automatic queue before granting folder access.');
      if (!auth) throw new Error('Sign in first.');
      const workspace = currentWorkspace();
      const names = new Set(store.get().batch?.entries.filter(e => e.status !== 'done' && e.status !== 'skipped').map(e => e.project.name) ?? []);
      const years = (await workspace.destinationFolderGrantTargets()).filter(folder => /^20\d{2}$/.test(folder.name));
      const missing = [];
      for (const year of years) {
        for (const folder of await workspace.listFolderFiles(year.id)) {
          if (names.has(folder.name) && folder.mimeType === 'application/vnd.google-apps.folder' && folder.isAppAuthorized === false) missing.push(folder);
        }
      }
      if (missing.length) await auth.pickFiles({ fileIds: missing.map(f => f.id), allowFolders: true, allowMultiple: true });
      const remaining = [];
      for (const folder of missing) if ((await workspace.getFile(folder.id)).isAppAuthorized === false) remaining.push(folder.name);
      if (remaining.length) throw new Error(`Folder access still missing: ${remaining.join(', ')}`);
      return { granted: missing.map(f => f.name) };
    }
    case 'startBatch': return service.startBatch(args[0] === true);
    case 'pauseBatch': return service.pauseBatch();
    case 'getState': return state(origin !== 'gui');
    case 'getSession': return origin === 'gui' ? service.getSessionView(String(args[0] ?? '')) : service.getSession(String(args[0] ?? ''));
    case 'listProjects': return service.listProjects();
    case 'prepare': assertStudio(args[0]); return service.prepare(args[0], String(args[1] ?? ''));
    case 'approveVideos':
      if (origin !== 'gui') throw new Error('Video approval happens in the GUI.');
      return service.approveVideos(String(args[0] ?? ''), args[1] as string[]);
    case 'approveStills':
      if (origin !== 'gui') throw new Error('Stills approval happens in the GUI.');
      return service.approveStills(String(args[0] ?? ''), args[1] as string[], args[2] as {project: string; type: string; year: string});
    case 'skip':
      if (origin !== 'gui') throw new Error('Skipping a project requires a reviewer in the GUI.');
      return service.skip(String(args[0] ?? ''));
    case 'resume': return service.resume(String(args[0] ?? ''));
    case 'getStatusSchema': return currentWorkspace().getStatusSchema();
    case 'createStartMenuShortcut': {
      if (process.platform !== 'win32' || !app.isPackaged) throw new Error('Start menu shortcuts require the packaged Windows app.');
      const folder = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
      await fs.mkdir(folder, { recursive: true });
      const shortcut = path.join(folder, 'Stills Library.lnk');
      if (!shell.writeShortcutLink(shortcut, 'create', { target: process.execPath, cwd: path.dirname(process.execPath), icon: process.execPath, iconIndex: 0, description: 'Stills Library — review video stills', appUserModelId: 'tv.filmkraft.stills-library' })) throw new Error('Could not create the Start menu shortcut.');
      return shortcut;
    }
    case 'ensureReviewedStatusOptions': return currentWorkspace().ensureReviewedStatusOptions();
    case 'setReviewed':
      if (origin !== 'gui') throw new Error('Human review must be marked in the app.');
      assertStudio(args[0]);
      if (typeof args[2] !== 'boolean') throw new Error('Reviewed must be checked or unchecked.');
      return service.setReviewed(args[0], String(args[1] ?? ''), args[2]);
    case 'reviewAgain': return service.reviewAgain(String(args[0] ?? ''));
    case 'configureGoogle': {
      const clientId = String(args[0] ?? '').trim();
      if (!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error('Enter a Google Desktop OAuth client ID ending in .apps.googleusercontent.com.');
      const old = store.get().config.googleClientId;
      if (old && old !== clientId) { await tokenStore.clear(); email = undefined; }
      if (old !== clientId) await clientCredentialsStore.clear();
      await service.configureGoogle(clientId);
      await initializeGoogle();
      backgroundError = undefined;
      broadcast();
      return state();
    }
    case 'importGoogleCredentials': {
      let file = typeof args[0] === 'string' ? args[0] : undefined;
      if (!file) {
        if (origin !== 'gui') throw new Error('Pass the path to the downloaded Desktop OAuth JSON file.');
        const options: Electron.OpenDialogOptions = {
          title: 'Import Google Desktop OAuth credentials', properties: ['openFile'],
          filters: [{ name: 'Google OAuth credentials', extensions: ['json'] }],
        };
        const chosen = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
        if (chosen.canceled || !chosen.filePaths[0]) return state();
        file = chosen.filePaths[0];
      }
      if ((await fs.stat(file)).size > 64 * 1024) throw new Error('The selected OAuth JSON file is too large.');
      const credentials = parseDesktopCredentials(await fs.readFile(file, 'utf8'));
      const old = store.get().config.googleClientId;
      if (old && old !== credentials.clientId) { await tokenStore.clear(); email = undefined; }
      await clientCredentialsStore.save(credentials);
      await service.configureGoogle(credentials.clientId);
      await initializeGoogle();
      backgroundError = undefined;
      broadcast();
      return state();
    }
    case 'signIn': {
      if (!auth) throw new Error('Save the Google desktop OAuth client ID in Setup first.');
      try { email = await auth.signIn(); }
      catch (error) {
        email = await auth.currentEmail().catch(() => null) ?? undefined;
        broadcast();
        throw error;
      }
      broadcast();
      await confirmRoots();
      backgroundError = undefined;
      broadcast();
      return state();
    }
    case 'signOut': {
      if (auth) await auth.signOut(); else await tokenStore.clear();
      email = undefined;
      backgroundError = undefined;
      await initializeGoogle();
      broadcast();
      return state();
    }
    case 'setSource': {
      assertStudio(args[0]);
      const input = String(args[1] ?? '');
      if (!input.trim()) throw new Error('Choose a source folder.');
      const candidate = await fs.realpath(input);
      if (!(await fs.stat(candidate)).isDirectory()) throw new Error('Source root must be a folder.');
      await service.setSource(args[0], candidate);
      broadcast();
      return state();
    }
    case 'setProjectSource': {
      const sessionId = String(args[0] ?? '');
      const input = String(args[1] ?? '');
      if (!input.trim()) throw new Error('Choose a project folder.');
      const folder = await fs.realpath(input);
      await service.setProjectSource(sessionId, folder);
      broadcast();
      return service.getSession(sessionId);
    }
    case 'chooseRoots': {
      const studio = args[0];
      if (studio !== undefined) assertStudio(studio);
      const pickerOptions: Electron.OpenDialogOptions = {
        title: `Choose ${studio ?? 'source'} folder`, properties: ['openDirectory'],
      };
      const chosen = window
        ? await dialog.showOpenDialog(window, pickerOptions)
        : await dialog.showOpenDialog(pickerOptions);
      if (chosen.canceled || !chosen.filePaths[0]) return state();
      if (studio) {
        await service.setSource(studio, chosen.filePaths[0]);
      } else {
        throw new Error('Choose Filmkraft or Screenbridge before selecting a source folder.');
      }
      broadcast();
      return state();
    }
    case 'chooseProjectSource': {
      const sessionId = String(args[0] ?? '');
      const session = service.getSession(sessionId);
      if (!session) throw new Error('Choose a project session first.');
      const pickerOptions: Electron.OpenDialogOptions = {
        title: `Choose final video folder for ${session.projectName}`,
        defaultPath: session.manualSourcePath || session.sourcePath || store.get().config.sourceRoots[session.studio],
        properties: ['openDirectory'],
      };
      const chosen = window
        ? await dialog.showOpenDialog(window, pickerOptions)
        : await dialog.showOpenDialog(pickerOptions);
      if (chosen.canceled || !chosen.filePaths[0]) return service.getSession(sessionId);
      const folder = await fs.realpath(chosen.filePaths[0]);
      await service.setProjectSource(sessionId, folder);
      broadcast();
      return service.getSession(sessionId);
    }
    case 'openPath': {
      const error = await shell.openPath(await allowedLocalPath(String(args[0] ?? '')));
      if (error) throw new Error(error);
      return true;
    }
    case 'revealPath': shell.showItemInFolder(await allowedLocalPath(String(args[0] ?? ''))); return true;
    case 'openUrl': {
      const url = new URL(String(args[0] ?? ''));
      if (url.protocol !== 'https:' || url.hostname !== 'drive.google.com' || !url.pathname.startsWith('/drive/folders/')) {
        throw new Error('Only the configured Drive folder can be opened.');
      }
      await shell.openExternal(url.toString());
      return true;
    }
    default: throw new Error(`Unknown Stills Library action: ${method}`);
  }
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1480, height: 980, minWidth: 900, minHeight: 640,
    title: 'Stills Library', backgroundColor: '#111717',
    icon: path.join(__dirname, '..', 'assets', 'stills-library.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  const created = window;
  let recovering = false;
  let recoveryTimes: number[] = [];
  let unresponsiveTimer: ReturnType<typeof setTimeout> | undefined;
  const recover = (reason: string, terminate = false) => {
    if (created.isDestroyed() || recovering) return;
    recoveryTimes = recoveryTimes.filter(time => Date.now() - time < 300_000);
    if (recoveryTimes.length >= 2) { journal('renderer-recovery-limit', { reason }); return; }
    recoveryTimes.push(Date.now());
    recovering = true;
    journal('renderer-recovery', { reason });
    if (terminate) created.webContents.forcefullyCrashRenderer();
    created.webContents.reload();
  };
  created.webContents.on('render-process-gone', (_event, details) => {
    journal('render-process-gone', { ...details });
    if (details.reason !== 'clean-exit') recover(details.reason);
  });
  created.webContents.on('did-finish-load', () => { recovering = false; journal('renderer-ready'); });
  created.on('unresponsive', () => {
    journal('window-unresponsive');
    if (!unresponsiveTimer) unresponsiveTimer = setTimeout(() => { unresponsiveTimer = undefined; recover('unresponsive', true); }, 15_000);
  });
  created.on('responsive', () => { clearTimeout(unresponsiveTimer); unresponsiveTimer = undefined; });
  created.on('closed', () => { clearTimeout(unresponsiveTimer); journal('window-closed'); });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  void window.loadFile(path.join(__dirname, 'renderer', 'index.html')).catch(error => journal('renderer-load-failed', { message: String(error) }));
  window.on('closed', () => { window = null; });
}

async function main(): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await app.whenReady();
  journal('app-start', { version: app.getVersion() });
  const metrics = setInterval(() => journal('memory', { main: process.memoryUsage(),
    processes: app.getAppMetrics().map(metric => ({ type: metric.type, pid: metric.pid, memory: metric.memory })) }), 60_000);
  metrics.unref();
  if (process.platform === 'win32') app.setAppUserModelId('tv.filmkraft.stills-library');
  service = new WorkflowService({
    store,
    getWorkspace: currentWorkspace,
    extractTool,
    renameTool,
    ffprobePath,
    stagingRoot,
    previewUrl,
    onChange: broadcast,
  });
  await service.initialize();
  await initializeGoogle();
  if (auth) {
    try {
      const storedEmail = await auth.currentEmail();
      if (storedEmail) { await auth.getAccessToken(); email = storedEmail; }
    } catch (error) { backgroundError = error instanceof Error ? error.message : String(error); }
  }
  protocol.handle('stills-preview', async request => {
    const url = new URL(request.url);
    if (url.hostname !== 'frame' || !/^\/[a-f0-9]{64}$/.test(url.pathname)) return new Response('Not found', { status: 404 });
    const filePath = previewFiles.get(url.pathname.slice(1));
    if (!filePath) return new Response('Not found', { status: 404 });
    const savedRelative = path.relative(stagingRoot, filePath);
    if (!savedRelative || savedRelative === '..' || savedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(savedRelative)) return new Response('Forbidden', { status: 403 });
    const realFile = await fs.realpath(filePath).catch(() => null);
    // A migrated session folder can be a Windows junction to the original
    // data directory. Resolve that session's boundary before checking the file.
    const sessionRoot = path.join(stagingRoot, savedRelative.split(path.sep)[0]);
    const realRoot = await fs.realpath(sessionRoot).catch(() => null);
    if (!realFile || !realRoot) return new Response('Not found', { status: 404 });
    const relative = path.relative(realRoot, realFile);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return new Response('Forbidden', { status: 403 });
    try {
      const bytes = await fs.readFile(realFile);
      const mime = /\.png$/i.test(realFile) ? 'image/png' : 'image/jpeg';
      return new Response(bytes, { headers: { 'Content-Type': mime, 'Cache-Control': 'no-store' } });
    } catch { return new Response('Not found', { status: 404 }); }
  });
  ipcMain.handle('stills:call', (event, method: unknown, args: unknown) => {
    if (!window || event.sender !== window.webContents) throw new Error('Unknown renderer.');
    if (typeof method !== 'string' || !Array.isArray(args)) throw new Error('Invalid Stills Library request.');
    return dispatch(method, args, 'gui');
  });
  rpcServer = await startRpcServer((method, args) => dispatch(method, args, 'cli'));
  createWindow();
  if (email) service.continueBatch();
  app.on('activate', () => { if (!window) createWindow(); });
  app.on('second-instance', () => { if (!window) createWindow(); window?.show(); window?.focus(); });
}

if (gotLock) {
  void main().catch(error => {
    journal('startup-failed', { message: String(error) });
    backgroundError = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox('Stills Library could not start', backgroundError);
    app.quit();
  });
}

app.on('before-quit', () => { journal('app-quit'); rpcServer?.close(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !service?.automaticRunning) app.quit(); });
