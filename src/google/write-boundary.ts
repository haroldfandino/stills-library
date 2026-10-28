import { GoogleApiError, type DriveFile, type SourceConfigs } from './types.js';

const FOLDER = 'application/vnd.google-apps.folder';
const fail = (): never => { throw new GoogleApiError('Drive change blocked: destination is outside the configured Stills Library folders or its location could not be verified.', 403, 'outside_library'); };

/** Resolve ancestry afresh for every write. Names alone never establish access. */
export async function assertLibraryFolder(
  id: string, sources: SourceConfigs, getFile: (id: string) => Promise<DriveFile>,
  listFiles: (id: string) => Promise<DriveFile[]>,
): Promise<void> {
  const roots = new Set(Object.values(sources).map(s => s.destinationFolderId));
  const seen = new Set<string>();
  let child: DriveFile | undefined;
  for (let depth = 0; depth < 20; depth++) {
    if (!id || seen.has(id)) fail();
    seen.add(id);
    const file = await getFile(id);
    if (file.id !== id || file.mimeType !== FOLDER || (file as DriveFile & { trashed?: boolean }).trashed) fail();
    if (roots.has(id)) {
      if (file.name === '01_Stills' || /^20\d{2}$/.test(file.name)) return;
      // A configured library root may also contain video libraries. Only its
      // unique 01_Stills child is writable, never those siblings or the root.
      if (!child || child.name !== '01_Stills') fail();
      const matches = (await listFiles(id)).filter(f => f.name === '01_Stills');
      if (matches.length !== 1 || matches[0].id !== child!.id || matches[0].mimeType !== FOLDER) fail();
      return;
    }
    if (file.parents?.length !== 1) fail();
    child = file;
    id = file.parents![0];
  }
  fail();
}

