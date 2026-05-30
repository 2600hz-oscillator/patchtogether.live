// e2e/tests/samsloop-download.spec.ts
//
// SAMSLOOP DOWNLOAD button — exports the recorded sample as a standard
// WAV file with a synthesized 44-byte RIFF/WAVE header on the fly.
//
// Coverage:
//   1. Record a brief sample. Click DOWNLOAD.
//   2. Assert Playwright observed a download with the expected
//      `samsloop-YYYYMMDD-HHmmss.wav` filename shape.
//   3. Read the saved file bytes. Assert it starts with "RIFF" / "WAVE"
//      and the header reports the expected sample-rate / bits / channels
//      matching the settings the user picked.

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
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

test.describe('SAMSLOOP DOWNLOAD button', () => {
  test('record → DOWNLOAD → WAV file lands with valid RIFF/WAVE header', async ({ page }) => {
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

    // Record briefly with defaults (44.1k / 16-bit / 2 ch).
    const rec = page.locator('[data-testid="samsloop-rec-button"]');
    await rec.click();
    await expect(rec).toContainText('STOP', { timeout: 3000 });
    await page.waitForTimeout(500);
    await rec.click();
    await expect(rec).toContainText('REC');

    const dl = page.locator('[data-testid="samsloop-download-button"]');
    await expect(dl).toBeEnabled({ timeout: 2000 });

    // Click DOWNLOAD — Playwright intercepts the resulting browser
    // download. Wait for the download event before clicking to avoid
    // racing the file-save.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dl.click(),
    ]);

    // Filename shape: samsloop-YYYYMMDD-HHmmss.wav.
    expect(download.suggestedFilename()).toMatch(/^samsloop-\d{8}-\d{6}\.wav$/);

    // Save the file + read it back to inspect the header.
    const savedPath = await download.path();
    expect(savedPath, 'download must save to disk').toBeTruthy();
    const buf = readFileSync(savedPath!);
    expect(buf.byteLength).toBeGreaterThan(44); // header + at least one frame

    // First 4 bytes = "RIFF".
    expect(buf.subarray(0, 4).toString('ascii')).toBe('RIFF');
    // Bytes 8-12 = "WAVE".
    expect(buf.subarray(8, 12).toString('ascii')).toBe('WAVE');
    // Bytes 12-16 = "fmt ".
    expect(buf.subarray(12, 16).toString('ascii')).toBe('fmt ');
    // Bytes 36-40 = "data".
    expect(buf.subarray(36, 40).toString('ascii')).toBe('data');

    // Read the header fields (all little-endian after the fixed ASCII chunks).
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    // Audio format = 1 (PCM).
    expect(view.getUint16(20, true)).toBe(1);
    // Channels (defaults = stereo = 2).
    expect(view.getUint16(22, true)).toBe(2);
    // Sample rate (default = 44.1k).
    expect(view.getUint32(24, true)).toBe(44100);
    // Bits per sample (default = 16).
    expect(view.getUint16(34, true)).toBe(16);
    // byteRate = rate * channels * bytesPerSample.
    expect(view.getUint32(28, true)).toBe(44100 * 2 * 2);
    // blockAlign = channels * bytesPerSample.
    expect(view.getUint16(32, true)).toBe(2 * 2);

    // dataChunkSize matches the body byte length.
    const dataChunkSize = view.getUint32(40, true);
    expect(dataChunkSize).toBe(buf.byteLength - 44);

    expect(errors, errors.join('; ')).toEqual([]);
  });
});
