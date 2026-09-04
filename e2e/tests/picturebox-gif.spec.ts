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

/** Open PICTUREBOX's dock full-view pane (the picker + preview canvas are
 *  `fullViewBody` — dock-only) and return the PANE locator. */
async function openPbPane(page: Page, id: string) {
  await page.waitForFunction(
    () =>
      typeof (globalThis as unknown as { __openDockFullView?: unknown }).__openDockFullView ===
      'function',
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(
    (i) => (globalThis as unknown as { __openDockFullView: (x: string) => void }).__openDockFullView(i),
    id,
  );
  const pane = page.locator(`[data-testid="dock-fullview-pane"][data-pane-node="${id}"]`);
  await expect(pane.getByTestId('picturebox-assets-body')).toBeVisible({ timeout: 60_000 });
  return pane;
}

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
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  return errors;
}

/** Mean luminance of PICTUREBOX's output frame, read at the ENGINE seam
 *  (`vid.outputTexture(nodeId, 'out')` + readPixels — the shell-agnostic
 *  instrument; the card-era probe read the VIDEO-OUT card canvas, which does
 *  not mount on the default shell). The downstream VIDEO-OUT displays exactly
 *  this texture. */
async function meanLuma(page: Page, nodeId: string): Promise<number> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        getDomain: (d: string) => {
          gl: WebGL2RenderingContext;
          outputTexture: (n: string, port?: string) => WebGLTexture | null;
          res: { width: number; height: number };
        };
      } | null;
    };
    const eng = w.__engine?.();
    if (!eng) return 0;
    const vid = eng.getDomain('video');
    const gl = vid.gl;
    const tex = vid.outputTexture(id, 'out');
    if (!tex) return 0;
    const { width: W, height: H } = vid.res;
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    const px = new Uint8Array(W * H * 4);
    if (complete) gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < px.length; i += 4 * 16) {
      sum += (px[i]! + px[i + 1]! + px[i + 2]!) / 3;
      n++;
    }
    return n ? sum / n : 0;
  }, nodeId);
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

    // REAL chain: pick the fixture gif through the face's file input (dock pane).
    const pane = await openPbPane(page, 'pb');
    await pane.locator('[data-testid="picturebox-face-file-input"]').setInputFiles(GIF_FIXTURE);

    // The face registers the image (bytes on node.data → data-has-image, which
    // lives on the face CANVAS, not the body root).
    await expect(pane.locator('[data-testid="picturebox-face-canvas"]')).toHaveAttribute(
      'data-has-image',
      'true',
      { timeout: 10_000 },
    );
    // It surfaces as a gif (mime propagated), not a flattened jpeg. The card's
    // painted 'gif' state word is deleted under the resting-text ruling; the
    // fact moved to the picture's accessible name ("an animated gif preserved
    // frame-for-frame"), where face specs already read state.
    await expect(pane.locator('[data-testid="picturebox-face-canvas"]')).toHaveAttribute(
      'aria-label', /animated gif/, { timeout: 10_000 },
    );

    // The output must SWING between the fixture's bright + dark frames. The gif
    // is 4 frames × 80ms = 320ms/loop; sample across ~1.4s so we straddle
    // multiple frames regardless of rAF cadence.
    const { min, max, samples } = await sampleLumaOverTime(page, 'pb', 1400);
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

    const pane = await openPbPane(page, 'pb');
    await pane.locator('[data-testid="picturebox-face-file-input"]').setInputFiles({
      name: 'white.png',
      mimeType: 'image/png',
      buffer: WHITE_PNG,
    });

    await expect(pane.locator('[data-testid="picturebox-face-canvas"]')).toHaveAttribute(
      'data-has-image',
      'true',
      { timeout: 10_000 },
    );
    // A non-gif → the still JPEG path: the accessible name says "synced at
    // W×H", never "animated gif" (the resting-text ruling's aria home).
    await expect(pane.locator('[data-testid="picturebox-face-canvas"]')).toHaveAttribute(
      'aria-label', /synced at/, { timeout: 10_000 },
    );

    // Wait for the bright still to reach the output, then confirm it's STABLE
    // (a still must not animate): two reads ~700ms apart barely differ.
    await expect
      .poll(async () => await meanLuma(page, 'pb'), { timeout: 8000 })
      .toBeGreaterThan(120);
    const a = await meanLuma(page, 'pb');
    await page.waitForTimeout(700);
    const b = await meanLuma(page, 'pb');
    expect(Math.abs(a - b), `static output stable over time (a=${a.toFixed(1)} b=${b.toFixed(1)})`).toBeLessThan(20);

    expect(errors, `no page errors: ${errors.join('; ')}`).toEqual([]);
  });
});
