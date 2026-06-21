// e2e/tests/toybox-node-batch.spec.ts
//
// TOYBOX batch op nodes (12 new combine ops) — COMPREHENSIVE end-to-end:
//   OVER · TILE · MIRROR · DISPLACE · BITBEND · BIOCELLS · EXQUISITE ·
//   FRAMEDELAY · CHANNELDESYNC · FLOWSMEAR · DREAMMELT · DATAMOSH
// plus the resizable node-graph view.
//
// For EACH op:
//   (a) it appears in the ADD row + the right-click "Add node" submenu (these
//       are auto-generated from OP_KINDS, so a correct registry wiring passes
//       for free + breaks loudly if it didn't),
//   (b) it RENDERS non-black when wired src → op → OUTPUT,
//   (c) it VISIBLY AFFECTS OUTPUT — the composite differs from the bypass
//       baseline (layer-0-only),
//   (d) its params are CV-TARGETABLE + respond (a cv route writes the live param).
// Multi-input ops additionally exercise EACH input (swapping which layer feeds
// in0/in1 changes the composite). The resizable view test asserts the graph
// panel resizes + the size persists in node.data.combineView.
//
// Determinism + CI: we pin iTime via __toyboxFreeze and read the on-card preview
// canvas average (the same canvas the VRT freezes) for stable numeric deltas, not
// flaky pixel diffs. The stateful ops (framedelay/…/datamosh) need a few
// converging frames, so we advance the freeze a handful of steps. Budgets are
// scaled by the per-op render count (CI's SwiftShader starves the main thread —
// see repo memory ci-swiftshader-video-e2e-timeouts), NOT a flat value.
//
// BATCH-per-boot (webgl-suite-optimization §2): the render/output-delta proofs
// (b)+(c) are GROUPED so multiple ops share ONE module boot (the dominant cost is
// goto+spawn+GL-warm, not the assertion) — see RENDER_BATCHES below. Each batched
// test asserts PER-ID (a loop of per-id expect()s with the op id in every failure
// message) so a single bad op cannot hide behind a green aggregate (§6 risk).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch, ensureCombineOpen } from './_helpers';

type GNode = { id: string; kind: string; layer?: number; x: number; y: number; params?: Record<string, number> };
type GEdge = { id: string; from: string; to: string; toPort: string };
type PatchGlobal = {
  __patch: {
    nodes: Record<
      string,
      {
        data?: {
          combine?: { nodes?: GNode[]; edges?: GEdge[] };
          layers?: unknown[];
          cvRoutes?: Record<string, unknown>;
          combineView?: { h?: number };
        };
      }
    >;
    edges: Record<string, unknown>;
  };
  __ydoc: { transact: (fn: () => void) => void };
  __toyboxFreeze?: (t?: number) => void;
  __engine?: () => { getDomain: (d: string) => { setParam: (id: string, port: string, v: number) => void } };
};

const CANVAS = '[data-testid="toybox-canvas"]';

/** Pin the Svelte Flow viewport so the card body is in the visible region. */
async function pinViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const vp = document.querySelector('.svelte-flow__viewport') as HTMLElement | null;
    if (!vp) return;
    vp.style.transition = 'none';
    vp.style.transform = 'translate(8px, -24px) scale(1)';
  });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

/** The 4 source nodes (one per layer) + an OUTPUT, the common scaffold. */
function sources(): GNode[] {
  return [
    { id: 'src0', kind: 'source', layer: 0, x: 14, y: 14 },
    { id: 'src1', kind: 'source', layer: 1, x: 14, y: 66 },
    { id: 'src2', kind: 'source', layer: 2, x: 14, y: 118 },
    { id: 'src3', kind: 'source', layer: 3, x: 14, y: 170 },
  ];
}

/** Two DISTINCT bright layers so a reroute/blend is visible; layers 2/3 too so
 *  the 4-input EXQUISITE has 4 distinct feeds. */
function fourLayers(): unknown[] {
  return [
    { kind: 'gen', contentId: 'noise-fbm', params: {} },
    { kind: 'gen', contentId: 'worley-cells', params: {} },
    { kind: 'gen', contentId: 'noise-fbm', params: {} },
    { kind: 'gen', contentId: 'worley-cells', params: {} },
  ] as unknown[];
}

/** Seed a precise combine graph + layers straight into node.data (the editor
 *  edits the same live shape; the data path is the stable way to set up a graph
 *  for a render assertion). */
async function seed(page: Page, nodes: GNode[], edges: GEdge[], cvRoutes?: Record<string, unknown>): Promise<void> {
  await page.evaluate(
    ({ nodes, edges, cvRoutes, layers }) => {
      const w = globalThis as unknown as PatchGlobal;
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['tb'];
        if (!n) return;
        if (!n.data) n.data = {};
        n.data.layers = layers;
        n.data.combine = { nodes, edges } as { nodes: GNode[]; edges: GEdge[] };
        if (cvRoutes) n.data.cvRoutes = cvRoutes;
      });
    },
    { nodes, edges, cvRoutes, layers: fourLayers() },
  );
}

