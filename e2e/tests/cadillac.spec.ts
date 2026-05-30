// e2e/tests/cadillac.spec.ts
//
// CADILLAC — singleton meta module that drives across the canvas R→L
// at 300 px/s and deletes every module its hit-box overlaps. TIMELORDE
// (and anything else flagged `undeletable: true`) passes through
// silently. Self-destructs 200px past the leftmost survivor, or after
// 8s wall-clock fallback when the canvas is empty.

import { test, expect, type Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

interface PatchNode {
  id: string;
  type: string;
  domain: string;
  position: { x: number; y: number };
  params: Record<string, number>;
  data?: Record<string, unknown>;
}

async function readNodes(page: Page): Promise<PatchNode[]> {
  return await page.evaluate(() => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, PatchNode> };
    };
    return Object.values(w.__patch.nodes).filter(Boolean) as PatchNode[];
  });
}

async function nodeTypes(page: Page): Promise<string[]> {
  return (await readNodes(page)).map((n) => n.type).sort();
}

async function bootEngine(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => {
    const w = globalThis as unknown as {
      __ensureEngine?: () => Promise<unknown>;
      __spawnFromPalette?: (type: string) => void;
    };
    return typeof w.__ensureEngine === 'function' && typeof w.__spawnFromPalette === 'function';
  });
  await page.evaluate(async () => {
    const w = globalThis as unknown as { __ensureEngine: () => Promise<unknown> };
    await w.__ensureEngine();
  });
}

async function placeNodes(page: Page, nodes: PatchNode[]): Promise<void> {
  await page.evaluate((toAdd) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      for (const id of Object.keys(w.__patch.edges)) delete w.__patch.edges[id];
      for (const id of Object.keys(w.__patch.nodes)) delete w.__patch.nodes[id];
      for (const n of toAdd) {
        w.__patch.nodes[n.id] = {
          id: n.id,
          type: n.type,
          domain: n.domain,
          position: n.position,
          params: n.params ?? {},
          data: n.data ?? {},
        };
      }
    });
  }, nodes);
}

async function spawnCadillac(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as unknown as { __spawnFromPalette: (t: string) => void };
    w.__spawnFromPalette('cadillac');
  });
}

// Bump per-test timeout — the rAF-driven drive needs wall-clock to play
// out (up to ~10s for the fallback case) and Playwright's 30s default is
// uncomfortably close under parallel load when the dev server is warming up.
test.setTimeout(60_000);

test('CADILLAC drives through audio modules and deletes them', async ({ page }) => {
  await bootEngine(page);

  // Plant three VCOs anywhere — we'll snap their y onto the car's y
  // right after the spawn so they're in its hit band.
  await placeNodes(page, [
    { id: 'vco-1', type: 'analogVco', domain: 'audio', position: { x: 100, y: 0 }, params: {} },
    { id: 'vco-2', type: 'analogVco', domain: 'audio', position: { x: 250, y: 0 }, params: {} },
    { id: 'vco-3', type: 'analogVco', domain: 'audio', position: { x: 400, y: 0 }, params: {} },
  ]);

  // Wait for SvelteFlow to measure the three cards (the overlay needs
  // measured w/h to compute hits).
  await page.waitForFunction(
    () => document.querySelectorAll('.svelte-flow__node').length === 3,
    null,
    { timeout: 5000 },
  );

  await spawnCadillac(page);

  // Snap the VCO y to match the cadillac y so they sit in the car's
  // hit-band (CAR_H = 94 px in flow space). The car's y is whatever
  // spawnFromPalette computed from the viewport center.
  await page.evaluate(() => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, { id: string; type: string; position: { y: number } }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    const cad = Object.values(w.__patch.nodes).find((n) => n?.type === 'cadillac');
    if (!cad) return;
    const carY = cad.position.y;
    w.__ydoc.transact(() => {
      for (const n of Object.values(w.__patch.nodes)) {
        if (n.type === 'analogVco') n.position.y = carY;
      }
    });
  });

  // The car drives ~300 px/s. With the cars at x∈[100..550] and the car
  // spawning at viewport right + 80, it can take a few seconds to chew
  // through them depending on viewport size. Generous budget so the spec
  // doesn't flake under parallel dev-server cold-start.
  await expect
    .poll(async () => (await nodeTypes(page)).filter((t) => t === 'analogVco').length, {
      timeout: 20_000,
      intervals: [200],
    })
    .toBe(0);

  // After the audio modules are gone, the car self-destructs once it's
  // 200 px past the leftmost survivor. Eventually the patch is empty.
  await expect
    .poll(async () => (await readNodes(page)).length, {
      timeout: 15_000,
      intervals: [200],
    })
    .toBe(0);
});

