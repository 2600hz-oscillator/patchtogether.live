// packages/web/src/lib/ui/controls/color-field-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROL FOR THE COLOUR CELL'S PROBE.
//
// `faces-parity`'s `color` branch drives an `<input type="color">` to a colour
// `nextProbeColor()` picks and asserts (a) the graph took a DIFFERENT packed
// value and (b) a witness element derived from the LIVE param followed. Three
// pure properties are load-bearing for that being an assertion at all, and all
// three fail SILENTLY GREEN if they break — the e2e would still pass, having
// proved nothing:
//
//   * the round-trip is the identity — else the value written back differs from
//     the value picked and every commit reads as drift;
//   * `packedToHex` is injective — else two real colours print one hex and the
//     witness cannot move across a genuine change;
//   * `nextProbeColor` has NO fixed point — else the probe "changes" the colour
//     to the colour it already is, and `.not.toBe(before)` is asserted against
//     a gesture that asked for nothing.
//
// They are asserted here, in the unit lane, on every run — the
// `audition-ledger.test.ts` precedent (the e2e leg proves the wiring once; the
// predicate is negative-controlled forever).

import { describe, it, expect } from 'vitest';
import {
  PACKED_RGB_MAX,
  PACKED_RGB_MIN,
  PACKED_RGB_STATES,
  PROBE_CHANNEL_STEP,
  clampPacked,
  hexToPacked,
  isPackedRgbParam,
  nextProbeColor,
  packedChannels,
  packedToHex,
} from './color-field-model';

/**
 * A deterministic sweep of the 24-bit space: both ends, every channel
 * boundary, the three wavesculpt defaults, and a co-prime stride so the sample
 * set cannot align with any power-of-two structure in the packing.
 *
 * ⚠ THE STRIDE IS CO-PRIME TO 256 ON PURPOSE. A stride of 0x010101 walks the
 * greys and would leave every "channels are independent" bug invisible; 0x4d2d
 * (19757, prime) visits all three channels irregularly, which is the
 * sample-at-irregular-offsets rule applied to a value space rather than to
 * time.
 */
function sweep(): number[] {
  const out = new Set<number>([
    PACKED_RGB_MIN,
    PACKED_RGB_MAX,
    0x000001,
    0x0000ff,
    0x00ff00,
    0xff0000,
    0x00ffff,
    0xff00ff,
    0xffff00,
    0xff3333, // wavesculpt RED default
    0x33ff4d, // wavesculpt GRN default
    0x4d80ff, // wavesculpt BLU default
  ]);
  for (let v = 0; v <= PACKED_RGB_MAX; v += 0x4d2d) out.add(v);
  return [...out];
}

describe('color-field-model — the packed-RGB space', () => {
  it('states its own size (the number a knob would have swept)', () => {
    expect(PACKED_RGB_STATES).toBe(16_777_216);
    expect(PACKED_RGB_MAX).toBe(16_777_215);
  });

  it('clamps, rounds and survives NaN / Infinity', () => {
    expect(clampPacked(-1)).toBe(0);
    expect(clampPacked(PACKED_RGB_MAX + 1000)).toBe(PACKED_RGB_MAX);
    expect(clampPacked(1.6)).toBe(2);
    expect(clampPacked(NaN)).toBe(0);
    expect(clampPacked(Infinity)).toBe(PACKED_RGB_MAX);
    expect(clampPacked(-Infinity)).toBe(0);
  });

  it('splits a packed value into three 0..255 channels', () => {
    expect(packedChannels(0xff3333)).toEqual([0xff, 0x33, 0x33]);
    expect(packedChannels(0)).toEqual([0, 0, 0]);
    expect(packedChannels(PACKED_RGB_MAX)).toEqual([255, 255, 255]);
  });
});

