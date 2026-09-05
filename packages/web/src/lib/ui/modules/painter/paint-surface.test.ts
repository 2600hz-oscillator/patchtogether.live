// packages/web/src/lib/ui/modules/painter/paint-surface.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for PAINTER's shared interaction seam.
//
// ⚠ WHAT THIS FILE IS ACTUALLY PROTECTING, stated first because it is not
// obvious from the assertions: every painter drawing surface writes into ONE
// Y.Doc-synced op log, and any `PaintOp` a surface emits is STRUCTURALLY VALID.
// So a divergence between two of them does not throw, does not fail a type
// check and does not redden a registry gate. It syncs two different pictures to
// two peers and looks like a rendering bug months later — which is why the
// gesture-to-op arithmetic is a shared module and this file is its negative
// control, whether one surface calls it today or three do tomorrow.
//
// The seam is what makes that divergence inexpressible: both surfaces call
// these functions and neither owns a copy of the arithmetic. This file pins the
// arithmetic itself, so a change to it is a change both surfaces get.
//
// The DRAWING MODEL below this seam (`painter-draw.ts`: the op shapes, the
// palette, `applyVectorOp`, `floodFill`, `coerceOps`) has its own unit suite
// and is not re-tested here.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripSourceComments } from '$lib/source-guards/strip-source-comments';
import {
  DEFAULT_BRUSH,
  DEFAULT_FG,
  MAX_BRUSH,
  MIN_BRUSH,
  PAINT_BG,
  type Tool,
} from '$lib/video/modules/painter-draw';
import {
  fillOpFor,
  gestureKindFor,
  PAINT_TOOLS,
  pickColorAt,
  pointerToCanvas,
  shapeOpFor,
  shapeToolOf,
  strokeColorFor,
  strokeOpFor,
  strokeSizeFor,
  strokeToolOf,
  textOpFor,
  textStampSize,
  type PaintToolState,
} from './paint-surface';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, rel), 'utf8');

/** The default local tool state both surfaces open with. */
function tools(over: Partial<PaintToolState> = {}): PaintToolState {
  return {
    tool: 'pencil',
    fg: DEFAULT_FG,
    bg: PAINT_BG,
    brush: DEFAULT_BRUSH,
    fillShapes: false,
    text: 'TEXT',
    ...over,
  };
}

/** A structural canvas — the web package's vitest runs in `environment: 'node'`,
 *  so there is no DOM and every rect is injected. */
function canvasAt(
  width: number,
  height: number,
  rect: { left: number; top: number; width: number; height: number },
) {
  return { width, height, getBoundingClientRect: () => rect };
}

describe('paint-surface — the tool roster', () => {
  it('carries every Tool the drawing model declares, exactly once', () => {
    // The roster is what both surfaces render buttons from, so a tool missing
    // here is a tool NEITHER surface can reach — invisible to every other gate,
    // because `painter-draw` would go on handling an op nothing can produce.
    const ids = PAINT_TOOLS.map((t) => t.id);
    expect(new Set(ids).size, 'a duplicated tool would render two buttons').toBe(ids.length);
    const expected: Tool[] = [
      'pencil', 'brush', 'eraser', 'fill', 'eyedropper', 'line', 'rect', 'ellipse', 'text',
    ];
    expect([...ids].sort()).toEqual([...expected].sort());
  });

  it('every entry carries a label — it is the tool button\'s accessible name', () => {
    for (const t of PAINT_TOOLS) {
      expect(t.label.length, `${t.id} has no label`).toBeGreaterThan(0);
      expect(t.glyph.length, `${t.id} has no glyph`).toBeGreaterThan(0);
    }
  });
});

describe('paint-surface — the gesture branch', () => {
  it('routes each tool to the behaviour it actually has', () => {
    expect(gestureKindFor('eyedropper')).toBe('pick');
    expect(gestureKindFor('fill')).toBe('fill');
    expect(gestureKindFor('text')).toBe('text');
    for (const t of ['pencil', 'brush', 'eraser'] as Tool[]) {
      expect(gestureKindFor(t), `${t} is a freehand stroke`).toBe('stroke');
    }
    for (const t of ['line', 'rect', 'ellipse'] as Tool[]) {
      expect(gestureKindFor(t), `${t} is a two-point shape`).toBe('shape');
    }
  });

  it('TOTALITY: every rostered tool has a branch, and none falls through', () => {
    // Without this, a tenth tool added to PAINT_TOOLS would silently take the
    // `shape` default and draw a rectangle when clicked.
    const kinds = new Set(PAINT_TOOLS.map((t) => gestureKindFor(t.id)));
    expect([...kinds].sort()).toEqual(['fill', 'pick', 'shape', 'stroke', 'text']);
  });
});

