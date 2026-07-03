// packages/dsp/src/lib/analog-delay-core.test.ts
//
// Behavioral proof for the OWN-CODE AnalogDelayCore (the COFEFVE DELAY
// engine). These assert the SPEC'd effect — echo at the delay time, a decaying
// feedback train, tempo sync, wow/flutter modulation, wet/dry split, ducking,
// drive, feedback stability, and the L==R bus-duplicate + determinism the ART
// profile relies on — NOT bit-exact numbers.

import { describe, it, expect } from 'vitest';
import { AnalogDelayCore, type AnalogDelaySettings, SYNC_BEATS } from './analog-delay-core';

const SR = 48000;

/** A full default settings object; override per test. */
function settings(over: Partial<AnalogDelaySettings> = {}): AnalogDelaySettings {
  return {
    delayTime: 0.2,
    tempoSync: 0,
    beatPeriodS: 0,
    lfoAmount: 0,
    lfoFrequency: 2,
    driftAmount: 0,
    driftSpeed: 1,
    feedback: 0.5,
    stereoOffset: 0,
    pan: 0,
    panMode: 0,
    duckAmount: 0,
    duckAttack: 10,
    duckRelease: 10,
    filterMode: 0,
    lowCut: 1,
    highCut: 0.001,
    driveGain: 0,
    driveMix: 1,
    driveCutoff: 1,
    driveIterations: 1,
    dryVolume: 1,
    wetVolume: 0.5,
    ...over,
  };
}

/** Render `seconds` of mono input (fed to both L+R) and return outL. */
function render(
  core: AnalogDelayCore,
  s: AnalogDelaySettings,
  seconds: number,
  inputFn: (n: number) => number,
): Float32Array {
  const n = Math.round(SR * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = inputFn(i);
    core.processSample(s, v, v);
    out[i] = core.outL;
  }
  return out;
}

function peakIndex(buf: Float32Array, from = 0): number {
  let bi = from;
  let bv = -Infinity;
  for (let i = from; i < buf.length; i++) {
    const a = Math.abs(buf[i]!);
    if (a > bv) {
      bv = a;
      bi = i;
    }
  }
  return bi;
}

function energy(buf: Float32Array, from = 0, to = buf.length): number {
  let e = 0;
  for (let i = from; i < to; i++) e += buf[i]! * buf[i]!;
  return e;
}

describe('AnalogDelayCore — SYNC_BEATS table', () => {
  it('has a quarter note (index 6) == exactly 1 beat', () => {
    expect(SYNC_BEATS[6]).toBe(1);
    expect(SYNC_BEATS[0]).toBe(0); // Off sentinel
    expect(SYNC_BEATS.length).toBe(20);
  });
});

describe('AnalogDelayCore — echo timing + decay', () => {
  it('an impulse produces a wet echo near the configured delay time', () => {
    const core = new AnalogDelayCore(SR);
    const s = settings({ delayTime: 0.1, feedback: 0, dryVolume: 0, wetVolume: 1 });
    const out = render(core, s, 0.3, (n) => (n === 0 ? 1 : 0));
    const pk = peakIndex(out, 1);
    const expected = 0.1 * SR;
    // Cubic interp + the ~10 ms read-pointer easing smear the peak — a generous
    // window (the point is "a delayed echo near the configured time").
    expect(pk).toBeGreaterThan(expected * 0.5);
    expect(pk).toBeLessThan(expected * 1.6);
  });

  it('feedback yields a DECAYING train of repeats; more feedback = louder tail', () => {
    const s = (fb: number) =>
      settings({ delayTime: 0.05, feedback: fb, dryVolume: 0, wetVolume: 1 });
    const low = render(new AnalogDelayCore(SR), s(0.3), 0.4, (n) => (n === 0 ? 1 : 0));
    const high = render(new AnalogDelayCore(SR), s(0.75), 0.4, (n) => (n === 0 ? 1 : 0));
    const tailFrom = Math.round(0.2 * SR); // ~4 repeats in
    const eLow = energy(low, tailFrom);
    const eHigh = energy(high, tailFrom);
    expect(eLow).toBeGreaterThan(0); // there IS a decaying tail
    expect(eHigh).toBeGreaterThan(eLow); // higher feedback rings longer
    // And it decays within one render: late energy << early echo energy.
    const early = energy(high, Math.round(0.04 * SR), Math.round(0.12 * SR));
    const late = energy(high, Math.round(0.32 * SR), Math.round(0.4 * SR));
    expect(late).toBeLessThan(early);
  });
});

