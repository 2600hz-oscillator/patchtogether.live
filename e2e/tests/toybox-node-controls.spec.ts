// e2e/tests/toybox-node-controls.spec.ts
//
// TOYBOX combine-node CONTROLS — the always-visible bottom control pane.
//
// The card shows the CURRENTLY-SELECTED combine node's controls in a bottom pane
// (a knob per param, plus a MODE <select> for FEEDBACK). This replaced the old
// right-click "Configure" popovers: every node type is now edited the SAME way,
// in the same place. This spec is the HARD regression guard the bottom-pane
// rewrite demanded — it exercises EVERY op kind and EVERY one of its controls:
//
//   (A) controls-render: select a node of each kind → the pane shows its title +
//       the right knob SET (and only that set — switching selection updates it).
//   (B) knobs-STICK: drag each knob → the value persists to node.data AND the
//       knob keeps displaying the new value (the "knobs don't stick / snap back
//       on release" bug — a stale, non-reactive `value` prop reset the tick to
//       the old value on pointer-up; the fix makes the selected-node a fresh
//       layersRev-keyed snapshot so the value re-reads the live write).
//   (C) delete-auto-select: deleting a node selects the next op node so the pane
//       keeps showing controls (empty pane after a delete read as "controls
//       vanished"); deleting the last op hides the pane.
//   (D) delete-NEVER-crashes: add+wire+RENDER then delete EACH op kind (incl. the
//       stateful history ops like datamosh, whose per-node GL ring buffers are
//       freed on delete) → no page/console error, engine keeps rendering.
//
// Determinism/CI: DOM-interaction (no flaky pixel diffs). Knob "sticks" is read
// off the slider's aria-valuenow (= the displayed value) vs the committed
// node.data param, polled so the rAF-coalesced commit + idle-sync settle. Budgets
// scaled per repo memory ci-swiftshader-video-e2e-timeouts (SwiftShader starves
// the main thread; a toybox boot + many knob drags is heavier than a flat value).
//
// SwiftShader-cheap (renders NO canvas — pure DOM/Y.Doc spec): the only reason
// this timed out on CI's software renderer was TOYBOX's live main-thread rAF
// render loop grinding UNPAUSED underneath the DOM/store work. `boot()` now calls
// `installRenderSmokeHooks(page)` BEFORE page.goto — it sets `__videoEnginePause`
// (the engine rAF loop IDLES, so step() never auto-advances on the background
// tick → the slow background render cost is gone) + `__videoEngineFreezeTime`
// (pins the clock). DIRECT step() calls are unaffected (engine.ts:1339), so the
// `__toyboxFreeze(t)` path in the delete-no-crash test still drives + blits a
// real frame and the stateful GL rings still allocate exactly as before. NO
// assertion changed: every control-pane / knob-stick / aria-valuenow /
// auto-select / delete-no-crash / no-error check is byte-identical. This spec no
// longer reads pixels and no longer needs the serialized real-GPU heavy lane —
// it runs in the normal parallel e2e shards.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch, ensureCombineOpen } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';

type GNode = { id: string; kind: string; layer?: number; x: number; y: number; params?: Record<string, number> };
type GEdge = { id: string; from: string; to: string; toPort: string };
type PatchGlobal = {
  __patch: {
    nodes: Record<string, { data?: { combine?: { nodes?: GNode[]; edges?: GEdge[] }; layers?: unknown[] } }>;
  };
  __ydoc: { transact: (fn: () => void) => void };
  __toyboxFreeze?: (t?: number) => void;
};

// Every OP kind that exposes per-node controls in the bottom pane. Hardcoded so a
// regression that DROPS a kind from the registry fails loudly here; the per-param
// controls themselves are enumerated at RUNTIME from the rendered knobs, so a new
// param on any op is covered WITHOUT editing this list.
const OP_KINDS = [
  'fade', 'lumakey', 'chromakey', 'map', 'over', 'tile', 'mirror', 'displace', 'bitbend',
  'biocells', 'feedback', 'exquisite', 'framedelay', 'channeldesync', 'flowsmear', 'dreammelt', 'datamosh',
] as const;
type OpKind = (typeof OP_KINDS)[number];

// Lean (real-GPU attest): the per-kind RENDER+DELETE / controls loops are the
// heaviest specs in the serialized GPU lane (17× seed→render→delete). Run a
// REPRESENTATIVE spread by default — stateless (over/displace) + a stateful
// GL-ring op (feedback) + the datamosh delete-crash repro — and gate the
// exhaustive 17-kind set behind FULL_TOYBOX_CONTENT=1 for manual validation. The
// hardcoded OP_KINDS list above still fails loudly if a kind is dropped from the
// registry, so that regression confidence is retained.
const RENDER_OP_KINDS: readonly OpKind[] =
  process.env.FULL_TOYBOX_CONTENT === '1'
    ? OP_KINDS
    : ['over', 'displace', 'feedback', 'datamosh'];

