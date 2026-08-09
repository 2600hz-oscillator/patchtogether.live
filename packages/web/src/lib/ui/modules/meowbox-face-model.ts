// packages/web/src/lib/ui/modules/meowbox-face-model.ts
//
// THE PURE MODEL BEHIND MEOWBOX's FACEPLATE — and the whole point of the face:
// UNBUNDLE `morph`.
//
// meowbox has four knobs. One of them indexes THIRTEEN five-entry tables through
// a linear crossfade between two neighbouring anchors (meowbox.dsp:29-63), so one
// fader moves all three formant frequencies, all three Qs, all three weights, the
// voiced/noise balance, the pitch contour's rise AND fall, and the decay scale —
// together. No surface in the rack says so, and three of those thirteen change
// numbers the OTHER knobs are labelled with:
//
//   * the note SETTLES `+riseAmtOf(morph)` octaves sharp of what PITCH asks for
//     (1.80 semitones at the shipped default) and stays there while the gate is
//     held, because `en.are` sustains at 1.0;
//   * the DECAY dial is MULTIPLIED by `decayScaleOf(morph)` before it reaches the
//     envelope, so its seconds are the truth at exactly one morph position;
//   * the effective peak gain of a formant is `aN·qN`, not `aN` — so the whole
//     amplitude table can sit flat at 1.0 across a move that changes band 1 by
//     +7.36 dB.
//
// ⚠ THE THIRTEEN TABLES ARE RE-TYPED, and that is a real drift risk stated
// rather than hidden. meowbox's DSP is FAUST (packages/dsp/src/meowbox.dsp), so
// — unlike kickdrum or ringback, whose models IMPORT their worklet's TS laws —
// there is nothing to import. meowbox ALSO has no `.f32` ART baseline (it is on
// ART_BACKLOG, and its three scenarios are a stub render, an OscillatorNode
// stand-in and an octave-RATIO check on the real wasm), so there is no
// downstream audio pin that would notice either. `meowbox-face-model.test.ts`
// parses all thirteen tables out of the .dsp SOURCE and fails on any
// disagreement; that grep is the ONLY guard, which is why it also asserts FIVE
// values parsed per table — a regex that silently matched nothing would compare
// [] to [] and pass green.
//
// PURE — no DOM, no Svelte, no engine. Node-testable.

import { MEOWBOX_C4_HZ, meowboxDef } from '$lib/audio/modules/meowbox';
import { fmtDb, fmtHz } from '$lib/audio/modules/kickdrum-format';

export { fmtDb, fmtHz, fmtMs } from '$lib/audio/modules/kickdrum-format';
/** C4 — the anchor the V/oct input and the PITCH knob both reference
 *  (`meowbox.dsp:72`). Re-exported from the def so there is ONE constant. */
export { MEOWBOX_C4_HZ } from '$lib/audio/modules/meowbox';

// ── the thirteen anchor tables (meowbox.dsp:29-41), verbatim ────────────────
//   0 kitten · 1 adult meow · 2 purr · 3 yowl · 4 hiss
export const F1_AT: readonly number[] = [700.0, 450.0, 180.0, 380.0, 100.0];
export const F2_AT: readonly number[] = [1900.0, 1300.0, 350.0, 1100.0, 4500.0];
export const F3_AT: readonly number[] = [3000.0, 2700.0, 800.0, 2400.0, 8000.0];
export const Q1_AT: readonly number[] = [12.0, 10.0, 6.0, 14.0, 0.5];
export const Q2_AT: readonly number[] = [14.0, 12.0, 8.0, 16.0, 8.0];
export const Q3_AT: readonly number[] = [12.0, 12.0, 8.0, 14.0, 8.0];
export const A1_AT: readonly number[] = [1.0, 1.0, 1.0, 1.0, 0.0];
export const A2_AT: readonly number[] = [0.85, 0.7, 0.6, 0.85, 0.7];
export const A3_AT: readonly number[] = [0.5, 0.4, 0.3, 0.6, 0.5];
export const VOICED_AT: readonly number[] = [0.85, 0.85, 0.6, 0.8, 0.15];
export const RISE_AT: readonly number[] = [0.25, 0.15, 0.0, 0.08, 0.0];
export const FALL_AT: readonly number[] = [0.22, 0.18, 0.0, 0.14, 0.0];
export const DECAY_SCALE_AT: readonly number[] = [0.7, 1.0, 1.5, 2.0, 0.6];

