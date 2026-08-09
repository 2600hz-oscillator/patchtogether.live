// packages/web/src/lib/audio/modules/macro-engine-roster.ts
//
// THE FOURTEEN ENGINES, IN ONE PLACE — the roster macrooscillator's def, its
// card, MACSEQ and the faceplate all read.
//
// ⚠ IT EXISTS BECAUSE "14" WAS ENCODED IN FOUR PLACES AND THE NAMES IN TWO.
// Before this file: `MACRO_MAX_MODEL = 13` in the def, a private `MODEL_NAMES`
// array in `MacrooscillatorCard.svelte`, a BYTE-IDENTICAL second copy in
// `macseq.ts` (whose own comment admitted it was "duplicated from
// MacrooscillatorCard.svelte's local copy rather than imported"), and the
// worklet's hard-coded `maxValue: 13`. Three of those four now derive from
// this array; the fourth lives in another package (`packages/dsp`) and cannot
// import from `$lib`, so it stays a literal and `macro-engine-roster.test.ts`
// greps it.
//
// ⚠ WHY A SEPARATE FILE RATHER THAN AN EXPORT ON THE DEF. The faceplate model
// needs the roster AND the def's pure-math mirror; the def needs the roster for
// `ParamDef.options`. Exporting it from the def would make that a cycle. This
// module imports NOTHING, which is also what lets the roster be the thing the
// tests anchor against rather than a projection of one consumer.
//
// ── WHAT EACH ROW CARRIES, AND WHY IT IS NOT ALL "NAMES" ────────────────────
//
// The macro scheme's central problem is that HARMONICS / TIMBRE / MORPH mean
// something DIFFERENT in each of the fourteen engines, and nothing in the UI
// has ever said which. Worse, in several engines a control that presents as a
// continuous fader is a stepped selector, an inert half-fader, or a level
// control running backwards. A faceplate that paints three anonymous dials over
// that is not neutral — it actively asserts a uniformity the DSP does not have.
//
// So every row declares, per axis, WHAT the axis does here and WHAT SHAPE it
// has. The shapes are not opinions:
//
//   'continuous'  — a genuine fader (41/41 distinct renders over a 0..1 sweep).
//   'stepped'     — N discrete buckets and nothing in between.
//   'blend'       — continuous, but interpolating between N named frames.
//   'inertBelow'  — DEAD from 0 up to a threshold, live above it. A DEFECT,
//                   surfaced rather than hidden (see WAVETABLE morph).
//   'inverted'    — moving it UP makes the engine QUIETER. Also a defect.
//
// EVERY ONE OF THOSE CLAIMS IS RE-DERIVED FROM `macrooscillatorMath` IN
// `macrooscillator-face-model.test.ts`, per engine, per axis. The table is the
// FACE's claim; the mirror is the ARTIFACT; the test is what stops them
// drifting. Concretely: the day someone fixes WAVETABLE's dead morph half, this
// file's `inertBelow: 0.5` stops being true and the face test goes RED —
// because a faceplate that keeps telling you a control is dead after it has
// been fixed is the same defect pointed the other way.

/** The SHAPE of one macro axis inside one engine. See the header. */
export type MacroAxisShape =
  /** A genuine continuous fader. */
  | { kind: 'continuous' }
  /** N discrete buckets, selected by `floor(v * N)` (clamped at the top). */
  | { kind: 'stepped'; steps: number; labels?: readonly string[] }
  /** Continuous, interpolating across N named frames. */
  | { kind: 'blend'; frames: number }
  /** Bit-exactly DEAD from 0 to `threshold` INCLUSIVE, live above. A defect. */
  | { kind: 'inertBelow'; threshold: number }
  /** Live, but raising it LOWERS the output level. A defect. */
  | { kind: 'inverted' };

export interface MacroAxis {
  /** What this axis DOES in this engine — the noun the faceplate prints. */
  noun: string;
  shape: MacroAxisShape;
}

