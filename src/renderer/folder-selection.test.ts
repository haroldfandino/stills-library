import { expect, it } from 'vitest';
import { folderContains, folderIsChosen, folderSelectionIds, reviewFolders, toggleFolderChoice } from './folder-selection';
import { ReviewHistory } from './review-history';

const frames = [
  { id: 'wide-a:1', folder: 'Horizontal/01_Offer' },
  { id: 'wide-b:1', folder: 'Horizontal/01_Offer' },
  { id: 'wide-b:2', folder: 'Horizontal/02_Main' },
  { id: 'tall:1', folder: 'Vertical/01_Offer' },
  { id: 'sibling:1', folder: 'HorizontalExtra/01_Offer' },
];
const approved = new Set(['wide-a:1', 'wide-b:1', 'tall:1', 'sibling:1']);

it('groups shared video folders and counts parent folders using actual reviewed selections', () => {
  const groups = reviewFolders(frames, approved);
  expect(groups.find(g => g.path === '')).toMatchObject({ approved: 4, total: 5 });
  expect(groups.find(g => g.path === 'Horizontal')).toMatchObject({ approved: 2, total: 3, depth: 1 });
  expect(groups.find(g => g.path === 'Horizontal/01_Offer')).toMatchObject({ approved: 2, total: 2, depth: 2 });
  expect(groups.find(g => g.path === 'Horizontal/02_Main')?.approved).toBe(0);
});

it('unselects an entire folder across videos, preserving other folders and unapproved frames', () => {
  const ids = folderSelectionIds(frames, approved, new Set(['Horizontal']));
  expect([...ids]).toEqual(['wide-a:1', 'wide-b:1']);
  expect([...approved].filter(id => !ids.has(id))).toEqual(['tall:1', 'sibling:1']);
  expect(folderContains('HorizontalExtra/01_Offer', 'Horizontal')).toBe(false);
});

it('deduplicates overlapping folder choices and supports multiple separate folders', () => {
  expect([...folderSelectionIds(frames, approved, new Set(['Horizontal', 'Horizontal/01_Offer', 'Vertical']))])
    .toEqual(['wide-a:1', 'wide-b:1', 'tall:1']);
});

it('covers nested choices and collapses them when their parent is selected', () => {
  const selected = toggleFolderChoice(new Set(['Horizontal/01_Offer', 'Vertical']), 'Horizontal');
  expect([...selected]).toEqual(['Vertical', 'Horizontal']);
  expect(folderIsChosen('Horizontal/01_Offer', selected)).toBe(true);
  expect([...toggleFolderChoice(selected, 'Horizontal')]).toEqual(['Vertical']);
});

it('handles project-root delivery and Windows separators without touching unknown selection IDs', () => {
  const flat = [{ id: 'one', folder: '' }, { id: 'two', folder: 'Vertical\\01_Offer' }];
  expect(reviewFolders(flat, new Set(['one', 'two']))[0].approved).toBe(2);
  expect([...folderSelectionIds(flat, new Set(['one', 'two', 'hidden']), new Set(['']))]).toEqual(['one', 'two']);
  expect(folderContains('Vertical\\01_Offer', 'Vertical')).toBe(true);
});

it('records a folder removal as one undoable change without changing skipped videos', () => {
  const history = new ReviewHistory();
  const before = { frames: approved, skipped: { skippedVideo: ['skipped:1'] } };
  const removed = folderSelectionIds(frames, approved, new Set(['Horizontal', 'Vertical']));
  const after = { frames: new Set([...approved].filter(id => !removed.has(id))), skipped: before.skipped };
  history.record(before, after);
  expect(history.undo(after)).toEqual(before);
  expect(history.redo(before)).toEqual(after);
  expect(approved.size).toBe(4);
});
