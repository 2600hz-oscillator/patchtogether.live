// packages/web/src/lib/ui/modules/rings-face-model.ts
//
// The PURE model behind the RINGS faceplate — its three derived readouts and
// the pickup-comb picture. No DOM, no engine, no store: params in, numbers and
// strings out, so every claim the faceplate makes is unit-testable and
// negative-controllable against the shipping DSP.
//
// ⚠ EVERY QUANTITY HERE IS SAMPLE-RATE INDEPENDENT, AND THAT IS A DESIGN
// CONSTRAINT RATHER THAN A COINCIDENCE. `FaceReadoutValue` is
// `(read) => string` and receives NO sample rate (face-readout-values.ts), so a
// readout that depended on one would print a single interface's answer as if it
// were every interface's — the `noise` brown-corner trap. RINGS has a far
// bigger instance of it than noise does, which is why the readout this module
// most obviously wants is NOT here: see RING TIME below.
//
// ── RING TIME IS DELIBERATELY NOT A READOUT ──────────────────────────────────
//
// The single most useful thing this faceplate could print is how long the body
// rings, because TWO knobs set it and only one says so (DAMPING is documented
// as the decay control; BRIGHTNESS is documented as a tone control and moves
// T60 by more than an order of magnitude). It cannot be printed honestly.
//
// MEASURED on the SHIPPING worklet (packages/dsp/src/rings.ts bundled offline
// and run in 128-sample blocks), MODAL, T60 of the ODD tap, strum-excited —
// identical figures whether the exciter is a STRUM edge or a burst on IN:
//
//   damping 0.5, brightness 0.5   337 ms @ 44.1k   392 ms @ 48k   163 ms @ 96k
//   damping 0.5, brightness 1.0  3889 ms @ 44.1k  7420 ms @ 48k   476 ms @ 96k
//
// That was a 15.6x swing across the SAME two knob settings, decided entirely by
// the interface, and it had TWO causes, not one.
//
// ── CAUSE 1, FIXED ──────────────────────────────────────────────────────────
// MODAL's Q is set proportional to partial frequency, `Q = 1 + (f/sr)*q`, so
// the decay constant is `tau = q/(pi*sr)`, and `q` came from the DAMPING knob
// alone with nothing to cancel the `sr`. `MODAL_Q_REFERENCE_SR` now scales `q`
// by `sr/48000`, which cancels it exactly and is bit-identical at 48 kHz.
// Measured on the fundamental (261.6 Hz, where bilinear warping is 1.00018 and
// therefore rules itself out as the cause), per-partial tau before -> after:
//
//   44.1k  115.4 ms -> 106.1     48k  106.1 ms -> 106.1     96k  53.6 -> 106.1
//
// i.e. a 2.15x spread became flat to within the warping term.
// `rings-sample-rate.test.ts` holds that, reading the decay off the real
// biquad poles rather than off a render.
//
// ── CAUSE 2, NOT FIXED, AND THE REASON THE READOUT STILL CANNOT EXIST ───────
// An RBJ biquad's decay is `2Q/(sin(w0)*sr)`, and `sin(w0)` collapses as `w0`
// approaches pi — so a partial that happens to land near Nyquist rings
// pathologically long, and WHICH partials land there is a function of the
// sample rate. At the shipped f0 the bank has 22 active modes at 44.1k, 23 at
// 48k and 24 at 96k, and the top one at 48k sits at 0.47*sr. Whole-bank tau
// spread, before -> after cause 1:
//
//   damping 0.5, brightness 0.5    2.80x -> 1.52x
//   damping 0.5, brightness 1.0   17.97x ->  9.00x
//
// Better, and still not one number. Removing the remainder means changing how
// near-Nyquist partials are voiced, which MOVES 48 kHz audio and needs an owner
// audition, so it is named rather than folded in.
//
// Nor is the RATIO stable enough to print instead: the BRIGHTNESS ring
// multiplier T60(b=1)/T60(b=0) measured 18.2x / 25.3x / 3.4x at 44.1 / 48 /
// 96 kHz.
//
// So the ring-time finding stays carried by the surfaces that need no number —
// the band LABEL ("2 · ring time — BOTH of these set it", which paints
// unconditionally where a hint does not), the sidebar, and a corrected
// `docs.controls.brightness`.

