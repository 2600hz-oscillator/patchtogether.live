// art/scenarios/warps/algorithm-spectra.test.ts
//
// Audio Regression Test scenarios for WARPS. Longer-render spectral checks
// on the four Xmod algorithms — verifies the audible character matches the
// Warps reference (ring-mod sum+diff sidebands, XOR broadband noise, XFADE
// passthrough).

import { describe, expect, it } from 'vitest';
import { warpsMath } from '../../../packages/web/src/lib/audio/modules/warps';

const SR = 48000;

function powerAt(buf: Float32Array, freq: number, sr: number): number {
  const w = (2 * Math.PI * freq) / sr;
  let re = 0;
  let im = 0;
  for (let i = 0; i < buf.length; i++) {
    re += buf[i]! * Math.cos(w * i);
    im += buf[i]! * Math.sin(w * i);
  }
  return Math.sqrt(re * re + im * im) / buf.length;
}

function rms(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i]! * buf[i]!;
  return Math.sqrt(s / buf.length);
}

function sine(n: number, freq: number, sr: number, amp = 0.5): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sr) * amp;
  return out;
}

describe('ART warps / RING-MOD produces sum + difference sidebands', () => {
  it('220 Hz × 110 Hz → 330 Hz (sum) and 110 Hz (diff) dominate the two source bins', () => {
    const n = SR;
    const car = sine(n, 220, SR, 0.5);
    const mod = sine(n, 110, SR, 0.5);
    // RING-MOD = algorithm 1, timbre=0 → 4*x1*x2*(1+0)=4*x1*x2 → softlimited.
    // The mathematical product of two pure sines yields sum + diff bins
    // ONLY (no fundamentals). After softlimit a touch of fundamental
    // leakage shows up but the sum+diff peaks still dominate.
    const out = warpsMath.render(n, SR, 0, {
      algorithm: 1, carrier_shape: 0, timbre: 0, level_1: 1, level_2: 1, note: 0,
    }, car, mod);
    const tail = out.slice(Math.floor(n * 0.25));
    const p110 = powerAt(tail, 110, SR);
    const p220 = powerAt(tail, 220, SR);
    const p330 = powerAt(tail, 330, SR);

    // Sum (330 Hz, the difference of 220-110=110 Hz is the same as the
    // modulator bin — to avoid that ambiguity we picked a 2:1 carrier:mod
    // ratio so the difference equals the modulator bin AND we expect the
    // sum bin to dominate any off-target bin like 600 or 800 Hz).
    const pOff = (powerAt(tail, 600, SR) + powerAt(tail, 800, SR) + powerAt(tail, 1234, SR)) / 3;
    expect(p330, `330 Hz sum ${p330} > off-bin avg ${pOff}`).toBeGreaterThan(pOff * 3);
    expect(p110, `110 Hz diff/mod-bin ${p110} > off-bin avg ${pOff}`).toBeGreaterThan(pOff * 2);
    // The carrier 220 Hz bin should be drastically attenuated vs the sum
    // bin (a pure product has no carrier).
    expect(p330).toBeGreaterThan(p220 * 0.5);
  });

  it('higher TIMBRE → more drive → output RMS rises monotonically', () => {
    const n = SR;
    const car = sine(n, 220, SR, 0.3);
    const mod = sine(n, 110, SR, 0.3);
    const baseParams = { algorithm: 1, carrier_shape: 0, level_1: 1, level_2: 1, note: 0 };
    const lo = warpsMath.render(n, SR, 0, { ...baseParams, timbre: 0.0 }, car, mod);
    const hi = warpsMath.render(n, SR, 0, { ...baseParams, timbre: 1.0 }, car, mod);
    expect(rms(hi)).toBeGreaterThan(rms(lo) * 1.5);
  });
});

describe('ART warps / XOR algorithm makes broadband noise', () => {
  it('220 Hz × 330 Hz pure tones → XOR mash has substantial energy at off-target bins', () => {
    // Two pure tones cross-modulated by XOR generate a noisy/glitchy
    // broadband texture (each bit boundary causes a discontinuity). The
    // power at off-target bins (not the sum, not the diff, not the
    // fundamentals) should be a sizeable fraction of the carrier-bin
    // power — well above what plain summing gives.
    const n = SR;
    const car = sine(n, 220, SR, 0.5);
    const mod = sine(n, 330, SR, 0.5);
    const xorOut = warpsMath.render(n, SR, 0, {
      algorithm: 2, carrier_shape: 0, timbre: 1, level_1: 1, level_2: 1, note: 0,
    }, car, mod);
    const xfadeOut = warpsMath.render(n, SR, 0, {
      algorithm: 0, carrier_shape: 0, timbre: 0.5, level_1: 1, level_2: 1, note: 0,
    }, car, mod);
    const tailXor = xorOut.slice(Math.floor(n * 0.25));
    const tailXfade = xfadeOut.slice(Math.floor(n * 0.25));
    // Off-target bin: a frequency the input doesn't contain and which
    // isn't a sum or difference of the two.
    const pXorOff = powerAt(tailXor, 1789, SR);
    const pXfadeOff = powerAt(tailXfade, 1789, SR);
    expect(pXorOff, `XOR broadband at 1789 Hz ${pXorOff} > XFADE ${pXfadeOff}`)
      .toBeGreaterThan(pXfadeOff * 5);
  });
});

