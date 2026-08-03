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
  renderPushLegend,
  renderPushElectra,
  renderStrip,
  ELECTRA_PANEL_STRIP,
  ELECTRA_PANEL_X,
  ELECTRA_PANEL_W,
  ELECTRA_SEL_Y,
  wrapToWidth,
  legendLabelY,
  LEGEND_BANNER_H,
  LEGEND_ROW_H,
  LEGEND_ROW_B_Y,
  LEGEND_LABEL_LINE_H,
  LEGEND_UNBOUND_MARK,
  COL_LEGEND_SHIFT,
  COL_LEGEND_UNBOUND,
  type PushDrawOp,
  type PushRectOp,
  type PushTextOp,
} from './push-screen-layout';
import { pushLegendView } from './push-legend-model';
import type { PushElectraView } from './push-electra-model';
import type { LaunchpadLegendContext } from '$lib/control/launchpad/launchpad-control.svelte';

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

// ---------------------------------------------------------------------------
// LEGEND MODE — the held overlay. Same op vocabulary, so the same "assert the
// geometry, not the pixels" discipline applies. The load-bearing claim here is
// SPATIAL: the bottom row of cells must sit over the physical buttons under the
// display, and every cell must line up with exactly one 120 px slice.
// ---------------------------------------------------------------------------

function lctx(over: Partial<LaunchpadLegendContext> = {}): LaunchpadLegendContext {
  return {
    deployment: 'single',
    view: 'clip',
    mode: 'session',
    shift: false,
    gridHeld: false,
    sceneScrollOffset: 0,
    bound: true,
    ...over,
  };
}

describe('renderPushLegend — geometry', () => {
  it('fills the panel and splits it into a banner + two equal rows', () => {
    const ops = renderPushLegend(pushLegendView(lctx()));
    expect(ops[0]).toMatchObject({ op: 'rect', x: 0, y: 0, w: PUSH_SCREEN_W, h: PUSH_SCREEN_H });
    // The two rows are the SAME height and, with the banner + 2 rules, account
    // for every one of the 160 lines — no drift at the bottom edge.
    expect(LEGEND_ROW_H).toBe(70);
    expect(LEGEND_BANNER_H + 1 + LEGEND_ROW_H + 1 + LEGEND_ROW_H).toBe(PUSH_SCREEN_H);
    expect(LEGEND_ROW_B_Y + LEGEND_ROW_H).toBe(PUSH_SCREEN_H);
  });

  it('the BOTTOM row is the FUNCTION row — it must sit over the buttons it names', () => {
    // This is the whole spatial argument: cell i of the bottom row is directly
    // above physical function button i. Swap the rows and the legend becomes
    // actively misleading, so it is asserted rather than assumed.
    const v = pushLegendView(lctx({ view: 'clip' }));
    const ops = renderPushLegend(v);
    const inRowB = texts(ops).filter((t) => t.y >= LEGEND_ROW_B_Y);
    for (const label of v.function.cells.map((c) => c.label)) {
      if (!label) continue;
      expect(inRowB.some((t) => t.text === label), `${label} not in the bottom row`).toBe(true);
    }
    // …and a SCENE-row label is not down there.
    expect(inRowB.some((t) => t.text === 'PITCH +1')).toBe(false);
  });

  it('every cell is centred on its own 120 px slice', () => {
    const ops = renderPushLegend(pushLegendView(lctx({ view: 'control' })));
    for (let i = 0; i < STRIP_COUNT; i++) {
      const cx = stripCenterX(i);
      expect(texts(ops).some((t) => t.x === cx && t.text === `STOP L${8 - i}`)).toBe(true);
    }
    expect(stripX(STRIP_COUNT - 1) + STRIP_W).toBe(PUSH_SCREEN_W); // 8 × 120 = 960 exactly
  });

  it('an UNBOUND cell draws a DASH — "does nothing here" is an answer, not a gap', () => {
    const ops = renderPushLegend(pushLegendView(lctx({ view: 'arranger' })));
    const dashes = texts(ops).filter((t) => t.text === LEGEND_UNBOUND_MARK);
    expect(dashes).toHaveLength(8); // the arranger's 8 inert scene buttons
    expect(dashes.every((d) => d.fill === COL_LEGEND_UNBOUND)).toBe(true);
  });

  it('the SHIFT layer is visibly different — chrome AND content', () => {
    const base = renderPushLegend(pushLegendView(lctx({ view: 'clip' })));
    const shifted = renderPushLegend(pushLegendView(lctx({ view: 'clip', shift: true })));
    expect(texts(base).some((t) => t.text === 'SHIFT' && t.fill === COL_LEGEND_SHIFT)).toBe(false);
    expect(texts(shifted).some((t) => t.text === 'SHIFT' && t.fill === COL_LEGEND_SHIFT)).toBe(true);
    expect(texts(shifted).some((t) => t.text === 'PITCH +8')).toBe(true);
    expect(texts(base).some((t) => t.text === 'PITCH +8')).toBe(false);
  });

  it('every shipped legend fits its cell without ellipsis', () => {
    // LEGIBILITY asserted rather than eyeballed: a label that had to be cut
    // would print '…' and stop being documentation.
    for (const c of [
      lctx({ view: 'grid' }),
      lctx({ view: 'grid', shift: true }),
      lctx({ view: 'clip' }),
      lctx({ view: 'clip', shift: true }),
      lctx({ view: 'control' }),
      lctx({ mode: 'keys' }),
      lctx({ mode: 'keys', shift: true }),
      lctx({ shift: true }),
    ]) {
      for (const t of texts(renderPushLegend(pushLegendView(c)))) {
        expect(t.text.includes('…'), `"${t.text}" was truncated`).toBe(false);
      }
    }
  });

  it('the "nothing bound" note REPLACES the function caption — no overlap', () => {
    const bound = texts(renderPushLegend(pushLegendView(lctx({ bound: true }))));
    const unbound = texts(renderPushLegend(pushLegendView(lctx({ bound: false }))));
    const captionAt = (ts: typeof bound) => ts.filter((t) => t.y < LEGEND_BANNER_H && t.x === 520);
    expect(captionAt(bound)).toHaveLength(1);
    expect(captionAt(bound)[0].text).toMatch(/FUNCTION ROW/);
    // Exactly ONE run in that slot either way — two would be drawn on top of
    // each other and read as a smear on a 160 px panel.
    expect(captionAt(unbound)).toHaveLength(1);
    expect(captionAt(unbound)[0].text).toMatch(/no clip player bound/);
  });

  it('a two-line label stacks by the line height and stays inside its row', () => {
    const y0 = legendLabelY(LEGEND_ROW_B_Y, 2, 0);
    const y1 = legendLabelY(LEGEND_ROW_B_Y, 2, 1);
    expect(y1 - y0).toBe(LEGEND_LABEL_LINE_H);
    expect(y0).toBeGreaterThan(LEGEND_ROW_B_Y);
    expect(y1).toBeLessThan(LEGEND_ROW_B_Y + LEGEND_ROW_H);
  });

  it('the signature CHANGES between card and legend, and between layers', () => {
    // This is what makes "release restores the previous display" cost exactly
    // one frame: the dirty check sees a different image, so it repaints once.
    const card = pushCardSignature(renderPushCard(view()));
    const legend = pushCardSignature(renderPushLegend(pushLegendView(lctx())));
    const shifted = pushCardSignature(renderPushLegend(pushLegendView(lctx({ shift: true }))));
    expect(legend).not.toBe(card);
    expect(shifted).not.toBe(legend);
    // …and re-deriving the same state is byte-identical, so a static legend
    // costs one string compare per tick exactly like the card.
    expect(pushCardSignature(renderPushLegend(pushLegendView(lctx())))).toBe(legend);
  });
});

