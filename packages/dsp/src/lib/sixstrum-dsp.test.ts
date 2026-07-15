// packages/dsp/src/lib/sixstrum-dsp.test.ts
import { describe, it, expect } from 'vitest';
import {
  SS_STRINGS,
  SIXSTRUM_DEFAULTS,
  type SixStrumParams,
  type SixStrumFrame,
  makeSixStrumState,
  prepSixStrumBlock,
  sixStrumStep,
} from './sixstrum-dsp';

const SR = 48000;
const BLOCK = 128;

function makeFrame(): SixStrumFrame {
  return {
    strum: new Float32Array(SS_STRINGS),
    mute: new Float32Array(SS_STRINGS),
    polyPitch: new Float32Array(SS_STRINGS),
    polyGate: new Float32Array(SS_STRINGS),
    accent: 0.6,
  };
}

interface Drive {
  (frame: SixStrumFrame, i: number): void; // i = global sample index
}

/** Render `durationS` seconds, calling prep once per block (as the worklet does),
 *  and `drive` each sample to set the inputs. `chordRootMidi` feeds prep. */
function render(
  durationS: number,
  params: SixStrumParams,
  drive: Drive,
  chordRootMidi = 60,
): Float32Array {
  const n = Math.round(SR * durationS);
  const out = new Float32Array(n);
  const s = makeSixStrumState(SR);
  const frame = makeFrame();
  for (let base = 0; base < n; base += BLOCK) {
    prepSixStrumBlock(params, chordRootMidi, SR, s);
    const end = Math.min(n, base + BLOCK);
    for (let i = base; i < end; i++) {
      // reset transient inputs each sample; drive sets what it wants
      frame.strum.fill(0);
      drive(frame, i);
      out[i] = sixStrumStep(frame, params, SR, s);
    }
  }
  return out;
}

function rms(b: Float32Array, s = 0, e = b.length): number {
  let x = 0;
  for (let i = s; i < e; i++) x += b[i]! * b[i]!;
  return Math.sqrt(x / Math.max(1, e - s));
}
function peak(b: Float32Array): number {
  let p = 0;
  for (const v of b) p = Math.max(p, Math.abs(v));
  return p;
}

/** Strum all 6 strings once at t=0 (a 3ms trigger pulse on every strum input). */
const strumAllAtZero: Drive = (f, i) => {
  if (i < Math.round(0.003 * SR)) f.strum.fill(1);
};

describe('sixstrum-dsp: a strum rings and decays', () => {
  it('produces finite, audible, bounded, ringing output', () => {
    const out = render(1.5, { ...SIXSTRUM_DEFAULTS }, strumAllAtZero);
    expect(out.every(Number.isFinite)).toBe(true);
    expect(peak(out)).toBeGreaterThan(0.05);
    expect(peak(out)).toBeLessThan(4);
    // Attack window has energy…
    const attack = rms(out, 0, Math.round(0.1 * SR));
    expect(attack).toBeGreaterThan(0.01);
    // …the string RINGS into the tail…
    const tail = rms(out, Math.round(0.6 * SR), Math.round(0.9 * SR));
    expect(tail).toBeGreaterThan(1e-3);
    // …but decays (tail quieter than attack).
    expect(tail).toBeLessThan(attack);
  });

  it('is silent before any strike (base_vol = 0)', () => {
    // Never strum: env stays idle, output ≈ 0.
    const out = render(0.2, { ...SIXSTRUM_DEFAULTS }, () => {});
    expect(peak(out)).toBeLessThan(1e-6);
  });

  it('is deterministic (bit-identical re-render)', () => {
    const a = render(0.5, { ...SIXSTRUM_DEFAULTS }, strumAllAtZero);
    const b = render(0.5, { ...SIXSTRUM_DEFAULTS }, strumAllAtZero);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i]! - b[i]!));
    expect(diff).toBe(0);
  });
});

describe('sixstrum-dsp: RING knob controls sustain length', () => {
  it('a longer RING rings louder in the tail', () => {
    const short = render(1.2, { ...SIXSTRUM_DEFAULTS, ring: 0.5 }, strumAllAtZero);
    const long = render(1.2, { ...SIXSTRUM_DEFAULTS, ring: 8 }, strumAllAtZero);
    const w0 = Math.round(0.8 * SR);
    const w1 = Math.round(1.1 * SR);
    expect(rms(long, w0, w1)).toBeGreaterThan(rms(short, w0, w1));
  });
});

