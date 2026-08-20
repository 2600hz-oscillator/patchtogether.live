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

/**
 * #1905 — HANDSHAKE TRACE REQUEST. Ask the worker for a snapshot of its own
 * init/attach/produce state. Request/response (rather than a periodic push) so
 * a dead worker costs nothing and — crucially — so NO REPLY is itself a
 * reading: a worker whose MESSAGE loop is wedged cannot answer, while a worker
 * whose RENDER loop died answers with a frozen `loopTicks` and a `lastError`.
 * Those two are opposite facts that a frame counter reports identically (as 0).
 */
export interface MsgTraceRequest {
  type: 'trace-request';
  /** Correlates the reply; a stale reply to an abandoned request is dropped. */
  seq: number;
}

export type WorkerInboundMsg =
  | MsgInit
  | MsgAddNode
  | MsgRemoveNode
  | MsgSetParam
  | MsgSetResolution
  | MsgDispose
  | MsgToyboxSync
  | MsgDeterminism
  | MsgTraceRequest;

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

/**
 * #1905 — per-node production state inside the worker.
 *
 * `drawn` vs `posted` vs `withheld` is the whole point: before this existed,
 * "the OUTPUT is black" collapsed four distinct states into one number.
 *   - drawn 0                     → the node was never attached / never stepped
 *   - drawn > 0, posted 0         → attached and drawing, WITHHELD (no content
 *                                   yet — an async shader/asset is still in
 *                                   flight, or failed: read `contentNote`)
 *   - posted > 0, black on screen → the picture itself is black (a real render
 *                                   bug, not a handshake one)
 */
export interface WorkerNodeTrace {
  id: string;
  /** ms (worker clock) at which the node was materialized. */
  addedAt: number;
  /** surface.draw() calls that returned without throwing. */
  drawn: number;
  /** frames transferred to the main thread. */
  posted: number;
  /** frames NOT transferred because the node reported no content yet. */
  withheld: number;
  /** ms at which the node first reported content — null while still warming. */
  firstContentAt: number | null;
  /** The node's own words for why it is withholding (e.g. which asset is in
   *  flight, or which one failed). Null when the node exposes no reason. */
  contentNote: string | null;
  /** surface.draw() throws swallowed by the per-node guard in step(). */
  drawErrors: number;
}

/**
 * #1905 — the worker's half of the handshake, as state rather than as silence.
 */
export interface WorkerTraceSnapshot {
  /** Worker-realm performance.now() when the snapshot was taken. */
  now: number;
  /** ms at which the init message was handled; null = init never arrived. */
  initAt: number | null;
  /** ms at which WebGL2 came up; null with a non-null initAt = GL failed. */
  glOkAt: number | null;
  /** Init failure text (mirrors MsgReady.initErr). */
  glError: string | null;
  /** RENDER-LOOP HEARTBEAT. Two traces with an identical value = the loop is
   *  DEAD. Before #1905 a dead loop and a never-started one were both "no
   *  frames", and a single throw inside loop() produced the first silently. */
  loopTicks: number;
  lastTickAt: number | null;
  /** Throws caught by the loop guard. Non-zero means the loop WOULD have died. */
  loopErrors: number;
  lastError: string | null;
  /** Determinism forwarding state (a paused worker posts no frames BY DESIGN —
   *  without this, "paused" reads exactly like "broken"). */
  paused: boolean;
  frozenTimeSec: number | null;
  nodes: WorkerNodeTrace[];
}

export interface MsgTrace {
  type: 'trace';
  seq: number;
  snapshot: WorkerTraceSnapshot;
}

export type WorkerOutboundMsg = MsgReady | MsgFrame | MsgTrace;
