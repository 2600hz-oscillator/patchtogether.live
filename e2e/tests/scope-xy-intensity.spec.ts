// e2e/tests/scope-xy-intensity.spec.ts
//
// E2E for SCOPE's X/Y (Lissajous) MODE switch + phosphor INTENSITY
// (persistence) knob.
//
//   1. X/Y mode: two oscillators drive ch1/ch2 at a 3:2 ratio (perfect
//      fifth). After switching to X/Y mode the on-card canvas must show a
//      non-trivial 2D Lissajous figure — lit pixels span MULTIPLE distinct
//      rows AND columns (i.e. NOT a flat horizontal/vertical line, which is
//      what a single channel or an in-phase pair would draw).
//
//   2. INTENSITY sweep: with a single tone on ch1, sweeping INTENSITY from
//      7:00 (min, 0.0 — a dot) up to 5:00 (max, 1.0 — a ~2-screen trail)
//      must change the lit-pixel extent of the trace. The dot lights far
//      fewer pixels than the long trail; 12:00 (default) sits between.
//
// We read the on-card canvas pixels directly (data-testid=scope-canvas).
// Audio is left running; we sample after a short settle so the analyser
// buffer is full. The thresholds are loose (structural, not pixel-exact)
// because exact pixels are the VRT suite's job; here we prove the FEATURE
// behaves (2D figure renders; trail length responds to the knob).

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

/** Read lit-pixel stats from the on-card scope canvas: total lit pixels,
 *  and the count of DISTINCT rows + columns that contain any lit pixel.
 *  "Lit" = noticeably brighter than the dark scope background (#0a0c10). */
async function scopeStats(page: Page): Promise<{
  lit: number; rows: number; cols: number; width: number; height: number;
}> {
  const canvas = page.locator('canvas[data-testid="scope-canvas"]');
  return canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return { lit: 0, rows: 0, cols: 0, width: c.width, height: c.height };
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const rowSet = new Set<number>();
    const colSet = new Set<number>();
    let lit = 0;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        const r = img.data[i]!;
        const g = img.data[i + 1]!;
        const b = img.data[i + 2]!;
        // Background is ~ (10,12,16). A lit trace pixel (amber/blue trace,
        // even faint phosphor) is clearly above that. Use a modest floor so
        // faint trail pixels still count.
        const lum = r + g + b;
        if (lum > 90) {
          lit++;
          rowSet.add(y);
          colSet.add(x);
        }
      }
    }
    return { lit, rows: rowSet.size, cols: colSet.size, width: c.width, height: c.height };
  });
}

async function setParam(page: Page, nodeId: string, param: string, value: number): Promise<void> {
  await page.evaluate(({ nodeId, param, value }) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes[nodeId];
      if (n) n.params[param] = value;
    });
  }, { nodeId, param, value });
}

test.describe('SCOPE X/Y mode + INTENSITY persistence', () => {
  test('X/Y mode draws a non-trivial Lissajous from two oscillators', async ({ page, rack, errorWatch }) => {
    // vco1 → ch1 (X), vco2 (a perfect fifth up, ~3:2) → ch2 (Y).
    await spawnPatch(
      page,
      [
        { id: 'vco1',  type: 'analogVco', position: { x: 40,  y: 40 },  domain: 'audio' },
        { id: 'vco2',  type: 'analogVco', position: { x: 40,  y: 280 }, domain: 'audio', params: { tune: 7 } },
        { id: 'scope', type: 'scope',     position: { x: 460, y: 60 },  domain: 'audio' },
      ],
      [
        { id: 'e1', from: { nodeId: 'vco1', portId: 'sine' }, to: { nodeId: 'scope', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
        { id: 'e2', from: { nodeId: 'vco2', portId: 'sine' }, to: { nodeId: 'scope', portId: 'ch2' }, sourceType: 'audio', targetType: 'audio' },
      ],
    );

    const card = page.locator('.svelte-flow__node-scope');
    await expect(card).toBeVisible();
    await page.waitForTimeout(500);

    // Switch to X/Y mode via the on-card button.
    const xyBtn = card.locator('[data-testid="scope-xy-mode"]');
    await expect(xyBtn).toHaveCount(1);
    await xyBtn.click();
    await expect(xyBtn).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(500);

    const s = await scopeStats(page);
    // A real Lissajous spreads across the square in BOTH axes — many rows
    // AND many columns are lit. A flat line (single channel / in-phase) would
    // fill ~all columns but only a couple of rows (or vice-versa).
    expect(s.lit, 'X/Y figure lights pixels').toBeGreaterThan(50);
    expect(s.rows, 'X/Y figure spans many rows (2D, not a horizontal line)').toBeGreaterThan(s.height * 0.3);
    expect(s.cols, 'X/Y figure spans many cols (2D, not a vertical line)').toBeGreaterThan(s.width * 0.3);

  });

  test('INTENSITY sweep: 7:00 dot lights far fewer pixels than 5:00 long trail', async ({ page, rack, errorWatch }) => {
    // Single tone on ch1, NORMAL (split) mode. Longer timebase so a 2-screen
    // trail (5:00) still fits inside the 2048-sample analyser buffer.
    await spawnPatch(
      page,
      [
        { id: 'vco',   type: 'analogVco', position: { x: 40,  y: 40 }, domain: 'audio' },
        { id: 'scope', type: 'scope',     position: { x: 460, y: 60 }, domain: 'audio', params: { timeMs: 10 } },
      ],
      [
        { id: 'e1', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'scope', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
      ],
    );

    const card = page.locator('.svelte-flow__node-scope');
    await expect(card).toBeVisible();
    await page.waitForTimeout(400);

    // 7:00 (min) — a moving dot. Near-zero trail.
    await setParam(page, 'scope', 'intensity', 0);
    await page.waitForTimeout(350);
    const dot = await scopeStats(page);

    // 12:00 (default) — one screen of trace.
    await setParam(page, 'scope', 'intensity', 0.5);
    await page.waitForTimeout(350);
    const mid = await scopeStats(page);

    // 5:00 (max) — ~2-screen persistence trail.
    await setParam(page, 'scope', 'intensity', 1);
    await page.waitForTimeout(350);
    const long = await scopeStats(page);

    // The dot lights only a handful of pixels; the long trail lights the
    // most. 12:00 sits strictly between (one screen of trace).
    expect(dot.lit, 'dot lights few pixels').toBeLessThan(mid.lit);
    expect(long.lit, 'long trail lights the most').toBeGreaterThan(mid.lit);
    // Make the dot↔trail contrast unambiguous (not a 1-pixel fluke).
    expect(long.lit, 'long trail >> dot').toBeGreaterThan(dot.lit * 3);

  });
});
