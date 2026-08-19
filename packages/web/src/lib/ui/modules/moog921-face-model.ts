// packages/web/src/lib/ui/modules/moog921-face-model.ts
//
// THE PURE MODEL BEHIND THE MOOG 921 OSCILLATOR FAMILY — the 921A driver, the
// 921B slave, and the standalone 921 VCO that packs both into one module. The
// driver and the slave share a file because they are ONE INSTRUMENT split
// across two defs and the number that matters is a product of both; the
// monolith joins them because it runs the SAME core (`moogFreqHz`,
// `syncModeFromParam`, `MoogVco`) and prints its pitch through the same
// formatters. One copy of the arithmetic, one copy of the formatting, one test
// file measuring all of it against the real worklets.
//
// ── WHY A MODEL AT ALL, FOR EIGHT ORDINARY KNOBS ────────────────────────────
//
// Because the 921A's headline dial is DIMENSIONLESS and its scale lives on a
// different control. `frequency` runs −1..+1 and means nothing on its own; the
// two-position `freqRange` switch decides whether that span is ONE octave or
// SIX (`packages/dsp/src/moog921a.ts:66-72`). The slaved 921B then reads the
// bus as V/oct. DERIVED THROUGH THE SHIPPING CORE (`moogFreqHz`), at the 921B's
// own defaults (`range = 0`, `fine = 0`, nothing on `freq_cv`):
//
//   frequency  freqRange     freq_bus   the 921B sings at
//   ---------  -----------   --------   -----------------
//   0.00       either          0 V        261.63 Hz  (C4)
//   +0.50      1 = SEMI       +0.5 V      370.00 Hz  (F#4)
//   +0.50      2 = OCT        +3.0 V     2093.01 Hz  (C7)
//   +1.00      2 = OCT        +6.0 V    16744.06 Hz
//   -1.00      2 = OCT        -6.0 V        4.09 Hz
//
// THE SAME DIAL POSITION IS F#4 OR C7 — 2^2.5, a factor of 5.66 — depending on
// a switch. The shipped cards print `0.50` and `SEMI`/`OCT`, and no Hz, no
// octave count and no volts anywhere on either panel.
//
// ── WHAT EACH FACE CAN AND CANNOT SEE, WHICH IS THE PAIRING ARGUMENT ────────
//
// A `FaceReadoutValue` receives a PARAM READER and nothing else
// (`face-readout-values.ts`). An audio-rate CONTROL INPUT is structurally
// invisible to it. So:
//
//   * the 921A can print the VOLTS it puts on the bus and the pitch those
//     volts encode — and cannot know what any slaved 921B adds on top;
//   * the 921B can print the OFFSET it adds and the pitch it sings with the
//     bus at rest — and cannot see the bus at all.
//
// Neither half can print the played pitch. Both halves print the two terms that
// compose into it, in units that add (`bus` volts + `offset` octaves), which is
// the most a def-driven face can honestly do here. That is why these two were
// authored together and why the arithmetic lives in ONE file.
//
// ── THE MIRRORED CONSTANTS ARE VALIDATED, NOT TRUSTED ───────────────────────
//
// Three numbers this model needs live inside WORKLET ENTRY files, which by
// design `export` NOTHING at the top level (a top-level export leaks into the
// bundled `dist/<name>.js` and breaks the ART classic-script eval — see each
// worklet's header). They are therefore MIRRORED here, and every one of them is
// MEASURED off the real processor in `moog921-face-model.test.ts` and asserted
// equal to the mirror. A mirrored constant nobody measures is a second copy of
// a number; a mirrored constant a gate re-derives from the artifact is not.
//
// PURE — no DOM, no Svelte, no engine, no fs. Node-testable.

import type { AudioModuleDef } from '$lib/audio/module-registry';
import { moog921aDef } from '$lib/audio/modules/moog921a';
import { moog921bDef } from '$lib/audio/modules/moog921b';
import { moog921VcoDef } from '$lib/audio/modules/moog921-vco';
import {
  MOOG_C4_HZ,
  type MoogSyncMode,
  moogFreqHz,
  syncModeFromParam,
} from '../../../../../dsp/src/lib/moog-vco-dsp';

// RELATIVE path, not the `@patchtogether.live/dsp/src/...` alias, for the reason
// `ninelives-face-model.ts` / `moog-filterbank-face-model.ts` both document: a
// worktree may not symlink the workspace package under node_modules, and the TS
// path-alias rules do not reliably resolve TS source out of there.

