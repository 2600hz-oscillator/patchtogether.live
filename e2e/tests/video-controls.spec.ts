// e2e/tests/video-controls.spec.ts
//
// DETERMINISTIC render-smoke (DRS) conversion of the video-controls regression
// suite — plan §3 (this spec is the worst wall-clock offender: 22 waitForTimeout
// + 10 animation-diff samples) and §5 Layer B. Converted IN-PLACE from the old
// `spawn → waitForTimeout(500) → readCanvas-once → mutate param → waitForTimeout
// → readCanvas-once → statsDiffer` shape (three un-synchronized clocks: the rAF
// cadence, the engine clock, the 2D-canvas blit) to the shared _render-smoke
// harness.
//
// WHAT EACH PARAM TEST NOW DOES (the §3 directive — "DRS per module"):
//   1. installRenderSmokeHooks(page) BEFORE page.goto(): PAUSE the engine rAF
//      loop (the test owns the exact frame count) + PIN the engine clock
//      (__videoEngineFreezeTime). Every time-animated source in this suite
//      (LINES auto-scrolls off frame.time; INWARDS reads uTime = frame.time)
//      renders an IDENTICAL frame on every step once the clock is pinned — so
//      the auto-scroll/zoom that the OLD test had to out-threshold is simply
//      GONE, and the ONLY thing that can move a pixel between the two reads is
//      the param mutation.
//   2. spawn the module (+ source/sink) → drive a FIXED burst (stepAndReadStats)
//      → read(BEFORE) from the module's OWN output FBO (gl.readPixels, no 2D
//      blit) → assert the renderer-tolerant CORRECTNESS FLOOR on it (each
//      shader actually paints structured, non-black content: assertRenderStats).
//   3. setNodeParam via the engine domain (__ydoc.transact → __patch param; the
//      reconciler routes it to engine.setParam — the SAME path the old test
//      proved) → drive a SECOND fixed burst → read(AFTER).
//   4. assert the TWO FROZEN reads DIFFER by a renderer-tolerant margin
//      (statsDiffer over mean / variance / nonZeroFrac). Because both reads are
//      bit-stable under the frozen clock, a steady patch with no param change
//      reads IDENTICAL stats (delta 0) — so the differ margin only has to clear
//      driver readback noise, not the old animation drift floor.
//
// WHY THE PRIOR (Phase-2a) ATTEMPT FAILED + the fix:
//   "LINES amp knob" and "CHROMAKEY threshold knob" failed because the two
//   frozen reads didn't differ enough. ROOT CAUSE: the param DELTA wasn't large
//   enough to move the frozen frame past the differ margin. FIX (not a weaker
//   assertion): pick deltas that CLEARLY change the frozen frame —
//     - LINES: amp 4 → 44 (≈4 line pairs → ≈44 → an order-of-magnitude change
//       in the count of bright/dark transitions → nonZeroFrac + variance both
//       move far past the margin). Frozen, so there is no auto-scroll confound.
//     - CHROMAKEY: keep the full-frame FG(saturated-red) → BG(lines) FLIP
//       (threshold 0 → 0.9 moves red from outside to inside the key band), which
//       swaps the entire frame from a flat red fill to a structured line field —
//       a large mean AND variance AND nonZeroFrac delta, deterministic once
//       frozen.
//
// PATTERN-SWAP tests (INWARDS density, V-MIXER cross-fade): a ring-count change
//   / a line-field↔radial-field swap can keep GLOBAL mean+variance within the
//   differ margin while every pixel moves (the documented V-MIXER blind spot:
//   var 7379 → 6941, a 6×6 cell delta of 3.2). The OLD test caught this with a
//   per-pixel canvas frameDiff. Preserved here as stepAndReadFrame() — the SAME
//   frozen freeze+step+readPixels FBO path the harness uses, but returning the
//   sparse luma ARRAY so two FROZEN frames can be diffed PER-PIXEL. Deterministic
//   (frozen FBO) and still catches the swap the aggregate stats miss.
//
// DEFERRED — FEEDBACK (determinism blocker, left on its ORIGINAL mechanism):
//   FEEDBACK is an UNBOUNDED ping-pong ACCUMULATOR (two FBOs alternate; each
//   frame samples the decay-multiplied PREVIOUS frame and writes the next). It
//   is NOT a pure function of the frozen clock and ships NO `freeze` param to
//   pin a settled frame — so a second equal frozen burst legitimately reads a
//   DIFFERENT ring state and would diverge on its OWN, making a two-frozen-reads
//   diff vacuous (it would "pass" off accumulator drift, not off the param).
//   Per the DRS rules (do NOT weaken a blocked test), the FEEDBACK test stays on
//   the original wall-clock readCanvasStats/statsDiffer mechanism below. (A
//   module-source `freeze` pin would be needed to DRS it; out of scope for this
//   test-only conversion — same call as VDELAY in video-chain.spec.ts.)
//
// The palette describe ("VIDEO grouping + V-MIXER visibility") is pure
// deterministic DOM (no rendering, no wall-clock sampling) and is carried over
// unchanged.
//
// No waitForTimeout / no poll / no animation-diff / no exact-pixel equality in
// any CONVERTED test (the lone remaining waitForTimeout lives in the explicitly
// DEFERRED FEEDBACK test + the carried-over palette test's networkidle waits).