/** Wait until the on-card canvas is sized + has produced a lit frame at `time`. */
async function freezeUntilLit(page: Page, time: number): Promise<void> {
  await page.waitForFunction(
    ({ time }) => {
      const g = globalThis as unknown as PatchGlobal;
      g.__toyboxFreeze?.(time);
      const c = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement | null;
      if (!c || c.width === 0) return false;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return false;
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      let lit = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i]! > 16 || data[i + 1]! > 16 || data[i + 2]! > 16) lit++;
      }
      return lit > c.width * c.height * 0.05;
    },
    { time },
    { timeout: 30_000 },
  );
}

/** Advance the freeze N frames at a constant iTime (for the stateful ops). */
async function advance(page: Page, time: number, steps: number): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await page.evaluate(({ time }) => (globalThis as unknown as PatchGlobal).__toyboxFreeze?.(time), { time });
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  }
}

/** Advance frames at a MONOTONICALLY INCREASING iTime until the canvas is lit,
 *  capturing the average + signature WHILE the clock is still moving. Some
 *  stateful ops are MOTION-driven — DATAMOSH estimates optical flow from the
 *  frame-to-frame luma DIFF, so with a constant pinned iTime its motion is ~0,
 *  its HOLD gate latches, and the visible output stays the (initially empty →
 *  black) advected ring forever → a constant-iTime freezeUntilLit times out, and
 *  re-pinning a constant after a moving warm-up lets it decay back to black
 *  before the read. So we keep the clock moving and capture mid-motion. Returns
 *  { avg, sig } captured on the last lit moving frame. */
async function captureMoving(
  page: Page,
  startTime: number,
  steps: number,
): Promise<{ avg: [number, number, number]; sig: number[] }> {
  const dt = 0.1;
  // Warm up enough frames for the ring to converge + the motion to register.
  for (let i = 0; i < steps; i++) {
    const t = startTime + i * dt;
    await page.evaluate(({ t }) => (globalThis as unknown as PatchGlobal).__toyboxFreeze?.(t), { t });
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  }
  // Keep stepping until lit (bounded), then capture on the SAME moving frame.
  let t = startTime + steps * dt;
  for (let tries = 0; tries < 120; tries++) {
    await page.evaluate(({ t }) => (globalThis as unknown as PatchGlobal).__toyboxFreeze?.(t), { t });
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    const lit = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement | null;
      if (!c || c.width === 0) return false;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return false;
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      let n = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i]! > 16 || data[i + 1]! > 16 || data[i + 2]! > 16) n++;
      }
      return n > c.width * c.height * 0.05;
    });
    if (lit) {
      const avg = await average(page);
      const sig = await signature(page);
      return { avg, sig };
    }
    t += dt;
  }
  throw new Error('captureMoving: canvas never reached a lit frame');
}

/** VIVID, fast-compiling, strongly-distinct layers so a band/feed reroute moves
 *  the average UNMISTAKABLY (noise-fbm/worley render near the idle grey, which
 *  is too subtle to assert a feed change on). src0/src3 = synthwave (purple),
 *  src1/src2 = star-field (near-black w/ bright dots). */
function vividLayers(): unknown[] {
  return [
    { kind: 'gen', contentId: 'synthwave-sunset', params: {} },
    { kind: 'gen', contentId: 'star-field', params: {} },
    { kind: 'gen', contentId: 'star-field', params: {} },
    { kind: 'gen', contentId: 'synthwave-sunset', params: {} },
  ] as unknown[];
}

/** Seed a graph with VIVID layers (above), bypassing the grey default content. */
async function seedVivid(page: Page, nodes: GNode[], edges: GEdge[]): Promise<void> {
  await page.evaluate(
    ({ nodes, edges, layers }) => {
      const w = globalThis as unknown as PatchGlobal;
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['tb'];
        if (!n) return;
        if (!n.data) n.data = {};
        n.data.layers = layers as unknown[];
        n.data.combine = { nodes, edges } as { nodes: GNode[]; edges: GEdge[] };
      });
    },
    { nodes, edges, layers: vividLayers() },
  );
}

/** Wait until the LIVE preview is non-idle (gen content has actually compiled,
 *  not the dark-teal idle pattern ~[124,84,64]) AND stable across two reads,
 *  THEN pin the freeze. freezeUntilLit alone can lock onto the idle frame before
 *  async content compiles, which then reads as "no change" between graphs. */
