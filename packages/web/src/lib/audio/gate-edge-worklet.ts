// packages/web/src/lib/audio/gate-edge-worklet.ts
//
// GATE-EDGE ACCUMULATOR — an AUDIO-THREAD rising-edge counter for the
// cross-domain audio → video gate bridge.
//
// WHY THIS EXISTS (the second half of the SHAPEGEN-clock dropped-edge bug):
// the first fix replaced the video engine's per-FRAME analyser sampler with
// the mandated main-thread `edge-detect createEdgeCounter` seam driven off the
// scheduler clock. That removed the rAF dependency but kept a subtler one: an
// `AnalyserNode` only retains its last `fftSize` samples, and `createEdgeCounter`
// deliberately windows to `elapsed * sampleRate` samples, CLAMPED to the buffer
// length. So the counter is only lossless while
//
//     (gap between two polls)  <  (fftSize / sampleRate)
//
// On a loaded CI runner (4 Playwright workers + the SwiftShader software
// rasterizer on a 4-vCPU box) the main thread is preempted for hundreds of ms
// at a stretch. Instrumented on a faithful local repro (SwiftShader + injected
// 250 ms main-thread stalls) the observed MAX POLL GAP was **1626 ms**. The
// AnalyserNode maximum `fftSize` is 32768 = **683 ms** @ 48 kHz, so the gap
// exceeded even the largest possible window by 2.4×. Signal older than the
// window is simply GONE from the ring — no main-thread reader can recover it,
// at any fftSize. Measured capture with the analyser counter under that repro:
// 13/24 edges at fftSize 4096, 20/24 at the 32768 maximum.
//
// THE FIX: move the COUNTING into the audio thread, where per-sample detection
// is correct by construction and cannot be starved. This is the exemption the
// repo standard already carves out: "A worklet consumer is exempt (per-sample
// `prev<TH && cur>=TH` is correct by construction)." The processor keeps a
// MONOTONIC edge total and posts it on every transition; the main thread
// replays the DELTA whenever it next gets to run. A stall of any length now
// costs LATENCY ONLY — never an edge — because the count is accumulated behind
// the stall and the message queue survives it.
//
// The worklet is built from an INLINE BLOB (the same self-contained pattern
// `scheduler-clock.ts` uses for its tick Worker), so it needs no packages/dsp
// build artifact, no SHA pin, and no attest basis churn. The source is a plain
// string literal — minifier-proof, and `gate-edge-worklet.test.ts` evaluates
// THIS EXACT STRING to drive the processor, so the shipped code and the tested
// code cannot drift.

import { GATE_HI } from './gate-trigger';

/** Registered processor name (also used by the unit test). */
export const GATE_EDGE_PROCESSOR = 'patchtogether-gate-edge-counter';

/** Message the processor posts to the main thread: once when the tap PRIMES
 *  (its baseline level, count unchanged), then on every level transition. */
export interface GateEdgeMessage {
  /** Monotonic count of rising edges since the processor was constructed. */
  count: number;
  /** Level AFTER this transition: 1 while the gate is held HIGH, else 0. */
  level: number;
  /** Audio-clock time (sec) of the LAST rising edge in the block this message
   *  reports, or -1 when it reports no rise (a fall, or the priming message).
   *  The main-thread bridge uses it to reconcile rises that straddle its
   *  analyser → worklet handoff: a rise at or before the handoff poll was
   *  already inside the window that poll scanned. */
  riseT: number;
}

