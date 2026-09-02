// e2e/tests/reconciler-node-type-swap.spec.ts
//
// A MODULE RESPAWNED AT A REUSED NODE ID IS THE MODULE THE OPERATOR NOW SEES.
//
// ── THE DEFECT THIS PINS ───────────────────────────────────────────────────
//
// `packages/web/src/lib/audio/reconciler.ts` computed node removal by ID
// ABSENCE alone, and its add pass skips any id it already holds. A node whose
// TYPE (or domain) changed AT A REUSED ID was therefore invisible to it: no
// `removeNode`, no `addNode`, and the PREVIOUS module's engine handle stayed
// bound to that id. `PatchEngine.read(node, key)` resolves by node id with no
// type check (engine.ts — `this.nodes.get(nodeId)`), and a dozen modules answer
// the SAME `read('snapshot')` key with their OWN shape — pong, frogger, scope,
// dockscope, nibbles, skifree, gamepad, featurecv, cube, synesthesia, modtris —
// so the new module's surface was handed the OLD module's snapshot.
//
// SYNESTHESIA is the observable end of that: `SynesthesiaCard`'s rAF loop reads
// the snapshot, and a truthy foreign one passes its MISSING `levelsA` into
// `drawVuMeters`, whose `levels[c] ?? 0` throws on the INDEX READ before the
// `??` can apply — `Cannot read properties of undefined (reading '0')`, thrown
// out of a rAF callback, i.e. a pageerror. `drawVuMeters` clears the canvas
// FIRST and throws before the first `fillRect`, so the meters also stay blank
// forever. Both halves are asserted below.
//
// ── WHY A REUSED ID IS A REAL STATE, NOT A CONTRIVANCE ─────────────────────
//
// Both writers that re-use an id delete-then-add inside ONE Y.Doc transaction:
// `loadEnvelopeIntoStore` (persistence.ts) swapping the live store when a patch
// is loaded over a running one, and the `spawnPatch` e2e helper clearing and
// rebuilding the rack. ONE transaction is ONE snapshot, so the empty
// intermediate state never exists to be observed. That is exactly what this
// spec drives — `spawnPatch`, unmodified, twice, at the same id.
//
// The reconciler's own layer (remove-then-add ordering, the coalescing
// condition, the domain change, and the no-churn negative control) is pinned in
// `packages/web/src/lib/audio/reconciler.test.ts`. This leg exists because that
// unit layer cannot see the consequence: a card painting another module's data.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { collectPageErrors } from './_page-errors';

/** The keys that identify WHICH module's handle is bound at `nodeId`. */
async function snapshotShape(page: import('@playwright/test').Page, nodeId: string) {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
      __patch: { nodes: Record<string, unknown> };
    };
    const eng = w.__engine?.();
    const node = w.__patch.nodes[id];
    if (!eng || !node) return { bound: false, keys: [] as string[] };
    const snap = eng.read(node, 'snapshot');
    if (!snap || typeof snap !== 'object') return { bound: false, keys: [] as string[] };
    return { bound: true, keys: Object.keys(snap as object).sort() };
  }, nodeId);
}

/** Fraction of sampled pixels with any paint, read off the card's own canvas. */
async function paintedFraction(page: import('@playwright/test').Page, testId: string) {
  return page.evaluate((id) => {
    const c = document.querySelector(`[data-testid="${id}"]`) as HTMLCanvasElement | null;
    if (!c) return -1;
    const ctx = c.getContext('2d');
    if (!ctx) return -1;
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    let painted = 0;
    let n = 0;
    for (let i = 3; i < px.length; i += 4) {
      n++;
      if (px[i]! > 0) painted++;
    }
    return n ? painted / n : -1;
  }, testId);
}

test('a module respawned at a REUSED node id replaces the previous module, and its card paints', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  // The legacy renderer, because that is where the unguarded read lives: the
  // legacy SynesthesiaCard passes `snap.levelsA` straight through, while the
  // v2 face body (SynesthesiaVuBody) defaults it. Same URL the registry
  // inputs-accept sweep boots (support/rack-session LEGACY_RACK_URL).
  await page.goto('/rack?shell=legacy&seed=none');

  // 1. SCOPE occupies node id `sut`. It answers the shared `read('snapshot')`
  //    key with its own analyser-window shape.
  await spawnPatch(page, [{ id: 'sut', type: 'scope' }]);
  const before = await snapshotShape(page, 'sut');
  expect(before.bound, 'PRECONDITION: the first module really bound a handle').toBe(true);
  expect(
    before.keys,
    'PRECONDITION: and it is a FOREIGN shape — no levelsA for a synesthesia surface to read',
  ).not.toContain('levelsA');

  // 2. SYNESTHESIA takes over the SAME id, via the same clear-and-rebuild
  //    single transaction every sweep row uses.
  await spawnPatch(page, [{ id: 'sut', type: 'synesthesia' }]);

  // 3. The engine handle at that id is now SYNESTHESIA's. Polled because the
  //    reconciler is a serial async chain — the timeout BOUNDS THE FAILURE, it
  //    is not the gate; the gate is the observed key set.
  await expect
    .poll(async () => (await snapshotShape(page, 'sut')).keys, {
      message: 'the id must resolve to the NEW module, not the one it replaced',
      timeout: 15_000,
    })
    .toEqual(['levelsA', 'levelsB']);

  // 4. …and the card PAINTS. Pre-fix this canvas stays fully transparent: the
  //    rAF loop clears it, then throws inside drawVuMeters before the first
  //    segment is filled. Level 0 still paints all 40 unlit segments, so this
  //    needs no signal to be deterministic.
  await expect
    .poll(async () => await paintedFraction(page, 'synesthesia-vu-a'), {
      message: 'the NEW module\'s VU meters must actually be drawn',
      timeout: 15_000,
    })
    .toBeGreaterThan(0.5);

  // 5. The pageerror the parked sweep row recorded.
  expect(errors.significant(), 'no pageerror from a card reading a foreign snapshot').toEqual([]);
});
