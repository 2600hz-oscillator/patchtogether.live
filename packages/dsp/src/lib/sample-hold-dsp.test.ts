// packages/dsp/src/lib/sample-hold-dsp.test.ts
//
// Pure-DSP unit tests for SAMPLE & HOLD / quantizer. Pins every novel piece of
// behaviour so a refactor surfaces as a specific quantitative regression:
//   • latch-on-rising-edge holds the value between edges (sample & hold).
//   • ungated passthrough = pure quantizer (cv flows + quantizes continuously).
//   • quantizeVoltage snaps to the nearest scale note for EVERY scale
//     (table-driven: a few voltages per mode → expected nearest scale degree).
//   • 1V/oct correctness: integer volts land on the root in every octave.

import { describe, it, expect } from 'vitest';
import {
  SAMPLE_HOLD_SCALES,
  SAMPLE_HOLD_MAX_SCALE,
  quantizeVoltage,
  sampleHoldStep,
  shouldWritePitch,
  clampScaleIndex,
  scaleName,
} from './sample-hold-dsp';

const idx = (id: string) => SAMPLE_HOLD_SCALES.findIndex((s) => s.id === id);

// Convenience: voltage at a given (octave, semitone) — 1V/oct, 1/12 V/semi.
const v = (octave: number, semi: number) => octave + semi / 12;

describe('sample-hold-dsp / scale table', () => {
  it('includes all spec-required modes plus chromatic + harmonic/melodic minor', () => {
    const ids = SAMPLE_HOLD_SCALES.map((s) => s.id);
    for (const required of [
      'major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian',
      'chromatic', 'harmonic', 'melodic',
    ]) {
      expect(ids, `scale '${required}' present`).toContain(required);
    }
  });

  it('every scale degree set is within one octave, ascending, root-anchored', () => {
    for (const s of SAMPLE_HOLD_SCALES) {
      expect(s.degrees[0], `${s.id} root = 0`).toBe(0);
      for (let i = 1; i < s.degrees.length; i++) {
        expect(s.degrees[i]! > s.degrees[i - 1]!, `${s.id} ascending`).toBe(true);
      }
      expect(s.degrees[s.degrees.length - 1]! < 12, `${s.id} < octave`).toBe(true);
    }
  });

  it('clampScaleIndex pins out-of-range + rounds floats', () => {
    expect(clampScaleIndex(-3)).toBe(0);
    expect(clampScaleIndex(999)).toBe(SAMPLE_HOLD_MAX_SCALE);
    expect(clampScaleIndex(2.4)).toBe(2);
    expect(clampScaleIndex(2.6)).toBe(3);
    expect(clampScaleIndex(NaN)).toBe(0);
  });

  it('scaleName returns the display name', () => {
    expect(scaleName(idx('major'))).toBe('Major');
    expect(scaleName(idx('locrian'))).toBe('Locrian');
  });
});

describe('sample-hold-dsp / quantizeVoltage — 1V/oct correctness', () => {
  it('integer volts (the root C) map to themselves in every octave + scale', () => {
    for (const s of SAMPLE_HOLD_SCALES) {
      for (const oct of [-2, -1, 0, 1, 2, 3]) {
        expect(quantizeVoltage(oct, idx(s.id)), `${s.id} oct ${oct}`).toBeCloseTo(oct, 9);
      }
    }
  });

  it('chromatic quantizes to the nearest semitone (1/12 V grid)', () => {
    const c = idx('chromatic');
    // 0.04 V ≈ 0.48 semitone → nearest semitone is 0 (C).
    expect(quantizeVoltage(0.04, c)).toBeCloseTo(0, 6);
    // 0.05 V = 0.6 semitone → nearest is 1 semitone (C#).
    expect(quantizeVoltage(0.05, c)).toBeCloseTo(1 / 12, 6);
    // 0.5 V = 6 semitones (F#) — exact.
    expect(quantizeVoltage(0.5, c)).toBeCloseTo(6 / 12, 6);
  });
});

