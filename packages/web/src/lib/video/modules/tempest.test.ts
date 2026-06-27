// packages/web/src/lib/video/modules/tempest.test.ts
//
// Pure unit tests for the TEMPEST renderer's GL-free geometry builder (P1).

import { describe, expect, it } from 'vitest';
import { buildTempestLines, shapeOf, tempestDef } from './tempest';
import { DEFAULT_LANES, TUBE_SHAPES } from '$lib/video/tempest/tempest-core';

describe('shapeOf', () => {
  it('maps the discrete param to a tube shape, clamped', () => {
    expect(shapeOf(0)).toBe('circle');
    expect(shapeOf(1)).toBe('square');
    expect(shapeOf(2)).toBe('star');
    expect(shapeOf(99)).toBe(TUBE_SHAPES[TUBE_SHAPES.length - 1]);
    expect(shapeOf(-5)).toBe('circle');
  });
});

describe('buildTempestLines', () => {
  it('emits a flat interleaved [x,y,r,g,b] LINE list (multiple of 2 vertices × 5)', () => {
    const v = buildTempestLines(0, 0, 1);
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length % 5).toBe(0); // 5 floats per vertex
    expect((v.length / 5) % 2).toBe(0); // LINES = vertex pairs
    // rim ring + pit ring + radial (3 segs × LANES) + claw (4 segs) = (3*LANES+4) segs.
    const segs = v.length / 5 / 2;
    expect(segs).toBe(3 * DEFAULT_LANES + 4);
  });

  it('keeps all positions inside the NDC box (aspect-fit margin)', () => {
    for (const aspect of [1, 16 / 9, 4 / 3, 0.75]) {
      const v = buildTempestLines(0.3, 0, aspect);
      for (let i = 0; i < v.length; i += 5) {
        expect(Math.abs(v[i]!)).toBeLessThanOrEqual(1);
        expect(Math.abs(v[i + 1]!)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('aspect>1 compresses X (round tube), aspect<1 compresses Y', () => {
    const wide = buildTempestLines(0, 0, 2); // x scaled by 1/2
    const tall = buildTempestLines(0, 0, 0.5); // y scaled by 0.5
    const maxX = (a: Float32Array) => Math.max(...[...a].filter((_, i) => i % 5 === 0).map(Math.abs));
    const maxY = (a: Float32Array) => Math.max(...[...a].filter((_, i) => i % 5 === 1).map(Math.abs));
    expect(maxX(wide)).toBeLessThan(maxY(wide)); // X squeezed
    expect(maxY(tall)).toBeLessThan(maxX(tall)); // Y squeezed
  });

  it('the claw color (bright yellow) appears, and moves with the rim param', () => {
    const hasClaw = (v: Float32Array): Set<string> => {
      const claw = new Set<string>();
      for (let i = 0; i < v.length; i += 5) {
        // claw verts are the only ones with g≈0.85, b≈0.15
        if (Math.abs(v[i + 3]! - 0.85) < 1e-3 && Math.abs(v[i + 4]! - 0.15) < 1e-3) {
          claw.add(`${v[i]!.toFixed(4)},${v[i + 1]!.toFixed(4)}`);
        }
      }
      return claw;
    };
    const a = hasClaw(buildTempestLines(0, 0, 1));
    const b = hasClaw(buildTempestLines(0.5, 0, 1)); // half-way around
    expect(a.size).toBeGreaterThan(0);
    expect(b.size).toBeGreaterThan(0);
    // the claw is at a different rim location → different vertex positions
    const same = [...a].every((p) => b.has(p));
    expect(same).toBe(false);
  });
});

describe('tempestDef', () => {
  it('is a lowercase-labelled video module with a cv rim input + video out', () => {
    expect(tempestDef.type).toBe('tempest');
    expect(tempestDef.label).toBe(tempestDef.label.toLowerCase());
    expect(tempestDef.domain).toBe('video');
    expect(tempestDef.inputs?.find((p) => p.id === 'rim')?.type).toBe('cv');
    expect(tempestDef.outputs?.some((p) => p.id === 'out' && p.type === 'video')).toBe(true);
  });
});
