// packages/web/src/lib/control/push2/push-card-paint.test.ts
//
// The draw-op EXECUTOR, against a recording context — so the one browser-facing
// file in the renderer is still covered by the node unit lane. Only the five
// lines that ALLOCATE a canvas need a real browser, and those are asserted to
// degrade to null rather than throw.
import { describe, it, expect, beforeEach } from 'vitest';

import {
  paintPushOps,
  pushCardRgba,
  pushCanvasAvailable,
  __test_resetPushScratch,
  PUSH_FONT_STACK,
  type PushCanvasContextLike,
} from './push-card-paint';
import type { PushDrawOp } from './push-screen-layout';

type Call =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; fill: string }
  | { kind: 'text'; s: string; x: number; y: number; maxW?: number; fill: string; font: string; align: string; baseline: string };

function recorder(): { ctx: PushCanvasContextLike; calls: Call[] } {
  const calls: Call[] = [];
  const ctx: PushCanvasContextLike = {
    fillStyle: '',
    font: '',
    textAlign: '',
    textBaseline: '',
    fillRect(x, y, w, h) {
      calls.push({ kind: 'rect', x, y, w, h, fill: String(ctx.fillStyle) });
    },
    fillText(s, x, y, maxW) {
      calls.push({
        kind: 'text', s, x, y, maxW,
        fill: String(ctx.fillStyle), font: ctx.font, align: ctx.textAlign, baseline: ctx.textBaseline,
      });
    },
  };
  return { ctx, calls };
}

const RECT: PushDrawOp = { op: 'rect', x: 4, y: 5, w: 6, h: 7, fill: '#123456' };
const TEXT: PushDrawOp = {
  op: 'text', x: 60, y: 41, text: 'CUTOFF', fill: '#ffffff',
  px: 11, weight: 'normal', align: 'center', maxW: 104,
};
const BOLD: PushDrawOp = { ...TEXT, text: 'my vco', px: 14, weight: 'bold', align: 'left' };

beforeEach(() => __test_resetPushScratch());

describe('paintPushOps', () => {
  it('replays rects with their own fill colour', () => {
    const { ctx, calls } = recorder();
    paintPushOps(ctx, [RECT]);
    expect(calls).toEqual([{ kind: 'rect', x: 4, y: 5, w: 6, h: 7, fill: '#123456' }]);
  });

  it('draws text at its own size/weight/alignment, and passes maxW through', () => {
    const { ctx, calls } = recorder();
    paintPushOps(ctx, [TEXT, BOLD]);
    expect(calls).toHaveLength(2);
    const [a, b] = calls as [Extract<Call, { kind: 'text' }>, Extract<Call, { kind: 'text' }>];
    expect(a.s).toBe('CUTOFF');
    expect(a.font).toBe(`11px ${PUSH_FONT_STACK}`);
    expect(a.align).toBe('center');
    expect(a.maxW, 'the hard width limit reaches fillText').toBe(104);
    expect(b.font, 'bold carries a weight prefix').toBe(`600 14px ${PUSH_FONT_STACK}`);
    expect(b.align).toBe('left');
  });

  it("sets textBaseline='middle' — every text op's y is its CENTRE", () => {
    // The layout positions from bands, not from font metrics. If the baseline
    // were 'alphabetic' every label would sit ~8px too high on the panel and
    // the layout's band arithmetic would be silently wrong.
    const { ctx, calls } = recorder();
    paintPushOps(ctx, [TEXT]);
    expect((calls[0] as Extract<Call, { kind: 'text' }>).baseline).toBe('middle');
    expect(ctx.textBaseline).toBe('middle');
  });

  it('preserves op ORDER — later ops paint over earlier ones', () => {
    const { ctx, calls } = recorder();
    const bg: PushDrawOp = { op: 'rect', x: 0, y: 0, w: 960, h: 160, fill: '#000000' };
    paintPushOps(ctx, [bg, RECT, TEXT]);
    expect(calls.map((c) => c.kind)).toEqual(['rect', 'rect', 'text']);
    expect((calls[0] as Extract<Call, { kind: 'rect' }>).fill).toBe('#000000');
  });

  it('skips an EMPTY text run (a blank strip costs no state change)', () => {
    const { ctx, calls } = recorder();
    paintPushOps(ctx, [{ ...TEXT, text: '' } as PushDrawOp]);
    expect(calls).toHaveLength(0);
  });

  it('is idempotent — painting the same list twice issues the same calls', () => {
    const a = recorder();
    const b = recorder();
    paintPushOps(a.ctx, [RECT, TEXT]);
    paintPushOps(b.ctx, [RECT, TEXT]);
    expect(a.calls).toEqual(b.calls);
  });
});

describe('the canvas half degrades instead of throwing', () => {
  it('with no canvas API at all, pushCardRgba returns null and reports unavailable', () => {
    // This IS the unit lane's environment (`environment: 'node'`), which is the
    // same shape as Safari-with-no-OffscreenCanvas-and-no-document: the display
    // simply paints nothing, and pads/encoders are unaffected.
    expect(pushCanvasAvailable()).toBe(false);
    expect(() => pushCardRgba([RECT])).not.toThrow();
    expect(pushCardRgba([RECT])).toBeNull();
  });

  it('uses OffscreenCanvas when it exists, and hands it the ops', () => {
    const calls: string[] = [];
    const ctx = {
      fillStyle: '', font: '', textAlign: '', textBaseline: '',
      fillRect: () => calls.push('rect'),
      fillText: () => calls.push('text'),
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
      }),
    };
    const g = globalThis as { OffscreenCanvas?: unknown };
    const prev = g.OffscreenCanvas;
    g.OffscreenCanvas = class {
      constructor(public width: number, public height: number) {}
      getContext() {
        return ctx;
      }
    };
    try {
      __test_resetPushScratch();
      expect(pushCanvasAvailable()).toBe(true);
      const rgba = pushCardRgba([RECT, TEXT]);
      expect(rgba).toBeInstanceOf(Uint8ClampedArray);
      expect(rgba!.length, '960 × 160 × 4').toBe(960 * 160 * 4);
      expect(calls).toEqual(['rect', 'text']);
    } finally {
      if (prev === undefined) delete g.OffscreenCanvas;
      else g.OffscreenCanvas = prev;
      __test_resetPushScratch();
    }
  });

  it('a getImageData that throws (a tainted surface) drops the frame, not the app', () => {
    const g = globalThis as { OffscreenCanvas?: unknown };
    const prev = g.OffscreenCanvas;
    g.OffscreenCanvas = class {
      constructor(public width: number, public height: number) {}
      getContext() {
        return {
          fillStyle: '', font: '', textAlign: '', textBaseline: '',
          fillRect: () => {},
          fillText: () => {},
          getImageData: () => {
            throw new Error('tainted');
          },
        };
      }
    };
    try {
      __test_resetPushScratch();
      expect(pushCardRgba([RECT])).toBeNull();
    } finally {
      if (prev === undefined) delete g.OffscreenCanvas;
      else g.OffscreenCanvas = prev;
      __test_resetPushScratch();
    }
  });
});