/**
 * The sample rate this model evaluates `moogFreqHz` AT.
 *
 * ⚠ A PHYSICAL CONSTANT WITH A STATED CONSEQUENCE, not a tuning knob and not a
 * population count. `moogFreqHz` clamps its result to `min(40000, sr · 0.49)`,
 * so the top of the compass is rate-dependent; the readout cannot ask the live
 * AudioContext for its rate because `FaceReadoutValue` receives a param reader
 * and nothing else. 48 kHz is Chrome's default on every platform the app ships
 * to and the ART harness's rate. The model test pins the 44.1 kHz delta so the
 * size of the approximation is a measured number rather than a shrug.
 */
export const MOOG921_MODEL_SR = 48_000;

/**
 * The V/oct span of the 921A's FREQUENCY pot in each RANGE position — MIRRORED
 * from `packages/dsp/src/moog921a.ts:66-67` (`RANGE_SEMITONE_OCT` /
 * `RANGE_OCTAVE_OCT`), which cannot export them.
 *
 * ⚠ THE 6:1 RATIO IS THE MODULE'S WHOLE READOUT STORY, so it is the one number
 * here most worth a gate: the model test drives the REAL 921A worklet at
 * `frequency = 1` in both positions and asserts the emitted `freq_bus` is
 * exactly these two values.
 */
export const MOOG921A_SEMI_OCT_SPAN = 1;
export const MOOG921A_OCT_OCT_SPAN = 6;

/**
 * The 921B's width-bus NORMAL threshold — MIRRORED from
 * `packages/dsp/src/moog921b.ts:170` (`widthBus < 0.02 ? 0.5 : widthBus`).
 *
 * ⚠ THE CABLE CARRIES float32 AND THIS LITERAL IS A double, so the comparison
 * is not symmetric about the printed number: `Math.fround(0.02)` is
 * 0.019999999552965164, which IS `< 0.02`. The normal therefore fires AT the
 * threshold as well as below it, and `slaveDuty` below reproduces that by
 * rounding through `Math.fround` rather than comparing the raw knob. Measured
 * (#1791): a bus of exactly 0.02 renders a 49.85 % duty, not 2 %.
 */
export const MOOG921B_WIDTH_NORMAL_BELOW = 0.02;
/** The duty the 921B substitutes when the normal fires (`moog921b.ts:170`). */
export const MOOG921B_WIDTH_NORMAL = 0.5;
/** The 921B's pulse-width clamp (`moog921b.ts:195-196`). */
export const MOOG921B_PW_MIN = 0.02;
export const MOOG921B_PW_MAX = 0.98;

/**
 * Full-scale linear-FM depth in Hz at `modAmount = 1` against a full-scale
 * (±1) modulator — MIRRORED from `packages/dsp/src/moog921b.ts:67`
 * (`LIN_FM_FULL_HZ`), which cannot export it. The model test measures it off
 * the real worklet (a DC offset of +1 at `modAmount = 1` against an unpatched
 * bus) and asserts the mirror.
 */
export const MOOG921B_LIN_FM_FULL_HZ = 2000;

// ── param readers ───────────────────────────────────────────────────────────

export interface Moog921aParams {
  readonly frequency: number;
  readonly freqRange: number;
  readonly width: number;
}

export interface Moog921bParams {
  readonly fine: number;
  readonly range: number;
  readonly modAmount: number;
  readonly syncMode: number;
  readonly level: number;
}

/**
 * Read one param, resolving the DEF DEFAULT for anything untouched and for any
 * non-finite value the live engine can hand back mid-boot. `node.params` is a
 * SPARSE overlay of what has been TOUCHED, so reading it bare prints
 * `undefined`-shaped nonsense on a freshly spawned node — and a readout runs on
 * every render, so a NaN reaching the arithmetic is a faceplate that goes down
 * mid-drag rather than a wrong number.
 */
function readOr(def: AudioModuleDef, read: (paramId: string) => number | undefined, id: string): number {
  const v = read(id);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const p = def.params.find((q) => q.id === id);
  if (!p) throw new Error(`moog921-face-model: ${def.type} has no param '${id}'`);
  return p.defaultValue;
}

export function moog921aFaceParams(read: (paramId: string) => number | undefined): Moog921aParams {
  return {
    frequency: readOr(moog921aDef, read, 'frequency'),
    freqRange: readOr(moog921aDef, read, 'freqRange'),
    width: readOr(moog921aDef, read, 'width'),
  };
}

