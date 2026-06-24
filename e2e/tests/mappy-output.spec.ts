// e2e/tests/mappy-output.spec.ts
//
// MAPPY real-source-chain coverage: a known LIVE video source → MAPPY →
// videoOut. Asserts (renderer-tolerant, so it holds on CI's SwiftShader
// software renderer):
//   1. the composite output is NON-BLANK + structured when an input is driven;
//   2. WARPING a surface (drag its quad to a sub-rect) CHANGES the composite;
//   3. driving a SECOND input also CHANGES the composite (each input matters,
//      the behavioral-sweep invariant).
//
// Source chain mirrors the QUADRALOGICAL e2e: LINES (an animated generative
// source, no file/codec needed) → CHROMA (tint to a separable colour) →
// MAPPY.inN. Reading the videoOut canvas (the canonical surface) avoids any
// dependence on a hardware encoder or a real camera — there is neither here.
//
// CAPABILITY NOTE: this is a PURE-GL chain (no getUserMedia, no H.264). The
// only renderer-sensitivity is shader/pixel precision, so every assertion uses
// COUNT-of-non-black / mean-channel / structural-CHANGE deltas with generous
// thresholds rather than exact pixels — confirmed to hold on the SwiftShader
// software renderer, not just a real GPU.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

type Page = import('@playwright/test').Page;

// Tint per input so each surface is a separable colour (LINES is mono; CHROMA
// tints it). Mirrors the QUADRALOGICAL e2e's TINTS.
const TINT_RED = { tintR: 1, tintG: 0, tintB: 0, tintMix: 1 };
const TINT_GREEN = { tintR: 0, tintG: 1, tintB: 0, tintMix: 1 };

type Node = { id: string; type: string; position: { x: number; y: number }; domain: 'video'; params?: Record<string, number> };
type Edge = { id: string; from: { nodeId: string; portId: string }; to: { nodeId: string; portId: string }; sourceType: string; targetType: string };

/** Build a LINES → CHROMA(tint) source feeding mappy.inN. */
function source(idx: number, tint: Record<string, number>, y: number): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: [
      { id: `lines${idx}`, type: 'lines', position: { x: 40, y }, domain: 'video', params: { amp: 8 + idx } },
      { id: `chroma${idx}`, type: 'chroma', position: { x: 260, y }, domain: 'video', params: tint },
    ],
    edges: [
      { id: `l${idx}`, from: { nodeId: `lines${idx}`, portId: 'out' }, to: { nodeId: `chroma${idx}`, portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
    ],
  };
}

/** Coarse, renderer-tolerant stats over the videoOut canvas. */
async function readStats(page: Page) {
  const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
  await expect(canvas, 'videoOut canvas present').toHaveCount(1);
  return canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0, sum = 0, sumSq = 0, nonZero = 0, rSum = 0, gSum = 0, bSum = 0;
    // A spatial signature (samples weighted by position) so two structurally
    // different composites read as different even at the same mean brightness.
    let sig = 0;
    for (let i = 0; i < data.length; i += 16) {
      const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
      const v = (r + g + b) / 3;
      sum += v; sumSq += v * v; n++;
      rSum += r; gSum += g; bSum += b;
      if (v > 8) nonZero++;
      sig += (r + g * 2 + b * 3) * ((i % 1009) + 1);
    }
    const mean = sum / n;
    return {
      mean,
      variance: sumSq / n - mean * mean,
      nonZeroFrac: nonZero / n,
      r: rSum / n, g: gSum / n, b: bSum / n,
      sig,
    };
  });
}

/** Set params on a node IN PLACE inside a Y.Doc transaction. */
async function setParams(page: Page, nodeId: string, params: Record<string, number>) {
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

/** Drag MAPPY surface `idx` (1-based) to a small TOP-LEFT sub-rect by writing
 *  node.data.surfaces[idx-1].corners IN PLACE (the same path the card's
 *  corner-drag writes). Corner order TL, TR, BR, BL in [0,1] output space. */
async function warpSurface(page: Page, mappyId: string, idx1: number, corners: number[][]) {
  await page.evaluate(({ mappyId, surfaceIdx, corners }) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { surfaces?: { corners: number[][] }[] } }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes[mappyId];
      if (!n) return;
      if (!n.data) n.data = {};
      if (!Array.isArray(n.data.surfaces) || n.data.surfaces.length !== 6) {
        // seed six full-frame surfaces (UNIT_QUAD TL,TR,BR,BL)
        n.data.surfaces = Array.from({ length: 6 }, () => ({
          corners: [[0, 0], [1, 0], [1, 1], [0, 1]] as number[][],
        }));
      }
      const s = n.data.surfaces[surfaceIdx];
      if (s) s.corners = corners;
    });
  }, { mappyId, surfaceIdx: idx1 - 1, corners });
}

