import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mxf', '.mkv', '.avi', '.m4v', '.webm']);

export type Aspect = 'horizontal' | 'square' | 'vertical' | '4x5' | 'unknown';
export type Channel = 'social' | 'tv' | 'other';
export type Voiceover = 'male' | 'female' | 'none';

export interface VideoCandidate {
  id: string;
  path: string;
  name: string;
  durationSec: number;
  aspect: Aspect;
  codec: string;
  format: string;
  variant: string;
  selected: boolean;
  width: number;
  height: number;
  channel: Channel;
  voiceover: Voiceover;
  declaredDurationSec: number | null;
  probeError?: string;
}

export interface VideoDiscovery {
  projectFolder: string | null;
  deliveryFolder: string | null;
  videos: VideoCandidate[];
  warnings: string[];
}

export interface DiscoverOptions {
  sourceRoot: string;
  projectCode: string;
  ffprobePath?: string;
}

export interface DiscoverProjectFolderOptions {
  projectFolder: string;
  ffprobePath?: string;
  /** Optional for no-code projects. A bracketed code in the folder name is inferred. */
  projectCode?: string;
}

export function normalizeProjectCode(code: string): string {
  const normalized = code.trim().replace(/^\[/, '').replace(/\]$/, '').toUpperCase();
  if (!/^[A-Z0-9]+$/.test(normalized)) throw new Error(`Invalid project code: ${code}`);
  return normalized;
}

function folderCode(folderName: string): string | null {
  return /^\[([A-Z0-9]+)\]/i.exec(folderName)?.[1].toUpperCase() ?? null;
}

async function directoryExists(folder: string): Promise<boolean> {
  try { return (await stat(folder)).isDirectory(); } catch { return false; }
}

async function childDirectory(parent: string, wanted: string): Promise<string | null> {
  let entries;
  try { entries = await readdir(parent, { withFileTypes: true }); }
  catch { return null; }
  const entry = entries.find(item => item.isDirectory() && item.name.toLowerCase() === wanted.toLowerCase());
  return entry ? path.join(parent, entry.name) : null;
}

/** Match the bracketed project code, never a substring of a client name. */
export async function findProjectFolder(sourceRoot: string, projectCode: string): Promise<string | null> {
  const code = normalizeProjectCode(projectCode);
  const root = path.resolve(sourceRoot);
  if (!await directoryExists(root)) return null;
  if (folderCode(path.basename(root)) === code) return root;
  const active = await childDirectory(root, '01_ActiveProjects');
  if (!active) return null;
  const matches: string[] = [];
  const inspect = async (folder: string): Promise<void> => {
    const entries = await readdir(folder, { withFileTypes: true });
    for (const item of entries) {
      if (item.isDirectory() && folderCode(item.name) === code) matches.push(path.join(folder, item.name));
    }
  };
  await inspect(active);
  // Some active-project roots divide projects by year.
  const entries = await readdir(active, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && /^20\d\d$/.test(entry.name)) await inspect(path.join(active, entry.name));
  }
  if (matches.length > 1) throw new Error(`Multiple folders match [${code}]: ${matches.join(', ')}`);
  return matches[0] ?? null;
}

async function findDeliveryFolder(projectFolder: string): Promise<string | null> {
  const finalDelivery = await childDirectory(projectFolder, '11_FINAL_DELIVERY');
  if (!finalDelivery) return null;
  return childDirectory(finalDelivery, '01_VIDEOS');
}

async function listVideoFiles(folder: string): Promise<string[]> {
  const result: string[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) result.push(full);
    }
  };
  await walk(folder);
  return result;
}

function namedDuration(name: string): number | null {
  const stem = path.parse(name).name;
  if (/(?:^|[_\s-])long[_\s-]?form(?:$|[_\s-])/i.test(stem)) return 3600;
  const match = /(?:^|[_\s-])(?:0?6|15|30|45|60|90|120)(?=[A-Z]?(?:$|[_\s-]))/i.exec(stem);
  return match ? Number(match[0].replace(/\D/g, '')) : null;
}

