// art/scenarios/helm/envelope-shapes.test.ts
//
// Audio Regression Test scenarios for HELM — exercises the pure-math
// envelope mirror over multi-second renders to confirm the ADSR shape
// matches Helm's exponential-decay characteristic (mopo/src/envelope.cpp).
//
// Worklet-side spectral assertions (filter sweep, polyphonic mixing)
// require AudioWorkletGlobalScope which isn't available under vitest;
// those checks land in the E2E pass.

import { describe, it, expect } from 'vitest';
import { renderAdsr } from '../../../packages/web/src/lib/audio/modules/helm';

const SR = 48000;

describe('ART helm / amplitude envelope characteristic', () => {
  it('attack ramps linearly up to ~1.0 within the attack time', () => {
    const attack = 0.05; // 50ms
    const out = renderAdsr(
      { attack, decay: 8, sustain: 1, release: 1 },
      [{ sample: 0, on: true }],
      Math.floor(SR * 0.1),
      SR,
    );
    // At t = attack, value should be ~ 1.0
    const atAttack = out[Math.floor(SR * attack)]!;
    expect(atAttack).toBeGreaterThan(0.95);
    // At t = attack/2, value should be ~ 0.5 (linear).
    const halfway = out[Math.floor(SR * attack * 0.5)]!;
    expect(halfway).toBeGreaterThan(0.45);
    expect(halfway).toBeLessThan(0.55);
  });

  it('decay follows an exponential approach toward sustain', () => {
    // Long-decay test — render long enough to settle (>= 5 * decay).
    const decay = 0.1;
    const sustain = 0.2;
    const out = renderAdsr(
      { attack: 0.001, decay, sustain, release: 5 },
      [{ sample: 0, on: true }],
      Math.floor(SR * 1.0),
      SR,
    );
    // Sample at 2× decay-tau in (200ms) — should be between sustain (0.2)
    // and peak (1.0); after 2 time constants the gap is ~13.5%.
    const at2Tau = out[Math.floor(SR * decay * 2)]!;
    expect(at2Tau).toBeGreaterThan(sustain);
    expect(at2Tau).toBeLessThan(0.5);
    // Past 5× decay the env should be very close to sustain.
    const settled = out[out.length - 1]!;
    expect(Math.abs(settled - sustain)).toBeLessThan(1e-2);
  });

  it('release decays exponentially to zero', () => {
    const release = 0.1;
    const sustain = 0.6;
    const out = renderAdsr(
      { attack: 0.001, decay: 0.001, sustain, release },
      [
        { sample: 0, on: true },
        { sample: Math.floor(SR * 0.05), on: false },
      ],
      Math.floor(SR * 1.0),
      SR,
    );
    // At t = release/2 past the gate-off, value should be ~ sustain * exp(-0.5) ≈ 0.36
    const releaseStartIdx = Math.floor(SR * 0.05);
    const atHalfRelease = out[releaseStartIdx + Math.floor(SR * release * 0.5)]!;
    expect(atHalfRelease).toBeGreaterThan(0.2);
    expect(atHalfRelease).toBeLessThan(0.5);
    // Past 8× release the env is effectively zero.
    expect(out[out.length - 1]!).toBeLessThan(1e-3);
  });

  it('retriggering during release restarts the attack from current value 0', () => {
    // Helm semantics: a re-trigger resets value to 0 and begins attack again.
    const out = renderAdsr(
      { attack: 0.01, decay: 0.05, sustain: 0.5, release: 0.05 },
      [
        { sample: 0, on: true },
        { sample: Math.floor(SR * 0.1), on: false },        // gate off → release
        { sample: Math.floor(SR * 0.15), on: true },        // re-trigger
      ],
      Math.floor(SR * 0.4),
      SR,
    );
    // At re-trigger sample, value should be near 0 (reset).
    const retrigIdx = Math.floor(SR * 0.15);
    expect(out[retrigIdx]!).toBeLessThan(0.01);
    // Past the second attack+decay, env should reach sustain.
    const settled = out[Math.floor(SR * 0.35)]!;
    expect(settled).toBeGreaterThan(0.4);
    expect(settled).toBeLessThan(0.6);
  });
});
