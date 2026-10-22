import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export function dataDir(): string {
  if (process.env.STILLS_LIBRARY_DATA_DIR) return path.resolve(process.env.STILLS_LIBRARY_DATA_DIR);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Stills Library');
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Stills Library');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'Stills Library');
}

export function socketPath(): string {
  if (process.platform !== 'win32') return path.join(dataDir(), 'service.sock');
  const userHash = crypto.createHash('sha256').update(os.homedir()).digest('hex').slice(0, 12);
  return `\\\\.\\pipe\\stills-library-${userHash}`;
}

export function rpcTokenPath(): string {
  return path.join(dataDir(), 'rpc-token');
}
