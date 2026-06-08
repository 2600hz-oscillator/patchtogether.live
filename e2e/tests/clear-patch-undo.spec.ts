// e2e/tests/clear-patch-undo.spec.ts
//
// Regression for Phase 2e of the standards-refactor program:
//   "Clear patch" must be UNDOABLE.
//
// Repro / root cause: Canvas.svelte's clearPatch() wrapped its node/edge
// deletes in a single `ydoc.transact(fn)` that passed NO origin. The
// UndoManager (graph/store.ts) is configured with
// `trackedOrigins = new Set([LOCAL_ORIGIN])`, so an origin-less transact is
// invisible to it — Clear was DESTRUCTIVE + IRREVERSIBLE. The Clear toolbar
// button has no confirm dialog, so undo is the only safety net, and that
// safety net was dead.
//
// Fix (one line): tag the transact with LOCAL_ORIGIN —
//   `ydoc.transact(fn, LOCAL_ORIGIN)`
// A single transact that deletes many keys collapses into ONE undo entry, so
// a single Cmd-Z (undoManager.undo()) restores the whole patch atomically.
//
// What this spec asserts (the user's repro):
//   1. spawn TWO modules (LFO + FILTER) + an edge between them.
//   2. click the REAL "Clear" toolbar button (the gesture undo backs up).
//   3. assert the canvas is empty (no node wrappers in the DOM AND
//      __patch.nodes/__patch.edges are empty).
//   4. trigger undo via the dev-only `__undoManager.undo()` hook (the same
//      UndoManager Cmd-Z drives).
//   5. assert the 2 nodes + the edge are restored — in both __patch and the
//      rendered DOM.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

/** Read patch node + edge ids from the dev-only window globals. */
async function readGraph(page: Page): Promise<{ nodes: string[]; edges: string[] }> {
  return await page.evaluate(() => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
    };
    return {
      nodes: Object.keys(w.__patch.nodes),
      edges: Object.keys(w.__patch.edges),
    };
  });
}

test('Clear patch is undoable: Clear empties the rack, undo restores nodes + edge', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // 1. Spawn two real-engine modules + a (cv→cv) edge between them. spawnPatch
  //    bootstraps the engine, mutates the graph in one transact, and waits for
  //    both node wrappers to mount in the DOM (bounded mountTimeout).
  await spawnPatch(
    page,
    [
      { id: 'lfo-1', type: 'lfo',    position: { x: 120, y: 120 }, domain: 'audio' },
      { id: 'flt-1', type: 'filter', position: { x: 460, y: 120 }, domain: 'audio' },
    ],
    [
      { id: 'e-1', from: { nodeId: 'lfo-1', portId: 'phase0' }, to: { nodeId: 'flt-1', portId: 'cutoff' }, sourceType: 'cv', targetType: 'cv' },
    ],
  );

  // Pre-condition: exactly the patch we asked for is present.
  {
    const g = await readGraph(page);
    expect(g.nodes).toEqual(expect.arrayContaining(['lfo-1', 'flt-1']));
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toEqual(['e-1']);
  }

  // 2. Click the REAL Clear toolbar button (the user gesture undo must back
  //    up). It's disabled while nodeCount === 0, so it must be enabled now.
  const clearBtn = page.getByRole('button', { name: 'Clear', exact: true });
  await expect(clearBtn).toBeEnabled();
  await clearBtn.click();

  // 3. The rack is now empty — both in the graph store and the DOM.
  await expect
    .poll(async () => (await readGraph(page)).nodes.length, { timeout: 5000 })
    .toBe(0);
  {
    const g = await readGraph(page);
    expect(g.edges).toHaveLength(0);
  }
  await expect(page.locator('.svelte-flow__node[data-id="lfo-1"]')).toHaveCount(0);
  await expect(page.locator('.svelte-flow__node[data-id="flt-1"]')).toHaveCount(0);
  // Clear disables itself once empty — corroborates nodeCount hit 0.
  await expect(clearBtn).toBeDisabled();

  // 4. Undo via the SAME UndoManager Cmd-Z drives (the dev-only hook). This is
  //    the safety net that was dead before LOCAL_ORIGIN was added to the Clear
  //    transact: without it, undo() is a no-op because the UndoManager never
  //    tracked the origin-less clear transact, so the stack would be empty.
  await page.evaluate(() => {
    const w = window as unknown as { __undoManager: { undo: () => void } };
    w.__undoManager.undo();
  });

  // 5. The whole patch is restored in ONE undo step (single-transact ⇒ single
  //    undo entry): both nodes + the edge come back, in the store and the DOM.
  await expect
    .poll(async () => (await readGraph(page)).nodes.length, { timeout: 5000 })
    .toBe(2);
  {
    const g = await readGraph(page);
    expect(g.nodes).toEqual(expect.arrayContaining(['lfo-1', 'flt-1']));
    expect(g.edges).toEqual(['e-1']);
  }
  // And re-mounted in the canvas DOM (renderer-tolerant: only asserts the node
  // wrappers exist by id, not pixels — works on CI's SwiftShader too).
  await expect(page.locator('.svelte-flow__node[data-id="lfo-1"]')).toBeVisible();
  await expect(page.locator('.svelte-flow__node[data-id="flt-1"]')).toBeVisible();
});
