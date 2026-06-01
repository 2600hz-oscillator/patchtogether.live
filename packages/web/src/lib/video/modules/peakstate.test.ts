// packages/web/src/lib/video/modules/peakstate.test.ts
//
// Module-shape tests for PEAKSTATE — the def itself, no GL. The
// algorithmic guts (pen trajectory, ring buffer, render-arm counts, HSL
// cycle) are covered by peakstate-draw.test.ts; this file pins the
// declared I/O surface + param ranges that the rest of the system
// depends on (port renames here would break saved patches + cross-
// domain CV bridges).

import { describe, it, expect } from 'vitest';
import { peakstateDef } from './peakstate';

describe('peakstateDef shape', () => {
  it('is a video-domain module registered as a source', () => {
    expect(peakstateDef.type).toBe('peakstate');
    expect(peakstateDef.domain).toBe('video');
    expect(peakstateDef.category).toBe('sources');
    expect(peakstateDef.schemaVersion).toBe(1);
  });

  it('declares the three documented video outputs with correct types', () => {
    const ids = peakstateDef.outputs.map((p) => p.id);
    expect(ids).toEqual(['mono_out', 'rgb_out', 'out_3d']);
    const types = Object.fromEntries(peakstateDef.outputs.map((p) => [p.id, p.type]));
    expect(types).toEqual({
      mono_out: 'mono-video',
      rgb_out:  'video',
      out_3d:   'video',
    });
  });

  it('declares no NON-CV inputs (mandala is internally driven)', () => {
    for (const port of peakstateDef.inputs) {
      expect(port.type).toBe('cv');
    }
  });

  it('exposes one CV input per modulatable param (speed / complexity / color_speed)', () => {
    const cvIds = peakstateDef.inputs.map((p) => p.id).sort();
    expect(cvIds).toEqual(['color_speed_cv', 'complexity_cv', 'speed_cv']);
    const targets = Object.fromEntries(peakstateDef.inputs.map((p) => [p.id, p.paramTarget]));
    expect(targets).toEqual({
      speed_cv: 'speed',
      complexity_cv: 'complexity',
      color_speed_cv: 'color_speed',
    });
  });

  it('declares the three documented params with the right ranges + defaults', () => {
    const byId = Object.fromEntries(peakstateDef.params.map((p) => [p.id, p]));
    expect(byId.speed).toMatchObject({ min: 0.1, max: 4, defaultValue: 1, curve: 'linear' });
    expect(byId.complexity).toMatchObject({ min: 4, max: 32, defaultValue: 12, curve: 'discrete' });
    expect(byId.color_speed).toMatchObject({ min: 0, max: 4, defaultValue: 1, curve: 'linear' });
  });

  it('complexity is discrete (must be coerced to integer)', () => {
    const c = peakstateDef.params.find((p) => p.id === 'complexity')!;
    expect(c.curve).toBe('discrete');
  });

  it('declares MOVE + OBLONG knobs for the spirograph orbit (defaults 0 → off)', () => {
    const byId = Object.fromEntries(peakstateDef.params.map((p) => [p.id, p]));
    expect(byId.move).toMatchObject({ min: 0, max: 1, defaultValue: 0, curve: 'linear' });
    expect(byId.oblong).toMatchObject({ min: 0, max: 1, defaultValue: 0, curve: 'linear' });
  });

  it('keeps SPEED / COMPLEXITY / COLOR untouched (regression: the spirograph PR must NOT renumber existing params)', () => {
    // Saved patches address params by id; renaming or dropping speed /
    // complexity / color_speed would silently break them. Pin the
    // exact id list (order-insensitive) so this PR's diff is auditable.
    const ids = peakstateDef.params.map((p) => p.id).sort();
    expect(ids).toEqual(['color_speed', 'complexity', 'move', 'oblong', 'speed']);
  });
});
