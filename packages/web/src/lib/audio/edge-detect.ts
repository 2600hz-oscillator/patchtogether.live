// packages/web/src/lib/audio/edge-detect.ts
//
// The single seam for MAIN-THREAD rising-edge detection on a gate/trigger CV
// input. A module taps its input port (GainNode → AnalyserNode) and calls
// `poll(ctx.currentTime)` once per scheduler tick; the counter returns how many
// rising edges arrived SINCE THE LAST POLL — windowed to the new samples only.
//
// WHY THIS EXISTS (see .myrobots/plans/io-trigger-gate-sanitization.md §3.2):
// the scheduler tick is ~25 ms but an AnalyserNode ring buffer is 2048 samples
// (~42 ms @ 48 kHz). If a consumer re-scans the WHOLE buffer every tick, the
// ~17 ms overlap re-presents the same rising edge on two consecutive ticks and
// it gets counted twice → a single clock pulse advances a sequencer TWO steps
// (the NUMPAD+/HYDROGEN/ATLANTIS-CATALYST bug class). The fix is to scan only
// the `elapsed * sampleRate` samples that actually arrived since the previous
// poll. That windowing math is correct in `transport-cv.ts drainOne` and in
// `sequencer.ts`, but it was re-implemented per module and drifted. This util
// OWNS the window math so a consumer CANNOT get it wrong (no `start = 0`
// foot-gun) — it is the rising-edge analogue of the `midi-timing` projection
// util every MIDI bridge must use.

import { createRisingEdgeDetector, type RisingEdgeDetector } from './modules/transport-helpers';
import { GATE_HI } from './gate-trigger';

export interface EdgeCounter {
  /** Call ONCE per scheduler tick with the current AudioContext time. Returns
   *  the number of rising edges that crossed the threshold in the samples that
   *  arrived since the previous call. Windowed → no overlap double-count. */
  poll(nowSec: number): number;
  /** Reset cross-tick state (e.g. on a PLAY/STOP transition or re-arm). */
  reset(): void;
}

export interface EdgeCounterOptions {
  ctx: BaseAudioContext;
  /** The analyser tapping the input (caller wires source → gain → analyser
   *  and keeps the gain as the input node). fftSize should comfortably exceed
   *  the tick interval (2048 is the repo convention). */
  analyser: AnalyserNode;
  /** Rising threshold (0..1). Defaults to the canonical GATE_HI (0.5). */
  threshold?: number;
}

/**
 * Create a windowed rising-edge counter over an AnalyserNode. Folds together
 * the two correct existing pieces — the window math from `transport-cv` and the
 * cross-tick rising-edge state from `createRisingEdgeDetector` — so neither can
 * be misused. (`transport-cv.ts` keeps its own batched 6-port drainer for the
 * sequencer transport ports; this is the single-analyser building block for
 * every other main-thread clock/trig/reset input.)
 */
export function createEdgeCounter(opts: EdgeCounterOptions): EdgeCounter {
  const { ctx, analyser } = opts;
  const threshold = opts.threshold ?? GATE_HI;
  const buf = new Float32Array(analyser.fftSize) as Float32Array<ArrayBuffer>;
  const detector: RisingEdgeDetector = createRisingEdgeDetector(threshold);
  let lastSampleTime = ctx.currentTime;

  return {
    poll(nowSec: number): number {
      analyser.getFloatTimeDomainData(buf);
      const elapsed = nowSec - lastSampleTime;
      lastSampleTime = nowSec;
      // Only the samples that actually arrived since the last poll are "new";
      // scanning earlier would re-count the overlap region (the bug).
      const newSamples = Math.min(
        buf.length,
        Math.max(1, Math.ceil(elapsed * ctx.sampleRate)),
      );
      const start = buf.length - newSamples;
      return detector.scan(buf, start, buf.length);
    },
    reset(): void {
      detector.reset();
      lastSampleTime = ctx.currentTime;
    },
  };
}
