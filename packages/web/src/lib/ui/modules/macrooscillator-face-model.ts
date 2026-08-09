// packages/web/src/lib/ui/modules/macrooscillator-face-model.ts
//
// THE PURE MODEL BEHIND MACROOSCILLATOR's FACEPLATE — the derived readouts and
// the hero picture's geometry.
//
// ⚠ WHAT THIS FACE IS FOR, IN ONE SENTENCE: the module's three macro dials mean
// something different in each of fourteen engines, and until this file NOTHING
// in the UI said which. A `paramId: 'harmonics'` readout prints `0.75` in all
// fourteen states — correct, useless, and actively misleading in the four
// engines where the fader is a switch. Every readout here is DERIVED for that
// reason, and each carries the perturbation that distinguishes it from a knob
// readback in its own comment (and, permanently, in the model test).
//
// ⚠ FOUR OF THESE READOUTS EXIST TO REPORT A DEFECT, NOT A FEATURE, and that
// is a deliberate scoping decision. WAVETABLE's morph is bit-exactly dead over
// its bottom half, GRANULAR's morph is a 3-position switch, MODAL's timbre runs
// BACKWARDS, and OUT level spans 76.6 dB across engines at identical macros.
// Every one of those is worklet arithmetic (`packages/dsp/src/macrooscillator
// .ts`), so fixing them is a DSP change to saved-rack audio and belongs in its
// own owner-audition PR — never folded into a face wave (CLAUDE.md; batch-3
// INDEX rule 5). What a face CAN do, and what this one does, is refuse to paint
// a dead control as a working one. The claims are re-derived from
// `macrooscillatorMath` in the model test, so the day the DSP is fixed the
// faceplate's stale claim goes RED rather than quietly lying the other way.
//
// PURE — no DOM, no Svelte, no engine handle. Node-testable.

import { macrooscillatorDef, macrooscillatorMath } from '$lib/audio/modules/macrooscillator';
import {
  MACRO_ENGINES,
  macroBucket,
  macroEngineAt,
  type MacroEngine,
} from '$lib/audio/modules/macro-engine-roster';

export interface MacroFaceParams {
  model: number;
  note: number;
  harmonics: number;
  timbre: number;
  morph: number;
  level: number;
}

export const MACRO_FACE_PARAM_IDS = [
  'model', 'note', 'harmonics', 'timbre', 'morph', 'level',
] as const satisfies readonly (keyof MacroFaceParams)[];

/** Live values in, resolving the DEF DEFAULT for anything untouched.
 *  `node.params` is a SPARSE overlay of what has been touched, so reading it
 *  bare prints 0 for every dial nobody has moved yet. */
export function macroFaceParams(
  read: (paramId: string) => number | undefined,
): MacroFaceParams {
  const val = (id: string): number => {
    const v = read(id);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const pd = macrooscillatorDef.params.find((p) => p.id === id);
    if (!pd) throw new Error(`macrooscillator-face-model: no param '${id}'`);
    return pd.defaultValue;
  };
  return {
    model: val('model'),
    note: val('note'),
    harmonics: val('harmonics'),
    timbre: val('timbre'),
    morph: val('morph'),
    level: val('level'),
  };
}

/** The engine the current `model` value selects. */
export function macroEngine(p: MacroFaceParams): MacroEngine {
  return macroEngineAt(p.model);
}

// ── THE THREE AXIS READOUTS ─────────────────────────────────────────────────
//
// One shared formatter over `MacroAxis`, because the interesting variation is
// in the DATA (the roster) and not in the code. Each returns a string that must
// stay under ~26 characters: the dock sidebar's content column is 258 px, and
// longer values pushed it 78 CSS px past the card's right edge (measured).

