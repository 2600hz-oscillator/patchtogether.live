// packages/web/src/lib/audio/modules/wavecel-draw.test.ts
//
// Unit tests for the shared WAVECEL draw helpers (scope + 3D). The web
// package's vitest config runs in `node` (no DOM canvas), so we stub
// the 2D context with a recorder that captures every call. The tests
// assert: (a) the canvas is cleared + painted; (b) at least one path is
// stroked; (c) for the 3D path, the active frame is rendered in white
// (color contrast = video output renders both colors, the spec
// motivation for choosing `video` over `mono-video` for wave3d_out).

import { describe, expect, it } from 'vitest';
import { drawWave3D, drawWaveScope } from './wavecel-draw';

type Op =
  | { op: 'clearRect' }
  | { op: 'fillRect' }
  | { op: 'fillStyle'; v: string }
  | { op: 'strokeStyle'; v: string }
  | { op: 'lineWidth'; v: number }
  | { op: 'beginPath' }
  | { op: 'moveTo'; x: number; y: number }
  | { op: 'lineTo'; x: number; y: number }
  | { op: 'stroke' };

function mockCtx(): { ops: Op[]; ctx: CanvasRenderingContext2D } {
  const ops: Op[] = [];
  const ctx = {
    get fillStyle(): string { return ''; },
    set fillStyle(v: string) { ops.push({ op: 'fillStyle', v }); },
    get strokeStyle(): string { return ''; },
    set strokeStyle(v: string) { ops.push({ op: 'strokeStyle', v }); },
    get lineWidth(): number { return 0; },
    set lineWidth(v: number) { ops.push({ op: 'lineWidth', v }); },
    clearRect: () => ops.push({ op: 'clearRect' }),
    fillRect: () => ops.push({ op: 'fillRect' }),
    beginPath: () => ops.push({ op: 'beginPath' }),
    moveTo: (x: number, y: number) => ops.push({ op: 'moveTo', x, y }),
    lineTo: (x: number, y: number) => ops.push({ op: 'lineTo', x, y }),
    stroke: () => ops.push({ op: 'stroke' }),
  };
  return { ops, ctx: ctx as unknown as CanvasRenderingContext2D };
}

function makeFrames(count: number, samples: number): Float32Array[] {
  const out: Float32Array[] = [];
  for (let f = 0; f < count; f++) {
    const arr = new Float32Array(samples);
    // Sin wave whose phase shifts per frame — enough non-zero data to
    // hit lineTo with varied y values.
    for (let s = 0; s < samples; s++) {
      arr[s] = Math.sin((s / samples) * Math.PI * 2 + (f / count) * Math.PI);
    }
    out.push(arr);
  }
  return out;
}

describe('drawWaveScope', () => {
  it('clears + paints the canvas and strokes a polyline trace', () => {
    const { ops, ctx } = mockCtx();
    const fs = makeFrames(4, 128);
    drawWaveScope(ctx, fs, 320, 120, { activeFrame: 2 });

    expect(ops.find((o) => o.op === 'clearRect'), 'background cleared').toBeDefined();
    expect(ops.find((o) => o.op === 'fillRect'), 'background filled').toBeDefined();
    expect(ops.filter((o) => o.op === 'stroke').length, 'at least one stroke').toBeGreaterThanOrEqual(1);

    const lineTos = ops.filter((o): o is { op: 'lineTo'; x: number; y: number } => o.op === 'lineTo');
    expect(lineTos.length, 'wave polyline drawn').toBeGreaterThan(50);
    const ys = new Set(lineTos.map((o) => Math.round(o.y)));
    expect(ys.size, 'non-flat trace (many distinct y values)').toBeGreaterThan(5);
  });

  it('handles empty frame lists without throwing', () => {
    const { ops, ctx } = mockCtx();
    drawWaveScope(ctx, [], 320, 120, { activeFrame: 0 });
    expect(ops.find((o) => o.op === 'fillRect'), 'still paints bg').toBeDefined();
  });
});

describe('drawWave3D', () => {
  it('renders one polyline per frame with the active frame in white', () => {
    const { ops, ctx } = mockCtx();
    const fs = makeFrames(8, 64);
    drawWave3D(ctx, fs, 320, 120, { activeFrame: 3 });

    expect(ops.find((o) => o.op === 'clearRect')).toBeDefined();
    expect(ops.find((o) => o.op === 'fillRect')).toBeDefined();

    const strokes = ops.filter((o) => o.op === 'stroke');
    expect(strokes.length, 'one stroke per frame').toBe(fs.length);

    const strokeStyles = ops
      .filter((o): o is { op: 'strokeStyle'; v: string } => o.op === 'strokeStyle')
      .map((o) => o.v);
    expect(strokeStyles, 'active frame stroked in white').toContain('#ffffff');
    // Non-active frames use the orange-with-alpha rgba(...) form. This
    // is the wave3d_out video signal's defining characteristic — orange
    // + white together is why wave3d_out is RGB `video`, not `mono-video`.
    expect(strokeStyles.some((s) => s.startsWith('rgba(255,150,40,')), 'orange tones present').toBe(true);
  });

  it('handles single-frame tables without divide-by-zero', () => {
    const { ops, ctx } = mockCtx();
    const fs = makeFrames(1, 32);
    drawWave3D(ctx, fs, 200, 100, { activeFrame: 0 });
    const strokes = ops.filter((o) => o.op === 'stroke');
    expect(strokes.length).toBe(1);
  });
});
