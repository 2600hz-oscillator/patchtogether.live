// e2e/tests/samsloop.spec.ts
//
// SAMSLOOP end-to-end:
//   1. Drop the module, the shell tile mounts with no console errors; the
//      dock face carries the waveform canvas.
//   2. Upload the committed test WAV (e2e/fixtures/samsloop-test.wav) through
//      the dock FILE cell — the "loaded N samples" receipt appears on the
//      cell cap and the face waveform canvas renders trace pixels. (The
//      card-only filename readout died with the card; the receipt is the
//      surviving observable.)
//   3. Drive the dock mode SEGMENTED (one-shot / loop radios) — aria-checked
//      flips and the underlying `mode` param mirrors.
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
import { readScopePeakOverWindow } from './_module-coverage-helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WAV_PATH = resolve(__dirname, '../fixtures/samsloop-test.wav');

async function setupPage(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  return errors;
}

/** Open the SAMSLOOP dock full view (every non-ranked affordance — the file
 *  cell, REC/EXPORT, the waveform — lives there) and return the PANE, scoped
 *  by node: the tile ranks some of the same cell testids. */
async function openSamsPane(page: Page, id = 's') {
  await page.waitForFunction(
    () => typeof (globalThis as unknown as { __openDockFullView?: unknown }).__openDockFullView === 'function',
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(
    (i) => (globalThis as unknown as { __openDockFullView: (x: string) => void }).__openDockFullView(i),
    id,
  );
  const pane = page.locator(`[data-testid="dock-fullview-pane"][data-pane-node="${id}"]`);
  await expect(pane.getByTestId('samsloop-face-canvas')).toBeVisible({ timeout: 30_000 });
  return pane;
}

async function countWaveformPixels(page: Page): Promise<number> {
  const canvas = page.locator('[data-testid="samsloop-face-canvas"]');
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
    const tile = page.locator('.svelte-flow__node[data-id="s"] [data-testid="module-shell"]');
    await expect(tile).toBeVisible();
    await expect(tile.getByTestId('tile-name-label')).toContainText(/samsloop/i);
    const pane = await openSamsPane(page);
    // No upload receipt until upload; the face waveform canvas exists.
    await expect(pane.getByTestId('shell-cell-samsloop-wav-input-status')).toHaveCount(0);
    await expect(pane.getByTestId('samsloop-face-canvas')).toHaveCount(1);
    expect(errors, errors.join('; ')).toEqual([]);
  });

  test('uploads a WAV → filename appears + waveform renders trace pixels', async ({ page }) => {
    const errors = await setupPage(page);
    await spawnPatch(page, [{ id: 's', type: 'samsloop', position: { x: 200, y: 200 } }]);

    const pane = await openSamsPane(page);
    const wavBytes = readFileSync(WAV_PATH);
    await pane.getByTestId('shell-cell-samsloop-wav-input').setInputFiles({
      name: 'samsloop-test.wav',
      mimeType: 'audio/wav',
      buffer: wavBytes,
    });

    // The load receipt appears on the FILE cell's cap (the card-only filename
    // readout died with the card — the receipt is the surviving observable).
    await expect(pane.getByTestId('shell-cell-samsloop-wav-input-status')).toContainText(
      /loaded \d+ samples/i,
      { timeout: 5000 },
    );

    // Waveform canvas should now have non-zero orange-trace pixels. The face
    // body redraws on its own rAF tick once the decoded sample lands in
    // node.data — poll the observable rather than budgeting a flat delay.
    await expect
      .poll(() => countWaveformPixels(page), {
        timeout: 10_000,
        message: 'face waveform paints the orange trace after the upload decodes',
      })
      .toBeGreaterThan(20);

    expect(errors, errors.join('; ')).toEqual([]);
  });

  test('mode toggle flips between LOOP and 1-SHOT and mirrors the param', async ({ page }) => {
    const errors = await setupPage(page);
    await spawnPatch(page, [
      { id: 's', type: 'samsloop', position: { x: 200, y: 200 }, params: { mode: 1 } },
    ]);

    // The dock face paints mode as a SEGMENTED radiogroup (one-shot / loop) —
    // the card's LOOP/1-SHOT text-flip button died with the card; aria-checked
    // is the surviving readout and the segments are the gesture.
    const pane = await openSamsPane(page);
    const seg = pane.getByTestId('control-mode');
    const loop = seg.getByRole('radio', { name: 'loop' });
    const oneShot = seg.getByRole('radio', { name: 'one-shot' });
    await expect(loop).toHaveAttribute('aria-checked', 'true');

    await oneShot.click();
    await expect(oneShot).toHaveAttribute('aria-checked', 'true');
    await expect(loop).toHaveAttribute('aria-checked', 'false');
    const modeAfterFirst = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      return Math.round(w.__patch.nodes['s']?.params.mode ?? -1);
    });
    expect(modeAfterFirst).toBe(0);

    await loop.click();
    await expect(loop).toHaveAttribute('aria-checked', 'true');
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
    // Engine should have accepted the value (no clamp below −2). The store→engine
    // hop is genuinely async, so poll the ENGINE read — the real subject — rather
    // than budget 200 ms for it. The poll returns the instant the engine adopts
    // the value and still fails, printing what it last saw, if it never does.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const w = globalThis as unknown as {
              __engine?: () => {
                readParam: (n: { id: string; type: string; domain: string }, k: string) => number | undefined;
              } | null;
              __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
            };
            const eng = w.__engine?.();
            const node = w.__patch.nodes['s'];
            if (!eng || !node) return null;
            return eng.readParam(node, 'rate');
          }),
        { message: 'the engine adopts rate = -1.5 (no clamp below -2)' },
      )
      .toBeCloseTo(-1.5, 3);

    expect(errors, errors.join('; ')).toEqual([]);
  });

  test('REC button is present and clicking it does not crash the card', async ({ page }) => {
    // The audio-input record path is exercised end-to-end in
    // samsloop-record.spec.ts (where a VCO is patched into audio_l_in).
    // Here we just assert the cell mounts + clicking it without an attached
    // audio source arms a recording and a second click stops it, without
    // throwing. The cell's label is static by design — the card's REC/STOP
    // text flip died with the card; the NODE-keyed registry's probe
    // (__samsloopRecording) is the recording-state observable.
    const errors = await setupPage(page);
    await spawnPatch(page, [{ id: 's', type: 'samsloop', position: { x: 200, y: 200 } }]);
    const pane = await openSamsPane(page);
    const rec = pane.getByTestId('shell-cell-samsloop-rec');
    await expect(rec).toBeVisible();
    const recording = () =>
      page.evaluate(
        (id) =>
          (globalThis as unknown as { __samsloopRecording: (n: string) => { recording: boolean } })
            .__samsloopRecording(id).recording,
        's',
      );
    expect(await recording()).toBe(false);
    await rec.click();
    await expect.poll(recording, { message: 'first press arms the take' }).toBe(true);
    await page.waitForTimeout(150);
    await rec.click();
    await expect.poll(recording, { message: 'second press stops it' }).toBe(false);
    expect(errors, errors.join('; ')).toEqual([]);
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

  test('upload status clears within 2s on success (no stuck "parsing..." spinner)', async ({ page }) => {
    // Regression: a small 8-bit 16 kHz mono WAV used to hang on
    // "parsing..." forever because the decoder upsampled to native
    // 48 kHz and the resulting 65K-element JS array took 10+ seconds
    // to serialize into the syncedstore CRDT. Fix downsamples to 24 kHz
    // before storing + uses try/finally so every exit path clears the
    // spinner. This test asserts the user-visible outcome: the load
    // status either advances to a success message or clears, but does
    // not get stuck on "parsing..." indefinitely.
    const errors = await setupPage(page);
    await spawnPatch(page, [{ id: 's', type: 'samsloop', position: { x: 200, y: 200 } }]);

    const pane = await openSamsPane(page);
    const wavBytes = readFileSync(WAV_PATH);
    await pane.getByTestId('shell-cell-samsloop-wav-input').setInputFiles({
      name: 'samsloop-test.wav',
      mimeType: 'audio/wav',
      buffer: wavBytes,
    });

    // Upload status MUST resolve to a "loaded ..." message within 2 s
    // — never get stuck on "parsing...". The 2 s budget covers a slow
    // CI runner; the fix makes a 43 KB upload land in tens of ms.
    const status = pane.getByTestId('shell-cell-samsloop-wav-input-status');
    await expect(status).toContainText(/loaded \d+ samples/i, { timeout: 2000 });
    await expect(status).not.toContainText(/parsing/i);

    expect(errors, errors.join('; ')).toEqual([]);
  });

  test('rejects oversize files (>2 MB) with the size-limit error', async ({ page }) => {
    const errors = await setupPage(page);
    await spawnPatch(page, [{ id: 's', type: 'samsloop', position: { x: 200, y: 200 } }]);

    // Build a >2 MB byte blob and feed it through the input. The cap was
    // raised 250 KB → 2 MB, so the blob must exceed 2 MB to trip the gate.
    // The file gate runs BEFORE decodeAudioData so the content can be
    // arbitrary bytes — the size check fires first.
    const pane = await openSamsPane(page);
    const oversizeBytes = Buffer.alloc(2 * 1024 * 1024 + 1, 0);
    await pane.getByTestId('shell-cell-samsloop-wav-input').setInputFiles({
      name: 'oversize.wav',
      mimeType: 'audio/wav',
      buffer: oversizeBytes,
    });

    // The FILE cell's cap carries the refusal (`.err` styling) — the same
    // status element, error-flavoured.
    await expect(pane.getByTestId('shell-cell-samsloop-wav-input-status')).toContainText(
      /too large/i,
      { timeout: 5000 },
    );
    // And nothing was persisted — the upload was rejected (the card-only
    // filename readout died with the card; the Y.Doc is the observable —
    // ⚠ an UPLOAD persists `fileBytesB64`, never `sample`, so that is the
    // key whose absence proves the rejection).
    const stored = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: { fileBytesB64?: unknown; fileName?: unknown } }> };
      };
      const d = w.__patch.nodes['s']?.data ?? {};
      return { bytes: d.fileBytesB64 ?? null, name: d.fileName ?? null };
    });
    expect(stored, 'rejected upload must persist NO file bytes and NO name').toEqual({
      bytes: null,
      name: null,
    });

    // Page-error captures: oversize rejection is a clean user-facing error,
    // not a thrown exception. We allow stderr-level console messages but
    // not uncaught page errors.
    expect(errors.filter((e) => !/too large/i.test(e)), errors.join('; ')).toEqual([]);
  });

  test('idle-by-default: a loaded sample stays SILENT until the TRIGGER button produces audio', async ({ page }) => {
    // SAMSLOOP no longer auto-plays. After a sample loads it sits idle; the
    // on-card TRIGGER button fires a momentary rising edge at the worklet
    // and starts playback (mode-aware). We route samsloop.out → SCOPE.ch1
    // and assert (a) the scope is essentially silent before any trigger,
    // then (b) audio appears after clicking TRIGGER. Renderer-tolerant:
    // we max-hold the scope peak over a window (not a single-instant read)
    // and use a generous floor so SwiftShader/CI software paths still pass
    // — the assertion is "silent vs audible", not an exact level.
    const errors = await setupPage(page);
    await spawnPatch(
      page,
      [
        { id: 's', type: 'samsloop', position: { x: 200, y: 200 }, domain: 'audio', params: { mode: 1 } },
        { id: 'scp', type: 'scope', position: { x: 620, y: 200 }, domain: 'audio' },
      ],
      [
        { id: 'e1', from: { nodeId: 's', portId: 'out' }, to: { nodeId: 'scp', portId: 'ch1' },
          sourceType: 'audio', targetType: 'audio' },
      ],
    );

    // Load the committed test WAV via the dock FILE cell.
    const pane = await openSamsPane(page);
    const wavBytes = readFileSync(WAV_PATH);
    await pane.getByTestId('shell-cell-samsloop-wav-input').setInputFiles({
      name: 'samsloop-test.wav',
      mimeType: 'audio/wav',
      buffer: wavBytes,
    });
    await expect(pane.getByTestId('shell-cell-samsloop-wav-input-status')).toContainText(
      /loaded \d+ samples/i,
      { timeout: 5000 },
    );
    // Give the engine factory's poll (~200ms) time to decode + push the
    // buffer into the worklet so a trigger would actually have audio to play.
    await page.waitForTimeout(600);

    // (a) IDLE-BY-DEFAULT: no trigger yet → the output must be silent.
    const idle = await readScopePeakOverWindow(page, 'scp', 500);
    expect(idle.peak, `idle peak ${idle.peak} (must be ~silent before trigger)`).toBeLessThan(0.02);

    // (b) Click TRIGGER → playback starts (loop mode) → audio appears.
    // (Pane-scoped: the tile ranks the same trigger cell testid.)
    const trigBtn = pane.getByTestId('shell-cell-samsloop-trigger');
    await expect(trigBtn).toBeVisible();
    await trigBtn.click();
    const playing = await readScopePeakOverWindow(page, 'scp', 1200);
    expect(playing.peak, `post-trigger peak ${playing.peak} (must be audible)`).toBeGreaterThan(0.05);

    expect(errors, errors.join('; ')).toEqual([]);
  });
});
