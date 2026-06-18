// packages/web/src/lib/video/modules/textmarquee-layout.test.ts
//
// Pure-helper coverage for TEXTMARQUEE: the rich-text model coercion, line
// layout/metrics, and the CV-calibrated position/scroll math. No WebGL2, no
// real <canvas> — a synthetic monospace measure (1 px per char) makes the
// layout math deterministic.

import { describe, it, expect } from 'vitest';
import {
  type RichTextModel,
  type RichRun,
  emptyRichTextModel,
  coerceRichTextModel,
  normalizeHex,
  modelPlainText,
  layoutModel,
  lineAlignOffset,
  posToDrawX,
  posToDrawY,
  scrollOffset,
  computeDrawOffset,
  MAX_SCREENS_PER_SEC,
} from './textmarquee-layout';

// Deterministic measure: every char is 1px wide, bold doubles it (so style
// influence is observable). Lets the layout asserts use exact integers.
const measure = (text: string, run: RichRun): number =>
  text.length * (run.bold ? 2 : 1);

describe('rich-text model', () => {
  it('emptyRichTextModel is a valid white-on-black single paragraph', () => {
    const m = emptyRichTextModel();
    expect(m.fg).toBe('#ffffff');
    expect(m.bg).toBe('#000000');
    expect(m.paragraphs).toHaveLength(1);
    expect(m.paragraphs[0]!.align).toBe('left');
    expect(modelPlainText(m)).toBe('');
  });

  it('normalizeHex accepts 6-digit hex (lowercased) and falls back otherwise', () => {
    expect(normalizeHex('#AABBCC', '#000000')).toBe('#aabbcc');
    expect(normalizeHex('#abc', '#000000')).toBe('#000000'); // 3-digit rejected
    expect(normalizeHex('red', '#111111')).toBe('#111111');
    expect(normalizeHex(42, '#222222')).toBe('#222222');
  });

  it('coerceRichTextModel drops malformed runs/paragraphs but keeps valid ones', () => {
    const dirty = {
      fg: '#FF0000',
      bg: 'not-a-hex',
      paragraphs: [
        { align: 'center', runs: [{ text: 'hi', bold: true }, { text: 5 }, { nope: 1 }] },
        { align: 'wat', runs: [] }, // bad align → left; empty runs → one empty run
        'garbage',
      ],
    };
    const m = coerceRichTextModel(dirty);
    expect(m.fg).toBe('#ff0000');
    expect(m.bg).toBe('#000000'); // invalid bg → default
    expect(m.paragraphs).toHaveLength(2);
    expect(m.paragraphs[0]!.align).toBe('center');
    expect(m.paragraphs[0]!.runs).toEqual([{ text: 'hi', bold: true }]);
    expect(m.paragraphs[1]!.align).toBe('left');
    expect(m.paragraphs[1]!.runs).toEqual([{ text: '' }]);
  });

  it('coerceRichTextModel returns the empty model for non-objects', () => {
    expect(coerceRichTextModel(null)).toEqual(emptyRichTextModel());
    expect(coerceRichTextModel('x')).toEqual(emptyRichTextModel());
    expect(coerceRichTextModel({ paragraphs: [] })).toEqual(emptyRichTextModel());
  });

  it('modelPlainText joins runs in a paragraph + paragraphs by newline', () => {
    const m: RichTextModel = {
      fg: '#fff',
      bg: '#000',
      paragraphs: [
        { align: 'left', runs: [{ text: 'foo' }, { text: 'bar' }] },
        { align: 'left', runs: [{ text: 'baz' }] },
      ],
    };
    // fg/bg here are short — modelPlainText doesn't care, only text matters.
    expect(modelPlainText(m)).toBe('foobar\nbaz');
  });
});

describe('layout', () => {
  it('lays a single line of two runs with cumulative x + summed width', () => {
    const m: RichTextModel = {
      fg: '#fff', bg: '#000',
      paragraphs: [{ align: 'left', runs: [{ text: 'abc' }, { text: 'de', bold: true }] }],
    };
    const r = layoutModel(m, measure, 10);
    expect(r.lines).toHaveLength(1);
    const line = r.lines[0]!;
    expect(line.runs).toHaveLength(2);
    expect(line.runs[0]!).toMatchObject({ text: 'abc', width: 3, x: 0 });
    expect(line.runs[1]!).toMatchObject({ text: 'de', width: 4, x: 3 }); // bold → 2px/char
    expect(line.width).toBe(7);
    expect(r.width).toBe(7);
    expect(r.height).toBe(10); // 1 line * lineHeight
    expect(r.lineHeight).toBe(10);
  });

  it('splits a run on embedded newlines into multiple lines', () => {
    const m: RichTextModel = {
      fg: '#fff', bg: '#000',
      paragraphs: [{ align: 'left', runs: [{ text: 'aa\nbbb\nc' }] }],
    };
    const r = layoutModel(m, measure, 12);
    expect(r.lines.map((l) => l.width)).toEqual([2, 3, 1]);
    expect(r.width).toBe(3);
    expect(r.height).toBe(36); // 3 lines * 12
  });

  it('separates paragraphs onto their own lines and preserves per-paragraph align', () => {
    const m: RichTextModel = {
      fg: '#fff', bg: '#000',
      paragraphs: [
        { align: 'left', runs: [{ text: 'left' }] },
        { align: 'center', runs: [{ text: 'middle' }] },
        { align: 'right', runs: [{ text: 'rt' }] },
      ],
    };
    const r = layoutModel(m, measure, 10);
    expect(r.lines).toHaveLength(3);
    expect(r.lines.map((l) => l.align)).toEqual(['left', 'center', 'right']);
    expect(r.width).toBe(6); // "middle" is widest
  });

  it('lineAlignOffset positions left/center/right within the block', () => {
    expect(lineAlignOffset(40, 100, 'left')).toBe(0);
    expect(lineAlignOffset(40, 100, 'center')).toBe(30);
    expect(lineAlignOffset(40, 100, 'right')).toBe(60);
  });
});

