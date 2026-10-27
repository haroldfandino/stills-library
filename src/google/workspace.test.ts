import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GoogleAuth } from './auth.js';
import { GoogleConflictError, SOURCE_CONFIG, type DriveFile, type ProjectRow } from './types.js';
import { GoogleWorkspace } from './workspace.js';

const auth = { getAccessToken: async () => 'test-token' } as GoogleAuth;
const json = (value: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const project: ProjectRow = { source: 'screenbridge', rowNumber: 3, name: '[203SB]Airwaav_Brager_PremiumAd', status: 'To Do' };

it('updates native table dropdowns without trying to set validation on typed cells', async () => {
  const tables = new Map<string, any>();
  const writes: any[] = [];
  const fetchImpl = vi.fn(async (input: any, init?: RequestInit) => {
    const url = new URL(String(input)); const key = url.pathname.split('/')[3].split(':')[0];
    if (!tables.has(key)) tables.set(key, { tableId: 'table', range: { startRowIndex: 0, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 2 }, columnProperties: [{ columnName: 'Project', columnType: 'TEXT' }, { columnIndex: 1, columnName: 'Status', columnType: 'DROPDOWN', dataValidationRule: { condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'Done' }] } } }] });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); writes.push(body);
      expect(body.requests).toHaveLength(1);
      expect(body.requests[0].updateTable.fields).toBe('columnProperties');
      tables.get(key).columnProperties = body.requests[0].updateTable.table.columnProperties;
      return json({});
    }
    if (url.pathname.includes('/values/')) return json({ values: [['Project', 'Status']] });
    if (url.searchParams.has('ranges')) return json({ sheets: [{ data: [] }] });
    return json({ sheets: [{ properties: { sheetId: 17, title: 'Stills', gridProperties: { rowCount: 3 } }, tables: [tables.get(key)] }] });
  }) as unknown as typeof fetch;
  const workspace = new GoogleWorkspace({ auth, fetchImpl });
  await workspace.ensureReviewedStatusOptions();
  await workspace.ensureReviewedStatusOptions();
  expect(writes).toHaveLength(2);
  expect(writes[0].requests[0].updateTable.table.columnProperties[0]).toEqual({ columnName: 'Project', columnType: 'TEXT' });
});

it('adds Reviewed to both status dropdowns preserving existing choices and validation settings', async () => {
  const rules = new Map<string, unknown>();
  const writes: any[] = [];
  const fetchImpl = vi.fn(async (input: any, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = url.pathname.split('/')[3].split(':')[0];
    const original = { condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'Done' }, { userEnteredValue: 'Custom' }] }, strict: false, showCustomUi: true, inputMessage: 'Keep me' };
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); writes.push(body);
      rules.set(key, body.requests[0].setDataValidation.rule); return json({});
    }
    if (url.pathname.includes('/values/')) return json({ values: [['Project', 'Status']] });
    if (url.searchParams.has('ranges')) return json({ sheets: [{ data: [{ startRow: 1, rowData: [{ values: [{ dataValidation: rules.get(key) ?? original }] }] }] }] });
    return json({ sheets: [{ properties: { sheetId: 17, title: 'Stills', gridProperties: { rowCount: 2 } } }] });
  }) as unknown as typeof fetch;
  const workspace = new GoogleWorkspace({ auth, fetchImpl });
  expect(await workspace.ensureReviewedStatusOptions()).toEqual(['filmkraft', 'screenbridge']);
  expect(writes).toHaveLength(2);
  expect(writes[0].requests[0].setDataValidation).toMatchObject({ range: { sheetId: 17, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 }, rule: { strict: false, inputMessage: 'Keep me', condition: { values: [{ userEnteredValue: 'Done' }, { userEnteredValue: 'Custom' }, { userEnteredValue: 'Reviewed' }] } } });
  await workspace.ensureReviewedStatusOptions();
  expect(writes).toHaveLength(2);
});
const uploadId = '11111111-1111-4111-8111-111111111111';