/** Format one axis of one engine at the live fader value. */
export function macroAxisText(axis: MacroEngine['harmonics'], v: number): string {
  const s = axis.shape;
  switch (s.kind) {
    case 'continuous':
      return axis.noun;
    case 'stepped': {
      const i = macroBucket(v, s.steps);
      const name = s.labels?.[i];
      return name
        ? `${name} · ${i + 1}/${s.steps}`
        : `${axis.noun} ${i + 1}/${s.steps}`;
    }
    case 'blend': {
      // A genuine interpolation across N frames — say WHERE between them,
      // because that is the fact a bucket index would destroy.
      const c = Math.max(0, Math.min(1, v || 0));
      const f = c * (s.frames - 1);
      const lo = Math.floor(f);
      const pct = Math.round((f - lo) * 100);
      return lo >= s.frames - 1
        ? `${axis.noun} ${s.frames}/${s.frames}`
        : `${axis.noun} ${lo + 1}→${lo + 2} ${pct}%`;
    }
    case 'inertBelow': {
      const c = Math.max(0, Math.min(1, v || 0));
      // ⚠ THE HONEST SENTENCE. Below the threshold the control is BIT-EXACTLY
      // dead; a percentage here would imply travel that does not exist.
      if (c <= s.threshold) return `${axis.noun} — DEAD ≤${Math.round(s.threshold * 100)}%`;
      const span = (c - s.threshold) / (1 - s.threshold);
      return `${axis.noun} ${Math.round(span * 100)}%`;
    }
    case 'inverted':
      // Print the value AND the direction, because the direction is the
      // surprise. MODAL's TIMBRE is Q 5..200 and raising it loses 17 dB.
      return `${axis.noun} ↑ = quieter`;
  }
}

/** HARMONICS, interpreted for the live engine. */
export function macroHarmonicsText(p: MacroFaceParams): string {
  return macroAxisText(macroEngine(p).harmonics, p.harmonics);
}
/** TIMBRE, interpreted for the live engine. */
export function macroTimbreText(p: MacroFaceParams): string {
  return macroAxisText(macroEngine(p).timbre, p.timbre);
}
/** MORPH, interpreted for the live engine. */
export function macroMorphText(p: MacroFaceParams): string {
  return macroAxisText(macroEngine(p).morph, p.morph);
}

/** What AUX carries in the live engine. A sibling rendering of the same note —
 *  NOT the right half of a stereo pair, which is the thing people assume. */
export function macroAuxText(p: MacroFaceParams): string {
  return macroEngine(p).aux;
}

// ── LEVEL — the 76.6 dB the MODEL fader silently moves ──────────────────────

/** The def's LEVEL default, the condition the roster's `outRmsDb` was measured
 *  at. Anything else is a pure `20·log10(level/this)` offset. */
export const MACRO_MEASURED_LEVEL = 0.8;

/** OUT RMS in dBFS at the LIVE level: the engine's measured figure, translated
 *  by the level scalar (`out = engine · level`, worklet :1556-1557).
 *
 *  ⚠ NEGATIVE CONTROL — MOVE `model`, TOUCH NOTHING ELSE. A `paramId: 'level'`
 *  readout prints `0.80` in all fourteen states while the actual output moves
 *  by up to 76.6 dB (FM 2OP −5.0 dBFS vs MODAL −81.6). SECOND LEG: move
 *  `level` and this must move by exactly `20·log10(new/old)` on EVERY engine —
 *  the same dB, because the level scalar is engine-independent. */
export function macroOutLevelDb(p: MacroFaceParams): number {
  const lvl = Math.max(0, Math.min(1, p.level));
  if (lvl <= 0) return -Infinity;
  return macroEngine(p).outRmsDb + 20 * Math.log10(lvl / MACRO_MEASURED_LEVEL);
}

/** The loudest engine's measured OUT RMS — the reference the spread is against. */
export const MACRO_LOUDEST_DB = Math.max(...MACRO_ENGINES.map((e) => e.outRmsDb));
/** The full spread, in dB. 76.6 as measured. */
export const MACRO_LEVEL_SPREAD_DB = MACRO_LOUDEST_DB - Math.min(...MACRO_ENGINES.map((e) => e.outRmsDb));

/** How far below the LOUDEST engine this one sits, at identical macros.
 *
 *  ⚠ INVARIANT TO `level` BY CONSTRUCTION, and that is the point: LEVEL cannot
 *  fix this, because it moves both sides equally. Only `model` moves it. */
export function macroLevelVsLoudestDb(p: MacroFaceParams): number {
  return macroEngine(p).outRmsDb - MACRO_LOUDEST_DB;
}