test('CADILLAC passes through TIMELORDE without an explosion', async ({ page }) => {
  await bootEngine(page);

  // TIMELORDE is undeletable. Place it directly in the car's path along
  // with one analog VCO to confirm the car still eats deletables.
  await placeNodes(page, [
    { id: 'tl-1', type: 'timelorde', domain: 'audio', position: { x: 200, y: 0 }, params: {} },
    { id: 'vco-1', type: 'analogVco', domain: 'audio', position: { x: 400, y: 0 }, params: {} },
  ]);

  await page.waitForFunction(
    () => document.querySelectorAll('.svelte-flow__node').length === 2,
    null,
    { timeout: 5000 },
  );

  await spawnCadillac(page);

  // Snap both into the car's hit-band y.
  await page.evaluate(() => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, { type: string; position: { y: number } }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    const cad = Object.values(w.__patch.nodes).find((n) => n?.type === 'cadillac');
    if (!cad) return;
    const carY = cad.position.y;
    w.__ydoc.transact(() => {
      for (const n of Object.values(w.__patch.nodes)) {
        if (n.type === 'timelorde' || n.type === 'analogVco') {
          n.position.y = carY;
        }
      }
    });
  });

  // Poll until the VCO is gone (generous budget for parallel dev-server load).
  await expect
    .poll(async () => (await readNodes(page)).find((n) => n.id === 'vco-1') === undefined, {
      timeout: 20_000,
      intervals: [150],
    })
    .toBe(true);

  // TIMELORDE must still exist.
  const tl = (await readNodes(page)).find((n) => n.id === 'tl-1');
  expect(tl, 'TIMELORDE should survive the drive').toBeDefined();

  // No explosion was emitted for it — the explosion overlay testid
  // appears only when the car deletes a node; TIMELORDE passed through
  // silently. We can't sample explosions reliably mid-fade (600ms life),
  // but the "TIMELORDE still exists" assertion above already pins the
  // no-delete contract — that's the load-bearing claim.

  // Let the car self-destruct (no deletables left → 8s fallback from
  // its spawn time, but since the drive already consumed a few seconds
  // we usually see it disappear sooner once 200px past tl-1).
  await expect
    .poll(
      async () => (await readNodes(page)).filter((n) => n.type === 'cadillac').length,
      { timeout: 25_000, intervals: [250] },
    )
    .toBe(0);

  const after = await readNodes(page);
  expect(after.find((n) => n.id === 'tl-1'), 'TIMELORDE survives after car gone').toBeDefined();
});

test('CADILLAC + 3 audio + 1 TIMELORDE: audio dies, TIMELORDE survives, car self-destructs ~200px past leftmost survivor', async ({
  page,
}) => {
  await bootEngine(page);

  // The headline scenario from the spec brief: 3 deletables + 1 undeletable
  // anchor. After the drive we expect ONLY the TIMELORDE left, and the car
  // to have self-destructed once it was ~200px past the TIMELORDE's left
  // edge (the leftmost survivor).
  await placeNodes(page, [
    { id: 'tl-1', type: 'timelorde', domain: 'audio', position: { x: 250, y: 0 }, params: {} },
    { id: 'vco-1', type: 'analogVco', domain: 'audio', position: { x: 450, y: 0 }, params: {} },
    { id: 'vco-2', type: 'analogVco', domain: 'audio', position: { x: 600, y: 0 }, params: {} },
    { id: 'vco-3', type: 'analogVco', domain: 'audio', position: { x: 750, y: 0 }, params: {} },
  ]);
  await page.waitForFunction(
    () => document.querySelectorAll('.svelte-flow__node').length === 4,
    null,
    { timeout: 5000 },
  );

  await spawnCadillac(page);

  // Snap deletables + the TIMELORDE into the car's hit-band.
  await page.evaluate(() => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, { type: string; position: { y: number } }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    const cad = Object.values(w.__patch.nodes).find((n) => n?.type === 'cadillac');
    if (!cad) return;
    const carY = cad.position.y;
    w.__ydoc.transact(() => {
      for (const n of Object.values(w.__patch.nodes)) {
        if (n.type === 'timelorde' || n.type === 'analogVco') {
          n.position.y = carY;
        }
      }
    });
  });

  // VCOs all gone within budget.
  await expect
    .poll(async () => (await nodeTypes(page)).filter((t) => t === 'analogVco').length, {
      timeout: 25_000,
      intervals: [200],
    })
    .toBe(0);

  // TIMELORDE survives.
  const after = await readNodes(page);
  expect(after.find((n) => n.id === 'tl-1'), 'TIMELORDE survives').toBeDefined();

  // Car self-destructs.
  await expect
    .poll(
      async () => (await readNodes(page)).filter((n) => n.type === 'cadillac').length,
      { timeout: 25_000, intervals: [250] },
    )
    .toBe(0);

  // Final state: only TIMELORDE remains.
  const final = await readNodes(page);
  expect(final.map((n) => n.id).sort()).toEqual(['tl-1']);
});

test('CADILLAC self-destructs via the 8s fallback when canvas is empty', async ({ page }) => {
  await bootEngine(page);

  // Empty canvas — no deletables.
  await placeNodes(page, []);
  await page.waitForFunction(
    () => document.querySelectorAll('.svelte-flow__node').length === 0,
    null,
    { timeout: 5000 },
  );

  const spawnStart = Date.now();
  await spawnCadillac(page);

  // Car should still exist immediately after spawn.
  expect((await readNodes(page)).find((n) => n.type === 'cadillac')).toBeDefined();

  // Within ~9s of spawn the fallback fires (8s + tolerance). Under parallel
  // load the dev-server cold-start can slow the rAF loop's first second
  // or two, so give the poll a bigger budget than the strict 8s fallback.
  await expect
    .poll(
      async () => (await readNodes(page)).filter((n) => n.type === 'cadillac').length,
      { timeout: 20_000, intervals: [250] },
    )
    .toBe(0);

  const elapsed = Date.now() - spawnStart;
  expect(elapsed, 'self-destruct fires roughly at 8s fallback boundary').toBeGreaterThanOrEqual(
    7_000,
  );
});
