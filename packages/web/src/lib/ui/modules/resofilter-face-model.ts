// packages/web/src/lib/ui/modules/resofilter-face-model.ts
//
// RESOFILTER's FACE MODEL — the pure arithmetic behind the faceplate's three
// derived readouts and its sidebar response curve.
//
// WHY THIS MODULE EXISTS, in one line: RESONANCE is one dial that sets one
// number, and the five modes turn that number into three different observable
// quantities — so a `paramId: 'resonance'` readout prints `0.30` in all five
// while the thing the player hears changes kind, not just degree.
//
//   k = 2 − 2·res, floored at 0.003 (`resToK`, imported below — never mirrored)
//
//   LP · HP   the gain AT CUTOFF is exactly 1/k, and nothing else moves.
//   BP        1/k is the peak AND 1/k sets the band's −3 dB width.
//   NT        there is no peak at all (the notch is an exact zero at every
//             resonance); k sets the WIDTH only.
//   AP        the magnitude is exactly 1 at every frequency and every
//             resonance; k sets how abruptly the 360° phase sweep happens —
//             the ±90° width, which is the SAME number as BP's/NT's −3 dB
//             width (measured: 2.538/2.532, 1.878/1.876, 1.126/1.122,
//             0.290/0.287 oct at res 0/0.3/0.6/0.9).
//
// So two numbers cover all five modes and between them say what one dial does:
// a PEAK in dB (LP/HP/BP) and a WIDTH in octaves (BP/NT/AP).
//
// ── WHAT WAS RE-MEASURED, AND WHERE THE SPEC WAS WRONG ──────────────────────
//
// Everything below was re-derived against the SHIPPING `resofilter-dsp.ts` at
// 48 kHz before it was written (`.myrobots/plans/face-specs-batch-4-resofilter
// .md` is the spec; four of its figures did not reproduce). Two of its errors
// were the SAME error — a resonant filter that has not settled:
//
//   * the spec reports the plateau peak gain as 50.441 dB and back-derives an
//     "implied k_min ≈ 0.003006" from it. `resToK` floors k at EXACTLY 0.003,
//     which is 50.4576 dB, and a 1 s render simply had not settled: measured
//     50.4547 / 50.4576 / 50.4576 / 50.4576 dB over 1 / 2 / 4 / 8 s. A DSP
//     constant was inferred from a measurement when it was in the source.
//   * the spec reports the notch as "50 dB deep and zero octaves wide" at
//     resonance 1.0, against −155 dB at every other resonance. Same artifact:
//     −68.0 dB on a 1 s render, −154.9 dB on 4 s and 16 s. The notch is a TRUE
//     ZERO at EVERY resonance (−155 dB is the f64 noise floor, not a depth);
//     only the width moves, 2.53 → 0.004 oct.
//
//   * the spec's "18 of 60 measured corners exceed full scale" does not
//     reproduce and cannot: it depends entirely on which 60 corners. On
//     5 modes × res {0,.2,.4,.6,.8,1} × mix {0.5,1} the answer is 9, and the
//     arithmetic is exhaustive — only LP/HP/BP above res ≈ 0.8 can exceed
//     unity at all. The robust form of the finding, which DOES reproduce
//     exactly, is the one this model publishes: peak gain reaches +50.46 dB
//     and nothing limits, so a −6 dBFS sine leaves at +44.46 dBFS.
//   * the spec's L/R figures (−9.03 / −33.49 dB) do not reproduce (0.00 /
//     −24.47 dB against each channel's own input, which agrees with its own
//     magnitude table). Its `max|L−R| = 5.281e-1` reproduces to the digit, so
//     the CLAIM (independent per-channel state) holds and only the reference
//     level was different.
//
// What DID reproduce, unchanged: the magnitude table, MIX 0 being bit-exact
// dry in all five modes (`max|out − in| = 0.000e+0`), silence unpatched, the
// notch-vs-frequency table, the peak-gain ladder, and the bypass corners.
//
// ── THE ONE APPROXIMATION, STATED ───────────────────────────────────────────
//
// The response law here is the ANALOG PROTOTYPE (`w = f / fc`), not the
// bilinear-prewarped digital one. That is a deliberate choice and it is the
// reason the readouts and the sidebar curve CANNOT disagree: both call these
// same functions, so there is no second implementation to drift.
//
//   * `svfPeakDb` is EXACT either way — measured 13.979 dB at fc 50, 200,
//     1000, 5000, 10000 and 15000 Hz for k = 0.2, because TPT prewarping puts
//     the resonance exactly at fc by construction.
//   * `svfWidthOct` is the prewarp-free width. Measured divergence from the
//     real filter: 0.0070 oct at fc 1 kHz, 0.028 at 2 kHz, 0.160 at 5 kHz,
//     0.98 at 15 kHz — i.e. above roughly 5 kHz the shipping filter's band is
//     genuinely NARROWER than the design value printed here. Pinned by
//     `resofilter-face-model.test.ts` so the gap is measured rather than
//     assumed, and stated in `docs.controls.resonance`.
//   * the curve's stopband tail runs 1.7 dB high at 8×fc and 8.7 dB high at
//     16×fc (the digital filter is steeper there), which is the conservative
//     direction for a picture.
//
// A per-interface digital law was considered and rejected: `FaceReadoutValue`
// is `(read) => string` and receives no sample rate, so a live readout would
// print ONE interface's answer as if it were every interface's (the reason
// `noise-brown-corner-hz` was not shipped). Between 44.1 k and 48 k the width
// differs by 0.0013 oct at the default cutoff, and by 0.18 oct at 20 kHz.
//
// PURE — no DOM, no Svelte, no engine. Node-testable.

