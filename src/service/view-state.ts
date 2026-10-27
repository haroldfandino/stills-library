import type { Session } from '../shared/contracts';

/** Keep extraction journals and delivery evidence in the service, not the UI. */
export function sessionView(session: Session, summary = false): Session & { detailsOmitted: boolean; revisionActive: boolean } {
  const { analyses: _analyses, exports: _exports, uploadResults: _uploads, revision, frames, videos,
    selectedFrameIds, selectedVideoIds, ...metadata } = session;
  return { ...metadata, detailsOmitted: summary, revisionActive: Boolean(revision),
    frames: summary ? [] : frames, videos: summary ? [] : videos,
    selectedFrameIds: summary ? [] : selectedFrameIds, selectedVideoIds: summary ? [] : selectedVideoIds,
    revision: !summary && revision ? { ...revision, exports: [], uploads: revision.uploads.map(item => {
      const file = item as { videoId: string; frameId: number };
      return { videoId: file.videoId, frameId: file.frameId };
    }) } : undefined };
}
