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
//
// DETERMINISTIC RENDER-SMOKE (DRS) conversion (plan §3 / Layer B):
// orientation is GEOMETRIC and fully deterministic once the engine is
// frozen — a static triangle stays apex-up regardless of how many frames
// elapse. So instead of `spawn -> waitForTimeout(N) -> read the displayed
// canvas once and hope enough rAF + present blits happened` (the flaky
// wall-clock sample), every SHAPES/transform/source test now:
//
//   1. installRenderSmokeHooks() BEFORE goto: PAUSE the engine rAF loop
//      (the test owns the exact engine frame count) + PIN the engine clock
//      (a time-animated source draws an identical frame every step).
//   2. spawn the deterministic SHAPES triangle -> module.
//   3. stepEngineFrames(): drive engine.step() a FIXED number of times
//      SYNCHRONOUSLY (the engine loop is paused, so the test must drive it
//      itself) — the module's output FBO now holds the FROZEN frame.
//   4. settleFrozenCanvas(): the per-card present blit runs on the CARD's
//      OWN rAF (independent of the paused engine loop), so wait — bounded,
//      on RENDERED STATE not a fixed budget — until the displayed canvas
//      has converged to non-black content that is STABLE across two reads.
//      Because the underlying engine frame is frozen, the only content the
//      card can ever blit is the frozen one, so this converges
//      deterministically (no "mid-paint wrong content" race).
//   5. analyzeTriangleOrientation() on the now-frozen displayed canvas.
//
// EXCEPTION — BENTBOX is NOT frame.time-deterministic: its CRT shader reads
// `performance.now()` directly for its scanline/chroma/noise drift (see
// bentbox.ts uTime = (performance.now() - startWallMs)/1000), so the engine
// freeze hook (which only pins `frame.time`) does NOT freeze it. Fixing that
// is a MODULE-SOURCE change (give BENTBOX its own clock-freeze hook), which
// this test-only conversion must not make. The BENTBOX-output tests (2/3/4)
// are therefore LEFT on the wall-clock sample + noted for a later hands-on
// pass. (Their orientation verdict is robust to the wall-clock jitter — the
// v>90 threshold rejects the scanline speckle and the apex-up geometry is
// time-invariant — so they remain meaningful, just not bit-frozen.)

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';

const FIXED_STEPS = 6;

/** Minimum bright-pixel count (luma > 90) for the frame to HAVE an orientation
 *  at all. Below this there is nothing to be the right way up, and any verdict
 *  is fiction — see the assertion in analyzeTriangleOrientation. One constant,
 *  used both to gate the verdict and to refuse the empty frame, so the two can
 *  never drift into disagreeing the way the settle threshold did. */
const MIN_BRIGHT_TOTAL = 100;

/** Drive the video engine `steps` frames SYNCHRONOUSLY (one evaluate, no
 *  yield). The engine rAF loop is paused by installRenderSmokeHooks, so the
 *  test owns the exact frame count; this leaves the module's output FBO
 *  holding the FROZEN frame. Returns the engine frame-count delta so callers
 *  can assert the loop really was paused (delta === steps). */
async function stepEngineFrames(page: Page, steps: number): Promise<number> {
  return page.evaluate((n) => {
    const w = globalThis as unknown as {
      __engine: () => {
        getDomain: (d: string) => { step: () => void; currentFrameCount: () => number };
      };
    };
    const vid = w.__engine().getDomain('video');
    const before = vid.currentFrameCount();
    for (let i = 0; i < n; i++) vid.step();
    return vid.currentFrameCount() - before;
  }, steps);
}

/** Wait — BOUNDED, on RENDERED STATE (not a fixed wall-clock budget) — until
 *  the displayed card canvas has converged to non-black content that is STABLE
 *  across two consecutive reads. The card's present blit runs on its OWN rAF
 *  (independent of the paused engine loop), so this absorbs the present cadence
 *  deterministically: the engine frame is frozen, so the only content the card
 *  can ever blit is the frozen one — the condition can only flip false->true and
 *  stay true (no "mid-paint wrong frame" race). Re-drives a single engine step
 *  each poll so a not-yet-rendered FBO gets filled. */
async function settleFrozenCanvas(page: Page, testid: string): Promise<void> {
  const handle = page.locator(`canvas[data-testid="${testid}"]`);
  await expect(handle, `${testid} present`).toHaveCount(1);
  // Re-step once between polls so the (paused) engine keeps publishing the
  // frozen FBO while the card's present rAF picks it up; convergence is on the
  // canvas having stable non-black content, never on elapsed time.
  await expect
    .poll(
      async () => {
        await stepEngineFrames(page, 1);
        return handle.evaluate((el) => {
          const c = el as HTMLCanvasElement;
          const ctx = c.getContext('2d');
          if (!ctx) return 0;
          const img = ctx.getImageData(0, 0, c.width, c.height).data;
          let nonZero = 0;
          for (let i = 0; i < img.length; i += 4 * 16) {
            if ((img[i]! + img[i + 1]! + img[i + 2]!) / 3 > 8) nonZero++;
          }
          return nonZero;
        });
      },
      { timeout: 10_000, message: `${testid} blitted frozen non-black content` },
    )
    .toBeGreaterThan(0);
}