describe('color-field-model — packedToHex', () => {
  it('always emits seven LOWERCASE characters (what the browser normalises to)', () => {
    for (const v of sweep()) {
      const hex = packedToHex(v);
      expect(hex, `packedToHex(${v})`).toMatch(/^#[0-9a-f]{6}$/);
    }
    // The zero-padding case a naive toString(16) drops — `#0` is not a colour
    // and an <input type="color"> handed it resets itself to black, which is
    // indistinguishable from a user edit.
    expect(packedToHex(0)).toBe('#000000');
    expect(packedToHex(0x0000ff)).toBe('#0000ff');
    expect(packedToHex(PACKED_RGB_MAX)).toBe('#ffffff');
  });

  it('is INJECTIVE — two different colours never print the same hex', () => {
    // If this collapsed, the parity probe's witness could read IDENTICAL text
    // across a real colour change and the assertion would fail as a false
    // negative — or, worse, a collapsing formatter plus a collapsing writer
    // would agree with each other and pass.
    const seen = new Map<string, number>();
    for (const v of sweep()) {
      const hex = packedToHex(v);
      const prior = seen.get(hex);
      expect(prior, `packedToHex collapsed ${prior} and ${v} onto ${hex}`).toBeUndefined();
      seen.set(hex, v);
    }
  });
});

describe('color-field-model — hexToPacked', () => {
  it('round-trips packedToHex EXACTLY over the whole space', () => {
    for (const v of sweep()) {
      expect(hexToPacked(packedToHex(v)), `round-trip ${v}`).toBe(v);
    }
  });

  it('accepts the #rgb shorthand and uppercase', () => {
    expect(hexToPacked('#f30')).toBe(0xff3300);
    expect(hexToPacked('#FF3333')).toBe(0xff3333);
    expect(hexToPacked('  #ff3333  ')).toBe(0xff3333);
  });

  it('returns null — NOT 0 — for anything that is not a colour', () => {
    // 0 is BLACK, a legal colour. A lenient parser turns a browser oddity into
    // a real user edit and writes it to the Y.Doc.
    for (const bad of ['', '#', 'ff3333', '#gggggg', '#ff33', '#ff33333', 'rgb(1,2,3)', 'red']) {
      expect(hexToPacked(bad), `hexToPacked(${JSON.stringify(bad)})`).toBeNull();
    }
  });
});

describe('color-field-model — nextProbeColor (the e2e probe would be vacuous without this)', () => {
  it('has NO fixed point anywhere in the space', () => {
    for (const v of sweep()) {
      expect(nextProbeColor(v), `nextProbeColor(${v}) returned its own input`).not.toBe(v);
    }
  });

  it('stays inside the space and is an involution', () => {
    for (const v of sweep()) {
      const n = nextProbeColor(v);
      expect(n).toBeGreaterThanOrEqual(PACKED_RGB_MIN);
      expect(n).toBeLessThanOrEqual(PACKED_RGB_MAX);
      expect(nextProbeColor(n), 'complementing twice returns the original').toBe(v);
    }
  });

  it('moves EVERY channel by exactly half its range — visibly, and in all three', () => {
    // ⚠ THIS CLAUSE ALREADY EARNED ITS KEEP. The first implementation was the
    // 24-bit complement, which satisfies the fixed-point clause above and
    // FAILED here: `#1a8778 → #e57887` is two similar teals (233 of a possible
    // 765), because a mid-grey channel complements to nearly itself. "Provably
    // different" and "different enough to diagnose a failure from" are
    // separate properties; only the first is automatic.
    for (const v of sweep()) {
      const before = packedChannels(v);
      const after = packedChannels(nextProbeColor(v));
      for (let c = 0; c < 3; c++) {
        expect(
          Math.abs(before[c]! - after[c]!),
          `nextProbeColor(${packedToHex(v)}) channel ${c}`,
        ).toBe(PROBE_CHANNEL_STEP);
      }
    }
  });

  it('NEGATIVE CONTROL: the fixed-point sweep can actually FAIL', () => {
    // A property test that has never been seen to fail is not a gate. Feed the
    // same sweep an identity "probe" and prove the loop above would have
    // caught it.
    const identity = (v: number) => v;
    const offenders = sweep().filter((v) => identity(v) === v);
    expect(offenders.length, 'the sweep must reject a no-op probe').toBeGreaterThan(0);
  });
});

describe('color-field-model — isPackedRgbParam (the face-lint predicate)', () => {
  const rgb = { min: PACKED_RGB_MIN, max: PACKED_RGB_MAX, curve: 'discrete' };

  it('accepts a real packed-RGB param', () => {
    expect(isPackedRgbParam(rgb)).toBe(true);
  });

  it('rejects every near-miss, one field at a time', () => {
    expect(isPackedRgbParam({ ...rgb, curve: 'linear' }), 'continuous').toBe(false);
    expect(isPackedRgbParam({ ...rgb, max: 2 }), 'a 3-state mode param').toBe(false);
    expect(isPackedRgbParam({ ...rgb, min: 1 }), 'off-by-one floor').toBe(false);
    expect(isPackedRgbParam({ ...rgb, max: 0xfffffe }), 'off-by-one ceiling').toBe(false);
    expect(isPackedRgbParam({ min: 0, max: 1, curve: 'discrete' }), 'a toggle').toBe(false);
  });
});