function versionFixture() {
  const folderMime = 'application/vnd.google-apps.folder';
  const versionName = '02_Mustela_Baby_Caf\u00e9';
  const files = new Map<string, DriveFile & { trashed?: boolean }>([
    ['project', { id: 'project', name: '[1400]Mustela_2026', mimeType: folderMime, isAppAuthorized: true }],
    ['version', { id: 'version', name: versionName, mimeType: folderMime, parents: ['project'], isAppAuthorized: true }],
  ]);
  const writes: { name: string; mimeType: string; parents: string[] }[] = [];
  const pickFiles = vi.fn(async ({ fileIds }: { fileIds: string[] }) => {
    for (const id of fileIds) files.get(id)!.isAppAuthorized = true;
    return fileIds;
  });
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.searchParams.get('fields')).toContain('trashed');
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { name: string; mimeType: string; parents: string[] };
      writes.push(body);
      const created = { id: 'created-version', ...body, isAppAuthorized: true };
      files.set(created.id, created);
      return json(created);
    }
    expect(init?.method).toBeUndefined();
    if (url.pathname.endsWith('/files')) {
      expect(url.searchParams.get('q')).toBe("'project' in parents and trashed = false");
      return json({ files: [...files.values()].filter(file => !file.trashed && file.parents?.includes('project')) });
    }
    const item = files.get(url.pathname.split('/').at(-1)!);
    return item ? json(item) : json({ error: { message: 'Not found' } }, 404);
  }) as unknown as typeof fetch;
  const pickerAuth = { getAccessToken: async () => 'test-token', pickFiles } as unknown as GoogleAuth;
  return { files, writes, pickFiles, versionName, workspace: new GoogleWorkspace({ auth: pickerAuth, fetchImpl }) };
}

