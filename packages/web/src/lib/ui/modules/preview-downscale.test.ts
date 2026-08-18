// packages/web/src/lib/ui/modules/preview-downscale.test.ts
//
// #1846. The claim under test is NOT "the preview looks nicer" — it is the
// mechanical one the fix rests on: **no single resampling step reduces by more
// than 2×**, because a 2×2 bilinear tap reads every source pixel at 2× and
// starts discarding rows past it.
//
// ⚠ THE INSTRUMENT. `drawPreviewDownscaled` degenerates to the original single
// `drawImage` in any environment with no real 2D context — which is exactly
// this one (jsdom). A test that only drove the DOM half would therefore watch
// the FALLBACK path and pass while proving nothing about the fix. So the
// decision lives in a pure function, `planDownscaleSteps`, and that is what is
// asserted here; the DOM half is tested through a FAKE context that records the
// draws, so the ratios it produces are checked without a canvas at all.
//
// The permanent negative controls are the two directions the fix must NOT move:
// a 1:1 draw (FULLSCREEN — `fullscreenCanvasDims` sizes the buffer to the
// engine dims, which is why fullscreen was never affected) and an UPSCALE both
// have to plan zero steps.

import { describe, expect, it, beforeEach } from 'vitest';
import {
  planDownscaleSteps,
  drawPreviewDownscaled,
  MAX_DOWNSCALE_STEPS,
  __resetPreviewDownscalePads,
} from './preview-downscale';

/** The engine's drawing-buffer size (VIDEO_RES). Every card reads its preview
 *  out of a buffer this size. */
const ENGINE_W = 1024;
const ENGINE_H = 768;

/** The RACKLINE lane thumbnail (VIDEO_THUMB_W/H) — the worst reduction that
 *  ships, at 6.4×. */
const THUMB_W = 160;
const THUMB_H = 120;

/** The largest reduction any step is allowed to be. This is the whole fix: it
 *  is the footprint of a bilinear tap, a property of the sampler, not a count
 *  of anything in this repo. */
const MAX_STEP_RATIO = 2;

/** Walk a plan and return the reduction ratio of EVERY step, including the
 *  final draw into the destination — the step a plan-only check would miss. */
function stepRatios(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): number[] {
  const steps = planDownscaleSteps(srcW, srcH, dstW, dstH);
  const ratios: number[] = [];
  let w = srcW;
  let h = srcH;
  for (const s of steps) {
    ratios.push(Math.max(w / s.w, h / s.h));
    w = s.w;
    h = s.h;
  }
  ratios.push(Math.max(w / dstW, h / dstH));
  return ratios;
}

