// packages/web/src/lib/audio/modules/swolevco.ts
//
// SWOLEVCO — Buchla 259-style complex waveform generator. The "swoleVCO"
// of the patchtogether.live oscillator lineup: two oscillators in one
// module, audio-rate cross-modulation ("timbre"), waveform morph
// ("symmetry"), West-Coast wavefolder, plus a mono-video scope output of
// the primary signal. Pure JS Web Audio — no Faust DSP — modeled after
// ILLOGIC's structure.
//
// Architecture:
//
//   PRIMARY OSC (3 OscillatorNodes — saw, triangle, square, all on the
//   SAME frequency) → 3-way symmetry crossfade GainNodes → wavefolder
//   (4x oversampled WaveShaperNode, shared buildFoldCurve helper)
//   → output bus.
//
//   MODULATOR OSC (single OscillatorNode, sine) → modulator output port
//   AND → timbreGain (×timbre amount × 200 Hz of deviation) → connected
//   to each PRIMARY OSC's .frequency AudioParam (audio-rate FM).
//
//   SUM OUT = output bus + modulator (summed via a GainNode bus).
//
//   SCOPE = AnalyserNode tap on the output bus (post-fold, pre-sum). The
//   shared waveform-video.ts renderer in the VideoEngine consumes this
//   when a video edge is patched to the `scope` port.
//
// Pitch convention (matches the project, see analog-vco.dsp):
//   pitch CV is 1V/oct, 0V = C4 = 261.626 Hz. We compute base Hz from
//   the (tune semitones + fine cents) knobs as a MULTIPLIER of 261.626;
//   the pitch-CV connection then routes through a "voct → freqMul"
//   audio-rate processor (a WaveShaperNode whose curve is
//   261.626 * 2^(x*K)) such that each volt = one octave shift. We don't
//   have an AudioWorkletProcessor for that — the cleanest pure-JS path
//   is to drive .frequency directly from a ConstantSource on a base Hz
//   and let the user CV input modulate via a parallel scaling network.
//
//   Pragmatic reality for v1: we set the OscillatorNode's intrinsic
//   .frequency from (tune+fine) on knob change; pitch CV input feeds an
//   intermediate WaveShaperNode that converts V/oct → Hz multiplier
//   (centered around 261.626 Hz baseline). The output of that goes to
//   .frequency as additional Hz. This gives correct V/oct behavior for
//   the common case where pitch CV is the dominant driver (sequencer,
//   keyboard).
//
// Timbre = audio-rate FM amount. modulator → timbreGain (range 0..200 Hz
// of deviation per fully-open knob) → primary .frequency AudioParam.
//
// Symmetry = 0..1, three-way crossfade across saw / triangle / square:
//   * 0.0  → saw only
//   * 0.5  → triangle only
//   * 1.0  → square only
//   * In between, linear blend between adjacent shapes.
// Implementation: each shape oscillator feeds its own GainNode whose
// .gain is driven at AUDIO RATE from the symmetry control signal through
// a WaveShaper LUT of `symmetryGains` — so knob and CV take the identical
// path. Same for timbre (× 200 Hz), fold (drive + fixed folder + dry/wet
// gate) and ratio (track + free-run gate); see the factory. Nothing in
// this module applies a CV-modulated param from JavaScript.
//
// Fold = 0..1, shared helper with WAVVIZ (4x oversample WaveShaperNode
// with sin foldback curve).
//
// Inputs:
//   pitch (pitch): V/oct pitch input, drives the primary oscillator.
//   mod_pitch (pitch): V/oct pitch input for the modulator oscillator.
//   fm (audio): external audio-rate FM modulator routed to the primary.
//   timbre (cv, linear, paramTarget=timbre): displaces the timbre (FM) amount.
//   symmetry (cv, linear, paramTarget=symmetry): displaces the saw↔tri↔square crossfade.
//   fold (cv, linear, paramTarget=fold): displaces the wavefold amount.
//   ratio (cv, linear, paramTarget=ratio): displaces the modulator-to-primary ratio.
//
// Outputs:
//   out (audio): primary post-fold waveform.
//   mod_out (audio): the modulator oscillator's sine output (patchable as a clean sine source).
//   sum_out (audio): primary + modulator summed (mix tap).
//   scope (mono-video): live oscilloscope trace of `out`.
//
// Params:
//   tune (linear -36..36 st, default 0): primary coarse tune.
//   fine (linear -100..100 ¢, default 0): primary fine tune.
//   mod_tune (linear -36..36 st, default 0): modulator coarse tune.
//   mod_fine (linear -100..100 ¢, default 0): modulator fine tune.
//   ratio (linear 0..8, default 1.0): modulator-to-primary frequency ratio.
//   timbre (linear 0..1, default 0): audio-rate FM amount from modulator → primary.
//   symmetry (linear 0..1, default 0.5): three-way crossfade saw / tri / square.
//   fold (linear 0..1, default 0): West-Coast wavefolder amount.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { buildFoldCurve } from '$lib/audio/fold-curve';

/** Base Hz at 0V/oct = C4 = 261.626 Hz (matches analog-vco.dsp). */
const C4_HZ = 261.626;

/** Maximum FM deviation (Hz) at timbre = 1.0. 200Hz at C4 is roughly
 *  ±4 semitones — enough to reach Buchla territory without veering
 *  into noise. */
const TIMBRE_MAX_HZ = 200;

/** V/oct → Hz table size. Range: ±5 octaves around C4 covers MIDI 12..108
 *  which is more than the project's MIN_MIDI..MAX_MIDI range.
 *
 *  **ODD ON PURPOSE**, for the same reason as `CURVE_LEN` in
 *  $lib/audio/cv-scale (see that comment for the full argument): a
 *  WaveShaperNode interpolates between `curve[⌊v⌋]` and `curve[⌊v⌋+1]`, so an
 *  EVEN table has no sample at the centre and 0 V — the value a patched-but-
 *  idle V/oct cable holds — reads as the MEAN of its two neighbours. `2^v - 1`
 *  is convex, so that mean is not 0 and the "at v=0V: curve = 0 (no
 *  contribution)" contract documented below was false by ~8e-5 Hz at C4. An
 *  odd length puts a sample exactly at 0 V, making it exactly 0 Hz. */
const VOCT_LUT_LEN = 4097;
const VOCT_RANGE = 5; // ±5 V