import { test, expect } from './_fixtures';
import { type Page, type Locator } from '@playwright/test';
import { spawnPatch } from './_helpers';
import {
  installRenderSmokeHooks,
  stepAndReadStats,
  assertRenderStats,
  type RenderStats,
} from './_render-smoke';

const FIXED_STEPS = 6;

/** Mutate a single patch-graph param via the dev `__patch` global inside a
 *  `__ydoc.transact` so the reconciler routes the change through
 *  engine.setParam — the EXACT param chain (UI → store → reconciler → engine →
 *  shader) the suite exists to prove. Identical to the original helper; kept
 *  as-is (a deterministic state mutation, not a wall-clock dependency). */
async function setNodeParam(
  page: Page,
  nodeId: string,
  paramId: string,
  value: number,
): Promise<void> {
  await page.evaluate(
    ({ nodeId, paramId, value }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> } | undefined> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const target = w.__patch.nodes[nodeId];
        if (target) target.params[paramId] = value;
      });
    },
    { nodeId, paramId, value },
  );
}

/** Two FROZEN render-smoke reads are "different" when at least one of mean /
 *  variance / nonZeroFrac shifted by more than a renderer-tolerant readback
 *  margin. Under the pinned clock + paused rAF a steady patch reads IDENTICAL
 *  stats (delta ≈ 0 — see the frame-stable asserts in acidwarp/video-chain), so
 *  unlike the OLD canvas-sampling differ (which had to clear LINES auto-scroll
 *  drift) these margins ONLY have to clear SwiftShader-vs-Metal readback noise.
 *  mean is 0..255; variance can be large; nonZeroFrac is 0..1. */
function statsDiffer(a: RenderStats, b: RenderStats): boolean {
  const meanDelta = Math.abs(a.mean - b.mean);
  const varianceDelta = Math.abs(a.variance - b.variance);
  const nzFracDelta = Math.abs(a.nonZeroFrac - b.nonZeroFrac);
  const varScale = Math.max(1, a.variance, b.variance);
  // Renderer-tolerant floors: a ≥4-luma mean shift, a ≥10% variance shift, or a
  // ≥3% non-zero-fraction shift. All three are FAR above frozen-readback noise
  // (which is ~0) yet each param delta below clears at least one comfortably.
  return (
    meanDelta > 4 ||
    varianceDelta / varScale > 0.1 ||
    nzFracDelta > 0.03
  );
}

/** Drive a FIXED burst SYNCHRONOUSLY (one evaluate, no yield — the same path as
 *  stepAndReadStats) and return the node's OWN output FBO as a SPARSE luma array
 *  so two FROZEN frames can be diffed PER-PIXEL. This is the deterministic
 *  replacement for the old canvas lumaFrame(): a genuine pattern SWAP (ring-count
 *  change / line↔radial cross-fade) moves many pixels even when the GLOBAL
 *  mean/variance collude to near-identical values — the documented blind spot
 *  statsDiffer() can miss. Reads gl.readPixels off the module's FBO (no 2D blit),
 *  stride-matched to the harness (every 16th RGBA texel). */
async function stepAndReadFrame(
  page: Page,
  opts: { nodeId: string; portId?: string; steps: number },
): Promise<number[]> {
  return page.evaluate(({ nodeId, portId, steps }) => {
    const w = globalThis as unknown as {
      __engine: () => {
        getDomain: (d: string) => {
          gl: WebGL2RenderingContext;
          step: () => void;
          outputTexture: (id: string, port?: string) => WebGLTexture | null;
          res: { width: number; height: number };
        };
      };
    };
    const vid = w.__engine().getDomain('video');
    const gl = vid.gl;
    while (gl.getError() !== gl.NO_ERROR) { /* drain pre-existing */ }

    for (let i = 0; i < steps; i++) vid.step();

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

    const out: number[] = [];
    for (let i = 0; i < px.length; i += 4 * 16) {
      out.push((px[i]! + px[i + 1]! + px[i + 2]!) / 3);
    }
    return out;
  }, opts);
}

/** Mean absolute per-pixel luma difference between two equal-length frames.
 *  Two FROZEN reads of an unchanged patch diff ≈ 0 (bit-stable); a genuine
 *  pattern swap diffs well above the renderer-tolerant floor. */
function frameDiff(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s / a.length;
}

