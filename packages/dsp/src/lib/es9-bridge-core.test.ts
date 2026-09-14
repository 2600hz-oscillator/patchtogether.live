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
  DC_INPUT_JACKS,
  FADE_FRAMES,
  GATE_OUT_LEVEL,
  GATE_RISE,
  GATE_FALL,
  InScaler,
  JACK_CHANNEL_BASE,
  LINE_NOMINAL_VOLTS_PEAK,
  LINE_NOMINAL_VOLTS_RMS,
  NOMINAL_VOLTS,
  REF_LINE,
  REF_MODULAR,
  RingIO,
  UnderrunFiller,
  VOLTS_FULL_SCALE,
  browserToHwSample,
  browserToHwScale,
  createRingSpec,
  hwToBrowserScale,
  outSample,
  rawInSample,
} from './es9-bridge-core';

describe('class scaling', () => {
  it('maps hardware volts onto app conventions (hw→browser)', () => {
    // AUDIO is Eurorack nominal, the SAME scale as cv: ±5 V → ±1.0. It was
    // ×1 (±10 V → ±1.0) until 2026-09-14, which landed every modular audio
    // signal 6 dB under the internal modules (ADR-019).
    expect(hwToBrowserScale(CLASS_AUDIO)).toBe(2);
    expect(hwToBrowserScale(CLASS_CV)).toBe(2);     // ±5 V → ±1
    expect(hwToBrowserScale(CLASS_PITCH)).toBe(10); // 1 V/oct → 1.0/oct
    expect(hwToBrowserScale(CLASS_GATE)).toBe(1);   // comparator, no multiply
  });

  it('maps app conventions onto hardware volts (browser→hw)', () => {
    expect(browserToHwScale(CLASS_AUDIO)).toBe(0.5); // ±1 → ±5 V
    expect(browserToHwScale(CLASS_CV)).toBe(0.5);
    expect(browserToHwScale(CLASS_PITCH)).toBeCloseTo(0.1, 12);
  });

  it('round-trips: a browser value out and back is identity per class', () => {
    for (const cls of [CLASS_AUDIO, CLASS_CV, CLASS_PITCH]) {
      const v = 0.62;
      expect(browserToHwScale(cls) * hwToBrowserScale(cls) * v).toBeCloseTo(v, 12);
    }
  });

  it('the nominal and full-scale constants are the wire scale and the app scale, and stay apart', () => {
    // App ±1.0 (audio) × NOMINAL_VOLTS = the volts at the jack; the wire's
    // ±1.0 = VOLTS_FULL_SCALE. Their ratio IS the audio/cv multiplier.
    expect(NOMINAL_VOLTS).toBe(5);
    expect(VOLTS_FULL_SCALE).toBe(10);
    expect(NOMINAL_VOLTS * hwToBrowserScale(CLASS_AUDIO)).toBe(VOLTS_FULL_SCALE);
    // The gate conventions are physical volts on the WIRE and must not move
    // with the audio convention: +5 V high, rise ≥ 2 V, fall < 1 V.
    expect(GATE_OUT_LEVEL).toBe(0.5);
    expect(GATE_RISE).toBe(0.2);
    expect(GATE_FALL).toBe(0.1);
  });

  it('rawInSample: DC jacks 0..13 scale ×2, the S/PDIF pair 14/15 passes ×1', () => {
    expect(DC_INPUT_JACKS).toBe(14);
    for (let ch = 0; ch < DC_INPUT_JACKS; ch++) {
      expect(rawInSample(ch, 0.5), `ch ${ch}`).toBeCloseTo(1.0, 12); // ±5 V → ±1
      expect(rawInSample(ch, -0.25), `ch ${ch}`).toBeCloseTo(-0.5, 12);
    }
    for (const ch of [14, 15]) {
      expect(rawInSample(ch, 0.5), `S/PDIF ch ${ch}`).toBe(0.5);       // 0 dBFS = 1.0
      expect(rawInSample(ch, 1.0), `S/PDIF ch ${ch}`).toBe(1.0);
    }
  });

  it('outSample: usb1-8 (channels 0..7) pass ×1 for EVERY class; jacks 8..15 are class-scaled', () => {
    expect(JACK_CHANNEL_BASE).toBe(8);
    for (let ch = 0; ch < JACK_CHANNEL_BASE; ch++) {
      for (const cls of [CLASS_AUDIO, CLASS_CV, CLASS_PITCH, CLASS_GATE]) {
        expect(outSample(ch, cls, 1.0), `usb ch ${ch} cls ${cls}`).toBe(1.0);
        expect(outSample(ch, cls, 0.3), `usb ch ${ch} cls ${cls}`).toBe(0.3);
      }
    }
    for (let ch = JACK_CHANNEL_BASE; ch < 16; ch++) {
      expect(outSample(ch, CLASS_AUDIO, 1.0), `jack ch ${ch}`).toBe(0.5);   // ±1 → ±5 V
      expect(outSample(ch, CLASS_CV, 1.0), `jack ch ${ch}`).toBe(0.5);
      expect(outSample(ch, CLASS_PITCH, 1.0), `jack ch ${ch}`).toBeCloseTo(0.1, 12);
      expect(outSample(ch, CLASS_GATE, 1.0), `jack ch ${ch}`).toBe(GATE_OUT_LEVEL);
      expect(outSample(ch, CLASS_GATE, 0.49), `jack ch ${ch}`).toBe(0);
      expect(outSample(ch, cls(ch), 0.3)).toBe(browserToHwSample(cls(ch), 0.3));
    }
    function cls(ch: number): number { return ch % 4; }
  });

  it('gate class emits 0 V / +5 V from the app 0|1 (GATE_HI threshold)', () => {
    expect(browserToHwSample(CLASS_GATE, 0)).toBe(0);
    expect(browserToHwSample(CLASS_GATE, 0.49)).toBe(0);
    expect(browserToHwSample(CLASS_GATE, 0.5)).toBe(GATE_OUT_LEVEL); // +5 V
    expect(browserToHwSample(CLASS_GATE, 1)).toBe(GATE_OUT_LEVEL);
  });
});