function parseVariant(name: string, projectFolder: string): string {
  const stem = path.parse(name).name;
  const netVariant = /(?:^|[_\s-])(?:0?6|15|30|45|60|90)([A-Z])(?=$|[_\s-])/i.exec(stem);
  if (netVariant) return netVariant[1].toUpperCase();
  const length = /(?:^|[_\s-])(?:0?6|15|30|45|60|90|120|long[_\s-]?form)(?=$|[_\s-])/i.exec(stem);
  let prefix = length ? stem.slice(0, length.index).replace(/[_\s-]+$/, '') : stem;
  const project = path.basename(projectFolder).replace(/^\[[^\]]+\]/, '').replace(/^[_\s-]+/, '');
  if (prefix.toLowerCase().startsWith(project.toLowerCase())) {
    prefix = prefix.slice(project.length).replace(/^[_\s-]+/, '');
  }
  return prefix || 'Main';
}

function classifyAspect(width: number, height: number, name: string): Aspect {
  if (width > 0 && height > 0) {
    const ratio = width / height;
    if (Math.abs(ratio - 1) <= 0.08) return 'square';
    if (Math.abs(ratio - 0.8) <= 0.08) return '4x5';
    if (ratio < 0.9) return 'vertical';
    return 'horizontal';
  }
  if (/4[x×_-]?5|four.?by.?five/i.test(name)) return '4x5';
  if (/square|1[x:_-]?1/i.test(name)) return 'square';
  if (/vertical|9[x:_-]?16/i.test(name)) return 'vertical';
  if (/horizontal|landscape|16[x:_-]?9/i.test(name)) return 'horizontal';
  return 'unknown';
}

function classifyChannel(relativePath: string): Channel {
  if (/(?:^|[/\\_\s-])social(?:$|[/\\_\s-])/i.test(relativePath)) return 'social';
  if (/(?:^|[/\\_\s-])tv(?:$|[/\\_\s-])/i.test(relativePath)) return 'tv';
  return 'other';
}

function classifyVoiceover(relativePath: string): Voiceover {
  if (/female\s*vo|femalevo/i.test(relativePath)) return 'female';
  if (/male\s*vo|malevo/i.test(relativePath)) return 'male';
  return 'none';
}

interface ProbeJson {
  streams?: Array<{ codec_name?: string; width?: number; height?: number; duration?: string; side_data_list?: Array<{rotation?: number}> }>;
  format?: { duration?: string };
}

async function probeVideo(file: string, ffprobePath: string): Promise<{ durationSec: number; width: number; height: number; codec: string }> {
  const { stdout } = await execFileAsync(ffprobePath, [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=codec_name,width,height,duration:stream_side_data=rotation:format=duration', '-of', 'json', file,
  ], { maxBuffer: 1024 * 1024, timeout: 30_000 });
  const data = JSON.parse(stdout) as ProbeJson;
  const stream = data.streams?.[0];
  if (!stream) throw new Error('No video stream');
  let width = Number(stream.width) || 0;
  let height = Number(stream.height) || 0;
  const rotation = Math.abs(Number(stream.side_data_list?.find(item => item.rotation !== undefined)?.rotation ?? 0)) % 360;
  if (rotation === 90 || rotation === 270) [width, height] = [height, width];
  const durationSec = Number(data.format?.duration || stream.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0 || width <= 0 || height <= 0) {
    throw new Error('Incomplete video duration or dimensions');
  }
  return { durationSec, width, height, codec: stream.codec_name || 'unknown' };
}

function durationRank(video: VideoCandidate): number {
  // H.264 and ProRes encodes of the same cut can differ by a frame.
  const stated = video.declaredDurationSec;
  if (stated !== null && stated < 3600 && Math.abs(stated - video.durationSec) <= 2) return stated;
  return Math.round(video.durationSec);
}

function preference(video: VideoCandidate): [number, number, number, number, number, string] {
  return [durationRank(video), video.channel === 'social' ? 2 : video.channel === 'tv' ? 1 : 0,
    /^(h264|avc1)$/i.test(video.codec) ? 1 : 0, video.width * video.height,
    video.durationSec, video.path];
}

function comparePreference(a: VideoCandidate, b: VideoCandidate): number {
  const left = preference(a), right = preference(b);
  for (let i = 0; i < left.length - 1; i++) {
    const difference = (left[i] as number) - (right[i] as number);
    if (difference) return difference;
  }
  return String(right[5]).localeCompare(String(left[5]));
}