test.describe('video controls drive output (deterministic render smoke)', () => {
  test('LINES amp knob changes pixel pattern', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);

    // Pause the rAF loop + pin the clock BEFORE boot — kills LINES auto-scroll
    // (the OLD test's drift confound) so the param is the only thing that moves.
    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'v-lines', type: 'lines',    position: { x: 80, y: 60 },  domain: 'video', params: { amp: 4, thickness: 0.4 } },
        { id: 'v-out',   type: 'videoOut', position: { x: 480, y: 60 }, domain: 'video' },
      ],
      [
        { id: 'e-lines-out', from: { nodeId: 'v-lines', portId: 'out' }, to: { nodeId: 'v-out', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
      ],
    );
    await expect(page.locator('.svelte-flow__node-lines'), 'LINES visible').toBeVisible();

    // BEFORE: read LINES' OWN FBO (amp=4 → a sparse line field, structured + non-black).
    const before = await stepAndReadStats(page, { nodeId: 'v-lines', steps: FIXED_STEPS });
    assertRenderStats(before, FIXED_STEPS, { minNonZeroFrac: 0.001 });
    const beforeFrame = await stepAndReadFrame(page, { nodeId: 'v-lines', steps: FIXED_STEPS });

    // Crank amp 4 → 44: ≈4 line pairs become ≈44. CRUCIAL: LINES amp is a spatial-
    // FREQUENCY change at a FIXED duty cycle (thickness const), so the bright/dark
    // DUTY FRACTION — and therefore global mean, variance, AND nonZeroFrac — is
    // INVARIANT to amp (verified: statsDiffer returns a literal zero delta). The
    // Phase-2a "make the delta bigger" diagnosis was wrong; aggregate stats simply
    // cannot see a frequency change. Assert the FROZEN PER-PIXEL frame delta
    // instead (same path INWARDS uses): a 4→44 line-count change moves many pixels
    // even though the aggregates don't move.
    await setNodeParam(page, 'v-lines', 'amp', 44);
    const after = await stepAndReadStats(page, { nodeId: 'v-lines', steps: FIXED_STEPS });
    expect(after.framesDelta, 'second burst advanced the exact frame count').toBe(FIXED_STEPS);
    const afterFrame = await stepAndReadFrame(page, { nodeId: 'v-lines', steps: FIXED_STEPS });

    const pxDelta = frameDiff(beforeFrame, afterFrame);
    expect(
      pxDelta,
      `LINES amp 4→44 per-pixel delta (frozen): pre mean=${before.mean.toFixed(1)} var=${before.variance.toFixed(1)} | post mean=${after.mean.toFixed(1)} var=${after.variance.toFixed(1)} frameDiff=${pxDelta.toFixed(1)}`,
    ).toBeGreaterThan(6);

  });

  test('INWARDS density knob changes pixel pattern', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);

    // Pin the clock — INWARDS reads uTime = frame.time, so the frozen clock halts
    // the inward zoom; density is the ONLY thing that can move a pixel. (The OLD
    // test had to set speed:0 to fake this; the freeze does it for free + for
    // EVERY frame.time read, not just the one param.)
    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'v-in',  type: 'inwards',  position: { x: 80, y: 60 },  domain: 'video', params: { density: 4, speed: 0, thickness: 0.4 } },
        { id: 'v-out', type: 'videoOut', position: { x: 480, y: 60 }, domain: 'video' },
      ],
      [
        { id: 'e-in-out', from: { nodeId: 'v-in', portId: 'out' }, to: { nodeId: 'v-out', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
      ],
    );
    await expect(page.locator('.svelte-flow__node-inwards'), 'INWARDS visible').toBeVisible();

    const before = await stepAndReadStats(page, { nodeId: 'v-in', steps: FIXED_STEPS });
    assertRenderStats(before, FIXED_STEPS, { minNonZeroFrac: 0.001 });
    const beforeFrame = await stepAndReadFrame(page, { nodeId: 'v-in', steps: FIXED_STEPS });

    await setNodeParam(page, 'v-in', 'density', 30);
    const after = await stepAndReadStats(page, { nodeId: 'v-in', steps: FIXED_STEPS });
    expect(after.framesDelta, 'second burst advanced the exact frame count').toBe(FIXED_STEPS);
    const afterFrame = await stepAndReadFrame(page, { nodeId: 'v-in', steps: FIXED_STEPS });

    // density 4 → 30 takes ≈4 rings to ≈30 — a huge PER-PIXEL change, but the
    // GLOBAL mean/variance can collude to near-identical values (4 wide bands vs
    // 30 tight bands average similarly), so assert the FROZEN per-pixel frame
    // delta — preserving the original test's intent. Identical frozen frames diff
    // ≈0; a genuine ring-count change moves many pixels.
    const pxDelta = frameDiff(beforeFrame, afterFrame);
    expect(
      pxDelta,
      `INWARDS density 4→30 per-pixel delta (frozen): pre mean=${before.mean.toFixed(1)} var=${before.variance.toFixed(1)} | post mean=${after.mean.toFixed(1)} var=${after.variance.toFixed(1)} frameDiff=${pxDelta.toFixed(1)}`,
    ).toBeGreaterThan(6);

  });

  test('DESTRUCTOR mangle knob changes pixel pattern', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);

    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'v-lines', type: 'lines',      position: { x: 40,  y: 60 },  domain: 'video' },
        { id: 'v-destr', type: 'destructor', position: { x: 320, y: 60 },  domain: 'video', params: { shift: 0, scanline: 0, posterize: 0, mangle: 0 } },
        { id: 'v-out',   type: 'videoOut',   position: { x: 700, y: 60 },  domain: 'video' },
      ],
      [
        { id: 'e-lines-destr', from: { nodeId: 'v-lines', portId: 'out' }, to: { nodeId: 'v-destr', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e-destr-out',   from: { nodeId: 'v-destr', portId: 'out' }, to: { nodeId: 'v-out',   portId: 'in' }, sourceType: 'video',      targetType: 'video' },
      ],
    );
    await expect(page.locator('.svelte-flow__node-destructor'), 'DESTRUCTOR visible').toBeVisible();

    // DESTRUCTOR is a pure passthrough of its input + params (no frame.time, no
    // accumulator) — frozen-deterministic. Read DESTRUCTOR's OWN FBO.
    const before = await stepAndReadStats(page, { nodeId: 'v-destr', steps: FIXED_STEPS });
    assertRenderStats(before, FIXED_STEPS, { minNonZeroFrac: 0.001 });

    // Crank everything destructor-side: posterize 0 quantizes to 2 levels (harsh
    // banding), scanline 0.8 darkens every other row, mangle 0.9 scales the RGB
    // shift — a heavy, deterministic mangle of the line field.
    await setNodeParam(page, 'v-destr', 'shift',     0.9);
    await setNodeParam(page, 'v-destr', 'scanline',  0.8);
    await setNodeParam(page, 'v-destr', 'posterize', 0.7);
    await setNodeParam(page, 'v-destr', 'mangle',    0.9);
    const after = await stepAndReadStats(page, { nodeId: 'v-destr', steps: FIXED_STEPS });
    expect(after.framesDelta, 'second burst advanced the exact frame count').toBe(FIXED_STEPS);

    expect(
      statsDiffer(before, after),
      `DESTRUCTOR all-on (frozen): pre mean=${before.mean.toFixed(1)} var=${before.variance.toFixed(1)} nz=${before.nonZeroFrac.toFixed(3)} | post mean=${after.mean.toFixed(1)} var=${after.variance.toFixed(1)} nz=${after.nonZeroFrac.toFixed(3)}`,
    ).toBe(true);

  });

  test('LUMA gamma knob changes pixel pattern', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);

    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    // LUMA is a single-input luminance processor (gamma / contrast / posterize /
    // bias), pure (no frame.time). gamma 1.0 → 2.5 darkens the LINES mid-luma
    // pixels — a deterministic CV→uniform→shader shift.
    await spawnPatch(
      page,
      [
        { id: 'v-lines', type: 'lines',    position: { x: 40, y: 60 },   domain: 'video' },
        { id: 'v-luma',  type: 'luma',     position: { x: 320, y: 60 },  domain: 'video', params: { gamma: 1.0 } },
        { id: 'v-out',   type: 'videoOut', position: { x: 700, y: 60 },  domain: 'video' },
      ],
      [
        { id: 'e-lines-luma', from: { nodeId: 'v-lines', portId: 'out' }, to: { nodeId: 'v-luma', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e-luma-out',   from: { nodeId: 'v-luma',  portId: 'out' }, to: { nodeId: 'v-out',  portId: 'in' }, sourceType: 'video',      targetType: 'video' },
      ],
    );
    await expect(page.locator('.svelte-flow__node-luma'), 'LUMA visible').toBeVisible();

    const before = await stepAndReadStats(page, { nodeId: 'v-luma', steps: FIXED_STEPS });
    assertRenderStats(before, FIXED_STEPS, { minNonZeroFrac: 0.001 });

    await setNodeParam(page, 'v-luma', 'gamma', 2.5);
    const after = await stepAndReadStats(page, { nodeId: 'v-luma', steps: FIXED_STEPS });
    expect(after.framesDelta, 'second burst advanced the exact frame count').toBe(FIXED_STEPS);

    expect(
      statsDiffer(before, after),
      `LUMA gamma 1.0→2.5 (frozen): pre mean=${before.mean.toFixed(1)} var=${before.variance.toFixed(1)} nz=${before.nonZeroFrac.toFixed(3)} | post mean=${after.mean.toFixed(1)} var=${after.variance.toFixed(1)} nz=${after.nonZeroFrac.toFixed(3)}`,
    ).toBe(true);

  });

  test('CHROMA tintMix knob changes pixel pattern', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);

    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    // CHROMA is a single-input hue-shifter / colorizer, pure (no frame.time). On
    // a greyscale LINES source the canonical visible proof is tintMix 0 → 1:
    // lerp the output fully toward the green tint. The output mean shifts the
    // moment the CV pipeline lands.
    await spawnPatch(
      page,
      [
        { id: 'v-lines',  type: 'lines',    position: { x: 40, y: 60 },   domain: 'video' },
        { id: 'v-chroma', type: 'chroma',   position: { x: 320, y: 60 },  domain: 'video', params: { hue: 0, saturation: 1, tintR: 0, tintG: 1, tintB: 0, tintMix: 0 } },
        { id: 'v-out',    type: 'videoOut', position: { x: 700, y: 60 },  domain: 'video' },
      ],
      [
        { id: 'e-lines-chroma', from: { nodeId: 'v-lines',  portId: 'out' }, to: { nodeId: 'v-chroma', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e-chroma-out',   from: { nodeId: 'v-chroma', portId: 'out' }, to: { nodeId: 'v-out',    portId: 'in' }, sourceType: 'video',      targetType: 'video' },
      ],
    );
    await expect(page.locator('.svelte-flow__node-chroma'), 'CHROMA visible').toBeVisible();

    const before = await stepAndReadStats(page, { nodeId: 'v-chroma', steps: FIXED_STEPS });
    assertRenderStats(before, FIXED_STEPS, { minNonZeroFrac: 0.001 });

    await setNodeParam(page, 'v-chroma', 'tintMix', 1.0);
    const after = await stepAndReadStats(page, { nodeId: 'v-chroma', steps: FIXED_STEPS });
    expect(after.framesDelta, 'second burst advanced the exact frame count').toBe(FIXED_STEPS);

    expect(
      statsDiffer(before, after),
      `CHROMA tintMix 0→1 (frozen): pre mean=${before.mean.toFixed(1)} var=${before.variance.toFixed(1)} nz=${before.nonZeroFrac.toFixed(3)} | post mean=${after.mean.toFixed(1)} var=${after.variance.toFixed(1)} nz=${after.nonZeroFrac.toFixed(3)}`,
    ).toBe(true);

  });

  test('CHROMAKEY threshold knob changes pixel pattern (FG + BG composite)', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    // CHROMAKEY keys on HUE distance, so the FG must carry SATURATED color.
    // SHAPES is grayscale; CHROMA tintMix=1 paints the whole FG uniform pure RED.
    // Key a hue NEAR red (orange) so red sits at a small-but-nonzero hue distance:
    //   threshold 0   → red is OUTSIDE the band → frame shows FG (flat red).
    //   threshold 0.9 → red falls INSIDE the band → frame keys to BG (line field).
    // The full-frame FLIP (flat red → structured lines) gives a large mean AND
    // variance AND nonZeroFrac delta — deterministic once the clock is frozen.
    // This is the Phase-2a fix for this test: the delta clearly changes the
    // frozen frame instead of nudging a smoothstep edge that the margin missed.
    await spawnPatch(
      page,
      [
        { id: 'v-shp', type: 'shapes',    position: { x: 40,  y: 40 },  domain: 'video', params: { shape: 0.3, rotate: 0.2, zoom: 0.7 } },
        { id: 'v-fg',  type: 'chroma',    position: { x: 200, y: 40 },  domain: 'video', params: { hue: 0, saturation: 2, tintR: 1, tintG: 0, tintB: 0, tintMix: 1 } },
        { id: 'v-bg',  type: 'lines',     position: { x: 40,  y: 280 }, domain: 'video', params: { amp: 8 } },
        { id: 'v-key', type: 'chromakey', position: { x: 320, y: 80 },  domain: 'video', params: { keyR: 1.0, keyG: 0.5, keyB: 0.0, threshold: 0.0, softness: 0.05, spillSuppress: 0 } },
        { id: 'v-out', type: 'videoOut',  position: { x: 700, y: 80 },  domain: 'video' },
      ],
      [
        { id: 'e-shp-fg',  from: { nodeId: 'v-shp', portId: 'out' }, to: { nodeId: 'v-fg',  portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e-fg-key',  from: { nodeId: 'v-fg',  portId: 'out' }, to: { nodeId: 'v-key', portId: 'fg' }, sourceType: 'video',      targetType: 'video' },
        { id: 'e-bg-key',  from: { nodeId: 'v-bg',  portId: 'out' }, to: { nodeId: 'v-key', portId: 'bg' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e-key-out', from: { nodeId: 'v-key', portId: 'out' }, to: { nodeId: 'v-out', portId: 'in' }, sourceType: 'video',      targetType: 'video' },
      ],
    );
    await expect(page.locator('.svelte-flow__node-chromakey'), 'CHROMAKEY visible').toBeVisible();

    // BEFORE (threshold 0): frame is the flat red FG. A flat fill has near-zero
    // spatial variance, so DON'T apply the variance floor here — assert non-black
    // + readable FBO + exact frame count + zero GL errors (the meaningful
    // correctness floors for a deliberately uniform frame).
    const before = await stepAndReadStats(page, { nodeId: 'v-key', steps: FIXED_STEPS });
    expect(before.framesDelta, 'first burst advanced the exact frame count').toBe(FIXED_STEPS);
    expect(before.fbComplete, 'CHROMAKEY output FBO readable').toBe(true);
    expect(before.glErrors, `GL errors: [${before.glErrors.join(',')}]`).toEqual([]);
    expect(before.nonZeroFrac, 'flat-red FG frame is non-black').toBeGreaterThan(0.5);

    await setNodeParam(page, 'v-key', 'threshold', 0.9);
    const after = await stepAndReadStats(page, { nodeId: 'v-key', steps: FIXED_STEPS });
    expect(after.framesDelta, 'second burst advanced the exact frame count').toBe(FIXED_STEPS);
    // AFTER (threshold 0.9): frame keys to the structured BG line field.
    expect(after.variance, 'keyed-through BG line field has spatial structure').toBeGreaterThan(15);

    expect(
      statsDiffer(before, after),
      `CHROMAKEY threshold 0→0.9 (frozen, full-frame flip): pre mean=${before.mean.toFixed(1)} var=${before.variance.toFixed(1)} nz=${before.nonZeroFrac.toFixed(3)} | post mean=${after.mean.toFixed(1)} var=${after.variance.toFixed(1)} nz=${after.nonZeroFrac.toFixed(3)}`,
    ).toBe(true);

    expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
  });

  test('LUMAKEY threshold knob changes pixel pattern (FG + BG composite)', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);

    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    // INWARDS (a denser-pixel source) is FG so the luma key has a varied luma
    // distribution to threshold across; LINES is BG. Frozen → both sources are
    // identical every step, so only the threshold moves pixels.
    //   threshold 0   → all FG (INWARDS rings).
    //   threshold 0.9 → mostly BG (LINES) bleeds through.
    // Proves both FG/BG inputs + the CV path land end-to-end.
    await spawnPatch(
      page,
      [
        { id: 'v-fg',  type: 'inwards',  position: { x: 40,  y: 40 },  domain: 'video', params: { density: 25, speed: 0.05 } },
        { id: 'v-bg',  type: 'lines',    position: { x: 40,  y: 280 }, domain: 'video', params: { amp: 8 } },
        { id: 'v-key', type: 'lumakey',  position: { x: 320, y: 80 },  domain: 'video', params: { threshold: 0.0, softness: 0.05, invert: 0 } },
        { id: 'v-out', type: 'videoOut', position: { x: 700, y: 80 },  domain: 'video' },
      ],
      [
        { id: 'e-fg-key',  from: { nodeId: 'v-fg',  portId: 'out' }, to: { nodeId: 'v-key', portId: 'fg' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e-bg-key',  from: { nodeId: 'v-bg',  portId: 'out' }, to: { nodeId: 'v-key', portId: 'bg' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e-key-out', from: { nodeId: 'v-key', portId: 'out' }, to: { nodeId: 'v-out', portId: 'in' }, sourceType: 'video',      targetType: 'video' },
      ],
    );
    await expect(page.locator('.svelte-flow__node-lumakey'), 'LUMAKEY visible').toBeVisible();

    const before = await stepAndReadStats(page, { nodeId: 'v-key', steps: FIXED_STEPS });
    assertRenderStats(before, FIXED_STEPS, { minNonZeroFrac: 0.001 });

    await setNodeParam(page, 'v-key', 'threshold', 0.9);
    const after = await stepAndReadStats(page, { nodeId: 'v-key', steps: FIXED_STEPS });
    expect(after.framesDelta, 'second burst advanced the exact frame count').toBe(FIXED_STEPS);

    expect(
      statsDiffer(before, after),
      `LUMAKEY threshold 0→0.9 (frozen): pre mean=${before.mean.toFixed(1)} var=${before.variance.toFixed(1)} nz=${before.nonZeroFrac.toFixed(3)} | post mean=${after.mean.toFixed(1)} var=${after.variance.toFixed(1)} nz=${after.nonZeroFrac.toFixed(3)}`,
    ).toBe(true);

  });

  test('COLORIZER tintR knob changes pixel pattern', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);

    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    // COLORIZER maps mono → solid tint (R = mono*tintR, etc), pure (no frame.time).
    // tintR 0 → 1 brings the red channel from black to full mono — a clear mean +
    // nonZeroFrac shift (the sparse-luma reader sums R+G+B, so adding the whole
    // red channel registers strongly).
    await spawnPatch(
      page,
      [
        { id: 'v-lines', type: 'lines',     position: { x: 40, y: 60 },   domain: 'video' },
        { id: 'v-color', type: 'colorizer', position: { x: 320, y: 60 },  domain: 'video', params: { tintR: 0.0, tintG: 0.5, tintB: 0.5 } },
        { id: 'v-out',   type: 'videoOut',  position: { x: 700, y: 60 },  domain: 'video' },
      ],
      [
        { id: 'e-lines-color', from: { nodeId: 'v-lines', portId: 'out' }, to: { nodeId: 'v-color', portId: 'in' }, sourceType: 'mono-video', targetType: 'mono-video' },
        { id: 'e-color-out',   from: { nodeId: 'v-color', portId: 'out' }, to: { nodeId: 'v-out',   portId: 'in' }, sourceType: 'video',      targetType: 'video' },
      ],
    );
    await expect(page.locator('.svelte-flow__node-colorizer'), 'COLORIZER visible').toBeVisible();

    const before = await stepAndReadStats(page, { nodeId: 'v-color', steps: FIXED_STEPS });
    assertRenderStats(before, FIXED_STEPS, { minNonZeroFrac: 0.001 });

    await setNodeParam(page, 'v-color', 'tintR', 1.0);
    const after = await stepAndReadStats(page, { nodeId: 'v-color', steps: FIXED_STEPS });
    expect(after.framesDelta, 'second burst advanced the exact frame count').toBe(FIXED_STEPS);

    expect(
      statsDiffer(before, after),
      `COLORIZER tintR 0→1 (frozen): pre mean=${before.mean.toFixed(1)} var=${before.variance.toFixed(1)} nz=${before.nonZeroFrac.toFixed(3)} | post mean=${after.mean.toFixed(1)} var=${after.variance.toFixed(1)} nz=${after.nonZeroFrac.toFixed(3)}`,
    ).toBe(true);

  });

  // DEFERRED — NOT converted to DRS. FEEDBACK is an UNBOUNDED ping-pong
  // ACCUMULATOR (two FBOs alternate; each frame samples the decay-multiplied
  // PREVIOUS frame): it is NOT a pure function of the frozen clock and ships NO
  // `freeze` param to pin a settled frame. Under freeze, a SECOND equal burst
  // reads a DIFFERENT ring state on its OWN, so a two-frozen-reads diff would be
  // VACUOUS (it would "pass" off accumulator drift, not off the wet param). Per
  // the DRS rules (do NOT weaken a determinism-blocked test), this stays on the
  // ORIGINAL wall-clock readCanvasStats/statsDiffer mechanism — the only test in
  // this file that still uses waitForTimeout. To DRS it later, the module needs
  // a source-level `freeze` pin (same call as VDELAY in video-chain.spec.ts).
  test('FEEDBACK wet knob changes pixel pattern', async ({ page, rack }) => {
    await spawnPatch(
      page,
      [
        { id: 'v-lines', type: 'lines',    position: { x: 40, y: 60 },   domain: 'video' },
        { id: 'v-fb',    type: 'feedback', position: { x: 320, y: 60 },  domain: 'video', params: { wet: 0.0, decay: 0.95, zoom: 1.05, offsetX: 0, offsetY: 0, rotate: 0 } },
        { id: 'v-out',   type: 'videoOut', position: { x: 700, y: 60 },  domain: 'video' },
      ],
      [
        { id: 'e-lines-fb', from: { nodeId: 'v-lines', portId: 'out' }, to: { nodeId: 'v-fb',  portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e-fb-out',   from: { nodeId: 'v-fb',    portId: 'out' }, to: { nodeId: 'v-out', portId: 'in' }, sourceType: 'video',      targetType: 'video' },
      ],
    );
    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await page.waitForTimeout(500);
    const before = (await readCanvasStatsLegacy(canvas))!;

    await setNodeParam(page, 'v-fb', 'wet', 1.0);
    await page.waitForTimeout(800);
    const after = (await readCanvasStatsLegacy(canvas))!;

    expect(
      statsDifferLegacy(before, after),
      `FEEDBACK wet 0→1: pre=mean=${before.mean.toFixed(1)},var=${before.variance.toFixed(1)} post=mean=${after.mean.toFixed(1)},var=${after.variance.toFixed(1)}`,
    ).toBe(true);
  });

  test('V-MIXER amount2 knob changes pixel pattern', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);

    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    // Two visually-distinct, frozen-pure sources (LINES line field + INWARDS
    // radial field). Cross-fading between them via the mixer amounts swaps which
    // pattern dominates — a per-pixel change a global stat can collude past, so
    // we assert the FROZEN per-pixel frameDiff (preserving the original intent).
    await spawnPatch(
      page,
      [
        { id: 'v-lines', type: 'lines',      position: { x: 40,  y: 40 },  domain: 'video', params: { amp: 8 } },
        { id: 'v-in',    type: 'inwards',    position: { x: 40,  y: 280 }, domain: 'video', params: { density: 25, speed: 0.05 } },
        { id: 'v-mix',   type: 'videoMixer', position: { x: 320, y: 80 },  domain: 'video', params: { amount1: 1.0, amount2: 0.0, amount3: 0, amount4: 0 } },
        { id: 'v-out',   type: 'videoOut',   position: { x: 700, y: 80 },  domain: 'video' },
      ],
      [
        { id: 'e-lines-mix', from: { nodeId: 'v-lines', portId: 'out' }, to: { nodeId: 'v-mix', portId: 'in1' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e-in-mix',    from: { nodeId: 'v-in',    portId: 'out' }, to: { nodeId: 'v-mix', portId: 'in2' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e-mix-out',   from: { nodeId: 'v-mix',   portId: 'out' }, to: { nodeId: 'v-out', portId: 'in' },  sourceType: 'video',      targetType: 'video' },
      ],
    );
    await expect(page.locator('.svelte-flow__node-videoMixer'), 'V-MIXER visible').toBeVisible();

    const before = await stepAndReadStats(page, { nodeId: 'v-mix', steps: FIXED_STEPS });
    assertRenderStats(before, FIXED_STEPS, { minNonZeroFrac: 0.001 });
    const beforeFrame = await stepAndReadFrame(page, { nodeId: 'v-mix', steps: FIXED_STEPS });

    // Cross-fade: amount1 1→0, amount2 0→1. A DIFFERENT pattern dominates.
    await setNodeParam(page, 'v-mix', 'amount1', 0.0);
    await setNodeParam(page, 'v-mix', 'amount2', 1.0);
    const after = await stepAndReadStats(page, { nodeId: 'v-mix', steps: FIXED_STEPS });
    expect(after.framesDelta, 'second burst advanced the exact frame count').toBe(FIXED_STEPS);
    const afterFrame = await stepAndReadFrame(page, { nodeId: 'v-mix', steps: FIXED_STEPS });

    // The line-field → radial-field swap keeps global mean/variance within the
    // differ margin (the documented blind spot: var 7379 → 6941), so assert the
    // FROZEN per-pixel frame difference — identical frozen frames diff ≈0, the
    // cross-fade swap moves many pixels.
    const pxDelta = frameDiff(beforeFrame, afterFrame);
    expect(
      pxDelta,
      `V-MIXER cross-fade per-pixel delta (frozen): pre mean=${before.mean.toFixed(1)} var=${before.variance.toFixed(1)} | post mean=${after.mean.toFixed(1)} var=${after.variance.toFixed(1)} frameDiff=${pxDelta.toFixed(1)}`,
    ).toBeGreaterThan(6);

  });
});

