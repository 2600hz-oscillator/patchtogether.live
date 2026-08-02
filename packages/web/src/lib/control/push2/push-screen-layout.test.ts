// packages/web/src/lib/control/push2/push-screen-layout.test.ts
//
// The 960×160 layout, asserted as DRAW OPS — no canvas, no browser.
//
// The tests that matter here are the BAR ones. A bar is the only part of the
// card that can be confidently wrong: a label is either the right string or an
// obviously wrong one, but a bar drawn from the wrong 0..1 looks perfectly
// plausible at every value. So each bar assertion is written so that a
// PERTURBATION OF THE INPUT MUST MOVE A PIXEL — the negative-control discipline
// applied to the instrument, not just to the code.
import { describe, it, expect } from 'vitest';

import type { PushCardView, PushStripView } from './push-card-model';
import { emptyStrip, pushStrip } from './push-card-model';
import type { ParamDef } from '$lib/graph/types';
import {
  renderPushCard,
  renderHeader,
  barFillSpan,
  cellRects,
  truncateToWidth,
  pushCardSignature,
  stripX,
  stripCenterX,
  trackX0,
  PUSH_SCREEN_W,
  PUSH_SCREEN_H,
  STRIP_COUNT,
  STRIP_W,
  STRIP_CONTENT_W,
  STRIP_PAD_X,
  TRACK_W,
  BAR_Y,
  BAR_H,
  BODY_Y,
  FLAG_Y,
  FLAG_H,
  COL_FILL,
  COL_ZERO_MARK,
  COL_CELL_OFF,
  COL_DIVIDER,
  EMPTY_MESSAGES,
  type PushDrawOp,
  type PushRectOp,
  type PushTextOp,
} from './push-screen-layout';

// ── fixtures ───────────────────────────────────────────────────────────────

function param(over: Partial<ParamDef> = {}): ParamDef {
  return { id: 'p', label: 'param', defaultValue: 0, min: 0, max: 1, curve: 'linear', ...over };
}

function view(over: Partial<PushCardView> = {}): PushCardView {
  return {
    moduleType: 'tidyVco',
    domain: 'audio',
    source: 'face',
    title: 'my vco',
    subtitle: 'voices',
    lane: 3,
    laneHex: '#ff0000',
    index: 2,
    count: 4,
    strips: Array.from({ length: STRIP_COUNT }, (_, i) => emptyStrip(i + 1)),
    empty: null,
    ...over,
  };
}

const rects = (ops: readonly PushDrawOp[]): PushRectOp[] =>
  ops.filter((o): o is PushRectOp => o.op === 'rect');
const texts = (ops: readonly PushDrawOp[]): PushTextOp[] =>
  ops.filter((o): o is PushTextOp => o.op === 'text');
/** The FILL rect of strip i's bar (the one drawn in the fill colour). */
const fillOf = (ops: readonly PushDrawOp[], i: number): PushRectOp | undefined =>
  rects(ops).find(
    (r) => r.fill === COL_FILL && r.x >= stripX(i) && r.x < stripX(i) + STRIP_W && r.y > BAR_Y,
  );

function withStrip(strip: PushStripView, i = 0): PushDrawOp[] {
  const strips = Array.from({ length: STRIP_COUNT }, (_, k) => emptyStrip(k + 1));
  strips[i] = { ...strip, encoder: i + 1 };
  return renderPushCard(view({ strips }));
}

// ── geometry ───────────────────────────────────────────────────────────────