export function moog921bFaceParams(read: (paramId: string) => number | undefined): Moog921bParams {
  return {
    fine: readOr(moog921bDef, read, 'fine'),
    range: readOr(moog921bDef, read, 'range'),
    modAmount: readOr(moog921bDef, read, 'modAmount'),
    syncMode: readOr(moog921bDef, read, 'syncMode'),
    level: readOr(moog921bDef, read, 'level'),
  };
}

// ── the 921A: what goes ON the two buses ────────────────────────────────────

/** RANGE switch → the V/oct span of the FREQUENCY pot. Mirror of
 *  `rangeOctSpan` (`packages/dsp/src/moog921a.ts:70-72`), rounding rule
 *  included: anything that rounds to ≥ 2 is OCT. */
export function rangeOctSpan(freqRange: number): number {
  return Math.round(freqRange) >= 2 ? MOOG921A_OCT_OCT_SPAN : MOOG921A_SEMI_OCT_SPAN;
}

/**
 * The volts the 921A puts on `freq_bus` — `frequency × octSpan`.
 *
 * ⚠ THIS IS THE NUMBER THE `frequency` KNOB CANNOT PRINT, and the blindness is
 * exact: a knob readback is INVARIANT to `freqRange`, which multiplies the
 * answer by six. Excludes `freq_cv`, which the worklet sums in AFTER the
 * multiply (`moog921a.ts:138`) and which no param reader can see.
 */
export function busVolts(p: Moog921aParams): number {
  return p.frequency * rangeOctSpan(p.freqRange);
}

/** The pitch those volts ENCODE — what a 921B at zero offset would sing.
 *  Evaluated through the shipping core so the clamp is the DSP's, not ours. */
export function busPitchHz(p: Moog921aParams): number {
  return moogFreqHz(busVolts(p), 0, 0, 0, MOOG921_MODEL_SR);
}

/** The pitch the bus would encode if the RANGE switch were in `octSpan`
 *  instead — the two-row comparison that is this pair's headline fact. */
export function busPitchHzAtSpan(p: Moog921aParams, octSpan: number): number {
  return moogFreqHz(p.frequency * octSpan, 0, 0, 0, MOOG921_MODEL_SR);
}

/**
 * The FULL COMPASS the FREQUENCY pot can reach in the CURRENT range position —
 * the dial at −1 and at +1.
 *
 * Invariant to `frequency` BY CONSTRUCTION (it evaluates the endpoints, not the
 * dial), so it moves only with `freqRange` while `busVolts` moves with both.
 * That is what makes the two each other's permanent negative control.
 */
export function busCompassHz(p: Moog921aParams): { readonly lo: number; readonly hi: number } {
  const span = rangeOctSpan(p.freqRange);
  return {
    lo: moogFreqHz(-span, 0, 0, 0, MOOG921_MODEL_SR),
    hi: moogFreqHz(span, 0, 0, 0, MOOG921_MODEL_SR),
  };
}

export interface SlaveDuty {
  /** Did the 921B's NORMAL fire — i.e. is the bus being ignored? */
  readonly normalled: boolean;
  /** The duty cycle the 921B's `rect` tap actually renders, 0..1. */
  readonly duty: number;
}

/**
 * What a slaved 921B's RECT tap actually does with a given width-bus value.
 *
 * ⚠ THIS READS A LAW THAT LIVES IN THE OTHER MODULE, and that is deliberate: it
 * is the only place either faceplate can state what the WIDTH knob DOES,
 * because the 921A has no pulse in it at all. The 921A emits
 * `clamp(knob + width_cv, 0, 1)` (`moog921a.ts:143-146`) and the 921B applies
 * `widthBus < 0.02 ? 0.5 : widthBus` then clamps to 0.02..0.98
 * (`moog921b.ts:170, 195-196`).
 *
 * ⚠ AND IT PRINTS A LIVE DEFECT RATHER THAN HIDING IT (#1791, filed not fixed).
 * The declared MINIMUM width, 0.000, lands on the MIDPOINT result — measured
 * 49.85 % duty at the `rect` tap, bit-identical to leaving the cable unpatched
 * — and everything from 0 up to and including float32(0.02) reads the same.
 * `normalled` is what lets the readout SAY so instead of printing a plausible
 * `50 %` that looks like the dial working.
 *
 * The `Math.fround` is not defensive rounding: the bus is a `Float32Array`, so
 * the comparison the worklet performs is against the float32 image of the knob,
 * and `Math.fround(0.02) < 0.02`. Modelling the double would put the cliff one
 * step in the wrong place.
 */
