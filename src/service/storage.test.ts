import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from './storage';

let directory: string;
afterEach(async () => { vi.restoreAllMocks(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });

it('retries transient Windows replacement locks without losing the last committed state', async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stills-store-'));
  const store = new JsonStore(directory); await store.load();
  await store.update(s => { s.currentSessionId = 'before'; });
  const rename = vi.spyOn(fs, 'rename').mockImplementationOnce(async () => {
    expect(store.get().currentSessionId).toBe('before');
    expect(JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8')).currentSessionId).toBe('before');
    throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
  });
  await store.update(s => { s.currentSessionId = 'after'; });
  expect(rename).toHaveBeenCalledTimes(2);
  expect(store.get().currentSessionId).toBe('after');
  expect(JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8')).currentSessionId).toBe('after');
});

it('preserves committed state on permanent errors and permits the next save', async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stills-store-'));
  const store = new JsonStore(directory); await store.load();
  await store.update(s => { s.currentSessionId = 'before'; });
  const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('disk error'), { code: 'EIO' }));
  await expect(store.update(s => { s.currentSessionId = 'failed'; })).rejects.toThrow('disk error');
  expect(rename).toHaveBeenCalledTimes(1);
  expect(store.get().currentSessionId).toBe('before');
  expect(await fs.readdir(directory)).toEqual(['state.json']);
  await store.update(s => { s.currentSessionId = 'recovered'; });
  expect(store.get().currentSessionId).toBe('recovered');
});