describe('geometry — exact integers on the 960×160 grid', () => {
  it('the 8 strips tile the panel EXACTLY, with no drift at the right edge', () => {
    expect(STRIP_W).toBe(120);
    expect(stripX(0)).toBe(0);
    expect(stripX(STRIP_COUNT - 1) + STRIP_W).toBe(PUSH_SCREEN_W);
    for (let i = 0; i < STRIP_COUNT; i++) {
      expect(Number.isInteger(stripX(i)), `strip ${i} lands on a whole pixel`).toBe(true);
      expect(stripCenterX(i)).toBe(stripX(i) + 60);
      expect(trackX0(i)).toBe(stripX(i) + STRIP_PAD_X + 1);
    }
  });

  it('the bar track interior is 102 px inside a 104 px content box', () => {
    expect(STRIP_CONTENT_W).toBe(104);
    expect(TRACK_W).toBe(102);
  });

  it('nothing is drawn outside the panel', () => {
    const strips = Array.from({ length: STRIP_COUNT }, (_, i) =>
      pushStrip(param({ id: `p${i}`, label: `p${i}` }), 1, i + 1),
    );
    for (const r of rects(renderPushCard(view({ strips })))) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w, `rect at ${r.x} stays on-panel`).toBeLessThanOrEqual(PUSH_SCREEN_W);
      expect(r.y + r.h, `rect at ${r.y} stays on-panel`).toBeLessThanOrEqual(PUSH_SCREEN_H);
    }
    // The bottom band leaves a margin rather than bleeding off the edge.
    expect(FLAG_Y + FLAG_H).toBeLessThan(PUSH_SCREEN_H);
  });

  it('draws 7 dividers, one between each pair of strips, below the header', () => {
    const divs = rects(renderPushCard(view())).filter((r) => r.fill === COL_DIVIDER);
    expect(divs).toHaveLength(STRIP_COUNT - 1);
    expect(divs.map((d) => d.x)).toEqual([120, 240, 360, 480, 600, 720, 840]);
    for (const d of divs) expect(d.y).toBe(BODY_Y);
  });
});

// ── the bar ────────────────────────────────────────────────────────────────

describe('the bar — 0..1 to pixels, and it must not lie', () => {
  it('a UNIPOLAR bar grows from the LEFT edge of the track', () => {
    const s = pushStrip(param(), 0.5, 1);
    const span = barFillSpan(s, trackX0(0));
    expect(span.x).toBe(trackX0(0));
    expect(span.w).toBe(51); // half of 102
  });

  it('CURVE NEGATIVE CONTROL: the same value on a LOG param draws elsewhere', () => {
    // `filter.cutoff` is log 20..20000. Its geometric midpoint (632 Hz) must sit
    // at ~50 % of the bar; a linear map would put it at 3 %. If the layout (or
    // the model) ignored the curve, these two spans would be identical — the
    // assertion is on the DIFFERENCE, so a curve-blind implementation fails.
    const lin = param({ min: 20, max: 20000, curve: 'linear' });
    const log = param({ min: 20, max: 20000, curve: 'log' });
    const wLin = barFillSpan(pushStrip(lin, 632, 1), trackX0(0)).w;
    const wLog = barFillSpan(pushStrip(log, 632, 1), trackX0(0)).w;
    expect(wLin, 'linear draws 632 Hz near the left edge').toBeLessThan(6);
    expect(wLog, 'log draws it near the middle').toBeGreaterThan(45);
    expect(wLog).toBeLessThan(57);
    expect(wLog).not.toBe(wLin);
  });

  it('BIPOLAR NEGATIVE CONTROL: the bar ORIGIN moves when the range changes sign', () => {
    // An attenuverter at rest must draw NOTHING, not a half-full bar. The proof
    // is that the fill ORIGIN differs between the two ranges — a
    // left-edge-anchored implementation would give the same x for both.
    const uni = pushStrip(param({ min: 0, max: 1 }), 0.5, 1);
    const bip = pushStrip(param({ min: -1, max: 1 }), 0.5, 1);
    const x0 = trackX0(0);
    expect(barFillSpan(uni, x0).x).toBe(x0);
    expect(barFillSpan(bip, x0).x).toBe(x0 + 51); // grows RIGHT out of centre
    expect(barFillSpan(bip, x0).x).not.toBe(barFillSpan(uni, x0).x);
  });

  it('a bipolar param AT REST draws a zero-width fill, and a NEGATIVE value grows LEFT', () => {
    const p = param({ min: -1, max: 1 });
    const x0 = trackX0(0);
    expect(barFillSpan(pushStrip(p, 0, 1), x0).w, 'at rest = empty, not half-full').toBe(0);
    const neg = barFillSpan(pushStrip(p, -0.5, 1), x0);
    expect(neg.x).toBeLessThan(x0 + 51);
    expect(neg.x + neg.w).toBe(x0 + 51); // ends AT the zero anchor
  });

  it('the smallest possible deflection still shows ONE pixel', () => {
    // 0.001 of 102 px rounds to 0. Without the 1px floor the first detent of a
    // turn would be invisible and the encoder would feel dead.
    const span = barFillSpan(pushStrip(param(), 0.001, 1), trackX0(0));
    expect(span.w).toBe(1);
  });

  it('a bipolar strip draws its ZERO MARK, a unipolar one does not', () => {
    const bip = withStrip(pushStrip(param({ min: -1, max: 1 }), 0, 1));
    const uni = withStrip(pushStrip(param({ min: 0, max: 1 }), 0, 1));
    const mark = rects(bip).find((r) => r.fill === COL_ZERO_MARK);
    expect(mark, 'the centre anchor is visible at rest').toBeTruthy();
    expect(mark!.x).toBe(trackX0(0) + 51);
    expect(mark!.w).toBe(1);
    expect(rects(uni).some((r) => r.fill === COL_ZERO_MARK)).toBe(false);
  });
});

