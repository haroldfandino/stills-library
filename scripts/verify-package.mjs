import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listPackage } from '@electron/asar';

const platform = process.platform;
const arch = process.arch;
const suffix = platform === 'win32' ? '.exe' : '';
const outputRoot = path.resolve('out');

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function findPackage() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  if (!fs.existsSync(outputRoot)) throw new Error('No out/ directory. Build the Electron package first.');
  const candidates = [];
  for (const child of fs.readdirSync(outputRoot, { withFileTypes: true })) {
    if (!child.isDirectory()) continue;
    if (!child.name.includes(`${platform}-${arch}`)) continue;
    const folder = path.join(outputRoot, child.name);
    for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
      if (platform === 'darwin' && item.isDirectory() && item.name === 'Stills Library.app') {
        candidates.push(path.join(folder, item.name));
      }
    }
    if (platform === 'win32' && fs.existsSync(path.join(folder, 'Stills Library.exe'))) {
      candidates.push(folder);
    }
  }
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one ${platform}/${arch} package in out/, found ${candidates.length}. Pass its path explicitly.`);
  }
  return candidates[0];
}

function check(file) {
  if (!fs.statSync(file).isFile()) throw new Error(`Missing package file: ${file}`);
  return file;
}

const packaged = findPackage();
const resources = platform === 'darwin'
  ? path.join(packaged, 'Contents', 'Resources')
  : path.join(packaged, 'resources');
const bundle = path.join(resources, arch);
const manifest = JSON.parse(fs.readFileSync(check(path.join(bundle, 'BUILD-MANIFEST.json')), 'utf8'));
if (manifest.platform !== platform || manifest.arch !== arch) {
  throw new Error(`Wrong native sidecar architecture: ${manifest.platform}/${manifest.arch}`);
}
const asar = check(path.join(resources, 'app.asar'));
const asarFiles = listPackage(asar);
for (const required of ['/dist/main.cjs', '/dist/preload.cjs', '/dist/cli.cjs']) {
  if (!asarFiles.includes(required)) throw new Error(`Missing packaged process: ${required}`);
}
for (const forbidden of ['/build/', '/native/', '/out/', '/node_modules/', '/src/']) {
  if (asarFiles.some((file) => file.startsWith(forbidden))) {
    throw new Error(`Development payload leaked into app.asar: ${forbidden}`);
  }
}
const extraction = check(path.join(bundle, 'extract-stills', `extract-stills${suffix}`));
const ffprobe = check(path.join(bundle, manifest.ffprobe_relative_path));
check(path.join(bundle, 'extract-stills', '_internal', 'binaries', `ffmpeg${suffix}`));
const rename = check(path.join(bundle, `rename-stills${suffix}`));
for (const [file, expected] of [
  [extraction, manifest.extract_executable_sha256],
  [ffprobe, manifest.ffprobe_sha256],
  [rename, manifest.rename_executable_sha256],
]) {
  if (sha256(file) !== expected) throw new Error(`Native sidecar checksum changed in package: ${file}`);
}
const internal = path.join(bundle, 'extract-stills', '_internal');
const models = JSON.parse(fs.readFileSync(check(path.join(internal, 'models', 'manifest.json')), 'utf8'));
const modelIds = new Set(models.models.map((entry) => entry.id));
for (const id of ['face_landmarker', 'text_detector', 'text_recognizer', 'text_dictionary']) {
  if (!modelIds.has(id)) throw new Error(`Packaged extraction model missing: ${id}`);
}
for (const entry of models.models) {
  const model = check(path.join(internal, 'models', entry.filename));
  if (fs.statSync(model).size !== entry.size_bytes || sha256(model) !== entry.sha256) {
    throw new Error(`Packaged extraction model changed: ${entry.id}`);
  }
}
for (const license of ['EXTRACT-STILLS-LICENSE.txt', 'FFMPEG-BINARIES.json', 'PYTHON-PACKAGES.json']) {
  check(path.join(internal, 'licenses', license));
}
const nativeVerification = JSON.parse(fs.readFileSync(check(path.join(bundle, 'packaged-verification.json')), 'utf8'));
if (nativeVerification.status !== 'passed' || nativeVerification.offline_assets_verified !== true) {
  throw new Error('Packaged native verification is missing or failed.');
}
if (platform === 'darwin') {
  const plist = path.join(packaged, 'Contents', 'Info.plist');
  const minimum = spawnSync('/usr/bin/plutil', ['-extract', 'LSMinimumSystemVersion', 'raw', '-o', '-', plist], { encoding: 'utf8' });
  if (minimum.status !== 0) throw new Error(`Cannot read app minimum macOS: ${minimum.stderr}`);
  const declared = minimum.stdout.trim();
  const audited = nativeVerification.macos_dependency_audit?.highest_declared_minimum_macos;
  const parts = (version) => String(version).split('.').map((number) => Number(number));
  const [declaredMajor, declaredMinor = 0] = parts(declared);
  const [auditedMajor, auditedMinor = 0] = parts(audited);
  if (!Number.isFinite(auditedMajor) || declaredMajor < auditedMajor ||
      (declaredMajor === auditedMajor && declaredMinor < auditedMinor)) {
    throw new Error(`App advertises macOS ${declared}; native bundle requires ${audited}.`);
  }
}
const launcher = check(path.join(resources, 'bin', platform === 'darwin' ? 'stills-library' : 'stills-library.cmd'));

// --help exits 2 after printing CLI usage, before any account or socket access.
// Restrict PATH to system directories so this proves the release uses its own
// Electron Node runtime, not a developer-installed node or python command.
const env = { ...process.env };
if (platform === 'win32') {
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
}
if (platform === 'darwin') env.PATH = '/usr/bin:/bin';
else env.Path = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const command = platform === 'darwin' ? launcher : 'cmd.exe';
const args = platform === 'darwin' ? ['--help'] : ['/d', '/c', `"${launcher}" --help`];
const result = spawnSync(command, args, { encoding: 'utf8', env, timeout: 30000, windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 2 || !result.stderr.includes('Stills Library CLI')) {
  throw new Error(`Packaged CLI launcher failed: exit=${result.status}\n${result.stdout}\n${result.stderr}`);
}

if (platform === 'darwin' && process.env.STILLS_LIBRARY_SKIP_GUI_SMOKE !== '1') {
  // The service is initially absent in a fresh data directory. A tiny shell
  // proxy records the detached GUI PID before exec'ing the real packaged app,
  // so this test can prove autolaunch and clean up afterward.
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stills-package-check-'));
  const proxy = path.join(folder, 'launch-app');
  const pidFile = path.join(folder, 'gui.pid');
  const app = path.join(packaged, 'Contents', 'MacOS', 'Stills Library');
  fs.writeFileSync(proxy, '#!/bin/sh\nprintf "%s" "$$" > "$STILLS_LIBRARY_TEST_PID"\nexec "$STILLS_LIBRARY_REAL_APP" "$@"\n');
  fs.chmodSync(proxy, 0o755);
  try {
    const status = spawnSync(launcher, ['status', '--json'], {
      encoding: 'utf8', timeout: 40000, windowsHide: true,
      env: {
        ...env, STILLS_LIBRARY_DATA_DIR: path.join(folder, 'data'),
        STILLS_LIBRARY_APP_EXECUTABLE: proxy,
        STILLS_LIBRARY_REAL_APP: app,
        STILLS_LIBRARY_TEST_PID: pidFile,
      },
    });
    if (status.error) throw status.error;
    if (status.status !== 0) throw new Error(`CLI autolaunch failed: ${status.stderr || status.stdout}`);
    const state = JSON.parse(status.stdout);
    if (!state || typeof state !== 'object' || !Array.isArray(state.sessions)) {
      throw new Error(`CLI autolaunch returned an invalid app state: ${status.stdout}`);
    }
  } finally {
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* exited */ } }
      }
    }
    // Electron may finish a settings write just after receiving SIGTERM.
    fs.rmSync(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}
console.log(`Verified Electron package and bundled CLI: ${packaged} (app.asar ${Math.round(fs.statSync(asar).size / 1024 / 1024)} MiB)`);
