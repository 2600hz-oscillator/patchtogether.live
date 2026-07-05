// packages/web/src/lib/audio/modules/scaler.ts
//
// SCALER — a tiny 1-in / 1-out signal multiplier (a VCA-without-CV / fixed-gain
// utility). The single AMOUNT knob multiplies the input by a factor from 0.1x
// up to 10x, sample-accurately. out = in * amount.
//
// Think of it as a clean "gain trim" / "boost-or-cut" utility: dial below 1.0
// to attenuate (down to a tenth), above 1.0 to boost (up to ten times), or
// leave it at unity (1.0 = a direct patch, signal passes unaltered). Unlike the
// passive 995 attenuator (which only cuts, 0..1) the SCALER can also BOOST.
//
// DSP: NONE — this is a pure Web Audio graph (one GainNode), so there's no
// worklet and no Faust .dsp. Multiplying a signal by a knob value maps exactly
// onto a GainNode whose gain ∈ [0.1, 10]. Mirrors the pure-gain factory pattern
// used by MOOG 995 / ATTENUMIX / MIXER's GainNode graphs. A GainNode multiplies
// at the audio sample rate, so the scaling is sample-accurate by construction.
//
// Inputs:
//   in (audio, also accepts the CV family): the SIGNAL to scale. Typed `audio`
//     so it interops with audio cables directly, and `accepts` cv/pitch/gate so
//     a CV / gate / pitch source can be scaled too (the SCOPE-probe widening
//     pattern) — it's just a multiply, valid for either signal class.
//
// Outputs:
//   out (TYPE-TRANSPARENT pass-through, `adoptsUpstreamFrom: 'in'`): the scaled
//     signal (out = in * amount). Its EMITTED cable type ADOPTS the type of
//     whatever's patched into `in` — a CV source makes `out` emit `cv`, an audio
//     source makes it emit `audio`. Declared `type: 'audio'` only as the fallback
//     when nothing is patched upstream (so a bare SCALER still presents an audio
//     jack). WHY: the audio→video bridge reads an `audio`-typed source through an
//     RMS envelope-follower that CLAMPS to 1.0 — so a hard-`audio` output made
//     SCALER's scaled CV saturate and the AMOUNT knob had ZERO effect at a video
//     destination (the "dead knob" bug). Adopting the upstream type keeps a CV
//     signal CV through the bridge → it takes the raw tail-sample path → AMOUNT
//     scales the real ±CV value. (SCOPE is the sibling "visualizer-not-a-bus"
//     port-type-widening pattern; here we widen the OUTPUT's emitted type instead
//     of an input's accepted set.)
//
// Params:
//   amount (log 0.1..10, default 1.0): the scale factor. LOG curve so unity
//     (1.0) sits at knob CENTER and the taper is symmetric (x0.1 at the left
//     extreme, x10 at the right). Default 1.0 so a freshly spawned SCALER
//     passes a direct patch through unaltered until the user dials it.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';

export const scalerDef: AudioModuleDef = {
  type: 'scaler',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'scaler',
  category: 'utilities',

  inputs: [
    // The signal to scale. `audio`-typed but widened to the CV family so a
    // CV / gate / pitch source can be scaled too (SCOPE-probe pattern).
    { id: 'in', type: 'audio', accepts: ['cv', 'pitch', 'gate'] },
  ],
  outputs: [
    // out = in * amount. TYPE-TRANSPARENT: the emitted cable type adopts
    // whatever's patched into `in` (a CV source → a CV out), so the scaled
    // signal stays in its own class through the cross-domain video bridge and
    // the AMOUNT knob actually scales it. `type: 'audio'` is the fallback when
    // nothing is patched upstream. See the header comment for the full why.
    { id: 'out', type: 'audio', adoptsUpstreamFrom: 'in' },
  ],
  params: [
    // LOG taper so 1.0 (unity) lands at knob center and x0.1..x10 is symmetric.
    // Default 1.0 = a direct passthrough on a fresh SCALER.
    { id: 'amount', label: 'AMOUNT', defaultValue: 1, min: 0.1, max: 10, curve: 'log' },
  ],

  // docs-hash-ignore:start  -- docs prose is hash-transparent to the ART audio-profile source pin
  docs: {
    explanation:
      "A one-knob signal multiplier — a clean gain trim that can both CUT and BOOST. The single AMOUNT knob multiplies whatever passes through by a factor from ×0.1 (a tenth) up to ×10 (ten times): out = in · amount. Unlike a passive attenuator (which only cuts, 0..1), SCALER can also amplify, and unlike a VCA it has no CV input — it is a fixed, set-and-forget trim. It works on EITHER signal class: the input accepts audio, CV, pitch or gate cables, and the output adopts the cable type of whatever is patched in, so scaling a CV stays CV through the system (this is what makes the knob actually do something at a cross-domain destination). There is no DSP worklet — it is a single Web Audio GainNode, sample-accurate.",
    inputs: {
      in: "The signal to scale. Typed audio but widened to accept CV / pitch / gate cables too, so the same multiply works on a control voltage, a pitch line or an audio bus — it is just a gain.",
    },
    outputs: {
      out: "The scaled signal, out = in · amount. Type-transparent: the emitted cable type adopts whatever is patched into IN (a CV source makes this emit CV, an audio source makes it emit audio); with nothing patched it presents as an audio jack.",
    },
    controls: {
      amount: "The scale factor, on a log fader so unity (×1.0) sits at the knob CENTER and the taper is symmetric: full left = ×0.1 (attenuate to a tenth), full right = ×10 (boost ten-fold). Defaults to ×1.0, so a freshly spawned SCALER is a transparent direct patch until you move it.",
    },
  },
  // docs-hash-ignore:end

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // Pure Web Audio: one GainNode whose gain IS the AMOUNT. in -> gain -> out.
    const gain = ctx.createGain();

    // Apply the initial value (saved patch override, else the def default).
    const initial = node.params ?? {};
    const v = initial.amount ?? scalerDef.params[0].defaultValue;
    gain.gain.setValueAtTime(v, ctx.currentTime);

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['in', { node: gain, input: 0 }],
      ]),
      outputs: new Map([['out', { node: gain, output: 0 }]]),
      setParam(paramId, value) {
        if (paramId === 'amount') gain.gain.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return paramId === 'amount' ? gain.gain.value : undefined;
      },
      dispose() {
        try { gain.disconnect(); } catch { /* */ }
      },
    };
  },
};
