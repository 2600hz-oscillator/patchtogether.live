// packages/web/src/lib/video/worker/worker-bridge.ts
//
// Fix E Phase 1 — the MAIN-THREAD side of the render worker.
//
// Owns the Worker, the RPC send path, the inbound frame queue (latest-bitmap-
// wins per nodeId), lifecycle, AND the capability check + main-thread FALLBACK
// decision. When the flag is OFF or the runtime can't support a worker WebGL2
// context, `enabled` is false and the VideoEngine renders every node on the
// main thread exactly as today (byte-identical). When enabled, the engine
// installs a WorkerProxyHandle for `renderLocus:'worker'` nodes and forwards
// their add/remove/setParam/setResolution to this bridge.
//
// The bridge holds at most ONE pending bitmap per nodeId: a frame that arrives
// before the proxy handle's draw() drains the previous one REPLACES it (and
// closes the stale one) so we never queue-and-leak bitmaps under back-pressure.

import type { ModuleNode } from '$lib/graph/types';
import type { WorkerInboundMsg, WorkerOutboundMsg } from './protocol';

/** The Fix E worker flag, TRI-STATE (stack-study adoption item 1, PR V2):
 *  - 'on'      — explicitly enabled: EVERY worker-locus module uses the worker,
 *                including `renderLocus:'worker-experimental'` ones.
 *  - 'off'     — kill switch: nothing uses the worker (main render everywhere).
 *  - 'default' — nothing set: the worker is ON for parity-complete
 *                `renderLocus:'worker'` modules only (the production default
 *                since this PR; it was OFF-by-default while the co-processor
 *                soaked behind the flag).
 *  Precedence (first match wins):
 *  1. runtime override `globalThis.__videoWorkerEnabled` (e2e flips this via
 *     addInitScript BEFORE boot, or a dev pokes the console). `=== false`
 *     force-disables even if a build/URL said on.
 *  2. URL param `?videoworker=1` (or `=true`) → on, `=0`/`=false` → off. Lets a
 *     reviewer A/B the worker path by opening a link — no console, works on
 *     mobile. SSR-safe (guarded on `location`).
 *  3. prod/dev build flag `VITE_VIDEO_WORKER`: 'true' → on, 'false' → off.
 *  Otherwise 'default'. */
export type WorkerFlagState = 'on' | 'off' | 'default';

export function workerFlagState(): WorkerFlagState {
  const override = (globalThis as unknown as { __videoWorkerEnabled?: boolean })
    .__videoWorkerEnabled;
  if (override === true) return 'on';
  if (override === false) return 'off';
  try {
    if (typeof location !== 'undefined' && location.search) {
      const v = new URLSearchParams(location.search).get('videoworker');
      if (v === '1' || v === 'true') return 'on';
      if (v === '0' || v === 'false') return 'off';
    }
  } catch {
    // location / URLSearchParams unavailable (SSR / odd realm) — fall through.
  }
  try {
    const env = (import.meta as unknown as { env?: Record<string, string> }).env
      ?.VITE_VIDEO_WORKER;
    if (env === 'true') return 'on';
    if (env === 'false') return 'off';
  } catch {
    /* import.meta.env unavailable — fall through to default */
  }
  return 'default';
}

/** Back-compat boolean view: is the worker path enabled AT ALL? True for both
 *  'on' and 'default' (the default is ON as of PR V2); false only for the
 *  explicit kill switch. Per-module eligibility is workerLocusEligible. */
export function isWorkerFlagOn(): boolean {
  return workerFlagState() !== 'off';
}

/**
 * Per-module worker eligibility (pure — unit-testable without a Worker):
 *  - kill switch ('off') → never;
 *  - `renderLocus:'worker'` (parity-complete: acidwarp) → 'on' AND 'default';
 *  - `renderLocus:'worker-experimental'` (parity gaps: TOYBOX's video/image
 *    layers render black in the worker + no freeze-hook forwarding for its
 *    bespoke VRT; VFPGA's card polls `read('gateState')` per frame, which
 *    materializes + ticks a main-thread fallback → double render) → explicit
 *    'on' only;
 *  - anything else → never.
 */
export function workerLocusEligible(
  locus: 'main' | 'worker' | 'worker-experimental' | undefined,
  state: WorkerFlagState,
): boolean {
  if (state === 'off') return false;
  if (locus === 'worker') return true;
  if (locus === 'worker-experimental') return state === 'on';
  return false;
}

