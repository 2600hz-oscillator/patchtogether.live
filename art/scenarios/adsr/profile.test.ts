// art/scenarios/adsr/profile.test.ts
//
// AUDIO PROFILE for ADSR (backfill Phase-0 pilot — spec §4.1/§4.3,
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md), through the
// shared capture harness (art/setup/capture.ts + drivers.ts).
//
// Category: ENVELOPE — driven by the canonical held-square gate (spec §4.2:
// gate high then released, ≥1.0 s so attack→decay→sustain→release are all
// visible in the gallery). Gate: high for 0.6 s of a 1.2 s render.
//
// SIGNATURE outputs only (owner decision §6b.2): `env` is captured;
// `env_inv` is skipped as a non-distinct inverse (1 − env carries no
// independent information).
//
// Rendering path: the pure-TS envelope core (packages/dsp/src/lib/adsr-env.ts
// `Envelope`, the shared per-voice ADSR state machine) — the accepted TS-pure
// canonical path (owner decision §6b.3); the live module's Faust en.adsr
// worklet cannot run under node-web-audio-api. Envelope stage times/sustain
// use the module's own defaults (packages/dsp/src/adsr.dsp sliders). The .sha
// therefore pins BOTH sources: a change to adsr.dsp OR adsr-env.ts forces an
// intentional `task art:update` re-capture.

import { describe, expect, it } from 'vitest';
import { Envelope } from '../../../packages/dsp/src/lib/adsr-env';
import { captureOutputs, dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { GATE_HI, heldGate } from '../../setup/drivers';

const SR = SAMPLE_RATE;
const DURATION_S = 1.2;
const GATE_ON_S = 0.6;

// packages/dsp/src/adsr.dsp slider defaults.
const ATTACK_S = 0.005;
const DECAY_S = 0.1;
const SUSTAIN = 0.7;
const RELEASE_S = 0.3;

function renderProfile(): Record<string, Float32Array> {
  const gate = heldGate({ totalS: DURATION_S, onS: GATE_ON_S });
  const env = new Envelope();
  let prevHigh = false;
  return captureOutputs({ durationS: DURATION_S, outputs: ['env'] }, (i) => {
    const high = gate[i]! >= GATE_HI;
    if (high !== prevHigh) {
      env.triggerHard(high);
      prevHigh = high;
    }
    return { env: env.tick(ATTACK_S, DECAY_S, SUSTAIN, RELEASE_S, SR) };
  });
}

describe('ART adsr / audio profile (canonical held gate)', () => {
  it('renders the full A-D-S-R shape, bounded and deterministic', () => {
    const buf = renderProfile().env!;
    expect(buf.length).toBe(Math.round(SR * DURATION_S));
    expect(buf.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)).toBe(true);
    // ATTACK: reaches the top within ~2× the 5 ms attack time.
    let peak = 0;
    for (let i = 0; i < Math.round(0.01 * SR); i++) peak = Math.max(peak, buf[i]!);
    expect(peak).toBeGreaterThan(0.99);
    // SUSTAIN: settled at the 0.7 plateau well after the 100 ms decay.
    expect(buf[Math.round(0.5 * SR)]!).toBeCloseTo(SUSTAIN, 2);
    // RELEASE: exponential fall after the gate drops at 0.6 s
    // (0.7·e^(−t/0.3): ≈0.257 at +300 ms, ≈0.095 at +600 ms).
    expect(buf[Math.round(0.9 * SR)]!).toBeLessThan(0.3);
    expect(buf[buf.length - 1]!).toBeLessThan(0.12);
    expect(buf[buf.length - 1]!).toBeGreaterThan(0);
    // Deterministic re-render.
    const again = renderProfile().env!;
    for (let i = 0; i < buf.length; i += 997) expect(again[i]).toBe(buf[i]);
  });

  it('pins the env profile baseline (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('adsr.dsp', 'lib/adsr-env.ts');
    await pinAll('adsr', srcSha, renderProfile());
  });
});
