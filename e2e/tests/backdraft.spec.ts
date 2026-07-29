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
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';

test.describe('BACKDRAFT — video feedback generator', () => {
  test('SHAPES/LINES masks + SHAPES sources -> BACKDRAFT -> OUTPUT renders a live feedback frame', async ({ page, rack, errorWatch }) => {
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

    await expect(page.locator('.svelte-flow__node-backdraft'), 'BACKDRAFT visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-videoOut'),  'OUTPUT visible').toBeVisible();
    await expect(page.locator('[data-testid="backdraft-card"]')).toHaveCount(1);
    // The card carries no in-rack picture any more (owner call). The <canvas>
    // is still MOUNTED because it is the surface Full Frame / Full Screen /
    // Present hand to the user, but it is 0x0 and unpainted while the card sits
    // in the rack — so assert BOTH, or "present" and "hidden" each pass on
    // their own for the wrong reason. The output pixels this spec reads come
    // from the downstream VIDEO OUT, which is unaffected.
    await expect(page.locator('[data-testid="backdraft-canvas"]')).toHaveCount(1);
    await expect(
      page.locator('[data-testid="backdraft-canvas"]'),
      'the output surface is not shown in the rack',
    ).toBeHidden();

    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await expect(canvas, 'video-out canvas in DOM').toHaveCount(1);

    // Let the feedback loop run a bunch of frames.
    await page.waitForTimeout(800);

    // The output should be non-trivial (feedback trails + masks). Assert a
    // spread of pixel values (variance) rather than pixel-exact — that's
    // the VRT suite's job.
    const stats = await canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0, sum = 0, sumSq = 0, nonZero = 0;
      for (let i = 0; i < data.length; i += 16) {
        const v = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
        sum += v; sumSq += v * v; n++;
        if (v > 8) nonZero++;
      }
      const mean = sum / n;
      const variance = sumSq / n - mean * mean;
      return { mean, variance, nonZeroFrac: nonZero / n };
    });
    expect(stats, 'canvas readable').not.toBeNull();
    expect(stats!.nonZeroFrac, 'output is not all-black (feedback rendered)').toBeGreaterThan(0.02);
    expect(stats!.variance, 'output has spatial structure (trails + masks)').toBeGreaterThan(20);

  });

  test('FREEZE holds the output still (deterministic capture hook)', async ({ page, rack }) => {
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

    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await expect(canvas).toHaveCount(1);
    await page.waitForTimeout(500);

    // Freeze BACKDRAFT.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['bd'];
        if (n) n.params.freeze = 1;
      });
    });
    await page.waitForTimeout(150);

    const sample = (): Promise<number[]> =>
      canvas.evaluate((el) => {
        const c = el as HTMLCanvasElement;
        const ctx = c.getContext('2d');
        if (!ctx) return [];
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        const out: number[] = [];
        for (let i = 0; i < d.length; i += 4 * 64) out.push(d[i]!);
        return out;
      });

    const a = await sample();
    await page.waitForTimeout(200);
    const b = await sample();

    // Frozen: the two samples (200ms apart, many rAFs) should be identical.
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
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
    // DRS uses (the ring is BACKDRAFT_BUFFER_FRAMES = 31 deep).
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
      await page.goto('/rack');
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

  test('PIXELATE reduces the source resolution (1.0 → flat frame; 0 → unchanged)', async ({ page, rack }) => {
    // Drive BACKDRAFT with a structured source and NO feedback, so the output
    // ≈ the (pixelated) source. At pixelate=1 the whole frame collapses to one
    // representative colour → near-zero spatial variance (a flat block). At
    // pixelate=0 the frame keeps its full structure (HARD INVARIANT: identity).
    async function captureVariance(pixelate: number): Promise<number> {
      // FRESH RACK PER CAPTURE (restored from pre-fixture main): both
      // captures spawn the SAME node ids, and re-spawning onto the live doc
      // compares the wrong scenes (same failure class as captureFrame above).
      // The `rack` fixture only navigates once per test, so re-navigate here.
      await page.goto('/rack');
      await page.waitForLoadState('networkidle');
      await spawnPatch(
        page,
        [
          { id: 'src_a', type: 'shapes',    position: { x: 40,  y: 40 }, domain: 'video',
            params: { shape: 1, tile: 1, tileN: 6, zoom: 0.8 } },
          { id: 'bd',    type: 'backdraft', position: { x: 460, y: 80 }, domain: 'video',
            params: { mix: 0, feedback: 0, delay: 16, pixelate } },
          { id: 'v-out', type: 'videoOut',  position: { x: 980, y: 80 }, domain: 'video' },
        ],
        [
          { id: 'e_a',   from: { nodeId: 'src_a', portId: 'out' }, to: { nodeId: 'bd',    portId: 'in_a' }, sourceType: 'mono-video', targetType: 'video' },
          { id: 'e_out', from: { nodeId: 'bd',    portId: 'out' }, to: { nodeId: 'v-out', portId: 'in'   }, sourceType: 'video',      targetType: 'video' },
        ],
      );
      const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
      await expect(canvas).toHaveCount(1);
      await page.waitForTimeout(400);
      // Freeze for a stable read.
      await page.evaluate(() => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { params: Record<string, number> }> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => { const n = w.__patch.nodes['bd']; if (n) n.params.freeze = 1; });
      });
      await page.waitForTimeout(120);
      const v = await canvas.evaluate((el) => {
        const c = el as HTMLCanvasElement;
        const ctx = c.getContext('2d');
        if (!ctx) return -1;
        // Sample only the INTERIOR (centre 60%) so the video-out letterbox
        // border (black bars around the 4:3 fit) can't inflate the variance —
        // we want the variance of the rendered IMAGE, not its frame.
        const x0 = Math.floor(c.width * 0.2), x1 = Math.ceil(c.width * 0.8);
        const y0 = Math.floor(c.height * 0.2), y1 = Math.ceil(c.height * 0.8);
        const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
        let n = 0, sum = 0, sumSq = 0;
        for (let i = 0; i < d.length; i += 16) {
          const lum = (d[i]! + d[i + 1]! + d[i + 2]!) / 3;
          sum += lum; sumSq += lum * lum; n++;
        }
        const mean = sum / n;
        return sumSq / n - mean * mean; // variance
      });
      return v;
    }

    const varFull = await captureVariance(0);   // identity → keeps structure
    const varFlat = await captureVariance(1);    // collapsed → one colour

    expect(varFull, 'pixelate=0 keeps the source structure').toBeGreaterThan(40);
    // pixelate=1 collapses the source to a single representative colour → the
    // interior is essentially flat. Far flatter than the full-structure frame.
    expect(varFlat, 'pixelate=1 collapses to a near-flat frame').toBeLessThan(5);
    expect(varFlat, 'pixelate=1 is far flatter than pixelate=0').toBeLessThan(varFull / 8);
  });

  test('DELAY CLOCK input overrides the DELAY knob (CLK badge appears when patched)', async ({ page, rack, errorWatch }) => {
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

    await expect(page.locator('[data-testid="backdraft-card"]')).toHaveCount(1);
    // The CLK override badge appears once the clock cable is patched.
    await expect(
      page.locator('[data-testid="backdraft-clk-badge"]'),
      'CLK badge shows the DELAY knob is clock-overridden',
    ).toBeVisible();

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
      await page.waitForTimeout(120);
      // Freeze for a stable read.
      await page.evaluate(() => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { params: Record<string, number> }> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => { const n = w.__patch.nodes['bd']; if (n) n.params.freeze = 1; });
      });
      await page.waitForTimeout(120);
    }

    // Sample a small grid of luma values + the canvas dims so we can compare
    // mirrored positions. Returns { w, h, lumaAt(x,y) } as a flat array.
    function readGrid() {
      return page.locator('canvas[data-testid="video-out-canvas"]').evaluate((el) => {
        const c = el as HTMLCanvasElement;
        const ctx = c.getContext('2d');
        if (!ctx) return null;
        const { width, height } = c;
        const img = ctx.getImageData(0, 0, width, height).data;
        const luma = (x: number, y: number): number => {
          const xi = Math.max(0, Math.min(width - 1, Math.round(x)));
          const yi = Math.max(0, Math.min(height - 1, Math.round(y)));
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

    await page.goto('/rack');
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
    await expect(page.locator('canvas[data-testid="video-out-canvas"]')).toHaveCount(1);
    await page.waitForTimeout(400);

    // Baseline: UNFOLDED frame (both mirrors off). Used to identify which
    // half each fold KEEPS (the half that equals the unfolded source).
    await setMirror(0, 0);
    const gUnfolded = await readGrid();
    expect(gUnfolded).not.toBeNull();

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

    // ---- Gate input toggles the mirror param on a rising edge ----
    // Reset mirrorX off + unfreeze. Drive the synthetic gate param
    // (mirrorXGate — what the mirror_x_gate CV bridge writes) low→high: the
    // module edge-detects the RISING edge and FLIPS mirrorX. The card mirrors
    // the engine's live value back into the store, so the assertion (reading
    // the store) sees the flip — exactly what the button binds to.
    const setGate = (v: number) =>
      page.evaluate((v) => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { params: Record<string, number> }> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => { const n = w.__patch.nodes['bd']; if (n) n.params.mirrorXGate = v; });
      }, v);
    const readMirrorX = () =>
      page.evaluate(() => {
        const w = globalThis as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> } };
        return w.__patch.nodes['bd']?.params.mirrorX;
      });

    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => { const n = w.__patch.nodes['bd']; if (n) { n.params.mirrorX = 0; n.params.mirrorXGate = 0; n.params.freeze = 0; } });
    });
    await page.waitForTimeout(120);

    // First rising edge → mirrorX flips 0 → 1.
    await setGate(1);
    await expect
      .poll(readMirrorX, { timeout: 3000, message: 'rising edge on mirror_x_gate flips mirrorX 0→1' })
      .toBeGreaterThanOrEqual(0.5);

    // Fall, then a SECOND rising edge → mirrorX flips back 1 → 0 (toggle-on-edge).
    await setGate(0);
    await page.waitForTimeout(120);
    await setGate(1);
    await expect
      .poll(readMirrorX, { timeout: 3000, message: 'second rising edge flips mirrorX 1→0' })
      .toBeLessThan(0.5);
  });

  test('faders route through the patch store', async ({ page, rack }) => {
    await spawnPatch(page, [
      { id: 'bd', type: 'backdraft', position: { x: 200, y: 100 }, domain: 'video' },
    ]);
    await expect(page.locator('[data-testid="backdraft-card"]')).toHaveCount(1);

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
    await page.waitForTimeout(120);

    const params = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      const n = w.__patch.nodes['bd'];
      return { fb: n?.params.feedback, ch: n?.params.chroma, dk: n?.params.darken };
    });
    expect(params.fb).toBe(1.2);
    expect(params.ch).toBe(1.8);
    expect(params.dk).toBe(0.4);
  });
});
