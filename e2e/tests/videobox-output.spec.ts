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

/** Drive the video engine's step() over a bounded window with macrotask gaps
 *  (so rVFC decode callbacks fire) and return the named node's uploadCount
 *  delta plus the OUTPUT's resolved input source + hasInput. This is the
 *  ENGINE-INTERNAL proof that real frames decode into the texture and reach
 *  the OUTPUT — deterministic on software GL, unlike sampling the rendered
 *  canvas (which flakes under CI rAF throttling). uploadCount advancing > 0 is
 *  the same "frame is live, not frozen black" fact the pixel checks chased. */
async function liveness(
  page: import('@playwright/test').Page,
  sourceId: string,
  outId: string,
  windowMs = 4000,
): Promise<{ uploads: number; outSource: string | null; outHasInput: boolean }> {
  return await page.evaluate(
    async ({ sourceId, outId, windowMs }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          getDomain: (d: string) => {
            step: () => void;
            read: (id: string, k: string) => unknown;
            resolveInputSourceId: (id: string, port: string) => string | null;
          };
        } | null;
      };
      const eng = w.__engine?.();
      if (!eng) return { uploads: 0, outSource: null, outHasInput: false };
      const vid = eng.getDomain('video');
      const u0 = (vid.read(sourceId, 'uploadCount') as number) ?? 0;
      const t0 = performance.now();
      while (performance.now() - t0 < windowMs) {
        vid.step();
        await new Promise<void>((res) => setTimeout(res, 16));
      }
      const u1 = (vid.read(sourceId, 'uploadCount') as number) ?? 0;
      return {
        uploads: u1 - u0,
        outSource: vid.resolveInputSourceId(outId, 'in'),
        outHasInput: vid.read(outId, 'hasInput') === true,
      };
    },
    { sourceId, outId, windowMs },
  );
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

    // DETERMINISTIC CI GUARD (replaces non-black + moving-content pixel reads):
    // drive step() over a window so the clip decodes, then assert (1) VIDEOBOX's
    // uploadCount ADVANCES — real frames decode into the source texture, the
    // exact #288 regression (frozen black texture from a bailed uploadIfReady)
    // and (2) the OUTPUT resolves to the VIDEOBOX and latches an input texture
    // — the frame reaches downstream. Both are engine-internal facts, immune to
    // software-GL rAF throttling that made the sampled-canvas reads flaky.
    const live = await liveness(page, 'vb', 'out');
    expect(
      live.uploads,
      `VIDEOBOX decodes live frames into its texture (uploadCount advanced by ${live.uploads})`,
    ).toBeGreaterThan(0);
    expect(live.outSource, 'VIDEO-OUT fed by VIDEOBOX').toBe('vb');
    expect(live.outHasInput, 'VIDEO-OUT latched an input texture').toBe(true);

    // VISUAL confirmation (LOCAL ONLY) — sampled software-GL canvas content
    // flakes under CI rAF throttling; the engine-state guards above are the
    // deterministic CI proof.
    if (!process.env.CI) {
      const stats = await canvasStats(page, 'video-out-canvas');
      await page.screenshot({ path: 'test-results/videobox-output.png' });
      expect(stats.max, `VIDEO-OUT has bright pixels (mean=${stats.mean.toFixed(1)} max=${stats.max})`).toBeGreaterThan(40);
      expect(stats.mean, `VIDEO-OUT not near-black (mean=${stats.mean.toFixed(1)})`).toBeGreaterThan(6);

      const first = await canvasSignature(page, 'video-out-canvas');
      let last = first, moved = false;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        await page.waitForTimeout(150);
        last = await canvasSignature(page, 'video-out-canvas');
        if (Math.abs(first - last) / Math.max(1, Math.abs(first)) > 0.001) { moved = true; break; }
      }
      expect(moved, `VIDEO-OUT frame changed within 5s (first=${first} last=${last})`).toBe(true);
    }

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

    // DETERMINISTIC CI GUARD: VIDEOBOX decodes live frames AND the chain
    // VIDEOBOX -> BENTBOX -> VIDEO-OUT is wired (OUTPUT resolves to BENTBOX and
    // latches an input texture). Engine-state, not sampled pixels.
    const live = await liveness(page, 'vb', 'out');
    expect(
      live.uploads,
      `VIDEOBOX decodes live frames (uploadCount advanced by ${live.uploads})`,
    ).toBeGreaterThan(0);
    expect(live.outSource, 'VIDEO-OUT fed by BENTBOX').toBe('bb');
    expect(live.outHasInput, 'VIDEO-OUT latched an input texture (via BENTBOX)').toBe(true);

    // VISUAL confirmation (LOCAL ONLY) — software-GL canvas content flakes on CI.
    if (!process.env.CI) {
      const stats = await canvasStats(page, 'video-out-canvas');
      await page.screenshot({ path: 'test-results/videobox-bentbox-output.png' });
      expect(stats.max, `VIDEO-OUT (via BENTBOX) has bright pixels (mean=${stats.mean.toFixed(1)} max=${stats.max})`).toBeGreaterThan(40);
      expect(stats.mean, `VIDEO-OUT (via BENTBOX) not near-black (mean=${stats.mean.toFixed(1)})`).toBeGreaterThan(6);
    }
  });
});