// ── cells ──────────────────────────────────────────────────────────────────

describe('cells — a discrete param is states, not a sweep', () => {
  it('cellRects tile the track with 1px gaps and never overflow', () => {
    for (const n of [2, 3, 5, 8, 16]) {
      const cs = cellRects(n, trackX0(0));
      expect(cs).toHaveLength(n);
      expect(cs[0].x).toBe(trackX0(0));
      const last = cs[n - 1];
      expect(last.x + last.w).toBeLessThanOrEqual(trackX0(0) + TRACK_W);
      for (const c of cs) expect(c.w).toBeGreaterThan(0);
    }
  });

  it("a 3-state 'select' param lights ONE cell — the one the readout names", () => {
    const p = param({
      curve: 'discrete',
      min: 0,
      max: 2,
      options: [
        { value: 0, label: 'lp' },
        { value: 1, label: 'bp' },
        { value: 2, label: 'hp' },
      ],
    });
    const ops = withStrip(pushStrip(p, 1, 1));
    const lit = rects(ops).filter((r) => r.fill === COL_FILL && r.y > BAR_Y);
    const off = rects(ops).filter((r) => r.fill === COL_CELL_OFF);
    expect(lit, 'exactly one lit cell — "2 of 3 filled" would read as a quantity').toHaveLength(1);
    expect(off).toHaveLength(2);
    expect(lit[0].x).toBe(cellRects(3, trackX0(0))[1].x);
    expect(texts(ops).some((t) => t.text === 'bp')).toBe(true);
  });

  it("a 'fill' quantity lights every cell up to the index", () => {
    const p = param({ curve: 'discrete', min: 0, max: 7 }); // dx7 feedback
    const ops = withStrip(pushStrip(p, 3, 1));
    expect(rects(ops).filter((r) => r.fill === COL_FILL && r.y > BAR_Y)).toHaveLength(4); // 0..3
  });

  it('a wide discrete param falls back to a CONTINUOUS fill (32 cells are 3px)', () => {
    const p = param({ curve: 'discrete', min: 1, max: 32 }); // dx7 algorithm
    const ops = withStrip(pushStrip(p, 16, 1));
    expect(rects(ops).filter((r) => r.fill === COL_CELL_OFF)).toHaveLength(0);
    expect(fillOf(ops, 0), 'one continuous fill instead').toBeTruthy();
  });
});

