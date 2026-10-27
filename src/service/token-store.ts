import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeStorage } from 'electron';
import type { GoogleTokenStore, StoredGoogleTokens } from '../google/auth';
import type { GoogleDesktopCredentials } from '../google/desktop-credentials';

/** Atomic replacement keeps the previous encrypted value if a write fails. */
class EncryptedStore<T> {
  private file: string;
  private writes: Promise<void> = Promise.resolve();

  constructor(directory: string, filename: string) { this.file = path.join(directory, filename); }

  async load(): Promise<T | null> {
    await this.writes;
    try {
      const encrypted = await fs.readFile(this.file);
      const decrypted = await safeStorage.decryptStringAsync(encrypted);
      const value = JSON.parse(decrypted.result) as T;
      if (decrypted.shouldReEncrypt) await this.save(value);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(value: T): Promise<void> {
    return this.enqueue(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(value));
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, encrypted, { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, this.file);
      } finally {
        await fs.unlink(temporary).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
      }
    });
  }

  async clear(): Promise<void> {
    return this.enqueue(async () => {
      try { await fs.unlink(this.file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.writes.then(operation);
    this.writes = pending.catch(() => {});
    return pending;
  }
}

/** Refresh tokens never enter state.json or CLI output. */
export class ElectronTokenStore extends EncryptedStore<StoredGoogleTokens> implements GoogleTokenStore {
  constructor(directory: string) { super(directory, 'google-tokens.bin'); }
}

/** Desktop client configuration is kept outside the repository and renderer. */
export class ElectronClientCredentialsStore extends EncryptedStore<GoogleDesktopCredentials> {
  constructor(directory: string) { super(directory, 'google-client.bin'); }
}
