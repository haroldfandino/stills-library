import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
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
      else reject(new Error(`${spec.command} exited ${code}: ${stderr || stdout}`.slice(-4000)));
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
  videos: VideoCandidate[], stagingRoot: string, extractTool: CommandSpec,
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
    const analysisPath = assertWithin(analysisRoot, result.analysis);
    const analysis = JSON.parse(await readFile(analysisPath, 'utf8')) as AnalysisJson;
    if (path.resolve(analysis.source) !== path.resolve(video.path)) {
      throw new Error(`Analysis source differs from selected video: ${video.name}`);
    }
    const analysisDir = path.dirname(analysisPath);
    const selectedIds = new Set(analysis.selected_ids);
    const ids = new Set<number>();
    for (const candidate of analysis.candidates) {
      if (!Number.isSafeInteger(candidate.id) || candidate.id < 0 || ids.has(candidate.id)) {
        throw new Error(`Analysis has invalid candidate IDs for ${video.name}.`);
      }
      ids.add(candidate.id);
      const previewPath = assertWithin(analysisDir, path.resolve(analysisDir, candidate.preview));
      if (!(await stat(previewPath)).isFile()) throw new Error(`Candidate preview is missing: ${previewPath}`);
      frames.push({
        id: `${video.id}:${candidate.id}`, previewPath, selected: selectedIds.has(candidate.id),
        videoName: video.name, videoId: video.id, frameId: candidate.id,
        timecode: timecode(candidate.timestamp), shotId: candidate.shot_id ?? candidate.scene_id ?? 0,
        score: candidate.score ?? 0, reasons: candidate.reasons ?? [],
      });
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
    const result = await runJsonTool<ExportResult>(extractTool, [
      'export', analysis.analysisPath, '--frames', frameIds.join(','), '--output', exportsRoot,
      '--format', 'png', '--json',
    ]);
    assertWithin(exportsRoot, result.output_dir);
    if (result.files.length !== frameIds.length) throw new Error(`Export count mismatch for ${analysis.videoName}.`);
    const returned = new Set<number>();
    for (const file of result.files) {
      if (!frameIds.includes(file.frame_index) || returned.has(file.frame_index)) {
        throw new Error(`Extract Stills returned an unexpected frame for ${analysis.videoName}.`);
      }
      returned.add(file.frame_index);
      const sourcePath = assertWithin(exportsRoot, file.path);
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
