// packages/web/src/lib/video/modules/painter.test.ts
//
// PCU coverage for PAINTER's pure drawing core (no canvas, no GL). The video
// plumbing (painter.ts factory) is exercised on the real GPU by the render-smoke
// e2e; here we lock the serializable op model + the deterministic paint logic
// that replays identically on every peer.

import { describe, it, expect, afterEach } from 'vitest';
import {
  WIN95_PALETTE,
  PAINT_BG,
  isHexColor,
  hexToRgba,
  coerceOps,
  applyVectorOp,
  floodFill,
  appendOp,
  popOp,
  clearOps,
  type Ctx2D,
  type PaintOp,
  type OpLogData,
  type RgbaBitmap,
} from './painter-draw';
import { painterDef } from './painter';
import { patch } from '$lib/graph/store';
import { mutateNode } from '$lib/graph/mutate';
import type { ModuleNode } from '$lib/graph/types';

describe('painter — palette + colour helpers', () => {
  it('the Win95 palette is 28 valid hex colours (2 rows × 14)', () => {
    expect(WIN95_PALETTE.length).toBe(28);
    for (const c of WIN95_PALETTE) expect(isHexColor(c)).toBe(true);
    // black + white are present (the canonical fg/bg)
    expect(WIN95_PALETTE).toContain('#000000');
    expect(WIN95_PALETTE).toContain('#ffffff');
    expect(PAINT_BG).toBe('#ffffff');
  });

  it('isHexColor accepts #rgb / #rrggbb, rejects junk', () => {
    expect(isHexColor('#fff')).toBe(true);
    expect(isHexColor('#ff8040')).toBe(true);
    expect(isHexColor('ff8040')).toBe(false);
    expect(isHexColor('#xyz')).toBe(false);
    expect(isHexColor(42)).toBe(false);
    expect(isHexColor(null)).toBe(false);
  });

  it('hexToRgba parses long + short form, defaults black on junk', () => {
    expect(hexToRgba('#ff0000')).toEqual([255, 0, 0, 255]);
    expect(hexToRgba('#0f0')).toEqual([0, 255, 0, 255]);
    expect(hexToRgba('#000080')).toEqual([0, 0, 128, 255]);
    expect(hexToRgba('garbage')).toEqual([0, 0, 0, 255]);
  });
});

describe('painter — coerceOps validation', () => {
  it('keeps a well-formed op of each kind', () => {
    const raw: unknown[] = [
      { kind: 'stroke', tool: 'brush', color: '#ff0000', size: 4, points: [0, 0, 10, 10] },
      { kind: 'shape', tool: 'rect', color: '#000000', size: 2, fill: '#00ff00', x0: 1, y0: 2, x1: 3, y1: 4 },
      { kind: 'shape', tool: 'line', color: '#000000', size: 2, fill: null, x0: 0, y0: 0, x1: 5, y1: 5 },
      { kind: 'fill', color: '#0000ff', x: 5, y: 5 },
      { kind: 'text', color: '#000000', size: 24, x: 1, y: 1, text: 'hi', font: 'sans-serif' },
      { kind: 'snapshot', dataUrl: 'data:image/png;base64,AAAA' },
    ];
    const ops = coerceOps(raw);
    expect(ops.map((o) => o.kind)).toEqual(['stroke', 'shape', 'shape', 'fill', 'text', 'snapshot']);
  });

  it('drops malformed ops (bad colour / short points / unknown kind / non-array)', () => {
    expect(coerceOps('nope')).toEqual([]);
    expect(coerceOps([
      { kind: 'stroke', tool: 'brush', color: 'red', size: 4, points: [0, 0] }, // bad colour
      { kind: 'stroke', tool: 'brush', color: '#fff', size: 4, points: [0] }, // odd/short points
      { kind: 'shape', tool: 'triangle', color: '#000', size: 1, fill: null, x0: 0, y0: 0, x1: 1, y1: 1 }, // bad tool
      { kind: 'wat' },
      { kind: 'fill', color: '#000', x: 'x', y: 0 }, // bad coord
      42,
      null,
    ])).toEqual([]);
  });

  it('a single-point stroke (a dot) is valid (points length 2)', () => {
    const ops = coerceOps([{ kind: 'stroke', tool: 'pencil', color: '#000000', size: 1, points: [4, 4] }]);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('stroke');
  });
});

/** A recording 2D-context stub — captures the calls applyVectorOp makes so we can
 *  assert the right primitive was drawn without a real canvas. */
