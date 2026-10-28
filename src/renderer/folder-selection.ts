export interface FolderFrame { id: string; folder: string }
export interface ReviewFolder { path: string; label: string; depth: number; approved: number; total: number }

function normalized(folder: string): string { return folder.split(/[\\/]+/).filter(Boolean).join('/'); }

/** Match directory boundaries, never a similarly named sibling. Empty is the project root. */
export function folderContains(folder: string, parent: string): boolean {
  const value = normalized(folder), prefix = normalized(parent);
  return !prefix || value === prefix || value.startsWith(`${prefix}/`);
}

export function reviewFolders(frames: FolderFrame[], approved: ReadonlySet<string>): ReviewFolder[] {
  const groups = new Map<string, ReviewFolder>();
  for (const frame of frames) {
    const parts = normalized(frame.folder).split('/').filter(Boolean);
    const paths = ['', ...parts.map((_, index) => parts.slice(0, index + 1).join('/'))];
    for (const path of paths) {
      const group = groups.get(path) ?? { path, label: path.split('/').at(-1) || 'Project folder (all stills)', depth: path ? path.split('/').length : 0, approved: 0, total: 0 };
      group.total++;
      if (approved.has(frame.id)) group.approved++;
      groups.set(path, group);
    }
  }
  return [...groups.values()].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

export function folderIsChosen(path: string, choices: ReadonlySet<string>): boolean {
  return [...choices].some(parent => folderContains(path, parent));
}

export function toggleFolderChoice(choices: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(choices);
  if (next.has(path)) next.delete(path);
  else {
    for (const child of next) if (folderContains(child, path)) next.delete(child);
    next.add(path);
  }
  return next;
}

/** The caller supplies the whole project's available frames, independent of UI filters. */
export function folderSelectionIds(frames: FolderFrame[], approved: ReadonlySet<string>, folders: ReadonlySet<string>): Set<string> {
  return new Set(frames.filter(frame => approved.has(frame.id) && folderIsChosen(frame.folder, folders)).map(frame => frame.id));
}