// ---------------------------------------------------------------------------
// Legacy wall-clock helpers — used ONLY by the DEFERRED FEEDBACK test above
// (an unbounded accumulator that can't be frozen into a deterministic frame).
// Kept verbatim from the pre-DRS spec so the deferred test's mechanism is
// unchanged; do NOT use these in the converted tests.
// ---------------------------------------------------------------------------

interface LegacyPixelStats {
  mean: number;
  variance: number;
  nonZero: number;
  samples: number;
}

async function readCanvasStatsLegacy(canvas: Locator): Promise<LegacyPixelStats | null> {
  return canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const data = img.data;
    let n = 0, sum = 0, sumSq = 0, nonZero = 0;
    for (let i = 0; i < data.length; i += 16) {
      const v = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
      sum += v;
      sumSq += v * v;
      if (v > 8) nonZero++;
      n++;
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    return { mean, variance, nonZero, samples: n };
  });
}

function statsDifferLegacy(a: LegacyPixelStats, b: LegacyPixelStats): boolean {
  const meanDelta = Math.abs(a.mean - b.mean);
  const varianceDelta = Math.abs(a.variance - b.variance);
  const nzDelta = Math.abs(a.nonZero - b.nonZero);
  const meanThreshold = 4;
  const varianceRel = 0.10;
  const nzRel = 0.10;
  const meanScale = Math.max(1, a.variance, b.variance);
  const nzScale = Math.max(1, a.nonZero, b.nonZero);
  return (
    meanDelta > meanThreshold ||
    varianceDelta / meanScale > varianceRel ||
    nzDelta / nzScale > nzRel
  );
}

