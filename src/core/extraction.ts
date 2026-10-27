import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { VideoCandidate } from './media.js';

export interface CommandSpec {
  /** Frozen executable, or Python/node interpreter in development. */
  command: string;
  /** For example ["/path/to/cli_entry.py"] or ["/path/to/rename_stills.py"]. */
  args?: string[];
}

export interface FrameCandidate {
  id: string;
  previewPath: string;
  selected: boolean;
  videoName: string;
  frameId: number;
  videoId: string;
  timecode: string;
  shotId: number;
  score: number;
  reasons: string[];
  finalFrame?: boolean;
}

export interface AnalysisRecord {
  videoId: string;
  videoName: string;
  analysisPath: string;
  candidateFrameIds: number[];
  selectedFrameIds: number[];
  warnings: string[];
}

export interface AnalysisBundle {
  analyses: AnalysisRecord[];
  frames: FrameCandidate[];
}

export interface ExportedStill {
  videoId: string;
  videoName: string;
  frameId: number;
  sourcePath: string;
  shotId: number;
  timestampSec: number;
  score: number;
}

export interface RenameTags {
  projectName: string;
  projectType: string;
}

export interface RenameItem extends ExportedStill {
  targetName: string;
}

export interface RenamePlan {
  projectName: string;
  projectType: string;
  items: RenameItem[];
}

export interface RenamedStill extends RenameItem {
  renamedPath: string;
}

export interface RenameResult {
  stagingFolder: string;
  files: RenamedStill[];
}

interface ToolPayload<T> {
  status?: string;
  results?: T[];
  errors?: Array<{ source?: string; error: string }>;
}

interface AnalyzeResult {
  source: string;
  analysis_dir: string;
  analysis: string;
  selected_ids: number[];
  warnings?: string[];
}

interface AnalysisJson {
  source: string;
  analysis_dir: string;
  candidates: Array<{
    id: number;
    preview: string;
    timestamp: number;
    shot_id?: number;
    scene_id?: number;
    score?: number;
    reasons?: string[];
  }>;
  selected_ids: number[];
  video?: { frame_count: number; frames: Array<{ timestamp: number; pts?: number }> };
}

interface ExportResult {
  source: string;
  output_dir: string;
  files: Array<{
    frame_index: number;
    path: string;
    shot_id?: number;
    timestamp: number;
    score: number;
  }>;
}