async function settleFreeze(page: Page, time: number): Promise<void> {
  let prev: [number, number, number] = [-9, -9, -9];
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(200);
    const a = await average(page);
    // stable (≈prev) + clearly off the idle grey red-channel (~124).
    if (Math.abs(a[0] - prev[0]) < 3 && Math.abs(a[0] - 124) > 8) break;
    prev = a;
  }
  await page.evaluate(({ time }) => (globalThis as unknown as PatchGlobal).__toyboxFreeze?.(time), { time });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

/** Average RGB of the on-card preview canvas. */
async function average(page: Page): Promise<[number, number, number]> {
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) { r += data[i]!; g += data[i + 1]!; b += data[i + 2]!; n++; }
    return [r / n, g / n, b / n] as [number, number, number];
  });
}

/** A COARSE per-cell signature of the canvas (an SxS grid of average RGB). Used
 *  for the "output changed" delta so SPATIAL-rearrangement ops (tile/mirror/
 *  displace/flowsmear) — which barely move the GLOBAL average but heavily move
 *  the LAYOUT — register a measurable change. */
async function signature(page: Page, S = 6): Promise<number[]> {
  return page.evaluate((S) => {
    const c = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
    const sig: number[] = [];
    for (let gy = 0; gy < S; gy++) {
      for (let gx = 0; gx < S; gx++) {
        let r = 0, g = 0, b = 0, n = 0;
        const x0 = Math.floor((gx * width) / S), x1 = Math.floor(((gx + 1) * width) / S);
        const y0 = Math.floor((gy * height) / S), y1 = Math.floor(((gy + 1) * height) / S);
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * width + x) * 4;
            r += data[i]!; g += data[i + 1]!; b += data[i + 2]!; n++;
          }
        }
        sig.push(r / n, g / n, b / n);
      }
    }
    return sig;
  }, S);
}

