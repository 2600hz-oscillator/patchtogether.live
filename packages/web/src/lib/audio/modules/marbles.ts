// packages/web/src/lib/audio/modules/marbles.ts
//
// MARBLES — random sampler / Bernoulli-gate + quantized-CV generator
// (Mutable Instruments archetype). Audio-domain module def + a pure-math
// host mirror (marbles-engine.ts) for tests/ART. Worklet DSP at
// packages/dsp/src/marbles.ts.
//
// Source: eurorack/marbles/ — Copyright 2015 Émilie Gillet, MIT-licensed per
// file headers ("Code (STM32F projects): MIT license"). MIT is compatible
// with patchtogether.live's AGPL. See packages/dsp/src/marbles-core.ts.
//
// Outputs: t1 / t2 (Bernoulli/coin/clusters/drums/markov gates), x1 / x2 / x3
// (random voltages → SPREAD/BIAS/STEPS + weighted-scale quantizer + déjà-vu),
// clk (master clock). CV outputs are ±1 (= ±5V on hardware).
//
// Inputs:
//   rate_cv (cv, linear, paramTarget=rate): displaces the rate knob.
//   tmodel_cv (cv, discrete, paramTarget=t_model): displaces the T-section model.
//   tbias_cv (cv, linear, paramTarget=t_bias): displaces T BIAS.
//   tjitter_cv (cv, linear, paramTarget=t_jitter): displaces T JITTER.
//   dejavu_cv (cv, linear, paramTarget=deja_vu): displaces T déjà-vu (loop probability).
//   length_cv (cv, linear, paramTarget=length): displaces T loop length.
//   spread_cv (cv, linear, paramTarget=spread): displaces X SPREAD.
//   xbias_cv (cv, linear, paramTarget=x_bias): displaces X BIAS.
//   steps_cv (cv, linear, paramTarget=steps): displaces X STEPS.
//   xdejavu_cv (cv, linear, paramTarget=x_deja_vu): displaces X déjà-vu.
//   scale_cv (cv, discrete, paramTarget=scale): displaces the quantizer scale.
//
// Outputs:
//   t1 / t2 (gate): Bernoulli / coin / clusters / drums / Markov gate pair.
//   x1 / x2 / x3 (cv): three quantized random voltages (per X SPREAD/BIAS/STEPS + déjà-vu).
//   clk (gate): master clock-out.
//
// Params:
//   rate (linear -60..60 st, default 0): clock rate macro.
//   t_model (discrete 0..MARBLES_MAX_T_MODEL, default 0): T-section model.
//   t_bias / t_jitter / deja_vu (linear 0..1): T-section tunings.
//   length (discrete 1..16, default 8): T loop length when déjà-vu locks.
//   pw_mean (linear 0..1, default 0.5): pulse-width macro.
//   spread / x_bias / steps / x_deja_vu (linear 0..1): X-section macros.
//   x_length (discrete 1..16, default 8): X loop length when X déjà-vu locks.
//   scale (discrete 0..MARBLES_SCALE_NAMES.length, default 0): X-section quantizer scale.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/marbles.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
import {
  MARBLES_MAX_T_MODEL,
  MARBLES_SCALE_NAMES,
  MARBLES_SCALE_OPTIONS,
  MARBLES_T_MODEL_OPTIONS,
} from './marbles-names';
import {
  RandomStream,
  TGenerator,
  XYGenerator,
  PRESET_SCALES,
  T_MODEL,
  type GroupSettings,
} from './marbles-engine';

const loadedContexts = new WeakSet<BaseAudioContext>();

// The two named rosters live in `marbles-names.ts`, which imports NOTHING —
// this module's `?url` worklet import makes it unloadable from Node, and the
// e2e needs the strings. Re-exported so every existing consumer's import
// surface (the card, the shell cells) is unchanged.
export {
  MARBLES_T_MODEL_NAMES,
  MARBLES_MAX_T_MODEL,
  MARBLES_SCALE_NAMES,
  MARBLES_T_MODEL_OPTIONS,
  MARBLES_SCALE_OPTIONS,
} from './marbles-names';

const T_MODEL_ORDER = [
  T_MODEL.COMPLEMENTARY_BERNOULLI,
  T_MODEL.CLUSTERS,
  T_MODEL.DRUMS,
  T_MODEL.INDEPENDENT_BERNOULLI,
  T_MODEL.THREE_STATES,
  T_MODEL.MARKOV,
];

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export interface MarblesParams {
  rate: number;
  t_model: number;
  t_bias: number;
  t_jitter: number;
  deja_vu: number;
  length: number;
  pw_mean: number;
  spread: number;
  x_bias: number;
  steps: number;
  x_deja_vu: number;
  x_length: number;
  scale: number;
}

