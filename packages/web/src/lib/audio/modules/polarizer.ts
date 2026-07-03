// packages/web/src/lib/audio/modules/polarizer.ts
//
// POLARIZER — a tiny 1-in / 1-out CV utility that maps a UNIPOLAR signal to a
// BIPOLAR one. It takes a [0, 1] control voltage and stretches it across
// [-1, +1], scaled by a single DEPTH knob:
//
//     out = (2·in − 1) · depth
//
// At depth = 1 (default) the map is the full unipolar→bipolar conversion:
// in=0 → −1, in=0.5 → 0, in=1 → +1. Turning DEPTH down shrinks the bipolar
// swing symmetrically about 0 (depth=0.5 → ±0.5, depth=0 → flat 0). This is the
// bipolar counterpart of a unipolar envelope output (e.g. SYNESTHESIA's 0..1
// follower) — patch it inline to turn a 0..1 envelope / LFO / sequencer CV into
// a ±1 modulation source that can both raise AND lower a destination.
//
// DSP: NONE — a pure Web Audio graph, no worklet / no Faust .dsp. The transform
// is affine (out = gain·in + offset), so it maps exactly onto two summed nodes:
//   • the input through a GainNode whose gain = 2·depth  (the scale term)
//   • a started ConstantSourceNode (constant 1) through a GainNode whose
//     gain = −depth, summed into the output                (the offset term)
// Both feed a unity summing GainNode (the `out` node). Everything runs at the
// audio sample rate, so the mapping is sample-accurate by construction. This
// mirrors the scale+offset node pattern used elsewhere for CV math (it's a
// GainNode + ConstantSourceNode, not a custom worklet — simplest correct form).
//
// Inputs:
//   in (cv): the UNIPOLAR control voltage to polarize (expected 0..1, but the
//     affine map is defined for any value — it just centers + scales linearly).
//
// Outputs:
//   out (cv): the BIPOLAR result, out = (2·in − 1)·depth.
//
// Params:
//   depth (linear 0..1, default 1): the bipolar swing. 1 = full ±1 conversion,
//     0 = flat 0. Scales BOTH the slope (2·depth) and the offset (−depth)
//     together so the [0,1]→[−depth,+depth] map stays centered on 0.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';

/** Pure helper so unit tests can pin the math without a Web Audio context.
 *  out = (2·in − 1)·depth. */
export function polarize(input: number, depth: number): number {
  return (2 * input - 1) * depth;
}

export const polarizerDef: AudioModuleDef = {
  type: 'polarizer',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'polarizer',
  category: 'utilities',
  schemaVersion: 1,

  inputs: [
    // The unipolar (0..1) CV to polarize. CV-typed (this is CV math, not audio).
    { id: 'in', type: 'cv' },
  ],
  outputs: [
    // out = (2·in − 1)·depth — the bipolar (±depth) result.
    { id: 'out', type: 'cv' },
  ],
  params: [
    // Bipolar swing. 1 = full ±1, 0 = flat 0. Linear so the swing tracks the
    // knob position directly.
    { id: 'depth', label: 'DEPTH', defaultValue: 1, min: 0, max: 1, curve: 'linear' },
  ],

  // docs-hash-ignore:start  -- docs prose is hash-transparent to the ART audio-profile source pin
  docs: {
    explanation:
      "A tiny one-knob CV utility that turns a UNIPOLAR signal into a BIPOLAR one: it takes a 0..1 control voltage and stretches it across -1..+1, applying out = (2·in - 1)·depth. The natural use is converting a 0..1 envelope, LFO or sequencer CV into a ±1 modulation source that can both RAISE and LOWER a destination (an unmodified envelope can only push a parameter up from where it sits; polarize it first and it can swing symmetrically about the knob). It is the exact inverse of DEPOLARIZER. There is no DSP worklet — it is a pure scale-plus-offset Web Audio graph, so the mapping is sample-accurate.",
    inputs: {
      in: "The unipolar control voltage to polarize, expected 0..1 (e.g. an envelope follower or a 0..1 LFO). The affine map is defined for any value — it just centers and linearly scales whatever arrives — but the labeled use is 0..1 in, ±depth out.",
    },
    outputs: {
      out: "The bipolar result, out = (2·in - 1)·depth. At depth 1: in=0 gives -1, in=0.5 gives 0, in=1 gives +1. The mid-point of the input (0.5) always maps to 0, so this is the signal centered on zero and ready to add to / subtract from a destination.",
    },
    controls: {
      depth: "Sets the bipolar swing on a linear 0..1 fader, scaling BOTH the slope and the offset together so the output stays centered on 0. 1 (default) = the full unipolar→bipolar conversion (±1); 0.5 = a half-size ±0.5 swing; 0 = flat 0 regardless of input. Effectively an attenuator on the polarized signal.",
    },
  },
  // docs-hash-ignore:end

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // Affine graph: out = scale·in + offset, with scale = 2·depth, offset = −depth.
    //   in ──▶ inScale (gain = 2·depth) ──▶ out
    //   const(1) ──▶ offset (gain = −depth) ──▶ out
    const inScale = ctx.createGain(); // the 2·depth multiply on the input
    const out = ctx.createGain(); // unity summing node (the OUT jack)
    out.gain.setValueAtTime(1, ctx.currentTime);

    const constOne = ctx.createConstantSource(); // constant 1.0
    constOne.offset.setValueAtTime(1, ctx.currentTime);
    const offset = ctx.createGain(); // the −depth offset term

    inScale.connect(out);
    constOne.connect(offset);
    offset.connect(out);
    constOne.start();

    const apply = (depth: number) => {
      inScale.gain.setValueAtTime(2 * depth, ctx.currentTime);
      offset.gain.setValueAtTime(-depth, ctx.currentTime);
    };

    let depth = node.params?.depth ?? polarizerDef.params[0].defaultValue;
    apply(depth);

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['in', { node: inScale, input: 0 }],
      ]),
      outputs: new Map([['out', { node: out, output: 0 }]]),
      setParam(paramId, value) {
        if (paramId === 'depth') {
          depth = value;
          apply(depth);
        }
      },
      readParam(paramId) {
        return paramId === 'depth' ? depth : undefined;
      },
      dispose() {
        try { constOne.stop(); } catch { /* */ }
        try { inScale.disconnect(); } catch { /* */ }
        try { constOne.disconnect(); } catch { /* */ }
        try { offset.disconnect(); } catch { /* */ }
        try { out.disconnect(); } catch { /* */ }
      },
    };
  },
};
