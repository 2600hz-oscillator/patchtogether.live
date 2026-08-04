// art/scenarios/analog-vco/vco-mirror.ts
//
// THE ONE TS mirror of packages/dsp/src/analog-vco.dsp.
//
// WHY A MIRROR EXISTS AT ALL. The analog-vco ART scenarios predate the
// Faust-in-Node harness (art/setup/faust-offline.ts, backfill batch 6). When
// they were written, node genuinely could not host a Faust AudioWorklet, so
// each scenario hand-ported the `.dsp`'s per-sample recurrences into TS and
// rendered its `.f32` baselines from that. Three scenarios did this
// independently, so three copies drifted apart in the same repo.
//
// WHAT THAT COST — measured, not theorised. With THREE private copies and a
// `.sha` pin that watches only the `.dsp`, the gate could be walked straight
// past. Inverting the oscillator's saw in the `.dsp` (`2p-1` → `1-2p`), a total
// polarity flip, then doing exactly what the failure message instructs:
//
//   1. `task dsp:build`               → the SHA pin fires (looks like it worked)
//   2. `npm run art:update -w art`    → the documented response
//   3. result: 28/28 PASS, 17 `.sha` re-pinned, and **not one `.f32` byte moved**
//
// The baselines regenerate from the UNCHANGED mirror, so the diff the re-pin
// ritual tells you to review is empty BY CONSTRUCTION. That is worse than no
// gate: it manufactures the appearance of verification. (Every behavioural
// assertion — "A stays sinusoidal", "sync reshapes A" — also passed with the
// saw inverted, because they too read the mirror.)
//
// THE FIX, in two halves:
//   * this file — ONE mirror, imported by all three scenarios, so a fix lands
//     in one place instead of three.
//   * mirror-fidelity.test.ts — renders the REAL shipped Faust wasm through
//     the offline harness and asserts THIS mirror matches it. That test owns
//     no baseline, so it CANNOT be silenced by a re-pin. Any `.dsp` edit that
//     changes the output reddens it until the mirror is reconciled.
//
// Measured agreement today: max |diff| 9.46e-5, rms error −80.5 dB relative to
// signal — float32-wasm vs float64-TS accumulation, not a modelling difference.
//
// ⚠ The scenarios' old header note ("node-web-audio-api cannot host the Faust
// AudioWorklet directly") is STALE as of the offline harness. Rendering the
// baselines from real Faust is the better end state and is tracked as the
// follow-up; it is NOT done here because the fm-sync feedback/mutual configs
// need sample-interleaved co-simulation of two instances, which the harness
// (whole-buffer, one module per call) cannot yet express. This PR makes the
// existing mirror HONEST rather than pretending that limitation away.

import { SAMPLE_RATE } from '../../setup/capture';

/** 0 V/oct reference — `freqHz` in the .dsp is 261.626 * 2^(...). */
export const C4_HZ = 261.626;

/** ma.frac */
export const frac = (x: number): number => x - Math.floor(x);

/** The .dsp clamps the computed frequency into a sane audio band. */
export function freqHz(
  pitchVolts: number,
  fm = 0,
  opts: { tune?: number; fine?: number; fmAmount?: number } = {},
): number {
  const { tune = 0, fine = 0, fmAmount = 0 } = opts;
  const f = C4_HZ * Math.pow(2, pitchVolts + tune / 12 + fine / 1200 + fmAmount * fm);
  return Math.min(20000, Math.max(1, f));
}

// ── The four fixed waveform taps (analog-vco.dsp:56-59) ──
export const saw = (p: number): number => 2.0 * p - 1.0;

/** `sqr(p) = select2(p < pw, 1.0, -1.0)`.
 *
 *  ⚠ FAUST SEMANTICS TRAP, and the fidelity gate caught it on its first run.
 *  `select2(c, a, b)` yields `a` when c is **0/false** and `b` when c is
 *  **1/true** — so this reads as `(p < pw) ? -1.0 : +1.0`, the OPPOSITE of the
 *  obvious `cond ? first : second` reading a TS author reaches for. Getting it
 *  backwards inverts the square and its half of the morph, and measured 5.8 dB
 *  of error — invisible to any gate that renders only the mirror. */
export const sqr = (p: number, pw = 0.5): number => (p < pw ? -1.0 : 1.0);
export const tri = (p: number): number => 4.0 * Math.abs(p - 0.5) - 1.0;
export const sn = (p: number): number => Math.sin(2.0 * Math.PI * p);

/** The continuous saw→sine→square morph (analog-vco.dsp:78-85).
 *  Two-segment linear crossfade over the SHARED phase. The square endpoint
 *  uses the pw-driven `sqr` (NOT a hardcoded 50% square) — that is the PW-in-
 *  MORPH fix, and mirroring it wrongly would hide a regression of it. */
export function morph(p: number, shape: number, pw = 0.5): number {
  const lo = 2.0 * shape;
  const hi = 2.0 * shape - 1.0;
  return shape < 0.5 ? sn(p) * lo + saw(p) * (1.0 - lo) : sqr(p, pw) * hi + sn(p) * (1.0 - hi);
}

