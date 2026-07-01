// e2e/tests/toybox-combine-editor.spec.ts
//
// TOYBOX Phase 4 — the bespoke SVG combine-graph editor.
//
// Spawns a TOYBOX with two DISTINCT lit layers, opens the in-card node editor,
// and drives it through the UI:
//   1. add an op node (the ADD · map button),
//   2. wire it (click an output port dot, then an input port dot),
//   3. wire it into OUTPUT,
// then asserts:
//   (a) node.data.combine persisted the user's nodes + edges (round-trips
//       through the Yjs patch proxy → save/load + multiplayer),
//   (b) the live OUTPUT changed: rerouting the graph so a different layer feeds
//       the output produces a measurably different composite (the editor edits
//       the LIVE combine graph, not just data).
//
// Determinism: we pin iTime via window.__toyboxFreeze and sample the on-card
// preview canvas average colour (the same canvas the VRT freezes), so the
// "output changed" assertion is a stable numeric delta, not a flaky pixel diff.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch, ensureCombineOpen } from './_helpers';

type PatchGlobal = {
  __patch: {
    nodes: Record<
      string,
      { data?: { combine?: { nodes?: unknown[]; edges?: unknown[] }; layers?: unknown[] } }
    >;
  };
  __ydoc: { transact: (fn: () => void) => void };
  __toyboxFreeze?: (t?: number) => void;
};

/**
 * Pin the Svelte Flow viewport to scale 1 at the origin and pan the spawned
 * card UP so its (tall, editor-open) body clears the fixed bottombar footer,
 * which otherwise intercepts pointer events on the lower controls. Mirrors the
 * VRT spec's viewport pin.
 */
async function pinViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const vp = document.querySelector('.svelte-flow__viewport') as HTMLElement | null;
    if (!vp) return;
    vp.style.transition = 'none';
    // Pan up so the card top sits near the very top of the canvas; the editor
    // section + SVG then fall in the visible upper region above the footer.
    vp.style.transform = 'translate(8px, -24px) scale(1)';
  });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

/** Seed two layers with bright, DISTINCT solid shaders (so a reroute is
 *  visible) + an empty combine so the editor seeds the default graph. */
async function seedTwoLayers(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as unknown as PatchGlobal;
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['tb'];
      if (!n) return;
      if (!n.data) n.data = {};
      // Two GEN shaders that fill the frame with bright content; layer 0 is the
      // base, layer 1 is the one we'll fold in / route to output.
      n.data.layers = [
        { kind: 'gen', contentId: 'noise-fbm', params: {} },
        { kind: 'gen', contentId: 'worley-cells', params: {} },
        { kind: 'off', contentId: null, params: {} },
        { kind: 'off', contentId: null, params: {} },
      ] as unknown[];
      // Clear any combine so the first editor touch seeds the default graph.
      delete (n.data as { combine?: unknown }).combine;
    });
  });
}

/** Freeze iTime + wait until the preview is lit, then return its average RGB. */
async function frozenAverage(page: Page, time: number): Promise<[number, number, number]> {
  await page.waitForFunction(
    ({ time }) => {
      const g = globalThis as unknown as PatchGlobal;
      g.__toyboxFreeze?.(time);
      const c = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement | null;
      if (!c) return false;
      const ctx = c.getContext('2d');
      if (!ctx) return false;
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      let lit = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i]! > 16 || data[i + 1]! > 16 || data[i + 2]! > 16) lit++;
      }
      return lit > c.width * c.height * 0.1;
    },
    { time },
    // CI's software WebGL renderer starves the main thread; producing a
    // non-black frozen composite (multi-layer combine + OBJ/texmap passes)
    // can take well past 10s under load. The test budget is 60s; give the
    // render-readiness poll generous headroom so it isn't the bottleneck.
    { timeout: 30_000 },
  );
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement;
    const ctx = c.getContext('2d')!;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i]!; g += data[i + 1]!; b += data[i + 2]!; n++;
    }
    return [r / n, g / n, b / n] as [number, number, number];
  });
}