/** AUX minus OUT, in dB, at the live LEVEL.
 *
 *  ⚠ AUX IS NOT LEVEL-SCALED (worklet :1557-1560) — a Plaits convention the
 *  def documents and nothing on screen ever showed. Measured at LEVEL 0: OUT
 *  peak is 0.0000 on all fourteen engines while AUX peak is 1.0000 on eight of
 *  them. So the honest reading at LEVEL 0 is `+∞`, not `0.00`.
 *
 *  ⚠ NEGATIVE CONTROL — TURN `level` TO 0. A `paramId: 'level'` readout prints
 *  `0.00` and says nothing at all about an output still running at full scale;
 *  this returns +Infinity. SECOND LEG: move `model` with LEVEL untouched and
 *  it must ALSO move (the per-engine AUX/OUT ratio is not constant — GRANULAR
 *  is +11.9 dB, STRING +1.9). */
export function macroAuxOffsetDb(p: MacroFaceParams): number {
  const e = macroEngine(p);
  const lvl = Math.max(0, Math.min(1, p.level));
  if (lvl <= 0) return Infinity;
  return e.auxRmsDb - (e.outRmsDb + 20 * Math.log10(lvl / MACRO_MEASURED_LEVEL));
}

// ── THE TWO ENGINE-CLASS READOUTS ───────────────────────────────────────────

/** Band-limiting, from `model` alone.
 *
 *  ⚠ NEGATIVE CONTROL — MOVE `note` +36 st. The AUDIBLE aliasing changes
 *  enormously and this must NOT move, because band-limiting is a property of
 *  the ENGINE, not of the pitch. Move `model` 0 → 1 and it must flip. */
export function macroAliasText(p: MacroFaceParams): string {
  return macroEngine(p).bandLimited ? 'polyBLEP saw + square' : 'naive — aliases';
}

/** Whether the live engine makes any sound at all with nothing patched into
 *  TRIG. Five of fourteen do not, and that is the module's second personality:
 *  STRING / KICK / SNARE / HIHAT initialise their excitation to 0 and are
 *  silent forever; FM 6OP decays to −108 dBFS in one second and never
 *  restarts. The STRIKE audition exists so those five are reachable without a
 *  cable.
 *
 *  ⚠ NEGATIVE CONTROL — move any MACRO and this must NOT move; move `model`
 *  0 → 8 and it must flip. */
export function macroStrikeText(p: MacroFaceParams): string {
  return macroEngine(p).needsStrike ? 'needs a strike' : 'free-running';
}

/** How many of the fourteen are silent unpatched — a fixed fact, printed so
 *  the STRIKE button has a stated reason to exist. */
export const MACRO_STRUCK_COUNT = MACRO_ENGINES.filter((e) => e.needsStrike).length;

// ── THE HERO PICTURE ────────────────────────────────────────────────────────

/** Samples the hero renders AFTER any warm-up. 2048 at 48 kHz ≈ 43 ms ≈ 19
 *  cycles at C4 — enough to read a waveform, cheap enough to recompute on a
 *  knob change (measured 4.7 ms for the full 14-engine tick). */
export const MACRO_HERO_WINDOW = 2048;

/** Samples DISCARDED before the window, per engine.
 *
 *  ⚠ IT IS NON-ZERO FOR EXACTLY ONE ENGINE, AND THAT IS A FINDING, NOT A
 *  TUNING KNOB. MODAL's exciter is a fixed 4 Hz impulse train, so its first
 *  non-zero sample is #11999 — 250.0 ms, measured — and a 43 ms window drawn
 *  from t=0 would show a FLAT LINE and teach that MODAL is broken rather than
 *  slow. The warm-up is PRINTED in the panel caption for the same reason the
 *  gain is: a picture that silently skips a quarter of a second is lying by
 *  omission. */
export function macroHeroWarmup(e: MacroEngine, sampleRate: number): number {
  if (e.name !== 'MODAL') return 0;
  // One full impulse period of the 4 Hz exciter, so the window opens ON the
  // strike rather than just before the next one.
  return Math.round(sampleRate * 0.25);
}

export interface MacroHeroTrace {
  /** Per-column [min, max] of OUT, in the SHARED normalised space. */
  out: readonly (readonly [number, number])[];
  /** Per-column [min, max] of AUX, same space — so the two traces are directly
   *  comparable in HEIGHT, which is how the OUT/AUX imbalance becomes visible. */
  aux: readonly (readonly [number, number])[];
  /** The multiplier applied to fit the taller of the two into ±1. PRINTED. */
  gain: number;
  /** True peak before the gain (max of |out|, |aux|). */
  peak: number;
  /** Discarded lead-in, in ms. PRINTED when non-zero. */
  warmupMs: number;
  /** The window's own length in ms. */
  windowMs: number;
}

