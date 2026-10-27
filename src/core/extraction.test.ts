import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyzeVideos, exportApprovedFrames, planRenames, stageAndRenameApprovedStills, type ExportedStill } from './extraction.js';
import type { VideoCandidate } from './media.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });

async function extractionFixture(config: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'stills native café '));
  temporary.push(root);
  const source = path.join(root, 'Delivery video.mp4');
  await writeFile(source, 'source video');
  const outside = path.join(root, 'outside-staging');
  await mkdir(outside);
  await writeFile(path.join(outside, 'preview.png'), 'outside preview');
  const staging = path.join(root, 'staging');
  const script = path.join(root, 'extract-fixture.cjs');
  const configPath = path.join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({ outside, ...config }));
  await writeFile(script, `
    const fs = require('node:fs');
    const path = require('node:path');
    const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const args = process.argv.slice(3);
    const requestedOutput = args[args.indexOf('--output') + 1];
    const output = config.canonicalOutput ? fs.realpathSync(requestedOutput) : requestedOutput;
    const directory = path.join(output, 'run');
    fs.mkdirSync(directory, { recursive: true });
    let result;
    if (args[0] === 'analyze') {
      const source = config.uppercaseSource ? args[1].toUpperCase() : args[1];
      let preview = 'preview.png';
      if (config.escapePreview) {
        fs.symlinkSync(config.outside, path.join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
        preview = 'linked/preview.png';
      } else fs.writeFileSync(path.join(directory, preview), 'preview');
      const analysis = { source, analysis_dir: directory, selected_ids: config.selectedIds || [7],
        source_fingerprint: {size:12,mtime_ns:1792099722827642100,sha256:'fixture'},
        video: { frame_count: 8, frames: Array.from({length:8}, (_, i) => ({timestamp:i / 7})) },
        candidates: [{ id: 7, preview, timestamp: 1, score: 0.9 }] };
      const analysisPath = path.join(directory, 'analysis.json');
      fs.writeFileSync(analysisPath, JSON.stringify(analysis).replace(/"mtime_ns":\\d+/, '"mtime_ns":1792099722827642100'));
      result = { source, analysis: analysisPath, analysis_dir: directory, selected_ids: analysis.selected_ids };
    } else {
      const analysis = JSON.parse(fs.readFileSync(args[1], 'utf8'));
      const file = path.join(directory, 'approved.png');
      fs.writeFileSync(file, 'approved PNG');
      result = { source: config.exportSource || analysis.source, output_dir: directory,
        files: [{ frame_index: 7, path: file, timestamp: 1, score: 0.9 }] };
    }
    if (config.trailingPeriod) {
      const reported = path.join(output, 'run.');
      for (const key of ['analysis', 'analysis_dir', 'output_dir']) {
        if (result[key]) result[key] = result[key].replace(directory, reported);
      }
      if (result.files) result.files.forEach(file => file.path = file.path.replace(directory, reported));
    }
    process.stdout.write(JSON.stringify({ status: 'success', results: [result] }));
  `);
  const video: VideoCandidate = { id: 'v', path: source, name: path.basename(source), durationSec: 30,
    aspect: 'horizontal', codec: 'h264', format: 'mp4', variant: 'Main', selected: true,
    width: 1920, height: 1080, channel: 'social', voiceover: 'none', declaredDurationSec: 30 };
  return { root, source, staging, video, configPath, tool: { command: process.execPath, args: [script, configPath] } };
}

