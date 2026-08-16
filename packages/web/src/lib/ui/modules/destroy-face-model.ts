// packages/web/src/lib/ui/modules/destroy-face-model.ts
//
// THE PURE MODEL BEHIND DESTROY's FACEPLATE — the four numbers a bitcrusher's
// three dials cannot print.
//
// WHY A MODEL AT ALL FOR A THREE-KNOB MODULE. Because every quantity that
// matters here is a RECIPROCAL or an EXPONENTIAL of a dial, and two of them are
// joins over two dials at once:
//
//   DECIMATE prints `8`. The number a player needs is `6.0 kHz` — and it is
//   `SR / round(d)`, not `SR / d`, because the hold length is an INTEGER
//   count of samples and the knob is a continuous 1..64 slider that CV lands
//   anywhere on. That rounding is not cosmetic: it is the whole of #1716,
//   where a `si.smoo`-ed slider truncated instead of rounding and DECIMATE 2
//   was a bit-exact no-op.
//
//   BITS prints `4`. The number a player needs is `-28.9 dB` — where the crush
//   artefact sits — and that is a JOIN with WET, which scales the artefact and
//   nothing else.
//
// ⚠ THE HOLD LAW IS ANCHORED TO THE SHIPPING WASM, NOT ARGUED HERE.
// `destroyHoldSamples` mirrors `packages/dsp/src/destroy.dsp`'s
// `ba.period(int(d + 0.5))`, and `art/scenarios/destroy/face-audit.test.ts`
// renders the REAL compiled Faust module and asserts the measured plateau
// length equals this function at every integer dial position AND at the
// half-step boundaries. A mirror with no join to the artefact is exactly the
// drift this repo keeps re-learning; the join is a test, not a comment.
//
// PURE — no DOM, no Svelte, no engine, no fs. Node-testable. TOTAL: every
// exported function is called on every animation frame while a value moves, so
// a throw on a transient NaN would take the faceplate down mid-drag.

import { destroyDef } from '$lib/audio/modules/destroy';
import { fmtDb, fmtHz } from '$lib/audio/modules/kickdrum-format';

/**
 * The sample rate every readout is stated AT.
 *
 * ⚠ A REFERENCE, NOT A MEASUREMENT, and it is stated rather than hidden. A
 * `FaceReadoutValue` sees ONLY params (`face-readout-values.ts`), so the live
 * `AudioContext.sampleRate` is structurally unreachable from a readout — the
 * `analog-vco-face-model` (`VCO_ASSUMED_SR`) and `noise-face-model`
 * (`NOISE_REFERENCE_SAMPLE_RATE`) precedents both take the same 48 kHz.
 *
 * What this means for a user on a 44.1 kHz interface: `rate` and `stream` are
 * both PROPORTIONAL to it, so they read 8.9 % high while `floor` and `mute` —
 * which carry no sample-rate term at all — stay exact. The decimator's HOLD
 * LENGTH in samples, which is what the DSP actually implements, is exact at
 * every rate.
 */
export const DESTROY_REFERENCE_SR = 48000;

export interface DestroyFaceParams {
  /** The DECIMATE dial, 1..64 — the sample-and-hold length request. */
  decimate: number;
  /** The BITS dial, 1..16 — the quantiser's depth. */
  bits: number;
  /** The WET dial, 0..1 — the crossfade against the untouched dry input. */
  wet: number;
}

/**
 * Live values in, resolving the DEF DEFAULT for anything untouched.
 * `node.params` is a SPARSE overlay of what has been TOUCHED, so reading it
 * bare prints `undefined`-shaped nonsense on a freshly spawned node.
 */
export function destroyFaceParams(
  read: (paramId: string) => number | undefined,
): DestroyFaceParams {
  const val = (id: string): number => {
    const v = read(id);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const d = destroyDef.params.find((p) => p.id === id);
    return d?.defaultValue ?? 0;
  };
  return { decimate: val('decimate'), bits: val('bits'), wet: val('wet') };
}

