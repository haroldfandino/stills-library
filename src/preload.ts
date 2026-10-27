import { contextBridge, ipcRenderer } from 'electron';
import type { AppState, Studio } from './shared/contracts';

type Listener = (state: AppState) => void;

function invoke(method: string, ...args: unknown[]): Promise<unknown> {
  return ipcRenderer.invoke('stills:call', method, args);
}

const api = {
  retryBatch: () => invoke('retryBatch'),
  startBatch: () => invoke('startBatch', true),
  pauseBatch: () => invoke('pauseBatch'),
  getState: () => invoke('getState'),
  listProjects: () => invoke('listProjects'),
  prepare: (studio: Studio, id: string) => invoke('prepare', studio, id),
  approveVideos: (sessionId: string, videoIds: string[]) => invoke('approveVideos', sessionId, videoIds),
  approveStills: (sessionId: string, frameIds: string[], naming: {project: string; type: string; year: string}) =>
    invoke('approveStills', sessionId, frameIds, naming),
  getSession: (id: string) => invoke('getSession', id),
  skip: (id: string) => invoke('skip', id),
  resume: (id: string) => invoke('resume', id),
  setReviewed: (studio: Studio, id: string, reviewed: boolean) => invoke('setReviewed', studio, id, reviewed),
  reviewAgain: (id: string) => invoke('reviewAgain', id),
  configureGoogle: (clientId: string) => invoke('configureGoogle', clientId),
  importGoogleCredentials: () => invoke('importGoogleCredentials'),
  signIn: () => invoke('signIn'),
  signOut: () => invoke('signOut'),
  chooseRoots: (studio?: Studio) => invoke('chooseRoots', studio),
  chooseProjectSource: (sessionId: string) => invoke('chooseProjectSource', sessionId),
  setSource: (studio: Studio, folder: string) => invoke('setSource', studio, folder),
  openPath: (filePath: string) => invoke('openPath', filePath),
  revealPath: (filePath: string) => invoke('revealPath', filePath),
  openUrl: (url: string) => invoke('openUrl', url),
  onState: (listener: Listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: AppState) => listener(state);
    ipcRenderer.on('stills:state', wrapped);
    return () => ipcRenderer.removeListener('stills:state', wrapped);
  },
};

contextBridge.exposeInMainWorld('stills', api);
