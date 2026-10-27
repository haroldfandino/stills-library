// Offline integration check: real Electron, renderer, IPC and native sidecars;
// Google is replaced only in a disposable build. Production sources are untouched.
import { build as bundle } from 'esbuild';
import { build as buildRenderer } from 'vite';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const suffix = process.platform === 'win32' ? '.exe' : '';
const nativeRoot = path.join(repo, 'native', process.platform, process.arch);
const extract = path.join(nativeRoot, 'extract-stills', `extract-stills${suffix}`);
const rename = path.join(nativeRoot, `rename-stills${suffix}`);
const binaries = path.join(nativeRoot, 'extract-stills', '_internal', 'binaries');
const ffmpeg = path.join(binaries, `ffmpeg${suffix}`);
const ffprobe = path.join(binaries, `ffprobe${suffix}`);
for (const file of [extract, rename, ffmpeg, ffprobe]) await fs.access(file);
const electron = require('electron');
const temporaryRoot = path.resolve(os.tmpdir());
const root = await fs.mkdtemp(path.join(temporaryRoot, 'stills gui café '));
const output = path.join(repo, 'build', 'gui-smoke');
const appRoot = path.join(root, 'app');
const dist = path.join(appRoot, 'dist');
const data = path.join(root, 'data');
const sourceRoot = path.join(root, 'source café');
const delivery = path.join(sourceRoot, '01_ActiveProjects', '[9000]Synthetic_Smoke_2026', '11_FINAL_DELIVERY', '01_Videos');
const drive = path.join(root, 'offline-drive');
const source = path.join(delivery, '01_FirstVersion', 'FirstVersion_06_Social_H264.mkv');
const alternate = path.join(delivery, '02_SecondVersion', 'SecondVersion_06_Social_H264.mkv');
await Promise.all([dist, data, path.dirname(source), path.dirname(alternate), drive, output].map(folder => fs.mkdir(folder, { recursive: true })));
await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'starting', nativeSidecars: true, google: 'local fixture only' }, null, 2));
await fs.writeFile(path.join(drive, 'keep-existing.txt'), 'existing fixture stays untouched');