describe('creative-version Drive destinations', () => {
  it('reuses an exact numbered version folder without changing existing content', async () => {
    const fixture = versionFixture();
    const before = structuredClone([...fixture.files.values()]);
    const folder = await fixture.workspace.ensureVersionDestination('project', fixture.versionName);
    expect(folder.id).toBe('version');
    expect(fixture.writes).toEqual([]);
    expect([...fixture.files.values()]).toEqual(before);
  });

  it('creates one exact version child and verifies its route without moving any sibling', async () => {
    const fixture = versionFixture();
    const name = '03_Mustela_Parents_Caf\u00e9';
    const existing = structuredClone(fixture.files.get('version'));
    const created = await fixture.workspace.ensureVersionDestination('project', name);
    expect(created).toMatchObject({ id: 'created-version', name, parents: ['project'] });
    expect(fixture.writes).toEqual([{ name, mimeType: 'application/vnd.google-apps.folder', parents: ['project'] }]);
    expect(fixture.files.get('version')).toEqual(existing);
  });

  it('refuses duplicate version names without creating a replacement', async () => {
    const fixture = versionFixture();
    fixture.files.set('duplicate', { ...fixture.files.get('version')!, id: 'duplicate' });
    await expect(fixture.workspace.ensureVersionDestination('project', fixture.versionName)).rejects.toBeInstanceOf(GoogleConflictError);
    await expect(fixture.workspace.verifyVersionDestination('project', fixture.versionName, 'version')).rejects.toBeInstanceOf(GoogleConflictError);
    expect(fixture.writes).toEqual([]);
  });

  it('refuses an existing file or case variant with the intended folder name', async () => {
    const fixture = versionFixture();
    fixture.files.get('version')!.mimeType = 'image/png';
    await expect(fixture.workspace.ensureVersionDestination('project', fixture.versionName)).rejects.toThrow('not a folder');
    fixture.files.get('version')!.mimeType = 'application/vnd.google-apps.folder';
    fixture.files.get('version')!.name = fixture.versionName.toUpperCase();
    await expect(fixture.workspace.ensureVersionDestination('project', fixture.versionName)).rejects.toThrow('case or Unicode variant');
    expect(fixture.writes).toEqual([]);
  });

  it.each([
    { name: 'different version' },
    { parents: ['another-project'] },
    { parents: ['project', 'another-project'] },
    { mimeType: 'image/png' },
    { trashed: true },
  ])('blocks a saved destination whose route changed: %j', async change => {
    const fixture = versionFixture();
    Object.assign(fixture.files.get('version')!, change);
    await expect(fixture.workspace.verifyVersionDestination('project', fixture.versionName, 'version')).rejects.toBeInstanceOf(GoogleConflictError);
    expect(fixture.writes).toEqual([]);
  });

  it('blocks a trashed project parent before creating a version folder', async () => {
    const fixture = versionFixture();
    fixture.files.get('project')!.trashed = true;
    await expect(fixture.workspace.ensureVersionDestination('project', '03_New')).rejects.toBeInstanceOf(GoogleConflictError);
    expect(fixture.writes).toEqual([]);
  });

  it('grants existing folders through Picker and checks their route afterward', async () => {
    const fixture = versionFixture();
    fixture.files.get('project')!.isAppAuthorized = false;
    fixture.files.get('version')!.isAppAuthorized = false;
    await fixture.workspace.ensureVersionDestination('project', fixture.versionName);
    expect(fixture.pickFiles.mock.calls.map(([input]) => input.fileIds)).toEqual([['project'], ['version']]);
    expect(fixture.writes).toEqual([]);

    fixture.files.get('version')!.isAppAuthorized = false;
    fixture.pickFiles.mockImplementation(async ({ fileIds }) => {
      fixture.files.get('version')!.isAppAuthorized = true;
      fixture.files.get('version')!.parents = ['different-project'];
      return fileIds;
    });
    await expect(fixture.workspace.verifyVersionDestination('project', fixture.versionName, 'version')).rejects.toBeInstanceOf(GoogleConflictError);
    expect(fixture.writes).toEqual([]);
  });

  it('rechecks uniqueness when another folder appears during Picker', async () => {
    const fixture = versionFixture();
    fixture.files.get('version')!.isAppAuthorized = false;
    fixture.pickFiles.mockImplementation(async ({ fileIds }) => {
      fixture.files.get('version')!.isAppAuthorized = true;
      fixture.files.set('duplicate', { ...fixture.files.get('version')!, id: 'duplicate' });
      return fileIds;
    });
    await expect(fixture.workspace.verifyVersionDestination('project', fixture.versionName, 'version')).rejects.toBeInstanceOf(GoogleConflictError);
    expect(fixture.writes).toEqual([]);
  });

  it.each(['', '.', '..', '01/name', '01\\name', 'bad\nname'])('rejects an invalid version name %j before any request', async name => {
    const fixture = versionFixture();
    await expect(fixture.workspace.ensureVersionDestination('project', name)).rejects.toThrow('plain folder name');
    expect(fixture.writes).toEqual([]);
    expect(fixture.pickFiles).not.toHaveBeenCalled();
  });
});

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


describe('explicit organization of verified PNGs', () => {
  function fixture() {
    let parent = 'old';
    let conflict = false;
    const writes: URL[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === 'PATCH') { writes.push(url); parent = url.searchParams.get('addParents')!; return json({}); }
      if (url.pathname.endsWith('/folder')) return json({ id: 'folder', name: 'folder', mimeType: 'application/vnd.google-apps.folder', isAppAuthorized: true, capabilities: { canListChildren: true } });
      if (url.pathname.endsWith('/files')) return json({ files: conflict ? [{ id: 'other', name: 'still.png' }] : [] });
      if (url.pathname.endsWith('/new')) return json({ id: 'new', name: 'Square', mimeType: 'application/vnd.google-apps.folder', isAppAuthorized: true });
      return json({ id: 'png', name: 'still.png', mimeType: 'image/png', parents: [parent], size: '10', md5Checksum: 'abc', appProperties: { stillsLibraryUploadId: uploadId } });
    }) as unknown as typeof fetch;
    return { workspace: new GoogleWorkspace({ auth, fetchImpl }), writes, conflict: () => { conflict = true; }, moved: () => { parent = 'new'; } };
  }
  it('moves only the verified file and can recover an already-completed remote move', async () => {
    const f = fixture();
    await f.workspace.relocateVerifiedPng('png', 'old', 'new', 'still.png', 'abc', 10, uploadId);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0].searchParams.get('removeParents')).toBe('old');
    await f.workspace.relocateVerifiedPng('png', 'old', 'new', 'still.png', 'abc', 10, uploadId);
    expect(f.writes).toHaveLength(1);
  });
  it('refuses a checksum mismatch or a destination name collision without writes', async () => {
    const f = fixture();
    await expect(f.workspace.relocateVerifiedPng('png', 'old', 'new', 'still.png', 'wrong', 10, uploadId)).rejects.toThrow(/verification/);
    f.conflict();
    await expect(f.workspace.relocateVerifiedPng('png', 'old', 'new', 'still.png', 'abc', 10, uploadId)).rejects.toThrow(/already contains/);
    expect(f.writes).toHaveLength(0);
  });
});