function dist(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
/** Mean absolute per-cell difference between two signatures. */
function sigDist(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s / a.length;
}
function lum(a: [number, number, number]): number { return a[0] + a[1] + a[2]; }

/** A bypass baseline: layer 0 straight to OUTPUT (no op). */
function bypassGraph(): { nodes: GNode[]; edges: GEdge[] } {
  return {
    nodes: [...sources(), { id: 'out', kind: 'output', x: 286, y: 66 }],
    edges: [{ id: 'e_b', from: 'src0', to: 'out', toPort: 'in0' }],
  };
}

/** A graph wiring `wires[i]` → the op's in{i} → OUTPUT. Defaults to src0..src3. */
function opGraph(
  kind: string,
  ports: number,
  params: Record<string, number> = {},
  wires: string[] = ['src0', 'src1', 'src2', 'src3'],
): { nodes: GNode[]; edges: GEdge[] } {
  const op: GNode = { id: 'op', kind, x: 120, y: 14, params };
  const out: GNode = { id: 'out', kind: 'output', x: 286, y: 66 };
  const edges: GEdge[] = [{ id: 'e_op_out', from: 'op', to: 'out', toPort: 'in0' }];
  for (let i = 0; i < ports; i++) {
    edges.push({ id: `e_in${i}`, from: wires[i]!, to: 'op', toPort: `in${i}` });
  }
  return { nodes: [...sources(), op, out], edges };
}

/** Each op + its port count + a params override that makes the effect visible.
 *  `wires` overrides which sources feed in0..inN (default src0..src3). The
 *  delay-line ops (framedelay) are an IDENTITY on a static frozen input, so we
 *  feed them a DIFFERENT layer (src1 = worley) than the src0 (noise) bypass to
 *  prove they pass content through + are wired. */
const OPS: Array<{ kind: string; ports: number; params: Record<string, number>; steps: number; wires?: string[]; moving?: boolean; vivid?: boolean }> = [
  { kind: 'over', ports: 2, params: { amount: 0.7 }, steps: 1 },
  { kind: 'tile', ports: 1, params: { tilesX: 3, tilesY: 3 }, steps: 1 },
  { kind: 'mirror', ports: 1, params: { mode: 3, segments: 6 }, steps: 1 },
  { kind: 'displace', ports: 2, params: { amount: 0.3, channel: 1 }, steps: 1 },
  { kind: 'bitbend', ports: 1, params: { op: 0, mask: 170 }, steps: 1 },
  { kind: 'biocells', ports: 1, params: { cellCount: 16, edgeWidth: 0.4 }, steps: 1 },
  { kind: 'exquisite', ports: 4, params: { bands: 4 }, steps: 1 },
  { kind: 'framedelay', ports: 1, params: { delay: 4, mix: 0.7 }, steps: 8, wires: ['src1'] },
  { kind: 'channeldesync', ports: 1, params: { gDelay: 5, bDelay: 10, offsetMag: 0.12 }, steps: 12 },
  { kind: 'flowsmear', ports: 1, params: { flowStrength: 0.9, noiseScale: 4, persistence: 0.9 }, steps: 12 },
  // dreammelt melts in0 -> in1; with the near-grey default layers the blend
  // delta is subtle (~1.7 vs the >2 bar). Feed VIVID, strongly-distinct layers
  // (synthwave purple vs star-field) — the same ones its bespoke tests below use
  // — so the in0->in1 dissolve is unmistakable.
  { kind: 'dreammelt', ports: 2, params: { meltAmount: 0.9, dripSpeed: 0.8 }, steps: 12, vivid: true },
  // datamosh estimates optical flow from the frame-to-frame luma DIFF, so it
  // needs a MOVING clock (a constant pinned iTime leaves motion ~0, its HOLD gate
  // latches, and the visible output is the empty advected ring → black).
  { kind: 'datamosh', ports: 1, params: { flowScale: 0.7, decay: 0.9 }, steps: 10, moving: true },
];

test.describe('TOYBOX batch op nodes — registry + menu', () => {
  test('every new op appears in the ADD row + the right-click Add submenu', async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }], []);
    await page.locator('.svelte-flow__node-toybox').first().waitFor({ state: 'visible', timeout: 10_000 });
    await pinViewport(page);
    await ensureCombineOpen(page);

    // (a) ADD-row buttons (auto-generated from OP_KINDS).
    for (const { kind } of OPS) {
      await expect(
        page.locator(`[data-testid="toybox-add-${kind}"]`),
        `ADD button for ${kind}`,
      ).toBeVisible();
    }

    // Clicking an ADD button inserts a node of that kind into node.data.combine.
    // dispatchEvent('click') (not force-click): under the serialized real-GPU
    // webgl-attest load a coordinate force-click on this combine-panel button
    // intermittently fails to deliver → the node never inserts → the poll below
    // times out (attest flake, task #151 — same as node-controls/menu/combine).
    await page.locator('[data-testid="toybox-add-datamosh"]').dispatchEvent('click');
    await expect
      .poll(() => page.evaluate(() => {
        const w = globalThis as unknown as PatchGlobal;
        return (w.__patch.nodes['tb']?.data?.combine?.nodes ?? []).some((n) => n.kind === 'datamosh');
      }), { timeout: 15_000, intervals: [200, 400, 800] })
      .toBe(true);

    // (a') Right-click the graph SVG → the Add submenu lists every op kind. Done
    // LAST so the (possibly modal) node menu doesn't intercept the ADD click above.
    // Right-click stays a coordinate force-click: the graph-SVG contextmenu
    // handler reads the event's clientX/Y to place the menu, so a coordinate-less
    // dispatchEvent('contextmenu') makes it set a non-finite SVGPoint. This block
    // is best-effort (guarded by isVisible + .catch), so a missed right-click
    // can't fail the test — unlike the ADD-button click above, which gates a poll.
    await page.locator('[data-testid="toybox-graph-svg"]').click({ button: 'right', force: true, noWaitAfter: true });
    const addMenu = page.locator('[data-testid="toybox-menu-add"]');
    if (await addMenu.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await addMenu.hover().catch(() => {});
      await addMenu.click({ noWaitAfter: true }).catch(() => {});
      for (const { kind } of OPS) {
        await expect(
          page.locator(`[data-testid="toybox-menu-add-${kind}"]`),
          `Add-submenu item for ${kind}`,
        ).toBeVisible({ timeout: 5_000 });
      }
    }

    expect(errors.filter((e) => !e.includes('AudioContext'))).toEqual([]);
  });
});

type Op = (typeof OPS)[number];

/** Within an ALREADY-BOOTED toybox page, render the bypass baseline then `op`'s
 *  composite (fresh graph seeds reset any stateful ring between ops, so multiple
 *  ops share ONE boot safely) and return the captures the assertions check. The
 *  moving/vivid branch logic is identical to the former per-op test — only the
 *  page boot moved out of the loop. */
async function captureOp(
  page: Page,
  { kind, ports, params, steps, wires, moving, vivid }: Op,
): Promise<{ withOpAvg: [number, number, number]; withOpSig: number[]; bypassSig: number[] }> {
  // Motion-driven ops (datamosh) use VIVID, strongly-distinct layers
  // (synthwave/star-field) so the op has enough luma-gradient signal to mosh
  // (grey noise-fbm gives it nothing to advect → a black frame), and a MOVING
  // clock (it estimates optical flow from the frame-to-frame luma diff — a
  // constant pinned iTime leaves its HOLD gate latched on the empty advected ring
  // → black). The rest use the standard grey layers + constant-iTime freeze.
  if (moving) {
    await seedVivid(page, bypassGraph().nodes, bypassGraph().edges);
    const bypassCap = await captureMoving(page, 2.0, steps);
    const g = opGraph(kind, ports, params, wires);
    await seedVivid(page, g.nodes, g.edges);
    const cap = await captureMoving(page, 2.0, steps);
    return { withOpAvg: cap.avg, withOpSig: cap.sig, bypassSig: bypassCap.sig };
  }
  const seedFn = vivid ? seedVivid : seed;
  await seedFn(page, bypassGraph().nodes, bypassGraph().edges);
  await freezeUntilLit(page, 2.0);
  const bypassSig = await signature(page);
  const g = opGraph(kind, ports, params, wires);
  await seedFn(page, g.nodes, g.edges);
  await freezeUntilLit(page, 2.0);
  await advance(page, 2.0, steps);
  return { withOpAvg: await average(page), withOpSig: await signature(page), bypassSig };
}

