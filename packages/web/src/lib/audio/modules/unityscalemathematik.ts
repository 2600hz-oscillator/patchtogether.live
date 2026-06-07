// packages/web/src/lib/audio/modules/unityscalemathematik.ts
//
// UNITYSCALEMATHEMATIK — bipolar CV-shaping utility. Three independent
// channels, each transforming a single signal through an attenuvert and
// (for sections A/B) a curve morph from linear to exponential.
//
// Sections:
//   UNITY  — input * atten            (atten in [-1, +1], default +1.0)
//   A      — sign(in) * |in|^k * atten (curve morphs k from 1.0 -> 3.0)
//   B      — same as A
//
// Curve math (A/B):
//   k = 1 + 2 * curve   (curve in [0, 1])    -> k in [1, 3]
//   y = sign(x) * |x|^k * atten
//
// At curve=0, k=1 -> y = x * atten (pure linear). At curve=1, k=3 -> a
// steep "expo" response that compresses small signals and preserves
// larger excursions, while keeping the sign of x. The piecewise
// formulation is C^0 at zero (and C^1 for k>=1), so there's no kink at
// the bipolar zero crossing.
//
// Why a custom JS worklet (not Faust): the math is one multiply per
// sample in the linear case and one multiply + Math.pow for A/B at non-
// zero curve. A bare AudioWorkletProcessor keeps the hot path inline
// and lets the engine route audio-rate CV directly into each section's
// AudioParam via the cvScale linear scaler (project convention; see
// .myrobots/plans/cv-range-standard.md).
//
// Inputs:
//   u_in (cv): UNITY-section signal input (linear attenuvert).
//   u_atten_cv (cv, linear, paramTarget=unityAtten): displaces UNITY atten.
//   a_in (cv): A-section signal input (curve-morphed attenuvert).
//   a_atten_cv (cv, linear, paramTarget=aAtten): displaces A atten.
//   a_curve_cv (cv, linear, paramTarget=aCurve): displaces A curve (linear ↔ expo).
//   b_in (cv): B-section signal input (curve-morphed attenuvert, same shape as A).
//   b_atten_cv (cv, linear, paramTarget=bAtten): displaces B atten.
//   b_curve_cv (cv, linear, paramTarget=bCurve): displaces B curve.
//
// Outputs:
//   u_out (cv): UNITY-section output (linear: u_in * atten).
//   a_out (cv): A-section output (sign(x) * |x|^k * atten).
//   b_out (cv): B-section output (same shape as A).
//
// Params:
//   unityAtten (linear -1..1, default 1): UNITY attenuvert.
//   aAtten (linear -1..1, default 1): A attenuvert.
//   aCurve (linear 0..1, default 0): A curve (0 = linear, 1 = expo).
//   bAtten (linear -1..1, default 1): B attenuvert.
//   bCurve (linear 0..1, default 0): B curve (0 = linear, 1 = expo).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/unityscalemathematik.js?url';

const PROCESSOR_NAME = 'unityscalemathematik';
const loadedContexts = new WeakSet<BaseAudioContext>();

/** Pure helpers extracted so unit tests can pin the math without a Web
 *  Audio context. */
export const unityScaleMath = {
  /** Linear attenuvert: y = x * atten with atten in [-1, +1]. */
  unity(x: number, atten: number): number {
    return x * atten;
  },
  /** Map curve in [0, 1] to the exponent k in [1, 3]. Linear interpolation. */
  curveToK(curve: number): number {
    const c = Math.max(0, Math.min(1, curve));
    return 1 + 2 * c;
  },
  /** Bipolar attenuvert with curve morph: preserves the sign of x and
   *  raises |x| to the curve-derived power before applying atten. */
  shape(x: number, atten: number, curve: number): number {
    const k = unityScaleMath.curveToK(curve);
    const mag = Math.pow(Math.abs(x), k);
    const sign = x < 0 ? -1 : x > 0 ? 1 : 0;
    return sign * mag * atten;
  },
};