// ── header, empties, text ──────────────────────────────────────────────────

describe('the header', () => {
  it('carries the lane swatch, "CH n", the title, the category and i/N', () => {
    const ops = renderHeader(view());
    const swatch = rects(ops)[0];
    expect(swatch).toMatchObject({ x: 0, y: 0, w: 4, h: 24, fill: '#ff0000' });
    const t = texts(ops).map((o) => o.text);
    expect(t).toContain('CH 3');
    expect(t).toContain('my vco');
    expect(t).toContain('voices');
    expect(t).toContain('2/4');
    // "CH n" is tinted with the lane hue so it matches the lit Push button.
    expect(texts(ops).find((o) => o.text === 'CH 3')!.fill).toBe('#ff0000');
  });

  it('a lane-less card still says so rather than printing "CH null"', () => {
    const t = texts(renderHeader(view({ lane: null, laneHex: null }))).map((o) => o.text);
    expect(t).toContain('CH —');
  });
});

describe('empty states', () => {
  for (const reason of ['no-lane', 'no-modules', 'no-controls'] as const) {
    it(`"${reason}" draws the header plus ONE sentence and no strips`, () => {
      const ops = renderPushCard(view({ empty: reason, strips: [] }));
      expect(texts(ops).map((o) => o.text)).toContain(
        truncateToWidth(EMPTY_MESSAGES[reason], 16, PUSH_SCREEN_W - 48),
      );
      expect(rects(ops).some((r) => r.fill === COL_DIVIDER), 'no strip dividers').toBe(false);
      expect(texts(ops).map((o) => o.text)).toContain('CH 3'); // you still know where you are
    });
  }

  it('a BLANK slot draws its encoder number and a hollow track — never a zero bar', () => {
    const ops = withStrip(emptyStrip(1));
    expect(fillOf(ops, 0), 'a blank strip must not draw a fill').toBeUndefined();
    // The number is drawn for every encoder, so a dead knob is identifiable.
    const nums = texts(ops).filter((t) => /^[1-8]$/.test(t.text));
    expect(nums).toHaveLength(STRIP_COUNT);
  });
});

describe('truncateToWidth', () => {
  it('leaves short text alone and ellipsizes long text', () => {
    expect(truncateToWidth('cutoff', 11, 104)).toBe('cutoff');
    const long = truncateToWidth('a-very-long-module-name-indeed', 11, 104);
    expect(long.endsWith('…')).toBe(true);
    expect(long.length).toBeLessThan('a-very-long-module-name-indeed'.length);
  });
  it('a bigger font gets a smaller character budget', () => {
    expect(truncateToWidth('abcdefghij', 30, 104).length).toBeLessThan(
      truncateToWidth('abcdefghij', 10, 104).length,
    );
  });
});

describe('pushCardSignature — the repaint dirty check', () => {
  it('is stable for an identical card', () => {
    expect(pushCardSignature(renderPushCard(view()))).toBe(pushCardSignature(renderPushCard(view())));
  });

  it('CHANGES for every input that changes a pixel', () => {
    const base = pushCardSignature(renderPushCard(view()));
    const moved = pushCardSignature(
      renderPushCard(view({ strips: [pushStrip(param(), 0.5, 1)] })),
    );
    expect(moved).not.toBe(base);
    // A one-pixel value move must also register, or a slow twist would freeze
    // the panel at its first frame.
    const a = pushCardSignature(renderPushCard(view({ strips: [pushStrip(param(), 0.5, 1)] })));
    const b = pushCardSignature(renderPushCard(view({ strips: [pushStrip(param(), 0.51, 1)] })));
    expect(b).not.toBe(a);
    expect(pushCardSignature(renderPushCard(view({ title: 'other' })))).not.toBe(base);
    expect(pushCardSignature(renderPushCard(view({ lane: 4 })))).not.toBe(base);
    expect(pushCardSignature(renderPushCard(view({ index: 3 })))).not.toBe(base);
  });
});