function dist(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Click an editor control by testid. force:true bypasses the fixed bottombar
 *  footer's pointer-interception over the lower card region — the elements are
 *  visible + in the DOM; only the overlay actionability check is in the way.
 *
 *  noWaitAfter:true is the load-bearing bit for CI: these are pure in-card
 *  onclick handlers (toggle a section, add an op, arm/wire a port) that never
 *  navigate. Without it, Playwright spends its default "waiting for scheduled
 *  navigations to finish" window after EVERY click. On CI that settle is
 *  pathologically slow (~3s/click) because TOYBOX's WebGL rAF compositor
 *  starves the main thread, so the 6-click wiring sequence that runs in ~4s
 *  locally balloons past the 30s test budget and the last click times out.
 *  Skipping the no-op post-click navigation wait reclaims that time. */
async function clickEd(page: Page, testid: string): Promise<void> {
  // Dispatch the click straight on the testid'd element (HTML toolbar buttons +
  // the SVG port circles / edge paths all carry their own onclick). A coordinate
  // force-click on the tiny SVG ports under svelte-flow's transform intermittently
  // fails to DELIVER under the serialized real-GPU attest's load (the toybox
  // combine-graph attest flake — same fix as node-menu/node-controls, task #151).
  await page.locator(`[data-testid="${testid}"]`).first().dispatchEvent('click');
}

/** Read the currently-armed connect source ("pendingFrom") from the on-card
 *  status line, which renders ONLY while a wire is armed
 *  (`<div data-testid="toybox-pending">armed: {id} → …</div>`). Returns the
 *  armed node id, or null when nothing is armed. This is the observable that
 *  makes the wiring protocol deterministic under CI starvation. */
async function armedFrom(page: Page): Promise<string | null> {
  const el = page.locator('[data-testid="toybox-pending"]');
  if ((await el.count()) === 0) return null;
  const txt = (await el.first().textContent()) ?? '';
  const m = txt.match(/armed:\s*(\S+)/);
  return m ? m[1]! : null;
}

/** Does node.data.combine already contain the edge from → to:toPort ? */
async function hasEdge(
  page: Page,
  from: string,
  to: string,
  toPort: string,
): Promise<boolean> {
  return page.evaluate(
    ({ from, to, toPort }) => {
      const w = globalThis as unknown as PatchGlobal;
      const c = w.__patch.nodes['tb']?.data?.combine as
        | { edges?: Array<{ from: string; to: string; toPort: string }> }
        | undefined;
      return (c?.edges ?? []).some(
        (e) => e.from === from && e.to === to && e.toPort === toPort,
      );
    },
    { from, to, toPort },
  );
}

/**
 * Per-pair re-click-until-edge-appears harness (#68 / #621).
 *
 * The two-click wire protocol (arm an OUTPUT dot → click an INPUT dot) was the
 * deterministic CI failure: under SwiftShader main-thread starvation a click
 * gets dropped, so either the arm never lands (input click then no-ops with
 * "pick an output dot first") or the commit click is lost — and because
 * onOutPortClick TOGGLES `pendingFrom`, a naive re-click can disarm instead of
 * arm. This harness drives the state machine to a KNOWN state each attempt
 * using the observable `toybox-pending` status line:
 *   1. if anything is armed, click that armed output to clear it (→ disarmed);
 *   2. click our OUTPUT dot and CONFIRM it armed to `from` (retry if dropped);
 *   3. click the INPUT dot and CONFIRM the edge formed in node.data.combine.
 * Bounded retries so a persistently-failing wire still fails the test loudly
 * (no infinite loop), rather than silently leaving a missing edge for the
 * downstream persistence poll to time out on.
 */
async function wireEdge(
  page: Page,
  from: string,
  to: string,
  toPort: string,
): Promise<void> {
  // Already wired (e.g. a prior attempt's commit landed late)? Done.
  if (await hasEdge(page, from, to, toPort)) return;

  const attempts = 6;
  for (let i = 0; i < attempts; i++) {
    // (1) Drive to a disarmed state: clear any stale arm by toggling it off.
    const stale = await armedFrom(page);
    if (stale) {
      await clickEd(page, `toybox-outport-${stale}`);
      await expect(page.locator('[data-testid="toybox-pending"]')).toHaveCount(0, {
        timeout: 3_000,
      });
    }

    // (2) Arm our output dot; confirm the arm actually landed on `from`.
    await clickEd(page, `toybox-outport-${from}`);
    try {
      await expect
        .poll(() => armedFrom(page), { timeout: 4_000, intervals: [100, 250, 500] })
        .toBe(from);
    } catch {
      continue; // arm click dropped (or toggled the wrong way) — retry the pair
    }

    // (3) Commit: click the input dot; confirm the edge persisted.
    await clickEd(page, `toybox-inport-${to}-${toPort}`);
    try {
      await expect
        .poll(() => hasEdge(page, from, to, toPort), {
          timeout: 4_000,
          intervals: [100, 250, 500, 1000],
        })
        .toBe(true);
      return; // edge formed
    } catch {
      // Commit click dropped, or the connect was rejected this frame; loop.
    }
  }

  throw new Error(
    `wireEdge: edge ${from} → ${to}:${toPort} never formed after ${attempts} attempts ` +
      `(CI SwiftShader click-drop class #621)`,
  );
}

test.describe('TOYBOX combine-graph editor (Phase 4)', () => {
  // Re-enabled (shard rebalance #68). Was a DETERMINISTIC CI failure (shard 9,
  // both attempts, run 27040200981): the multi-step click-to-wire flow (chained
  // port-pair clicks) DROPPED a click under SwiftShader main-thread starvation,
  // so the final edge never formed and the persistence poll exhausted. TWO
  // changes fix it: (1) this spec now runs on the dedicated non-sharded
  // `e2e-video` job (--workers=1), so no co-tenant heavy starves the GL context;
  // (2) each wire goes through the `wireEdge` per-pair re-click-until-edge
  // harness (above) — it drives the arm→commit state machine to a KNOWN state
  // each attempt via the observable `toybox-pending` line and retries a dropped
  // click, instead of firing 6 fire-and-forget clicks and hoping. The
  // wiring → node.data logic itself stays unit-covered (toybox-combine-graph.ts
  // 44 + toybox-combine-ydoc.ts 18); this e2e is the click-protocol layer.
  test('add a node + wire it via clicks; persists to node.data + changes the output', async ({
    page,
  }) => {
    // TOYBOX runs a WebGL rAF compositor; on CI's software renderer the main
    // thread is slow enough that the multi-step wiring UI flow needs headroom
    // beyond the 30s default (mirrors the heavy-video specs e.g. freezeframe /
    // picturebox-limits). On the serialized e2e-video job it finishes well
    // inside this budget; kept generous as belt-and-suspenders.
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }],
      [],
    );

    const card = page.locator('.svelte-flow__node-toybox').first();
    await card.waitFor({ state: 'visible', timeout: 10_000 });
    await pinViewport(page);

    await seedTwoLayers(page);

    // Baseline output (default graph = layer 0 base, fades at amount 0).
    const before = await frozenAverage(page, 2.0);

    // Open the editor (idempotent — the section defaults open in the wide card).
    await ensureCombineOpen(page);
    await expect(page.locator('[data-testid="toybox-graph-svg"]')).toBeVisible();

    // The default graph seeds when the editor first reads it; force a seed by
    // adding a node (mutateCombine seeds the default in place first).
    await clickEd(page, 'toybox-add-map');

    // The new op node should appear. Find its id from node.data.combine.
    const opId = await page.evaluate(() => {
      const w = globalThis as unknown as PatchGlobal;
      const c = w.__patch.nodes['tb']?.data?.combine as
        | { nodes?: Array<{ id: string; kind: string }> }
        | undefined;
      const op = (c?.nodes ?? []).find((n) => n.kind === 'map');
      return op?.id ?? null;
    });
    expect(opId, 'a MAP op node was added to node.data.combine').toBeTruthy();

    // Wire src0 → newOp.in0, src1 → newOp.in1, then re-point OUTPUT.in0 to newOp.
    // Each wire goes through wireEdge (per-pair re-click-until-edge harness) so a
    // dropped arm/commit click under CI starvation is retried, not lost (#621).
    await wireEdge(page, 'src0', opId!, 'in0');
    await wireEdge(page, 'src1', opId!, 'in1');

    // Re-route OUTPUT to the new op: delete OUTPUT's existing in0 edge, then
    // wire newOp → OUTPUT.in0.
    const outId = await page.evaluate(() => {
      const w = globalThis as unknown as PatchGlobal;
      const c = w.__patch.nodes['tb']?.data?.combine as
        | { nodes?: Array<{ id: string; kind: string }>; edges?: Array<{ id: string; to: string; toPort: string }> }
        | undefined;
      return (c?.nodes ?? []).find((n) => n.kind === 'output')?.id ?? null;
    });
    expect(outId).toBeTruthy();

    const outEdgeId = await page.evaluate(
      ({ outId }) => {
        const w = globalThis as unknown as PatchGlobal;
        const c = w.__patch.nodes['tb']?.data?.combine as
          | { edges?: Array<{ id: string; to: string; toPort: string }> }
          | undefined;
        return (c?.edges ?? []).find((e) => e.to === outId && e.toPort === 'in0')?.id ?? null;
      },
      { outId },
    );
    expect(outEdgeId).toBeTruthy();
    // Delete OUTPUT's existing in0 edge, then re-poll until the slot is free —
    // a dropped delete-click would otherwise leave wireEdge unable to commit
    // (the input shows 'occupied'). Re-click the edge until it's gone.
    await expect
      .poll(
        async () => {
          if (
            !(await page.evaluate(
              ({ outId }) => {
                const w = globalThis as unknown as PatchGlobal;
                const c = w.__patch.nodes['tb']?.data?.combine as
                  | { edges?: Array<{ to: string; toPort: string }> }
                  | undefined;
                return (c?.edges ?? []).some((e) => e.to === outId && e.toPort === 'in0');
              },
              { outId },
            ))
          ) {
            return false; // edge gone
          }
          await clickEd(page, `toybox-edge-${outEdgeId}`);
          return true; // still present this tick
        },
        { timeout: 10_000, intervals: [200, 400, 800, 1500] },
      )
      .toBe(false);
    // Now wire newOp → OUTPUT.in0 via the same retrying harness.
    await wireEdge(page, opId!, outId!, 'in0');

    // (a) PERSISTENCE: node.data.combine reflects the user's nodes + edges.
    // POLL rather than assert-once: the wiring clicks use noWaitAfter (load-
    // bearing for CI speed), so the Yjs write from the final edge can lag the
    // read by a few frames under the WebGL compositor's main-thread starvation.
    // A single evaluate then intermittently sees the pre-write edge set
    // ('op → output.in0 persisted' === false). Polling absorbs that lag.
    await expect
      .poll(
        () =>
          page.evaluate(
            ({ opId, outId }) => {
              const w = globalThis as unknown as PatchGlobal;
              const c = w.__patch.nodes['tb']?.data?.combine as
                | {
                    nodes?: Array<{ id: string; kind: string }>;
                    edges?: Array<{ from: string; to: string; toPort: string }>;
                  }
                | undefined;
              const edges = c?.edges ?? [];
              return {
                hasOp: (c?.nodes ?? []).some((n) => n.id === opId && n.kind === 'map'),
                srcIn0: edges.some((e) => e.from === 'src0' && e.to === opId && e.toPort === 'in0'),
                srcIn1: edges.some((e) => e.from === 'src1' && e.to === opId && e.toPort === 'in1'),
                opToOut: edges.some((e) => e.from === opId && e.to === outId && e.toPort === 'in0'),
              };
            },
            { opId, outId },
          ),
        {
          timeout: 15_000,
          intervals: [200, 400, 800, 1500],
          message: 'combine graph nodes + edges persisted to node.data.combine',
        },
      )
      .toMatchObject({ hasOp: true, srcIn0: true, srcIn1: true, opToOut: true });

    // (b) OUTPUT CHANGED: the MAP op (layer0 × layer1) now feeds the output, so
    // the composite differs from the layer-0-only baseline.
    const after = await frozenAverage(page, 2.0);
    expect(
      dist(before, after),
      'rerouting the combine graph through a MAP op changes the live output',
    ).toBeGreaterThan(4);

    expect(
      errors.filter((e) => !e.includes('AudioContext')),
      'no console / page errors',
    ).toEqual([]);
  });

  test('cycle-creating edges are rejected by the editor (output stays valid)', async ({ page }) => {
    // See the sibling test: TOYBOX's WebGL compositor makes the CI main thread
    // slow, so the add-op + wire-op + reject-cycle click flow needs headroom.
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }],
      [],
    );
    await page.locator('.svelte-flow__node-toybox').first().waitFor({ state: 'visible', timeout: 10_000 });
    await pinViewport(page);
    await seedTwoLayers(page);

    await ensureCombineOpen(page);
    // Add two FRESH ops + chain a → b, then try b → a (a cycle) and assert it's
    // blocked. (Pick the just-added fade ops — the ones with NO incoming edges —
    // not the pre-wired default-chain ops.)
    await clickEd(page, 'toybox-add-fade');
    await clickEd(page, 'toybox-add-fade');
    const [a, b] = await page.evaluate(() => {
      const w = globalThis as unknown as PatchGlobal;
      const c = w.__patch.nodes['tb']?.data?.combine as
        | {
            nodes?: Array<{ id: string; kind: string }>;
            edges?: Array<{ to: string }>;
          }
        | undefined;
      const wiredTo = new Set((c?.edges ?? []).map((e) => e.to));
      const freeFades = (c?.nodes ?? []).filter((n) => n.kind === 'fade' && !wiredTo.has(n.id));
      return [freeFades[0]?.id ?? null, freeFades[1]?.id ?? null];
    });
    expect(a && b).toBeTruthy();

    // a → b (legal) — via the per-pair re-click-until-edge harness so a dropped
    // arm/commit click under SwiftShader starvation is retried, not lost (#621).
    await wireEdge(page, a!, b!, 'in0');

    // b → a (would close a cycle). This is REJECTED, so no edge forms — wireEdge
    // (which waits for an edge) can't be used. Drive the arm→commit state machine
    // to a KNOWN state deterministically: clear any stale arm, arm b + CONFIRM it
    // landed (so the failure isn't a dropped arm click masquerading as "pick an
    // output first"), then click a's input to attempt the cycle.
    const stale = await armedFrom(page);
    if (stale) {
      await clickEd(page, `toybox-outport-${stale}`);
      await expect(page.locator('[data-testid="toybox-pending"]')).toHaveCount(0, {
        timeout: 3_000,
      });
    }
    await expect
      .poll(
        async () => {
          if ((await armedFrom(page)) === b) return true;
          await clickEd(page, `toybox-outport-${b}`);
          return false;
        },
        { timeout: 6_000, intervals: [150, 300, 600, 1200] },
      )
      .toBe(true);
    await clickEd(page, `toybox-inport-${a}-in0`);

    // The rejection message shows + no back-edge was written.
    await expect(page.locator('[data-testid="toybox-connect-msg"]')).toContainText('cycle');
    const hasBackEdge = await page.evaluate(
      ({ a, b }) => {
        const w = globalThis as unknown as PatchGlobal;
        const c = w.__patch.nodes['tb']?.data?.combine as
          | { edges?: Array<{ from: string; to: string }> }
          | undefined;
        return (c?.edges ?? []).some((e) => e.from === b && e.to === a);
      },
      { a, b },
    );
    expect(hasBackEdge, 'the cycle edge was NOT written').toBe(false);

    expect(
      errors.filter((e) => !e.includes('AudioContext')),
      'no console / page errors',
    ).toEqual([]);
  });
});
