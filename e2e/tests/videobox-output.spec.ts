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
// load a small local .webm via setInputFiles, patch the output, and assert (a)
// the engine-internal liveness facts (uploadCount advances, the OUTPUT resolves
// to the right source + latches an input texture) and (b) VIDEOBOX's OWN output
// FBO shows non-black, structured content.
//
// ============================================================================
// DRS CONVERSION (plan §3 — converted IN-PLACE from the old wall-clock shape)
// ============================================================================
//
// The OLD test sampled the downstream VIDEO-OUT *card canvas* via a 2D
// getImageData read after `waitForTimeout(800)`, then ran an animation-diff
// "frame moved within 5s" poll. Three un-synchronized clocks (rAF cadence, the
// <video> decode cadence, the 2D-canvas blit) made the pixel reads flaky under
// CI's SwiftShader rAF throttling — exactly the flake class the shared
// _render-smoke harness exists to kill. Per the §3 directive we:
//
//   * KEEP the 6 deterministic liveness / uploadCount / resolveInputSourceId /
//     hasInput hooks AS-IS (they are engine-internal facts, already immune to
//     rAF throttling — they were the prior conversion's CI proof and stay the
//     CI proof here). The `liveness()` helper is preserved verbatim.
//   * REPLACE the canvasStats / canvasSignature one-shots + animation-diff poll
//     with the DRS pattern: installRenderSmokeHooks() BEFORE goto (pause the
//     engine rAF loop so the test owns the exact frame count + pin the engine
//     clock), then drive a FIXED burst via stepAndReadStats() and read
//     VIDEOBOX's OWN output FBO once via gl.readPixels with renderer-tolerant
//     floors. No waitForTimeout, no poll, no animation-diff, no exact-pixel
//     equality.
//
// WHY VIDEOBOX's OWN FBO IS DRS-DETERMINISTIC: videobox.ts `draw()` reads NO
// engine clock and holds NO accumulating GL state — it is a pure passthrough of
// `uploader.texture` (uploadIfReady() just rebinds the most-recently-decoded
// frame). The synchronous step burst runs inside ONE page.evaluate with no
// awaits, so no rVFC decode callback can interleave mid-burst → the uploaded
// frame is identical across the two bursts → a frozen, frame-STABLE FBO. That
// lets us assert the same "frame is live, not frozen black" fact the old pixel
// reads chased, deterministically.
//
// ----------------------------------------------------------------------------
// DEFERRAL — the VIDEOBOX -> BENTBOX -> VIDEO-OUT test's PIXEL read.
// ----------------------------------------------------------------------------
// BENTBOX is a HARD determinism blocker for the DRS pixel path and CANNOT be
// frozen:
//   * it derives its shader `uTime` from `performance.now()` (bentbox.ts
//     startWallMs + per-draw `performance.now()`), which `__videoEngineFreezeTime`
//     does NOT pin; and
//   * it ACCUMULATES state across frames — `framesElapsed` + a ping-pong feedback
//     ring (uPrev), so each step reads a different ring state.
// Reading VIDEOBOX's frame DOWNSTREAM of BENTBOX is therefore non-deterministic
// — this is the exact root cause that sank the prior (Phase-2a) attempt, which
// sampled the canvas AFTER bentbox. So for the BENTBOX-chain test we do NOT add
// a DRS pixel read; we keep its engine-state liveness guards (which DO prove the
// VIDEOBOX -> BENTBOX -> OUT chain is wired + carrying live frames) and leave
// the VISUAL pixel confirmation on its EXISTING local-only mechanism
// (canvasStats, gated behind visualChecksEnabled()), with a NOTE. Weakening it
// to a vacuous DRS read through a non-freezable module is not an option.
//
// The first test (VIDEOBOX -> VIDEO-OUT, no bentbox) reads VIDEOBOX's OWN FBO,
// which IS freezable, so it gets the full DRS treatment.

import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { spawnPatch } from './_helpers';
import { visualChecksEnabled } from './_visual-checks';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';

