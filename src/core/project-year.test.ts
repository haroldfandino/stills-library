import { expect, test } from 'vitest';
import { suggestProjectYear } from './project-year';
import type { Video } from '../shared/contracts';
const video = (values: Partial<Video>): Video => ({ id: 'v', path: '/video.mp4', name: 'video.mp4', selected: true, ...values });
test('embedded creation date takes precedence over copied file dates and project name', () => {
  expect(suggestProjectYear([video({ createdAt: '2024-12-31T12:00:00Z', fileCreatedAt: '2026-10-22T12:00:00Z' })], 'Project 2026').year).toBe('2024');
});
test('only selected videos determine the year; file dates are fallback', () => {
  expect(suggestProjectYear([video({ createdAt: '2023-01-01', selected: false }), video({ fileCreatedAt: '2025-01-01' })], 'Project').year).toBe('2025');
});
test('invalid dates do not override a usable modification date', () => {
  expect(suggestProjectYear([video({ createdAt: '1904-01-01', fileCreatedAt: 'nonsense', fileModifiedAt: '2022-04-01' })], 'Project').year).toBe('2022');
});
test('a clear year in the name is used when no dates are available', () => {
  expect(suggestProjectYear([video({ name: 'Brand_2021.mp4' })], 'Project').year).toBe('2021');
});
