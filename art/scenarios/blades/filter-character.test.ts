// art/scenarios/blades/filter-character.test.ts
//
// Audio Regression Tests for BLADES. Long-render checks of:
//   • LP roll-off slope vs an octave above cutoff (~12 dB/oct ZDF SVF)
//   • BP peak shape — energy clusters at fc, falls off either side
//   • HP mirror of LP — passes high, attenuates low
//   • COLOR knob adds harmonic content on a sine input (THD rises)
//   • Mix-mode toggle changes the mix bus spectrum on a 2-input patch
//
// Single-sine probes are far more numerically stable than a pink-noise
// spectrum probe (a leaky-integrated noise source has its own roll-off
// that contaminates the measurement). Each probe synthesises a pure
// sine, runs it through the math mirror, and reads the settled-tail
// amplitude with Goertzel. The unit tests pin the shape; ART pins the
// settled-tail magnitudes across a longer render.

import { describe, expect, it } from 'vitest';
import { bladesMath } from '../../../packages/web/src/lib/audio/modules/blades';

const SR = 48000;

function bandAmp(buf: Float32Array, freqHz: number, sr: number): number {
  const w = 2 * Math.PI * freqHz / sr;
  let re = 0; let im = 0;
  for (let i = 0; i < buf.length; i++) {
    re += buf[i]! * Math.cos(w * i);
    im += buf[i]! * Math.sin(w * i);
  }
  return 2 * Math.sqrt(re * re + im * im) / buf.length;
}

function sineBuf(freqHz: number, frames: number, sr: number, amp = 0.5): Float32Array {
  const b = new Float32Array(frames);
  for (let i = 0; i < frames; i++) b[i] = amp * Math.sin(2 * Math.PI * freqHz * i / sr);
  return b;
}

// Drive a single sine through one core and return the post-settle band
// amplitude at the input frequency.
function probeMagnitude(
  mode: 0 | 1 | 2,
  sigHz: number,
  fcHz: number,
  res = 0.2,
  frames = SR,
): number {
  const sig = sineBuf(sigHz, frames, SR, 0.5);
  const { out1 } = bladesMath.render(sig, null, frames, {
    cutoff1: fcHz, cutoff2: fcHz, res1: res, res2: res,
    mode1: mode, mode2: mode, color: 0, mixMode: 0, sr: SR,
  });
  const tail = out1.slice(Math.floor(SR * 0.2));
  return bandAmp(tail, sigHz, SR);
}

describe('ART blades / LP roll-off matches a ~12 dB/oct slope (ZDF SVF)', () => {
  it('1 kHz LP: 500 Hz passes ≈ unity; 4 kHz down ≥ 6×; 8 kHz down ≥ 16×', () => {
    const fc = 1000;
    const aPass = probeMagnitude(0, 500, fc);   // half-octave below — passband
    const a4k   = probeMagnitude(0, 4000, fc);  // 2 oct above
    const a8k   = probeMagnitude(0, 8000, fc);  // 3 oct above
    expect(aPass, `passband (500 Hz) amp ≈ 0.5: ${aPass}`).toBeGreaterThan(0.35);
    // -12 dB/oct ideal → 4 kHz is 4 octaves of 6 dB = 24 dB down on a
    // single-pole at fc=1k. SVF k=1.6 (res=0.2) gives a ~Q=0.6 response,
    // so the slope holds reasonably above fc.
    expect(aPass / a4k, `1k LP 500→4k attenuation ratio: ${aPass / a4k}`).toBeGreaterThan(6);
    expect(aPass / a8k, `1k LP 500→8k attenuation ratio: ${aPass / a8k}`).toBeGreaterThan(16);
    // Monotonic decrease above fc.
    expect(a4k, `4k louder than 8k`).toBeGreaterThan(a8k);
  });
});

describe('ART blades / BP at fc=1 kHz peaks at fc and falls off either side', () => {
  it('peak at 1 kHz exceeds 250 Hz and 4 kHz side bands', () => {
    const fc = 1000;
    // Use moderate resonance to widen the peak so the probe doesn't fall
    // off a too-narrow needle.
    const center = probeMagnitude(1, 1000, fc, 0.4);
    const lowSide = probeMagnitude(1, 250, fc, 0.4);
    const hiSide  = probeMagnitude(1, 4000, fc, 0.4);
    expect(center, `BP peak ${center} vs low ${lowSide}`).toBeGreaterThan(lowSide * 2);
    expect(center, `BP peak ${center} vs hi ${hiSide}`).toBeGreaterThan(hiSide * 2);
  });
});

describe('ART blades / HP at fc=1 kHz mirrors LP — passes high, kills low', () => {
  it('8 kHz passes ≈ unity, 100 Hz attenuated by ≥ 50×', () => {
    const fc = 1000;
    const pass = probeMagnitude(2, 8000, fc);
    const stop = probeMagnitude(2, 100,  fc);
    expect(pass, `HP pass(8k)=${pass}`).toBeGreaterThan(0.35);
    expect(pass / stop, `HP pass:stop ratio (≥50): ${pass / stop}`).toBeGreaterThan(50);
  });
});

