export type Studio = 'filmkraft' | 'screenbridge';

export type SessionStatus =
  | 'discovering'
  | 'awaiting_videos'
  | 'analyzing'
  | 'awaiting_stills'
  | 'exporting'
  | 'uploading'
  | 'done'
  | 'error'
  | 'skipped';

export interface Project {
  id: string;
  studio: Studio;
  name: string;
  status: string;
  code?: string;
  row: number;
  sourcePath?: string;
}

export interface Video {
  id: string;
  path: string;
  name: string;
  durationSec?: number;
  aspect?: string;
  codec?: string;
  format?: string;
  variant?: string;
  selected?: boolean;
  width?: number;
  height?: number;
  voiceover?: string;
  channel?: string;
}

export interface Frame {
  id: string;
  videoId: string;
  frameId: number;
  previewPath: string;
  previewUrl?: string;
  videoName?: string;
  timecode?: string;
  selected?: boolean;
}

export interface Naming {
  project: string;
  type: string;
  year?: string;
}

export interface Session {
  id: string;
  projectId: string;
  projectName: string;
  projectRow: number;
  studio: Studio;
  status: SessionStatus;
  videos: Video[];
  frames: Frame[];
  selectedVideoIds: string[];
  selectedFrameIds: string[];
  sourcePath?: string;
  manualSourcePath?: string;
  stagingPath?: string;
  destinationUrl?: string;
  destinationFolderId?: string;
  naming?: Naming;
  error?: string;
  message?: string;
  updatedAt: string;
  createdAt: string;
  manifestPath?: string;
  analyses?: unknown[];
  exports?: unknown[];
  uploadResults?: unknown[];
  lastPhase?: SessionStatus;
}

export interface AppConfig {
  googleClientId: string;
  sourceRoots: Record<Studio, string>;
  destinationFolders: Record<Studio, string>;
  extractExecutable?: string;
  renameExecutable?: string;
  renameScript?: string;
  pythonExecutable?: string;
  ffprobeExecutable?: string;
}

export interface AppState {
  accountEmail?: string;
  authenticated: boolean;
  configured: boolean;
  projects: Project[];
  sessions: Session[];
  currentSessionId?: string;
  sourceRoots: Record<Studio, string>;
  destinationFolders: Record<Studio, string>;
  error?: string;
}
