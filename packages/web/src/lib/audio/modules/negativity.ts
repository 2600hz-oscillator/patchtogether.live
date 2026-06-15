// packages/web/src/lib/audio/modules/negativity.ts
//
// NEGATIVITY — a tiny 1-in / 1-out CV utility: a pure INVERTER. It flips the
// sign of its input, sample-for-sample:
//
//     out = −in
//
// A positive control voltage becomes negative and vice-versa (in=0.4 → −0.4,
// in=−0.7 → +0.7), with no knob and no parameters. Use it to turn a rising
// modulation into a falling one (or the reverse), to derive a complementary
// CV (e.g. an inverted envelope for ducking), or to phase-flip a bipolar
// modulation source. It is the no-knob, fixed-sign sibling of POLARIZER /
// DEPOLARIZER (both of which also reshape range; NEGATIVITY only inverts).
//
// DSP: NONE — a pure Web Audio graph, no worklet / no Faust .dsp. Negation is
// a multiply by −1, which is exactly a GainNode whose gain = −1. in → gain → out
// on a single node, sample-accurate by construction. (Same one-GainNode pattern
// as SCALER, but with a fixed −1 gain and no knob.)
//
// Inputs:
//   in (cv): the control voltage to invert.
//
// Outputs:
//   out (cv): the inverted result, out = −in.
//
// Params: NONE — the inversion is fixed (gain = −1).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';

/** Pure helper so unit tests can pin the math without a Web Audio context.
 *  out = −in. */
export function negate(input: number): number {
  return -input;
}

export const negativityDef: AudioModuleDef = {
  type: 'negativity',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'negativity',
  category: 'utilities',
  schemaVersion: 1,

  inputs: [
    // The CV to invert. CV-typed (this is CV math, not audio).
    { id: 'in', type: 'cv' },
  ],
  outputs: [
    // out = −in.
    { id: 'out', type: 'cv' },
  ],
  // No params — the inversion is a fixed gain = −1.
  params: [],

  async factory(ctx): Promise<AudioDomainNodeHandle> {
    // Pure Web Audio: one GainNode with a fixed gain of −1. in → gain → out.
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(-1, ctx.currentTime);

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['in', { node: gain, input: 0 }],
      ]),
      outputs: new Map([['out', { node: gain, output: 0 }]]),
      setParam() {
        // No params.
      },
      readParam() {
        return undefined;
      },
      dispose() {
        try { gain.disconnect(); } catch { /* */ }
      },
    };
  },
};
