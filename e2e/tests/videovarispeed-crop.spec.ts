// e2e/tests/videovarispeed-crop.spec.ts
//
// VIDEOVARISPEED CROP output coverage. Proves the new `crop` video output +
// "add crop" overlay end-to-end:
//   • the crop output is a DISTINCT texture that routes to a downstream videoOut;
//   • passthrough by default (crop ≈ the full VIDEO frame) — never black;
//   • "add crop" makes it active; the overlay rect the card RENDERS equals the
//     stored normalized node.data.crop (UI-can't-lie);
//   • the crop rect actually WINDOWS the output — two very different crop regions
//     yield structurally different downstream frames;
//   • "remove crop" restores full-frame passthrough.
//
// Renderer-tolerant per the SwiftShader standard: the deterministic anchors
// (cropActive toggle, texture distinctness, DOM-rect == stored, non-black +
// structured) are renderer-independent; the windowing claim compares two crop
// regions with a generous structural threshold rather than exact pixels.
//
// The crop output is in the heavy-WebGL lane (**/videovarispeed-*.spec.ts).

import { test, expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { spawnPatch } from './_helpers';
import { stepAndReadStats, type RenderStats } from './_render-smoke';

const FIXTURE = fileURLToPath(new URL('../fixtures/lobby-clip.webm', import.meta.url));

async function setup(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  return errors;
}

/** Set node.data.crop deterministically (bypassing a pointer drag) via the
 *  dev-mode Y.Doc hook — the same store the card reads reactively. */
async function setCrop(
  page: Page,
  nodeId: string,
  crop: { active: boolean; x: number; y: number; w: number },
): Promise<void> {
  await page.evaluate(({ nodeId, crop }) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes[nodeId];
      if (n) { if (!n.data) n.data = {}; n.data.crop = crop; }
    });
  }, { nodeId, crop });
}

/** Read a video node's engine `read(key)` hook. */
async function engineRead(page: Page, nodeId: string, key: string): Promise<unknown> {
  return page.evaluate(({ nodeId, key }) => {
    const w = globalThis as unknown as {
      __engine: () => { getDomain: (d: string) => { read: (id: string, k: string) => unknown } };
    };
    return w.__engine().getDomain('video').read(nodeId, key);
  }, { nodeId, key });
}

/** True iff the node's `crop` output texture is a distinct, non-null object from
 *  its `video` output texture (the crop pass has its own FBO). */
async function cropTextureIsDistinct(page: Page, nodeId: string): Promise<boolean> {
  return page.evaluate(({ nodeId }) => {
    const w = globalThis as unknown as {
      __engine: () => { getDomain: (d: string) => {
        outputTexture: (id: string, port?: string) => WebGLTexture | null;
      } };
    };
    const vid = w.__engine().getDomain('video');
    const video = vid.outputTexture(nodeId, 'video');
    const crop = vid.outputTexture(nodeId, 'crop');
    return crop !== null && video !== null && crop !== video;
  }, { nodeId });
}

/** Load the fixture into a VIDEOVARISPEED card + start playback, then wait for a
 *  real decoded frame to have been uploaded (the crop pass samples that frame). */
async function loadAndPlay(page: Page, vvId: string): Promise<void> {
  await page.setInputFiles('[data-testid="videovarispeed-file-input"]', FIXTURE);
  await expect(page.locator('[data-testid="videovarispeed-card"]')).toHaveAttribute(
    'data-has-local-file', 'true', { timeout: 8000 },
  );
  await page.click('[data-testid="videovarispeed-play-btn"]');
  await expect(page.locator('[data-testid="videovarispeed-card"]')).toHaveAttribute(
    'data-is-playing', 'true', { timeout: 4000 },
  );
  // Wait until at least one real frame has been uploaded (decode→texture path).
  await expect
    .poll(async () => Number(await engineRead(page, vvId, 'uploadCount')), { timeout: 8000 })
    .toBeGreaterThan(0);
}

/** Read the downstream videoOut's rendered stats (structural — no frame-delta
 *  assert since the engine loop runs live here). */
async function outStats(page: Page, outId: string): Promise<RenderStats> {
  return stepAndReadStats(page, { nodeId: outId, steps: 6 });
}