/**
 * The hero picture: OUT and AUX over one short window of the LIVE engine at the
 * LIVE macros, decimated to `columns` min/max pairs.
 *
 * ⚠ ONE SHARED GAIN FOR BOTH TRACES. Normalising them separately would make
 * every engine look identical and would DESTROY the single most useful thing
 * this picture says — that AUX is routinely far louder than OUT and is never
 * touched by LEVEL. At the defaults, OUT peaks at 0.64 and AUX at 1.00 on VA;
 * at LEVEL 0, OUT is a flat line and AUX is unchanged at full scale.
 *
 * ⚠ THE GAIN IS RETURNED SO THE CAPTION CAN PRINT IT. MODAL peaks at 0.0028, so
 * an un-gained draw is a flat line — indistinguishable from silence, and from
 * the WAVETABLE-morph kind of dead control this face exists to expose. `×357`
 * beside the trace is the difference between "quiet" and "broken".
 */
export function macroHeroTrace(
  p: MacroFaceParams,
  sampleRate: number,
  columns: number,
): MacroHeroTrace {
  const e = macroEngine(p);
  const warmup = macroHeroWarmup(e, sampleRate);
  const n = warmup + MACRO_HERO_WINDOW;
  // pitchV 0 = C4; the hero draws what the KNOBS imply, so the `pitch` jack is
  // deliberately not in the picture (a face readout cannot see it either).
  const { main, aux } = macrooscillatorMath.render(n, sampleRate, 0, {
    model: p.model,
    note: p.note,
    harmonics: p.harmonics,
    timbre: p.timbre,
    morph: p.morph,
    level: p.level,
  });

  let peak = 0;
  for (let i = warmup; i < n; i++) {
    const a = Math.abs(main[i]!);
    const b = Math.abs(aux[i]!);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  const gain = peak > 1e-9 ? 1 / peak : 1;

  const cols = Math.max(1, Math.floor(columns));
  const per = MACRO_HERO_WINDOW / cols;
  const out: [number, number][] = [];
  const auxCols: [number, number][] = [];
  for (let c = 0; c < cols; c++) {
    const a0 = warmup + Math.floor(c * per);
    const a1 = Math.max(a0 + 1, warmup + Math.floor((c + 1) * per));
    let oLo = Infinity, oHi = -Infinity, xLo = Infinity, xHi = -Infinity;
    for (let i = a0; i < a1 && i < n; i++) {
      const o = main[i]! * gain;
      const x = aux[i]! * gain;
      if (o < oLo) oLo = o;
      if (o > oHi) oHi = o;
      if (x < xLo) xLo = x;
      if (x > xHi) xHi = x;
    }
    out.push([Number.isFinite(oLo) ? oLo : 0, Number.isFinite(oHi) ? oHi : 0]);
    auxCols.push([Number.isFinite(xLo) ? xLo : 0, Number.isFinite(xHi) ? xHi : 0]);
  }

  return {
    out,
    aux: auxCols,
    gain,
    peak,
    warmupMs: (warmup / sampleRate) * 1000,
    windowMs: (MACRO_HERO_WINDOW / sampleRate) * 1000,
  };
}

// ── FORMATTERS ──────────────────────────────────────────────────────────────

/** dBFS with the infinities spelled out, because both ends are REACHABLE here
 *  (LEVEL 0 silences OUT completely) and `-Infinity dBFS` is not a readout. */
export function fmtMacroDb(v: number): string {
  if (v === -Infinity) return 'silent';
  if (v === Infinity) return 'OUT is silent';
  if (!Number.isFinite(v)) return `${v}`;
  const s = v.toFixed(1);
  return v > 0 ? `+${s} dB` : `${s} dB`;
}

/** dBFS as an absolute level (no leading `+`). */
export function fmtMacroDbfs(v: number): string {
  if (v === -Infinity) return 'silent';
  if (!Number.isFinite(v)) return `${v}`;
  return `${v.toFixed(1)} dBFS`;
}

/** The hero's gain caption — `×1` is stated rather than hidden, so the absence
 *  of a multiplier is as legible as its presence. */
export function fmtMacroGain(gain: number): string {
  if (!Number.isFinite(gain) || gain <= 0) return '×1';
  if (gain >= 100) return `×${Math.round(gain)}`;
  if (gain >= 10) return `×${gain.toFixed(0)}`;
  return `×${gain.toFixed(1)}`;
}