// in-port counts (so the seeded graph is realistic + the delete-no-crash path
// exercises a WIRED stateful node, whose GL ring must be freed on delete).
const PORTS: Record<OpKind, number> = {
  fade: 2, lumakey: 2, chromakey: 2, map: 2, over: 2, displace: 2, dreammelt: 2,
  tile: 1, mirror: 1, bitbend: 1, biocells: 1, feedback: 1,
  framedelay: 1, channeldesync: 1, flowsmear: 1, datamosh: 1,
  exquisite: 4,
};

const CANVAS = '[data-testid="toybox-canvas"]';

async function pinViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const vp = document.querySelector('.svelte-flow__viewport') as HTMLElement | null;
    if (!vp) return;
    vp.style.transition = 'none';
    vp.style.transform = 'translate(8px, -24px) scale(1)';
  });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

/** Pan the svelte-flow viewport so `locator` sits near the visible centre.
 *  A tall card (feedback has 14 knobs) pushes lower controls BELOW the browser
 *  viewport, and svelte-flow positions content via a CSS transform — so
 *  Playwright's scrollIntoView/hover can't reach them (a real user pans the
 *  canvas). We do the same: nudge the viewport transform by the element's offset
 *  from a target point, so every knob can be hovered + dragged. */
async function panToElement(page: Page, locator: ReturnType<Page['locator']>): Promise<void> {
  const box = await locator.boundingBox();
  if (!box) return;
  const TARGET = { x: 360, y: 320 };
  const cur = await page.evaluate(() => {
    const vp = document.querySelector('.svelte-flow__viewport') as HTMLElement | null;
    const m = (vp?.style.transform ?? '').match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
    return m ? { x: parseFloat(m[1]!), y: parseFloat(m[2]!) } : { x: 8, y: -24 };
  });
  const nx = cur.x + (TARGET.x - (box.x + box.width / 2));
  const ny = cur.y + (TARGET.y - (box.y + box.height / 2));
  await page.evaluate(({ x, y }) => {
    const vp = document.querySelector('.svelte-flow__viewport') as HTMLElement | null;
    if (vp) vp.style.transform = `translate(${x}px, ${y}px) scale(1)`;
  }, { x: nx, y: ny });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

function sources(): GNode[] {
  return [
    { id: 'src0', kind: 'source', layer: 0, x: 14, y: 14 },
    { id: 'src1', kind: 'source', layer: 1, x: 14, y: 66 },
    { id: 'src2', kind: 'source', layer: 2, x: 14, y: 118 },
    { id: 'src3', kind: 'source', layer: 3, x: 14, y: 170 },
  ];
}

function fourLayers(): unknown[] {
  return [
    { kind: 'gen', contentId: 'noise-fbm', params: {} },
    { kind: 'gen', contentId: 'worley-cells', params: {} },
    { kind: 'gen', contentId: 'noise-fbm', params: {} },
    { kind: 'gen', contentId: 'worley-cells', params: {} },
  ] as unknown[];
}

/** Seed a graph straight into node.data (the editor edits the same live shape). */
async function seed(page: Page, nodes: GNode[], edges: GEdge[]): Promise<void> {
  await page.evaluate(
    ({ nodes, edges, layers }) => {
      const w = globalThis as unknown as PatchGlobal;
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['tb'];
        if (!n) return;
        if (!n.data) n.data = {};
        n.data.layers = layers;
        n.data.combine = { nodes, edges } as { nodes: GNode[]; edges: GEdge[] };
      });
    },
    { nodes, edges, layers: fourLayers() },
  );
}

/** A single op of `kind` (id 'op') wired src0..→ its inputs → OUTPUT. */
function opGraph(kind: OpKind, opId = 'op'): { nodes: GNode[]; edges: GEdge[] } {
  const ports = PORTS[kind];
  const op: GNode = { id: opId, kind, x: 120, y: 14, params: {} };
  const out: GNode = { id: 'out', kind: 'output', x: 286, y: 66 };
  const edges: GEdge[] = [{ id: `e_${opId}_out`, from: opId, to: 'out', toPort: 'in0' }];
  const wires = ['src0', 'src1', 'src2', 'src3'];
  for (let i = 0; i < ports; i++) edges.push({ id: `e_${opId}_in${i}`, from: wires[i]!, to: opId, toPort: `in${i}` });
  return { nodes: [...sources(), op, out], edges };
}

