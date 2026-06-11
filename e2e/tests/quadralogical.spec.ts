// e2e/tests/quadralogical.spec.ts
//
// QUADRALOGICAL (4-input video mixer) functional e2e.
//
// Graph:
//   LINES → CHROMA(tint red)    → in1  \
//   LINES → CHROMA(tint green)  → in2    QUADRALOGICAL → videoOut
//   LINES → CHROMA(tint blue)   → in3  /
//   LINES → CHROMA(tint yellow) → in4 /
//
// Each CHROMA tints its LINES input a distinct colour (tintMix=1) so the four
// joystick quadrants are visually separable. We assert:
//   1. all cards spawn + the QUADRALOGICAL card + preview canvas mount,
//   2. the wired-up MIX renders a non-trivial (non-black, structured) frame,
//   3. dragging the joystick to a CORNER makes that input dominate the MIX
//      (TL ⇒ red in1, BR ⇒ yellow in4 — distinct frames),
//   4. the inner-diamond CENTER is a 4-way composite (distinct from any corner),
//   5. the PREVIEW output (2×2 tile) emits when routed through a videoOut,
//   6. FREEZE holds the MIX still (deterministic-capture hook).
//
// PHASE 2 additions:
//   7. selecting a DIFFERENT effect on an edge VISIBLY changes the MIX (the
//      "always dissolve" regression) — DISSOLVE vs MULTIPLY vs DIFF on the top
//      edge produce distinct frames at the same joystick position,
//   8. each of the 8 effects renders without error + produces a distinct frame,
//   9. per-edge assignment is INDEPENDENT (changing edge 1–2 doesn't change the
//      output when the joystick sits on a different edge).
//
// Pixel-exact determinism lives in the VRT suite; this is the behavioural gate.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

// Distinct tint per input so each quadrant is a separable colour. R/G/B/Y.
const TINTS = [
  { tintR: 1, tintG: 0, tintB: 0, tintMix: 1 }, // in1 red
  { tintR: 0, tintG: 1, tintB: 0, tintMix: 1 }, // in2 green
  { tintR: 0, tintG: 0, tintB: 1, tintMix: 1 }, // in3 blue
  { tintR: 1, tintG: 1, tintB: 0, tintMix: 1 }, // in4 yellow
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

// Read coarse stats from the videoOut canvas (the MIX, via the canonical surface).
async function readStats(page: import('@playwright/test').Page) {
  const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
  return canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0, sum = 0, sumSq = 0, nonZero = 0, rSum = 0, gSum = 0, bSum = 0;
    for (let i = 0; i < data.length; i += 16) {
      const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
      const v = (r + g + b) / 3;
      sum += v; sumSq += v * v; n++;
      rSum += r; gSum += g; bSum += b;
      if (v > 8) nonZero++;
    }
    const mean = sum / n;
    return {
      mean,
      variance: sumSq / n - mean * mean,
      nonZeroFrac: nonZero / n,
      r: rSum / n, g: gSum / n, b: bSum / n,
    };
  });
}

// Drag the joystick by writing pos_x/pos_y into the patch store (the live-poll
// path picks it up; bypasses pointer-drag flake). Center = diamond all-4 zone.
async function setJoystick(page: import('@playwright/test').Page, x: number, y: number) {
  await page.evaluate(([px, py]) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['quad'];
      if (n) { n.params.pos_x = px; n.params.pos_y = py; }
    });
  }, [x, y]);
}

// Write arbitrary params onto the quad node (per-edge fx + controls). Mutated
// IN PLACE inside a Y.Doc transaction (node.params is a live Y.Map).
async function setParams(page: import('@playwright/test').Page, params: Record<string, number>) {
  await page.evaluate((p) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['quad'];
      if (n) for (const [k, v] of Object.entries(p)) n.params[k] = v;
    });
  }, params);
}