describe('sample-hold-dsp / quantizeVoltage — per-scale nearest-note table', () => {
  // Each row: scale id, input volts, expected (octave, semitone) of the snap.
  // The semitone must be an admitted degree of that scale (asserted below too).
  // Tie-break rule (documented in quantizeVoltage): a voltage EXACTLY halfway
  // between two admitted notes rounds toward the HIGHER note.
  const cases: Array<[string, number, number, number]> = [
    // Major {0,2,4,5,7,9,11}. 1 semi (C#) is NOT in major.
    ['major', v(0, 1) - 0.001, 0, 0],   // just below C#: nearer C (0)
    ['major', v(0, 1) + 0.04, 0, 2],    // ~1.5 semi up → nearer D (2)
    ['major', v(0, 3), 0, 4],           // D#(3) between D(2)/E(4) → tie → higher E(4)
    ['major', v(0, 6), 0, 7],           // F#(6) between F(5)/G(7) → tie → higher G(7)
    ['major', v(1, 5), 1, 5],           // F in next octave — admitted, exact
    // Minor (aeolian) {0,2,3,5,7,8,10}. E(4) not in minor.
    ['minor', v(0, 4), 0, 5],           // E(4) between Eb(3)/F(5) → tie → higher F(5)
    ['minor', v(0, 10), 0, 10],         // Bb admitted, exact
    // Dorian {0,2,3,5,7,9,10}.
    ['dorian', v(0, 9), 0, 9],          // A admitted
    ['dorian', v(0, 1), 0, 2],          // C#(1) between C(0)/D(2) → tie → higher D(2)
    // Phrygian {0,1,3,5,7,8,10}.
    ['phrygian', v(0, 1), 0, 1],        // Db admitted (exact)
    ['phrygian', v(0, 2), 0, 3],        // D(2) between Db(1)/Eb(3) → tie → higher Eb(3)
    // Lydian {0,2,4,6,7,9,11}.
    ['lydian', v(0, 6), 0, 6],          // F# admitted (the lydian #4)
    ['lydian', v(0, 5), 0, 6],          // F(5) between E(4)/F#(6) → tie → higher F#(6)
    // Mixolydian {0,2,4,5,7,9,10}.
    ['mixolydian', v(0, 10), 0, 10],    // Bb admitted (the b7)
    ['mixolydian', v(0, 11), 1, 0],     // B(11) between Bb(10)/C(12=next-oct root) → tie → higher C
    // Locrian {0,1,3,5,6,8,10}.
    ['locrian', v(0, 6), 0, 6],         // Gb admitted (the b5)
    // Harmonic minor {0,2,3,5,7,8,11}.
    ['harmonic', v(0, 11), 0, 11],      // major 7th admitted
    ['harmonic', v(0, 9), 0, 8],        // A(9) nearer Ab(8) than B(11) → 8
    // Melodic minor {0,2,3,5,7,9,11}.
    ['melodic', v(0, 9), 0, 9],         // raised 6th admitted
  ];

  for (const [id, volts, expOct, expSemi] of cases) {
    it(`${id}: ${volts.toFixed(4)}V → octave ${expOct} semitone ${expSemi}`, () => {
      const out = quantizeVoltage(volts, idx(id));
      // Result must be an admitted note voltage.
      expect(out).toBeCloseTo(v(expOct, expSemi), 6);
      // And it MUST belong to the scale (degree mod 12 in the degree set).
      const semi = Math.round(out * 12);
      const within = ((semi % 12) + 12) % 12;
      expect(SAMPLE_HOLD_SCALES[idx(id)]!.degrees, `${id} admits degree ${within}`).toContain(within);
    });
  }

  it('quantized output is ALWAYS an admitted note (random sweep, every scale)', () => {
    for (const s of SAMPLE_HOLD_SCALES) {
      for (let k = 0; k < 200; k++) {
        const volts = (k / 200) * 4 - 2; // -2..+2 V
        const out = quantizeVoltage(volts, idx(s.id));
        const within = ((Math.round(out * 12) % 12) + 12) % 12;
        expect(s.degrees, `${s.id} @ ${volts.toFixed(3)}V → ${within}`).toContain(within);
      }
    }
  });
});

