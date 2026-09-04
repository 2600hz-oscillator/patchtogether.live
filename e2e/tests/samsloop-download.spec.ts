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
import { expectedAchievedRate, openSamsloopPane, readContextSampleRate, readSample, samsloopIsRecording } from './_samsloop-helpers';

async function setupPage(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/rack?seed=none');
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

    const ctxRate = await readContextSampleRate(page);
    expect(ctxRate, 'audio engine must be up before REC').toBeGreaterThan(0);

    // Record briefly with defaults (48k target / 16-bit / MONO) — the REC
    // cell in the dock pane; the registry probe is the recording observable.
    const pane = await openSamsloopPane(page, 's');
    const rec = pane.getByTestId('shell-cell-samsloop-rec');
    await rec.click();
    await expect.poll(() => samsloopIsRecording(page, 's'), { message: 'REC arms' }).toBe(true);
    await page.waitForTimeout(500);
    await rec.click();
    await expect.poll(() => samsloopIsRecording(page, 's'), { message: 'REC stops' }).toBe(false);

    // The take must be committed before EXPORT is pressed (the cell button is
    // always enabled — enablement was card chrome; the persisted take is the
    // real precondition).
    await expect
      .poll(async () => (await readSample(page, 's')) !== null, { message: 'take committed' })
      .toBe(true);
    const dl = pane.getByTestId('shell-cell-samsloop-download');

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
    // Channels (default = MONO). The playback worklet buffer is mono and the
    // decoder mono-mixes before it gets there, so a stereo default bought a
    // 2× byte cost to serve only this WAV export. The switch is still there.
    expect(view.getUint16(22, true)).toBe(1);
    // Bits per sample (default = 16).
    expect(view.getUint16(34, true)).toBe(16);
    // ⚠ Sample rate: the rate the samples ACTUALLY are on this machine, not
    // the RATE switch. Hard-coding 44 100 here (what this test used to do)
    // asserted a property of the runner and agreed with a wrong tag.
    const expectedRate = expectedAchievedRate(ctxRate, 48_000);
    expect(view.getUint32(24, true), `ctx ${ctxRate} Hz → ${expectedRate} Hz`).toBe(expectedRate);
    // byteRate = rate * channels * bytesPerSample.
    expect(view.getUint32(28, true)).toBe(expectedRate * 1 * 2);
    // blockAlign = channels * bytesPerSample.
    expect(view.getUint16(32, true)).toBe(1 * 2);

    // The exported header must agree with what was persisted — the WAV and
    // node.data are two views of one take, and a divergence would mean the
    // downloaded file and the module play at different speeds.
    const stored = await readSample(page, 's');
    expect(stored, 'nothing persisted — the header check above is about the wrong thing').not.toBeNull();
    expect(view.getUint32(24, true)).toBe(stored!.rate);
    expect(view.getUint16(22, true)).toBe(stored!.channels);
    expect(view.getUint16(34, true)).toBe(stored!.bits);

    // dataChunkSize matches the body byte length.
    const dataChunkSize = view.getUint32(40, true);
    expect(dataChunkSize).toBe(buf.byteLength - 44);

    expect(errors, errors.join('; ')).toEqual([]);
  });
});
