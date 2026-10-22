export type Studio = "filmkraft" | "screenbridge" | (string & {});

export type ProjectStatus = "To Do" | "In Process" | "Done" | "Skip" | (string & {});

export interface Project {
  id: string;
  studio: Studio;
  name: string;
  status: ProjectStatus;
  code?: string;
  sourcePath?: string;
  destinationUrl?: string;
  sheetRow?: number;
}

export interface Video {
  id: string;
  path: string;
  name?: string;
  durationSec?: number;
  aspect?: string;
  codec?: string;
  format?: string;
  variant?: string;
  voiceover?: string;
  channel?: string;
  width?: number;
  height?: number;
  selected?: boolean;
}

export interface Frame {
  id: string;
  videoId?: string;
  previewUrl?: string;
  previewPath?: string;
  shot?: string | number;
  shotId?: number;
  timecode?: string;
  timestampSec?: number;
  score?: number;
  videoName?: string;
  selected?: boolean;
}

export type SessionStatus =
  | "awaiting_videos"
  | "analyzing"
  | "awaiting_stills"
  | "exporting"
  | "uploading"
  | "done"
  | "error"
  | "skipped"
  | (string & {});

export interface Session {
  id: string;
  projectId: string;
  projectName?: string;
  studio: Studio;
  status: SessionStatus;
  videos?: Video[];
  frames?: Frame[];
  sourcePath?: string;
  manualSourcePath?: string;
  stagingPath?: string;
  destinationUrl?: string;
  error?: string;
  message?: string;
  lastPhase?: SessionStatus;
  naming?: { project?: string; type?: string; year?: string };
  uploadedCount?: number;
  totalCount?: number;
}

export interface AppState {
  accountEmail?: string;
  authenticated?: boolean;
  configured?: boolean;
  projects?: Project[];
  sessions?: Session[];
  currentSessionId?: string;
  sourceRoots?: Record<string, string>;
  error?: string;
}

export interface StillsApi {
  getState(): Promise<AppState>;
  listProjects(): Promise<Project[]>;
  prepare(studio: Studio, id: string): Promise<Session | AppState | void>;
  approveVideos(sessionId: string, videoIds: string[]): Promise<unknown>;
  approveStills(
    sessionId: string,
    frameSelections: string[],
    naming: { project: string; type: string; year?: string },
  ): Promise<unknown>;
  skip(sessionId: string): Promise<unknown>;
  resume(sessionId: string): Promise<unknown>;
  openPath(path: string): Promise<unknown>;
  openUrl(url: string): Promise<unknown>;
  chooseRoots(studio?: Studio): Promise<unknown>;
  chooseProjectSource(sessionId: string): Promise<unknown>;
  signIn(): Promise<unknown>;
  configureGoogle(clientId: string): Promise<unknown>;
  onState(callback: (state: AppState) => void): void | (() => void);
}

export function getBridge(): StillsApi | undefined {
  return (window as Window & { stills?: StillsApi }).stills;
}
