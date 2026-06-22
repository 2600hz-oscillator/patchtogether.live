// e2e/tests/freezeframe.spec.ts
//
// FREEZEFRAME — video sample & hold + per-channel posterize.
//
// DETERMINISTIC render-smoke (DRS), converted IN-PLACE from the old wall-clock
// shape (spawn → poll-the-output-canvas-on-a-50ms-cadence until a
// brightness-fingerprint animation-diff crosses a LIVE/FROZEN fraction, with a
// 12 s deadline). That pattern raced three un-synchronized clocks (the engine's
// own rAF loop — THROTTLED in a backgrounded e2e tab — the 2D-canvas blit
// cadence, and the wall-clock poll) and proved "the frame moved" by diffing
// successive ANIMATED frames, which a frozen clock can't (and shouldn't) do.
//
// The DRS instead PAUSES the engine rAF loop + PINS the engine clock before boot
// (installRenderSmokeHooks), drives engine.step() a FIXED number of frames
// synchronously, and reads FREEZEFRAME's OWN output FBO once via the shared
// _render-smoke harness with renderer-tolerant floors. The regression-critical
// paths, re-expressed deterministically:
//
//   (a) UNGATED   → live passthrough: with nothing patched to gate_in the gate
//                   reads UNPATCHED (read('gatePatched')===false) and the output
//                   TRACKS the source — changing the source's (frozen) frame
//                   changes the output (two FROZEN reads DIFFER).
//   (b) GATE HIGH → output UPDATES: with __freezeframeForceGate=1 the gate reads
//                   PATCHED and the output still TRACKS the source (two FROZEN
//                   reads, source frame changed in between, DIFFER).
//   (c) GATE LOW  → output FROZEN: with __freezeframeForceGate=0 the held frame
//                   PERSISTS even though the source's frozen frame is changed
//                   underneath (two FROZEN reads MATCH within tolerance).
//   (d) QUANT     → raising all four QUANT knobs to max drops the number of
//                   DISTINCT colours at the output (posterization): two FROZEN
//                   reads (full-depth vs max-quant) and the distinct-colour count
//                   collapses.
//
// "Source frame changed in between" is done deterministically by setParam-ing
// ACIDWARP's `scene` (the source rebuilds its pattern texture for the new scene
// — see acidwarp.ts) rather than by waiting for it to ANIMATE: with the clock
// pinned, each (scene) is a bit-stable frozen frame, so a scene swap is a clean
// "the input changed" edge with no timing flake.
//
// The gate scenarios use the deterministic `__freezeframeForceGate` test hook (a
// number = "gate patched at this level") so the freeze-vs-live state is pinned
// without a timing-flaky real LFO. The REAL CV-bridge gate path (a gate source
// patched into gate_in) is covered by the per-module-per-port sweep + the
// freezeframe.test.ts shouldCapture unit tests; this spec proves the end-to-end
// render behaviour.
//
// No waitForTimeout, no poll, no animation-diff, no exact-pixel assert.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';

// FREEZEFRAME's own combined output port (video_out). The harness reads a node's
// OWN FBO by node id (+ optional port); FREEZEFRAME publishes video_out via
// read('outputTexture:video_out'), and outputTexture() prefers that port texture.
const FF_PORT = 'video_out';

// A fixed synchronous burst — large enough that FREEZEFRAME has captured the
// (unpatched/high-gate) source into its hold buffer (holdSeeded) and every
// output pass has run, small enough to stay cheap on CI's software renderer.
const FIXED_STEPS = 6;

/** Read FREEZEFRAME's OWN combined-output FBO ONCE and return luma stats PLUS a
 *  distinct-colour count (5-bit-per-channel buckets) — the posterize headline
 *  metric the shared harness doesn't compute. Single page.evaluate (one
 *  round-trip, no await inside → rAF/decode/blit can't interleave), no poll, no
 *  sleep. Mirrors _render-smoke's gl.readPixels readback. */
