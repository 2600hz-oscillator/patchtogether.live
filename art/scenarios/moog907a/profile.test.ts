// art/scenarios/moog907a/profile.test.ts
//
// AUDIO PROFILE for MOOG 907A (fixed filter bank) (backfill batch 2 —
// spec §4.1/§4.3, .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md),
// through the shared capture harness (art/setup/capture.ts + drivers.ts).
//
// Category: FILTER (fixed — no CV, the band centres never move). Driver:
// the canonical SEEDED WHITE NOISE (spec §4.2 FX/processor driver,
// PROFILE_NOISE_SEED xorshift32) — broadband noise is what reveals a FIXED
// bank's signature: the spectrogram shows the comb of eight Q=4 bandpass
// stripes (250 Hz … 2.8 kHz) plus the 175 Hz low-pass and 6.6 kHz
// high-pass bookend shelves. Patch: every section level at 0.5 (the
// shipping default — the bank's neutral middle).
//
// Rendering path: the REAL module def + factory. The 907A has NO worklet —
// it is PURE Web Audio (a fan of BiquadFilterNode/GainNode built by
// moog-filterbank-factory.ts), and native primitive nodes DO run under
// node-web-audio-api's OfflineAudioContext (plan §1.3 path #3; the WebAudio
// spec pins the biquad coefficient math exactly). So this scenario calls
// moog907aDef.factory() against an OfflineAudioContext and renders the
// EXACT shipping node graph — zero mirror, zero drift. Determinism was
// probed bit-identical in-process AND across processes before pinning.
//
// SIGNATURE output (owner decision §6b.2): the single mono `audio` out.
//
// The .sha pins the shared band-table lib + the shared factory wiring
// (repoSourceSha — the render path lives partly in packages/web). The def
// file itself is deliberately NOT pinned: its render-relevant contribution
// is passing the lib's constants through, and pinning it would churn the
// baseline on docs-prose edits (docs must never invalidate audio pins).

import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import { moog907aDef } from '$lib/audio/modules/moog907a';
import { pinAll, repoSourceSha, SAMPLE_RATE } from '../../setup/capture';
import { seededNoise } from '../../setup/drivers';

const SR = SAMPLE_RATE;
const DURATION_S = 1.0;

// The profile patch: every section (hp, band1..band8, lp) at its 0.5
// shipping default — applied EXPLICITLY so the render is a pure function
// of this file + the pinned factory/lib (ids come from the def so the
// param map can never drift out of lock-step with the module).
const LEVEL = 0.5;
const NOISE_AMP = 0.5;

async function renderProfile(): Promise<Record<string, Float32Array>> {
  const n = Math.round(SR * DURATION_S);
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: n, sampleRate: SR });
  const params = Object.fromEntries(moog907aDef.params.map((p) => [p.id, LEVEL]));
  const node = {
    id: 'profile',
    type: moog907aDef.type,
    position: { x: 0, y: 0 },
    params,
  } as unknown as Parameters<typeof moog907aDef.factory>[1];
  const handle = await moog907aDef.factory(ctx as unknown as AudioContext, node);

  // Seeded white-noise driver (bit-identical for the pinned seed).
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

// Goertzel magnitude (normalized 2/N) of freqHz over the whole buffer,
// averaged over a few probe bins so a single noisy bin can't dominate.
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

describe('ART moog907a / audio profile (seeded noise through the 8-band fixed bank, all levels 0.5)', () => {
  it('renders a finite, audible banked spectrum with the inter-band gap', async () => {
    const out = (await renderProfile()).audio!;
    expect(out.length).toBe(Math.round(SR * DURATION_S));
    expect(out.every(Number.isFinite)).toBe(true);
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThan(2);
    expect(rms(out)).toBeGreaterThan(0.02);
    // The bank's fingerprint: energy INSIDE the band grid (probe around the
    // 1 kHz centre) clearly beats the spectral HOLE between the top band
    // (2.8 kHz) and the 6.6 kHz high-pass shelf.
    const inBand = bandMag(out, [950, 1000, 1050]);
    const gap = bandMag(out, [4200, 4500, 4800]);
    expect(inBand).toBeGreaterThan(gap * 2);
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
    await pinAll('moog907a', srcSha, await renderProfile());
  });
});
