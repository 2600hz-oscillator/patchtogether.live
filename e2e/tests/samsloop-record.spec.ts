// e2e/tests/samsloop-record.spec.ts
//
// SAMSLOOP audio-input record path:
//   1. Spawn NOISE → samsloop.audio_l_in. Click REC, wait, click STOP.
//      Assert the button label flips REC → STOP → REC across the click
//      sequence.
//   2. node.data.sample.bytes is non-empty (recorded SOMETHING) AND ≤
//      the 250 kB byte budget.
//   3. The waveform canvas has non-trivial luma variance during/after
//      the recording (we drew something, not a blank canvas).
//   4. Settings switches: pick stereo / 16-bit / 44 kHz and assert the
//      "max seconds" readout in the UI displays ≈ 1.42 s.
//   5. CHAN / BITS / RATE buttons are disabled while a recording is in
//      flight (settings change mid-recording should stop the recording
//      cleanly — separately exercised in the unit-level state-machine).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

async function setupPage(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/rack');
  await page.waitForLoadState('domcontentloaded');
  return errors;
}

async function readSample(page: Page, nodeId: string) {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { sample?: { bytesB64: string; byteLength: number; rate: number; bits: number; channels: number; durationSec: number } } }> };
    };
    const s = w.__patch.nodes[id]?.data?.sample;
    if (!s) return null;
    return {
      bytesLen: s.byteLength,
      rate: s.rate,
      bits: s.bits,
      channels: s.channels,
      durationSec: s.durationSec,
    };
  }, nodeId);
}

test.describe('SAMSLOOP audio-input record', () => {
  test('REC → wait → STOP commits bytes + waveform has visible trace', async ({ page }) => {
    const errors = await setupPage(page);
    await spawnPatch(
      page,
      [
        { id: 'n', type: 'noise', position: { x: 100, y: 200 } },
        { id: 's', type: 'samsloop', position: { x: 400, y: 200 } },
      ],
      [
        {
          id: 'e1',
          from: { nodeId: 'n', portId: 'white' },
          to:   { nodeId: 's', portId: 'audio_l_in' },
          sourceType: 'noise',
          targetType: 'samsloop',
        },
      ],
    );

    const rec = page.locator('[data-testid="samsloop-rec-button"]');
    await expect(rec).toBeVisible();
    await expect(rec).toContainText('REC');

    // Start recording.
    await rec.click();
    await expect(rec).toContainText('STOP', { timeout: 3000 });
    // Settings buttons get disabled while recording.
    await expect(page.locator('[data-testid="samsloop-chan-stereo"]')).toBeDisabled();
    await expect(page.locator('[data-testid="samsloop-bits-16"]')).toBeDisabled();
    await expect(page.locator('[data-testid="samsloop-rate-44k"]')).toBeDisabled();

    // Capture ~700 ms of noise.
    await page.waitForTimeout(700);

    // Stop recording.
    await rec.click();
    await expect(rec).toContainText('REC');

    // Settings re-enable.
    await expect(page.locator('[data-testid="samsloop-chan-stereo"]')).toBeEnabled();

    // node.data.sample populated and within the byte budget.
    const sample = await readSample(page, 's');
    expect(sample, 'expected node.data.sample populated after stop').not.toBeNull();
    expect(sample!.bytesLen).toBeGreaterThan(0);
    expect(sample!.bytesLen).toBeLessThanOrEqual(250_000);
    // Defaults: 44.1 kHz / 16-bit / 2 ch.
    expect(sample!.rate).toBe(44100);
    expect(sample!.bits).toBe(16);
    expect(sample!.channels).toBe(2);
    expect(sample!.durationSec).toBeGreaterThan(0);

    // Waveform canvas has non-trivial luma variance — we drew SOMETHING
    // (the live-record peak trace, or the static decoded preview after
    // stop). "Non-trivial" = stdev of the red-channel pixel intensity
    // across the canvas > 5 (a blank canvas has stdev ≈ 0).
    const variance = await page.locator('[data-testid="samsloop-waveform"]').evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      if (!ctx) return 0;
      const img = ctx.getImageData(0, 0, c.width, c.height);
      // Sample every 4th pixel to keep the calc cheap.
      const reds: number[] = [];
      for (let i = 0; i < img.data.length; i += 16) reds.push(img.data[i]!);
      const mean = reds.reduce((a, b) => a + b, 0) / reds.length;
      const variance = reds.reduce((sum, x) => sum + (x - mean) ** 2, 0) / reds.length;
      return Math.sqrt(variance);
    });
    expect(variance, `red-channel stdev across waveform canvas: ${variance}`).toBeGreaterThan(5);

    expect(errors, errors.join('; ')).toEqual([]);
  });

  test('max-seconds readout reflects settings: stereo / 16-bit / 44 kHz ≈ 1.42s', async ({ page }) => {
    const errors = await setupPage(page);
    await spawnPatch(page, [{ id: 's', type: 'samsloop', position: { x: 200, y: 200 } }]);

    // Defaults already are stereo / 16-bit / 44 kHz — assert as-is.
    const budget = page.locator('[data-testid="samsloop-max-seconds"]');
    await expect(budget).toContainText(/1\.42s/);

    // Flip to mono / 8-bit / 22 kHz → 11.34 s.
    await page.locator('[data-testid="samsloop-chan-mono"]').click();
    await page.locator('[data-testid="samsloop-bits-8"]').click();
    await page.locator('[data-testid="samsloop-rate-22k"]').click();
    await expect(budget).toContainText(/11\.34s/);

    // Flip to stereo / 16-bit / 44 kHz → back to 1.42s.
    await page.locator('[data-testid="samsloop-chan-stereo"]').click();
    await page.locator('[data-testid="samsloop-bits-16"]').click();
    await page.locator('[data-testid="samsloop-rate-44k"]').click();
    await expect(budget).toContainText(/1\.42s/);

    expect(errors, errors.join('; ')).toEqual([]);
  });

  test('DOWNLOAD button enabled only after a successful recording', async ({ page }) => {
    const errors = await setupPage(page);
    await spawnPatch(
      page,
      [
        { id: 'n', type: 'noise', position: { x: 100, y: 200 } },
        { id: 's', type: 'samsloop', position: { x: 400, y: 200 } },
      ],
      [
        {
          id: 'e1',
          from: { nodeId: 'n', portId: 'white' },
          to:   { nodeId: 's', portId: 'audio_l_in' },
          sourceType: 'noise',
          targetType: 'samsloop',
        },
      ],
    );

    const dl = page.locator('[data-testid="samsloop-download-button"]');
    await expect(dl).toBeDisabled();

    // Record briefly.
    const rec = page.locator('[data-testid="samsloop-rec-button"]');
    await rec.click();
    await expect(rec).toContainText('STOP');
    await page.waitForTimeout(400);
    await rec.click();
    await expect(rec).toContainText('REC');

    await expect(dl).toBeEnabled({ timeout: 2000 });

    expect(errors, errors.join('; ')).toEqual([]);
  });
});