/** Build a curve mapping V/oct (in [-VOCT_RANGE, +VOCT_RANGE]) to a
 *  frequency MULTIPLIER MINUS ONE — `2^v - 1` — independent of the base
 *  pitch. The WaveShaperNode applies this to any audio-rate signal patched
 *  to a pitch input; the module then MULTIPLIES the result by the (audio-
 *  rate) base-Hz signal and sums it with that same base Hz:
 *
 *    finalFreq = baseHz + baseHz × (2^v - 1) = baseHz × 2^v  ✓
 *
 *  curve[i] = 2^v - 1, where v = (i / (N-1)) * 2 * VOCT_RANGE - VOCT_RANGE.
 *  At v=0V: curve = 0 (no contribution). At v=1V: curve = 1 (one octave up).
 *
 *  **The base pitch used to be BAKED INTO THIS LUT** (`baseHz * (2^v - 1)`),
 *  which meant every tune / fine / ratio change reassigned a 4097-point
 *  `WaveShaperNode.curve` on a live node. Factoring the base out makes the
 *  curve a CONSTANT, assigned exactly once per node, which matters twice:
 *  a pitch change is now a single `AudioParam` write instead of a table
 *  rebuild, and `node-web-audio-api` (the ART harness) **refuses a second
 *  `curve` assignment outright** — `InvalidStateError: cannot assign curve
 *  twice`, verified still thrown after resetting to null, while real Chrome
 *  147 allows it. That refusal made this module's entire `setParam` path
 *  unreachable from ART, which is a large part of why #1661 survived.
 *
 *  Returned as Float32Array on a fresh ArrayBuffer (TS strict typed-array
 *  signature requirement for WaveShaperNode.curve).
 */
export function buildVoctRatioCurve(): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(VOCT_LUT_LEN * 4));
  for (let i = 0; i < VOCT_LUT_LEN; i++) {
    const v = (i / (VOCT_LUT_LEN - 1)) * 2 * VOCT_RANGE - VOCT_RANGE;
    curve[i] = Math.pow(2, v) - 1;
  }
  return curve;
}

/** LUT length for every CV→coefficient WaveShaper in this module (the
 *  shadow-signal mappings for symmetry / fold / ratio).
 *
 *  ODD ON PURPOSE, same argument as `VOCT_LUT_LEN`: a WaveShaperNode
 *  linearly interpolates between `curve[⌊p⌋]` and `curve[⌊p⌋+1]`, so an
 *  EVEN table has no sample at the centre. Every breakpoint these curves
 *  turn on — symmetry 0 / 0.5 / 1, ratio 0, fold 0 — must land EXACTLY on
 *  a sample or the mapping is read as the mean of two neighbours and the
 *  module's documented anchor values (0.5 = pure triangle, fold 0 =
 *  identity) stop being exact. `(LEN-1) = 4096 = 2^12` additionally puts
 *  every dyadic control value (0.5, 0.25, 0.125, …) on a sample. */
const CV_LUT_LEN = 4097;

/** Sample a pure `(input ∈ [-1,+1]) → coefficient` mapping into a
 *  WaveShaper LUT. The mappings below are all piecewise-LINEAR with their
 *  breakpoints on LUT samples, so the node's linear interpolation between
 *  samples reproduces them EXACTLY rather than approximately. */
function buildCvCurve(f: (u: number) => number): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(CV_LUT_LEN * 4));
  for (let i = 0; i < CV_LUT_LEN; i++) {
    curve[i] = f((i / (CV_LUT_LEN - 1)) * 2 - 1);
  }
  return curve;
}

/** Compute the per-shape gains for a given symmetry value ∈ [0, 1].
 *  Three-way crossfade: saw (s=0) → triangle (s=0.5) → square (s=1).
 *  Linear blends between adjacent shapes; ALWAYS sums to 1.0.
 *
 *  Pure helper extracted so the unit test can pin the math.
 */
export function symmetryGains(symmetry: number): {
  saw: number;
  triangle: number;
  square: number;
} {
  const s = Math.max(0, Math.min(1, symmetry));
  if (s <= 0.5) {
    // Saw → triangle blend.
    const t = s * 2; // [0, 1]
    return { saw: 1 - t, triangle: t, square: 0 };
  } else {
    // Triangle → square blend.
    const t = (s - 0.5) * 2; // [0, 1]
    return { saw: 0, triangle: 1 - t, square: t };
  }
}

/** Compute the BASE frequency (Hz) from tune (semitones) + fine (cents). */
export function tuneFineToHz(tuneSt: number, fineCents: number): number {
  return C4_HZ * Math.pow(2, tuneSt / 12 + fineCents / 1200);
}

/** Top of the `ratio` param's declared range (see `params` below). The
 *  ratio shadow signal is normalised by this before it indexes a
 *  WaveShaper (whose input domain is [-1,+1]), and un-normalised by the
 *  curve — so ratio 0..8 maps onto LUT positions 0.5..1.0. */
const RATIO_MAX = 8;

/** Fold "k" at fold=1. `buildFoldCurve` folds with `sin(x·π·k)` where
 *  `k = 1 + fold·4`, so k ∈ [1, 5]. The audio-rate folder below uses a
 *  FIXED `sin(u·π·FOLD_MAX_K)` shaper and pre-scales its input by `k /
 *  FOLD_MAX_K`, which composes to exactly `sin(x·π·k)` — the identical
 *  function, with the fold amount living in a GainNode instead of in a
 *  rebuilt LUT. */
const FOLD_MAX_K = 5;

/** Width (in control units) of the transition band a WaveShaper step
 *  costs. A step encoded in a LUT of `CV_LUT_LEN` samples over [-1,+1]
 *  cannot be a true discontinuity: the node interpolates linearly across
 *  the ONE cell that straddles the breakpoint. Both step curves below
 *  (fold's dry/wet gate, ratio's free-run gate) therefore ramp over a
 *  single cell rather than switching instantly. Exposed as a named
 *  constant so the tests can assert *where* that band is instead of
 *  discovering it. */
export const CV_STEP_BAND = 2 / (CV_LUT_LEN - 1);

/** Per-shape symmetry crossfade gain as a function of the SHADOW signal
 *  (the combined knob+CV value carried at audio rate). Identical to
 *  `symmetryGains` — including its clamp, which a WaveShaper reproduces
 *  for free by clamping its own input to [-1,+1]. */
function buildSymmetryCurve(shape: 'saw' | 'triangle' | 'square'): Float32Array<ArrayBuffer> {
  return buildCvCurve((u) => symmetryGains(u)[shape]);
}