export interface MacroEngine {
  /** The `model` param value that selects this engine. NEVER renumber — a
   *  saved rack is a bare `Record<string, number>` with no migration
   *  substrate, so a renumber silently repatches every rack to a different
   *  engine and nothing can detect it. New engines APPEND at 14+. */
  index: number;
  /** The name shown everywhere: the MODEL selector, MACSEQ, the card. */
  name: string;
  harmonics: MacroAxis;
  timbre: MacroAxis;
  morph: MacroAxis;
  /** What the AUX output carries for this engine — a sibling rendering of the
   *  same note, NOT a second channel and NOT scaled by LEVEL. */
  aux: string;
  /** TRUE only where the engine band-limits its own waveform. Exactly one
   *  engine does (VA's polyBLEP'd saw + square); the other thirteen are naive. */
  bandLimited: boolean;
  /** TRUE where the engine is SILENT (or has decayed to silence) with nothing
   *  patched into TRIG — the module's second personality. */
  needsStrike: boolean;
  /** MEASURED OUT RMS in dBFS at the def's default macros and LEVEL 0.8, over
   *  a 500 ms window at 48 kHz / pitch 0.75 V. MEASUREMENT, NOT LAW — and the
   *  face test re-derives every one of these from `macrooscillatorMath` so a
   *  DSP level change cannot leave the faceplate quoting a stale number. */
  outRmsDb: number;
  /** MEASURED AUX RMS in dBFS, same conditions. AUX is NOT level-scaled. */
  auxRmsDb: number;
}

const FM2_RATIO_LABELS = ['1:1', '1:2', '2:1', '1:3', '3:1', '1:4', '2:3', '3:2'] as const;
const CHORD_SHAPE_LABELS = ['oct', '5th', 'min', 'maj', 'sus2', 'sus4', 'dom7', 'dim7'] as const;
const MODAL_PRESET_LABELS = ['bar', 'vibes', 'bell', 'marimba'] as const;
const VOWEL_LABELS = ['ah', 'eh', 'ee', 'oh', 'oo', 'uh'] as const;

/**
 * The fourteen engines, in `model` order. Index === `model` value.
 *
 * ⚠ ONLY GROWS, AND ONLY AT THE END. See `MacroEngine.index`.
 */