describe('paint-surface — the op arithmetic both surfaces share', () => {
  it('the ERASER paints the BACKGROUND colour; everything else the foreground', () => {
    // ⚠ THE REASON RIGHT-CLICK-A-SWATCH IS A CONTROL RATHER THAN A SHORTCUT.
    // The background is reachable only by right-clicking the palette, and it is
    // what the eraser draws with — so a surface that dropped the right-click
    // would ship an eraser stuck on white.
    expect(strokeColorFor(tools({ tool: 'eraser', bg: '#00ff00' }))).toBe('#00ff00');
    expect(strokeColorFor(tools({ tool: 'brush', fg: '#ff0000', bg: '#00ff00' }))).toBe('#ff0000');
  });

  it('PENCIL is 1 px whatever SIZE says; brush and eraser take SIZE', () => {
    expect(strokeSizeFor(tools({ tool: 'pencil', brush: 40 }))).toBe(1);
    expect(strokeSizeFor(tools({ tool: 'brush', brush: 40 }))).toBe(40);
    expect(strokeSizeFor(tools({ tool: 'eraser', brush: 7 }))).toBe(7);
  });

  it('maps each tool onto the op tool the model expects', () => {
    expect(strokeToolOf('eraser')).toBe('eraser');
    expect(strokeToolOf('brush')).toBe('brush');
    expect(strokeToolOf('pencil')).toBe('pencil');
    expect(shapeToolOf('line')).toBe('line');
    expect(shapeToolOf('rect')).toBe('rect');
    expect(shapeToolOf('ellipse')).toBe('ellipse');
  });

  it('a stroke op COPIES its points — the caller keeps mutating the live array', () => {
    // Both surfaces push into `strokePts` on every pointermove and commit on
    // pointerup. Handing the LIVE array to `appendOp` would put a still-growing
    // reference into the Y.Doc; the next drag would rewrite a committed op.
    const pts = [1, 2, 3, 4];
    const op = strokeOpFor(tools({ tool: 'brush' }), pts);
    pts.push(9, 9);
    expect(op.points).toEqual([1, 2, 3, 4]);
  });

  it('FILL never reaches a LINE — a line has no interior', () => {
    const filled = shapeOpFor(tools({ tool: 'rect', fillShapes: true, bg: '#123456' }), 0, 0, 4, 4);
    expect(filled.fill).toBe('#123456');
    const line = shapeOpFor(tools({ tool: 'line', fillShapes: true, bg: '#123456' }), 0, 0, 4, 4);
    expect(line.fill, 'the FILL toggle must not change what a line serialises to').toBeNull();
    const outline = shapeOpFor(tools({ tool: 'ellipse', fillShapes: false }), 0, 0, 4, 4);
    expect(outline.fill).toBeNull();
  });

  it('a shape OUTLINE is the FOREGROUND and its interior the BACKGROUND', () => {
    const op = shapeOpFor(
      tools({ tool: 'rect', fillShapes: true, fg: '#ff0000', bg: '#0000ff' }),
      1, 2, 3, 4,
    );
    expect(op.color).toBe('#ff0000');
    expect(op.fill).toBe('#0000ff');
    expect([op.x0, op.y0, op.x1, op.y1]).toEqual([1, 2, 3, 4]);
  });

  it('FILL floods with the FOREGROUND, at the click point', () => {
    const op = fillOpFor(tools({ fg: '#abcdef' }), 12, 34);
    expect(op).toEqual({ kind: 'fill', color: '#abcdef', x: 12, y: 34 });
  });

  it('an EMPTY stamp string commits NOTHING', () => {
    // ⚠ NOT COSMETIC. An empty text op draws nothing, and still consumes an
    // UNDO press and a slot against `MAX_OPS` — so clicking with an empty field
    // would look like the canvas had stopped responding.
    expect(textOpFor(tools({ tool: 'text', text: '' }), 5, 5)).toBeNull();
    const op = textOpFor(tools({ tool: 'text', text: 'HI', brush: 10, fg: '#00ff00' }), 5, 6);
    expect(op).toEqual({
      kind: 'text', color: '#00ff00', size: textStampSize(10), x: 5, y: 6,
      font: 'sans-serif', text: 'HI',
    });
  });

  it('the stamp size floors, so the smallest brush still stamps something legible', () => {
    expect(textStampSize(MIN_BRUSH)).toBe(12);
    expect(textStampSize(2)).toBe(12);
    expect(textStampSize(4)).toBe(24);
    expect(textStampSize(MAX_BRUSH)).toBe(MAX_BRUSH * 6);
  });
});

