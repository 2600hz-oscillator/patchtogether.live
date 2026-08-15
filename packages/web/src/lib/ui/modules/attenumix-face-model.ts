// packages/web/src/lib/ui/modules/attenumix-face-model.ts
//
// The PURE model behind the ATTENUMIX faceplate — the three derived readouts,
// and the arithmetic that makes them not-a-knob-relabelled.
//
// WHY A MODEL FOR A FIVE-KNOB MIXER. Because the five knobs cannot say the
// three things a player actually needs to know about this module, and each of
// the three is a JOIN over knobs no single readback can perform:
//
//   PEAK    the loudest sample the MIX bus can produce. It is `tanh(Σatt ·
//           master)`, so it needs all five values at once. At the shipped
//           defaults every attenuator is 0 and the answer is EXACTLY SILENCE
//           — while the MASTER dial reads a confident `1.00`, i.e. unity, on a
//           module whose output is bit-exactly zero. That single sentence is
//           the most useful thing this faceplate says, and no knob on it can
//           say anything of the kind.
//   DRIVE   how hard that sum hits the tanh, as a multiplier plus what the
//           tanh is charging for it in dB. MASTER's own readback is INVARIANT
//           to the channel count: it says `1.00×` whether one channel is open
//           (drive 1.0, −2.2 dB of squash) or four are (drive 4.0, −12.0 dB).
//   CV ROOM how much attenuator travel the four CV inputs can still reach.
//           This module's CV law is `att = clamp(knob + cv, 0, 1)`, so a knob
//           parked at 1.0 is CV-DEAF — the cable is patched, the jack lights,
//           the LFO runs, and the channel does not move. Nothing else on the
//           faceplate hints at that, and it is INVARIANT TO MASTER, which is
//           what makes it the third readout rather than a third view of the
//           first.
//
// ⚠ PEAK AND DRIVE ARE THE SAME SCALAR SEEN TWICE, ON PURPOSE — `peak =
// tanh(drive)` — and that is the pairing, not an oversight. The tanh is
// strictly monotone, so a PEAK that moves while DRIVE does not (or the
// reverse) is a broken model, and publishing both makes the instrument its own
// negative control. That is the `clap-q` / `clap-bandwidth-hz` precedent. They
// are also in different units and answer different questions: one is the
// number a meter would show, the other is how much headroom you spent to get
// it. CV ROOM is the genuinely orthogonal third — MASTER cannot move it at all.
//
// EVERY NUMBER HERE GOES THROUGH THE MODULE'S OWN MATH. The soft-clip is
// `attenumixMath.mixSample` and the per-channel clamp is
// `attenumixMath.channelAtt`, imported from the def rather than re-typed, so a
// DSP change turns these readouts wrong-in-the-same-direction instead of
// leaving the faceplate quietly insisting on the old law. (And that mirror is
// itself pinned against the SHIPPED worklet by
// `attenumix-cv-path.test.ts` + the ART profile.)
//
// PURE: no DOM, no engine, no store, no fs. Every function is a total function
// of the live params.

import { fmtDb } from '$lib/audio/modules/kickdrum-format';
import { attenumixDef, attenumixMath } from '$lib/audio/modules/attenumix';

// ── WHICH PARAMS, DERIVED FROM THE DEF ──────────────────────────────────────
//
// Read off the def rather than written down, so "how many channels" is never a
// literal anybody has to keep in step (CLAUDE.md: never hand-type a population
// count). A fifth channel would flow through every function below untouched.

/** The per-channel attenuator param ids, in declaration order. */
export const ATTENUMIX_ATT_PARAM_IDS: readonly string[] = attenumixDef.params
  .filter((p) => /^att\d+$/.test(p.id))
  .map((p) => p.id);

/** The mix-bus gain param id. */
export const ATTENUMIX_MASTER_PARAM_ID = 'master';

function spec(id: string): { min: number; max: number; defaultValue: number } {
  const p = attenumixDef.params.find((q) => q.id === id);
  if (!p) throw new Error(`attenumix-face-model: '${id}' is not a declared param`);
  return { min: p.min, max: p.max, defaultValue: p.defaultValue };
}

// ── THE LIVE PARAMS ─────────────────────────────────────────────────────────

export interface AttenumixFaceParams {
  /** The live attenuators, in `ATTENUMIX_ATT_PARAM_IDS` order. */
  att: readonly number[];
  /** The live mix-bus gain. */
  master: number;
}

/**
 * Read the face's params off a live reader.
 *
 * TOTAL, and every clause of it is load-bearing on a real render:
 *   * `node.params` is a SPARSE overlay of what has been TOUCHED, so an
 *     un-read param falls back to the DEF DEFAULT — reading it bare would
 *     print the wrong number on a fresh spawn, which on this module means
 *     printing a mix that is not muted when it is.
 *   * a non-finite value (a NaN mid-drag, an ±Infinity from a corrupt save)
 *     falls back to the default rather than propagating — this runs on every
 *     animation frame and a throw takes the faceplate down mid-drag.
 *   * a finite value is CLAMPED to the def's own range, because that is what
 *     the AudioParam does to it; a readout that believed an out-of-range save
 *     would print a peak the module cannot reach.
 */