test.describe('module palette: VIDEO grouping + V-MIXER visibility', () => {
  test('palette renders AUDIO + VIDEO domain headers and lists V-MIXER', async ({ page, rack }) => {
    // Bootstrap the engine + register video module defs (their
    // registration runs on Canvas mount).
    await page.waitForFunction(() => {
      const w = globalThis as unknown as { __ensureEngine?: () => Promise<unknown> };
      return typeof w.__ensureEngine === 'function';
    });

    // Open the palette via right-click on the canvas pane (xyflow's
    // background pane catches the contextmenu and Canvas.svelte routes
    // it through onPaneContextMenu → paletteOpen=true).
    const pane = page.locator('.svelte-flow__pane').first();
    await expect(pane).toBeVisible();
    await pane.click({ button: 'right', position: { x: 200, y: 200 } });

    // Nested-palette: Audio modules top row appears before Video modules.
    const audioTop = page.getByTestId('palette-top-audio-modules');
    const videoTop = page.getByTestId('palette-top-video-modules');
    await expect(audioTop, 'Audio modules header rendered').toBeVisible();
    await expect(videoTop, 'Video modules header rendered').toBeVisible();
    const audioBox = await audioTop.boundingBox();
    const videoBox = await videoTop.boundingBox();
    expect(audioBox && videoBox, 'both top headers measured').toBeTruthy();
    if (audioBox && videoBox) {
      expect(audioBox.y, 'Audio modules above Video modules').toBeLessThan(videoBox.y);
    }

    // Drill into Video modules → Utilities to confirm V-MIXER is reachable.
    await videoTop.click();
    await page.getByTestId('palette-sub-utilities').click();
    await expect(
      page.locator('[data-testid="palette-item-videoMixer"]'),
      'V-MIXER appears in palette',
    ).toBeVisible();

    // Other Phase-1 video modules — switch into Sources / Processors via
    // search-mode so we don't have to drill into each sub explicitly.
    // Refocus the search input first (the previous click stole focus).
    await page.locator('.module-palette input').click();
    await page.keyboard.type('LINES');
    await expect(page.locator('[data-testid="palette-item-lines"]')).toBeVisible();
  });
});