describe('sixstrum-dsp: MUTE gate chokes the string', () => {
  it('a held mute gate kills the ring (dead thunk, not a long ring)', () => {
    // Strike only string 0; compare tail with vs without its mute gate held.
    const strikeS0: Drive = (f, i) => {
      if (i < Math.round(0.003 * SR)) f.strum[0] = 1;
    };
    const open = render(1.0, { ...SIXSTRUM_DEFAULTS }, strikeS0);
    const muted = render(1.0, { ...SIXSTRUM_DEFAULTS, muteDepth: 0.9 }, (f, i) => {
      strikeS0(f, i);
      f.mute[0] = 1; // finger held on the string the whole time
    });
    const w0 = Math.round(0.3 * SR);
    const w1 = Math.round(0.6 * SR);
    expect(rms(muted, w0, w1)).toBeLessThan(rms(open, w0, w1) * 0.5);
  });
});

describe('sixstrum-dsp: STRUM SPREAD staggers the strike', () => {
  it('spread > 0 delays the later strings (energy ramps in, not a single block hit)', () => {
    // A karplus voice's output lags its strike by ~one string period, so the
    // signature is the first several ms: block0 strikes ALL strings at t=0 (the
    // fast high strings ring within ~3ms → energy present), while a full down-
    // strum staggers the strikes across ~45ms (only the slow low string has
    // struck by 8ms, and it hasn't rung yet) → near-silent.
    const block0 = render(0.1, { ...SIXSTRUM_DEFAULTS, strumSpread: 0 }, strumAllAtZero);
    const spread = render(0.1, { ...SIXSTRUM_DEFAULTS, strumSpread: 1 }, strumAllAtZero);
    const w = Math.round(0.008 * SR);
    expect(rms(block0, 0, w)).toBeGreaterThan(1e-3); // fast strings already ring
    expect(rms(spread, 0, w)).toBeLessThan(rms(block0, 0, w) * 0.5); // staggered in
  });
});

describe('sixstrum-dsp: poly path (real note source)', () => {
  it('a poly note-on/off drives a voice audibly', () => {
    const params: SixStrumParams = { ...SIXSTRUM_DEFAULTS, polyConnected: 1 };
    const out = render(0.6, params, (f, i) => {
      // lane 0 = C4 (0 V/oct), gate high for the first 0.3 s.
      f.polyPitch[0] = 0;
      f.polyGate[0] = i < Math.round(0.3 * SR) ? 1 : 0;
    });
    expect(peak(out)).toBeGreaterThan(0.03);
    expect(rms(out, 0, Math.round(0.1 * SR))).toBeGreaterThan(0.005);
  });
});

describe('sixstrum-dsp: chord mode voices 6 strings from one root', () => {
  it('chordConnected + a root produces a fuller chord than a single string', () => {
    const chord = render(
      0.5,
      { ...SIXSTRUM_DEFAULTS, chordConnected: 1 },
      strumAllAtZero,
      60, // C
    );
    const single = render(0.5, { ...SIXSTRUM_DEFAULTS }, (f, i) => {
      if (i < Math.round(0.003 * SR)) f.strum[0] = 1;
    });
    const w0 = Math.round(0.02 * SR);
    const w1 = Math.round(0.15 * SR);
    expect(rms(chord, w0, w1)).toBeGreaterThan(rms(single, w0, w1));
  });
});

describe('sixstrum-dsp: BODY resonance', () => {
  it('body = 0 is a dry passthrough; body > 0 changes the signal', () => {
    const dry = render(0.4, { ...SIXSTRUM_DEFAULTS, body: 0 }, strumAllAtZero);
    const wet = render(0.4, { ...SIXSTRUM_DEFAULTS, body: 1 }, strumAllAtZero);
    let diff = 0;
    for (let i = 0; i < dry.length; i++) diff = Math.max(diff, Math.abs(dry[i]! - wet[i]!));
    expect(diff).toBeGreaterThan(1e-4); // body audibly colours the tone
    expect(wet.every(Number.isFinite)).toBe(true);
    expect(peak(wet)).toBeLessThan(4);
  });
});

describe('sixstrum-dsp: guitar/bass/harp reachable by knob state (no branches)', () => {
  it('each mode preset renders finite, audible, bounded output', () => {
    const guitar: SixStrumParams = { ...SIXSTRUM_DEFAULTS, tuning: 0, register: 0, ring: 2.5, material: 0.55 };
    const bass: SixStrumParams = { ...SIXSTRUM_DEFAULTS, tuning: 1, register: 0, ring: 6, material: 0.32 };
    const harp: SixStrumParams = { ...SIXSTRUM_DEFAULTS, tuning: 2, register: 7, ring: 9, material: 0.85 };
    for (const p of [guitar, bass, harp]) {
      const out = render(0.8, p, strumAllAtZero);
      expect(out.every(Number.isFinite)).toBe(true);
      expect(peak(out)).toBeGreaterThan(0.03);
      expect(peak(out)).toBeLessThan(4);
    }
  });
});
