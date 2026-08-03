// packages/web/src/lib/ui/modules/drummergirl-face-model.ts
//
// THE PURE MODEL BEHIND DRUMMERGIRL's FACEPLATE — and the whole point of the
// face: UNBUNDLE `shape`.
//
// drummergirl is not a drum machine. It is ONE sine, ONE noise source, ONE
// amplitude ADSR and ONE pitch ADSR. Four of its five knobs do one thing each.
// The fifth, SHAPE, indexes FIVE 16-entry tables through a linear crossfade
// between two neighbouring presets, so ONE fader moves FIVE independent
// quantities at once: the amp envelope's attack, sustain and release, plus the
// pitch sweep's DEPTH *and* its DURATION. No surface in the rack says so.
//
// AND THE HEADLINE: AT THE SHIPPED DEFAULT THE PITCH SWEEP IS ZERO. shape 0.30
// → shapeIdx 4.5 → seg 4 / seg2 5 / frac 0.5, and `sweepAt` is 0.0 at BOTH 4
// and 5. Index 6 is 0.0 too — the default sits in the MIDDLE of a three-wide
// dead zone, so nudging the fader either way does not wake the sweep up.
//
// ⚠ THE FIVE TABLES ARE RE-TYPED, and that is a real drift risk stated rather
// than hidden. drummergirl's DSP is FAUST (packages/dsp/src/drummergirl.dsp),
// so — unlike kickdrum, whose model IMPORTS its worklet's TS laws — there is
// nothing to import. drummergirl also has NO ART baseline (it is on
// ART_BACKLOG), so there is no downstream audio pin that would notice either.
// `drummergirl-face-model.test.ts` parses the tables out of the .dsp SOURCE and
// fails on any disagreement; that grep is the ONLY guard, which is why it also
// asserts sixteen values parsed per table (a regex that silently matches
// nothing would otherwise pass green).
//
// PURE — no DOM, no Svelte, no engine. Node-testable.

import { drummergirlDef } from '$lib/audio/modules/drummergirl';

import { fmtDb } from '$lib/audio/modules/kickdrum-format';

export {
  fmtDb,
  fmtHz,
  fmtMs,
  fmtSemitones,
} from '$lib/audio/modules/kickdrum-format';

// ── the five preset tables (drummergirl.dsp:26-45), verbatim ────────────────
export const ATTACK_AT: readonly number[] = [
  0.0, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.005,
  0.005, 0.005, 0.005, 0.001, 0.001, 0.001, 0.001, 0.001,
];
export const DECAY_AT: readonly number[] = [
  0.4, 0.25, 0.18, 0.15, 0.05, 0.07, 0.4, 0.25,
  0.2, 0.18, 0.12, 0.08, 0.05, 0.3, 0.45, 0.5,
];
export const SUSTAIN_AT: readonly number[] = [
  0.0, 0.05, 0.08, 0.1, 0.0, 0.02, 0.0, 0.05,
  0.0, 0.0, 0.0, 0.5, 0.4, 0.0, 0.0, 0.0,
];
export const RELEASE_AT: readonly number[] = [
  0.1, 0.1, 0.12, 0.1, 0.02, 0.05, 0.1, 0.12,
  0.15, 0.18, 0.15, 0.2, 0.18, 0.4, 0.5, 0.6,
];
export const SWEEP_AT: readonly number[] = [
  1.0, 0.85, 0.6, 0.5, 0.0, 0.0, 0.0, 0.7,
  0.8, 0.6, 0.4, 0.0, 0.0, 0.0, 0.0, 0.0,
];

/** C2 — the base frequency the PITCH knob transposes (drummergirl.dsp:60). */
export const DRUMMERGIRL_C2_HZ = 65.406;

/** The crossfade position: which two presets, and how far between them
 *  (drummergirl.dsp:48-51). */
export function shapeSeg(shape: number): {
  idx: number;
  seg: number;
  seg2: number;
  frac: number;
} {
  const idx = Math.max(0, Math.min(15, (Number.isFinite(shape) ? shape : 0) * 15));
  const seg = Math.floor(idx);
  return { idx, seg, seg2: Math.min(15, seg + 1), frac: idx - seg };
}

/** The linear crossfade the .dsp applies to every one of the five tables
 *  (drummergirl.dsp:53-57). */
export function lerpAt(table: readonly number[], shape: number): number {
  const { seg, seg2, frac } = shapeSeg(shape);
  return (table[seg] ?? 0) * (1 - frac) + (table[seg2] ?? 0) * frac;
}

export const attackOf = (s: number): number => lerpAt(ATTACK_AT, s);
export const decayOf = (s: number): number => lerpAt(DECAY_AT, s);
export const sustainOf = (s: number): number => lerpAt(SUSTAIN_AT, s);
export const releaseOf = (s: number): number => lerpAt(RELEASE_AT, s);
export const sweepOf = (s: number): number => lerpAt(SWEEP_AT, s);

