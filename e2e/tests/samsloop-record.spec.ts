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
//   6. ⚠ THE ONE THAT MATTERS, AND THE ONE THAT WAS MISSING:
//      **the recording PLAYS.** Record → trigger → audible RMS at `out`.
//
// ⚠ WHY 6 EXISTS. Read 1-5 again: every assertion above is about BYTES
// (`node.data.sample` populated, inside the budget, right rate/bits/channels),
// PIXELS (the waveform canvas has variance) or CHROME (a button label, a
// disabled state, a max-seconds readout). Not one of them listens. And for the
// whole life of the feature the module was **SILENT after REC** — the card
// wrote `node.data.sample.bytesB64` and the engine factory read only
// `node.data.fileBytesB64` / `node.data.samples`, so a recorded buffer never
// reached the worklet at all. Bytes: correct. Waveform: drawn. Save/load:
// round-tripped. Download: a valid WAV. Sound: none. This whole file was green
// throughout, and so was `samsloop.spec.ts`, whose audio test drives the
// UPLOAD path.
//
// The lesson is the repo's own: ask what a suite is structurally unable to
// see. A recorder's test set that never asserts audio can only ever prove the
// recorder writes a file.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow } from './_module-coverage-helpers';

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

  test('a RECORDED sample PLAYS — record → trigger → audible at the output', async ({ page }) => {
    // THE P0 REGRESSION LOCK. NOISE → samsloop.audio_l_in (the record chain)
    // and samsloop.out → SCOPE.ch1 (the playback chain), in one patch, so the
    // recorder's write and the player's read are joined by a cable rather than
    // by an assumption.
    const errors = await setupPage(page);
    await spawnPatch(
      page,
      [
        { id: 'n',   type: 'noise',    position: { x: 100, y: 200 } },
        { id: 's',   type: 'samsloop', position: { x: 400, y: 200 }, domain: 'audio', params: { mode: 1 } },
        { id: 'scp', type: 'scope',    position: { x: 800, y: 200 }, domain: 'audio' },
      ],
      [
        { id: 'e1', from: { nodeId: 'n', portId: 'white' }, to: { nodeId: 's', portId: 'audio_l_in' },
          sourceType: 'noise', targetType: 'samsloop' },
        { id: 'e2', from: { nodeId: 's', portId: 'out' }, to: { nodeId: 'scp', portId: 'ch1' },
          sourceType: 'audio', targetType: 'audio' },
      ],
    );

    // (a) NEGATIVE CONTROL, BEFORE. Nothing recorded yet and no trigger, so
    //     the output must be silent. Without this leg a leaky patch (noise
    //     bleeding to the scope through some other route) would make the
    //     post-trigger assertion pass for the wrong reason — which is exactly
    //     the failure mode that let the silent recorder ship.
    const beforeRec = await readScopePeakOverWindow(page, 'scp', 400);
    expect(
      beforeRec.peak,
      `pre-record peak ${beforeRec.peak} — samsloop must be silent with no sample and no trigger`,
    ).toBeLessThan(0.02);

    // (b) Record ~700 ms of noise.
    const rec = page.locator('[data-testid="samsloop-rec-button"]');
    await expect(rec).toBeVisible();
    await rec.click();
    await expect(rec).toContainText('STOP', { timeout: 3000 });
    await page.waitForTimeout(700);
    await rec.click();
    await expect(rec).toContainText('REC');

    // The bytes landed — asserted here too so a failure below is diagnosable
    // as "recorded but does not play" rather than "did not record".
    const sample = await readSample(page, 's');
    expect(sample, 'nothing was recorded — the failure below would be about the wrong thing').not.toBeNull();
    expect(sample!.bytesLen).toBeGreaterThan(0);

    // (c) NEGATIVE CONTROL, MIDDLE. SAMSLOOP is idle-by-default: a loaded
    //     sample does NOT auto-play. So it must STILL be silent here, which
    //     also proves the audible reading in (d) comes from the TRIGGER and
    //     not from the record tap leaking into the output.
    await page.waitForTimeout(600); // the factory polls node.data every 200 ms
    const loaded = await readScopePeakOverWindow(page, 'scp', 500);
    expect(
      loaded.peak,
      `post-record pre-trigger peak ${loaded.peak} — a loaded sample must stay idle`,
    ).toBeLessThan(0.02);

    // (d) THE ASSERTION THE MODULE SHIPPED WITHOUT: trigger it and listen.
    //     Renderer-tolerant — a max-held peak over a window with a generous
    //     floor, because the claim is "audible vs silent", not a level.
    await page.locator('[data-testid="samsloop-trigger-button"]').click();
    const playing = await readScopePeakOverWindow(page, 'scp', 1500);
    expect(
      playing.peak,
      `post-trigger peak ${playing.peak} over ${playing.polls} polls — a recorded sample MUST play`,
    ).toBeGreaterThan(0.05);

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
