// e2e/tests/backdraft-render-smoke.spec.ts
//
// DETERMINISTIC render-smoke (DRS) for BACKDRAFT — a video-feedback EFFECT
// (input port `in_a`, output `out`). Modeled on spirographs-render-smoke.spec.ts
// + the shared _render-smoke harness (installRenderSmokeHooks /
// stepAndReadStats / assertRenderStats).
//
// WHY BACKDRAFT IS *NOT* FRAME.TIME-DETERMINISTIC ON ITS OWN — AND THE UNBLOCK:
// Unlike a pure SOURCE (SPIROGRAPHS/ACIDWARP), whose draw(frame) derives the
// whole frame from `frame.time` alone, BACKDRAFT is a FEEDBACK ring: each
// frame composites the live source with a colour/affine-processed copy of its
// OWN previous output read from a ring of past-frame FBOs (see backdraft.ts
// "Feedback loop + 1-frame lag" / "DELAY as a frame ring"). The ring ACCUMULATES
// across frames, so it is NOT a pure function of `frame.time` — two equal step
// bursts from DIFFERENT ring states (the 2nd burst starts where the 1st left
// off) would read different feedback content and diverge. Pinning the clock
// alone (installRenderSmokeHooks) is therefore not sufficient for a feedback
// effect; it only makes the SOURCE (shapes) frame-stable.
//
// The module ships its OWN determinism pin: the `freeze` param (0/1). When
// freeze>=0.5, draw() is a NO-OP — the ring + published output hold their last
// contents, so the output is pixel-stable across steps. BUT freeze must be set
// AFTER the loop has SETTLED: if freeze=1 is set at spawn, draw() no-ops from
// frame 0, the ring never accumulates, and the output is ALL-BLACK (verified
// empirically: nonZeroFrac=0, variance=0). So the module header is precise —
// "the VRT scene settles the loop then sets freeze=1 to PIN a deterministic
// frame" — and the VRT scene (vrt-scenes.ts: backdraft) + the functional
// backdraft.spec.ts both do exactly that: run the feedback loop, THEN freeze.
//
// This DRS mirrors that pin under the paused-loop harness:
//   1. installRenderSmokeHooks() BEFORE goto: PAUSE the rAF loop (we own the
//      exact step count) + PIN the engine clock (the shapes source is identical
//      every step).
//   2. spawn shapes (mono-video) -> backdraft.in_a, backdraft.out -> videoOut,
//      WITH freeze=0 so the loop actually runs.
//   3. SETTLE BURST: drive a fixed number of UNFROZEN steps so the feedback
//      ring fills with the compounded tunnel (zoom>1 + rotate) — non-black,
//      structured content.
//   4. Set freeze=1 via the live store (the same hook backdraft.spec.ts uses).
//   5. Burst `a` + burst `b`: now every step is a held no-op, so the two
//      independent bursts read the SAME pinned frame → bit-stable (verified:
//      a and b are byte-identical across 3 runs).
//
// No waitForTimeout, no poll, no animation-diff, no exact-pixel assert. The
// settle + the two read bursts are all synchronous engine.step() drives.

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';

/** Read a node's output texture once and return the mean luma (0..255) of the
 *  four CORNER boxes (averaged) + a CENTRE box. Renderer-tolerant region stats
 *  for the SHAPE-mask assertions: PURE GEO ON forces the corners outside the
 *  shape to black; OFF leaves them to fill from feedback spill. readPixels is
 *  bottom-left origin, but the corner set is symmetric so the flip is moot. */
async function readShapeRegions(
  page: Page,
  nodeId: string,
): Promise<{ corners: number; center: number }> {
  return page.evaluate(({ nodeId }) => {
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
    const tex = vid.outputTexture(nodeId) as WebGLTexture | null;
    const { width: W, height: H } = vid.res;
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const px = new Uint8Array(W * H * 4);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    while (gl.getError() !== gl.NO_ERROR) { /* drain */ }
    const boxMean = (x0: number, y0: number, x1: number, y1: number): number => {
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const i = (y * W + x) * 4;
          sum += (px[i]! + px[i + 1]! + px[i + 2]!) / 3;
          n++;
        }
      return n ? sum / n : 0;
    };
    const bw = Math.max(1, Math.floor(W * 0.08));
    const bh = Math.max(1, Math.floor(H * 0.08));
    const corners =
      (boxMean(0, 0, bw, bh) +
        boxMean(W - bw, 0, W, bh) +
        boxMean(0, H - bh, bw, H) +
        boxMean(W - bw, H - bh, W, H)) /
      4;
    const cx = Math.floor(W / 2), cy = Math.floor(H / 2);
    const center = boxMean(cx - bw, cy - bh, cx + bw, cy + bh);
    return { corners, center };
  }, { nodeId });
}

