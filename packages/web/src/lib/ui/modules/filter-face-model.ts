// packages/web/src/lib/ui/modules/filter-face-model.ts
//
// THE PURE MODEL BEHIND FILTER's FACEPLATE — the magnitude response the sidebar
// draws, the peak gain the hero strip prints, and the two CV REACH windows.
//
// ⚠ ONE LAW, TWO SURFACES. `filterMagnitude` is the ONLY place the transfer
// functions are written down: the sidebar curve samples it and `filterPeakDb`
// maximises it. A panel that drew its own curve beside a peak computed from a
// closed form would be two pictures of two filters that happen to agree at the
// defaults — the divergence class CLAUDE.md documents one dimension over.
//
// WHERE THE ALGEBRA COMES FROM. Faust 2.85.5 `filters.lib`, read on the box the
// DSP compiles on (`fi.reson{lp,hp,bp}` are library functions; the file is not
// vendored here, which is why the shapes are restated with their derivations
// rather than cited alone). With s normalised to jω/ω_c and gain = 1
// (`filter.dsp:18-20` passes 1.0):
//
//   LP  `tf2s(0,0,1, 1/Q,1, ωc)`      H = 1 / (s² + s/Q + 1)
//   HP  `resonhp = x − resonlp(x)`    H = (s² + s/Q) / (s² + s/Q + 1)
//   BP  `tf2s(0,1,0, 1/Q,1, ωc)`      H = s / (s² + s/Q + 1)
//
// THE HP IS THE ONE WORTH STATING TWICE, because it is the fact the module's
// own tooltips got wrong: input-minus-lowpass puts a SECOND numerator zero at
// ω = 1/Q, i.e. f = fc/Q. Above that break the stopband is 12 dB/oct; BELOW it
// the taper is only 6 dB/oct — and at resonance 0 (Q 0.7) the break sits at
// 1.43 × fc, ABOVE the corner, so a zero-resonance highpass is a 6 dB/oct
// filter across its entire audible stopband. The BP's single `s` numerator
// gives it 6 dB/oct skirts on both sides for the same reason.
//
// ⚠ NO RANGE, CURVE OR DEFAULT IS RE-TYPED HERE. `filterFaceParams` resolves a
// missing value off `filterDef` (CLAUDE.md: a control's numbers come from ONE
// place). The only constants below are the DSP's own — the ±5-octave CV law,
// the 20 Hz/20 kHz clamp and the Q map — each mirroring one line of
// `filter.dsp` and named after it.
//
// PURE — no DOM, no Svelte, no engine. Node-testable.

import { filterDef } from '$lib/audio/modules/filter';

/** `filter.dsp:16` — `Q = q * 20.0 + 0.7`. */
export const FILTER_Q_SCALE = 20;
/** `filter.dsp:16` — the Q floor at resonance 0. */
export const FILTER_Q_OFFSET = 0.7;
/** `filter.dsp:13` — `pow(2.0, 5.0 * cutoffCv)`: full-scale CV = ±5 octaves. */
export const FILTER_CV_OCTAVES = 5;
/** `filter.dsp:13` — `: max(20.0) : min(20000.0)`, applied BEFORE `si.smoo`. */
export const FILTER_FC_MIN_HZ = 20;
export const FILTER_FC_MAX_HZ = 20000;

/** Mode ids, matching `ba.selectn(3, …, lp, hp, bp)` (`filter.dsp:10`). */
export const FILTER_MODE_LP = 0;
export const FILTER_MODE_HP = 1;
export const FILTER_MODE_BP = 2;

/** The five params every derived readout and the response panel read. */
export interface FilterFaceParams {
  cutoff: number;
  resonance: number;
  mode: number;
  cutoff_cv_amt: number;
  res_cv_amt: number;
}

/** The five ids, so a def-side rename fails a test instead of silently
 *  falling back to a default. */
export const FILTER_FACE_PARAM_IDS = [
  'cutoff', 'resonance', 'mode', 'cutoff_cv_amt', 'res_cv_amt',
] as const satisfies readonly (keyof FilterFaceParams)[];

/**
 * Live values in, resolving the DEF DEFAULT for anything the reader has no
 * answer for.
 *
 * ⚠ `node.params` is a SPARSE OVERLAY of what has been TOUCHED, not the
 * module's state — a freshly spawned filter has an empty map, so reading it
 * bare would compute every number from zeros and print a 20 Hz corner beside a
 * dial reading 1.0 kHz. A missing param id THROWS: that is a rename, and it
 * must be loud.
 */
export function filterFaceParams(
  read: (paramId: string) => number | undefined,
): FilterFaceParams {
  const val = (id: string): number => {
    const v = read(id);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const pd = filterDef.params.find((p) => p.id === id);
    if (!pd) throw new Error(`filter-face-model: filter has no param '${id}'`);
    return pd.defaultValue;
  };
  return {
    cutoff: val('cutoff'),
    resonance: val('resonance'),
    mode: val('mode'),
    cutoff_cv_amt: val('cutoff_cv_amt'),
    res_cv_amt: val('res_cv_amt'),
  };
}

