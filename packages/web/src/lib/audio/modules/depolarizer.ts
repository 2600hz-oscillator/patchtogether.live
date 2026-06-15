// packages/web/src/lib/audio/modules/depolarizer.ts
//
// DEPOLARIZER — the reverse of POLARIZER: a tiny 1-in / 1-out CV utility that
// maps a BIPOLAR signal back to a UNIPOLAR one. It takes a [-1, +1] control
// voltage and folds it into [0, 1], scaled by a single DEPTH knob:
//
//     out = 0.5 + depth · (in / 2)
//
// DEPTH semantics — "how far the output departs from the 0.5 CENTER":
//   • depth = 1 (default): the full bipolar→unipolar conversion,
//     out = (in + 1)/2 → in=−1 → 0, in=0 → 0.5, in=+1 → 1.
//   • depth = 0.5: half-strength, the output only swings 0.25..0.75 around 0.5.
//   • depth = 0: flat 0.5 (the unipolar center) regardless of input.
// So DEPTH attenuates the deviation from center, never the center itself — the
// output always rests at 0.5 with nothing patched / at depth 0, which is the
// natural "neutral" unipolar value. Patch it inline to feed a bipolar LFO /
// sequencer / ±1 modulation source into a destination that wants a 0..1 CV
// (a level / depth / mix knob CV), with DEPTH trimming the modulation amount.
//
// DSP: NONE — a pure Web Audio graph, no worklet / no Faust .dsp. The transform
// is affine (out = gain·in + offset), so it maps exactly onto two summed nodes:
//   • the input through a GainNode whose gain = depth/2     (the scale term)
//   • a started ConstantSourceNode (constant 1) through a GainNode whose
//     gain = 0.5, summed into the output                    (the +0.5 center)
// Both feed a unity summing GainNode (the `out` node). Note the offset (0.5) is
// CONSTANT — only the slope depends on DEPTH — which is what keeps the output
// centered on 0.5 as DEPTH is dialed. Sample-accurate by construction.
//
// Inputs:
//   in (cv): the BIPOLAR control voltage to depolarize (expected −1..+1, but
//     the affine map is defined for any value).
//
// Outputs:
//   out (cv): the UNIPOLAR result, out = 0.5 + depth·(in/2).
//
// Params:
//   depth (linear 0..1, default 1): deviation from the 0.5 center. 1 = full
//     map (in=±1 → 0/1), 0 = flat 0.5. Scales only the slope (depth/2); the
//     0.5 center offset is fixed.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';

/** Pure helper so unit tests can pin the math without a Web Audio context.
 *  out = 0.5 + depth·(in/2). */
export function depolarize(input: number, depth: number): number {
  return 0.5 + depth * (input / 2);
}

export const depolarizerDef: AudioModuleDef = {
  type: 'depolarizer',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'depolarizer',
  category: 'utilities',
  schemaVersion: 1,

  inputs: [
    // The bipolar (−1..+1) CV to depolarize. CV-typed (CV math, not audio).
    { id: 'in', type: 'cv' },
  ],
  outputs: [
    // out = 0.5 + depth·(in/2) — the unipolar result centered on 0.5.
    { id: 'out', type: 'cv' },
  ],
  params: [
    // Deviation from the 0.5 center. 1 = full map, 0 = flat 0.5. Linear.
    { id: 'depth', label: 'DEPTH', defaultValue: 1, min: 0, max: 1, curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // Affine graph: out = scale·in + offset, with scale = depth/2, offset = 0.5.
    //   in ──▶ inScale (gain = depth/2) ──▶ out
    //   const(1) ──▶ center (gain = 0.5) ──▶ out
    const inScale = ctx.createGain(); // the depth/2 multiply on the input
    const out = ctx.createGain(); // unity summing node (the OUT jack)
    out.gain.setValueAtTime(1, ctx.currentTime);

    const constOne = ctx.createConstantSource(); // constant 1.0
    constOne.offset.setValueAtTime(1, ctx.currentTime);
    const center = ctx.createGain(); // the fixed +0.5 center term
    center.gain.setValueAtTime(0.5, ctx.currentTime);

    inScale.connect(out);
    constOne.connect(center);
    center.connect(out);
    constOne.start();

    const apply = (depth: number) => {
      inScale.gain.setValueAtTime(depth / 2, ctx.currentTime);
    };

    let depth = node.params?.depth ?? depolarizerDef.params[0].defaultValue;
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
        try { center.disconnect(); } catch { /* */ }
        try { out.disconnect(); } catch { /* */ }
      },
    };
  },
};