/** Fold DRIVE: `u → k / FOLD_MAX_K` where `k = 1 + clamp(u,0,1)·4`. */
function buildFoldDriveCurve(): Float32Array<ArrayBuffer> {
  return buildCvCurve((u) => (1 + Math.max(0, Math.min(1, u)) * 4) / FOLD_MAX_K);
}

/** Fold WET gate: 0 at fold ≤ 0, 1 above it. `buildFoldCurve` is
 *  DISCONTINUOUS at 0 — it returns the identity at exactly 0 and
 *  `sin(x·π·k)` for anything above — so reproducing it at audio rate needs
 *  a hard dry/wet switch, not a crossfade. See `CV_STEP_BAND`. */
function buildFoldWetGateCurve(): Float32Array<ArrayBuffer> {
  return buildCvCurve((u) => (u > 0 ? 1 : 0));
}

/** Fold DRY gate — the exact complement of the wet gate, so the two always
 *  sum to 1 and no fold position can gain- or level-shift the output. */
function buildFoldDryGateCurve(): Float32Array<ArrayBuffer> {
  return buildCvCurve((u) => (u > 0 ? 0 : 1));
}

/** Ratio TRACK: normalised ratio → the ratio itself, floored at 0 (the
 *  free-run regime contributes through `buildRatioFreeGateCurve` instead).
 *  Linear above 0, so the node's interpolation is exact there. */
function buildRatioTrackCurve(): Float32Array<ArrayBuffer> {
  return buildCvCurve((u) => Math.max(0, u * RATIO_MAX));
}

/** Ratio FREE-RUN gate: 1 when ratio ≤ 0 (modulator runs at its own
 *  M.Tune / M.Fine pitch), 0 above. See `CV_STEP_BAND`. */
function buildRatioFreeGateCurve(): Float32Array<ArrayBuffer> {
  return buildCvCurve((u) => (u > 0 ? 0 : 1));
}