/** `filter.dsp:14,16` — the resonance knob's Q, clamped the way the DSP is. */
export function filterQ(resonance: number): number {
  const q = Math.min(0.99, Math.max(0, resonance));
  return q * FILTER_Q_SCALE + FILTER_Q_OFFSET;
}

/**
 * |H(jω)| for the SELECTED mode at `u = ω / ω_c`, gain 1.
 *
 * The single source of truth for the response — the sidebar's curve and the
 * hero's peak both come from here. `u = 0` is exact rather than a limit: LP
 * passes DC at unity, HP and BP null it.
 */
export function filterMagnitude(mode: number, Q: number, u: number): number {
  if (!(u > 0)) return mode === FILTER_MODE_LP ? 1 : 0;
  const den = Math.hypot(1 - u * u, u / Q);
  if (!(den > 0)) return Number.POSITIVE_INFINITY;
  if (mode === FILTER_MODE_LP) return 1 / den;
  if (mode === FILTER_MODE_BP) return u / den;
  // HP: |jω(jω + 1/Q)| = u·√(u² + 1/Q²) — the second zero at u = 1/Q is what
  // makes the deep stopband 6 dB/oct rather than 12.
  return (u * Math.sqrt(u * u + 1 / (Q * Q))) / den;
}

/**
 * THE PEAK, in dB relative to unity: how much the corner adds into whatever
 * comes next. NOT a `resonance` readback — the three modes differ by 5.2 dB at
 * Q 0.7 and CONVERGE above ≈ Q 5, and that convergence is the fact the readout
 * teaches.
 *
 * Found by maximising `filterMagnitude` — a log scan seeded with each mode's
 * ASYMPTOTIC passband gain, then golden-section refined. The seed is not a
 * fudge: LP's DC gain and HP's ω→∞ gain are both exactly 1 by construction
 * (`gain = 1.0` in the .dsp), so at low Q — where the response has no interior
 * maximum at all — the honest answer is the passband, and a bare scan would
 * report it a few hundred-thousandths of a dB low. BP has no passband: it is
 * zero at both ends and peaks exactly at u = 1 with |H| = Q.
 *
 * ⚠ SCALE-INVARIANT BY CONSTRUCTION. `u` is normalised, so nothing here can
 * read `cutoff`; the "must not move" leg of the negative control is a property
 * of the signature, not of the arithmetic.
 */
export function filterPeakDb(mode: number, resonance: number): number {
  const Q = filterQ(resonance);
  if (mode === FILTER_MODE_BP) return 20 * Math.log10(Q);
  let best = 1; // the asymptotic passband — LP at DC, HP at Nyquist-ward ∞.
  let bu = 1;
  const N = 1201;
  for (let i = 0; i < N; i++) {
    const u = Math.pow(10, -3 + (6 * i) / (N - 1));
    const m = filterMagnitude(mode, Q, u);
    if (m > best) {
      best = m;
      bu = u;
    }
  }
  let lo = bu / 1.05;
  let hi = bu * 1.05;
  for (let k = 0; k < 80; k++) {
    const m1 = lo + (hi - lo) * 0.382;
    const m2 = lo + (hi - lo) * 0.618;
    if (filterMagnitude(mode, Q, m1) > filterMagnitude(mode, Q, m2)) hi = m2;
    else lo = m1;
  }
  best = Math.max(best, filterMagnitude(mode, Q, (lo + hi) / 2));
  return 20 * Math.log10(best);
}

/** A frequency window, Hz. `muted` = the depth knob is at 0, so the jack moves
 *  nothing and the "window" is the knob standing still. */
export interface FilterReachHz {
  lo: number;
  hi: number;
  muted: boolean;
  /** Reachable span in OCTAVES — `log2(hi/lo)`, which the clamp eats into. */
  octaves: number;
}

/**
 * WHERE A FULL-SCALE CV CAN THROW THE CORNER — `filter.dsp:13`, clamp included.
 *
 * `|depth|` because a negative attenuverter inverts the DIRECTION and reaches
 * the same two endpoints. The clamp is applied here, in the same order the DSP
 * applies it (clamp, then smooth — the smoother cannot change an endpoint), and
 * it is the whole reason this is a derivation rather than a multiplication: at
 * the shipped 1000 Hz / depth +1 the corner reaches 5.00 octaves DOWN but only
 * 4.32 UP, because 32 kHz does not exist.
 */
export function filterCutoffReach(p: FilterFaceParams): FilterReachHz {
  const depth = Math.abs(p.cutoff_cv_amt);
  const clamp = (hz: number): number =>
    Math.min(FILTER_FC_MAX_HZ, Math.max(FILTER_FC_MIN_HZ, hz));
  const lo = clamp(p.cutoff * Math.pow(2, -FILTER_CV_OCTAVES * depth));
  const hi = clamp(p.cutoff * Math.pow(2, FILTER_CV_OCTAVES * depth));
  return {
    lo,
    hi,
    muted: depth === 0,
    octaves: lo > 0 ? Math.log2(hi / lo) : 0,
  };
}

/** A resonance window on the knob's own 0..0.99 scale. */
export interface FilterResReach {
  lo: number;
  hi: number;
  muted: boolean;
}

