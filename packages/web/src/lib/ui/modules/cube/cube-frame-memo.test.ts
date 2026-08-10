// packages/web/src/lib/ui/modules/cube/cube-frame-memo.test.ts
//
// THE MEMO, NEGATIVE-CONTROLLED IN BOTH DIRECTIONS.
//
// `cubeSlotFrames` exists because `resolveSlotFrames` COPIES every frame
// (~16 k floats per table, ~50 k across the three) and both faceplate panels
// read frames from a `$derived` that re-runs on every node-version bump — every
// tick of a knob drag. A cache is the fix; a cache is also the bug, twice over,
// and neither failure is visible from the UI:
//
//   a memo that never HITS  → the picture is correct and the copy happens
//                             anyway. Nothing looks wrong. Nothing is fixed.
//   a memo that never MISSES → the picture is stale forever, and it is stale
//                             with the confident look of a working cache.
//
// So this file measures BOTH, off the memo's own miss counter rather than off
// an argument, and it measures the property the Svelte chain actually keys on
// (the SIGNATURE STRING) rather than trusting that a `$derived` will stop.

import { describe, it, expect } from 'vitest';
import { getFactoryTable, getFactoryTables } from '$lib/audio/wavetable-factory-tables';
import { CUBE_DEFAULT_TABLES } from '$lib/audio/modules/cube';
import {
  cubeFrameResolveCount,
  cubeSlotFrames,
  cubeSlotTableSig,
} from './cube-table-actions';

/** A node-shaped literal — the memo reads `node.data` and nothing else. */
const nodeWith = (data: Record<string, unknown>) => ({ data });

describe('cube frame memo — the SIGNATURE is what the $derived chain stops on', () => {
  it('is INVARIANT to every param — a knob tick cannot invalidate it', () => {
    // ⚠ THIS IS THE CHAIN CLAIM, checkable without a browser. Both panels build
    // `tableSig` from this string and read frames only through a `$derived`
    // over it, so Svelte's equality check stops propagation exactly when this
    // string is stable. If it ever started reading a param, the memo would
    // still be correct and would stop working, silently.
    const base = nodeWith({ floor: { source: 'factory:basic-shapes' } });
    const withParams = {
      data: { floor: { source: 'factory:basic-shapes' } },
      params: { slice_ry: 1.234, crush: 0.5, view_rot_x: 0.9 },
    };
    expect(cubeSlotTableSig(base, 'floor')).toBe(cubeSlotTableSig(withParams, 'floor'));
  });

  it('CHANGES on every kind of real slot move', () => {
    // The other direction: a signature that never moved would be an equally
    // green way to be permanently stale.
    const sig = (d: unknown) => cubeSlotTableSig({ data: d }, 'floor');
    const a = sig({ floor: { source: 'factory:basic-shapes' } });
    expect(sig({ floor: { source: 'factory:pwm-sweep' } }), 'factory swap').not.toBe(a);
    expect(sig({ floor: { source: 'user', label: 'X', frames: [[0]] } }), 'user load').not.toBe(a);
    expect(
      sig({ floor: { source: 'user', label: 'X', frames: [[0], [1]] } }),
      'a different frame count',
    ).not.toBe(sig({ floor: { source: 'user', label: 'X', frames: [[0]] } }));
  });

  it('is PER SLOT — three slots on one table are three entries, not one', () => {
    const n = nodeWith({
      floor: { source: 'factory:basic-shapes' },
      wall: { source: 'factory:basic-shapes' },
    });
    expect(cubeSlotTableSig(n, 'floor')).not.toBe(cubeSlotTableSig(n, 'wall'));
  });
});

describe('cube frame memo — it HITS (the copy really is skipped)', () => {
  it('resolves ONCE across many reads of an unchanged slot', () => {
    const n = nodeWith({ floor: { source: 'factory:harmonic-sweep' } });
    // Warm it, so the measurement is about the steady state a knob drag sees
    // rather than about first paint.
    const first = cubeSlotFrames(n, 'floor');
    const before = cubeFrameResolveCount();
    for (let i = 0; i < 200; i++) {
      expect(cubeSlotFrames(nodeWith({ floor: { source: 'factory:harmonic-sweep' } }), 'floor'))
        .toBe(first); // IDENTITY — not merely equal contents
    }
    expect(
      cubeFrameResolveCount() - before,
      '200 reads of an unchanged slot must cost ZERO resolves — this is the whole point',
    ).toBe(0);
  });

  it('shares one copy across NODES holding the same table', () => {
    // Keyed by signature, not by nodeId: two cubes on the same table share the
    // frames, and a deleted node leaves nothing behind.
    const a = cubeSlotFrames(nodeWith({ wall: { source: 'factory:pwm-sweep' } }), 'wall');
    const before = cubeFrameResolveCount();
    const b = cubeSlotFrames(nodeWith({ wall: { source: 'factory:pwm-sweep' } }), 'wall');
    expect(b).toBe(a);
    expect(cubeFrameResolveCount() - before).toBe(0);
  });
});