/** The five anchors, in table order — the names the .dsp's own header uses
 *  (`meowbox.dsp:17-27`). NOT vowels: the def's prose claimed an a/e/i/o/u
 *  taxonomy the source has never implemented. */
export const MEOWBOX_ANCHORS = ['kitten', 'adult', 'purr', 'yowl', 'hiss'] as const;

/** The envelope's SUSTAIN level — `en.adsr(0.005, 0.05, 0.4, …)`
 *  (`meowbox.dsp:109`). It is why "how long is a meow" has no numeric answer
 *  from the params alone, and why the audition is a HELD pad. */
export const MEOWBOX_SUSTAIN = 0.4;

/** Attack + decay, seconds (`meowbox.dsp:109`) — the fixed head of the
 *  envelope, before the sustain the gate holds. */
export const MEOWBOX_HEAD_S = 0.005 + 0.05;

/** The right channel's maximum delay, seconds: `maxDelay = 0.001·SR` samples
 *  scaled by `stereoSpread = (1 − ampEnv)·0.6` (`meowbox.dsp:113-114`). The
 *  .dsp's own comment at :111 says "up to 1 ms"; the `·0.6` caps it here. */
export const MEOWBOX_MAX_SPREAD_S = 0.6 * 0.001;

/** The crossfade position: which two anchors, and how far between them
 *  (`meowbox.dsp:44-47`). */
export function morphSeg(morph: number): {
  idx: number;
  seg: number;
  seg2: number;
  frac: number;
} {
  const idx = Math.max(0, Math.min(4, (Number.isFinite(morph) ? morph : 0) * 4));
  const seg = Math.floor(idx);
  return { idx, seg, seg2: Math.min(4, seg + 1), frac: idx - seg };
}

/** The linear crossfade the .dsp applies to every one of the thirteen tables
 *  (`meowbox.dsp:49`). ⚠ LINEAR IN HZ, not in log-frequency — which is why the
 *  mid-glide formants land on values that appear in no anchor row. */
export function lerpAt(table: readonly number[], morph: number): number {
  const { seg, seg2, frac } = morphSeg(morph);
  return (table[seg] ?? 0) * (1 - frac) + (table[seg2] ?? 0) * frac;
}

/**
 * The Q getters carry the .dsp's `max(0.5, …)` clamp (`:54-56`) so the mirror is
 * the source rather than a tidied version of it.
 *
 * ⚠ THE CLAMP IS DEAD CODE, MEASURED. Swept at 10 001 points across the whole
 * morph travel it binds at ZERO of them — the table minimum is already 0.5 and a
 * lerp of two values ≥ 0.5 is ≥ 0.5. Kept because removing it from the mirror
 * would make the mirror disagree with the source; pinned inert by the model test
 * so nobody reads it as a live constraint.
 */
const q = (table: readonly number[], m: number): number => Math.max(0.5, lerpAt(table, m));

export const f1Of = (m: number): number => lerpAt(F1_AT, m);
export const f2Of = (m: number): number => lerpAt(F2_AT, m);
export const f3Of = (m: number): number => lerpAt(F3_AT, m);
export const q1Of = (m: number): number => q(Q1_AT, m);
export const q2Of = (m: number): number => q(Q2_AT, m);
export const q3Of = (m: number): number => q(Q3_AT, m);
export const a1Of = (m: number): number => lerpAt(A1_AT, m);
export const a2Of = (m: number): number => lerpAt(A2_AT, m);
export const a3Of = (m: number): number => lerpAt(A3_AT, m);
export const voicedOf = (m: number): number => lerpAt(VOICED_AT, m);
export const riseAmtOf = (m: number): number => lerpAt(RISE_AT, m);
export const fallAmtOf = (m: number): number => lerpAt(FALL_AT, m);
export const decayScaleOf = (m: number): number => lerpAt(DECAY_SCALE_AT, m);

export interface MeowboxParams {
  pitch: number;
  morph: number;
  decay: number;
  level: number;
}

export const MEOWBOX_PARAM_IDS = [
  'pitch', 'morph', 'decay', 'level',
] as const satisfies readonly (keyof MeowboxParams)[];

