// packages/dsp/src/moog962.ts
//
// MOOG 962 SEQUENTIAL SWITCH — Moog System 55 clone. A gate-advanced signal
// selector: up to three signal inputs (in1..in3) feed a single output, and a
// rising edge on the SHIFT gate steps the selector to the next input
// (1→2→3→1 for stages=3, 1↔2 for stages=2). This is the 4PLEXER's
// gate-advanced selector trimmed to 3-in / 1-out (one selector, one gate).
//
// The selection logic lives in ./lib/moog962-dsp.ts (pure + unit-tested
// rising-edge counter — Moog962Switch); this entry wraps it in an
// AudioWorkletProcessor and adds a very short declick crossfade so flipping
// between audio-rate inputs doesn't zipper-click (same DECLICK approach as
// fourplexer.ts). Selection is INSTANT/discrete — the crossfade is purely
// anti-click.
//
// IMPORTANT: this file does NOT `export` anything at the top level — top-level
// exports leak into the bundled dist/moog962.js + break the ART classic-script
// eval. The Processor is registered via the `registerProcessor` side-effect;
// vitest captures it via the registerProcessor shim below.
//
// Inputs (4 audio-rate node connections):
//   inputs[0] = in1   (signal — audio OR cv, routes identically)
//   inputs[1] = in2   (signal)
//   inputs[2] = in3   (signal)
//   inputs[3] = shift (gate — advances the selector on each rising edge)
//
// Outputs (1, 1 channel):
//   outputs[0] = out  (carries the currently-selected input)
//
// Params:
//   stages (k-rate, 2..3, default 3) — how many inputs to cycle through.

import { Moog962Switch, moog962ClampStages } from './lib/moog962-dsp';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  process?(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
declare function registerProcessor(
  name: string,
  ctor: typeof AudioWorkletProcessor,
): void;

// Shim worklet globals when running outside AudioWorkletGlobalScope (vitest
// captures the class via this shim — see the moog962 test loader pattern).
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

// Declick crossfade length on a selector flip. ~4 ms — short enough to be
// perceptually instant (discrete) but long enough to kill the zipper click on
// an audio-rate input (matches fourplexer's DECLICK_S).
const DECLICK_S = 0.004;

// Not `export`ed at the top level by design — see the file-header note.
class Moog962Processor extends AudioWorkletProcessor {
  private sw = new Moog962Switch(3);
  // Selector index currently driving the output + the one we're fading FROM.
  private cur = 0;
  private prev = 0;
  // 0..1 declick progress prev→cur (1 = settled on cur).
  private fade = 1;
  private readonly fadeStep = 1 / sampleRate / DECLICK_S;

  static get parameterDescriptors() {
    return [
      // STAGES — k-rate discrete (how many inputs to cycle). 2..3.
      { name: 'stages', defaultValue: 3, minValue: 2, maxValue: 3, automationRate: 'k-rate' as const },
    ];
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const sig = [inputs[0]?.[0] ?? null, inputs[1]?.[0] ?? null, inputs[2]?.[0] ?? null];
    const shift = inputs[3]?.[0] ?? null;
    const out = outputs[0]?.[0];
    if (!out) return true;
    const n = out.length;

    // k-rate: apply stages once per block before the sample loop.
    const stages = moog962ClampStages(parameters.stages?.[0] ?? 3);
    this.sw.setStages(stages);

    // Per-sample signal table reused for the switch's selector read.
    const tbl = [0, 0, 0];

    for (let s = 0; s < n; s++) {
      tbl[0] = sig[0] ? sig[0][s]! : 0;
      tbl[1] = sig[1] ? sig[1][s]! : 0;
      tbl[2] = sig[2] ? sig[2][s]! : 0;
      const g = shift ? shift[s]! : 0;

      // Advance the pure switch (handles the rising-edge + wrap). We read its
      // selected index AFTER stepping so we can declick a change.
      this.sw.step(tbl, g);
      const sel = this.sw.selected();
      if (sel !== this.cur) {
        this.prev = this.cur;
        this.cur = sel;
        this.fade = 0;
      }

      if (this.fade < 1) this.fade = Math.min(1, this.fade + this.fadeStep);
      const f = this.fade;
      const curSig = tbl[this.cur] ?? 0;
      const prevSig = tbl[this.prev] ?? 0;
      out[s] = f >= 1 ? curSig : prevSig * (1 - f) + curSig * f;
    }

    return true;
  }
}

registerProcessor('moog962', Moog962Processor);
