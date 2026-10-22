import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { GoogleAuth } from './auth.js';
import {
  GoogleApiError, GoogleConflictError, SOURCE_CONFIG,
  type DriveFile, type ProjectRow, type ProjectStatus,
  type RootVerification, type SourceConfigs, type SourceKey,
} from './types.js';

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const PNG_MIME = 'image/png';
const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
const GOOGLE_FILE_FIELDS = 'id,name,mimeType,parents,size,md5Checksum,webViewLink,driveId,isAppAuthorized,appProperties,capabilities(canEdit,canAddChildren,canListChildren)';
const UPLOAD_MARKER = 'stillsLibraryUploadId';
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface GoogleWorkspaceOptions {
  auth: GoogleAuth;
  fetchImpl?: typeof fetch;
  /** Overrides may be saved after a user picks a replacement Sheet or destination folder. */
  sources?: SourceConfigs;
}

export interface UploadPngInput {
  folderId: string;
  filePath: string;
  fileName: string;
  uploadId: string;
  onProgress?: (bytesUploaded: number, totalBytes: number) => void;
}

interface SheetValues { values?: string[][] }
interface DriveFileList { files?: DriveFile[]; nextPageToken?: string; incompleteSearch?: boolean }

function sourceKeys(): SourceKey[] { return ['filmkraft', 'screenbridge']; }

function driveLiteral(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function collisionKey(name: string): string { return name.normalize('NFC').toLocaleLowerCase('en-US'); }

function requiresPicker(error: unknown): boolean {
  return error instanceof GoogleApiError && (error.status === 403 || error.status === 404);
}

function assertAppAuthorized(file: DriveFile): void {
  if (file.isAppAuthorized === false) {
    throw new GoogleApiError(`Select ${file.name} in Google Picker to grant this app access.`, 403, 'picker_grant_required');
  }
}

function checkGoogleUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || (url.hostname !== 'googleapis.com' && !url.hostname.endsWith('.googleapis.com'))) {
    throw new GoogleApiError('Google returned an untrusted upload URL.', 502, 'untrusted_upload_url');
  }
  return url;
}

async function errorFromResponse(response: Response, endpoint: string): Promise<GoogleApiError> {
  let body: unknown;
  try { body = await response.json(); } catch { body = null; }
  const outer = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const payload = outer.error && typeof outer.error === 'object' ? outer.error as Record<string, unknown> : outer;
  const status = response.status;
  const rawMessage = typeof payload.message === 'string' ? payload.message : `Google returned HTTP ${status}`;
  const rawCode = typeof payload.status === 'string' ? payload.status : `http_${status}`;
  const details = Array.isArray(payload.errors) ? payload.errors : [];
  if (status === 403 && details.some(item => item && typeof item === 'object'
    && (item as Record<string, unknown>).reason === 'appNotAuthorizedToFile')) {
    return new GoogleApiError('Select this file or folder in Google Picker to grant the app access.', 403, 'picker_grant_required', endpoint);
  }
  if (status === 403 && /insufficient|scope|permission/i.test(rawMessage)) {
    return new GoogleApiError('Google denied this request. Reauthorize the app with Drive file and read-only metadata access, or verify edit permission.', 403, 'insufficient_scope_or_permission', endpoint);
  }
  if (status === 404) {
    return new GoogleApiError('Google file or folder is unavailable to this app. Select it in Google Picker or update its ID.', 404, 'not_found_or_not_granted', endpoint);
  }
  return new GoogleApiError(rawMessage, status, rawCode, endpoint);
}

