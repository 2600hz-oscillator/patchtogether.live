// The record-side seams a TRANSFORM write goes through — `buildTransformedSample`
// and `samsloopTransformCapRefusal` — pure, no AudioContext.
//
// Pinned: the round trip at 8 and 16 bits (source bit depth is preserved —
// no size growth), the exact +32767 / +127 landing of a 1.0 peak, the
// DENOISE marker, and the three named cap refusals (per-take bytes, 60 s,
// rack ledger) with a permanent negative control that a fitting write is
// NOT refused.

import { describe, expect, it } from 'vitest';
import {
  buildTransformedSample,
  decodeRecordedPcm,
  samsloopRackLedger,
  samsloopRackTransformMessage,
  samsloopTransformCapRefusal,
  SAMSLOOP_RECORD_BUDGET_BYTES,
  SAMSLOOP_RECORD_MAX_SECONDS,
  SAMSLOOP_RACK_RECORD_BUDGET_BYTES,
} from './samsloop-record';
import { resolveSamsloopSource } from './samsloop';

function ramp(n: number): Float32Array {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * i) / 100);
  return x;
}

describe('buildTransformedSample — REC\'s commit shape, at the SOURCE bit depth', () => {
  it('16-bit: round-trips through the shared decoder, mono, stamped', () => {
    const x = ramp(1000);
    const { sample, frames } = buildTransformedSample(x, 24_000, 16, { now: 7 });
    expect(frames).toBe(1000);
    expect(sample.bits).toBe(16);
    expect(sample.channels).toBe(1);
    expect(sample.rate).toBe(24_000);
    expect(sample.byteLength).toBe(2000);
    expect(sample.durationSec).toBeCloseTo(1000 / 24_000, 9);
    expect(sample.recordedAt).toBe(7);
    expect(sample.denoised).toBeUndefined();
    const back = decodeRecordedPcm(sample, 'mix');
    expect(back.length).toBe(1000);
    for (let i = 0; i < 1000; i += 37) expect(back[i]).toBeCloseTo(x[i]!, 4);
  });

  it('8-bit: stays 8-bit — one byte per frame, a 1.0 peak on exactly +127', () => {
    const x = ramp(1000);
    x[25] = 1; // the sine's own peak sits between samples; force an exact 1.0
    const { sample } = buildTransformedSample(x, 48_000, 8, { now: 1 });
    expect(sample.bits).toBe(8);
    expect(sample.byteLength).toBe(1000);
    const back = decodeRecordedPcm(sample, 'mix');
    expect(back[25]).toBe(1);
    // The 8-bit staircase is coarse (1/127) but the shape survives.
    for (let i = 0; i < 1000; i += 37) expect(back[i]).toBeCloseTo(x[i]!, 1);
  });

  it('the resulting record RESOLVES as a playable source with a signature that MOVES with `now`', () => {
    const a = buildTransformedSample(ramp(500), 24_000, 16, { now: 1 }).sample;
    const b = buildTransformedSample(ramp(500), 24_000, 16, { now: 2 }).sample;
    const sa = resolveSamsloopSource({ sample: a });
    const sb = resolveSamsloopSource({ sample: b });
    expect(sa?.kind).toBe('record');
    expect(sa?.signature).not.toBe(sb?.signature);
  });

  it('the DENOISE marker is written only when asked, as the literal `true`', () => {
    expect(buildTransformedSample(ramp(10), 24_000, 16, { denoised: true, now: 1 }).sample.denoised).toBe(true);
    expect(buildTransformedSample(ramp(10), 24_000, 16, { denoised: false, now: 1 }).sample.denoised).toBeUndefined();
  });
});

describe('samsloopTransformCapRefusal — the three ceilings a write must clear', () => {
  const emptyLedger = samsloopRackLedger({});

  it('NEGATIVE CONTROL: a write that fits is NOT refused', () => {
    expect(
      samsloopTransformCapRefusal({
        byteLength: 96_000, frames: 48_000, rate: 48_000, base64Length: 128_000, ledger: emptyLedger,
      }),
    ).toBeNull();
  });

  it('over the per-take byte budget → the byte sentence', () => {
    const r = samsloopTransformCapRefusal({
      byteLength: SAMSLOOP_RECORD_BUDGET_BYTES + 2,
      frames: 10, rate: 48_000, base64Length: 10, ledger: emptyLedger,
    });
    expect(r).toMatch(/MB of PCM/);
    expect(r).toContain(String(SAMSLOOP_RECORD_BUDGET_BYTES / 1_000_000));
  });

  it('over the 60 s ceiling → the seconds sentence (a 62.5 s upload at 24 kHz)', () => {
    const r = samsloopTransformCapRefusal({
      byteLength: 3_000_000, frames: 1_500_000, rate: 24_000, base64Length: 4_000_000, ledger: emptyLedger,
    });
    expect(r).toMatch(/62\.5 s/);
    expect(r).toContain(`${SAMSLOOP_RECORD_MAX_SECONDS} s`);
  });

  it('over the rack ledger → the rack sentence, with the numbers', () => {
    const ledger = {
      usedBytes: SAMSLOOP_RACK_RECORD_BUDGET_BYTES - 100,
      budgetBytes: SAMSLOOP_RACK_RECORD_BUDGET_BYTES,
      freeBytes: 100,
      overBudget: false,
      nodeCount: 3,
    };
    const r = samsloopTransformCapRefusal({
      byteLength: 1000, frames: 500, rate: 24_000, base64Length: 1334, ledger,
    });
    expect(r).toBe(samsloopRackTransformMessage(ledger, 1334));
    expect(r).toMatch(/3 samsloops/);
    expect(r).toMatch(/0\.00 MB/); // what is free
  });
});