/** Inject a deterministic bright-HALF <video> through the REAL CAMERA DOM-video
 *  upload path (UNPACK_FLIP_Y_WEBGL=true) and make it WIN the CameraInputCard's
 *  attach race, then settle the OUTPUT present blit on the injected (frozen,
 *  deterministic) content.
 *
 *  THE RACE (root cause of the flaky/locally-failing camera tests): the
 *  CameraInputCard's onMount runs a setInterval that attaches the card's OWN
 *  (empty, readyState=0) <video> element to engine node 'cam' until the attach
 *  sticks (`read('cam','hasVideoElement')===true`), then clears the interval. If
 *  the test attaches the injected element FIRST, that self-attach CLOBBERS it —
 *  the empty element samples to CAMERA's idle navy pattern → top=0/bottom=0 → the
 *  orientation guard reads black and fails. In this default (chromium) project NO
 *  camera permission is granted, so the card never runs requestStream(); the
 *  setInterval's single self-attach is therefore the ONLY clobber. (This is why
 *  the test passed on CI — where the card attaches before the test — yet failed
 *  locally with a real webcam device enumerated, where the test attaches first
 *  and the card then clobbers it.)
 *
 *  THE FIX (test-only reorder, no card/engine change): (1) ready the injected
 *  element WITHOUT attaching it; (2) WAIT until the card has finished its
 *  self-attach — `hasVideoElement===true`, which (since we have not attached
 *  yet) can only be the card's own element, and the interval clears in the SAME
 *  synchronous tick, so nothing re-clobbers afterward; (3) attach the injected
 *  source so it wins PERMANENTLY; (4) drive frozen engine frames + settle the
 *  present blit on the injected content. Removes the timing dependency entirely.
 *  The element still flows through the FLIP_Y=true DOM-video upload path (NOT the
 *  __camerainputTestFrame FLIP_Y=false seam), so the orientation guard stays
 *  fully valid. */
async function injectCameraSourceAndSettle(page: Page, brightHalf: 'top' | 'bottom'): Promise<void> {
  await page.evaluate(async (half) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        getDomain: (d: string) => {
          attachExternalSource: (id: string, k: string, el: HTMLElement | null) => void;
          read: (id: string, key: string) => unknown;
        };
      } | null;
    };
    const cv = document.createElement('canvas');
    cv.width = 320; cv.height = 240;
    const c = cv.getContext('2d')!;
    const paint = () => {
      c.fillStyle = '#141414'; c.fillRect(0, 0, 320, 240);
      // Top-left origin: 'top' paints y=0..120 (the TOP half), 'bottom' paints
      // y=120..240 (the BOTTOM half). Static every frame → frame-deterministic.
      c.fillStyle = '#ffffff';
      if (half === 'top') c.fillRect(0, 0, 320, 120);
      else c.fillRect(0, 120, 320, 120);
      requestAnimationFrame(paint);
    };
    paint();
    const stream = (cv as HTMLCanvasElement).captureStream(30);
    const vid = document.createElement('video');
    vid.muted = true; vid.playsInline = true; vid.autoplay = true;
    vid.srcObject = stream;
    document.body.appendChild(vid);
    await vid.play().catch(() => { /* autoplay fallback */ });
    // DETERMINISTIC readyState wait — event-driven, on the element being
    // sampleable (readyState>=2 && videoWidth>0), NOT a fixed budget.
    await new Promise<void>((res) => {
      const check = () => { if (vid.readyState >= 2 && vid.videoWidth > 0) res(); else requestAnimationFrame(check); };
      check();
    });
    // Keep a reference so GC doesn't reclaim the element/stream mid-test.
    (globalThis as unknown as { __orientVid?: HTMLVideoElement }).__orientVid = vid;

    const ve = w.__engine?.()?.getDomain('video');
    if (!ve) throw new Error('no video engine');

    // WAIT for the CameraInputCard's onMount self-attach to land + its interval
    // to clear — event-driven, bounded so a genuine failure is loud not a hang.
    // Since we have NOT attached yet, hasVideoElement===true can only be the
    // card's own (empty) element; the card clears its interval in the same tick.
    await new Promise<void>((res, rej) => {
      const t0 = performance.now();
      const check = () => {
        if (ve.read('cam', 'hasVideoElement') === true) { res(); return; }
        if (performance.now() - t0 > 10_000) {
          rej(new Error('cameraInput card never self-attached (hasVideoElement stayed false)'));
          return;
        }
        requestAnimationFrame(check);
      };
      check();
    });
    // NOW attach the injected source so it wins the race permanently.
    ve.attachExternalSource('cam', 'video', vid);
  }, brightHalf);

  // Drive frozen engine frames so CAMERA's upload + OUTPUT FBO reflect the
  // now-winning injected source, then settle the present blit on rendered state.
  const delta = await stepEngineFrames(page, FIXED_STEPS);
  expect(delta, 'engine advanced exactly the fixed frame count (loop paused)').toBe(FIXED_STEPS);
  await settleFrozenCanvas(page, 'video-out-canvas');
}

