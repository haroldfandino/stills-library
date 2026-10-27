import { expect, test } from 'vitest';
import { ReviewHistory } from './review-history';

test('undo/redo restores both selected stills and skipped video visibility', () => {
  const history = new ReviewHistory();
  const before = { frames: new Set(['a', 'b', 'c']), skipped: {} };
  const skipped = { frames: new Set(['c']), skipped: { video: ['a', 'b'] } };
  expect(history.record(before, skipped)).toBe(true);
  expect(history.undo(skipped)).toEqual(before);
  expect(history.redo(before)).toEqual(skipped);
  expect(history.canRedo).toBe(false);
});

test('a new edit clears redo, no-op edits do not add history, and reset prevents crossing saves', () => {
  const history = new ReviewHistory();
  const first = { frames: new Set(['a']), skipped: {} };
  const second = { frames: new Set(['a', 'b']), skipped: {} };
  expect(history.record(first, first)).toBe(false);
  history.record(first, second);
  history.undo(second);
  expect(history.canRedo).toBe(true);
  history.record(first, { frames: new Set(['c']), skipped: {} });
  expect(history.canRedo).toBe(false);
  history.clear();
  expect(history.canUndo).toBe(false);
});
