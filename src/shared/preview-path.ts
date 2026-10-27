import path from 'node:path';

/** Rebase saved previews after the app's data directory has been relocated. */
export function previewPath(file: string, savedSessionRoot: string | undefined, sessionId: string, stagingRoot: string): string {
  if (!savedSessionRoot || !sessionId || path.basename(sessionId) !== sessionId
      || sessionId === '.' || sessionId === '..' || path.basename(savedSessionRoot) !== sessionId) return file;
  const relative = path.relative(savedSessionRoot, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return file;
  return path.join(stagingRoot, sessionId, relative);
}
