// e2e/tests/quadralogical.spec.ts
//
// QUADRALOGICAL (4-input video mixer) — DETERMINISTIC render-smoke (DRS),
// converted IN-PLACE from the old wall-clock / animation-diff shape (plan §3/§5
// Layer B; rebuild plan §3 "DRS for corner-dominance + preview").
//
// ── WHY THIS IS DRS-ABLE (frame-time purity of the whole chain) ──────────────
// The graph is  LINES → CHROMA(tint) → QUADRALOGICAL → videoOut , ×4 inputs.
//   * LINES is a pure `frame.time`-animated source: its ONLY time dependence is
//     `autoPhase = (frame.time * 0.15) % 1`. PINNING the engine clock
//     (`__videoEngineFreezeTime`) makes frame.time constant → LINES renders an
//     IDENTICAL frame every step (same property ACIDWARP relies on).
//   * CHROMA is a pure function of its input + params — no time read, no RNG, no
//     accumulator.
//   * QUADRALOGICAL's MIX + PREVIEW shaders are pure functions of the four input
//     textures + the joystick / per-edge params — NO frame.time read, NO
//     Math.random, NO performance.now, NO accumulating ring/animTick state.
// So with the rAF loop PAUSED (`__videoEnginePause` → the test owns the exact
// frame count) and the clock PINNED, the entire chain is a pure function of the
// frozen clock + params: every step produces a bit-stable frame, and a param
// change produces a different bit-stable frame. NO test here has a determinism
// blocker → NOTHING is deferred.
//
// ── HOW EACH ORIGINAL ASSERTION'S INTENT IS PRESERVED ────────────────────────
//   1. card / canvas / pad / diamond / dot / video-out-canvas mount  → kept
//      as-is (DOM structural assertions; deterministic already).
//   2. wired MIX renders a non-trivial structured frame + TL corner ⇒ in1 (red)
//      dominant  → DRS: freeze+pause, set joystick to TL via the ENGINE domain
//      setParam (inside the SAME evaluate as the step burst — no yield, so no
//      rAF/Y.Doc poll can interleave), step a fixed burst, read QUADRALOGICAL's
//      OWN `out` FBO once. Renderer-tolerant floors (nonZero / variance) instead
//      of a specific pixel, PLUS the colour-dominance R>G,R>B claim, PLUS a
//      second-burst frame-stable proof (the property the old one-shot lacked).
//   5. PREVIEW (2×2 tile) emits  → DRS: read QUADRALOGICAL's `preview` PORT FBO
//      (multi-output read), floors + all-3-channels-present + second-burst
//      stability.
//   7. selecting a DIFFERENT effect VISIBLY changes the MIX (the "always
//      dissolve" regression)  → TWO-FROZEN-READS per the §3 directive: sit on
//      the top edge, freeze→set edge1_fx=A→step N→read, freeze→set edge1_fx=B→
//      step N→read, compare the two FROZEN samples (deterministic diff, NOT an
//      animation average). The fx deltas chosen (DISSOLVE vs MULTIPLY of two
//      complementary colours; DISSOLVE vs DIFF) move pixels by a wide margin.
//   9. per-edge assignment is INDEPENDENT  → TWO-FROZEN-READS: sit on the BOTTOM
//      edge (edge 3–4 active, edge 1–2 mass ≈ 0), read frozen, flip edge1_fx to
//      MULTIPLY, read frozen, assert the two frozen frames are ~identical (a
//      leak would change them). No animation slack needed — both reads are
//      frozen, so the tolerance is tiny.
//
//   The original suite had already DOWNGRADED the FREEZE-capture test and the
//   "all 8 effects render distinct" test to the unit + VRT suites (see the
//   original NOTE comments, preserved below); we keep those downgrades.
//
// No waitForTimeout, no poll, no animation-diff, no exact-pixel equality.

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';

const FIXED_STEPS = 6;

// Distinct tint per input so each quadrant is a separable colour. R/G/B/Y.
const TINTS = [
  { tintR: 1, tintG: 0, tintB: 0, tintMix: 0.6 }, // in1 red
  { tintR: 0, tintG: 1, tintB: 0, tintMix: 0.6 }, // in2 green
  { tintR: 0, tintG: 0, tintB: 1, tintMix: 0.6 }, // in3 blue
  { tintR: 1, tintG: 1, tintB: 0, tintMix: 0.6 }, // in4 yellow
];