// BATCH-per-boot (webgl-suite-optimization §2): the per-op render/output-delta
// proofs used to pay a FULL fresh module boot (goto + spawn + GL warm, ~the whole
// cost) PER op — 12 boots. They are now grouped so MULTIPLE ops share one boot,
// the largest single lane wall-time win. Per the §6 risk note ("BATCH-per-boot
// can mask a per-id failure"), each batched test ASSERTS PER-ID — it loops the
// ops, runs per-id expect()s with the op id in every failure message, so one bad
// op can't hide behind a green aggregate. Batches keep similar handling together
// to bound each boot's wall-time: the cheap steps=1 ops in one boot, the stateful
// constant-clock ops in another, the moving-clock datamosh in its own (priciest).
//
// LEANED for the serialized real-GPU webgl-attest lane (fix/lean-webgl-attest):
// the render+output-delta proof used to iterate ALL 13 ops (with several stateful
// ops doing 8-12 converge frames each) = the heaviest serial GL burst in the
// toybox suite, which flaked/retried on the lane's single real-GPU context. We
// now render a REPRESENTATIVE op PER SHAPE that proves the render+delta path:
//   • a simple compositing blend (over),
//   • a spatial-rearrange op whose global avg barely moves but layout does (tile),
//   • a stateful constant-clock op (channeldesync),
//   • the moving-clock optical-flow op (datamosh, the priciest).
// EVERY op is still proven WIRED + menu-registered by the (DOM-only, cheap)
// registry+menu test above, which iterates the full OPS list; and each op's
// combine MATH/topology + CV targeting is unit-owned (toybox-combine-graph.test.ts
// / toybox.test.ts). So the per-shape representatives keep the e2e's unique
// "compiles + draws + visibly transforms through the real engine" claim while
// cutting the heavy converge work ~3×. Set FULL_TOYBOX_CONTENT=1 to render the
// FULL op set (use locally on a real GPU when validating a new combine-op batch).
const RENDER_FULL = process.env.FULL_TOYBOX_CONTENT === '1';
const REP_RENDER_KINDS = new Set(['over', 'tile', 'channeldesync', 'datamosh']);
const renderOps = (pred: (o: Op) => boolean): Op[] =>
  OPS.filter((o) => pred(o) && (RENDER_FULL || REP_RENDER_KINDS.has(o.kind)));
const RENDER_BATCHES: Array<{ name: string; ops: Op[] }> = [
  {
    name: 'simple single-step ops',
    ops: renderOps((o) => o.steps === 1 && !o.moving && !o.vivid),
  },
  {
    name: 'stateful constant-clock ops',
    ops: renderOps((o) => o.steps > 1 && !o.moving),
  },
  {
    name: 'moving-clock ops',
    ops: renderOps((o) => !!o.moving),
  },
].filter((b) => b.ops.length > 0);

test.describe('TOYBOX batch op nodes — render + output delta', () => {
  for (const batch of RENDER_BATCHES) {
    test(`${batch.name} render non-black + visibly affect the output`, async ({ page }) => {
      // Budget = a single boot + Σ(per-op converge cost). Base 60s for the boot,
      // + 4s/step × 2 captures per op (stateful ops need several frames each on
      // SwiftShader), summed over the ops sharing this boot.
      const stepBudget = batch.ops.reduce((s, o) => s + o.steps, 0);
      test.setTimeout(60_000 + stepBudget * 8_000);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

      // ONE boot for the whole batch.
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await spawnPatch(page, [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }], []);
      await page.locator('.svelte-flow__node-toybox').first().waitFor({ state: 'visible', timeout: 10_000 });
      await pinViewport(page);

      // PER-ID assertions (a bad op can't hide in the shared boot).
      for (const op of batch.ops) {
        const { withOpAvg, withOpSig, bypassSig } = await captureOp(page, op);
        // (b) RENDERS: the op's composite is non-black.
        expect(lum(withOpAvg), `${op.kind} composite is non-black`).toBeGreaterThan(15);
        // (c) VISIBLY AFFECTS OUTPUT: the per-cell layout differs from the bypass
        //     baseline (a coarse-grid signature catches spatial ops whose GLOBAL
        //     average is nearly unchanged, e.g. tile/mirror/displace/flowsmear).
        expect(
          sigDist(bypassSig, withOpSig),
          `${op.kind} changes the live output vs bypass`,
        ).toBeGreaterThan(2);
      }

      expect(errors.filter((e) => !e.includes('AudioContext'))).toEqual([]);
    });
  }
});

