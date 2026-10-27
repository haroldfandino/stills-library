import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { realpathSync, readFileSync } from 'node:fs';

/** An explicit portable profile prevents Store/AppData virtualization from
 * selecting a different library when Explorer launches the same executable. */
export function pinnedDataDirectory(executable: string): string | undefined {
  const config = path.join(path.dirname(executable), 'stills-library-data-dir.txt');
  let value: string;
  try { value = readFileSync(config, 'utf8').trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!value || !path.isAbsolute(value)) throw new Error('The pinned Stills Library data directory must be an absolute path.');
  return value;
}

function canonicalWindowsDirectory(directory: string): string {
  try { return realpathSync.native(directory); }
  catch (error) {
    // First launch can precede directory creation. Other failures (permissions,
    // invalid paths, etc.) must not silently select a different service.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return directory;
  }
}

export function dataDir(): string {
  if (process.env.STILLS_LIBRARY_DATA_DIR) {
    const directory = path.resolve(process.env.STILLS_LIBRARY_DATA_DIR);
    return process.platform === 'win32' ? canonicalWindowsDirectory(directory) : directory;
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Stills Library');
  if (process.platform === 'win32') return canonicalWindowsDirectory(pinnedDataDirectory(process.execPath)
    ?? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Stills Library'));
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'Stills Library');
}

export function socketPath(platform: NodeJS.Platform = process.platform, directory = dataDir()): string {
  if (platform !== 'win32') return path.join(directory, 'service.sock');
  const canonical = canonicalWindowsDirectory(path.win32.resolve(directory));
  const workspaceHash = crypto.createHash('sha256').update(canonical.toLowerCase()).digest('hex').slice(0, 20);
  return `\\\\.\\pipe\\stills-library-${workspaceHash}`;
}

export function rpcTokenPath(): string {
  return path.join(dataDir(), 'rpc-token');
}