const FIXTURE = fileURLToPath(new URL('../fixtures/lobby-clip.webm', import.meta.url));

// DRS fixed burst — the test owns the exact engine frame count (rAF paused).
const FIXED_STEPS = 6;

/** Wire up page-error capture and install the DRS determinism hooks (pause the
 *  engine rAF loop + pin the engine clock) BEFORE the app boots, then navigate.
 *  installRenderSmokeHooks MUST run before page.goto. */
async function setup(page: import('@playwright/test').Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  // Pause rAF (test owns the frame count) + pin the clock BEFORE boot.
  await installRenderSmokeHooks(page);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  return errors;
}

/** Mean luminance + per-channel max over a card canvas. LOCAL-ONLY visual
 *  confirmation for the deferred BENTBOX-chain test (its FBO is non-freezable).
 *  NOT used by the DRS path. */
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

/** Drive the video engine's step() over a bounded window with macrotask gaps
 *  (so rVFC decode callbacks fire) and return the named node's uploadCount
 *  delta plus the OUTPUT's resolved input source + hasInput. This is the
 *  ENGINE-INTERNAL proof that real frames decode into the texture and reach
 *  the OUTPUT — deterministic on software GL, unlike sampling the rendered
 *  canvas. uploadCount advancing > 0 is the same "frame is live, not frozen
 *  black" fact the pixel checks chased.
 *
 *  KEPT AS-IS from the prior conversion (plan §3: preserve the 6 deterministic
 *  liveness hooks). NOTE: this helper INTENTIONALLY uses a wall-clock window +
 *  macrotask gaps because its WHOLE POINT is to let the <video> element decode
 *  REAL frames over real time (rVFC fires only between macrotasks); it does NOT
 *  read pixels and does NOT assert frame-stability, so it is not subject to the
 *  DRS "no waitForTimeout" rule — it asserts only the monotonic uploadCount
 *  delta + resolved routing, both engine-internal facts. The DRS pixel read is
 *  a separate, frozen, synchronous burst below. */
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
  // Start playback (the clip is moving footage; we want the element to have a
  // decoded frame for the engine to sample).
  await page.click('[data-testid="videobox-play-btn"]');
  await expect(page.locator('[data-testid="videobox-card"]')).toHaveAttribute(
    'data-is-playing', 'true', { timeout: 4000 },
  );
}

