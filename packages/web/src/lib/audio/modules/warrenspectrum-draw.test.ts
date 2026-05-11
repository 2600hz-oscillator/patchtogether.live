// packages/web/src/lib/audio/modules/warrenspectrum-draw.test.ts
//
// Unit tests for the WARRENSPECTRUM shared renderer. The web package's
// vitest config runs in `node` (no DOM canvas), so we stub the 2D
// context with a recorder. We verify the LED meter columns are drawn
// as discrete fillRect segments — NOT a single full-height bar — and
// that lit segments use a green→yellow→red HSL palette.

import { describe, expect, it } from 'vitest';
import { drawWarrenspectrum, type WarrenspectrumSnapshot } from './warrenspectrum-draw';

type Op =
  | { op: 'fillRect'; x: number; y: number; w: number; h: number }
  | { op: 'fillStyle'; v: string }
  | { op: 'strokeStyle'; v: string }
  | { op: 'lineWidth'; v: number }
  | { op: 'lineCap'; v: string }
  | { op: 'font'; v: string }
  | { op: 'textAlign'; v: string }
  | { op: 'beginPath' }
  | { op: 'moveTo'; x: number; y: number }
  | { op: 'lineTo'; x: number; y: number }
  | { op: 'bezierCurveTo' }
  | { op: 'stroke' }
  | { op: 'fillText'; t: string; x: number; y: number }
  | { op: 'createLinearGradient' };

function mockCtx(): { ops: Op[]; ctx: CanvasRenderingContext2D } {
  const ops: Op[] = [];
  let lastFill = '';
  const grad = {
    addColorStop: (): void => undefined,
  };
  const ctx = {
    get fillStyle(): string { return lastFill; },
    set fillStyle(v: string) { lastFill = v; ops.push({ op: 'fillStyle', v }); },
    get strokeStyle(): string { return ''; },
    set strokeStyle(v: string) { ops.push({ op: 'strokeStyle', v }); },
    get lineWidth(): number { return 0; },
    set lineWidth(v: number) { ops.push({ op: 'lineWidth', v }); },
    get lineCap(): string { return ''; },
    set lineCap(v: string) { ops.push({ op: 'lineCap', v }); },
    get font(): string { return ''; },
    set font(v: string) { ops.push({ op: 'font', v }); },
    get textAlign(): string { return ''; },
    set textAlign(v: string) { ops.push({ op: 'textAlign', v }); },
    fillRect: (x: number, y: number, w: number, h: number) =>
      ops.push({ op: 'fillRect', x, y, w, h }),
    beginPath: () => ops.push({ op: 'beginPath' }),
    moveTo: (x: number, y: number) => ops.push({ op: 'moveTo', x, y }),
    lineTo: (x: number, y: number) => ops.push({ op: 'lineTo', x, y }),
    bezierCurveTo: () => ops.push({ op: 'bezierCurveTo' }),
    stroke: () => ops.push({ op: 'stroke' }),
    fillText: (t: string, x: number, y: number) =>
      ops.push({ op: 'fillText', t, x, y }),
    createLinearGradient: () => {
      ops.push({ op: 'createLinearGradient' });
      return grad;
    },
  };
  return { ops, ctx: ctx as unknown as CanvasRenderingContext2D };
}

function makeSnap(flash: number[]): WarrenspectrumSnapshot {
  return {
    wave: new Float32Array(64),
    flash,
    levels: [1, 1, 1, 1, 1, 1, 1, 1],
    frame: 10,
    viznoise: 0.3,
  };
}

