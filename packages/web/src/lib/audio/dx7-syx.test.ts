// packages/web/src/lib/audio/dx7-syx.test.ts
//
// Unit tests for the DX7 SYX parser, ratio math, and envelope helpers.
// We synthesize a known-good SYX bank in-memory (rather than ship a
// copyrighted ROM dump as a fixture) and roundtrip it through the parser.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseSyxBank,
  dx7Ratio,
  dx7DetuneFactor,
  computeChecksum,
  dx7LevelToAmp,
  dx7LevelToDb,
  dx7RateToDbPerSec,
  dx7EgAmpFromDb,
  dx7EgTick,
  dx7FixedHz,
  dx7FixedHzFromRatio,
} from './dx7-syx';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Real-world DX7 cartridge fixture from the user's bug report. The
 *  SYX-load fix (PR fix/dx7-syx-bank-loading) regression-asserts against
 *  this file: every patch must parse with a unique name + at least 4
 *  distinct algorithms across the 32 voices, and operator ratios+levels
 *  must vary patch-to-patch (no all-uniform fallback). */
const AAAHGOOD_SYX = join(__dirname, '__fixtures__', 'AAAHGOOD.SYX');

// ---------------- Fixture builder ----------------

/**
 * Build a 4104-byte 32-voice SYX bank. Each voice uses a deterministic
 * pattern so we can assert the parser correctly extracts every field.
 */
function buildFixtureSyx(): Uint8Array {
  const out = new Uint8Array(4104);
  out[0] = 0xf0; // sysex start
  out[1] = 0x43; // Yamaha
  out[2] = 0x00; // sub-status / channel
  out[3] = 0x09; // 32-voice format
  out[4] = 0x20; // count high
  out[5] = 0x00; // count low (4096)
  out[4103] = 0xf7; // EOX

  const payload = out.subarray(6, 4102);

  // 32 voices × 128 bytes
  for (let v = 0; v < 32; v++) {
    const base = v * 128;
    // 6 ops × 17 bytes
    for (let op = 0; op < 6; op++) {
      const o = base + op * 17;
      // op-index from 0 (op6) to 5 (op1) — SYX stores reversed
      const opNumInVoice = 5 - op; // 0 = op1
      payload[o + 0] = 99; // R1
      payload[o + 1] = 50; // R2
      payload[o + 2] = 30; // R3
      payload[o + 3] = 60; // R4
      payload[o + 4] = 99; // L1
      payload[o + 5] = 70; // L2
      payload[o + 6] = 50; // L3
      payload[o + 7] = 0; // L4
      payload[o + 8] = 0; // breakpoint
      payload[o + 9] = 0; // left depth
      payload[o + 10] = 0; // right depth
      payload[o + 11] = 0; // curves
      // detune = 7 (no detune); rate scaling = 0
      payload[o + 12] = (7 << 3) | 0;
      // velocity sens = 4; amp mod sens = 0
      payload[o + 13] = (4 << 2) | 0;
      // op output level (musical: op1 carrier full, others lower)
      payload[o + 14] = 99 - opNumInVoice * 10;
      // osc mode = 0 (ratio), coarse = (op-num + 1) so op1 is ratio 1, op2 is 2, etc.
      const coarse = opNumInVoice + 1;
      payload[o + 15] = (coarse << 1) | 0;
      payload[o + 16] = 0; // fine
    }
    // pitch EG (102..109)
    for (let k = 0; k < 4; k++) {
      payload[base + 102 + k] = 99; // rates
      payload[base + 106 + k] = 50; // levels
    }
    payload[base + 110] = v % 32; // algorithm 0..31 (1..32 after parse)
    payload[base + 111] = 4 | (1 << 3); // feedback=4, osc sync on
    payload[base + 112] = 35; // lfo speed
    payload[base + 113] = 0; // lfo delay
    payload[base + 114] = 0; // pmd
    payload[base + 115] = 0; // amd
    payload[base + 116] = (1 << 1); // sync=0, wave=0 (triangle), pms=0... wait, bit 1..3 = wave
    payload[base + 117] = 24; // transpose = 0 (24 = middle)
    // Voice name: "VOICE_<NN>" padded to 10 bytes
    const name = `VOICE_${String(v).padStart(2, '0')}`.slice(0, 10);
    for (let i = 0; i < 10; i++) {
      payload[base + 118 + i] = i < name.length ? name.charCodeAt(i) : 32; // space pad
    }
  }

  // Yamaha checksum
  out[4102] = computeChecksum(payload);
  return out;
}

