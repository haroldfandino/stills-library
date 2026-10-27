import type { Video } from '../shared/contracts';

type VersionVideo = Pick<Video, 'id' | 'path' | 'name' | 'variant'>;

const TECHNICAL = /^(?:social|tv|broadcast|web|digital|online|h\.?26[45]|avc1?|hevc|prores(?:hq|lt|proxy|4444|422)?|hq|lt|proxy|4444|422|mp4|mov|mxf|avi|mkv|webm|png|jpe?g|square|vertical|horizontal|portrait|landscape|4x5|1x1|9x16|16x9|4x3|3x4|uhd|fhd|hd|sd|[248]k|\d{3,4}p|\d{3,5}x\d{3,5}|(?:0?6|15|30|45|60|90|120)(?:s|sec|secs|seconds)?|longform|videos?|exports?|delivery|finals?|masters?|versions?|codecs?|formats?|aspect|ratio|malevo|femalevo|novo)$/i;
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const identity = (value: string) => value.normalize('NFC').trim().replace(/[\s_-]+/g, '_').toLowerCase();

function tokens(value: string): string[] {
  return value.normalize('NFC')
    .replace(/^\[[^\]]+\][\s_-]*/, '')
    .replace(/\.(?:mp4|mov|mxf|avi|mkv|webm)$/i, '')
    .replace(/(?:^|[\s_-])long[\s_-]?form(?=$|[\s_-])/gi, '_longform_')
    .replace(/(?:^|[\s_-])(male|female|no)[\s_-]+vo(?=$|[\s_-])/gi, '_$1vo_')
    .replace(/(?:^|[\s_-])(16|9|4|3|1)[x×:_-](16|9|5|4|3|1)(?=$|[\s_-])/gi, '_$1x$2_')
    .replace(/(?:^|[\s_-])(?:0?6|15|30|45|60|90|120)(?:s|sec|secs|seconds)(?=$|[\s_-])/gi, '_')
    .replace(/(?:^|[\s_-])(?:0?6|15|30|45|60|90|120)([A-Z])(?=$|[\s_-])/g, '_$1_')
    .split(/[\s_-]+/).filter(token => token && !TECHNICAL.test(token));
}

function stripProjectPrefix(value: string[], project: string[]): string[] {
  let index = 0;
  while (index < value.length && index < project.length && identity(value[index]) === identity(project[index])) index++;
  return value.slice(index);
}

function checkedSourceLabel(label: string): string {
  if (!label || label === '.' || label === '..' || /[<>:"/\\|?*\u0000-\u001f]/.test(label)
      || /[. ]$/.test(label) || label.length > 200) {
    throw new Error(`Unsafe source version folder: ${JSON.stringify(label)}. Choose a safe version label before delivery.`);
  }
  return label;
}

/** Path splitting is deliberately platform-independent (Windows paths also run in Linux tests). */
function sourceVersion(file: string): { folder: string; label: string } | undefined {
  const pieces = file.split(/[\\/]+/);
  let delivery = -1;
  for (let index = 0; index + 1 < pieces.length; index++) {
    if (/^11[_ -]*final[_ -]*delivery$/i.test(pieces[index]) && /^0?1[_ -]*videos?$/i.test(pieces[index + 1])) delivery = index + 2;
  }
  if (delivery < 0) return undefined;
  for (let index = pieces.length - 2; index >= delivery; index--) {
    const match = /^(\d+)[ _.-]+(.+)$/.exec(pieces[index]);
    if (match && tokens(match[2]).length) return { folder: checkedSourceLabel(pieces[index]), label: match[2] };
  }
  return undefined;
}

function safeDerivedLabel(label: string): string {
  return label.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[\s_-]+/g, '_').replace(/^[._ ]+|[._ ]+$/g, '').slice(0, 100).replace(/[. ]+$/g, '') || 'Main';
}

/**
 * Assign delivery subfolders only when the chosen videos represent more than
 * one creative version. Numbered source folders are authoritative; encodes and
 * aspect ratios of one creative stay together. This never reads or writes disk.
 */
