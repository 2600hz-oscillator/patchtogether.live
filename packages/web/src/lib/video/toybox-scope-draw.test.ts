// packages/web/src/lib/video/toybox-scope-draw.test.ts
//
// PURE coverage for the TOYBOX inline mini-scope draw helpers. vitest runs in
// `node` (no real canvas), so we stub the 2D context with a recorder that
// captures every op + asserts the trace/fill/waveform geometry. pixelFromValue
// is exercised directly.

import { describe, it, expect } from 'vitest';
import {
  pixelFromValue,
  drawToyboxInputScope,
  type ToyboxScopeColors,
} from './toybox-scope-draw';

const COLORS: ToyboxScopeColors = {
  trace: '#0f0',
  fill: 'rgba(0,255,0,0.2)',
  wave: 'rgba(255,255,255,0.3)',
  grid: '#333',
  bg: '#050608',
};

type Op =
  | { op: 'fillRect' }
  | { op: 'fillStyle'; v: string }
  | { op: 'strokeStyle'; v: string }
  | { op: 'lineWidth'; v: number }
  | { op: 'beginPath' }
  | { op: 'moveTo'; x: number; y: number }
  | { op: 'lineTo'; x: number; y: number }
  | { op: 'closePath' }
  | { op: 'stroke' }
  | { op: 'fill' };

function mockCtx(): { ops: Op[]; ctx: CanvasRenderingContext2D } {
  const ops: Op[] = [];
  const ctx = {
    set fillStyle(v: string) { ops.push({ op: 'fillStyle', v }); },
    set strokeStyle(v: string) { ops.push({ op: 'strokeStyle', v }); },
    set lineWidth(v: number) { ops.push({ op: 'lineWidth', v }); },
    fillRect() { ops.push({ op: 'fillRect' }); },
    beginPath() { ops.push({ op: 'beginPath' }); },
    moveTo(x: number, y: number) { ops.push({ op: 'moveTo', x, y }); },
    lineTo(x: number, y: number) { ops.push({ op: 'lineTo', x, y }); },
    closePath() { ops.push({ op: 'closePath' }); },
    stroke() { ops.push({ op: 'stroke' }); },
    fill() { ops.push({ op: 'fill' }); },
  } as unknown as CanvasRenderingContext2D;
  return { ops, ctx };
}

describe('pixelFromValue', () => {
  it('maps 0 → baseline (bottom), 1 → top, 0.5 → middle', () => {
    expect(pixelFromValue(0, 22)).toBeCloseTo(21, 6); // height-1
    expect(pixelFromValue(1, 22)).toBeCloseTo(0, 6);
    expect(pixelFromValue(0.5, 22)).toBeCloseTo(10.5, 6);
  });
  it('clamps out-of-range values to the window', () => {
    expect(pixelFromValue(-1, 22)).toBeCloseTo(21, 6); // → 0
    expect(pixelFromValue(2, 22)).toBeCloseTo(0, 6); // → 1
    expect(pixelFromValue(NaN, 22)).toBeCloseTo(21, 6); // non-finite → 0
  });
  it('is monotonic decreasing in value (higher value = smaller y)', () => {
    expect(pixelFromValue(0.8, 22)).toBeLessThan(pixelFromValue(0.2, 22));
  });
});

describe('drawToyboxInputScope', () => {
  it('paints the background + a fill + a 1px trace for a value ring', () => {
    const { ops, ctx } = mockCtx();
    drawToyboxInputScope(ctx, {
      width: 64,
      height: 22,
      values: [0, 0.5, 1],
      colors: COLORS,
    });
    // background fill first.
    expect(ops[0]).toEqual({ op: 'fillStyle', v: COLORS.bg });
    expect(ops[1]).toEqual({ op: 'fillRect' });
    // a fill (area) AND a stroke (trace) both happen.
    expect(ops.some((o) => o.op === 'fill')).toBe(true);
    expect(ops.some((o) => o.op === 'stroke')).toBe(true);
    // the trace stroke uses the trace color.
    expect(ops.some((o) => o.op === 'strokeStyle' && o.v === COLORS.trace)).toBe(true);
    // the trace's last lineTo for value 1 lands at the TOP (y≈0).
    const lineTos = ops.filter((o): o is Extract<Op, { op: 'lineTo' }> => o.op === 'lineTo');
    const topMost = Math.min(...lineTos.map((o) => o.y));
    expect(topMost).toBeCloseTo(0, 4); // value 1 → y 0
  });

  it('draws a waveform overlay only when a wave is provided', () => {
    const withWave = mockCtx();
    drawToyboxInputScope(withWave.ctx, {
      width: 64, height: 22, values: [0.5, 0.5], wave: [-1, 0, 1], colors: COLORS,
    });
    expect(withWave.ops.some((o) => o.op === 'strokeStyle' && o.v === COLORS.wave)).toBe(true);

    const noWave = mockCtx();
    drawToyboxInputScope(noWave.ctx, {
      width: 64, height: 22, values: [0.5, 0.5], colors: COLORS,
    });
    expect(noWave.ops.some((o) => o.op === 'strokeStyle' && o.v === COLORS.wave)).toBe(false);
  });

  it('draws a flat baseline trace with no samples (always-on idle scope)', () => {
    const { ops, ctx } = mockCtx();
    drawToyboxInputScope(ctx, { width: 64, height: 22, values: [], colors: COLORS });
    // still strokes the trace color (a flat line at baseline).
    expect(ops.some((o) => o.op === 'strokeStyle' && o.v === COLORS.trace)).toBe(true);
    expect(ops.some((o) => o.op === 'stroke')).toBe(true);
  });

  it('no-ops on a zero-size canvas (never throws)', () => {
    const { ops, ctx } = mockCtx();
    expect(() => drawToyboxInputScope(ctx, { width: 0, height: 0, values: [0.5], colors: COLORS })).not.toThrow();
    expect(ops).toEqual([]);
  });
});
