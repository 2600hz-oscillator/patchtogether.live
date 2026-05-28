// e2e/tests/video-orientation.spec.ts
//
// Orientation verification harness for the upside-down-video bug fix.
//
// Uses SHAPES (triangle, apex UP in vUv space) as a known-orientation
// procedural reference. Procedural modules author against vUv directly,
// so a SHAPES triangle defines the canonical "up": its apex sits at high
// vUv.y. With the OUTPUT card's GL-bottom -> screen-bottom present flip,
// an upright triangle has its narrow apex in the TOP half of the
// displayed canvas and its wide base in the BOTTOM half.
//
// We read the displayed card canvas (the exact pixels the user sees) via
// getImageData and compare the bright-pixel centroid / row profile to
// decide which way is up. No baseline images needed — the geometry of a
// triangle is self-describing.

import { test, expect } from '@playwright/test';
import { spawnPatch, type SpawnNode, type SpawnEdge } from './_helpers';

/** Read a card canvas and return, per displayed row band, the count and
 *  mean horizontal spread of bright pixels. A triangle pointing UP (apex
 *  in the top band) has fewer bright pixels + narrower spread up top and
 *  more + wider at the bottom. */
async function analyzeTriangleOrientation(
  page: import('@playwright/test').Page,
  testid: string,
): Promise<{ topBright: number; bottomBright: number; verdict: 'up' | 'down' | 'ambiguous' }> {
  const handle = page.locator(`canvas[data-testid="${testid}"]`);
  await expect(handle, `${testid} present`).toHaveCount(1);
  return await handle.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return { topBright: 0, bottomBright: 0, verdict: 'ambiguous' as const };
    const w = c.width, h = c.height;
    const img = ctx.getImageData(0, 0, w, h).data;
    // Per-row bright-pixel width. For an up-pointing triangle the width
    // grows from near-zero at the apex row to a maximum at the base row.
    // We compare the bright width in the top eighth vs the bottom eighth
    // of the rows that contain content — robust to the small centered
    // shape and to BENTBOX's scanline speckle (threshold filters it).
    const rowW: number[] = new Array(h).fill(0);
    let topBright = 0, bottomBright = 0;
    const half = Math.floor(h / 2);
    for (let y = 0; y < h; y++) {
      let cnt = 0;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const v = (img[i]! + img[i + 1]! + img[i + 2]!) / 3;
        if (v > 90) {
          cnt++;
          if (y < half) topBright++;
          else bottomBright++;
        }
      }
      rowW[y] = cnt;
    }
    // An up-pointing triangle has its narrow apex toward the TOP of the
    // displayed frame and its wide base toward the BOTTOM, so the bottom
    // half carries more bright pixels than the top half. We use the
    // top/bottom bright-pixel counts directly — robust to the small
    // centered shape and to BENTBOX's scanline speckle (the v>90
    // threshold rejects the speckle). The rowW profile is kept for
    // debugging but the count ratio is the decision.
    void rowW;
    let verdict: 'up' | 'down' | 'ambiguous' = 'ambiguous';
    const total = topBright + bottomBright;
    if (total > 100) {
      if (bottomBright > topBright * 1.08) verdict = 'up';
      else if (topBright > bottomBright * 1.08) verdict = 'down';
    }
    return { topBright, bottomBright, verdict };
  });
}

const TRIANGLE_PARAMS = { shape: 2, tile: 0, rotate: 0, zoom: 2.2 };

async function setup(page: import('@playwright/test').Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  return errors;
}