describe('cube frame memo — it MISSES when it must (staleness, both shapes)', () => {
  it('a FACTORY swap resolves again, and returns the NEW table', () => {
    const n = nodeWith({ ceiling: { source: 'factory:basic-shapes' } });
    const basic = cubeSlotFrames(n, 'ceiling');
    const before = cubeFrameResolveCount();
    const swapped = cubeSlotFrames(nodeWith({ ceiling: { source: 'factory:pwm-sweep' } }), 'ceiling');
    expect(cubeFrameResolveCount() - before, 'a real swap costs exactly one resolve').toBe(1);
    expect(swapped).not.toBe(basic);
    // ⚠ AND IT IS THE RIGHT TABLE. "A different object" is satisfied by a memo
    // that returns garbage; compare against the factory's own frames.
    const want = getFactoryTable('pwm-sweep')!.frames[0]!;
    expect(Array.from(swapped[0]!.slice(0, 8))).toEqual(Array.from(want.slice(0, 8)));
    expect(Array.from(basic[0]!.slice(0, 8)))
      .not.toEqual(Array.from(want.slice(0, 8)));
  });

  it('⚠ a RE-LOADED user file with the SAME name and size is NOT served stale', () => {
    // THE COLLISION THE STRING KEY WOULD HAVE HAD. Both of these carry
    // `source:'user'`, the same label and the same frame count, so their
    // SIGNATURES are identical — a string-keyed cache would return the first
    // one's frames for the second, forever, with every gate green. The user
    // path is keyed on the frames array's IDENTITY instead, so an edited file
    // re-loaded under its old name is a miss by construction.
    const v1 = { source: 'user', label: 'MYWAVE', frames: [Array.from({ length: 256 }, () => 0.25)] };
    const v2 = { source: 'user', label: 'MYWAVE', frames: [Array.from({ length: 256 }, () => -0.75)] };
    expect(cubeSlotTableSig(nodeWith({ floor: v1 }), 'floor'))
      .toBe(cubeSlotTableSig(nodeWith({ floor: v2 }), 'floor'));

    const a = cubeSlotFrames(nodeWith({ floor: v1 }), 'floor');
    const b = cubeSlotFrames(nodeWith({ floor: v2 }), 'floor');
    expect(a[0]![0]).toBeCloseTo(0.25, 6);
    expect(b[0]![0], 'the SECOND load must not be served the FIRST one\'s frames').toBeCloseTo(-0.75, 6);

    // …and the same array object still HITS, so the exactness costs nothing in
    // the steady state.
    const before = cubeFrameResolveCount();
    expect(cubeSlotFrames(nodeWith({ floor: v1 }), 'floor')).toBe(a);
    expect(cubeFrameResolveCount() - before).toBe(0);
  });

  it('an UNTOUCHED slot resolves its DEFAULT table, once', () => {
    // `node.data` is a sparse overlay of what has been touched — the crossover
    // panel printed `WIDTH 0%` beside a dial reading 0.20 by forgetting that.
    const frames = cubeSlotFrames(nodeWith({}), 'wall');
    const want = getFactoryTable(CUBE_DEFAULT_TABLES.wall)!.frames[0]!;
    expect(Array.from(frames[0]!.slice(0, 8))).toEqual(Array.from(want.slice(0, 8)));
    const before = cubeFrameResolveCount();
    expect(cubeSlotFrames(nodeWith({}), 'wall')).toBe(frames);
    expect(cubeFrameResolveCount() - before).toBe(0);
  });
});

describe('cube frame memo — the INSTRUMENT itself', () => {
  it('the miss counter can move at all (else every count above is vacuous)', () => {
    // A counter frozen at 0 would make every `delta === 0` assertion in this
    // file pass while proving nothing whatsoever.
    const before = cubeFrameResolveCount();
    // Every factory table, on a slot none of the tests above have warmed.
    for (const t of getFactoryTables()) {
      cubeSlotFrames(nodeWith({ ceiling: { source: `factory:${t.id}` } }), 'ceiling');
    }
    expect(
      cubeFrameResolveCount() - before,
      'the counter must ADVANCE on genuinely new keys',
    ).toBeGreaterThan(0);
  });
});
