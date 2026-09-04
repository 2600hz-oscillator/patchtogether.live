// patchtogether native shell — preload (P2 surface + P3 helperStatus).
//
// The web app must NEVER import Electron; this bridge is the only seam. The
// browser/e2e "simulated double" mirrors this exact shape (grown in later
// phases alongside presentTargets/slotBindings).

import { contextBridge, ipcRenderer } from 'electron';
import type { HelperStatus } from './supervisor';

export interface HelperStatusSnapshot {
  current: HelperStatus[];
  /** Bounded per-helper transition history — late subscribers (the pre-flight
   *  UI booting after the supervisors, or the harness) miss nothing. */
  history: HelperStatus[];
}

export interface PtNative {
  nativeAvailable: () => boolean;
  shellVersion: () => string;
  onLoadPatchRequested: (cb: (filePath: string) => void) => void;
  quit: () => void;
  helperStatus: {
    get: () => Promise<HelperStatusSnapshot>;
    /** Live status pushes. Returns an unsubscribe. Crash-loop arrives here as
     *  state 'crash-looped' — a RED STATUS ROW, never a modal. */
    subscribe: (cb: (status: HelperStatus) => void) => () => void;
  };
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
  helperStatus: {
    get: () => ipcRenderer.invoke('pt:helper-status') as Promise<HelperStatusSnapshot>,
    subscribe: (cb) => {
      const listener = (_event: unknown, status: HelperStatus) => cb(status);
      ipcRenderer.on('pt:helper-status-changed', listener);
      return () => ipcRenderer.removeListener('pt:helper-status-changed', listener);
    },
  },
};

contextBridge.exposeInMainWorld('ptNative', ptNative);