describe('verified delivery revisions', () => {
  it('renames and trashes only owned PNGs, with idempotent recovery', async () => {
    const file = { id: 'png', name: 'old.png', mimeType: 'image/png', parents: ['folder'], size: '7', md5Checksum: 'abc', appProperties: { stillsLibraryUploadId: uploadId }, trashed: false };
    let writes = 0;
    let conflict = false;
    const workspace = new GoogleWorkspace({ auth, fetchImpl: (async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === 'PATCH') {
        expect(url.searchParams.get('supportsAllDrives')).toBe('true');
        writes++;
        Object.assign(file, JSON.parse(String(init.body)));
        return json(file);
      }
      if (url.pathname.endsWith('/folder')) return json({ id: 'folder', name: 'folder', mimeType: 'application/vnd.google-apps.folder', isAppAuthorized: true, capabilities: { canListChildren: true } });
      if (url.pathname.endsWith('/files')) return json({ files: conflict ? [{ ...file, id: 'foreign', name: 'new.png' }] : [file] });
      return json(file);
    }) as typeof fetch });
    await expect(workspace.reviseVerifiedPng('png', 'folder', 'old.png', 'new.png', 'bad', 7, uploadId)).rejects.toThrow('ownership');
    conflict = true;
    await expect(workspace.reviseVerifiedPng('png', 'folder', 'old.png', 'new.png', 'abc', 7, uploadId)).rejects.toThrow('already contains');
    expect(writes).toBe(0);
    conflict = false;
    await workspace.reviseVerifiedPng('png', 'folder', 'old.png', 'new.png', 'abc', 7, uploadId);
    await workspace.reviseVerifiedPng('png', 'folder', 'old.png', 'new.png', 'abc', 7, uploadId);
    expect(writes).toBe(1);
    await workspace.reviseVerifiedPng('png', 'folder', 'new.png', null, 'abc', 7, uploadId);
    await workspace.reviseVerifiedPng('png', 'folder', 'new.png', null, 'abc', 7, uploadId);
    expect(writes).toBe(2);
    expect(file.trashed).toBe(true);
    await expect(workspace.verifyUploadedPng('png', 'folder', 'new.png', 'abc', 7, uploadId)).rejects.toThrow('verification');
  });
});


describe('empty delivery folder cleanup', () => {
  it('keeps folders with other items and trashes only the exact empty folder, idempotently', async () => {
    const folder = { id: 'version', name: 'Video', mimeType: 'application/vnd.google-apps.folder', parents: ['project'], trashed: false };
    let occupied = true, writes = 0;
    const workspace = new GoogleWorkspace({ auth, fetchImpl: (async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === 'PATCH') {
        writes++;
        expect(JSON.parse(String(init.body))).toEqual({ trashed: true });
        folder.trashed = true;
      }
      if (url.pathname.endsWith('/files')) return json({ files: occupied ? [{ id: 'foreign', name: 'notes.txt' }] : [] });
      return json(folder);
    }) as typeof fetch });
    expect(await workspace.trashEmptyDeliveryFolder('version', 'project', 'Video')).toBe(false);
    expect(writes).toBe(0);
    await expect(workspace.trashEmptyDeliveryFolder('version', 'other', 'Video')).rejects.toThrow('identity');
    expect(writes).toBe(0);
    occupied = false;
    expect(await workspace.trashEmptyDeliveryFolder('version', 'project', 'Video')).toBe(true);
    expect(await workspace.trashEmptyDeliveryFolder('version', 'project', 'Video')).toBe(true);
    expect(writes).toBe(1);
  });
});
