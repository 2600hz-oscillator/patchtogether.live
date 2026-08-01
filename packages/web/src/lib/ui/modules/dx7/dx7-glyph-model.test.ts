// packages/web/src/lib/ui/modules/dx7/dx7-glyph-model.test.ts
//
// The DX7 algorithm diagram is a PICTURE, and a picture is exactly the kind of
// output that looks right while being wrong — every one of these 32 diagrams
// renders as "some boxes with some lines" whether or not the lines connect the
// operators the routing table actually wires. So the assertions below are on
// the RELATIONSHIPS between drawn coordinates, never on "it produced output".
//
// Deliberately paired with a NEGATIVE CONTROL at the bottom: a check that the
// geometry is not invariant to the thing under test. Repo discipline — a metric
// blind to the dimension it claims to measure returns a clean number for a
// broken input (see CLAUDE.md, "VALIDATE THE INSTRUMENT").

import { describe, expect, it } from 'vitest';
import { dx7AlgorithmLayout } from '$lib/audio/dx7-algorithm-layout';
import { BLOCK_H, BLOCK_W, dx7GlyphGeometry } from './dx7-glyph-model';

const ALL = Array.from({ length: 32 }, (_, i) => i + 1);

const geomFor = (num: number) => {
  const layout = dx7AlgorithmLayout(num);
  expect(layout, `algorithm ${num} must have a layout`).toBeDefined();
  return { layout: layout!, geom: dx7GlyphGeometry(layout!) };
};

describe('dx7GlyphGeometry — all 32 algorithms', () => {
  it('places all six operators, inside the viewBox', () => {
    for (const num of ALL) {
      const { geom } = geomFor(num);
      expect(geom.blocks, `alg ${num} block count`).toHaveLength(6);
      expect([...geom.blocks.map((b) => b.op)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);

      for (const b of geom.blocks) {
        expect(b.x, `alg ${num} op${b.op + 1} left edge`).toBeGreaterThanOrEqual(0);
        expect(b.y, `alg ${num} op${b.op + 1} top edge`).toBeGreaterThanOrEqual(0);
        expect(b.x + b.w, `alg ${num} op${b.op + 1} right edge`).toBeLessThanOrEqual(geom.width);
        expect(b.y + b.h, `alg ${num} op${b.op + 1} bottom edge`).toBeLessThanOrEqual(geom.height);
      }
    }
  });

  it('never overlaps two operator blocks', () => {
    for (const num of ALL) {
      const { geom } = geomFor(num);
      for (let i = 0; i < geom.blocks.length; i++) {
        for (let j = i + 1; j < geom.blocks.length; j++) {
          const a = geom.blocks[i]!;
          const b = geom.blocks[j]!;
          const disjoint =
            a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
          expect(disjoint, `alg ${num}: op${a.op + 1} and op${b.op + 1} overlap`).toBe(true);
        }
      }
    }
  });

  // THE ROW FLIP. Row 0 is the carrier row and must render at the BOTTOM (every
  // Yamaha chart draws signal falling into the output). Drop the flip in
  // dx7GlyphGeometry and the diagram still renders — upside down — and every
  // other assertion here still passes. This is the one that catches it.
  it('draws carriers at the BOTTOM, below every modulator', () => {
    for (const num of ALL) {
      const { geom } = geomFor(num);
      const carriers = geom.blocks.filter((b) => b.carrier);
      const modulators = geom.blocks.filter((b) => !b.carrier);
      expect(carriers.length, `alg ${num} must have at least one carrier`).toBeGreaterThan(0);

      const topmostCarrier = Math.min(...carriers.map((b) => b.y));
      for (const m of modulators) {
        expect(m.y, `alg ${num}: modulator op${m.op + 1} must sit above every carrier`).toBeLessThan(
          topmostCarrier + BLOCK_H,
        );
      }
    }
  });

  // The visual form of dx7-algorithm-layout's "a stack never draws an edge that
  // skips backwards over a block": every modulation edge must point DOWNWARD on
  // the canvas. An upward or sideways edge means the row assignment and the
  // drawing disagree, which reads as a tangle rather than a chart.
  it('EDGES POINT DOWN — every edge runs from modulator down to its consumer', () => {
    for (const num of ALL) {
      const { layout, geom } = geomFor(num);
      expect(geom.edges, `alg ${num} edge count`).toHaveLength(layout.edges.length);

      for (const e of geom.edges) {
        expect(
          e.y1,
          `alg ${num}: edge op${e.from + 1}→op${e.to + 1} must start above where it ends`,
        ).toBeLessThanOrEqual(e.y2);
      }
    }
  });

  it('anchors every edge on the two blocks it names', () => {
    for (const num of ALL) {
      const { geom } = geomFor(num);
      const byOp = new Map(geom.blocks.map((b) => [b.op, b]));
      for (const e of geom.edges) {
        const from = byOp.get(e.from)!;
        const to = byOp.get(e.to)!;
        expect(e.x1, `alg ${num} edge start x`).toBeCloseTo(from.x + BLOCK_W / 2, 6);
        expect(e.y1, `alg ${num} edge start y`).toBeCloseTo(from.y + BLOCK_H, 6);
        expect(e.x2, `alg ${num} edge end x`).toBeCloseTo(to.x + BLOCK_W / 2, 6);
        expect(e.y2, `alg ${num} edge end y`).toBeCloseTo(to.y, 6);
      }
    }
  });

  it('draws the feedback loop every algorithm declares', () => {
    for (const num of ALL) {
      const { layout, geom } = geomFor(num);
      expect(geom.feedback, `alg ${num} feedback`).toBeDefined();
      expect(geom.feedback!.from).toBe(layout.feedback.from);
      expect(geom.feedback!.to).toBe(layout.feedback.to);
      expect(geom.feedback!.d.length, `alg ${num} feedback path`).toBeGreaterThan(0);
      expect(geom.feedback!.d).toMatch(/^M /);
      expect(geom.feedback!.d, `alg ${num} feedback path must be finite`).not.toMatch(/NaN/);
    }
  });

  it('emits a viewBox matching its own reported size', () => {
    for (const num of ALL) {
      const { geom } = geomFor(num);
      expect(geom.viewBox).toBe(`0 0 ${geom.width} ${geom.height}`);
      expect(geom.width).toBeGreaterThan(0);
      expect(geom.height).toBeGreaterThan(0);
    }
  });

  // NEGATIVE CONTROL for the whole suite. Everything above would also pass if
  // dx7GlyphGeometry ignored its argument and returned one fixed picture — the
  // block/edge/feedback checks are all internally consistent. Prove the output
  // actually tracks the input: the 32 algorithms must not all draw the same.
  it('NEGATIVE CONTROL: distinct algorithms produce distinct pictures', () => {
    const shapes = new Set(
      ALL.map((num) => {
        const { geom } = geomFor(num);
        const blocks = geom.blocks
          .map((b) => `${b.op}@${b.x},${b.y}${b.carrier ? 'C' : ''}`)
          .sort()
          .join(' ');
        const edges = geom.edges.map((e) => `${e.from}>${e.to}`).sort().join(' ');
        return `${blocks}|${edges}|${geom.feedback?.from}>${geom.feedback?.to}`;
      }),
    );
    // The routing table has 32 rows; PR 0 (#1187) established they are all
    // distinct (only 21 were, before it). If the geometry collapses any of
    // them together, the picker is showing the user a lie.
    expect(shapes.size, 'all 32 algorithms must draw differently').toBe(32);
  });
});