function assertWithin(root: string, child: string): string {
  const absolute = path.resolve(child);
  const relative = path.relative(path.resolve(root), absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Tool returned a path outside staging: ${absolute}`);
  }
  return absolute;
}

async function stagedPath(root: string, child: string): Promise<string> {
  // Native tools can return canonical paths for a redirected Windows AppData
  // root or a junction. Compare actual locations rather than rejecting those
  // aliases first; a child junction that escapes the real root still fails.
  // Win32 removes trailing dots/spaces when native tools create directories,
  // but their JSON may retain the requested spelling. Resolve that spelling
  // before realpath; still check the canonical target for junction escapes.
  const nativeSpelling = (value: string) => process.platform === 'win32' && !value.startsWith('\\\\?\\')
    ? path.resolve(value).split(path.sep).map(part => part.replace(/[. ]+$/, '')).join(path.sep)
    : value;
  const resolveNative = async (value: string) => {
    try { return await realpath(value); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || nativeSpelling(value) === value) throw error;
      return realpath(nativeSpelling(value));
    }
  };
  const [actualRoot, actualChild] = await Promise.all([resolveNative(root), resolveNative(child)]);
  return assertWithin(actualRoot, actualChild);
}

async function sameSource(expected: string, actual: string): Promise<boolean> {
  const [left, right] = await Promise.all([realpath(expected), realpath(actual)]);
  // path.relative respects Windows drive/separator and case conventions.
  return path.relative(left, right) === '';
}

async function runCommand(spec: CommandSpec, args: string[], options: { cwd?: string; input?: string } = {}): Promise<string> {
  if (!spec.command) throw new Error('Tool command is not configured.');
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, [...(spec.args ?? []), ...args], {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const limit = 32 * 1024 * 1024;
    const append = (which: 'stdout' | 'stderr', data: Buffer) => {
      if (which === 'stdout') stdout += data.toString('utf8');
      else stderr += data.toString('utf8');
      if (stdout.length + stderr.length > limit) child.kill();
    };
    child.stdout.on('data', data => append('stdout', data));
    child.stderr.on('data', data => append('stderr', data));
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(stdout);
      else {
        let detail = '';
        // Native inference libraries emit harmless startup warnings on stderr.
        // Extract Stills reports the actionable failure in its JSON stdout.
        try {
          const payload = JSON.parse(stdout) as ToolPayload<unknown>;
          detail = payload.errors?.map(item => item.error).filter(Boolean).join('; ') ?? '';
        } catch { /* Non-JSON tools report their errors on stderr. */ }
        reject(new Error(`${spec.command} exited ${code}: ${detail || stderr || stdout}`.slice(-4000)));
      }
    });
    child.stdin.on('error', () => { /* A fast failing process may close stdin first. */ });
    child.stdin.end(options.input ?? '');
  });
}

async function runJsonTool<T>(spec: CommandSpec, args: string[]): Promise<T> {
  const stdout = await runCommand(spec, args);
  let payload: ToolPayload<T>;
  try { payload = JSON.parse(stdout) as ToolPayload<T>; }
  catch { throw new Error(`Tool did not return JSON: ${stdout.slice(0, 1000)}`); }
  if (payload.status !== 'success' || !payload.results?.length || payload.errors?.length) {
    throw new Error(payload.errors?.map(item => item.error).join('; ') || 'Tool returned no successful result.');
  }
  if (payload.results.length !== 1) throw new Error(`Expected one tool result, got ${payload.results.length}.`);
  return payload.results[0];
}

function timecode(seconds: number): string {
  const milliseconds = Math.round(Math.max(0, seconds) * 1000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds / 60_000) % 60;
  const wholeSeconds = Math.floor(milliseconds / 1000) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
}

/** Runs Smart analysis in staging and exposes every preview, including alternatives. */
export async function analyzeVideos(
  videos: VideoCandidate[], stagingRoot: string, extractTool: CommandSpec, ffmpegPath = 'ffmpeg',
): Promise<AnalysisBundle> {
  const selected = videos.filter(video => video.selected);
  if (!selected.length) throw new Error('Select at least one video before analysis.');
  const analysisRoot = path.resolve(stagingRoot, 'analysis');
  await mkdir(analysisRoot, { recursive: true });
  const analyses: AnalysisRecord[] = [];
  const frames: FrameCandidate[] = [];
  for (const video of selected) {
    if (video.probeError) throw new Error(`Cannot analyze ${video.name}: ${video.probeError}`);
    const result = await runJsonTool<AnalyzeResult>(extractTool, [
      'analyze', video.path, '--output', analysisRoot, '--format', 'png', '--json',
    ]);
    const analysisPath = await stagedPath(analysisRoot, result.analysis);
    // Native fingerprints include nanosecond timestamps larger than JavaScript's
    // exact integer range. Preserve their original JSON digits when adding the
    // final candidate, or an unchanged source can falsely fail export validation.
    const analysis = JSON.parse(await readFile(analysisPath, 'utf8'),
      (_key: string, value: unknown, context?: { source: string }) =>
        typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) && context
          ? (JSON as typeof JSON & { rawJSON(text: string): unknown }).rawJSON(context.source) : value) as AnalysisJson;
    if (!await sameSource(video.path, analysis.source) || !await sameSource(video.path, result.source)) {
      throw new Error(`Analysis source differs from selected video: ${video.name}`);
    }
    if (!Array.isArray(analysis.candidates) || !Array.isArray(analysis.selected_ids)) {
      throw new Error(`Analysis has invalid candidate data for ${video.name}.`);
    }
    const analysisDir = path.dirname(analysisPath);
    if (!analysis.video) throw new Error(`Analysis does not identify the final source frame for ${video.name}. Update Extract Stills before continuing.`);
    const finalIndex = analysis.video ? analysis.video.frame_count - 1 : undefined;
    if (finalIndex !== undefined) {
      const timing = analysis.video!.frames[finalIndex];
      if (!Number.isSafeInteger(finalIndex) || finalIndex < 0 || !timing || !Number.isFinite(timing.timestamp)) {
        throw new Error(`Cannot identify the final source frame for ${video.name}.`);
      }
      if (!analysis.candidates.some(frame => frame.id === finalIndex)) {
        const preview = `final-frame-${randomUUID()}.jpg`;
        await runCommand({ command: ffmpegPath }, ['-v', 'error', '-nostdin', '-n', '-i', video.path,
          '-map', '0:v:0', '-vf', `select=eq(n\\,${finalIndex}),scale=960:960:force_original_aspect_ratio=decrease`,
          '-frames:v', '1', '-fps_mode', 'vfr', '-q:v', '2', path.join(analysisDir, preview)]);
        analysis.candidates.push({ id: finalIndex, preview, timestamp: timing.timestamp,
          shot_id: Math.max(0, ...analysis.candidates.map(frame => frame.shot_id ?? frame.scene_id ?? 0)),
          score: 0, reasons: ['Final source frame included by default'] });
      }
      if (!analysis.selected_ids.includes(finalIndex)) analysis.selected_ids.push(finalIndex);
      analysis.candidates.sort((a, b) => a.id - b.id);
      await writeFile(analysisPath, JSON.stringify(analysis, null, 2));
    }
    const selectedIds = new Set(analysis.selected_ids);
    const ids = new Set<number>();
    for (const candidate of analysis.candidates) {
      if (!Number.isSafeInteger(candidate.id) || candidate.id < 0 || ids.has(candidate.id)) {
        throw new Error(`Analysis has invalid candidate IDs for ${video.name}.`);
      }
      if (!Number.isFinite(candidate.timestamp) || candidate.timestamp < 0) {
        throw new Error(`Analysis has an invalid frame timestamp for ${video.name}.`);
      }
      ids.add(candidate.id);
      const previewPath = await stagedPath(analysisDir, path.resolve(analysisDir, candidate.preview));
      if (!(await stat(previewPath)).isFile()) throw new Error(`Candidate preview is missing: ${previewPath}`);
      frames.push({
        id: `${video.id}:${candidate.id}`, previewPath, selected: selectedIds.has(candidate.id),
        finalFrame: candidate.id === finalIndex,
        videoName: video.name, videoId: video.id, frameId: candidate.id,
        timecode: timecode(candidate.timestamp), shotId: candidate.shot_id ?? candidate.scene_id ?? 0,
        score: candidate.score ?? 0, reasons: candidate.reasons ?? [],
      });
    }
    if (selectedIds.size !== analysis.selected_ids.length || [...selectedIds].some(id => !ids.has(id))) {
      throw new Error(`Analysis selected unknown or duplicate frame IDs for ${video.name}.`);
    }
    analyses.push({ videoId: video.id, videoName: video.name, analysisPath,
      candidateFrameIds: [...ids], selectedFrameIds: [...selectedIds], warnings: result.warnings ?? [] });
  }
  return { analyses, frames };
}

/** Export only approved source-frame IDs; Extract Stills verifies source fingerprints. */
export async function exportApprovedFrames(
  analyses: AnalysisRecord[], approvedFrameIds: string[], stagingRoot: string, extractTool: CommandSpec,
): Promise<ExportedStill[]> {
  if (!approvedFrameIds.length) throw new Error('Select at least one still before export.');
  const exportsRoot = path.resolve(stagingRoot, 'exports');
  await mkdir(exportsRoot, { recursive: true });
  const requested = new Set(approvedFrameIds);
  if (requested.size !== approvedFrameIds.length) throw new Error('Duplicate still IDs were selected.');
  const valid = new Set(analyses.flatMap(analysis => analysis.candidateFrameIds.map(id => `${analysis.videoId}:${id}`)));
  for (const id of requested) if (!valid.has(id)) throw new Error(`Unknown still ID: ${id}`);
  const exported: ExportedStill[] = [];
  for (const analysis of analyses) {
    const frameIds = analysis.candidateFrameIds.filter(id => requested.has(`${analysis.videoId}:${id}`));
    if (!frameIds.length) continue;
    const analysisPath = await stagedPath(path.resolve(stagingRoot, 'analysis'), analysis.analysisPath);
    const stored = JSON.parse(await readFile(analysisPath, 'utf8')) as AnalysisJson;
    const result = await runJsonTool<ExportResult>(extractTool, [
      'export', analysisPath, '--frames', frameIds.join(','), '--output', exportsRoot,
      '--format', 'png', '--json',
    ]);
    if (!await sameSource(stored.source, result.source)) {
      throw new Error(`Export source differs from approved video: ${analysis.videoName}`);
    }
    const outputDir = await stagedPath(exportsRoot, result.output_dir);
    if (result.files.length !== frameIds.length) throw new Error(`Export count mismatch for ${analysis.videoName}.`);
    const returned = new Set<number>();
    for (const file of result.files) {
      if (!frameIds.includes(file.frame_index) || returned.has(file.frame_index)) {
        throw new Error(`Extract Stills returned an unexpected frame for ${analysis.videoName}.`);
      }
      returned.add(file.frame_index);
      const sourcePath = await stagedPath(outputDir, file.path);
      if (path.extname(sourcePath).toLowerCase() !== '.png' || !(await stat(sourcePath)).isFile()) {
        throw new Error(`Expected exported PNG is missing: ${sourcePath}`);
      }
      exported.push({ videoId: analysis.videoId, videoName: analysis.videoName,
        frameId: file.frame_index, sourcePath, shotId: file.shot_id ?? 0,
        timestampSec: file.timestamp, score: file.score });
    }
  }
  return exported;
}

function safeTag(raw: string, label: string): string {
  const value = raw.trim().replace(/\s+/g, '_');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    throw new Error(`${label} must contain letters, numbers, underscores or hyphens.`);
  }
  return value;
}

/** Preview exact Rename Stills names, including case-insensitive Drive collisions. */
export function planRenames(files: ExportedStill[], tags: RenameTags, existingNames: string[] = []): RenamePlan {
  if (!files.length) throw new Error('No approved PNG files to rename.');
  const projectName = safeTag(tags.projectName, 'Project name');
  const projectType = safeTag(tags.projectType, 'Project type');
  const sourcePaths = new Set(files.map(file => path.resolve(file.sourcePath)));
  if (sourcePaths.size !== files.length) throw new Error('The same exported PNG was selected twice.');
  const occupied = new Set(existingNames.map(name => name.toLowerCase()));
  const items = files.map((file, index) => ({ ...file,
    targetName: `${projectName}_${projectType}_Still_${String(index + 1).padStart(2, '0')}.png`,
  }));
  const collisions = items.filter(item => occupied.has(item.targetName.toLowerCase()));
  if (collisions.length) throw new Error(`Destination already contains: ${collisions.map(item => item.targetName).join(', ')}`);
  return { projectName, projectType, items };
}

/** Copy to an empty, unique staging folder before invoking the original rename script. */
export async function stageAndRenameApprovedStills(
  plan: RenamePlan, stagingRoot: string, renameTool: CommandSpec,
): Promise<RenameResult> {
  if (!plan.items.length) throw new Error('Rename plan has no files.');
  const verified = planRenames(plan.items, {
    projectName: plan.projectName, projectType: plan.projectType,
  });
  if (verified.items.some((item, index) => item.targetName !== plan.items[index].targetName)) {
    throw new Error('Rename plan changed after review. Preview the names again.');
  }
  const renamesRoot = path.resolve(stagingRoot, 'renamed');
  await mkdir(renamesRoot, { recursive: true });
  const stagingFolder = path.join(renamesRoot, `run_${randomUUID()}`);
  await mkdir(stagingFolder);
  for (let index = 0; index < plan.items.length; index++) {
    const item = plan.items[index];
    if (path.extname(item.sourcePath).toLowerCase() !== '.png' || !(await stat(item.sourcePath)).isFile()) {
      throw new Error(`Cannot rename a missing or non-PNG export: ${item.sourcePath}`);
    }
    const inputName = `input_${String(index + 1).padStart(6, '0')}.png`;
    if (plan.items.some(other => other.targetName.toLowerCase() === inputName.toLowerCase())) {
      throw new Error(`Rename target would overwrite a staging input: ${inputName}`);
    }
    await copyFile(item.sourcePath, path.join(stagingFolder, inputName), constants.COPYFILE_EXCL);
  }
  const before = await readdir(stagingFolder);
  if (before.length !== plan.items.length) throw new Error('Rename staging contains unexpected files.');
  await runCommand(renameTool, [], { cwd: stagingFolder, input: `${plan.projectName}\n${plan.projectType}\n` });
  const after = await readdir(stagingFolder);
  const expected = new Set(plan.items.map(item => item.targetName));
  if (after.length !== expected.size || after.some(name => !expected.has(name))) {
    throw new Error('Rename Stills did not produce the reviewed filenames.');
  }
  return { stagingFolder, files: plan.items.map(item => ({ ...item,
    renamedPath: path.join(stagingFolder, item.targetName) })) };
}