describe('wrapToWidth', () => {
  it('keeps a short label on one line', () => {
    expect(wrapToWidth('COPY', 15, 108, 2)).toEqual(['COPY']);
  });
  it('breaks on spaces into at most maxLines', () => {
    // 60 px at 15 px ⇒ a 6-character budget: 'ARP' fits, 'ARP UP-DN' does not.
    expect(wrapToWidth('ARP UP-DN', 15, 60, 2)).toEqual(['ARP', 'UP-DN']);
    expect(wrapToWidth('ARM LANE 1', 15, 80, 2)).toEqual(['ARM LANE', '1']);
  });
  it('truncates the last line instead of dropping words', () => {
    const out = wrapToWidth('one two three four five six', 15, 40, 2);
    expect(out).toHaveLength(2);
    expect(out[1].endsWith('…')).toBe(true);
  });
  it('hard-cuts a single word wider than the line', () => {
    const out = wrapToWidth('supercalifragilistic', 15, 40, 2);
    expect(out).toHaveLength(1);
    expect(out[0].endsWith('…')).toBe(true);
  });
  it('is empty for empty input or a zero-width box', () => {
    expect(wrapToWidth('', 15, 108, 2)).toEqual([]);
    expect(wrapToWidth('X', 15, 0, 2)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ELECTRA CONTROL MODE — the third display mode's geometry.
//
// The claim worth gating is that it REUSES the card's machinery rather than
// re-implementing it: six strips drawn by the same `renderStrip`, on the same
// exact-integer 960/8 grid, so encoder n's strip sits over encoder n in both
// modes. A second strip renderer would be a second chance for the bar to lie.
// ---------------------------------------------------------------------------

describe('renderPushElectra', () => {
  const knob: ParamDef = {
    id: 'cutoff', label: 'Cutoff', min: 20, max: 20000, defaultValue: 1000, curve: 'log', units: 'Hz',
  };

  function view(over: Partial<PushElectraView> = {}): PushElectraView {
    return {
      surfaceName: 'my surface',
      row: 3,
      rowCount: 6,
      bank: 'MID',
      strips: Array.from({ length: 6 }, (_, i) => (i === 0 ? pushStrip(knob, 1000, 1) : emptyStrip(i + 1))),
      empty: null,
      ...over,
    };
  }
  const textsOf = (ops: PushDrawOp[]) =>
    ops.filter((o): o is PushDrawOp & { op: 'text' } => o.op === 'text').map((o) => o.text);

  it('draws SIX strips through the SAME renderStrip the card uses', () => {
    const ops = renderPushElectra(view());
    // Op-for-op: strip 0's ops are exactly what the card would emit for it.
    const mine = renderStrip(pushStrip(knob, 1000, 1), 0);
    for (const op of mine) expect(ops).toContainEqual(op);
  });

  it('the strips occupy encoders 1-6 and the PANEL starts exactly at encoder 7', () => {
    expect(ELECTRA_PANEL_STRIP).toBe(6);
    expect(ELECTRA_PANEL_X).toBe(stripX(6));
    expect(ELECTRA_PANEL_X).toBe(720);
    expect(ELECTRA_PANEL_W).toBe(240);
    expect(ELECTRA_PANEL_X + ELECTRA_PANEL_W).toBe(PUSH_SCREEN_W); // no gap at the edge
  });

  it('the ROW panel says ROW, the number, and numbers the two INERT encoders', () => {
    const t = textsOf(renderPushElectra(view({ row: 4 })));
    expect(t).toContain('ROW');
    expect(t).toContain('4');
    // The physical encoders are still there, so a numbered blank says "this
    // knob does nothing here" rather than leaving the eye to guess.
    expect(t).toContain('7');
    expect(t).toContain('8');
  });

  it('the row SELECTOR lights exactly one cell — a mode, not a quantity', () => {
    const ops = renderPushElectra(view({ row: 2 }));
    const sel = ops.filter((o) => o.op === 'rect' && o.y === ELECTRA_SEL_Y) as PushRectOp[];
    expect(sel).toHaveLength(6);
    const lit = sel.filter((r) => r.fill === COL_FILL);
    expect(lit).toHaveLength(1);
    expect(sel.indexOf(lit[0])).toBe(1); // 0-based cell for row 2
    // …and the selector spans the panel, inset, without leaving the panel.
    expect(sel[0].x).toBeGreaterThanOrEqual(ELECTRA_PANEL_X);
    expect(sel[5].x + sel[5].w).toBeLessThanOrEqual(ELECTRA_PANEL_X + ELECTRA_PANEL_W);
  });

  it('the selector MOVES with the row — negative control for the cell above', () => {
    const litIndex = (row: number) => {
      const sel = renderPushElectra(view({ row })).filter(
        (o) => o.op === 'rect' && o.y === ELECTRA_SEL_Y,
      ) as PushRectOp[];
      return sel.findIndex((r) => r.fill === COL_FILL);
    };
    expect([1, 2, 3, 4, 5, 6].map(litIndex)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('the header names the mode, the surface, the bank and the row counter', () => {
    const t = textsOf(renderPushElectra(view({ row: 5, bank: 'BOT' })));
    expect(t).toContain('ELECTRA');
    expect(t).toContain('my surface');
    expect(t).toContain('BANK BOT');
    expect(t).toContain('5/6');
  });

  it('the empty state says WHY, and still shows the header', () => {
    const ops = renderPushElectra(view({ empty: 'no-surface', surfaceName: '' }));
    const t = textsOf(ops);
    expect(t.join(' ')).toContain('no ELECTRA CONTROL in this rack');
    expect(t).toContain('ELECTRA'); // you still know which mode you are in
    // …and it draws no strips at all.
    expect(ops.filter((o) => o.op === 'rect' && o.y === ELECTRA_SEL_Y)).toHaveLength(0);
  });

  it('every op is inside the 960×160 panel', () => {
    for (const row of [1, 6]) {
      for (const op of renderPushElectra(view({ row }))) {
        if (op.op !== 'rect') continue;
        expect(op.x).toBeGreaterThanOrEqual(0);
        expect(op.y).toBeGreaterThanOrEqual(0);
        expect(op.x + op.w).toBeLessThanOrEqual(PUSH_SCREEN_W);
        expect(op.y + op.h).toBeLessThanOrEqual(PUSH_SCREEN_H);
      }
    }
  });

  it('the signature moves when the ROW moves — the dirty check can see it', () => {
    // The display pump repaints only on a signature change, so a mode whose
    // only visible change did not reach the signature would never redraw.
    const a = pushCardSignature(renderPushElectra(view({ row: 1 })));
    const b = pushCardSignature(renderPushElectra(view({ row: 2 })));
    expect(a).not.toBe(b);
  });

  it('cellRects rounds identically at any track width — one rounding rule', () => {
    // The selector reuses the card's cell math with a wider track. If it had
    // its own, the two cell rows could drift apart at the right-hand edge.
    const wide = cellRects(6, 0, 188);
    expect(wide[5].x + wide[5].w).toBeLessThanOrEqual(188);
    expect(cellRects(3, 0)).toEqual(cellRects(3, 0, TRACK_W)); // default is TRACK_W
  });
});