/** Static capability gate: does this realm even have the primitives the worker
 *  path needs? (A worker WebGL2 context is probed for real via the init
 *  handshake below — this is the cheap pre-check that avoids spawning a worker
 *  on a browser that obviously can't.) */
export function workerCapable(): boolean {
  return (
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof createImageBitmap !== 'undefined'
  );
}

export interface WorkerBridgeOpts {
  res: { width: number; height: number };
  /** Optional trace sink (Canvas threads its trace() here). */
  trace?: (msg: string) => void;
}

export class RenderWorkerBridge {
  private worker: Worker | null = null;
  /** True once the worker has reported a working WebGL2 context. Until then the
   *  engine still renders worker-locus nodes on main (fallback) — see ready(). */
  private workerGlOk = false;
  /** False permanently once the worker reports a dead GL context OR construction
   *  throws: the engine then keeps every node on the main thread. */
  private _supported: boolean;
  private disposed = false;
  private trace?: (msg: string) => void;
  private res: { width: number; height: number };

  /** Latest pending bitmap per nodeId (latest-wins; stale ones are closed). */
  private pending = new Map<string, ImageBitmap>();
  /** Nodes the bridge has been told about (so a re-init can replay them). */
  private knownNodes = new Map<string, ModuleNode>();
  /** Last determinism state forwarded to the worker ("<freeze>|<paused>"),
   *  so syncDeterminism only posts on change. */
  private lastDeterminismKey = '';

  constructor(opts: WorkerBridgeOpts) {
    this.res = { ...opts.res };
    this.trace = opts.trace;
    this._supported = workerCapable();
    if (!this._supported) {
      this.trace?.('[render-worker] unsupported runtime — main-thread fallback');
      return;
    }
    try {
      this.worker = new Worker(new URL('./render-worker.ts', import.meta.url), {
        type: 'module',
        name: 'video-render-worker',
      });
      this.worker.onmessage = (e: MessageEvent<WorkerOutboundMsg>) => this.onMessage(e.data);
      this.worker.onerror = (e) => {
        this.trace?.(`[render-worker] worker error: ${e.message} — main-thread fallback`);
        this.fail();
      };
      this.send({ type: 'init', res: this.res });
      // Forward the CURRENT determinism globals right away — e2e harnesses set
      // them via addInitScript BEFORE the app boots, and the worker's clock
      // must honor them from its very first frame.
      this.syncDeterminism();
    } catch (err) {
      this.trace?.(`[render-worker] construct failed: ${err instanceof Error ? err.message : err} — main-thread fallback`);
      this.fail();
    }
  }

  /** Whether the worker path is usable at all (capability + construction). The
   *  engine consults this WITH the flag to decide the install path. Note: even
   *  when supported, until the worker reports glOk the node renders on main —
   *  see ready(). */
  get supported(): boolean {
    return this._supported && !this.disposed;
  }

  /** Whether the worker has confirmed a live WebGL2 context. The engine's proxy
   *  handle only consumes worker frames once this is true; before then (and if
   *  it never becomes true) the proxy falls back to main-thread render. */
  ready(): boolean {
    return this.supported && this.workerGlOk;
  }

  // -------- lifecycle of a worker-resident node --------

  addNode(node: ModuleNode): void {
    if (!this.supported) return;
    // Store a plain snapshot — never a live Y proxy (structured-clone safe +
    // matches the cv-modulation render-local-clone discipline).
    this.knownNodes.set(node.id, snapshot(node));
    this.send({ type: 'addNode', node: snapshot(node) });
  }

  removeNode(nodeId: string): void {
    this.knownNodes.delete(nodeId);
    const stale = this.pending.get(nodeId);
    if (stale) { try { stale.close(); } catch { /* */ } this.pending.delete(nodeId); }
    if (!this.supported) return;
    this.send({ type: 'removeNode', nodeId });
  }

  setParam(nodeId: string, paramId: string, value: number): void {
    if (!this.supported) return;
    this.send({ type: 'setParam', nodeId, paramId, value });
  }

  setResolution(width: number, height: number): void {
    this.res = { width, height };
    if (!this.supported) return;
    this.send({ type: 'setResolution', width, height });
  }

  /**
   * Fix E Phase 2 — send a serialized TOYBOX state snapshot to the worker.
   * Called by the toybox main-thread wrapper whenever node.data changes so the
   * worker renderer picks up layer/combine/cvRoute edits without touching the
   * Yjs store or any DOM API. A no-op when the worker is not supported.
   */
  sendToyboxSync(nodeId: string, state: unknown): void {
    if (!this.supported) return;
    this.send({ type: 'toybox-sync', nodeId, state });
  }