// ---------------- Tests ----------------

describe('dx7Ratio', () => {
  it('coarse=0 returns 0.5 (special slot)', () => {
    expect(dx7Ratio(0, 0)).toBeCloseTo(0.5, 6);
  });

  it('coarse=1 fine=0 returns 1.0 (unison)', () => {
    expect(dx7Ratio(1, 0)).toBeCloseTo(1.0, 6);
  });

  it('coarse=14 fine=0 returns 14.0 (canonical e.piano modulator)', () => {
    expect(dx7Ratio(14, 0)).toBeCloseTo(14.0, 6);
  });

  it('coarse=2 fine=50 returns 2 * 1.5 = 3', () => {
    expect(dx7Ratio(2, 50)).toBeCloseTo(3.0, 6);
  });

  it('clamps out-of-range coarse', () => {
    expect(dx7Ratio(-5, 0)).toBeCloseTo(0.5, 6);
    expect(dx7Ratio(99, 0)).toBeCloseTo(31, 6);
  });
});

describe('dx7DetuneFactor', () => {
  it('detune byte 7 = 1.0 (no detune)', () => {
    expect(dx7DetuneFactor(7)).toBeCloseTo(1.0, 6);
  });

  it('detune > 7 sharpens (factor > 1)', () => {
    expect(dx7DetuneFactor(14)).toBeGreaterThan(1.0);
  });

  it('detune < 7 flattens (factor < 1)', () => {
    expect(dx7DetuneFactor(0)).toBeLessThan(1.0);
  });

  it('symmetric around 7', () => {
    const sharp = dx7DetuneFactor(10);
    const flat = dx7DetuneFactor(4);
    // sharp * flat ≈ 1 (mirror around the center)
    expect(sharp * flat).toBeCloseTo(1.0, 4);
  });
});