describe('planDownscaleSteps — no step may reduce by more than 2x', () => {
  it('holds for the shipped preview sizes, final draw included', () => {
    // (label, destination width, destination height) at the sizes that
    // actually ship. Derived from the components, not invented: the RACKLINE
    // lane thumb is VIDEO_THUMB_W/H; the OUTPUT card's default fit rect is its
    // 360x360 card inner area letterboxed to 4:3; the dock/full-view pane is
    // wider; FULLSCREEN is the engine buffer itself.
    const cases: [string, number, number][] = [
      ['lane thumb', THUMB_W, THUMB_H],
      ['default OUTPUT card fit rect', 340, 255],
      ['small BENTBOX screen', 220, 165],
      ['wide dock pane', 700, 525],
      ['fullscreen (1:1)', ENGINE_W, ENGINE_H],
    ];
    const offenders: string[] = [];
    for (const [label, w, h] of cases) {
      for (const [i, ratio] of stepRatios(ENGINE_W, ENGINE_H, w, h).entries()) {
        if (ratio > MAX_STEP_RATIO + 1e-9) {
          offenders.push(
            `${label} (${ENGINE_W}x${ENGINE_H} -> ${w}x${h}) step ${i}: ` +
              `${ratio.toFixed(3)}x reduction (max ${MAX_STEP_RATIO}x)`,
          );
        }
      }
    }
    expect(offenders, 'reduction ratio per resampling step, unitless').toEqual([]);
  });

  it('holds across a swept range of destination sizes', () => {
    const offenders: string[] = [];
    // Odd stride so the sweep cannot land only on powers of two, where a
    // halving plan is trivially exact and the check would alias to a constant.
    for (let w = 17; w <= ENGINE_W; w += 37) {
      const h = Math.max(1, Math.round((w * ENGINE_H) / ENGINE_W));
      for (const [i, ratio] of stepRatios(ENGINE_W, ENGINE_H, w, h).entries()) {
        if (ratio > MAX_STEP_RATIO + 1e-9) {
          offenders.push(`${w}x${h} step ${i}: ${ratio.toFixed(3)}x`);
        }
      }
    }
    expect(offenders, 'reduction ratio per resampling step, unitless').toEqual([]);
  });

  it('NEGATIVE CONTROL: the check can fail — the OLD single-step draw violates it', () => {
    // The permanent proof that the assertion above is not vacuous. The pre-fix
    // behaviour is exactly "one step, straight to the destination".
    const singleStep = Math.max(ENGINE_W / THUMB_W, ENGINE_H / THUMB_H);
    expect(singleStep).toBeGreaterThan(MAX_STEP_RATIO);
    expect(singleStep).toBeCloseTo(6.4, 1);
  });

  it('NEGATIVE CONTROL: 1:1 (fullscreen) plans ZERO steps, so the draw is unchanged', () => {
    expect(planDownscaleSteps(ENGINE_W, ENGINE_H, ENGINE_W, ENGINE_H)).toEqual([]);
  });

  it('NEGATIVE CONTROL: an UPSCALE plans ZERO steps', () => {
    expect(planDownscaleSteps(THUMB_W, THUMB_H, ENGINE_W, ENGINE_H)).toEqual([]);
  });

  it('plans zero steps while the reduction is still under 2x', () => {
    // 1024 -> 520 is 1.97x: a single bilinear tap already covers it.
    expect(planDownscaleSteps(ENGINE_W, ENGINE_H, 520, 390)).toEqual([]);
    // 1024 -> 512 is exactly 2x: still one tap's worth, still no halving.
    expect(planDownscaleSteps(ENGINE_W, ENGINE_H, 512, 384)).toEqual([]);
    // 1024 -> 511 crosses it.
    expect(planDownscaleSteps(ENGINE_W, ENGINE_H, 511, 383).length).toBe(1);
  });

  it('is bounded and terminates on a degenerate destination', () => {
    expect(planDownscaleSteps(ENGINE_W, ENGINE_H, 1, 1).length).toBe(MAX_DOWNSCALE_STEPS);
  });

  it('returns an empty plan for unreadable or degenerate dimensions', () => {
    expect(planDownscaleSteps(0, 0, THUMB_W, THUMB_H)).toEqual([]);
    expect(planDownscaleSteps(ENGINE_W, ENGINE_H, 0, 0)).toEqual([]);
    expect(planDownscaleSteps(Number.NaN, ENGINE_H, THUMB_W, THUMB_H)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The DOM half, driven through a fake context so the draws are observable.
// ---------------------------------------------------------------------------

interface RecordedDraw {
  args: number[];
}

function fakeCtx(): CanvasRenderingContext2D & { draws: RecordedDraw[] } {
  const draws: RecordedDraw[] = [];
  return {
    draws,
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
    globalCompositeOperation: 'source-over',
    drawImage: (_src: unknown, ...rest: number[]) => {
      draws.push({ args: rest });
    },
  } as unknown as CanvasRenderingContext2D & { draws: RecordedDraw[] };
}

describe('drawPreviewDownscaled', () => {
  beforeEach(() => {
    __resetPreviewDownscalePads();
  });

  it('turns smoothing ON at HIGH quality on the destination context', () => {
    const ctx = fakeCtx();
    drawPreviewDownscaled(
      ctx,
      { width: ENGINE_W, height: ENGINE_H } as unknown as CanvasImageSource,
      0,
      0,
      THUMB_W,
      THUMB_H,
    );
    expect(ctx.imageSmoothingEnabled).toBe(true);
    expect(ctx.imageSmoothingQuality).toBe('high');
  });

  it('FALLBACK: with no scratch context it makes exactly ONE draw, the original 5-arg call', () => {
    // jsdom has no 2D context, so this IS the path taken here — assert it
    // explicitly rather than leaving it as an unstated assumption of every
    // other card test that mocks a context.
    const ctx = fakeCtx();
    const used = drawPreviewDownscaled(
      ctx,
      { width: ENGINE_W, height: ENGINE_H } as unknown as CanvasImageSource,
      7,
      9,
      THUMB_W,
      THUMB_H,
    );
    expect(used).toBe(0);
    expect(ctx.draws.length).toBe(1);
    expect(ctx.draws[0]!.args).toEqual([7, 9, THUMB_W, THUMB_H]);
  });

  it('FALLBACK preserves the 9-arg call shape when the caller passed a source rect', () => {
    const ctx = fakeCtx();
    drawPreviewDownscaled(
      ctx,
      { width: ENGINE_W, height: ENGINE_H } as unknown as CanvasImageSource,
      0,
      0,
      200,
      150,
      { x: 0, y: 0, w: ENGINE_W, h: ENGINE_H },
    );
    expect(ctx.draws[0]!.args).toEqual([0, 0, ENGINE_W, ENGINE_H, 0, 0, 200, 150]);
  });

  it('a 1:1 source (fullscreen) makes exactly ONE draw', () => {
    const ctx = fakeCtx();
    const used = drawPreviewDownscaled(
      ctx,
      { width: ENGINE_W, height: ENGINE_H } as unknown as CanvasImageSource,
      0,
      0,
      ENGINE_W,
      ENGINE_H,
    );
    expect(used).toBe(0);
    expect(ctx.draws.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// THE REAL PATH. Everything above watches the fallback, because there is no 2D
// context in this environment. That is not good enough: the assertion that
// matters is about the draws the SHIPPING code makes, so stand up a fake
// `document` whose canvases hand back recording contexts and drive
// `drawPreviewDownscaled` down its actual branch. The ratios below come out of
// the function, not out of the planner.
// ---------------------------------------------------------------------------

interface FakePad {
  width: number;
  height: number;
  draws: number[][];
}

function withFakeCanvasDocument<T>(body: (pads: FakePad[]) => T): T {
  const pads: FakePad[] = [];
  const doc = {
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
      const pad: FakePad = { width: 0, height: 0, draws: [] };
      pads.push(pad);
      const ctx = {
        globalCompositeOperation: 'source-over',
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low',
        drawImage: (_s: unknown, ...rest: number[]) => {
          pad.draws.push(rest);
        },
      };
      // `pad` IS the canvas: width/height are plain writable fields, which is
      // all the helper touches.
      return Object.assign(pad, { getContext: () => ctx });
    },
  };
  const g = globalThis as unknown as { document?: unknown };
  const had = 'document' in g;
  const prev = g.document;
  g.document = doc;
  try {
    return body(pads);
  } finally {
    if (had) g.document = prev;
    else delete g.document;
  }
}

describe('drawPreviewDownscaled — the real multi-step path', () => {
  beforeEach(() => {
    __resetPreviewDownscalePads();
  });

  it('shrinks the lane thumb through scratch pads, and NO step exceeds 2x', () => {
    const { used, ratios, destArgs } = withFakeCanvasDocument((pads) => {
      const ctx = fakeCtx();
      const used = drawPreviewDownscaled(
        ctx,
        { width: ENGINE_W, height: ENGINE_H } as unknown as CanvasImageSource,
        3,
        5,
        THUMB_W,
        THUMB_H,
      );
      // Every pad draw is 9-arg: sx, sy, sw, sh, dx, dy, dw, dh.
      const padDraws = pads.flatMap((p) => p.draws);
      const ratios: number[] = [];
      for (const d of padDraws) {
        ratios.push(Math.max(d[2]! / d[6]!, d[3]! / d[7]!));
      }
      // …and the final draw into the destination context.
      const last = ctx.draws.at(-1)!.args;
      ratios.push(Math.max(last[2]! / last[6]!, last[3]! / last[7]!));
      return { used, ratios, destArgs: last };
    });

    expect(used, 'halving steps actually applied').toBe(2);
    const worst = Math.max(...ratios);
    expect(
      worst,
      `worst per-step reduction ${worst.toFixed(3)}x (unitless ratio); ` +
        `steps: ${ratios.map((r) => r.toFixed(2)).join(', ')}`,
    ).toBeLessThanOrEqual(MAX_STEP_RATIO + 1e-9);
    // The destination rect the caller asked for is untouched by the rewrite.
    expect(destArgs.slice(4)).toEqual([3, 5, THUMB_W, THUMB_H]);
  });

  it('NEGATIVE CONTROL: the same instrument SEES the pre-fix violation', () => {
    // Drive the identical measurement over a single-step draw and confirm it
    // reports > 2x. Without this leg a broken ratio computation would report
    // "all steps fine" for every input, including the bug.
    const single = [0, 0, ENGINE_W, ENGINE_H, 0, 0, THUMB_W, THUMB_H];
    const ratio = Math.max(single[2]! / single[6]!, single[3]! / single[7]!);
    expect(ratio).toBeGreaterThan(MAX_STEP_RATIO);
  });

  it('NEGATIVE CONTROL: at 1:1 the real path still makes exactly one draw and allocates no pad', () => {
    const padCount = withFakeCanvasDocument((pads) => {
      const ctx = fakeCtx();
      drawPreviewDownscaled(
        ctx,
        { width: ENGINE_W, height: ENGINE_H } as unknown as CanvasImageSource,
        0,
        0,
        ENGINE_W,
        ENGINE_H,
      );
      expect(ctx.draws.length).toBe(1);
      expect(ctx.draws[0]!.args).toEqual([0, 0, ENGINE_W, ENGINE_H]);
      return pads.length;
    });
    expect(padCount, 'scratch canvases allocated for a 1:1 draw').toBe(0);
  });

  it('reuses its two scratch pads across calls instead of allocating per frame', () => {
    const padCount = withFakeCanvasDocument((pads) => {
      const ctx = fakeCtx();
      for (let i = 0; i < 5; i++) {
        drawPreviewDownscaled(
          ctx,
          { width: ENGINE_W, height: ENGINE_H } as unknown as CanvasImageSource,
          0,
          0,
          THUMB_W,
          THUMB_H,
        );
      }
      return pads.length;
    });
    expect(padCount, 'canvases created across 5 preview frames').toBe(2);
  });
});