test.describe('VIDEOVARISPEED crop output', () => {
  test('crop output routes downstream, windows the frame, and the overlay is truthful', async ({ page }) => {
    const errors = await setup(page);
    await spawnPatch(
      page,
      [
        { id: 'vv',  type: 'videovarispeed', position: { x: 40,  y: 40 }, domain: 'video' },
        { id: 'out', type: 'videoOut',       position: { x: 560, y: 40 }, domain: 'video' },
      ],
      // The CROP output drives the downstream videoOut (proves per-port routing).
      [{ id: 'e1', from: { nodeId: 'vv', portId: 'crop' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' }],
    );

    await loadAndPlay(page, 'vv');
    await page.waitForTimeout(400);

    // ── Deterministic anchor: the crop output is its own texture. ──
    expect(await cropTextureIsDistinct(page, 'vv'), 'crop output is a distinct texture from video').toBe(true);
    expect(await engineRead(page, 'vv', 'cropActive'), 'no crop yet ⇒ passthrough').toBe(false);

    // ── Passthrough: the downstream (crop) videoOut shows a real structured frame. ──
    const passthrough = await outStats(page, 'out');
    expect(passthrough.fbComplete, 'crop→videoOut FBO readable').toBe(true);
    expect(passthrough.glErrors, `GL errors: [${passthrough.glErrors.join(',')}]`).toEqual([]);
    expect(passthrough.nonZeroFrac, 'crop passthrough is not all-black').toBeGreaterThan(0.02);
    expect(passthrough.variance, 'crop passthrough has spatial structure').toBeGreaterThan(15);

    // ── "add crop" → active + the editor overlay appears. ──
    await page.click('[data-testid="videovarispeed-add-crop"]');
    await expect.poll(async () => await engineRead(page, 'vv', 'cropActive'), { timeout: 3000 }).toBe(true);
    await expect(page.locator('[data-testid="crop-overlay"]')).toBeVisible();

    // ── UI-can't-lie: set a specific rect; the rendered overlay rect === stored. ──
    const rectTL = { active: true, x: 0.02, y: 0.02, w: 0.28 };
    await setCrop(page, 'vv', rectTL);
    const rectEl = page.locator('[data-testid="crop-rect"]');
    await expect(rectEl).toBeVisible();
    await expect.poll(async () => Number(await rectEl.getAttribute('data-x'))).toBeCloseTo(rectTL.x, 3);
    expect(Number(await rectEl.getAttribute('data-y'))).toBeCloseTo(rectTL.y, 3);
    expect(Number(await rectEl.getAttribute('data-w'))).toBeCloseTo(rectTL.w, 3);
    // height is derived (aspect-locked ⇒ h === w for videovarispeed's frame).
    expect(Number(await rectEl.getAttribute('data-h'))).toBeCloseTo(rectTL.w, 3);

    // crop output still renders a real frame while cropped.
    const croppedTL = await outStats(page, 'out');
    expect(croppedTL.nonZeroFrac, 'cropped output is not all-black').toBeGreaterThan(0.02);

    // ── Windowing: a very different crop region yields a structurally different
    //    downstream frame (renderer-tolerant: compares luma stats, not pixels). ──
    await setCrop(page, 'vv', { active: true, x: 0.70, y: 0.70, w: 0.28 });
    await page.waitForTimeout(300);
    const croppedBR = await outStats(page, 'out');
    const meanDelta = Math.abs(croppedBR.mean - croppedTL.mean);
    const varDelta = Math.abs(croppedBR.variance - croppedTL.variance);
    const nzDelta = Math.abs(croppedBR.nonZeroFrac - croppedTL.nonZeroFrac);
    expect(
      meanDelta > 3 || varDelta > 8 || nzDelta > 0.03,
      `two crop regions differ structurally (Δmean=${meanDelta.toFixed(1)} Δvar=${varDelta.toFixed(1)} Δnz=${nzDelta.toFixed(3)})`,
    ).toBe(true);

    // ── "remove crop" → passthrough restored (active false, still streaming). ──
    await page.click('[data-testid="videovarispeed-remove-crop"]');
    await expect.poll(async () => await engineRead(page, 'vv', 'cropActive'), { timeout: 3000 }).toBe(false);
    await expect(page.locator('[data-testid="crop-overlay"]')).toHaveCount(0);
    const restored = await outStats(page, 'out');
    expect(restored.nonZeroFrac, 'passthrough restored — still streaming').toBeGreaterThan(0.02);
    expect(restored.variance, 'passthrough restored — structured').toBeGreaterThan(15);

    expect(errors, `no page errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