async function readColorStats(
  page: Page,
  nodeId: string,
  portId: string,
): Promise<{ nonZeroFrac: number; distinctColors: number; samples: number }> {
  return page.evaluate(({ nodeId, portId }) => {
    const w = globalThis as unknown as {
      __engine: () => {
        getDomain: (d: string) => {
          gl: WebGL2RenderingContext;
          outputTexture: (id: string, port?: string) => WebGLTexture | null;
          res: { width: number; height: number };
        };
      };
    };
    const vid = w.__engine().getDomain('video');
    const gl = vid.gl;
    while (gl.getError() !== gl.NO_ERROR) { /* drain pre-existing */ }
    const tex = vid.outputTexture(nodeId, portId) as WebGLTexture | null;
    const { width: W, height: H } = vid.res;
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    const px = new Uint8Array(W * H * 4);
    if (complete) gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    while (gl.getError() !== gl.NO_ERROR) { /* drain readback */ }

    let n = 0, nonZero = 0;
    const colors = new Set<number>();
    for (let i = 0; i < px.length; i += 4 * 16) {
      const r = px[i]!, g = px[i + 1]!, b = px[i + 2]!;
      if ((r + g + b) / 3 > 8) nonZero++;
      colors.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
      n++;
    }
    return { nonZeroFrac: n ? nonZero / n : 0, distinctColors: colors.size, samples: n };
  }, { nodeId, portId });
}

/** Read a video-engine node diagnostic hook value from the page (e.g.
 *  read('gatePatched') / read('holdSeeded')). */
async function readNodeHook(page: Page, nodeId: string, key: string): Promise<unknown> {
  return page.evaluate(({ nodeId, key }) => {
    const w = globalThis as unknown as {
      __engine: () => { getDomain: (d: string) => { read: (id: string, k: string) => unknown } };
    };
    return w.__engine().getDomain('video').read(nodeId, key);
  }, { nodeId, key });
}

/** setParam on a video node through the engine (deterministic, no Y.Doc write):
 *  drives the handle's setParam directly — used to swap ACIDWARP's frozen frame
 *  (scene) and to crank FREEZEFRAME's QUANT knobs. */
async function setVideoParam(page: Page, nodeId: string, paramId: string, value: number): Promise<void> {
  await page.evaluate(({ nodeId, paramId, value }) => {
    const w = globalThis as unknown as {
      __engine: () => { getDomain: (d: string) => { setParam: (id: string, p: string, v: number) => void } };
    };
    w.__engine().getDomain('video').setParam(nodeId, paramId, value);
  }, { nodeId, paramId, value });
}

