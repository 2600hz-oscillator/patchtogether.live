// e2e/tests/backdraft.spec.ts
//
// BACKDRAFT (video feedback generator) functional e2e.
//
// Graph (matches the module spec's E2E request):
//   SHAPES (circle)  -> in_a   \
//   SHAPES (squares) -> in_b     BACKDRAFT --> OUTPUT
//   LINES            -> lighten /
//   SHAPES (tris)    -> darken /
//
// The spec asks for LINES + SHAPES as the lighten/darken key masks and a
// couple of video sources into in_a / in_b. We assert:
//   1. all cards spawn + the BACKDRAFT card mounts (its output-surface canvas
//      is mounted but hidden — the in-rack display was removed),
//   2. the wired-up output renders a non-trivial (moving feedback) frame,
//   3. params route through the patch store (MIDI-Learn-wired faders path),
//   4. no console / page errors.
//
// Determinism for the PIXEL baseline lives in the VRT suite (vrt-scenes.ts:
// BACKDRAFT freezes after settle). This spec is the behavioural gate.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats, type RenderStats } from './_render-smoke';
import { SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

// ── SHARED DRIVE HELPERS ────────────────────────────────────────────────────
// Every capture in this file is frame-driven, never wall-clocked. See the
// per-test notes; the rules they all follow are:
//
//   * PAUSE the engine rAF loop (installRenderSmokeHooks) so the test owns the
//     frame count, then call step() a fixed number of times.
//   * WAIT ON A CONDITION for graph readiness, never a duration — the Y.Doc →
//     engine reconcile lands between event-loop turns and how many turns it
//     takes is a RACE (see the PIXELATE note below for the measurements).
//   * Reading the video-out CANVAS (rather than a node's FBO) additionally
//     needs the CARD's own rAF blit to land. That loop is independent of the
//     engine loop and is NOT paused, so wait TWO animation frames — frames, not
//     milliseconds. With the engine paused those rAFs carry no GL work, so this
//     is cheap on every renderer.

/** One event-loop turn per poll, driving one engine frame each, until `nodeId`
 *  is emitting light. Graph-construction readiness — a precondition, not the
 *  thing under test.
 *
 *  ⚠ Scans the WHOLE frame with a stride, never a fixed sample point. A
 *  centre-block probe silently becomes a 20 s hang the moment a source's
 *  content sits somewhere else (measured: MIRROR's small off-centre triangle
 *  misses quarter-point blocks entirely). The readback runs at most a couple of
 *  times — the poll exits as soon as the graph is up — so full-frame is the
 *  cheap option here, not the expensive one. */
async function waitForNodeLit(page: Page, nodeId: string, timeout = 20_000): Promise<void> {
  await page.waitForFunction((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        getDomain: (d: string) => {
          gl: WebGL2RenderingContext;
          step: () => void;
          outputTexture: (n: string) => WebGLTexture | null;
          res: { width: number; height: number };
        };
      };
    };
    if (!w.__engine) return false;
    const vid = w.__engine().getDomain('video');
    vid.step();
    const tex = vid.outputTexture(id);
    if (!tex) return false;
    const gl = vid.gl;
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    let lit = false;
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
      const W = vid.res.width, H = vid.res.height;
      const px = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      for (let i = 0; i < px.length; i += 4 * 16) {
        if (px[i]! > 8 || px[i + 1]! > 8 || px[i + 2]! > 8) { lit = true; break; }
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    while (gl.getError() !== gl.NO_ERROR) { /* drain */ }
    return lit;
  }, nodeId, { timeout });
}

/** Drive the PAUSED engine exactly `steps` frames, synchronously (one evaluate,
 *  so nothing can interleave), then let the card's own rAF blit land. Returns
 *  the exact engine frame delta so the caller can assert the loop really was
 *  paused. */
async function driveFrames(page: Page, steps: number): Promise<number> {
  const delta = await page.evaluate((n) => {
    const w = globalThis as unknown as {
      __engine: () => { getDomain: (d: string) => { step: () => void; currentFrameCount: () => number } };
    };
    const vid = w.__engine().getDomain('video');
    const before = vid.currentFrameCount();
    for (let i = 0; i < n; i++) vid.step();
    return vid.currentFrameCount() - before;
  }, steps);
  // TWO animation frames for the card blit — frames, not milliseconds.
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  return delta;
}

/** Read the VIDEO OUT sink's engine surface (`vid.outputTexture('v-out')` +
 *  readPixels — the texture every present path blits; the card-era probe read
 *  the `video-out-canvas` card chrome, which does not mount on the default
 *  shell). Returns a sparse luma sample grid plus dims so callers can build
 *  stats or mirror comparisons. The claim "the whole chain reaches OUTPUT"
 *  survives: this is the SINK's own surface, not BACKDRAFT's FBO. */
async function readVoutFrame(
  page: Page,
  stride = 16,
): Promise<{ width: number; height: number; data: number[] } | null> {
  return page.evaluate((stride) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        getDomain: (d: string) => {
          gl: WebGL2RenderingContext;
          outputTexture: (id: string, port?: string) => WebGLTexture | null;
          res: { width: number; height: number };
        };
      };
    };
    if (!w.__engine) return null;
    const vid = w.__engine().getDomain('video');
    const gl = vid.gl;
    const tex = vid.outputTexture('v-out');
    if (!tex) return null;
    const { width: W, height: H } = vid.res;
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    const px = new Uint8Array(W * H * 4);
    if (complete) gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    while (gl.getError() !== gl.NO_ERROR) { /* drain */ }
    if (!complete) return null;
    const data: number[] = [];
    for (let i = 0; i < px.length; i += 4 * stride) {
      data.push(px[i]!, px[i + 1]!, px[i + 2]!);
    }
    return { width: W, height: H, data };
  }, stride);
}

