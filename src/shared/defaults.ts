import type { AppConfig } from './contracts';

export const SHEETS = {
  filmkraft: '11kk_s8r-_dk1W3K8uudB1YtpMYh4LTlcHcFcq4O7Z6w',
  screenbridge: '15sS9pdgUTTVZp8t298bCvBKy0gLNpTIULUNCHQM0364',
} as const;

export const DEFAULT_CONFIG: AppConfig = {
  googleClientId: '',
  sourceRoots: {
    filmkraft: '/Volumes/filmkraft/filespace/Filmkraft',
    screenbridge: '/Volumes/filmkraft/filespace/Screenbridge',
  },
  destinationFolders: {
    filmkraft: '1DQr_5OSdnZluCyACHdaSLoQsp2sOBp2S',
    screenbridge: '1Pdz7dsMmzXGoF5Sx6-q8z1wEudvQDWCS',
  },
  ffprobeExecutable: 'ffprobe',
};

export const PILOT_ORDER = [
  { studio: 'screenbridge', code: '203SB' },
  { studio: 'filmkraft', code: '1289' },
] as const;