/** Live values in, def defaults for anything untouched. `node.params` is a
 *  SPARSE overlay of what has been TOUCHED, so a bare read prints the wrong
 *  numbers on a fresh spawn (the crossover-panel scar). */
export function meowboxParams(read: (paramId: string) => number | undefined): MeowboxParams {
  const val = (id: string): number => {
    const v = read(id);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const pd = meowboxDef.params.find((p) => p.id === id);
    if (!pd) throw new Error(`meowbox-face-model: meowbox has no param '${id}'`);
    return pd.defaultValue;
  };
  return { pitch: val('pitch'), morph: val('morph'), decay: val('decay'), level: val('level') };
}

// ── A · THE RESOLVED FORMANTS ───────────────────────────────────────────────

/** The three band-pass centres, Hz. A `paramId: 'morph'` readout prints `0.375`
 *  and cannot express that you are mid-glide between two anchors on a LINEAR-IN-HZ
 *  interpolation; this triple is the only surface that can. */
export function meowboxFormantHz(p: MeowboxParams): [number, number, number] {
  return [f1Of(p.morph), f2Of(p.morph), f3Of(p.morph)];
}

/** `315 · 825 · 1750 Hz` — the hero's headline, three numbers wide. */
export function meowboxFormantsText(p: MeowboxParams): string {
  return meowboxFormantHz(p).map((hz) => fmtHz(hz)).join(' · ');
}

// ── B · THE EFFECTIVE PEAK GAIN, WHICH IS NOT THE AMPLITUDE TABLE ───────────

/**
 * The peak gain of each formant, LINEAR.
 *
 * ⚠ `aN · qN`, NOT `aN`. `fi.resonbp(fc, Q, gain)` expands to
 * `tf2s(0, gain, 0, 1/Q, 1, 2π·fc)` — H(s) = gain·s / (s² + s/Q + 1) — so at
 * s = j (i.e. ω = ω_c) the numerator is gain·j and the denominator is j/Q, and
 * |H(fc)| = **gain·Q exactly**. Verified numerically against the exact
 * coefficients at Q = 0.5/6/10/12/14/16: 0.500000 / 6.000000 / 10.000000 /
 * 12.000000 / 14.000000 / 16.000000.
 *
 * This is the readout the registry exists for. `A1` is 1.0 at morph 0.5 AND at
 * 0.75 AND at every point between, so a readout of the amplitude table is FLAT
 * across a move that changes band 1 by +7.36 dB.
 */
export function meowboxPeakGain(p: MeowboxParams): [number, number, number] {
  const m = p.morph;
  return [a1Of(m) * q1Of(m), a2Of(m) * q2Of(m), a3Of(m) * q3Of(m)];
}

/** The three peaks in dB. ⚠ `−∞` at morph 1.0, where `a1Of` is bit-exactly 0 —
 *  the honest number for a band that has been faded out, and the one place on
 *  this module a control is genuinely inert. */
export function meowboxPeakGainText(p: MeowboxParams): string {
  return meowboxPeakGain(p)
    .map((g) => (g > 0 ? fmtDb(20 * Math.log10(g)) : '−∞ dB'))
    .join(' · ');
}

// ── C · WHERE THE NOTE SETTLES, WHICH IS NOT WHERE YOU ASKED ────────────────

/** The fundamental the note STARTS at — `−fallAmtOf(morph)` octaves flat of the
 *  notated pitch, because the fall envelope's attack is 0 and it jumps to 1 on
 *  the gate edge (`meowbox.dsp:80`). */
export function meowboxOnsetHz(p: MeowboxParams): number {
  return MEOWBOX_C4_HZ * Math.pow(2, p.pitch / 12 - fallAmtOf(p.morph));
}

/**
 * The fundamental the note SETTLES on while the gate is held.
 *
 * ⚠ `en.are` SUSTAINS AT 1.0 (`envelopes.lib:652`), so the rise term does not
 * decay away — the note ends `+riseAmtOf(morph)` octaves SHARP of the notated
 * pitch and stays there until release. At the factory defaults that is 1.80
 * semitones: 261.63 Hz asked for, 290.29 Hz delivered. The .dsp's own comment at
 * :74-77 ("then it falls toward 0") says otherwise and is wrong.
 *
 * A `paramId: 'pitch'` readout prints `0 st` in every one of those states.
 */