describe('paint-surface — pointer mapping', () => {
  it('scales client coordinates through the ELEMENT\'s own rect', () => {
    // The two surfaces show the SAME 1024x768 buffer at DIFFERENT displayed
    // sizes (the card into its rack tier, the body into the faceplate width).
    // A gesture mapped through the wrong rect commits an op that is right where
    // it was drawn and wrong on every other peer.
    const card = canvasAt(1024, 768, { left: 10, top: 20, width: 256, height: 192 });
    expect(pointerToCanvas(card, 10 + 128, 20 + 96)).toEqual([512, 384]);
    const body = canvasAt(1024, 768, { left: 0, top: 0, width: 512, height: 384 });
    expect(pointerToCanvas(body, 128, 96)).toEqual([256, 192]);
  });

  it('NEGATIVE CONTROL: a zero-sized rect maps to the origin, never NaN', () => {
    // A pointer that arrives before layout must not poison the synced op log
    // with NaN coordinates — they serialise, sync, and paint nothing on every
    // peer forever.
    const unlaidOut = canvasAt(1024, 768, { left: 0, top: 0, width: 0, height: 0 });
    expect(pointerToCanvas(unlaidOut, 40, 40)).toEqual([0, 0]);
  });
});

describe('paint-surface — the readback helpers never throw', () => {
  it('the eyedropper returns a hex, and NULL rather than throwing', () => {
    const ok = {
      getImageData: () => ({ data: new Uint8ClampedArray([0x12, 0x34, 0x56, 255]) }),
    } as unknown as CanvasRenderingContext2D;
    expect(pickColorAt(ok, 3, 4)).toBe('#123456');

    // ⚠ THE FAILING CASE IS THE ONE THAT MATTERS. `getImageData` throws on a
    // tainted context; a throw here would escape the pointerdown handler and
    // take the whole surface's event wiring down.
    const tainted = {
      getImageData: () => { throw new Error('tainted'); },
    } as unknown as CanvasRenderingContext2D;
    expect(pickColorAt(tainted, 3, 4)).toBeNull();
  });
});

describe('paint-surface — the no-drift property is STRUCTURAL', () => {
  const bodyCode = stripSourceComments(read('./PainterEditorBody.svelte'));

  it('the surface imports the seam — it owns no copy of the arithmetic', () => {
    expect(bodyCode, 'the face body').toMatch(/from '\.\/paint-surface'/);
    for (const fn of ['strokeOpFor', 'shapeOpFor', 'fillOpFor', 'textOpFor', 'pointerToCanvas']) {
      expect(bodyCode, `the body uses ${fn}`).toContain(fn);
    }
  });

  it('it does not re-type the op literals the seam builds', () => {
    // The offence this replaces: `commitOp({ kind: 'stroke', tool: ..., ... })`
    // written out in a component. It compiles, it syncs, and it is one edit away
    // from disagreeing with the other surface.
    for (const [where, code] of [['body', bodyCode] as const]) {
      expect(code, `${where} builds a stroke op by hand`).not.toMatch(/kind:\s*'stroke'/);
      expect(code, `${where} builds a shape op by hand`).not.toMatch(/kind:\s*'shape'/);
      expect(code, `${where} builds a fill op by hand`).not.toMatch(/kind:\s*'fill'/);
      expect(code, `${where} builds a text op by hand`).not.toMatch(/kind:\s*'text'/);
    }
  });

  it('it does not re-type the SIZE range — it comes from the model', () => {
    // `card-range-source` holds this at the source for PARAM controls; SIZE is
    // not a param (painter declares none), so the same rule is held here: a
    // surface that widened the range would emit ops the model then clamps.
    for (const [where, code] of [['body', bodyCode] as const]) {
      expect(code, `${where} binds min from MIN_BRUSH`).toMatch(/min=\{MIN_BRUSH\}/);
      expect(code, `${where} binds max from MAX_BRUSH`).toMatch(/max=\{MAX_BRUSH\}/);
    }
    expect(MIN_BRUSH).toBeLessThan(MAX_BRUSH);
  });

  it('it replays through the ONE node-lifetime replay', () => {
    // Three replays of one log would be three chances to disagree about what a
    // saved rack looks like. `replayPaintOps` is the producer's own function.
    expect(bodyCode).toContain('replayPaintOps');
  });

  it('it does not revert the node to the placeholder on teardown', () => {
    // ⚠ THE #1720 BUG, SPELLED OUT SO IT CANNOT COME BACK BY REFLEX.
    // `setPaintCanvas(null)` looks like correct cleanup and is the exact
    // regression: it drops the node to a blank white page. Handing the binding
    // back is `release()`, which makes the registry re-push its own replay.
    for (const [where, code] of [['body', bodyCode] as const]) {
      expect(code, `${where} nulls the paint canvas on teardown`)
        .not.toMatch(/setPaintCanvas\(\s*null\s*\)/);
      expect(code, `${where} releases the lease instead`).toMatch(/\.release\(\)/);
    }
  });
});