test.describe('FREEZEFRAME — video sample & hold + posterize', () => {
  test('(a) ungated = live passthrough; (b/c) gate high updates / gate low freezes', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // Pause the engine rAF loop (the test owns the exact frame count) + pin the
    // engine clock (ACIDWARP halts its scene cycler + palette rotation, so each
    // `scene` is a bit-stable frozen frame) BEFORE boot.
    await installRenderSmokeHooks(page);

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Clear any stale force-gate from a previous test in the worker.
    await page.evaluate(() => {
      (globalThis as unknown as { __freezeframeForceGate?: number | undefined }).__freezeframeForceGate = undefined;
    });

    await spawnPatch(
      page,
      [
        // ACIDWARP — colourful plasma source. scene 0 to start; we swap scene to
        // deterministically change its FROZEN frame (no reliance on animation).
        { id: 'v-src', type: 'acidwarp',    position: { x: 40,  y: 40 }, domain: 'video', params: { speed: 0.5, scene: 0 } },
        { id: 'v-ff',  type: 'freezeframe', position: { x: 380, y: 40 }, domain: 'video' },
        { id: 'v-out', type: 'videoOut',    position: { x: 720, y: 40 }, domain: 'video' },
      ],
      [
        { id: 'e-src-ff', from: { nodeId: 'v-src', portId: 'out' },       to: { nodeId: 'v-ff',  portId: 'video_in' }, sourceType: 'video', targetType: 'video' },
        { id: 'e-ff-out', from: { nodeId: 'v-ff',  portId: 'video_out' }, to: { nodeId: 'v-out', portId: 'in' },       sourceType: 'video', targetType: 'video' },
      ],
    );

    await expect(page.locator('.svelte-flow__node-acidwarp'),    'ACIDWARP visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-freezeframe'), 'FREEZEFRAME visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-videoOut'),    'OUTPUT visible').toBeVisible();

    // ---- (a) UNGATED: live passthrough — output renders + TRACKS the source ----
    // Drive a fixed burst synchronously, read FREEZEFRAME's OWN output FBO once:
    // non-black + structured + exact frame delta + zero GL errors. (Replaces the
    // old waitForMoving poll, which proved "moved" by diffing animated frames.)
    const aBefore = await stepAndReadStats(page, { nodeId: 'v-ff', portId: FF_PORT, steps: FIXED_STEPS });
    assertRenderStats(aBefore, FIXED_STEPS);
    expect(aBefore.nonZeroFrac, 'ungated output renders content').toBeGreaterThan(0);

    // Unpatched gate → the module reports the gate is NOT patched (so it's on the
    // live-passthrough path) and the hold buffer is seeded with real content.
    expect(await readNodeHook(page, 'v-ff', 'gatePatched'), 'ungated → gate reads unpatched').toBe(false);
    expect(await readNodeHook(page, 'v-ff', 'holdSeeded'), 'ungated → hold buffer seeded').toBe(true);

    // LIVE PASSTHROUGH (deterministic): change the source's FROZEN frame (swap
    // scene). With the gate unpatched the output must FOLLOW — a second FROZEN
    // read differs from the first. This is the deterministic equivalent of "the
    // frame keeps changing at the output".
    await setVideoParam(page, 'v-src', 'scene', 2);
    const aAfter = await stepAndReadStats(page, { nodeId: 'v-ff', portId: FF_PORT, steps: FIXED_STEPS });
    expect(aAfter.framesDelta, 'burst advanced the exact frame count').toBe(FIXED_STEPS);
    const aMeanDelta = Math.abs(aAfter.mean - aBefore.mean);
    const aVarDelta = Math.abs(aAfter.variance - aBefore.variance);
    expect(
      aMeanDelta > 1 || aVarDelta > 5,
      `ungated output TRACKS the source: a scene swap changed the output (Δmean=${aMeanDelta.toFixed(2)} Δvar=${aVarDelta.toFixed(2)})`,
    ).toBe(true);

    // ---- (b) GATE HIGH: output updates (tracks the live source) ----
    await page.evaluate(() => {
      (globalThis as unknown as { __freezeframeForceGate?: number }).__freezeframeForceGate = 1;
    });
    const bBefore = await stepAndReadStats(page, { nodeId: 'v-ff', portId: FF_PORT, steps: FIXED_STEPS });
    assertRenderStats(bBefore, FIXED_STEPS);
    // NB: we do NOT assert read('gatePatched') here. That hook reports whether a
    // REAL edge is patched into gate_in (it keys off gateWriteFrame, written only
    // by the CV bridge on a live edge); `__freezeframeForceGate` overrides the
    // gate LEVEL for the test, which is deliberately NOT the same as "patched".
    // The gate-HIGH BEHAVIOUR (output tracks the live source) is proven below.

    // Gate HIGH → still TRACKS: swap scene again, the output must follow (two
    // FROZEN reads differ).
    await setVideoParam(page, 'v-src', 'scene', 4);
    const bAfter = await stepAndReadStats(page, { nodeId: 'v-ff', portId: FF_PORT, steps: FIXED_STEPS });
    expect(bAfter.framesDelta, 'burst advanced the exact frame count').toBe(FIXED_STEPS);
    const bMeanDelta = Math.abs(bAfter.mean - bBefore.mean);
    const bVarDelta = Math.abs(bAfter.variance - bBefore.variance);
    expect(
      bMeanDelta > 1 || bVarDelta > 5,
      `gate HIGH keeps tracking: a scene swap changed the output (Δmean=${bMeanDelta.toFixed(2)} Δvar=${bVarDelta.toFixed(2)})`,
    ).toBe(true);
    expect(bAfter.nonZeroFrac, 'gate-high output renders content').toBeGreaterThan(0);

    // ---- (c) GATE LOW: output FROZEN while the source frame changes underneath ----
    await page.evaluate(() => {
      (globalThis as unknown as { __freezeframeForceGate?: number }).__freezeframeForceGate = 0;
    });
    // Settle the held frame: one burst with the gate LOW captures nothing further,
    // so the hold buffer now holds the LAST captured (scene-4) frame.
    const cFrozen = await stepAndReadStats(page, { nodeId: 'v-ff', portId: FF_PORT, steps: FIXED_STEPS });
    assertRenderStats(cFrozen, FIXED_STEPS);

    // Headline sample-&-hold guarantee, expressed deterministically: change the
    // SOURCE's frozen frame (scene swap) and step a wider burst. With the gate LOW
    // the FROZEN output must NOT follow — two FROZEN reads MATCH within tolerance.
    // (Replaces the old waitForFrozen poll + the stepAndSample(30) animation-diff:
    // here the source is provably DIFFERENT, not merely "still animating".)
    await setVideoParam(page, 'v-src', 'scene', 1);
    const cLater = await stepAndReadStats(page, { nodeId: 'v-ff', portId: FF_PORT, steps: 30 });
    expect(cLater.framesDelta, 'frozen burst advanced the exact frame count').toBe(30);
    const cMeanDelta = Math.abs(cLater.mean - cFrozen.mean);
    const cVarDelta = Math.abs(cLater.variance - cFrozen.variance);
    expect(
      cMeanDelta < 0.5 && cVarDelta < 1.0,
      `gate LOW: frozen frame PERSISTS while the source frame changes underneath (Δmean=${cMeanDelta.toFixed(2)} Δvar=${cVarDelta.toFixed(2)})`,
    ).toBe(true);
    expect(cLater.nonZeroFrac, 'frozen output still shows the held frame').toBeGreaterThan(0);

    // Clean up the hook so it can't leak into another test in the worker.
    await page.evaluate(() => {
      (globalThis as unknown as { __freezeframeForceGate?: number | undefined }).__freezeframeForceGate = undefined;
    });

    expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
  });

  test('(d) raising QUANT knobs drops the distinct-colour count (posterize)', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await installRenderSmokeHooks(page);

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page.evaluate(() => {
      (globalThis as unknown as { __freezeframeForceGate?: number | undefined }).__freezeframeForceGate = undefined;
    });

    // Start with QUANT at 0 (full depth → many colours).
    await spawnPatch(
      page,
      [
        { id: 'v-src', type: 'acidwarp',    position: { x: 40,  y: 40 }, domain: 'video', params: { speed: 0.4, scene: 0 } },
        { id: 'v-ff',  type: 'freezeframe', position: { x: 380, y: 40 }, domain: 'video',
          params: { quant_r: 0, quant_g: 0, quant_b: 0, quant_luma: 0 } },
        { id: 'v-out', type: 'videoOut',    position: { x: 720, y: 40 }, domain: 'video' },
      ],
      [
        { id: 'e-src-ff', from: { nodeId: 'v-src', portId: 'out' },       to: { nodeId: 'v-ff',  portId: 'video_in' }, sourceType: 'video', targetType: 'video' },
        { id: 'e-ff-out', from: { nodeId: 'v-ff',  portId: 'video_out' }, to: { nodeId: 'v-out', portId: 'in' },       sourceType: 'video', targetType: 'video' },
      ],
    );

    await expect(page.locator('.svelte-flow__node-freezeframe'), 'FREEZEFRAME visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-videoOut'),    'OUTPUT visible').toBeVisible();

    // Drive a fixed burst synchronously so full-depth content is on FREEZEFRAME's
    // FBO, then read it once (non-black + structured + exact frame delta + zero GL
    // errors). Capture the FULL-DEPTH distinct-colour count. (Replaces the old
    // waitForContent poll.)
    const fullStats = await stepAndReadStats(page, { nodeId: 'v-ff', portId: FF_PORT, steps: FIXED_STEPS });
    assertRenderStats(fullStats, FIXED_STEPS);
    const full = await readColorStats(page, 'v-ff', FF_PORT);
    expect(full.nonZeroFrac, 'full-depth output renders content').toBeGreaterThan(0);

    // Crank every QUANT knob to MAX (2 levels per channel → heavy posterize).
    // setParam (engine) is deterministic and avoids a per-frame Y.Doc write.
    await setVideoParam(page, 'v-ff', 'quant_r', 1);
    await setVideoParam(page, 'v-ff', 'quant_g', 1);
    await setVideoParam(page, 'v-ff', 'quant_b', 1);
    await setVideoParam(page, 'v-ff', 'quant_luma', 1);

    // Re-render a fixed burst (FROZEN clock + FROZEN source → the ONLY thing that
    // changed is the QUANT params), read the posterized output FBO once. Two
    // FROZEN reads: posterizing to 2 levels per channel collapses the colour space
    // hard, so the distinct-colour count must DROP below the full-depth count.
    // (Replaces the old waitForCondition poll.)
    const quantStats = await stepAndReadStats(page, { nodeId: 'v-ff', portId: FF_PORT, steps: FIXED_STEPS });
    expect(quantStats.framesDelta, 'quant burst advanced the exact frame count').toBe(FIXED_STEPS);
    const quantized = await readColorStats(page, 'v-ff', FF_PORT);
    expect(quantized.nonZeroFrac, 'quantized output still renders content').toBeGreaterThan(0);
    expect(
      quantized.distinctColors,
      `posterize drops distinct colours (full=${full.distinctColors} quantized=${quantized.distinctColors})`,
    ).toBeLessThan(full.distinctColors);

    expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
  });
});
