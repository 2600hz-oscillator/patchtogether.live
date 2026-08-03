// packages/web/src/lib/audio/modules/shimmershine.test.ts
//
// Unit tests for SHIMMERSHINE:
//   - module-def shape (ports, params, cvScale annotations)
//   - pitch-shifter math: a 440Hz sine driven through the pure-TS pitch
//     shifter exposed via shimmershineMath.renderPitchShifter produces
//     significant 880Hz energy (i.e. the granular-fade scheme actually
//     shifts an octave up).
//
// Worklet-level behavior (tank routing, feedback cap) is covered by the
// ART scenario which runs against a real OfflineAudioContext.

import { describe, expect, it } from 'vitest';
import { shimmershineMath, shimmershineDef } from './shimmershine';

const SR = 48000;

/** Mean, RMS and the AC (mean-removed) RMS of a buffer — the three numbers
 *  that tell DC and audio apart. A recirculating module can look perfectly
 *  healthy on RMS alone while being 100 % DC. */
function dcProfile(b: Float32Array): { mean: number; rms: number; ac: number; dcPct: number } {
  let sum = 0;
  for (const v of b) sum += v;
  const mean = sum / b.length;
  let sq = 0;
  let acSq = 0;
  for (const v of b) {
    sq += v * v;
    acSq += (v - mean) * (v - mean);
  }
  const rms = Math.sqrt(sq / b.length);
  const ac = Math.sqrt(acSq / b.length);
  return { mean, rms, ac, dcPct: rms > 0 ? (Math.abs(mean) / rms) * 100 : 0 };
}

/** A zero-mean noise burst then silence — the drive the tail is measured on. */
function noiseBurstThenSilence(burstS: number, tailS: number): Float32Array {
  const n = Math.round((burstS + tailS) * SR);
  const burstN = Math.round(burstS * SR);
  const buf = new Float32Array(n);
  // Deterministic LCG, zero-mean by construction.
  let s = 0x9e3779b9;
  for (let i = 0; i < burstN; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    buf[i] = (s / 0xffffffff) * 2 - 1;
  }
  return buf;
}