/**
 * Pure-math render — numerically identical to the worklet. Returns the gate +
 * CV streams over `n` samples. Used by unit tests + ART.
 */
export const marblesMath = {
  render(n: number, sr: number, params: MarblesParams) {
    const stream = new RandomStream(0x12345678);
    const t = new TGenerator(stream, sr);
    const xy = new XYGenerator(stream);
    for (let s = 0; s < PRESET_SCALES.length; s++) xy.loadScaleAll(s, PRESET_SCALES[s]!);
    t.reset();

    t.model = T_MODEL_ORDER[clamp(Math.round(params.t_model), 0, MARBLES_MAX_T_MODEL)]!;
    t.setRate(params.rate);
    t.setBias(clamp(params.t_bias, 0, 1));
    t.setJitter(clamp(params.t_jitter, 0, 1));
    t.setDejaVu(clamp(params.deja_vu, 0, 1));
    t.setLength(clamp(Math.round(params.length), 1, 16));
    t.setPulseWidthMean(clamp(params.pw_mean, 0, 1));

    const xSettings: GroupSettings = {
      spread: clamp(params.spread, 0, 1),
      bias: clamp(params.x_bias, 0, 1),
      steps: clamp(params.steps, 0, 1),
      dejaVu: clamp(params.x_deja_vu, 0, 1),
      scaleIndex: clamp(Math.round(params.scale), 0, PRESET_SCALES.length - 1),
      length: clamp(Math.round(params.x_length), 1, 16),
    };

    const t1 = new Float32Array(n);
    const t2 = new Float32Array(n);
    const x1 = new Float32Array(n);
    const x2 = new Float32Array(n);
    const x3 = new Float32Array(n);
    const clk = new Float32Array(n);
    const gateBuf = [false, false];
    const slaveBuf = [0, 0];
    const cvBuf = [0, 0, 0, 0];

    for (let i = 0; i < n; i++) {
      const masterPhase = t.processSample(2.0, gateBuf, slaveBuf);
      xy.processSample(xSettings, xSettings, masterPhase, cvBuf);
      t1[i] = gateBuf[0] ? 1 : 0;
      t2[i] = gateBuf[1] ? 1 : 0;
      x1[i] = clamp(cvBuf[0]! / 5, -1, 1);
      x2[i] = clamp(cvBuf[1]! / 5, -1, 1);
      x3[i] = clamp(cvBuf[2]! / 5, -1, 1);
      clk[i] = masterPhase < 0.5 ? 1 : 0;
    }
    return { t1, t2, x1, x2, x3, clk };
  },
};