export const MACRO_ENGINES: readonly MacroEngine[] = [
  {
    index: 0,
    name: 'VA',
    harmonics: { noun: 'detune', shape: { kind: 'continuous' } },
    timbre: { noun: 'wavefold drive', shape: { kind: 'continuous' } },
    morph: { noun: 'saw → sq → tri', shape: { kind: 'continuous' } },
    aux: 'sub-octave triangle',
    // The ONLY band-limited engine in the module: polyBLEP on the saw and the
    // square (packages/dsp/src/macrooscillator.ts:154-164, used by VA alone).
    bandLimited: true,
    needsStrike: false,
    outRmsDb: -9.9,
    auxRmsDb: -4.8,
  },
  {
    index: 1,
    name: 'WAVESHAPE',
    harmonics: { noun: 'sub mix', shape: { kind: 'continuous' } },
    timbre: { noun: 'drive', shape: { kind: 'continuous' } },
    morph: { noun: 'fold ↔ tanh', shape: { kind: 'continuous' } },
    aux: 'pre-drive body',
    bandLimited: false,
    needsStrike: false,
    outRmsDb: -13.0,
    auxRmsDb: -4.5,
  },
  {
    index: 2,
    name: 'FM 2OP',
    // 8 ratio buckets by `floor(h * 8)` — a SWITCH wearing a fader's clothes.
    harmonics: { noun: 'c:m ratio', shape: { kind: 'stepped', steps: 8, labels: FM2_RATIO_LABELS } },
    timbre: { noun: 'mod index', shape: { kind: 'continuous' } },
    morph: { noun: 'feedback', shape: { kind: 'continuous' } },
    aux: 'clean carrier',
    bandLimited: false,
    needsStrike: false,
    outRmsDb: -5.0,
    auxRmsDb: -3.0,
  },
  {
    index: 3,
    name: 'FM 6OP',
    harmonics: { noun: 'ratio spread', shape: { kind: 'continuous' } },
    timbre: { noun: 'mod index', shape: { kind: 'continuous' } },
    morph: { noun: 'op decay', shape: { kind: 'continuous' } },
    aux: 'clean carrier',
    bandLimited: false,
    // Envelopes decay UNCONDITIONALLY and never restart: measured RMS by 0.5 s
    // window at morph 0 is 1.10e-1 → 5.02e-6 → 2.28e-10 → 1.04e-14. Even at
    // morph 1 it is a 5 s decay. So switching TO this engine lands on a fully
    // decayed voice unless something strikes it.
    needsStrike: true,
    outRmsDb: -11.7,
    auxRmsDb: -3.0,
  },
  {
    index: 4,
    name: 'CHORD',
    harmonics: { noun: 'chord shape', shape: { kind: 'stepped', steps: 8, labels: CHORD_SHAPE_LABELS } },
    timbre: { noun: 'sine → saw', shape: { kind: 'continuous' } },
    morph: { noun: 'voice spread', shape: { kind: 'continuous' } },
    aux: 'root sine',
    bandLimited: false,
    needsStrike: false,
    outRmsDb: -17.8,
    auxRmsDb: -3.0,
  },
  {
    index: 5,
    name: 'ADDITIVE',
    harmonics: { noun: 'stretch', shape: { kind: 'continuous' } },
    timbre: { noun: 'spectral tilt', shape: { kind: 'continuous' } },
    morph: { noun: 'odd ↔ even', shape: { kind: 'continuous' } },
    aux: 'fundamental partial',
    bandLimited: false,
    needsStrike: false,
    outRmsDb: -14.7,
    auxRmsDb: -3.0,
  },
  {
    index: 6,
    name: 'STRING',
    harmonics: { noun: 'stiffness', shape: { kind: 'continuous' } },
    timbre: { noun: 'exciter tone', shape: { kind: 'continuous' } },
    morph: { noun: 'damping', shape: { kind: 'continuous' } },
    aux: 'raw delay tap',
    bandLimited: false,
    // Excitation initialises to 0 in the worklet — silent FOREVER until a TRIG
    // rising edge arrives. (The def's pure-math mirror calls `reset()` up
    // front, which is why every unit test measures a struck voice the worklet
    // never produces at t = 0.)
    needsStrike: true,
    outRmsDb: -29.1,
    auxRmsDb: -27.2,
  },
  {
    index: 7,
    name: 'MODAL',
    harmonics: { noun: 'preset', shape: { kind: 'stepped', steps: 4, labels: MODAL_PRESET_LABELS } },
    // ⚠ THE DEFECT. TIMBRE is resonance Q (5..200), and an RBJ constant-skirt
    // band-pass's impulse response scales with `alpha = sin(w0)/2Q` — so
    // raising Q makes MODAL QUIETER, not brighter. Measured −69.6 dBFS at Q 5
    // against −86.6 dBFS at Q 200. The worklet's own comment at :847-851 says
    // the opposite.
    timbre: { noun: 'resonance Q', shape: { kind: 'inverted' } },
    morph: { noun: 'mode balance', shape: { kind: 'continuous' } },
    aux: 'fundamental mode',
    bandLimited: false,
    needsStrike: false,
    // The quietest engine by 52 dB — and its first non-zero sample lands at
    // 11999 (250.0 ms), because the exciter is a fixed 4 Hz impulse train.
    outRmsDb: -81.6,
    auxRmsDb: -89.3,
  },
  {
    index: 8,
    name: 'KICK',
    harmonics: { noun: 'sweep range', shape: { kind: 'continuous' } },
    timbre: { noun: 'click', shape: { kind: 'continuous' } },
    morph: { noun: 'body decay', shape: { kind: 'continuous' } },
    aux: 'body (swept, w/o click)',
    bandLimited: false,
    needsStrike: true,
    outRmsDb: -7.5,
    auxRmsDb: -5.5,
  },
  {
    index: 9,
    name: 'SNARE',
    harmonics: { noun: 'tone ↔ noise', shape: { kind: 'continuous' } },
    timbre: { noun: 'noise hi-pass', shape: { kind: 'continuous' } },
    morph: { noun: 'body decay', shape: { kind: 'continuous' } },
    aux: 'body sines',
    bandLimited: false,
    needsStrike: true,
    outRmsDb: -15.1,
    auxRmsDb: -10.9,
  },
  {
    index: 10,
    name: 'HIHAT',
    harmonics: { noun: 'band centre', shape: { kind: 'continuous' } },
    timbre: { noun: 'metal ↔ noise', shape: { kind: 'continuous' } },
    morph: { noun: 'decay', shape: { kind: 'continuous' } },
    aux: 'raw metallic cluster',
    bandLimited: false,
    needsStrike: true,
    outRmsDb: -23.1,
    auxRmsDb: -13.6,
  },
  {
    index: 11,
    name: 'WAVETABLE',
    // NOT a quantiser — 41/41 distinct renders over a 0..1 sweep. The 8 frames
    // are BLENDED by `h * 7`. (The batch-3 spec's "HARMONICS is a quantiser in
    // five engines" counted this one; measurement says four.)
    harmonics: { noun: 'frame', shape: { kind: 'blend', frames: 8 } },
    timbre: { noun: 'low-pass', shape: { kind: 'continuous' } },
    // ⚠ THE DEFECT. `packages/dsp/src/macrooscillator.ts:1160-1165` guards the
    // phase warp on `morph < 0.5`, so the bottom HALF of the fader is a
    // bit-exact no-op: maxAbsDiff vs morph 0 is 0.000e+0 at 0, 0.1, 0.25, 0.49
    // AND 0.5, first moving at 0.5001. (The comment at :1157-1159 also states
    // the wrong wrap point — it says 0.25.)
    morph: { noun: 'phase warp', shape: { kind: 'inertBelow', threshold: 0.5 } },
    aux: 'pre-filter waveform',
    bandLimited: false,
    needsStrike: false,
    outRmsDb: -9.7,
    auxRmsDb: -7.2,
  },
  {
    index: 12,
    name: 'GRANULAR',
    harmonics: { noun: 'spawn rate', shape: { kind: 'continuous' } },
    timbre: { noun: 'pitch jitter', shape: { kind: 'continuous' } },
    // ⚠ NOT A FADER AT ALL — three grain WINDOWS with hard boundaries at 0.33
    // and 0.66 and nothing in between (3/41 distinct renders over a sweep).
    // Nothing in the repo said so before this file.
    morph: { noun: 'grain window', shape: { kind: 'stepped', steps: 3, labels: ['tri', 'hann', 'expo'] } },
    // NOT the note: `sin(2π · spawnTimer/spawnEvery)`, a full-scale sine at the
    // grain-SPAWN rate — 0 Hz at harmonics 0, ~199 Hz at 1. On a port declared
    // `type: 'audio'` the bottom of that range is sub-audio.
    aux: 'spawn-rate sine (not the note)',
    bandLimited: false,
    needsStrike: false,
    outRmsDb: -14.9,
    auxRmsDb: -3.0,
  },
  {
    index: 13,
    name: 'SPEECH',
    harmonics: { noun: 'vowel', shape: { kind: 'stepped', steps: 6, labels: VOWEL_LABELS } },
    timbre: { noun: 'formant Q', shape: { kind: 'continuous' } },
    morph: { noun: 'voiced ↔ whisper', shape: { kind: 'continuous' } },
    aux: 'glottal pulse',
    bandLimited: false,
    needsStrike: false,
    outRmsDb: -20.8,
    auxRmsDb: -8.0,
  },
];