describe('AnalogDelayCore — tempo sync', () => {
  it('tempoSync = 1/4 locks the echo to one beat period (beatPeriodS), not the TIME fallback', () => {
    const core = new AnalogDelayCore(SR);
    const beatS = 0.12;
    const s = settings({
      tempoSync: 6, // quarter note = 1 beat
      beatPeriodS: beatS,
      feedback: 0,
      dryVolume: 0,
      wetVolume: 1,
      delayTime: 0.5, // free-running fallback — must be IGNORED
    });
    const out = render(core, s, 0.5, (n) => (n === 0 ? 1 : 0));
    const pk = peakIndex(out, 1);
    const expected = beatS * SR;
    expect(pk).toBeGreaterThan(expected * 0.5);
    expect(pk).toBeLessThan(expected * 1.6);
    expect(pk).toBeLessThan(0.5 * SR * 0.8); // definitely not the 0.5 s fallback
  });

  it('tempoSync Off ignores beatPeriodS and uses the free-running TIME', () => {
    const core = new AnalogDelayCore(SR);
    const s = settings({
      tempoSync: 0,
      beatPeriodS: 0.4, // present but must be ignored
      delayTime: 0.1,
      feedback: 0,
      dryVolume: 0,
      wetVolume: 1,
    });
    const out = render(core, s, 0.3, (n) => (n === 0 ? 1 : 0));
    const pk = peakIndex(out, 1);
    const expected = 0.1 * SR;
    expect(pk).toBeGreaterThan(expected * 0.5);
    expect(pk).toBeLessThan(expected * 1.6);
  });
});

describe('AnalogDelayCore — wow/flutter modulation', () => {
  it('a nonzero LFO amount audibly changes the wet output vs no modulation', () => {
    const tone = (n: number) => Math.sin((2 * Math.PI * 220 * n) / SR) * 0.7;
    const flat = render(
      new AnalogDelayCore(SR),
      settings({ delayTime: 0.05, feedback: 0.4, dryVolume: 0, wetVolume: 1, lfoAmount: 0 }),
      0.4,
      tone,
    );
    const wobbled = render(
      new AnalogDelayCore(SR),
      settings({
        delayTime: 0.05,
        feedback: 0.4,
        dryVolume: 0,
        wetVolume: 1,
        lfoAmount: 0.3,
        lfoFrequency: 6,
      }),
      0.4,
      tone,
    );
    let diff = 0;
    const from = Math.round(0.1 * SR);
    for (let i = from; i < flat.length; i++) diff += Math.abs(flat[i]! - wobbled[i]!);
    expect(diff).toBeGreaterThan(0); // the LFO warps the read time
  });

  it('DRIFT is deterministic — same seed → bit-identical renders', () => {
    const s = settings({ delayTime: 0.05, feedback: 0.4, driftAmount: 0.04, driftSpeed: 5, dryVolume: 0, wetVolume: 1 });
    const tone = (n: number) => Math.sin((2 * Math.PI * 180 * n) / SR) * 0.6;
    const a = render(new AnalogDelayCore(SR), s, 0.3, tone);
    const b = render(new AnalogDelayCore(SR), s, 0.3, tone);
    let maxDiff = 0;
    for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i]! - b[i]!));
    expect(maxDiff).toBe(0);
  });
});

describe('AnalogDelayCore — wet/dry split', () => {
  it('dry-only (wet=0) passes the input through with NO delayed echo', () => {
    const core = new AnalogDelayCore(SR);
    const s = settings({ delayTime: 0.1, feedback: 0.6, dryVolume: 1, wetVolume: 0 });
    const out = render(core, s, 0.3, (n) => (n === 0 ? 1 : 0));
    // The only energy is the dry impulse at t=0; the echo window is silent.
    expect(Math.abs(out[0]!)).toBeGreaterThan(0.5);
    const echoWin = energy(out, Math.round(0.09 * SR), Math.round(0.11 * SR));
    expect(echoWin).toBeLessThan(1e-9);
  });

  it('wet-only (dry=0) has NO t=0 dry spike but DOES have the delayed echo', () => {
    const core = new AnalogDelayCore(SR);
    const s = settings({ delayTime: 0.1, feedback: 0, dryVolume: 0, wetVolume: 1 });
    const out = render(core, s, 0.3, (n) => (n === 0 ? 1 : 0));
    expect(Math.abs(out[0]!)).toBeLessThan(1e-6); // no dry passthrough
    const echoWin = energy(out, Math.round(0.08 * SR), Math.round(0.12 * SR));
    expect(echoWin).toBeGreaterThan(0);
  });
});