/** The params the RINGS faceplate reads. Resolved through the caller's reader,
 *  which already falls back to the def default for an untouched param. */
export interface RingsFaceParams {
  model: number;
  note: number;
  structure: number;
  brightness: number;
  damping: number;
  position: number;
  level: number;
}

/** Read the face params off a live param reader. */
export function ringsFaceParams(read: (paramId: string) => number | undefined): RingsFaceParams {
  const n = (id: string, dflt: number): number => {
    const v = read(id);
    return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
  };
  return {
    model: n('model', 0),
    note: n('note', 0),
    structure: n('structure', 0.25),
    brightness: n('brightness', 0.5),
    damping: n('damping', 0.5),
    position: n('position', 0.5),
    level: n('level', 0.8),
  };
}

/** Middle C, the pitch the resonator is tuned to with PITCH unpatched. Mirrors
 *  `packages/dsp/src/rings.ts` rather than being re-typed as a bare literal
 *  everywhere it is needed. */
export const RINGS_C4_HZ = 261.6256;
/** MODAL's partial count (`MODAL_MAX_PARTIALS`). */
export const RINGS_MODAL_PARTIALS = 24;
/** SYMPATHETIC detunes its second string by `structure * this` semitones
 *  (`RingsSympatheticStrings.configure`). */
export const RINGS_DETUNE_SEMITONES = 19;
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** The notated fundamental from the NOTE offset alone. ⚠ BLIND TO THE `pitch`
 *  CABLE by construction — a `FaceReadoutValue` is a pure function of PARAMS —
 *  so every surface that prints it says "knob", the `cube-f0-knobs` precedent. */
export function ringsKnobF0Hz(p: RingsFaceParams): number {
  return RINGS_C4_HZ * Math.pow(2, p.note / 12);
}

/** Is this model SYMPATHETIC? Rounded exactly as the DSP rounds it. */
export function ringsIsSympathetic(p: RingsFaceParams): boolean {
  return Math.max(0, Math.min(1, Math.round(p.model))) === 1;
}

/**
 * WHERE THE SECOND THING IS — and the two models mean different things by it.
 *
 * MODAL   partial 2 of a 24-partial bank, at `2*f0*(1 + structure/2)` (the
 *         incremental `stretch += structure*0.5`, evaluated at the second
 *         partial). Measured against the shipping worklet at structure
 *         0 / .25 / .5 / .75 / 1: ratio 2.0000 / 2.2500 / 2.5000 / 2.7500 /
 *         3.0000 against a prediction of exactly those.
 * SYMPATHETIC  there IS no partial 2 — there is a second STRING, detuned by
 *         `structure * 19` semitones. Same slider, a different object.
 */
export function ringsSecondPartialHz(p: RingsFaceParams): number {
  const f0 = ringsKnobF0Hz(p);
  const s = clamp01(p.structure);
  if (ringsIsSympathetic(p)) return f0 * Math.pow(2, (s * RINGS_DETUNE_SEMITONES) / 12);
  return 2 * f0 * (1 + s / 2);
}

/**
 * The hero's `2nd` line — A VALUE AND ITS UNIT, nothing else.
 *
 * ⚠ THE QUANTITY IS MODEL-AWARE EVEN THOUGH THE STRING IS NOT, which is why
 * the readout's LABEL is `2nd` rather than `partial 2`: in SYMPATHETIC there
 * is no partial 2, there is a second STRING at `structure * 19` semitones, and
 * a caption naming a partial would be wrong at half this module's settings.
 * Carrying that distinction in the printed text was tried and cut — a readout
 * states a value, not a thesis (owner directive 2026-08-11).
 */
export function ringsSecondPartialText(p: RingsFaceParams): string {
  return fmtRingsHz(ringsSecondPartialHz(p));
}

/** Hz with a sensible number of digits for a resonator's register. */
export function fmtRingsHz(hz: number): string {
  if (!Number.isFinite(hz)) return '—';
  if (hz >= 1000) return `${(hz / 1000).toFixed(2)} kHz`;
  if (hz >= 100) return `${hz.toFixed(1)} Hz`;
  return `${hz.toFixed(2)} Hz`;
}

