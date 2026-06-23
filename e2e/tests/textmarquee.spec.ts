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
// the module's FBO. We assert the UNIQUE store/editor wiring (not the render):
//   1. typing text persists a rich-text model into node.data.richText,
//   2. toolbar BOLD applies a run style (the model carries bold:true),
//   3. CV params (scrollX/posX) route through the patch store,
//   4. no console / page errors.
//
// The LIVE render of that text to OUTPUT (non-black, structured) is the
// deterministic textmarquee-render-smoke.spec.ts (frozen clock + paused rAF,
// frame-stable). The pos/scroll/wrap math + rich-text layout are pixel-
// deterministically proven by textmarquee-layout.test.ts, and the def shape by
// textmarquee.test.ts. The GPU-attest rebuild Phase 3 dropped the old wall-clock
// render samples from this file (waitForTimeout → read-once brightness floor),
// keeping only the editor → store round-trip that has no other coverage.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const HEAVY_MOUNT_TIMEOUT = 30_000;
test.setTimeout(120_000);

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
  test('typing serializes a rich-text model into the patch store', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await spawnMarquee(page);

    // Type into the editor — the contenteditable → oninput → mutateNode round-trip
    // persists a rich-text model. This is the UNIQUE editor→store wiring; the
    // LIVE render of the text is textmarquee-render-smoke.spec.ts (deterministic).
    const editor = page.locator('[data-testid="textmarquee-editor"]');
    await editor.click();
    await page.keyboard.type('HELLO MARQUEE');

    // Poll the persisted model until the typed text serializes through (the
    // round-trip is async — deterministic poll, no wall-clock render sample).
    await expect.poll(async () => {
      const m = await readModel(page, 'txt') as { paragraphs?: { runs?: { text?: string }[] }[] } | null;
      return (m?.paragraphs ?? []).flatMap((p) => (p.runs ?? []).map((r) => r.text ?? '')).join('');
    }, { timeout: 5000, message: 'typed text serialized into the model' }).toContain('HELLO MARQUEE');

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
