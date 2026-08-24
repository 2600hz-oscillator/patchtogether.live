// packages/web/src/lib/ui/modules/twotracks-waveform-draw.test.ts
//
// The twotracks reel picture is the COORDINATE SYSTEM for two of the module's
// params — START and END are positions in it — so the arithmetic that PAINTS a
// marker and the arithmetic that decides you GRABBED it have to be the same
// arithmetic. These tests pin that agreement, plus the empty-tape state that
// separates "no tape yet" from "the body failed to mount".
//
// Pure: no browser, no AudioContext, no Svelte. The draw is exercised against a
// recording 2D-context double.

import { describe, it, expect } from 'vitest';
import {
  drawTwotracksReel,
  twotracksHandleHit,
  twotracksHasTape,
  twotracksMarkPositions,
  twotracksPosToFrac,
  TWOTRACKS_EMPTY_TAPE_TEXT,
  TWOTRACKS_HANDLE_HIT_PX,
  type TwotracksReelView,
} from './twotracks-waveform-draw';

/** A 2D context double that records the calls the assertions care about. */
function recordingCanvas(width: number, height: number) {
  const texts: { text: string; x: number; y: number }[] = [];
  const strokeColors: string[] = [];
  const fillRects: { x: number; y: number; w: number; h: number }[] = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    font: '',
    textAlign: '',
    clearRect() {},
    fillRect(x: number, y: number, w: number, h: number) {
      fillRects.push({ x, y, w, h });
    },
    fillText(text: string, x: number, y: number) {
      texts.push({ text, x, y });
    },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {
      strokeColors.push(String(ctx.strokeStyle));
    },
  };
  const el = {
    width,
    height,
    getContext: (kind: string) => (kind === '2d' ? ctx : null),
  } as unknown as HTMLCanvasElement;
  return { el, ctx, texts, strokeColors, fillRects };
}

const view = (over: Partial<TwotracksReelView> = {}): TwotracksReelView => ({
  peaks: null,
  bufLen: 0,
  playheadFrac: 0,
  startFrac: 0,
  endFrac: 1,
  ...over,
});

const tape = (over: Partial<TwotracksReelView> = {}): TwotracksReelView =>
  view({ peaks: new Float32Array([0.5, 0.5, 0.5, 0.5]), bufLen: 48_000, ...over });

describe('twotracks reel geometry — the draw and the hit-test agree', () => {
  // ⚠ THE POINT OF THIS FILE. A marker painted at pixel X must be grabbable by a
  // pointer at pixel X. These are two different functions and nothing else in
  // the tree joins them, so a change to one that forgot the other would produce
  // a dead zone the player experiences as a handle that will not move — and no
  // other gate can see it.
  it('a pointer AT a painted marker hits that marker, for every marker', () => {
    const W = 220;
    const v = tape({ startFrac: 0.25, endFrac: 0.8, playheadFrac: 0.5 });
    const marks = twotracksMarkPositions(v, W);

    expect(twotracksHandleHit(twotracksPosToFrac(marks.startX, W), v.startFrac, v.endFrac, W))
      .toBe('start');
    expect(twotracksHandleHit(twotracksPosToFrac(marks.endX, W), v.startFrac, v.endFrac, W))
      .toBe('end');
    // The playhead is not a marker you grab BY position — anywhere that is not a
    // handle scrubs — so the assertion is that the middle of the tape scrubs.
    expect(twotracksHandleHit(twotracksPosToFrac(marks.playheadX, W), v.startFrac, v.endFrac, W))
      .toBe('playhead');
  });

  it('NEGATIVE CONTROL: just outside the hit radius is a scrub, not a handle', () => {
    const W = 220;
    // One pixel beyond the radius, converted to a fraction.
    const justOutside = 0.25 + (TWOTRACKS_HANDLE_HIT_PX + 1) / W;
    expect(twotracksHandleHit(justOutside, 0.25, 0.8, W)).toBe('playhead');
    // …and just inside is still the handle, so the assertion above is measuring
    // the radius rather than always returning 'playhead'.
    const justInside = 0.25 + (TWOTRACKS_HANDLE_HIT_PX - 1) / W;
    expect(twotracksHandleHit(justInside, 0.25, 0.8, W)).toBe('start');
  });

  it('the CLOSER handle wins when start and end are near each other', () => {
    const W = 220;
    // Both within the radius of the probe; 'start' is nearer.
    expect(twotracksHandleHit(0.5, 0.5, 0.52, W)).toBe('start');
    expect(twotracksHandleHit(0.52, 0.5, 0.52, W)).toBe('end');
  });
});

