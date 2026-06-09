// packages/web/src/lib/video/worker/protocol.ts
//
// Fix E Phase 1 — the postMessage RPC contract between the MAIN-thread
// worker-bridge and the render worker. Kept in one file so both sides share a
// single source of truth (a drift here = silently-dropped frames).
//
// Control flows main → worker as plain JSON (low rate — addNode/removeNode/
// setParam/setResolution/dispose). Finished frames flow worker → main as
// transferred ImageBitmaps (zero-copy, latest-wins per nodeId).

import type { ModuleNode } from '$lib/graph/types';

// ---- main → worker ----

export interface MsgInit {
  type: 'init';
  res: { width: number; height: number };
}
export interface MsgAddNode {
  type: 'addNode';
  /** A plain snapshot of the node (id/type/params) — never a live Y proxy. */
  node: ModuleNode;
}
export interface MsgRemoveNode {
  type: 'removeNode';
  nodeId: string;
}
export interface MsgSetParam {
  type: 'setParam';
  nodeId: string;
  paramId: string;
  value: number;
}
export interface MsgSetResolution {
  type: 'setResolution';
  width: number;
  height: number;
}
export interface MsgDispose {
  type: 'dispose';
}

export type WorkerInboundMsg =
  | MsgInit
  | MsgAddNode
  | MsgRemoveNode
  | MsgSetParam
  | MsgSetResolution
  | MsgDispose;

// ---- worker → main ----

export interface MsgReady {
  type: 'ready';
  /** Whether OffscreenCanvas + WebGL2 init succeeded in the worker. When
   *  false, the bridge tears the worker down and the engine renders the node
   *  on the main thread (the mandatory fallback). */
  glOk: boolean;
  /** Init error text when glOk is false (surfaced in the bridge trace). */
  initErr?: string;
}
export interface MsgFrame {
  type: 'frame';
  nodeId: string;
  /** Transferred ImageBitmap of the node's finished frame. The bitmap is in
   *  the transfer list, so it's moved (zero-copy) — the worker no longer owns
   *  it after posting. The main side MUST `close()` it after upload. */
  bitmap: ImageBitmap;
}

export type WorkerOutboundMsg = MsgReady | MsgFrame;
