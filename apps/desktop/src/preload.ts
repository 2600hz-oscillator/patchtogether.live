// patchtogether native shell — preload (P2, minimal ptNative surface).
//
// The web app must NEVER import Electron; this bridge is the only seam. The
// browser/e2e "simulated double" mirrors this exact shape (grown in later
// phases alongside presentTargets/slotBindings/helperStatus).

import { contextBridge, ipcRenderer } from 'electron';

export interface PtNative {
  nativeAvailable: () => boolean;
  shellVersion: () => string;
  onLoadPatchRequested: (cb: (filePath: string) => void) => void;
  quit: () => void;
}

const ptNative: PtNative = {
  nativeAvailable: () => true,
  shellVersion: () => process.env.npm_package_version ?? '0.1.0',
  onLoadPatchRequested: (cb) => {
    ipcRenderer.on('pt:load-patch-requested', (_event, filePath: string) => cb(filePath));
  },
  quit: () => {
    void ipcRenderer.invoke('pt:quit');
  },
};

contextBridge.exposeInMainWorld('ptNative', ptNative);