// ⚠ THE PARAMS, NOT THE DEF — and the reason is structural rather than
// stylistic. `modules/resofilter.ts` opens with a Vite `?url` import of the
// worklet bundle, which Playwright's Node loader cannot resolve; importing it
// (even transitively) fails an entire e2e spec file with *"does not provide an
// export named 'default'"* before a single test is collected. `resofilter-face
// .spec.ts` needs THIS module so its expectations come from the same source
// the panel prints instead of being re-typed, so this module has to stay
// def-free. `noise-face-model` and `strict-faces` are def-free for the same
// reason; `cofefve-face-model` imports its def and has no e2e reading it.
import { RESOFILTER_PARAMS, resofilterParam } from '$lib/audio/resofilter-params';
// The SHIPPING damping law, imported via a RELATIVE path (not the
// `@patchtogether.live/dsp/src/...` alias) for the same reason cofefve-face-
// model.ts and warrensspectrum.ts do: worktrees may not symlink the workspace
// package under node_modules, and the TS path-alias rules don't reliably
// resolve TS source out of node_modules/@patchtogether.live/dsp/src.
//
// ⚠ IMPORTED, NEVER MIRRORED. `k = 2 − 2·res` floored at 0.003 is the ONE
// number every readout on this face is a function of; a re-typed copy here
// would let a DSP change leave the faceplate confidently wrong.
import { RESOFILTER_MODE_SHORT, resToK } from '../../../../../dsp/src/lib/resofilter-dsp';

/** The five short mode tags, re-exported so a CONSUMER of this model never has
 *  to reach for the def. `SvfResponsePanel` needs them for its legend, and a
 *  sidebar panel importing a module def would pull the Vite `?url` worklet
 *  import into the shell's chunk — the thing `sidebar-panels.ts` means by "the
 *  shell never imports a module". `FilterResponsePanel` reads only
 *  `filter-face-model` for the same reason. */
export { RESOFILTER_MODE_SHORT };

/** The five modes, by `mode` param value. */
export type SvfModeIndex = 0 | 1 | 2 | 3 | 4;

/** The live params this face reads. */
export interface ResofilterFaceParams {
  cutoff: number;
  resonance: number;
  mode: SvfModeIndex;
  mix: number;
}

const paramDefault = (id: string): number => resofilterParam(id).defaultValue;

const CUTOFF_MIN = resofilterParam('cutoff').min;
const CUTOFF_MAX = resofilterParam('cutoff').max;

/** Re-exported so a caller that already has this module does not have to reach
 *  for the def to learn what the params are. */
export { RESOFILTER_PARAMS };

/** The mode index the WORKLET resolves — `Math.round`, clamped to 0..4, which
 *  is `resofilter.ts:117` exactly. `Math.round(0.5)` is 1, so the boundary
 *  between LP and HP sits AT 0.5 and not above it. */
export function svfModeIndex(raw: number | undefined): SvfModeIndex {
  const r = Math.round(Number.isFinite(raw) ? (raw as number) : 0);
  return (r < 0 ? 0 : r > 4 ? 4 : r) as SvfModeIndex;
}

