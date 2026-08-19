// packages/web/src/lib/ui/modules/pentemelodica-face-model.ts
//
// THE PURE MODEL BEHIND PENTEMELODICA's FACEPLATE.
//
// Four derived numbers, and each one exists because the nearest knob is BLIND
// to something that genuinely changes the answer:
//
//   mode gain   — a function of MODE **and** RESONANCE. A MODE readout is
//                 invariant to resonance and would print "low-pass" alike at
//                 −6.0 dB (res 0) and +34.0 dB (res 0.99), a 50× swing on the
//                 master bus that the MODE knob never twitches for.
//   peak        — a function of every LEVEL **and** every PAN. A level readback
//                 is pan-invariant; spreading the pans genuinely lowers the
//                 per-channel peak (1.697 → 1.342 at ±0.8).
//   release tail— release × ln(sustain / 1e-5). The RELEASE knob is
//                 SUSTAIN-invariant, and sustain moves the answer 58 → 46 ms
//                 without the knob twitching.
//   decay to S  — 0 ms at the shipped SUSTAIN of 1, because the Decay branch
//                 exits on its FIRST tick when the gap is already zero.
//
// THE MODE-1 TAP IS A TRUE NOTCH as of the notch fix, and this model tracks it.
// `modeMorph` used to compute `notch = x - taps.bp` — the `k` was missing, so
// the fourth tap was a PHASE-INVERTED BAND-PASS whose gain at fc was |1 − 1/k|:
// −8.5 dB at the shipped resonance 0.2, a true null ONLY at 0.5 (k == 1), and
// +33.8 dB — a 49× BOOST on the master bus — at the max 0.99. It now computes
// `x − k·bp` = `lp + hp`, the same identity `resofilter-dsp` has always used,
// so the tap NULLS at fc for every resonance.
//
// ⚠ That makes `penteModeGainAtCutoff` resonance-INVARIANT at exactly mode = 1
// (a null is a null at any Q) — but only there. Every mode BELOW the fourth tap
// still scales as 1/k, which is a 0.5 → 50 swing across the resonance range, so
// the readout is still reporting something the MODE knob cannot show. The
// negative control moved with it: see `pentemelodica-face-model.test.ts`.
//
// PURE — no DOM, no Svelte, no engine. Node-testable.

import { PENTE_MASTER_GAIN, PENTE_VOICES } from '../../../../../dsp/src/lib/pentemelodica-dsp';
import { resToK } from '../../../../../dsp/src/lib/resofilter-dsp';
import { pentemelodicaDef } from '$lib/audio/modules/pentemelodica';

/** The envelope's idle floor and its Decay-branch exit threshold, mirrored from
 *  `Envelope.tick` in pentemelodica-dsp (a module-private pair of literals). */
export const PENTE_ENV_IDLE_FLOOR = 1e-5;
export const PENTE_ENV_DECAY_EPS = 1e-4;

export interface PenteFaceParams {
  mode: number;
  resonance: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  /** length 5, v1..v5 */
  levels: number[];
  /** length 5, v1..v5 */
  pans: number[];
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Live params in, def defaults for anything untouched (`node.params` is a
 *  sparse overlay of what has been TOUCHED). */
export function pentemelodicaFaceParams(
  read: (paramId: string) => number | undefined,
): PenteFaceParams {
  const val = (id: string): number => {
    const v = read(id);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const pd = pentemelodicaDef.params.find((p) => p.id === id);
    if (!pd) throw new Error(`pentemelodica-face-model: no param '${id}'`);
    return pd.defaultValue;
  };
  const levels: number[] = [];
  const pans: number[] = [];
  for (let v = 1; v <= PENTE_VOICES; v++) {
    levels.push(val(`v${v}_level`));
    pans.push(val(`v${v}_pan`));
  }
  return {
    mode: val('mode'),
    resonance: val('resonance'),
    attack: val('attack'),
    decay: val('decay'),
    sustain: val('sustain'),
    release: val('release'),
    levels,
    pans,
  };
}

/**
 * |H(jωc)| — the filter's magnitude AT the cutoff, for the live MODE and
 * RESONANCE.
 *
 * MIRRORS `modeMorph` exactly. At ω = ωc the analog SVF taps are lp = −j/k,
 * bp = 1/k, hp = +j/k, and the fourth tap is the true notch `x − k·bp` =
 * 1 − k·(1/k) = 0 — an exact null, independently of k. Blending time-domain taps
 * IS blending transfer functions (all four are linear in the same input), so the
 * closed form is exact at fc.
 *
 * Hence the fourth segment (HP → Notch) carries only the HP contribution,
 * decaying to zero as the dial reaches 1 — where the pre-fix code instead
 * carried a real term `t·(1 − 1/k)` that grew without bound as k fell.
 */
export function penteModeGainAtCutoff(mode: number, resonance: number): number {
  const k = resToK(resonance);
  const m = clamp01(mode);
  const m3 = m * 3;
  const seg = Math.min(2, Math.floor(m3));
  const t = m3 - seg;
  let re: number;
  let im: number;
  if (seg === 0) {
    re = t / k;
    im = -(1 - t) / k;
  } else if (seg === 1) {
    re = (1 - t) / k;
    im = t / k;
  } else {
    // The notch tap contributes NOTHING at fc (it nulls there), so only the
    // fading HP term survives: at t = 1 the gain is exactly 0.
    re = 0;
    im = (1 - t) / k;
  }
  return Math.hypot(re, im);
}

/**
 * True per-channel peak with ALL FIVE voices gated at full envelope:
 *   L = 0.6·Σ level_v·cos((pan_v+1)·π/4),  R = the sin twin.
 * PENTE_MASTER_GAIN is a CONSTANT 0.6 and there is no 1/√N anywhere in the DSP,
 * so this scales linearly with the number of sounding voices.
 */
export function pentePeakLinear(
  levels: readonly number[],
  pans: readonly number[],
): number {
  let l = 0;
  let r = 0;
  for (let i = 0; i < PENTE_VOICES; i++) {
    const lv = Math.max(0, Math.min(1, levels[i] ?? 0));
    const pan = Math.max(-1, Math.min(1, pans[i] ?? 0));
    const a = ((pan + 1) * Math.PI) / 4;
    l += lv * Math.cos(a);
    r += lv * Math.sin(a);
  }
  return PENTE_MASTER_GAIN * Math.max(l, r);
}

/** ms to fall from `sustain` to the Envelope's idle floor. */
export function penteReleaseTailMs(release: number, sustain: number): number {
  const s = clamp01(sustain);
  if (s <= PENTE_ENV_IDLE_FLOOR) return 0;
  return Math.max(1e-6, release) * Math.log(s / PENTE_ENV_IDLE_FLOOR) * 1000;
}

/**
 * ms for the Decay branch to reach Sustain. The branch exits when
 * `|value − s| < 1e-4` starting from 1 — so at the shipped SUSTAIN of 1 the gap
 * is already zero and ZERO SAMPLES of decay ever run.
 */
export function penteDecayToSustainMs(decay: number, sustain: number): number {
  const gap = Math.max(0, 1 - clamp01(sustain));
  if (gap <= PENTE_ENV_DECAY_EPS) return 0;
  return Math.max(1e-6, decay) * Math.log(gap / PENTE_ENV_DECAY_EPS) * 1000;
}