describe('AnalogDelayCore — ducking', () => {
  it('ducking attenuates the wet while dry signal is loud', () => {
    const tone = (n: number) => Math.sin((2 * Math.PI * 220 * n) / SR) * 0.8;
    const base: Partial<AnalogDelaySettings> = {
      delayTime: 0.05,
      feedback: 0.5,
      dryVolume: 0, // measure wet only
      wetVolume: 1,
      duckAttack: 5,
      duckRelease: 5,
    };
    const unducked = render(new AnalogDelayCore(SR), settings({ ...base, duckAmount: 0 }), 0.5, tone);
    const ducked = render(new AnalogDelayCore(SR), settings({ ...base, duckAmount: 10 }), 0.5, tone);
    const from = Math.round(0.2 * SR);
    const rms = (b: Float32Array) => Math.sqrt(energy(b, from) / (b.length - from));
    expect(rms(ducked)).toBeLessThan(rms(unducked) * 0.85);
  });
});

describe('AnalogDelayCore — drive', () => {
  it('drive saturation changes the wet signal; drive=0 is a clean bypass', () => {
    const tone = (n: number) => Math.sin((2 * Math.PI * 110 * n) / SR) * 0.9;
    const base: Partial<AnalogDelaySettings> = {
      delayTime: 0.05,
      feedback: 0.4,
      dryVolume: 0,
      wetVolume: 1,
      driveMix: 1,
      driveCutoff: 1,
      driveIterations: 4,
    };
    const clean = render(new AnalogDelayCore(SR), settings({ ...base, driveGain: 0 }), 0.5, tone);
    const driven = render(new AnalogDelayCore(SR), settings({ ...base, driveGain: 6 }), 0.5, tone);
    let diff = 0;
    const from = Math.round(0.2 * SR);
    for (let i = from; i < clean.length; i++) diff += Math.abs(clean[i]! - driven[i]!);
    expect(diff).toBeGreaterThan(0);
  });
});

describe('AnalogDelayCore — feedback stability', () => {
  it('stays finite + bounded at very high feedback', () => {
    const core = new AnalogDelayCore(SR);
    const s = settings({ delayTime: 0.03, feedback: 0.95, driveGain: 0.2, dryVolume: 1, wetVolume: 0.6, lowCut: 0.75 });
    const out = render(core, s, 1.0, (n) => (n < SR * 0.1 ? Math.sin((2 * Math.PI * 200 * n) / SR) * 0.5 : 0));
    let peak = 0;
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i]!)).toBe(true);
      peak = Math.max(peak, Math.abs(out[i]!));
    }
    expect(peak).toBeLessThan(8); // bounded — the loop does not run away
  });
});

describe('AnalogDelayCore — bus-duplicate + determinism', () => {
  it('with stereoOffset 0 + static pan 0, outL == outR sample-for-sample', () => {
    const core = new AnalogDelayCore(SR);
    const s = settings({ stereoOffset: 0, pan: 0, panMode: 0, driftAmount: 0.03, feedback: 0.6 });
    const n = Math.round(SR * 0.4);
    for (let i = 0; i < n; i++) {
      const v = i < SR * 0.06 ? Math.sin((2 * Math.PI * 261.6 * i) / SR) * 0.6 : 0;
      core.processSample(s, v, v);
      expect(core.outL).toBe(core.outR);
    }
  });

  it('two fresh cores render bit-identically (no hidden global state)', () => {
    const s = settings({ feedback: 0.7, driveGain: 3, driftAmount: 0.02, lfoAmount: 0.2 });
    const tone = (n: number) => (n < SR * 0.06 ? Math.sin((2 * Math.PI * 300 * n) / SR) * 0.5 : 0);
    const a = render(new AnalogDelayCore(SR), s, 0.5, tone);
    const b = render(new AnalogDelayCore(SR), s, 0.5, tone);
    let maxDiff = 0;
    for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i]! - b[i]!));
    expect(maxDiff).toBe(0);
  });
});