describe('reference (per-jack modular / line) — owner 2026-09-14: "add a toggle on the card to set it to line per jack"', () => {
  /** The wire amplitude that must read exactly ±1.0 under REF_LINE — DERIVED
   *  from the constant, never typed (the spec's typed 0.17371 read 1.0005). */
  const LINE_WIRE = LINE_NOMINAL_VOLTS_PEAK / VOLTS_FULL_SCALE;

  it('the line constants are the +4 dBu derivation: 0.7746 V × 10^(4/20) = 1.2277 V RMS, × √2 = 1.7362 V peak', () => {
    expect(LINE_NOMINAL_VOLTS_RMS).toBeCloseTo(1.2277, 4);
    expect(LINE_NOMINAL_VOLTS_PEAK).toBeCloseTo(1.7362, 4);
    // 9.19 dB below the ±5 V modular reference — the residual ADR-019 measured
    // for line gear under the modular reference (−9.2 dBFS).
    expect(20 * Math.log10(NOMINAL_VOLTS / LINE_NOMINAL_VOLTS_PEAK)).toBeCloseTo(9.19, 2);
    // The two roster values are 0 and 1 (the param's 0..1 discrete range).
    expect(REF_MODULAR).toBe(0);
    expect(REF_LINE).toBe(1);
  });

  it('DEFAULT REPRODUCES TODAY: every scale with no ref argument equals the same call with REF_MODULAR', () => {
    for (const cls of [CLASS_AUDIO, CLASS_CV, CLASS_PITCH, CLASS_GATE]) {
      expect(hwToBrowserScale(cls), `hw→browser cls ${cls}`).toBe(hwToBrowserScale(cls, REF_MODULAR));
      expect(browserToHwScale(cls), `browser→hw cls ${cls}`).toBe(browserToHwScale(cls, REF_MODULAR));
    }
    expect(hwToBrowserScale(CLASS_AUDIO, REF_MODULAR)).toBe(2);
    expect(browserToHwScale(CLASS_AUDIO, REF_MODULAR)).toBe(0.5);
    expect(rawInSample(0, 0.5)).toBeCloseTo(1.0, 12);
    expect(outSample(8, CLASS_AUDIO, 1.0)).toBe(0.5);
  });

  it('AUDIO under REF_LINE: in ×5.76 (10 / 1.7362), out ×0.174 (1.7362 / 10), derived from the constants', () => {
    expect(hwToBrowserScale(CLASS_AUDIO, REF_LINE)).toBe(VOLTS_FULL_SCALE / LINE_NOMINAL_VOLTS_PEAK);
    expect(hwToBrowserScale(CLASS_AUDIO, REF_LINE)).toBeCloseTo(5.7598, 4);
    expect(browserToHwScale(CLASS_AUDIO, REF_LINE)).toBe(LINE_NOMINAL_VOLTS_PEAK / VOLTS_FULL_SCALE);
    expect(browserToHwScale(CLASS_AUDIO, REF_LINE)).toBeCloseTo(0.1736, 4);
    // NEGATIVE CONTROL: the argument is honoured — line is not modular.
    expect(hwToBrowserScale(CLASS_AUDIO, REF_LINE)).not.toBe(hwToBrowserScale(CLASS_AUDIO));
    expect(browserToHwScale(CLASS_AUDIO, REF_LINE)).not.toBe(browserToHwScale(CLASS_AUDIO));
  });

  it('cv / pitch / gate carry VOLTS and ignore the reference, in both directions', () => {
    for (const cls of [CLASS_CV, CLASS_PITCH, CLASS_GATE]) {
      expect(hwToBrowserScale(cls, REF_LINE), `hw→browser cls ${cls}`).toBe(hwToBrowserScale(cls, REF_MODULAR));
      expect(browserToHwScale(cls, REF_LINE), `browser→hw cls ${cls}`).toBe(browserToHwScale(cls, REF_MODULAR));
    }
    expect(hwToBrowserScale(CLASS_CV, REF_LINE)).toBe(2);
    expect(hwToBrowserScale(CLASS_PITCH, REF_LINE)).toBe(10);
    expect(browserToHwScale(CLASS_CV, REF_LINE)).toBe(0.5);
    expect(browserToHwScale(CLASS_PITCH, REF_LINE)).toBeCloseTo(0.1, 12);
  });

  it('round-trips: out and back is identity for every (class, ref) — and line out into modular in is the 9.19 dB residual', () => {
    for (const ref of [REF_MODULAR, REF_LINE]) {
      for (const cls of [CLASS_AUDIO, CLASS_CV, CLASS_PITCH]) {
        const v = 0.62;
        expect(browserToHwScale(cls, ref) * hwToBrowserScale(cls, ref) * v, `cls ${cls} ref ${ref}`).toBeCloseTo(v, 12);
      }
    }
    // Mismatched ends: a line-referenced out into a modular-referenced in.
    const mismatch = browserToHwScale(CLASS_AUDIO, REF_LINE) * hwToBrowserScale(CLASS_AUDIO, REF_MODULAR);
    expect(mismatch).toBeCloseTo(LINE_NOMINAL_VOLTS_PEAK / NOMINAL_VOLTS, 12); // 0.347
    expect(20 * Math.log10(mismatch)).toBeCloseTo(-9.19, 2);
  });

  it('rawInSample: a +4 dBu peak on the wire (0.1736) reads 1.0 on every DC jack under REF_LINE; S/PDIF ignores it', () => {
    for (let ch = 0; ch < DC_INPUT_JACKS; ch++) {
      expect(rawInSample(ch, LINE_WIRE, REF_LINE), `ch ${ch} line`).toBeCloseTo(1.0, 12);
      // The same wire level under the default reads the line-gear residual.
      expect(rawInSample(ch, LINE_WIRE), `ch ${ch} modular`).toBeCloseTo(LINE_NOMINAL_VOLTS_PEAK / NOMINAL_VOLTS, 12);
    }
    for (const ch of [14, 15]) {
      expect(rawInSample(ch, 0.5, REF_LINE), `S/PDIF ch ${ch}`).toBe(0.5);
      expect(rawInSample(ch, 1.0, REF_LINE), `S/PDIF ch ${ch}`).toBe(1.0);
    }
  });

  it('outSample: an audio jack under REF_LINE drives ±1.736 V for ±1.0 (0.1736 on the wire); usb1-8 and non-audio classes ignore it', () => {
    for (let ch = 0; ch < JACK_CHANNEL_BASE; ch++) {
      for (const cls of [CLASS_AUDIO, CLASS_CV, CLASS_PITCH, CLASS_GATE]) {
        expect(outSample(ch, cls, 1.0, REF_LINE), `usb ch ${ch} cls ${cls}`).toBe(1.0);
      }
    }
    for (let ch = JACK_CHANNEL_BASE; ch < 16; ch++) {
      expect(outSample(ch, CLASS_AUDIO, 1.0, REF_LINE), `jack ch ${ch}`).toBeCloseTo(LINE_WIRE, 12);
      expect(outSample(ch, CLASS_AUDIO, 1.0, REF_LINE), `jack ch ${ch}`).toBeCloseTo(0.1736, 4);
      for (const cls of [CLASS_CV, CLASS_PITCH, CLASS_GATE]) {
        expect(outSample(ch, cls, 1.0, REF_LINE), `jack ch ${ch} cls ${cls}`).toBe(outSample(ch, cls, 1.0, REF_MODULAR));
        expect(outSample(ch, cls, 0.3, REF_LINE), `jack ch ${ch} cls ${cls}`).toBe(outSample(ch, cls, 0.3, REF_MODULAR));
      }
      // Gate still emits the physical +5 V under a line ref — volts, not a level.
      expect(outSample(ch, CLASS_GATE, 1.0, REF_LINE)).toBe(GATE_OUT_LEVEL);
      expect(outSample(ch, CLASS_GATE, 0.49, REF_LINE)).toBe(0);
    }
    expect(browserToHwSample(CLASS_GATE, 0.5, REF_LINE)).toBe(GATE_OUT_LEVEL);
  });

  it('InScaler: the reference is read at class audio only, and setting it does not reset the gate latch', () => {
    const s = new InScaler();
    expect(s.reference).toBe(REF_MODULAR);
    s.setClass(CLASS_AUDIO);
    s.setReference(REF_LINE);
    expect(s.reference).toBe(REF_LINE);
    expect(s.process(LINE_WIRE)).toBeCloseTo(1.0, 12);         // +4 dBu peak → 1.0
    expect(s.process(0.5)).toBeCloseTo(NOMINAL_VOLTS / LINE_NOMINAL_VOLTS_PEAK, 12); // ±5 V → 2.88
    s.setClass(CLASS_CV);
    expect(s.process(0.5)).toBeCloseTo(1.0, 12);               // cv unchanged under line
    s.setClass(CLASS_PITCH);
    expect(s.process(0.1)).toBeCloseTo(1.0, 12);               // pitch unchanged under line
    // Gate thresholds are WIRE volts; the ref cannot move them or the latch.
    s.setClass(CLASS_GATE);
    expect(s.process(0.15)).toBe(0);
    expect(s.process(0.2)).toBe(1);
    s.setReference(REF_MODULAR);                               // flip while high…
    expect(s.process(0.12)).toBe(1);                           // …still held (no reset)
    s.setReference(REF_LINE);
    expect(s.process(0.15)).toBe(1);                           // hysteresis intact
    expect(s.process(0.09)).toBe(0);
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
    s.setClass(CLASS_AUDIO);
    expect(s.process(0.5)).toBeCloseTo(1.0, 12);   // +5 V → +1 (same as cv)
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