describe('ART blades / COLOR knob adds harmonic content on a sine input', () => {
  it('THD-ish ratio (sum of 2nd+3rd+5th harmonics / fund) is higher at COLOR=1', () => {
    const FRAMES = SR;
    const fund = 440;
    const sig = sineBuf(fund, FRAMES, SR, 0.8);
    const clean = bladesMath.render(sig, null, FRAMES, {
      cutoff1: 12000, cutoff2: 12000, res1: 0.1, res2: 0.1,
      mode1: 0, mode2: 0, color: 0, mixMode: 0, sr: SR,
    });
    const dirty = bladesMath.render(sig, null, FRAMES, {
      cutoff1: 12000, cutoff2: 12000, res1: 0.1, res2: 0.1,
      mode1: 0, mode2: 0, color: 1, mixMode: 0, sr: SR,
    });
    const thd = (out: Float32Array): number => {
      const tail = out.slice(Math.floor(SR * 0.2));
      const f = bandAmp(tail, fund, SR);
      const h2 = bandAmp(tail, fund * 2, SR);
      const h3 = bandAmp(tail, fund * 3, SR);
      const h5 = bandAmp(tail, fund * 5, SR);
      return (h2 + h3 + h5) / Math.max(1e-9, f);
    };
    const tClean = thd(clean.out1);
    const tDirty = thd(dirty.out1);
    expect(tClean, `clean THD ≈ 0: ${tClean}`).toBeLessThan(0.01);
    expect(tDirty, `dirty THD: ${tDirty}`).toBeGreaterThan(0.1);
    expect(tDirty, `COLOR=1 (${tDirty}) vs COLOR=0 (${tClean}): ≥10× richer`)
      .toBeGreaterThan(tClean * 10);
  });
});

describe('ART blades / mix-mode toggle changes the mix bus spectrum', () => {
  it('PARALLEL passes both 440 Hz (in1) and 880 Hz (in2); SERIAL drops in2', () => {
    const FRAMES = SR;
    const a = sineBuf(440, FRAMES, SR, 0.4);
    const b = sineBuf(880, FRAMES, SR, 0.4);
    const par = bladesMath.render(a, b, FRAMES, {
      cutoff1: 2000, cutoff2: 2000, res1: 0.2, res2: 0.2,
      mode1: 0, mode2: 0, color: 0, mixMode: 0, sr: SR,
    });
    const ser = bladesMath.render(a, b, FRAMES, {
      cutoff1: 2000, cutoff2: 2000, res1: 0.2, res2: 0.2,
      mode1: 0, mode2: 0, color: 0, mixMode: 1, sr: SR,
    });
    const parA = bandAmp(par.mix.slice(Math.floor(SR * 0.2)), 440, SR);
    const parB = bandAmp(par.mix.slice(Math.floor(SR * 0.2)), 880, SR);
    const serA = bandAmp(ser.mix.slice(Math.floor(SR * 0.2)), 440, SR);
    const serB = bandAmp(ser.mix.slice(Math.floor(SR * 0.2)), 880, SR);
    expect(parA, `parallel mix has 440: ${parA}`).toBeGreaterThan(0.1);
    expect(parB, `parallel mix has 880: ${parB}`).toBeGreaterThan(0.05);
    expect(serA, `serial mix has 440: ${serA}`).toBeGreaterThan(0.05);
    expect(serB, `serial mix drops 880 (in2 ignored): ${serB}`).toBeLessThan(parB * 0.4);
  });
});

describe('ART blades / serial mode == filter1 → filter2 cascade', () => {
  it('SERIAL mix has steeper roll-off above fc than a single filter', () => {
    // Two LPs at fc=1k cascaded → 24 dB/oct on a sine octaves above.
    const FRAMES = SR;
    const fc = 1000;
    const sig = sineBuf(8000, FRAMES, SR, 0.5);
    // Single-filter comparison: drive in1, read out1.
    const single = bladesMath.render(sig, null, FRAMES, {
      cutoff1: fc, cutoff2: fc, res1: 0.2, res2: 0.2,
      mode1: 0, mode2: 0, color: 0, mixMode: 0, sr: SR,
    });
    // Serial: drive in1, read mix (which is filter2(filter1(in1))).
    const serial = bladesMath.render(sig, null, FRAMES, {
      cutoff1: fc, cutoff2: fc, res1: 0.2, res2: 0.2,
      mode1: 0, mode2: 0, color: 0, mixMode: 1, sr: SR,
    });
    const singleAmp = bandAmp(single.out1.slice(Math.floor(SR * 0.2)), 8000, SR);
    const serialAmp = bandAmp(serial.mix.slice(Math.floor(SR * 0.2)), 8000, SR);
    expect(serialAmp, `serial cascade ${serialAmp} ≤ single ${singleAmp}`)
      .toBeLessThan(singleAmp);
    // Cascaded 12 dB/oct gives an additional ~24 dB at 3 octaves up vs single.
    expect(singleAmp / Math.max(1e-12, serialAmp), `extra rolloff ratio ≥ 4`).toBeGreaterThan(4);
  });
});