function buildNodes() {
  const nodes: Array<{ id: string; type: string; position: { x: number; y: number }; domain: 'video'; params?: Record<string, number> }> = [];
  for (let i = 0; i < 4; i++) {
    nodes.push({ id: `lines${i}`, type: 'lines', position: { x: 40, y: 40 + i * 180 }, domain: 'video', params: { amp: 8 + i } });
    nodes.push({ id: `chroma${i}`, type: 'chroma', position: { x: 260, y: 40 + i * 180 }, domain: 'video', params: TINTS[i]! });
  }
  nodes.push({ id: 'quad', type: 'quadralogical', position: { x: 560, y: 80 }, domain: 'video' });
  nodes.push({ id: 'v-out', type: 'videoOut', position: { x: 1080, y: 80 }, domain: 'video' });
  return nodes;
}

function buildEdges() {
  const edges: Array<{ id: string; from: { nodeId: string; portId: string }; to: { nodeId: string; portId: string }; sourceType?: string; targetType?: string }> = [];
  for (let i = 0; i < 4; i++) {
    edges.push({ id: `l${i}`, from: { nodeId: `lines${i}`, portId: 'out' }, to: { nodeId: `chroma${i}`, portId: 'in' }, sourceType: 'mono-video', targetType: 'video' });
    edges.push({ id: `c${i}`, from: { nodeId: `chroma${i}`, portId: 'out' }, to: { nodeId: 'quad', portId: `in${i + 1}` }, sourceType: 'video', targetType: 'video' });
  }
  edges.push({ id: 'out', from: { nodeId: 'quad', portId: 'out' }, to: { nodeId: 'v-out', portId: 'in' }, sourceType: 'video', targetType: 'video' });
  return edges;
}

// ── DRS read helper with per-channel stats + ENGINE-domain param writes ──────
//
// The shared stepAndReadStats() returns luma stats only; this spec also needs
// per-channel (r/g/b) means for the corner-colour-dominance + per-edge-fx
// assertions, and it needs to SET params on the video domain in the SAME
// evaluate as the step burst (no yield → no rAF/Y.Doc poll can interleave a
// stale frame between the param write and the frozen read). So we mirror the
// harness exactly (same FBO readback + sparse luma stats + EXACT frame-count
// delta + GL-error capture) and extend it with channel sums + a params write.
//
// `params` is applied via vid.setParam(nodeId, paramId, value) — the engine
// domain façade (VideoEngine.setParam → handle.setParam), the same path a
// patched CV cable drives. This replaces the old Y.Doc-store write + the
// live-poll wait; here the value is in effect for the very next synchronous
// step().
interface ChannelStats {
  framesDelta: number;
  fbComplete: boolean;
  glErrors: number[];
  nonZeroFrac: number;
  variance: number;
  mean: number;
  r: number;
  g: number;
  b: number;
}

async function setStepRead(
  page: Page,
  opts: { nodeId: string; portId?: string; steps: number; params?: Record<string, number> },
): Promise<ChannelStats> {
  return page.evaluate(({ nodeId, portId, steps, params }) => {
    const w = globalThis as unknown as {
      __engine: () => {
        getDomain: (d: string) => {
          gl: WebGL2RenderingContext;
          step: () => void;
          currentFrameCount: () => number;
          setParam: (id: string, paramId: string, value: number) => void;
          outputTexture: (id: string, port?: string) => WebGLTexture | null;
          res: { width: number; height: number };
        };
      };
    };
    const vid = w.__engine().getDomain('video');
    const gl = vid.gl;
    while (gl.getError() !== gl.NO_ERROR) { /* drain pre-existing */ }

    // Apply param writes BEFORE the step burst, in the same evaluate (no yield).
    if (params) for (const [k, v] of Object.entries(params)) vid.setParam(nodeId, k, v);

    const before = vid.currentFrameCount();
    for (let i = 0; i < steps; i++) vid.step();
    const framesDelta = vid.currentFrameCount() - before;

    const glErrors: number[] = [];
    let e: number;
    while ((e = gl.getError()) !== gl.NO_ERROR) glErrors.push(e);

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
    while (gl.getError() !== gl.NO_ERROR) { /* drain readback (already captured) */ }

    let n = 0, sum = 0, sumSq = 0, nonZero = 0, rSum = 0, gSum = 0, bSum = 0;
    for (let i = 0; i < px.length; i += 4 * 16) {
      const r = px[i]!, gC = px[i + 1]!, bC = px[i + 2]!;
      const v = (r + gC + bC) / 3;
      sum += v; sumSq += v * v; n++;
      rSum += r; gSum += gC; bSum += bC;
      if (v > 8) nonZero++;
    }
    const mean = n ? sum / n : 0;
    const variance = n ? sumSq / n - mean * mean : 0;
    return {
      framesDelta, fbComplete: complete, glErrors,
      nonZeroFrac: n ? nonZero / n : 0, variance, mean,
      r: n ? rSum / n : 0, g: n ? gSum / n : 0, b: n ? bSum / n : 0,
    };
  }, opts);
}

