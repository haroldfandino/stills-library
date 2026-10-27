import { expect, test } from 'vitest';
import { sessionView } from './view-state';
import type { Session } from '../shared/contracts';

test('summaries omit large review and delivery arrays; detail retains all candidate choices', () => {
  const session = { id: 'large', frames: Array.from({ length: 18588 }, (_, frameId) => ({ id: `v:${frameId}`, frameId })),
    videos: [{ id: 'v' }], selectedFrameIds: ['v:4'], selectedVideoIds: ['v'],
    analyses: [{ privateJournal: true }], exports: [{ sourcePath: 'export' }], uploadResults: [{ fileId: 'drive' }],
    revision: { id: 'revision', phase: 'staging', uploads: [{ videoId: 'v', frameId: 4, fileId: 'drive' }], exports: [{ sourcePath: 'old' }] } } as unknown as Session;
  const summary = sessionView(session, true);
  expect(summary.frames).toEqual([]);
  expect(summary.detailsOmitted).toBe(true);
  expect(JSON.stringify(summary).length).toBeLessThan(500);
  const detail = sessionView(session);
  expect(detail.frames).toHaveLength(18588);
  expect(detail.selectedFrameIds).toEqual(['v:4']);
  expect(detail.revision?.uploads).toEqual([{ videoId: 'v', frameId: 4 }]);
  expect(detail.analyses).toBeUndefined();
  expect(detail.exports).toBeUndefined();
  expect(detail.uploadResults).toBeUndefined();
  expect(session.uploadResults).toEqual([{ fileId: 'drive' }]);
});
