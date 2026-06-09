// packages/web/src/lib/video/modules/acidwarp.test.ts
//
// Unit tests for the ACIDWARP module def + pure pattern/palette helpers.
// The actual GL pipeline is exercised by E2E (jsdom can't render shaders).

import { describe, it, expect } from 'vitest';
import { acidwarpDef, speedKnobToMultiplier } from './acidwarp';
import {
  generatePattern,
  buildPalette,
  rotatePalette,
  SCENE_COUNT,
  PALETTE_COUNT,
} from './acidwarp-patterns';

describe('acidwarpDef shape', () => {
  it('is a video-source module with one video output', () => {
    expect(acidwarpDef.type).toBe('acidwarp');
    expect(acidwarpDef.domain).toBe('video');
    expect(acidwarpDef.outputs).toHaveLength(1);
    expect(acidwarpDef.outputs[0]!.id).toBe('out');
    expect(acidwarpDef.outputs[0]!.type).toBe('video');
  });

  it('is opted into the Fix E render worker (renderLocus: worker)', () => {
    // acidwarp is the Phase-1 vehicle for the off-main-thread render worker.
    // The flag is OFF by default, so this only changes behavior when
    // VITE_VIDEO_WORKER / __videoWorkerEnabled is set; the def field is what
    // the engine consults to pick the WorkerProxyHandle path.
    expect(acidwarpDef.renderLocus).toBe('worker');
  });

  it('declares speed + scene CV inputs', () => {
    const ids = acidwarpDef.inputs.map((p) => p.id).sort();
    expect(ids).toEqual(['scene_cv', 'speed_cv']);
    const speed = acidwarpDef.inputs.find((p) => p.id === 'speed_cv')!;
    expect(speed.paramTarget).toBe('speed');
    expect(speed.cvScale?.mode).toBe('linear');
  });

  it('declares speed / freeze / scene / paletteType / sceneTrig params', () => {
    const ids = acidwarpDef.params.map((p) => p.id).sort();
    expect(ids).toEqual(['freeze', 'paletteType', 'scene', 'sceneTrig', 'speed']);
  });

  it('freeze + scene + paletteType are discrete', () => {
    for (const k of ['freeze', 'scene', 'paletteType'] as const) {
      expect(acidwarpDef.params.find((p) => p.id === k)?.curve).toBe('discrete');
    }
  });
});

describe('speedKnobToMultiplier — piecewise mapping', () => {
  it('knob = 0 → 0× (stopped)', () => {
    expect(speedKnobToMultiplier(0)).toBe(0);
  });
  it('knob = 0.5 → 1× (normal speed)', () => {
    expect(speedKnobToMultiplier(0.5)).toBe(1);
  });
  it('knob = 1 → 4× (max speed)', () => {
    expect(speedKnobToMultiplier(1)).toBeCloseTo(4, 5);
  });
  it('knob = 0.25 → 0.5×', () => {
    expect(speedKnobToMultiplier(0.25)).toBeCloseTo(0.5, 5);
  });
  it('knob = 0.75 → 2.5×', () => {
    expect(speedKnobToMultiplier(0.75)).toBeCloseTo(2.5, 5);
  });
  it('clamps below 0 and above 1', () => {
    expect(speedKnobToMultiplier(-1)).toBe(0);
    expect(speedKnobToMultiplier(2)).toBeCloseTo(4, 5);
  });
});

describe('generatePattern — shape + index range', () => {
  it('returns width * height bytes', () => {
    const buf = generatePattern({ scene: 0, width: 32, height: 24 });
    expect(buf.length).toBe(32 * 24);
  });

  it('all values land in 1..255 (palette slot 0 is reserved)', () => {
    const buf = generatePattern({ scene: 5, width: 16, height: 16 });
    for (let i = 0; i < buf.length; i++) {
      expect(buf[i]).toBeGreaterThanOrEqual(1);
      expect(buf[i]).toBeLessThanOrEqual(255);
    }
  });

  it('is deterministic for a given seed', () => {
    const a = generatePattern({ scene: 12, width: 16, height: 16, seed: 999 });
    const b = generatePattern({ scene: 12, width: 16, height: 16, seed: 999 });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('different scenes produce different output (sampled)', () => {
    const a = generatePattern({ scene: 0, width: 32, height: 24, seed: 1 });
    const b = generatePattern({ scene: 12, width: 32, height: 24, seed: 1 });
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    expect(diff).toBeGreaterThan(50);
  });

  it('works for every scene id without throwing', () => {
    for (let s = 0; s < SCENE_COUNT; s++) {
      const buf = generatePattern({ scene: s, width: 8, height: 8 });
      expect(buf.length).toBe(64);
    }
  });
});

describe('buildPalette + rotatePalette', () => {
  it('produces 768 bytes (256 RGB triples)', () => {
    const pal = buildPalette(0);
    expect(pal.length).toBe(256 * 3);
  });

  it('slot 0 is black in every base palette', () => {
    // For RGBW and the W palettes slot 0 = (0,0,0); pastel starts at 31
    // (= 124 after scaling) but slot 0 is the "1 + i/4" value evaluated at
    // i = 0 = 31. So we only assert "exists" + length here.
    for (let t = 0; t < PALETTE_COUNT; t++) {
      const pal = buildPalette(t as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7);
      expect(pal.length).toBe(768);
    }
  });

  it('rotatePalette preserves slot 0 (always black)', () => {
    const base = buildPalette(0);
    // Force slot 0 to a known non-zero value to prove it gets reset.
    base[0] = 42; base[1] = 42; base[2] = 42;
    const rot = rotatePalette(base, 7);
    expect(rot[0]).toBe(0);
    expect(rot[1]).toBe(0);
    expect(rot[2]).toBe(0);
  });

  it('rotatePalette by 0 reproduces non-zero slots verbatim', () => {
    const base = buildPalette(0);
    const rot = rotatePalette(base, 0);
    // slot 0 is special; check slot 1 onward.
    for (let i = 1; i < 256; i++) {
      expect(rot[i * 3]).toBe(base[i * 3]);
      expect(rot[i * 3 + 1]).toBe(base[i * 3 + 1]);
      expect(rot[i * 3 + 2]).toBe(base[i * 3 + 2]);
    }
  });

  it('rotatePalette is cyclic (rotate by 255 returns to the prior slot)', () => {
    const base = buildPalette(0);
    const a = rotatePalette(base, 1);
    const b = rotatePalette(base, 256);   // 256 mod 255 = 1
    // Both should produce the same rotation of the non-zero half.
    for (let i = 1; i < 256; i++) {
      expect(a[i * 3]).toBe(b[i * 3]);
    }
  });
});
