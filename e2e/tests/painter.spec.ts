// e2e/tests/painter.spec.ts
//
// PAINTER — the real interactive draw → canvas → synced-op chain. The per-port
// sweep proves the OUT port emits (the blank white page is a non-black signal);
// this proves the UNIQUE bit: a pointer drag actually paints the canvas, commits
// a synced PaintOp (node.data.ops, so it persists + syncs to rack-mates), and
// CLEAR empties it back to a blank page. (The pure draw/flood/op-model logic is
// unit-tested in painter-draw.test.ts; the GL canvas→texture→OUT passthrough is a
// trivial blit covered by the per-port emit sweep.)

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

type PatchGlobal = {
  __patch: { nodes: Record<string, { data?: { ops?: unknown[] } }> };
};

/** Fraction of sampled canvas pixels that are NOT near-white (i.e. painted). */
async function paintedFrac(page: Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid="painter-canvas"]') as HTMLCanvasElement | null;
    if (!c) return -1;
    const ctx = c.getContext('2d');
    if (!ctx) return -1;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0, painted = 0;
    for (let i = 0; i < d.length; i += 4 * 32) {
      n++;
      // "painted" = not near-white (the blank page is #ffffff)
      if (d[i]! < 240 || d[i + 1]! < 240 || d[i + 2]! < 240) painted++;
    }
    return n > 0 ? painted / n : 0;
  });
}

function opCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = globalThis as unknown as PatchGlobal;
    return (w.__patch.nodes['pt']?.data?.ops ?? []).length;
  });
}

/** Drag the mouse across the painter canvas to paint a thick stroke (brush at a
 *  large size so the painted band is unambiguous under sparse pixel sampling).
 *  `yFrac` places the stroke band so multiple strokes don't overlap. */
async function drawStroke(page: Page, yFrac = 0.5): Promise<void> {
  await page.locator('[data-testid="painter-tool-brush"]').click();
  await page.locator('[data-testid="painter-size"]').fill('48');
  const canvas = page.locator('[data-testid="painter-canvas"]');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('painter canvas has no bounding box');
  const y = box.y + box.height * yFrac;
  await page.mouse.move(box.x + box.width * 0.15, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, y);
  await page.mouse.move(box.x + box.width * 0.85, y);
  await page.mouse.up();
}

test.describe('PAINTER — interactive draw → synced ops', () => {
  test('a pointer drag paints the canvas + commits a synced stroke op', async ({ page, rack, errorWatch }) => {
    await spawnPatch(page, [
      { id: 'pt', type: 'painter', position: { x: 200, y: 120 }, domain: 'video' },
    ]);

    await expect(page.locator('[data-testid="painter-card"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="painter-canvas"]')).toHaveCount(1);

    // Blank page = white → ~0 painted pixels, and no ops yet.
    expect(await paintedFrac(page)).toBeLessThan(0.02);
    expect(await opCount(page)).toBe(0);

    await drawStroke(page, 0.3);

    // The stroke painted the canvas (black on white) + persisted ONE op.
    expect(await paintedFrac(page), 'the drag painted dark pixels on the canvas').toBeGreaterThan(0.01);
    await expect.poll(() => opCount(page), { message: 'one stroke op committed to node.data.ops' }).toBe(1);

    // A SECOND stroke must ALSO commit — the Yjs re-integration trap (slice +
    // reassign of a live op array) silently dropped every op after the first, so
    // the canvas rolled back to one stroke. Two strokes ⇒ two persisted ops.
    await drawStroke(page, 0.7);
    await expect
      .poll(() => opCount(page), { message: 'the SECOND stroke commits too (no Yjs re-integration drop)' })
      .toBe(2);
    expect(await paintedFrac(page), 'both stroke bands remain painted (no rollback)').toBeGreaterThan(0.02);

  });

  test('CLEAR empties the op log + returns a blank page', async ({ page, rack }) => {
    await spawnPatch(page, [
      { id: 'pt', type: 'painter', position: { x: 200, y: 120 }, domain: 'video' },
    ]);
    await expect(page.locator('[data-testid="painter-canvas"]')).toHaveCount(1);

    await drawStroke(page);
    await expect.poll(() => opCount(page)).toBeGreaterThan(0);
    expect(await paintedFrac(page)).toBeGreaterThan(0.01);

    await page.locator('[data-testid="painter-clear"]').click();

    await expect.poll(() => opCount(page), { message: 'CLEAR empties node.data.ops' }).toBe(0);
    await expect.poll(() => paintedFrac(page), { message: 'canvas is blank/white again' }).toBeLessThan(0.02);
  });

  test('the FILL tool floods the canvas with the foreground colour', async ({ page, rack }) => {
    await spawnPatch(page, [
      { id: 'pt', type: 'painter', position: { x: 200, y: 120 }, domain: 'video' },
    ]);
    await expect(page.locator('[data-testid="painter-canvas"]')).toHaveCount(1);

    // Pick a red foreground, select FILL, click the canvas.
    await page.locator('[data-testid="painter-swatch-#ff0000"]').click();
    await page.locator('[data-testid="painter-tool-fill"]').click();
    const canvas = page.locator('[data-testid="painter-canvas"]');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('no canvas box');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    // The whole (blank) page floods red → almost all pixels painted + one fill op.
    await expect.poll(() => paintedFrac(page), { message: 'fill covers the canvas' }).toBeGreaterThan(0.9);
    await expect.poll(() => opCount(page)).toBe(1);
  });
});