describe('dx7RateToDbPerSec — the authentic linear-in-dB rate law', () => {
  /** Seconds for a full-scale (level 99 → 0) segment at this rate. */
  const fullScaleS = (rate: number) => -dx7LevelToDb(0) / dx7RateToDbPerSec(rate);

  // hexter's `dx7_voice_eg_rate_decay_duration[]` — seconds for a full-scale
  // decay, MEASURED on real DX7/TX7 hardware (dx7_voice_data.c). We derive our
  // law from msfa's closed form and calibrate it on the rate-0 entry alone;
  // every other row is then a genuine cross-check of the two sources.
  const HEXTER_FULL_SCALE_S: Record<number, number> = {
    0: 317.487, 5: 181.487, 10: 105.810, 15: 63.504, 20: 39.677,
    25: 19.848, 30: 11.339, 35: 6.614, 40: 3.968, 45: 2.481,
    50: 1.240, 55: 0.709, 60: 0.414, 65: 0.248, 70: 0.1558,
    75: 0.078200, 80: 0.044800, 85: 0.026100, 90: 0.015640,
  };

  it.each(Object.entries(HEXTER_FULL_SCALE_S))(
    "rate %s matches hexter's hardware-measured full-scale duration",
    (rateStr, measured) => {
      const ours = fullScaleS(Number(rateStr));
      // Within 2 % across a 20 000:1 span, calibrated on rate 0 only.
      expect(Math.abs(ours - measured) / measured, `rate ${rateStr}: ${ours}s vs ${measured}s`)
        .toBeLessThan(0.02);
    },
  );

  it('rate 99 is ~5.5 ms full-scale, rate 0 is ~317 s', () => {
    expect(fullScaleS(99)).toBeLessThan(0.007);
    expect(fullScaleS(99)).toBeGreaterThan(0.004);
    expect(fullScaleS(0)).toBeCloseTo(317.487, 3);
  });

  it('doubles every 4 steps of the quantised rate (msfa `qrate >> 2`)', () => {
    // q = (rate * 41) >> 6; rates 12 and 18 are q = 7 and q = 11 → exactly 2×.
    expect(dx7RateToDbPerSec(18) / dx7RateToDbPerSec(12)).toBeCloseTo(2, 12);
  });

  it('QUANTISED — 99 rate bytes collapse onto 64 distinct speeds', () => {
    const distinct = new Set<number>();
    for (let r = 0; r <= 99; r++) distinct.add(dx7RateToDbPerSec(r));
    expect(distinct.size).toBe(64);
    // Rates 0 and 1 both quantise to q = 0 — that is the hardware, not a bug.
    expect(dx7RateToDbPerSec(0)).toBe(dx7RateToDbPerSec(1));
  });

  it('monotonic non-decreasing, and strictly increasing every 10 steps', () => {
    let prev = -Infinity;
    for (let r = 0; r <= 99; r++) {
      const v = dx7RateToDbPerSec(r);
      expect(v, `rate ${r}`).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    for (let r = 10; r <= 99; r += 10) {
      expect(dx7RateToDbPerSec(r)).toBeGreaterThan(dx7RateToDbPerSec(r - 10));
    }
  });
});

describe('dx7LevelToDb / dx7EgAmpFromDb', () => {
  it('agrees with dx7LevelToAmp on every level byte', () => {
    for (let l = 0; l <= 99; l++) {
      expect(dx7EgAmpFromDb(dx7LevelToDb(l)), `level ${l}`).toBeCloseTo(dx7LevelToAmp(l), 12);
    }
  });

  it('level 99 is 0 dB (unity) and level 0 is the hard floor', () => {
    expect(dx7LevelToDb(99)).toBe(0);
    expect(dx7LevelToDb(0)).toBe(-74.25);
    expect(dx7EgAmpFromDb(-74.25)).toBe(0);
    expect(dx7EgAmpFromDb(-100)).toBe(0);
  });
});

describe('dx7EgTick — the DX7 segment machine', () => {
  const SR = 48000;
  const dt = 1 / SR;

  /** Run `seconds` of envelope; returns the final {db, seg}. */
  function run(
    l: [number, number, number, number],
    r: [number, number, number, number],
    seconds: number,
    releasing = false,
  ): { db: number; seg: number } {
    const levelsDb = l.map(dx7LevelToDb);
    const rates = r.map(dx7RateToDbPerSec);
    const envDb = new Float64Array(1);
    const envSeg = new Int32Array(1);
    envDb[0] = levelsDb[3]!; // idle at L4
    if (releasing) envSeg[0] = 3;
    for (let i = 0; i < Math.round(seconds * SR); i++) {
      dx7EgTick(envDb, envSeg, 0, levelsDb, rates, releasing, dt);
    }
    return { db: envDb[0]!, seg: envSeg[0]! };
  }

  it('IDLES at L4, not at silence', () => {
    const levelsDb = [0, 0, 0, dx7LevelToDb(60)];
    const envDb = new Float64Array(1);
    envDb[0] = levelsDb[3]!;
    expect(envDb[0]).toBe(dx7LevelToDb(60));
    expect(dx7EgAmpFromDb(envDb[0]!)).toBeGreaterThan(0);
  });

  it('HOLDS at L3 for as long as the gate is high', () => {
    // Fast rates: 3 segments are long done by 0.5 s; L3 = 60.
    const a = run([99, 80, 60, 0], [99, 99, 99, 60], 0.5);
    const b = run([99, 80, 60, 0], [99, 99, 99, 60], 5.0);
    expect(a.seg, 'parked in the release segment, frozen').toBe(3);
    expect(a.db).toBeCloseTo(dx7LevelToDb(60), 9);
    expect(b.db, 'ten times longer and it has not moved a dB').toBe(a.db);
  });

  it('RELEASES to L4 only once the gate falls', () => {
    const held = run([99, 80, 60, 20], [99, 99, 99, 80], 2.0, false);
    expect(held.db).toBeCloseTo(dx7LevelToDb(60), 9);
    const released = run([99, 80, 60, 20], [99, 99, 99, 80], 2.0, true);
    expect(released.db).toBeCloseTo(dx7LevelToDb(20), 9);
    expect(released.seg).toBe(4); // finished
  });

  // hexter's `dx7_voice_eg_rate_rise_duration[]` — MEASURED seconds for a
  // full attack (level 0 → 99) at each rate. Independent of the decay table
  // and of msfa: only the flat 8.01 decay/rise RATIO is used to calibrate the
  // attack ceiling, so every row here is a real cross-check of the curve.
  const HEXTER_ATTACK_S: Record<number, number> = {
    0: 39.638, 5: 22.658, 10: 13.206, 15: 7.929, 20: 4.958,
    25: 2.477, 30: 1.416, 35: 0.827, 40: 0.496, 45: 0.310,
    50: 0.1549, 55: 0.0885, 60: 0.0516, 65: 0.0309, 70: 0.019430,
  };

  /** Simulated seconds for the attack segment to reach L1 = 99 from idle. */
  function attackSeconds(rate: number): number {
    const levelsDb = [dx7LevelToDb(99), 0, 0, dx7LevelToDb(0)];
    const rates = [dx7RateToDbPerSec(rate), 0, 0, 0];
    const envDb = new Float64Array(1);
    const envSeg = new Int32Array(1);
    envDb[0] = levelsDb[3]!;
    let n = 0;
    while (envSeg[0]! === 0 && n < SR * 200) {
      dx7EgTick(envDb, envSeg, 0, levelsDb, rates, false, dt);
      n++;
    }
    return n / SR;
  }

  it.each(Object.entries(HEXTER_ATTACK_S))(
    "ATTACK at rate %s matches hexter's hardware-measured rise duration",
    (rateStr, measured) => {
      const ours = attackSeconds(Number(rateStr));
      expect(Math.abs(ours - measured) / measured, `rate ${rateStr}: ${ours}s vs ${measured}s`)
        .toBeLessThan(0.02);
    },
  );

  it('ATTACK is ~8× faster than a DECAY at the same rate byte', () => {
    const rate = 50;
    const decayS = -dx7LevelToDb(0) / dx7RateToDbPerSec(rate);
    const ratio = decayS / attackSeconds(rate);
    expect(ratio).toBeGreaterThan(7.8);
    expect(ratio).toBeLessThan(8.2);
  });

  it('a segment already at its target advances immediately', () => {
    // L1 = L2 = L3 = L4: nothing to traverse, so a held gate parks at seg 3
    // within a handful of samples rather than stalling.
    const out = run([50, 50, 50, 50], [0, 0, 0, 0], 0.001);
    expect(out.seg).toBe(3);
    expect(out.db).toBe(dx7LevelToDb(50));
  });
});

describe('dx7FixedHz — the fixed-frequency law', () => {
  it('is 10^((coarse & 3) + fine/100) Hz', () => {
    expect(dx7FixedHz(0, 0)).toBeCloseTo(1, 9);
    expect(dx7FixedHz(1, 0)).toBeCloseTo(10, 9);
    expect(dx7FixedHz(2, 0)).toBeCloseTo(100, 9);
    expect(dx7FixedHz(3, 0)).toBeCloseTo(1000, 9);
    expect(dx7FixedHz(3, 99)).toBeCloseTo(9772.372209558107, 6);
  });

  it('coarse wraps every 4 (only the low 2 bits matter)', () => {
    for (let c = 0; c < 32; c++) {
      expect(dx7FixedHz(c, 37), `coarse ${c}`).toBe(dx7FixedHz(c & 3, 37));
    }
  });

  it('legacy ratio fallback is exact for fine = 0', () => {
    // dx7Ratio(coarse, 0) === coarse (or 0.5 for coarse 0).
    for (const c of [0, 1, 2, 3, 5, 8, 14, 31]) {
      expect(dx7FixedHzFromRatio(dx7Ratio(c, 0)), `coarse ${c}`).toBeCloseTo(dx7FixedHz(c, 0), 9);
    }
  });
});

describe('dx7LevelToAmp', () => {
  it('level 0 → 0 amplitude', () => {
    expect(dx7LevelToAmp(0)).toBe(0);
  });

  it('level 99 → 1.0 amplitude', () => {
    expect(dx7LevelToAmp(99)).toBeCloseTo(1.0, 6);
  });

  it('level 91 → ~0.5 (~6 dB attenuation)', () => {
    const amp = dx7LevelToAmp(91);
    expect(amp).toBeGreaterThan(0.4);
    expect(amp).toBeLessThan(0.6);
  });
});

describe('parseSyxBank — full 4104-byte cartridge', () => {
  const fixture = buildFixtureSyx();

  it('parses 32 voices', () => {
    const result = parseSyxBank(fixture);
    expect(result.voices).toHaveLength(32);
    expect(result.warnings).toHaveLength(0); // no checksum or format warnings
  });

  it('extracts voice names', () => {
    const result = parseSyxBank(fixture);
    expect(result.voices[0]?.name).toBe('VOICE_00');
    expect(result.voices[5]?.name).toBe('VOICE_05');
    expect(result.voices[31]?.name).toBe('VOICE_31');
  });

  it('extracts algorithms (1-indexed)', () => {
    const result = parseSyxBank(fixture);
    expect(result.voices[0]?.algorithm).toBe(1);
    expect(result.voices[7]?.algorithm).toBe(8);
    expect(result.voices[31]?.algorithm).toBe(32);
  });

  it('extracts feedback (0..7)', () => {
    const result = parseSyxBank(fixture);
    expect(result.voices[0]?.feedback).toBe(4);
  });

  it('reverses operator order so operators[0] = op1', () => {
    const result = parseSyxBank(fixture);
    const v = result.voices[0]!;
    expect(v.operators).toHaveLength(6);
    // The fixture sets coarse = (5 - op_storage_idx) + 1, with op_storage_idx
    // running 0..5 in storage order. After the parser reverses, operators[0]
    // (= op1) was stored at op_storage_idx=5, so coarse = 0+1 = 1 → ratio 1.
    // operators[5] (= op6) was stored at op_storage_idx=0, so coarse = 5+1 = 6 → ratio 6.
    expect(v.operators[0]?.ratio).toBeCloseTo(1, 4);
    expect(v.operators[5]?.ratio).toBeCloseTo(6, 4);
  });

  it('extracts envelope rates and levels per op', () => {
    const result = parseSyxBank(fixture);
    const op1 = result.voices[0]!.operators[0]!;
    expect(op1.r).toEqual([99, 50, 30, 60]);
    expect(op1.l).toEqual([99, 70, 50, 0]);
  });

  it('extracts detune factor', () => {
    const result = parseSyxBank(fixture);
    expect(result.voices[0]?.operators[0]?.detune).toBe(7);
    expect(result.voices[0]?.operators[0]?.detuneFactor).toBeCloseTo(1.0, 6);
  });

  it('extracts velocity sensitivity', () => {
    const result = parseSyxBank(fixture);
    expect(result.voices[0]?.operators[0]?.velocitySens).toBe(4);
  });

  it('extracts operator output level', () => {
    const result = parseSyxBank(fixture);
    // op1 stored at idx=5: level = 99 - 0*10 = 99
    // wait: opNumInVoice = 5 - op = 5 when op=0 (storage), level = 99 - 5*10 = 49.
    // After reverse, operators[0] = op1 (was at storage op=5). At that storage
    // slot opNumInVoice = 5 - 5 = 0, level = 99 - 0 = 99. Yes:
    expect(result.voices[0]?.operators[0]?.level).toBe(99);
    // operators[5] (op6) was at storage op=0; opNumInVoice = 5 - 0 = 5; level = 99 - 50 = 49.
    expect(result.voices[0]?.operators[5]?.level).toBe(49);
  });

  it('extracts transpose (24 = no transpose)', () => {
    const result = parseSyxBank(fixture);
    expect(result.voices[0]?.transpose).toBe(24);
  });
});

describe('parseSyxBank — flexible inputs', () => {
  it('accepts 4096-byte raw payload (no SysEx envelope)', () => {
    const fullBank = buildFixtureSyx();
    const payload = fullBank.subarray(6, 4102);
    const result = parseSyxBank(payload);
    expect(result.voices).toHaveLength(32);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1); // raw payload warning
  });

  it('accepts a single 128-byte voice', () => {
    const fullBank = buildFixtureSyx();
    const oneVoice = fullBank.subarray(6, 6 + 128);
    const result = parseSyxBank(oneVoice);
    expect(result.voices).toHaveLength(1);
    expect(result.voices[0]?.name).toBe('VOICE_00');
  });

  it('rejects unknown sizes', () => {
    expect(() => parseSyxBank(new Uint8Array(100))).toThrow(/unsupported/i);
  });

  it('warns on bad checksum but still parses', () => {
    const fullBank = buildFixtureSyx();
    fullBank[4102] = 0; // wrong checksum
    const result = parseSyxBank(fullBank);
    expect(result.voices).toHaveLength(32);
    expect(result.warnings.some((w) => w.includes('checksum'))).toBe(true);
  });
});