export function slaveDuty(widthBus: number): SlaveDuty {
  if (!Number.isFinite(widthBus)) return { normalled: true, duty: MOOG921B_WIDTH_NORMAL };
  const bus = Math.fround(Math.min(1, Math.max(0, widthBus)));
  if (bus < MOOG921B_WIDTH_NORMAL_BELOW) {
    return { normalled: true, duty: MOOG921B_WIDTH_NORMAL };
  }
  return { normalled: false, duty: Math.min(MOOG921B_PW_MAX, Math.max(MOOG921B_PW_MIN, bus)) };
}

// ── the 921B: what it ADDS to whatever arrives on the bus ───────────────────

/** The pitch offset the 921B applies on top of the bus, in OCTAVES — the term
 *  that ADDS to the 921A's `bus` volts. RANGE is footage; FINE is semitones. */
export function slaveOffsetOct(p: Moog921bParams): number {
  return p.range + p.fine / 12;
}

/** What the 921B sings with the bus AT REST (0 V = C4) — its own offset alone.
 *  Through the shipping core, so the 0.01 Hz floor and the Nyquist ceiling are
 *  the DSP's. */
export function slavePitchHz(p: Moog921bParams): number {
  return moogFreqHz(0, p.range, p.fine, 0, MOOG921_MODEL_SR);
}

/** Output gain in dB — the `level` dial is a 0..2 LINEAR multiplier, so its
 *  own readback says `1.00` where the answer is `0.0 dB` and `2.00` where the
 *  answer is `+6.0 dB`. −Infinity at zero; the formatter prints `silent`. */
export function slaveOutDb(p: Moog921bParams): number {
  return 20 * Math.log10(Math.max(p.level, 0));
}

/** The linear-FM swing in Hz a FULL-SCALE (±1) modulator buys at the current
 *  FM depth. Ships at 0, so BOTH FM jacks are bit-exactly silent as delivered —
 *  which is the number this readout exists to print. */
export function slaveFmSpanHz(p: Moog921bParams): number {
  return Math.abs(p.modAmount) * MOOG921B_LIN_FM_FULL_HZ;
}

/** The SYNC comparator's actual state, through the DSP's own thresholds
 *  (`syncModeFromParam`: ≥ +0.5 hard, ≤ −0.5 soft, else off). The dial is
 *  declared −1..1 over three states, so 50 % of its travel is one flat `off`
 *  and its bare readback prints `0.00` for it. */
export function slaveSyncMode(p: Moog921bParams): MoogSyncMode {
  return syncModeFromParam(p.syncMode);
}

// ── formatting ──────────────────────────────────────────────────────────────

/** A frequency as this pair prints it. Three decades of precision matter here
 *  — the OCT compass runs 4.09 Hz to 16.74 kHz — so the precision follows the
 *  magnitude rather than being fixed. */
export function fmtOscHz(hz: number): string {
  if (!Number.isFinite(hz)) return '—';
  if (hz >= 1000) return `${(hz / 1000).toFixed(2)}k`;
  if (hz >= 100) return `${hz.toFixed(1)} Hz`;
  return `${hz.toFixed(2)} Hz`;
}

/** A SIGNED volt count — a bus voltage needs its direction printed. */
export function fmtVolts(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const r = v.toFixed(2);
  return `${v >= 0 && !r.startsWith('-') ? '+' : ''}${r} V`;
}

/** A SIGNED octave offset, same reason. */
export function fmtOct(oct: number): string {
  if (!Number.isFinite(oct)) return '—';
  const r = oct.toFixed(2);
  return `${oct >= 0 && !r.startsWith('-') ? '+' : ''}${r} oct`;
}

// ── the readout texts ───────────────────────────────────────────────────────

/** `bus` — the volts on `freq_bus`. */
export function busVoltsText(p: Moog921aParams): string {
  return fmtVolts(busVolts(p));
}

/** `span` — the whole compass the FREQUENCY pot reaches in this RANGE. */
export function busCompassText(p: Moog921aParams): string {
  const c = busCompassHz(p);
  return `${fmtOscHz(c.lo)} … ${fmtOscHz(c.hi)}`;
}

