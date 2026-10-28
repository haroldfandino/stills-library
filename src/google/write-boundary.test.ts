import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertLibraryFolder } from './write-boundary.js';
import { GoogleWorkspace } from './workspace.js';
import type { GoogleAuth } from './auth.js';
import { SOURCE_CONFIG, type DriveFile, type SourceConfigs } from './types.js';

const folder = (id: string, name: string, parents?: string[]): DriveFile => ({ id, name, parents, mimeType: 'application/vnd.google-apps.folder' });
const sources: SourceConfigs = {
  filmkraft: { ...SOURCE_CONFIG.filmkraft, destinationFolderId: 'library' },
  screenbridge: { ...SOURCE_CONFIG.screenbridge, destinationFolderId: 'second-library' },
};
const json = (v: unknown, status = 200, headers = {}) => new Response(JSON.stringify(v), { status, headers });
const uploadId = '11111111-1111-4111-8111-111111111111';

function tree() {
  const files = new Map<string, DriveFile>([
    ['library', folder('library', 'Library')],
    ['stills', folder('stills', '01_Stills', ['library'])],
    ['year', folder('year', '2026', ['stills'])],
    ['project', folder('project', '[100]Project', ['year'])],
    ['version', folder('version', 'Video', ['project'])],
    ['videos', folder('videos', '02_Videos', ['library'])],
    ['outside', folder('outside', '01_Stills')],
    ['second-library', folder('second-library', '2025')],
  ]);
  const get = async (id: string) => { const f = files.get(id); if (!f) throw Error('Not found'); return structuredClone(f); };
  const list = async (id: string) => [...files.values()].filter(f => f.parents?.includes(id));
  return { files, get, list };
}

describe('Drive write ancestry boundary', () => {
  it('accepts nested stills folders and an explicitly configured year', async () => {
    const t = tree();
    for (const id of ['stills', 'year', 'project', 'version', 'second-library']) await assertLibraryFolder(id, sources, t.get, t.list);
  });
  it.each(['library', 'videos', 'outside', 'unknown'])('rejects unconfigured or non-stills destination %s', async id => {
    const t = tree();
    await expect(assertLibraryFolder(id, sources, t.get, t.list)).rejects.toThrow();
  });
  it.each([
    { parents: ['outside'] }, { parents: ['year', 'outside'] }, { parents: [] },
    { parents: ['project'] }, { mimeType: 'application/vnd.google-apps.shortcut' }, { trashed: true },
  ])('fails closed for moved, ambiguous, cyclic, shortcut or trashed ancestry: %j', async change => {
    const t = tree(); Object.assign(t.files.get('project')!, change);
    await expect(assertLibraryFolder('version', sources, t.get, t.list)).rejects.toThrow();
  });
  it('rejects duplicate 01_Stills roots under a broader library', async () => {
    const t = tree(); t.files.set('duplicate', folder('duplicate', '01_Stills', ['library']));
    await expect(assertLibraryFolder('project', sources, t.get, t.list)).rejects.toMatchObject({ code: 'outside_library' });
  });
});

describe('all outbound writes enforce the boundary', () => {
  let temporary: string | undefined;
  afterEach(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); temporary = undefined; });
  async function fixture() {
    const t = tree();
    temporary = await mkdtemp(path.join(tmpdir(), 'stills-boundary-'));
    const bytes = Buffer.from('89504e470d0a1a0a0000', 'hex');
    const filePath = path.join(temporary, 'test.png'); await writeFile(filePath, bytes);
    const md5 = createHash('md5').update(bytes).digest('hex');
    const png = (id: string, parent: string): DriveFile => ({ id, name: 'still.png', mimeType: 'image/png', parents: [parent], size: String(bytes.length), md5Checksum: md5, appProperties: { stillsLibraryUploadId: uploadId } });
    t.files.set('owned', png('owned', 'project')); t.files.set('foreign-location', png('foreign-location', 'outside'));
    t.files.set('empty', folder('empty', 'Empty', ['outside']));
    const writes: string[] = [];
    let moveAfterInitiation = false;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method && init.method !== 'GET') {
        writes.push(`${init.method} ${url.pathname}`);
        if (url.pathname === '/upload/drive/v3/files') {
          if (moveAfterInitiation) t.files.get('project')!.parents = ['outside'];
          return json({}, 200, { Location: 'https://www.googleapis.com/upload/session/test' });
        }
        return json({});
      }
      if (url.pathname.endsWith('/files')) {
        const parent = /^'([^']+)' in parents/.exec(url.searchParams.get('q') ?? '')?.[1];
        return json({ files: await t.list(parent ?? '') });
      }
      const id = decodeURIComponent(url.pathname.split('/').at(-1)!);
      return json(await t.get(id));
    }) as typeof fetch;
    const workspace = new GoogleWorkspace({ auth: { getAccessToken: async () => 'token' } as GoogleAuth, sources, fetchImpl });
    return { ...t, workspace, writes, filePath, md5, size: bytes.length, moveAfterInitiation: () => { moveAfterInitiation = true; } };
  }
  it('blocks folder creation outside stills', async () => {
    const f = await fixture();
    await expect(f.workspace.ensureVersionDestination('outside', 'New')).rejects.toMatchObject({ code: 'outside_library' });
    expect(f.writes).toEqual([]);
  });
  it('blocks uploads outside stills before creating an upload session', async () => {
    const f = await fixture();
    await expect(f.workspace.uploadPng({ folderId: 'outside', filePath: f.filePath, fileName: 'new.png', uploadId })).rejects.toMatchObject({ code: 'outside_library' });
    expect(f.writes).toEqual([]);
  });
  it.each(['renaming', 'trashing'])('blocks %s of even app-owned files outside stills', async operation => {
    const f = await fixture();
    await expect(f.workspace.reviseVerifiedPng('foreign-location', 'outside', 'still.png', operation === 'renaming' ? 'new.png' : null, f.md5, f.size, uploadId)).rejects.toMatchObject({ code: 'outside_library' });
    expect(f.writes).toEqual([]);
  });
  it.each([['owned', 'project', 'outside'], ['foreign-location', 'outside', 'version']])('checks both ends of file moves: %s', async (id, previous, destination) => {
    const f = await fixture();
    if (id === 'owned') f.files.delete('foreign-location');
    await expect(f.workspace.relocateVerifiedPng(id, previous, destination, 'still.png', f.md5, f.size, uploadId)).rejects.toMatchObject({ code: 'outside_library' });
    expect(f.writes).toEqual([]);
  });
  it('blocks cleanup of an empty folder outside stills', async () => {
    const f = await fixture();
    await expect(f.workspace.trashEmptyDeliveryFolder('empty', 'outside', 'Empty')).rejects.toMatchObject({ code: 'outside_library' });
    expect(f.writes).toEqual([]);
  });
  it('rechecks ancestry before upload chunks and recovery after a folder moves', async () => {
    const f = await fixture(); f.moveAfterInitiation();
    await expect(f.workspace.uploadPng({ folderId: 'project', filePath: f.filePath, fileName: 'new.png', uploadId })).rejects.toMatchObject({ code: 'outside_library' });
    expect(f.writes).toEqual(['POST /upload/drive/v3/files']);
  });
  it('rejects writes to unconfigured Sheets and unknown mutation endpoints', async () => {
    const f = await fixture();
    for (const url of ['https://sheets.googleapis.com/v4/spreadsheets/unconfigured:batchUpdate', 'https://www.googleapis.com/drive/v3/files/owned/permissions']) {
      await expect((f.workspace as any).json(url, { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'outside_library' });
    }
    expect(f.writes).toEqual([]);
  });
});