describe('shimmershineMath.hannWindow', () => {
  it('phase 0 and phase 1 both return 0 (window endpoints)', () => {
    expect(shimmershineMath.hannWindow(0)).toBeCloseTo(0, 6);
    expect(shimmershineMath.hannWindow(1)).toBeCloseTo(0, 6);
  });

  it('phase 0.5 returns the peak (= 1)', () => {
    expect(shimmershineMath.hannWindow(0.5)).toBeCloseTo(1, 6);
  });

  it('window stays in [0..1] across the full phase domain', () => {
    for (let i = 0; i <= 64; i++) {
      const phase = i / 64;
      const v = shimmershineMath.hannWindow(phase);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('granular pitch shifter: 440Hz → 880Hz octave-up shift', () => {
  it('output spectrum at rate=2 concentrates energy around 880Hz (octave up), not 440Hz', () => {
    const sr = 48000;
    const f0 = 440;
    const durS = 1.0;
    const n = Math.round(sr * durS);
    const input = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      input[i] = Math.sin((2 * Math.PI * f0 * i) / sr);
    }

    const out = shimmershineMath.renderPitchShifter(input, sr, 2.0, 25);

    // Use the second half of the output to skip pitch-shifter warmup.
    const slice = out.slice(Math.floor(out.length * 0.5));

    // Goertzel-style power at a target frequency.
    function powerAt(freq: number): number {
      const w = (2 * Math.PI * freq) / sr;
      let re = 0;
      let im = 0;
      for (let i = 0; i < slice.length; i++) {
        re += slice[i]! * Math.cos(w * i);
        im += slice[i]! * Math.sin(w * i);
      }
      return Math.sqrt(re * re + im * im) / slice.length;
    }

    // Band-sum power in a ±60Hz region around a target. The granular-fade
    // shifter's Hann window produces AM sidebands at f ± (1/windowMs), so
    // the octave-up energy appears in a small cluster around 880Hz rather
    // than at exactly 880Hz. Test by integrating the band instead.
    function bandPower(centre: number, bandHz: number): number {
      let total = 0;
      // 10Hz step is fine for a ±60Hz band — that's 12+ samples per band.
      for (let f = centre - bandHz; f <= centre + bandHz; f += 10) {
        total += powerAt(f);
      }
      return total;
    }

    const bandAt440 = bandPower(440, 60);
    const bandAt880 = bandPower(880, 60);
    const bandAt220 = bandPower(220, 60);

    // Octave-up band must dominate fundamental band by a clear margin.
    expect(
      bandAt880,
      `880Hz band ${bandAt880}, 440Hz band ${bandAt440}, 220Hz band ${bandAt220}`,
    ).toBeGreaterThan(bandAt440 * 5);
    // 220Hz (sub-octave) should be the smallest of the three.
    expect(bandAt220).toBeLessThan(bandAt880);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DC — the assertion this module shipped without, and the P0 it was hiding.
//
// SHIMMERSHINE's headline feature is described on the def as "a continuous,
// level-bounded crystalline drone". Past a threshold in SHIMMER the sustained
// state was not crystalline and was not audio: it was a pure DC RAIL. The
// round-trip DC gain of the regeneration loop is `shimmer × 0.55 / (1 − fb)`
// and NOTHING in the loop attenuated DC — the damping one-pole has unity DC
// gain for any damp < 1, the Schroeder allpass passes DC at unity, and the
// shifter's two Hann head-gains sum to exactly 1. So the loop crossed unity at
// SHIMMER ≈ 0.388, and THE SHIPPED DEFAULT IS 0.4.
//
// Why nothing caught it: every existing test here and in
// art/scenarios/shimmershine measures a Goertzel bin (440/880 Hz), and a DC
// rail is invisible to a Goertzel at any non-zero frequency. The ART scenario
// even has a leg NAMED "the late tail should not be DC-loaded" — which only
// asserts `Number.isFinite`. Two instruments, both blind to the exact
// quantity in their own titles.
// ─────────────────────────────────────────────────────────────────────────
describe('shimmershine: the tail is AUDIO, not a DC rail', () => {
  const TANK = { decay: 0.6, size: 0.6, damp: 0.4, mix: 1 };

  it('at the SHIPPED DEFAULTS the sustained tail carries essentially no DC', () => {
    const shimmerDefault = shimmershineDef.params.find((p) => p.id === 'shimmer')!.defaultValue;
    expect(shimmerDefault, 'this test is calibrated to the shipped default').toBe(0.4);

    const input = noiseBurstThenSilence(1, 24);
    const out = shimmershineMath.renderShimmer(input, SR, { ...TANK, shimmer: shimmerDefault });
    const tail = out.slice(out.length - Math.round(2 * SR));
    const p = dcProfile(tail);
    expect(
      p.dcPct,
      `at the shipped default shimmer=${shimmerDefault} the 23-25 s tail is ` +
        `${p.dcPct.toFixed(1)} % DC (mean ${p.mean.toExponential(3)}, rms ` +
        `${p.rms.toExponential(3)}, ac ${p.ac.toExponential(3)}). A DC rail is ` +
        `inaudible AND speaker-hostile; the module promises a crystalline drone.`,
    ).toBeLessThan(5);
  });

  it('even at SHIMMER 1 — the deliberate drone — the sustain is AC, and bounded', () => {
    const input = noiseBurstThenSilence(1, 24);
    const out = shimmershineMath.renderShimmer(input, SR, { ...TANK, shimmer: 1 });
    const tail = out.slice(out.length - Math.round(2 * SR));
    const p = dcProfile(tail);
    expect(
      p.dcPct,
      `shimmer=1 tail is ${p.dcPct.toFixed(1)} % DC (mean ${p.mean.toExponential(3)}, ` +
        `rms ${p.rms.toExponential(3)}). Measured before the DC blocker: 100.0 % ` +
        `at a mean of +0.98 — a full-scale rail with no headroom left.`,
    ).toBeLessThan(5);
    expect(Math.abs(p.mean), 'no DC offset on the output at all').toBeLessThan(0.01);
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(peak, `shimmer=1 peak ${peak}`).toBeLessThan(1.5);
  });

  // ── NEGATIVE CONTROL on the instrument ──────────────────────────────────
  // `dcProfile` must be able to SEE a DC rail, or the two assertions above
  // are decoration. Feed the analyser a signal that IS one.
  it('NEGATIVE CONTROL: dcProfile reports ~100 % on an actual rail, ~0 % on a sine', () => {
    const rail = new Float32Array(4800).fill(0.7);
    expect(dcProfile(rail).dcPct).toBeGreaterThan(99);
    const sine = new Float32Array(4800);
    for (let i = 0; i < sine.length; i++) sine[i] = Math.sin((2 * Math.PI * 100 * i) / SR);
    expect(dcProfile(sine).dcPct).toBeLessThan(1);
  });

  // ── The SHIMMER knob must still do its job. ─────────────────────────────
  // A DC blocker that also killed the regeneration would pass everything
  // above. This is the leg that stops the fix from being "delete the feature".
  it('NEGATIVE CONTROL: SHIMMER still lengthens the tail (the loop is alive)', () => {
    const input = noiseBurstThenSilence(1, 9);
    const late = (shimmer: number): number => {
      const out = shimmershineMath.renderShimmer(input, SR, { ...TANK, shimmer });
      const seg = out.slice(Math.round(7 * SR), Math.round(9 * SR));
      let sq = 0;
      for (const v of seg) sq += v * v;
      return Math.sqrt(sq / seg.length);
    };
    const off = late(0);
    const on = late(1);
    expect(
      on,
      `late-tail RMS at shimmer 0 = ${off.toExponential(3)}, at shimmer 1 = ${on.toExponential(3)}`,
    ).toBeGreaterThan(off * 10);
  });

  // ── DAMP at 1 must not leave a frozen DC residue. ───────────────────────
  // `fbStore = fbStore * damp + y * (1 - damp)` degenerates to
  // `fbStore = fbStore` at damp === 1, freezing the lowpass at whatever it
  // happened to hold and injecting that constant into every comb write
  // forever. Two shipped comments say it "freezes at zero" — true only from a
  // cold spawn, which is the only way the tests ever ran it.
  it('DAMP at 1 stops the tank instead of parking it on a rail', () => {
    const input = noiseBurstThenSilence(1, 3);
    const held = shimmershineMath.renderShimmer(input, SR, { ...TANK, damp: 1, shimmer: 0.4 });
    const tail = held.slice(held.length - Math.round(1 * SR));
    const p = dcProfile(tail);
    expect(
      Math.abs(p.mean),
      `damp=1 tail mean ${p.mean.toExponential(3)} — DAMP full up is the ` +
        `documented panic move; it must stop the tank, not park it on a rail`,
    ).toBeLessThan(1e-4);
  });
});