/** `duty` — what the slaved 921B's RECT tap actually renders, and whether the
 *  bus is being IGNORED (the #1791 normal). */
export function slaveDutyText(width: number): string {
  const d = slaveDuty(width);
  const pct = `${(d.duty * 100).toFixed(0)} %`;
  return d.normalled ? `norm ${pct}` : pct;
}

/** One sidebar row: the pitch the bus would encode at a given RANGE position,
 *  whichever position is actually selected. */
export function busPitchAtSpanText(p: Moog921aParams, octSpan: number): string {
  return fmtOscHz(busPitchHzAtSpan(p, octSpan));
}

/** `pitch` — what the 921B sings with the bus at rest. */
export function slavePitchText(p: Moog921bParams): string {
  return fmtOscHz(slavePitchHz(p));
}

/** `offset` — the octaves it adds to whatever the bus carries. */
export function slaveOffsetText(p: Moog921bParams): string {
  return fmtOct(slaveOffsetOct(p));
}

/** `out` — the output gain in dB. */
export function slaveOutText(p: Moog921bParams): string {
  const db = slaveOutDb(p);
  if (!Number.isFinite(db)) return 'silent';
  const r = db.toFixed(1);
  return `${db >= 0 && !r.startsWith('-') ? '+' : ''}${r} dB`;
}

/** `fm` — the ±Hz a full-scale modulator buys. `off` when the depth is zero,
 *  because `±0 Hz` reads like a rounding artefact rather than a dead jack. */
export function slaveFmText(p: Moog921bParams): string {
  const hz = slaveFmSpanHz(p);
  if (!Number.isFinite(hz)) return '—';
  if (hz === 0) return 'off';
  return `± ${fmtOscHz(hz)}`;
}

/** `sync` — the comparator's state, named. */
export function slaveSyncText(p: Moog921bParams): string {
  return slaveSyncMode(p);
}

// ── THE MONOLITH: moog921Vco, the third member of the family ────────────────
//
// Same oscillator core (`moogFreqHz` / `syncModeFromParam` / `MoogVco`), a
// DIFFERENT instrument: the 921A driver and the 921B slave packed into one
// module, with the jack neither half of the pair has — its OWN 1V/oct input. So
// it needs its own arithmetic rather than a rename of the slave's:
//
//   * its dials are `octave` + `tune` (±5 oct, ±12 st) where the pair splits the
//     job across `frequency`/`freqRange` on one def and `range`/`fine` on the
//     other, so the pitch join is over TWO dials on ONE face and there is no bus
//     term to leave unprinted;
//   * it owns `width` directly (the pair passes duty over a bus and normals it,
//     which is #1791) — and WIDTH here is level-invariant, so it is deliberately
//     NOT a term in any readout below. That is what makes it the whole set's
//     permanent negative control;
//   * its `linFmAmount` is a control on the SAME face as the jack it gates,
//     where the slave's `modAmount` gates two.
//
// Every function below is a pure function of `node.params` — no bus, no CV, no
// engine — which is the whole of what a `FaceReadoutValue` can see.

/**
 * Full-scale linear-FM depth in Hz at `linFmAmount = 1` against a full-scale
 * (±1) modulator — MIRRORED from `packages/dsp/src/moog921-vco.ts:155`
 * (`linFmAmt * linFm * 2000`), which is a worklet ENTRY file and by design
 * exports nothing at the top level.
 *
 * ⚠ MEASURED off the real processor in `moog921-face-model.test.ts` and asserted
 * equal to this mirror, for the reason the header gives: a mirrored constant
 * nobody measures is just a second copy of a number.
 *
 * It happens to equal the 921B's `MOOG921B_LIN_FM_FULL_HZ`, and they are still
 * two constants — they live in two worklets that could diverge, and the test
 * measures each against its own processor rather than asserting they agree.
 */
export const MOOG921VCO_LIN_FM_FULL_HZ = 2000;

export interface Moog921VcoParams {
  readonly octave: number;
  readonly tune: number;
  readonly width: number;
  readonly linFmAmount: number;
  readonly sync: number;
  readonly level: number;
}

export function moog921VcoFaceParams(read: (paramId: string) => number | undefined): Moog921VcoParams {
  return {
    octave: readOr(moog921VcoDef, read, 'octave'),
    tune: readOr(moog921VcoDef, read, 'tune'),
    width: readOr(moog921VcoDef, read, 'width'),
    linFmAmount: readOr(moog921VcoDef, read, 'linFmAmount'),
    sync: readOr(moog921VcoDef, read, 'sync'),
    level: readOr(moog921VcoDef, read, 'level'),
  };
}

