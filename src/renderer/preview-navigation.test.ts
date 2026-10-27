import { expect, test } from 'vitest';
import { previewNavigation } from './preview-navigation';
import type { Frame } from './bridge';

const frames: Frame[] = [
  { id: 'a:1', videoId: 'a', shotId: 0, timestampSec: 1 },
  { id: 'a:2', videoId: 'a', shotId: 0, timestampSec: 2 },
  { id: 'a:3', videoId: 'a', shotId: 1, timestampSec: 3 },
  { id: 'b:1', videoId: 'b', shotId: 0, timestampSec: 1 },
];
test('selected navigation skips unselected alternatives and anchors an unselected preview', () => {
  const selected = new Set(['a:1', 'a:3']);
  expect(previewNavigation(frames, frames[0], selected, 'selected').next).toBe(frames[2]);
  expect(previewNavigation(frames, frames[1], selected, 'selected')).toMatchObject({ index: -1, previous: frames[0], next: frames[2] });
});
test('shot navigation includes unselected alternatives and stays within video and shot, including shot zero', () => {
  expect(previewNavigation(frames, frames[0], new Set(['a:1']), 'shot')).toMatchObject({ count: 2, index: 0, next: frames[1] });
  expect(previewNavigation(frames, frames[1], new Set(), 'shot').next).toBeUndefined();
});
test('missing shot metadata never groups unrelated candidates', () => {
  const missing = frames.map(({ shotId, ...frame }) => frame);
  expect(previewNavigation(missing, missing[0], new Set(), 'shot').count).toBe(1);
});