/** Read a card canvas and return, per displayed row band, the count and
 *  mean horizontal spread of bright pixels. A triangle pointing UP (apex
 *  in the top band) has fewer bright pixels + narrower spread up top and
 *  more + wider at the bottom. */
async function analyzeTriangleOrientation(
  page: import('@playwright/test').Page,
  testid: string,
): Promise<{ topBright: number; bottomBright: number; total: number; verdict: 'up' | 'down' | 'ambiguous' }> {
  const handle = page.locator(`canvas[data-testid="${testid}"]`);
  await expect(handle, `${testid} present`).toHaveCount(1);
  const r = await handle.evaluate((el, MIN_BRIGHT_TOTAL) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return { topBright: 0, bottomBright: 0, total: 0, thr: 0, maxLuma: 0, verdict: 'ambiguous' as const };
    const w = c.width, h = c.height;
    const img = ctx.getImageData(0, 0, w, h).data;
    // ── THE BRIGHT THRESHOLD IS ADAPTIVE — DOWNWARD ONLY (#1851 recalibration).
    // The card preview this reads is box-filtered by drawPreviewDownscaled
    // since #1851, and CORRECT filtering legitimately dims thin-line content:
    // RUTTETRA's 1-px scanlines at a ~3× reduction average with the black
    // between them and land BELOW the old fixed 90 (measured on the first
    // real-GPU run after #1851: apex visibly up, 0 pixels above 90). Area
    // content (solid triangles, bright image halves) stays near full luma, so
    // every historically-passing leg keeps the proven 90 — the threshold only
    // SCALES DOWN with the frame's own maximum, and the 45 floor keeps the
    // #141414 background (luma 20) structurally invisible exactly as before.
    let maxLuma = 0;
    for (let i = 0; i < img.length; i += 4) {
      const v = (img[i]! + img[i + 1]! + img[i + 2]!) / 3;
      if (v > maxLuma) maxLuma = v;
    }
    const thr = Math.min(90, Math.max(45, 0.55 * maxLuma));
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
        if (v > thr) {
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
    // centered shape and to BENTBOX's scanline speckle (the adaptive
    // threshold rejects the speckle at >= the old bar on bright frames).
    // The rowW profile is kept for debugging but the count ratio is the
    // decision.
    void rowW;
    let verdict: 'up' | 'down' | 'ambiguous' = 'ambiguous';
    const total = topBright + bottomBright;
    if (total > MIN_BRIGHT_TOTAL) {
      if (bottomBright > topBright * 1.08) verdict = 'up';
      else if (topBright > bottomBright * 1.08) verdict = 'down';
    }
    return { topBright, bottomBright, total, thr, maxLuma, verdict };
  }, MIN_BRIGHT_TOTAL);

  // ── THE PRECONDITION, ASSERTED WHERE EVERY LEG PASSES THROUGH ────────────
  //
  // Until #1826 this function returned an orientation verdict for a frame with
  // NO BRIGHT PIXELS AT ALL, and every caller then asserted on it. The maths
  // makes that a guaranteed FALSE VERDICT rather than a soft one:
  // `expect(topBright).toBeGreaterThan(bottomBright * 1.5)` with both at 0 is
  // `0 > 0`, which is false. So "the source never arrived" was REPORTED AS
  // "the orientation is wrong" — and it cost two real-GPU attest windows and
  // sent a reviewer hunting through render-worker transfer code for a flip
  // that never happened.
  //
  // ⚠ THE THRESHOLDS DID NOT AGREE, and that is the whole mechanism.
  // `settleFrozenCanvas` converges on luma > 8 sampled every 16th pixel; the
  // verdict above counts luma > 90. The injected PICTUREBOX image is a bright
  // TOP half on a #141414 background — luma 20. So a frame carrying ONLY the
  // background passes the settle (20 > 8) and then scores top=0 bottom=0 at the
  // verdict's threshold. The readiness gate was converging on content the
  // assertion is structurally unable to see.
  //
  // Asserting here rather than at ~20 call sites is deliberate: every
  // orientation leg funnels through this function, so one check makes all of
  // them self-diagnosing, including the ones that are currently green by luck.
  expect(
    r.total,
    `${testid}: THE SOURCE NEVER PRODUCED BRIGHT CONTENT (top=${r.topBright} bottom=${r.bottomBright} ` +
      `bright-pixel total=${r.total}, adaptive threshold luma>${r.thr.toFixed(1)} from frame maxLuma=${r.maxLuma.toFixed(1)}, ` +
      `floor 45 > background 20). This is a FIXTURE-READINESS failure, ` +
      `NOT an orientation failure — there is nothing in the frame to be the right way up. ` +
      `Look at whether the source actually loaded (the injected image / video / shader), not at ` +
      `flips, uploads or transfer paths. Note that a canvas showing only a dark background ` +
      `SATISFIES settleFrozenCanvas (luma>8) while scoring zero here (luma>90).`,
  ).toBeGreaterThan(MIN_BRIGHT_TOTAL);
  return r;
}