/**
 * Read the face's params off any reader, resolving the def DEFAULT for
 * anything untouched (`node.params` is a sparse overlay of what has been
 * TOUCHED — reading it bare prints a 20 Hz filter beside a dial saying 1 kHz).
 */
export function resofilterFaceParams(
  read: (paramId: string) => number | undefined,
): ResofilterFaceParams {
  const num = (id: string): number => {
    const v = read(id);
    return typeof v === 'number' && Number.isFinite(v) ? v : paramDefault(id);
  };
  return {
    cutoff: num('cutoff'),
    resonance: num('resonance'),
    mode: svfModeIndex(num('mode')),
    mix: Math.min(1, Math.max(0, num('mix'))),
  };
}

// ── THE TWO NUMBERS ─────────────────────────────────────────────────────────

/** The damping coefficient the SVF actually runs at. Re-exported so callers
 *  cannot be tempted to re-derive it. */
export function svfDamping(resonance: number): number {
  return resToK(resonance);
}

/** The RESONANCE above which `resToK`'s floor is active — everything from here
 *  to 1.0 is the SAME filter. DERIVED from the shipping floor, never typed:
 *  `k = 2 − 2·res = K_FLOOR ⇒ res = 1 − K_FLOOR/2`. */
export const RESOFILTER_K_FLOOR = resToK(1);
export const RESOFILTER_CLAMP_RES = 1 - RESOFILTER_K_FLOOR / 2;

/** Modes whose RESONANCE dial sets a PEAK HEIGHT: low-pass, high-pass,
 *  band-pass. The notch has no peak (it is an exact zero at cutoff at every
 *  resonance) and the allpass has unity magnitude everywhere. */
export const MODES_WITH_PEAK: ReadonlySet<SvfModeIndex> = new Set<SvfModeIndex>([0, 1, 2]);

/** Modes whose RESONANCE dial sets a BANDWIDTH: band-pass (−3 dB pass band),
 *  notch (−3 dB reject band) and allpass (the ±90° phase transition). All
 *  three are the same closed form because they share one denominator. */
export const MODES_WITH_WIDTH: ReadonlySet<SvfModeIndex> = new Set<SvfModeIndex>([2, 3, 4]);

/**
 * THE GAIN AT CUTOFF, in dB — exactly `1/k`.
 *
 * Measured against the shipping filter at cutoff 1 kHz: −6.021 / −2.923 /
 * 1.938 / 13.979 / 33.979 / 50.458 dB at resonance 0 / 0.3 / 0.6 / 0.9 / 0.99
 * / ≥0.9985, identical in LP, HP and BP, and identical at every cutoff from
 * 50 Hz to 15 kHz. Negative below resonance 0.5 (k > 1), which is a corner
 * that DIPS rather than peaks — the same signed convention `filter-peak-db`
 * already prints.
 */
export function svfPeakDb(resonance: number): number {
  return 20 * Math.log10(1 / svfDamping(resonance));
}

/**
 * THE BAND WIDTH IN OCTAVES — the −3 dB width of BP's pass band and NT's
 * reject band, and the ±90° width of AP's phase transition.
 *
 * All three fall out of the same condition. With `w = f/fc` normalised, the
 * denominator is `D = (1 − w²) + j·k·w`; the −3 dB points of `|w/D|` and
 * `|(1−w²)/D|` and the ±90° points of `arg(conj(D)/D)` are all where
 * `|1 − w²| = k·w`, i.e. `w² ± k·w − 1 = 0`:
 *
 *     w_hi = ( k + √(k²+4) ) / 2      w_lo = ( −k + √(k²+4) ) / 2
 *
 * Prewarp-free — see the file header for the measured divergence from the
 * shipping digital filter and why a sample-rate-aware form is not available
 * through the readout registry.
 */
export function svfWidthOct(resonance: number): number {
  const k = svfDamping(resonance);
  const root = Math.sqrt(k * k + 4);
  return Math.log2((k + root) / (root - k));
}

// ── THE CUTOFF CV WINDOW ────────────────────────────────────────────────────

/** Where a full-scale CUTOFF CV can throw the corner, in Hz. */
export interface SvfCutoffReach {
  loHz: number;
  hiHz: number;
  /** Octaves of DOWNWARD travel from the knob, after the 20 Hz clamp. */
  octavesDown: number;
  /** Octaves of UPWARD travel from the knob, after the 20 kHz clamp. */
  octavesUp: number;
}

