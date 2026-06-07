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
  /** 1/sqrt(active voice count); 1 when none are active. */
  polyNorm: number;
}

/**
 * Per-voice VCA gain = `base + (1 - base) * env` — a "VCA floor / env depth"
 * control. The envelope rides ON TOP of a base level:
 *   - base = 0 → pure ADSR (gain = env; silent between notes).
 *   - base = 1 → gain = 1 always; the envelope does nothing (full on while
 *                the voice is active).
 *   - base = 0.5 → gain floors at 0.5 and rises to 1.0 as the env peaks.
 * Applied ONLY to ACTIVE voices (gated or still env-audible). A never-gated
 * lane is NOT active → it stays silent regardless of base (so patching poly
 * never auto-drones — the no-stray-drone fix). Shared by CUBE + WAVECEL.
 */
export function vcaGain(base: number, env: number): number {
  return base + (1 - base) * env;
}

/**
 * One-sample poly env+sum for the gated-poly path. Ticks each lane's envelope
 * (every lane ticks ALWAYS so a silent lane's release tail keeps decaying and a
 * re-opened lane doesn't pop), multiplies each ACTIVE lane's pre-read (L,R)
 * oscillator sample by its per-voice VCA gain (`vcaGain(baseVol, env)`), sums the
 * active lanes, and returns the active-voice-count normalization.
 *
 * ACTIVE = gated OR still env-audible (env.value > EPS). A lane whose gate just
 * fell is in Release and must keep sounding until it decays — so it stays active
 * through the release tail. A NEVER-gated lane (gate low, env idle at 0) is NOT
 * active and contributes nothing (even with baseVol > 0): patching poly never
 * auto-drones. The caller is responsible for having called env[lane].triggerSoft()
 * on the lane's gate edges before this loop (block-rate edge detection).
 *
 * @param perLaneL  pre-read left  oscillator sample per lane (length 5)
 * @param perLaneR  pre-read right oscillator sample per lane (length 5)
 * @param env       per-lane Envelope instances (length 5; state owned by caller)
 * @param adsr      the single shared A/D/S/R block
 * @param sr        sample rate
 * @param laneGate  per-lane currently-gated flag (length 5). Optional — when
 *                  omitted, "active" falls back to env-audibility alone (the
 *                  pre-base-vol behavior, so the existing helper tests still
 *                  pin the same arithmetic).
 * @param baseVol   per-voice VCA floor [0..1]. Optional — defaults to 0 (pure
 *                  ADSR, the pre-base-vol behavior).
 */
export function polyEnvSum(
  perLaneL: ArrayLike<number>,
  perLaneR: ArrayLike<number>,
  env: Envelope[],
  adsr: AdsrParams,
  sr: number,
  laneGate?: ArrayLike<boolean>,
  baseVol = 0,
): PolySumResult {
  let sumL = 0;
  let sumR = 0;
  let activeCount = 0;
  for (let lane = 0; lane < POLY_SUM_VOICES; lane++) {
    const e = env[lane]!;
    const ev = e.tick(adsr.attack, adsr.decay, adsr.sustain, adsr.release, sr);
    const gated = laneGate ? !!laneGate[lane] : false;
    // ACTIVE = gated now OR still ringing out a release tail. A never-gated lane
    // (gate low, env idle) is excluded so baseVol can't make it drone.
    const active = gated || ev > ENV_AUDIBLE_EPS;
    if (active) {
      activeCount++;
      const g = vcaGain(baseVol, ev);
      sumL += (perLaneL[lane] ?? 0) * g;
      sumR += (perLaneR[lane] ?? 0) * g;
    }
  }
  const polyNorm = activeCount > 0 ? 1 / Math.sqrt(activeCount) : 1;
  return { sumL, sumR, polyNorm };
}

/**
 * One-sample env multiply for the gated-MONO path (TRIGGER input drives lane-0's
 * envelope; poly bus unpatched but the TRIGGER is patched). Returns the lane-0
 * (L,R) sample scaled by the per-voice VCA gain `vcaGain(baseVol, env)`. No
 * normalization (a single voice). The caller ticks/triggers the envelope
 * identically to the poly path so retrigger stays click-safe.
 *
 * ACTIVE gating: the floor (and any output) applies ONLY while the voice is
 * active — gated now OR still env-audible (releasing tail). Before the first
 * trigger (env idle, gate low) the voice is INACTIVE → silent (gain 0), so a
 * patched-but-never-hit TRIGGER does not drone even with baseVol > 0. The
 * caller passes `active = trigGate || env.value > EPS`.
 *
 * @param baseVol per-voice VCA floor [0..1]. Default 0 = pure ADSR (gain = env),
 *                the pre-base-vol behavior the existing helper tests pin.
 * @param active  whether the voice is gated-or-releasing this sample. Default
 *                true (pre-base-vol callers always had a live envelope).
 */
export function monoEnvSample(
  sampleL: number,
  sampleR: number,
  env: Envelope,
  adsr: AdsrParams,
  sr: number,
  baseVol = 0,
  active = true,
): { l: number; r: number } {
  const ev = env.tick(adsr.attack, adsr.decay, adsr.sustain, adsr.release, sr);
  const g = active ? vcaGain(baseVol, ev) : 0;
  return { l: sampleL * g, r: sampleR * g };
}
