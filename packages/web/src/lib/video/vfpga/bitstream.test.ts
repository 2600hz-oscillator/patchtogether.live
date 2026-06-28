// packages/web/src/lib/video/vfpga/bitstream.test.ts
//
// Pure (GL-free) tests for the VFPGA bitstream codec (hardware-accuracy A3).
// Pins the two HARD properties — lossless round-trip + byte-identical compiled
// effect — across every shipped fabric, plus the CRC, header guards, and the
// forward-compat / numeric / string edge cases the real fixtures don't exercise.
//
// NOTE: toStrictEqual round-trip is guaranteed only for fabrics WITHOUT
// explicit-undefined-valued keys ({pos: undefined} decodes to the key absent).
// The specs/*.ts fixtures comply, and every synthetic fabric below is built via
// conditional assignment, so the property holds. (Documented per the A3 verifier.)

import { describe, expect, it } from 'vitest';
import { pack, unpack, crc32 } from './bitstream';
import { fabricToEffect } from './place-and-route';
import { listVfpgaSpecs } from './registry';
import type { VfpgaFabric, VfpgaTile } from './types';

const LE = true;
const FABRIC_SPECS = listVfpgaSpecs().filter((s) => s.fabric);

/** Minimal 1-tile fabric carrying a given tile config (+ optional tile fields). */
function fab(config: VfpgaTile['config'], extra?: Partial<VfpgaTile>): VfpgaFabric {
  return {
    grid: { rows: 1, cols: 1 },
    tiles: [{ id: 't', type: 'clb', config, ...extra }],
    nets: [],
    outputs: { vout1: 't' },
  };
}
const rt = (f: VfpgaFabric): VfpgaFabric => unpack(pack(f));

// ----------------------------------------------------------------------
// The two hard properties, over every shipped fabric.
// ----------------------------------------------------------------------
describe('round-trip every shipped fabric spec', () => {
  it('there is at least one fabric spec to test', () => {
    expect(FABRIC_SPECS.length).toBeGreaterThan(0);
  });
  it.each(FABRIC_SPECS.map((s) => [s.id, s.fabric!] as const))(
    'unpack(pack(%s)) deep-equals the fabric',
    (_id, fabric) => {
      expect(rt(fabric)).toStrictEqual(fabric);
    },
  );
});

describe('byte-identical compiled effect (no VRT/attest rebaseline)', () => {
  it.each(FABRIC_SPECS.map((s) => [s.id, s.fabric!] as const))(
    'fabricToEffect(unpack(pack(%s))) equals fabricToEffect(fabric)',
    (_id, fabric) => {
      expect(fabricToEffect(rt(fabric))).toStrictEqual(fabricToEffect(fabric));
    },
  );
});

// ----------------------------------------------------------------------
// Determinism golden — catches a field added to pack() but not the symbol
// builder (which still round-trips, but drifts the bytes / CRC).
// ----------------------------------------------------------------------
describe('determinism', () => {
  const golden = fab(
    { op: 'mix', consts: { t: 0.5 }, bind: [{ knob: 't', to: 'p', slot: 1, uniform: 'uMixT' }] },
    { inputs: ['a', 'b'], pos: { row: 0, col: 0 } },
  );
  it('pack is byte-stable', () => {
    expect(Array.from(pack(golden))).toMatchSnapshot();
  });
  it('pack is repeatable', () => {
    expect(Array.from(pack(golden))).toEqual(Array.from(pack(golden)));
  });
});

// ----------------------------------------------------------------------
// CRC.
// ----------------------------------------------------------------------
describe('CRC', () => {
  it('detects a single-bit flip', () => {
    const bytes = pack(fab({ consts: { a: 0.5 } }));
    const corrupt = bytes.slice();
    corrupt[12]! ^= 0x01; // gridRows f64 mantissa — a value byte
    expect(() => unpack(corrupt)).toThrow(/CRC mismatch/);
  });

  it('a value-byte flip + CRC re-stamp yields a VALID but DIFFERENT fabric (the bend seam)', () => {
    const f = fab({ consts: { a: 0.5 } });
    const bent = pack(f).slice();
    bent[12]! ^= 0x01; // flip gridRows mantissa
    const bodyEnd = bent.length - 4;
    new DataView(bent.buffer).setUint32(bodyEnd, crc32(bent, 0, bodyEnd), LE);
    const r = unpack(bent); // CRC now valid → decodes
    expect(r).not.toStrictEqual(f); // grid.rows drifted
    expect(r.grid.rows).not.toBe(1);
  });

  it('crc32 is unsigned', () => {
    expect(crc32(Uint8Array.of(0, 1, 2, 3))).toBeGreaterThanOrEqual(0);
  });
});