/** Set MAPPY surface `idx1` (1-based) FIT mode (true = zoom-fit, false = crop)
 *  by writing node.data.surfaces[idx-1].fit IN PLACE — the same path the card's
 *  per-surface FIT toggle writes. Seeds the 6-surface array if absent. */
async function setFit(page: Page, mappyId: string, idx1: number, fit: boolean) {
  await page.evaluate(({ mappyId, surfaceIdx, fit }) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { surfaces?: { corners: number[][]; fit?: boolean }[] } }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes[mappyId];
      if (!n) return;
      if (!n.data) n.data = {};
      if (!Array.isArray(n.data.surfaces) || n.data.surfaces.length !== 6) {
        n.data.surfaces = Array.from({ length: 6 }, () => ({
          corners: [[0, 0], [1, 0], [1, 1], [0, 1]] as number[][],
          fit: true,
        }));
      }
      const s = n.data.surfaces[surfaceIdx];
      if (s) s.fit = fit;
    });
  }, { mappyId, surfaceIdx: idx1 - 1, fit });
}

async function setup(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  return errors;
}

test.describe('MAPPY — multi-surface projection mapper output', () => {
  // Pure-GL multi-input chain; on CI's SwiftShader software renderer spawning
  // LINES→CHROMA sources + the warp/composite + several canvas reads can exceed
  // the 30s default (the established video-domain budget — see repo memory
  // ci-swiftshader-video-e2e-timeouts).
  test.describe.configure({ timeout: 120_000 });

  test('source → mappy → output: composite is non-blank, and warping a surface changes it', async ({ page }) => {
    const errors = await setup(page);

    const s1 = source(1, TINT_RED, 40);
    const nodes: Node[] = [
      ...s1.nodes,
      { id: 'mappy', type: 'mappy', position: { x: 560, y: 60 }, domain: 'video' },
      { id: 'v-out', type: 'videoOut', position: { x: 900, y: 60 }, domain: 'video' },
    ];
    const edges: Edge[] = [
      ...s1.edges,
      { id: 'm1', from: { nodeId: 'chroma1', portId: 'out' }, to: { nodeId: 'mappy', portId: 'in1' }, sourceType: 'video', targetType: 'video' },
      { id: 'mo', from: { nodeId: 'mappy', portId: 'out' }, to: { nodeId: 'v-out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
    ];
    await spawnPatch(page, nodes, edges);

    await expect(page.locator('[data-testid="mappy-card"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="mappy-canvas"]')).toHaveCount(1);
    await expect(page.locator('canvas[data-testid="video-out-canvas"]')).toHaveCount(1);
    await page.waitForTimeout(600);

    // 1) Full-frame surface 1 → the whole composite shows the (red) live source.
    const full = await readStats(page);
    expect(full, 'composite readable').not.toBeNull();
    expect(full!.nonZeroFrac, 'composite NOT all-black (in1 drives full frame)').toBeGreaterThan(0.1);
    expect(full!.variance, 'composite has spatial structure (live LINES)').toBeGreaterThan(15);
    expect(full!.r, 'in1 is red-tinted: R dominates G').toBeGreaterThan(full!.g + 6);
    expect(full!.r, 'in1 is red-tinted: R dominates B').toBeGreaterThan(full!.b + 6);

    // 2) Warp surface 1 into a small TOP-LEFT sub-rect → far fewer lit texels
    //    and a different spatial signature. The composite MUST change.
    await warpSurface(page, 'mappy', 1, [[0.02, 0.02], [0.42, 0.02], [0.42, 0.42], [0.02, 0.42]]);
    await page.waitForTimeout(600);
    const warped = await readStats(page);
    expect(warped, 'warped composite readable').not.toBeNull();
    // The footprint shrank to ~1/4×1/4 of the frame → the lit fraction drops.
    expect(
      warped!.nonZeroFrac,
      `warp shrinks the lit footprint (full=${full!.nonZeroFrac.toFixed(3)} warped=${warped!.nonZeroFrac.toFixed(3)})`,
    ).toBeLessThan(full!.nonZeroFrac * 0.6);
    // and the spatial signature is demonstrably different.
    expect(warped!.sig, 'warp changes the composite signature').not.toBe(full!.sig);

    expect(errors, `no page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('per-surface FIT/CROP: identity for full-frame, both modes render for a warped box', async ({ page }) => {
    const errors = await setup(page);

    const s1 = source(1, TINT_RED, 40);
    const nodes: Node[] = [
      ...s1.nodes,
      { id: 'mappy', type: 'mappy', position: { x: 560, y: 60 }, domain: 'video' },
      { id: 'v-out', type: 'videoOut', position: { x: 900, y: 60 }, domain: 'video' },
    ];
    const edges: Edge[] = [
      ...s1.edges,
      { id: 'm1', from: { nodeId: 'chroma1', portId: 'out' }, to: { nodeId: 'mappy', portId: 'in1' }, sourceType: 'video', targetType: 'video' },
      { id: 'mo', from: { nodeId: 'mappy', portId: 'out' }, to: { nodeId: 'v-out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
    ];
    await spawnPatch(page, nodes, edges);
    await expect(page.locator('[data-testid="mappy-card"]')).toHaveCount(1);

    // INVARIANT: for a FULL-FRAME quad the homography is identity, so the
    // back-projected source uv == the texel's own output uv. FIT samples at the
    // back-projected uv, CROP at the output uv — IDENTICAL here. So toggling FIT
    // on a full-frame surface must NOT change the lit footprint (deterministic +
    // animation-tolerant: lit fraction is stable even though LINES animates).
    await setFit(page, 'mappy', 1, true);
    await page.waitForTimeout(500);
    const fitFull = await readStats(page);
    expect(fitFull, 'FIT full-frame readable').not.toBeNull();
    expect(fitFull!.nonZeroFrac, 'full-frame FIT fills the frame').toBeGreaterThan(0.5);

    await setFit(page, 'mappy', 1, false);
    await page.waitForTimeout(500);
    const cropFull = await readStats(page);
    expect(cropFull, 'CROP full-frame readable').not.toBeNull();
    // same footprint within a generous tolerance (animation jitters the exact
    // count slightly; the identity property keeps them close).
    expect(
      Math.abs(cropFull!.nonZeroFrac - fitFull!.nonZeroFrac),
      `full-frame FIT≈CROP (fit=${fitFull!.nonZeroFrac.toFixed(3)} crop=${cropFull!.nonZeroFrac.toFixed(3)})`,
    ).toBeLessThan(0.06);

    // Now WARP surface 1 to a small top-left box. Both FIT and CROP must render a
    // non-blank, structured, red-tinted composite (the CROP branch compiles +
    // runs on the real renderer; it windows the source instead of zoom-fitting).
    await warpSurface(page, 'mappy', 1, [[0.02, 0.02], [0.42, 0.02], [0.42, 0.42], [0.02, 0.42]]);
    for (const fit of [true, false]) {
      await setFit(page, 'mappy', 1, fit);
      await page.waitForTimeout(500);
      const st = await readStats(page);
      expect(st, `${fit ? 'FIT' : 'CROP'} warped readable`).not.toBeNull();
      expect(st!.nonZeroFrac, `${fit ? 'FIT' : 'CROP'} warped box is non-blank`).toBeGreaterThan(0.02);
      expect(st!.r, `${fit ? 'FIT' : 'CROP'} stays red-tinted`).toBeGreaterThan(st!.g);
    }

    expect(errors, `no page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('driving a SECOND input changes the composite (each input matters)', async ({ page }) => {
    const errors = await setup(page);

    const s1 = source(1, TINT_RED, 40);
    const s2 = source(2, TINT_GREEN, 300);
    const nodes: Node[] = [
      ...s1.nodes,
      ...s2.nodes,
      { id: 'mappy', type: 'mappy', position: { x: 560, y: 120 }, domain: 'video' },
      { id: 'v-out', type: 'videoOut', position: { x: 900, y: 120 }, domain: 'video' },
    ];
    const baseEdges: Edge[] = [
      ...s1.edges,
      ...s2.edges,
      { id: 'm1', from: { nodeId: 'chroma1', portId: 'out' }, to: { nodeId: 'mappy', portId: 'in1' }, sourceType: 'video', targetType: 'video' },
      { id: 'mo', from: { nodeId: 'mappy', portId: 'out' }, to: { nodeId: 'v-out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
    ];

    // (a) only in1 (red) connected; warp surface-2's quad to the BOTTOM half so
    //     once in2 is added it occupies a distinct region (in2 default would be
    //     full-frame and, being last in painter order, paint over in1 — we want
    //     a partial overlay so the "in2 changed something" delta is unambiguous
    //     either way).
    await spawnPatch(page, nodes, baseEdges);
    await warpSurface(page, 'mappy', 2, [[0.0, 0.5], [1.0, 0.5], [1.0, 1.0], [0.0, 1.0]]);
    await page.waitForTimeout(600);
    const before = await readStats(page);
    expect(before, 'in1-only composite readable').not.toBeNull();
    expect(before!.nonZeroFrac, 'in1 drives a non-blank composite').toBeGreaterThan(0.1);

    // (b) connect in2 (green) too → its (bottom-half) green surface paints into
    //     the composite. Green channel rises + the signature changes.
    const withIn2: Edge[] = [
      ...baseEdges,
      { id: 'm2', from: { nodeId: 'chroma2', portId: 'out' }, to: { nodeId: 'mappy', portId: 'in2' }, sourceType: 'video', targetType: 'video' },
    ];
    await spawnPatch(page, nodes, withIn2);
    await warpSurface(page, 'mappy', 2, [[0.0, 0.5], [1.0, 0.5], [1.0, 1.0], [0.0, 1.0]]);
    await page.waitForTimeout(600);
    const after = await readStats(page);
    expect(after, 'in1+in2 composite readable').not.toBeNull();

    // The composite demonstrably changed when in2 was driven.
    expect(after!.sig, 'adding in2 changes the composite signature').not.toBe(before!.sig);
    // Green clearly increases (in2 is green-tinted, occupying the bottom half).
    expect(
      after!.g,
      `in2 (green) raises the green channel (before=${before!.g.toFixed(1)} after=${after!.g.toFixed(1)})`,
    ).toBeGreaterThan(before!.g + 4);

    expect(errors, `no page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('GRIDS-FIRST: with NO inputs the output shows the calibration grid; adding a surface changes it', async ({ page }) => {
    const errors = await setup(page);

    // No source at all — just MAPPY → videoOut. The grids-first behavior must
    // render surface 1's numbered calibration grid so you can set up geometry
    // before patching any video.
    const nodes: Node[] = [
      { id: 'mappy', type: 'mappy', position: { x: 560, y: 60 }, domain: 'video' },
      { id: 'v-out', type: 'videoOut', position: { x: 900, y: 60 }, domain: 'video' },
    ];
    const edges: Edge[] = [
      { id: 'mo', from: { nodeId: 'mappy', portId: 'out' }, to: { nodeId: 'v-out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
    ];
    await spawnPatch(page, nodes, edges);
    await expect(page.locator('[data-testid="mappy-card"]')).toHaveCount(1);
    await page.waitForTimeout(600);

    // 1) the default single surface renders its grid → non-blank + structured
    //    (the checker + border + digit), with NO input connected.
    const grid1 = await readStats(page);
    expect(grid1, 'grid composite readable').not.toBeNull();
    expect(grid1!.nonZeroFrac, 'grid is NOT all-black with no inputs').toBeGreaterThan(0.3);
    expect(grid1!.variance, 'grid has spatial structure (checker)').toBeGreaterThan(15);

    // 2) warp surface 2 to a sub-rect and bump surfaceCount → a 2nd grid joins
    //    the composite → it demonstrably changes.
    await warpSurface(page, 'mappy', 2, [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]]);
    await setParams(page, 'mappy', { surfaceCount: 2 });
    await page.waitForTimeout(600);
    const grid2 = await readStats(page);
    expect(grid2, '2-grid composite readable').not.toBeNull();
    expect(grid2!.sig, 'a 2nd grid changes the composite signature').not.toBe(grid1!.sig);

    expect(errors, `no page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('MAP editor opens with a large canvas, can add a surface, and closes', async ({ page }) => {
    const errors = await setup(page);

    const nodes: Node[] = [
      { id: 'mappy', type: 'mappy', position: { x: 560, y: 60 }, domain: 'video' },
      { id: 'v-out', type: 'videoOut', position: { x: 900, y: 60 }, domain: 'video' },
    ];
    const edges: Edge[] = [
      { id: 'mo', from: { nodeId: 'mappy', portId: 'out' }, to: { nodeId: 'v-out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
    ];
    await spawnPatch(page, nodes, edges);
    await expect(page.locator('[data-testid="mappy-card"]')).toHaveCount(1);

    // open the full-window editor
    await page.locator('[data-testid="mappy-open-editor"]').click();
    await expect(page.locator('[data-testid="mappy-editor"]')).toBeVisible();
    await expect(page.locator('[data-testid="mappy-editor-canvas"]')).toHaveCount(1);
    // one surface to start → tab 1 present, tab 2 absent
    await expect(page.locator('[data-testid="mappy-editor-tab-1"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="mappy-editor-tab-2"]')).toHaveCount(0);

    // add a surface → tab 2 appears
    await page.locator('[data-testid="mappy-editor-add"]').click();
    await expect(page.locator('[data-testid="mappy-editor-tab-2"]')).toHaveCount(1);

    // close
    await page.locator('[data-testid="mappy-editor-close"]').click();
    await expect(page.locator('[data-testid="mappy-editor"]')).toHaveCount(0);

    expect(errors, `no page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('a surface renders INSIDE its bounding box, in the right place (Y-orientation guard)', async ({ page }) => {
    const errors = await setup(page);

    // No inputs → grids-first shows surface 1's calibration grid. Confine it to
    // the VISUAL TOP-LEFT quadrant and assert every lit pixel lands there. This
    // is deterministic + renderer-tolerant (counts pixels, not glyphs) and is the
    // regression guard for the y-down/y-up flip that put the grid in the wrong
    // half. Corners are in the engine's y-UP uv space (v=1 = canvas top), so the
    // visual top-left quad uses HIGH v.
    const nodes: Node[] = [
      { id: 'mappy', type: 'mappy', position: { x: 560, y: 60 }, domain: 'video' },
      { id: 'v-out', type: 'videoOut', position: { x: 900, y: 60 }, domain: 'video' },
    ];
    const edges: Edge[] = [
      { id: 'mo', from: { nodeId: 'mappy', portId: 'out' }, to: { nodeId: 'v-out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
    ];
    await spawnPatch(page, nodes, edges);
    await expect(page.locator('[data-testid="mappy-card"]')).toHaveCount(1);

    // surface 1 → visual top-left quadrant: x∈[0.05,0.5], visual-y∈[0.05,0.5]
    // (v∈[0.5,0.95], v high = top).
    await warpSurface(page, 'mappy', 1, [[0.05, 0.95], [0.5, 0.95], [0.5, 0.5], [0.05, 0.5]]);
    await page.waitForTimeout(600);

    const b = await page.locator('canvas[data-testid="video-out-canvas"]').evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      const { width: w, height: h } = c;
      const data = ctx.getImageData(0, 0, w, h).data;
      let minX = 1, maxX = 0, minY = 1, maxY = 0, lit = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const v = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
          if (v > 24) {
            lit++;
            const fx = x / w, fy = y / h;
            if (fx < minX) minX = fx;
            if (fx > maxX) maxX = fx;
            if (fy < minY) minY = fy;
            if (fy > maxY) maxY = fy;
          }
        }
      }
      return { minX, maxX, minY, maxY, litFrac: lit / (w * h) };
    });
    expect(b, 'bbox readable').not.toBeNull();
    // the grid is actually drawn (its bright border lights a decent area)
    expect(b!.litFrac, 'the grid lit something').toBeGreaterThan(0.02);
    // …and EVERY lit pixel is within the top-left quadrant (+ a small AA margin).
    // The Y-orientation guard: maxY must stay in the TOP half — a y-flip would
    // push the grid to the bottom (maxY → ~0.95) and fail here.
    const M = 0.06;
    expect(b!.minX, `left edge inside (minX=${b!.minX.toFixed(3)})`).toBeGreaterThan(0.05 - M);
    expect(b!.maxX, `right edge inside (maxX=${b!.maxX.toFixed(3)})`).toBeLessThan(0.5 + M);
    expect(b!.minY, `top edge inside (minY=${b!.minY.toFixed(3)})`).toBeGreaterThan(0.05 - M);
    expect(b!.maxY, `bottom edge inside — NOT flipped to lower half (maxY=${b!.maxY.toFixed(3)})`).toBeLessThan(0.5 + M);
    // …and it fills toward the far (bottom-right) corner of its box (so it's a
    // real quad, not a sliver): the lit region reaches near x=0.5 and y=0.5.
    expect(b!.maxX, 'fills toward right edge').toBeGreaterThan(0.4);
    expect(b!.maxY, 'fills toward box bottom').toBeGreaterThan(0.4);

    expect(errors, `no page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('card: the rendered grid sits INSIDE its corner-handle box (overlay ↔ render)', async ({ page }) => {
    // The actual y-flip bug was the OVERLAY handles not matching the render. This
    // reads the 4 corner-handle screen positions AND the lit grid bbox from the
    // card preview and asserts they coincide — i.e. the grid is 100% inside the
    // box the handles draw (the user's invariant).
    const errors = await setup(page);
    const nodes: Node[] = [
      { id: 'mappy', type: 'mappy', position: { x: 560, y: 60 }, domain: 'video' },
    ];
    await spawnPatch(page, nodes, []);
    await expect(page.locator('[data-testid="mappy-card"]')).toHaveCount(1);

    // a clearly-off-centre quad so a flip/offset would be unmissable
    await warpSurface(page, 'mappy', 1, [[0.1, 0.9], [0.6, 0.9], [0.6, 0.45], [0.1, 0.45]]);
    await page.waitForTimeout(500);

    const canvasBox = await page.locator('[data-testid="mappy-canvas"]').boundingBox();
    expect(canvasBox, 'card preview canvas present').not.toBeNull();
    // handle-box in canvas-fractional coords (from the 4 SVG handle centres)
    let hMinX = 1, hMaxX = 0, hMinY = 1, hMaxY = 0;
    for (let i = 0; i < 4; i++) {
      const hb = await page.locator(`[data-testid="mappy-handle-1-${i}"]`).boundingBox();
      expect(hb, `handle ${i} present`).not.toBeNull();
      const fx = (hb!.x + hb!.width / 2 - canvasBox!.x) / canvasBox!.width;
      const fy = (hb!.y + hb!.height / 2 - canvasBox!.y) / canvasBox!.height;
      hMinX = Math.min(hMinX, fx); hMaxX = Math.max(hMaxX, fx);
      hMinY = Math.min(hMinY, fy); hMaxY = Math.max(hMaxY, fy);
    }
    // rendered grid bbox from the card preview pixels
    const r = await page.locator('[data-testid="mappy-canvas"]').evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      const { width: w, height: h } = c;
      const data = ctx.getImageData(0, 0, w, h).data;
      let minX = 1, maxX = 0, minY = 1, maxY = 0, lit = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          if ((data[i]! + data[i + 1]! + data[i + 2]!) / 3 > 24) {
            lit++;
            const fx = x / w, fy = y / h;
            if (fx < minX) minX = fx; if (fx > maxX) maxX = fx;
            if (fy < minY) minY = fy; if (fy > maxY) maxY = fy;
          }
        }
      }
      return { minX, maxX, minY, maxY, litFrac: lit / (w * h) };
    });
    expect(r, 'preview readable').not.toBeNull();
    expect(r!.litFrac, 'grid is drawn in the preview').toBeGreaterThan(0.02);
    // the rendered grid must fall within the handle box (+ AA/handle-radius slack)
    const M = 0.08;
    expect(r!.minX, `grid left ≥ box left (grid ${r!.minX.toFixed(2)} vs box ${hMinX.toFixed(2)})`).toBeGreaterThan(hMinX - M);
    expect(r!.maxX, `grid right ≤ box right (grid ${r!.maxX.toFixed(2)} vs box ${hMaxX.toFixed(2)})`).toBeLessThan(hMaxX + M);
    expect(r!.minY, `grid top ≥ box top (grid ${r!.minY.toFixed(2)} vs box ${hMinY.toFixed(2)})`).toBeGreaterThan(hMinY - M);
    expect(r!.maxY, `grid bottom ≤ box bottom — NOT y-flipped (grid ${r!.maxY.toFixed(2)} vs box ${hMaxY.toFixed(2)})`).toBeLessThan(hMaxY + M);

    expect(errors, `no page errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