describe('sample-hold-dsp / sampleHoldStep — latch on rising edge', () => {
  const chromatic = idx('chromatic');

  it('latches cv_in on a rising edge and HOLDS it until the next edge', () => {
    let held = 0;
    let prev = 0;
    // gate low, cv = 0.7 → held stays 0 (no edge).
    let r = sampleHoldStep(0.7, 0, prev, held, true, chromatic);
    held = r.held; prev = r.prevGate;
    expect(held).toBe(0);

    // rising edge with cv = 0.7 → latch 0.7.
    r = sampleHoldStep(0.7, 1, prev, held, true, chromatic);
    held = r.held; prev = r.prevGate;
    expect(held).toBeCloseTo(0.7, 9);

    // gate stays high, cv changes to 0.2 → STILL holding 0.7 (no new edge).
    r = sampleHoldStep(0.2, 1, prev, held, true, chromatic);
    held = r.held; prev = r.prevGate;
    expect(held).toBeCloseTo(0.7, 9);

    // gate falls, cv = 0.2 → still 0.7.
    r = sampleHoldStep(0.2, 0, prev, held, true, chromatic);
    held = r.held; prev = r.prevGate;
    expect(held).toBeCloseTo(0.7, 9);

    // new rising edge with cv = 0.2 → latch 0.2.
    r = sampleHoldStep(0.2, 1, prev, held, true, chromatic);
    held = r.held;
    expect(held).toBeCloseTo(0.2, 9);
  });

  it('cv_quant is the latched value quantized to the scale', () => {
    // Latch 0.04 V (just under C#) on a major scale → held 0.04, quant 0 (C).
    const r = sampleHoldStep(0.04, 1, 0, 0, true, idx('major'));
    expect(r.held).toBeCloseTo(0.04, 6);
    expect(r.quant).toBeCloseTo(0, 6);
  });
});

describe('sample-hold-dsp / sampleHoldStep — ungated = pure quantizer', () => {
  it('passes cv_in through continuously when gate is NOT connected', () => {
    // gateConnected=false: cvOut tracks the live input regardless of gate.
    const a = sampleHoldStep(0.3, 0, 0, 0, false, idx('chromatic'));
    expect(a.held).toBeCloseTo(0.3, 9);          // live passthrough
    const b = sampleHoldStep(0.8, 0, a.prevGate, a.held, false, idx('chromatic'));
    expect(b.held).toBeCloseTo(0.8, 9);          // tracks the new value (no hold)
  });

  it('continuously quantizes the live input (the QUANTIZER mode)', () => {
    // 0.5 V on a major scale: 6 semis (F#) not admitted; snaps to G (7) on tie.
    const r = sampleHoldStep(0.5, 0, 0, 0, false, idx('major'));
    expect(r.held).toBeCloseTo(0.5, 9);          // cv_out = live input
    const within = ((Math.round(r.quant * 12) % 12) + 12) % 12;
    expect(SAMPLE_HOLD_SCALES[idx('major')]!.degrees).toContain(within);
  });
});

describe('sample-hold-dsp / shouldWritePitch — S&H scheduling predicate', () => {
  // The full truth table: enabled (S&H ON/OFF) × gatedThisStep (gate fires?).
  it('S&H ON: writes pitch ONLY on a gated step (latch to the gate edge)', () => {
    expect(shouldWritePitch(true, true)).toBe(true);   // gated → write (latch)
    expect(shouldWritePitch(true, false)).toBe(false); // rest  → hold (skip)
  });

  it('S&H OFF: ALWAYS writes pitch (continuous, legacy behavior)', () => {
    expect(shouldWritePitch(false, true)).toBe(true);  // gated → write
    expect(shouldWritePitch(false, false)).toBe(true); // rest  → still write
  });

  it('is a pure boolean function of (enabled, gatedThisStep) — full table', () => {
    const table: Array<[boolean, boolean, boolean]> = [
      [true, true, true],
      [true, false, false],
      [false, true, true],
      [false, false, true],
    ];
    for (const [enabled, gated, expected] of table) {
      expect(shouldWritePitch(enabled, gated)).toBe(expected);
    }
  });
});
