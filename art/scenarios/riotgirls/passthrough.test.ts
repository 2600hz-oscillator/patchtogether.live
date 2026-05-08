// art/scenarios/riotgirls/passthrough.test.ts
//
// Toolchain validation for RIOTGIRLS — same shape as the mixmstrs scenario.
// RIOTGIRLS itself is composition-of-existing-modules at the JS engine
// layer (no single .dsp / .ts source); ART here verifies the new
// equal-power-pan Faust worklet that RIOTGIRLS depends on.
//
// When the render harness gains real OfflineAudioContext support, this
// file expands to scenarios per the plan §7:
//   - trigN individually fires expected spectral character
//   - 4-simultaneous voice mix
//   - pan -1 -> >30 dB L/R asymmetry
//   - voice-4 long envelope (release=4s -> audio still > -40 dBFS at t=4s)
//   - QBRT cutoff sweep

import { describe, it, expect } from 'vitest';
import { render, builtSha, moduleSourceSha } from '../../setup/render';

describe('riotgirls / equal-power-pan toolchain', () => {
  it('renders without throwing and produces non-empty buffer', async () => {
    const result = await render({ moduleName: 'equal-power-pan', durationS: 0.5 });
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.sampleRate).toBe(48000);
    const badIdx = result.buffer.findIndex((v) => !Number.isFinite(v));
    expect(badIdx, `non-finite sample at ${badIdx}`).toBe(-1);
  });

  it('SHA matches between equal-power-pan source and built artifact', async () => {
    const srcSha = await moduleSourceSha('equal-power-pan');
    const built = await builtSha('equal-power-pan');
    expect(built).toBe(srcSha);
  });
});

describe('riotgirls / pure pan-law characterization', () => {
  // Plan §7 calls for a pan test: -1 -> >30 dB L/R asymmetry. That belongs
  // in the OfflineAudioContext path once it lands, but we can pin the math
  // here by exercising the same equal-power formula the Faust DSP uses.
  // (We re-derive locally rather than importing from packages/web to keep
  // this scenario file self-contained — the web module's unit tests already
  // cover the JS implementation.)
  function pan(p: number): { l: number; r: number } {
    const c = Math.max(-1, Math.min(1, p));
    const theta = (c + 1) * (Math.PI / 4);
    return { l: Math.cos(theta), r: Math.sin(theta) };
  }
  function asymmetryDb(p: number): number {
    const { l, r } = pan(p);
    // Use a floor of -120 dB to avoid -Infinity at the hard-pan poles.
    const floor = 1e-6;
    return 20 * Math.log10(Math.max(l, floor) / Math.max(r, floor));
  }
  it('hard-left pan (-1) yields > 100 dB L/R asymmetry (well above 30 dB target)', () => {
    expect(asymmetryDb(-1)).toBeGreaterThan(100);
  });
  it('hard-right pan (+1) yields > 100 dB R/L asymmetry', () => {
    expect(-asymmetryDb(1)).toBeGreaterThan(100);
  });
  it('center pan yields ≈ 0 dB asymmetry', () => {
    expect(Math.abs(asymmetryDb(0))).toBeLessThan(0.01);
  });
});
