export const SOURCE_CONFIG = {
  filmkraft: {
    label: 'Filmkraft',
    spreadsheetId: '11kk_s8r-_dk1W3K8uudB1YtpMYh4LTlcHcFcq4O7Z6w',
    destinationFolderId: '1DQr_5OSdnZluCyACHdaSLoQsp2sOBp2S',
  },
  screenbridge: {
    label: 'Screenbridge',
    spreadsheetId: '15sS9pdgUTTVZp8t298bCvBKy0gLNpTIULUNCHQM0364',
    destinationFolderId: '1Pdz7dsMmzXGoF5Sx6-q8z1wEudvQDWCS',
  },
} as const;

export type SourceKey = keyof typeof SOURCE_CONFIG;
export type SourceConfig = { label: string; spreadsheetId: string; destinationFolderId: string };
export type SourceConfigs = Record<SourceKey, SourceConfig>;
export type ProjectStatus = 'To Do' | 'In Process' | 'Done' | 'Reviewed' | 'Skip';

export interface ProjectRow {
  source: SourceKey;
  rowNumber: number;
  name: string;
  status: string;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  /** Drive's per-app grant, independent of what read-only metadata scopes reveal. */
  isAppAuthorized?: boolean;
  appProperties?: Record<string, string>;
  parents?: string[];
  size?: string;
  md5Checksum?: string;
  webViewLink?: string;
  driveId?: string;
  capabilities?: { canEdit?: boolean; canAddChildren?: boolean; canListChildren?: boolean };
}

export interface RootVerification {
  source: SourceKey;
  sheetOk: boolean;
  folderOk: boolean;
  folderName?: string;
  sheetError?: string;
  folderError?: string;
  requiresPicker: boolean;
}

export class GoogleApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly endpoint?: string;

  constructor(message: string, status: number, code = 'google_api_error', endpoint?: string) {
    super(message);
    this.name = 'GoogleApiError';
    this.status = status;
    this.code = code;
    this.endpoint = endpoint;
  }
}

export class GoogleConflictError extends GoogleApiError {
  constructor(message: string) {
    super(message, 409, 'conflict');
    this.name = 'GoogleConflictError';
  }
}