export function meowboxSettledHz(p: MeowboxParams): number {
  return MEOWBOX_C4_HZ * Math.pow(2, p.pitch / 12 + riseAmtOf(p.morph));
}

/** How far sharp the settled note is, in semitones — the same fact as a
 *  difference rather than a frequency, for the sidebar. */
export function meowboxSettledSemitones(p: MeowboxParams): number {
  return 12 * riseAmtOf(p.morph);
}

// ── D · THE TAIL, AND WHY IT IS NOT "LENGTH" ────────────────────────────────

/**
 * The RELEASE TAIL, seconds — `decay × decayScaleOf(morph)` (`meowbox.dsp:109`).
 *
 * ⚠ IT IS NOT THE NOTE'S LENGTH, and the difference is the reason this function
 * has this name. `ampEnv` is an `en.adsr` SUSTAINING AT 0.4 while the gate is
 * non-zero, so total length = gate-high time + this — and gate-high time is not a
 * param. Printing a total under a hidden gate-length assumption is exactly what
 * `drummergirlHitText` refuses to do; this prints the half that IS answerable.
 *
 * ⚠ AT THE SHIPPED DEFAULTS IT EQUALS THE DIAL (0.40 s → 400 ms), which is
 * correct and is also precisely why a knob readback looks right here. Hold DECAY
 * at 0.40 and move MORPH to yowl and it is 800 ms while the dial still says 0.40.
 */
export function meowboxTailS(p: MeowboxParams): number {
  return p.decay * decayScaleOf(p.morph);
}

export function meowboxTailText(p: MeowboxParams): string {
  const s = meowboxTailS(p);
  if (!Number.isFinite(s) || s <= 0) return '0 ms';
  return s >= 1 ? `${s.toFixed(2)} s` : `${Math.round(s * 1000)} ms`;
}

// ── E · THE TREMOLO, AND THE COMMENT IT CONTRADICTS ─────────────────────────

/**
 * The 15 Hz AM depth on the voiced path — `0.4·(1 − voicedOf(morph))`
 * (`meowbox.dsp:96`).
 *
 * ⚠ THE .dsp COMMENT AT :92-95 IS BACKWARDS. It says the strength "scales with
 * `voicedOf(m)` so non-purr presets aren't affected… hiss has voiced ~0.15 so
 * tremolo has minimal effect anyway". The expression scales by `(1 − voiced)`, so
 * the depth is MAXIMAL at hiss (0.34) and MINIMAL at kitten and adult (0.06) —
 * the opposite, on both halves of the sentence. Pinned as a DEFECT rather than
 * approved: the model test fails the day the DSP is changed to match its comment.
 */
export function meowboxTremoloDepth(p: MeowboxParams): number {
  return 0.4 * (1 - voicedOf(p.morph));
}

export function meowboxTremoloText(p: MeowboxParams): string {
  return `${Math.round(100 * meowboxTremoloDepth(p))} % @ 15 Hz`;
}

// ── F · THE MONO-SUM COMB, WHICH NO KNOB MOVES ──────────────────────────────

/**
 * The first mono-sum null, Hz, as a function of the ENVELOPE — not of any param.
 *
 * `R = de.fdelay(maxDelay, (1 − ampEnv)·0.6·maxDelay, L)` (`meowbox.dsp:114-117`),
 * so R is L delayed by `(1 − ampEnv)·0.6 ms` and summing to mono combs at
 * `1 / (2·delay)`. Idle (ampEnv 0) that is 833 Hz — straight through the formant
 * region — and at the 0.4 sustain it is 1389 Hz. At the envelope peak the delay
 * is zero and there is no null at all.
 *
 * ⚠ THE ARGUMENT IS THE ENVELOPE ON PURPOSE. Every other derivation on this
 * module is a function of the live params; this one is a function of a quantity
 * no control touches, and taking it as a parameter is what makes the claim
 * FALSIFIABLE IN BOTH DIRECTIONS: the model test moves `ampEnv` and watches the
 * number move, then sweeps every param through the registered readout and asserts
 * the string never changes. A readout that responded to a knob would be measuring
 * something else.
 *
 * Returns `Infinity` at the peak, which the formatter renders rather than hides.
 */
