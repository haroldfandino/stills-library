import type { VideoCandidate } from './media';

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
export function projectVideoName(projectName: string): string {
  return projectName.replace(/^\[[^\]]+\]/, '').replace(/^[_\s-]+/, '').split('_')[0].trim();
}

export function selectVideoDefaults(videos: VideoCandidate[], projectCode?: string, projectName?: string): VideoCandidate[] {
  const net32 = projectCode ? projectCode.trim().replace(/^\[/, '').replace(/\]$/, '').toUpperCase() === '1289' : false;
  const label = projectName ? projectVideoName(projectName) : '';
  const normalize = (value: string) => value.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  const matches = (video: VideoCandidate) => !label || normalize(video.name.replace(/\.[^.]+$/, '')).includes(normalize(label));
  const groups = new Map<string, VideoCandidate[]>();
  for (const video of videos) {
    if (!matches(video)) continue;
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
  return videos.map(video => ({ ...video, selected: selected.has(video.id),
    skipReason: matches(video) ? undefined : `Skipped: filename does not include ${label}.` }));
}

