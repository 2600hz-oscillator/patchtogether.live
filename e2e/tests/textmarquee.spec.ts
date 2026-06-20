// e2e/tests/textmarquee.spec.ts
//
// TEXTMARQUEE (rich-text marquee video generator) functional e2e — the REAL
// edit → render → OUTPUT chain.
//
// Graph:
//   TEXTMARQUEE.out --> OUTPUT
//
// TEXTMARQUEE is a video SOURCE: the user types styled text in the card's
// contenteditable editor; it serializes to a rich-text model (node.data
// .richText), renders to an offscreen 2D canvas (system fonts), and draws into
// the module's FBO. We assert, on the LIVE render + the store:
//   1. the card + the OUTPUT preview canvas mount,
//   2. a freshly-spawned node renders SOMETHING (the placeholder) — not black,
//   3. typing text persists a rich-text model into node.data.richText,
//   4. toolbar BOLD applies a run style (the model carries bold:true),
//   5. CV params (scrollX/posX) route through the patch store,
//   6. no console / page errors.
//
// This spec is intentionally THIN: the pos/scroll/wrap math + the rich-text
// layout/measurement are pixel-deterministically proven by the pure unit suite
// (textmarquee-layout.test.ts), and the def shape by textmarquee.test.ts. All
// pixel asserts here are RENDERER-TOLERANT (SwiftShader on CI ≠ a real GPU, and
// system-font glyph rasterization differs across platforms — see CLAUDE.md):
// we assert "the layer is not all-black" / "some bright pixels", never an exact
// glyph shape or count.
//
// Timeout: TEXTMARQUEE + videoOut are WebGL canvas cards whose first paint is
// slow on CI's SwiftShader software renderer; grant the established WebGL-heavy
// mount headroom (ci-swiftshader-video-e2e-timeouts).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const HEAVY_MOUNT_TIMEOUT = 30_000;
test.setTimeout(120_000);

/** Fraction of sampled OUTPUT pixels that are bright (a rendered glyph / the
 *  fg over the bg). Renderer-tolerant: "some bright pixels", not a glyph shape. */
async function readBrightFrac(page: Page): Promise<number> {
  const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
  await expect(canvas).toHaveCount(1);
  const frac = await canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return -1;
    // Sample the centre 80% so the 4:3 letterbox bars can't skew the count.
    const x0 = Math.floor(c.width * 0.1), x1 = Math.ceil(c.width * 0.9);
    const y0 = Math.floor(c.height * 0.1), y1 = Math.ceil(c.height * 0.9);
    const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let n = 0, bright = 0;
    for (let i = 0; i < d.length; i += 16) {
      const v = (d[i]! + d[i + 1]! + d[i + 2]!) / 3;
      n++;
      if (v > 40) bright++;
    }
    return n > 0 ? bright / n : 0;
  });
  expect(frac, 'canvas readable').toBeGreaterThanOrEqual(0);
  return frac;
}

/** Read the persisted rich-text model off the patch store for node `id`. */
async function readModel(page: Page, id: string): Promise<unknown> {
  return page.evaluate((nodeId) => {
    const w = window as unknown as { __patch?: { nodes?: Record<string, { data?: { richText?: unknown } }> } };
    return w.__patch?.nodes?.[nodeId]?.data?.richText ?? null;
  }, id);
}

async function spawnMarquee(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'txt',  type: 'textmarquee', position: { x: 80,  y: 80 }, domain: 'video' },
      { id: 'vout', type: 'videoOut',    position: { x: 620, y: 80 }, domain: 'video' },
    ],
    [
      { id: 'e_out', from: { nodeId: 'txt', portId: 'out' }, to: { nodeId: 'vout', portId: 'in' }, sourceType: 'video', targetType: 'video' },
    ],
    { mountTimeout: HEAVY_MOUNT_TIMEOUT },
  );
  await expect(page.locator('[data-testid="textmarquee-card"]')).toHaveCount(1);
  await expect(page.locator('canvas[data-testid="video-out-canvas"]')).toHaveCount(1);
}

test.describe('TEXTMARQUEE — rich-text marquee video generator', () => {
  test('placeholder + typed text render to OUTPUT (not all-black)', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await spawnMarquee(page);
    // A few rAFs so the TEXTMARQUEE → OUTPUT chain renders the placeholder.
    await page.waitForTimeout(800);
    const placeholderFrac = await readBrightFrac(page);
    expect(placeholderFrac, 'placeholder text renders (not all-black)').toBeGreaterThan(0.0);

    // Type into the editor — the model persists + the canvas re-renders.
    const editor = page.locator('[data-testid="textmarquee-editor"]');
    await editor.click();
    await page.keyboard.type('HELLO MARQUEE');

    // Poll the persisted model until the typed text serializes through (the
    // contenteditable → oninput → mutateNode round-trip is async).
    await expect.poll(async () => {
      const m = await readModel(page, 'txt') as { paragraphs?: { runs?: { text?: string }[] }[] } | null;
      return (m?.paragraphs ?? []).flatMap((p) => (p.runs ?? []).map((r) => r.text ?? '')).join('');
    }, { timeout: 5000, message: 'typed text serialized into the model' }).toContain('HELLO MARQUEE');
    await page.waitForTimeout(300);

    const typedFrac = await readBrightFrac(page);
    expect(typedFrac, 'typed text renders to OUTPUT (not all-black)').toBeGreaterThan(0.0);

    expect(errors, 'no console / page errors').toEqual([]);
  });

  test('BOLD toolbar applies a bold run to the selection', async ({ page }) => {
    await spawnMarquee(page);
    const editor = page.locator('[data-testid="textmarquee-editor"]');
    await editor.click();
    await page.keyboard.type('boldme');
    // Let the debounced persist settle (so its re-render can't steal focus mid
    // selection), then select all the editor text via the DOM Selection API
    // (scoped to the editor — robust vs a page-wide Ctrl+A) and click BOLD.
    await page.waitForTimeout(400);
    await editor.click();
    await editor.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
    await page.locator('[data-testid="textmarquee-bold"]').click();

    await expect.poll(async () => {
      const m = await readModel(page, 'txt') as { paragraphs?: { runs?: { bold?: boolean }[] }[] } | null;
      return (m?.paragraphs ?? []).some((p) => (p.runs ?? []).some((r) => r.bold === true));
    }, { timeout: 5000, message: 'BOLD toolbar produced a bold run in the model' }).toBe(true);
  });

  test('CV params (scrollX / posX) route through the patch store', async ({ page }) => {
    await spawnMarquee(page);
    // Drive the params through the same Yjs seam the knobs write (the cellshade
    // spec's proven pattern). The CV bridge reads node.params at edge-add time.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['txt'];
        if (!n) return;
        n.params.scrollX = 0.9;
        n.params.posX = 0.2;
      });
    });
    await page.waitForTimeout(120);
    const params = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      const n = w.__patch.nodes['txt'];
      return { scrollX: n?.params.scrollX, posX: n?.params.posX };
    });
    expect(params.scrollX, 'scrollX routed to the store').toBeCloseTo(0.9, 5);
    expect(params.posX, 'posX routed to the store').toBeCloseTo(0.2, 5);
  });
});