/**
 * THE CUTOFF CV WINDOW — and the reason this readout is on the faceplate.
 *
 * `cutoff_cv` declares `cvScale: { mode: 'linear' }`, so `scaleCv` adds
 * `cv · (max − min)/2` = ±9990 **Hz** to a knob on a **log** taper, and then
 * the AudioParam clamps to 20..20000. resofilter is one of only six log-curve
 * params in the registry that scale their CV linearly; the other thirty-eight
 * — including the two other filter cutoffs, `qbrt` and `moog904c` — declare
 * `log`, which is symmetric in octaves by construction.
 *
 * The consequence is that the modulation window is wildly asymmetric and moves
 * with the knob. Measured:
 *
 *   knob     20 Hz →     20 .. 10010 Hz   (0.00 oct down,  8.97 up)
 *   knob    100 Hz →     20 .. 10090 Hz   (2.32 oct down,  6.66 up)
 *   knob   1000 Hz →     20 .. 10990 Hz   (5.64 oct down,  3.46 up)
 *   knob  10000 Hz →     20 .. 19990 Hz   (8.97 oct down,  1.00 up)
 *
 * against a symmetric ±4.98 octaves everywhere had it declared `log`. At the
 * bottom of the dial the CV cannot travel DOWN AT ALL; near the top an LFO is
 * nine octaves of downward sweep. Changing the declaration is an I/O-contract
 * change with its own re-pin, so this face STATES the window rather than
 * silently fixing it.
 */
export function svfCutoffReach(p: ResofilterFaceParams): SvfCutoffReach {
  const half = (CUTOFF_MAX - CUTOFF_MIN) / 2;
  const clamp = (hz: number): number => Math.min(CUTOFF_MAX, Math.max(CUTOFF_MIN, hz));
  const knob = clamp(p.cutoff);
  const loHz = clamp(knob - half);
  const hiHz = clamp(knob + half);
  return {
    loHz,
    hiHz,
    octavesDown: Math.log2(knob / loHz),
    octavesUp: Math.log2(hiHz / knob),
  };
}

// ── THE RESPONSE CURVE ──────────────────────────────────────────────────────

/** The plot's frequency window and dB window — shared by the curve sampler and
 *  by the panel's axis maths so the two cannot disagree. */
export const PLOT_MIN_HZ = 20;
export const PLOT_MAX_HZ = 20000;
export const PLOT_FLOOR_DB = -48;
export const PLOT_TOP_DB = 24;

/** 0 at `PLOT_MIN_HZ` → 1 at `PLOT_MAX_HZ`, log-spaced. */
export function svfPlotX(hz: number): number {
  const c = Math.min(PLOT_MAX_HZ, Math.max(PLOT_MIN_HZ, hz));
  return Math.log2(c / PLOT_MIN_HZ) / Math.log2(PLOT_MAX_HZ / PLOT_MIN_HZ);
}