/**
 * Processor source. Self-contained (no imports — an AudioWorkletGlobalScope has
 * no module graph here), so the threshold is baked in from `GATE_HI` at build
 * time and the detection predicate is character-for-character the one
 * `createRisingEdgeDetector` uses: `prev < TH && cur >= TH`.
 *
 * PRIMED FROM ITS FIRST SAMPLE. The tap is connected to a source that is
 * already running, so the first sample it sees is a LEVEL, not a transition:
 * a gate held high — or a CV LFO in its positive half — at the moment the tap
 * starts must not be reported as a rising edge. (Measured before this: a 4 Hz
 * LFO patched into a trigger input read one manufactured rise 25 ms after the
 * worklet took over, on top of the real ones — a bogus 25 ms clock period.) The
 * priming block posts the baseline level with the count unchanged, so the main
 * thread knows the level before any edge.
 *
 * Posts ONLY on a transition after that, so a 2 Hz clock produces ~4
 * messages/sec — the port is never a bottleneck, and a held gate is silent on
 * the wire.
 */
export const GATE_EDGE_WORKLET_SOURCE = `
class GateEdgeCounterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._prev = 0;
    this._count = 0;
    this._primed = false;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    const TH = ${GATE_HI};
    let prev = this._prev;
    let count = this._count;
    let changed = false;
    let riseT = -1;
    let i = 0;
    if (!this._primed) {
      prev = ch[0];
      this._primed = true;
      changed = true;
      i = 1;
    }
    for (; i < ch.length; i++) {
      const cur = ch[i];
      const wasHigh = prev >= TH;
      const isHigh = cur >= TH;
      if (!wasHigh && isHigh) { count++; changed = true; riseT = currentTime + i / sampleRate; }
      else if (wasHigh && !isHigh) { changed = true; }
      prev = cur;
    }
    this._prev = prev;
    this._count = count;
    if (changed) {
      this.port.postMessage({ count: count, level: prev >= TH ? 1 : 0, riseT: riseT });
    }
    return true;
  }
}
registerProcessor(${JSON.stringify(GATE_EDGE_PROCESSOR)}, GateEdgeCounterProcessor);
`;

/** Contexts whose audioWorklet already has the module registered. */
const REGISTERED = new WeakSet<BaseAudioContext>();
/** In-flight registrations, so N concurrent bridges share ONE addModule. */
const PENDING = new WeakMap<BaseAudioContext, Promise<boolean>>();

/**
 * Idempotently register the processor on `ctx`. Resolves true when the module
 * is available. Resolves FALSE (never throws) if the environment can't take it
 * — a CSP that forbids blob: worklets, a stubbed test context, an older
 * browser — so the caller can fall back to the main-thread analyser counter
 * rather than losing the edge entirely.
 */
export function ensureGateEdgeWorklet(ctx: BaseAudioContext): Promise<boolean> {
  if (REGISTERED.has(ctx)) return Promise.resolve(true);
  const inFlight = PENDING.get(ctx);
  if (inFlight) return inFlight;
  const p = (async (): Promise<boolean> => {
    try {
      const aw = (ctx as unknown as { audioWorklet?: { addModule(u: string): Promise<void> } })
        .audioWorklet;
      if (!aw || typeof aw.addModule !== 'function') return false;
      if (typeof Blob === 'undefined' || typeof URL === 'undefined'
        || typeof URL.createObjectURL !== 'function') return false;
      const blob = new Blob([GATE_EDGE_WORKLET_SOURCE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      try {
        await aw.addModule(url);
      } finally {
        try { URL.revokeObjectURL(url); } catch { /* */ }
      }
      REGISTERED.add(ctx);
      return true;
    } catch {
      return false;
    }
  })();
  PENDING.set(ctx, p);
  return p;
}

/**
 * Synchronous: is the processor ALREADY registered on `ctx`? The AudioEngine
 * pre-registers at construction, so by the time a cable lands this is normally
 * true and the bridge can construct its node on the spot — counting from the
 * first render quantum, with no analyser phase and no handoff. False while the
 * registration is still in flight or after it declined.
 */
export function isGateEdgeWorkletRegistered(ctx: BaseAudioContext): boolean {
  return REGISTERED.has(ctx);
}

/** Test-only: forget registration state between cases. */
export function __resetGateEdgeWorkletForTests(ctx: BaseAudioContext): void {
  REGISTERED.delete(ctx);
  PENDING.delete(ctx);
}
