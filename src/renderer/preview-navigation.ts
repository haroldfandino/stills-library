import type { Frame } from './bridge';

export type PreviewMode = 'selected' | 'shot';
export const previewFrameKey = (frame: Frame): string => frame.id.includes(':') ? frame.id : frame.videoId ? `${frame.videoId}:${frame.id}` : frame.id;

export function previewNavigation(frames: Frame[], current: Frame, selected: Set<string>, mode: PreviewMode) {
  const shot = current.shotId ?? current.shot;
  const candidates = frames.filter(frame => mode === 'selected' ? selected.has(previewFrameKey(frame))
    : frame.videoId === current.videoId && (shot === undefined ? previewFrameKey(frame) === previewFrameKey(current) : (frame.shotId ?? frame.shot) === shot));
  const order = new Map(frames.map((frame, index) => [previewFrameKey(frame), index]));
  // Native candidate order is chronological; timestamps make that explicit when present.
  const hasTimes = candidates.every(frame => frame.timestampSec !== undefined);
  const position = (frame: Frame) => hasTimes ? frame.timestampSec! : order.get(previewFrameKey(frame))!;
  if (mode === 'shot') candidates.sort((a, b) => position(a) - position(b));
  const index = candidates.findIndex(frame => previewFrameKey(frame) === previewFrameKey(current));
  const anchor = order.get(previewFrameKey(current)) ?? -1;
  return { count: candidates.length, index,
    previous: mode === 'shot' ? candidates[index - 1] : candidates.filter(frame => order.get(previewFrameKey(frame))! < anchor).at(-1),
    next: mode === 'shot' ? candidates[index + 1] : candidates.find(frame => order.get(previewFrameKey(frame))! > anchor),
  };
}