// ----------------------------------------------------------------------
// Header / forward-compat guards.
// ----------------------------------------------------------------------
describe('header guards', () => {
  const valid = () => pack(fab({}));
  const restamp = (b: Uint8Array) => {
    const e = b.length - 4;
    new DataView(b.buffer).setUint32(e, crc32(b, 0, e), LE);
    return b;
  };
  it('rejects a bad sync preamble', () => {
    const b = valid(); b[0]! ^= 0xff; restamp(b);
    expect(() => unpack(b)).toThrow(/sync/);
  });
  it('rejects a wrong magic', () => {
    const b = valid(); b[4]! ^= 0xff; restamp(b);
    expect(() => unpack(b)).toThrow(/magic/);
  });
  it('rejects an unsupported version', () => {
    const b = valid(); new DataView(b.buffer).setUint16(8, 2, LE); restamp(b);
    expect(() => unpack(b)).toThrow(/version/);
  });
  it('rejects nonzero reserved header flags', () => {
    const b = valid(); new DataView(b.buffer).setUint16(10, 1, LE); restamp(b);
    expect(() => unpack(b)).toThrow(/reserved header flags/);
  });
});

// ----------------------------------------------------------------------
// Empty-vs-absent (toStrictEqual is strict on this).
// ----------------------------------------------------------------------
describe('empty-vs-absent', () => {
  it('config {} round-trips to {} (config is always present)', () => {
    const f = fab({});
    expect(rt(f).tiles[0]!.config).toStrictEqual({});
  });
  it('consts {} is distinct from absent', () => {
    const empty = fab({ consts: {} });
    const absent = fab({});
    expect(rt(empty)).toStrictEqual(empty);
    expect(rt(empty).tiles[0]!.config.consts).toStrictEqual({});
    expect('consts' in rt(absent).tiles[0]!.config).toBe(false);
  });
  it('bind [] is distinct from absent', () => {
    const f = fab({ bind: [] });
    expect(rt(f)).toStrictEqual(f);
    expect(rt(f).tiles[0]!.config.bind).toStrictEqual([]);
  });
  it('inputs [] is distinct from absent', () => {
    const f = fab({}, { inputs: [] });
    expect(rt(f)).toStrictEqual(f);
    expect(rt(f).tiles[0]!.inputs).toStrictEqual([]);
  });
  it("op '' is distinct from absent", () => {
    const empty = fab({ op: '' });
    expect(rt(empty)).toStrictEqual(empty);
    expect(rt(empty).tiles[0]!.config.op).toBe('');
    expect('op' in rt(fab({})).tiles[0]!.config).toBe(false);
  });
  it('kind absent vs rgba8 vs float', () => {
    expect('kind' in rt(fab({})).tiles[0]!.config).toBe(false);
    expect(rt(fab({ kind: 'rgba8' })).tiles[0]!.config.kind).toBe('rgba8');
    expect(rt(fab({ kind: 'float' })).tiles[0]!.config.kind).toBe('float');
  });
  it('outputs.vout2 absent vs empty-string vs id', () => {
    const absent = fab({});
    expect('vout2' in rt(absent).outputs).toBe(false);
    const empty: VfpgaFabric = { ...fab({}), outputs: { vout1: 't', vout2: '' } };
    expect(rt(empty)).toStrictEqual(empty);
    const id: VfpgaFabric = { ...fab({}), outputs: { vout1: 't', vout2: 't' } };
    expect(rt(id)).toStrictEqual(id);
  });
  it('budget absent vs {} vs present-zero vs partial', () => {
    expect('budget' in rt(fab({}))).toBe(false);
    const mk = (budget: VfpgaFabric['budget']): VfpgaFabric => ({ ...fab({}), budget });
    for (const b of [{}, { dsp: 0 }, { passes: 4 }, { dsp: 1, bramRows: 8, passes: 3 }]) {
      const f = mk(b);
      expect(rt(f)).toStrictEqual(f);
    }
  });
  it('bind.slot absent vs 0', () => {
    const withSlot = fab({ bind: [{ knob: 'k', to: 'cv', slot: 0, uniform: 'u' }] });
    const noSlot = fab({ bind: [{ knob: 'k', to: 'cv', uniform: 'u' }] });
    expect(rt(withSlot)).toStrictEqual(withSlot);
    expect(rt(noSlot)).toStrictEqual(noSlot);
    expect('slot' in rt(noSlot).tiles[0]!.config.bind![0]!).toBe(false);
  });
});