function run(command, args, env = process.env, timeout = 180_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', bytes => { log += bytes.toString(); });
    child.stderr.on('data', bytes => { log += bytes.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Smoke command timed out: ${command}\n${log.slice(-5000)}`)); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(log);
      else reject(new Error(`Smoke command exited ${code}: ${command}\n${log.slice(-6000)}`));
    });
  });
}

const fakeGoogle = `
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
export const SOURCE_CONFIG = {
  screenbridge: {label:'Screenbridge',spreadsheetId:'offline-sheet',destinationFolderId:'offline-root'},
  filmkraft: {label:'Filmkraft',spreadsheetId:'offline-sheet-f',destinationFolderId:'offline-root-f'},
};
const row = {source:'screenbridge',rowNumber:2,name:'[9000]Synthetic_Smoke_2026',status:'To Do'};
const files = [];
const folder = {id:'offline-project',name:row.name,mimeType:'application/vnd.google-apps.folder',parents:['offline-year']};
const versionFolders = new Map();
export class GoogleAuth {
  async currentEmail() { return 'harold@filmkraft.tv'; }
  async getAccessToken() { return 'offline-test-token'; }
}
export class GoogleWorkspace {
  constructor(options) { this.sources = options.sources; }
  async listProjects(studio) { return !studio || studio === row.source ? [{...row}] : []; }
  async verifyRoots() { return Object.fromEntries(Object.keys(SOURCE_CONFIG).map(source => [source,{source,sheetOk:true,folderOk:true,requiresPicker:false}])); }
  async preflightProjectDestination() {}
  async updateStatus(expected, status, previous) {
    if (row.status !== previous || expected.name !== row.name) throw new Error('Offline row changed');
    row.status = status;
    await fs.writeFile(path.join(process.env.STILLS_SMOKE_DRIVE, 'sheet-status.txt'), status);
    return {...row};
  }
  async findOrCreateProjectFolder(_studio, name, year) {
    if (name !== row.name || year !== '2026') throw new Error('Incorrect offline destination');
    return {...folder};
  }
  async verifyProjectFolder(studio, name, year, id) {
    if (id !== folder.id) throw new Error('Wrong offline project folder');
    return this.findOrCreateProjectFolder(studio,name,year);
  }
  async ensureVersionDestination(projectId, name) {
    if (projectId !== folder.id || !['01_FirstVersion','02_SecondVersion'].includes(name)) throw new Error('Wrong offline version destination');
    let version = [...versionFolders.values()].find(item=>item.name===name);
    if (!version) {
      version = {id:'offline-version-'+(versionFolders.size+1),name,mimeType:'application/vnd.google-apps.folder',parents:[projectId]};
      await fs.mkdir(path.join(process.env.STILLS_SMOKE_DRIVE,name));
      versionFolders.set(version.id,version);
      files.push(version);
    }
    return this.verifyVersionDestination(projectId,name,version.id);
  }
  async verifyVersionDestination(projectId, name, id) {
    const version = versionFolders.get(id);
    if (projectId !== folder.id || !version || version.name!==name || version.mimeType!=='application/vnd.google-apps.folder' || version.parents.length!==1 || version.parents[0]!==projectId) throw new Error('Offline version route changed');
    return {...version};
  }
  async listFolderFiles(id) {
    if (id !== folder.id && !versionFolders.has(id)) throw new Error('Wrong offline folder');
    return files.filter(file=>file.parents.includes(id)).map(file=>({...file}));
  }
  async uploadPng(input) {
    const version = versionFolders.get(input.folderId);
    if (input.folderId !== folder.id && !version) throw new Error('Wrong offline upload folder');
    const bytes = await fs.readFile(input.filePath);
    await fs.copyFile(input.filePath,path.join(process.env.STILLS_SMOKE_DRIVE,version?.name??'',input.fileName),1);
    const file = {id:randomUUID(),name:input.fileName,mimeType:'image/png',parents:[input.folderId],size:String(bytes.length),md5Checksum:createHash('md5').update(bytes).digest('hex'),appProperties:{stillsLibraryUploadId:input.uploadId}};
    files.push(file); return {...file};
  }
  async verifyUploadedPng(id, folderId, name, md5, size, uploadId) {
    const file = files.find(file=>file.id===id);
    if (!file || file.name!==name || file.md5Checksum!==md5 || file.size!==String(size) || !file.parents.includes(folderId) || file.appProperties.stillsLibraryUploadId!==uploadId) throw new Error('Offline upload mismatch');
    return {...file};
  }
}
`;

const harness = `
import {app,BrowserWindow,session,nativeImage} from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {rpcCall} from ${JSON.stringify(path.join(repo, 'src/service/rpc.ts'))};
import ${JSON.stringify(path.join(repo, 'src/main.ts'))};
app.disableHardwareAcceleration();
globalThis.fetch = async () => { throw new Error('Network forbidden in offline GUI smoke'); };
const output = process.env.STILLS_SMOKE_OUTPUT;
const drive = process.env.STILLS_SMOKE_DRIVE;
const sources = JSON.parse(process.env.STILLS_SMOKE_SOURCES);
const digest = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const report = {status:'running',nativeSidecars:true,google:'local fixture only',checks:[]};
let win;
const capture = async filename => {
  // Chromium on Windows can return UnknownVizError for a fully hidden surface.
  // Show without taking keyboard focus only while its screenshot is captured.
  win.showInactive();
  try {
    await sleep(350);
    const pixels = await Promise.race([win.webContents.capturePage(),sleep(5000).then(()=>{throw new Error('Timed out capturing '+filename);})]);
    await fs.writeFile(path.join(output,filename),pixels.toPNG());
  } finally { win.hide(); }
};
app.on('browser-window-created',(_event,window)=>{
  window.webContents.setBackgroundThrottling(false);
  window.hide();
});
app.whenReady().then(async()=>{
  session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>callback({cancel:true}));
  const before = await Promise.all(sources.map(digest));
  const until = async (check,label,timeout=120000) => {
    await fs.writeFile(path.join(output,'progress.txt'),label);
    const deadline=Date.now()+timeout;
    while(Date.now()<deadline) { const result=await check(); if(result) return result; await sleep(100); }
    throw new Error('Timed out: '+label);
  };
  await until(()=>{win=BrowserWindow.getAllWindows()[0];return win&&!win.webContents.isLoading();},'window');
  const js = source => win.webContents.executeJavaScript(source,true);
  const state = ()=>js('window.stills.getState()');
  const click = async text => {
    await until(()=>js('Array.from(document.querySelectorAll("button")).some(b=>b.textContent.trim()==='+JSON.stringify(text)+'&&!b.disabled)'), 'enabled button '+text);
    await js('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==='+JSON.stringify(text)+').click()');
  };
  const waitPhase = phase => until(async()=>{const s=await state();const current=s.sessions[0];if(current?.status==='error')throw new Error(current.error);return current?.status===phase?current:false;},phase);
  await until(()=>js('Boolean(window.stills&&document.querySelector(".hero-card"))'),'renderer ready');
  await click('Prepare project →');
  let current=await waitPhase('awaiting_videos');
  assert.equal(current.videos.length,2);
  assert.equal(current.frames.length,0);
  assert.equal(current.exports,undefined);
  await assert.rejects(rpcCall('approveVideos',[current.id,current.selectedVideoIds]),/GUI/);
  report.checks.push('discovery and CLI approval boundary');
  await click('Clear selection');
  await click('Select all');
  await click('Approve 2 videos →');
  current=await waitPhase('awaiting_stills');
  assert.equal(current.selectedVideoIds.length,2);
  assert.deepEqual(Object.values(current.versionFolders).sort(),['01_FirstVersion','02_SecondVersion']);
  assert.ok(current.frames.length>0);
  assert.equal(current.exports,undefined);
  assert.equal((await fs.readdir(drive)).filter(name=>name.endsWith('.png')).length,0);
  await until(()=>js('Array.from(document.querySelectorAll(".frame-grid img")).every(img=>img.complete&&img.naturalWidth>0)&&document.querySelectorAll(".frame-grid img").length>0'),'real preview pixels');
  await fs.writeFile(path.join(output,'progress.txt'),'capture review');
  await capture('stills-review.png');
  report.checks.push('real native analysis and Windows stills-preview images');
  assert.equal(current.frames.filter(f=>f.finalFrame && f.selected).length,2);
  assert.ok(current.frames.filter(f=>f.finalFrame).every(f=>f.frameId===35));
  report.checks.push('actual final source frames preselected and exported');
  await click('Clear selection');
  const firstFrames=current.selectedVideoIds.map(id=>current.frames.findIndex(frame=>frame.videoId===id && frame.finalFrame));
  assert.ok(firstFrames.every(index=>index>=0));
  await js('(()=>{const boxes=document.querySelectorAll(".frame-grid input[type=checkbox]");'+JSON.stringify(firstFrames)+'.forEach(index=>boxes[index].click());})()');
  await js('document.querySelectorAll(".frame-enlarge")['+firstFrames[0]+'].click()');
  await until(()=>js('Boolean(document.querySelector("dialog[open] img")?.naturalWidth)'),'enlarged preview');
  await click('✓ Selected for delivery');
  await click('Select for delivery');
  await click('Close ✕');
  await js('(()=>{const fields=document.querySelectorAll(".naming-fields input");const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;["Synthetic_Smoke","Review","2026"].forEach((v,i)=>{setter.call(fields[i],v);fields[i].dispatchEvent(new Event("input",{bubbles:true}));});})()');
  const selectedFrames=current.frames.filter((_frame,index)=>firstFrames.includes(index));
  const expectedPaths=selectedFrames.map((frame,index)=>current.versionFolders[frame.videoId]+'/Synthetic_Smoke_Review_Still_'+String(index+1).padStart(2,'0')+'.png');
  await until(()=>js('document.querySelectorAll(".filename-list code").length===2'),'two filename previews');
  assert.deepEqual(await js('Array.from(document.querySelectorAll(".filename-list code"),item=>item.textContent)'),expectedPaths);
  assert.match(await js('document.querySelector(".delivery-folders").textContent'),/2 version folders/);
  assert.ok(await js('Array.from(document.querySelectorAll(".frame-folder"),item=>item.textContent).some(text=>text.includes("01_FirstVersion"))'));
  assert.ok(await js('Array.from(document.querySelectorAll(".frame-folder"),item=>item.textContent).some(text=>text.includes("02_SecondVersion"))'));
  await js('document.querySelector(".naming-panel").scrollIntoView({block:"center"})');
  await capture('version-folder-review.png');
  report.checks.push('checkbox selection, enlarged review, version-folder paths and global filename numbering');
  await click('Approve & deliver →');
  current=await waitPhase('done');
  assert.equal(current.selectedFrameIds.length,2);
  assert.equal(current.exports.length,2);
  assert.equal(current.uploadResults.length,2);
  assert.equal(new Set(current.uploadResults.map(item=>item.folderId)).size,2);
  assert.deepEqual((await fs.readdir(drive)).filter(name=>name.endsWith('.png')),[]);
  for (let index=0;index<expectedPaths.length;index++) {
    const relative=expectedPaths[index];
    const version=current.versionFolders[current.uploadResults[index].videoId];
    assert.equal(current.uploadResults[index].versionName,version);
    assert.equal(current.uploadResults[index].status,'verified');
    assert.deepEqual(await fs.readdir(path.join(drive,version)),[path.basename(relative)]);
    assert.ok(nativeImage.createFromPath(path.join(drive,relative)).getSize().width>0);
  }
  assert.equal(await fs.readFile(path.join(drive,'sheet-status.txt'),'utf8'),'Done');
  assert.equal(await fs.readFile(path.join(drive,'keep-existing.txt'),'utf8'),'existing fixture stays untouched');
  assert.deepEqual(await Promise.all(sources.map(digest)),before);
  assert.equal(JSON.parse(await fs.readFile(current.manifestPath,'utf8')).status,'done');
  await until(()=>js('Boolean(document.querySelector(".completion-card"))&&!document.querySelector(".busy-banner")'),'completion screen');
  await js('document.querySelector(".completion-card").scrollIntoView({block:"center"})');
  // A hidden Electron window can deliver the DOM update before its compositor
  // paints the frame captured below.
  await sleep(350);
  await capture('delivery-complete.png');
  report.previewCount=current.frames.length; report.deliveredPngs=2;
  report.versionFolders=Object.values(current.versionFolders).sort();
  report.checks.push('native PNG export and rename, two verified version destinations, source preservation and Done manifest');
  const deliveredHashes=await Promise.all(expectedPaths.map(relative=>digest(path.join(drive,relative))));
  const completedSessionId=current.id;
  await click('Review stills again');
  current=await waitPhase('awaiting_stills');
  assert.equal(current.id,completedSessionId);
  assert.equal(current.selectedFrameIds.length,0);
  assert.equal(current.frames.filter(frame=>frame.selected).length,2);
  assert.equal(current.exports,undefined);
  assert.equal(current.uploadResults,undefined);
  assert.equal(current.destinationFolderId,undefined);
  assert.equal(JSON.parse(await fs.readFile(current.previousDeliveryManifest,'utf8')).status,'done');
  assert.equal(JSON.parse(await fs.readFile(current.manifestPath,'utf8')).status,'awaiting_stills');
  assert.equal(await fs.readFile(path.join(drive,'sheet-status.txt'),'utf8'),'In Process');
  assert.equal((await rpcCall('resume',[current.id])).status,'awaiting_stills');
  await assert.rejects(rpcCall('approveStills',[current.id,selectedFrames.map(frame=>frame.id),current.naming]),/GUI/);
  for (const relative of expectedPaths) assert.deepEqual(await fs.readdir(path.join(drive,path.dirname(relative))),[path.basename(relative)]);
  assert.deepEqual(await Promise.all(expectedPaths.map(relative=>digest(path.join(drive,relative)))),deliveredHashes);
  assert.deepEqual(await Promise.all(sources.map(digest)),before);
  assert.equal(await fs.readFile(path.join(drive,'keep-existing.txt'),'utf8'),'existing fixture stays untouched');
  await until(()=>js('document.querySelectorAll(".filename-list code").length===2&&!document.querySelector(".busy-banner")'),'reopened folder review');
  assert.deepEqual(await js('Array.from(document.querySelectorAll(".filename-list code"),item=>item.textContent)'),expectedPaths);
  await js('document.querySelector(".naming-panel").scrollIntoView({block:"center"})');
  await capture('review-again.png');
  report.checks.push('Review stills again archives delivery and resets exports/uploads; saved selections need fresh GUI approval');
  report.reopenedForReview=true;
  report.status='passed';
}).catch(error=>{report.status='failed';report.error=error.stack||String(error);}).finally(async()=>{
  if(report.status!=='passed'&&win&&!win.isDestroyed()) await capture('failure.png').catch(()=>{});
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
  app.exit(report.status==='passed'?0:1);
});
`;

try {
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'smptebars=size=640x360:rate=12:duration=3', '-c:v', 'ffv1', source]);
  await fs.copyFile(source, alternate);
  await fs.writeFile(path.join(appRoot, 'package.json'), JSON.stringify({ name: 'stills-offline-smoke', version: '0.0.0', main: 'dist/main.cjs' }));
  await fs.writeFile(path.join(data, 'state.json'), JSON.stringify({
    config: { googleClientId: 'offline-test.apps.googleusercontent.com',
      sourceRoots: { filmkraft: sourceRoot, screenbridge: sourceRoot },
      destinationFolders: { filmkraft: 'offline-root-f', screenbridge: 'offline-root' },
      extractExecutable: extract, renameExecutable: rename, ffprobeExecutable: ffprobe },
    projects: [], sessions: [],
  }));
  await bundle({ stdin: { contents: harness, resolveDir: repo, loader: 'ts' }, outfile: path.join(dist, 'main.cjs'),
    bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron'],
    plugins: [{ name: 'offline-google', setup(build) {
      build.onLoad({ filter: /[\\/]src[\\/]main\.ts$/ }, async args => ({
        // Keep Chromium painting deterministically without showing a test window.
        contents: (await fs.readFile(args.path, 'utf8'))
          .replace('new BrowserWindow({', 'new BrowserWindow({ show: false,')
          .replace('webPreferences: {', 'webPreferences: { backgroundThrottling: false,'),
        loader: 'ts',
      }));
      build.onResolve({ filter: /^\.\/google$/ }, args => args.importer.endsWith(`${path.sep}src${path.sep}main.ts`) || args.importer.endsWith('/src/main.ts')
        ? { path: 'offline-google', namespace: 'fixture' } : null);
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: fakeGoogle, loader: 'js' }));
    } }],
  });
  await bundle({ entryPoints: [path.join(repo, 'src/preload.ts')], outfile: path.join(dist, 'preload.cjs'),
    bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron'] });
  await buildRenderer({ configFile: false, root: path.join(repo, 'src/renderer'), base: './', logLevel: 'warn',
    build: { outDir: path.join(dist, 'renderer'), emptyOutDir: true } });
  const env = { ...process.env, STILLS_LIBRARY_DATA_DIR: data, STILLS_SMOKE_DRIVE: drive,
    STILLS_SMOKE_OUTPUT: output, STILLS_SMOKE_SOURCES: JSON.stringify([source, alternate]),
    HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9' };
  delete env.ELECTRON_RUN_AS_NODE;
  await run(electron, [appRoot], env);
  console.log(await fs.readFile(path.join(output, 'report.json'), 'utf8'));
  console.log(`GUI smoke artifacts: ${output}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(await fs.readFile(path.join(output, 'report.json'), 'utf8'));
  console.error(`GUI smoke report: ${path.join(output, 'report.json')}`);
  process.exitCode = 1;
} finally {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('stills gui café ')) {
    throw new Error('Refusing to clean an unexpected smoke fixture directory.');
  }
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
