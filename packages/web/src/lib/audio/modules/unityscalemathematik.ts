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
// docs/adr/004-cv-range-convention.md).
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

import { createWorkletNode } from '$lib/audio/worklet-guard';
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

  // ── THE FACEPLATE (PF-20) — queue Q15, COHORT 3 ──────────────────────────
  //
  // WHAT THIS MODULE IS FOR, and every rank below descends from it: six other
  // modules in the rack attenuate or invert a control voltage — `scaler`,
  // `polarizer`, `depolarizer`, `attenumix`, `illogic`, `analogLogicMaths` —
  // and every one of them is a STRAIGHT LINE, out = in × k. This is the only
  // module that changes the SHAPE of a voltage rather than its size. The verb
  // is *bend the response*.
  face: {
    // 1 — A CRV, the IDENTITY. Measured on the shipped worklet through this
    //     def's own factory (art/scenarios/unityscalemathematik/cv-path.test.ts):
    //     a 0.5 input leaves at 0.500 / 0.250 / 0.125 across its travel while a
    //     2.0 input leaves at 2.00 / 4.00 / 8.00 — it moves the two halves of
    //     the range in OPPOSITE directions, which is the one thing no
    //     attenuverter anywhere in the rack can do.
    // 2 — A ATT, A's scale/invert AND its ENABLER: at 0 the whole A channel is
    //     dead, curve included. It ranks under the identity and over everything
    //     in B because it is UNCONDITIONALLY applicable — it still works at
    //     curve 0, where this module is just an attenuverter.
    // 3/4 — B's pair. The same law again on a second channel.
    // 5 — UNITY, ranked LAST deliberately: it does the one thing three other
    //     modules already do, and it is the only control here that cannot bend
    //     anything. It is also the only one with no readout, because a dB
    //     conversion of a single dial IS that dial relabelled.
    //
    // Tier ladder as a sentence: mini shows A CRV; compact adds A ATT; the
    // six-cell lane plate and the dock both show all five, so the ranking's
    // whole authority is at the top two.
    order: ['aCurve', 'aAtten', 'bCurve', 'bAtten', 'unityAtten'],

    // PAGES BY SIGNAL ORDER (u → a → b), deliberately disagreeing with `order`,
    // which is priority: UNITY is the FIRST section on the panel and the LAST
    // thing worth reaching for.
    //
    // ⚠ WHY THREE PAGES AND NOT ONE PAGE WITH TWO CLUSTERS. A and B are the
    // documented cluster case on the face of it — "the same idea, twice" — and
    // that was the first draft. The REAR CARD settles it the other way:
    // `rearFieldPlan` derives one rear band per `pages` page and files each
    // page's CV holes under it, and this module's five CV jacks partition
    // EXACTLY by section (u_atten_cv | a_atten_cv + a_curve_cv | b_atten_cv +
    // b_curve_cv). Clustering A and B onto one `shape` page would pile four of
    // those five jacks into one band and lose the only structure the rear has.
    // Three pages keep the front and the back saying the same thing.
    pages: [
      { id: 'unity', label: 'unity', controls: ['unityAtten'] },
      { id: 'a', label: 'a', controls: ['aCurve', 'aAtten'] },
      { id: 'b', label: 'b', controls: ['bCurve', 'bAtten'] },
    ],

    // ⚠ 'none' IS A DECISION, NOT A DEFAULT. `primaryAudioOutPortId` matches
    // `type === 'audio'`; this module declares three `cv` outputs and no audio
    // output at all, so ANY other glyph resolves to `{kind:'static'}` — a
    // live-looking readout of NOTHING. That is the marbles defect (#1692) and
    // the ninelives near-miss (#1706); `module-face-lint`'s dead-glyph clause
    // is unconditional now and would refuse anything else. The face takes the
    // extra lane cell instead.
    glyph: 'none',
    hero: {
      control: 'aCurve',
    },
    // No `title`, no `hint`, no band hints, no sidebar — owner ruling
    // 2026-08-11 (marbles / resofilter): plain labels and values on the face;
    // the explanation lives in `docs`, one right-click away.
  },

  docs: {
    explanation:
      "A bipolar CV-shaping utility with three independent channels. UNITY is a plain attenuverter — out = in · atten, with atten swinging -1..+1 so it can scale, attenuate, OR invert a signal. A and B are the same attenuverter PLUS a curve morph: each adds a knob that bends the response from linear toward exponential. The shaping math preserves the sign of the input and raises its magnitude to a power: y = sign(x)·|x|^k·atten where k = 1 + 2·curve runs from 1 (linear) to 3 (steep expo). A steep curve PIVOTS the response about a magnitude of 1: below it small signals are pushed further down (0.5 in leaves at 0.125 at full curve, 0.25 in at 0.0156), and ABOVE it the same curve EXPANDS — a ±2 input leaves at ±8, a ±3 at ±27. So it tames a hot LFO whose peaks sit at or under 1, and it is a gain stage for anything hotter; the crossover is exactly |1|, and unity is the only magnitude the curve leaves alone. The map is continuous through the bipolar zero crossing (no kink). Each atten and each curve also has its own CV input. There is a DSP worklet for the per-sample math.",
    inputs: {
      u_in: "UNITY-section signal input. Passed through the linear attenuverter: u_out = u_in · unityAtten.",
      u_atten_cv: "CV that sums into the UNITY attenuverter amount (linear), modulating how much the UNITY section scales/inverts its input.",
      a_in: "A-section signal input. Passed through the curve-morphed attenuverter: a_out = sign·|a_in|^k·aAtten.",
      a_atten_cv: "CV that sums into the A attenuverter amount (linear) — voltage control over A's scale/invert.",
      a_curve_cv: "CV that sums into the A curve amount (linear), sliding A's response between linear and exponential under modulation.",
      b_in: "B-section signal input. Same curve-morphed attenuverter shape as A: b_out = sign·|b_in|^k·bAtten.",
      b_atten_cv: "CV that sums into the B attenuverter amount (linear).",
      b_curve_cv: "CV that sums into the B curve amount (linear), modulating B's linear↔exponential bend.",
    },
    outputs: {
      u_out: "UNITY-section output, u_in · unityAtten — the plainly attenuverted (scaled, possibly inverted) signal.",
      a_out: "A-section output, sign(a_in)·|a_in|^k·aAtten with k from the A curve — the sign-preserving curve-shaped attenuvert.",
      b_out: "B-section output, the same sign-preserving curve-shaped attenuvert as A driven by B's own atten + curve.",
    },
    controls: {
      unityAtten: "UNITY attenuverter, linear -1..+1 (default +1 = unity passthrough). +1 passes the input as-is, 0 mutes, -1 inverts; in between it attenuates (and flips below 0).",
      aAtten: "A-section attenuverter, linear -1..+1 (default +1). Scales A's curve-shaped output; negative values invert it.",
      aCurve: "A-section curve, linear 0..1 (default 0 = linear). 0 is a straight attenuvert; turning it up bends the response toward exponential (exponent k goes 1→3). It PIVOTS about an input magnitude of 1, which is the only magnitude it leaves alone: below 1 it pushes signals further down (0.5 in leaves at 0.125 at full curve), above 1 it lifts them (2 in leaves at 8). Sign is always kept.",
      bAtten: "B-section attenuverter, linear -1..+1 (default +1). Scales B's curve-shaped output; negative inverts.",
      bCurve: "B-section curve, linear 0..1 (default 0 = linear), bending B's response from linear toward steep exponential exactly like A's curve — same pivot at an input magnitude of 1, same expansion above it.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const worklet = createWorkletNode(node, ctx, PROCESSOR_NAME, {
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
