// packages/web/src/lib/video/worker/render-worker.ts
//
// Fix E Phase 1 — the RENDER WORKER entry point.
//
// A Vite *module* worker (`new Worker(new URL('./render-worker.ts',
// import.meta.url), { type: 'module' })`) so it can statically import the
// worker-eligible module factories (Phase 1 = acidwarp) and instantiate them in
// its own OffscreenCanvas + WebGL2 context. It is a TEXTURE CO-PROCESSOR, not a
// replacement engine: it renders ONLY the opted-in pure-GL nodes the main
// thread forwards, and posts each finished frame back as a transferred
// ImageBitmap. The main VideoEngine, its OffscreenCanvas, blit, rAF, and all
// preview cards stay completely unchanged.
//
// Proven path (Phase 0 spike, branch spike/offscreen-canvas-worker): worker
// OffscreenCanvas + WebGL2 renders non-black under CI SwiftShader and the
// transferToImageBitmap round-trip is ~1.7ms (p50) on real GPU / ~0.2ms steady
// under SwiftShader. This file reuses that exact mechanic, generalized to the
// real module factory.

import type { VideoModuleFactory } from '$lib/video/engine';
import { acidwarpDef } from '$lib/video/modules/acidwarp';
import { createToyboxWorkerHandle } from './toybox-worker-handle';
import { WorkerRenderEngine, type WorkerFactoryRegistry } from './worker-engine';
import type { WorkerInboundMsg, WorkerOutboundMsg } from './protocol';

// The factories the worker may instantiate. Importing the def (NOT the card)
// keeps the worker bundle DOM-free. Add more entries here as additional pure-GL
// modules opt into renderLocus:'worker' (Phase 2).
//
// TOYBOX uses a bespoke worker handle (createToyboxWorkerHandle) rather than
// its main-thread factory: the main-thread factory reads livePatch.nodes[id]
// on every frame (DOM-coupled); the worker handle instead receives serialized
// state via MsgToyboxSync (sent by VideoEngine.syncNodeData on every data
// change) and renders the eligible pure-GL layers. Video/image layers render
// black in Phase 2A.
const WORKER_FACTORIES: WorkerFactoryRegistry = {
  [acidwarpDef.type as string]: acidwarpDef.factory as VideoModuleFactory,
  toybox: createToyboxWorkerHandle as VideoModuleFactory,
};

// Minimal worker-global surface. The project tsconfig uses the DOM lib (not
// WebWorker), so `DedicatedWorkerGlobalScope` isn't in scope here — we type just
// the two members we touch (postMessage with an optional transfer list +
// onmessage) rather than pulling in the whole WebWorker lib (which collides with
// DOM globals).
interface WorkerScope {
  postMessage(message: WorkerOutboundMsg, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerInboundMsg>) => void) | null;
}
const ctx = self as unknown as WorkerScope;

let engine: WorkerRenderEngine | null = null;
let running = false;
/** Determinism forwarding: while true (main thread paused / freeze-rendered),
 *  the loop keeps scheduling but neither steps nor posts frames. */
let paused = false;
let timerId: ReturnType<typeof setTimeout> | null = null;

/** Target render cadence (~60fps). The worker is a HEADLESS compute unit with
 *  no display to vsync to, so we drive it with a timer rather than
 *  requestAnimationFrame: in-worker rAF only fires for an OffscreenCanvas that
 *  is actually presented/composited, and ours is never transferred to a visible
 *  canvas (its output goes back as ImageBitmaps). The MAIN thread paces
 *  presentation by draining the latest-wins frame in its own rAF, so a fixed
 *  worker cadence is the right model + portable across browsers. */
const FRAME_MS = 16;

function post(msg: WorkerOutboundMsg, transfer?: Transferable[]): void {
  if (transfer && transfer.length) ctx.postMessage(msg, transfer);
  else ctx.postMessage(msg);
}

function loop(): void {
  if (!running || !engine) return;
  if (!paused && engine.hasNodes()) {
    const ready = engine.step();
    for (const nodeId of ready) {
      const bitmap = engine.transferNodeFrame(nodeId);
      if (bitmap) post({ type: 'frame', nodeId, bitmap }, [bitmap]);
    }
  }
  schedule();
}

function schedule(): void {
  timerId = setTimeout(loop, FRAME_MS);
}

function stopLoop(): void {
  running = false;
  if (timerId !== null) {
    clearTimeout(timerId);
    timerId = null;
  }
}

ctx.onmessage = (e: MessageEvent<WorkerInboundMsg>) => {
  const m = e.data;
  switch (m.type) {
    case 'init': {
      try {
        engine = new WorkerRenderEngine(WORKER_FACTORIES, m.res);
        running = true;
        schedule();
        post({ type: 'ready', glOk: true });
      } catch (err) {
        post({ type: 'ready', glOk: false, initErr: err instanceof Error ? err.message : String(err) });
      }
      break;
    }
    case 'addNode': {
      engine?.addNode(m.node);
      break;
    }
    case 'removeNode': {
      engine?.removeNode(m.nodeId);
      break;
    }
    case 'setParam': {
      engine?.setParam(m.nodeId, m.paramId, m.value);
      break;
    }
    case 'setResolution': {
      engine?.setResolution(m.width, m.height);
      break;
    }
    case 'toybox-sync': {
      engine?.syncToyboxState(m.nodeId, m.state);
      break;
    }
    case 'determinism': {
      paused = m.paused;
      engine?.setFrozenTime(m.freezeTimeSec);
      break;
    }
    case 'dispose': {
      stopLoop();
      try { engine?.dispose(); } catch { /* */ }
      engine = null;
      break;
    }
  }
};