// ----------------------------------------------------------------------
// Numeric edge cases (every leaf rides f64 → bit-exact).
// ----------------------------------------------------------------------
describe('numeric leaves are bit-exact', () => {
  it('NaN / ±Infinity / -0 / subnormal / inexact / MAX round-trip through consts', () => {
    const f = fab({
      consts: { nan: NaN, pinf: Infinity, ninf: -Infinity, nz: -0, sub: 5e-324, inexact: 0.1 + 0.2, max: Number.MAX_VALUE, one: 1 },
    });
    const c = rt(f).tiles[0]!.config.consts!;
    expect(Number.isNaN(c.nan!)).toBe(true);
    expect(c.pinf).toBe(Infinity);
    expect(c.ninf).toBe(-Infinity);
    expect(Object.is(c.nz, -0)).toBe(true);
    expect(c.sub).toBe(5e-324);
    expect(c.inexact).toBe(0.1 + 0.2);
    expect(c.max).toBe(Number.MAX_VALUE);
    expect(c.one).toBe(1);
  });
  it('-0 also survives through taps / rows / clockDiv / pos / grid', () => {
    const f: VfpgaFabric = {
      grid: { rows: -0, cols: 1 },
      tiles: [{ id: 't', type: 'bram', config: { taps: [-0, 0.5], rows: -0, clockDiv: 2 }, pos: { row: 0, col: 0 } }],
      nets: [],
      outputs: { vout1: 't' },
    };
    const r = rt(f);
    expect(r).toStrictEqual(f);
    expect(Object.is(r.grid.rows, -0)).toBe(true);
    expect(Object.is(r.tiles[0]!.config.taps![0], -0)).toBe(true);
    expect(Object.is(r.tiles[0]!.config.rows, -0)).toBe(true);
  });
});

// ----------------------------------------------------------------------
// Synthetic lutInit / bitPlanes (no shipped spec exercises these — packed vs
// escape paths must both be lossless). Packed = u16 (shorter), escape = f64.
// ----------------------------------------------------------------------
describe('lutInit packed vs escape', () => {
  it('a valid u16 INIT takes the compact (shorter) packed path and round-trips', () => {
    const packed = fab({ lutInit: 0x6996 });
    const escape = fab({ lutInit: 0.5 });
    expect(rt(packed)).toStrictEqual(packed);
    expect(pack(packed).length).toBeLessThan(pack(escape).length); // u16 < f64
  });
  it.each([-1, 0.5, 70000])('out-of-domain lutInit %p escapes to f64 and round-trips', (v) => {
    const f = fab({ lutInit: v });
    expect(rt(f)).toStrictEqual(f);
  });
  it('lutInit -0 escapes (not packed to +0) and survives as -0', () => {
    const f = fab({ lutInit: -0 });
    expect(Object.is(rt(f).tiles[0]!.config.lutInit, -0)).toBe(true);
    expect(pack(f).length).toBe(pack(fab({ lutInit: 0.5 })).length); // took the f64 escape
  });
});

describe('bitPlanes packed mask vs escape', () => {
  it('an ascending unique 0..15 set packs to a mask and round-trips', () => {
    const f = fab({ bitPlanes: [0, 2, 5] });
    expect(rt(f)).toStrictEqual(f);
  });
  it.each([
    ['non-ascending + dup', [5, 2, 2]],
    ['fractional', [0.5]],
    ['negative-zero', [-0]],
  ] as const)('%s escapes to an f64 list preserving order', (_label, planes) => {
    const f = fab({ bitPlanes: planes.slice() });
    expect(rt(f)).toStrictEqual(f);
  });
});

// ----------------------------------------------------------------------
// String edge cases via the symbol table (UTF-8 + UTF-16LE fallback + dedup).
// ----------------------------------------------------------------------
describe('symbol table', () => {
  it('round-trips empty / NUL / lone-surrogate / emoji string keys', () => {
    const f = fab({ consts: { '': 1, 'a b': 2, '\uD800': 3, '🎛️': 4 } });
    expect(rt(f)).toStrictEqual(f);
  });
  it('dedups a string used as both tile id and output target', () => {
    const f: VfpgaFabric = { grid: { rows: 1, cols: 1 }, tiles: [{ id: 'o1', type: 'clb', config: {} }], nets: [], outputs: { vout1: 'o1' } };
    const bytes = pack(f);
    const symCount = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(32, LE);
    expect(symCount).toBe(1); // 'o1' interned exactly once
    expect(rt(f)).toStrictEqual(f);
  });
});