test.describe('BACKDRAFT — video feedback generator', () => {
  test('SHAPES/LINES masks + SHAPES sources -> BACKDRAFT -> OUTPUT renders a live feedback frame', async ({ page, errorWatch }) => {
    // ⚠ AND IT STILL NEVER DECLARED ONE — until now. It timed out at the bare
    // 30 s default AGAIN on 2026-09-05, for the third recorded time, and the
    // paragraph below has been sitting here naming the cause the whole time.
    // The frame-driven rewrite it describes was the right fix for the COST; it
    // was never a fix for the CEILING, and the two were conflated. This branch
    // then added a dock open to the file, which put the cost back over.
    // `SLOW_BOOT_TEST_TIMEOUT_MS` is the bound; the FRAMES loop below is still
    // what makes the cost renderer-honest.
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS);
    // FRAME-DRIVEN. This test timed out at the DEFAULT 30 s on CI (#1256 run
    // 30444817370, and twice before that) — it cost 34.8 s there against a 30 s
    // budget it never declared. Its only settle was `waitForTimeout(800)`,
    // which is a different number of frames on every renderer and was the whole
    // overrun: CI's SwiftShader runs this 6-node patch at well under 10 fps.
    // Now the loop is paused and the frames are counted, so the cost is the
    // renderer's true fill rate for FRAMES frames and nothing else.
    //
    // The `rack` fixture is dropped deliberately: it navigates, and the pause
    // hook has to be installed BEFORE the app boots, so this test owns its own
    // navigation. (Same reason SPATIAL TRANSFORM and PIXELATE below dropped it.)
    await installRenderSmokeHooks(page);
    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');
    // Enough frames for the feedback trails to build and the two masks to bite;
    // the assertions below are floors on structure, not on trail depth.
    const FRAMES = 12;

    await spawnPatch(
      page,
      [
        { id: 'src_a',  type: 'shapes',    position: { x: 40,  y: 40  }, domain: 'video', params: { shape: 0, zoom: 1.6 } },
        { id: 'src_b',  type: 'shapes',    position: { x: 40,  y: 260 }, domain: 'video', params: { shape: 1, tile: 1, tileN: 5, zoom: 0.7 } },
        { id: 'mask_l', type: 'lines',     position: { x: 40,  y: 480 }, domain: 'video', params: { amp: 8 } },
        { id: 'mask_d', type: 'shapes',    position: { x: 40,  y: 700 }, domain: 'video', params: { shape: 2, tile: 1, tileN: 4 } },
        { id: 'bd',     type: 'backdraft', position: { x: 460, y: 80  }, domain: 'video',
          params: { mix: 0.5, feedback: 1.05, delay: 16, luma: 1.1, chroma: 1.3, lighten: 0.9, darken: 0.9 } },
        { id: 'v-out',  type: 'videoOut',  position: { x: 980, y: 80  }, domain: 'video' },
      ],
      [
        { id: 'e_a', from: { nodeId: 'src_a',  portId: 'out' }, to: { nodeId: 'bd', portId: 'in_a'    }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e_b', from: { nodeId: 'src_b',  portId: 'out' }, to: { nodeId: 'bd', portId: 'in_b'    }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e_l', from: { nodeId: 'mask_l', portId: 'out' }, to: { nodeId: 'bd', portId: 'lighten' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e_d', from: { nodeId: 'mask_d', portId: 'out' }, to: { nodeId: 'bd', portId: 'darken'  }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e_out', from: { nodeId: 'bd',   portId: 'out' }, to: { nodeId: 'v-out', portId: 'in'   }, sourceType: 'video',      targetType: 'video' },
      ],
    );

    await expect(
      page.locator('.svelte-flow__node[data-id="bd"] [data-testid="module-shell"]'),
      'BACKDRAFT visible',
    ).toBeVisible();
    await expect(
      page.locator('.svelte-flow__node[data-id="v-out"] [data-testid="module-shell"]'),
      'OUTPUT visible',
    ).toBeVisible();
    // (The card-era mounted-but-hidden `backdraft-canvas` anatomy died with the
    // card; the presenting surface lives in the dock body (`backdraft-canvas`
    // there) and is covered by the fullscreen/full-frame specs. The output
    // pixels this spec reads come from the SINK's engine surface.)

    // Graph readiness (a condition, not a duration), then an EXACT frame count.
    // The read below is of the video-out CANVAS on purpose — this test's claim
    // is that the whole chain reaches OUTPUT, so it must not be shortened to a
    // read of BACKDRAFT's own FBO. driveFrames() lets the card's blit land.
    await waitForNodeLit(page, 'bd');
    const delta = await driveFrames(page, FRAMES);
    expect(delta, 'drove the exact frame count (engine loop paused)').toBe(FRAMES);

    // The output should be non-trivial (feedback trails + masks). Assert a
    // spread of pixel values (variance) rather than pixel-exact — that's
    // the VRT suite's job.
    const frame = await readVoutFrame(page, 4);
    const stats = (() => {
      if (!frame) return null;
      let n = 0, sum = 0, sumSq = 0, nonZero = 0;
      for (let i = 0; i < frame.data.length; i += 3) {
        const v = (frame.data[i]! + frame.data[i + 1]! + frame.data[i + 2]!) / 3;
        sum += v; sumSq += v * v; n++;
        if (v > 8) nonZero++;
      }
      const mean = sum / n;
      const variance = sumSq / n - mean * mean;
      return { mean, variance, nonZeroFrac: nonZero / n };
    })();
    expect(stats, 'sink surface readable').not.toBeNull();
    expect(stats!.nonZeroFrac, 'output is not all-black (feedback rendered)').toBeGreaterThan(0.02);
    expect(stats!.variance, 'output has spatial structure (trails + masks)').toBeGreaterThan(20);

  });

  test('FREEZE holds the output still (deterministic capture hook)', async ({ page }) => {
    // ⚠ BARE DEFAULT, AND THIS FILE HAS NOW LOST THREE TESTS TO IT. The feedback
    // case above records two earlier CI deaths on the undeclared 30 s; this one
    // and the DELAY CLOCK case joined them on run 33996525110, both with a
    // plain `Test timeout` and no call log — nothing stuck, the whole test just
    // ran out. Four of this file's tests already declare a budget; these were
    // the two that never did. A BOUND, not a claim: neither asserts a latency.
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS);
    // ⚠ THIS TEST WAS VACUOUS. It asserted only `expect(b).toEqual(a)` on two
    // samples 200 ms apart — and a BLACK canvas satisfies that perfectly. It
    // could not tell "FREEZE held the picture still" from "there was never a
    // picture", so it would have passed with the render dead. Same defect class
    // as PIXELATE below, found by the same question: why are the green runs
    // green?
    //
    // It now (a) asserts the frozen frame is a REAL picture, and (b) carries
    // its own NEGATIVE CONTROL — the UNFROZEN loop must first be shown to
    // CHANGE between samples, so we know the comparison can detect motion at
    // all before we assert its absence. Without that, "identical" proves
    // nothing about FREEZE.
    //
    // Also frame-driven now: the three wall-clock settles (500/150/200 ms) were
    // renderer-dependent, and the 200 ms "many rAFs" gap was the load-bearing
    // one — on a slow renderer it could be ZERO engine frames, which would make
    // the stillness assertion trivially true for a second reason.
    await installRenderSmokeHooks(page);
    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');
    const FRAMES = 8;

    await spawnPatch(
      page,
      [
        { id: 'src_a', type: 'shapes',    position: { x: 40,  y: 40 }, domain: 'video', params: { shape: 0, zoom: 1.6 } },
        { id: 'bd',    type: 'backdraft', position: { x: 460, y: 80 }, domain: 'video', params: { feedback: 1.1, delay: 16 } },
        { id: 'v-out', type: 'videoOut',  position: { x: 980, y: 80 }, domain: 'video' },
      ],
      [
        { id: 'e_a',   from: { nodeId: 'src_a', portId: 'out' }, to: { nodeId: 'bd',    portId: 'in_a' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e_out', from: { nodeId: 'bd',    portId: 'out' }, to: { nodeId: 'v-out', portId: 'in'   }, sourceType: 'video',      targetType: 'video' },
      ],
    );

    await waitForNodeLit(page, 'bd');

    const sample = async (): Promise<number[]> => {
      const f = await readVoutFrame(page, 64);
      if (!f) return [];
      // Red channel only (matches the card-era sample).
      const out: number[] = [];
      for (let i = 0; i < f.data.length; i += 3) out.push(f.data[i]!);
      return out;
    };

    const setFreeze = (v: number) =>
      page.evaluate((fv) => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { params: Record<string, number> }> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          const n = w.__patch.nodes['bd'];
          if (n) n.params.freeze = fv;
        });
      }, v);

    // ── NEGATIVE CONTROL: the loop is LIVE and the comparison can see it ──
    // Drive frames with FREEZE OFF; the feedback ring is still filling, so the
    // output must MOVE. If this fails, the stillness assertion below would have
    // been meaningless — nothing was ever changing.
    await driveFrames(page, FRAMES);
    const live0 = await sample();
    await driveFrames(page, FRAMES);
    const live1 = await sample();
    expect(live0.length, 'canvas readable').toBeGreaterThan(0);
    const moved = live1.reduce((n, v, i) => n + (v === live0[i] ? 0 : 1), 0);
    expect(
      moved,
      `UNFROZEN the output moves between samples (${moved}/${live0.length} samples changed) — ` +
      'the control that makes the stillness assertion below meaningful',
    ).toBeGreaterThan(0);

    // ── AND IT IS A REAL PICTURE, not a black frame ──────────────────────
    // The old test asserted only equality, which black satisfies.
    const lit = live1.filter((v) => v > 8).length;
    expect(
      lit / live1.length,
      `the frame under test is LIT, not black (${lit}/${live1.length} samples above 8/255)`,
    ).toBeGreaterThan(0.02);

    // ── THE ASSERTION: FREEZE holds it still ─────────────────────────────
    await setFreeze(1);
    await driveFrames(page, FRAMES);
    const a = await sample();
    await driveFrames(page, FRAMES);
    const b = await sample();
    expect(b, `FROZEN the output is identical across ${FRAMES} driven frames`).toEqual(a);
  });

  test('SPATIAL TRANSFORM (zoom+rotate) changes the feedback geometry vs identity', async ({ page }) => {
    // FRAME-COUNTED, NOT WALL-CLOCKED. BACKDRAFT is an ITERATED feedback loop —
    // the tunnel compounds one level per RENDERED FRAME — so "settled enough to
    // compare" is a frame COUNT and never a duration.
    //
    // This capture used to `waitForTimeout(1200)`. MEASURED, that one duration
    // buys wildly different numbers of frames (engine frame-counter delta over
    // the 1200 ms window, dev server, 1 worker):
    //
    //   renderer            identity capture     tunnel capture
    //   real GPU (Metal)    146 frames           145 frames
    //   SwiftShader         0 frames (!)         32 frames
    //
    // The identity capture NEVER GOT PAST ENGINE FRAME 4 on the software
    // renderer: BACKDRAFT's first-spawn shader compile eats the whole window on
    // the main thread and the rAF loop does not tick once. So on CI this test
    // (a) spent its entire budget waiting on background rendering, which is what
    // blew the DEFAULT 30 s timeout on main (7abf607c, e2e shard 1/10), and
    // (b) was comparing an UNSETTLED identity frame against a settled tunnel —
    // a wall-clock budget is not one assertion, it is a different assertion per
    // machine.
    //
    // It is SLOWNESS, not a different result: with both captures settled, the
    // two renderers agree to <0.5% (meanDiff 160.4 SwiftShader vs 159.7 real
    // GPU, changedFrac 0.869 on both).
    //
    // Fix: pause the engine rAF loop + pin the sim clock (installRenderSmokeHooks)
    // and drive an EXACT step count ourselves, then read BACKDRAFT's own output
    // texture. The capture is now exactly SETTLE_STEPS frames on EVERY renderer,
    // nothing renders that the assertion doesn't need, and the freeze/settle
    // sleeps are gone (a paused loop is already frame-stable). Same pattern as
    // backdraft-render-smoke.spec.ts / backdraft-pure-tv.spec.ts.
    //
    // NEGATIVE-CONTROLLED (the instrument, not just the code): re-running with
    // BOTH captures at identity gives meanDiff 0.000 / changedFrac 0.00000 —
    // byte-identical frames, and the test correctly FAILS. So the metric moves
    // with the transform and nothing else, and the paused-loop drive is
    // bit-reproducible rather than merely stable.
    //
    // The budget is explicit because the test is COMPUTE-bound: 2 x 30 frames
    // plus two first-spawn shader compiles on a software renderer is real time,
    // and a simulation-bound test should not inherit a default tuned for
    // pure-function assertions.
    test.setTimeout(90_000);

    // Frames of UNFROZEN feedback per capture. delay=0 taps the most recent
    // frame, so the transform compounds every step; 30 matches the settle the
    // DRS uses (well past cold-start at this near-zero delay — the LAZY ring
    // holds only the couple of slots that delay needs; its cap is
    // BACKDRAFT_BUFFER_FRAMES).
    const SETTLE_STEPS = 30;

    // Pause the rAF loop + pin the clock BEFORE the app boots.
    await installRenderSmokeHooks(page);

    // Two runs of the SAME feedback scene: one at identity (zoom=1,
    // rotate=0 → 1:1 tap, the original behaviour) and one with a tunnel
    // transform (zoom>1 + rotate). The transformed run must produce a
    // MEANINGFULLY DIFFERENT frame — proving the transform actually moves
    // where the feedback tap samples (tunnels/spirals), not just brightness.
    async function captureFrame(
      transform: { zoom: number; rotate: number },
    ): Promise<{ framesDelta: number; fbComplete: boolean; samples: number[] }> {
      // FRESH RACK PER CAPTURE (restored from pre-fixture main): both
      // captures spawn the SAME node ids, so re-spawning onto the live doc
      // would read capture 1's already-settled feedback ring (identical
      // frames, diff exactly 0 — the shard-1 failure on #1036).
      await page.goto('/rack?seed=none');
      await page.waitForLoadState('networkidle');
      await spawnPatch(
        page,
        [
          { id: 'src_a', type: 'shapes',    position: { x: 40,  y: 40 }, domain: 'video', params: { shape: 0, tile: 0, zoom: 0.5 } },
          { id: 'bd',    type: 'backdraft', position: { x: 460, y: 80 }, domain: 'video',
            params: { mix: 0, feedback: 0.95, delay: 0, chroma: 1.4, zoom: transform.zoom, rotate: transform.rotate } },
          { id: 'v-out', type: 'videoOut',  position: { x: 980, y: 80 }, domain: 'video' },
        ],
        [
          { id: 'e_a',   from: { nodeId: 'src_a', portId: 'out' }, to: { nodeId: 'bd',    portId: 'in_a' }, sourceType: 'mono-video', targetType: 'video' },
          { id: 'e_out', from: { nodeId: 'bd',    portId: 'out' }, to: { nodeId: 'v-out', portId: 'in'   }, sourceType: 'video',      targetType: 'video' },
        ],
      );
      // Drive the feedback loop a FIXED number of frames inside ONE evaluate
      // (no await between steps, so nothing can interleave), then read the
      // BACKDRAFT node's own output FBO. No freeze needed: with the rAF loop
      // paused the texture holds the last drawn frame by construction.
      return page.evaluate(({ steps }) => {
        const w = globalThis as unknown as {
          __videoEngineFreezeTime?: number;
          __engine: () => {
            getDomain: (d: string) => {
              gl: WebGL2RenderingContext;
              step: () => void;
              markWatched: (id: string) => void;
              currentFrameCount: () => number;
              outputTexture: (id: string, port?: string) => WebGLTexture | null;
              res: { width: number; height: number };
            };
          };
        };
        const vid = w.__engine().getDomain('video');
        const gl = vid.gl;
        const before = vid.currentFrameCount();
        for (let n = 0; n < steps; n++) {
          // Advance the PINNED sim clock by exactly one virtual camera frame,
          // so the source is bit-reproducible at any render speed.
          w.__videoEngineFreezeTime = 2 + (n + 0.5) / 60;
          // Keep the chain a pull-eval root for the whole burst: the watch mark
          // is wall-clock TTL'd (1500 ms) and a 30-frame software-renderer
          // burst outlives that, which would silently stop drawing 'bd'.
          vid.markWatched('bd');
          vid.step();
        }
        const framesDelta = vid.currentFrameCount() - before;

        const tex = vid.outputTexture('bd') as WebGLTexture | null;
        const { width: W, height: H } = vid.res;
        const fb = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        const fbComplete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        const px = new Uint8Array(W * H * 4);
        if (fbComplete) gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fb);
        while (gl.getError() !== gl.NO_ERROR) { /* drain */ }

        const samples: number[] = [];
        for (let i = 0; i < px.length; i += 4 * 32) samples.push(px[i]!);
        return { framesDelta, fbComplete, samples };
      }, { steps: SETTLE_STEPS });
    }

    const idCap = await captureFrame({ zoom: 1, rotate: 0 });
    const tunCap = await captureFrame({ zoom: 1.12, rotate: 14 });
    const identity = idCap.samples;
    const tunnel = tunCap.samples;

    // The frame COUNT is the renderer-independent contract this test rests on:
    // both captures drove exactly SETTLE_STEPS frames, on any renderer. (Also
    // catches a loop that wasn't paused, or a node pull-eval skipped.)
    expect(idCap.framesDelta, 'identity capture drove the exact frame count (loop paused)').toBe(SETTLE_STEPS);
    expect(tunCap.framesDelta, 'tunnel capture drove the exact frame count (loop paused)').toBe(SETTLE_STEPS);
    expect(idCap.fbComplete && tunCap.fbComplete, 'BACKDRAFT output FBO readable in both captures').toBe(true);

    expect(identity.length).toBeGreaterThan(0);
    expect(tunnel.length).toBe(identity.length);

    // Mean-absolute pixel difference across the sampled grid. A pure 1:1
    // tap (identity) holds the source still; the tunnel transform drags
    // the echoes inward + rotates them → a large fraction of pixels differ.
    let diff = 0, changed = 0;
    for (let i = 0; i < identity.length; i++) {
      const d = Math.abs(tunnel[i]! - identity[i]!);
      diff += d;
      if (d > 16) changed++;
    }
    const meanDiff = diff / identity.length;
    const changedFrac = changed / identity.length;
    // Measured at SETTLE_STEPS=30 over 24576 samples: meanDiff 160.4 /
    // changedFrac 0.869 on SwiftShader vs 159.7 / 0.869 on a real GPU — the two
    // renderers now agree to <0.5% because they run the IDENTICAL frame count.
    expect(meanDiff, `transform shifts pixel values vs identity (meanDiff ${meanDiff.toFixed(2)}/255, floor 4)`).toBeGreaterThan(4);
    expect(changedFrac, `a real fraction of pixels move (tunnel geometry) (changedFrac ${changedFrac.toFixed(4)}, floor 0.05)`).toBeGreaterThan(0.05);
  });

  test('PIXELATE reduces the source resolution (1.0 → flat frame; 0 → unchanged)', async ({ page }) => {
    // FRAME-DRIVEN, AND THE FLAT FRAME MUST BE **LIT**.
    //
    // This test timed out at the DEFAULT 30 s on main (017f61df, e2e shard
    // 1/10) on both the attempt and the retry. It was not stuck: the trace
    // shows all three assertions COMPLETING, successfully, at 31.8 s. It was
    // simply ~32 s of work in a 30 s box, and every second of that was
    // avoidable — see the three problems below.
    //
    // ── 1. IT WAS VACUOUS ────────────────────────────────────────────────
    // The pixelate=1 assertions were passing for the WRONG REASON. `pixelate`
    // is a POINT SAMPLE, not an average: at 1.0, cells=1 and every uv maps to
    // the single centre texel (0.5, 0.5) — see backdraftPixelateUv(). The old
    // source (`tileN: 6`) is BLACK at its centre, so the "collapsed" frame was
    // pure black (mean 0.0, nonZeroFrac 0.000, variance 0.0), and:
    //
    //     expect(varFlat).toBeLessThan(5)
    //     expect(varFlat).toBeLessThan(varFull / 8)
    //
    // are BOTH satisfied by black. The test could not tell "PIXELATE collapsed
    // the image to one colour" from "the render died" — it would have passed
    // with BACKDRAFT emitting nothing at all.
    //
    // FIX: `tileN: 6` → `tileN: 5` moves the tiling so the source centre is
    // LIT. Measured on BACKDRAFT's own FBO (SwiftShader): pixelate=1 now gives
    // mean 255.0, variance 0.00, nonZeroFrac 1.00 — flat AND lit. The new
    // nonZeroFrac floor is what makes the two flatness assertions non-vacuous,
    // and it is the assertion that actually proves the documented behaviour
    // ("collapses to one representative colour"). p=0 is unaffected: variance
    // 15622 vs 15789 with the old tiling.
    //
    // ⚠ Luma variance is INVARIANT TO BLOCK SIZE — a mosaic has nearly the same
    // luma histogram as its source, so variance cannot see pixelation at all
    // except at the cells=1 endpoint (measured: variance moves 0.2 % across
    // pixelate 0.1→0.99, then collapses at exactly 1.0). This test is therefore
    // an ENDPOINT test by construction. Do not extend it to mid-range values
    // with this metric — it is blind there; block-size needs a spatial measure.
    //
    // ── 2. THREE PAGE LOADS FOR TWO CAPTURES ─────────────────────────────
    // It took the `rack` fixture (which navigates) AND re-navigated per
    // capture. Same waste #1249 removed from SPATIAL TRANSFORM. The fixture is
    // dropped; each capture owns its navigation.
    //
    // ── 3. WALL-CLOCK SETTLES ────────────────────────────────────────────
    // `waitForTimeout(400)` + a freeze + `waitForTimeout(120)` per capture,
    // i.e. ~1 s per capture of renderer-dependent guessing. Replaced by the DRS
    // harness: pause the rAF loop, pin the clock, drive an EXACT frame count,
    // read BACKDRAFT's own output FBO. No freeze needed — a paused loop holds
    // the last drawn frame by construction.
    //
    // ⚠ WHAT THE CAPTURE IS ACTUALLY WAITING FOR IS GRAPH READINESS, AND IT IS
    // A RACE — not a fixed number of frames, and not a fixed number of yields.
    // On a COLD page the first driven frame renders black for the SOURCE too
    // (`src_a` variance 0), i.e. the whole graph is not up yet; async module
    // init (shader compile / texture upload) has to land first, and that only
    // happens BETWEEN event-loop turns. Measured from cold, one frame per turn:
    //
    //     turn 0 → bd var 0      src var 0        (nothing is up)
    //     turn 1 → bd var 15622  src var 15622    (up, and stable thereafter)
    //
    // A big synchronous burst does NOT fix it (30 frames in one evaluate still
    // reads black) and neither does a fixed yield count — how many turns it
    // takes is a race, which is exactly why the old `waitForTimeout(400)`
    // appeared to work: it yielded for long enough, on that machine, that day.
    //
    // So wait on the CONDITION, driving one frame per poll: the wait is in
    // frames + turns, never a duration, and it self-limits at ~4 ms warm.
    //
    // Gating on the SOURCE (not on `bd`) keeps it honest — "the source is
    // producing an image" is a precondition, not the thing under test, so the
    // wait cannot make the bd assertions self-fulfilling.
    //
    // An UNBOUNDED readiness wait is safe HERE specifically because this scene
    // has no feedback (mix=0, feedback=0): bd's output is a pure function of
    // the source in a single pass, so it is frame-count INDEPENDENT. (Contrast
    // SPATIAL TRANSFORM above, where the frame count IS the assertion and the
    // burst must therefore be exact.)
    test.setTimeout(60_000);

    // Frames driven for the measured capture, once the graph is ready. One is
    // sufficient (single-pass, no feedback); four is free margin on a paused loop.
    const STEPS = 4;

    // Pause the engine rAF loop + pin the clock BEFORE the app boots.
    await installRenderSmokeHooks(page);

    async function capture(pixelate: number): Promise<RenderStats> {
      // FRESH RACK PER CAPTURE: both captures spawn the SAME node ids, so
      // re-spawning onto the live doc would read the previous scene.
      await page.goto('/rack?seed=none');
      await page.waitForLoadState('networkidle');
      await spawnPatch(
        page,
        [
          { id: 'src_a', type: 'shapes',    position: { x: 40,  y: 40 }, domain: 'video',
            params: { shape: 1, tile: 1, tileN: 5, zoom: 0.8 } },
          { id: 'bd',    type: 'backdraft', position: { x: 460, y: 80 }, domain: 'video',
            params: { mix: 0, feedback: 0, delay: 16, pixelate } },
          { id: 'v-out', type: 'videoOut',  position: { x: 980, y: 80 }, domain: 'video' },
        ],
        [
          { id: 'e_a',   from: { nodeId: 'src_a', portId: 'out' }, to: { nodeId: 'bd',    portId: 'in_a' }, sourceType: 'mono-video', targetType: 'video' },
          { id: 'e_out', from: { nodeId: 'bd',    portId: 'out' }, to: { nodeId: 'v-out', portId: 'in'   }, sourceType: 'video',      targetType: 'video' },
        ],
      );
      // GRAPH-READY GATE (see the note above): drive ONE frame per poll until
      // the SOURCE is actually emitting light. Frames + event-loop turns, never
      // a duration; ~4 ms once warm.
      await page.waitForFunction(() => {
        const w = globalThis as unknown as {
          __engine?: () => {
            getDomain: (d: string) => {
              gl: WebGL2RenderingContext;
              step: () => void;
              outputTexture: (id: string) => WebGLTexture | null;
              res: { width: number; height: number };
            };
          };
        };
        if (!w.__engine) return false;
        const vid = w.__engine().getDomain('video');
        vid.step();
        const tex = vid.outputTexture('src_a');
        if (!tex) return false;
        const gl = vid.gl;
        const fb = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        let lit = false;
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
          // FOUR blocks spread across the frame, not one in the middle: the
          // gate must not depend on the source's tiling phase (a centre-only
          // probe silently becomes a 20 s hang the moment someone changes
          // tileN and the centre lands on a dark cell). Cheap — 4 x 16x16.
          const N = 16;
          const px = new Uint8Array(N * N * 4);
          const W = vid.res.width, H = vid.res.height;
          const spots: Array<[number, number]> = [
            [W >> 2, H >> 2], [(W * 3) >> 2, H >> 2],
            [W >> 2, (H * 3) >> 2], [(W * 3) >> 2, (H * 3) >> 2],
          ];
          for (const [cx, cy] of spots) {
            gl.readPixels(
              Math.max(0, Math.min(W - N, cx - (N >> 1))),
              Math.max(0, Math.min(H - N, cy - (N >> 1))),
              N, N, gl.RGBA, gl.UNSIGNED_BYTE, px,
            );
            for (let i = 0; i < px.length; i += 4) { if (px[i]! > 8) { lit = true; break; } }
            if (lit) break;
          }
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fb);
        while (gl.getError() !== gl.NO_ERROR) { /* drain */ }
        return lit;
      }, undefined, { timeout: 20_000 });
      return stepAndReadStats(page, { nodeId: 'bd', steps: STEPS });
    }

    const full = await capture(0);   // identity → keeps structure
    const flat = await capture(1);   // cells=1  → one representative colour

    // The renderer-independent contract this test rests on: both captures drove
    // exactly STEPS frames on ANY renderer, and both reads were real.
    expect(full.framesDelta, 'identity capture drove the exact frame count (loop paused)').toBe(STEPS);
    expect(flat.framesDelta, 'flat capture drove the exact frame count (loop paused)').toBe(STEPS);
    expect(full.fbComplete && flat.fbComplete, 'BACKDRAFT output FBO readable in both captures').toBe(true);
    expect(full.glErrors, `GL errors in the identity capture: [${full.glErrors.join(',')}]`).toEqual([]);
    expect(flat.glErrors, `GL errors in the flat capture: [${flat.glErrors.join(',')}]`).toEqual([]);

    // THE ANTI-VACUITY ASSERTION. Without this, every assertion below is also
    // satisfied by a black frame / a dead render (which is exactly what shipped).
    // Measured: nonZeroFrac 1.00, mean 255.0 on SwiftShader.
    expect(
      flat.nonZeroFrac,
      `the collapsed frame is LIT, not black — it is the source's centre colour (nonZeroFrac ${flat.nonZeroFrac.toFixed(3)}, mean ${flat.mean.toFixed(1)})`,
    ).toBeGreaterThan(0.9);

    // Measured on BACKDRAFT's FBO (SwiftShader): varFull 15622.5, varFlat 0.00.
    // Floors kept generous so driver pixel divergence can never trip them.
    expect(full.variance, `pixelate=0 keeps the source structure (variance ${full.variance.toFixed(1)}, floor 40)`).toBeGreaterThan(40);
    expect(flat.variance, `pixelate=1 collapses to a near-flat frame (variance ${flat.variance.toFixed(2)}, ceiling 5)`).toBeLessThan(5);
    expect(flat.variance, 'pixelate=1 is far flatter than pixelate=0').toBeLessThan(full.variance / 8);
  });

  test('DELAY CLOCK input overrides the DELAY knob (CLK badge appears when patched)', async ({ page, rack, errorWatch }) => {
    // ⚠ BARE DEFAULT, AND THIS FILE HAS NOW LOST THREE TESTS TO IT. The feedback
    // case above records two earlier CI deaths on the undeclared 30 s; this one
    // and the DELAY CLOCK case joined them on run 33996525110, both with a
    // plain `Test timeout` and no call log — nothing stuck, the whole test just
    // ran out. Four of this file's tests already declare a budget; these were
    // the two that never did. A BOUND, not a claim: neither asserts a latency.
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS);
    // Drive the DELAY CLOCK gate input with an LFO (its phase0 CV output is a
    // steady periodic swing). When the delay_clock cable is patched, the card
    // must flip the Delay knob into the "clock-driven" (overridden) state and
    // show the CLK badge.
    await spawnPatch(
      page,
      [
        { id: 'src_a', type: 'shapes',    position: { x: 40,  y: 40 },  domain: 'video', params: { shape: 0, zoom: 1.4 } },
        { id: 'lfo',   type: 'lfo',       position: { x: 40,  y: 320 }, params: { rate: 4 } },
        { id: 'bd',    type: 'backdraft', position: { x: 460, y: 80 },  domain: 'video', params: { feedback: 1.0, delay: 16 } },
        { id: 'v-out', type: 'videoOut',  position: { x: 980, y: 80 },  domain: 'video' },
      ],
      [
        { id: 'e_a',   from: { nodeId: 'src_a', portId: 'out'    }, to: { nodeId: 'bd',    portId: 'in_a'        }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e_out', from: { nodeId: 'bd',    portId: 'out'    }, to: { nodeId: 'v-out', portId: 'in'          }, sourceType: 'video',      targetType: 'video' },
        { id: 'e_clk', from: { nodeId: 'lfo',   portId: 'phase0' }, to: { nodeId: 'bd',    portId: 'delay_clock' }, sourceType: 'cv',         targetType: 'cv' },
      ],
    );

    await expect(page.locator('.svelte-flow__node[data-id="bd"] [data-testid="module-shell"]')).toHaveCount(1);
    // The live-override badge appears on the DELAY fader cell once the clock
    // cable is patched — the faceplate half of the card's CLK badge, driven by
    // the SAME shared predicate (param-override-badges.ts /
    // backdraft-clocked-delay.ts, so the two surfaces cannot disagree). The
    // DELAY fader lives on the DOCK ladder (probed: zero delay cells in the
    // lane tile), so open the pane and assert there.
    await page.waitForFunction(
      () =>
        typeof (globalThis as unknown as { __openDockFullView?: unknown }).__openDockFullView ===
        'function',
      undefined,
      { timeout: 30_000 },
    );
    await page.evaluate(
      (i) => (globalThis as unknown as { __openDockFullView: (x: string) => void }).__openDockFullView(i),
      'bd',
    );
    const bdPane = page.locator('[data-testid="dock-fullview-pane"][data-pane-node="bd"]');
    await expect(bdPane).toBeVisible({ timeout: 60_000 });
    // The DELAY fader sits on the 'loop' faceplate tab; inactive pages are
    // display:none (the tabbed-dock recipe), so activate it before asserting.
    await bdPane.locator('[data-testid="faceplate-tab-loop"]').click();
    await expect(
      bdPane.locator('[data-testid="face-override-badge-delay"]'),
      'override badge shows the DELAY fader is clock-overridden',
    ).toBeVisible({ timeout: 60_000 });

  });

  test('MIRROR X / MIRROR Y fold the output (kaleidoscope) + gate toggles the param', async ({ page }) => {
    // CI-load robustness: this heavy video-feedback spec reads the WebGL output
    // canvas several times under the SwiftShader software renderer (far slower
    // than a real GPU). The flat 30s default timed out under CI load (#790).
    // Match the sibling WebGL-heavy specs' generous per-test budget.
    test.setTimeout(90_000);
    // Drive BACKDRAFT with an ASYMMETRIC source (a single small off-centre
    // shape) and NO feedback, so the output is essentially the folded source.
    // We then read the video-out canvas and assert the fold symmetries:
    //   MIRROR X → right half mirrors the left,
    //   MIRROR Y → bottom half mirrors the top (VISUALLY top→bottom),
    //   both    → 4-way (quadrant) symmetric.
    async function setMirror(mx: number, my: number): Promise<void> {
      await page.evaluate(([mx, my]) => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { params: Record<string, number> }> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          const n = w.__patch.nodes['bd'];
          if (n) { n.params.mirrorX = mx; n.params.mirrorY = my; n.params.freeze = 0; }
        });
      }, [mx, my]);
      // Frames, not milliseconds: drive the fold through the (paused) engine.
      await driveFrames(page, 4);
      // Freeze for a stable read.
      await page.evaluate(() => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { params: Record<string, number> }> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => { const n = w.__patch.nodes['bd']; if (n) n.params.freeze = 1; });
      });
      await driveFrames(page, 2);
    }

    // Sample a small grid of luma values + dims so we can compare mirrored
    // positions — read at the SINK's engine surface (see readVoutFrame). NB
    // readPixels rows are bottom-origin; the mirror comparisons are symmetric
    // under a vertical flip EXCEPT the kept-half check, which flips its labels
    // accordingly (the engine's row 0 is the VISUAL bottom).
    function readGrid() {
      return page.evaluate(() => {
        const w = globalThis as unknown as {
          __engine?: () => {
            getDomain: (d: string) => {
              gl: WebGL2RenderingContext;
              outputTexture: (id: string, port?: string) => WebGLTexture | null;
              res: { width: number; height: number };
            };
          };
        };
        if (!w.__engine) return null;
        const vid = w.__engine().getDomain('video');
        const gl = vid.gl;
        const tex = vid.outputTexture('v-out');
        if (!tex) return null;
        const { width, height } = vid.res;
        const fb = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        const img = new Uint8Array(width * height * 4);
        if (complete) gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fb);
        while (gl.getError() !== gl.NO_ERROR) { /* drain */ }
        if (!complete) return null;
        const luma = (x: number, y: number): number => {
          const xi = Math.max(0, Math.min(width - 1, Math.round(x)));
          // Flip to VISUAL y (readPixels is bottom-origin).
          const yi = Math.max(0, Math.min(height - 1, height - 1 - Math.round(y)));
          const i = (yi * width + xi) * 4;
          return (img[i]! + img[i + 1]! + img[i + 2]!) / 3;
        };
        // Sample a 9x9 interior grid (avoid exact edges/centre seam).
        const pts: { x: number; y: number; v: number }[] = [];
        for (let gy = 1; gy <= 9; gy++) {
          for (let gx = 1; gx <= 9; gx++) {
            const x = (gx / 10) * width;
            const y = (gy / 10) * height;
            pts.push({ x, y, v: luma(x, y) });
          }
        }
        return { width, height, pts };
      });
    }

    await installRenderSmokeHooks(page);
    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [
        // A rotated triangle (asymmetric on BOTH axes) so each fold has a
        // visible effect. mix=0 → use only in_a. No feedback (output ≈ folded
        // source). A triangle points, and rotating it breaks left/right
        // symmetry too, so MIRROR X and MIRROR Y both change the frame.
        { id: 'src_a', type: 'shapes',    position: { x: 40,  y: 40 }, domain: 'video',
          params: { shape: 2, tile: 0, rotate: 0.9, zoom: 0.6 } },
        { id: 'bd',    type: 'backdraft', position: { x: 460, y: 80 }, domain: 'video',
          params: { mix: 0, feedback: 0, delay: 16, mirrorX: 0, mirrorY: 0 } },
        { id: 'v-out', type: 'videoOut',  position: { x: 980, y: 80 }, domain: 'video' },
      ],
      [
        { id: 'e_a',   from: { nodeId: 'src_a', portId: 'out' }, to: { nodeId: 'bd',    portId: 'in_a' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e_out', from: { nodeId: 'bd',    portId: 'out' }, to: { nodeId: 'v-out', portId: 'in'   }, sourceType: 'video',      targetType: 'video' },
      ],
    );
    await waitForNodeLit(page, 'bd');

    // Baseline: UNFOLDED frame (both mirrors off). Used to identify which
    // half each fold KEEPS (the half that equals the unfolded source).
    await setMirror(0, 0);
    const gUnfolded = await readGrid();
    expect(gUnfolded).not.toBeNull();

    // ⚠ ANTI-VACUITY PRECONDITION. Every symmetry assertion below is of the
    // form `meanAbsDiff < 12`, and a BLACK frame scores 0 — so all three would
    // pass with the render dead. (Only the top-vs-bottom KEPT-half assertion,
    // which is a strict >, could ever have caught that.) Pin here, once, that
    // there is a real asymmetric picture to fold: it must be LIT, and it must
    // have STRUCTURE — a uniform fill is trivially symmetric under every fold.
    {
      const vs = gUnfolded!.pts.map((p) => p.v);
      const litFrac = vs.filter((v) => v > 8).length / vs.length;
      const mean = vs.reduce((a, b) => a + b, 0) / vs.length;
      const variance = vs.reduce((a, b) => a + (b - mean) ** 2, 0) / vs.length;
      expect(litFrac, `the unfolded frame is LIT (${(litFrac * 100).toFixed(1)}% of grid samples above 8/255)`)
        .toBeGreaterThan(0.02);
      expect(variance, `the unfolded frame has STRUCTURE to fold (variance ${variance.toFixed(1)}) — ` +
        'a flat frame is symmetric under every mirror and would pass vacuously')
        .toBeGreaterThan(20);
    }

    // Helper: mean-abs difference between each point and its mirror partner.
    const lumaMap = (g: NonNullable<Awaited<ReturnType<typeof readGrid>>>) => {
      const m = new Map<string, number>();
      for (const p of g.pts) m.set(`${Math.round(p.x)},${Math.round(p.y)}`, p.v);
      return { g, m };
    };

    // ---- MIRROR X: right half mirrors left ----
    await setMirror(1, 0);
    const gx = await readGrid();
    expect(gx).not.toBeNull();
    {
      const { g, m } = lumaMap(gx!);
      let diff = 0, n = 0;
      for (const p of g.pts) {
        if (p.x > g.width / 2) continue; // compare left → its mirror on the right
        const partner = m.get(`${Math.round(g.width - p.x)},${Math.round(p.y)}`);
        if (partner === undefined) continue;
        diff += Math.abs(p.v - partner); n++;
      }
      expect(n).toBeGreaterThan(0);
      expect(diff / n, 'MIRROR X: right half mirrors the left').toBeLessThan(12);
    }

    // ---- MIRROR Y: bottom mirrors top ----
    await setMirror(0, 1);
    const gy = await readGrid();
    {
      const { g, m } = lumaMap(gy!);
      let diff = 0, n = 0;
      for (const p of g.pts) {
        if (p.y > g.height / 2) continue; // compare top → its mirror at the bottom
        const partner = m.get(`${Math.round(p.x)},${Math.round(g.height - p.y)}`);
        if (partner === undefined) continue;
        diff += Math.abs(p.v - partner); n++;
      }
      expect(n).toBeGreaterThan(0);
      expect(diff / n, 'MIRROR Y: bottom half mirrors the top').toBeLessThan(12);
    }

    // ---- MIRROR Y reads VISUALLY top→bottom (not bottom→top) ----
    // The KEPT half is the one whose pixels still equal the UNFOLDED frame;
    // the reflected half differs. For a correct top→bottom fold the TOP half
    // is kept (≈ unfolded) and the BOTTOM is replaced by the reflection.
    {
      const folded = gy!;
      const base = gUnfolded!;
      const baseAt = new Map<string, number>();
      for (const p of base.pts) baseAt.set(`${Math.round(p.x)},${Math.round(p.y)}`, p.v);
      let topDiff = 0, topN = 0, botDiff = 0, botN = 0;
      for (const p of folded.pts) {
        const b = baseAt.get(`${Math.round(p.x)},${Math.round(p.y)}`);
        if (b === undefined) continue;
        const d = Math.abs(p.v - b);
        if (p.y < folded.height / 2) { topDiff += d; topN++; }
        else { botDiff += d; botN++; }
      }
      expect(topN).toBeGreaterThan(0);
      expect(botN).toBeGreaterThan(0);
      // Top half ≈ unchanged (kept); bottom half changed (reflection). The
      // bottom must differ from the unfolded baseline MORE than the top does.
      expect(botDiff / botN, 'MIRROR Y replaces the BOTTOM half (top is kept)')
        .toBeGreaterThan(topDiff / topN);
    }

    // ---- BOTH on: 4-way symmetric (kaleidoscope) ----
    await setMirror(1, 1);
    const gb = await readGrid();
    {
      const { g, m } = lumaMap(gb!);
      let diff = 0, n = 0;
      for (const p of g.pts) {
        if (p.x > g.width / 2 || p.y > g.height / 2) continue; // top-left quadrant
        // partner in each of the other three quadrants must match.
        for (const [px, py] of [
          [g.width - p.x, p.y],
          [p.x, g.height - p.y],
          [g.width - p.x, g.height - p.y],
        ] as const) {
          const partner = m.get(`${Math.round(px)},${Math.round(py)}`);
          if (partner === undefined) continue;
          diff += Math.abs(p.v - partner); n++;
        }
      }
      expect(n).toBeGreaterThan(0);
      expect(diff / n, 'BOTH mirrors → 4-way quadrant symmetry (kaleidoscope)').toBeLessThan(12);
    }

    // ---- Gate input toggles the mirror on a rising edge ----
    // Drive the synthetic gate param (mirrorXGate — what the mirror_x_gate CV
    // bridge writes) low→high: the module edge-detects the RISING edge and
    // FLIPS its live mirrorX latch. ⚠ THE OBSERVABLE IS THE RENDER, not the
    // store: the store write-back was the LEGACY CARD's rAF reflection (its
    // comment said so verbatim), and no shell surface re-persists the latch —
    // so the spec asserts what the toggle DOES: the output gains X symmetry on
    // the first edge and loses it on the second (toggle-on-edge), measured
    // with the same grid instrument as the folds above.
    const setGate = (v: number) =>
      page.evaluate((v) => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { params: Record<string, number> }> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => { const n = w.__patch.nodes['bd']; if (n) n.params.mirrorXGate = v; });
      }, v);
    const unfreezeAll = () =>
      page.evaluate(() => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { params: Record<string, number> }> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => { const n = w.__patch.nodes['bd']; if (n) { n.params.mirrorX = 0; n.params.mirrorXGate = 0; n.params.freeze = 0; } });
      });
    /** Mean-abs luma diff between left samples and their right mirrors — the
     *  X-symmetry meter (small = folded, large = the asymmetric triangle). */
    const xAsym = (g: NonNullable<Awaited<ReturnType<typeof readGrid>>>): number => {
      const m = new Map<string, number>();
      for (const p of g.pts) m.set(`${Math.round(p.x)},${Math.round(p.y)}`, p.v);
      let diff = 0, n = 0;
      for (const p of g.pts) {
        if (p.x > g.width / 2) continue;
        const partner = m.get(`${Math.round(g.width - p.x)},${Math.round(p.y)}`);
        if (partner === undefined) continue;
        diff += Math.abs(p.v - partner); n++;
      }
      return n ? diff / n : 0;
    };

    await unfreezeAll();
    await driveFrames(page, 4);
    const gBase = await readGrid();
    expect(gBase).not.toBeNull();
    const baseAsym = xAsym(gBase!);
    // Anti-vacuity: the ungated frame is measurably ASYMMETRIC, so "symmetric
    // after the edge" cannot pass on a dead/flat render.
    // Floor 8: measured 11.33 for this triangle over the 81-point grid (many
    // grid samples land on black on both sides, diluting the mean); a folded
    // frame measures ~2 (the fold assertions above run at ceiling 12 on the
    // SAME instrument for a busier scene).
    expect(baseAsym, `ungated frame is X-asymmetric (${baseAsym.toFixed(2)})`).toBeGreaterThan(8);

    // First rising edge → the live mirror latch flips on → X symmetry.
    await setGate(1);
    await driveFrames(page, 4);
    const gOn = await readGrid();
    expect(xAsym(gOn!), 'rising edge on mirror_x_gate folds the output (X-symmetric)').toBeLessThan(baseAsym / 2);

    // Fall, then a SECOND rising edge → the latch flips back off (toggle-on-
    // edge) → the asymmetric picture returns.
    await setGate(0);
    await driveFrames(page, 2);
    await setGate(1);
    await driveFrames(page, 4);
    const gOff = await readGrid();
    expect(xAsym(gOff!), 'second rising edge unfolds the output (asymmetry returns)').toBeGreaterThan(baseAsym / 2);
  });

  test('faders route through the patch store', async ({ page, rack }) => {
    await spawnPatch(page, [
      { id: 'bd', type: 'backdraft', position: { x: 200, y: 100 }, domain: 'video' },
    ]);
    await expect(page.locator('.svelte-flow__node[data-id="bd"] [data-testid="module-shell"]')).toHaveCount(1);

    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['bd'];
        if (!n) return;
        n.params.feedback = 1.2;
        n.params.chroma = 1.8;
        n.params.darken = 0.4;
      });
    });
    // Poll the STORE — the real subject. This site reads no pixels, so it is a
    // plain state readback and NOT one of backdraft's frame-count waits (those
    // gate the per-frame nest and are untouched here). One assertion over the
    // whole record: a partial write fails.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const w = globalThis as unknown as {
              __patch: { nodes: Record<string, { params: Record<string, number> }> };
            };
            const n = w.__patch.nodes['bd'];
            return { fb: n?.params.feedback, ch: n?.params.chroma, dk: n?.params.darken };
          }),
        { message: 'all three BACKDRAFT param writes land in the patch store' },
      )
      .toEqual({ fb: 1.2, ch: 1.8, dk: 0.4 });
  });
});