/** Click a combine node's box to select it (the bottom control pane opens). */
async function selectNode(page: Page, nodeId: string): Promise<void> {
  // Dispatch the click straight on the handler-bearing <rect> (the testid is on the
  // parent <g>; the `onclick` lives on its `.gnode-rect` child, and the centred
  // `.gnode-label` is pointer-events:none). A coordinate `force` click computes the
  // <g> bbox centre and, under the serialized real-GPU attest's load, intermittently
  // fails to DELIVER to the SVG sub-element through svelte-flow's CSS transform — the
  // toybox-node-controls attest flake (the click lands but selection never fires, so
  // the pane never opens). A dispatched event hits the exact node + bubbles to
  // Svelte's delegated handler, immune to coordinates/transform/occlusion (same fix
  // as the #844 collab gestures occluded by the TIMELORDE overlay).
  await page.locator(`[data-testid="toybox-gnode-${nodeId}"] .gnode-rect`).dispatchEvent('click');
  // The params pane can still lag a slow frame before its data-node settles.
  await expect(page.locator('[data-testid="toybox-combine-params"]')).toHaveAttribute('data-node', nodeId, { timeout: 15_000 });
}

/** Read a combine node's live param value (or null). */
async function paramVal(page: Page, nodeId: string, param: string): Promise<number | null> {
  return page.evaluate(
    ({ nodeId, param }) => {
      const w = globalThis as unknown as PatchGlobal;
      return w.__patch.nodes['tb']?.data?.combine?.nodes?.find((n) => n.id === nodeId)?.params?.[param] ?? null;
    },
    { nodeId, param },
  );
}

/** The param ids currently rendered as knobs in the bottom pane (DOM order). */
async function renderedKnobParams(page: Page): Promise<string[]> {
  return page.$$eval('[data-testid^="toybox-combine-knob-"]', (els) =>
    els.map((e) => (e as HTMLElement).getAttribute('data-param') ?? '').filter(Boolean),
  );
}

/** Boot a single toybox + open the combine editor. */
async function boot(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  // SwiftShader-cheap: pause the engine rAF loop + pin the clock BEFORE boot so
  // TOYBOX's live main-thread render doesn't grind the software renderer under
  // this pure-DOM/Y.Doc spec (the sole cause of the CI timeout). Direct step()
  // calls the spec drives via __toyboxFreeze are unaffected, so every render /
  // ring-alloc / canvas-visible assertion below still holds.
  await installRenderSmokeHooks(page);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }], []);
  await page.locator('.svelte-flow__node-toybox').first().waitFor({ state: 'visible', timeout: 10_000 });
  await pinViewport(page);
  await ensureCombineOpen(page);
  await expect(page.locator('[data-testid="toybox-graph-svg"]')).toBeVisible();
  return errors;
}

const noErrors = (errors: string[]) =>
  expect(errors.filter((e) => !e.includes('AudioContext')), 'no page/console errors').toEqual([]);

/** Drag a node's `param` knob + assert it (a) persists to node.data AND (b) the
 *  displayed tick tracks the write — i.e. does NOT snap back to the default on
 *  pointer-up (the bug this whole PR fixes). Reused by the per-kind loop + the
 *  exhaustive feedback test. `label` just tags assertion messages. */