export class GoogleWorkspace {
  readonly sources: SourceConfigs;
  private readonly auth: GoogleAuth;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GoogleWorkspaceOptions) {
    this.auth = options.auth;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sources = options.sources ?? SOURCE_CONFIG;
  }

  private source(source: SourceKey) {
    const value = this.sources[source];
    if (!value?.spreadsheetId || !value.destinationFolderId) throw new Error(`Missing Google configuration for ${source}.`);
    return value;
  }

  private async request(url: string | URL, init: RequestInit = {}): Promise<Response> {
    const endpoint = checkGoogleUrl(String(url)).toString();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${await this.auth.getAccessToken()}`);
    const response = await this.fetchImpl(endpoint, { ...init, headers });
    if (response.status !== 401) return response;
    headers.set('Authorization', `Bearer ${await this.auth.getAccessToken(true)}`);
    return this.fetchImpl(endpoint, { ...init, headers });
  }

  private async json<T>(url: string | URL, init: RequestInit = {}): Promise<T> {
    const endpoint = String(url);
    const response = await this.request(url, init);
    if (!response.ok) throw await errorFromResponse(response, endpoint);
    return await response.json() as T;
  }

  async verifyRoots(): Promise<Record<SourceKey, RootVerification>> {
    await this.auth.getAccessToken();
    const result = {} as Record<SourceKey, RootVerification>;
    for (const source of sourceKeys()) {
      const config = this.source(source);
      const entry: RootVerification = { source, sheetOk: false, folderOk: false, requiresPicker: false };
      try {
        const sheetUrl = new URL(`${SHEETS_BASE}/${encodeURIComponent(config.spreadsheetId)}`);
        sheetUrl.searchParams.set('fields', 'spreadsheetId,sheets(properties(title))');
        const sheet = await this.json<{ sheets?: { properties?: { title?: string } }[] }>(sheetUrl);
        if (!sheet.sheets?.some(item => item.properties?.title === 'Stills')) throw new Error('The spreadsheet has no Stills tab.');
        const sheetFile = await this.getFile(config.spreadsheetId);
        assertAppAuthorized(sheetFile);
        if (sheetFile.capabilities?.canEdit === false) throw new Error('The signed-in account cannot edit the spreadsheet.');
        entry.sheetOk = true;
      } catch (error) {
        entry.sheetError = error instanceof Error ? error.message : String(error);
        entry.requiresPicker ||= requiresPicker(error);
      }
      try {
        const folder = await this.getFile(config.destinationFolderId);
        if (folder.mimeType !== FOLDER_MIME) throw new Error('Configured Drive destination is not a folder.');
        assertAppAuthorized(folder);
        if (folder.capabilities?.canAddChildren === false || folder.capabilities?.canListChildren === false) {
          throw new Error('The signed-in account cannot list or add files in the destination folder.');
        }
        entry.folderOk = true;
        entry.folderName = folder.name;
      } catch (error) {
        entry.folderError = error instanceof Error ? error.message : String(error);
        entry.requiresPicker ||= requiresPicker(error);
      }
      result[source] = entry;
    }
    return result;
  }

  /** Reads only the Stills tab's project/status columns. Row 1 is required headers. */
  async listProjects(source?: SourceKey): Promise<ProjectRow[]> {
    const keys = source ? [source] : sourceKeys();
    const projects: ProjectRow[] = [];
    for (const key of keys) {
      const url = `${SHEETS_BASE}/${encodeURIComponent(this.source(key).spreadsheetId)}/values/${encodeURIComponent('Stills!A:B')}?valueRenderOption=FORMATTED_VALUE`;
      const sheet = await this.json<SheetValues>(url);
      const rows = sheet.values ?? [];
      if (rows[0]?.[0]?.trim() !== 'Project' || rows[0]?.[1]?.trim() !== 'Status') {
        throw new GoogleApiError(`${this.source(key).label} Stills tab must have Project and Status in A1:B1.`, 422, 'unexpected_sheet_layout');
      }
      for (let i = 1; i < rows.length; i++) {
        const name = rows[i]?.[0]?.trim();
        if (name) projects.push({ source: key, rowNumber: i + 1, name, status: rows[i]?.[1]?.trim() ?? '' });
      }
    }
    return projects;
  }

  /** Re-reads A:B immediately before changing B, and confirms the write afterward. */
  async updateStatus(project: ProjectRow, nextStatus: ProjectStatus, expectedStatus = project.status): Promise<ProjectRow> {
    if (!Number.isSafeInteger(project.rowNumber) || project.rowNumber < 2 || !project.name.trim()) throw new Error('Invalid Stills project row.');
    if (!(['To Do', 'In Process', 'Done', 'Skip'] as string[]).includes(nextStatus)) throw new Error(`Invalid status ${nextStatus}.`);
    const config = this.source(project.source);
    const readUrl = `${SHEETS_BASE}/${encodeURIComponent(config.spreadsheetId)}/values/${encodeURIComponent(`Stills!A${project.rowNumber}:B${project.rowNumber}`)}?valueRenderOption=FORMATTED_VALUE`;
    const before = await this.json<SheetValues>(readUrl);
    const actualName = before.values?.[0]?.[0]?.trim() ?? '';
    const actualStatus = before.values?.[0]?.[1]?.trim() ?? '';
    if (actualName !== project.name || actualStatus !== expectedStatus) {
      throw new GoogleConflictError(`Stills row ${project.rowNumber} changed. Refresh projects before updating its status.`);
    }
    if (actualStatus === nextStatus) return { ...project, status: nextStatus };
    const writeUrl = `${SHEETS_BASE}/${encodeURIComponent(config.spreadsheetId)}/values/${encodeURIComponent(`Stills!B${project.rowNumber}`)}?valueInputOption=RAW`;
    await this.json<unknown>(writeUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ range: `Stills!B${project.rowNumber}`, majorDimension: 'ROWS', values: [[nextStatus]] }),
    });
    const after = await this.json<SheetValues>(readUrl);
    if (after.values?.[0]?.[0]?.trim() !== project.name || after.values?.[0]?.[1]?.trim() !== nextStatus) {
      throw new GoogleConflictError(`Stills row ${project.rowNumber} did not retain ${nextStatus}; refresh before continuing.`);
    }
    return { ...project, status: nextStatus };
  }

  async getFile(fileId: string): Promise<DriveFile> {
    const url = new URL(`${DRIVE_BASE}/${encodeURIComponent(fileId)}`);
    url.searchParams.set('fields', GOOGLE_FILE_FIELDS);
    url.searchParams.set('supportsAllDrives', 'true');
    return this.json<DriveFile>(url);
  }

  async listFolderFiles(folderId: string): Promise<DriveFile[]> {
    const folder = await this.getFile(folderId);
    if (folder.mimeType !== FOLDER_MIME) throw new GoogleApiError('Destination item is not a folder.', 422, 'not_a_folder');
    if (folder.capabilities?.canListChildren === false) throw new GoogleApiError('Google denies listing this folder; upload is blocked to protect existing names.', 403, 'cannot_list_folder');
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(DRIVE_BASE);
      url.searchParams.set('q', `${driveLiteral(folderId)} in parents and trashed = false`);
      url.searchParams.set('fields', `nextPageToken,incompleteSearch,files(${GOOGLE_FILE_FIELDS})`);
      url.searchParams.set('pageSize', '1000');
      url.searchParams.set('supportsAllDrives', 'true');
      url.searchParams.set('includeItemsFromAllDrives', 'true');
      url.searchParams.set('corpora', folder.driveId ? 'drive' : 'user');
      if (folder.driveId) url.searchParams.set('driveId', folder.driveId);
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const page = await this.json<DriveFileList>(url);
      if (page.incompleteSearch) throw new GoogleApiError('Drive did not return a complete folder listing; upload is blocked to protect existing files.', 409, 'incomplete_listing');
      files.push(...(page.files ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return files;
  }

  /** Existing destination ancestors that must be opened by this OAuth app. */
  async destinationFolderGrantTargets(): Promise<DriveFile[]> {
    const targets: DriveFile[] = [];
    for (const source of sourceKeys()) {
      const root = await this.getFile(this.source(source).destinationFolderId);
      if (root.mimeType !== FOLDER_MIME) throw new GoogleApiError('Configured destination is not a folder.', 422, 'not_a_folder');
      let stills = root;
      if (root.name !== '01_Stills' && !/^20\d{2}$/.test(root.name)) {
        const folders = (await this.listFolderFiles(root.id)).filter(file => file.name === '01_Stills' && file.mimeType === FOLDER_MIME);
        if (folders.length !== 1) throw new GoogleConflictError(`Expected exactly one 01_Stills folder inside ${root.name}.`);
        stills = folders[0];
      }
      if (stills.id !== root.id) targets.push(stills);
      if (!/^20\d{2}$/.test(stills.name)) {
        targets.push(...(await this.listFolderFiles(stills.id)).filter(file => /^20\d{2}$/.test(file.name) && file.mimeType === FOLDER_MIME));
      }
    }
    return targets;
  }

  /** Opens an existing project/year folder in Picker before any write to it. */
  async ensureFolderAuthorized(folderId: string): Promise<DriveFile> {
    let folder = await this.getFile(folderId);
    if (folder.mimeType !== FOLDER_MIME) throw new GoogleApiError('Destination item is not a folder.', 422, 'not_a_folder');
    if (folder.isAppAuthorized === false) {
      await this.auth.pickFiles({ fileIds: [folderId], allowFolders: true });
      folder = await this.getFile(folderId);
      assertAppAuthorized(folder);
    }
    if (folder.capabilities?.canAddChildren === false || folder.capabilities?.canListChildren === false) {
      throw new GoogleApiError('The signed-in account cannot list and add files in this destination folder.', 403, 'cannot_write_folder');
    }
    return folder;
  }

  /** Read-only destination lookup and Picker grant before moving a Sheet row to In Process. */
  async preflightProjectDestination(source: SourceKey, projectName: string): Promise<void> {
    const name = projectName.trim();
    if (!name || name.includes('/') || name.includes('\\')) throw new Error('Invalid project folder name.');
    const configured = await this.getFile(this.source(source).destinationFolderId);
    if (configured.mimeType !== FOLDER_MIME) throw new Error('Configured destination is not a folder.');
    let stills = configured;
    if (configured.name !== '01_Stills' && !/^20\d{2}$/.test(configured.name)) {
      const matches = (await this.listFolderFiles(configured.id)).filter(file => file.name === '01_Stills' && file.mimeType === FOLDER_MIME);
      if (matches.length !== 1) throw new GoogleConflictError(`Expected exactly one 01_Stills folder inside ${configured.name}.`);
      stills = matches[0];
    }
    const yearFolders = /^20\d{2}$/.test(stills.name) ? [stills]
      : (await this.listFolderFiles(stills.id)).filter(file => /^20\d{2}$/.test(file.name) && file.mimeType === FOLDER_MIME);
    if (!yearFolders.length) throw new GoogleConflictError(`No destination year folders were found inside ${stills.name}.`);
    const exact: DriveFile[] = [];
    for (const yearFolder of yearFolders) {
      for (const file of await this.listFolderFiles(yearFolder.id)) {
        if (file.name !== name && collisionKey(file.name) === collisionKey(name)) {
          throw new GoogleConflictError(`Destination already contains a project folder with a case variant of ${name}.`);
        }
        if (file.name === name) exact.push(file);
      }
    }
    if (exact.length > 1) throw new GoogleConflictError(`Multiple destination items named ${name}; choose the correct year manually.`);
    if (exact.length === 1) {
      if (exact[0].mimeType !== FOLDER_MIME) throw new GoogleConflictError(`Destination item ${name} exists but is not a folder.`);
      await this.ensureFolderAuthorized(exact[0].id);
      return;
    }
    for (const yearFolder of yearFolders) await this.ensureFolderAuthorized(yearFolder.id);
  }

  /** Read-only route check for a saved destination ID; never creates a replacement. */
  async verifyProjectFolder(source: SourceKey, projectName: string, year: string, folderId: string): Promise<DriveFile> {
    if (!/^20\d{2}$/.test(year)) throw new Error('Delivery year must be a four-digit 20xx year.');
    const folder = await this.getFile(folderId);
    if (folder.mimeType !== FOLDER_MIME || folder.name !== projectName || folder.parents?.length !== 1) {
      throw new GoogleConflictError('Saved destination is no longer the exact project folder. Delivery is paused.');
    }
    const yearFolder = await this.getFile(folder.parents[0]);
    if (yearFolder.mimeType !== FOLDER_MIME || yearFolder.name !== year || yearFolder.parents?.length !== 1) {
      throw new GoogleConflictError('Saved destination is no longer under the selected delivery year. Delivery is paused.');
    }
    const configuredId = this.source(source).destinationFolderId;
    if (yearFolder.id !== configuredId) {
      const stills = await this.getFile(yearFolder.parents[0]);
      if (stills.mimeType !== FOLDER_MIME || stills.name !== '01_Stills'
          || (stills.id !== configuredId && !stills.parents?.includes(configuredId))) {
        throw new GoogleConflictError('Saved destination is outside the configured 01_Stills folder. Delivery is paused.');
      }
    }
    const authorized = await this.ensureFolderAuthorized(folderId);
    if (authorized.name !== projectName || authorized.mimeType !== FOLDER_MIME
        || !authorized.parents?.includes(yearFolder.id)) {
      throw new GoogleConflictError('Saved destination changed while its Google access was checked. Delivery is paused.');
    }
    return authorized;
  }

  /**
   * Locate a project under 01_Stills/<year>. Exact existing names are reused.
   * For a new folder without a year in its name, the caller must choose a year.
   */
  async findOrCreateProjectFolder(source: SourceKey, projectName: string, year?: string): Promise<DriveFile> {
    const name = projectName.trim();
    if (!name || name.includes('/') || name.includes('\\')) throw new Error('Invalid project folder name.');
    const configured = await this.getFile(this.source(source).destinationFolderId);
    if (configured.mimeType !== FOLDER_MIME) throw new Error('Configured destination is not a folder.');
    let stills = configured;
    if (configured.name !== '01_Stills' && !/^20\d{2}$/.test(configured.name)) {
      const matches = (await this.listFolderFiles(configured.id)).filter(file => file.name === '01_Stills' && file.mimeType === FOLDER_MIME);
      if (matches.length !== 1) throw new GoogleConflictError(`Expected exactly one 01_Stills folder inside ${configured.name}.`);
      stills = matches[0];
    }
    const yearFolders = /^20\d{2}$/.test(stills.name) ? [stills]
      : (await this.listFolderFiles(stills.id)).filter(file => /^20\d{2}$/.test(file.name) && file.mimeType === FOLDER_MIME);
    const existing: { folder: DriveFile; year: string }[] = [];
    for (const yearFolder of yearFolders) {
      for (const file of await this.listFolderFiles(yearFolder.id)) {
        if (file.name !== name && collisionKey(file.name) === collisionKey(name)) {
          throw new GoogleConflictError(`Destination already contains a project folder with a case variant of ${name}.`);
        }
        if (file.name === name) existing.push({ folder: file, year: yearFolder.name });
      }
    }
    if (existing.length > 1) throw new GoogleConflictError(`Multiple destination items named ${name}; choose the correct year manually.`);
    if (existing.length === 1) {
      if (year && existing[0].year !== year) throw new GoogleConflictError(`${name} already exists under ${existing[0].year}, not ${year}.`);
      if (existing[0].folder.mimeType !== FOLDER_MIME) throw new GoogleConflictError(`Destination item ${name} exists but is not a folder.`);
      return this.verifyProjectFolder(source, name, year ?? existing[0].year, existing[0].folder.id);
    }
    const namedYears = [...new Set(name.match(/20\d{2}/g) ?? [])];
    const chosenYear = year ?? (namedYears.length === 1 ? namedYears[0] : undefined);
    if (!chosenYear || !/^20\d{2}$/.test(chosenYear)) {
      throw new GoogleApiError(`Choose the destination year before creating a folder for ${name}.`, 422, 'destination_year_required');
    }
    const target = yearFolders.filter(item => item.name === chosenYear);
    if (target.length !== 1) throw new GoogleConflictError(`Expected exactly one ${chosenYear} folder inside 01_Stills.`);
    const parentId = target[0].id;
    await this.ensureFolderAuthorized(parentId);
    const url = new URL(DRIVE_BASE);
    url.searchParams.set('fields', GOOGLE_FILE_FIELDS);
    url.searchParams.set('supportsAllDrives', 'true');
    const created = await this.json<DriveFile>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
    if (created.name !== name || created.mimeType !== FOLDER_MIME || !created.parents?.includes(parentId)) {
      throw new GoogleApiError('Drive did not confirm the newly created project folder.', 502, 'folder_verification_failed');
    }
    return created;
  }

  async verifyUploadedPng(fileId: string, folderId: string, fileName: string, localMd5: string, localSize: number, uploadId: string): Promise<DriveFile> {
    const file = await this.getFile(fileId);
    if (file.name !== fileName || file.mimeType !== PNG_MIME || !file.parents?.includes(folderId)
        || file.size !== String(localSize) || file.md5Checksum?.toLowerCase() !== localMd5.toLowerCase()
        || file.appProperties?.[UPLOAD_MARKER] !== uploadId) {
      throw new GoogleApiError(`Uploaded PNG ${fileName} failed Drive metadata verification.`, 502, 'upload_verification_failed');
    }
    return file;
  }

  /** Creates a new PNG only; an existing same-name item causes a conflict. */
  async uploadPng(input: UploadPngInput): Promise<DriveFile> {
    const { folderId, filePath, fileName, uploadId, onProgress } = input;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uploadId)) {
      throw new Error('PNG upload requires a persistent UUID.');
    }
    if (!fileName.toLowerCase().endsWith('.png') || fileName.includes('/') || fileName.includes('\\') || fileName !== fileName.trim()) {
      throw new Error('PNG upload requires a plain .png file name.');
    }
    const bytes = await readFile(filePath);
    if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('Selected file is not a PNG.');
    const localMd5 = createHash('md5').update(bytes).digest('hex');
    const existing = (await this.listFolderFiles(folderId)).filter(file => collisionKey(file.name) === collisionKey(fileName));
    if (existing.length) throw new GoogleConflictError(`Destination already contains ${fileName}; choose a different name.`);
    const metadata = { name: fileName, mimeType: PNG_MIME, parents: [folderId],
      appProperties: { [UPLOAD_MARKER]: uploadId } };
    const url = new URL(UPLOAD_BASE);
    url.searchParams.set('uploadType', 'resumable');
    url.searchParams.set('fields', GOOGLE_FILE_FIELDS);
    url.searchParams.set('supportsAllDrives', 'true');
    const sessionResponse = await this.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': PNG_MIME,
        'X-Upload-Content-Length': String(bytes.length),
      },
      body: JSON.stringify(metadata),
    });
    if (!sessionResponse.ok) throw await errorFromResponse(sessionResponse, String(url));
    const location = sessionResponse.headers.get('location');
    if (!location) throw new GoogleApiError('Drive did not return a resumable upload session.', 502, 'missing_upload_session');
    const sessionUrl = checkGoogleUrl(location);
    let offset = 0;
    let recoveryAttempts = 0;
    while (offset < bytes.length) {
      const end = Math.min(offset + UPLOAD_CHUNK_SIZE, bytes.length);
      let response: Response;
      try {
        response = await this.request(sessionUrl, {
          method: 'PUT',
          headers: {
            'Content-Type': PNG_MIME,
            'Content-Range': `bytes ${offset}-${end - 1}/${bytes.length}`,
          },
          body: bytes.subarray(offset, end),
        });
      } catch (error) {
        if (++recoveryAttempts > 2) throw error;
        const recovered = await this.recoverUpload(sessionUrl, bytes.length);
        if (typeof recovered !== 'number') {
          return this.verifyUploadedPng(recovered.id, folderId, fileName, localMd5, bytes.length, uploadId);
        }
        offset = recovered;
        continue;
      }
      if (response.status === 308) {
        const next = this.nextUploadOffset(response.headers.get('range'), bytes.length);
        if (next <= offset) throw new GoogleApiError('Drive upload did not advance.', 502, 'upload_stalled');
        offset = next;
        onProgress?.(offset, bytes.length);
        continue;
      }
      if (!response.ok) throw await errorFromResponse(response, String(sessionUrl));
      const created = await response.json() as DriveFile;
      if (!created.id) throw new GoogleApiError('Drive did not return an uploaded file ID.', 502, 'missing_file_id');
      onProgress?.(bytes.length, bytes.length);
      return this.verifyUploadedPng(created.id, folderId, fileName, localMd5, bytes.length, uploadId);
    }
    const completed = await this.recoverUpload(sessionUrl, bytes.length);
    if (typeof completed !== 'number') {
      return this.verifyUploadedPng(completed.id, folderId, fileName, localMd5, bytes.length, uploadId);
    }
    throw new GoogleApiError('Drive upload ended without a completed file.', 502, 'upload_incomplete');
  }

  private nextUploadOffset(range: string | null, total: number): number {
    if (!range) return 0;
    const match = /^bytes=0-(\d+)$/.exec(range);
    if (!match) throw new GoogleApiError('Drive returned an invalid upload range.', 502, 'invalid_upload_range');
    const offset = Number(match[1]) + 1;
    if (offset > total) throw new GoogleApiError('Drive reported more bytes than the PNG contains.', 502, 'invalid_upload_range');
    return offset;
  }

  private async recoverUpload(sessionUrl: URL, total: number): Promise<number | DriveFile> {
    const response = await this.request(sessionUrl, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes */${total}`, 'Content-Length': '0' },
    });
    if (response.status === 308) return this.nextUploadOffset(response.headers.get('range'), total);
    if (!response.ok) throw await errorFromResponse(response, String(sessionUrl));
    const completed = await response.json() as DriveFile;
    if (!completed.id) throw new GoogleApiError('Drive completed an upload without returning a file ID.', 502, 'missing_file_id');
    return completed;
  }
}