describe('drawWarrenspectrum LED column meter', () => {
  it('renders 10 discrete LED segments per band (80 fillRects total)', () => {
    const { ops, ctx } = mockCtx();
    const snap = makeSnap([1, 1, 1, 1, 1, 1, 1, 1]); // all bands fully lit
    drawWarrenspectrum(ctx, snap, 360, 120);

    // The LED meter contributes 8 bands × 10 segments = 80 fillRects.
    // Other parts of the renderer (background, slider bars, freq labels)
    // also fillRect — so we look for the LED segments by paired
    // fillStyle ops that pull from the green→yellow→red HSL band
    // (hue ∈ [0, 130] at 90% sat, 55% lit).
    const litSegments = ops.filter(
      (o): o is { op: 'fillStyle'; v: string } =>
        o.op === 'fillStyle' && /^hsl\(\d+(?:\.\d+)?, 90%, 55%\)$/.test(o.v),
    );
    expect(litSegments.length, 'all 80 LED segments lit').toBe(80);
  });

  it('LED column has visibly distinct lit + unlit segments at half level', () => {
    const { ops, ctx } = mockCtx();
    // flash = 0.5 → litCount = round(0.5 * 10) = 5 lit, 5 unlit per band.
    const snap = makeSnap([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    drawWarrenspectrum(ctx, snap, 360, 120);

    const lit = ops.filter(
      (o): o is { op: 'fillStyle'; v: string } =>
        o.op === 'fillStyle' && /^hsl\(\d/.test(o.v),
    );
    const unlit = ops.filter(
      (o): o is { op: 'fillStyle'; v: string } =>
        o.op === 'fillStyle' && /^hsla\(\d/.test(o.v) && /0\.18\)$/.test(o.v),
    );
    // 5 lit per band × 8 bands = 40 lit segments; same for unlit.
    expect(lit.length, 'lit segments').toBeGreaterThanOrEqual(40);
    expect(unlit.length, 'unlit segments').toBe(40);
  });

  it('all 80 segments unlit when no pings (idle state)', () => {
    const { ops, ctx } = mockCtx();
    const snap = makeSnap([0, 0, 0, 0, 0, 0, 0, 0]);
    drawWarrenspectrum(ctx, snap, 360, 120);

    const unlit = ops.filter(
      (o): o is { op: 'fillStyle'; v: string } =>
        o.op === 'fillStyle' && /^hsla\(\d.*0\.18\)$/.test(o.v),
    );
    expect(unlit.length, 'all 80 LEDs in dim/unlit state').toBe(80);
  });

  it('LED palette spans green→yellow→red from bottom to top', () => {
    const { ops, ctx } = mockCtx();
    const snap = makeSnap([1, 0, 0, 0, 0, 0, 0, 0]); // band 0 fully lit
    drawWarrenspectrum(ctx, snap, 360, 120);

    // Extract just the lit-segment hues for band 0. The first 10 lit
    // entries (segments 0..9, drawn bottom-up) should span hue 130
    // (green) → 55 (yellow) → 0 (red).
    const litHues: number[] = [];
    for (const o of ops) {
      if (o.op !== 'fillStyle') continue;
      const m = /^hsl\((\d+(?:\.\d+)?), 90%, 55%\)$/.exec(o.v);
      if (m) litHues.push(parseFloat(m[1]!));
    }
    expect(litHues.length, 'band 0 contributes 10 lit hues').toBe(10);
    expect(litHues[0], 'bottom segment is green (hue ~130)').toBeCloseTo(130, 0);
    expect(litHues[9], 'top segment is red (hue ~0)').toBeCloseTo(0, 0);
    // Mid segment (index 6, t=0.667 → just past the 0.6 inflection) should
    // be in the yellow zone (hue ≤ 55).
    expect(litHues[6], 'upper-mid is yellow-ish').toBeLessThanOrEqual(55);
  });

  it('LED segments have non-zero gap between them (visible separation)', () => {
    const { ops, ctx } = mockCtx();
    const snap = makeSnap([1, 0, 0, 0, 0, 0, 0, 0]);
    drawWarrenspectrum(ctx, snap, 360, 200); // taller canvas → readable gap

    // Collect fillRects whose width matches the LED column width
    // (usable * 0.45 / 7 ≈ 22.6px on a 360-wide canvas). Sort by y;
    // adjacent ys should differ by segH + segGap, NOT 0.
    const colXFirstBand = 360 * 0.06; // padX, == bandX(0)
    // colW = (usable / 7) * 0.45 where usable = w - 2*padX = 360 * 0.88
    // expected colW ≈ 360 * 0.88 / 7 * 0.45 ≈ 20.4
    const ledRects = ops
      .filter(
        (o): o is { op: 'fillRect'; x: number; y: number; w: number; h: number } =>
          o.op === 'fillRect' && o.w > 15 && o.w < 30 && o.h > 5 && o.h < 30,
      )
      .filter((r) => Math.abs(r.x - (colXFirstBand - r.w / 2)) < 1);

    expect(ledRects.length, 'band 0 has 10 LED-rect draws').toBe(10);
    // Check that gaps exist: each y should be at least 1px apart from the
    // next (segH + segGap), and rects should NOT be contiguous (which
    // would imply a solid full-height bar).
    const ysSorted = ledRects.map((r) => r.y).sort((a, b) => a - b);
    let totalGap = 0;
    for (let i = 1; i < ysSorted.length; i++) {
      const dy = ysSorted[i]! - ysSorted[i - 1]!;
      const segH = ledRects[0]!.h;
      // Distance between top edges = segH + segGap, so the bare gap
      // is (segH + segGap) - segH = segGap > 0.
      const gap = dy - segH;
      totalGap += Math.max(0, gap);
    }
    expect(totalGap, 'cumulative inter-segment gap > 0').toBeGreaterThan(0);
  });
});