export const unityscalemathematikDef: AudioModuleDef = {
  type: 'unityscalemathematik',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'unityscalemathematik',
  category: 'utilities',
  schemaVersion: 1,

  inputs: [
    { id: 'u_in',        type: 'cv' },
    { id: 'u_atten_cv',  type: 'cv', paramTarget: 'unityAtten', cvScale: { mode: 'linear' } },
    { id: 'a_in',        type: 'cv' },
    { id: 'a_atten_cv',  type: 'cv', paramTarget: 'aAtten',     cvScale: { mode: 'linear' } },
    { id: 'a_curve_cv',  type: 'cv', paramTarget: 'aCurve',     cvScale: { mode: 'linear' } },
    { id: 'b_in',        type: 'cv' },
    { id: 'b_atten_cv',  type: 'cv', paramTarget: 'bAtten',     cvScale: { mode: 'linear' } },
    { id: 'b_curve_cv',  type: 'cv', paramTarget: 'bCurve',     cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'u_out', type: 'cv' },
    { id: 'a_out', type: 'cv' },
    { id: 'b_out', type: 'cv' },
  ],
  params: [
    { id: 'unityAtten', label: 'Unity', defaultValue: 1, min: -1, max: 1, curve: 'linear' },
    { id: 'aAtten',     label: 'A Att', defaultValue: 1, min: -1, max: 1, curve: 'linear' },
    { id: 'aCurve',     label: 'A Crv', defaultValue: 0, min:  0, max: 1, curve: 'linear' },
    { id: 'bAtten',     label: 'B Att', defaultValue: 1, min: -1, max: 1, curve: 'linear' },
    { id: 'bCurve',     label: 'B Crv', defaultValue: 0, min:  0, max: 1, curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const worklet = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 3,
      numberOfOutputs: 3,
      outputChannelCount: [1, 1, 1],
    });

    const params = worklet.parameters as unknown as Map<string, AudioParam>;
    const initial = node.params ?? {};
    for (const def of unityscalemathematikDef.params) {
      const v = initial[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    const pUnity = params.get('unityAtten')!;
    const pAAtt  = params.get('aAtten')!;
    const pACv   = params.get('aCurve')!;
    const pBAtt  = params.get('bAtten')!;
    const pBCv   = params.get('bCurve')!;

    return {
      domain: 'audio',
      inputs: new Map([
        ['u_in',       { node: worklet, input: 0 }],
        ['u_atten_cv', { node: worklet, input: 0, param: pUnity }],
        ['a_in',       { node: worklet, input: 1 }],
        ['a_atten_cv', { node: worklet, input: 0, param: pAAtt  }],
        ['a_curve_cv', { node: worklet, input: 0, param: pACv   }],
        ['b_in',       { node: worklet, input: 2 }],
        ['b_atten_cv', { node: worklet, input: 0, param: pBAtt  }],
        ['b_curve_cv', { node: worklet, input: 0, param: pBCv   }],
      ]),
      outputs: new Map([
        ['u_out', { node: worklet, output: 0 }],
        ['a_out', { node: worklet, output: 1 }],
        ['b_out', { node: worklet, output: 2 }],
      ]),
      setParam(paramId, value) {
        switch (paramId) {
          case 'unityAtten': pUnity.setValueAtTime(value, ctx.currentTime); return;
          case 'aAtten':     pAAtt.setValueAtTime(value,  ctx.currentTime); return;
          case 'aCurve':     pACv.setValueAtTime(value,   ctx.currentTime); return;
          case 'bAtten':     pBAtt.setValueAtTime(value,  ctx.currentTime); return;
          case 'bCurve':     pBCv.setValueAtTime(value,   ctx.currentTime); return;
        }
      },
      readParam(paramId) {
        switch (paramId) {
          case 'unityAtten': return pUnity.value;
          case 'aAtten':     return pAAtt.value;
          case 'aCurve':     return pACv.value;
          case 'bAtten':     return pBAtt.value;
          case 'bCurve':     return pBCv.value;
        }
        return undefined;
      },
      dispose() {
        try { worklet.disconnect(); } catch { /* */ }
      },
    };
  },
};
