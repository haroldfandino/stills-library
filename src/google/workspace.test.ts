import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GoogleAuth } from './auth.js';
import { GoogleConflictError, SOURCE_CONFIG, type ProjectRow } from './types.js';
import { GoogleWorkspace } from './workspace.js';

const auth = { getAccessToken: async () => 'test-token' } as GoogleAuth;
const json = (value: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const project: ProjectRow = { source: 'screenbridge', rowNumber: 3, name: '[203SB]Airwaav_Brager_PremiumAd', status: 'To Do' };
const uploadId = '11111111-1111-4111-8111-111111111111';

describe('GoogleWorkspace safety rules', () => {
  let temporaryDirectory: string | undefined;
  afterEach(async () => { if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }); temporaryDirectory = undefined; });

  it('reads only the Stills project/status columns and keeps Sheet row numbers', async () => {
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return json({ values: [['Project', 'Status'], ['First', 'Done'], [project.name, 'To Do']] });
    }) as unknown as typeof fetch;
    const workspace = new GoogleWorkspace({ auth, fetchImpl });
    expect(await workspace.listProjects('screenbridge')).toEqual([
      { source: 'screenbridge', rowNumber: 2, name: 'First', status: 'Done' }, project,
    ]);
    expect(requested).toHaveLength(1);
    expect(decodeURIComponent(requested[0])).toContain('/values/Stills!A:B');
    expect(requested[0]).toContain(SOURCE_CONFIG.screenbridge.spreadsheetId);
  });

  it('refuses a status update when the row changed, without writing', async () => {
    const fetchImpl = vi.fn(async () => json({ values: [[project.name, 'Done']] })) as unknown as typeof fetch;
    const workspace = new GoogleWorkspace({ auth, fetchImpl });
    await expect(workspace.updateStatus(project, 'In Process')).rejects.toBeInstanceOf(GoogleConflictError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('writes only the selected B cell and checks that it retained the new value', async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (init?.method === 'PUT') return json({ updatedRange: 'Stills!B3' });
      return json({ values: [[project.name, requests.length === 1 ? 'To Do' : 'In Process']] });
    }) as unknown as typeof fetch;
    const workspace = new GoogleWorkspace({ auth, fetchImpl });
    expect(await workspace.updateStatus(project, 'In Process')).toEqual({ ...project, status: 'In Process' });
    expect(requests).toHaveLength(3);
    expect(requests[1].init?.method).toBe('PUT');
    expect(decodeURIComponent(requests[1].url)).toContain('/values/Stills!B3');
    expect(JSON.parse(String(requests[1].init?.body))).toEqual({ range: 'Stills!B3', majorDimension: 'ROWS', values: [['In Process']] });
  });

  it('paginates a folder listing and blocks incomplete results', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/folder')) return json({ id: 'folder', name: '2026', mimeType: 'application/vnd.google-apps.folder', driveId: 'shared-drive' });
      expect(url.searchParams.get('corpora')).toBe('drive');
      expect(url.searchParams.get('driveId')).toBe('shared-drive');
      const token = url.searchParams.get('pageToken');
      return token ? json({ files: [{ id: 'b', name: 'Two.png', mimeType: 'image/png' }] })
        : json({ files: [{ id: 'a', name: 'One.png', mimeType: 'image/png' }], nextPageToken: 'next' });
    }) as unknown as typeof fetch;
    const workspace = new GoogleWorkspace({ auth, fetchImpl });
    expect((await workspace.listFolderFiles('folder')).map(file => file.name)).toEqual(['One.png', 'Two.png']);
    const incomplete = new GoogleWorkspace({ auth, fetchImpl: vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/files/folder') ? json({ id: 'folder', name: '2026', mimeType: 'application/vnd.google-apps.folder' })
        : json({ incompleteSearch: true, files: [] })) as unknown as typeof fetch });
    await expect(incomplete.listFolderFiles('folder')).rejects.toMatchObject({ code: 'incomplete_listing' });
  });

  it('requires Picker when metadata is readable but the app lacks the destination grant', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('sheets.googleapis.com')) return json({ sheets: [{ properties: { title: 'Stills' } }] });
      return json({ id: url.split('/').at(-1)?.split('?')[0], name: 'Library',
        mimeType: 'application/vnd.google-apps.folder', isAppAuthorized: false,
        capabilities: { canAddChildren: true, canListChildren: true } });
    }) as unknown as typeof fetch;
    const workspace = new GoogleWorkspace({ auth, fetchImpl });
    const roots = await workspace.verifyRoots();
    expect(roots.screenbridge.folderOk).toBe(false);
    expect(roots.screenbridge.requiresPicker).toBe(true);
    expect(roots.filmkraft.folderOk).toBe(false);
  });

  it('checks the target folder app grant again after Picker', async () => {
    let granted = false;
    const pickFiles = vi.fn(async () => { granted = true; return ['year-folder']; });
    const pickerAuth = { getAccessToken: async () => 'test-token', pickFiles } as unknown as GoogleAuth;
    const fetchImpl = vi.fn(async () => json({ id: 'year-folder', name: '2026',
      mimeType: 'application/vnd.google-apps.folder', isAppAuthorized: granted,
      capabilities: { canAddChildren: true, canListChildren: true } })) as unknown as typeof fetch;
    const workspace = new GoogleWorkspace({ auth: pickerAuth, fetchImpl });
    expect((await workspace.ensureFolderAuthorized('year-folder')).id).toBe('year-folder');
    expect(pickFiles).toHaveBeenCalledWith({ fileIds: ['year-folder'], allowFolders: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    granted = false;
    const ignoredPicker = { getAccessToken: async () => 'test-token',
      pickFiles: vi.fn(async () => ['year-folder']) } as unknown as GoogleAuth;
    await expect(new GoogleWorkspace({ auth: ignoredPicker, fetchImpl }).ensureFolderAuthorized('year-folder'))
      .rejects.toMatchObject({ code: 'picker_grant_required' });
  });

  it('preflights an exact existing project folder before any Sheet status write', async () => {
    let granted = false;
    const pickFiles = vi.fn(async () => { granted = true; return ['project-folder']; });
    const pickerAuth = { getAccessToken: async () => 'test-token', pickFiles } as unknown as GoogleAuth;
    const folders = {
      root: { id: 'root', name: '01_Stills', mimeType: 'application/vnd.google-apps.folder', isAppAuthorized: true },
      year: { id: 'year', name: '2026', mimeType: 'application/vnd.google-apps.folder', isAppAuthorized: true },
      project: { id: 'project-folder', name: project.name, mimeType: 'application/vnd.google-apps.folder',
        isAppAuthorized: false, capabilities: { canAddChildren: true, canListChildren: true } },
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBeUndefined();
      const url = new URL(String(input));
      if (url.pathname.endsWith('/files')) {
        const q = url.searchParams.get('q') ?? '';
        return json({ files: q.includes("'root'") ? [folders.year] : q.includes("'year'") ? [folders.project] : [] });
      }
      const id = url.pathname.split('/').at(-1);
      if (id === 'root') return json(folders.root);
      if (id === 'year') return json(folders.year);
      return json({ ...folders.project, isAppAuthorized: granted });
    }) as unknown as typeof fetch;
    const workspace = new GoogleWorkspace({ auth: pickerAuth, fetchImpl, sources: {
      filmkraft: SOURCE_CONFIG.filmkraft,
      screenbridge: { ...SOURCE_CONFIG.screenbridge, destinationFolderId: 'root' },
    } });
    await workspace.preflightProjectDestination('screenbridge', project.name);
    expect(pickFiles).toHaveBeenCalledWith({ fileIds: ['project-folder'], allowFolders: true });
  });

  it('rejects a saved project folder moved outside the configured year hierarchy', async () => {
    const rootId = SOURCE_CONFIG.screenbridge.destinationFolderId;
    let folderParent = 'year';
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const id = new URL(String(input)).pathname.split('/').at(-1);
      if (id === 'project-folder') return json({ id, name: project.name,
        mimeType: 'application/vnd.google-apps.folder', parents: [folderParent], isAppAuthorized: true });
      if (id === 'year') return json({ id, name: '2026',
        mimeType: 'application/vnd.google-apps.folder', parents: ['stills'] });
      if (id === 'stills') return json({ id, name: '01_Stills',
        mimeType: 'application/vnd.google-apps.folder', parents: [rootId] });
      return json({ id, name: 'Outside', mimeType: 'application/vnd.google-apps.folder', parents: ['other'] });
    }) as unknown as typeof fetch;
    const workspace = new GoogleWorkspace({ auth, fetchImpl });
    expect((await workspace.verifyProjectFolder('screenbridge', project.name, '2026', 'project-folder')).id).toBe('project-folder');
    folderParent = 'wrong-year';
    await expect(workspace.verifyProjectFolder('screenbridge', project.name, '2026', 'project-folder'))
      .rejects.toBeInstanceOf(GoogleConflictError);
  });

  it('blocks same-name PNG uploads before opening a Drive upload session', async () => {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'stills-google-'));
    const filePath = path.join(temporaryDirectory, 'test.png');
    await writeFile(filePath, Buffer.from('89504e470d0a1a0a0000', 'hex'));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/files/folder') ? json({ id: 'folder', name: '2026', mimeType: 'application/vnd.google-apps.folder' })
        : json({ files: [{ id: 'prior', name: 'test.PNG', mimeType: 'image/png' }] })) as unknown as typeof fetch;
    const workspace = new GoogleWorkspace({ auth, fetchImpl });
    await expect(workspace.uploadPng({ folderId: 'folder', filePath, fileName: 'Test.png', uploadId })).rejects.toBeInstanceOf(GoogleConflictError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('verifies uploaded PNG name, parent, size and checksum', async () => {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'stills-google-'));
    const filePath = path.join(temporaryDirectory, 'test.png');
    const bytes = Buffer.from('89504e470d0a1a0a0000', 'hex');
    await writeFile(filePath, bytes);
    const md5Checksum = createHash('md5').update(bytes).digest('hex');
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/upload/drive/') && init?.method === 'POST') {
        expect(JSON.parse(String(init.body)).appProperties).toEqual({ stillsLibraryUploadId: uploadId });
        return json({}, 200, { Location: 'https://www.googleapis.com/upload/session/test' });
      }
      if (url.includes('/upload/session/test')) return json({ id: 'new-file' }, 200);
      if (url.includes('/drive/v3/files/new-file')) return json({ id: 'new-file', name: 'Test.png', mimeType: 'image/png', parents: ['folder'], size: String(bytes.length), md5Checksum, appProperties: { stillsLibraryUploadId: uploadId } });
      if (url.includes('/drive/v3/files/folder')) return json({ id: 'folder', name: '2026', mimeType: 'application/vnd.google-apps.folder' });
      return json({ files: [] });
    }) as unknown as typeof fetch;
    const workspace = new GoogleWorkspace({ auth, fetchImpl });
    const uploaded = await workspace.uploadPng({ folderId: 'folder', filePath, fileName: 'Test.png', uploadId });
    expect(uploaded.id).toBe('new-file');
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it('recovers a lost final upload response by querying the resumable session', async () => {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'stills-google-'));
    const filePath = path.join(temporaryDirectory, 'test.png');
    const bytes = Buffer.from('89504e470d0a1a0a0000', 'hex');
    await writeFile(filePath, bytes);
    const md5Checksum = createHash('md5').update(bytes).digest('hex');
    let chunkAttempted = false;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/upload/drive/') && init?.method === 'POST') return json({}, 200, { Location: 'https://www.googleapis.com/upload/session/test' });
      if (url.includes('/upload/session/test') && init?.method === 'PUT') {
        if (!chunkAttempted) { chunkAttempted = true; throw new TypeError('connection reset'); }
        expect(new Headers(init.headers).get('Content-Range')).toBe(`bytes */${bytes.length}`);
        return json({ id: 'recovered-file' });
      }
      if (url.includes('/drive/v3/files/recovered-file')) return json({ id: 'recovered-file', name: 'Test.png', mimeType: 'image/png', parents: ['folder'], size: String(bytes.length), md5Checksum, appProperties: { stillsLibraryUploadId: uploadId } });
      if (url.includes('/drive/v3/files/folder')) return json({ id: 'folder', name: '2026', mimeType: 'application/vnd.google-apps.folder' });
      return json({ files: [] });
    }) as unknown as typeof fetch;
    const workspace = new GoogleWorkspace({ auth, fetchImpl });
    expect((await workspace.uploadPng({ folderId: 'folder', filePath, fileName: 'Test.png', uploadId })).id).toBe('recovered-file');
  });

  it('creates exact project folders only under an explicitly chosen 01_Stills year', async () => {
    const folders: Record<string, { id: string; name: string; mimeType: string }> = {
      [SOURCE_CONFIG.screenbridge.destinationFolderId]: { id: SOURCE_CONFIG.screenbridge.destinationFolderId, name: '01_SB_Still&Video Library', mimeType: 'application/vnd.google-apps.folder' },
      stills: { id: 'stills', name: '01_Stills', mimeType: 'application/vnd.google-apps.folder' },
      y2025: { id: 'y2025', name: '2025', mimeType: 'application/vnd.google-apps.folder' },
      y2026: { id: 'y2026', name: '2026', mimeType: 'application/vnd.google-apps.folder' },
    };
    const created: { name: string; parents: string[] }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/files') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { name: string; parents: string[] };
        created.push(body);
        return json({ id: 'created', name: body.name, mimeType: 'application/vnd.google-apps.folder', parents: body.parents });
      }
      if (url.pathname.endsWith('/files')) {
        const query = url.searchParams.get('q') ?? '';
        if (query.includes(SOURCE_CONFIG.screenbridge.destinationFolderId)) return json({ files: [folders.stills] });
        if (query.includes('stills')) return json({ files: [folders.y2025, folders.y2026] });
        return json({ files: [] });
      }
      const id = url.pathname.split('/').at(-1)!;
      return json(folders[id]);
    }) as unknown as typeof fetch;
    const workspace = new GoogleWorkspace({ auth, fetchImpl });
    await expect(workspace.findOrCreateProjectFolder('screenbridge', project.name)).rejects.toMatchObject({ code: 'destination_year_required' });
    expect(created).toHaveLength(0);
    const folder = await workspace.findOrCreateProjectFolder('screenbridge', project.name, '2026');
    expect(folder.name).toBe(project.name);
    expect(created).toEqual([{ name: project.name, mimeType: 'application/vnd.google-apps.folder', parents: ['y2026'] }]);
  });
});