export interface DrummergirlParams {
  pitch: number;
  tone: number;
  shape: number;
  volume: number;
  decay: number;
}

export const DRUMMERGIRL_PARAM_IDS = [
  'pitch', 'tone', 'shape', 'volume', 'decay',
] as const satisfies readonly (keyof DrummergirlParams)[];

/** Live values in, def defaults for anything untouched. */
export function drummergirlParams(
  read: (paramId: string) => number | undefined,
): DrummergirlParams {
  const val = (id: string): number => {
    const v = read(id);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const pd = drummergirlDef.params.find((p) => p.id === id);
    if (!pd) throw new Error(`drummergirl-face-model: drummergirl has no param '${id}'`);
    return pd.defaultValue;
  };
  return {
    pitch: val('pitch'),
    tone: val('tone'),
    shape: val('shape'),
    volume: val('volume'),
    decay: val('decay'),
  };
}

/** The pitch sweep's DEPTH in semitones — `pitchEnv * 4 octaves`
 *  (drummergirl.dsp:69 + :71). ZERO at the shipped default. */
export function drummergirlSweepSemitones(p: DrummergirlParams): number {
  return 48 * sweepOf(p.shape);
}

/**
 * The pitch sweep's DURATION, ms.
 *
 * ⚠ `decayOf(shape)`, NOT the DECAY knob — drummergirl.dsp:69 contains no
 * `decayKnob` at all, and :78 is the only place the knob appears. That
 * disjointness is the face's central negative control: turning DECAY moves the
 * amp envelope and NOT the sweep, in either depth or duration.
 */
export function drummergirlSweepMs(p: DrummergirlParams): number {
  return 1000 * Math.max(0.005, decayOf(p.shape));
}

/** The pitch the hit SETTLES on — the PITCH knob alone (drummergirl.dsp:60). */
export function drummergirlBodyHz(p: DrummergirlParams): number {
  return DRUMMERGIRL_C2_HZ * Math.pow(2, p.pitch / 12);
}

/** The pitch the hit STARTS at — the body times the sweep. A
 *  `paramId: 'pitch'` readout is blind to this by construction. */
export function drummergirlStartHz(p: DrummergirlParams): number {
  return drummergirlBodyHz(p) * Math.pow(2, 4 * sweepOf(p.shape));
}

export const drummergirlAttackMs = (p: DrummergirlParams): number => 1000 * attackOf(p.shape);
export const drummergirlReleaseMs = (p: DrummergirlParams): number => 1000 * releaseOf(p.shape);
export const drummergirlSustain = (p: DrummergirlParams): number => sustainOf(p.shape);

/** Where SHAPE currently sits: on a preset, or between two of them. `shape` is
 *  a CONTINUOUS fader over a 16-entry table, so landing exactly on a preset by
 *  hand is impossible and every hand-set value is a crossfade. */
export function drummergirlShapeIndexText(p: DrummergirlParams): string {
  const { idx, seg, seg2, frac } = shapeSeg(p.shape);
  if (frac < 5e-4) return `${seg}`;
  return `${idx.toFixed(1)} · ${seg}→${seg2}`;
}

/** The sustain level in dB — `−∞` at the many presets whose sustain is 0. */
export function drummergirlSustainText(p: DrummergirlParams): string {
  const s = drummergirlSustain(p);
  if (!(s > 0)) return '−∞ dB';
  return fmtDb(20 * Math.log10(s));
}

/**
 * How long the HIT lasts.
 *
 * ⚠ A TOTAL FUNCTION THAT REFUSES TO GUESS. With a non-trivial SUSTAIN the
 * envelope HOLDS while the gate is high, so "how long is the hit" has no
 * numeric answer without a gate-length assumption this face does not have.
 * Rather than print a number under a hidden assumption, it says the fact.
 * (The 0.05 threshold — −26 dB — is a DESIGNED constant, not a derived one:
 * it is where a held sustain becomes clearly audible. Stated, and pinned.)
 */
export const DRUMMERGIRL_SUSTAINS_ABOVE = 0.05;

export function drummergirlHitText(p: DrummergirlParams): string {
  if (drummergirlSustain(p) > DRUMMERGIRL_SUSTAINS_ABOVE) return 'sustains';
  const ms = 1000 * (attackOf(p.shape) + p.decay + releaseOf(p.shape));
  return `${Math.round(ms)} ms`;
}

/** A preset row's annotation — DERIVED DATA, not prose. The face's 16 preset
 *  `note` strings are pinned against this in the model test, so they cannot go
 *  stale against the tables. */
export function drummergirlPresetNote(i: number): string {
  return `${Math.round(48 * (SWEEP_AT[i] ?? 0))} st · ${Math.round(1000 * (RELEASE_AT[i] ?? 0))} ms`;
}
