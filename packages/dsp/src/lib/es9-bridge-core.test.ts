// Unit tests for the ES-9 bridge pure core: class scaling, gate hysteresis,
// underrun policies, and the SharedArrayBuffer ring. The LAYOUT-PIN test at
// the bottom asserts raw byte positions so the web-side mirror
// (packages/web/src/lib/audio/es9/es9-ring.ts) can pin the identical
// sequence — drift between the two halves fails fast in units, not live.

import { describe, expect, it } from 'vitest';
import {
  CLASS_AUDIO,
  CLASS_CV,
  CLASS_GATE,
  CLASS_PITCH,
  FADE_FRAMES,
  GATE_OUT_LEVEL,
  InScaler,
  RingIO,
  UnderrunFiller,
  browserToHwSample,
  browserToHwScale,
  createRingSpec,
  hwToBrowserScale,
} from './es9-bridge-core';

describe('class scaling', () => {
  it('maps hardware volts onto app conventions (hw→browser)', () => {
    expect(hwToBrowserScale(CLASS_AUDIO)).toBe(1);
    expect(hwToBrowserScale(CLASS_CV)).toBe(2);     // ±5 V → ±1
    expect(hwToBrowserScale(CLASS_PITCH)).toBe(10); // 1 V/oct → 1.0/oct
  });

  it('maps app conventions onto hardware volts (browser→hw)', () => {
    expect(browserToHwScale(CLASS_AUDIO)).toBe(1);
    expect(browserToHwScale(CLASS_CV)).toBe(0.5);
    expect(browserToHwScale(CLASS_PITCH)).toBeCloseTo(0.1, 12);
  });

  it('round-trips: a browser value out and back is identity per class', () => {
    for (const cls of [CLASS_CV, CLASS_PITCH]) {
      const v = 0.62;
      expect(browserToHwScale(cls) * hwToBrowserScale(cls) * v).toBeCloseTo(v, 12);
    }
  });

  it('gate class emits 0 V / +5 V from the app 0|1 (GATE_HI threshold)', () => {
    expect(browserToHwSample(CLASS_GATE, 0)).toBe(0);
    expect(browserToHwSample(CLASS_GATE, 0.49)).toBe(0);
    expect(browserToHwSample(CLASS_GATE, 0.5)).toBe(GATE_OUT_LEVEL); // +5 V
    expect(browserToHwSample(CLASS_GATE, 1)).toBe(GATE_OUT_LEVEL);
  });
});

describe('InScaler gate hysteresis', () => {
  it('rises at ≥2 V, falls below 1 V — no double-trigger on a wobbly edge', () => {
    const s = new InScaler();
    s.setClass(CLASS_GATE);
    expect(s.process(0)).toBe(0);
    expect(s.process(0.15)).toBe(0);   // 1.5 V — below rise threshold
    expect(s.process(0.2)).toBe(1);    // 2 V — rises
    expect(s.process(0.12)).toBe(1);   // sag to 1.2 V — HOLDS (hysteresis)
    expect(s.process(0.18)).toBe(1);   // wobble back up — still one gate
    expect(s.process(0.09)).toBe(0);   // below 1 V — falls
    expect(s.process(0.15)).toBe(0);   // 1.5 V again — must NOT re-rise
    expect(s.process(0.5)).toBe(1);    // full +5 V — clean second gate
  });

  it('resets comparator state on class change', () => {
    const s = new InScaler();
    s.setClass(CLASS_GATE);
    s.process(0.5);
    s.setClass(CLASS_CV);
    s.setClass(CLASS_GATE);
    expect(s.process(0.15)).toBe(0);   // fresh comparator, below rise
  });

  it('scales non-gate classes multiplicatively', () => {
    const s = new InScaler();
    s.setClass(CLASS_CV);
    expect(s.process(0.5)).toBeCloseTo(1.0, 12);   // +5 V → +1
    s.setClass(CLASS_PITCH);
    expect(s.process(0.1)).toBeCloseTo(1.0, 12);   // 1 V → 1 octave
  });
});

