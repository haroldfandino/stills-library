import { expect, test } from 'vitest';
import { revisionSteps } from './revision-steps';

test('metadata work is bounded and every in-flight operation drains before failure returns', async () => {
  let active = 0, peak = 0, calls = 0;
  await expect(revisionSteps(Array.from({ length: 20 }, (_, i) => i), async item => {
    calls++; active++; peak = Math.max(peak, active);
    try {
      await new Promise(resolve => setTimeout(resolve, item === 1 ? 1 : 15));
      if (item === 1) throw new Error('Drive failure');
    } finally { active--; }
  })).rejects.toThrow('Drive failure');
  expect(peak).toBe(4);
  expect(active).toBe(0);
  expect(calls).toBe(4);
});