test.describe('video orientation — SHAPES triangle reference', () => {
  test('1. SHAPES(triangle) -> OUTPUT is upright (apex on top)', async ({ page }) => {
    await setup(page);
    await spawnPatch(page,
      [
        { id: 'src', type: 'shapes', position: { x: 40, y: 40 }, domain: 'video', params: TRIANGLE_PARAMS },
        { id: 'out', type: 'videoOut', position: { x: 500, y: 40 }, domain: 'video' },
      ],
      [{ id: 'e1', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' }],
    );
    await page.waitForTimeout(600);
    const r = await analyzeTriangleOrientation(page, 'video-out-canvas');
    await page.screenshot({ path: 'test-results/orient-1-shapes-output.png' });
    expect(r.verdict, `SHAPES->OUTPUT verdict (top=${r.topBright} bottom=${r.bottomBright})`).toBe('up');
  });

  test('2. SHAPES(triangle) -> BENTBOX is upright', async ({ page }) => {
    await setup(page);
    await spawnPatch(page,
      [
        { id: 'src', type: 'shapes', position: { x: 40, y: 40 }, domain: 'video', params: TRIANGLE_PARAMS },
        { id: 'bb', type: 'bentbox', position: { x: 500, y: 40 }, domain: 'video' },
      ],
      [{ id: 'e1', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'bb', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' }],
    );
    await page.waitForTimeout(600);
    const r = await analyzeTriangleOrientation(page, 'bentbox-canvas');
    await page.screenshot({ path: 'test-results/orient-2-shapes-bentbox.png' });
    expect(r.verdict, `SHAPES->BENTBOX verdict (top=${r.topBright} bottom=${r.bottomBright})`).toBe('up');
  });

  test('3. SHAPES(triangle) -> BENTBOX -> OUTPUT is upright', async ({ page }) => {
    await setup(page);
    await spawnPatch(page,
      [
        { id: 'src', type: 'shapes', position: { x: 40, y: 40 }, domain: 'video', params: TRIANGLE_PARAMS },
        { id: 'bb', type: 'bentbox', position: { x: 400, y: 40 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 800, y: 40 }, domain: 'video' },
      ],
      [
        { id: 'e1', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'bb', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e2', from: { nodeId: 'bb', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );
    await page.waitForTimeout(600);
    const r = await analyzeTriangleOrientation(page, 'video-out-canvas');
    await page.screenshot({ path: 'test-results/orient-3-shapes-bentbox-output.png' });
    expect(r.verdict, `SHAPES->BENTBOX->OUTPUT verdict (top=${r.topBright} bottom=${r.bottomBright})`).toBe('up');
  });

  // (Removed) Test 5 injected a synthetic framebuffer through DOOM's
  // pushRemoteFramebuffer/setSpectating spectator-mirror hooks to assert the
  // BGRA top-down → texture upload orientation. That host-framebuffer-over-
  // awareness mirror path was REMOVED (it was the relay-OOM driver), and with
  // it the only public frame-injection hook. The same uploadFramebufferToTexture
  // swizzle now runs only for a peer's OWN live WASM frames (needs the WAD), so
  // DOOM-specific orientation is left to the WASM-gated DOOM e2e specs; the
  // generic top-down upload orientation is still covered by tests 2/3/6 here.

  test('6. CAMERA(injected video, bright TOP) -> OUTPUT shows bright on top', async ({ page }) => {
    // CAMERA uploads a <video> element with UNPACK_FLIP_Y_WEBGL=true.
    // We exercise the REAL <video> upload path (not a synthetic buffer)
    // by attaching a video element whose srcObject is a canvas
    // captureStream painted bright in its TOP half (top-left origin).
    // A correctly-oriented pipeline displays that band at the TOP of
    // OUTPUT. This is the load-bearing DOM-source-orientation guard.
    await setup(page);
    await spawnPatch(page,
      [
        { id: 'cam', type: 'cameraInput', position: { x: 40, y: 40 }, domain: 'video', params: { enabled: 1, mirror: 0 } },
        { id: 'out', type: 'videoOut', position: { x: 600, y: 40 }, domain: 'video' },
      ],
      [{ id: 'e1', from: { nodeId: 'cam', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' }],
    );
    // Let the card's onMount getUserMedia attempt fail + settle first
    // (the default project has no camera device), so it doesn't clobber
    // our injected element afterwards.
    await page.waitForTimeout(600);
    await page.evaluate(async () => {
      const w = globalThis as unknown as {
        __engine?: () => { getDomain: (d: string) => { attachExternalSource: (id: string, k: string, el: HTMLElement | null) => void } } | null;
      };
      const cv = document.createElement('canvas');
      cv.width = 320; cv.height = 240;
      const c = cv.getContext('2d')!;
      const paint = () => {
        c.fillStyle = '#141414'; c.fillRect(0, 0, 320, 240);
        // Top-left origin: y=0..120 is the TOP half. Paint it bright.
        c.fillStyle = '#ffffff'; c.fillRect(0, 0, 320, 120);
        requestAnimationFrame(paint);
      };
      paint();
      const stream = (cv as HTMLCanvasElement).captureStream(30);
      const vid = document.createElement('video');
      vid.muted = true; vid.playsInline = true; vid.autoplay = true;
      vid.srcObject = stream;
      document.body.appendChild(vid);
      await vid.play().catch(() => { /* autoplay fallback */ });
      // Wait for a sampleable frame (readyState >= 2).
      await new Promise<void>((res) => {
        const check = () => { if (vid.readyState >= 2 && vid.videoWidth > 0) res(); else requestAnimationFrame(check); };
        check();
      });
      const ve = w.__engine?.()?.getDomain('video');
      if (!ve) throw new Error('no video engine');
      ve.attachExternalSource('cam', 'video', vid);
      // Keep a reference so GC doesn't reclaim the element/stream mid-test.
      (globalThis as unknown as { __orientVid?: HTMLVideoElement }).__orientVid = vid;
    });
    await page.waitForTimeout(800);
    const rc = await analyzeTriangleOrientation(page, 'video-out-canvas');
    await page.screenshot({ path: 'test-results/orient-6-camera-output.png' });
    expect(rc.topBright, `CAMERA->OUTPUT bright-top should dominate (top=${rc.topBright} bottom=${rc.bottomBright})`)
      .toBeGreaterThan(rc.bottomBright * 1.5);
  });

  test('4. SHAPES(triangle) -> BENTBOX -> BENTBOX -> OUTPUT is upright', async ({ page }) => {
    await setup(page);
    await spawnPatch(page,
      [
        { id: 'src', type: 'shapes', position: { x: 40, y: 40 }, domain: 'video', params: TRIANGLE_PARAMS },
        { id: 'bb1', type: 'bentbox', position: { x: 300, y: 40 }, domain: 'video' },
        { id: 'bb2', type: 'bentbox', position: { x: 600, y: 40 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 900, y: 40 }, domain: 'video' },
      ],
      [
        { id: 'e1', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'bb1', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e2', from: { nodeId: 'bb1', portId: 'out' }, to: { nodeId: 'bb2', portId: 'in' }, sourceType: 'video', targetType: 'video' },
        { id: 'e3', from: { nodeId: 'bb2', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );
    await page.waitForTimeout(600);
    const r = await analyzeTriangleOrientation(page, 'video-out-canvas');
    await page.screenshot({ path: 'test-results/orient-4-shapes-bb-bb-output.png' });
    expect(r.verdict, `SHAPES->BB->BB->OUTPUT verdict (top=${r.topBright} bottom=${r.bottomBright})`).toBe('up');
  });

  test('7. SHAPES(triangle) -> RUTTETRA is upright (apex on top)', async ({ page }) => {
    // RUTTETRA samples its input in a custom VERTEX shader and lays the
    // grid out directly in NDC. With its input sample Y-flipped to match
    // the engine's UNPACK_FLIP_Y_WEBGL convention (the same convention the
    // fullscreen-quad modules sample under), an up-pointing triangle must
    // render with its narrow apex in the TOP half — like every sibling.
    // Disp params are zeroed so the raster is a clean 1:1 luma map and the
    // verdict isolates ORIENTATION (not the luma heightmap displacement).
    await setup(page);
    await spawnPatch(page,
      [
        { id: 'src', type: 'shapes', position: { x: 40, y: 40 }, domain: 'video', params: TRIANGLE_PARAMS },
        { id: 're', type: 'ruttetra', position: { x: 500, y: 40 }, domain: 'video', params: { xDisp: 0, yDisp: 0, xShape: 0, yShape: 0 } },
      ],
      [{ id: 'e1', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 're', portId: 'z' }, sourceType: 'mono-video', targetType: 'video' }],
    );
    await page.waitForTimeout(600);
    const r = await analyzeTriangleOrientation(page, 'ruttetra-canvas');
    await page.screenshot({ path: 'test-results/orient-7-shapes-ruttetra.png' });
    expect(r.verdict, `SHAPES->RUTTETRA verdict (top=${r.topBright} bottom=${r.bottomBright})`).toBe('up');
  });
});
