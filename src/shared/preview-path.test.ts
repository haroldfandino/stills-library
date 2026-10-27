import { expect, test } from 'vitest';
import path from 'node:path';
import { previewPath } from './preview-path';

test('rebases a saved preview into the current session folder', () => {
  const old = path.resolve('old/staging/session');
  const current = path.resolve('current/staging');
  expect(previewPath(path.join(old, 'analysis/previews/frame.jpg'), old, 'session', current))
    .toBe(path.join(current, 'session/analysis/previews/frame.jpg'));
});

test('does not map traversal or a mismatched session into allowed storage', () => {
  const old = path.resolve('old/staging/session');
  const outside = path.resolve('private.jpg');
  expect(previewPath(outside, old, 'session', 'current')).toBe(outside);
  const file = path.join(old, 'frame.jpg');
  expect(previewPath(file, old, '../session', 'current')).toBe(file);
  expect(previewPath(file, old, 'different', 'current')).toBe(file);
});