/**
 * What it sings with the PITCH jack at rest (0 V = C4) — the join over both
 * dials, evaluated through the SHIPPING core so the 0.01 Hz floor and the
 * Nyquist ceiling are the DSP's rather than a second opinion.
 *
 * ⚠ THIS IS THE NUMBER NEITHER DIAL CAN PRINT, and the blindness is mutual: a
 * RANGE readback is invariant to FREQ and vice versa, while the answer is a
 * product of both and of a C4 reference that appears on no panel. Both read `0`
 * at the factory settings, where this is 261.63 Hz.
 *
 * Excludes the `pitch` jack itself, which a param reader cannot see — the
 * readout prints what the module contributes, and the patch adds the rest.
 */
export function vcoPitchHz(p: Moog921VcoParams): number {
  return moogFreqHz(0, p.octave, p.tune, 0, MOOG921_MODEL_SR);
}

/**
 * The FULL COMPASS the two pitch dials reach — evaluated at the DEF'S OWN
 * declared endpoints, so it cannot drift from the contract and no bound is
 * re-typed here.
 *
 * ⚠ NOT PUBLISHED AS A READOUT, deliberately, and the reason is this function's
 * own shape: it takes no params and is invariant to every dial, so as a readout
 * it could never move. It exists for `docs`, for the def's rank argument and for
 * the test that pins the span — the places a constant belongs.
 */
export function vcoCompassHz(): { readonly lo: number; readonly hi: number } {
  const oct = moog921VcoDef.params.find((p) => p.id === 'octave')!;
  const tune = moog921VcoDef.params.find((p) => p.id === 'tune')!;
  return {
    lo: moogFreqHz(0, oct.min, tune.min, 0, MOOG921_MODEL_SR),
    hi: moogFreqHz(0, oct.max, tune.max, 0, MOOG921_MODEL_SR),
  };
}

/** Output gain in dB — `level` is a 0..2 LINEAR multiplier, so its own readback
 *  says `1.00` where the answer is `0.0 dB` and `2.00` where it is `+6.0 dB`.
 *  −Infinity at zero; the formatter prints `silent`, and the worklet really does
 *  render bit-exact zeros there (measured at steady state — a whole-render RMS
 *  reads the 80 Hz smoother's ramp instead and says −30 dB). */
export function vcoOutDb(p: Moog921VcoParams): number {
  return 20 * Math.log10(Math.max(p.level, 0));
}

/** The linear-FM swing in Hz a FULL-SCALE (±1) modulator buys at the current
 *  depth. Ships at 0, and that is not an approximation: with a 200 Hz sine on
 *  `lin_fm` the render is BIT-IDENTICAL to leaving the jack unpatched. */
export function vcoFmSpanHz(p: Moog921VcoParams): number {
  return Math.abs(p.linFmAmount) * MOOG921VCO_LIN_FM_FULL_HZ;
}

/** The SYNC comparator's actual state, through the DSP's own thresholds
 *  (`syncModeFromParam`: ≥ +0.5 hard, ≤ −0.5 soft, else off). */
export function vcoSyncMode(p: Moog921VcoParams): MoogSyncMode {
  return syncModeFromParam(p.sync);
}

/** `pitch` — what it sings with the pitch jack at rest. */
export function vcoPitchText(p: Moog921VcoParams): string {
  return fmtOscHz(vcoPitchHz(p));
}

/** `out` — the output gain in dB, on all four taps. */
export function vcoOutText(p: Moog921VcoParams): string {
  const db = vcoOutDb(p);
  if (!Number.isFinite(db)) return 'silent';
  const r = db.toFixed(1);
  return `${db >= 0 && !r.startsWith('-') ? '+' : ''}${r} dB`;
}

/** `fm` — the ±Hz a full-scale modulator buys. `off` when the depth is zero,
 *  because `± 0.00 Hz` reads like a rounding artefact rather than a dead jack. */
export function vcoFmText(p: Moog921VcoParams): string {
  const hz = vcoFmSpanHz(p);
  if (!Number.isFinite(hz)) return '—';
  if (hz === 0) return 'off';
  return `± ${fmtOscHz(hz)}`;
}

/** `sync` — the comparator's state, named. */
export function vcoSyncText(p: Moog921VcoParams): string {
  return vcoSyncMode(p);
}
