// e2e/tests/videobox-output.spec.ts
//
// VIDEOBOX output-reaches-downstream coverage.
//
// Regression guard for the bug where a VIDEOBOX whose card preview played
// fine still emitted a BLACK frame on its `video` output port — so
// VIDEOBOX.video -> VIDEO-OUT (and -> BENTBOX -> VIDEO-OUT) showed nothing.
//
// Root cause was the card-owned <video> only ever decoded frames while
// PLAYING; when the engine sampled it for the `out` texture the element was
// paused at readyState 1 (HAVE_METADATA, no decoded frame), so uploadIfReady
// bailed and the FBO stayed at its idle pattern. The fix forces a first-frame
// decode + samples the element every engine frame regardless of play state.
//
// We drive the REAL file -> <video> -> GL-texture path (no synthetic buffer):
// load a small local .webm via setInputFiles, patch the output, and assert the
// downstream VIDEO-OUT canvas shows (a) non-black content and (b) frame-to-
// frame change while the video plays (the clip is moving footage).

import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { spawnPatch } from './_helpers';

const FIXTURE = fileURLToPath(new URL('../fixtures/lobby-clip.webm', import.meta.url));

async function setup(page: import('@playwright/test').Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  return errors;
}

/** Mean luminance + per-channel max over a card canvas. */
async function canvasStats(
  page: import('@playwright/test').Page,
  testid: string,
): Promise<{ mean: number; max: number }> {
  const handle = page.locator(`canvas[data-testid="${testid}"]`);
  await expect(handle, `${testid} present`).toHaveCount(1);
  return await handle.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return { mean: 0, max: 0 };
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let sum = 0, max = 0;
    for (let i = 0; i < data.length; i += 4) {
      const v = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
      sum += v;
      if (v > max) max = v;
    }
    return { mean: sum / (data.length / 4), max };
  });
}

/** A signature of the canvas pixels for change detection — sum of a coarse
 *  pixel sample. Two reads with a meaningfully different signature mean the
 *  frame content changed (the video is moving). */
async function canvasSignature(
  page: import('@playwright/test').Page,
  testid: string,
): Promise<number> {
  const handle = page.locator(`canvas[data-testid="${testid}"]`);
  return await handle.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return 0;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    // Sample every 64th pixel weighted by index so spatial movement shifts
    // the signature even if total luminance stays roughly constant.
    let sig = 0;
    for (let i = 0; i < data.length; i += 256) {
      sig += (data[i]! + data[i + 1]! * 2 + data[i + 2]! * 3) * ((i % 997) + 1);
    }
    return sig;
  });
}

/** Load the fixture into a VIDEOBOX card via its hidden file input, wait for
 *  the element to have a decoded frame, and start playback. */
async function loadAndPlay(page: import('@playwright/test').Page) {
  await page.setInputFiles('[data-testid="videobox-file-input"]', FIXTURE);
  // Wait for the card to register a local file (data-has-local-file flips).
  await expect(page.locator('[data-testid="videobox-card"]')).toHaveAttribute(
    'data-has-local-file', 'true', { timeout: 8000 },
  );
  // Start playback (the clip is moving footage; we want frame-to-frame change).
  await page.click('[data-testid="videobox-play-btn"]');
  await expect(page.locator('[data-testid="videobox-card"]')).toHaveAttribute(
    'data-is-playing', 'true', { timeout: 4000 },
  );
}

test.describe('VIDEOBOX video output reaches downstream', () => {
  test('VIDEOBOX.video -> VIDEO-OUT shows non-black, moving content', async ({ page }) => {
    const errors = await setup(page);
    await spawnPatch(page,
      [
        { id: 'vb',  type: 'videobox', position: { x: 40,  y: 40 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 560, y: 40 }, domain: 'video' },
      ],
      [{ id: 'e1', from: { nodeId: 'vb', portId: 'video' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' }],
    );

    await loadAndPlay(page);
    await page.waitForTimeout(800);

    // (a) Non-black: a real frame must reach the output canvas.
    const stats = await canvasStats(page, 'video-out-canvas');
    await page.screenshot({ path: 'test-results/videobox-output.png' });
    expect(stats.max, `VIDEO-OUT has bright pixels (mean=${stats.mean.toFixed(1)} max=${stats.max})`).toBeGreaterThan(40);
    expect(stats.mean, `VIDEO-OUT not near-black (mean=${stats.mean.toFixed(1)})`).toBeGreaterThan(6);

    // (b) Moving: the clip plays, so the output frame must change. Poll a
    //     window rather than comparing two fixed reads — under CI load the
    //     rVFC-driven (~30fps as of #297) decode can stall, landing two close
    //     reads on the same decoded frame and falsely failing. Sample until a
    //     change beyond threshold is seen (early-out) or the deadline passes; a
    //     genuinely frozen/black output never changes and still fails (the #288
    //     regression guard is preserved).
    const first = await canvasSignature(page, 'video-out-canvas');
    let last = first, moved = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(150);
      last = await canvasSignature(page, 'video-out-canvas');
      if (Math.abs(first - last) / Math.max(1, Math.abs(first)) > 0.001) { moved = true; break; }
    }
    expect(moved, `VIDEO-OUT frame changed within 5s (first=${first} last=${last})`).toBe(true);

    expect(errors, `no page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('VIDEOBOX.video -> BENTBOX -> VIDEO-OUT shows content', async ({ page }) => {
    await setup(page);
    await spawnPatch(page,
      [
        { id: 'vb',  type: 'videobox', position: { x: 40,  y: 40 }, domain: 'video' },
        { id: 'bb',  type: 'bentbox',  position: { x: 420, y: 40 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 820, y: 40 }, domain: 'video' },
      ],
      [
        { id: 'e1', from: { nodeId: 'vb', portId: 'video' }, to: { nodeId: 'bb',  portId: 'in' }, sourceType: 'video', targetType: 'video' },
        { id: 'e2', from: { nodeId: 'bb', portId: 'out' },   to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );

    await loadAndPlay(page);
    await page.waitForTimeout(900);

    const stats = await canvasStats(page, 'video-out-canvas');
    await page.screenshot({ path: 'test-results/videobox-bentbox-output.png' });
    expect(stats.max, `VIDEO-OUT (via BENTBOX) has bright pixels (mean=${stats.mean.toFixed(1)} max=${stats.max})`).toBeGreaterThan(40);
    expect(stats.mean, `VIDEO-OUT (via BENTBOX) not near-black (mean=${stats.mean.toFixed(1)})`).toBeGreaterThan(6);
  });
});
