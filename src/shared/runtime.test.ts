import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataDir, socketPath, pinnedDataDirectory } from './runtime';

afterEach(() => { vi.unstubAllEnvs(); });

describe('Windows local service isolation', () => {
  it('pins Explorer launches to the same explicit saved profile without moving any data', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'stills-runtime-'));
    try {
      const executable = path.join(fixture, 'Stills Library.exe');
      expect(pinnedDataDirectory(executable)).toBeUndefined();
      fs.writeFileSync(path.join(fixture, 'stills-library-data-dir.txt'), `${path.join(fixture, 'saved-profile')}\n`);
      expect(pinnedDataDirectory(executable)).toBe(path.join(fixture, 'saved-profile'));
      fs.writeFileSync(path.join(fixture, 'stills-library-data-dir.txt'), 'relative-profile');
      expect(() => pinnedDataDirectory(executable)).toThrow('absolute path');
    } finally {
      const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(fixture));
      if (relative.startsWith('stills-runtime-') && !relative.includes(path.sep)) fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
  it('gives each data directory a separate named pipe', () => {
    const first = socketPath('win32', 'C:\\Users\\Reviewer\\AppData\\Roaming\\Stills Library');
    const smokeTest = socketPath('win32', 'C:\\Temp\\stills-package-check-123\\data');
    expect(first).toMatch(/^\\\\\.\\pipe\\stills-library-[a-f0-9]{20}$/);
    expect(first).not.toBe(smokeTest);
  });

  it('uses the same pipe for differently cased Windows directory spellings', () => {
    expect(socketPath('win32', 'C:\\Users\\Reviewer\\Stills Library')).toBe(socketPath('win32', 'c:\\users\\reviewer\\STILLS LIBRARY'));
  });

  it.skipIf(process.platform !== 'win32')('shares state and service identity through a Windows directory junction', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'stills-runtime-'));
    const target = path.join(fixture, 'physical-state');
    const alias = path.join(fixture, 'alias-state');
    try {
      fs.mkdirSync(target);
      fs.symlinkSync(target, alias, 'junction');
      const canonical = fs.realpathSync.native(target);
      vi.stubEnv('STILLS_LIBRARY_DATA_DIR', alias);
      expect(dataDir()).toBe(canonical);
      expect(socketPath('win32', alias)).toBe(socketPath('win32', canonical));
      const aliasPipe = socketPath();
      vi.stubEnv('STILLS_LIBRARY_DATA_DIR', target);
      expect(dataDir()).toBe(canonical);
      expect(socketPath()).toBe(aliasPipe);
    } finally {
      const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(fixture));
      if (relative.startsWith('stills-runtime-') && !relative.includes(path.sep)) fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'win32')('resolves a first-launch directory after it is created', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'stills-runtime-'));
    const requested = path.join(fixture, 'new-state');
    try {
      vi.stubEnv('STILLS_LIBRARY_DATA_DIR', requested);
      expect(dataDir()).toBe(requested);
      fs.mkdirSync(requested);
      expect(dataDir()).toBe(fs.realpathSync.native(requested));
    } finally {
      const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(fixture));
      if (relative.startsWith('stills-runtime-') && !relative.includes(path.sep)) fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