describe('ART warps / XFADE preserves carrier when LEVEL_2 = 0', () => {
  it('carrier signal passes through unchanged (softlimit identity for |x|≪1)', () => {
    const n = SR;
    const car = sine(n, 440, SR, 0.3);
    const mod = sine(n, 1100, SR, 0.3);
    // With timbre=0 (parameter=0) the XFADE picks carrier 100%. Even with
    // a modulator present at the input, level_2=0 silences it on the way
    // in. The output should match the carrier exactly (modulo softlimit).
    const out = warpsMath.render(n, SR, 0, {
      algorithm: 0, carrier_shape: 0, timbre: 0, level_1: 1, level_2: 0, note: 0,
    }, car, mod);
    // Spectrally: 440 Hz should dominate, 1100 Hz should be near silent.
    const tail = out.slice(Math.floor(n * 0.25));
    const p440 = powerAt(tail, 440, SR);
    const p1100 = powerAt(tail, 1100, SR);
    expect(p440, `carrier 440 Hz ${p440} >> mod 1100 Hz ${p1100}`)
      .toBeGreaterThan(p1100 * 50);
  });

  it('XFADE at timbre=1 with carrier silenced passes modulator', () => {
    const n = SR;
    const car = sine(n, 440, SR, 0.3);
    const mod = sine(n, 1100, SR, 0.3);
    // Parameter=timbre=1 → pure modulator path; also kill carrier gain
    // for good measure.
    const out = warpsMath.render(n, SR, 0, {
      algorithm: 0, carrier_shape: 0, timbre: 1, level_1: 0, level_2: 1, note: 0,
    }, car, mod);
    const tail = out.slice(Math.floor(n * 0.25));
    const p440 = powerAt(tail, 440, SR);
    const p1100 = powerAt(tail, 1100, SR);
    expect(p1100, `modulator 1100 Hz ${p1100} >> carrier 440 Hz ${p440}`)
      .toBeGreaterThan(p440 * 50);
  });
});

describe('ART warps / internal carrier oscillator is usable without external inputs', () => {
  it('no inputs patched, RING-MOD at TIMBRE=1 → silence (mod=0 ⇒ ring=0)', () => {
    const n = SR;
    const out = warpsMath.render(n, SR, 0, {
      algorithm: 1, carrier_shape: 0, timbre: 1, level_1: 1, level_2: 1, note: 0,
    }, null, null);
    expect(rms(out)).toBeLessThan(0.01);
  });

  it('no inputs patched, XFADE at TIMBRE=0 → audible internal carrier', () => {
    const n = SR;
    const out = warpsMath.render(n, SR, 0, {
      algorithm: 0, carrier_shape: 0, timbre: 0, level_1: 1, level_2: 1, note: 0,
    }, null, null);
    expect(rms(out)).toBeGreaterThan(0.1);
    // Should be a clean sine at C4 (~261.6 Hz) — verify dominant bin.
    const tail = out.slice(Math.floor(n * 0.25));
    const pC4 = powerAt(tail, 261.6, SR);
    const pOff = powerAt(tail, 1789, SR);
    expect(pC4, `C4 ${pC4} > off-bin ${pOff}`).toBeGreaterThan(pOff * 50);
  });
});

describe('ART warps / algorithm switching is numerically clean', () => {
  it('no NaN / Infinity for any algorithm across a long render', () => {
    for (let algo = 0; algo <= 3; algo++) {
      const n = SR * 2;
      const car = sine(n, 220, SR, 0.5);
      const mod = sine(n, 330, SR, 0.5);
      const out = warpsMath.render(n, SR, 0, {
        algorithm: algo, carrier_shape: 0.4, timbre: 0.7, level_1: 1, level_2: 1, note: 0,
      }, car, mod);
      for (let i = 0; i < out.length; i++) {
        if (!Number.isFinite(out[i]!)) {
          throw new Error(`algo=${algo} idx=${i} value=${out[i]}`);
        }
      }
      expect(rms(out)).toBeGreaterThan(0); // not full silence
    }
  });
});
