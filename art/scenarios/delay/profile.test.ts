// art/scenarios/delay/profile.test.ts
//
// AUDIO PROFILE for DELAY (single-tap delay line + feedback + mix) (backfill
// batch 5 — spec §4.1/§4.3,
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md), through the
// shared capture harness (capture.ts + drivers.ts + offline.ts).
//
// Category: TIME-BASED FX with a decaying tail — the canonical TRANSIENT
// driver (a short tone BURST at t=0, then silence) so the profile IS the
// ringing echo train, not a steady tone (the cofefve batch-2 precedent).
// A 40 ms C4-saw burst hits a 150 ms delay at 0.6 feedback / 0.5 mix, so the
// output is: the dry hit, then a first echo at 150 ms and successive echoes
// every 150 ms, each 0.6× the last — the module's defining behavior.
//
// Rendering path: the REAL def factory (delay is a native DelayNode + a
// feedback GainNode loop — no worklet) under node-web-audio-api's
// OfflineAudioContext via the shared renderOfflineDef helper (plan §1.3
// path #3). NOTE: renderOfflineDef applies params at CONSTRUCTION (no
// setParam), so the dry/wet split is the factory's linear construction-time
// mix (dry = 1−mix, wet = mix), not the equal-power setParam crossfade — a
// fixed, fully deterministic graph.
//
// SIGNATURE output (owner decision §6b.2): the single `audio` out (dry + the
// feedback echo tail).
//
// The .sha pins the def file with its co-located docs stripped
// (docs-hash-ignore markers — docs edits must never invalidate audio pins).

import { describe, expect, it } from 'vitest';
import { delayDef } from '$lib/audio/modules/delay';
import { docsStrippedRepoSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { toneBurst } from '../../setup/drivers';
import { renderOfflineDef } from '../../setup/offline';

const SR = SAMPLE_RATE;
const DURATION_S = 1.0; // ≥1 s to capture several echoes of the tail (spec §4.1)
const TIME_S = 0.15; // 150 ms between echoes
const FEEDBACK = 0.6; // ~0.6× decay per repeat
const MIX = 0.5; // dry = 0.5, wet = 0.5 at construction
const BURST_S = 0.04; // a short 40 ms hit
const BURST_AMP = 0.6;

const input = toneBurst({ totalS: DURATION_S, burstS: BURST_S, shape: 'saw', amp: BURST_AMP });

async function renderProfile(): Promise<Record<string, Float32Array>> {
  return renderOfflineDef(delayDef, {
    durationS: DURATION_S,
    params: { time: TIME_S, feedback: FEEDBACK, mix: MIX },
    inputs: { audio: input },
    outputs: ['audio'],
  });
}

function rms(b: Float32Array, s: number, e: number): number {
  let x = 0;
  for (let i = s; i < e; i++) x += b[i]! * b[i]!;
  return Math.sqrt(x / Math.max(1, e - s));
}
const at = (t: number) => Math.round(t * SR);

describe('ART delay / audio profile (a 40 ms burst echoed every 150 ms, decaying ~0.6× per tap)', () => {
  it('emits the dry hit then a decaying feedback echo train', async () => {
    const out = (await renderProfile()).audio!;
    const n = Math.round(SR * DURATION_S);
    expect(out.length).toBe(n);
    expect(out.every(Number.isFinite)).toBe(true);

    // The dry hit sits at t=0; echoes land at 0.15, 0.30, 0.45 s. Measure the
    // energy in a short window around each, plus a quiet gap between them.
    const dry = rms(out, at(0.0), at(BURST_S));
    const echo1 = rms(out, at(TIME_S), at(TIME_S + BURST_S));
    const echo2 = rms(out, at(2 * TIME_S), at(2 * TIME_S + BURST_S));
    const echo3 = rms(out, at(3 * TIME_S), at(3 * TIME_S + BURST_S));
    const gap = rms(out, at(BURST_S + 0.04), at(TIME_S - 0.01)); // between dry & echo1

    // Dry present; each echo present but strictly quieter than the previous —
    // the feedback decay is the signature.
    expect(dry).toBeGreaterThan(0.05);
    expect(echo1).toBeGreaterThan(0.02);
    expect(echo1).toBeLessThan(dry);
    expect(echo2).toBeGreaterThan(0.01);
    expect(echo2).toBeLessThan(echo1);
    expect(echo3).toBeGreaterThan(0.004);
    expect(echo3).toBeLessThan(echo2);
    // The gap between the dry hit and the first echo is near-silent.
    expect(gap).toBeLessThan(echo1 / 2);

    // Bounded — the 0.95-ceilinged feedback can't run away (no clipping/NaN).
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]!));
    expect(peak).toBeLessThan(1);

    // Deterministic re-render is bit-identical (fixed offline feedback graph).
    const again = (await renderProfile()).audio!;
    let diff = 0;
    for (let i = 0; i < n; i++) diff = Math.max(diff, Math.abs(out[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the audio profile baseline (SHA-gated, RMS tier B)', async () => {
    const srcSha = await docsStrippedRepoSourceSha('packages/web/src/lib/audio/modules/delay.ts');
    await pinAll('delay', srcSha, await renderProfile());
  });
});