export const swolevcoDef: AudioModuleDef = {
  type: 'swolevco',
  palette: { top: 'Hybrid', sub: 'Hybrid' },
  domain: 'audio',
  label: 'swolevco',
  category: 'sources',
  // Chain-role (Design-D declarative override): a DECLARED source. Its lone
  // audio input (fm) is MODULATION, not a signal-chain insert — WITHOUT this the
  // port inference reads that single audio-in as a "main in" and mis-bins the
  // oscillator as an FX. Declare 'source' so it is a head-eligible SOURCE.
  chainWiring: { role: 'source' },

  inputs: [
    { id: 'pitch',     type: 'pitch' },
    { id: 'mod_pitch', type: 'pitch' },
    { id: 'fm',        type: 'audio' },
    // CV scaling per docs/adr/004-cv-range-convention.md (LFO ±1 sweeps
    // each param's full natural range centered on the knob).
    { id: 'timbre',    type: 'cv', paramTarget: 'timbre',   cvScale: { mode: 'linear' } },
    { id: 'symmetry',  type: 'cv', paramTarget: 'symmetry', cvScale: { mode: 'linear' } },
    { id: 'fold',      type: 'cv', paramTarget: 'fold',     cvScale: { mode: 'linear' } },
    { id: 'ratio',     type: 'cv', paramTarget: 'ratio',    cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out',     type: 'audio' },
    // Explicit jack label (PortDef.label — cosmetic, contract-transparent):
    // this is the MODULATOR oscillator's sine tap, and the shared abbreviation
    // table reads a bare `mod` stem as 'MODE' (the mode/mod_… family every
    // other module uses it for). Name it rather than let the derivation guess.
    { id: 'mod_out', type: 'audio', label: 'modulator' },
    { id: 'sum_out', type: 'audio' },
    { id: 'scope',   type: 'mono-video' },
  ],
  params: [
    { id: 'tune',     label: 'Tune',  defaultValue: 0,   min: -36,  max: 36,  curve: 'linear', units: 'st' },
    { id: 'fine',     label: 'Fine',  defaultValue: 0,   min: -100, max: 100, curve: 'linear', units: '¢' },
    { id: 'mod_tune', label: 'M.Tn',  defaultValue: 0,   min: -36,  max: 36,  curve: 'linear', units: 'st' },
    { id: 'mod_fine', label: 'M.Fn',  defaultValue: 0,   min: -100, max: 100, curve: 'linear', units: '¢' },
    // ratio = 0 means "free run" (modulator pitch is independent, driven by
    // mod_tune + mod_fine + mod_pitch CV). ratio > 0 means "modulator
    // frequency = primary frequency × ratio".
    { id: 'ratio',    label: 'Ratio', defaultValue: 1.0, min: 0,    max: 8,   curve: 'linear' },
    { id: 'timbre',   label: 'Tbr',   defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' },
    { id: 'symmetry', label: 'Sym',   defaultValue: 0.5, min: 0,    max: 1,   curve: 'linear' },
    { id: 'fold',     label: 'Fold',  defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' },
  ],

  // ── THE FACEPLATE (PF-20) ────────────────────────────────────────────────
  //
  // WHAT SWOLEVCO IS FOR. It is the COMPLEX (West-Coast) oscillator: one pitch
  // goes in, and instead of choosing a waveform you BUILD a timbre by warping
  // it — crossfade the shape (SYMMETRY), fold it back on itself (FOLD), and
  // pour audio-rate FM into it from a second oscillator (TIMBRE) that is
  // either locked to a RATIO of the first or running free at its own pitch.
  // The verb a player performs is riding FOLD and SYMMETRY with one hand while
  // RATIO decides whether the modulator is a harmonic partner or a second
  // voice. Every rank below descends from that sentence, and every one of them
  // is a MEASURED number rather than a preference.
  //
  // THE RANKING, and why it is not the declaration order. Measured against the
  // real factory under an OfflineAudioContext (48 kHz, tail half of a 0.5 s
  // render; spectral centroid via a HANN-WINDOWED 8192-pt FFT — a rectangular
  // window read this module's own pure-sine `mod_out` as 2904 Hz against a
  // truth of 261.626, because a frequency-weighted centroid is dominated by
  // 1/f leakage sidelobes, and the windowed instrument reads 261.8):
  //
  //   1 FOLD      the largest timbral travel on the module by a distance —
  //               centroid 637 -> 3264 Hz (5.12x, +412 %) across 0..1, while
  //               the level moves only 1.8 dB. This is what a hand rides, so
  //               it is rank 1 AND the hero control.
  //   2 SYMMETRY  the waveform identity and a real level hazard: 4.8 dB of
  //               NON-MONOTONIC rms swing (-4.87 / -5.38 / -4.77 / -2.36 /
  //               -0.07 dB at 0 / 0.25 / 0.5 / 0.75 / 1) and over-full-scale
  //               at BOTH ends (peak 1.0286 saw, 1.0428 square) with no output
  //               stage anywhere in the module. Tracked as #1877 — it is an
  //               audio change and deliberately NOT in this PR.
  //   3 RATIO     decides the modulator's entire behaviour, including whether
  //               ranks 7 and 8 exist at all.
  //   4 TIMBRE    the marquee FM control, ranked 4 ON MEASUREMENT rather than
  //               on branding: +23 % of centroid (637 -> 786 Hz) for its whole
  //               travel, against FOLD's +412 %. The declared law is +-200 Hz
  //               at full knob, a modulation index of 0.76 on a 261.6 Hz
  //               carrier — modest BY CONSTRUCTION. It also costs 4.1 dB on
  //               `sum_out` (-8.44 -> -12.52 dB) while leaving `out` alone.
  //   5 TUNE      pitch.
  //   6 FINE      pitch.
  //   7 M.TUNE    DOCK-ONLY, and this is an argument rather than a leftover.
  //   8 M.FINE    Both are BIT-EXACTLY INERT in the state a rack spawns in:
  //               at the shipped default `ratio = 1`, sweeping either across
  //               its full declared range (+-36 st, +-100 c) gives
  //               `max|x - x_ref| = 0.000e+0` on ALL THREE audio outputs.
  //               `faceTierCap('full')` is 6, so ranks 7+ are dock-only by
  //               construction — and a 192x180 lane tile that paints two dead
  //               dials is a tile that lies. In the dock they are live, the
  //               LOCK readout says which mode is on, and the sidebar says the
  //               one sentence that makes them make sense.
  //               Positive control, so the probe is not blind: at `ratio = 0`
  //               the same sweep moves `mod_out` from 33 Hz to 2093 Hz.
  //
  // WHY `order` AND `pages` DISAGREE, deliberately. `order` is PRIORITY (it is
  // what the tiers showing a SUBSET cut against), so it leads with the two
  // timbre controls. `pages` is SIGNAL ORDER — primary oscillator first, then
  // the modulator that cross-modulates it — because the tier showing
  // EVERYTHING should read like the block diagram. FOLD is rank 1 and lives in
  // the `primary` page; M.TUNE is rank 7 and sits beside the RATIO that gates
  // it.
  //
  // NOT CONTROL-HEAVY, measured against the tabbed-face ruling. Eight params
  // at ONE control shape (a linear fader, every one of them) and two honest
  // ideas to group them into. "Lots of controls of DIFFERENT types" is the
  // bar; this is the opposite of both halves of it, so it takes two bands and
  // no tab rail. The two bands are 3 + 4 cells after the hero promotes FOLD,
  // which packs to a single row (`DOCK_ROW_MAX_CONTROLS` is 10) and stays well
  // under `DOCK_TAB_MIN_BANDS` (7), so the band hints actually render.
  //
  // NO AUDITION, and no `hero.cell`. swolevco FREE-RUNS — three OscillatorNodes
  // started at factory time, full scale the instant it spawns — so there is
  // nothing to strike, and an `action` cell would need a probe reaching a
  // callable that does not exist. Keeping the `scope` glyph (rather than
  // suppressing it with a hero picture) is deliberate: it makes swolevco the
  // third faced module that is free-running, so its lane tile is REAL roster
  // coverage for #1420's pre-frame AudioContext freeze rather than another
  // silent graph that would read zeros either way.
  face: {
    order: [
      'fold',
      'symmetry',
      'ratio',
      'timbre',
      'tune',
      'fine',
      // Dock-only by construction — see ranks 7/8 above.
      'mod_tune',
      'mod_fine',
    ],

    pages: [
      {
        id: 'primary',
        label: 'primary oscillator',
        hint: 'saw -> tri -> sqr crossfade, then the folder',
        controls: ['tune', 'fine', 'symmetry', 'fold'],
      },
      {
        id: 'modulator',
        label: 'modulator + cross-mod',
        hint: 'RATIO 0 = free-run; above 0 M.TUNE / M.FINE are ignored',
        controls: ['ratio', 'timbre', 'mod_tune', 'mod_fine'],
      },
    ],

    glyph: 'scope',

    hero: {
      control: 'fold',
    },

  },

  docs: {
    explanation: "A complex / West-Coast-style dual oscillator: two oscillators in one module that interact to build harmonically rich timbres rather than just stacking simple shapes. A PRIMARY oscillator (crossfaded across saw / triangle / square by Symmetry, then run through a wavefolder) is the main voice; a sine MODULATOR oscillator, tuned either to a Ratio of the primary's pitch or to its own M.Tune / M.Fine, cross-modulates the primary via audio-rate FM (the Timbre amount). Mental model: start from a near-sine, warp the wave with Symmetry, then FOLD it — the folder is the big move on this module, worth about +412% of spectral brightness across its travel, where Timbre's audio-rate FM adds about +23% of colour on top. One caution worth knowing before you patch: RATIO decides the modulator's whole behaviour, and at its default of 1 the M.Tune and M.Fine controls do exactly nothing — the modulator is locked to the primary's pitch. Bring Ratio to 0 to hand the modulator back its own tuning. You can tap the primary alone (OUT), the clean modulator sine alone (MOD OUT), or the two summed together (SUM OUT, which is exactly half of OUT plus MOD OUT), and a mono-video oscilloscope of the primary is available on SCOPE.",
    inputs: {
      pitch: "1V/oct pitch CV for the PRIMARY oscillator (0V = C4 = 261.626 Hz), summed on top of the Tune / Fine knobs. When Ratio is greater than 0 the modulator tracks this pitch (modulator frequency = primary × Ratio), so a sequencer or keyboard patched here moves both oscillators together.",
      mod_pitch: "1V/oct pitch CV for the MODULATOR oscillator (0V = C4), summed on top of M.Tune / M.Fine. Most useful in free-run mode (Ratio = 0) where the modulator has its own pitch; with Ratio greater than 0 the modulator is largely slaved to the primary and this adds on top of that base.",
      fm: "External audio-rate FM into the PRIMARY oscillator: an incoming audio signal is scaled (full-scale ±1 ≈ ±200 Hz of deviation) and summed into the primary's frequency, on top of the internal Timbre FM. Drive it from a VCA or another oscillator for cross-FM beyond the built-in modulator.",
      timbre: "CV that displaces the Timbre control (audio-rate FM amount from the modulator into the primary); an LFO or envelope here opens and closes the FM brightness over time.",
      symmetry: "CV that displaces the Symmetry control, sliding the saw → triangle → square waveform crossfade of the primary oscillator up or down.",
      fold: "CV that displaces the Fold control, modulating how hard the West-Coast wavefolder folds the primary signal — patch an envelope here for evolving fold timbres.",
      ratio: "CV that displaces the Ratio control, sweeping the modulator-to-primary frequency ratio. Pushing it through 0 toggles the modulator between free-run (its own M.Tune / M.Fine pitch) and ratio-locked (a multiple of the primary's pitch).",
    },
    outputs: {
      out: "The PRIMARY oscillator: the symmetry-crossfaded saw/tri/square wave after the wavefolder, including any Timbre / external FM. This is the main voice and the signal the SCOPE traces.",
      mod_out: "The MODULATOR oscillator's raw sine output, before it is mixed in — a clean sine tap you can patch anywhere as an independent oscillator (e.g. as an LFO or a second voice) at the modulator's pitch.",
      sum_out: "The PRIMARY and MODULATOR summed into one signal (each at half level to leave headroom). With Timbre up this is the cross-modulated mix — the primary already FM'd by the modulator, plus the modulator's own sine on top — for a thicker, two-oscillator blend.",
      scope: "A mono-video oscilloscope trace of the primary signal (OUT), tapped post-fold. Patch a video cable from here into a scope / display module to watch the waveform; it is a video output, not audio.",
    },
    controls: {
      tune: "Coarse tuning of the PRIMARY oscillator in semitones (-36 to +36, i.e. ±3 octaves) relative to C4; combines with Fine and any pitch CV to set the base pitch.",
      fine: "Fine tuning of the PRIMARY oscillator in cents (-100 to +100, ±1 semitone) for beating / detune against the modulator or other voices.",
      mod_tune: "Coarse tuning of the MODULATOR oscillator in semitones (±3 octaves). Active when Ratio = 0 (free-run); when Ratio is greater than 0 the modulator follows the primary × Ratio and this is ignored.",
      mod_fine: "Fine tuning of the MODULATOR oscillator in cents (±1 semitone), for free-run detune. Like M.Tune, it only takes effect when Ratio = 0.",
      ratio: "Modulator-to-primary frequency ratio (0 to 8). At 0 the modulator free-runs at its own M.Tune / M.Fine pitch; above 0 the modulator frequency is the primary's frequency × this value (1 = unison, 2 = octave up, etc.), so it tracks the primary's pitch for harmonically related FM.",
      timbre: "Audio-rate FM amount: how much the modulator deviates the primary's frequency (0 to 1, where 1 ≈ ±200 Hz at C4). 0 leaves the primary clean; turning it up adds FM sidebands for a bell-like, slightly metallic edge. Measured, it is the GENTLEST of the four timbre controls, not the biggest: a full 0→1 sweep moves the spectral centroid by about +23% (637 → 786 Hz), where Fold moves it by +412% over the same travel. ±200 Hz on a 261.6 Hz carrier is a modulation index of about 0.76 — modest by design. Reach for Fold when you want the dramatic move and Timbre when you want to colour it. Note also that Timbre makes SUM OUT about 4 dB quieter (−8.4 → −12.5 dB) while leaving OUT's level alone, because the FM'd primary and the modulator sine partially cancel in the sum.",
      symmetry: "Morphs the PRIMARY waveform across a three-way crossfade (0 to 1): 0 = saw, 0.5 = triangle, 1 = square, with a linear blend of the two neighboring shapes in between. Default 0.5 (pure triangle).",
      fold: "West-Coast wavefolder amount on the primary (0 to 1): 0 is no folding; raising it folds the wave back on itself, adding harmonics and that characteristic complex-oscillator brightness/buzz even on a plain triangle.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const initialParams = node.params ?? {};
    const initial = {
      tune:     (initialParams.tune     ?? 0)   as number,
      fine:     (initialParams.fine     ?? 0)   as number,
      mod_tune: (initialParams.mod_tune ?? 0)   as number,
      mod_fine: (initialParams.mod_fine ?? 0)   as number,
      ratio:    (initialParams.ratio    ?? 1.0) as number,
      timbre:   (initialParams.timbre   ?? 0)   as number,
      symmetry: (initialParams.symmetry ?? 0.5) as number,
      fold:     (initialParams.fold     ?? 0)   as number,
    };

    // ---------------- CV shadows: the combined (knob + CV) value, as a SIGNAL ----------------
    //
    // Each of the four CV-modulated scalar knobs (timbre / symmetry / fold /
    // ratio) is carried through this graph as an audio-rate SIGNAL, not as a
    // JS number. A ConstantSource pinned at 1.0 feeds a GainNode whose
    // `.gain` is the AudioParam published on the corresponding input port:
    //
    //     shadow output = 1.0 × (knob intrinsic + every connected CV)
    //                   = the combined value, at audio rate.
    //
    // Everything downstream reads that OUTPUT, and that is the whole fix for
    // #1661. The shadows used to be pinned at offset **0** and connected to
    // **nothing** — they existed only so the engine's per-param tap analyser
    // had an AudioParam to observe for the motorized-fader animation, while
    // `setParam` (the knob path) separately did all the real work. So a
    // patched cable moved the fader and not one sample of audio: measured
    // peak |Δsample| of exactly 0.0000e+0 on all four inputs, against
    // 9.7e-1 … 1.9e0 for the same values applied as a knob. The animating
    // fader actively told the player it was working.
    //
    // Reaching the DSP from a live AudioParam fixes clip automation for free
    // as well: `AudioEngine.scheduleParam` / `holdParam` prefer
    // `inputs[paramId].param` over `setParam`, so automating any of these
    // four was writing to the same dead end.
    const constantSources: ConstantSourceNode[] = [];
    function makeConstant(offset: number): ConstantSourceNode {
      const cs = ctx.createConstantSource();
      cs.offset.value = offset;
      cs.start();
      constantSources.push(cs);
      return cs;
    }
    function makeShadow(initialValue: number): GainNode {
      const g = ctx.createGain();
      g.gain.setValueAtTime(initialValue, ctx.currentTime);
      makeConstant(1).connect(g);
      return g;
    }
    const sTimbre   = makeShadow(initial.timbre);
    const sSymmetry = makeShadow(initial.symmetry);
    const sFold     = makeShadow(initial.fold);
    const sRatio    = makeShadow(initial.ratio);

    // ---------------- Primary oscillators (3 shapes) ----------------
    //
    // OscillatorNode primitives (sawtooth/triangle/square/sine) are
    // bandlimited per the W3C spec — Web Audio implementations use BLEP
    // or polynomial-bandlimited tables under the hood. We get aliasing-
    // free shapes for free.
    //
    // The base pitch is a SIGNAL (`csBaseHz`) rather than the oscillators'
    // intrinsic `.frequency`, because the modulator's ratio leg has to
    // multiply it at audio rate. Every oscillator's intrinsic frequency is
    // therefore 0 and its pitch arrives entirely through connections, which
    // Web Audio sums: base + V/oct + timbre FM + external FM.
    const baseHz = tuneFineToHz(initial.tune, initial.fine);
    const csBaseHz = makeConstant(baseHz);
    function makeOsc(type: OscillatorType): OscillatorNode {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(0, ctx.currentTime);
      o.start();
      csBaseHz.connect(o.frequency);
      return o;
    }
    const oscSaw = makeOsc('sawtooth');
    const oscTri = makeOsc('triangle');
    const oscSqr = makeOsc('square');

    // Per-shape symmetry crossfade gains. Intrinsic 0: each shape's gain
    // arrives from the symmetry shadow through its own WaveShaper LUT of
    // `symmetryGains`, so a CV cable crossfades saw→tri→square at audio
    // rate and a knob move is just a write to the shadow's intrinsic. The
    // LUT reproduces `symmetryGains` exactly — the mapping is piecewise
    // linear with breakpoints (0, 0.5, 1) sitting ON LUT samples, and the
    // node's clamp of its own input to [-1,+1] reproduces the helper's
    // clamp of `symmetry` to [0,1].
    function makeShapeGain(shape: 'saw' | 'triangle' | 'square'): GainNode {
      const g = ctx.createGain();
      g.gain.value = 0;
      const ws = ctx.createWaveShaper();
      ws.curve = buildSymmetryCurve(shape);
      sSymmetry.connect(ws);
      ws.connect(g.gain);
      symmetryShapers.push(ws);
      return g;
    }
    const symmetryShapers: WaveShaperNode[] = [];
    const gSaw = makeShapeGain('saw');
    const gTri = makeShapeGain('triangle');
    const gSqr = makeShapeGain('square');
    oscSaw.connect(gSaw);
    oscTri.connect(gTri);
    oscSqr.connect(gSqr);

    // Sum the three shape outputs into a primary bus.
    const primaryBus = ctx.createGain();
    primaryBus.gain.value = 1;
    gSaw.connect(primaryBus);
    gTri.connect(primaryBus);
    gSqr.connect(primaryBus);

    // ---------------- Wavefolder (post-symmetry) ----------------
    //
    // `buildFoldCurve` is DISCONTINUOUS at fold=0 — the identity at exactly
    // 0, `sin(x·π·(1+4·fold))` for anything above it — so the audio-rate
    // form is a hard dry/wet SWITCH, not a crossfade:
    //
    //   dry: primaryBus → foldDry (identity, 4× oversampled) → dryGain
    //   wet: primaryBus → foldDrive (gain = k/5) → foldWet
    //                     (fixed `sin(u·π·5)`)          → wetGain
    //
    // because `sin(u·π·5)` evaluated at `u = x·k/5` IS `sin(x·π·k)`. The
    // fold amount has moved out of a rebuilt LUT and into a GainNode, so it
    // is audio-rate and `.curve` is never touched again after construction.
    //
    // `foldDry` keeps the identity curve on a 4×-oversampled WaveShaper —
    // the same node shape the old rebuilt folder had at fold=0 — rather than
    // bypassing to a plain wire, so the default (fold=0) output stays
    // bit-identical: the oversampler's up/downsample filters are not exactly
    // transparent and skipping them would have been an audible change to
    // every existing rack. The two gates are exact complements, so no fold
    // position can level-shift the output.
    const foldDry = ctx.createWaveShaper();
    foldDry.oversample = '4x';
    foldDry.curve = buildFoldCurve(0);
    const dryGain = ctx.createGain();
    dryGain.gain.value = 0;
    primaryBus.connect(foldDry);
    foldDry.connect(dryGain);

    const foldDrive = ctx.createGain();
    foldDrive.gain.value = 0;
    const foldWet = ctx.createWaveShaper();
    foldWet.oversample = '4x';
    foldWet.curve = buildCvCurve((u) => Math.sin(u * Math.PI * FOLD_MAX_K));
    const wetGain = ctx.createGain();
    wetGain.gain.value = 0;
    primaryBus.connect(foldDrive);
    foldDrive.connect(foldWet);
    foldWet.connect(wetGain);

    function driveFromFold(
      curve: Float32Array<ArrayBuffer>,
      target: AudioParam,
    ): WaveShaperNode {
      const ws = ctx.createWaveShaper();
      ws.curve = curve;
      sFold.connect(ws);
      ws.connect(target);
      foldShapers.push(ws);
      return ws;
    }
    const foldShapers: WaveShaperNode[] = [];
    driveFromFold(buildFoldDriveCurve(),   foldDrive.gain);
    driveFromFold(buildFoldWetGateCurve(), wetGain.gain);
    driveFromFold(buildFoldDryGateCurve(), dryGain.gain);

    // Output bus (post-fold). This is the `out` port AND the source for
    // the scope analyser AND one of the two summands for sum_out.
    const outBus = ctx.createGain();
    outBus.gain.value = 1;
    dryGain.connect(outBus);
    wetGain.connect(outBus);

    // ---------------- Modulator (sine) ----------------
    const modOsc = ctx.createOscillator();
    modOsc.type = 'sine';
    modOsc.frequency.setValueAtTime(0, ctx.currentTime);
    modOsc.start();

    // The modulator's base frequency, as a SIGNAL summed from two mutually
    // exclusive legs gated by the ratio shadow — so the mode switch itself
    // is CV-reachable, not just the ratio value:
    //
    //   ratio > 0  →  primary base Hz × ratio   (ratio-locked FM)
    //   ratio ≤ 0  →  the modulator's own M.Tune / M.Fine pitch (free run)
    //
    // The ratio shadow spans the param's 0..8 range, so it is normalised by
    // RATIO_MAX before indexing a WaveShaper (whose input domain is
    // [-1,+1]) and un-normalised by the track curve. The two gates cross in
    // one LUT cell — `CV_STEP_BAND` wide in ratio-normalised units — rather
    // than switching instantaneously; see that constant.
    const gRatioNorm = ctx.createGain();
    gRatioNorm.gain.value = 1 / RATIO_MAX;
    sRatio.connect(gRatioNorm);

    const wsRatioTrack = ctx.createWaveShaper();
    wsRatioTrack.curve = buildRatioTrackCurve();
    gRatioNorm.connect(wsRatioTrack);
    const gRatioBase = ctx.createGain();
    gRatioBase.gain.value = baseHz; // re-written by tune / fine
    wsRatioTrack.connect(gRatioBase);

    const wsRatioFree = ctx.createWaveShaper();
    wsRatioFree.curve = buildRatioFreeGateCurve();
    gRatioNorm.connect(wsRatioFree);
    const gFreeHz = ctx.createGain();
    gFreeHz.gain.value = tuneFineToHz(initial.mod_tune, initial.mod_fine);
    wsRatioFree.connect(gFreeHz);

    const modHzBus = ctx.createGain();
    modHzBus.gain.value = 1;
    gRatioBase.connect(modHzBus);
    gFreeHz.connect(modHzBus);
    modHzBus.connect(modOsc.frequency);

    // Modulator output bus (kept as a buffer so we can fan-out to
    // mod_out, sum_out, and the timbre-FM path).
    const modBus = ctx.createGain();
    modBus.gain.value = 1;
    modOsc.connect(modBus);

    // ---------------- Timbre = audio-rate FM amount ----------------
    //
    // Modulator → timbreGain (×TIMBRE_MAX_HZ × timbre value) → primary
    // .frequency AudioParam. Web Audio sums modulator inputs into the
    // AudioParam, so this is true audio-rate FM with proper sample
    // accuracy. We connect ONCE per primary oscillator (saw/tri/sqr —
    // they all need the same FM input).
    //
    // The FM DEPTH is itself audio-rate now: `timbreGain.gain` has an
    // intrinsic of 0 and is driven entirely by the timbre shadow scaled by
    // TIMBRE_MAX_HZ, which is exactly what `setParam` used to compute in JS
    // (`value * TIMBRE_MAX_HZ`). An envelope patched into `timbre` opens the
    // FM index per sample instead of per knob move.
    const timbreGain = ctx.createGain();
    timbreGain.gain.value = 0;
    modBus.connect(timbreGain);
    timbreGain.connect(oscSaw.frequency);
    timbreGain.connect(oscTri.frequency);
    timbreGain.connect(oscSqr.frequency);
    const gTimbreHz = ctx.createGain();
    gTimbreHz.gain.value = TIMBRE_MAX_HZ;
    sTimbre.connect(gTimbreHz);
    gTimbreHz.connect(timbreGain.gain);

    // ---------------- External FM input → primary frequency ----------------
    //
    // The `fm` input port lets a user route an external audio signal as
    // an additional FM source. Same pattern as timbre, but no scaling
    // (1V of input = 1Hz of frequency deviation). For musically useful
    // amounts the user typically drives this from a VCA whose output is
    // already amplitude-shaped.
    const fmIn = ctx.createGain();
    fmIn.gain.value = TIMBRE_MAX_HZ; // scale 1.0 audio level → 200 Hz dev
    fmIn.connect(oscSaw.frequency);
    fmIn.connect(oscTri.frequency);
    fmIn.connect(oscSqr.frequency);

    // ---------------- Pitch CV (V/oct → Hz) ----------------
    //
    // Inbound pitch CV (V/oct, 0V = C4) is converted to a frequency
    // delta via a WaveShaper LUT. Output is connected to all three
    // primary oscillators' .frequency AudioParams (and to the modulator's
    // when ratio==0; otherwise the modulator tracks the primary).
    //
    // The LUT is BASE-FREE (`2^v - 1`) and the base Hz arrives as a signal
    // on the multiplier's gain, so a tune/fine change is one AudioParam
    // write and never a table rebuild. See `buildVoctRatioCurve`.
    const pitchVoctShaper = ctx.createWaveShaper();
    pitchVoctShaper.curve = buildVoctRatioCurve();
    // WaveShaperNode reads input as [-1, +1] and maps proportionally to the
    // curve's index range. Our curve maps a V/oct input ∈ [-VOCT_RANGE,
    // +VOCT_RANGE] to a Hz delta, so the incoming V/oct CV has to be scaled
    // down by 1/VOCT_RANGE first or every input above ±1V saturates to the
    // curve's endpoint (= ±VOCT_RANGE octaves), giving the oscillator a
    // usable range of only ~2 semitones around C4. The fix: pitchScaler =
    // GainNode(gain = 1/VOCT_RANGE) interposed between input + shaper, so a
    // +1V input lands at the +1V point on the curve (= baseHz delta = one
    // octave up). The `pitch` input port now terminates on pitchScaler so
    // CV connections feed the scaled chain.
    const pitchScaler = ctx.createGain();
    pitchScaler.gain.value = 1 / VOCT_RANGE;
    pitchScaler.connect(pitchVoctShaper);
    // × base Hz. Intrinsic 0 with the base arriving on the gain param, so
    // the product is `baseHz × (2^v - 1)` — the Hz delta the LUT used to
    // carry directly. Summed with `csBaseHz` at the oscillator this is
    // `baseHz × 2^v`, unchanged.
    const pitchVoctHz = ctx.createGain();
    pitchVoctHz.gain.value = 0;
    pitchVoctShaper.connect(pitchVoctHz);
    csBaseHz.connect(pitchVoctHz.gain);
    pitchVoctHz.connect(oscSaw.frequency);
    pitchVoctHz.connect(oscTri.frequency);
    pitchVoctHz.connect(oscSqr.frequency);

    // Same for the modulator pitch input — same base-free LUT, multiplied
    // by the MODULATOR's base-Hz signal so pitch CV tracks whichever regime
    // (ratio-locked or free-run) `modHzBus` is currently in. Always
    // connected: pitch CV always tracks.
    const modPitchVoctShaper = ctx.createWaveShaper();
    modPitchVoctShaper.curve = buildVoctRatioCurve();
    const modPitchScaler = ctx.createGain();
    modPitchScaler.gain.value = 1 / VOCT_RANGE;
    modPitchScaler.connect(modPitchVoctShaper);
    const modPitchVoctHz = ctx.createGain();
    modPitchVoctHz.gain.value = 0;
    modPitchVoctShaper.connect(modPitchVoctHz);
    modHzBus.connect(modPitchVoctHz.gain);
    modPitchVoctHz.connect(modOsc.frequency);

    // ---------------- Sum output bus ----------------
    const sumBus = ctx.createGain();
    sumBus.gain.value = 0.5; // scale to avoid clipping (out + mod can exceed ±1)
    outBus.connect(sumBus);
    modBus.connect(sumBus);

    // ---------------- Scope analyser tap ----------------
    const scopeAnalyser = ctx.createAnalyser();
    scopeAnalyser.fftSize = 2048;
    scopeAnalyser.smoothingTimeConstant = 0;
    outBus.connect(scopeAnalyser);

    // Track current KNOB values. These are the intrinsic half of each
    // param; the combined value the DSP actually hears is intrinsic + CV
    // and lives in the graph, not here.
    const live: Record<string, number> = { ...initial };

    /** The four CV-modulated params, keyed by id → the shadow whose `.gain`
     *  is the AudioParam published on the matching input port. `setParam`
     *  writes the intrinsic; everything else is the graph's job. */
    const shadowOf: Record<string, GainNode> = {
      timbre:   sTimbre,
      symmetry: sSymmetry,
      fold:     sFold,
      ratio:    sRatio,
    };

    function recomputePrimaryHz() {
      const bh = tuneFineToHz(live.tune ?? 0, live.fine ?? 0);
      csBaseHz.offset.setValueAtTime(bh, ctx.currentTime);
      // The modulator's ratio-tracked leg SCALES this same base, so a
      // primary pitch change carries the modulator with it — there is no
      // separate modulator recompute to forget.
      gRatioBase.gain.setValueAtTime(bh, ctx.currentTime);
    }
    function recomputeModFreeHz() {
      gFreeHz.gain.setValueAtTime(
        tuneFineToHz(live.mod_tune ?? 0, live.mod_fine ?? 0),
        ctx.currentTime,
      );
    }

    return {
      domain: 'audio',
      inputs: new Map([
        ['pitch',     { node: pitchScaler,    input: 0 }],
        ['mod_pitch', { node: modPitchScaler, input: 0 }],
        ['fm',        { node: fmIn,               input: 0 }],
        // CV-modulated params: the port's AudioParam is the shadow's
        // `.gain`, and the shadow's OUTPUT — intrinsic + every connected
        // CV — is what the DSP reads. Knob, CV cable and clip automation
        // therefore land on one summing junction and cannot disagree.
        ['timbre',   { node: sTimbre,   input: 0, param: sTimbre.gain   }],
        ['symmetry', { node: sSymmetry, input: 0, param: sSymmetry.gain }],
        ['fold',     { node: sFold,     input: 0, param: sFold.gain     }],
        ['ratio',    { node: sRatio,    input: 0, param: sRatio.gain    }],
      ]),
      outputs: new Map([
        ['out',     { node: outBus, output: 0 }],
        ['mod_out', { node: modBus, output: 0 }],
        ['sum_out', { node: sumBus, output: 0 }],
      ]),
      videoSources: new Map([
        ['scope', { analyser: scopeAnalyser, sampleRate: ctx.sampleRate }],
      ]),
      setParam(paramId, value) {
        switch (paramId) {
          case 'tune':
          case 'fine':
            live[paramId] = value;
            recomputePrimaryHz();
            return;
          case 'mod_tune':
          case 'mod_fine':
            live[paramId] = value;
            // Only audible when ratio ≤ 0; above that the free-run leg is
            // gated to silence, so writing it unconditionally is harmless
            // and keeps the value ready for the moment ratio crosses 0.
            recomputeModFreeHz();
            return;
          // The four CV-modulated knobs: write the shadow's INTRINSIC and
          // stop. Every mapping that used to live in this switch (timbre ×
          // 200 Hz, the symmetry crossfade, the fold curve, the ratio →
          // modulator frequency) is now a WaveShaper/GainNode chain hanging
          // off the shadow's OUTPUT, so it applies to knob and CV alike.
          case 'ratio':
          case 'timbre':
          case 'symmetry':
          case 'fold':
            live[paramId] = value;
            shadowOf[paramId]!.gain.setValueAtTime(value, ctx.currentTime);
            return;
        }
      },
      readParam(paramId) {
        // The KNOB (intrinsic) position. Modulation is reported separately
        // by the engine's per-param tap analyser, which observes the CV
        // side of the same summing junction.
        switch (paramId) {
          case 'tune':     return live.tune;
          case 'fine':     return live.fine;
          case 'mod_tune': return live.mod_tune;
          case 'mod_fine': return live.mod_fine;
          case 'ratio':    return live.ratio;
          case 'timbre':   return live.timbre;
          case 'symmetry': return live.symmetry;
          case 'fold':     return live.fold;
        }
        return undefined;
      },
      dispose() {
        try { oscSaw.stop(); } catch { /* */ }
        try { oscTri.stop(); } catch { /* */ }
        try { oscSqr.stop(); } catch { /* */ }
        try { modOsc.stop(); } catch { /* */ }
        // Every ConstantSource this factory started — the four shadow
        // drivers AND the primary base-Hz source — in one list, so a new
        // one cannot be added and forgotten.
        for (const s of constantSources) {
          try { s.stop(); } catch { /* */ }
          s.disconnect();
        }
        oscSaw.disconnect();
        oscTri.disconnect();
        oscSqr.disconnect();
        modOsc.disconnect();
        gSaw.disconnect();
        gTri.disconnect();
        gSqr.disconnect();
        for (const ws of symmetryShapers) ws.disconnect();
        primaryBus.disconnect();
        foldDry.disconnect();
        foldDrive.disconnect();
        foldWet.disconnect();
        dryGain.disconnect();
        wetGain.disconnect();
        for (const ws of foldShapers) ws.disconnect();
        outBus.disconnect();
        modBus.disconnect();
        gRatioNorm.disconnect();
        wsRatioTrack.disconnect();
        gRatioBase.disconnect();
        wsRatioFree.disconnect();
        gFreeHz.disconnect();
        modHzBus.disconnect();
        timbreGain.disconnect();
        gTimbreHz.disconnect();
        fmIn.disconnect();
        pitchScaler.disconnect();
        pitchVoctShaper.disconnect();
        pitchVoctHz.disconnect();
        modPitchScaler.disconnect();
        modPitchVoctShaper.disconnect();
        modPitchVoctHz.disconnect();
        sumBus.disconnect();
        scopeAnalyser.disconnect();
        sTimbre.disconnect();
        sSymmetry.disconnect();
        sFold.disconnect();
        sRatio.disconnect();
      },
    };
  },
};
