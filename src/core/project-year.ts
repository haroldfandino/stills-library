import type { Video } from '../shared/contracts';

export function validVideoYear(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  const year = date.getUTCFullYear();
  return Number.isFinite(date.getTime()) && year >= 2000 && year <= new Date().getUTCFullYear()
    ? String(year) : undefined;
}

/** Prefer dates embedded by the video producer over a copied file's birth date. */
export function suggestProjectYear(videos: Video[], projectName: string): { year: string; reason: string } {
  const chosen = videos.filter(video => video.selected);
  const pool = chosen.length ? chosen : videos;
  for (const [field, label] of [['createdAt', 'video creation metadata'], ['fileCreatedAt', 'file creation date'], ['fileModifiedAt', 'file modification date']] as const) {
    const years = pool.flatMap(video => {
      const year = validVideoYear(video[field]);
      return year ? [{ year, name: video.name }] : [];
    });
    if (years.length) {
      const counts = new Map<string, number>();
      for (const item of years) counts.set(item.year, (counts.get(item.year) ?? 0) + 1);
      const year = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
      return { year, reason: `${label}: ${years.find(item => item.year === year)!.name}` };
    }
  }
  const named = [...new Set([...pool.map(video => video.name), projectName].flatMap(name => name.match(/(?<!\d)20\d{2}(?!\d)/g) ?? []))];
  if (named.length === 1) return { year: named[0], reason: 'Year in the video or project name' };
  return { year: String(new Date().getUTCFullYear()), reason: 'Current year; source creation dates unavailable' };
}
