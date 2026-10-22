import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planRenames, stageAndRenameApprovedStills, type ExportedStill } from './extraction.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });

describe('rename staging', () => {
  it('rejects a case-insensitive destination collision before copies or renames', async () => {
    const source = path.join(tmpdir(), 'frame.png');
    const files: ExportedStill[] = [{ videoId: 'v', videoName: 'video', frameId: 7,
      sourcePath: source, shotId: 0, timestampSec: 1, score: 90 }];
    expect(() => planRenames(files, { projectName: 'Airwaav', projectType: 'Brager' },
      ['airwaav_brager_still_01.PNG'])).toThrow(/Destination already contains/);
  });

  it('runs the rename command on copies and preserves exported PNGs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stills-rename-'));
    temporary.push(root);
    const first = path.join(root, 'frame1.png');
    const second = path.join(root, 'frame2.png');
    await writeFile(first, Buffer.from('PNG one'));
    await writeFile(second, Buffer.from('PNG two'));
    const files: ExportedStill[] = [first, second].map((sourcePath, index) => ({
      videoId: 'video', videoName: 'video.mp4', frameId: index + 7, sourcePath,
      shotId: index, timestampSec: index, score: 80,
    }));
    const plan = planRenames(files, { projectName: 'Airwaav', projectType: 'Brager' });
    // A tiny stand-in receives the same prompts and directory layout as Rename Stills.
    const script = `let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{const fs=require('node:fs');const [p,t]=input.trim().split('\\n');fs.readdirSync('.').filter(x=>x.endsWith('.png')).sort().forEach((name,i)=>fs.renameSync(name,p+'_'+t+'_Still_'+String(i+1).padStart(2,'0')+'.png'))})`;
    const result = await stageAndRenameApprovedStills(plan, root, { command: process.execPath, args: ['-e', script] });
    expect(result.files.map(item => item.targetName)).toEqual([
      'Airwaav_Brager_Still_01.png', 'Airwaav_Brager_Still_02.png',
    ]);
    expect(await readFile(first, 'utf8')).toBe('PNG one');
    expect(await readFile(second, 'utf8')).toBe('PNG two');
    expect(await readFile(result.files[0].renamedPath, 'utf8')).toBe('PNG one');
    expect(await readFile(result.files[1].renamedPath, 'utf8')).toBe('PNG two');
  });
});
