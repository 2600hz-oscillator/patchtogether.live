// packages/web/src/lib/control/push2/push-card-paint.ts
//
// The ONLY browser-touching part of the push-card renderer: replay a
// `PushDrawOp[]` onto a 2D context and hand the RGBA to the display transport.
//
// It is deliberately tiny, and the interesting half is still testable in the
// node unit lane: `paintPushOps` takes a STRUCTURAL context
// (`PushCanvasContextLike`), so a recording fake asserts the exact fill/rect/
// text calls — order, colours, coordinates — with no canvas anywhere. Only
// `pushCardRgba`'s five lines of canvas ALLOCATION need a real browser, and
// those degrade to `null` (⇒ no frame sent, pads and encoders unaffected)
// rather than throwing.

import type { PushDrawOp } from './push-screen-layout';
import { PUSH_SCREEN_W, PUSH_SCREEN_H } from './push-screen-layout';

/** The slice of `CanvasRenderingContext2D` the executor uses. Declared
 *  structurally so a test fake satisfies it exactly. */
export interface PushCanvasContextLike {
  /** Widened to the real `CanvasRenderingContext2D` type — a narrower `string`
   *  would make a live 2D context UNASSIGNABLE here (property types are
   *  covariant), which is exactly the seam this interface exists to keep open.
   *  We only ever WRITE a colour string to it. */
  fillStyle: string | CanvasGradient | CanvasPattern;
  font: string;
  textAlign: string;
  textBaseline: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
}

/** The font stack the panel draws in. A system UI stack rather than a webfont:
 *  the panel is 160 px tall and the card is short strings, so a load-order
 *  dependency would buy nothing and could paint a frame with fallback metrics. */
export const PUSH_FONT_STACK =
  "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/**
 * Replay ops onto a context. PURE with respect to the ops (it never reads state
 * back), so painting the same list twice paints the same pixels.
 *
 * `textBaseline` is set ONCE to 'middle' — every text op's `y` is its vertical
 * centre, which is what lets the layout position from bands instead of from
 * per-platform font metrics.
 */
export function paintPushOps(ctx: PushCanvasContextLike, ops: readonly PushDrawOp[]): void {
  ctx.textBaseline = 'middle';
  for (const o of ops) {
    if (o.op === 'rect') {
      ctx.fillStyle = o.fill;
      ctx.fillRect(o.x, o.y, o.w, o.h);
      continue;
    }
    if (!o.text) continue; // an empty run would still cost a state change
    ctx.fillStyle = o.fill;
    ctx.font = `${o.weight === 'bold' ? '600 ' : ''}${o.px}px ${PUSH_FONT_STACK}`;
    ctx.textAlign = o.align;
    ctx.fillText(o.text, o.x, o.y, o.maxW);
  }
}

// ---------------------------------------------------------------------------
// The browser half — a single reused 960×160 scratch canvas.
// ---------------------------------------------------------------------------

interface ScratchSurface {
  ctx: PushCanvasContextLike;
  data(): Uint8ClampedArray | null;
}

let scratch: ScratchSurface | null | undefined; // undefined = not yet probed

/** Build the 960×160 scratch surface once, preferring OffscreenCanvas. Returns
 *  null wherever neither exists (the node unit lane, SSR) — a missing canvas is
 *  not an error, it just means this machine paints no frames. */
function ensureScratch(): ScratchSurface | null {
  if (scratch !== undefined) return scratch;
  scratch = null;
  try {
    const g = globalThis as {
      OffscreenCanvas?: new (w: number, h: number) => unknown;
      document?: { createElement(tag: string): unknown };
    };
    let surface: unknown = null;
    if (typeof g.OffscreenCanvas === 'function') {
      surface = new g.OffscreenCanvas(PUSH_SCREEN_W, PUSH_SCREEN_H);
    } else if (g.document && typeof g.document.createElement === 'function') {
      const el = g.document.createElement('canvas') as { width: number; height: number };
      el.width = PUSH_SCREEN_W;
      el.height = PUSH_SCREEN_H;
      surface = el;
    }
    const getCtx = (surface as { getContext?: (id: string) => unknown } | null)?.getContext;
    if (!surface || typeof getCtx !== 'function') return scratch;
    const ctx = getCtx.call(surface, '2d') as
      | (PushCanvasContextLike & {
          getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
        })
      | null;
    if (!ctx) return scratch;
    scratch = {
      ctx,
      data: () => {
        try {
          return ctx.getImageData(0, 0, PUSH_SCREEN_W, PUSH_SCREEN_H).data;
        } catch {
          return null; // a tainted or zero-sized surface — drop the frame
        }
      },
    };
  } catch {
    /* no canvas here — stays null */
  }
  return scratch;
}

/** Paint ops to the scratch canvas and return its RGBA, or null when this
 *  environment has no canvas. The buffer is REUSED between calls — hand it
 *  straight to `sendFrame`, which packs synchronously. */
export function pushCardRgba(ops: readonly PushDrawOp[]): Uint8ClampedArray | null {
  const s = ensureScratch();
  if (!s) return null;
  paintPushOps(s.ctx, ops);
  return s.data();
}

/** Is a paint surface available at all? Lets the card say "preview unavailable"
 *  instead of silently showing nothing. */
export function pushCanvasAvailable(): boolean {
  return ensureScratch() !== null;
}

/** TEST-ONLY: forget the probed surface so a spec can re-probe. */
export function __test_resetPushScratch(): void {
  scratch = undefined;
}