export function attenumixFaceParams(
  read: (paramId: string) => number | undefined,
): AttenumixFaceParams {
  const one = (id: string): number => {
    const s = spec(id);
    const v = read(id);
    if (typeof v !== 'number' || !Number.isFinite(v)) return s.defaultValue;
    return Math.min(s.max, Math.max(s.min, v));
  };
  return {
    att: ATTENUMIX_ATT_PARAM_IDS.map(one),
    master: one(ATTENUMIX_MASTER_PARAM_ID),
  };
}

// ── THE DERIVED QUANTITIES ──────────────────────────────────────────────────

/**
 * The worst-case mix-bus SUM: every channel's attenuator, through the module's
 * own clamp, with full-scale (±1) audio patched into all of them.
 *
 * "Worst case" is the honest framing and the only one available: a
 * `FaceReadoutValue` sees ONLY params (`face-readout-values.ts`), so it cannot
 * know what is patched or how loud it is. What it CAN state exactly is the
 * ceiling the knobs impose, which is the number that decides whether the tanh
 * is in play.
 */
export function attenumixSumAtt(p: AttenumixFaceParams): number {
  return p.att.reduce((s, a) => s + attenumixMath.channelAtt(a, 0), 0);
}

/** The pre-tanh DRIVE: `Σatt · master`, a plain multiplier. */
export function attenumixDrive(p: AttenumixFaceParams): number {
  return attenumixSumAtt(p) * p.master;
}

/** The highest sample the MIX output can produce — through the module's own
 *  soft-clip, never a re-typed `Math.tanh`. */
export function attenumixPeak(p: AttenumixFaceParams): number {
  return attenumixMath.mixSample(attenumixSumAtt(p), p.master);
}

/** That peak in dBFS. `-Infinity` when the module is muted — the callers below
 *  say `muted` rather than printing it. */
export function attenumixPeakDb(p: AttenumixFaceParams): number {
  const peak = attenumixPeak(p);
  return peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY;
}

/**
 * What the tanh is CHARGING at the live drive, in dB: `20log₁₀(tanh(D)/D)`.
 *
 * Zero (not `-Infinity`) at D = 0: the limit of `tanh(D)/D` as D → 0 is 1, so
 * a muted module is not being squashed, it is being fed nothing. Getting this
 * clause wrong prints `-Infinity dB` on every freshly spawned ATTENUMIX.
 */
export function attenumixSquashDb(p: AttenumixFaceParams): number {
  const d = attenumixDrive(p);
  if (d <= 0) return 0;
  return 20 * Math.log10(attenumixPeak(p) / d);
}

/**
 * The fraction of the channel attenuators' travel that CV CAN STILL REACH:
 * `Σ(max − att) / Σ(max − min)`, i.e. 1 at the shipped defaults and 0 when
 * every knob is parked at unity.
 *
 * ⚠ THIS IS THE MODULE'S ONE NON-OBVIOUS LAW, and it is a property of the
 * CLAMP rather than of the cable: `att = clamp(knob + cv, 0, 1)`, so positive
 * CV into a channel already at 1.0 does nothing at all. INVARIANT TO MASTER by
 * construction, which is exactly why it is worth a slot beside two readouts
 * that both move with it.
 */
export function attenumixCvRoom(p: AttenumixFaceParams): number {
  let room = 0;
  let span = 0;
  ATTENUMIX_ATT_PARAM_IDS.forEach((id, i) => {
    const s = spec(id);
    room += Math.max(0, s.max - (p.att[i] ?? s.defaultValue));
    span += s.max - s.min;
  });
  return span > 0 ? room / span : 0;
}

// ── WHAT THE FACEPLATE PRINTS ───────────────────────────────────────────────

/** `muted` · `-0.3 dB` — the mix bus's ceiling. */
export function attenumixPeakText(p: AttenumixFaceParams): string {
  const db = attenumixPeakDb(p);
  return Number.isFinite(db) ? fmtDb(db) : 'muted';
}

/** `2.00x · -6.3 dB` — the drive into the soft-clip and what it costs. */
export function attenumixDriveText(p: AttenumixFaceParams): string {
  return `${attenumixDrive(p).toFixed(2)}x · ${fmtDb(attenumixSquashDb(p))}`;
}

/** `100 %` · `deaf` — how much of the attenuator travel CV can still reach. */
export function attenumixCvRoomText(p: AttenumixFaceParams): string {
  const room = attenumixCvRoom(p);
  return room <= 0 ? 'deaf' : `${Math.round(room * 100)} %`;
}