/** Clamp helper that also absorbs NaN (`Math.min/max` propagate it). */
function clamp(v: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

/**
 * THE HOLD LENGTH IN SAMPLES — `ba.period(int(d + 0.5))` in the shipping DSP.
 *
 * The decimator latches the input on every `holdSamples`-th sample and holds it
 * in between, so this is the ONE integer the whole time-domain half of the face
 * is derived from. 1 = untouched.
 *
 * ⚠ ROUND, NOT TRUNCATE. `int(d)` was the shipped law until #1716 and it read
 * one step LOW at every integer dial position, because `decimateKnob` is
 * `si.smoo`-ed and a one-pole smoother stalls just BELOW its target in float32
 * (measured ≈ 4.8e-4 short at d = 8). At DECIMATE 2 that made the hold 1 — no
 * decimation at all.
 */
export function destroyHoldSamples(decimate: number): number {
  const d = clamp(decimate, 1, 64, 1);
  return Math.max(1, Math.round(d));
}

/** The EFFECTIVE sample rate the decimator leaves behind, in Hz. */
export function destroyEffectiveSrHz(p: DestroyFaceParams): number {
  return DESTROY_REFERENCE_SR / destroyHoldSamples(p.decimate);
}

/**
 * The QUANTISATION STEP in signal units — the distance between two adjacent
 * output levels on the ±1 bus. `quantized = floor(x·2^(b−1) + 0.5) / 2^(b−1)`,
 * so the step is `2^(1−b)`: 3.05e-5 at 16 bits, 1.0 at 1 bit.
 */
export function destroyQuantStep(bits: number): number {
  return Math.pow(2, 1 - clamp(bits, 1, 16, 16));
}

/**
 * THE DATA RATE the crush leaves the signal at, in kbit/s — `bits × effective
 * sample rate`. The one number on this faceplate that moves with BOTH crush
 * dials, and the figure of merit a player recognises: 768 kbit/s at the shipped
 * defaults, 312 at an SP-1200's 12 bit / 26 kHz, 24 at DECIMATE 8 / BITS 4.
 *
 * ⚠ IT IS A REAL JOIN, and it replaces one the queue spec PREDICTED and this
 * audit DISPROVED. §Q18 proposed "the number of distinct output levels is a
 * function of BITS and DECIMATE together"; measured on the shipping wasm, the
 * level census is a function of BITS ALONE (9 at 4 bits and 5 at 3 bits, at
 * DECIMATE 1, 2, 4, 8, 16 and 64 alike). Decimation re-uses grid cells; it does
 * not remove them.
 */
export function destroyStreamKbps(p: DestroyFaceParams): number {
  const bits = clamp(p.bits, 1, 16, 16);
  return (bits * destroyEffectiveSrHz(p)) / 1000;
}

/**
 * THE CRUSH FLOOR in dBFS — where the bit-reduction artefact sits relative to
 * full scale, `20·log10(wet · step / √12)`.
 *
 * `step/√12` is the RMS of a uniform error across one quantiser cell, and WET
 * scales the artefact exactly (the output is `dry + wet·(crushed − dry)`, so
 * the error IS `wet ×` the error). MEASURED against the shipping wasm on seeded
 * noise: within 0.09 dB at every bit depth 1..16 and every wet 0.1..1
 * (`art/scenarios/destroy/face-audit.test.ts`).
 *
 * ⚠ IT IS THE QUANTISER'S FLOOR, NOT THE WHOLE CRUSH, and the face says so by
 * putting `rate` in the same row. The decimator's error is SIGNAL-DEPENDENT —
 * a sample-and-hold error is a function of the input's slew — so no pure
 * function of the params can print it, and this one does not pretend to:
 * measured on broadband noise it reaches −1.86 dBFS at DECIMATE 64 while this
 * readout, correctly, stays at −101 dBFS for the bit stage.
 *
 * Returns −Infinity at WET 0 (nothing crushed reaches the output at all).
 */
export function destroyBitFloorDb(p: DestroyFaceParams): number {
  const wet = clamp(p.wet, 0, 1, 1);
  if (wet <= 0) return -Infinity;
  return 20 * Math.log10((wet * destroyQuantStep(p.bits)) / Math.sqrt(12));
}

/**
 * THE DEAD ZONE, in dBFS — the input level below which the quantiser's output
 * is EXACTLY ZERO, `20·log10(2^−bits)` = `−6.02 × bits`.
 *
 * A mid-tread quantiser rounds to the nearest cell, so everything inside the
 * first half-cell rounds to 0. It is a CLIFF, not a fade: measured on the
 * shipping wasm at BITS 1, a source at 1.2× the threshold leaves at −4.3 dBFS
 * and one at 0.98× leaves at −99.0 dBFS.
 *
 * ⚠ THIS IS `bitFloorDb`'s NEGATIVE CONTROL, and publishing both is what makes
 * either trustworthy (the `clap-q` / `clap-bandwidth-hz` pattern). They are the
 * same stage's two edges and they answer to DIFFERENT dials: WET moves the
 * floor by exactly `20·log10(wet)` and moves this by nothing, because WET
 * decides how much of the crush you hear and not where the quantiser's grid
 * lands.
 */
export function destroyMuteDb(bits: number): number {
  return 20 * Math.log10(Math.pow(2, -clamp(bits, 1, 16, 16)));
}

// ── FORMATTED, for face-readout-values ─────────────────────────────────────

/** `48.0 kHz` … `750 Hz`. */
export function destroyRateText(p: DestroyFaceParams): string {
  return fmtHz(destroyEffectiveSrHz(p));
}

/** `768 kbit/s` … `24 kbit/s` … `0.8 kbit/s`. */
export function destroyStreamText(p: DestroyFaceParams): string {
  const k = destroyStreamKbps(p);
  if (!Number.isFinite(k)) return `${k}`;
  return k >= 10 ? `${Math.round(k)} kbit/s` : `${k.toFixed(1)} kbit/s`;
}

/** `−101.1 dB` … `−10.8 dB`, or `off` when WET is fully dry. */
export function destroyFloorText(p: DestroyFaceParams): string {
  const v = destroyBitFloorDb(p);
  return v === -Infinity ? 'off' : fmtDb(v);
}

/** `−96.3 dB` … `−6.0 dB`. */
export function destroyMuteText(p: DestroyFaceParams): string {
  return fmtDb(destroyMuteDb(p.bits));
}