export const marblesDef: AudioModuleDef = {
  type: 'marbles',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'marbles',
  category: 'sources',
  ossAttribution: { author: 'Émilie Gillet' },

  inputs: [
    { id: 'rate_cv', type: 'cv', paramTarget: 'rate', cvScale: { mode: 'linear' } },
    { id: 'tmodel_cv', type: 'cv', paramTarget: 't_model', cvScale: { mode: 'discrete' } },
    { id: 'tbias_cv', type: 'cv', paramTarget: 't_bias', cvScale: { mode: 'linear' } },
    { id: 'tjitter_cv', type: 'cv', paramTarget: 't_jitter', cvScale: { mode: 'linear' } },
    { id: 'dejavu_cv', type: 'cv', paramTarget: 'deja_vu', cvScale: { mode: 'linear' } },
    { id: 'length_cv', type: 'cv', paramTarget: 'length', cvScale: { mode: 'linear' } },
    { id: 'spread_cv', type: 'cv', paramTarget: 'spread', cvScale: { mode: 'linear' } },
    { id: 'xbias_cv', type: 'cv', paramTarget: 'x_bias', cvScale: { mode: 'linear' } },
    { id: 'steps_cv', type: 'cv', paramTarget: 'steps', cvScale: { mode: 'linear' } },
    { id: 'xdejavu_cv', type: 'cv', paramTarget: 'x_deja_vu', cvScale: { mode: 'linear' } },
    { id: 'scale_cv', type: 'cv', paramTarget: 'scale', cvScale: { mode: 'discrete' } },
  ],
  outputs: [
    { id: 't1', type: 'gate', edge: 'gate' },
    { id: 't2', type: 'gate', edge: 'gate' },
    { id: 'x1', type: 'cv' },
    { id: 'x2', type: 'cv' },
    { id: 'x3', type: 'cv' },
    { id: 'clk', type: 'gate', edge: 'trigger' },
  ],
  params: [
    { id: 'rate', label: 'Rate', defaultValue: 0, min: -60, max: 60, curve: 'linear', units: 'st' },
    { id: 't_model', label: 'T Model', defaultValue: 0, min: 0, max: MARBLES_MAX_T_MODEL, curve: 'discrete', options: MARBLES_T_MODEL_OPTIONS },
    { id: 't_bias', label: 'T Bias', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 't_jitter', label: 'T Jitter', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    { id: 'deja_vu', label: 'Déjà Vu', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    { id: 'length', label: 'Length', defaultValue: 8, min: 1, max: 16, curve: 'discrete' },
    { id: 'pw_mean', label: 'PWidth', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'spread', label: 'Spread', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'x_bias', label: 'X Bias', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'steps', label: 'Steps', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'x_deja_vu', label: 'X Déjà Vu', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    { id: 'x_length', label: 'X Length', defaultValue: 8, min: 1, max: 16, curve: 'discrete' },
    { id: 'scale', label: 'Scale', defaultValue: 0, min: 0, max: MARBLES_SCALE_NAMES.length - 1, curve: 'discrete', options: MARBLES_SCALE_OPTIONS },
  ],

  controlFamilies: [
    {
      // The two loops + the quantiser's surviving degrees — the faceplate's
      // hero picture. A control FAMILY (a `cell`) rather than a param because
      // it is a picture, not a value: nothing about it is stored, undoable or
      // MIDI-learnable.
      id: 'marbles-loop',
      label: 'Loops',
      kind: 'cell' as const,
      testidPrefix: 'marbles-loop',
    },
  ],

  docs: {
    explanation:
      "A random sampler and clock generator (a port of Mutable Instruments Marbles) with two halves driven by one master clock. It FREE-RUNS: from the moment it spawns the clk output is pulsing and both sections are producing, with nothing patched. The T section makes random GATES (t1/t2) whose character is set by a model, plus bias and jitter; the X section makes three random CONTROL VOLTAGES (x1/x2/x3) shaped by Spread and Bias, optionally lagged or quantized by Steps, and snapped to a Scale. THE CLOCK IS EXACT: f = 2 Hz x 2^(RATE/12), so RATE 0 is 120 BPM and the fader spans 3.75 BPM to 3840 BPM — at the bottom that is one pulse every 16 seconds, which looks like a broken module until you wait. DEJA VU IS THE MODULE'S IDEA AND ITS MAXIMUM IS ITS MIDDLE: the per-step probability that a section departs from its loop is (2*dv - 1)^2, so at 0 every step is freshly rolled, at 0.5 the loop plays back verbatim, and above 0.5 the loop's CONTENTS are frozen but its ORDER is scrambled — turning the knob past 12 o'clock makes it repeat LESS, not more. Two consequences follow and neither is visible from a knob: LENGTH and X LENGTH are bit-exactly inert at Deja Vu 0 (the shipped default), because every step overwrites the slot it is about to read; and STEPS has two regimes with a gap between them — below 0.5 it is a PORTAMENTO (the voltages glide for most of a step at the bottom of the dial), from 0.5 the glide is gone, and the quantizer does not engage until 0.536, so at the shipped 0.5 neither the lag nor the quantizer is doing anything and Scale is inert. Both ends of SPREAD are degenerate too: at 0.01 and below all three X outputs are a DC constant at 10*BIAS - 5 volts, and at 0.99 and above they stop being voltages and become a two-level coin flip between -5 V and +5 V. Every control has a dedicated CV input, so the randomness itself can be modulated.",
    inputs: {
      rate_cv: "CV that modulates the master clock Rate (in semitones, summed with the knob) — speeds up or slows down both the T and X sections together. The law is exact: f = 2 Hz x 2^(RATE/12).",
      tmodel_cv: "Discrete CV that modulates the T-section Model select, stepping between COIN / CLUSTERS / DRUMS / INDEP / 3-STATE / MARKOV. Note that CLUSTERS is not implemented in this port and behaves exactly as COIN, so the six positions are five behaviours.",
      tbias_cv: "CV that modulates the T-section Bias (0..1, summed with the knob) — for the two Bernoulli models it sets the split directly, P(t1) = 1 - Bias, and the two gates share every clock between them.",
      tjitter_cv: "CV that modulates the T-section Jitter (0..1) — adds or removes timing humanization on the random gates. It is a zero-mean displacement, so the average tempo does not move with it.",
      dejavu_cv: "CV that modulates the T-section Déjà Vu (0..1). Not a monotone lock: the loop is tightest at 0.5 and both ends of the range are equally disordered — below 0.5 by re-rolling values, above it by jumping around the loop it already has.",
      length_cv: "CV that modulates the T loop Length (1..16 steps). It has no effect at all while Déjà Vu is 0, where every step re-rolls and the loop is never read back.",
      spread_cv: "CV that modulates the X-section Spread (0..1) — widens or narrows how far the three random voltages wander. Both ends are degenerate: at 0.01 and below the outputs are a DC constant, at 0.99 and above a two-level coin flip.",
      xbias_cv: "CV that modulates the X-section Bias (0..1) — shifts the centre of the three random voltages, and sets WHERE the two degenerate ends of Spread land (a DC of 10*Bias - 5 volts, or the probability of the +5 V side of the coin flip).",
      steps_cv: "CV that modulates the X-section Steps (0..1). Below 0.5 it is the portamento TIME — 0 glides for most of a step, and the glide is gone by 0.49. From 0.536 it is the quantizer depth instead, in seven levels.",
      xdejavu_cv: "CV that modulates the X-section Déjà Vu (0..1) — the same non-monotone law as the T one, applied to the three control voltages.",
      scale_cv: "Discrete CV that modulates the X-section quantizer Scale select (C major, C minor, pentatonic, Pelog, Raag Bhairav, Raag Shri). It does nothing while Steps is below 0.536.",
    },
    outputs: {
      t1: "First random gate from the T section, opening per the selected model's logic and bias. Its width is a FIXED fraction of the step — 5% + 90% x PWidth, the same for every gate — not a per-gate random span. Patch into a drum or envelope input.",
      t2: "Second random gate from the T section — complementary to t1 under COIN and CLUSTERS (exactly one of the two opens on every clock) and independent of it under INDEP (both can open at once, or neither). It stays high for the same fixed fraction of the step as t1 — 5% + 90% x PWidth — so the two together build call-and-response rhythms at a matched gate length.",
      x1: "First random control voltage from the X section, shaped by Spread and Bias, lagged or quantized by Steps, and snapped to the chosen Scale when the quantizer is engaged. Patch into a pitch input.",
      x2: "Second random control voltage, decorrelated from x1 — a different but related stream for a second voice or parameter.",
      x3: "Third random control voltage, decorrelated from x1 and x2 — a third independent stream.",
      clk: "The master clock output that paces both sections. A 50% square at EVERY setting — PWidth moves the t1/t2 gate width and leaves this untouched — so clocking another module from here gives it a half-step gate regardless of how tight the T gates are set.",
    },
    controls: {
      rate: "Master clock rate in semitones (-60..+60). Exact law: f = 2 Hz x 2^(RATE/12), i.e. 120 BPM at 0, 3.75 BPM at -60 (one pulse every 16 seconds) and 3840 BPM at +60. It drives both the T gates and the X voltages, and the clk output.",
      t_model:
        "Picks the T-section gate model: COIN (a complementary coin toss — exactly one of t1/t2 fires per clock), CLUSTERS, DRUMS (18 fixed 8-step patterns), INDEP (two independent coins, so both gates can fire on one clock or neither), 3-STATE (a clock can pass with no gate at all), or MARKOV (a state machine over its own recent history). CLUSTERS IS NOT IMPLEMENTED in this port: the DSP falls through to the COIN generator for it, so the six named models are five behaviours and the faceplate prints CLUSTERS as 'CLUSTERS -> COIN'.",
      t_bias: "Sets the t1/t2 split. Under the two Bernoulli models the law is exact — P(t1) = 1 - Bias, so 0 sends every gate to t1 and 1 sends every gate to t2 — and the two outputs always share the clock between them. Under DRUMS it picks the pattern, under 3-STATE it steers all three outcomes, and under MARKOV it steers the transition logit.",
      t_jitter: "Adds timing humanization to the T gates (0..1): 0 is metronomic, higher values loosen the placement. The displacement is zero-mean, so the average tempo is unchanged (measured stable to 0.44% across the whole range while the spread of intervals grows without bound).",
      deja_vu:
        "The T-section loop control (0..1), and its maximum is its MIDDLE. The per-step probability of departing from the loop is (2*dv - 1)^2: at 0 that is 1, so every step is a fresh random value and there is no loop; at 0.5 it is 0 and the loop plays back verbatim — this is the tightest setting; above 0.5 the loop's contents are frozen but each step may JUMP to a random position in it, with the same probability curve rising back to 1 at the top. So turning it past 12 o'clock makes the pattern repeat LESS.",
      length: "How many steps long the T-section loop is (1..16). BIT-EXACTLY INERT while Déjà Vu is 0 — the shipped default — because at that setting every step overwrites the slot it is about to read, so no loop is ever played back. Move Déjà Vu off zero before this control does anything.",
      pw_mean: "The width of the t1/t2 gates as a fraction of the step: exactly 5% + 90% x PWidth, the same for every gate. It does NOT affect clk, which stays a 50% square at every setting.",
      spread: "How far the three X voltages wander from the centre (0..1). BOTH ENDS ARE DEGENERATE: at 0.01 and below all three outputs collapse to a DC constant at 10*XBias - 5 volts (0 V at the default Bias), and at 0.99 and above they become a two-level coin flip between -5 V and +5 V rather than a continuous voltage. The useful range is everything in between.",
      x_bias: "The centre the three X voltages sit around (0..1), and the value that decides WHERE Spread's two degenerate ends land — the DC level at the bottom (10*XBias - 5 volts) and the odds of the +5 V side of the coin flip at the top. On its own, at the shipped Spread, it skews the distribution; it does not freeze it.",
      steps: "TWO CONTROLS IN ONE DIAL, with a gap between them. Below 0.5 it is the PORTAMENTO time: at 0 the voltages glide for roughly 90% of a step, and the glide shrinks to nothing by 0.49. From 0.5 the output steps hard. The QUANTIZER does not engage until 0.536, and then runs in seven levels up to the top, each level keeping fewer of the scale's degrees. The shipped default of 0.5 sits in the gap: no glide left, no quantization yet, and therefore no Scale.",
      x_deja_vu: "The X-section loop control (0..1) — the same law as Déjà Vu, applied to the three voltages: (2*dv - 1)^2 is the chance a step departs from the loop, so repetition peaks at 0.5 and falls away toward BOTH ends.",
      x_length: "How many steps long the X-section loop is (1..16). Bit-exactly inert while X Déjà Vu is 0, for the same reason as Length.",
      scale:
        "The quantizer scale the X voltages snap to: C major, C minor, pentatonic, Pelog, Raag Bhairav, or Raag Shri. Each scale weights its degrees, and the Steps level decides how many of them survive — so the six scales are only ALL distinguishable in the middle of the quantizer's range (Steps 0.607 to 0.893). Below Steps 0.536 the quantizer is off and Scale does nothing at all; at the very top only the root survives and every scale gives octaves.",
      'marbles-loop-{n}':
        "The faceplate picture: one row of slots per section (T and X) showing each loop's length and how much of it survives a step, plus a one-octave ruler marking which of the current scale's degrees the quantizer is keeping. A section with no loop draws a single slot rather than a length it is not honouring, and an empty ruler means the quantizer is off.",
    },
  },

  // ── THE FACEPLATE ─────────────────────────────────────────────────────────
  //
  // marbles is the RANDOM SOURCE of the rack — nothing else does this — and it
  // is the module most tempted to NARRATE, because randomness genuinely cannot
  // be read off knob positions. This face does not narrate. Owner directive
  // 2026-08-11: *"we should prefer almost zero AI authored text… our old faces
  // are pretty self explanatory. i want to lose all the ai text, and bring back
  // right click → annotate based on authored docs."*
  //
  // So there is no `hint`, no band hint, no explanatory caption anywhere. What
  // the faceplate carries instead is BARE VALUES chosen so that the value IS
  // the fact — every explanation is in `docs` above, one right-click away.
  // Three of them do the work the prose would have done:
  //
  //   `T random` / `X random`   `p = (2·dv − 1)²`, as a percentage. It reads
  //     100 % at DÉJÀ VU 0, falls to 0 % at 0.5, and climbs back to 100 % at
  //     the top. The single most misunderstood thing about this module — that
  //     the MAXIMUM of the knob is not the maximum of the behaviour — is
  //     visible in one number while turning one dial, with nothing written.
  //
  //   `T loop` / `X loop`       prints `free` rather than a length while its
  //     DÉJÀ VU is 0, because LENGTH is BIT-EXACTLY inert there (measured: one
  //     distinct t1 stream across lengths 1/2/3/4/5/8/16). A dial reading `8`
  //     beside a loop that does not exist is the defect this replaces.
  //
  //   `glide` + `quantiser`     `0 %` and `off`, together, at the shipped
  //     STEPS 0.50. Two adjacent values state the gap — the portamento has
  //     ended at 0.49 and the quantiser does not start until 0.536 — which is
  //     why SCALE is inert on a freshly spawned module.
  //
  // Everything printed is derived in `$lib/ui/modules/marbles-face-model` and
  // re-derived from a real `marblesMath` render by an ORACLE in that module's
  // test, so a DSP change turns a stale claim red rather than leaving the
  // faceplate insisting on it.
  //
  // ⚠ THE SPEC THIS WAS BUILT FROM WAS WRONG FOUR TIMES, all of them the same
  // failure — probing a random process at one seed on a coarse grid — and the
  // corrections are the reason several of the choices above look different from
  // what it proposed. Recorded here because the next reader of that file needs
  // to know: (1) it reported the T loop SATURATED across the whole top half of
  // DÉJÀ VU while only the X one was non-monotone; BOTH are non-monotone and
  // both peak at exactly 0.5, and the saturation was an artifact of `length 4`
  // plus an IOI metric on a seed whose four slots sat on one side of the gate
  // threshold. (2) It reported X BIAS's two ends as DC constants; at the
  // shipped SPREAD they give 48 distinct values each. The DC collapse is
  // SPREAD's, and BIAS only chooses where it lands. (3) It reported STEPS'
  // bottom half as "a dead knob"; it is the PORTAMENTO, and the def's own prose
  // had its direction inverted. (4) It called CLUSTERS "a genuine behavioural
  // collapse in marbles-core"; it is a two-line commented STUB
  // (`case T_MODEL.CLUSTERS: … generateComplementaryBernoulli`).
  //
  // ⚠ AND ITS LAYOUT CLAIM WAS ARITHMETIC. "SIX BANDS ⇒ the dock TAB RAIL,
  // deliberately" — `DOCK_TAB_MIN_BANDS` is 7. Six bands stack, as cube's and
  // cofefve's do.
  //
  // ⚠ ONE DEFECT IS DOCUMENTED RATHER THAN FIXED: CLUSTERS. Implementing it
  // means porting the firmware's cluster generator, which changes audio, so it
  // is its own PR. The face refuses to paint it as working — the `model`
  // readout prints `CLUSTERS → COIN`.
  face: {
    // 1-6 is the LANE budget (`faceTierCap('full')`). RATE first because
    // nothing else means anything until the clock is where you want it;
    // DÉJÀ VU second because it is the module's whole idea; then the two
    // section-defining macros (T BIAS splits the gates, SPREAD sets the X
    // width), STEPS fifth because it is the control most likely to be found
    // dead, and T MODEL sixth.
    //
    // Rank 7 for the picture: module-face-lint refuses a PANEL selected at a
    // lane tier and the cap is 6, so a hero picture's first legal rank is 7.
    // Fourteen keys, so it is comfortably reachable.
    order: [
      'rate',
      'deja_vu',
      't_bias',
      'spread',
      'steps',
      't_model',
      'marbles-loop-{n}',
      'x_deja_vu',
      'length',
      'scale',
      'x_bias',
      'x_length',
      't_jitter',
      'pw_mean',
    ],

    // SIX BANDS, PLAIN LABELS. One clock, then T and X in the same three
    // shapes each (what it makes · its loop), so the panel teaches the
    // module's symmetry by its layout rather than by saying so.
    //
    // ⚠ THE PANEL MUST BE CLAIMED BY A BAND EVEN THOUGH THE HERO PROMOTES IT
    // OUT AGAIN. A ranked key that no page claims lands in `dockFacePlan`'s
    // defensive `__all` band — and `DockFullView` builds its tab rail from the
    // PRE-hero-split band list, so an unclaimed panel made this a SEVEN-band
    // face that tripped `DOCK_TAB_MIN_BANDS` and rendered a tab rail (six band
    // chips plus `more`) over a faceplate that still stacked all six bands
    // underneath. Caught by workflow-shell-faces' structural assertion, not by
    // any unit gate: `module-face-lint` reads the POST-split plan, where the
    // emptied band is already gone. T LOOP claims it; the hero takes it and
    // DÉJÀ VU out, and the band keeps LENGTH, so nothing empties.
    pages: [
      { id: 'clock', label: 'CLOCK', controls: ['rate', 't_jitter'] },
      { id: 'tgates', label: 'T GATES', controls: ['t_model', 't_bias', 'pw_mean'] },
      { id: 'tloop', label: 'T LOOP', controls: ['marbles-loop-{n}', 'deja_vu', 'length'] },
      { id: 'x', label: 'X CV', controls: ['spread', 'x_bias'] },
      { id: 'xquant', label: 'QUANTISER', controls: ['steps', 'scale'] },
      { id: 'xloop', label: 'X LOOP', controls: ['x_deja_vu', 'x_length'] },
    ],

    // ⚠ NINE FADERS, DECLARED, because `MarblesCard` draws every one of these
    // as a `<Fader>` and the shell paints a ranked param with `KnobConic`
    // unless told otherwise (the `fader` cell kind, #1464). Substituting a dial
    // for a throw is a real regression even though the value semantics are
    // identical.
    //
    // ⚠ `length` AND `x_length` ARE THE EXCEPTION AND IT IS NOT A CHOICE.
    // module-face-lint's `fader` clause rejects a DISCRETE param outright, so
    // the two loop lengths — which the card DOES draw as (discrete) faders —
    // stay knobs on the face. Named here rather than left to be noticed.
    //
    // ⚠ T MODEL AND SCALE ARE GRIDS, NOT SEGMENTED ROWS. Both declare a
    // six-entry `options` roster, which resolves to `<Segmented>` at the dock —
    // and `.seg` is `flex: 1`, i.e. flex-BASIS 0, so every caption is allotted
    // the roster MEAN width. `filter` ships three TWO-LETTER options and still
    // renders `LP · H… · B…`; "Raag Bhairav" against a 8.7-character mean has
    // no chance. The grid's chip + portaled popover shows all six in full.
    paramCells: {
      rate: 'fader',
      deja_vu: 'fader',
      t_bias: 'fader',
      t_jitter: 'fader',
      spread: 'fader',
      x_bias: 'fader',
      steps: 'fader',
      pw_mean: 'fader',
      x_deja_vu: 'fader',
      t_model: 'grid',
      scale: 'grid',
    },

    // ⚠ NO GLYPH, AND THAT IS A MEASUREMENT RATHER THAN A PREFERENCE. This
    // face shipped `glyph: 'meter'` through three review passes before the
    // binding was actually read: `primaryAudioOutPortId` matches
    // `o.type === 'audio'`, and marbles declares NO audio output — t1/t2/clk
    // are `gate` and x1/x2/x3 are `cv`. So `glyphBinding` falls all the way
    // through to `{ kind: 'static' }`, `tap` is undefined, and `<VuMeter>`
    // renders with its `level = 0` default: TWELVE SEGMENTS THAT CAN NEVER
    // LIGHT, on the one module in the rack that is producing from the instant
    // it spawns. A permanently dead meter is the exact thing this programme
    // refuses to paint, so there is no glyph at all.
    //
    // No other kind resolves either — `envelope` needs A/D/S/R, `algorithm`
    // needs an `algorithm` param, `waveform` needs a 0..2 `shape` — so every
    // glyph on this module is decoration until the resolver learns to tap a
    // gate or CV output, which is a platform change and not a face PR's.
    //
    // ⚠ AND IT MEANS marbles IS NOT A FREEZE WITNESS. A draft of this face
    // claimed it was the roster's third free-running exerciser of #1420's
    // pre-frame AudioContext freeze. It free-runs, but with no analyser tap
    // the capture has nothing to be a moving target — the claim was about a
    // glyph that was never live. See e2e/vrt/_shell-faces.
    //
    // The compact tier gains a cell for it: `faceTierCap('compact')` is 3
    // without a glyph and 2 with one, so the lane tile shows RATE, DÉJÀ VU and
    // T BIAS instead of two of them beside a dead bar.
    glyph: 'none',

    title: 'Random',

    // THE HERO. The picture, DÉJÀ VU promoted beside it at XL — the control the
    // picture is about — and four bare values.
    //
    // ⚠ NO `action`. marbles free-runs; it is producing clock pulses from the
    // moment it spawns, so there is nothing to audition and an audition button
    // would mean nothing.
    hero: {
      cell: 'marbles-loop-{n}',
      control: 'deja_vu',
      readouts: [
        { label: 'clock', valueId: 'marbles-bpm' },
        { label: 'step', valueId: 'marbles-step' },
        { label: 'T random', valueId: 'marbles-t-random' },
        { label: 'X random', valueId: 'marbles-x-random' },
      ],
    },

    // TWO BLOCKS, one per section, every entry a bare value.
    //
    // ⚠ A `signal-flow` BLOCK WAS DRAFTED AND CUT. Its stages would have been
    // RATE → the two sections → their outputs, which is what the two rows of
    // the hero picture already show, and its `note` fields were exactly the
    // editorial captions the owner's directive rules out.
    sidebar: [
      {
        kind: 'readouts',
        label: 'T',
        entries: [
          // `CLUSTERS → COIN` when the stub is selected: the model the DSP is
          // RUNNING, which is not always the one the selector names.
          { label: 'model', valueId: 'marbles-model' },
          // Exact for the two Bernoulli models (P(t1) = 1 − BIAS) and `—` for
          // the three with no closed form. A blank is honest; a plausible
          // number would not be.
          { label: 't1 / t2', valueId: 'marbles-t-split' },
          // The gate width against `clk`'s fixed 50 %. Two adjacent numbers
          // that disagree are the whole point of the pair.
          { label: 'gate', valueId: 'marbles-gate-width' },
          { label: 'clk', text: '50 %' },
          { label: 'T loop', valueId: 'marbles-t-loop' },
        ],
      },
      {
        kind: 'readouts',
        label: 'X',
        entries: [
          { label: 'X loop', valueId: 'marbles-x-loop' },
          { label: 'shape', valueId: 'marbles-x-shape' },
          { label: 'glide', valueId: 'marbles-glide' },
          { label: 'quantiser', valueId: 'marbles-quantiser' },
          { label: 'scales', valueId: 'marbles-scales' },
        ],
      },
      {
        // ACTIONS, not prose. Each one puts the module into a state where a
        // control that is inert at the factory default starts working — which
        // is the fastest way to learn this module and needs no sentence.
        kind: 'presets',
        label: 'presets',
        entries: [
          { id: 'locked', label: 'locked', values: { deja_vu: 0.5, x_deja_vu: 0.5 } },
          { id: 'shuffled', label: 'shuffled', values: { deja_vu: 1, x_deja_vu: 1 } },
          { id: 'glide', label: 'glide', values: { steps: 0 } },
          { id: 'pentatonic', label: 'pentatonic', values: { steps: 0.75, scale: 2 } },
        ],
      },
    ],
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }
    const workletNode = createWorkletNode(node, ctx, 'marbles', {
      numberOfInputs: 0,
      numberOfOutputs: 6,
      outputChannelCount: [1, 1, 1, 1, 1, 1],
    });
    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of marblesDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }
    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['rate_cv', { node: workletNode, input: 0, param: params.get('rate')! }],
        ['tmodel_cv', { node: workletNode, input: 0, param: params.get('t_model')! }],
        ['tbias_cv', { node: workletNode, input: 0, param: params.get('t_bias')! }],
        ['tjitter_cv', { node: workletNode, input: 0, param: params.get('t_jitter')! }],
        ['dejavu_cv', { node: workletNode, input: 0, param: params.get('deja_vu')! }],
        ['length_cv', { node: workletNode, input: 0, param: params.get('length')! }],
        ['spread_cv', { node: workletNode, input: 0, param: params.get('spread')! }],
        ['xbias_cv', { node: workletNode, input: 0, param: params.get('x_bias')! }],
        ['steps_cv', { node: workletNode, input: 0, param: params.get('steps')! }],
        ['xdejavu_cv', { node: workletNode, input: 0, param: params.get('x_deja_vu')! }],
        ['scale_cv', { node: workletNode, input: 0, param: params.get('scale')! }],
      ]),
      outputs: new Map([
        ['t1', { node: workletNode, output: 0 }],
        ['t2', { node: workletNode, output: 1 }],
        ['x1', { node: workletNode, output: 2 }],
        ['x2', { node: workletNode, output: 3 }],
        ['x3', { node: workletNode, output: 4 }],
        ['clk', { node: workletNode, output: 5 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try {
          workletNode.disconnect();
        } catch {
          /* */
        }
      },
    };
  },
};
