// packages/web/src/lib/ui/modules/dx7/dx7-op-map-model.test.ts

import { describe, expect, it } from 'vitest';
import { dx7MapGeometry, dx7FreqLabel, MAP_BLOCK_H } from './dx7-op-map-model';

const ALL = Array.from({ length: 32 }, (_, i) => i + 1);
const OPS = Array.from({ length: 6 }, (_, i) => ({
  r: [80, 70, 60, 50],
  l: [99, 80, 70, 0],
  ratio: 1 + i * 0.5,
}));

describe('dx7MapGeometry', () => {
  it('places six operators for every algorithm, inside the viewBox', () => {
    for (const num of ALL) {
      const g = dx7MapGeometry(num, OPS, undefined);
      expect(g, `alg ${num}`).toBeDefined();
      expect(g!.blocks).toHaveLength(6);
      for (const b of g!.blocks) {
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.x + b.w).toBeLessThanOrEqual(g!.width);
        expect(b.y + b.h).toBeLessThanOrEqual(g!.height);
      }
    }
  });

  // THE CARRIER RAIL is the deuteranopia defence — role is otherwise carried
  // only by colour, which is exactly the cue a red-green colourblind player
  // cannot read. It must sit BELOW every block and have one drop per carrier,
  // or the geometric cue silently degrades to a colour-only cue.
  it('draws a carrier rail below every block, with one drop per carrier', () => {
    for (const num of ALL) {
      const g = dx7MapGeometry(num, OPS, undefined)!;
      const carriers = g.blocks.filter((b) => b.carrier);
      expect(carriers.length, `alg ${num} carriers`).toBeGreaterThan(0);
      expect(g.rail.drops).toHaveLength(carriers.length);
      expect(new Set(g.rail.drops.map((d) => d.op))).toEqual(new Set(carriers.map((b) => b.op)));

      for (const b of g.blocks) {
        expect(g.rail.y, `alg ${num}: rail must clear op${b.op + 1}`).toBeGreaterThanOrEqual(
          b.y + b.h,
        );
      }
      // Each drop lands on its carrier's horizontal centre.
      for (const d of g.rail.drops) {
        const b = carriers.find((c) => c.op === d.op)!;
        expect(d.x).toBeCloseTo(b.x + b.w / 2, 6);
      }
    }
  });

  it('marks carriers as carriers and gives every operator a role', () => {
    for (const num of ALL) {
      const g = dx7MapGeometry(num, OPS, undefined)!;
      for (const b of g.blocks) {
        expect(['carrier', 'modulator', 'both']).toContain(b.role);
        // A row-0 block reaches the output, so its role can never be a pure
        // modulator — that would be the map contradicting its own geometry.
        if (b.carrier) expect(b.role).not.toBe('modulator');
      }
    }
  });

  // Every rack saved before PR 5 has NO `opOn` array. Reading a missing entry
  // as `false` would render every legacy patch fully muted — a spectacular,
  // entirely silent regression.
  it('treats a missing or short opOn as ON, never as muted', () => {
    const g = dx7MapGeometry(5, OPS, undefined)!;
    expect(g.blocks.every((b) => b.on)).toBe(true);

    const short = dx7MapGeometry(5, OPS, [false, true])!;
    expect(short.blocks.find((b) => b.op === 0)!.on).toBe(false);
    expect(short.blocks.find((b) => b.op === 1)!.on).toBe(true);
    // Beyond the array's end → ON.
    expect(short.blocks.filter((b) => b.op >= 2).every((b) => b.on)).toBe(true);
  });

  it('gives every block an EG thumbnail normalised into the unit box', () => {
    const g = dx7MapGeometry(7, OPS, undefined)!;
    for (const b of g.blocks) {
      expect(b.egThumb.length).toBeGreaterThan(1);
      for (const p of b.egThumb) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(1);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(1);
        expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      }
    }
  });

  // The thumbnail is scaled by OUTPUT LEVEL so a quiet operator draws a short
  // curve — that vertical scaling is the only thing making six thumbnails
  // comparable at a glance. If it is dropped, every operator looks equally loud.
  it('scales the EG thumbnail by output level', () => {
    // OUTPUT LEVEL is `op.level` — a field of its own, NOT `l[3]` (which is EG
    // level 4, the idle/release level, and is 0 for virtually every real
    // voice). Reading the wrong one scales every thumbnail to zero.
    const loud = [{ r: [80, 70, 60, 50], l: [99, 90, 80, 0], level: 99, ratio: 1 }];
    const quiet = [{ r: [80, 70, 60, 50], l: [99, 90, 80, 0], level: 20, ratio: 1 }];
    const gLoud = dx7MapGeometry(1, [...loud, ...OPS.slice(1)], undefined)!;
    const gQuiet = dx7MapGeometry(1, [...quiet, ...OPS.slice(1)], undefined)!;
    const peak = (g: typeof gLoud) =>
      Math.max(...g.blocks.find((b) => b.op === 0)!.egThumb.map((p) => p.y));
    expect(peak(gQuiet)).toBeLessThan(peak(gLoud));
  });

  it('returns undefined for an unusable algorithm rather than throwing', () => {
    expect(dx7MapGeometry(0, OPS, undefined)).toBeUndefined();
    expect(dx7MapGeometry(33, OPS, undefined)).toBeUndefined();
    expect(dx7MapGeometry(Number.NaN, OPS, undefined)).toBeUndefined();
  });

  it('survives a voice with no operator data at all', () => {
    const g = dx7MapGeometry(5, undefined, undefined);
    expect(g).toBeDefined();
    expect(g!.blocks).toHaveLength(6);
    expect(g!.blocks.every((b) => Number.isFinite(b.level))).toBe(true);
    expect(g!.blocks.every((b) => b.h === MAP_BLOCK_H)).toBe(true);
  });

  // NEGATIVE CONTROL: everything above would also pass if the geometry ignored
  // its algorithm argument and returned one fixed picture.
  it('NEGATIVE CONTROL: distinct algorithms produce distinct maps', () => {
    const shapes = new Set(
      ALL.map((num) => {
        const g = dx7MapGeometry(num, OPS, undefined)!;
        // FEEDBACK belongs in the key. Ten algorithm pairs differ ONLY by
        // where the feedback loop sits — omitting it collapses them and this
        // check reports 22, not 32. The map draws feedback, so those really
        // are distinct pictures.
        return (
          g.blocks.map((b) => `${b.op}@${b.x},${b.y}${b.carrier ? 'C' : ''}`).sort().join(' ') +
          '|' + g.edges.map((e) => `${e.from}>${e.to}`).sort().join(' ') +
          '|fb' + g.feedback?.from + '>' + g.feedback?.to
        );
      }),
    );
    expect(shapes.size).toBe(32);
  });
});

describe('dx7FreqLabel', () => {
  it('prints a ratio operator as a multiplier', () => {
    expect(dx7FreqLabel({ ratio: 3.06 })).toBe('×3.06');
    expect(dx7FreqLabel({ ratio: 1 })).toBe('×1.00');
  });

  it('prints a fixed operator in Hz, never as a ratio', () => {
    expect(dx7FreqLabel({ fixedMode: true, fixedHz: 220 })).toBe('FIX 220 Hz');
    expect(dx7FreqLabel({ fixedMode: true, fixedHz: 1000 })).toBe('FIX 1000 Hz');
  });

  it('falls back to ×1.00 rather than NaN for a junk operator', () => {
    expect(dx7FreqLabel(undefined)).toBe('×1.00');
    expect(dx7FreqLabel({})).toBe('×1.00');
    expect(dx7FreqLabel({ ratio: Number.NaN })).toBe('×1.00');
  });
});