const TRIANGLE_PARAMS = { shape: 2, tile: 0, rotate: 0, zoom: 2.2 };

/** Boot the app with the DRS determinism hooks installed (paused engine loop +
 *  pinned clock). MUST install before goto. Returns the captured-error sink. */
async function setupFrozen(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  // Pause the engine rAF loop + pin the clock BEFORE the app boots.
  await installRenderSmokeHooks(page);
  await page.goto('/rack?shell=legacy&seed=none');
  await page.waitForLoadState('networkidle');
  return errors;
}

/** Legacy wall-clock setup — kept ONLY for the BENTBOX-output tests, which can
 *  not be frozen without a module-source change (BENTBOX reads performance.now()
 *  directly). Does NOT install the freeze hooks, so the engine rAF loop runs. */
async function setupLive(page: import('@playwright/test').Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/rack?shell=legacy&seed=none');
  await page.waitForLoadState('networkidle');
  return errors;
}

// @webgl-serial — MEASURED, not inferred. Under the attest's PARALLEL Pass
// A-heavy on a real GPU, PICTUREBOX's own output surface comes back with ZERO
// bright pixels: reproduced on CLEAN MAIN (14b1edef9 + only this file's
// readiness fix), with the real Pass A filter
// (--grep-invert '@collab|@capacity|@webgl-serial', --workers=5). The same tree
// passes 20/20 in isolation (E2E_REAL_GPU=1 task e2e:one -- video-orientation).
//
// It is NOT a frame-count problem, and that is worth stating because it is the
// obvious wrong fix: `setImage` uploads SYNCHRONOUSLY (picturebox.ts
// `setImage` -> `uploadToSlot` -> `glUpload` -> `gl.texImage2D`, no promise, no
// deferral), and the readiness poll below re-steps the frozen engine for 15 s
// and still reads 0. Raising FIXED_STEPS would change nothing.
//
// That leaves the same output-FBO readback race the other two members of this
// bucket carry, so it runs in the SERIAL bucket (workers=1) — a quiet GPU, so
// it passes honestly rather than being papered over by retries. See
// WEBGL_SERIAL_SPECS in scripts/webgl-attest-lib.ts. Wall-time there is
// ADDITIVE; this earns its place with the reproduction above.
test.describe('video orientation — SHAPES triangle reference @webgl-serial', () => {
  test('1. SHAPES(triangle) -> OUTPUT is upright (apex on top)', async ({ page }) => {
    await setupFrozen(page);
    await spawnPatch(page,
      [
        { id: 'src', type: 'shapes', position: { x: 40, y: 40 }, domain: 'video', params: TRIANGLE_PARAMS },
        { id: 'out', type: 'videoOut', position: { x: 500, y: 40 }, domain: 'video' },
      ],
      [{ id: 'e1', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' }],
    );
    // Drive a fixed number of FROZEN engine frames synchronously, then settle
    // the card's present blit on rendered state (no wall-clock wait).
    const delta = await stepEngineFrames(page, FIXED_STEPS);
    expect(delta, 'engine advanced exactly the fixed frame count (loop paused)').toBe(FIXED_STEPS);
    await settleFrozenCanvas(page, 'video-out-canvas');
    const r = await analyzeTriangleOrientation(page, 'video-out-canvas');
    await page.screenshot({ path: 'test-results/orient-1-shapes-output.png' });
    expect(r.verdict, `SHAPES->OUTPUT verdict (top=${r.topBright} bottom=${r.bottomBright})`).toBe('up');
  });

  // NOTE (deferred — module-source change required): BENTBOX's CRT shader reads
  // performance.now() for its uTime drift (bentbox.ts), so the engine freeze
  // hook does NOT make it frame-stable. Tests 2/3/4 (BENTBOX as the read
  // surface) stay on the live engine + wall-clock sample until BENTBOX gets its
  // own clock-freeze hook. The orientation verdict is still valid: the v>90
  // threshold rejects the scanline speckle and apex-up geometry is
  // time-invariant.
  test('2. SHAPES(triangle) -> BENTBOX is upright', async ({ page }) => {
    await setupLive(page);
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

  // NOTE (deferred): BENTBOX in the chain — see test 2. Left on the live engine.
  test('3. SHAPES(triangle) -> BENTBOX -> OUTPUT is upright', async ({ page }) => {
    await setupLive(page);
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
    //
    // DRS: the injected band is a STATIC bright-top fill (no time
    // animation), and CAMERA's upload path uses no time uniform, so under
    // the frozen+paused engine the OUTPUT FBO is deterministic once the
    // <video> is attached + sampleable. injectCameraSourceAndSettle attaches
    // the injected element AFTER the CameraInputCard's onMount self-attach
    // lands (so the injected source wins the race — see its doc), keeps the
    // deterministic readyState wait, then drives frozen steps + settles the
    // present blit on rendered state.
    await setupFrozen(page);
    await spawnPatch(page,
      [
        { id: 'cam', type: 'cameraInput', position: { x: 40, y: 40 }, domain: 'video', params: { enabled: 1, mirror: 0 } },
        { id: 'out', type: 'videoOut', position: { x: 600, y: 40 }, domain: 'video' },
      ],
      [{ id: 'e1', from: { nodeId: 'cam', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' }],
    );
    await injectCameraSourceAndSettle(page, 'top');
    const rc = await analyzeTriangleOrientation(page, 'video-out-canvas');
    await page.screenshot({ path: 'test-results/orient-6-camera-output.png' });
    expect(rc.topBright, `CAMERA->OUTPUT bright-top should dominate (top=${rc.topBright} bottom=${rc.bottomBright})`)
      .toBeGreaterThan(rc.bottomBright * 1.5);
  });

  // NOTE (deferred): BENTBOX×2 in the chain — see test 2. Left on the live engine.
  test('4. SHAPES(triangle) -> BENTBOX -> BENTBOX -> OUTPUT is upright', async ({ page }) => {
    await setupLive(page);
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
    // RUTTETRA uses NO time uniform → fully deterministic when frozen.
    await setupFrozen(page);
    await spawnPatch(page,
      [
        { id: 'src', type: 'shapes', position: { x: 40, y: 40 }, domain: 'video', params: TRIANGLE_PARAMS },
        { id: 're', type: 'ruttetra', position: { x: 500, y: 40 }, domain: 'video', params: { xDisp: 0, yDisp: 0, xShape: 0, yShape: 0 } },
      ],
      [{ id: 'e1', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 're', portId: 'z' }, sourceType: 'mono-video', targetType: 'video' }],
    );
    const delta = await stepEngineFrames(page, FIXED_STEPS);
    expect(delta, 'engine advanced exactly the fixed frame count (loop paused)').toBe(FIXED_STEPS);
    await settleFrozenCanvas(page, 'ruttetra-canvas');
    const r = await analyzeTriangleOrientation(page, 'ruttetra-canvas');
    await page.screenshot({ path: 'test-results/orient-7-shapes-ruttetra.png' });
    expect(r.verdict, `SHAPES->RUTTETRA verdict (top=${r.topBright} bottom=${r.bottomBright})`).toBe('up');
  });
});

// ---------------------------------------------------------------------------
// PARAMETRIZED orientation lock — every video→video transform / keyer.
//
// Drives each module that has BOTH a video (or mono-video) INPUT and a video
// output with the same SHAPES(triangle) asymmetric source (apex UP in vUv
// space) used above, routes the module's output to OUTPUT, reads the displayed
// OUTPUT canvas, and asserts the triangle's apex is still in the TOP half
// (verdict 'up'). A vertically-mirrored module flips the apex to the bottom →
// verdict 'down' → the test FAILS. This is the load-bearing regression lock:
// any module that starts (or regresses to) sampling its input upside-down is
// caught here, module-by-module, with no baseline images needed.
//
// DRS: every transform/keyer below uses NO time uniform (pure function of its
// input) and is driven with neutralized params, so feeding it the FROZEN SHAPES
// triangle under the paused+pinned engine makes its output deterministic. We
// drive a fixed step burst + settle the present blit on rendered state instead
// of the old waitForTimeout + expect.poll-over-a-fixed-budget sample.
//
// The discrimination guard below proves the assertion actually distinguishes
// up from down by injecting a vertically-INVERTED source (bright BOTTOM half)
// through the real CAMERA upload path: a correct pipeline then reads
// bottom-dominant, so if the analyzer ever reported 'up' for that, every
// orientation assertion here would be vacuous.
// ---------------------------------------------------------------------------

interface TransformCase {
  /** Registered module `type` (matches the def's `type` field). */
  type: string;
  /** Human label for the test title. */
  label: string;
  /** The module's video/mono-video INPUT port the triangle feeds into. */
  inPort: string;
  /** The source→input edge type pair. SHAPES emits mono-video; a video input
   *  upcasts it (engine handles the grayscale→rgb promotion). */
  targetType: 'video' | 'mono-video';
  /** Optional params to neutralize the transform so the triangle passes
   *  through 1:1 and the verdict isolates ORIENTATION. */
  params?: Record<string, number>;
}

// Every video-output module that ALSO has a video/mono-video input. Pure
// generators (acidwarp, doom, scope/wave3d, rasterize, …) have
// no asymmetric input to drive and are covered by VRT baselines instead — see
// the PR notes. BENTBOX + RUTTETRA already have dedicated tests above; the
// remaining transforms/keyers are locked here.
const TRANSFORM_CASES: TransformCase[] = [
  { type: 'destructor', label: 'DESTRUCTOR', inPort: 'in',  targetType: 'video',      params: { shift: 0, scanline: 0, posterize: 0, mangle: 0 } },
  { type: 'chroma',     label: 'CHROMA',     inPort: 'in',  targetType: 'video' },
  { type: 'luma',       label: 'LUMA',       inPort: 'in',  targetType: 'video' },
  { type: 'colorizer',  label: 'COLORIZER',  inPort: 'in',  targetType: 'mono-video' },
  { type: 'monoglitch', label: 'MONOGLITCH', inPort: 'in',  targetType: 'video',      params: { hRamp: 0, vRamp: 0, intensity: 0 } },
  { type: 'feedback',   label: 'FEEDBACK',   inPort: 'in',  targetType: 'video',      params: { wet: 1, decay: 0, zoom: 1, rotate: 0, offsetX: 0, offsetY: 0 } },
  { type: 'vdelay',     label: 'VDELAY',     inPort: 'in',  targetType: 'video',      params: { feedback: 0, mix: 0 } },
  { type: 'lumakey',    label: 'LUMAKEY',    inPort: 'fg',  targetType: 'video',      params: { threshold: 0.05, softness: 0.05, invert: 0 } },
  { type: 'chromakey',  label: 'CHROMAKEY',  inPort: 'fg',  targetType: 'video' },
  { type: 'videoMixer', label: 'MIXER',      inPort: 'in1', targetType: 'video' },
  { type: 'reshaper',   label: 'RESHAPER',   inPort: 'z',   targetType: 'video',      params: { xDisp: 0, yDisp: 0, intensity: 1 } },
  { type: 'backdraft',  label: 'BACKDRAFT',  inPort: 'in_a', targetType: 'video',     params: { feedback: 0, mix: 0, zoom: 1, rotate: 0 } },
];

test.describe('video orientation — parametrized transform/keyer lock @webgl-serial', () => {
  for (const tc of TRANSFORM_CASES) {
    test(`SHAPES(triangle) -> ${tc.label} -> OUTPUT is upright (apex on top)`, async ({ page }) => {
      await setupFrozen(page);
      await spawnPatch(page,
        [
          { id: 'src', type: 'shapes', position: { x: 40, y: 40 }, domain: 'video', params: TRIANGLE_PARAMS },
          { id: 'mod', type: tc.type, position: { x: 400, y: 40 }, domain: 'video', params: tc.params },
          { id: 'out', type: 'videoOut', position: { x: 800, y: 40 }, domain: 'video' },
        ],
        [
          { id: 'e1', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'mod', portId: tc.inPort }, sourceType: 'mono-video', targetType: tc.targetType },
          { id: 'e2', from: { nodeId: 'mod', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
        ],
      );
      // Feedback/vdelay/backdraft have a ring that needs a few frames for the
      // accumulator to settle even with feedback/mix zeroed. Drive a fixed
      // FROZEN step burst (the engine loop is paused, so the test owns the count)
      // — deterministic by construction — then settle the present blit on
      // rendered state. No waitForTimeout, no poll-over-a-fixed-budget.
      const delta = await stepEngineFrames(page, FIXED_STEPS);
      expect(delta, 'engine advanced exactly the fixed frame count (loop paused)').toBe(FIXED_STEPS);
      await settleFrozenCanvas(page, 'video-out-canvas');
      const r = await analyzeTriangleOrientation(page, 'video-out-canvas');
      await page.screenshot({ path: `test-results/orient-param-${tc.type}.png` });
      expect(r.verdict, `SHAPES->${tc.label}->OUTPUT verdict (top=${r.topBright} bottom=${r.bottomBright})`).toBe('up');
    });
  }

  // Discrimination guard: prove the assertion actually distinguishes up from
  // down. Inject a vertically-INVERTED source (bright BOTTOM half, the mirror
  // of test 6's bright-TOP source) through the real CAMERA upload path. A
  // correctly-oriented pipeline must display that band at the BOTTOM — i.e.
  // bottom-dominant. If the analyzer instead reported top-dominant here, the
  // 'up' assertions above would be vacuous. This is the live proof that the
  // analyzer (and thus the whole parametrized lock) discriminates orientation.
  //
  // DRS: the injected band is a STATIC bright-bottom fill (no time animation)
  // and CAMERA's upload uses no time uniform, so under the frozen+paused engine
  // the OUTPUT FBO is deterministic. The deterministic readyState wait (event-
  // driven, on the element being sampleable) is preserved.
  test('discrimination guard: bright-BOTTOM source reads bottom-dominant', async ({ page }) => {
    await setupFrozen(page);
    await spawnPatch(page,
      [
        { id: 'cam', type: 'cameraInput', position: { x: 40, y: 40 }, domain: 'video', params: { enabled: 1, mirror: 0 } },
        { id: 'out', type: 'videoOut', position: { x: 600, y: 40 }, domain: 'video' },
      ],
      [{ id: 'e1', from: { nodeId: 'cam', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' }],
    );
    // Same real-CAMERA upload path as test 6, but the injected band is the
    // vertical MIRROR (bright BOTTOM half). injectCameraSourceAndSettle wins the
    // card's attach race + settles on the frozen injected content.
    await injectCameraSourceAndSettle(page, 'bottom');
    const r = await analyzeTriangleOrientation(page, 'video-out-canvas');
    await page.screenshot({ path: 'test-results/orient-guard-bottom.png' });
    expect(r.bottomBright, `bright-BOTTOM source must read bottom-dominant (top=${r.topBright} bottom=${r.bottomBright}) — else the lock is vacuous`)
      .toBeGreaterThan(r.topBright * 1.5);
  });
});

// ---------------------------------------------------------------------------
// PICTUREBOX — image SOURCE (no video input), so it can't be driven by the
// SHAPES triangle. We instead inject an asymmetric image (bright TOP half)
// through the module's REAL production decode path (downscaleAndEncode ->
// base64ToImageBitmap -> setImage) and assert OUTPUT shows the band on TOP.
//
// This was the module the owner reported flipped: its ImageBitmap upload path
// rendered upside-down because Chromium ignores UNPACK_FLIP_Y_WEBGL for
// Blob-sourced ImageBitmaps, so the bottom-up texel layout was sampled as-is.
// Fixed by decoding with imageOrientation:'flipY' in base64ToImageBitmap so
// the existing FLIP_Y=true upload + vUv sampling lands upright like CAMERA.
//
// DRS: the injected image is a STATIC bright-top fill and PICTUREBOX's upload
// uses no time uniform, so under the frozen+paused engine the OUTPUT FBO is
// deterministic once setImage() has run. We await the real encode/decode
// helpers (deterministic promise chain, not a wall-clock wait), then drive a
// fixed frozen step burst + settle the present blit on rendered state.
// ---------------------------------------------------------------------------
test.describe('video orientation — PICTUREBOX image source @webgl-serial', () => {
  test('PICTUREBOX(bright-top image) -> OUTPUT shows bright on top', async ({ page }) => {
    await setupFrozen(page);
    await spawnPatch(page,
      [
        { id: 'pic', type: 'picturebox', position: { x: 40, y: 40 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 600, y: 40 }, domain: 'video' },
      ],
      [{ id: 'e1', from: { nodeId: 'pic', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'image', targetType: 'video' }],
    );
    const injected = await page.evaluate(async () => {
      const w = globalThis as unknown as {
        __engine?: () => { getDomain: (d: string) => { read: (id: string, key: string) => unknown } } | null;
      };
      const cv = document.createElement('canvas');
      cv.width = 640; cv.height = 480;
      const c = cv.getContext('2d')!;
      c.fillStyle = '#141414'; c.fillRect(0, 0, 640, 480);
      // Top-left origin: y=0..240 is the TOP half. Paint it bright.
      c.fillStyle = '#ffffff'; c.fillRect(0, 0, 640, 240);
      const blob: Blob = await new Promise((res) => cv.toBlob((b) => res(b!), 'image/jpeg', 0.85));
      // Drive the REAL production encode/decode helpers (same functions the
      // card uses) so the orientation under test is the shipped behavior.
      // Resolved via the app-exposed test hook (gated on testHooksEnabled) so
      // it works under the prebuilt `vite preview` bundle (E2E_USE_PREVIEW=1),
      // where a `/src/...` dynamic import would 404.
      const wm = globalThis as unknown as {
        __pictureboxEncode?: () => Promise<{
          downscaleAndEncode: (b: Blob) => Promise<string>;
          base64ToImageBitmap: (s: string) => Promise<ImageBitmap>;
        }>;
      };
      if (!wm.__pictureboxEncode) throw new Error('__pictureboxEncode missing — test-hooks build expected');
      const mod = await wm.__pictureboxEncode();
      const b64: string = await mod.downscaleAndEncode(blob);
      const bmp: ImageBitmap = await mod.base64ToImageBitmap(b64);
      const extras = w.__engine?.()?.getDomain('video')?.read('pic', 'extras') as { setImage: (b: ImageBitmap) => void } | undefined;
      if (!extras) throw new Error('no picturebox extras');
      // Report what we are about to inject. A 640x480 bright-TOP fill must
      // decode to a bitmap with real dimensions; a 0x0 bitmap would upload
      // "successfully" and render nothing, which is one of the ways this test
      // used to report a phantom orientation failure.
      extras.setImage(bmp);
      return { w: bmp.width, h: bmp.height, b64Len: b64.length };
    });
    expect(
      injected.w * injected.h,
      `PICTUREBOX: the injected ImageBitmap has no pixels (${injected.w}x${injected.h}, ` +
        `base64 ${injected.b64Len} chars). The encode/decode chain produced nothing to upload, ` +
        'so nothing downstream can be the right way up.',
    ).toBeGreaterThan(0);

    // ── POSITIVE CONTROL: the SOURCE carries the picture, before we ask the
    //    SINK where the bright half is. ───────────────────────────────────────
    //
    // Without this, PICTUREBOX-never-loaded and VIDEOOUT-shows-it-upside-down
    // are the same failure message. With it, the two are different assertions
    // with different text, and the one that fires names the half that broke.
    //
    // Bounded by RENDERED STATE, not by a wall-clock budget: each poll drives
    // the (paused) engine one more frozen step and re-reads the PICTUREBOX
    // node's OWN output, so it converges on the upload actually landing. That
    // is the readGateWhenPopulated shape — wait on the thing you are about to
    // assert on, never on a proxy for it and never on a longer timeout.
    await expect
      .poll(
        async () => {
          await stepEngineFrames(page, 1);
          return page.evaluate(() => {
            const w = globalThis as unknown as {
              __engine: () => {
                getDomain: (d: string) => {
                  gl: WebGL2RenderingContext;
                  res: { width: number; height: number };
                  blitOutputToDrawingBuffer: (n: string) => void;
                };
              };
            };
            const vid = w.__engine().getDomain('video');
            const gl = vid.gl;
            const { width: W, height: H } = vid.res;
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, W, H);
            gl.clearColor(0, 0, 0, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            vid.blitOutputToDrawingBuffer('pic');
            const px = new Uint8Array(W * H * 4);
            gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
            // Same luma threshold the orientation verdict uses, so this gate
            // cannot converge on content the assertion is unable to see.
            let bright = 0;
            for (let i = 0; i < px.length; i += 4 * 16) {
              if ((px[i]! + px[i + 1]! + px[i + 2]!) / 3 > 90) bright++;
            }
            return bright;
          });
        },
        {
          message:
            'PICTUREBOX\'s OWN output carries the injected bright half. If this is what fails, ' +
            'the SOURCE never loaded — do not go looking for a flip, an upload orientation or a ' +
            'worker transfer path. The image is a 640x480 bright-TOP fill on a #141414 ' +
            'background, injected through the real downscaleAndEncode -> base64ToImageBitmap -> ' +
            'setImage chain.',
          timeout: 15_000,
        },
      )
      .toBeGreaterThan(0);

    const delta = await stepEngineFrames(page, FIXED_STEPS);
    expect(delta, 'engine advanced exactly the fixed frame count (loop paused)').toBe(FIXED_STEPS);
    await settleFrozenCanvas(page, 'video-out-canvas');
    const r = await analyzeTriangleOrientation(page, 'video-out-canvas');
    await page.screenshot({ path: 'test-results/orient-picturebox.png' });
    // The injected band is a solid bright TOP half (not a triangle), so we
    // assert the TOP band dominates directly rather than the triangle verdict.
    expect(r.topBright, `PICTUREBOX bright-top must dominate (top=${r.topBright} bottom=${r.bottomBright})`)
      .toBeGreaterThan(r.bottomBright * 1.5);
  });
});
