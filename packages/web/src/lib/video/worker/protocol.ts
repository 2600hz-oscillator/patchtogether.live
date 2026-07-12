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
/**
 * Fix E Phase 2 — TOYBOX state sync: main → worker.
 *
 * Carries a plain-JSON snapshot of the TOYBOX node's live state (layers +
 * combine graph + cvRoutes), sent from the main thread whenever node.data
 * changes. The worker-side TOYBOX renderer replaces its internal state from
 * this snapshot before the next draw cycle, so GL output reflects the user's
 * latest edits without needing Yjs or the SvelteKit store in the worker.
 *
 * `state` is deliberately `unknown` here (typed as ToyboxNodeData in the
 * main-thread sender + worker receiver) so this protocol file stays free of
 * the TOYBOX-specific type imports.
 */
export interface MsgToyboxSync {
  type: 'toybox-sync';
  nodeId: string;
  /** Serialized ToyboxNodeData as plain JSON (layers + combine + cvRoutes). */
  state: unknown;
}

/**
 * DETERMINISM FORWARDING (PR V2) — mirror the main thread's e2e/VRT
 * determinism hooks into the worker realm. The worker has its own clock and
 * render loop; without this a frozen/paused harness on the main thread would
 * leave worker-resident nodes free-running (nondeterministic pixels under
 * DRS/VRT). Sent by the bridge on construction and whenever the main-side
 * globals change (see RenderWorkerBridge.syncDeterminism).
 */
export interface MsgDeterminism {
  type: 'determinism';
  /** Pin the worker engine clock (ctx.time) to this value; null = live. */
  freezeTimeSec: number | null;
  /** Stop stepping/posting frames while true (main is paused or
   *  freeze-rendered). Already-posted frames remain valid. */
  paused: boolean;
}

export type WorkerInboundMsg =
  | MsgInit
  | MsgAddNode
  | MsgRemoveNode
  | MsgSetParam
  | MsgSetResolution
  | MsgDispose
  | MsgToyboxSync
  | MsgDeterminism;

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
