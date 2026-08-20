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

import { WORKER_FACTORIES } from './worker-factories';
import { WorkerRenderEngine } from './worker-engine';
import type { WorkerInboundMsg, WorkerOutboundMsg, WorkerTraceSnapshot } from './protocol';

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
/** Bumped on every teardown so a frame parked on a mid-frame yield cannot
 *  resume into a later engine. NOT a population count — it is a generation
 *  token whose only meaningful operation is equality. */
let loopGen = 0;

/** ---- #1905 handshake trace state (see protocol.WorkerTraceSnapshot) ---- */
let initAt: number | null = null;
let glOkAt: number | null = null;
let glError: string | null = null;
/** Loop heartbeat. NOT a population count — a monotonic liveness token whose
 *  only meaningful operation is "did it move between two traces?". */
let loopTicks = 0;
let lastTickAt: number | null = null;
let loopErrors = 0;
let lastError: string | null = null;

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

/**
 * One worker frame: draw every resident node, then hand each finished node
 * back as a transferred ImageBitmap.
 *
 * ⚠ ONE `transferToImageBitmap()` PER TASK. `transferNodeFrame` blits the
 * node's FBO into the ONE shared drawing buffer and transfers it; doing that
 * several times inside a single task means several transfers against one
 * canvas whose presented frame the spec does not pin per call. MEASURED
 * (#1811): with four worker-resident modules under `E2E_SWIFTSHADER=1`, every
 * node came back with the FIRST node's picture — four OUTPUTs all showing
 * ACIDWARP. Adding `gl.finish()` before the transfer fixed most of it and left
 * the LAST node still aliasing to its predecessor; yielding to a fresh task
 * between transfers is what actually closed it. Both are kept: `finish()`
 * guarantees the commands have executed, the yield guarantees the transfer is
 * the only one in its task.
 *
 * The bug was invisible before this PR because ACIDWARP was the sole
 * worker-resident module, and one node cannot alias with itself.
 *
 * Cost: N extra macrotasks per frame ON THE WORKER THREAD. That is the whole
 * point of this file — worker-thread scheduling does not delay the main
 * thread's audio scheduler.
 */
async function loop(gen: number): Promise<void> {
  if (gen !== loopGen || !running || !engine) return;
  loopTicks++;
  lastTickAt = performance.now();
  // ⚠ #1905 — THE LOOP RESCHEDULES ITSELF, SO ONE THROW USED TO END IT FOREVER.
  //
  // `schedule()` was the last statement of this function and the ONLY thing
  // that queues the next frame. `transferNodeFrame` (which compiles the copy
  // program on first use and calls `transferToImageBitmap`) and `post` (a
  // structured clone) can both throw; the call site is `setTimeout(() => void
  // loop(gen))`, so an async throw became a VOIDED rejection — no console
  // entry, no `onerror`, no `ready:{glOk:false}`.
  //
  // The resulting state is precisely #1905's signature: the worker is alive and
  // answers messages, `bridge.ready()` stays TRUE so the main thread never
  // re-materializes its fallback, and the node is black FOREVER — zero output
  // ever, not wrong output. Recovery required a reload, which is why every
  // sighting "passed on a retry of the identical tree".
  //
  // So: the frame is now guarded and `schedule()` moved into a `finally`. A
  // frame may fail; the LOOP may not die.
  try {
    if (!paused && engine.hasNodes()) {
      const ready = engine.step();
      for (let i = 0; i < ready.length; i++) {
        // Re-check EVERY iteration. `dispose` (and a subsequent re-`init`) can
        // land inside one of the yields below; touching a disposed engine would
        // throw on a dead context, and a stale frame resuming after a re-init
        // would schedule a SECOND concurrent loop. The generation counter is
        // what makes that second case impossible rather than merely unlikely.
        if (gen !== loopGen || !running || !engine) return;
        const bitmap = engine.transferNodeFrame(ready[i]!);
        if (bitmap) post({ type: 'frame', nodeId: ready[i]!, bitmap }, [bitmap]);
        if (i < ready.length - 1) await nextTask();
      }
    }
  } catch (err) {
    loopErrors++;
    lastError = err instanceof Error ? err.message : String(err);
    // A LOST CONTEXT IS TERMINAL, and it is the one failure the main thread can
    // still recover from — but only if it is TOLD. Report it exactly like a
    // failed init so the bridge takes its documented path (`fail()` → the proxy
    // re-materializes the main-thread fallback → the node paints again).
    // Silence here is what turned a recoverable GPU event into a dead node.
    if (engine && engine.gl.isContextLost()) {
      glError = `worker GL context lost after init (${lastError})`;
      post({ type: 'ready', glOk: false, initErr: glError });
      stopLoop();
      return;
    }
  } finally {
    // `gen` is re-checked inside schedule()'s callback via the generation token,
    // and stopLoop() clears `running` — so a dispose that landed mid-frame still
    // wins, exactly as before.
    if (gen === loopGen && running) schedule();
  }
}

/** Yield to a fresh macrotask. `setTimeout(0)` and not a microtask: a
 *  microtask drains inside the SAME task, which is exactly what does not
 *  separate two `transferToImageBitmap()` calls. */
function nextTask(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function schedule(): void {
  // `void`: loop() is async now (it yields between per-node transfers), and a
  // rejection would otherwise be an unhandled promise rather than a caught
  // frame. Nothing awaits a frame — the next one is scheduled from inside.
  const gen = loopGen;
  timerId = setTimeout(() => void loop(gen), FRAME_MS);
}

function stopLoop(): void {
  // Invalidate any in-flight frame that is currently parked on a yield.
  loopGen++;
  running = false;
  if (timerId !== null) {
    clearTimeout(timerId);
    timerId = null;
  }
}

/** #1905 — the worker's half of the handshake, on demand. Reading it costs one
 *  message; NOT being able to read it (no reply) is itself the diagnosis. */
function traceSnapshot(): WorkerTraceSnapshot {
  return {
    now: performance.now(),
    initAt,
    glOkAt,
    glError,
    loopTicks,
    lastTickAt,
    loopErrors,
    lastError,
    paused,
    frozenTimeSec: engine ? engine.frozenTime : null,
    nodes: engine ? engine.traceNodes() : [],
  };
}

ctx.onmessage = (e: MessageEvent<WorkerInboundMsg>) => {
  const m = e.data;
  switch (m.type) {
    case 'init': {
      initAt = performance.now();
      try {
        engine = new WorkerRenderEngine(WORKER_FACTORIES, m.res);
        running = true;
        schedule();
        glOkAt = performance.now();
        glError = null;
        post({ type: 'ready', glOk: true });
      } catch (err) {
        glError = err instanceof Error ? err.message : String(err);
        post({ type: 'ready', glOk: false, initErr: glError });
      }
      break;
    }
    case 'trace-request': {
      post({ type: 'trace', seq: m.seq, snapshot: traceSnapshot() });
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
