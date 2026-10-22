import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { AppState, Frame, Project } from "./bridge";
import { getBridge } from "./bridge";

type QueueFilter = "All" | "To Do" | "In Process" | "Done" | "Skip";

const FILTERS: QueueFilter[] = ["All", "To Do", "In Process", "Done", "Skip"];
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
  const minutes = Math.floor(value / 60);
  const seconds = Math.round(value % 60);
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
  return years.size === 1 ? [...years][0] : String(new Date().getFullYear());
}

function frameKey(frame: Frame): string {
  if (frame.id.includes(":")) return frame.id;
  return frame.videoId ? `${frame.videoId}:${frame.id}` : frame.id;
}

function phaseLabel(status?: string): string {
  switch (status) {
    case "discovering": return "Finding delivery videos";
    case "awaiting_videos": return "Video review";
    case "analyzing": return "Analyzing shots";
    case "awaiting_stills": return "Stills review";
    case "exporting": return "Exporting PNGs";
    case "uploading": return "Uploading to Drive";
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
  if (status === "done" || status === "Done") return "done";
  if (status === "error") return "error";
  if (status === "skipped" || status === "Skip") return "muted";
  if (status === "awaiting_videos" || status === "awaiting_stills") return "review";
  if (status === "To Do") return "todo";
  return "active";
}

function priority(project: Project): number {
  const name = `${project.id} ${project.name}`.toLowerCase();
  if (name.includes("airwaav")) return 0;
  if (name.includes("net32")) return 1;
  return 2;
}

function FrameImage({ frame }: { frame: Frame }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [frame.previewUrl]);
  return frame.previewUrl && !failed ? (
    <img src={frame.previewUrl} alt={`Candidate frame ${frame.id}`} onError={() => setFailed(true)} />
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

export default function App() {
  const bridge = useMemo(getBridge, []);
  const [state, setState] = useState<AppState>({});
  const [initializing, setInitializing] = useState(true);
  const [selectedKey, setSelectedKey] = useState<string>();
  const [filter, setFilter] = useState<QueueFilter>("All");
  const [search, setSearch] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [clientId, setClientId] = useState("");
  const [busy, setBusy] = useState<string>();
  const [uiError, setUiError] = useState<string>();
  const [checkedVideos, setCheckedVideos] = useState<Set<string>>(new Set());
  const [checkedFrames, setCheckedFrames] = useState<Set<string>>(new Set());
  const [projectTag, setProjectTag] = useState("");
  const [typeTag, setTypeTag] = useState("");
  const [yearTag, setYearTag] = useState("");

  const refresh = useCallback(async () => {
    if (!bridge) return;
    const next = await bridge.getState();
    let projects = next.projects;
    try {
      const listed = await bridge.listProjects();
      if (Array.isArray(listed)) projects = listed;
    } catch (error) {
      if (next.authenticated || (projects?.length ?? 0) > 0) throw error;
    }
    setState((previous) => ({ ...previous, ...next, projects: projects ?? previous.projects }));
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

  const projects = useMemo(() => [...(state.projects ?? [])].sort((a, b) => {
    const byPriority = priority(a) - priority(b);
    return byPriority || a.name.localeCompare(b.name);
  }), [state.projects]);

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

  const session = useMemo(() => {
    if (!selectedProject) return undefined;
    return (state.sessions ?? []).find((item) => item.projectId === selectedProject.id && item.studio === selectedProject.studio);
  }, [selectedProject, state.sessions]);

  const videoSeed = (session?.videos ?? []).map((video) => `${video.id}:${video.selected ? 1 : 0}`).join("|");
  const frameSeed = (session?.frames ?? []).map((frame) => `${frameKey(frame)}:${frame.selected === false ? 0 : 1}`).join("|");

  useEffect(() => {
    setCheckedVideos(new Set((session?.videos ?? []).filter((video) => video.selected).map((video) => video.id)));
  }, [session?.id, videoSeed]);

  useEffect(() => {
    setCheckedFrames(new Set((session?.frames ?? []).filter((frame) => frame.selected !== false).map(frameKey)));
  }, [session?.id, frameSeed]);

  useEffect(() => {
    setProjectTag(session?.naming?.project ?? selectedProject?.name ?? "");
    setTypeTag(session?.naming?.type ?? "");
    setYearTag(session?.naming?.year ?? suggestedYear(selectedProject?.name));
  }, [session?.id, session?.status, selectedProject?.name]);

  const visibleProjects = projects.filter((project) => {
    if (filter !== "All" && project.status !== filter) return false;
    const query = search.trim().toLowerCase();
    return !query || `${project.name} ${project.code ?? ""} ${project.id} ${project.studio}`.toLowerCase().includes(query);
  });
  const counts = Object.fromEntries(FILTERS.map((item) => [item, item === "All" ? projects.length : projects.filter((project) => project.status === item).length]));
  const frameSelections = (session?.frames ?? []).filter((frame) => checkedFrames.has(frameKey(frame))).map(frameKey);
  const normalizedProjectTag = formatTag(projectTag);
  const normalizedTypeTag = formatTag(typeTag);
  const namingReady = Boolean(normalizedProjectTag && normalizedTypeTag && /^20\d{2}$/.test(yearTag));

  const perform = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    setUiError(undefined);
    try {
      await action();
      await refresh();
    } catch (error) {
      setUiError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(undefined);
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
          targetId = updated.sessions?.find((item) => item.projectId === selectedProject.id && item.studio === selectedProject.studio)?.id;
        }
      }
      if (!targetId) throw new Error("The project session could not be created.");
      await bridge.skip(targetId);
    });
  };

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

      {settingsOpen && (
        <section className="settings-panel" aria-label="App setup">
          <div className="settings-intro"><span className="eyebrow">WORKSPACE SETUP</span><h2>Connect your sources</h2><p>Use the project account and choose the local source roots on this computer.</p></div>
          <div className="settings-grid">
            <div className="settings-card">
              <span className="settings-number">01</span><h3>Google account</h3>
              <p>{state.accountEmail ? `Connected as ${state.accountEmail}` : "Sign in as harold@filmkraft.tv to access the Stills sheets and Drive destinations."}</p>
              <div className="settings-form"><input aria-label="Google OAuth client ID" type="text" value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder="Desktop OAuth client ID" />
                <ActionButton onClick={() => bridge && void perform("Saving Google setup", () => bridge.configureGoogle(clientId.trim()))} disabled={!bridge || !clientId.trim() || Boolean(busy)}>Save ID</ActionButton></div>
              <ActionButton variant="primary" onClick={() => bridge && void perform("Signing in", () => bridge.signIn())} disabled={!bridge || Boolean(busy)}>Sign in with Google ↗</ActionButton>
            </div>
            <div className="settings-card"><span className="settings-number">02</span><h3>Local source folders</h3>
              {Object.keys(state.sourceRoots ?? {}).length ? <div className="root-list">{Object.entries(state.sourceRoots ?? {}).map(([studio, path]) => <div className="root-item" key={studio}><strong>{studio}</strong><span title={path}>{path}</span></div>)}</div> : <p>Choose the Filmkraft and Screenbridge source folders before preparing a project.</p>}
              <div className="root-actions"><ActionButton onClick={() => bridge && void perform("Choosing Filmkraft folder", () => bridge.chooseRoots("filmkraft"))} disabled={!bridge || Boolean(busy)}>Choose Filmkraft</ActionButton><ActionButton onClick={() => bridge && void perform("Choosing Screenbridge folder", () => bridge.chooseRoots("screenbridge"))} disabled={!bridge || Boolean(busy)}>Choose Screenbridge</ActionButton></div>
            </div>
          </div>
        </section>
      )}

      <div className="workspace">
        <aside className="queue-panel">
          <div className="queue-heading"><span className="eyebrow">PROJECTS</span><h1>Review queue</h1><p>One project at a time, with your approval before each handoff.</p></div>
          <div className="queue-stat-row"><div><strong>{counts["To Do"] ?? 0}</strong><span>To do</span></div><div><strong>{counts["In Process"] ?? 0}</strong><span>In process</span></div><div><strong>{counts.Done ?? 0}</strong><span>Done</span></div></div>
          <input className="queue-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search projects" aria-label="Search projects" />
          <div className="filter-row" aria-label="Filter projects">{FILTERS.map((item) => <button type="button" key={item} onClick={() => setFilter(item)} className={`filter-pill ${filter === item ? "selected" : ""}`}>{item} <span>{counts[item] ?? 0}</span></button>)}</div>
          <div className="project-list" aria-label="Projects">
            {visibleProjects.length ? visibleProjects.map((project) => {
              const selected = selectedProject && projectKey(project) === projectKey(selectedProject);
              const projectSession = (state.sessions ?? []).find((item) => item.projectId === project.id && item.studio === project.studio);
              return <button type="button" key={projectKey(project)} className={`project-row ${selected ? "selected" : ""}`} onClick={() => setSelectedKey(projectKey(project))}>
                <span className="project-row-top"><span className="studio-label">{STUDIO_LABEL[project.studio] ?? project.studio}</span><span className={`status-mini ${statusClass(projectSession?.status ?? project.status)}`}>{projectSession ? phaseLabel(projectSession.status) : projectStatusLabel(project.status)}</span></span>
                <strong>{project.name}</strong><span className="project-row-bottom">{project.code || project.id}<span aria-hidden="true">↗</span></span>
              </button>;
            }) : <div className="empty-queue">{initializing ? "Loading projects…" : projects.length ? "No projects match this filter." : "No projects loaded yet. Connect Google in Setup, then refresh."}</div>}
          </div>
          <div className="queue-footer"><span>Source rows marked <strong>To Do</strong> are eligible.</span></div>
        </aside>

        <main className="main-panel">
          {(uiError || state.error) && <div className="alert alert-error" role="alert"><strong>Action needed</strong><span>{uiError || state.error}</span><button type="button" onClick={() => setUiError(undefined)} aria-label="Dismiss error">×</button></div>}
          {busy && <div className="busy-banner" role="status"><span className="spinner" /> {busy}…</div>}
          {selectedProject ? (
            <>
              <div className="project-header">
                <div className="project-title"><div className="eyebrow">{selectedProject.studio.toUpperCase()} <span className="crumb">/</span> {selectedProject.code || selectedProject.id}</div><h2>{selectedProject.name}</h2><div className="project-meta"><span className={`status-chip ${statusClass(session?.status ?? selectedProject.status)}`}>{session ? phaseLabel(session.status) : projectStatusLabel(selectedProject.status)}</span><span>Sheet status: {projectStatusLabel(selectedProject.status)}</span></div>{session?.manualSourcePath && <div className="source-confirmation" title={session.manualSourcePath}>Selected source: {session.manualSourcePath}</div>}</div>
                <div className="project-tools">
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

              {!session && <section className="hero-card"><div className="hero-icon">▣</div><span className="eyebrow">READY TO BEGIN</span><h3>Prepare this project</h3><p>We’ll locate its delivery videos and propose the best cuts for your review. Nothing is exported until you approve.</p><div className="hero-actions"><ActionButton variant="primary" onClick={() => bridge && void perform("Preparing project", () => bridge.prepare(selectedProject.studio, selectedProject.id))} disabled={!bridge || Boolean(busy) || selectedProject.status === "Done" || selectedProject.status === "Skip"}>Prepare project <span aria-hidden="true">→</span></ActionButton>{selectedProject.status === "To Do" && <ActionButton variant="quiet" onClick={skipProject} disabled={!bridge || Boolean(busy)}>Skip project</ActionButton>}</div></section>}

              {session?.status === "awaiting_videos" && <section className="review-section"><div className="section-heading"><div><span className="eyebrow">APPROVAL 01 / 02</span><h3>Choose videos</h3><p>Every discovered delivery file is listed below. The suggested cuts are preselected; adjust them before analysis.</p></div><div className="selection-count"><strong>{checkedVideos.size}</strong><span>of {session.videos?.length ?? 0} selected</span></div></div>
                {session.manualSourcePath && <div className="source-review-note"><strong>Manually selected source</strong><span>{session.manualSourcePath}</span><small>Confirm these videos belong to this Stills row before approval.</small></div>}
                {session.videos?.length ? <div className="video-list">{session.videos.map((video) => <label className={`video-row ${checkedVideos.has(video.id) ? "checked" : ""}`} key={video.id}><input type="checkbox" checked={checkedVideos.has(video.id)} onChange={() => setCheckedVideos((previous) => { const next = new Set(previous); if (next.has(video.id)) next.delete(video.id); else next.add(video.id); return next; })} /><span className="custom-check" aria-hidden="true">✓</span><span className="video-content"><span className="video-top"><strong title={video.path}>{video.name || shortName(video.path)}</strong>{video.selected && <em>Suggested</em>}</span><span className="video-details"><span>{durationLabel(video.durationSec)}</span><span>{video.aspect || "Aspect unknown"}</span><span>{video.codec || video.format || "Format unknown"}</span>{video.width && video.height && <span>{video.width} × {video.height}</span>}{video.variant && <span>{video.variant}</span>}{video.channel && <span>{video.channel}</span>}{video.voiceover && <span>{video.voiceover}</span>}</span><span className="video-path" title={video.path}>{video.path}</span></span><button className="row-open" type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); openPath(video.path); }} title="Open video in Finder or Explorer" aria-label={`Open ${video.name || shortName(video.path)}`}>↗</button></label>)}</div> : <div className="empty-state"><strong>No videos found</strong><p>Check the delivery folder or source-root setup, then resume the scan.</p></div>}
                <div className="review-footer"><span>Analysis begins only for the checked videos.</span><div><ActionButton variant="quiet" onClick={skipProject} disabled={Boolean(busy)}>Skip project</ActionButton><ActionButton variant="primary" onClick={() => bridge && void perform("Analyzing selected videos", () => bridge.approveVideos(session.id, [...checkedVideos]))} disabled={!bridge || !checkedVideos.size || Boolean(busy)}>Approve {checkedVideos.size} {checkedVideos.size === 1 ? "video" : "videos"} <span aria-hidden="true">→</span></ActionButton></div></div>
              </section>}

              {session?.status === "awaiting_stills" && <section className="review-section"><div className="section-heading"><div><span className="eyebrow">APPROVAL 02 / 02</span><h3>Choose stills</h3><p>One smart pick per shot is preselected. Add or remove frames, then review the filenames before export.</p></div><div className="selection-count"><strong>{frameSelections.length}</strong><span>of {session.frames?.length ?? 0} selected</span></div></div>
                {session.error && <div className="review-alert" role="alert"><strong>Delivery paused</strong><span>{session.error}</span></div>}
                {session.frames?.length ? <div className="frame-grid">{session.frames.map((frame, index) => { const key = frameKey(frame); return <label className={`frame-card ${checkedFrames.has(key) ? "checked" : ""}`} key={key}><input type="checkbox" checked={checkedFrames.has(key)} onChange={() => setCheckedFrames((previous) => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; })} /><div className="frame-image"><FrameImage frame={frame} /><span className="frame-check" aria-hidden="true">✓</span></div><div className="frame-info"><strong>{frame.shot !== undefined || frame.shotId !== undefined ? `Shot ${frame.shot ?? frame.shotId}` : `Frame ${index + 1}`}</strong><span>{frame.timecode || (frame.timestampSec !== undefined ? durationLabel(frame.timestampSec) : "Time unknown")}</span></div><div className="frame-video" title={frame.videoName}>{frame.videoName || (session.videos ?? []).find((video) => video.id === frame.videoId)?.name || "Selected video"}</div></label>; })}</div> : <div className="empty-state"><strong>No candidate frames</strong><p>Resume analysis or inspect the selected video files.</p></div>}
                <div className="naming-panel"><div className="naming-heading"><span className="eyebrow">FILENAME REVIEW</span><h4>Set the naming tags</h4><p>Preview of the PNG names that will be uploaded to Drive.</p></div><div className="naming-fields"><label>Project tag<input value={projectTag} onChange={(event) => setProjectTag(event.target.value)} placeholder="Airwaav_Brager" /></label><label>Type tag<input value={typeTag} onChange={(event) => setTypeTag(event.target.value)} placeholder="Campaign" /></label><label>Delivery year<input value={yearTag} onChange={(event) => setYearTag(event.target.value)} placeholder="2026" inputMode="numeric" maxLength={4} /></label></div><div className="destination-preview">Drive destination <strong>01_Stills / {/^20\d{2}$/.test(yearTag) ? yearTag : "valid year required"} / {selectedProject.name}</strong></div><div className="filename-list">{namingReady && frameSelections.length ? frameSelections.slice(0, 5).map((id, index) => <div key={id}><span>{String(index + 1).padStart(2, "0")}</span><code>{normalizedProjectTag}_{normalizedTypeTag}_Still_{String(index + 1).padStart(2, "0")}.png</code></div>) : <p>Choose a frame, fill both tags, and enter a 20xx delivery year to preview filenames.</p>}{frameSelections.length > 5 && <small>+ {frameSelections.length - 5} more PNGs</small>}</div></div>
                <div className="review-footer"><span>Approved frames are exported as PNGs, renamed in staging, and uploaded.</span><div><ActionButton variant="quiet" onClick={skipProject} disabled={Boolean(busy)}>Skip project</ActionButton><ActionButton variant="primary" onClick={() => bridge && void perform("Exporting approved stills", () => bridge.approveStills(session.id, frameSelections, { project: normalizedProjectTag, type: normalizedTypeTag, year: yearTag }))} disabled={!bridge || !frameSelections.length || !namingReady || Boolean(busy)}>Approve & deliver <span aria-hidden="true">→</span></ActionButton></div></div>
              </section>}

              {["discovering", "analyzing", "exporting", "uploading"].includes(session?.status ?? "") && <section className="hero-card progress-card"><div className="large-spinner" /><span className="eyebrow">WORK IN PROGRESS</span><h3>{phaseLabel(session?.status)}</h3><p>{session?.message || (session?.status === "discovering" ? "Scanning the project delivery folders for videos." : session?.status === "analyzing" ? "Extract Stills is finding strong frames from the approved videos." : "The approved stills are being prepared and delivered.")}</p>{session?.totalCount !== undefined && <div className="progress-numbers">{session.uploadedCount ?? 0} / {session.totalCount} files</div>}</section>}

              {session?.status === "error" && <section className="hero-card error-card"><div className="hero-icon">!</div><span className="eyebrow">NEEDS ATTENTION</span><h3>Project paused</h3><p>{session.error || session.message || "The workflow stopped before delivery. Review the source and staging folders, then resume."}</p><div className="hero-actions">{session.lastPhase === "discovering" && <ActionButton onClick={() => bridge && void perform("Choosing project folder", () => bridge.chooseProjectSource(session.id))} disabled={!bridge || Boolean(busy)}>Choose source folder</ActionButton>}<ActionButton variant="primary" onClick={() => bridge && void perform("Resuming project", () => bridge.resume(session.id))} disabled={!bridge || Boolean(busy)}>Resume project →</ActionButton><ActionButton variant="quiet" onClick={skipProject} disabled={Boolean(busy)}>Skip project</ActionButton></div></section>}

              {session?.status === "done" && <section className="hero-card completion-card"><div className="hero-icon">✓</div><span className="eyebrow">DELIVERY VERIFIED</span><h3>Project complete</h3><p>{session.message || "The approved PNGs are in the project’s Drive folder, and the Stills row is marked Done."}</p><div className="hero-actions"><ActionButton variant="primary" onClick={() => openUrl(session.destinationUrl || selectedProject.destinationUrl)} disabled={!session.destinationUrl && !selectedProject.destinationUrl}>Open Drive folder ↗</ActionButton></div></section>}

              {session?.status === "skipped" && <section className="hero-card"><div className="hero-icon">—</div><span className="eyebrow">SKIPPED BY REVIEWER</span><h3>Project skipped</h3><p>This project’s Stills row is marked Skip. Select another project from the queue.</p></section>}

              {session && !["discovering", "awaiting_videos", "awaiting_stills", "analyzing", "exporting", "uploading", "done", "error", "skipped"].includes(session.status) && <section className="hero-card"><span className="eyebrow">CURRENT STATE</span><h3>{phaseLabel(session.status)}</h3><p>{session.message || "The workflow is preparing this project."}</p><ActionButton variant="primary" onClick={() => bridge && void perform("Resuming project", () => bridge.resume(session.id))} disabled={!bridge || Boolean(busy)}>Resume project →</ActionButton></section>}
            </>
          ) : <section className="welcome-panel"><span className="welcome-symbol">▣</span><span className="eyebrow">STILLS LIBRARY</span><h2>{initializing ? "Loading projects…" : "Ready when you are"}</h2><p>{initializing ? "Reading your project queue." : "Connect Google and choose your source folders in Setup, then refresh the queue."}</p><ActionButton variant="primary" onClick={() => setSettingsOpen(true)}>Open setup →</ActionButton></section>}
        </main>
      </div>
    </div>
  );
}
