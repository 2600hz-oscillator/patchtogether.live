// packages/dsp/src/master-limiter.ts
//
// MASTER LIMITER — AudioWorklet entry for `audioOut`'s terminal safety stage.
// Wraps the pure core in ./lib/master-limiter-dsp.ts, which carries the design
// notes and the no-overshoot proof. This file is only the worklet shell.
//
// IMPORTANT: this file does NOT `export` anything at the top level — top-level
// exports leak into the bundled dist/master-limiter.js and break the ART
// classic-script eval. The Processor class is registered via the
// `registerProcessor` side-effect; tests capture it through a registerProcessor
// shim (mirrors moog905.ts / resofilter.ts exactly).
//
// Inputs (1 node connection):
//   inputs[0] = the DC-blocked stereo master bus.
//
// ⚠ DELIBERATELY NO MONO NORMAL. audio-out's L and R are two INDEPENDENT mono
// inputs (Eurorack convention — you patch both sides for stereo), so a patched
// L with an unpatched R must stay left-only; copying L into R here would
// silently make every mono patch dual-mono. The upstream ChannelMergerNode also
// always presents two channels, so a `?? inL` fallback could never fire anyway —
// `mono-normal-not-defeated.test.ts` caught exactly that dead normal on the
// first draft of this file.
//
// Outputs (1, 2 channels):
//   outputs[0] = the same bus, peak-bounded at the ceiling. Delayed by the
//                look-ahead (2 ms) — that latency IS the mechanism, see the
//                core's header.
//
// No AudioParams: this is a fixed safety stage, not a user-facing dynamics
// processor. Its numbers live as named constants in the core so the card, the
// docs and the tests all read the same one.

import {
  makeMasterLimiterState,
  masterLimiterStepStereo,
  type MasterLimiterState,
} from './lib/master-limiter-dsp';

// Shim worklet globals when running outside AudioWorkletGlobalScope (vitest /
// ART capture the class through this shim — see art/setup/worklet.ts).
const G = globalThis as unknown as {
  AudioWorkletProcessor?: unknown;
  registerProcessor?: unknown;
};
if (typeof G.AudioWorkletProcessor === 'undefined') {
  G.AudioWorkletProcessor = class {};
}
if (typeof G.registerProcessor === 'undefined') {
  G.registerProcessor = () => {};
}

// Not `export`ed at the top level by design — see the file-header note.
class MasterLimiterProcessor extends AudioWorkletProcessor {
  private st: MasterLimiterState;
  private frame = new Float32Array(2);

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.st = makeMasterLimiterState(sampleRate);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const outL = out?.[0];
    if (!outL) return true;
    const outR = out[1] ?? outL;

    const inCh = inputs[0] ?? [];
    const inL = inCh[0] ?? null;
    const inR = inCh[1] ?? null; // NOT `?? inL` — see the header.

    const n = outL.length;
    const f = this.frame;
    for (let s = 0; s < n; s++) {
      masterLimiterStepStereo(inL?.[s] ?? 0, inR?.[s] ?? 0, this.st, f);
      outL[s] = f[0]!;
      outR[s] = f[1]!;
    }
    // Always alive: this is the terminal stage, so it must keep pulling even
    // while the patch is silent (the delay line still has to drain).
    return true;
  }
}

registerProcessor('master-limiter', MasterLimiterProcessor);