export function planVersionFolders(videos: Array<VersionVideo>, projectName: string): Map<string, string> {
  const seenIds = new Set<string>();
  const project = tokens(projectName);
  const candidates = videos.map(video => {
    if (seenIds.has(video.id)) throw new Error(`Duplicate video ID in version-folder plan: ${video.id}`);
    seenIds.add(video.id);
    const source = sourceVersion(video.path);
    const variant = video.variant && !/^(?:main|default|unknown)$/i.test(video.variant.trim())
      ? stripProjectPrefix(tokens(video.variant), project) : [];
    const filename = video.name || video.path.split(/[\\/]/).pop() || '';
    return { id: video.id, source, words: variant.length ? variant : stripProjectPrefix(tokens(filename), project) };
  });

  // A Sheet title can contain tags absent from filenames. Remove the remaining
  // common file prefix only when it leaves a meaningful label on every file.
  const flat = candidates.filter(candidate => !candidate.source);
  const distinct = new Set(flat.map(candidate => identity(candidate.words.join('_'))));
  let common = 0;
  if (distinct.size > 1) {
    while (flat.every(candidate => candidate.words.length > common + 1
      && identity(candidate.words[common]) === identity(flat[0].words[common]))) common++;
  }

  const groups = new Map<string, { ids: string[]; labels: Set<string>; sources: Set<string> }>();
  for (const candidate of candidates) {
    const label = (candidate.source?.label ?? candidate.words.slice(common).join('_')) || 'Main';
    const key = identity(label);
    const group = groups.get(key) ?? { ids: [], labels: new Set<string>(), sources: new Set<string>() };
    group.ids.push(candidate.id);
    group.labels.add(label);
    if (candidate.source) group.sources.add(candidate.source.folder);
    groups.set(key, group);
  }
  const assigned = new Map<string, string>();
  const usedNames = new Map<string, string>();
  const usedNumbers = new Set<number>();
  for (const [key, group] of groups) {
    if (!group.sources.size) continue;
    const labels = [...group.sources].sort(compare);
    if (new Set(labels.map(identity)).size > 1) {
      throw new Error(`Conflicting source version folders for ${[...group.labels].sort(compare)[0]}: ${labels.join(', ')}.`);
    }
    const label = labels[0];
    const existing = usedNames.get(identity(label));
    if (existing && existing !== key) throw new Error(`Version folder collision: ${label}`);
    assigned.set(key, label);
    usedNames.set(identity(label), key);
    usedNumbers.add(Number(/^\d+/.exec(label)?.[0]));
  }
  // Conflicting authoritative source labels must be caught even when their
  // creative names coincide, before deciding that delivery can stay flat.
  if (groups.size <= 1) return new Map();

  let nextNumber = 1;
  for (const [key, group] of [...groups].sort(([left], [right]) => compare(left, right))) {
    if (assigned.has(key)) continue;
    const base = safeDerivedLabel([...group.labels].sort(compare)[0]);
    let folder: string;
    do {
      while (usedNumbers.has(nextNumber)) nextNumber++;
      const number = nextNumber++;
      usedNumbers.add(number);
      folder = `${String(number).padStart(2, '0')}_${base}`;
    } while (usedNames.has(identity(folder)));
    assigned.set(key, folder);
    usedNames.set(identity(folder), key);
  }
  return new Map([...groups].flatMap(([key, group]) => group.ids.map(id => [id, assigned.get(key)!] as const)));
}

/** Aspect folders are project-wide and appear only for multiple delivered ratios. */
export function planDeliveryFolders(videos: Array<VersionVideo & Pick<Video, 'aspect'>>, projectName: string): Map<string, string> {
  const versions = planVersionFolders(videos, projectName);
  const aspects = new Set(videos.map(video => video.aspect));
  if (aspects.size <= 1) return versions;
  const labels: Record<string, string> = { horizontal: 'Horizontal', square: 'Square', vertical: 'Vertical', '4x5': '4x5' };
  return new Map(videos.map(video => {
    const aspect = labels[video.aspect ?? ''];
    if (!aspect) throw new Error('Cannot organize unknown aspect ratio. Probe the selected videos first.');
    const version = versions.get(video.id);
    return [video.id, version ? `${aspect}/${version}` : aspect];
  }));
}