/**
 * WHAT THE BODY IS — the rank-1 fact, and the one the MODEL control cannot say
 * about itself.
 *
 * `model` is a 0/1 discrete param with no `options` roster, so the dock paints
 * it as an anonymous <Toggle> reading its label and a switch position. That is
 * a two-state control over TWO DIFFERENT INSTRUMENTS — a 24-partial band-pass
 * bank versus a pair of Karplus-Strong loops — which additionally sit 5.37 dB
 * apart in output level at identical macros (measured, ODD tap, 2 s strummed:
 * MODAL -38.67 dBFS against SYMPATHETIC -33.30). This readout names it.
 *
 * It also carries STRUCTURE's meaning switch, which is the same class of fact:
 * in MODAL the slider stretches partial spacing, in SYMPATHETIC it detunes a
 * string pair by up to 19 semitones, and its own readback is `0.25` in both.
 */
export function ringsBodyText(p: RingsFaceParams): string {
  return ringsIsSympathetic(p) ? 'sympathetic' : 'modal';
}

/** How close POSITION must be to a landmark to count as sitting on it. The
 *  pickup weight is a cosine, so the null is a point rather than a band; this
 *  is the tolerance a dial can actually be parked at. */
export const RINGS_POSITION_EPS = 0.005;

/** The three states POSITION can be in — see `ringsEvenTapText`. */
export type RingsPickupState = 'node' | 'full-comb' | 'mirrored';

/**
 * WHICH STATE THE PICKUP IS IN. Three, all measured on the shipping worklet,
 * and no knob readback can distinguish any of them:
 *
 *   'node'       POSITION 0.25 or 0.75. Every ODD-INDEXED partial lands on a
 *                standing-wave zero, so the EVEN TAP GOES SILENT — measured
 *                peak 5.028e-16 at 0.25 and 1.302e-15 at 0.75, against an
 *                unaffected ODD (-35.62 dBFS RMS at both). A
 *                `paramId: 'position'` readout prints `0.25` and says nothing
 *                about one output being at digital zero.
 *   'full-comb'  POSITION 0, 0.5 or 1. Every |cos(2*PI*p*i)| = 1, so no partial
 *                is attenuated at all. ⚠ THE SHIPPED DEFAULT (0.5) IS ONE OF
 *                THESE: it is a MAXIMUM of the comb, not a midpoint. Measured,
 *                ODD at 0.5 is BIT-IDENTICAL to ODD at 0 (max|d| 0.000e+0) and
 *                EVEN at 0.5 is its exact polarity inverse (max|even(0) +
 *                even(0.5)| = 0.000e+0, against 6.836e-1 for the difference).
 *   'mirrored'   everywhere else. `cos(2*PI*(1-p)*i) = cos(2*PI*p*i)`, so p and
 *                1-p are the SAME filter bank: measured max|d| of exactly
 *                0.000e+0 at 0.00/1.00, 0.25/0.75 and 0.30/0.70, and ~5e-7 at
 *                the pairs whose float32 param values are not exact
 *                complements. THE TOP HALF OF THE DIAL RETRACES THE BOTTOM.
 */
export function ringsPickupState(p: RingsFaceParams): RingsPickupState {
  const pos = clamp01(p.position);
  const near = (x: number): boolean => Math.abs(pos - x) < RINGS_POSITION_EPS;
  if (near(0.25) || near(0.75)) return 'node';
  if (near(0) || near(0.5) || near(1)) return 'full-comb';
  return 'mirrored';
}

/**
 * The hero's `even tap` line — the STATE, and nothing else.
 *
 * ⚠ THE THREE-WAY STATE ABOVE COLLAPSES TO TWO WORDS HERE ON PURPOSE. The
 * mirror partner and the full-comb maxima are real and measured, but naming
 * them in the readout was narration; the travel strip in the hero PICTURE
 * shows both (the curve is symmetric about the centre line and the two node
 * marks sit on it), and `docs.controls.position` states them in words. What is
 * left is the one thing a player needs at a glance and cannot get from the
 * POSITION dial: whether one of the two outputs is currently dead.
 */
export function ringsEvenTapText(p: RingsFaceParams): string {
  return ringsPickupState(p) === 'node' ? 'silent' : 'live';
}

// ── THE PICKUP-COMB PICTURE ──────────────────────────────────────────────────