test.describe('VIDEOBOX video output reaches downstream', () => {
  test('VIDEOBOX.video -> VIDEO-OUT shows non-black content (DRS)', async ({ page }) => {
    test.setTimeout(60_000);
    const errors = await setup(page);
    await spawnPatch(page,
      [
        { id: 'vb',  type: 'videobox', position: { x: 40,  y: 40 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 560, y: 40 }, domain: 'video' },
      ],
      [{ id: 'e1', from: { nodeId: 'vb', portId: 'video' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' }],
    );

    await loadAndPlay(page);

    // DETERMINISTIC LIVENESS GUARDS (kept AS-IS, plan §3 — the 6 engine-state
    // hooks): drive step() over a window so the clip decodes, then assert
    // (1) VIDEOBOX's uploadCount ADVANCES — real frames decode into the source
    // texture, the exact #288 regression (frozen black texture from a bailed
    // uploadIfReady); and (2) the OUTPUT resolves to the VIDEOBOX and latches an
    // input texture — the frame reaches downstream. Both are engine-internal
    // facts, immune to software-GL rAF throttling.
    const live = await liveness(page, 'vb', 'out');
    expect(
      live.uploads,
      `VIDEOBOX decodes live frames into its texture (uploadCount advanced by ${live.uploads})`,
    ).toBeGreaterThan(0);
    expect(live.outSource, 'VIDEO-OUT fed by VIDEOBOX').toBe('vb');
    expect(live.outHasInput, 'VIDEO-OUT latched an input texture').toBe(true);

    // DRS PIXEL READ (replaces the old canvasStats one-shot + animation-diff
    // poll). VIDEOBOX's OWN output FBO is a pure passthrough of the decoded
    // frame — no engine-clock read, no accumulating GL state — so with the rAF
    // loop paused and the clock pinned, a synchronous step burst reads a
    // frame-STABLE FBO. We read VIDEOBOX's own texture ({ nodeId: 'vb' } → the
    // single `video`-output FBO), NOT downstream of any non-freezable module.
    //
    // The lobby clip is dense, lit footage → the DEFAULT non-black floor (2%)
    // and variance floor apply (this asserts the same "non-black + has content"
    // fact the old `max > 40 && mean > 6` canvas read chased, renderer-tolerant).
    const a = await stepAndReadStats(page, { nodeId: 'vb', steps: FIXED_STEPS });
    assertRenderStats(a, FIXED_STEPS);

    // NB: we deliberately do NOT assert a second-burst frame-STABLE read here.
    // VIDEOBOX's shader is clock-pure, but its SOURCE is a live decoding <video>
    // (no `__camerainputTestFrame`-style injection seam in video-frame-upload.ts
    // yet), so an rVFC decode can land in the async gap BETWEEN two bursts and
    // upload a different frame — a tight mean/variance epsilon would then flake on
    // the cumulative-load lane. The single-burst floors above (non-black +
    // variance + exact frame count + zero GL errors) are renderer-tolerant and
    // hold for ANY decoded frame, which is the deterministic fact this test needs;
    // a true frame-stability assert is deferred to a future videobox freeze seam.
    expect(errors, `no page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('VIDEOBOX.video -> BENTBOX -> VIDEO-OUT shows content', async ({ page }) => {
    test.setTimeout(60_000);
    const errors = await setup(page);
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

    // DETERMINISTIC LIVENESS GUARDS (kept AS-IS, plan §3): VIDEOBOX decodes live
    // frames AND the chain VIDEOBOX -> BENTBOX -> VIDEO-OUT is wired (OUTPUT
    // resolves to BENTBOX and latches an input texture). Engine-state, not
    // sampled pixels — these are the deterministic CI proof for this chain.
    const live = await liveness(page, 'vb', 'out');
    expect(
      live.uploads,
      `VIDEOBOX decodes live frames (uploadCount advanced by ${live.uploads})`,
    ).toBeGreaterThan(0);
    expect(live.outSource, 'VIDEO-OUT fed by BENTBOX').toBe('bb');
    expect(live.outHasInput, 'VIDEO-OUT latched an input texture (via BENTBOX)').toBe(true);

    // DRS DEFERRED (NOT weakened): the PIXEL read for this chain stays on its
    // EXISTING local-only mechanism. BENTBOX is a HARD determinism blocker — its
    // shader uTime comes from performance.now() (NOT pinned by the freeze hook)
    // and it accumulates framesElapsed + a ping-pong feedback ring, so its
    // output FBO is non-deterministic per frame. Reading VIDEOBOX's frame
    // DOWNSTREAM of BENTBOX is the exact non-determinism that sank the prior
    // Phase-2a attempt. We therefore do NOT add a frozen DRS read through
    // BENTBOX (that would be vacuous / flaky); the engine-state liveness guards
    // above are the deterministic chain proof, and the visual pixel confirmation
    // runs LOCAL-ONLY (visualChecksEnabled()) on the existing canvasStats read.
    // A module-source freeze hook on BENTBOX (pin uTime + a settled-frame pin)
    // would be needed to DRS this read; that is out of scope for a test-only
    // conversion.
    if (visualChecksEnabled()) {
      const stats = await canvasStats(page, 'video-out-canvas');
      await page.screenshot({ path: 'test-results/videobox-bentbox-output.png' });
      expect(stats.max, `VIDEO-OUT (via BENTBOX) has bright pixels (mean=${stats.mean.toFixed(1)} max=${stats.max})`).toBeGreaterThan(40);
      expect(stats.mean, `VIDEO-OUT (via BENTBOX) not near-black (mean=${stats.mean.toFixed(1)})`).toBeGreaterThan(6);
    }

    expect(errors, `no page errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
