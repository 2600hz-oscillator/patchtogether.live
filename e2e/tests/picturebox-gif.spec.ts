// e2e/tests/picturebox-gif.spec.ts
//
// PICTUREBOX animated-GIF support — the REAL chain:
//   setInputFiles(<the committed fixture gif>) → onFileChange → encodePickedFile
//   (byte-preserving) → Y.Doc → applyBytesToEngine → decodeAnimatedGif
//   (WebCodecs) → module frame scheduling → OUTPUT canvas.
//
// We assert the downstream VIDEO-OUT OUTPUT ANIMATES: sampling its mean luma
// across time yields BOTH a bright and a dark reading (the fixture alternates
// solid white/black frames), so max−min swings hard — renderer-tolerant, no
// sub-pixel precision, SwiftShader-safe. The animation assertion is GATED on a
// runtime ImageDecoder('image/gif') capability probe (skips where WebCodecs is
// unavailable — the app degrades to a static first frame there, no error).
//
// A second test loads a STATIC image (regression): the output renders and is
// STABLE over time (a still must NOT animate).
//
// Image-domain only (no H.264 encoder / getUserMedia), so it runs in the
// parallel sharded matrix under SwiftShader — NOT the real-GPU attest lane
// (picturebox-* is not a heavy WebGL glob).

import { test, expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { spawnPatch } from './_helpers';

const GIF_FIXTURE = fileURLToPath(new URL('../fixtures/animated-test.gif', import.meta.url));

// A solid-white 32×32 PNG (generated via sharp) — the static-image regression
// source. encodePickedFile takes the JPEG path for a non-gif, so downstream
// luma is high + steady.
const WHITE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAMUlEQVR4nO3QMQ0AAAjAMPybBgm7+FoDSzb7bASKRcmiZFGyKFmULEoWJYuSRel90QGLVfSm++z7fAAAAABJRU5ErkJggg==',
  'base64',
);

async function setup(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  return errors;
}

/** Mean luminance over a VIDEO-OUT canvas (by node id). */
async function meanLuma(page: Page, nodeId: string): Promise<number> {
  const handle = page.locator(`canvas[data-testid="video-out-canvas"][data-node-id="${nodeId}"]`);
  await expect(handle, `VIDEO-OUT ${nodeId} canvas present`).toHaveCount(1);
  return await handle.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return 0;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
    return sum / (data.length / 4);
  });
}

/** Does this runtime decode animated gifs (WebCodecs ImageDecoder)? */
async function gifDecodeSupported(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    const ID = (globalThis as { ImageDecoder?: { isTypeSupported: (t: string) => Promise<boolean> } }).ImageDecoder;
    if (!ID || typeof ID.isTypeSupported !== 'function') return false;
    try { return await ID.isTypeSupported('image/gif'); } catch { return false; }
  });
}

/** Sample mean luma repeatedly over `durationMs`, returning {min,max,samples}. */
async function sampleLumaOverTime(
  page: Page,
  nodeId: string,
  durationMs: number,
  everyMs = 60,
): Promise<{ min: number; max: number; samples: number[] }> {
  const samples: number[] = [];
  const deadline = Date.now() + durationMs;
  do {
    samples.push(await meanLuma(page, nodeId));
    await page.waitForTimeout(everyMs);
  } while (Date.now() < deadline);
  return { min: Math.min(...samples), max: Math.max(...samples), samples };
}

test.describe('PICTUREBOX — animated gif', () => {
  test('an animated gif loaded via the file picker ANIMATES the video output', async ({ page }) => {
    const errors = await setup(page);
    const supported = await gifDecodeSupported(page);
    test.skip(!supported, 'WebCodecs ImageDecoder(image/gif) unavailable — app degrades to a static first frame here');

    await spawnPatch(
      page,
      [
        { id: 'pb', type: 'picturebox', position: { x: 60, y: 60 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 520, y: 60 }, domain: 'video' },
      ],
      [
        { id: 'e_out', from: { nodeId: 'pb', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'image', targetType: 'video' },
      ],
    );

    // REAL chain: pick the fixture gif through the card's file input.
    await page.locator('[data-testid="picturebox-file-input"]').setInputFiles(GIF_FIXTURE);

    // Card registers the image (bytes on node.data → data-has-image).
    await expect(page.locator('[data-testid="picturebox-card"]')).toHaveAttribute(
      'data-has-image',
      'true',
      { timeout: 10_000 },
    );
    // The card surfaces it as a gif (mime propagated), not a flattened jpeg.
    await expect(page.locator('[data-testid="picturebox-synced"]')).toHaveText('gif', { timeout: 10_000 });

    // The output must SWING between the fixture's bright + dark frames. The gif
    // is 4 frames × 80ms = 320ms/loop; sample across ~1.4s so we straddle
    // multiple frames regardless of rAF cadence.
    const { min, max, samples } = await sampleLumaOverTime(page, 'out', 1400);
    expect(
      max - min,
      `output luma must swing over time (animation): min=${min.toFixed(1)} max=${max.toFixed(1)} n=${samples.length}`,
    ).toBeGreaterThan(60);
    // Sanity: we actually saw a bright frame and a dark frame (not just noise).
    expect(max, 'saw a bright frame').toBeGreaterThan(120);
    expect(min, 'saw a dark frame').toBeLessThan(90);

    expect(errors, `no page errors: ${errors.join('; ')}`).toEqual([]);
  });

  test('a static image renders and does NOT animate (regression)', async ({ page }) => {
    const errors = await setup(page);

    await spawnPatch(
      page,
      [
        { id: 'pb', type: 'picturebox', position: { x: 60, y: 60 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 520, y: 60 }, domain: 'video' },
      ],
      [
        { id: 'e_out', from: { nodeId: 'pb', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'image', targetType: 'video' },
      ],
    );

    await page.locator('[data-testid="picturebox-file-input"]').setInputFiles({
      name: 'white.png',
      mimeType: 'image/png',
      buffer: WHITE_PNG,
    });

    await expect(page.locator('[data-testid="picturebox-card"]')).toHaveAttribute(
      'data-has-image',
      'true',
      { timeout: 10_000 },
    );
    // A non-gif → the still JPEG path (not 'gif').
    await expect(page.locator('[data-testid="picturebox-synced"]')).not.toHaveText('gif', { timeout: 10_000 });

    // Wait for the bright still to reach the output, then confirm it's STABLE
    // (a still must not animate): two reads ~700ms apart barely differ.
    await expect
      .poll(async () => await meanLuma(page, 'out'), { timeout: 8000 })
      .toBeGreaterThan(120);
    const a = await meanLuma(page, 'out');
    await page.waitForTimeout(700);
    const b = await meanLuma(page, 'out');
    expect(Math.abs(a - b), `static output stable over time (a=${a.toFixed(1)} b=${b.toFixed(1)})`).toBeLessThan(20);

    expect(errors, `no page errors: ${errors.join('; ')}`).toEqual([]);
  });
});
