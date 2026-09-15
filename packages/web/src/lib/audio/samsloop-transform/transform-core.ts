// SAMSLOOP transform core — the PURE request→response the transform worker
// runs, and the inline fallback runs where there is no Worker (vitest, SSR).
//
// One request = one press of NORMALIZE or DENOISE: decode the node's stored
// sample (header-less PCM from the record path, or a Float32 buffer the main
// thread already decoded through the AudioContext for an upload), run the
// dsp core IN PLACE, and re-encode at the SOURCE's bit depth and rate as the
// `sample` record shape REC writes — base64 included, so the main thread's
// only remaining work is the one Yjs transaction.
//
// ⚠ THIS FILE IMPORTS `packages/dsp/src/lib` BY RELATIVE PATH, AND IT IS THE
// FIRST FILE A WORKER BUNDLE DOES THAT FROM. The main bundle already crosses
// the package boundary the same way (`ui/modules/moog904a-face-model.ts`,
// `ninelives-face-model.ts`, `moog911-face-model.ts` all import
// `../../../../../dsp/src/lib/*`), so this is the ratified shape, not a new
// one. `packages/web/vite.config.ts` sets no `worker.format`, so the worker
// build takes Vite's default `iife`, which INLINES this import into the
// worker chunk — that is why a cross-package worker works at all, and it is
// also why the worker chunk cannot code-split. Stated here so the next author
// does not discover it in CI.
//
// Placed OUTSIDE `lib/audio/modules/` on purpose: `docs/module-manifest.ts`
// globs every non-test `.ts` there as a module def.
//
// Pure: no DOM, no store, no engine. `transform-core.test.ts` drives it with
// the real dsp cores and no Worker.

import {
  normalizeSample,
  type NormalizeResult,
} from '../../../../../dsp/src/lib/samsloop-normalize';
import {
  denoiseSample,
  type DenoiseResult,
} from '../../../../../dsp/src/lib/samsloop-denoise';
import {
  buildTransformedSample,
  decodeRecordedPcm,
  type SamsloopRecBits,
  type SamsloopRecChannels,
  type SamsloopRecordedSample,
} from '../modules/samsloop-record';

export type SamsloopTransformKind = 'normalize' | 'denoise';

/** A NORMALIZE whose gain is under this is a no-op at any stored depth
 *  (0.01 dB is 0.12 % of amplitude — under one LSB of int8 at every level
 *  and under one LSB of int16 above −40 dBFS). Paired with a one-LSB DC test. */
export const NORMALIZE_NOOP_DB = 0.01;

/** What the main thread hands the worker. `pcm` is the record path's stored
 *  bytes (decoded HERE, off the main thread); `f32` is an upload the main
 *  thread had to decode through the AudioContext (a worker has none), sent
 *  as a TRANSFERRED ArrayBuffer. */
export type SamsloopTransformSource =
  | {
      kind: 'pcm';
      bytesB64: string;
      bits: SamsloopRecBits;
      channels: SamsloopRecChannels;
      rate: number;
    }
  | { kind: 'f32'; samples: ArrayBuffer; rate: number; bits: SamsloopRecBits };

export interface SamsloopTransformRequest {
  /** Correlates a reply with its press on the client's pending map. */
  id: number;
  kind: SamsloopTransformKind;
  source: SamsloopTransformSource;
  /** The source record already carried the DENOISE marker — carried through a
   *  NORMALIZE so the marker survives. */
  denoised?: boolean;
  /** Injectable clock for the record's `recordedAt` (tests pin the signature). */
  now?: number;
}

export type SamsloopTransformStats =
  | { kind: 'normalize'; dcOffset: number; peakBefore: number; gainDb: number }
  | { kind: 'denoise'; noiseFloorDb: number; reductionDb: number };

export type SamsloopTransformRefusal =
  | Extract<NormalizeResult, { ok: false }>['reason']
  | Extract<DenoiseResult, { ok: false }>['reason']
  | 'empty';

export type SamsloopTransformResponse =
  | {
      id: number;
      ok: true;
      sample: SamsloopRecordedSample;
      frames: number;
      stats: SamsloopTransformStats;
    }
  | { id: number; ok: false; reason: SamsloopTransformRefusal };

/** Decode the request's source into a private mono Float32 buffer. */
function decodeSource(src: SamsloopTransformSource): { f32: Float32Array; rate: number; bits: SamsloopRecBits } {
  if (src.kind === 'pcm') {
    return { f32: decodeRecordedPcm(src, 'mix'), rate: src.rate, bits: src.bits };
  }
  return { f32: new Float32Array(src.samples), rate: src.rate, bits: src.bits };
}

/** Run one transform request. Synchronous and pure; the worker shim and the
 *  inline fallback both call exactly this. */
export function runSamsloopTransform(req: SamsloopTransformRequest): SamsloopTransformResponse {
  const { f32, rate, bits } = decodeSource(req.source);
  if (f32.length === 0) return { id: req.id, ok: false, reason: 'empty' };

  let stats: SamsloopTransformStats;
  if (req.kind === 'normalize') {
    const r = normalizeSample(f32);
    if (!r.ok) return { id: req.id, ok: false, reason: r.reason };
    // ⚠ THE QUANTIZED NO-OP. The core refuses 'already-full-scale' only when
    // |mean| < 1e-6 AND |1 − peak| < 1e-6 — a Float32 contract. A STORED
    // record is int16 / int8, and rounding a DC-removed sine to 16 bits
    // leaves a mean of ~5e-6 (measured 4.6e-6 in transform-core.test.ts), so
    // a second NORMALIZE press on the record it just wrote would pass the
    // core and rewrite the sample with a +0.00004 dB gain and a −5e-6 offset:
    // a Yjs write, a worklet reload and a playback stop for nothing. The
    // owner's ruling is that already-full-scale is a REFUSAL, so it is
    // decided here at the resolution the source can express: no change
    // greater than one LSB of the source depth is no change.
    const lsb = 1 / (bits === 16 ? 0x7fff : 0x7f);
    if (Math.abs(r.gainDb) < NORMALIZE_NOOP_DB && Math.abs(r.dcOffset) <= lsb) {
      return { id: req.id, ok: false, reason: 'already-full-scale' };
    }
    stats = { kind: 'normalize', dcOffset: r.dcOffset, peakBefore: r.peakBefore, gainDb: r.gainDb };
  } else {
    const r = denoiseSample(f32, rate);
    if (!r.ok) return { id: req.id, ok: false, reason: r.reason };
    stats = { kind: 'denoise', noiseFloorDb: r.noiseFloorDb, reductionDb: r.reductionDb };
  }

  const { sample, frames } = buildTransformedSample(f32, rate, bits, {
    denoised: req.kind === 'denoise' || !!req.denoised,
    now: req.now,
  });
  return { id: req.id, ok: true, sample, frames, stats };
}
