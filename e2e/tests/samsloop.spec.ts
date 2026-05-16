// e2e/tests/samsloop.spec.ts
//
// SAMSLOOP end-to-end:
//   1. Drop the module, card mounts with no console errors, the waveform
//      canvas shows the "NO SAMPLE LOADED" placeholder.
//   2. Upload the committed test WAV (e2e/fixtures/samsloop-test.wav),
//      the filename appears, the waveform canvas re-renders with non-zero
//      pixels (orange peak-per-pixel trace).
//   3. Click the loop / one-shot toggle — text alternates between LOOP
//      and 1-SHOT, the underlying `mode` param mirrors.
//   4. Set the rate param (slider proxy) to a reverse value via the dev
//      __ydoc transact, confirm the engine accepted it and no errors fire.
//   5. Reject an oversized fake WAV → the error message renders, the
//      filename does NOT update.

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { spawnPatch } from './_helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WAV_PATH = resolve(__dirname, '../fixtures/samsloop-test.wav');

async function setupPage(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  return errors;
}

async function countWaveformPixels(page: Page): Promise<number> {
  const canvas = page.locator('[data-testid="samsloop-waveform"]');
  await expect(canvas).toHaveCount(1);
  return await canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return 0;
    const img = ctx.getImageData(0, 0, c.width, c.height);
    let orange = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      const r = img.data[i]!;
      const g = img.data[i + 1]!;
      const b = img.data[i + 2]!;
      // Match the trace colour rgb(255, 150, 40) with some AA tolerance.
      if (r > 200 && g > 100 && g < 200 && b < 100) orange++;
    }
    return orange;
  });
}