/** Return a fresh array; the UI can change any checkbox before analysis. */
export function selectVideoDefaults(videos: VideoCandidate[], projectCode?: string): VideoCandidate[] {
  const net32 = projectCode ? normalizeProjectCode(projectCode) === '1289' : false;
  const groups = new Map<string, VideoCandidate[]>();
  for (const video of videos) {
    if (video.probeError || video.aspect === 'unknown' || video.durationSec <= 0) continue;
    if (net32 && !['A', 'B'].includes(video.variant)) continue;
    const key = `${video.variant.toLowerCase()}|${video.aspect}`;
    groups.set(key, [...(groups.get(key) ?? []), video]);
  }
  const selected = new Set<string>();
  for (const alternatives of groups.values()) {
    // Prefer the delivery format named in the review rule before comparing
    // lengths. A longer TV master should not displace a Social H.264 cut.
    const socialH264 = alternatives.filter(video => video.channel === 'social' && /^(h264|avc1)$/i.test(video.codec));
    const social = alternatives.filter(video => video.channel === 'social');
    const h264 = alternatives.filter(video => /^(h264|avc1)$/i.test(video.codec));
    const pool = socialH264.length ? socialH264 : social.length ? social : h264.length ? h264 : alternatives;
    const maxDuration = Math.max(...pool.map(durationRank));
    let candidates = pool.filter(video => durationRank(video) === maxDuration);
    if (net32 && candidates.some(video => video.voiceover === 'male')) {
      candidates = candidates.filter(video => video.voiceover === 'male');
    }
    candidates.sort((a, b) => comparePreference(b, a));
    selected.add(candidates[0].id);
  }
  return videos.map(video => ({ ...video, selected: selected.has(video.id) }));
}

export async function discoverProjectVideos(options: DiscoverOptions): Promise<VideoDiscovery> {
  const code = normalizeProjectCode(options.projectCode);
  const projectFolder = await findProjectFolder(options.sourceRoot, code);
  if (!projectFolder) return { projectFolder: null, deliveryFolder: null, videos: [], warnings: [`Project folder [${code}] was not found.`] };
  return discoverProjectFolderVideos({ projectFolder, projectCode: code, ffprobePath: options.ffprobePath });
}

/** Inspect exactly the chosen folder, including projects whose names have no bracketed code. */
export async function discoverProjectFolderVideos(options: DiscoverProjectFolderOptions): Promise<VideoDiscovery> {
  const selected = path.resolve(options.projectFolder);
  if (!await directoryExists(selected)) {
    return { projectFolder: null, deliveryFolder: null, videos: [], warnings: [`Selected project folder was not found: ${selected}`] };
  }
  const projectFolder = await realpath(selected);
  const code = options.projectCode ? normalizeProjectCode(options.projectCode) : folderCode(path.basename(projectFolder));
  const deliveryFolder = await findDeliveryFolder(projectFolder);
  if (!deliveryFolder) return { projectFolder, deliveryFolder: null, videos: [], warnings: ['11_FINAL_DELIVERY/01_VIDEOS was not found.'] };
  const warnings: string[] = [];
  let paths = await listVideoFiles(deliveryFolder);
  if (code === '1289') {
    paths = paths.filter(file => path.relative(deliveryFolder, file).split(path.sep)[0].toLowerCase() === 'brand refresh');
  }
  if (!paths.length) warnings.push('No video files were found in the delivery folder.');
  const results = new Array<VideoCandidate>(paths.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, paths.length) }, async () => {
    while (cursor < paths.length) {
      const index = cursor++;
      const file = paths[index];
      const name = path.basename(file);
      const relativePath = path.relative(deliveryFolder, file);
      const id = createHash('sha256').update(file).digest('hex').slice(0, 20);
      const base: VideoCandidate = {
        id, path: file, name, durationSec: 0, aspect: 'unknown', codec: 'unknown',
        format: path.extname(file).slice(1).toLowerCase(), variant: parseVariant(name, projectFolder),
        selected: false, width: 0, height: 0, channel: classifyChannel(relativePath),
        voiceover: classifyVoiceover(relativePath), declaredDurationSec: namedDuration(name),
      };
      try {
        const probe = await probeVideo(file, options.ffprobePath ?? 'ffprobe');
        results[index] = { ...base, ...probe, aspect: classifyAspect(probe.width, probe.height, name) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results[index] = { ...base, aspect: classifyAspect(0, 0, name), probeError: message };
        warnings.push(`Could not inspect ${relativePath}: ${message}`);
      }
    }
  }));
  return { projectFolder, deliveryFolder, videos: selectVideoDefaults(results, code ?? undefined), warnings };
}
