export interface ReviewSelection {
  frames: Set<string>;
  skipped: Record<string, string[]>;
}

interface Change {
  added: string[];
  removed: string[];
  beforeSkipped: Record<string, string[]>;
  afterSkipped: Record<string, string[]>;
}

const copySkipped = (value: Record<string, string[]>) => Object.fromEntries(Object.entries(value).map(([id, frames]) => [id, [...frames]]));

/** Store selection differences, rather than copying a large review per click. */
export class ReviewHistory {
  private past: Change[] = [];
  private future: Change[] = [];
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
  clear() { this.past = []; this.future = []; }

  record(before: ReviewSelection, after: ReviewSelection): boolean {
    const added = [...after.frames].filter(id => !before.frames.has(id));
    const removed = [...before.frames].filter(id => !after.frames.has(id));
    if (!added.length && !removed.length && JSON.stringify(before.skipped) === JSON.stringify(after.skipped)) return false;
    this.past.push({ added, removed, beforeSkipped: copySkipped(before.skipped), afterSkipped: copySkipped(after.skipped) });
    if (this.past.length > 100) this.past.shift();
    this.future = [];
    return true;
  }

  undo(current: ReviewSelection): ReviewSelection | undefined {
    const change = this.past.pop();
    if (!change) return;
    this.future.push(change);
    const frames = new Set(current.frames);
    for (const id of change.added) frames.delete(id);
    for (const id of change.removed) frames.add(id);
    return { frames, skipped: copySkipped(change.beforeSkipped) };
  }

  redo(current: ReviewSelection): ReviewSelection | undefined {
    const change = this.future.pop();
    if (!change) return;
    this.past.push(change);
    const frames = new Set(current.frames);
    for (const id of change.removed) frames.delete(id);
    for (const id of change.added) frames.add(id);
    return { frames, skipped: copySkipped(change.afterSkipped) };
  }
}