test.describe('QUADRALOGICAL — 4-input video mixer (Phase 1)', () => {
  // The Phase-2 per-edge 8-effect mix shader is heavier than Phase 1; spawning
  // 4 video inputs + rendering/sampling the mix several times per test exceeds
  // the 30s default on CI's SwiftShader software renderer (timed out on
  // shard 8). Give the whole suite a video-domain budget (matches the other
  // heavy WebGL e2e; see repo memory ci-swiftshader-video-e2e-timeouts).
  test.describe.configure({ timeout: 120_000 });

  // Phase 2 lean (webgl-suite-optimization §1/§7-4): reduced from the full
  // 4-corner + center sweep to ONE live-source corner smoke. The corner/edge/
  // center WEIGHT MAP (one-hot corners, 2-input edges, balanced center) is owned
  // pixel-free by quadralogical.test.ts (quadWeights/edgeWeights), and the
  // per-effect pixel determinism by vrt-quadralogical's 8 baselines. What stays
  // here is the unique GL claim a flat-CHROMA unit can't make: a LIVE LINES
  // source, tinted by a real CHROMA, reaches the right corner of the real MIX
  // FBO (structured, not all-black, with the routed colour dominating).
  test('4 colored CHROMA inputs → MIX renders a structured live frame; TL corner is in1 (red) dominant', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, buildNodes(), buildEdges());

    await expect(page.locator('.svelte-flow__node-quadralogical'), 'QUADRALOGICAL visible').toBeVisible();
    await expect(page.locator('[data-testid="quadralogical-card"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="quadralogical-canvas"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="quadralogical-pad"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="quadralogical-diamond"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="quadralogical-dot"]')).toHaveCount(1);
    await expect(page.locator('canvas[data-testid="video-out-canvas"]')).toHaveCount(1);

    // ---- TL corner ⇒ in1 (red) dominates ----
    await setJoystick(page, -1, 1);
    await page.waitForTimeout(400);
    const tl = await readStats(page);
    expect(tl, 'MIX canvas readable').not.toBeNull();
    expect(tl!.nonZeroFrac, 'MIX not all-black at TL corner').toBeGreaterThan(0.02);
    expect(tl!.variance, 'MIX has spatial structure (live LINES)').toBeGreaterThan(20);
    expect(tl!.r, 'TL corner → in1 (red) dominant: R > G').toBeGreaterThan(tl!.g + 8);
    expect(tl!.r, 'TL corner → in1 (red) dominant: R > B').toBeGreaterThan(tl!.b + 8);

    expect(errors, 'no console / page errors').toEqual([]);
  });

  test('PREVIEW output (2×2 raw tile) emits when routed through a videoOut', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Same sources, but route quad.preview → videoOut.in (the secondary output).
    const nodes = buildNodes();
    const edges = buildEdges().filter((e) => e.id !== 'out');
    edges.push({ id: 'prev', from: { nodeId: 'quad', portId: 'preview' }, to: { nodeId: 'v-out', portId: 'in' }, sourceType: 'video', targetType: 'video' });
    await spawnPatch(page, nodes, edges);

    await expect(page.locator('canvas[data-testid="video-out-canvas"]')).toHaveCount(1);
    await page.waitForTimeout(600);

    const stats = await readStats(page);
    expect(stats, 'PREVIEW canvas readable').not.toBeNull();
    // The 2×2 tile shows the four raw (coloured) inputs → non-black + structured.
    expect(stats!.nonZeroFrac, 'PREVIEW tile emits (not all-black)').toBeGreaterThan(0.02);
    expect(stats!.variance, 'PREVIEW tile has structure (4 distinct cells)').toBeGreaterThan(20);
    // All three colour channels appear somewhere in the 2×2 tile (R,G,B,Y inputs).
    expect(stats!.r, 'PREVIEW has red (in1/in4 tiles)').toBeGreaterThan(8);
    expect(stats!.g, 'PREVIEW has green (in2/in4 tiles)').toBeGreaterThan(8);
    expect(stats!.b, 'PREVIEW has blue (in3 tile)').toBeGreaterThan(8);

    expect(errors, 'no console / page errors').toEqual([]);
  });

  // NOTE (Phase 2 lean, §1/§7-3): the FREEZE deterministic-capture test was
  // DOWNGRADED to quadralogical.test.ts ("QUADRALOGICAL FREEZE holds the frame")
  // — the freeze mechanism is `draw() returns before any GL work when frozen`,
  // which a draw-counting unit ctx asserts GPU-free (no canvas sample needed).

  // ── Phase 2: per-edge effects ────────────────────────────────────────────

  test('selecting a DIFFERENT effect on an edge VISIBLY changes the MIX (no more "always dissolve")', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, buildNodes(), buildEdges());
    await expect(page.locator('canvas[data-testid="video-out-canvas"]')).toHaveCount(1);

    // Sit ON the top edge (in1 red ↔ in2 green), midway → both contribute.
    // Edge 1–2 is the active edge here.
    await setJoystick(page, 0, 1);

    // Capture the brightness signature for a given edge-1 effect. We average
    // over a few frames so animation jitter doesn't dominate the comparison.
    const sigForFx = async (fx: number): Promise<{ mean: number; r: number; g: number; b: number }> => {
      await setParams(page, { edge1_fx: fx, edge1_amount: 1, edge1_param: 0.1 });
      await page.waitForTimeout(350);
      let mean = 0, r = 0, g = 0, b = 0; const N = 4;
      for (let i = 0; i < N; i++) {
        const s = await readStats(page);
        mean += s!.mean; r += s!.r; g += s!.g; b += s!.b;
        await page.waitForTimeout(60);
      }
      return { mean: mean / N, r: r / N, g: g / N, b: b / N };
    };

    const dissolve = await sigForFx(0);  // mid-grey-ish red+green average
    const multiply = await sigForFx(2);  // red·green = dark → much DARKER
    const diff = await sigForFx(6);      // |red-green| stays bright/saturated

    // DISSOLVE vs MULTIPLY must differ a lot in overall brightness (multiply of
    // two complementary colours darkens hard). This is the core regression: in
    // Phase 1 every effect rendered identically (dissolve).
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

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, buildNodes(), buildEdges());
    await expect(page.locator('canvas[data-testid="video-out-canvas"]')).toHaveCount(1);

    // Sit on the BOTTOM edge (in3 blue ↔ in4 yellow) — that's edge 3–4. Edge
    // 1–2's mass is ~0 here, so changing edge1_fx must NOT change the output.
    await setJoystick(page, 0, -1);
    // Make edge 3–4 a plain dissolve so the bottom-edge frame is stable.
    await setParams(page, { edge3_fx: 0, edge1_fx: 0 });
    await page.waitForTimeout(350);

    const avgStats = async (): Promise<{ r: number; g: number; b: number }> => {
      let r = 0, g = 0, b = 0; const N = 4;
      for (let i = 0; i < N; i++) { const s = await readStats(page); r += s!.r; g += s!.g; b += s!.b; await page.waitForTimeout(60); }
      return { r: r / N, g: g / N, b: b / N };
    };

    const before = await avgStats();
    // Slam edge 1–2 to MULTIPLY — a dramatic change IF it leaked into this edge.
    await setParams(page, { edge1_fx: 2, edge1_amount: 1 });
    await page.waitForTimeout(350);
    const after = await avgStats();

    const delta = Math.abs(after.r - before.r) + Math.abs(after.g - before.g) + Math.abs(after.b - before.b);
    // The bottom edge (3–4) frame should be essentially unchanged (small delta
    // from animation only). Edge 1–2's effect is inactive at this joystick pos.
    expect(delta, 'changing edge 1–2 fx does NOT perturb the edge 3–4 output').toBeLessThan(10);

    expect(errors, 'no console / page errors').toEqual([]);
  });
});