describe('position math — FULL-RANGE CV calibration', () => {
  const W = 1024;
  const H = 768;
  const textW = 300;
  const textH = 60;

  it('posX=0 places the block FULLY OFF the LEFT (right edge at x=0)', () => {
    const x = posToDrawX(0, textW, W);
    expect(x).toBe(-textW); // left edge at -textW → right edge at 0
  });

  it('posX=1 places the block FULLY OFF the RIGHT (left edge at x=W)', () => {
    const x = posToDrawX(1, textW, W);
    expect(x).toBe(W);
  });

  it('posX=0.5 centres the block', () => {
    const x = posToDrawX(0.5, textW, W);
    expect(x).toBeCloseTo((W - textW) / 2, 6);
  });

  it('posY=0 fully off top, posY=1 fully off bottom, posY=0.5 centred', () => {
    expect(posToDrawY(0, textH, H)).toBe(-textH);
    expect(posToDrawY(1, textH, H)).toBe(H);
    expect(posToDrawY(0.5, textH, H)).toBeCloseTo((H - textH) / 2, 6);
  });

  it('a default-centred ±1 LFO sweeps posX across the FULL off-left→off-right range', () => {
    // Repo CV convention (cv-scale linear): effective = clamp(knob + cv*0.5, 0, 1).
    // Default knob = 0.5. cv=-1 → 0 (off left), cv=+1 → 1 (off right).
    const knob = 0.5;
    const eff = (cv: number) => Math.max(0, Math.min(1, knob + cv * 0.5));
    expect(posToDrawX(eff(-1), textW, W)).toBe(-textW); // fully off left
    expect(posToDrawX(eff(+1), textW, W)).toBe(W);       // fully off right
    expect(posToDrawX(eff(0), textW, W)).toBeCloseTo((W - textW) / 2, 6); // centred
  });

  it('clamps out-of-range pos params (defensive)', () => {
    expect(posToDrawX(-5, textW, W)).toBe(-textW);
    expect(posToDrawX(5, textW, W)).toBe(W);
    expect(posToDrawX(NaN, textW, W)).toBe(-textW); // NaN→0 via clamp01
  });
});

describe('scroll math — marquee wrap', () => {
  const span = 1000;
  const textSize = 200;
  const period = span + textSize; // 1200

  it('speed=0.5 (centre) is static — zero offset at any time', () => {
    expect(scrollOffset(0.5, 0, span, textSize)).toBe(0);
    expect(scrollOffset(0.5, 12.34, span, textSize)).toBe(0);
  });

  it('offset is continuous + wraps within ±period/2', () => {
    // Sample many times across several periods; every offset stays in range.
    for (let i = 0; i < 200; i++) {
      const t = i * 0.37;
      const o = scrollOffset(0.9, t, span, textSize);
      expect(o).toBeGreaterThanOrEqual(-period / 2 - 1e-6);
      expect(o).toBeLessThan(period / 2 + 1e-6);
    }
  });

  it('positive speed advances then re-enters from the opposite edge (modular)', () => {
    // vel at speed=1 = (1-0.5)*2 * MAX * span = MAX*span screens... px/sec.
    const vel = (1 - 0.5) * 2 * MAX_SCREENS_PER_SEC * span;
    // One full period of travel returns to the same wrapped offset.
    const t0 = 1.0;
    const tPeriod = t0 + period / vel;
    expect(scrollOffset(1, t0, span, textSize)).toBeCloseTo(
      scrollOffset(1, tPeriod, span, textSize),
      4,
    );
  });

  it('negative-direction speed mirrors positive', () => {
    const t = 2.5;
    const up = scrollOffset(0.8, t, span, textSize);
    const down = scrollOffset(0.2, t, span, textSize); // symmetric around 0.5
    // The magnitudes track (opposite directions, same |speed| from centre).
    expect(Math.abs(up)).toBeCloseTo(Math.abs(down), 6);
  });

  it('degenerate dimensions never throw / divide-by-zero', () => {
    expect(scrollOffset(1, 5, 0, 0)).toBe(0);
  });
});

describe('computeDrawOffset — position + scroll combined', () => {
  it('static (centre speeds) returns exactly the position anchor', () => {
    const o = computeDrawOffset({
      posX: 0.5, posY: 0.5, scrollX: 0.5, scrollY: 0.5,
      time: 9.9, textWidth: 300, textHeight: 60, screenW: 1024, screenH: 768,
    });
    expect(o.x).toBeCloseTo((1024 - 300) / 2, 6);
    expect(o.y).toBeCloseTo((768 - 60) / 2, 6);
  });

  it('adds the scroll offset onto the position anchor', () => {
    const base = computeDrawOffset({
      posX: 0.3, posY: 0.7, scrollX: 0.5, scrollY: 0.5,
      time: 0, textWidth: 300, textHeight: 60, screenW: 1024, screenH: 768,
    });
    const scrolled = computeDrawOffset({
      posX: 0.3, posY: 0.7, scrollX: 0.9, scrollY: 0.5,
      time: 1.5, textWidth: 300, textHeight: 60, screenW: 1024, screenH: 768,
    });
    const expectedDx = scrollOffset(0.9, 1.5, 1024, 300);
    expect(scrolled.x - base.x).toBeCloseTo(expectedDx, 6);
    expect(scrolled.y).toBeCloseTo(base.y, 6); // scrollY static → no y change
  });
});
