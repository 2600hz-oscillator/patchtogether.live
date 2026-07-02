// art/scenarios/moog914/profile.test.ts
//
// AUDIO PROFILE for MOOG 914 (extended fixed filter bank) (backfill
// batch 2 — spec §4.1/§4.3,
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md), through the
// shared capture harness (art/setup/capture.ts + drivers.ts).
//
// Category: FILTER (fixed — the System 55's full-size bank). Driver: the
// canonical SEEDED WHITE NOISE (PROFILE_NOISE_SEED xorshift32) — broadband
// noise reveals the fixed bank's signature: TWELVE Q=4 bandpass stripes
// (125 Hz … 5.6 kHz) plus the 100 Hz low-pass and 7.5 kHz high-pass
// bookend shelves (vs the 907A's 8-band standard range — same factory,
// different data). Patch: every section level at 0.5 (shipping default).
//
// Rendering path: the REAL module def + factory — identical reasoning to
// the moog907a profile (PURE Web Audio biquad fan, no worklet; native
// primitives run under node-web-audio-api's OfflineAudioContext, plan §1.3
// path #3; determinism probed bit-identical in- and across processes).
//
// SIGNATURE output (owner decision §6b.2): the single mono `audio` out.
//
// The .sha pins the shared band-table lib + the shared factory wiring
// (repoSourceSha), NOT the def file — same rationale as moog907a (docs
// edits must never invalidate audio pins; the constants live in the lib).

import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { moog914Def } from '$lib/audio/modules/moog914';
import { pinAll, repoSourceSha, SAMPLE_RATE } from '../../setup/capture';
import { seededNoise } from '../../setup/drivers';

const SR = SAMPLE_RATE;
const DURATION_S = 1.0;

// Every section (hp, band1..band12, lp) at its 0.5 shipping default —
// explicit, so the render is a pure function of this file + the pinned
// factory/lib (ids come from the def, staying in lock-step).
const LEVEL = 0.5;
const NOISE_AMP = 0.5;

async function renderProfile(): Promise<Record<string, Float32Array>> {
  const n = Math.round(SR * DURATION_S);
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: n, sampleRate: SR });
  const params = Object.fromEntries(moog914Def.params.map((p) => [p.id, LEVEL]));
  const node = {
    id: 'profile',
    type: moog914Def.type,
    position: { x: 0, y: 0 },
    params,
  } as unknown as Parameters<typeof moog914Def.factory>[1];
  const handle = await moog914Def.factory(ctx as unknown as AudioContext, node);

  const noise = seededNoise(DURATION_S);
  const buf = ctx.createBuffer(1, noise.length, SR);
  const scaled = new Float32Array(noise.length);
  for (let i = 0; i < noise.length; i++) scaled[i] = noise[i]! * NOISE_AMP;
  buf.copyToChannel(scaled, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;

  const inRef = handle.inputs.get('audio')!;
  src.connect(inRef.node, 0, inRef.input);
  const outRef = handle.outputs.get('audio')!;
  outRef.node.connect(ctx.destination);
  src.start(0);
  const rendered = await ctx.startRendering();
  return { audio: rendered.getChannelData(0).slice() };
}

// Goertzel magnitude (normalized 2/N), averaged over a few probe bins.
function bandMag(buf: Float32Array, freqsHz: number[]): number {
  let sum = 0;
  for (const f of freqsHz) {
    const w = (2 * Math.PI * f) / SR;
    const coeff = 2 * Math.cos(w);
    let q1 = 0;
    let q2 = 0;
    for (let i = 0; i < buf.length; i++) {
      const q0 = coeff * q1 - q2 + buf[i]!;
      q2 = q1;
      q1 = q0;
    }
    const re = q1 - q2 * Math.cos(w);
    const im = q2 * Math.sin(w);
    sum += (2 / buf.length) * Math.sqrt(re * re + im * im);
  }
  return sum / freqsHz.length;
}

function rms(b: Float32Array): number {
  let x = 0;
  for (const v of b) x += v * v;
  return Math.sqrt(x / b.length);
}

describe('ART moog914 / audio profile (seeded noise through the 12-band extended bank, all levels 0.5)', () => {
  it('renders a finite, audible extended-bank spectrum down to the 125 Hz band', async () => {
    const out = (await renderProfile()).audio!;
    expect(out.length).toBe(Math.round(SR * DURATION_S));
    expect(out.every(Number.isFinite)).toBe(true);
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThan(2);
    expect(rms(out)).toBeGreaterThan(0.02);
    // The extended grid: both the 1 kHz centre AND the 125 Hz bottom band
    // (which the 907A does not have) carry clearly more energy than the
    // spectral hole between the top band (5.6 kHz) and the 7.5 kHz shelf.
    const inBand = bandMag(out, [950, 1000, 1050]);
    const bottomBand = bandMag(out, [120, 125, 130]);
    const gap = bandMag(out, [6300, 6500, 6700]);
    expect(inBand).toBeGreaterThan(gap * 1.5);
    expect(bottomBand).toBeGreaterThan(gap * 1.5);
    // Deterministic re-render is bit-identical (probed before pinning).
    const again = (await renderProfile()).audio!;
    let diff = 0;
    for (let i = 0; i < out.length; i++) diff = Math.max(diff, Math.abs(out[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the audio profile baseline (SHA-gated, RMS tier B)', async () => {
    const srcSha = await repoSourceSha(
      'packages/dsp/src/lib/moog-filterbank-dsp.ts',
      'packages/web/src/lib/audio/modules/moog-filterbank-factory.ts',
    );
    await pinAll('moog914', srcSha, await renderProfile());
  });
});
