import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AppState, Frame, Project, Session } from "./bridge";
import { getBridge } from "./bridge";
import { VirtualFrameGrid } from "./VirtualFrameGrid";
import { ReviewHistory, type ReviewSelection } from "./review-history";
import { previewNavigation, type PreviewMode } from "./preview-navigation";
import { projectSession, queueProjects } from "./session-view";

type QueueFilter = "All" | "To Do" | "In Process" | "Done" | "Reviewed" | "Skip";

const FILTERS: QueueFilter[] = ["All", "To Do", "In Process", "Done", "Reviewed", "Skip"];
const STUDIO_LABEL: Record<string, string> = {
  filmkraft: "Filmkraft",
  screenbridge: "Screenbridge",
};

function projectKey(project: Pick<Project, "studio" | "id">): string {
  return `${project.studio}:${project.id}`;
}

function shortName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function durationLabel(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "Duration unknown";
  const rounded = Math.round(value);
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  return minutes ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds}s`;
}

function formatTag(value: string): string {
  return value
    .trim()
    .replace(/[\s-]+/g, "_")
    .replace(/[^A-Za-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

function suggestedYear(projectName?: string): string {
  const years = new Set((projectName?.match(/20\d{2}/g) ?? []));
  return years.size === 1 ? [...years][0] : "";
}

function frameKey(frame: Frame): string {
  if (frame.id.includes(":")) return frame.id;
  return frame.videoId ? `${frame.videoId}:${frame.id}` : frame.id;
}

function phaseLabel(status?: string, revision = false): string {
  switch (status) {
    case "discovering": return "Finding delivery videos";
    case "awaiting_videos": return "Video review";
    case "analyzing": return "Analyzing shots";
    case "awaiting_stills": return "Stills review";
    case "exporting": return "Exporting PNGs";
    case "uploading": return revision ? "Updating Drive" : "Uploading to Drive";
    case "done": return "Complete";
    case "error": return "Needs attention";
    case "skipped": return "Skipped";
    default: return status ? status.replace(/_/g, " ") : "Ready to prepare";
  }
}

function projectStatusLabel(status: string): string {
  return status.toLowerCase() === "todo" ? "To Do" : status;
}

function statusClass(status?: string): string {
  if (status === "done" || status === "Done" || status === "Reviewed") return "done";
  if (status === "error") return "error";
  if (status === "skipped" || status === "Skip") return "muted";
  if (status === "awaiting_videos" || status === "awaiting_stills") return "review";
  if (status === "To Do") return "todo";
  return "active";
}

function priority(project: Project): number {
  const code = (project.code ?? project.id).toUpperCase();
  if (project.studio === "screenbridge" && code === "203SB") return 0;
  if (project.studio === "filmkraft" && code === "1289") return 1;
  return 2;
}

function FrameImage({ frame }: { frame: Frame }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [frame.previewUrl]);
  return frame.previewUrl && !failed ? (
    <img loading="lazy" decoding="async" src={frame.previewUrl} alt={`Candidate frame ${frame.id}`} onError={() => setFailed(true)} />
  ) : (
    <div className="preview-unavailable"><span>◇</span><small>Preview unavailable</small></div>
  );
}

function ActionButton({
  children,
  onClick,
  disabled,
  variant = "secondary",
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "quiet" | "danger";
  title?: string;
}) {
  return <button type="button" className={`button button-${variant}`} onClick={onClick} disabled={disabled} title={title}>{children}</button>;
}

function FramePreview({ frame, selected, index, count, folder, mode, onMode, hasPrevious, hasNext, shotFrames, selectedIds, onChoose, onToggleFrame, onClose, onMove, onToggle }: {
  frame: Frame; selected: boolean; index: number; count: number; folder: string;
  mode: PreviewMode; onMode: (mode: PreviewMode) => void; hasPrevious: boolean; hasNext: boolean;
  shotFrames: Frame[]; selectedIds: Set<string>; onChoose: (id: string) => void; onToggleFrame: (id: string) => void;
  onClose: () => void; onMove: (offset: number) => void; onToggle: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [thumbnailView, setThumbnailView] = useState(false);
  const showThumbnails = mode === "shot" && thumbnailView;
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog className="frame-dialog" ref={dialog} onClose={onClose} aria-label="Review enlarged still" onKeyDown={(event) => {
    if (event.key === "ArrowLeft" && hasPrevious) { event.preventDefault(); onMove(-1); }
    if (event.key === "ArrowRight" && hasNext) { event.preventDefault(); onMove(1); }
  }}>
    <div className="frame-dialog-header"><div><strong>{frame.videoName || "Candidate still"}</strong><span>{frame.timecode || ""} · {index >= 0 ? `${index + 1} of ${count}` : "Unselected candidate"} · {mode === "shot" ? `Shot ${frame.shotId ?? frame.shot ?? "unknown"}` : "Selected stills"}</span><span>Folder: {folder || "Project folder"}</span></div><ActionButton onClick={onClose}>Close ✕</ActionButton></div>
    <div className="preview-navigation-mode" role="group" aria-label="Enlarged navigation"><button type="button" aria-pressed={mode === "selected"} onClick={() => { onMode("selected"); setThumbnailView(false); }}>Selected stills</button><button type="button" aria-pressed={mode === "shot"} onClick={() => onMode("shot")}>Frames in this shot</button><span>← / → browse {mode === "shot" ? "all candidates in this shot" : "selected stills"}</span></div>
    {mode === "shot" && <div className="shot-view-switch" role="group" aria-label="Shot display"><button type="button" aria-pressed={!showThumbnails} onClick={() => setThumbnailView(false)}>Enlarged image</button><button type="button" aria-pressed={showThumbnails} onClick={() => setThumbnailView(true)}>Thumbnails</button><span>{shotFrames.filter(candidate => selectedIds.has(frameKey(candidate))).length} selected in this shot</span></div>}
    {showThumbnails ? <div className="shot-thumbnail-grid" role="region" aria-label="Frames in current shot"><VirtualFrameGrid items={shotFrames} sessionId={`${frame.videoId}:${frame.shotId ?? frame.shot ?? frame.id}`} render={(candidate, candidateIndex) => <div key={frameKey(candidate)} className={`frame-card shot-thumbnail ${selectedIds.has(frameKey(candidate)) ? "checked" : ""} ${frameKey(candidate) === frameKey(frame) ? "current" : ""}`}><div className="frame-image"><button type="button" className="frame-preview-trigger" aria-label={`Enlarge shot candidate ${candidateIndex + 1}`} onClick={() => { onChoose(frameKey(candidate)); setThumbnailView(false); }}><FrameImage frame={candidate} /><span className="frame-enlarge">Enlarge ↗</span></button><input type="checkbox" className="frame-select" aria-label={`Select shot candidate ${candidateIndex + 1}`} checked={selectedIds.has(frameKey(candidate))} onChange={() => onToggleFrame(frameKey(candidate))}/></div><div className="frame-info"><strong>Candidate {candidateIndex + 1}</strong><span>{candidate.timecode || `${candidate.timestampSec ?? ""}s`}</span><small>{selectedIds.has(frameKey(candidate)) ? "Selected for delivery" : "Not selected"}</small></div></div>} /></div> : <div className="frame-dialog-image"><FrameImage frame={frame} /></div>}

    <div className="frame-dialog-actions"><ActionButton onClick={() => onMove(-1)} disabled={!hasPrevious}>← Previous</ActionButton><label className="preview-selection"><input type="checkbox" checked={selected} onChange={showThumbnails ? () => onToggleFrame(frameKey(frame)) : onToggle} /> Selected for delivery</label><ActionButton onClick={() => onMove(1)} disabled={!hasNext}>Next →</ActionButton></div>
  </dialog>;
}

export default function App() {
  const bridge = useMemo(getBridge, []);
  const [state, setState] = useState<AppState>({});
  const [initializing, setInitializing] = useState(true);
  const [selectedKey, setSelectedKey] = useState<string>();
  const [filter, setFilter] = useState<QueueFilter>("All");
  const [search, setSearch] = useState("");
  const [locateProjectRequest, setLocateProjectRequest] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [clientId, setClientId] = useState("");
  const [operations, setOperations] = useState<Record<string, string>>({});
  const [hydratedDraft, setHydratedDraft] = useState("");
  const [draftError, setDraftError] = useState<string>();
  const histories = useRef(new Map<string, ReviewHistory>());
  const [uiError, setUiError] = useState<string>();
  const [checkedVideos, setCheckedVideos] = useState<Set<string>>(new Set());
  const [checkedFrames, setCheckedFrames] = useState<Set<string>>(new Set());
  const [projectTag, setProjectTag] = useState("");
  const [typeTag, setTypeTag] = useState("");
  const [yearTag, setYearTag] = useState("");
  const [previewFrameId, setPreviewFrameId] = useState<string>();
  const [previewMode, setPreviewMode] = useState<PreviewMode>("selected");
  const [filenamePage, setFilenamePage] = useState(0);
  const [approvedOnly, setApprovedOnly] = useState(false);
  const [reviewVideoId, setReviewVideoId] = useState("");
  const reviewSaveRef = useRef<HTMLDivElement>(null);
  const projectListRef = useRef<HTMLDivElement>(null);
  const selectedProjectRowRef = useRef<HTMLButtonElement>(null);
  const [skipVideosOpen, setSkipVideosOpen] = useState(false);
  const [videosToSkip, setVideosToSkip] = useState<Set<string>>(new Set());
  const reviewHistory = useRef(new ReviewHistory());
  const reviewSelection = useRef<ReviewSelection>({ frames: new Set(), skipped: {} });
  const [skippedVideoFrames, setSkippedVideoFrames] = useState<Record<string, string[]>>({});
  const [lastVideoSkip, setLastVideoSkip] = useState<{ sessionId: string; updatedAt?: string; videoCount: number; frameIds: string[]; videoIds: string[] }>();
  useEffect(() => { setApprovedOnly(false); setReviewVideoId(""); setSkipVideosOpen(false); setVideosToSkip(new Set()); setLastVideoSkip(undefined); }, [selectedKey]);
  const [detail, setDetail] = useState<Session>();

  const refresh = useCallback(async () => {
    if (!bridge) return;
    const next = await bridge.getState();
    setState((previous) => ({ ...previous, ...next }));
    let projects = next.projects;
    try {
      const listed = await bridge.listProjects();
      if (Array.isArray(listed)) projects = listed;
    } catch (error) {
      if (next.authenticated || (projects?.length ?? 0) > 0) throw error;
    }
    // Listing can wait behind a long save. Read state again rather than
    // replacing newer progress/completion events with the startup snapshot.
    const latest = await bridge.getState();
    setState((previous) => ({ ...previous, ...latest, projects: projects ?? latest.projects ?? previous.projects }));
  }, [bridge]);

  useEffect(() => {
    if (!bridge) {
      setInitializing(false);
      setUiError("The desktop bridge is unavailable. Open Stills Library from the Electron app.");
      return;
    }
    let mounted = true;
    const unsubscribe = bridge.onState((next) => {
      if (mounted) setState((previous) => ({ ...previous, ...next, projects: next.projects ?? previous.projects }));
    });
    refresh()
      .catch((error) => mounted && setUiError(error instanceof Error ? error.message : String(error)))
      .finally(() => mounted && setInitializing(false));
    return () => {
      mounted = false;
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, [bridge, refresh]);

  useEffect(() => { if (state.configured === false) setSettingsOpen(true); }, [state.configured]);
  useEffect(() => { setClientId(state.googleClientId ?? ""); }, [state.googleClientId]);

  const projects = useMemo(() => queueProjects(state).sort((a, b) => {
    const byPriority = priority(a) - priority(b);
    return byPriority || a.name.localeCompare(b.name);
  }), [state.projects, state.batch]);

  const selectedProject = useMemo(() => {
    const exact = projects.find((project) => projectKey(project) === selectedKey);
    if (exact) return exact;
    const currentSession = (state.sessions ?? []).find((session) => session.id === state.currentSessionId);
    if (currentSession) {
      const currentProject = projects.find((project) => project.id === currentSession.projectId && project.studio === currentSession.studio);
      if (currentProject) return currentProject;
    }
    return projects.find((project) => project.status === "In Process")
      ?? projects.find((project) => project.status === "To Do")
      ?? projects[0];
  }, [projects, selectedKey, state.currentSessionId, state.sessions]);

  const operationKey = selectedProject ? projectKey(selectedProject) : "global";
  const busy = operations[operationKey];
  const anyBusy = Object.keys(operations).length > 0;
  const openReviews = (state.sessions ?? []).filter(item => !item.deferred && ["awaiting_videos", "awaiting_stills", "analyzing", "exporting", "uploading", "error"].includes(item.status));

  const runningEntries = state.batch?.entries.filter(entry => entry.status === 'running') ?? [];
  const waitingEntries = runningEntries.filter(entry => state.sessions?.find(s => s.id === entry.sessionId)?.message === 'PNGs prepared; waiting for the upload slot.');
  const workingEntries = runningEntries.filter(entry => !waitingEntries.includes(entry));
  const runningEntry = workingEntries.find(entry => state.sessions?.find(s => s.id === entry.sessionId)?.status !== 'uploading') ?? workingEntries[0] ?? waitingEntries[0];
  useEffect(() => {
    if (runningEntry) setSelectedKey(projectKey(runningEntry.project));
  }, [runningEntry?.sessionId, state.batch?.id]);

  const nextProject = projects.find(project => project.status === "To Do"
    && (!selectedProject || projectKey(project) !== projectKey(selectedProject)));
  const openNextProject = () => {
    if (!nextProject) return;
    setSearch("");
    setFilter("All");
    setSelectedKey(projectKey(nextProject));
  };

  const sessionSummary = useMemo(() => {
    if (!selectedProject) return undefined;
    return projectSession(state, selectedProject);
  }, [selectedProject, state.sessions, state.batch]);

  useEffect(() => {
    if (!sessionSummary?.detailsOmitted || !bridge) return;
    let cancelled = false;
    void bridge.getSession(sessionSummary.id).then(next => {
      if (!cancelled && next) setDetail(next);
    }).catch(error => { if (!cancelled) setUiError(String(error)); });
    return () => { cancelled = true; };
  }, [bridge, sessionSummary?.id, sessionSummary?.updatedAt, sessionSummary?.detailsOmitted]);
  const session = sessionSummary?.detailsOmitted && detail?.id === sessionSummary.id && detail?.updatedAt === sessionSummary.updatedAt
    ? { ...detail, ...sessionSummary, frames: detail.frames, videos: detail.videos, revision: detail.revision }
    : sessionSummary;
  const loadingDetail = Boolean(sessionSummary?.detailsOmitted && (detail?.id !== sessionSummary.id || detail?.updatedAt !== sessionSummary.updatedAt));

  const videoSeed = (session?.videos ?? []).map((video) => `${video.id}:${video.selected ? 1 : 0}`).join("|");
  const frameSeed = (session?.frames ?? []).map((frame) => `${frameKey(frame)}:${frame.selected === false ? 0 : 1}`).join("|");

  const draftIdentity = session ? `${session.id}:${session.updatedAt ?? ""}` : "";
  useEffect(() => {
    if (!session || loadingDetail) return;
    let draft: any;
    try {
      const saved = localStorage.getItem(`stills-review-draft:${session.id}`) ?? sessionStorage.getItem('stills-review-draft');
      const parsed = saved ? JSON.parse(saved) : undefined;
      if (parsed?.sessionId === session.id && parsed.updatedAt === session.updatedAt) draft = parsed;
    } catch { /* Saved suggestions remain available if a draft cannot be read. */ }
    const allowed = new Set((session.frames ?? []).map(frameKey));
    const videos = new Set((session.videos ?? []).map(video => video.id));
    let frames = new Set((session.frames ?? []).filter(frame => frame.selected !== false).map(frameKey));
    let skipped: Record<string, string[]> = {};
    if (Array.isArray(draft?.frameIds)) frames = new Set(draft.frameIds.filter((id: unknown): id is string => typeof id === 'string' && allowed.has(id)));
    if (draft?.skippedVideoFrames && typeof draft.skippedVideoFrames === 'object') {
      skipped = Object.fromEntries(Object.entries(draft.skippedVideoFrames)
        .filter(([id, values]) => videos.has(id) && Array.isArray(values))
        .map(([id, values]) => [id, (values as unknown[]).filter((key): key is string => typeof key === 'string' && allowed.has(key))]));
    }
    setCheckedVideos(new Set(Array.isArray(draft?.videoIds) ? draft.videoIds.filter((id: string) => videos.has(id)) : (session.videos ?? []).filter(video => video.selected).map(video => video.id)));
    const history = histories.current.get(draftIdentity) ?? new ReviewHistory();
    histories.current.set(draftIdentity, history);
    reviewHistory.current = history;
    reviewSelection.current = { frames, skipped };
    setCheckedFrames(frames);
    setSkippedVideoFrames(skipped);
    setProjectTag(typeof draft?.naming?.project === 'string' ? draft.naming.project : session.naming?.project ?? selectedProject?.name ?? "");
    setTypeTag(typeof draft?.naming?.type === 'string' ? draft.naming.type : session.naming?.type ?? "");
    setYearTag(typeof draft?.naming?.year === 'string' ? draft.naming.year : session.naming?.year ?? suggestedYear(selectedProject?.name));
    setLastVideoSkip(undefined);
    setPreviewFrameId(undefined);
    setHydratedDraft(draftIdentity);
  }, [draftIdentity, loadingDetail, frameSeed, videoSeed]);

  useEffect(() => {
    if (!session || loadingDetail || hydratedDraft !== draftIdentity || !["awaiting_videos", "awaiting_stills"].includes(session.status)) return;
    try {
      localStorage.setItem(`stills-review-draft:${session.id}`, JSON.stringify({ sessionId: session.id, updatedAt: session.updatedAt,
        frameIds: [...checkedFrames], videoIds: [...checkedVideos], skippedVideoFrames,
        naming: { project: projectTag, type: typeTag, year: yearTag } }));
      setDraftError(undefined);
    } catch { setDraftError('The local draft could not be saved. Keep this review open until you save its changes to Drive.'); }
  }, [draftIdentity, hydratedDraft, loadingDetail, session?.status, checkedFrames, checkedVideos, skippedVideoFrames, projectTag, typeTag, yearTag]);

  const visibleProjects = projects.filter((project) => {
    if (filter !== "All" && project.status !== filter) return false;
    const query = search.trim().toLowerCase();
    return !query || `${project.name} ${project.code ?? ""} ${project.id} ${project.studio}`.toLowerCase().includes(query);
  });
  const selectedProjectKey = selectedProject ? projectKey(selectedProject) : "";
  const selectedProjectVisible = visibleProjects.some(project => projectKey(project) === selectedProjectKey);
  useEffect(() => {
    // Reveal a newly selected (or newly unfiltered) project once. Progress
    // updates and manual scrolling must not pull the list back to this row.
    const list = projectListRef.current;
    const row = selectedProjectRowRef.current;
    if (!selectedProjectVisible || !list || !row) return;
    const viewport = list.getBoundingClientRect();
    const item = row.getBoundingClientRect();
    if (item.top < viewport.top) list.scrollTop += item.top - viewport.top;
    else if (item.bottom > viewport.bottom) list.scrollTop += item.bottom - viewport.bottom;
  }, [selectedProjectKey, selectedProjectVisible, locateProjectRequest]);
  const counts = Object.fromEntries(FILTERS.map((item) => [item, item === "All" ? projects.length : projects.filter((project) => project.status === item).length]));
  const selectedFrames = (session?.frames ?? []).filter((frame) => checkedFrames.has(frameKey(frame)));
  const frameSelections = selectedFrames.map(frameKey);
  const availableFrames = (session?.frames ?? []).filter(frame => !frame.videoId || !Object.hasOwn(skippedVideoFrames, frame.videoId));
  const videoFrames = availableFrames.filter(frame => !reviewVideoId || frame.videoId === reviewVideoId);
  const visibleFrames = approvedOnly ? videoFrames.filter(frame => checkedFrames.has(frameKey(frame))) : videoFrames;
  const videoCounts = new Map<string, { total: number; approved: number }>();
  for (const frame of session?.frames ?? []) {
    if (!frame.videoId) continue;
    const counts = videoCounts.get(frame.videoId) ?? { total: 0, approved: 0 };
    counts.total++;
    if (checkedFrames.has(frameKey(frame))) counts.approved++;
    videoCounts.set(frame.videoId, counts);
  }
  const skipCandidateVideos = (session?.videos ?? []).filter(video => videoCounts.has(video.id) && !Object.hasOwn(skippedVideoFrames, video.id));
  const skipStillCount = selectedFrames.filter(frame => frame.videoId && videosToSkip.has(frame.videoId)).length;
  const normalizedProjectTag = formatTag(projectTag);
  const normalizedTypeTag = formatTag(typeTag);
  const namingReady = Boolean(normalizedProjectTag && normalizedTypeTag && /^20\d{2}$/.test(yearTag));
  const frameFolder = (frame: Frame) => frame.videoId ? session?.versionFolders?.[frame.videoId] ?? "" : "";
  const filenamePreviews = selectedFrames.map((frame, index) => {
    const folder = frameFolder(frame);
    const filename = `${normalizedProjectTag}_${normalizedTypeTag}_Still_${String(index + 1).padStart(2, "0")}.png`;
    return { id: frameKey(frame), folder, path: folder ? `${folder}/${filename}` : filename };
  });
  const folderCounts = new Map<string, number>();
  for (const preview of filenamePreviews) folderCounts.set(preview.folder, (folderCounts.get(preview.folder) ?? 0) + 1);
  const filenamePages = Math.max(1, Math.ceil(filenamePreviews.length / 100));
  const visibleFilenamePage = Math.min(filenamePage, filenamePages - 1);
  const previousDeliveryIds = useMemo(() => new Set(session?.revision?.uploads.map(file => `${file.videoId}:${file.frameId}`)), [session?.revision]);
  const versionFolderCount = [...folderCounts.keys()].filter(Boolean).length;
  const previewFrame = videoFrames.find(frame => frameKey(frame) === previewFrameId);
  const previewNav = previewFrame ? previewNavigation(videoFrames, previewFrame, checkedFrames, previewMode) : undefined;
  useEffect(() => {
    if (previewFrameId && !previewFrame) setPreviewFrameId(undefined);
  }, [previewFrameId, previewFrame]);
  const applyReviewSelection = (next: ReviewSelection) => {
    reviewSelection.current = next;
    setCheckedFrames(next.frames);
    setSkippedVideoFrames(next.skipped);
    setLastVideoSkip(undefined);
    try { sessionStorage.setItem('stills-review-draft', JSON.stringify({ sessionId: session?.id,
      updatedAt: session?.updatedAt, frameIds: [...next.frames], skippedVideoFrames: next.skipped })); } catch { /* A full browser cache must not block review. */ }
  };
  const updateFrameSelection = (frames: Set<string>, skipped = skippedVideoFrames) => {
    const next = { frames, skipped };
    if (reviewHistory.current.record(reviewSelection.current, next)) applyReviewSelection(next);
  };
  const undoReview = () => {
    const previous = reviewHistory.current.undo(reviewSelection.current);
    if (previous) applyReviewSelection(previous);
  };
  const redoReview = () => {
    const next = reviewHistory.current.redo(reviewSelection.current);
    if (next) applyReviewSelection(next);
  };
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (session?.status !== 'awaiting_stills' || busy || loadingDetail || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      const target = event.target as HTMLElement;
      if (target.closest('textarea, select, input:not([type="checkbox"]), [contenteditable="true"]')) return;
      const key = event.key.toLowerCase();
      if (key === 'z' || (key === 'y' && !event.shiftKey)) {
        event.preventDefault();
        if (key === 'y' || event.shiftKey) redoReview(); else undoReview();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  });
  const skipVideos = (ids: Set<string>) => {
    if (!session) return;
    const removed = selectedFrames.filter(frame => frame.videoId && ids.has(frame.videoId)).map(frameKey);
    const next = new Set(checkedFrames);
    for (const id of removed) next.delete(id);
    const skipped = { ...skippedVideoFrames };
    for (const id of ids) skipped[id] = selectedFrames.filter(frame => frame.videoId === id).map(frameKey);
    updateFrameSelection(next, skipped);
    if (ids.has(reviewVideoId)) setReviewVideoId("");
    setLastVideoSkip({ sessionId: session.id, updatedAt: session.updatedAt, videoCount: ids.size, frameIds: removed, videoIds: [...ids] });
    setSkipVideosOpen(false);
    setVideosToSkip(new Set());
  };
  const toggleFrame = (key: string) => {
    const next = new Set(checkedFrames);
    if (next.has(key)) next.delete(key); else next.add(key);
    updateFrameSelection(next);
  };

  const perform = async (label: string, action: () => Promise<unknown>) => {
    const key = operationKey;
    setOperations(previous => ({ ...previous, [key]: label }));
    setUiError(undefined);
    try {
      await action();
      const next = await bridge?.getState();
      if (next) setState((previous) => ({ ...previous, ...next }));
    } catch (error) {
      setUiError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperations(previous => { const next = { ...previous }; delete next[key]; return next; });
    }
  };

  const openPath = (path?: string) => {
    if (path && bridge) void perform("Opening folder", () => bridge.openPath(path));
  };
  const openUrl = (url?: string) => {
    if (url && bridge) void perform("Opening Drive", () => bridge.openUrl(url));
  };
  const skipProject = () => {
    if (!bridge || !selectedProject) return;
    void perform("Skipping project", async () => {
      let targetId = session?.id;
      if (!targetId) {
        const result = await bridge.prepare(selectedProject.studio, selectedProject.id);
        if (result && "id" in result && typeof result.id === "string") targetId = result.id;
        if (!targetId) {
          const updated = await bridge.getState();
          targetId = projectSession(updated, selectedProject)?.id;
        }
      }
      if (!targetId) throw new Error("The project session could not be created.");
      await bridge.skip(targetId);
    });
  };

  const nextProjectControl = nextProject
    ? <ActionButton onClick={openNextProject} disabled={Boolean(busy)} title={nextProject.name}>Next project →</ActionButton>
    : <span role="status">Queue complete — no To Do projects remain.</span>;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark"><span></span><span></span><span></span></div>
          <div><strong>STILLS LIBRARY</strong><small>Filmkraft · Screenbridge</small></div>
        </div>
        <div className="header-actions">
          <span className={`connection-dot ${state.authenticated ? "connected" : ""}`} aria-hidden="true" />
          <span className="account-label">{state.accountEmail || "Google not connected"}</span>
          <ActionButton variant="quiet" onClick={() => setSettingsOpen((open) => !open)}>{settingsOpen ? "Close setup" : "Setup"}</ActionButton>
          <ActionButton variant="quiet" onClick={() => void perform("Refreshing", refresh)} disabled={Boolean(busy)}>↻ <span className="hide-mobile">Refresh</span></ActionButton>
        </div>
      </header>

      {state.batch && <section className="batch-banner" aria-label="Automatic queue progress"><div><strong>Automatic queue · {state.batch.status}</strong>{workingEntries.map(entry => { const active = state.sessions?.find(s => s.id === entry.sessionId); return <p key={projectKey(entry.project)}><button className="batch-project-link" onClick={() => { setSelectedKey(projectKey(entry.project)); setSearch(""); setFilter("All"); }}>{entry.project.name}</button> · {active?.message === "PNGs prepared; waiting for the upload slot." ? "Waiting to upload" : phaseLabel(active?.status ?? "discovering", Boolean(active?.revisionActive))}</p>; })}{waitingEntries.length > 0 && <details className="upload-backlog"><summary>{waitingEntries.length} {waitingEntries.length === 1 ? "project" : "projects"} waiting to upload</summary>{waitingEntries.map(entry => <p key={projectKey(entry.project)}><button className="batch-project-link" onClick={() => setSelectedKey(projectKey(entry.project))}>{entry.project.name}</button></p>)}</details>}<p>{state.batch.entries.filter(e => e.status === 'done').length} completed · {state.batch.entries.filter(e => e.status === 'skipped').length} missing sources · {state.batch.entries.filter(e => e.status === 'failed').length} need attention · {state.batch.entries.filter(e => e.status === 'pending' || e.status === 'running').length} remaining</p>{state.batch.error && <p role="alert">{state.batch.error}</p>}<small>Suggested selections are approved automatically. Every export remains available for review.</small></div><div>{runningEntry && <ActionButton variant="primary" onClick={() => { setSelectedKey(projectKey(runningEntry.project)); setSearch(""); setFilter("All"); }}>View current project</ActionButton>}<ActionButton onClick={() => openPath(state.batch?.reportPath)}>Open run report ↗</ActionButton>{state.batch.status === 'running' && <ActionButton onClick={() => bridge && void perform("Pausing queue", () => bridge.pauseBatch())} disabled={state.batch.pauseRequested}>{state.batch.pauseRequested ? 'Pausing after current work…' : 'Pause after current work'}</ActionButton>}{state.batch.status !== 'running' && state.batch.entries.some(e => e.status === 'failed') && <ActionButton onClick={() => bridge && void perform("Retrying flagged projects", () => bridge.retryBatch())}>Retry flagged projects</ActionButton>}{state.batch.status === 'paused' && <ActionButton onClick={() => bridge && void perform("Resuming automatic queue", () => bridge.startBatch())}>Resume automatic queue</ActionButton>}</div></section>}

      {settingsOpen && (
        <section className="settings-panel" aria-label="App setup">
          <div className="settings-intro"><span className="eyebrow">WORKSPACE SETUP</span><h2>Connect your sources</h2><p>Use the project account and choose the local source roots on this computer.</p></div>
          <div className="settings-grid">
            <div className="settings-card">
              <span className="settings-number">01</span><h3>Google account</h3>
              <p>{state.accountEmail ? `Connected as ${state.accountEmail}` : "Sign in as harold@filmkraft.tv to access the Stills sheets and Drive destinations."}</p>
              <div className="settings-form"><input aria-label="Google OAuth client ID" type="text" value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder="Desktop OAuth client ID" />
                <ActionButton onClick={() => bridge && void perform("Saving Google setup", () => bridge.configureGoogle(clientId.trim()))} disabled={!bridge || !clientId.trim() || Boolean(busy)}>Save ID</ActionButton></div>
              <div className="root-actions"><ActionButton onClick={() => bridge && void perform("Importing Google setup", () => bridge.importGoogleCredentials())} disabled={!bridge || Boolean(busy)}>Import OAuth JSON</ActionButton><ActionButton variant="primary" onClick={() => bridge && void perform("Signing in", async () => { await bridge.signIn(); await refresh(); })} disabled={!bridge || !state.configured || Boolean(busy)}>Sign in with Google ↗</ActionButton></div>
              <p className="setup-hint">Import the JSON downloaded for a Google Desktop app client, or save its client ID above.</p>
              {state.authenticated && <ActionButton variant="quiet" onClick={() => bridge && void perform("Signing out", () => bridge.signOut())} disabled={anyBusy}>Sign out</ActionButton>}
            </div>
            <div className="settings-card"><span className="settings-number">02</span><h3>Local source folders</h3>
              {Object.keys(state.sourceRoots ?? {}).length ? <div className="root-list">{Object.entries(state.sourceRoots ?? {}).map(([studio, path]) => <div className="root-item" key={studio}><strong>{STUDIO_LABEL[studio] ?? studio}</strong><span title={path}>{path || "Choose a source folder"}</span></div>)}</div> : <p>Choose the Filmkraft and Screenbridge source folders before preparing a project.</p>}
              {(state.additionalSources ?? []).map(source => <div className="root-item" key={source.path}><strong>Google Drive: {source.label}</strong><span title={source.url}>{source.path}</span></div>)}
              <div className="root-actions"><ActionButton onClick={() => bridge && void perform("Choosing Filmkraft folder", () => bridge.chooseRoots("filmkraft"))} disabled={!bridge || Boolean(busy)}>Choose Filmkraft</ActionButton><ActionButton onClick={() => bridge && void perform("Choosing Screenbridge folder", () => bridge.chooseRoots("screenbridge"))} disabled={!bridge || Boolean(busy)}>Choose Screenbridge</ActionButton></div>
            </div>
          </div>
        </section>
      )}

      <div className="workspace">
        <aside className="queue-panel">
          <div className="queue-heading"><span className="eyebrow">PROJECTS</span><h1>Review queue</h1><p>Up to {state.reviewLimit ?? 3} open reviews. One Drive upload at a time.</p></div>
          <div className="queue-stat-row"><div><strong>{counts["To Do"] ?? 0}</strong><span>To do</span></div><div><strong>{counts["In Process"] ?? 0}</strong><span>In process</span></div><div><strong>{counts.Done ?? 0}</strong><span>Done</span></div></div>
          <input className="queue-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search projects" aria-label="Search projects" />
          <button type="button" className="locate-project" disabled={!selectedProject} title="Show the current project in the full project list" onClick={() => { setSearch(""); setFilter("All"); setLocateProjectRequest(value => value + 1); }}>Find current project ↓</button>
          <div className="filter-row" aria-label="Filter projects">{FILTERS.map((item) => <button type="button" key={item} onClick={() => setFilter(item)} className={`filter-pill ${filter === item ? "selected" : ""}`}>{item} <span>{counts[item] ?? 0}</span></button>)}</div>
          <div className="project-list" aria-label="Projects" ref={projectListRef}>
            {visibleProjects.length ? visibleProjects.map((project) => {
              const selected = selectedProject && projectKey(project) === projectKey(selectedProject);
              const rowSession = projectSession(state, project);
              return <button type="button" key={projectKey(project)} ref={selected ? selectedProjectRowRef : undefined} className={`project-row ${selected ? "selected" : ""}`} onClick={() => setSelectedKey(projectKey(project))}>
                <span className="project-row-top"><span className="studio-label">{STUDIO_LABEL[project.studio] ?? project.studio}</span><span className={`status-mini ${statusClass(rowSession?.status ?? project.status)}`}>{project.status === "Reviewed" ? "Reviewed" : rowSession ? phaseLabel(rowSession.status, Boolean(rowSession.revisionActive)) : projectStatusLabel(project.status)}</span></span>
                <strong>{project.name}</strong><span className="project-row-bottom">{project.code || project.id}<span aria-hidden="true">↗</span></span>
              </button>;
            }) : <div className="empty-queue">{initializing ? "Loading projects…" : projects.length ? "No projects match this filter." : "No projects loaded yet. Connect Google in Setup, then refresh."}</div>}
          </div>
          <div className="queue-footer"><span>Source rows marked <strong>To Do</strong> are eligible.</span></div>
        </aside>

        <main className="main-panel">
          <nav title="Drafts are saved on this computer. Save changes to Drive when ready." className="open-reviews" aria-label="Open project reviews"><span>Open reviews · {openReviews.length}/{state.reviewLimit ?? 3}</span>{openReviews.map(item => <button type="button" key={item.id} className={item.id === session?.id ? "selected" : ""} onClick={() => { setSelectedKey(`${item.studio}:${item.projectId}`); setSearch(""); setFilter("All"); }}>{item.projectName || item.projectId}{["uploading", "exporting"].includes(item.status) ? " · Saving" : operations[`${item.studio}:${item.projectId}`] ? " · Waiting" : ""}</button>)}</nav>
          {draftError && <div className="alert alert-error" role="alert">{draftError}</div>}
          {session?.deferred && ["awaiting_videos", "awaiting_stills"].includes(session.status) && <section className="hero-card"><h3>Review closed</h3><p>Your draft is kept separately for this project.</p><ActionButton onClick={() => bridge && void perform("Opening review", () => bridge.setReviewOpen(session.id, true))} disabled={Boolean(busy)}>Open review</ActionButton></section>}

          {(uiError || state.error) && <div className="alert alert-error" role="alert"><strong>Action needed</strong><span>{uiError || state.error}</span><button type="button" onClick={() => setUiError(undefined)} aria-label="Dismiss error">×</button></div>}
          {busy && <div className="busy-banner" role="status"><span className="spinner" /> {busy}…</div>}
          {selectedProject ? (
            <>
              <div className="project-header">
                <div className="project-title"><div className="eyebrow">{selectedProject.studio.toUpperCase()} <span className="crumb">/</span> {selectedProject.code || selectedProject.id}</div><h2>{selectedProject.name}</h2><div className="project-meta"><span className={`status-chip ${statusClass(session?.status ?? selectedProject.status)}`}>{selectedProject.status === "Reviewed" ? "Reviewed" : session ? phaseLabel(session.status, Boolean(session.revision || session.revisionActive)) : projectStatusLabel(selectedProject.status)}</span><span>Sheet status: {projectStatusLabel(selectedProject.status)}</span>{["Done", "Reviewed"].includes(selectedProject.status) && <label className="reviewed-toggle"><input type="checkbox" checked={selectedProject.status === "Reviewed"} disabled={!bridge || Boolean(busy) || state.batch?.status === "running" || Boolean(session && session.status !== "done")} onChange={event => { const reviewed = event.target.checked; if (bridge) void perform(reviewed ? "Marking project Reviewed" : "Returning project to Done", () => bridge.setReviewed(selectedProject.studio, selectedProject.id, reviewed)); }} /> Reviewed</label>}</div>{session?.manualSourcePath && <div className="source-confirmation" title={session.manualSourcePath}>Selected source: {session.manualSourcePath}</div>}</div>
                <div className="project-tools">{session && !session.deferred && ["awaiting_videos", "awaiting_stills", "error"].includes(session.status) && <ActionButton onClick={() => bridge && void perform("Closing review", () => bridge.setReviewOpen(session.id, false))} disabled={Boolean(busy)}>Close review · keep draft</ActionButton>}{session && (session.status === "awaiting_videos" || session.status === "skipped" || (session.status === "error" && session.lastPhase === "discovering")) && <ActionButton onClick={() => bridge && void perform("Finding videos in selected folder", () => bridge.chooseProjectSource(session.id))} disabled={!bridge || Boolean(busy) || state.batch?.status === "running"}>Choose source folder</ActionButton>}
                  <ActionButton variant="quiet" onClick={() => openPath(session?.sourcePath || selectedProject.sourcePath)} disabled={!session?.sourcePath && !selectedProject.sourcePath}>Open source ↗</ActionButton>
                  <ActionButton variant="quiet" onClick={() => openPath(session?.stagingPath)} disabled={!session?.stagingPath}>Open staging ↗</ActionButton>
                  <ActionButton variant="quiet" onClick={() => openUrl(session?.destinationUrl || selectedProject.destinationUrl)} disabled={!session?.destinationUrl && !selectedProject.destinationUrl}>Open Drive ↗</ActionButton>
                </div>
              </div>
              <div className="stage-track" aria-label="Workflow progress">
                {["Discover", "Review videos", "Review stills", "Deliver"].map((label, index) => {
                  const current = session?.status === "awaiting_videos" ? 1 : session?.status === "analyzing" || session?.status === "awaiting_stills" ? 2 : session?.status === "exporting" || session?.status === "uploading" || session?.status === "done" ? 3 : 0;
                  return <div key={label} className={`stage ${index < current ? "passed" : ""} ${index === current ? "current" : ""}`}><span className="stage-index">{index < current ? "✓" : String(index + 1).padStart(2, "0")}</span><span>{label}</span></div>;
                })}
              </div>

              {!session && <section className="hero-card"><div className="hero-icon">▣</div><span className="eyebrow">READY TO BEGIN</span><h3>Prepare this project</h3><p>We’ll locate its delivery videos and propose the best cuts for your review. Nothing is exported until you approve.</p><div className="hero-actions"><ActionButton variant="primary" onClick={() => bridge && void perform("Preparing project", () => bridge.prepare(selectedProject.studio, selectedProject.id))} disabled={!bridge || Boolean(busy) || selectedProject.status === "Done" || selectedProject.status === "Reviewed" || selectedProject.status === "Skip"}>Prepare project <span aria-hidden="true">→</span></ActionButton>{selectedProject.status === "To Do" && <ActionButton variant="quiet" onClick={skipProject} disabled={!bridge || Boolean(busy)}>Skip project</ActionButton>}</div></section>}

              {loadingDetail && <section className="hero-card"><div className="spinner"/><h3>Loading saved review…</h3></section>}
              {session?.status === "awaiting_videos" && !session.deferred && !loadingDetail && <section className="review-section"><div className="section-heading"><div><span className="eyebrow">APPROVAL 01 / 02</span><h3>Choose videos</h3><p>Every discovered delivery file is listed below. The suggested cuts are preselected; adjust them before analysis.</p></div><div className="selection-count"><strong>{checkedVideos.size}</strong><span>of {session.videos?.length ?? 0} selected</span></div></div>
                <div className="selection-actions"><ActionButton variant="quiet" onClick={() => setCheckedVideos(new Set((session.videos ?? []).filter(video => video.selected).map(video => video.id)))} disabled={Boolean(busy)}>Use suggestions</ActionButton><ActionButton variant="quiet" onClick={() => setCheckedVideos(new Set((session.videos ?? []).map(video => video.id)))} disabled={Boolean(busy)}>Select all</ActionButton><ActionButton variant="quiet" onClick={() => setCheckedVideos(new Set())} disabled={Boolean(busy)}>Clear selection</ActionButton></div>
                {session.manualSourcePath && <div className="source-review-note"><strong>Manually selected source</strong><span>{session.manualSourcePath}</span><small>Confirm these videos belong to this Stills row before approval.</small></div>}
                {session.videos?.length ? <div className="video-list">{session.videos.map((video) => <label className={`video-row ${checkedVideos.has(video.id) ? "checked" : ""}`} key={video.id}><input type="checkbox" checked={checkedVideos.has(video.id)} onChange={() => setCheckedVideos((previous) => { const next = new Set(previous); if (next.has(video.id)) next.delete(video.id); else next.add(video.id); return next; })} /><span className="custom-check" aria-hidden="true">✓</span><span className="video-content"><span className="video-top"><strong title={video.path}>{video.name || shortName(video.path)}</strong>{video.selected && <em>Suggested</em>}</span><span className="video-details"><span>{durationLabel(video.durationSec)}</span><span>{video.aspect || "Aspect unknown"}</span><span>{video.codec || video.format || "Format unknown"}</span>{video.width && video.height && <span>{video.width} × {video.height}</span>}{video.variant && <span>{video.variant}</span>}{video.channel && <span>{video.channel}</span>}{video.voiceover && <span>{video.voiceover}</span>}</span><span className="video-path" title={video.path}>{video.path}</span></span><button className="row-open" type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); if (bridge) void perform("Showing video", () => bridge.revealPath(video.path)); }} title="Show video in Finder or Explorer" aria-label={`Open ${video.name || shortName(video.path)}`}>↗</button></label>)}</div> : <div className="empty-state"><strong>No videos found</strong><p>Check the delivery folder or source-root setup, then resume the scan.</p></div>}
                {session.revision && <p className="revision-summary">{frameSelections.filter(id => !previousDeliveryIds.has(id)).length} to upload · {session.revision.uploads.filter(file => !frameSelections.includes(`${file.videoId}:${file.frameId}`)).length} to move to Drive Trash · Names will be numbered from 01.</p>}
                <div className="review-footer"><span>Analysis begins only for the checked videos.</span><div>{!session.revision && <ActionButton variant="quiet" onClick={skipProject} disabled={Boolean(busy)}>Skip project</ActionButton>}<ActionButton variant="primary" onClick={() => bridge && void perform("Analyzing selected videos", () => bridge.approveVideos(session.id, [...checkedVideos]))} disabled={!bridge || !checkedVideos.size || Boolean(busy)}>Approve {checkedVideos.size} {checkedVideos.size === 1 ? "video" : "videos"} <span aria-hidden="true">→</span></ActionButton></div></div>
              </section>}

              {session?.status === "awaiting_stills" && !session.deferred && !loadingDetail && <section className="review-section"><div className="section-heading"><div><span className="eyebrow">APPROVAL 02 / 02</span><h3>Choose stills</h3><p>{session.previousDeliveryManifest ? "Your previous selection is preselected for review. Adjust the stills and check the folders and filenames before approving again." : "One smart pick per shot plus the final source frame is preselected. Add or remove frames, then review the folders and filenames before export."}</p></div><div className="selection-count"><strong>{frameSelections.length}</strong><span>of {availableFrames.length} selected</span></div></div>
                <div className="selection-actions"><ActionButton title="Undo last review change (Ctrl+Z)" onClick={undoReview} disabled={!reviewHistory.current.canUndo || Boolean(busy)}>Undo</ActionButton><ActionButton title="Redo review change (Ctrl+Y or Ctrl+Shift+Z)" onClick={redoReview} disabled={!reviewHistory.current.canRedo || Boolean(busy)}>Redo</ActionButton>{!approvedOnly && <ActionButton variant="quiet" onClick={() => updateFrameSelection(new Set([...checkedFrames, ...videoFrames.map(frameKey)]))} disabled={Boolean(busy)}>{reviewVideoId ? "Select all in this video" : "Select all"}</ActionButton>}<ActionButton variant="quiet" onClick={() => { if (reviewVideoId) skipVideos(new Set([reviewVideoId])); else updateFrameSelection(new Set()); }} disabled={Boolean(busy) || (reviewVideoId ? !videoCounts.get(reviewVideoId)?.approved : !checkedFrames.size)}>{reviewVideoId ? "Skip this video" : "Clear selection"}</ActionButton><ActionButton onClick={() => { setVideosToSkip(new Set(reviewVideoId && videoCounts.get(reviewVideoId)?.approved ? [reviewVideoId] : [])); setSkipVideosOpen(open => !open); }} disabled={Boolean(busy)}>Skip videos…</ActionButton><span>Enlarge a preview to inspect it before delivery.</span><ActionButton onClick={() => reviewSaveRef.current?.scrollIntoView({ block: "end" })} disabled={Boolean(busy)}>Review & save changes ↓</ActionButton></div>
                {session.error && <div className="review-alert" role="alert"><strong>Delivery paused</strong><span>{session.error}</span></div>}
                {skipVideosOpen && <section className="video-skip-panel" aria-label="Skip stills by video"><h4>Skip all stills from videos</h4><p>Choose one or more videos to remove from your approved selection. Save changes to Drive when your review is finished.</p><div className="video-skip-tools"><ActionButton onClick={() => setVideosToSkip(new Set(skipCandidateVideos.filter(video => videoCounts.get(video.id)!.approved > 0).map(video => video.id)))}>Select all videos</ActionButton><ActionButton onClick={() => setVideosToSkip(new Set())} disabled={!videosToSkip.size}>Clear video selection</ActionButton></div><div className="video-skip-list">{skipCandidateVideos.map(video => <label key={video.id}><input type="checkbox" aria-label={`Skip all stills from ${video.name || shortName(video.path)}`} checked={videosToSkip.has(video.id)} disabled={!videoCounts.get(video.id)!.approved} onChange={() => setVideosToSkip(previous => { const next = new Set(previous); if (next.has(video.id)) next.delete(video.id); else next.add(video.id); return next; })}/><span><strong>{video.name || shortName(video.path)}</strong><small>{videoCounts.get(video.id)!.approved} approved stills</small></span></label>)}</div><div className="video-skip-tools"><ActionButton variant="primary" onClick={() => skipVideos(videosToSkip)} disabled={!skipStillCount}>Skip {videosToSkip.size} {videosToSkip.size === 1 ? "video" : "videos"} · {skipStillCount} stills</ActionButton><ActionButton onClick={() => setSkipVideosOpen(false)}>Cancel</ActionButton></div></section>}
                {lastVideoSkip?.sessionId === session.id && lastVideoSkip.updatedAt === session.updatedAt && <div className="video-skip-notice" role="status"><span>{lastVideoSkip.videoCount} {lastVideoSkip.videoCount === 1 ? "video skipped" : "videos skipped"} · {lastVideoSkip.frameIds.length} stills deselected. Save changes to Drive to apply.</span><ActionButton onClick={undoReview}>Undo</ActionButton></div>}
                {Object.keys(skippedVideoFrames).length > 0 && <div className="video-skip-notice"><span>{Object.keys(skippedVideoFrames).length} skipped videos hidden from review.</span><ActionButton onClick={() => { updateFrameSelection(new Set([...checkedFrames, ...Object.values(skippedVideoFrames).flat()]), {}); setLastVideoSkip(undefined); }}>Restore skipped videos</ActionButton></div>}
                <div className="stills-filter" role="group" aria-label="Filter stills"><label className="video-filter">Video<select aria-label="Filter stills by video" value={reviewVideoId} onChange={event => setReviewVideoId(event.target.value)}><option value="">All videos</option>{(session.videos ?? []).filter(video => videoCounts.has(video.id) && !Object.hasOwn(skippedVideoFrames, video.id)).map(video => <option key={video.id} value={video.id}>{video.name || shortName(video.path)} — {videoCounts.get(video.id)!.approved} approved / {videoCounts.get(video.id)!.total} candidates</option>)}</select></label><button type="button" className={`filter-pill ${!approvedOnly ? "selected" : ""}`} aria-pressed={!approvedOnly} onClick={() => setApprovedOnly(false)}>All candidates <span>{videoFrames.length}</span></button><button type="button" className={`filter-pill ${approvedOnly ? "selected" : ""}`} aria-pressed={approvedOnly} onClick={() => setApprovedOnly(true)}>Approved only <span>{videoFrames.filter(frame => checkedFrames.has(frameKey(frame))).length}</span></button><span className="stills-filter-count" role="status">Showing {visibleFrames.length} of {videoFrames.length} stills{reviewVideoId ? " in this video" : ""}</span></div>
                {visibleFrames.length ? <VirtualFrameGrid items={visibleFrames} sessionId={`${session.id}:${approvedOnly}:${reviewVideoId}`} render={(frame, index) => { const key = frameKey(frame); const folder = frameFolder(frame); return <div className={`frame-card ${checkedFrames.has(key) ? "checked" : ""}`} key={key}><div className="frame-image"><button type="button" className="frame-preview-trigger" aria-label={`Enlarge frame ${index + 1}`} onClick={() => setPreviewFrameId(key)}><FrameImage frame={frame} /><span className="frame-enlarge" aria-hidden="true">Enlarge ↗</span></button><input type="checkbox" className="frame-select" aria-label={`Select frame ${index + 1} for delivery`} checked={checkedFrames.has(key)} onChange={() => toggleFrame(key)} /></div><div className="frame-info"><strong>{frame.finalFrame ? "Final frame" : frame.shot !== undefined || frame.shotId !== undefined ? `Shot ${frame.shot ?? frame.shotId}` : `Frame ${index + 1}`}</strong><span>{frame.timecode || (frame.timestampSec !== undefined ? durationLabel(frame.timestampSec) : "Time unknown")}</span></div><div className="frame-video" title={frame.videoName}>{frame.videoName || (session.videos ?? []).find((video) => video.id === frame.videoId)?.name || "Selected video"}</div><div className="frame-folder" title={folder || "Project folder"}>Folder: {folder || "Project folder"}</div></div>; }} /> : <div className="empty-state"><strong>{approvedOnly ? "No approved stills" : "No candidate frames"}</strong><p>{approvedOnly ? "Switch to All candidates to select stills, or choose another video." : "Resume analysis or inspect the selected video files."}</p></div>}
                <div className="naming-panel"><div className="naming-heading"><span className="eyebrow">FOLDER & FILENAME REVIEW</span><h4>Set the naming tags</h4><p>Preview the destination for every selected PNG before delivery.</p></div><div className="naming-fields"><label>Project tag<input value={projectTag} onChange={(event) => setProjectTag(event.target.value)} placeholder="Airwaav_Brager" /></label><label>Type tag<input value={typeTag} onChange={(event) => setTypeTag(event.target.value)} placeholder="Campaign" /></label><label>Delivery year<input disabled={Boolean(session.revision)} value={yearTag} onChange={(event) => setYearTag(event.target.value)} placeholder="Choose year" inputMode="numeric" maxLength={4} /></label></div>{session.yearSuggestion && <p>Suggested year: {session.yearSuggestion.year} — {session.yearSuggestion.reason}. </p>}<div className="destination-preview">Drive destination <strong>01_Stills / {/^20\d{2}$/.test(yearTag) ? yearTag : "valid year required"} / {selectedProject.name}</strong></div>
                  <div className="delivery-folders"><strong>{versionFolderCount ? `${versionFolderCount} version ${versionFolderCount === 1 ? "folder" : "folders"}` : "Project folder"}</strong><span>{frameSelections.length} selected {frameSelections.length === 1 ? "PNG" : "PNGs"}{!versionFolderCount ? " · No subfolders" : ""}</span>{folderCounts.size > 0 && <ul>{[...folderCounts].map(([folder, count]) => <li key={folder}><span>{folder || "Project folder"}</span><small>{count} {count === 1 ? "PNG" : "PNGs"}</small></li>)}</ul>}</div>
                  <div className="filename-list">{namingReady && filenamePreviews.length ? filenamePreviews.slice(visibleFilenamePage * 100, (visibleFilenamePage + 1) * 100).map((preview, index) => <div key={preview.id}><span>{String(visibleFilenamePage * 100 + index + 1).padStart(2, "0")}</span><code>{preview.path}</code></div>) : <p>Choose a frame, fill both tags, and enter a 20xx delivery year to preview filenames.</p>}</div>{filenamePages > 1 && <div className="filename-pages"><ActionButton onClick={() => setFilenamePage(visibleFilenamePage - 1)} disabled={visibleFilenamePage === 0}>Previous names</ActionButton><span>Page {visibleFilenamePage + 1} of {filenamePages}</span><ActionButton onClick={() => setFilenamePage(visibleFilenamePage + 1)} disabled={visibleFilenamePage + 1 === filenamePages}>Next names</ActionButton></div>}</div>
                {session.revision && <p className="revision-summary">{frameSelections.filter(id => !previousDeliveryIds.has(id)).length} to upload · {session.revision.uploads.filter(file => !frameSelections.includes(`${file.videoId}:${file.frameId}`)).length} to move to Drive Trash · Names will be numbered from 01.</p>}
                <div className="review-footer" ref={reviewSaveRef}><span>{session.revision ? "Save the whole project’s selection, including other videos. Deselected stills move to Drive Trash." : "Approved frames are exported as PNGs, renamed in staging, and uploaded."}</span><div>{!session.revision && <ActionButton variant="quiet" onClick={skipProject} disabled={Boolean(busy)}>Skip project</ActionButton>}<ActionButton variant="primary" onClick={() => bridge && void perform("Exporting approved stills", () => bridge.approveStills(session.id, frameSelections, { project: normalizedProjectTag, type: normalizedTypeTag, year: yearTag }))} disabled={!bridge || (!frameSelections.length && !session.revision) || !namingReady || Boolean(busy)}>{session.revision ? "Save changes to Drive" : "Approve & deliver"} <span aria-hidden="true">→</span></ActionButton></div></div>
              </section>}

              {["discovering", "analyzing", "exporting", "uploading"].includes(session?.status ?? "") && <section className="hero-card progress-card"><div className="large-spinner" /><span className="eyebrow">WORK IN PROGRESS</span><h3>{session?.revision && session.status === "uploading" ? "Applying changes to Drive" : phaseLabel(session?.status)}</h3><p>{session?.message || (session?.status === "discovering" ? "Scanning the project delivery folders for videos." : session?.status === "analyzing" ? "Extract Stills is finding strong frames from the approved videos." : "The approved stills are being prepared and delivered.")}</p>{session?.totalCount !== undefined && <div className="progress-numbers">{session.uploadedCount ?? 0} / {session.totalCount} files</div>}</section>}

              {session?.status === "error" && <section className="hero-card error-card"><div className="hero-icon">!</div><span className="eyebrow">NEEDS ATTENTION</span><h3>Project paused</h3><p>{session.error || session.message || "The workflow stopped before delivery. Review the source and staging folders, then resume."}</p><div className="hero-actions">{session.lastPhase === "discovering" && <ActionButton onClick={() => bridge && void perform("Choosing project folder", () => bridge.chooseProjectSource(session.id))} disabled={!bridge || Boolean(busy)}>Choose source folder</ActionButton>}<ActionButton variant="primary" onClick={() => bridge && void perform("Resuming project", () => bridge.resume(session.id))} disabled={!bridge || Boolean(busy)}>Resume project →</ActionButton>{!session.revision && <ActionButton variant="quiet" onClick={skipProject} disabled={Boolean(busy)}>Skip project</ActionButton>}</div></section>}

              {session?.status === "done" && <section className="hero-card completion-card"><div className="hero-icon">✓</div><span className="eyebrow">DELIVERY VERIFIED</span><h3>Project complete</h3><p>{session.message || "The approved PNGs are in the project’s Drive folder, and the Stills row is marked Done."}</p><div className="hero-actions"><ActionButton variant="primary" onClick={() => openUrl(session.destinationUrl || selectedProject.destinationUrl)} disabled={!session.destinationUrl && !selectedProject.destinationUrl}>Open Drive folder ↗</ActionButton>{nextProjectControl}<ActionButton onClick={() => bridge && void perform("Reopening stills review", () => bridge.reviewAgain(session.id))} disabled={!bridge || Boolean(busy)}>Review stills again</ActionButton></div><p className="review-again-note">Review again using the saved previews and previous selection. Apply a revision to remove deselected files from Drive, upload additions, and renumber the selection.</p></section>}

              {session?.status === "skipped" && <section className="hero-card"><div className="hero-icon">—</div><span className="eyebrow">{session.automaticRunId ? "SOURCE UNAVAILABLE" : "SKIPPED BY REVIEWER"}</span><h3>Project skipped</h3><p>{session.message || "This project’s Stills row is marked Skip."}</p><div className="hero-actions">{nextProjectControl}</div></section>}

              {session && !["discovering", "awaiting_videos", "awaiting_stills", "analyzing", "exporting", "uploading", "done", "error", "skipped"].includes(session.status) && <section className="hero-card"><span className="eyebrow">CURRENT STATE</span><h3>{phaseLabel(session.status, Boolean(session.revision || session.revisionActive))}</h3><p>{session.message || "The workflow is preparing this project."}</p><ActionButton variant="primary" onClick={() => bridge && void perform("Resuming project", () => bridge.resume(session.id))} disabled={!bridge || Boolean(busy)}>Resume project →</ActionButton></section>}
            </>
          ) : <section className="welcome-panel"><span className="welcome-symbol">▣</span><span className="eyebrow">STILLS LIBRARY</span><h2>{initializing ? "Loading projects…" : "Ready when you are"}</h2><p>{initializing ? "Reading your project queue." : "Connect Google and choose your source folders in Setup, then refresh the queue."}</p><ActionButton variant="primary" onClick={() => setSettingsOpen(true)}>Open setup →</ActionButton></section>}
        </main>
      </div>
      {previewFrame && session?.status === "awaiting_stills" && !session.deferred && <FramePreview frame={previewFrame} selected={checkedFrames.has(frameKey(previewFrame))} index={previewNav?.index ?? -1} count={previewNav?.count ?? 0} mode={previewMode} onMode={setPreviewMode} hasPrevious={Boolean(previewNav?.previous)} hasNext={Boolean(previewNav?.next)} shotFrames={previewMode === "shot" ? previewNav?.candidates ?? [] : []} selectedIds={checkedFrames} onChoose={setPreviewFrameId} onToggleFrame={toggleFrame} folder={frameFolder(previewFrame)} onClose={() => setPreviewFrameId(undefined)} onMove={(offset) => { const next = offset < 0 ? previewNav?.previous : previewNav?.next; if (next) setPreviewFrameId(frameKey(next)); }} onToggle={() => {
        const id = frameKey(previewFrame);
        if (checkedFrames.has(id)) {
          // Resolve the next candidate before Approved only removes this one.
          const next = previewNav?.next ?? (previewMode === "selected" ? previewNav?.previous : undefined);
          if (next) setPreviewFrameId(frameKey(next));
        }
        toggleFrame(id);
      }} />}
    </div>
  );
}