function recordingCtx(): Ctx2D & { calls: string[]; props: Record<string, unknown> } {
  const calls: string[] = [];
  const props: Record<string, unknown> = {};
  const rec = (name: string) => (...args: unknown[]) => { calls.push(`${name}(${args.join(',')})`); };
  return {
    calls, props,
    set strokeStyle(v) { props.strokeStyle = v; }, get strokeStyle() { return props.strokeStyle as string; },
    set fillStyle(v) { props.fillStyle = v; }, get fillStyle() { return props.fillStyle as string; },
    set lineWidth(v) { props.lineWidth = v; }, get lineWidth() { return props.lineWidth as number; },
    set lineCap(v) { props.lineCap = v; }, get lineCap() { return props.lineCap as CanvasLineCap; },
    set lineJoin(v) { props.lineJoin = v; }, get lineJoin() { return props.lineJoin as CanvasLineJoin; },
    set font(v) { props.font = v; }, get font() { return props.font as string; },
    set textBaseline(v) { props.textBaseline = v; }, get textBaseline() { return props.textBaseline as CanvasTextBaseline; },
    beginPath: rec('beginPath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'),
    stroke: rec('stroke'), fill: rec('fill'), rect: rec('rect'), ellipse: rec('ellipse'),
    fillRect: rec('fillRect'), fillText: rec('fillText'), closePath: rec('closePath'),
  } as unknown as Ctx2D & { calls: string[]; props: Record<string, unknown> };
}

describe('painter — applyVectorOp', () => {
  it('a stroke draws a polyline with the colour + width', () => {
    const ctx = recordingCtx();
    const ok = applyVectorOp(ctx, { kind: 'stroke', tool: 'brush', color: '#ff0000', size: 6, points: [0, 0, 10, 10, 20, 0] });
    expect(ok).toBe(true);
    expect(ctx.props.strokeStyle).toBe('#ff0000');
    expect(ctx.props.lineWidth).toBe(6);
    expect(ctx.calls.filter((c) => c.startsWith('lineTo')).length).toBe(2);
    expect(ctx.calls).toContain('stroke()');
  });

  it('a filled rect both fills (interior) and strokes (outline)', () => {
    const ctx = recordingCtx();
    applyVectorOp(ctx, { kind: 'shape', tool: 'rect', color: '#000000', size: 2, fill: '#00ff00', x0: 0, y0: 0, x1: 10, y1: 8 });
    expect(ctx.calls.some((c) => c.startsWith('fillRect'))).toBe(true);
    expect(ctx.calls.some((c) => c.startsWith('rect'))).toBe(true);
    expect(ctx.calls).toContain('stroke()');
  });

  it('an outline-only ellipse fills nothing', () => {
    const ctx = recordingCtx();
    applyVectorOp(ctx, { kind: 'shape', tool: 'ellipse', color: '#000000', size: 2, fill: null, x0: 0, y0: 0, x1: 20, y1: 20 });
    expect(ctx.calls.some((c) => c.startsWith('ellipse'))).toBe(true);
    expect(ctx.calls).toContain('stroke()');
    expect(ctx.calls).not.toContain('fill()');
  });

  it('text stamps via fillText with the px font', () => {
    const ctx = recordingCtx();
    applyVectorOp(ctx, { kind: 'text', color: '#0000ff', size: 32, x: 5, y: 6, text: 'hi', font: 'serif' });
    expect(ctx.props.font).toBe('32px serif');
    expect(ctx.calls.some((c) => c.startsWith('fillText(hi,5,6)'))).toBe(true);
  });

  it('returns false for fill / snapshot (the card handles those)', () => {
    const ctx = recordingCtx();
    expect(applyVectorOp(ctx, { kind: 'fill', color: '#000000', x: 0, y: 0 } as PaintOp)).toBe(false);
    expect(applyVectorOp(ctx, { kind: 'snapshot', dataUrl: 'data:image/png;base64,AA' } as PaintOp)).toBe(false);
  });
});

describe('painter — floodFill', () => {
  /** Build a w×h opaque-white bitmap. */
  function whiteBitmap(w: number, h: number): RgbaBitmap {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i += 4) { data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255; }
    return { data, width: w, height: h };
  }
  const px = (img: RgbaBitmap, x: number, y: number) => {
    const i = (y * img.width + x) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
  };

  it('fills the whole canvas when it is one uniform region', () => {
    const img = whiteBitmap(4, 4);
    const n = floodFill(img, 0, 0, [255, 0, 0, 255]);
    expect(n).toBe(16);
    expect(px(img, 3, 3)).toEqual([255, 0, 0, 255]);
  });

  it('fills the WHOLE region from a CENTER seed (left half too — scanline regression)', () => {
    // Seeding from the middle must paint the run's left side as well; an early
    // bug painted from the seed x rightward only, leaving the left half white.
    const img = whiteBitmap(7, 5);
    const n = floodFill(img, 3, 2, [0, 0, 255, 255]);
    expect(n).toBe(35); // every pixel
    expect(px(img, 0, 0)).toEqual([0, 0, 255, 255]); // top-left corner reached
    expect(px(img, 0, 2)).toEqual([0, 0, 255, 255]); // left of the seed row
    expect(px(img, 6, 4)).toEqual([0, 0, 255, 255]); // bottom-right corner
  });

  it('respects a barrier — fills only the seed side', () => {
    const img = whiteBitmap(5, 1); // a 5×1 row
    // paint a black wall at x=2
    const wall = (2 * 1) * 4; // y=0
    img.data[wall] = 0; img.data[wall + 1] = 0; img.data[wall + 2] = 0;
    const n = floodFill(img, 0, 0, [0, 0, 255, 255]); // fill from the left
    expect(n).toBe(2); // x=0,1 only (x=2 is the wall, x=3,4 unreachable)
    expect(px(img, 0, 0)).toEqual([0, 0, 255, 255]);
    expect(px(img, 1, 0)).toEqual([0, 0, 255, 255]);
    expect(px(img, 3, 0)).toEqual([255, 255, 255, 255]); // untouched
  });

  it('is a no-op when the seed already equals the target colour', () => {
    const img = whiteBitmap(3, 3);
    expect(floodFill(img, 1, 1, [255, 255, 255, 255])).toBe(0);
  });

  it('out-of-bounds seed does nothing', () => {
    const img = whiteBitmap(2, 2);
    expect(floodFill(img, 9, 9, [0, 0, 0, 255])).toBe(0);
  });
});

