// packages/web/src/lib/audio/modules/analog-logic-maths.ts
//
// ANALOGLOGICMATHS (ALM) — analog-logic mixer.
//
// Inspired by Mystic Instruments ANA (hardware, no firmware source — this is
// a from-spec implementation, NOT a port). The intent is the "logic" of
// analog electronics: continuous-signal min/max/diff/sum/product, not the
// digital boolean logic that ILLOGIC ships.
//
// Two continuous inputs A and B feed bipolar attenuverters (-1..+1) and the
// post-attenuverter signals fan out into five simultaneous outputs:
//
//   MIN     = min(A', B')          — sample-wise minimum
//   MAX     = max(A', B')          — sample-wise maximum
//   DIFF    = A' - B'              — sign-aware difference
//   SUM     = tanh(A' + B')        — pure sum with tanh soft-clip
//   PRODUCT = tanh(A' * B')        — sample-wise multiply with tanh soft-clip
//
// Musical use:
//   • MIN/MAX of two waveforms gives jagged-saw / smoothed-crest mashing.
//   • MAX of two envelopes = "either-trigger" fires.
//   • DIFF of two LFOs creates anti-correlated motion.
//   • PRODUCT of two audios is ring-mod; of two CVs is smooth blending.
//
// ILLOGIC contrast: ILLOGIC thresholds inputs at 0.5 and produces AND/NAND/
// OR/NOT booleans (0 or 1). ALM never thresholds — its outputs are
// continuous functions of the inputs.
//
// Trimmed output set rationale: the canonical analog-logic catalog also
// lists MEAN ((a+b)/2) and ABS_DIFF (|a-b|). MEAN is SUM÷2 — patch a follow-
// up attenuator if needed; redundant on the panel. ABS_DIFF is niche enough
// that we omitted it to keep the 5-out card readable; can ship as a follow-
// up if user feedback asks for it.
//
// Inputs:
//   a (cv): bipolar input A.
//   b (cv): bipolar input B.
//   attA_cv (cv, linear, paramTarget=attA): displaces the A attenuvert.
//   attB_cv (cv, linear, paramTarget=attB): displaces the B attenuvert.
//
// Outputs:
//   min (cv): min(A', B').
//   max (cv): max(A', B').
//   diff (cv): A' - B'.
//   sum (cv): tanh(A' + B').
//   product (cv): tanh(A' * B').
//
// Params:
//   attA (linear -1..1, default 1): A attenuvert.
//   attB (linear -1..1, default 1): B attenuvert.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/analog-logic-maths.js?url';

const PROCESSOR_NAME = 'analog-logic-maths';
const loadedContexts = new WeakSet<BaseAudioContext>();

/** Pure helpers extracted so unit tests can pin the math without spinning
 *  up a Web Audio context. The worklet's per-sample loop is the same five
 *  expressions. */
export const analogLogicMath = {
  /** Bipolar attenuvert: y = x * att with att ∈ [-1, +1]. */
  atten(x: number, att: number): number {
    return x * att;
  },
  min(a: number, b: number): number {
    return a < b ? a : b;
  },
  max(a: number, b: number): number {
    return a > b ? a : b;
  },
  diff(a: number, b: number): number {
    return a - b;
  },
  /** Sum with tanh soft-clip. a+b can exceed unity; tanh keeps the bus
   *  in (-1, +1). At small amplitudes tanh(x) ≈ x so quiet sums pass
   *  through nearly transparent. */
  sum(a: number, b: number): number {
    return Math.tanh(a + b);
  },
  /** Product with tanh soft-clip. Same reasoning as sum. */
  product(a: number, b: number): number {
    return Math.tanh(a * b);
  },
};

export const analogLogicMathsDef: AudioModuleDef = {
  type: 'analogLogicMaths',
  domain: 'audio',
  label: 'ANALOGLOGICMATHS',
  category: 'utilities',
  schemaVersion: 1,

  inputs: [
    { id: 'a',       type: 'cv' },
    { id: 'b',       type: 'cv' },
    // CV-on-knob inputs for both attenuverters — gives a 4-input module
    // where someone can sweep the attenuvert via LFO/envelope. Linear
    // cv-scale per the project's CV range standard.
    { id: 'attA_cv', type: 'cv', paramTarget: 'attA', cvScale: { mode: 'linear' } },
    { id: 'attB_cv', type: 'cv', paramTarget: 'attB', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'min',     type: 'cv' },
    { id: 'max',     type: 'cv' },
    { id: 'diff',    type: 'cv' },
    { id: 'sum',     type: 'cv' },
    { id: 'product', type: 'cv' },
  ],
  params: [
    { id: 'attA', label: 'Att A', defaultValue: 1, min: -1, max: 1, curve: 'linear' },
    { id: 'attB', label: 'Att B', defaultValue: 1, min: -1, max: 1, curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const worklet = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 2,
      numberOfOutputs: 5,
      outputChannelCount: [1, 1, 1, 1, 1],
    });

    const params = worklet.parameters as unknown as Map<string, AudioParam>;
    const initial = node.params ?? {};
    for (const def of analogLogicMathsDef.params) {
      const v = initial[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    const pAttA = params.get('attA')!;
    const pAttB = params.get('attB')!;

    return {
      domain: 'audio',
      inputs: new Map([
        ['a',       { node: worklet, input: 0 }],
        ['b',       { node: worklet, input: 1 }],
        // CV-on-param inputs reuse input slot 0 (the engine writes only to
        // the AudioParam in this case; the audio slot is ignored).
        ['attA_cv', { node: worklet, input: 0, param: pAttA }],
        ['attB_cv', { node: worklet, input: 0, param: pAttB }],
      ]),
      outputs: new Map([
        ['min',     { node: worklet, output: 0 }],
        ['max',     { node: worklet, output: 1 }],
        ['diff',    { node: worklet, output: 2 }],
        ['sum',     { node: worklet, output: 3 }],
        ['product', { node: worklet, output: 4 }],
      ]),
      setParam(paramId, value) {
        switch (paramId) {
          case 'attA': pAttA.setValueAtTime(value, ctx.currentTime); return;
          case 'attB': pAttB.setValueAtTime(value, ctx.currentTime); return;
        }
      },
      readParam(paramId) {
        switch (paramId) {
          case 'attA': return pAttA.value;
          case 'attB': return pAttB.value;
        }
        return undefined;
      },
      dispose() {
        try { worklet.disconnect(); } catch { /* */ }
      },
    };
  },
};