describe('twotracksPosToFrac — the END handle must be reachable', () => {
  // ⚠ A REGRESSION LEG WITH A REAL DEFECT BEHIND IT. `end` defaults to exactly
  // 1, so if the conversion divides by the drawing-buffer width while the
  // pointer reports CSS pixels against a narrower displayed width, the largest
  // fraction a click can produce is < 1 and the END marker can never be grabbed.
  it('a click at the far right edge of the DISPLAYED width yields exactly 1', () => {
    expect(twotracksPosToFrac(215, 215)).toBe(1);
    expect(twotracksHandleHit(twotracksPosToFrac(215, 215), 0, 1, 215)).toBe('end');
  });

  it('clamps outside the canvas rather than returning an out-of-range fraction', () => {
    expect(twotracksPosToFrac(-40, 215)).toBe(0);
    expect(twotracksPosToFrac(999, 215)).toBe(1);
  });

  it('a zero displayed width does not divide by zero', () => {
    expect(Number.isFinite(twotracksPosToFrac(10, 0))).toBe(true);
  });
});

describe('twotracksHasTape — one predicate, both branches', () => {
  it('blank reel, recorded reel, and the two half-states', () => {
    expect(twotracksHasTape({ peaks: null, bufLen: 0 })).toBe(false);
    expect(twotracksHasTape({ peaks: new Float32Array(4), bufLen: 0 })).toBe(false);
    expect(twotracksHasTape({ peaks: null, bufLen: 48_000 })).toBe(false);
    expect(twotracksHasTape({ peaks: new Float32Array(4), bufLen: 48_000 })).toBe(true);
  });
});

describe('drawTwotracksReel — the empty tape is DRAWN, not blank', () => {
  it('a fresh reel paints the empty-tape text and NO playhead', () => {
    const { el, texts, strokeColors } = recordingCanvas(220, 60);
    drawTwotracksReel(el, view());
    expect(texts.map((t) => t.text)).toContain(TWOTRACKS_EMPTY_TAPE_TEXT);
    // Both loop handles still stroke (they stay grabbable on a blank reel — you
    // set a window before recording into it), but the playhead does not: a
    // cursor on a tape that does not exist would be a position with no referent.
    expect(strokeColors.filter((c) => c.includes('80, 160, 255'))).toHaveLength(0);
    expect(strokeColors.length).toBeGreaterThan(0);
  });

  it('POSITIVE CONTROL: a recorded reel paints a playhead and NO empty text', () => {
    const { el, texts, strokeColors } = recordingCanvas(220, 60);
    drawTwotracksReel(el, tape({ playheadFrac: 0.5 }));
    expect(texts.map((t) => t.text)).not.toContain(TWOTRACKS_EMPTY_TAPE_TEXT);
    expect(strokeColors.filter((c) => c.includes('80, 160, 255')).length).toBeGreaterThan(0);
  });

  it('the out-of-loop wash appears only when there IS tape', () => {
    const blank = recordingCanvas(220, 60);
    drawTwotracksReel(blank.el, view({ startFrac: 0.25, endFrac: 0.75 }));
    // Background fill only — no dimming rectangles over a blank reel.
    const blankWashes = blank.fillRects.filter((r) => r.w !== 220 && r.h === 60);
    expect(blankWashes).toHaveLength(0);

    const withTape = recordingCanvas(220, 60);
    drawTwotracksReel(withTape.el, tape({ startFrac: 0.25, endFrac: 0.75 }));
    const washes = withTape.fillRects.filter((r) => r.w !== 220 && r.h === 60);
    // One wash left of START, one right of END.
    expect(washes).toHaveLength(2);
  });

  it('a null canvas is a no-op rather than a throw', () => {
    expect(() => drawTwotracksReel(null, view())).not.toThrow();
  });
});
