import { expect, test } from 'vitest';
import { reviewCapacity } from './review-capacity';

test('bounds open reviews according to system memory', () => {
  expect(reviewCapacity(4 * 1024 ** 3)).toBe(1);
  expect(reviewCapacity(8 * 1024 ** 3)).toBe(2);
  expect(reviewCapacity(16 * 1024 ** 3)).toBe(3);
  expect(reviewCapacity(128 * 1024 ** 3)).toBe(3);
});