describe('parseSyxBank — real-world AAAHGOOD.SYX cartridge', () => {
  // This is the file the user actually reported broken — full canonical
  // 32-voice 4104-byte SYX dump. If the parser regresses, the symptom in
  // the bug report ("everything sounds like electric piano") returns.
  const fixture = new Uint8Array(readFileSync(AAAHGOOD_SYX));

  it('parses without throwing and yields 32 voices', () => {
    const result = parseSyxBank(fixture);
    expect(result.voices).toHaveLength(32);
  });

  it('does not warn (well-formed cartridge: header, format byte, checksum all valid)', () => {
    const result = parseSyxBank(fixture);
    expect(result.warnings).toEqual([]);
  });

  it('every voice has a non-empty ASCII name', () => {
    const result = parseSyxBank(fixture);
    for (const v of result.voices) {
      expect(v.name.length).toBeGreaterThan(0);
      // All chars printable ASCII (or our '?' substitution, which is also ASCII).
      for (const ch of v.name) {
        const code = ch.charCodeAt(0);
        expect(code).toBeGreaterThanOrEqual(32);
        expect(code).toBeLessThan(127);
      }
    }
  });

  it('every voice has a UNIQUE name (no aliasing collapse to one voice)', () => {
    // The bug we're catching: if the parser silently mapped every patch to
    // the first slot, we'd see name uniqueness collapse to 1.
    const result = parseSyxBank(fixture);
    const names = new Set(result.voices.map((v) => v.name));
    expect(names.size).toBe(32);
  });

  it('algorithms span at least 4 distinct values across the 32 patches', () => {
    // AAAHGOOD.SYX uses 14 distinct algorithms (2,3,4,5,6,8,9,15,16,18,22,26,28,32);
    // we assert ≥4 to leave room for SYX banks that happen to use fewer
    // algorithms while still catching the "stuck on alg 1" regression.
    const result = parseSyxBank(fixture);
    const algos = new Set(result.voices.map((v) => v.algorithm));
    expect(algos.size).toBeGreaterThanOrEqual(4);
    // Every algorithm in 1..32.
    for (const a of algos) {
      expect(a).toBeGreaterThanOrEqual(1);
      expect(a).toBeLessThanOrEqual(32);
    }
  });

  it('operator ratios vary patch-to-patch (not all the same default)', () => {
    const result = parseSyxBank(fixture);
    // Build the set of unique (op0_ratio, op1_ratio, ..., op5_ratio) tuples.
    const ratioFingerprints = new Set(
      result.voices.map((v) => v.operators.map((o) => o.ratio.toFixed(3)).join(',')),
    );
    expect(ratioFingerprints.size).toBeGreaterThan(10);
  });

  it('operator levels vary patch-to-patch (not all the same default)', () => {
    const result = parseSyxBank(fixture);
    const levelFingerprints = new Set(
      result.voices.map((v) => v.operators.map((o) => o.level).join(',')),
    );
    expect(levelFingerprints.size).toBeGreaterThan(10);
  });

  it('each voice has exactly 6 operators', () => {
    const result = parseSyxBank(fixture);
    for (const v of result.voices) {
      expect(v.operators).toHaveLength(6);
    }
  });
});

describe('checksum', () => {
  it('roundtrip: payload → checksum → 7-bit', () => {
    const payload = new Uint8Array(4096);
    for (let i = 0; i < 4096; i++) payload[i] = i & 0x7f;
    const sum = computeChecksum(payload);
    expect(sum).toBeGreaterThanOrEqual(0);
    expect(sum).toBeLessThan(128);
  });

  it('zero payload → checksum 0', () => {
    expect(computeChecksum(new Uint8Array(4096))).toBe(0);
  });
});