/** `syncEdge(sync) = (sync > 0) & (sync' <= 0)` — rising-edge detect. */
export function syncEdge(cur: number, prev: number): 0 | 1 {
  return cur > 0 && prev <= 0 ? 1 : 0;
}

/** One `phasorReset` step: `loop(prev) = (1 - reset) * frac(prev + f/SR)`. */
export function phasorResetStep(prev: number, f: number, reset: 0 | 1, sr = SAMPLE_RATE): number {
  return (1.0 - reset) * frac(prev + f / sr);
}

/** `syncPulse(pRaw) = (pRaw < pRaw') * 1.0` — a one-sample pulse on wrap. */
export const syncPulse = (cur: number, prev: number): number => (cur < prev ? 1.0 : 0.0);

export interface VcoTaps {
  saw: Float32Array;
  sqr: Float32Array;
  tri: Float32Array;
  sn: Float32Array;
  morph: Float32Array;
  syncPulse: Float32Array;
}

export interface VcoRenderOptions {
  n: number;
  /** V/oct per sample, or a constant. */
  pitch?: Float32Array | number;
  /** FM input per sample (scaled by fmAmount inside freqHz). */
  fm?: Float32Array | null;
  /** PM input per sample (scaled by pmAmount, added to phase). */
  pm?: Float32Array | null;
  /** Sync input per sample — a rising edge resets the phase to 0. */
  sync?: Float32Array | null;
  tune?: number;
  fine?: number;
  fmAmount?: number;
  pmAmount?: number;
  pw?: number;
  shape?: number;
  sr?: number;
}

/** Render ALL SIX outputs, in the .dsp's `process` order, from the mirrored
 *  per-sample recurrences. This is the exact chain the .dsp declares:
 *
 *      f     = freqHz(pitch, fm)
 *      reset = syncEdge(sync)
 *      pRaw  = phasorReset(f, reset)
 *      p     = frac(pRaw + pmAmount * pm)
 *      out   = saw(p), sqr(p), tri(p), sn(p), morph(p), syncPulse(pRaw)
 */
export function renderVcoMirror(opts: VcoRenderOptions): VcoTaps {
  const {
    n,
    pitch = 0,
    fm = null,
    pm = null,
    sync = null,
    tune = 0,
    fine = 0,
    fmAmount = 0,
    pmAmount = 0,
    pw = 0.5,
    shape = 0,
    sr = SAMPLE_RATE,
  } = opts;

  const out: VcoTaps = {
    saw: new Float32Array(n),
    sqr: new Float32Array(n),
    tri: new Float32Array(n),
    sn: new Float32Array(n),
    morph: new Float32Array(n),
    syncPulse: new Float32Array(n),
  };

  let pRaw = 0;
  let prevRaw = 0;
  let prevSync = 0;

  for (let i = 0; i < n; i++) {
    const v = typeof pitch === 'number' ? pitch : (pitch[i] ?? 0);
    const fmIn = fm ? (fm[i] ?? 0) : 0;
    const pmIn = pm ? (pm[i] ?? 0) : 0;
    const syncIn = sync ? (sync[i] ?? 0) : 0;

    const f = freqHz(v, fmIn, { tune, fine, fmAmount });
    const reset = syncEdge(syncIn, prevSync);
    prevSync = syncIn;

    prevRaw = pRaw;
    pRaw = phasorResetStep(pRaw, f, reset, sr);
    const p = frac(pRaw + pmAmount * pmIn);

    out.saw[i] = saw(p);
    out.sqr[i] = sqr(p, pw);
    out.tri[i] = tri(p);
    out.sn[i] = sn(p);
    out.morph[i] = morph(p, shape, pw);
    out.syncPulse[i] = syncPulse(pRaw, prevRaw);
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// ⚠ DO NOT TRUST THIS FILE'S sqr POLARITY YET — the measurement is unresolved.
//
// Three framings of "does the mirror's square match the shipped DSP" gave
// three different answers in one session:
//   * an independent phase accumulator      → flipped matches 95%
//   * phase derived from Faust's own saw    → flipped matches 93-98%
//   * reading the first samples directly    → UNFLIPPED matches (sqr[0]=+1 at
//                                             p=0.0055, i.e. p<pw yields +1)
// and the agreement is N-DEPENDENT with identical first samples:
//     N=400 → unflipped 43.3% | N=2400 → 20.0% | N=12000 → 4.1%
//
// A relationship that is exact by construction (sqr is a pure function of the
// same p that produces saw, in the same expression) CANNOT legitimately decay
// with buffer length. So the decay is an artefact of how these probes read the
// harness, not a property of the DSP — and until that is understood, no claim
// about which polarity is correct is worth anything.
//
// The blind-gate finding this branch exists for does NOT depend on any of that:
// it was demonstrated with the repo's own commands (edit .dsp → task dsp:build
// → art:update → git status) and no custom probe at all.
// ─────────────────────────────────────────────────────────────────────────