/** One drawn partial of the MODAL bank. */
export interface RingsCombPartial {
  /** 0-based partial index — index 0 IS the fundamental. */
  index: number;
  /** Its stretched centre frequency, Hz. */
  hz: number;
  /** The cosine pickup weight, `cos(2*PI*position*index)` — SIGNED, because the
   *  sign is what the mono fold hears and is the whole difference between
   *  POSITION 0 and POSITION 0.5 on the EVEN tap. */
  weight: number;
  /** Which output tap this partial lands in. `RingsModal.process` accumulates
   *  partial i into ODD when i is EVEN — index 0, the fundamental, is ODD. */
  tap: 'odd' | 'even';
  /** Drawn magnitude in 0..1 — `|weight|`, the pickup comb and nothing else.
   *  See the header note on why there is no loudness term. */
  height: number;
  /** FALSE for a partial above the Nyquist guard the DSP skips. */
  active: boolean;
}

/**
 * The Nyquist guard the DSP applies (`partialFreq < sr * 0.49`), evaluated at a
 * reference rate. It decides only WHICH partials exist, never how they are
 * drawn — the DSP itself skips them, so the picture must too.
 */
export const RINGS_PICTURE_SR = 48000;

/**
 * The drawn bank: 24 partials at their STRUCTURE-stretched positions, each
 * scaled by its cosine pickup weight and coloured by the tap it lands in.
 *
 * ⚠ THE BAR IS THE PICKUP WEIGHT, NOT A LOUDNESS — and the first version of
 * this function got that wrong in a way worth recording, because every gate
 * passed it and only rendering the dock and looking at it caught it.
 *
 * It scaled each bar by the band-pass PEAK GAIN, `Q**0.6`
 * (`MODAL_Q_GAIN_EXP`), reasoning that a partial's bar should show how loud it
 * is. Peak gain is not contribution: `Q` is proportional to partial frequency
 * here, and a high-Q filter is NARROW, so it captures less of a broadband
 * strike. Measured against the shipping worklet at the shipped defaults, the
 * drawn order was EXACTLY REVERSED — loudest-first by measurement
 * `2 3 0 1 5 4 6 7 …`, tallest-first as drawn `11 10 9 8 7 …`. The picture
 * said the top of the bank was the loud end; the spectrum says the bottom is.
 *
 * The fix is not a better loudness model. A truthful one would need the
 * excitation spectrum and the filter bandwidths — a second reimplementation of
 * the DSP for a decoration — and it would drag the sample rate back into a
 * picture that is otherwise free of it. So the bar shows the ONE thing this
 * panel is named for and can state exactly: `cos(2*PI*position*n)`, the pickup
 * comb. That is POSITION's entire effect, it is sample-rate independent, and it
 * is what makes the two nulls and the mirror symmetry visible.
 */
export function ringsCombBank(
  p: RingsFaceParams,
  sr: number = RINGS_PICTURE_SR,
): RingsCombPartial[] {
  const f0 = ringsKnobF0Hz(p);
  const structure = clamp01(p.structure);
  const position = clamp01(p.position);

  const stiffness = structure * 0.5;
  let stretch = 1;
  const w0 = 2 * Math.PI * position;

  const out: RingsCombPartial[] = [];
  for (let i = 0; i < RINGS_MODAL_PARTIALS; i++) {
    const hz = f0 * (i + 1) * stretch;
    const active = hz < sr * 0.49;
    const weight = Math.cos(w0 * i);
    out.push({
      index: i,
      hz,
      weight,
      tap: (i & 1) === 0 ? 'odd' : 'even',
      height: active ? Math.abs(weight) : 0,
      active,
    });
    stretch += stiffness;
  }
  return out;
}

/** The comb weight curve over the WHOLE position dial, for the panel's mirror
 *  strip — `n` samples of the mean |cos| across the active bank. Its symmetry
 *  about 0.5 is the §4-A finding drawn rather than described. */
export function ringsCombMirrorCurve(p: RingsFaceParams, n = 101): number[] {
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const pos = k / (n - 1);
    const bank = ringsCombBank({ ...p, position: pos });
    const live = bank.filter((b) => b.active);
    const mean = live.length
      ? live.reduce((s, b) => s + Math.abs(b.weight), 0) / live.length
      : 0;
    out.push(mean);
  }
  return out;
}
