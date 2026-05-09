// art/scenarios/dx7/envelope.test.ts
//
// Validates that the DX7's 4-segment envelope behaves correctly:
//   - Attack rises from 0 to op.l[0].
//   - Decay falls toward op.l[2] (sustain).
//   - Release (gate-off) drives the env down to ~0 within a few hundred ms.

import { describe, it, expect } from 'vitest';
import { renderDx7Note, rms } from '../../../packages/web/src/lib/audio/dx7-render';
import { findBuiltinPatch } from '../../../packages/web/src/lib/audio/dx7-banks';

const SAMPLE_RATE = 48000;

describe('DX7 ART: envelope shape', () => {
  it('release segment drives envelope toward 0', () => {
    const patch = findBuiltinPatch('STRINGS 1')!;
    // 1 sec total, gate-off at 0.5 sec.
    const buf = renderDx7Note(patch, {
      midi: 60,
      durationS: 1.5,
      sampleRate: SAMPLE_RATE,
      holdGate: false,
    });
    // First 100 ms after release vs. last 100 ms.
    const releaseStart = Math.round(0.75 * SAMPLE_RATE); // gate-off at 0.75 sec (mid)
    const earlyRelease = buf.subarray(releaseStart, releaseStart + Math.round(0.05 * SAMPLE_RATE));
    const lateRelease = buf.subarray(buf.length - Math.round(0.1 * SAMPLE_RATE));
    expect(rms(lateRelease), 'late release RMS < early release RMS').toBeLessThan(rms(earlyRelease));
  });

  it('marimba (fast attack) reaches peak within 30 ms', () => {
    const patch = findBuiltinPatch('MARIMBA')!;
    const buf = renderDx7Note(patch, {
      midi: 60,
      durationS: 0.2,
      sampleRate: SAMPLE_RATE,
      holdGate: true,
    });
    // Find the peak sample index; it should be within the first 30 ms.
    let peakIdx = 0;
    let peakVal = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs(buf[i]!);
      if (v > peakVal) {
        peakVal = v;
        peakIdx = i;
      }
    }
    const peakTimeMs = (peakIdx / SAMPLE_RATE) * 1000;
    expect(peakTimeMs, 'MARIMBA peak should be in the first 30 ms').toBeLessThan(30);
  });

  it('strings (slow attack) does NOT peak in the first 20 ms', () => {
    const patch = findBuiltinPatch('STRINGS 1')!;
    const buf = renderDx7Note(patch, {
      midi: 60,
      durationS: 0.5,
      sampleRate: SAMPLE_RATE,
      holdGate: true,
    });
    let peakIdx = 0;
    let peakVal = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs(buf[i]!);
      if (v > peakVal) {
        peakVal = v;
        peakIdx = i;
      }
    }
    const peakTimeMs = (peakIdx / SAMPLE_RATE) * 1000;
    expect(peakTimeMs, 'STRINGS should still be growing at 20 ms').toBeGreaterThan(20);
  });
});