/** Maximum legal `model` index. DERIVED, so "how many engines are there" has
 *  exactly one answer. */
export const MACRO_MAX_MODEL = MACRO_ENGINES.length - 1;

/** Engine names in `model` order — the list MACSEQ and the card print. */
export const MODEL_NAMES: readonly string[] = MACRO_ENGINES.map((e) => e.name);

/** Resolve a raw `model` param value (possibly fractional, possibly out of
 *  range) to its engine, exactly as the worklet does:
 *  `Math.max(0, Math.min(13, Math.round(model)))`
 *  (packages/dsp/src/macrooscillator.ts:1514). Pure. */
export function macroEngineAt(model: number): MacroEngine {
  const i = Math.max(0, Math.min(MACRO_MAX_MODEL, Math.round(model || 0)));
  return MACRO_ENGINES[i]!;
}

/**
 * The bucket a STEPPED axis lands in, using the worklet's own `floor(v * N)`
 * with the clamp that makes the top bucket asymmetric.
 *
 * ⚠ THE OVERFLOW IS REAL AND IS REPORTED, NOT HIDDEN: `v = 1.0` overflows to
 * index N and clamps back to N−1, so the last bucket is reachable over
 * [(N−1)/N, 1.0] — 2× the width of every other bucket at N = 8. Printing the
 * bucket rather than the fader value is what makes that legible.
 */
export function macroBucket(v: number, steps: number): number {
  const c = Math.max(0, Math.min(1, v || 0));
  return Math.max(0, Math.min(steps - 1, Math.floor(c * steps)));
}