describe('painter — module def contract', () => {
  it('is a lowercase-labelled video source with a single video out + no inputs', () => {
    expect(painterDef.type).toBe('painter');
    expect(painterDef.label).toBe('painter');
    expect(painterDef.label).toBe(painterDef.label.toLowerCase());
    expect(painterDef.domain).toBe('video');
    expect(painterDef.inputs).toEqual([]);
    expect(painterDef.outputs).toEqual([{ id: 'out', type: 'video' }]);
  });
});

describe('painter — op-log mutators (in place)', () => {
  const fill = (n: number): PaintOp => ({ kind: 'fill', color: '#000000', x: n, y: n });

  it('appendOp pushes in place + creates the array when missing', () => {
    const d: OpLogData = {};
    appendOp(d, fill(1));
    appendOp(d, fill(2));
    expect(d.ops).toHaveLength(2);
    expect(d.ops![1]).toMatchObject({ kind: 'fill', x: 2 });
  });

  it('appendOp soft-caps at maxOps (local drawing unaffected; just stops persisting)', () => {
    const d: OpLogData = { ops: [] };
    for (let k = 0; k < 5; k++) appendOp(d, fill(k), 3);
    expect(d.ops).toHaveLength(3);
  });

  it('popOp removes the last op + is a safe no-op past empty', () => {
    const d: OpLogData = { ops: [fill(1), fill(2)] };
    popOp(d);
    expect(d.ops).toHaveLength(1);
    popOp(d);
    popOp(d);
    expect(d.ops).toHaveLength(0);
  });

  it('clearOps empties the log', () => {
    const d: OpLogData = { ops: [fill(1), fill(2), fill(3)] };
    clearOps(d);
    expect(d.ops).toEqual([]);
  });
});

describe('painter — op log on a REAL Y.Doc (2nd-op re-integration regression)', () => {
  // The bug: commitOp did `ops = d.ops.slice(); ops.push(op); d.ops = ops` — under
  // a SyncedStore proxy `.slice()` copies references to already-integrated Y
  // objects, and reassigning that array throws "Not supported: reassigning object
  // that already occurs in the tree" on the 2nd+ op → every paint after the first
  // was silently dropped + the canvas rolled back when a repaint fired. These run
  // against the SAME syncedStore/Y.Doc the live patch uses, so node.data.ops is a
  // real Y type — the only way to catch the trap ([[yjs-save-load-real-ydoc]]).
  const PID = 'painter-ydoc-test';
  function setup(): void {
    patch.nodes[PID] = {
      id: PID, type: 'painter', domain: 'video', position: { x: 0, y: 0 }, params: {}, data: {},
    } as unknown as ModuleNode;
  }
  afterEach(() => {
    for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
    for (const id of Object.keys(patch.edges)) delete patch.edges[id];
  });

  const stroke = (y: number): PaintOp => ({ kind: 'stroke', tool: 'brush', color: '#ff0000', size: 8, points: [0, y, 100, y] });

  it('commits MANY ops in a row without the re-integration trap (was: only the 1st stuck)', () => {
    setup();
    expect(() => {
      for (let k = 0; k < 6; k++) mutateNode(PID, (live) => appendOp(live.data as OpLogData, stroke(k * 10)));
    }).not.toThrow();
    expect(coerceOps(patch.nodes[PID]!.data?.ops)).toHaveLength(6);
  });

  it('undo + clear mutate the live log in place, and append still works after clear', () => {
    setup();
    for (let k = 0; k < 3; k++) mutateNode(PID, (live) => appendOp(live.data as OpLogData, stroke(k)));
    expect(() => mutateNode(PID, (live) => popOp(live.data as OpLogData))).not.toThrow();
    expect(coerceOps(patch.nodes[PID]!.data?.ops)).toHaveLength(2);
    expect(() => mutateNode(PID, (live) => clearOps(live.data as OpLogData))).not.toThrow();
    expect(coerceOps(patch.nodes[PID]!.data?.ops)).toHaveLength(0);
    expect(() => mutateNode(PID, (live) => appendOp(live.data as OpLogData, stroke(99)))).not.toThrow();
    expect(coerceOps(patch.nodes[PID]!.data?.ops)).toHaveLength(1);
  });
});
