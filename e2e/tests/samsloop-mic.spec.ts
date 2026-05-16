// e2e/tests/samsloop-mic.spec.ts
//
// SAMSLOOP mic-record path — separate spec so the fake-audio-input
// flag (--use-fake-device-for-media-stream) doesn't leak into other
// SAMSLOOP tests. This spec runs under the `chromium-samsloop-mic`
// project (see e2e/playwright.config.ts) which grants microphone
// permission + injects a synthetic mono beep on getUserMedia.
//
// Coverage:
//   - REC button starts capture, button visibly flips to "active" with
//     the live ms counter ticking forward.
//   - Clicking REC a second time stops capture and the sample is
//     committed into node.data (the one-sample invariant — the load
//     path is identical to file upload).
//   - The captured sample populates node.data.samples (non-empty) and
//     node.data.sampleLength matches.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

async function setupPage(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  return errors;
}

test.describe('SAMSLOOP mic-record (fake-mic)', () => {
  test('REC → wait → REC commits a captured sample into node.data', async ({ page }) => {
    const errors = await setupPage(page);
    await spawnPatch(page, [
      { id: 's', type: 'samsloop', position: { x: 200, y: 200 } },
    ]);

    const rec = page.locator('[data-testid="samsloop-rec-button"]');
    await expect(rec).toBeVisible();
    await expect(rec).toContainText('REC');

    // Start recording. The fake-audio device begins streaming a synthetic
    // mono beep — Chromium's fake mic outputs at the AudioContext's
    // native rate so we'll see captured samples piling up.
    await rec.click();
    // Button flips to active styling + the live ms counter mounts.
    await expect(rec).toHaveClass(/active/, { timeout: 3000 });
    await expect(page.locator('[data-testid="samsloop-rec-counter"]')).toBeVisible();

    // Let the recorder run for ~700 ms so we accumulate a real chunk.
    await page.waitForTimeout(700);

    // Stop recording. The card tears down the mic graph + commits the
    // samples into the patch graph via the one-sample-invariant path.
    await rec.click();
    await expect(rec).not.toHaveClass(/active/);

    // node.data should now carry a non-empty samples array with a
    // matching sampleLength + a "mic <duration>s" filename.
    const data = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: {
          nodes: Record<string, { data?: { samples?: number[]; sampleRate?: number; sampleLength?: number; fileName?: string } }>;
        };
      };
      const d = w.__patch.nodes['s']?.data;
      if (!d) return null;
      return {
        samplesLen: d.samples?.length ?? 0,
        sampleRate: d.sampleRate ?? 0,
        sampleLength: d.sampleLength ?? 0,
        fileName: d.fileName ?? '',
      };
    });
    expect(data, 'expected node.data populated after stop').not.toBeNull();
    expect(data!.samplesLen).toBeGreaterThan(0);
    expect(data!.samplesLen).toBe(data!.sampleLength);
    expect(data!.sampleRate).toBeGreaterThan(0);
    expect(data!.fileName).toMatch(/^mic /);

    // No page errors — mic-permission errors would have shown inline in
    // the card (samsloop-rec-error testid) but the permission is granted
    // for this project so neither path should fire.
    expect(errors, errors.join('; ')).toEqual([]);
  });

  test('file upload is disabled while recording is active', async ({ page }) => {
    await setupPage(page);
    await spawnPatch(page, [
      { id: 's', type: 'samsloop', position: { x: 200, y: 200 } },
    ]);

    const rec = page.locator('[data-testid="samsloop-rec-button"]');
    const fileInput = page.locator('[data-testid="samsloop-wav-input"]');
    await expect(fileInput).toBeEnabled();
    await rec.click();
    await expect(rec).toHaveClass(/active/, { timeout: 3000 });
    await expect(fileInput).toBeDisabled();
    // Stop and confirm the input is re-enabled.
    await rec.click();
    await expect(rec).not.toHaveClass(/active/);
    await expect(fileInput).toBeEnabled();
  });
});