test.describe('TOYBOX batch op nodes — multi-input exercise', () => {
  // For the 2-input ops, swapping which layer feeds in0 vs in1 must change the
  // composite (proves BOTH inputs are read, not just in0).
  //
  // LEANED for the real-GPU lane: each kind here pays its OWN module boot + two
  // converged captures. We keep a REPRESENTATIVE pair — `over` (the simple,
  // single-step blend) + `dreammelt` (the stateful melt, the more demanding
  // both-inputs-read proof) — which covers both the cheap and stateful 2-input
  // shapes. `displace` (a single-step 2-input op like `over`) is dropped from the
  // lane: its specific in0/in1 displacement math is unit-owned
  // (toybox-combine-graph.test.ts), and its render+delta is still proven by the
  // representative render batch above. FULL_TOYBOX_CONTENT=1 restores all three.
  const MULTI_KINDS = process.env.FULL_TOYBOX_CONTENT === '1'
    ? ['over', 'displace', 'dreammelt']
    : ['over', 'dreammelt'];
  for (const kind of MULTI_KINDS) {
    test(`${kind}: each input is exercised (swap in0/in1 changes output)`, async ({ page }) => {
      test.setTimeout(180_000);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await spawnPatch(page, [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }], []);
      await page.locator('.svelte-flow__node-toybox').first().waitFor({ state: 'visible', timeout: 10_000 });
      await pinViewport(page);

      const params = kind === 'over' ? { amount: 0.6 }
        : kind === 'displace' ? { amount: 0.35, channel: 1 }
        : { meltAmount: 0.8, dripSpeed: 0.6 };
      const steps = kind === 'dreammelt' ? 10 : 1;
      const out: GNode = { id: 'out', kind: 'output', x: 286, y: 66 };
      const op = (p: Record<string, number>): GNode => ({ id: 'op', kind, x: 120, y: 14, params: p });

      // src0 → in0, src1 → in1.
      await seed(page, [...sources(), op(params), out], [
        { id: 'e0', from: 'src0', to: 'op', toPort: 'in0' },
        { id: 'e1', from: 'src1', to: 'op', toPort: 'in1' },
        { id: 'eo', from: 'op', to: 'out', toPort: 'in0' },
      ]);
      await freezeUntilLit(page, 2.0);
      await advance(page, 2.0, steps);
      const ab = await average(page);

      // swap: src1 → in0, src0 → in1 (fresh graph so stateful buffers reset).
      await seed(page, [...sources(), op(params), out], [
        { id: 'e0', from: 'src1', to: 'op', toPort: 'in0' },
        { id: 'e1', from: 'src0', to: 'op', toPort: 'in1' },
        { id: 'eo', from: 'op', to: 'out', toPort: 'in0' },
      ]);
      await freezeUntilLit(page, 2.0);
      await advance(page, 2.0, steps);
      const ba = await average(page);

      expect(dist(ab, ba), `${kind} reads BOTH inputs (swap changes output)`).toBeGreaterThan(3);
      expect(errors.filter((e) => !e.includes('AudioContext'))).toEqual([]);
    });
  }

  test('exquisite: wiring a 3rd input changes the composite (multi-feed)', async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }], []);
    await page.locator('.svelte-flow__node-toybox').first().waitFor({ state: 'visible', timeout: 10_000 });
    await pinViewport(page);

    const out: GNode = { id: 'out', kind: 'output', x: 286, y: 66 };
    const op: GNode = { id: 'op', kind: 'exquisite', x: 120, y: 14, params: { bands: 4, seamBlend: 0 } };

    // 2 inputs.
    await seed(page, [...sources(), op, out], [
      { id: 'e0', from: 'src0', to: 'op', toPort: 'in0' },
      { id: 'e1', from: 'src1', to: 'op', toPort: 'in1' },
      { id: 'eo', from: 'op', to: 'out', toPort: 'in0' },
    ]);
    await freezeUntilLit(page, 2.0);
    const two = await average(page);

    // add a 3rd, distinct input → band assignment changes → composite changes.
    await seed(page, [...sources(), op, out], [
      { id: 'e0', from: 'src0', to: 'op', toPort: 'in0' },
      { id: 'e1', from: 'src1', to: 'op', toPort: 'in1' },
      { id: 'e2', from: 'src2', to: 'op', toPort: 'in2' },
      { id: 'eo', from: 'op', to: 'out', toPort: 'in0' },
    ]);
    await freezeUntilLit(page, 2.0);
    const three = await average(page);

    expect(dist(two, three), 'exquisite reads the 3rd input').toBeGreaterThan(2);
    expect(errors.filter((e) => !e.includes('AudioContext'))).toEqual([]);
  });

  // ── Audit M1: EXQUISITE must show NON-CONTIGUOUSLY wired feeds. Wiring in0+in2
  //    (in1 empty) used to drop in2 entirely (the count-space idx 1 hit the empty
  //    in1 → fell back to in0); in3-only used to render solid black (idx 0 hit the
  //    unbound in0 dummy). The wiredSlot() mapping fixes both.
  test('exquisite: shows non-contiguously wired feeds (in0+in2 ≠ in0-only; in3-only not black)', async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }], []);
    await page.locator('.svelte-flow__node-toybox').first().waitFor({ state: 'visible', timeout: 10_000 });
    await pinViewport(page);

    const out: GNode = { id: 'out', kind: 'output', x: 286, y: 66 };
    const op: GNode = { id: 'op', kind: 'exquisite', x: 120, y: 14, params: { bands: 4, seamBlend: 0 } };

    // VIVID, distinct layers (src0/src3 = synthwave purple, src2 = star-field):
    // a band reroute moves the average UNMISTAKABLY. settleFreeze waits for the
    // gen content to compile (not the idle frame) before pinning the freeze.

    // in0 ONLY (baseline).
    await seedVivid(page, [...sources(), op, out], [
      { id: 'e0', from: 'src0', to: 'op', toPort: 'in0' },
      { id: 'eo', from: 'op', to: 'out', toPort: 'in0' },
    ]);
    await settleFreeze(page, 2.0);
    const in0only = await average(page);

    // in0 + in2 (in1 EMPTY — the non-contiguous gap). src2 = star-field, very
    // distinct from src0 = synthwave, so half the bands must now show star-field
    // → the composite moves a LOT. Pre-fix: idx 1 hit empty in1 → fell back to
    // in0 → no change (the M1 bug).
    await seedVivid(page, [...sources(), op, out], [
      { id: 'e0', from: 'src0', to: 'op', toPort: 'in0' },
      { id: 'e2', from: 'src2', to: 'op', toPort: 'in2' },
      { id: 'eo', from: 'op', to: 'out', toPort: 'in0' },
    ]);
    await settleFreeze(page, 2.0);
    const in0in2 = await average(page);
    expect(dist(in0only, in0in2), 'in0+in2 shows in2 (≠ in0-only)').toBeGreaterThan(15);

    // in3 ONLY (in0/in1/in2 empty). Must NOT be solid black (pre-fix idx 0 hit
    // the unbound in0 dummy → black). wiredSlot maps slot 0 → in3.
    await seedVivid(page, [...sources(), op, out], [
      { id: 'e3', from: 'src3', to: 'op', toPort: 'in3' },
      { id: 'eo', from: 'op', to: 'out', toPort: 'in0' },
    ]);
    await settleFreeze(page, 2.0);
    const in3only = await average(page);
    expect(lum(in3only), 'in3-only is not a black frame').toBeGreaterThan(40);

    expect(errors.filter((e) => !e.includes('AudioContext'))).toEqual([]);
  });

  // ── Audit C1: DREAMMELT melts IN from in0 — at the start the interior shows in0
  //    (melt seeds at 0), NOT in1 (which would mean the ring cleared alpha=1 →
  //    melt=1 → fully melted from frame 1). We solo-render in0 + in1 as references,
  //    then assert the early dreammelt frame is CLOSER to in0 than to in1.
  test('dreammelt: starts as in0 (melts IN), not in1, at the first frames', async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }], []);
    await page.locator('.svelte-flow__node-toybox').first().waitFor({ state: 'visible', timeout: 10_000 });
    await pinViewport(page);

    const out: GNode = { id: 'out', kind: 'output', x: 286, y: 66 };

    // Solo references: src0 (synthwave purple) → out, and src1 (star-field dark)
    // → out. VIVID + distinct so "closer to in0" is unambiguous.
    await seedVivid(page, [...sources(), out], [{ id: 'eo', from: 'src0', to: 'out', toPort: 'in0' }]);
    await settleFreeze(page, 2.0);
    const in0ref = await average(page);
    await seedVivid(page, [...sources(), out], [{ id: 'eo', from: 'src1', to: 'out', toPort: 'in0' }]);
    await settleFreeze(page, 2.0);
    const in1ref = await average(page);
    // Sanity: the two references are visibly distinct (else the test is vacuous).
    expect(dist(in0ref, in1ref), 'in0 vs in1 references are distinct').toBeGreaterThan(15);

    // DREAMMELT: in0 = src0 (purple), in1 = src1 (dark). A FRESH graph resets the
    // ring → clearColor MUST seed melt=0 (alpha=0) → the early frames read in0
    // (mix(in0,in1,0)=in0). Pre-fix the ring cleared alpha=1 → melt=1 →
    // mix=in1 → fully melted (dark) from frame 1. Low dripSpeed + high threshold
    // keep melt near 0 for the first frames.
    const op: GNode = { id: 'op', kind: 'dreammelt', x: 120, y: 14, params: { meltAmount: 0.9, dripSpeed: 0.05, threshold: 0.95 } };
    await seedVivid(page, [...sources(), op, out], [
      { id: 'e0', from: 'src0', to: 'op', toPort: 'in0' },
      { id: 'e1', from: 'src1', to: 'op', toPort: 'in1' },
      { id: 'eo', from: 'op', to: 'out', toPort: 'in0' },
    ]);
    await settleFreeze(page, 2.0);
    const early = await average(page);

    const dToIn0 = dist(early, in0ref);
    const dToIn1 = dist(early, in1ref);
    expect(dToIn0, `early dreammelt is CLOSER to in0 (${dToIn0.toFixed(1)}) than in1 (${dToIn1.toFixed(1)}) — melts IN from in0`)
      .toBeLessThan(dToIn1);
    expect(errors.filter((e) => !e.includes('AudioContext'))).toEqual([]);
  });
});

