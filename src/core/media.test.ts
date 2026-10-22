import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverProjectFolderVideos, findProjectFolder, selectVideoDefaults, type VideoCandidate } from './media.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });

function video(name: string, overrides: Partial<VideoCandidate> = {}): VideoCandidate {
  return {
    id: name, path: `/delivery/${name}`, name, durationSec: 30, aspect: 'horizontal',
    codec: 'h264', format: 'mp4', variant: 'Main', selected: false, width: 3840, height: 2160,
    channel: 'social', voiceover: 'none', declaredDurationSec: 30, ...overrides,
  };
}

describe('project lookup', () => {
  it('matches the bracketed code exactly, including year subfolders', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stills-project-'));
    temporary.push(root);
    await mkdir(path.join(root, '01_ActiveProjects', '2026', '[203SB]Airwaav_Brager'), { recursive: true });
    await mkdir(path.join(root, '01_ActiveProjects', '[203SBA]Another'), { recursive: true });
    expect(await findProjectFolder(root, '[203SB]')).toBe(path.join(root, '01_ActiveProjects', '2026', '[203SB]Airwaav_Brager'));
    expect(await findProjectFolder(root, '203S')).toBeNull();
  });

  it('discovers videos only in a manually chosen no-code project folder', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stills-no-code-'));
    temporary.push(root);
    const chosen = path.join(root, 'Fatty15 Ricky Lake');
    const delivery = path.join(chosen, '11_FINAL_DELIVERY', '01_Videos', 'Social');
    const sibling = path.join(root, 'Another Project', '11_FINAL_DELIVERY', '01_Videos');
    await mkdir(delivery, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await writeFile(path.join(delivery, 'RickyLake_30_Social_H264.mp4'), 'fixture');
    await writeFile(path.join(sibling, 'must-not-appear.mp4'), 'fixture');
    const found = await discoverProjectFolderVideos({ projectFolder: chosen, ffprobePath: path.join(root, 'no-ffprobe') });
    expect(found.projectFolder).toBe(await realpath(chosen));
    expect(found.videos.map(item => item.name)).toEqual(['RickyLake_30_Social_H264.mp4']);
    expect(found.videos[0].channel).toBe('social');
    expect(found.videos[0].probeError).toBeTruthy();
  });
});

describe('video defaults', () => {
  it('selects the longest Social H.264 creative per aspect, then resolution', () => {
    const candidates = [
      video('short', { durationSec: 15, declaredDurationSec: 15 }),
      video('tv', { channel: 'tv' }),
      video('prores', { codec: 'prores', format: 'mov' }),
      video('social-h264-hd', { width: 1920, height: 1080 }),
      video('social-h264-4k'),
      video('offer', { variant: 'Offer' }),
      video('square', { aspect: 'square', width: 1080, height: 1080 }),
      video('4x5', { aspect: '4x5', width: 1080, height: 1350 }),
      video('vertical', { aspect: 'vertical', width: 1080, height: 1920 }),
    ];
    const selected = selectVideoDefaults(candidates, '203SB').filter(item => item.selected).map(item => item.id);
    expect(selected).toEqual(['social-h264-4k', 'offer', 'square', '4x5', 'vertical']);
  });

  it('keeps a Social H.264 cut ahead of a longer TV or non-H.264 master', () => {
    const candidates = [
      video('social-h264-15', { durationSec: 15, declaredDurationSec: 15 }),
      video('social-prores-30', { durationSec: 30, declaredDurationSec: 30, codec: 'prores' }),
      video('tv-h264-60', { durationSec: 60, declaredDurationSec: 60, channel: 'tv' }),
    ];
    expect(selectVideoDefaults(candidates, '203SB').filter(item => item.selected).map(item => item.id))
      .toEqual(['social-h264-15']);
  });

  it('selects only Net32 A/B, one VO per creative and aspect', () => {
    const candidates = [
      video('A-male', { variant: 'A', voiceover: 'male' }),
      video('A-female', { variant: 'A', voiceover: 'female' }),
      video('B-male', { variant: 'B', voiceover: 'male' }),
      video('B-female', { variant: 'B', voiceover: 'female' }),
      video('C-male', { variant: 'C', voiceover: 'male' }),
      video('A-square', { variant: 'A', aspect: 'square', voiceover: 'female' }),
    ];
    expect(selectVideoDefaults(candidates, '1289').filter(item => item.selected).map(item => item.id))
      .toEqual(['A-male', 'B-male', 'A-square']);
  });
});
