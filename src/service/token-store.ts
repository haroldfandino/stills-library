import fs from 'node:fs/promises';
import path from 'node:path';
import { safeStorage } from 'electron';
import type { GoogleTokenStore, StoredGoogleTokens } from '../google/auth';

/** Google refresh tokens remain in Electron's OS-protected storage, never in state.json or CLI output. */
export class ElectronTokenStore implements GoogleTokenStore {
  private file: string;

  constructor(directory: string) { this.file = path.join(directory, 'google-tokens.bin'); }

  async load(): Promise<StoredGoogleTokens | null> {
    try {
      const encrypted = await fs.readFile(this.file);
      const decrypted = await safeStorage.decryptStringAsync(encrypted);
      const value = JSON.parse(decrypted.result) as StoredGoogleTokens;
      if (decrypted.shouldReEncrypt) await this.save(value);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(tokens: StoredGoogleTokens): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(tokens));
    await fs.writeFile(this.file, encrypted, { mode: 0o600 });
  }

  async clear(): Promise<void> {
    try { await fs.unlink(this.file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