// NOTE: the "batch-op param is CV-targetable + responds" coverage moved OUT of
// e2e into a REAL-engine unit test — see toybox.test.ts
// ('TOYBOX batch-op CV targeting drives the render-local combine param'). The
// old e2e block read node.data.combine after a cv drive and asserted the STORE
// value changed; that is now architecturally WRONG — CV modulation deliberately
// writes only the render-local clone (read('liveModulated')), never the synced
// Y.Doc (the progressive-slowdown leak fix), so the store value correctly never
// moves. The unit test drives the real toyboxDef factory's setParam(cvN) and
// asserts the post-modulation value via read('liveModulated').combine — the same
// engine-internal read the toybox-cv-routing e2e asserts on — and fails if the
// cv wiring is broken (no render needed).

test.describe('TOYBOX combine graph — resizable view persists', () => {
  test('the node-graph panel resizes + the height persists in node.data', async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }], []);
    await page.locator('.svelte-flow__node-toybox').first().waitFor({ state: 'visible', timeout: 10_000 });
    await pinViewport(page);
    await ensureCombineOpen(page);

    const wrap = page.locator('[data-testid="toybox-graph-wrap"]');
    await expect(wrap).toBeVisible();
    const startH = (await wrap.boundingBox())!.height;

    // The panel is user-resizable (native CSS resize grip).
    const cssResize = await wrap.evaluate((el) => getComputedStyle(el).resize);
    expect(['vertical', 'both'], 'graph panel has a CSS resize affordance').toContain(cssResize);

    // Drive a resize the way the native grip does: set the element's inline
    // height; the ResizeObserver action picks it up + persists it (debounced).
    const targetH = Math.round(startH + 140);
    await page.evaluate((h) => {
      const el = document.querySelector('[data-testid="toybox-graph-wrap"]') as HTMLElement | null;
      if (el) el.style.height = `${h}px`;
    }, targetH);

    // (1) PERSISTED: the new height is written to node.data.combineView.h (so it
    //     round-trips through save/load + preset round-trip + multiplayer).
    let persisted = 0;
    await expect
      .poll(async () => {
        persisted = (await page.evaluate(() => {
          const w = globalThis as unknown as PatchGlobal;
          return w.__patch.nodes['tb']?.data?.combineView?.h ?? null;
        })) ?? 0;
        return persisted;
      }, { timeout: 8_000, intervals: [200, 400, 800] })
      .toBeGreaterThan(startH + 80);

    // (2) READ-BACK round-trip: WRITE the persisted size to a SECOND fresh toybox
    //     (a clean mount that has never been dragged), exactly as a save/load or a
    //     remote collaborator's node.data would carry it. The new card's
    //     combineViewH derived must apply that persisted height on mount.
    await spawnPatch(page, [{ id: 'tb2', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }], []);
    await page.evaluate((h) => {
      const w = globalThis as unknown as PatchGlobal;
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['tb2'];
        if (!n) return;
        if (!n.data) n.data = {};
        n.data.combineView = { h };
      });
    }, Math.round(persisted));
    await page.locator('.svelte-flow__node-toybox').first().waitFor({ state: 'visible', timeout: 10_000 });
    await pinViewport(page);
    await ensureCombineOpen(page);

    // The fresh card's graph panel reflects the persisted height (inline style
    // bound to the combineViewH derived, read off node.data on mount).
    const wrap2 = page.locator('[data-testid="toybox-graph-wrap"]');
    await expect(wrap2).toBeVisible();
    await expect
      .poll(() => wrap2.evaluate((el) => {
        const m = (el.getAttribute('style') ?? '').match(/height:\s*([\d.]+)px/);
        return m ? parseFloat(m[1]!) : 0;
      }), { timeout: 8_000, intervals: [200, 400, 800] })
      .toBeGreaterThan(startH + 50);

    expect(errors.filter((e) => !e.includes('AudioContext'))).toEqual([]);
  });
});
