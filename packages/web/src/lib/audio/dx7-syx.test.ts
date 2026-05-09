// packages/web/src/lib/audio/dx7-syx.test.ts
//
// Unit tests for the DX7 SYX parser, ratio math, and envelope helpers.
// We synthesize a known-good SYX bank in-memory (rather than ship a
// copyrighted ROM dump as a fixture) and roundtrip it through the parser.

import { describe, it, expect } from 'vitest';
import {
  parseSyxBank,
  dx7Ratio,
  dx7DetuneFactor,
  computeChecksum,
  dx7RateToCoef,
  dx7LevelToAmp,
} from './dx7-syx';

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

describe('dx7RateToCoef', () => {
  it('rate 99 produces a fast time-constant', () => {
    const coef = dx7RateToCoef(99);
    expect(coef).toBeGreaterThan(500); // very fast
  });

  it('rate 0 produces a slow time-constant', () => {
    const coef = dx7RateToCoef(0);
    expect(coef).toBeLessThan(1); // slow
  });

  it('monotonic (rate ↑ → coef ↑)', () => {
    let prev = -Infinity;
    for (let r = 0; r <= 99; r += 10) {
      const c = dx7RateToCoef(r);
      expect(c).toBeGreaterThan(prev);
      prev = c;
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
