// packages/dsp/src/lib/poly-osc-sum.ts
//
// Pure per-lane ENVELOPE + SUM + NORMALIZATION math shared by CUBE and WAVECEL's
// polyphonic hot loops (the per-voice-ADSR feature). Factored out of the inline
// worklet loops so the envelope/sum/norm arithmetic is unit-testable directly —
// the ART render harness can't render the worklet (its render() returns a
// synthetic sine placeholder), so this pure function is the real signal-coverage
// gate for the poly envelope math.
//
// The per-lane OSCILLATOR READ stays in each worklet (CUBE's readFrame /
// WAVECEL's WavetableOsc.step) and feeds this helper the already-read per-lane
// (L,R) samples; the helper owns ONLY the envelope tick, the env multiply, the
// summation, and the env-audible-count normalization. Keeping the oscillator
// read in the worklet means CUBE and WAVECEL can share this exact arithmetic
// without the helper needing to know about wavetables / slices.
//
// NORMALIZATION (decision #6 of the locked spec): 1/sqrt(N) where N counts
// ENV-AUDIBLE voices (env.value > EPS) — NOT gated lanes and NOT state≠Idle.
// This (a) keeps a held single poly note at ~mono level (matching shipped #664),
// (b) avoids a mix pump when a sustain=0 voice is held but silent, and (c) avoids
// a release-pop because a releasing-but-still-audible voice still counts toward N.

import { Envelope } from './adsr-env';

export const POLY_SUM_VOICES = 5;

/** A voice is "env-audible" (counts toward the 1/sqrt(N) normalization) when its
 *  envelope value exceeds this epsilon. Matches the spec's env.value > ε rule. */
export const ENV_AUDIBLE_EPS = 1e-4;

// ── Held per-voice pitch (release-tail pitch fix) ──
//
// The poly VCOs (CUBE / WAVECEL) used to sample each lane's V/oct ONCE per block
// and ONLY while that lane was currently GATED, into a block-local array reset to
// 0 every block. A released note keeps SOUNDING while its envelope decays
// (env.value > 0) but its gate is already low — so the releasing lane's pitch
// read back as 0 V/oct (= C4), and the release tail snapped to C4 instead of the
// played note's pitch (the user-reported bug; reproduced mono + poly).
//
// Fix: each voice keeps a PERSISTENT held V/oct that is UPDATED while the lane is
// gated and HELD (not reset) when it isn't, so a releasing voice advances at the
// last played pitch until its envelope decays. These two pure helpers own that
// logic so it's unit-testable without an AudioWorklet (the ART render() is a
// stub — see the file header above).

/**
 * Update one voice's held V/oct for this block.
 *   gated  → track the live lane pitch (so held pitch follows pitch-bend while
 *            the note is held).
 *   !gated → HOLD the previous value (do NOT reset to 0) so a releasing voice's
 *            tail keeps advancing at the played pitch.
 */
export function updateHeldPitch(held: number, gated: boolean, lanePitch: number): number {
  return gated ? lanePitch : held;
}

/**
 * Pick the V/oct a lane's oscillator should advance at this block:
 *   - gated OR still env-audible (releasing tail) → its OWN held pitch (the
 *     played note — this is the bug fix: a releasing voice keeps its pitch).
 *   - silent / never-gated → lane-0's held pitch, so a later re-open doesn't pop
 *     (a never-played lane has held=0 and tracks lane 0's phase region).
 *
 * @param held       per-lane held V/oct (length POLY_SUM_VOICES)
 * @param lane       lane index
 * @param gated      whether the lane is currently gated this block
 * @param envAudible whether the lane's envelope is still audible (env.value > 0)
 */
export function laneRenderVOct(
  held: ArrayLike<number>,
  lane: number,
  gated: boolean,
  envAudible: boolean,
): number {
  return gated || envAudible ? (held[lane] ?? 0) : (held[0] ?? 0);
}

/** Shared single A/D/S/R param block (read once per worklet block at k-rate and
 *  fed identically into every lane's env tick — NOT a per-voice scheme). */
export interface AdsrParams {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

export interface PolySumResult {
  sumL: number;
  sumR: number;
  /** 1/sqrt(env-audible voice count); 1 when none are audible. */
  polyNorm: number;
}

/**
 * One-sample poly env+sum for the gated-poly path. Ticks each lane's envelope
 * (every lane ticks ALWAYS so a silent lane's release tail keeps decaying and a
 * re-opened lane doesn't pop), multiplies each lane's pre-read (L,R) oscillator
 * sample by its env value, sums the GATED-OR-STILL-AUDIBLE lanes, and returns
 * the env-audible-count normalization.
 *
 * A lane contributes its env-scaled sample whenever its envelope is non-idle
 * (env.value > 0): a lane whose gate just fell is in Release and must keep
 * sounding until it decays — so we gate the SUM on env-audibility, not the raw
 * gate. The caller is responsible for having called env[lane].triggerSoft() on
 * the lane's gate edges before this loop (block-rate edge detection).
 *
 * @param perLaneL  pre-read left  oscillator sample per lane (length 5)
 * @param perLaneR  pre-read right oscillator sample per lane (length 5)
 * @param env       per-lane Envelope instances (length 5; state owned by caller)
 * @param adsr      the single shared A/D/S/R block
 * @param sr        sample rate
 */
export function polyEnvSum(
  perLaneL: ArrayLike<number>,
  perLaneR: ArrayLike<number>,
  env: Envelope[],
  adsr: AdsrParams,
  sr: number,
): PolySumResult {
  let sumL = 0;
  let sumR = 0;
  let audibleCount = 0;
  for (let lane = 0; lane < POLY_SUM_VOICES; lane++) {
    const e = env[lane]!;
    const ev = e.tick(adsr.attack, adsr.decay, adsr.sustain, adsr.release, sr);
    if (ev > ENV_AUDIBLE_EPS) {
      audibleCount++;
      sumL += (perLaneL[lane] ?? 0) * ev;
      sumR += (perLaneR[lane] ?? 0) * ev;
    }
  }
  const polyNorm = audibleCount > 0 ? 1 / Math.sqrt(audibleCount) : 1;
  return { sumL, sumR, polyNorm };
}

/**
 * One-sample env multiply for the gated-MONO path (TRIGGER input drives lane-0's
 * envelope; poly bus unpatched). Returns the lane-0 (L,R) sample scaled by
 * lane-0's envelope. No normalization (a single voice). The caller ticks/triggers
 * the envelope identically to the poly path so retrigger stays click-safe.
 *
 * NOTE: this is ONLY called once the TRIGGER has been gated at least once
 * (everGated latch) — before any note (and when the TRIGGER is unpatched) the
 * caller skips the env entirely and emits the raw oscillator → byte-identical
 * legacy drone.
 */
export function monoEnvSample(
  sampleL: number,
  sampleR: number,
  env: Envelope,
  adsr: AdsrParams,
  sr: number,
): { l: number; r: number } {
  const ev = env.tick(adsr.attack, adsr.decay, adsr.sustain, adsr.release, sr);
  return { l: sampleL * ev, r: sampleR * ev };
}
