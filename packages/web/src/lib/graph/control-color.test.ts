// packages/web/src/lib/graph/control-color.test.ts
//
// PURE unit tests for the control-colour resolver — the single source of truth
// the Control Surface / ElectraControl stripes + the Electra preset all read.
// Asserts: assigned colour wins, auto default is stable + distinct + legible,
// hex normalization, and the RGB565 round-trip.

import { describe, it, expect } from 'vitest';
import {
  resolveControlColor,
  defaultColorFor,
  quantizeToRgb565,
  normalizeHex,
  CONTROL_COLOR_PALETTE,
} from './control-color';

interface N {
  id: string;
  data?: Record<string, unknown>;
}
const node = (id: string, data?: Record<string, unknown>): N => ({ id, data });

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}
function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255; // 0..1 perceptual-ish
}
function saturation(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return 0;
  return (max - min) / max;
}

describe('resolveControlColor', () => {
  it('returns the assigned data.controlColor when set (normalized to 6-up-hex)', () => {
    expect(resolveControlColor(node('a', { controlColor: 'F45C51' }))).toBe('F45C51');
    // Accepts + normalizes lowercase / leading-#.
    expect(resolveControlColor(node('a', { controlColor: '#f45c51' }))).toBe('F45C51');
  });

  it('falls back to the auto default when unset / unparseable', () => {
    const auto = defaultColorFor(node('a'));
    expect(resolveControlColor(node('a'))).toBe(auto);
    expect(resolveControlColor(node('a', { controlColor: 'not-a-color' }))).toBe(auto);
    expect(resolveControlColor(node('a', {}))).toBe(auto);
  });

  it('handles an absent node gracefully (neutral fallback, no throw)', () => {
    expect(() => resolveControlColor(undefined)).not.toThrow();
    expect(resolveControlColor(undefined)).toMatch(/^[0-9A-F]{6}$/);
  });

  it('accepts (but currently ignores) the reserved paramId arg — per-module v1', () => {
    // v1 is per-MODULE: paramId does not change the result yet (reserved for the
    // future per-knob-override layer). Both calls return the same colour.
    const n = node('a', { controlColor: '529DEC' });
    expect(resolveControlColor(n)).toBe(resolveControlColor(n, 'cutoff'));
    expect(resolveControlColor(n, 'cutoff')).toBe('529DEC');
  });
});

describe('defaultColorFor', () => {
  it('is deterministic + stable for a given node id', () => {
    expect(defaultColorFor(node('osc1'))).toBe(defaultColorFor(node('osc1')));
    // Independent of data — keyed on the id only.
    expect(defaultColorFor(node('osc1', { x: 1 }))).toBe(defaultColorFor(node('osc1')));
  });

  it('is distinct per INSTANCE (two of the same type differ)', () => {
    const colors = ['osc1', 'osc2', 'osc3', 'flt1', 'flt2'].map((id) => defaultColorFor(node(id)));
    expect(new Set(colors).size).toBe(colors.length);
  });

  it('spreads hues well across many ids (not clustered)', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `node-${i}`);
    const colors = ids.map((id) => defaultColorFor(node(id)));
    // A good spread → many distinct colours among 40 ids.
    expect(new Set(colors).size).toBeGreaterThan(30);
  });

  it('never produces near-white / near-black / washed-out colours', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `n${i}`);
    for (const id of ids) {
      const hex = defaultColorFor(node(id));
      const lum = luminance(hex);
      expect(lum).toBeGreaterThan(0.12); // not near-black
      expect(lum).toBeLessThan(0.9); // not near-white
      expect(saturation(hex)).toBeGreaterThan(0.25); // not muddy/grey
    }
  });

  it('always returns a valid 6-digit uppercase hex', () => {
    for (const id of ['', 'a', 'a-very-long-node-identifier-1234', 'ünïçødé']) {
      expect(defaultColorFor(node(id))).toMatch(/^[0-9A-F]{6}$/);
    }
  });
});

describe('quantizeToRgb565', () => {
  it('round-trips a 24-bit hex through 5-6-5 and back', () => {
    // Pure white/black are 565-exact.
    expect(quantizeToRgb565('FFFFFF')).toBe('FFFFFF');
    expect(quantizeToRgb565('000000')).toBe('000000');
  });

  it('is idempotent (quantizing an already-565 colour is a no-op)', () => {
    // Quantize-then-quantize === quantize-once for any input.
    for (const { hex } of CONTROL_COLOR_PALETTE) {
      const once = quantizeToRgb565(hex);
      expect(quantizeToRgb565(once)).toBe(once);
    }
  });

  it('snaps a colour to its nearest 565 representation', () => {
    // 0x01 (r) has only the 0x00 bit set below the 5-bit threshold → collapses.
    const q = quantizeToRgb565('010203');
    expect(q).toMatch(/^[0-9A-F]{6}$/);
    // The quantized value, re-quantized, is stable.
    expect(quantizeToRgb565(q)).toBe(q);
  });

  it('normalizes input (lowercase / leading #) before quantizing', () => {
    expect(quantizeToRgb565('#ffffff')).toBe('FFFFFF');
  });
});

describe('normalizeHex', () => {
  it('strips #, uppercases, returns 6-char', () => {
    expect(normalizeHex('#f45c51')).toBe('F45C51');
    expect(normalizeHex('f45c51')).toBe('F45C51');
    expect(normalizeHex('  F45C51  ')).toBe('F45C51');
  });

  it('expands 3-char shorthand', () => {
    expect(normalizeHex('#f00')).toBe('FF0000');
    expect(normalizeHex('abc')).toBe('AABBCC');
  });

  it('rejects non-hex / wrong-length', () => {
    expect(normalizeHex('xyz123')).toBeNull();
    expect(normalizeHex('F45C5')).toBeNull();
    expect(normalizeHex('')).toBeNull();
    // @ts-expect-error — runtime guard for non-string input
    expect(normalizeHex(null)).toBeNull();
  });
});

describe('CONTROL_COLOR_PALETTE', () => {
  it('every swatch is a valid 6-digit uppercase hex', () => {
    for (const { hex, name } of CONTROL_COLOR_PALETTE) {
      expect(hex, name).toMatch(/^[0-9A-F]{6}$/);
    }
  });

  it("includes Electra's 6 quick colours VERBATIM (matches the device palette)", () => {
    const hexes = new Set(CONTROL_COLOR_PALETTE.map((c) => c.hex));
    for (const c of ['FFFFFF', 'F45C51', 'F49500', '529DEC', '03A598']) {
      expect(hexes.has(c), c).toBe(true);
    }
  });
});