/** dB → 0 at the plot floor, 1 at the plot top, clamped. */
export function svfPlotY(db: number): number {
  const t = (db - PLOT_FLOOR_DB) / (PLOT_TOP_DB - PLOT_FLOOR_DB);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** A complex number, as a bare pair (no allocation ceremony in a render path). */
interface Cx { re: number; im: number; }

/**
 * The WET transfer function of one SVF tap at normalised frequency `w = f/fc`.
 *
 *   D  = (1 − w²) + j·k·w
 *   LP = 1/D      HP = −w²/D     BP = j·w/D
 *   NT = LP + HP  = (1 − w²)/D
 *   AP = LP + HP − k·BP = conj(D)/D          (|AP| ≡ 1)
 *
 * The signs matter: the dry/wet crossfade below sums COMPLEX values, and
 * `|(1−m) + m·H|` is not `(1−m) + m·|H|`. Verified against the shipping
 * filter — LP at cutoff 1 kHz / resonance 0.9 measures 0.000 / 3.274 / 8.129 /
 * 11.500 / 13.979 dB at mix 0 / 0.25 / 0.5 / 0.75 / 1 and this predicts
 * 0.000 / 3.274 / 8.129 / 11.500 / 13.979.
 *
 * A magnitude-only crossfade gets that by 1.41 dB (9.542 against 8.129) — and
 * gets ALLPASS wrong in kind rather than in degree: |H_AP| ≡ 1, so it predicts
 * a flat 0 dB at every mix, where the real thing is a deep null at cutoff
 * because the rotating phase cancels against the dry path. That is the phaser,
 * and it is why MIX is worth drawing here at all.
 */
export function svfTap(w: number, k: number, mode: SvfModeIndex): Cx {
  const dr = 1 - w * w;
  const di = k * w;
  const d2 = dr * dr + di * di;
  if (d2 === 0) return { re: 0, im: 0 };
  switch (mode) {
    case 0: // LP = 1/D
      return { re: dr / d2, im: -di / d2 };
    case 1: // HP = -w^2/D
      return { re: -w * w * dr / d2, im: w * w * di / d2 };
    case 2: // BP = j*w/D
      return { re: w * di / d2, im: w * dr / d2 };
    case 3: // NT = (1-w^2)/D
      return { re: dr * dr / d2, im: -dr * di / d2 };
    default: // AP = conj(D)/D
      return { re: (dr * dr - di * di) / d2, im: (-2 * dr * di) / d2 };
  }
}

/** The DELIVERED transfer function — the dry/wet crossfade the DSP performs
 *  (`(1-m)*x + m*wet`, `ResofilterChannel.step`) applied to the tap above. */
export function svfDelivered(w: number, k: number, mode: SvfModeIndex, mix: number): Cx {
  const h = svfTap(w, k, mode);
  const m = mix < 0 ? 0 : mix > 1 ? 1 : mix;
  return { re: (1 - m) + m * h.re, im: m * h.im };
}

const FLOOR_LIN = 1e-7;
const cxDb = (c: Cx): number => 20 * Math.log10(Math.max(Math.hypot(c.re, c.im), FLOOR_LIN));

/** One sampled point of the response plot, in NORMALISED [0,1] plot space. */
export interface SvfCurvePoint {
  x: number;
  y: number;
  hz: number;
  db: number;
}

/**
 * The DELIVERED magnitude response — the curve the sidebar draws. `n` points,
 * log-spaced across `PLOT_MIN_HZ..PLOT_MAX_HZ`.
 */
export function svfResponseCurve(p: ResofilterFaceParams, n = 128): SvfCurvePoint[] {
  const k = svfDamping(p.resonance);
  const fc = Math.min(CUTOFF_MAX, Math.max(CUTOFF_MIN, p.cutoff));
  const out: SvfCurvePoint[] = [];
  for (let i = 0; i < n; i++) {
    const x = n === 1 ? 0 : i / (n - 1);
    const hz = PLOT_MIN_HZ * Math.pow(PLOT_MAX_HZ / PLOT_MIN_HZ, x);
    const db = cxDb(svfDelivered(hz / fc, k, p.mode, p.mix));
    out.push({ x, y: svfPlotY(db), hz, db });
  }
  return out;
}

/**
 * The WET-ONLY magnitude response — drawn under the delivered curve so the
 * MIX knob has something to move. Identical to `svfResponseCurve` at mix 1,
 * which is the def default, so the two traces coincide until MIX is touched.
 */
export function svfWetCurve(p: ResofilterFaceParams, n = 128): SvfCurvePoint[] {
  return svfResponseCurve({ ...p, mix: 1 }, n);
}

/**
 * The PHASE response, in normalised plot space (0 = −180°, 1 = +180°).
 *
 * ⚠ THE ALLPASS IS THE ONE MODE A MAGNITUDE PLOT CANNOT DRAW. Measured, its
 * output level is invariant to RESONANCE to every digit the instrument has —
 * −4.804 dB broadband at res 0, 0.001, 0.1, 0.3, 0.6, 0.9 AND 1.0, a span of
 * exactly 0.00 dB — while `max|Δ|` against res 0 runs 9.3e-4 → 1.4e0 over the
 * same travel. It is a pure phase rotation. A picture that showed only
 * magnitude there would draw a flat line, i.e. certify that the dial does
 * nothing, which is the one thing this faceplate must not do.
 */
export function svfPhaseCurve(p: ResofilterFaceParams, n = 128): SvfCurvePoint[] {
  const k = svfDamping(p.resonance);
  const fc = Math.min(CUTOFF_MAX, Math.max(CUTOFF_MIN, p.cutoff));
  const out: SvfCurvePoint[] = [];
  for (let i = 0; i < n; i++) {
    const x = n === 1 ? 0 : i / (n - 1);
    const hz = PLOT_MIN_HZ * Math.pow(PLOT_MAX_HZ / PLOT_MIN_HZ, x);
    const c = svfDelivered(hz / fc, k, p.mode, p.mix);
    const deg = (Math.atan2(c.im, c.re) * 180) / Math.PI;
    out.push({ x, y: (deg + 180) / 360, hz, db: deg });
  }
  return out;
}

// ── THE PRINTED STRINGS ─────────────────────────────────────────────────────

/** `+14.0 dB`, `−2.9 dB`, `0.0 dB` — signed, one decimal, U+2212 for minus so
 *  the glyph matches the rest of the faceplate's numerals. */
export function fmtSignedDb(db: number): string {
  if (!Number.isFinite(db)) return '—';
  const r = Math.round(db * 10) / 10;
  if (Object.is(r, -0) || r === 0) return '0.0 dB';
  return r > 0 ? `+${r.toFixed(1)} dB` : `−${Math.abs(r).toFixed(1)} dB`;
}

/**
 * The PEAK readout: the gain the RESONANCE dial puts at the cutoff frequency,
 * or `—` in the two modes that have no peak.
 *
 * NEGATIVE CONTROL — MODE. A `paramId: 'resonance'` readout prints `0.30` in
 * all five modes. This one prints a number in three of them and `—` in the
 * other two, and the two it refuses are exactly the two where the measured
 * peak does not exist: NT's gain at cutoff is a true zero at EVERY resonance
 * and AP's magnitude is exactly 1 at every frequency and every resonance.
 */
export function resofilterPeakText(p: ResofilterFaceParams): string {
  if (!MODES_WITH_PEAK.has(p.mode)) return '—';
  return fmtSignedDb(svfPeakDb(p.resonance));
}

/**
 * The WIDTH readout: the octave span RESONANCE opens or closes, or `—` in the
 * two modes that have no band.
 *
 * NEGATIVE CONTROL — MODE, in the MIRROR of the peak's. The two readouts are
 * each other's control: `peak` is live in LP/HP/BP and `width` in BP/NT/AP, so
 * every mode has exactly one of them except BP, which has both — and in NT a
 * broadband level metric measures 0.55 dB of span across the whole RESONANCE
 * travel while this moves 2.53 → 0.004 octaves.
 */
export function resofilterWidthText(p: ResofilterFaceParams): string {
  if (!MODES_WITH_WIDTH.has(p.mode)) return '—';
  const oct = svfWidthOct(p.resonance);
  return `${oct >= 1 ? oct.toFixed(2) : oct.toFixed(3)} oct`;
}

/** `840 Hz`, `1.10 kHz` — the same ladder on both ends of the reach window. */
export function fmtReachHz(hz: number): string {
  if (!Number.isFinite(hz)) return '—';
  return hz >= 1000 ? `${(hz / 1000).toFixed(2)} kHz` : `${Math.round(hz)} Hz`;
}

/**
 * The CV REACH readout: `20 Hz – 10.99 kHz` at the def default, the window a
 * full-scale CUTOFF CV can throw the corner through.
 *
 * ⚠ THE STRING IN THIS COMMENT IS THE ONE THE PANEL PAINTS, to two decimals,
 * and that is deliberate rather than fussy. It read `11.0 kHz` in the first
 * draft — a perfectly true rounding of the same number — which is precisely the
 * shape of the noise defect (#1464's third commit): a hero readout and a
 * sidebar entry printing two DIFFERENT TRUE values of one quantity, both
 * correct, neither wrong, and no gate able to see it because only one of them
 * was ever read. Quote what `fmtReachHz` produces, or quote raw Hz.
 *
 * NEGATIVE CONTROL — it must move with CUTOFF (the window is centred on the
 * knob in Hz and both ends clamp) while `peak` and `width` are both INVARIANT
 * to cutoff, and it must be invariant to RESONANCE, MODE and MIX, which both
 * of those move with. Publishing the three together is the pair's own control:
 * a derivation that moved all three, or none, is falsified on the spot.
 */
export function resofilterCvReachText(p: ResofilterFaceParams): string {
  const r = svfCutoffReach(p);
  return `${fmtReachHz(r.loHz)} – ${fmtReachHz(r.hiHz)}`;
}