export function meowboxCombNullHz(ampEnv: number): number {
  const e = Number.isFinite(ampEnv) ? Math.max(0, Math.min(1, ampEnv)) : 0;
  const delayS = (1 - e) * MEOWBOX_MAX_SPREAD_S;
  return delayS > 0 ? 1 / (2 * delayS) : Infinity;
}

/** The two ends of that span — idle and at the held sustain — as one string.
 *  A CONSTANT by construction: it is the fact, not a reading. */
export function meowboxCombNullText(): string {
  return `${fmtHz(meowboxCombNullHz(0))} idle · ${fmtHz(meowboxCombNullHz(MEOWBOX_SUSTAIN))} held`;
}

// ── THE FIVE ANCHORS, AS A REAL SELECTION ───────────────────────────────────

/** The param write one anchor row performs: `morph = k/4`, the exact index.
 *  `morph` is a CONTINUOUS fader over a five-entry table, so a row is the only
 *  way to land exactly ON an anchor rather than between two. */
export function meowboxAnchorMorph(i: number): number {
  return i / 4;
}

/**
 * An anchor row's annotation — DERIVED DATA, NOT PROSE. `F1 Hz · voiced % ·
 * tail ×scale`, computed from the tables, so the face's five `note` strings are
 * verified against the source rather than being captions that can go stale.
 * Pinned by `meowbox-face-model.test.ts`.
 */
export function meowboxAnchorNote(i: number): string {
  const f1 = F1_AT[i] ?? 0;
  const voiced = VOICED_AT[i] ?? 0;
  const scale = DECAY_SCALE_AT[i] ?? 0;
  return `${Math.round(f1)} Hz · ${Math.round(100 * voiced)} % voiced · tail ×${scale.toFixed(1)}`;
}

// ── THE PICTURE'S GEOMETRY (the `formant-bank` sidebar panel) ───────────────

/** One drawn resonance peak. `gain` is the EFFECTIVE peak (`a·Q`), which is what
 *  makes the picture say something a list of centre frequencies does not. */
export interface MeowboxFormantBand {
  hz: number;
  q: number;
  gain: number;
}

/** One drawn source partial: F, 2F, 3F and 4F at the .dsp's amplitudes
 *  (`meowbox.dsp:86-90`), against the SETTLED fundamental — the pitch the voice
 *  actually holds, not the one the knob asks for. */
export interface MeowboxPartial {
  hz: number;
  amp: number;
}

export const MEOWBOX_PARTIAL_AMPS: readonly number[] = [1.0, 0.5, 0.25, 0.125];

/** The log-frequency window the picture spans. Fixed rather than fitted: a
 *  window that rescaled with MORPH would make every anchor look identical, which
 *  is the one thing the picture exists to disprove. 80 Hz clears the lowest
 *  formant (100 Hz at hiss) and 10 kHz clears the highest (8 kHz). */
export const MEOWBOX_PLOT_MIN_HZ = 80;
export const MEOWBOX_PLOT_MAX_HZ = 10000;

/** 0..1 across the plot's LOG axis, clamped. */
export function meowboxPlotX(hz: number): number {
  if (!Number.isFinite(hz) || hz <= 0) return 0;
  const lo = Math.log2(MEOWBOX_PLOT_MIN_HZ);
  const hi = Math.log2(MEOWBOX_PLOT_MAX_HZ);
  return Math.max(0, Math.min(1, (Math.log2(hz) - lo) / (hi - lo)));
}

export function meowboxBands(p: MeowboxParams): MeowboxFormantBand[] {
  const [f1, f2, f3] = meowboxFormantHz(p);
  const [g1, g2, g3] = meowboxPeakGain(p);
  return [
    { hz: f1, q: q1Of(p.morph), gain: g1 },
    { hz: f2, q: q2Of(p.morph), gain: g2 },
    { hz: f3, q: q3Of(p.morph), gain: g3 },
  ];
}

export function meowboxPartials(p: MeowboxParams): MeowboxPartial[] {
  const f0 = meowboxSettledHz(p);
  return MEOWBOX_PARTIAL_AMPS.map((amp, i) => ({ hz: f0 * (i + 1), amp }));
}

/** The tallest effective peak — the picture's vertical normaliser. Never 0, so
 *  the panel cannot divide by zero at morph 1.0 where band 1 vanishes. */
export function meowboxPeakCeiling(p: MeowboxParams): number {
  return Math.max(1e-6, ...meowboxPeakGain(p));
}