describe('native extraction protocol', () => {
  it('shows structured extraction failures instead of harmless inference warnings', async () => {
    const fixture = await extractionFixture();
    const script = 'process.stderr.write("Inference startup warning");process.stdout.write(JSON.stringify({status:"error",errors:[{error:"Unable to decode selected video"}]}));process.exitCode=1;';
    await expect(analyzeVideos([fixture.video], fixture.staging, { command: process.execPath, args: ['-e', script, '--'] }))
      .rejects.toThrow(/Unable to decode selected video/);
  });

  it('analyzes and exports approved frames with spaces and non-ASCII paths', async () => {
    const fixture = await extractionFixture();
    const analyzed = await analyzeVideos([fixture.video], fixture.staging, fixture.tool);
    expect(analyzed.frames.map(frame => frame.id)).toEqual(['v:7']);
    expect(await readFile(analyzed.analyses[0].analysisPath, 'utf8')).toMatch(/"mtime_ns":\s*1792099722827642100/);
    const exported = await exportApprovedFrames(analyzed.analyses, ['v:7'], fixture.staging, fixture.tool);
    expect(exported).toHaveLength(1);
    expect(await readFile(exported[0].sourcePath, 'utf8')).toBe('approved PNG');
    expect(await readFile(fixture.source, 'utf8')).toBe('source video');
  });

  it.skipIf(process.platform !== 'win32')('accepts Windows source paths with different casing', async () => {
    const fixture = await extractionFixture({ uppercaseSource: true });
    const analyzed = await analyzeVideos([fixture.video], fixture.staging, fixture.tool);
    expect(analyzed.frames).toHaveLength(1);
  });

  it.skipIf(process.platform !== 'win32')('canonicalizes native trailing-period directories during analysis and export', async () => {
    const fixture = await extractionFixture({ trailingPeriod: true });
    const analyzed = await analyzeVideos([fixture.video], fixture.staging, fixture.tool);
    expect(await readFile(analyzed.frames[0].previewPath, 'utf8')).toBe('preview');
    const exported = await exportApprovedFrames(analyzed.analyses, ['v:7'], fixture.staging, fixture.tool);
    expect(await readFile(exported[0].sourcePath, 'utf8')).toBe('approved PNG');
  });

  it.skipIf(process.platform !== 'win32')('still rejects junction escapes under trailing-period directories', async () => {
    const fixture = await extractionFixture({ trailingPeriod: true, escapePreview: true });
    await expect(analyzeVideos([fixture.video], fixture.staging, fixture.tool)).rejects.toThrow(/outside staging/);
  });

  it('accepts canonical native outputs when the configured staging root is a junction or symlink', async () => {
    const fixture = await extractionFixture({ canonicalOutput: true });
    const actualStaging = path.join(fixture.root, 'redirected-appdata', 'staging');
    await mkdir(actualStaging, { recursive: true });
    await symlink(actualStaging, fixture.staging, process.platform === 'win32' ? 'junction' : 'dir');
    const analyzed = await analyzeVideos([fixture.video], fixture.staging, fixture.tool);
    expect(analyzed.analyses[0].analysisPath).toBe(await realpath(path.join(actualStaging, 'analysis', 'run', 'analysis.json')));
    expect(await readFile(analyzed.frames[0].previewPath, 'utf8')).toBe('preview');
    const exported = await exportApprovedFrames(analyzed.analyses, ['v:7'], fixture.staging, fixture.tool);
    expect(exported[0].sourcePath).toBe(await realpath(path.join(actualStaging, 'exports', 'run', 'approved.png')));
    expect(await readFile(exported[0].sourcePath, 'utf8')).toBe('approved PNG');
  });

  it('rejects a preview redirected outside staging by a Windows junction or symlink', async () => {
    const fixture = await extractionFixture({ escapePreview: true });
    await expect(analyzeVideos([fixture.video], fixture.staging, fixture.tool)).rejects.toThrow(/outside staging/);
  });

  it('rejects unknown selected frame IDs before presenting review', async () => {
    const fixture = await extractionFixture({ selectedIds: [999] });
    await expect(analyzeVideos([fixture.video], fixture.staging, fixture.tool)).rejects.toThrow(/unknown or duplicate frame IDs/);
  });

  it('rejects exported frames associated with another source video', async () => {
    const fixture = await extractionFixture();
    const analyzed = await analyzeVideos([fixture.video], fixture.staging, fixture.tool);
    const otherVideo = path.join(fixture.root, 'different.mp4');
    await writeFile(otherVideo, 'another source');
    await writeFile(fixture.configPath, JSON.stringify({ exportSource: otherVideo }));
    await expect(exportApprovedFrames(analyzed.analyses, ['v:7'], fixture.staging, fixture.tool))
      .rejects.toThrow(/Export source differs from approved video/);
  });
});

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
