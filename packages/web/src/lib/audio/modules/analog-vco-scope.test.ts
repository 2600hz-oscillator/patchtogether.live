// packages/web/src/lib/audio/modules/analog-vco-scope.test.ts
//
// Unit coverage for the ANALOG VCO on-card single-cycle scope's window
// extraction (findCycleWindow). The draw routine itself is canvas pixels
// (VRT-covered with the canvas masked), but the cycle-locking logic is pure
// and is where the "show exactly one period, tracking the modulated freq"
// behaviour lives — so it gets dedicated unit tests.

import { describe, expect, it } from 'vitest';
import { findCycleWindow } from './analog-vco-scope';

const SR = 48000;

// Build a sine buffer at `freq` Hz.
function sine(freq: number, n = 2048): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

describe('analogVco scope: findCycleWindow', () => {
  it('zero-crossing locks ~one period at the signal frequency', () => {
    const freq = 440;
    const win = findCycleWindow(sine(freq), SR, freq);
    expect(win.locked).toBe(true);
    const expectedPeriod = SR / freq; // ~109 samples
    // Locked window length should be within a sample or two of the true period.
    expect(Math.abs(win.length - expectedPeriod)).toBeLessThan(3);
  });

  it('locks the REAL period even when the knob-implied freq is wrong (FM/pitch case)', () => {
    // Signal is actually 880 Hz but the card was told 220 Hz (e.g. heavy FM).
    // Zero-crossing detection should still lock the true 880 Hz period.
    const real = 880;
    const win = findCycleWindow(sine(real), SR, 220);
    expect(win.locked).toBe(true);
    expect(Math.abs(win.length - SR / real)).toBeLessThan(3);
  });

  it('falls back to the knob-implied frequency on silence (no crossings)', () => {
    const silent = new Float32Array(2048); // all zeros
    const freq = 261.626;
    const win = findCycleWindow(silent, SR, freq);
    expect(win.locked).toBe(false);
    expect(win.length).toBe(Math.round(SR / freq));
  });

  it('clamps the window to the buffer length', () => {
    // Sub-audio "frequency" → implied period longer than the buffer.
    const buf = new Float32Array(256);
    const win = findCycleWindow(buf, SR, 1); // period = 48000 samples ≫ 256
    expect(win.length).toBeLessThanOrEqual(256);
  });

  it('returns at least 2 samples for a degenerate buffer', () => {
    const win = findCycleWindow(new Float32Array(2), SR, 440);
    expect(win.length).toBeGreaterThanOrEqual(2);
  });

  it('a saw waveform also locks one cycle', () => {
    const freq = 330;
    const n = 2048;
    const buf = new Float32Array(n);
    const period = SR / freq;
    for (let i = 0; i < n; i++) {
      const ph = (i % period) / period;
      buf[i] = 2 * ph - 1;
    }
    const win = findCycleWindow(buf, SR, freq);
    expect(win.locked).toBe(true);
    expect(Math.abs(win.length - period)).toBeLessThan(3);
  });
});
