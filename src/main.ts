import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron';
import type { AppState, Studio } from './shared/contracts';
import { dataDir } from './shared/runtime';
import { SOURCE_CONFIG, GoogleAuth, GoogleWorkspace } from './google';
import type { SourceConfigs } from './google';
import { JsonStore } from './service/storage';
import { ElectronTokenStore } from './service/token-store';
import { startRpcServer } from './service/rpc';
import { WorkflowService } from './service/workflow';
import type { CommandSpec } from './core/extraction';

protocol.registerSchemesAsPrivileged([
  { scheme: 'stills-preview', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

const directory = dataDir();
const stagingRoot = path.join(directory, 'staging');
const store = new JsonStore(directory);
const tokenStore = new ElectronTokenStore(directory);
const previewFiles = new Map<string, string>();
let window: BrowserWindow | null = null;
let service: WorkflowService;
let auth: GoogleAuth | null = null;
let email: string | undefined;
let rpcServer: Awaited<ReturnType<typeof startRpcServer>> | null = null;
let backgroundError: string | undefined;

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
  return new GoogleWorkspace({ auth, sources });
}

function bundledTool(name: 'extract-stills' | 'rename-stills'): string {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const base = path.join(process.resourcesPath, process.arch);
  return name === 'extract-stills'
    ? path.join(base, 'extract-stills', `extract-stills${suffix}`)
    : path.join(base, `rename-stills${suffix}`);
}

function extractTool(): CommandSpec {
  const config = store.get().config;
  if (config.extractExecutable) return { command: config.extractExecutable };
  if (app.isPackaged) return { command: bundledTool('extract-stills') };
  const script = path.resolve(__dirname, '../../extract-stills/cli_entry.py');
  return { command: config.pythonExecutable || 'python3.12', args: [script] };
}

function renameTool(): CommandSpec {
  const config = store.get().config;
  if (config.renameExecutable) return { command: config.renameExecutable };
  if (app.isPackaged) return { command: bundledTool('rename-stills') };
  const script = config.renameScript || path.resolve(__dirname, '../../postproduction-tools/Rename_stills/rename_stills.py');
  return { command: config.pythonExecutable || 'python3.12', args: [script] };
}

function ffprobePath(): string {
  const configured = store.get().config.ffprobeExecutable;
  if (app.isPackaged) {
    return path.join(process.resourcesPath, process.arch, 'extract-stills', '_internal', 'binaries',
      process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  }
  return configured || 'ffprobe';
}

function previewUrl(filePath: string): string {
  const key = crypto.createHash('sha256').update(filePath).digest('hex');
  previewFiles.set(key, filePath);
  return `stills-preview://frame/${key}`;
}

function state(): AppState {
  return { ...service.getState(), accountEmail: email, authenticated: Boolean(email),
    configured: Boolean(store.get().config.googleClientId), error: backgroundError };
}

function broadcast(): void {
  if (!window || window.isDestroyed()) return;
  window.webContents.send('stills:state', state());
}

function initializeGoogle(): void {
  const clientId = store.get().config.googleClientId.trim();
  auth = clientId ? new GoogleAuth({
    clientId, tokenStore, expectedEmail: 'harold@filmkraft.tv',
    openBrowser: url => shell.openExternal(url),
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
  const roots = [...Object.values(store.get().config.sourceRoots), stagingRoot];
  for (const root of roots) {
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
  switch (method) {
    case 'getState': return state();
    case 'getSession': return service.getSession(String(args[0] ?? ''));
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
    case 'configureGoogle': {
      const clientId = String(args[0] ?? '').trim();
      if (!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error('Enter a Google Desktop OAuth client ID ending in .apps.googleusercontent.com.');
      const old = store.get().config.googleClientId;
      if (old && old !== clientId) { await tokenStore.clear(); email = undefined; }
      await service.configureGoogle(clientId);
      initializeGoogle();
      backgroundError = undefined;
      broadcast();
      return state();
    }
    case 'signIn': {
      if (!auth) throw new Error('Save the Google desktop OAuth client ID in Setup first.');
      email = await auth.signIn();
      broadcast();
      await confirmRoots();
      backgroundError = undefined;
      broadcast();
      return state();
    }
    case 'setSource': {
      assertStudio(args[0]);
      const candidate = await fs.realpath(String(args[1] ?? ''));
      if (!(await fs.stat(candidate)).isDirectory()) throw new Error('Source root must be a folder.');
      await service.setSource(args[0], candidate);
      broadcast();
      return state();
    }
    case 'setProjectSource': {
      const sessionId = String(args[0] ?? '');
      const folder = await fs.realpath(String(args[1] ?? ''));
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
        title: `Choose source project folder for ${session.projectName}`,
        defaultPath: store.get().config.sourceRoots[session.studio],
        properties: ['openDirectory'],
      };
      const chosen = window
        ? await dialog.showOpenDialog(window, pickerOptions)
        : await dialog.showOpenDialog(pickerOptions);
      if (chosen.canceled || !chosen.filePaths[0]) return service.getSession(sessionId);
      const folder = await fs.realpath(chosen.filePaths[0]);
      const root = await fs.realpath(store.get().config.sourceRoots[session.studio]);
      const relative = path.relative(root, folder);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('Choose a project folder within the configured studio source root.');
      }
      await service.setProjectSource(sessionId, folder);
      broadcast();
      return service.getSession(sessionId);
    }
    case 'openPath': return shell.openPath(await allowedLocalPath(String(args[0] ?? '')));
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
    width: 1480, height: 980, minWidth: 1020, minHeight: 700,
    title: 'Stills Library', backgroundColor: '#111717',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  void window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  window.on('closed', () => { window = null; });
}

async function main(): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  app.setPath('userData', directory);
  await app.whenReady();
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
  initializeGoogle();
  if (auth) {
    const storedEmail = await auth.currentEmail();
    if (storedEmail) {
      try { await auth.getAccessToken(); email = storedEmail; }
      catch (error) { backgroundError = error instanceof Error ? error.message : String(error); }
    }
  }
  protocol.handle('stills-preview', async request => {
    const url = new URL(request.url);
    if (url.hostname !== 'frame' || !/^\/[a-f0-9]{64}$/.test(url.pathname)) return new Response('Not found', { status: 404 });
    const filePath = previewFiles.get(url.pathname.slice(1));
    if (!filePath) return new Response('Not found', { status: 404 });
    const realFile = await fs.realpath(filePath).catch(() => null);
    const realRoot = await fs.realpath(stagingRoot).catch(() => null);
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
  app.on('activate', () => { if (!window) createWindow(); });
  app.on('second-instance', () => { if (!window) createWindow(); window?.show(); window?.focus(); });
}

if (gotLock) {
  void main().catch(error => {
    backgroundError = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox('Stills Library could not start', backgroundError);
    app.quit();
  });
}

app.on('before-quit', () => { rpcServer?.close(); });
