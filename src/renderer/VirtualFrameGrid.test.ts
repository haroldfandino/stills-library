import { expect, test } from 'vitest';
import { gridWindow } from './VirtualFrameGrid';

test('large reviews mount only a small window and can reach their final candidate', () => {
  const count = 18588;
  const initial = gridWindow(count, 1100, 660, 0);
  expect(initial.end - initial.start).toBeLessThan(50);
  const bottom = gridWindow(count, 1100, 660, initial.height - 660);
  expect(bottom.end).toBeGreaterThanOrEqual(count);
  expect(bottom.end - bottom.start).toBeLessThan(50);
  expect(bottom.offset).toBeLessThan(initial.height);
});
