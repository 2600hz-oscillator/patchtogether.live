// packages/dsp/src/seq-clock.ts
//
// SEQ-CLOCK — the audio-thread clock worklet module. It registers TWO
// processors that share one motivation (a main-thread stall must never be able
// to drop a scheduled edge, because AudioParam scheduling is main-thread-only):
//
//   • 'seq-clock' — AudioWorklet wrapper around SeqClockCore (see
//     lib/seq-clock-core.ts): the sequencer's INTERNAL-clock step advance +
//     gate/pitch emission (the clock-drop-on-drag bug).
//   • 'cv-clock' — AudioWorklet wrapper around CvClockCore (see
//     lib/cv-clock-core.ts): CV Buddy's hardware RUN + CLOCK pulse train for
//     the ES-9 jacks (the SPEEDERR-001 dropped-pulse incident — one pulse lost
//     to a 200–360 ms main-thread stall against a 200 ms lookahead, audible as
//     every downstream Pam's re-locking). Wired by
//     packages/web/src/lib/audio/modules/cv-buddy.ts.
//
// I/O:
//   • 'seq-clock': output[0] = 2 channels: ch0 = pitch CV (V/oct), ch1 = gate.
//   • 'cv-clock': output[0] = clock (mono, 5 ms pulses at PPQN·bpm),
//     output[1] = run (mono level, held while running).
//   • config arrives via port messages on EDIT / scheduler tick — never per
//     audio block — so a config update dropped during a main-thread stall just
//     applies a frame late and never affects the pulse train itself.
//
// IMPORTANT: this file does NOT export anything at the top level — a
// top-level export pollutes the bundled dist/seq-clock.js and breaks the ART
// harness's classic-script eval (see ringback.ts / twotracks.ts). The classes
// are reached via their registerProcessor side-effects only.

import { SeqClockCore } from './lib/seq-clock-core';
import type { SeqClockConfig } from './lib/seq-clock-core';
import { CvClockCore } from './lib/cv-clock-core';
import type { CvClockConfig } from './lib/cv-clock-core';

// `sampleRate` is a global in AudioWorkletGlobalScope.
// Shim the worklet globals when running outside AudioWorkletGlobalScope (vitest).
// Guarded so the real runtime is untouched.
const G = globalThis as unknown as {
  AudioWorkletProcessor?: unknown;
  registerProcessor?: unknown;
  sampleRate?: number;
};
if (typeof G.AudioWorkletProcessor === 'undefined') {
  G.AudioWorkletProcessor = class {
    port = { onmessage: null, postMessage() {} } as unknown as MessagePort;
  };
}
if (typeof G.registerProcessor === 'undefined') {
  G.registerProcessor = () => {};
}

class SeqClockProcessor extends AudioWorkletProcessor {
  private core = new SeqClockCore(
    typeof sampleRate === 'number' ? sampleRate : 48000,
  );

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; config?: Partial<SeqClockConfig> } | undefined;
      if (data?.type === 'config' && data.config) {
        this.core.setConfig(data.config);
      }
    };
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0];
    const pitchOut = out?.[0];
    const gateOut = out?.[1];
    if (!pitchOut || !gateOut) return true;
    this.core.process(pitchOut, gateOut, pitchOut.length);
    return true;
  }
}

registerProcessor('seq-clock', SeqClockProcessor);

/**
 * CV Buddy's audio-thread RUN + CLOCK generator. All musical semantics live in
 * the pure CvClockCore; this wrapper only moves messages and buffers.
 *
 * Messages IN:  { type: 'config', config: Partial<CvClockConfig> }
 *               { type: 'dispose' } — stop processing so the node can be GC'd
 *                 (a 0-input source that always returns true would live
 *                 forever; see cv-buddy.ts dispose()).
 * Messages OUT: { type: 'health', pulses, skipped } — cumulative counters,
 *               posted only when they moved and at most every ~50 ms, so the
 *               port carries ≤20 msgs/s at any tempo. The wiring side surfaces
 *               them via read('clockHealth').
 */
class CvClockProcessor extends AudioWorkletProcessor {
  private core = new CvClockCore(typeof sampleRate === 'number' ? sampleRate : 48000);
  private disposed = false;
  private framesSinceHealth = 0;
  private lastHealthTotal = -1;
  private readonly healthEveryFrames = Math.round(
    (typeof sampleRate === 'number' ? sampleRate : 48000) * 0.05,
  );

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const data = e.data as
        | { type?: string; config?: Partial<CvClockConfig> }
        | undefined;
      if (data?.type === 'config' && data.config) {
        this.core.setConfig(data.config);
      } else if (data?.type === 'dispose') {
        this.disposed = true;
      }
    };
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>,
  ): boolean {
    if (this.disposed) return false;
    const clockOut = outputs[0]?.[0];
    const runOut = outputs[1]?.[0];
    if (!clockOut || !runOut) return true;
    this.core.process(clockOut, runOut, clockOut.length);

    this.framesSinceHealth += clockOut.length;
    const total = this.core.pulses + this.core.skipped;
    if (total !== this.lastHealthTotal && this.framesSinceHealth >= this.healthEveryFrames) {
      this.lastHealthTotal = total;
      this.framesSinceHealth = 0;
      this.port.postMessage({
        type: 'health',
        pulses: this.core.pulses,
        skipped: this.core.skipped,
      });
    }
    return true;
  }
}

registerProcessor('cv-clock', CvClockProcessor);
