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

/** Boot the app with the DRS determinism hooks installed (paused engine loop +
 *  pinned clock). MUST install before goto. Returns the captured-error sink. */
async function setupFrozen(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  // Pause the engine rAF loop + pin the clock BEFORE the app boots.
  await installRenderSmokeHooks(page);
  await page.goto('/');
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
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  return errors;
}

test.describe('video orientation — SHAPES triangle reference', () => {
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
    // <video> is attached + sampleable. We keep the deterministic
    // readyState wait (an event-driven wait on the element actually being
    // sampleable — NOT a wall-clock budget), then drive frozen steps +
    // settle the present blit on rendered state.
    await setupFrozen(page);
    await spawnPatch(page,
      [
        { id: 'cam', type: 'cameraInput', position: { x: 40, y: 40 }, domain: 'video', params: { enabled: 1, mirror: 0 } },
        { id: 'out', type: 'videoOut', position: { x: 600, y: 40 }, domain: 'video' },
      ],
      [{ id: 'e1', from: { nodeId: 'cam', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' }],
    );
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
      // DETERMINISTIC readyState wait — event-driven, on the element being
      // sampleable (readyState>=2 && videoWidth>0), NOT a fixed budget.
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
    // Drive frozen engine frames so CAMERA's upload + OUTPUT FBO settle, then
    // settle the present blit on rendered state.
    const delta = await stepEngineFrames(page, FIXED_STEPS);
    expect(delta, 'engine advanced exactly the fixed frame count (loop paused)').toBe(FIXED_STEPS);
    await settleFrozenCanvas(page, 'video-out-canvas');
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
// generators (acidwarp, doom, scope/wave3d, rasterize, warrenspectrum, …) have
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

test.describe('video orientation — parametrized transform/keyer lock', () => {
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
    await page.evaluate(async () => {
      const w = globalThis as unknown as {
        __engine?: () => { getDomain: (d: string) => { attachExternalSource: (id: string, k: string, el: HTMLElement | null) => void } } | null;
      };
      const cv = document.createElement('canvas');
      cv.width = 320; cv.height = 240;
      const c = cv.getContext('2d')!;
      const paint = () => {
        c.fillStyle = '#141414'; c.fillRect(0, 0, 320, 240);
        // Top-left origin: y=120..240 is the BOTTOM half. Paint it bright.
        c.fillStyle = '#ffffff'; c.fillRect(0, 120, 320, 120);
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
      const ve = w.__engine?.()?.getDomain('video');
      if (!ve) throw new Error('no video engine');
      ve.attachExternalSource('cam', 'video', vid);
      (globalThis as unknown as { __orientVid2?: HTMLVideoElement }).__orientVid2 = vid;
    });
    const delta = await stepEngineFrames(page, FIXED_STEPS);
    expect(delta, 'engine advanced exactly the fixed frame count (loop paused)').toBe(FIXED_STEPS);
    await settleFrozenCanvas(page, 'video-out-canvas');
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
test.describe('video orientation — PICTUREBOX image source', () => {
  test('PICTUREBOX(bright-top image) -> OUTPUT shows bright on top', async ({ page }) => {
    await setupFrozen(page);
    await spawnPatch(page,
      [
        { id: 'pic', type: 'picturebox', position: { x: 40, y: 40 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 600, y: 40 }, domain: 'video' },
      ],
      [{ id: 'e1', from: { nodeId: 'pic', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'image', targetType: 'video' }],
    );
    await page.evaluate(async () => {
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
      extras.setImage(bmp);
    });
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