  /**
   * DETERMINISM FORWARDING — the worker is a separate realm with its own
   * clock, so the main thread's e2e/VRT determinism globals
   * (`__videoEngineFreezeTime` pins the engine clock; `__videoEnginePause` /
   * `__videoEngineFreezeRender` stop per-frame draws) would otherwise be
   * invisible to worker-resident nodes and leave them animating under a
   * frozen harness. The VideoEngine calls this once per step() (cheap string
   * compare; posts only on CHANGE) and the constructor calls it once so
   * addInitScript-set hooks apply from the first worker frame.
   */
  syncDeterminism(): void {
    if (!this.supported) return;
    const g = globalThis as unknown as {
      __videoEngineFreezeTime?: unknown;
      __videoEnginePause?: unknown;
      __videoEngineFreezeRender?: unknown;
    };
    const freeze =
      typeof g.__videoEngineFreezeTime === 'number' && Number.isFinite(g.__videoEngineFreezeTime)
        ? (g.__videoEngineFreezeTime as number)
        : null;
    // Both pause (idle the loop) and freeze-render (skip draws) mean the same
    // thing to the worker: stop producing new frames.
    const paused = g.__videoEnginePause === true || g.__videoEngineFreezeRender === true;
    const key = `${freeze}|${paused}`;
    if (key === this.lastDeterminismKey) return;
    this.lastDeterminismKey = key;
    this.send({ type: 'determinism', freezeTimeSec: freeze, paused });
  }

  /** Drain (remove + return) the latest pending bitmap for a node, transferring
   *  ownership to the caller (the proxy handle uploads + closes it). Returns
   *  null when no fresh frame has arrived since the last drain. */
  takeFrame(nodeId: string): ImageBitmap | null {
    const bmp = this.pending.get(nodeId);
    if (!bmp) return null;
    this.pending.delete(nodeId);
    return bmp;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.send({ type: 'dispose' });
    for (const bmp of this.pending.values()) { try { bmp.close(); } catch { /* */ } }
    this.pending.clear();
    this.knownNodes.clear();
    if (this.worker) {
      // Give the worker a tick to process the dispose, then terminate.
      const w = this.worker;
      this.worker = null;
      try { w.terminate(); } catch { /* */ }
    }
    this.workerGlOk = false;
  }

  // -------- internals --------

  private onMessage(msg: WorkerOutboundMsg): void {
    if (this.disposed) {
      if (msg.type === 'frame') { try { msg.bitmap.close(); } catch { /* */ } }
      return;
    }
    switch (msg.type) {
      case 'ready': {
        this.workerGlOk = msg.glOk;
        if (!msg.glOk) {
          this.trace?.(`[render-worker] worker WebGL2 unavailable (${msg.initErr ?? '?'}) — main-thread fallback`);
          this.fail();
        } else {
          this.trace?.('[render-worker] worker WebGL2 ready');
          // Replay any nodes added before the worker confirmed ready.
          for (const node of this.knownNodes.values()) {
            this.send({ type: 'addNode', node });
          }
        }
        break;
      }
      case 'frame': {
        // Latest-wins: a not-yet-drained previous bitmap for this node is stale.
        if (!this.workerGlOk || !this.knownNodes.has(msg.nodeId)) {
          try { msg.bitmap.close(); } catch { /* */ }
          break;
        }
        const prev = this.pending.get(msg.nodeId);
        if (prev) { try { prev.close(); } catch { /* */ } }
        this.pending.set(msg.nodeId, msg.bitmap);
        break;
      }
    }
  }

  /** Permanently disable the worker path (the engine's already-installed proxy
   *  handles fall back to main render on their next draw via ready()===false). */
  private fail(): void {
    this._supported = false;
    this.workerGlOk = false;
    for (const bmp of this.pending.values()) { try { bmp.close(); } catch { /* */ } }
    this.pending.clear();
    if (this.worker) {
      try { this.worker.terminate(); } catch { /* */ }
      this.worker = null;
    }
  }

  private send(msg: WorkerInboundMsg): void {
    this.worker?.postMessage(msg);
  }
}

function snapshot(node: ModuleNode): ModuleNode {
  return {
    id: node.id,
    type: node.type,
    domain: node.domain,
    position: { ...node.position },
    params: { ...node.params },
    data: node.data ? { ...node.data } : undefined,
  };
}