test.describe('SAMSLOOP module', () => {
  test('spawns with empty waveform placeholder, no console errors', async ({ page }) => {
    const errors = await setupPage(page);
    await spawnPatch(page, [{ id: 's', type: 'samsloop', position: { x: 200, y: 200 } }]);
    const card = page.locator('.svelte-flow__node-samsloop');
    await expect(card).toBeVisible();
    await expect(card).toContainText('SAMSLOOP');
    // No filename shown until upload.
    await expect(page.locator('[data-testid="samsloop-filename"]')).toHaveCount(0);
    // Waveform canvas exists.
    await expect(page.locator('[data-testid="samsloop-waveform"]')).toHaveCount(1);
    expect(errors, errors.join('; ')).toEqual([]);
  });

  test('uploads a WAV → filename appears + waveform renders trace pixels', async ({ page }) => {
    const errors = await setupPage(page);
    await spawnPatch(page, [{ id: 's', type: 'samsloop', position: { x: 200, y: 200 } }]);

    const wavBytes = readFileSync(WAV_PATH);
    const fileInput = page.locator('[data-testid="samsloop-wav-input"]');
    await fileInput.setInputFiles({
      name: 'samsloop-test.wav',
      mimeType: 'audio/wav',
      buffer: wavBytes,
    });

    // Filename + status appear on success.
    await expect(page.locator('[data-testid="samsloop-filename"]')).toContainText(
      'samsloop-test.wav',
      { timeout: 5000 },
    );
    await expect(page.locator('[data-testid="samsloop-upload-status"]')).toContainText(
      /loaded \d+ samples/i,
    );

    // Waveform canvas should now have non-zero orange-trace pixels.
    // Wait briefly for the $effect-driven redraw to settle.
    await page.waitForTimeout(300);
    const orange = await countWaveformPixels(page);
    expect(orange, `waveform trace pixel count: ${orange}`).toBeGreaterThan(20);

    expect(errors, errors.join('; ')).toEqual([]);
  });

  test('mode toggle flips between LOOP and 1-SHOT and mirrors the param', async ({ page }) => {
    const errors = await setupPage(page);
    await spawnPatch(page, [
      { id: 's', type: 'samsloop', position: { x: 200, y: 200 }, params: { mode: 1 } },
    ]);

    const btn = page.locator('[data-testid="samsloop-mode-toggle"]');
    await expect(btn).toContainText('LOOP');

    await btn.click();
    await expect(btn).toContainText('1-SHOT');
    const modeAfterFirst = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      return Math.round(w.__patch.nodes['s']?.params.mode ?? -1);
    });
    expect(modeAfterFirst).toBe(0);

    await btn.click();
    await expect(btn).toContainText('LOOP');
    const modeAfterSecond = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      return Math.round(w.__patch.nodes['s']?.params.mode ?? -1);
    });
    expect(modeAfterSecond).toBe(1);

    expect(errors, errors.join('; ')).toEqual([]);
  });

  test('rate param accepts a reverse value (varispeed) without errors', async ({ page }) => {
    const errors = await setupPage(page);
    await spawnPatch(page, [
      { id: 's', type: 'samsloop', position: { x: 200, y: 200 }, params: { rate: 1.0 } },
    ]);

    // Push rate to −1.5 (reverse 1.5×) through the live patch graph. Mirrors
    // what the fader's drag handler does.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['s'];
        if (n) n.params.rate = -1.5;
      });
    });
    await page.waitForTimeout(200);

    // Engine should have accepted the value (no clamp below −2).
    const live = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => { readParam: (n: { id: string; type: string; domain: string }, k: string) => number | undefined } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      const node = w.__patch.nodes['s'];
      if (!eng || !node) return null;
      return eng.readParam(node, 'rate');
    });
    expect(live, `live rate: ${live}`).toBeCloseTo(-1.5, 3);

    expect(errors, errors.join('; ')).toEqual([]);
  });

  test('REC button is present and clicking it does not crash the card', async ({ page }) => {
    // Mic capture itself is exercised in samsloop-mic.spec.ts (fake-mic
    // project). Here we just assert the button mounts + clicking it in
    // the default (no fake-mic flag) project doesn't throw — a missing
    // permission rejects to an inline error string, not a page error.
    const errors = await setupPage(page);
    await spawnPatch(page, [{ id: 's', type: 'samsloop', position: { x: 200, y: 200 } }]);
    const rec = page.locator('[data-testid="samsloop-rec-button"]');
    await expect(rec).toBeVisible();
    await expect(rec).toContainText('REC');
    // Click + give the (eventual) getUserMedia rejection a beat to settle.
    await rec.click();
    await page.waitForTimeout(500);
    // The card should NOT have thrown. Filter known mic-permission noise
    // (we EXPECT getUserMedia to reject under the default Chromium project
    // since no permission was granted) — that surfaces inline, not as a
    // page error.
    const noisy = (e: string) => /Permission denied|NotAllowed|getUserMedia|permission|microphone/i.test(e);
    expect(errors.filter((e) => !noisy(e)), errors.join('; ')).toEqual([]);
  });

  test('per-rackspace cap: adding samsloop #21 surfaces "sorry, SAMSLOOP limit exceeded"', async ({ page }) => {
    // The per-rackspace cap is 20 (see lib/multiplayer/samsloop-limits.ts).
    // In single-user E2E mode the per-user cap is skipped (null userId) so
    // the rackspace cap is what we hit. We spawn 20 directly into the
    // patch then attempt one more via spawnFromPalette and expect the
    // error band to surface the exact mandated message.
    const errors = await setupPage(page);
    const seed = Array.from({ length: 20 }, (_, i) => ({
      id: `s-${i}`,
      type: 'samsloop',
      position: { x: 80 + (i % 5) * 40, y: 80 + Math.floor(i / 5) * 40 },
    }));
    await spawnPatch(page, seed);
    await page.waitForTimeout(300);
    // Open the palette and try to add one more SAMSLOOP — should be
    // blocked. We invoke spawnFromPalette via the dev-only window helper
    // so this test isn't coupled to the right-click → palette UX (which
    // is covered separately).
    const present = await page.evaluate(() => {
      const w = globalThis as unknown as { __spawnFromPalette?: (type: string) => void };
      const ok = typeof w.__spawnFromPalette === 'function';
      if (ok) w.__spawnFromPalette!('samsloop');
      return ok;
    });
    expect(present, '__spawnFromPalette must be exposed in dev mode').toBe(true);
    // Error band (Canvas's pre.error) surfaces the exact brief-mandated
    // string. The band auto-clears after 4s — assert within that window.
    await expect(page.locator('pre.error'))
      .toContainText('sorry, SAMSLOOP limit exceeded', { timeout: 4000 });
    // And the patch did NOT acquire a 21st samsloop.
    const samsloopCount = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { type?: string }> };
      };
      let n = 0;
      for (const node of Object.values(w.__patch.nodes)) {
        if (node?.type === 'samsloop') n++;
      }
      return n;
    });
    expect(samsloopCount).toBe(20);
    expect(errors, errors.join('; ')).toEqual([]);
  });

  test('rejects oversize files (>250 KB) with the size-limit error', async ({ page }) => {
    const errors = await setupPage(page);
    await spawnPatch(page, [{ id: 's', type: 'samsloop', position: { x: 200, y: 200 } }]);

    // Build a 300 KB byte blob and feed it through the input. The file
    // gate runs BEFORE decodeAudioData so the content can be arbitrary
    // bytes — the size check fires first.
    const oversizeBytes = Buffer.alloc(300 * 1024, 0);
    const fileInput = page.locator('[data-testid="samsloop-wav-input"]');
    await fileInput.setInputFiles({
      name: 'oversize.wav',
      mimeType: 'audio/wav',
      buffer: oversizeBytes,
    });

    await expect(page.locator('[data-testid="samsloop-upload-error"]')).toContainText(
      /too large/i,
      { timeout: 5000 },
    );
    // No filename should be set — the upload was rejected.
    await expect(page.locator('[data-testid="samsloop-filename"]')).toHaveCount(0);

    // Page-error captures: oversize rejection is a clean user-facing error,
    // not a thrown exception. We allow stderr-level console messages but
    // not uncaught page errors.
    expect(errors.filter((e) => !/too large/i.test(e)), errors.join('; ')).toEqual([]);
  });
});
