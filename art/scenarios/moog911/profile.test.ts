// art/scenarios/moog911/profile.test.ts
//
// AUDIO PROFILE for MOOG 911 (envelope / contour generator) (backfill
// batch 3 — spec §4.1/§4.3,
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md), through the
// shared capture harness (art/setup/capture.ts + drivers.ts + worklet.ts).
//
// Category: ENVELOPE / MODULATOR — driven by the canonical HELD-SQUARE GATE
// (spec §4.2: heldGate from $lib/audio/gate-trigger semantics), ≥1.0 s so
// the full contour is visible: gate high for 0.6 s of a 1.5 s render.
//
// Patch: the SHIPPING DEFAULTS (t1 0.01 s attack, t2 0.2 s initial decay,
// Esus 0.6 sustain level, t3 0.4 s final decay) — the 911 is a THREE-time-
// constant contour generator, not a literal ADSR, and the default patch
// shows all four phases in one window: fast rise to 1.0, rounded decay to
// the 0.6 sustain shelf, hold, then the T3 exponential release to 0.
//
// Rendering path: the REAL worklet processor class (bluebox batch-1
// pattern, via the shared art/setup/worklet.ts shim loader). moog911.ts is
// self-contained pure math — a thin AudioWorkletProcessor around the
// Moog911Eg core (lib/moog911-eg-dsp.ts), no RNG — so this render IS the
// shipping DSP, gate thresholding and all.
//
// SIGNATURE output (owner decision §6b.2): `env` only. The worklet's second
// port env_inv is EXACTLY 1 − env (asserted bit-exact below) — an affine
// duplicate with no independent information, so it shares the one profile
// (the bus-duplicate rule, spec §4.1).
//
// The .sha pins BOTH the worklet entry and the contour core
// (combinedSourceSha discipline) so a change in either forces an
// intentional `task art:update`.

import { describe, expect, it } from 'vitest';
import { dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { heldGate } from '../../setup/drivers';
import { captureWorkletProcessor, renderWorklet } from '../../setup/worklet';

const SR = SAMPLE_RATE;
const DURATION_S = 1.5;
const GATE_ON_S = 0.6;

// Shipping defaults (the worklet's parameterDescriptors defaults).
const T1 = 0.01;
const T2 = 0.2;
const ESUS = 0.6;
const T3 = 0.4;

async function renderProfile(): Promise<{ env: Float32Array; envInv: Float32Array }> {
  const Proc = await captureWorkletProcessor(
    'moog911',
    () => import('../../../packages/dsp/src/moog911'),
    SR,
  );
  const proc = new Proc();
  const n = Math.round(SR * DURATION_S);
  const bufs = renderWorklet(proc, {
    totalSamples: n,
    // inputs[0] = gate (S-trigger; >= 0.5 high).
    inputs: [heldGate({ totalS: DURATION_S, onS: GATE_ON_S })],
    params: { t1: T1, t2: T2, esus: ESUS, t3: T3 },
    outputs: ['env', 'env_inv'],
  });
  return { env: bufs.env!, envInv: bufs.env_inv! };
}

const at = (s: number) => Math.round(s * SR);

describe('ART moog911 / audio profile (default contour under a 0.6 s held gate)', () => {
  it('renders rise→initial-decay→sustain shelf→final decay, env_inv the exact mirror', async () => {
    const { env, envInv } = await renderProfile();
    expect(env.length).toBe(Math.round(SR * DURATION_S));
    expect(env.every(Number.isFinite)).toBe(true);
    // Contour is bounded 0..1.
    let lo = Infinity;
    let peak = -Infinity;
    for (const v of env) {
      if (v < lo) lo = v;
      if (v > peak) peak = v;
    }
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(peak).toBeLessThanOrEqual(1);
    // ATTACK: t1=0.01 s covers ~99% in 10 ms — the peak hits 1.0 (the stage
    // machine snaps to exactly 1.0 when it flips to DECAY).
    expect(peak).toBe(1);
    expect(Math.max(...env.subarray(0, at(0.05)))).toBe(1);
    // INITIAL DECAY → SUSTAIN: by 0.5 s the contour sits on the Esus shelf.
    expect(env[at(0.5)]!).toBeGreaterThan(0.59);
    expect(env[at(0.5)]!).toBeLessThan(0.61);
    // FINAL DECAY: falling after the gate drops at 0.6 s…
    expect(env[at(0.7)]!).toBeLessThan(0.59);
    // …and fully released well before the end (t3=0.4 s, 5τ ≈ 99.3%).
    expect(env[at(1.45)]!).toBeLessThan(1e-3);
    // env_inv is the exact 1 − env mirror (to float32 rounding) — no
    // independent info, so it is not pinned separately (signature rule).
    let mirrorErr = 0;
    for (let i = 0; i < env.length; i++) {
      mirrorErr = Math.max(mirrorErr, Math.abs(envInv[i]! - (1 - env[i]!)));
    }
    expect(mirrorErr).toBeLessThan(1e-6);
    // Deterministic re-render is bit-identical (fresh processor instance).
    const again = (await renderProfile()).env;
    let diff = 0;
    for (let i = 0; i < env.length; i++) diff = Math.max(diff, Math.abs(env[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the env profile baseline (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('moog911.ts', 'lib/moog911-eg-dsp.ts');
    const { env } = await renderProfile();
    await pinAll('moog911', srcSha, { env });
  });
});