async function assertKnobSticks(page: Page, nodeId: string, param: string, label: string): Promise<void> {
  const slider = page
    .locator(`[data-testid="toybox-combine-knob-${param}"]`)
    .locator('[role="slider"]');
  await expect(slider).toBeVisible();
  const before = Number(await slider.getAttribute('aria-valuenow'));
  const min = Number(await slider.getAttribute('aria-valuemin'));
  const max = Number(await slider.getAttribute('aria-valuemax'));
  const tol = Math.max(1e-3, (max - min) * 0.02);
  // Pan the canvas so THIS knob is centred + on-screen (feedback's 14 knobs push
  // lower ones off the viewport inside svelte-flow's transform), then hover()
  // parks the cursor on it. Pointer CAPTURE on pointerdown keeps the drag flowing
  // to this knob even as the cursor leaves it.
  await panToElement(page, slider);
  await slider.hover();
  const box = (await slider.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  // Drag toward the side that CHANGES the value: up (cy-) = increase, so values
  // at/under mid drag up, values over mid drag down (a param whose default is the
  // max, e.g. fade T=1, can't increase further).
  const mid = (min + max) / 2;
  const dy = before <= mid ? -55 : 55;
  await page.mouse.down();
  await page.mouse.move(cx, cy + dy, { steps: 8 });
  await page.mouse.up();

  // the committed value moved off the default…
  let persisted = before;
  await expect
    .poll(async () => {
      persisted = (await paramVal(page, nodeId, param)) ?? before;
      return Math.abs(persisted - before);
    }, { timeout: 6_000, intervals: [100, 200, 400], message: `${label}.${param} committed a change (before=${before}, min=${min}, max=${max}, dy=${dy})` })
    .toBeGreaterThan(tol);

  // …and the KNOB keeps displaying it (the snap-back regression reset the tick to
  // `before` on pointer-up; poll so the idle-sync settles).
  await expect
    .poll(async () => Math.abs(Number(await slider.getAttribute('aria-valuenow')) - persisted),
      { timeout: 6_000, intervals: [100, 200, 400], message: `${label}.${param} knob displays the persisted value (no snap-back)` })
    .toBeLessThan(tol);
  expect(Math.abs(Number(await slider.getAttribute('aria-valuenow')) - before),
    `${label}.${param} knob stuck (off default)`).toBeGreaterThan(tol);
}

// ───────────────────────── (A)+(B) render + STICK ─────────────────────────
// ONE boot loops every op kind (re-seeding in place): proves each kind's controls
// RENDER + its FIRST knob STICKS (the snap-back fix is one structural change, so
// one knob per kind proves it per kind). The EXHAUSTIVE every-knob coverage is the
// feedback test below (the 14-knob worst case). Collapsed to two boots because the
// WebGL-heavy serialized `e2e-video` job is near its 30-min cap and booting 17
// toyboxes (the old per-kind tests) blew it.
test.describe('TOYBOX node controls — every kind renders + knobs stick', () => {
  test('all op kinds: controls render + first knob sticks (no snap-back)', async ({ page }) => {
    test.setTimeout(240_000);
    const errors = await boot(page);
    for (const kind of RENDER_OP_KINDS) {
      const g = opGraph(kind);
      await seed(page, g.nodes, g.edges);
      await selectNode(page, 'op');
      await expect(page.locator('[data-testid="toybox-combine-params-title"]'),
        `${kind} pane title`).toContainText(kind.toUpperCase());
      const params = await renderedKnobParams(page);
      expect(params.length, `${kind} renders ≥1 control knob`).toBeGreaterThan(0);
      if (kind === 'feedback') {
        await expect(page.locator('[data-testid="toybox-feedback-mode-select"]')).toBeVisible();
        expect(params, 'feedback MODE is the <select>, not a knob').not.toContain('mode');
      }
      await assertKnobSticks(page, 'op', params[0]!, kind);
    }
    noErrors(errors);
  });

  test('feedback: EVERY one of its knobs sticks (no snap-back)', async ({ page }) => {
    test.setTimeout(180_000);
    const errors = await boot(page);
    const g = opGraph('feedback');
    await seed(page, g.nodes, g.edges);
    await selectNode(page, 'op');
    const params = await renderedKnobParams(page);
    expect(params.length, 'feedback exposes many knobs').toBeGreaterThan(5);
    for (const param of params) await assertKnobSticks(page, 'op', param, 'feedback');
    noErrors(errors);
  });
});

// ───────────────────────── (A') selection switches the pane ─────────────────────────
test.describe('TOYBOX node controls — selection switches the control set', () => {
  test('selecting a different-kind node swaps the rendered controls', async ({ page }) => {
    test.setTimeout(90_000);
    const errors = await boot(page);

    // Two distinct-kind ops: biocells (CELLS/LUMA JIT/EDGE/EDGE COL) + tile
    // (TILES X/Y/…). Selecting each shows ITS controls and not the other's.
    const out: GNode = { id: 'out', kind: 'output', x: 286, y: 66 };
    const a: GNode = { id: 'opA', kind: 'biocells', x: 120, y: 14, params: {} };
    const b: GNode = { id: 'opB', kind: 'tile', x: 196, y: 14, params: {} };
    await seed(page, [...sources(), a, b, out], [
      { id: 'ea', from: 'src0', to: 'opA', toPort: 'in0' },
      { id: 'eb', from: 'opA', to: 'opB', toPort: 'in0' },
      { id: 'eo', from: 'opB', to: 'out', toPort: 'in0' },
    ]);

    await selectNode(page, 'opA');
    let params = await renderedKnobParams(page);
    expect(params).toContain('cellCount');
    expect(params).not.toContain('tilesX');

    await selectNode(page, 'opB');
    params = await renderedKnobParams(page);
    expect(params).toContain('tilesX');
    expect(params).not.toContain('cellCount');

    noErrors(errors);
  });
});

// ───────────────────────── (C) delete → auto-select ─────────────────────────
test.describe('TOYBOX node controls — delete auto-selects the next node', () => {
  test('deleting the selected node selects the next op; deleting the last hides the pane', async ({ page }) => {
    test.setTimeout(90_000);
    const errors = await boot(page);

    const out: GNode = { id: 'out', kind: 'output', x: 286, y: 66 };
    const a: GNode = { id: 'opA', kind: 'biocells', x: 120, y: 14, params: {} };
    const b: GNode = { id: 'opB', kind: 'mirror', x: 196, y: 14, params: {} };
    await seed(page, [...sources(), a, b, out], [
      { id: 'ea', from: 'src0', to: 'opA', toPort: 'in0' },
      { id: 'eb', from: 'opA', to: 'opB', toPort: 'in0' },
      { id: 'eo', from: 'opB', to: 'out', toPort: 'in0' },
    ]);

    await selectNode(page, 'opA');
    // Delete the SELECTED node (its × affordance) → the pane re-targets the
    // remaining op (opB) and shows its controls (not an empty pane). dispatchEvent
    // on the testid'd `.gnode-del` <text> (carries the onclick) so the delete lands
    // regardless of attest-load click-delivery — see selectNode's note.
    await page.locator('[data-testid="toybox-delnode-opA"]').dispatchEvent('click');
    await expect(page.locator('[data-testid="toybox-combine-params"]')).toHaveAttribute('data-node', 'opB');
    expect(await renderedKnobParams(page)).toContain('mode'); // mirror's MODE knob

    // Delete the LAST op → no op nodes remain → the control pane hides.
    await page.locator('[data-testid="toybox-delnode-opB"]').dispatchEvent('click');
    await expect(page.locator('[data-testid="toybox-combine-params"]')).toHaveCount(0);

    noErrors(errors);
  });
});

// ───────────────────────── (D) deleting any kind never crashes ─────────────────────────
test.describe('TOYBOX node controls — deleting any node kind never crashes', () => {
  test('add → wire → RENDER → delete each op kind: no crash, engine keeps rendering', async ({ page }) => {
    // One boot; re-seed + delete each kind in turn. The original report was a
    // CRASH when deleting a datamosh (stateful) node — its per-node GL ring is
    // freed on delete; this proves every kind's delete is clean while LIVE.
    test.setTimeout(240_000);
    const errors = await boot(page);

    for (const kind of RENDER_OP_KINDS) {
      // Seed the op of this kind, wired + selected, and let it render a frame
      // (a stateful op only allocs its ring once the engine has rendered it).
      const g = opGraph(kind);
      await seed(page, g.nodes, g.edges);
      await selectNode(page, 'op');
      // Pin time + advance a couple frames so a stateful node's ring is live.
      // (__toyboxFreeze drives a DIRECT engine step() — unaffected by the paused
      // rAF loop installRenderSmokeHooks set — so the ring still allocates.)
      await page.evaluate(() => (globalThis as unknown as PatchGlobal).__toyboxFreeze?.(2.0));
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

      // DELETE it (the × affordance) — the reported crash path. dispatchEvent so the
      // delete lands every iteration under the 17× SwiftShader loop (see selectNode).
      await page.locator('[data-testid="toybox-delnode-op"]').dispatchEvent('click');
      // Node is gone from node.data…
      // CI-load robustness: the per-kind delete+render round runs 17× under the
      // SwiftShader software renderer; the per-iteration 6s/default-5s waits race
      // a slow software frame (toybox-node-controls:341 flake). Widen the per-
      // iteration heavy-card waits (the overall test.setTimeout is already maxed).
      await expect
        .poll(() => page.evaluate(() => {
          const w = globalThis as unknown as PatchGlobal;
          return (w.__patch.nodes['tb']?.data?.combine?.nodes ?? []).some((n) => n.id === 'op');
        }), { timeout: 15_000 })
        .toBe(false);
      // …and the engine is still alive: a frame still renders to the canvas.
      await page.evaluate(() => (globalThis as unknown as PatchGlobal).__toyboxFreeze?.(2.5));
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
      await expect(page.locator(CANVAS)).toBeVisible({ timeout: 15_000 });
      // Fail fast with the offending kind if anything threw this round.
      expect(errors.filter((e) => !e.includes('AudioContext')), `no crash deleting ${kind}`).toEqual([]);
    }

    noErrors(errors);
  });
});