/** Set node params on the live store inside a Y.Doc transaction. */
async function setNodeParams(page: Page, nodeId: string, params: Record<string, number>): Promise<void> {
  await page.evaluate(({ nodeId, params }) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes[nodeId];
      if (n) for (const [k, v] of Object.entries(params)) n.params[k] = v;
    });
  }, { nodeId, params });
}

const FIXED_STEPS = 6;
// Enough unfrozen frames to fill the feedback ring + let the tunnel transform
// compound into a deep, structured frame before we pin it. (The ring is
// BACKDRAFT_BUFFER_FRAMES = 31 deep; 30 settles it well past cold-start.)
const SETTLE_STEPS = 30;

test.describe('BACKDRAFT — deterministic render smoke', () => {
  test('settle feedback loop + freeze + pause + synchronous step → non-black, structured, frame-stable, zero GL errors', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // Pause the engine rAF loop + pin the clock BEFORE boot.
    await installRenderSmokeHooks(page);

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // BACKDRAFT is an EFFECT: a deterministic source (shapes, a static shape =
    // frame.time-independent) feeds in_a; backdraft.out -> videoOut. freeze=0 so
    // the feedback loop runs during the settle. A tunnel transform (zoom>1 +
    // rotate) compounds the fed-back frame each iteration so the output is
    // STRUCTURED (a spiral), not a flat brightness wash. delay=0 taps the most
    // recent frame so the transform compounds every step (deepest tunnel).
    await spawnPatch(
      page,
      [
        { id: 'src', type: 'shapes',    position: { x: 40,  y: 40  }, domain: 'video',
          params: { shape: 0, tile: 1, tileN: 4, zoom: 0.6 } },
        { id: 'm',   type: 'backdraft', position: { x: 460, y: 80  }, domain: 'video',
          params: { freeze: 0, mix: 0, feedback: 1.0, delay: 0, chroma: 1.4, zoom: 1.1, rotate: 10 } },
        { id: 'out', type: 'videoOut',  position: { x: 980, y: 80  }, domain: 'video' },
      ],
      [
        { id: 'e_a', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'm',   portId: 'in_a' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e_o', from: { nodeId: 'm',   portId: 'out' }, to: { nodeId: 'out', portId: 'in'   }, sourceType: 'video',      targetType: 'video' },
      ],
    );

    // SETTLE BURST — drive the UNFROZEN feedback loop a fixed number of steps so
    // the ring fills + the tunnel compounds into a non-black, structured frame.
    // (Synchronous engine.step()s; no waitForTimeout.)
    const settle = await stepAndReadStats(page, { nodeId: 'm', steps: SETTLE_STEPS });
    expect(settle.framesDelta, 'settle burst advanced the exact frame count (loop paused)').toBe(SETTLE_STEPS);
    expect(settle.glErrors, `GL errors during settle: [${settle.glErrors.join(',')}]`).toEqual([]);

    // PIN: set freeze=1 via the live store (the hook backdraft.spec.ts uses).
    // From here draw() is a no-op — the ring + output hold the settled frame.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => { const n = w.__patch.nodes['m']; if (n) n.params.freeze = 1; });
    });

    // First read burst: drive a FIXED number of (now no-op) frames synchronously
    // + read the pinned BACKDRAFT output texture once. Lower the non-black floor:
    // the sparse source + tunnel can leave the frame legitimately sparse on the
    // SwiftShader renderer; the variance floor still rejects a flat/black frame.
    const a = await stepAndReadStats(page, { nodeId: 'm', steps: FIXED_STEPS });
    assertRenderStats(a, FIXED_STEPS, { minNonZeroFrac: 0.01 });

    // DETERMINISM: a second independent burst (output still frozen) must produce
    // a frame-stable result — same mean + variance to a tight epsilon (in
    // practice byte-identical, since the frozen output is held verbatim).
    const b = await stepAndReadStats(page, { nodeId: 'm', steps: FIXED_STEPS });
    expect(b.framesDelta, 'second burst also advanced the exact frame count').toBe(FIXED_STEPS);
    expect(Math.abs(b.mean - a.mean), `frozen output is frame-stable (mean ${a.mean.toFixed(3)} vs ${b.mean.toFixed(3)})`).toBeLessThan(0.5);
    expect(Math.abs(b.variance - a.variance), 'frozen output variance is frame-stable').toBeLessThan(1.0);

    expect(errors, 'no console / page errors during render').toEqual([]);
  });

  test('SHAPE circle + PURE GEO ON cuts the corners (corner=bg, centre lit); OFF + zoom-in spills into the corners', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await installRenderSmokeHooks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // A DENSE, deterministic source (ACIDWARP plasma — frame.time-pinned by the
    // harness) so the shape INTERIOR always has content; backdraft set to a
    // CIRCLE shape with a zoom-IN tunnel. We test BOTH masking modes on the same
    // engine: PURE GEO ON (screen-space crop → corners forced black) and OFF
    // (zoomed-source crop → masked source feeds back + spills to the corners).
    await spawnPatch(
      page,
      [
        { id: 'src', type: 'acidwarp',  position: { x: 40,  y: 40  }, domain: 'video' },
        { id: 'm',   type: 'backdraft', position: { x: 460, y: 80  }, domain: 'video',
          params: { freeze: 0, mix: 0, feedback: 1.0, delay: 0, zoom: 1.4, rotate: 6,
                    shape: 1 /* circle */, pureGeo: 1 /* ON */ } },
        { id: 'out', type: 'videoOut',  position: { x: 980, y: 80  }, domain: 'video' },
      ],
      [
        { id: 'e_a', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'm',   portId: 'in_a' }, sourceType: 'video', targetType: 'video' },
        { id: 'e_o', from: { nodeId: 'm',   portId: 'out' }, to: { nodeId: 'out', portId: 'in'   }, sourceType: 'video', targetType: 'video' },
      ],
    );

    // ── PURE GEO ON: settle, freeze, read regions.
    const onSettle = await stepAndReadStats(page, { nodeId: 'm', steps: SETTLE_STEPS });
    expect(onSettle.framesDelta).toBe(SETTLE_STEPS);
    expect(onSettle.glErrors, `GL errors (ON): [${onSettle.glErrors.join(',')}]`).toEqual([]);
    await setNodeParams(page, 'm', { freeze: 1 });
    await stepAndReadStats(page, { nodeId: 'm', steps: FIXED_STEPS }); // hold no-ops
    const on = await readShapeRegions(page, 'm');

    // The circle (radius 0.5, aspect-corrected) excludes the corner boxes at all
    // zooms in ON mode → they read ~background (black). The centre is inside the
    // shape → lit. Renderer-tolerant floors (SwiftShader vs real GPU).
    expect(on.corners, `ON corners should be ~black (got ${on.corners.toFixed(1)})`).toBeLessThan(8);
    expect(on.center, `ON centre should be lit (got ${on.center.toFixed(1)})`).toBeGreaterThan(on.corners + 6);

    // ── PURE GEO OFF + zoom-in: unfreeze, re-settle, freeze, read regions. The
    // masked SOURCE feeds back through the zoom tunnel and spills outward, so the
    // corners are no longer forced black — they fill from the spill.
    await setNodeParams(page, 'm', { freeze: 0, pureGeo: 0 });
    const offSettle = await stepAndReadStats(page, { nodeId: 'm', steps: SETTLE_STEPS });
    expect(offSettle.framesDelta).toBe(SETTLE_STEPS);
    expect(offSettle.glErrors, `GL errors (OFF): [${offSettle.glErrors.join(',')}]`).toEqual([]);
    await setNodeParams(page, 'm', { freeze: 1 });
    await stepAndReadStats(page, { nodeId: 'm', steps: FIXED_STEPS });
    const off = await readShapeRegions(page, 'm');

    // OFF corners fill from the zoom-in spill → strictly brighter than the ON
    // corners (which are hard-masked to black). A small margin keeps it robust.
    expect(off.corners, `OFF corners should spill brighter than ON corners (OFF ${off.corners.toFixed(1)} vs ON ${on.corners.toFixed(1)})`).toBeGreaterThan(on.corners + 2);

    expect(errors, 'no console / page errors during render').toEqual([]);
  });
});
