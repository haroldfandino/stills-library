import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const encryption = vi.hoisted(() => ({
  encryptStringAsync: vi.fn(async (value: string) => Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`)),
  decryptStringAsync: vi.fn(async (value: Buffer) => ({
    result: Buffer.from(value.toString().slice('encrypted:'.length), 'base64').toString(), shouldReEncrypt: false,
  })),
}));
vi.mock('electron', () => ({ safeStorage: encryption }));
import { ElectronClientCredentialsStore, ElectronTokenStore } from './token-store';

describe('OS-protected Google configuration', () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('keeps tokens and client credentials in distinct encrypted files and clears only the requested store', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'stills-vault-'));
    const tokens = new ElectronTokenStore(directory);
    const client = new ElectronClientCredentialsStore(directory);
    const record = { accessToken: 'test-access', refreshToken: 'test-refresh', expiresAt: 1234,
      email: 'harold@filmkraft.tv', scope: 'test' };
    expect(await tokens.load()).toBeNull();
    await tokens.save(record);
    await client.save({ clientId: 'test-id', clientSecret: 'test-secret' });
    expect(await tokens.load()).toEqual(record);
    expect(await client.load()).toEqual({ clientId: 'test-id', clientSecret: 'test-secret' });
    expect(await readFile(path.join(directory, 'google-tokens.bin'), 'utf8')).not.toContain('test-refresh');
    expect(await readFile(path.join(directory, 'google-client.bin'), 'utf8')).not.toContain('test-secret');
    await tokens.clear();
    expect(await tokens.load()).toBeNull();
    expect(await client.load()).not.toBeNull();
  });

  it('preserves the previous credentials after encryption fails, then permits retry', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'stills-vault-'));
    const client = new ElectronClientCredentialsStore(directory);
    await client.save({ clientId: 'previous' });
    encryption.encryptStringAsync.mockRejectedValueOnce(new Error('OS vault unavailable'));
    await expect(client.save({ clientId: 'failed' })).rejects.toThrow('OS vault unavailable');
    expect(await client.load()).toEqual({ clientId: 'previous' });
    await client.save({ clientId: 'retry' });
    expect(await client.load()).toEqual({ clientId: 'retry' });
    expect(await readdir(directory)).toEqual(['google-client.bin']);
  });
});