describe('UnderrunFiller', () => {
  it('audio class fades to zero within FADE_FRAMES and stays there', () => {
    const f = new UnderrunFiller();
    f.feed(0.8);
    let v = 0.8;
    for (let i = 0; i < FADE_FRAMES; i++) {
      const next = f.fill(CLASS_AUDIO);
      expect(Math.abs(next)).toBeLessThanOrEqual(Math.abs(v) + 1e-9);
      v = next;
    }
    expect(v).toBe(0);
    expect(f.fill(CLASS_AUDIO)).toBe(0);
  });

  it('cv-ish classes hold the last value indefinitely', () => {
    for (const cls of [CLASS_CV, CLASS_PITCH, CLASS_GATE]) {
      const f = new UnderrunFiller();
      f.feed(-0.42);
      for (let i = 0; i < 500; i++) expect(f.fill(cls)).toBeCloseTo(-0.42, 12);
    }
  });

  it('fresh data cancels an in-progress fade', () => {
    const f = new UnderrunFiller();
    f.feed(1.0);
    f.fill(CLASS_AUDIO);
    f.fill(CLASS_AUDIO);
    f.feed(0.5);                       // stream resumed
    f.feed(0.6);
    const v = f.fill(CLASS_AUDIO);     // new fade starts from 0.6
    expect(v).toBeCloseTo(0.6 - 0.6 / FADE_FRAMES, 9);
  });
});

describe('RingIO (SAB SPSC ring)', () => {
  it('round-trips frames across the wrap boundary', () => {
    const ring = new RingIO(createRingSpec(2, 64));
    for (let cycle = 0; cycle < 3; cycle++) {
      const wrote = ring.write(48, (ch, i) => ch * 1000 + cycle * 48 + i);
      expect(wrote).toBe(48);
      const seen: number[][] = [[], []];
      const read = ring.read(48, (ch, i, v) => { seen[ch]![i] = v; });
      expect(read).toBe(48);
      for (let ch = 0; ch < 2; ch++) {
        for (let i = 0; i < 48; i++) {
          expect(seen[ch]![i]).toBe(ch * 1000 + cycle * 48 + i);
        }
      }
    }
  });

  it('writes short on overflow, reads short on underrun, skips', () => {
    const ring = new RingIO(createRingSpec(1, 32));
    expect(ring.write(40, (_ch, i) => i)).toBe(32);
    expect(ring.occupancy).toBe(32);
    expect(ring.free).toBe(0);
    let count = 0;
    expect(ring.read(10, () => { count++; })).toBe(10);
    expect(count).toBe(10);
    expect(ring.skip(100)).toBe(22);
    expect(ring.occupancy).toBe(0);
    expect(ring.read(4, () => {})).toBe(0);
  });

  it('rounds capacity up to a power of two', () => {
    expect(createRingSpec(1, 100).capacity).toBe(128);
    expect(createRingSpec(1, 128).capacity).toBe(128);
  });

  it('LAYOUT PIN: plane-per-channel, index = counter & (capacity-1), header [head, tail]', () => {
    // The web mirror (packages/web/src/lib/audio/es9/es9-ring.ts) pins the
    // SAME sequence — if either side changes layout, one of the twins fails.
    const spec = createRingSpec(2, 8);
    const ring = new RingIO(spec);
    ring.write(3, (ch, i) => ch * 10 + i);       // ch0: 0,1,2  ch1: 10,11,12
    const raw = new Float32Array(spec.data);
    expect(raw[0]).toBe(0);
    expect(raw[1]).toBe(1);
    expect(raw[2]).toBe(2);
    expect(raw[8 + 0]).toBe(10);                 // plane stride = capacity (8)
    expect(raw[8 + 1]).toBe(11);
    const header = new Int32Array(spec.header);
    expect(header[0]).toBe(3);                   // head advanced
    expect(header[1]).toBe(0);                   // tail untouched
  });
});