/**
 * THE TRAVEL A PATCHED MODULATOR HAS ON THE RESONANCE SCALE — `filter.dsp:14`.
 * ADDITIVE (`resKnob + resCv`), not exponential, and clamped to 0..0.99 before
 * the smoother.
 */
export function filterResReach(p: FilterFaceParams): FilterResReach {
  const depth = Math.abs(p.res_cv_amt);
  const clamp = (v: number): number => Math.min(0.99, Math.max(0, v));
  return {
    lo: clamp(p.resonance - depth),
    hi: clamp(p.resonance + depth),
    muted: depth === 0,
  };
}

/** Hz for a REACH endpoint: `31 Hz`, `1.0 kHz`, `20.0 kHz`. */
export function fmtReachHz(v: number): string {
  if (!Number.isFinite(v)) return `${v}`;
  return v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`;
}

/** `31 Hz – 20.0 kHz`, or `1.0 kHz · muted` when the depth knob is at 0 — which
 *  is the honest thing to print about a knob whose jack is doing nothing. */
export function filterCutoffReachText(p: FilterFaceParams): string {
  const r = filterCutoffReach(p);
  if (r.muted) return `${fmtReachHz(r.lo)} · muted`;
  return `${fmtReachHz(r.lo)} – ${fmtReachHz(r.hi)}`;
}

/** `0.00 – 0.30`, or `0.10 · muted` at depth 0. */
export function filterResReachText(p: FilterFaceParams): string {
  const r = filterResReach(p);
  if (r.muted) return `${r.lo.toFixed(2)} · muted`;
  return `${r.lo.toFixed(2)} – ${r.hi.toFixed(2)}`;
}

/** The peak, formatted: `+8.8 dB`, `-3.1 dB`, `0.0 dB`. */
export function filterPeakDbText(p: FilterFaceParams): string {
  const db = filterPeakDb(p.mode, p.resonance);
  if (!Number.isFinite(db)) return `${db}`;
  const s = db.toFixed(1);
  return db > 0 ? `+${s} dB` : `${s} dB`;
}

// ── THE SIDEBAR CURVE ───────────────────────────────────────────────────────

/** One sampled point of the response plot, in NORMALISED [0,1] plot space. */
export interface FilterCurvePoint {
  /** 0 at `PLOT_MIN_HZ` → 1 at `PLOT_MAX_HZ`, LOG-spaced. */
  x: number;
  /** dB mapped onto the plot's own dB window: 0 at the floor, 1 at the top. */
  y: number;
  /** The frequency this point is at, Hz. */
  hz: number;
  /** The raw magnitude in dB (unclamped) — for a caller that wants the number. */
  db: number;
}

/** The plot's frequency axis: the audible decade-and-a-half the def's own
 *  `cutoff` range spans (`filter.ts:94` — 20..20000 Hz), so the picture and the
 *  knob cover exactly the same ground. */
export const PLOT_MIN_HZ = FILTER_FC_MIN_HZ;
export const PLOT_MAX_HZ = FILTER_FC_MAX_HZ;
/** The plot's dB window. The top is the maximum this filter can reach
 *  (+26.2 dB at resonance 0.99) rounded up, so the peak never leaves the box
 *  and the picture's vertical scale is FIXED — a curve that re-normalised
 *  itself would look identical at every resonance, which is the one thing the
 *  plot is drawn to show. */
export const PLOT_TOP_DB = 30;
export const PLOT_FLOOR_DB = -42;

/** Hz → the plot's normalised x (log axis). */
export function filterPlotX(hz: number): number {
  const lo = Math.log(PLOT_MIN_HZ);
  const hi = Math.log(PLOT_MAX_HZ);
  const v = Math.log(Math.min(PLOT_MAX_HZ, Math.max(PLOT_MIN_HZ, hz)));
  return (v - lo) / (hi - lo);
}

/**
 * Sample the SELECTED mode's magnitude response across the audible range.
 *
 * ⚠ Evaluated at the LIVE cutoff, so the whole curve slides when the hero dial
 * moves — the same param the strip's peak is INVARIANT to. Two surfaces, two
 * different sensitivities, one law.
 */
export function filterResponseCurve(p: FilterFaceParams, points = 96): FilterCurvePoint[] {
  const Q = filterQ(p.resonance);
  const fc = Math.min(PLOT_MAX_HZ, Math.max(PLOT_MIN_HZ, p.cutoff));
  const n = Math.max(2, Math.round(points));
  const out: FilterCurvePoint[] = [];
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    const hz = PLOT_MIN_HZ * Math.pow(PLOT_MAX_HZ / PLOT_MIN_HZ, x);
    const m = filterMagnitude(p.mode, Q, hz / fc);
    const db = m > 0 ? 20 * Math.log10(m) : PLOT_FLOOR_DB;
    const clamped = Math.min(PLOT_TOP_DB, Math.max(PLOT_FLOOR_DB, db));
    out.push({
      x,
      y: (clamped - PLOT_FLOOR_DB) / (PLOT_TOP_DB - PLOT_FLOOR_DB),
      hz,
      db,
    });
  }
  return out;
}