// The standard floors (mirrors assertRenderStats; renderer-tolerant). The MIX
// here is fed a LIVE LINES pattern (a sparse striped source) tinted by CHROMA,
// so the non-black floor is the harness default — but lowered where the routed
// content is genuinely sparse (the diamond composite of striped inputs).
function assertFloors(s: ChannelStats, steps: number, opts: { minNonZeroFrac?: number; minVariance?: number } = {}): void {
  expect(s.framesDelta, 'engine advanced exactly the fixed frame count (loop paused)').toBe(steps);
  expect(s.fbComplete, 'output FBO readable').toBe(true);
  expect(s.glErrors, `GL errors during render: [${s.glErrors.join(',')}]`).toEqual([]);
  expect(s.nonZeroFrac, 'output is not all-black').toBeGreaterThan(opts.minNonZeroFrac ?? 0.02);
  expect(s.variance, 'output has spatial structure (live LINES, not a flat fill)').toBeGreaterThan(opts.minVariance ?? 15);
}

test.describe('QUADRALOGICAL — 4-input video mixer (Phase 1)', () => {
  // The Phase-2 per-edge 8-effect mix shader is heavier than Phase 1; spawning
  // 4 video inputs + reading the mix several times exceeds the 30s default on
  // CI's SwiftShader software renderer. Keep the video-domain budget (matches
  // the other heavy WebGL e2e; see repo memory ci-swiftshader-video-e2e-timeouts).
  test.describe.configure({ timeout: 120_000 });

  // Phase 2 lean (webgl-suite-optimization §1/§7-4): the corner/edge/center
  // WEIGHT MAP is owned pixel-free by quadralogical.test.ts (quadWeights/
  // edgeWeights) and the per-effect pixel determinism by vrt-quadralogical's 8
  // baselines. What stays here is the unique GL claim a flat-CHROMA unit can't
  // make: a LIVE LINES source, tinted by a real CHROMA, reaches the right corner
  // of the real MIX FBO (structured, not all-black, routed colour dominating) —
  // now proven DETERMINISTICALLY (freeze+pause+step) instead of by wall-clock.
  test('4 colored CHROMA inputs → MIX renders a structured live frame; TL corner is in1 (red) dominant', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // Pause the engine rAF loop (the test owns the frame count) + pin the clock
    // (LINES → identical frame every step) BEFORE boot.
    await installRenderSmokeHooks(page);

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, buildNodes(), buildEdges());

    // DOM-structural assertions (deterministic already) — preserved as-is.
    await expect(page.locator('.svelte-flow__node-quadralogical'), 'QUADRALOGICAL visible').toBeVisible();
    await expect(page.locator('[data-testid="quadralogical-card"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="quadralogical-canvas"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="quadralogical-pad"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="quadralogical-diamond"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="quadralogical-dot"]')).toHaveCount(1);
    await expect(page.locator('canvas[data-testid="video-out-canvas"]')).toHaveCount(1);

    // ---- TL corner ⇒ in1 (red) dominates ----
    // Joystick to TL via the engine domain (pos_x=-1, pos_y=+1), inside the same
    // evaluate as the step burst, then read QUADRALOGICAL's OWN `out` FBO.
    const tl = await setStepRead(page, { nodeId: 'quad', steps: FIXED_STEPS, params: { pos_x: -1, pos_y: 1 } });
    assertFloors(tl, FIXED_STEPS, { minNonZeroFrac: 0.02, minVariance: 20 });
    expect(tl.r, 'TL corner → in1 (red) dominant: R > G').toBeGreaterThan(tl.g + 8);
    expect(tl.r, 'TL corner → in1 (red) dominant: R > B').toBeGreaterThan(tl.b + 8);

    // DETERMINISM: a second independent burst (clock frozen, params unchanged,
    // no accumulating state in the chain) must be frame-stable — the property
    // the old waitForTimeout(400)+one-shot read lacked.
    const tl2 = await setStepRead(page, { nodeId: 'quad', steps: FIXED_STEPS });
    expect(tl2.framesDelta, 'second burst also advanced the exact frame count').toBe(FIXED_STEPS);
    expect(Math.abs(tl2.mean - tl.mean), `frozen MIX is frame-stable (mean ${tl.mean.toFixed(3)} vs ${tl2.mean.toFixed(3)})`).toBeLessThan(0.5);
    expect(Math.abs(tl2.variance - tl.variance), 'frozen MIX variance is frame-stable').toBeLessThan(1.0);

    expect(errors, 'no console / page errors').toEqual([]);
  });

  test('PREVIEW output (2×2 raw tile) emits when routed through a videoOut', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await installRenderSmokeHooks(page);

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Same sources, but route quad.preview → videoOut.in (the secondary output).
    // The DRS read targets QUADRALOGICAL's `preview` PORT FBO directly (the
    // multi-output read('outputTexture:preview') path), so the assertion does
    // not depend on what the videoOut canvas happens to blit.
    const nodes = buildNodes();
    const edges = buildEdges().filter((e) => e.id !== 'out');
    edges.push({ id: 'prev', from: { nodeId: 'quad', portId: 'preview' }, to: { nodeId: 'v-out', portId: 'in' }, sourceType: 'video', targetType: 'video' });
    await spawnPatch(page, nodes, edges);

    await expect(page.locator('canvas[data-testid="video-out-canvas"]')).toHaveCount(1);

    // Read QUADRALOGICAL's `preview` output texture (the 2×2 raw-input tile).
    const stats = await setStepRead(page, { nodeId: 'quad', portId: 'preview', steps: FIXED_STEPS });
    // The 2×2 tile shows the four raw (coloured) inputs → non-black + structured.
    assertFloors(stats, FIXED_STEPS, { minNonZeroFrac: 0.02, minVariance: 20 });
    // All three colour channels appear somewhere in the 2×2 tile (R,G,B,Y inputs).
    expect(stats.r, 'PREVIEW has red (in1/in4 tiles)').toBeGreaterThan(8);
    expect(stats.g, 'PREVIEW has green (in2/in4 tiles)').toBeGreaterThan(8);
    expect(stats.b, 'PREVIEW has blue (in3 tile)').toBeGreaterThan(8);

    // DETERMINISM: second burst frame-stable (PREVIEW is a pure function of the
    // four frozen inputs — no accumulating state).
    const stats2 = await setStepRead(page, { nodeId: 'quad', portId: 'preview', steps: FIXED_STEPS });
    expect(stats2.framesDelta, 'second burst also advanced the exact frame count').toBe(FIXED_STEPS);
    expect(Math.abs(stats2.mean - stats.mean), `frozen PREVIEW is frame-stable (mean ${stats.mean.toFixed(3)} vs ${stats2.mean.toFixed(3)})`).toBeLessThan(0.5);
    expect(Math.abs(stats2.variance - stats.variance), 'frozen PREVIEW variance is frame-stable').toBeLessThan(1.0);

    expect(errors, 'no console / page errors').toEqual([]);
  });

  // NOTE (Phase 2 lean, §1/§7-3): the FREEZE deterministic-capture test was
  // DOWNGRADED to quadralogical.test.ts ("QUADRALOGICAL FREEZE holds the frame")
  // — the freeze mechanism is `draw() returns before any GL work when frozen`,
  // which a draw-counting unit ctx asserts GPU-free (no canvas sample needed).
  // (This DRS conversion does not re-add it; it stays at the unit layer.)

  // ── Phase 2: per-edge effects ────────────────────────────────────────────

  test('selecting a DIFFERENT effect on an edge VISIBLY changes the MIX (no more "always dissolve")', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await installRenderSmokeHooks(page);

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, buildNodes(), buildEdges());
    await expect(page.locator('canvas[data-testid="video-out-canvas"]')).toHaveCount(1);

    // §3 directive — TWO-FROZEN-READS, NOT animation-diff. Sit ON the top edge
    // (in1 red ↔ in2 green, edge 1–2 active), midway → both contribute. For each
    // candidate edge-1 effect: set the joystick + edge1 params + the fx, step a
    // fixed burst, and read QUADRALOGICAL's OWN `out` FBO ONCE. The frozen clock
    // makes each read a single deterministic sample (no per-frame jitter to
    // average away), so we compare the FROZEN frames directly.
    const sigForFx = (fx: number) =>
      setStepRead(page, {
        nodeId: 'quad',
        steps: FIXED_STEPS,
        params: { pos_x: 0, pos_y: 1, edge1_fx: fx, edge1_amount: 1, edge1_param: 0.1 },
      });

    const dissolve = await sigForFx(0);  // 0 DISSOLVE — mid red+green average
    const multiply = await sigForFx(2);  // 2 MULTIPLY — red·green = dark → DARKER
    const diff = await sigForFx(6);      // 6 DIFF — |red-green| stays saturated

    // Sanity: every sample is a real, structured, error-free frame.
    assertFloors(dissolve, FIXED_STEPS, { minNonZeroFrac: 0.02, minVariance: 20 });
    assertFloors(multiply, FIXED_STEPS, { minNonZeroFrac: 0.001 }); // MULTIPLY darkens hard → may be sparse-bright
    assertFloors(diff, FIXED_STEPS, { minNonZeroFrac: 0.02, minVariance: 20 });

    // DISSOLVE vs MULTIPLY must differ a lot in overall brightness (multiply of
    // two complementary colours darkens hard). This is the core regression: in
    // Phase 1 every effect rendered identically (dissolve). The fx DELTA here
    // (linear cross-dissolve vs product of red·green ≈ 0) is large enough to
    // clear a renderer-tolerant margin on SwiftShader.
    expect(multiply.mean, 'MULTIPLY noticeably darker than DISSOLVE')
      .toBeLessThan(dissolve.mean - 6);
    // DIFF differs from DISSOLVE too (different channel mix).
    const diffDelta = Math.abs(diff.r - dissolve.r) + Math.abs(diff.g - dissolve.g) + Math.abs(diff.b - dissolve.b);
    expect(diffDelta, 'DIFF frame differs from DISSOLVE frame').toBeGreaterThan(8);

    expect(errors, 'no console / page errors').toEqual([]);
  });

  // NOTE (Phase 2 lean, §1/§2/§7-2): the "all 8 effects render distinct" test
  // was PRUNED — it is a true duplicate. vrt-quadralogical.spec.ts pins one
  // pixel-exact baseline PER effect (dissolve/add/multiply/wipe/chroma/luma/
  // diff/iris), and quadralogical.test.ts covers the blend2 math for every
  // effect branch. The dynamic "effect-change moves the mix" claim is kept by
  // the DISSOLVE≠MULTIPLY≠DIFF test above (the "always-dissolve" regression).

  test('per-edge assignment is INDEPENDENT (edge 1–2 fx does not affect a different active edge)', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await installRenderSmokeHooks(page);

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, buildNodes(), buildEdges());
    await expect(page.locator('canvas[data-testid="video-out-canvas"]')).toHaveCount(1);

    // §3 directive — TWO-FROZEN-READS. Sit on the BOTTOM edge (in3 blue ↔ in4
    // yellow) — that's edge 3–4. Edge 1–2's mass is ≈ 0 here, so changing
    // edge1_fx must NOT change the output. Make edge 3–4 a plain dissolve and
    // edge 1–2 a dissolve too for the baseline, then read frozen.
    const before = await setStepRead(page, {
      nodeId: 'quad',
      steps: FIXED_STEPS,
      params: { pos_x: 0, pos_y: -1, edge3_fx: 0, edge1_fx: 0 },
    });
    assertFloors(before, FIXED_STEPS, { minNonZeroFrac: 0.02, minVariance: 20 });

    // Slam edge 1–2 to MULTIPLY — a dramatic change IF it leaked into this edge.
    // Read frozen again (joystick unchanged, clock frozen).
    const after = await setStepRead(page, {
      nodeId: 'quad',
      steps: FIXED_STEPS,
      params: { edge1_fx: 2, edge1_amount: 1 },
    });
    expect(after.framesDelta, 'second burst also advanced the exact frame count').toBe(FIXED_STEPS);

    const delta = Math.abs(after.r - before.r) + Math.abs(after.g - before.g) + Math.abs(after.b - before.b);
    // Both reads are FROZEN at the same joystick position, so a clean
    // independence holds the frame essentially bit-identical (edge 1–2 inactive
    // at this joystick pos). Tighter than the old animation-slack tolerance of
    // 10 — a frozen pair has no per-frame jitter to absorb — but still
    // renderer-tolerant of SwiftShader rounding.
    expect(delta, 'changing edge 1–2 fx does NOT perturb the edge 3–4 output').toBeLessThan(4);

    expect(errors, 'no console / page errors').toEqual([]);
  });
});
