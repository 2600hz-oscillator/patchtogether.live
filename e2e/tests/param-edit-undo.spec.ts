// e2e/tests/param-edit-undo.spec.ts
//
// Regression for the standards-refactor Phase 5a "setNodeParam migration":
//   A card knob/fader edit must be UNDOABLE.
//
// Phase 5a routed the ~141 card param write-sites from a bare
// `patch.nodes[id].params[k] = v` (a SyncedStore proxy write that transacts
// with NO origin → invisible to the UndoManager) onto the shared mutation seam
// `setNodeParam(id, k, v)`, which wraps the write in `ydoc.transact(fn,
// LOCAL_ORIGIN)`. The UndoManager (graph/store.ts) is configured with
// `trackedOrigins = new Set([LOCAL_ORIGIN])`, so only a LOCAL_ORIGIN-tagged
// write lands on the undo stack. Before the migration a knob turn was NOT
// undoable; after it, Cmd-Z reverts it. This spec proves the routing kept the
// write undoable by driving the REAL card UI (a dblclick on the Fader track,
// which fires the card's migrated `onchange` → setNodeParam).
//
// What this asserts (renderer-tolerant — only reads param values from the
// dev `__patch` global, never pixels, so it runs on CI's SwiftShader too):
//   1. spawn a REVERB with size seeded to a NON-default value (0.9).
//   2. dblclick the "Size" fader track → the card's onchange fires → routed
//      through setNodeParam (LOCAL_ORIGIN). (The exact landed value depends on
//      the click position; we only require it to MOVE off the seeded 0.9.)
//   3. assert params.size moved away from 0.9 (the user edit landed).
//   4. __undoManager.undo() (the same UndoManager Cmd-Z drives).
//   5. assert params.size === 0.9 again (the edit was tracked + reverted).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

/** Read a single flat param off a node via the dev-only window global. */
async function readParam(page: Page, nodeId: string, paramId: string): Promise<number | undefined> {
  return await page.evaluate(
    ({ nodeId, paramId }) => {
      const w = window as unknown as {
        __patch: { nodes: Record<string, { params?: Record<string, number> }> };
      };
      return w.__patch.nodes[nodeId]?.params?.[paramId];
    },
    { nodeId, paramId },
  );
}

test('card param edit is undoable: a Fader edit reverts on undo (setNodeParam migration)', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // 1. Spawn a reverb with size seeded to a non-default value. The ReverbCard
  //    Size fader's defaultValue is 0.5; we seed 0.9 so the dblclick (which
  //    sets the param to the default) produces an observable change.
  await spawnPatch(page, [
    { id: 'rev-1', type: 'reverb', position: { x: 200, y: 160 }, domain: 'audio', params: { size: 0.9, damp: 0.3, mix: 0.3 } },
  ]);

  expect(await readParam(page, 'rev-1', 'size')).toBeCloseTo(0.9, 5);

  // 2. Scroll the "Size" Fader track DOWN by one wheel tick. The Fader's wheel
  //    handler calls onchange(newValue) ONCE (no rAF coalescing) → runs the
  //    card's migrated `set('size')` closure → setNodeParam('rev-1', 'size', v)
  //    (LOCAL_ORIGIN). A single gesture = a single tracked transaction = a
  //    single undo entry, so one undo() reverts it cleanly.
  const sizeFader = page
    .locator('.svelte-flow__node[data-id="rev-1"] .track[role="slider"][aria-label="Size"]');
  await expect(sizeFader).toBeVisible();
  await sizeFader.hover();
  await page.mouse.wheel(0, 120); // one notch down → lowers size off 0.9

  // 3. The user edit landed: size has changed away from the seeded 0.9.
  await expect
    .poll(() => readParam(page, 'rev-1', 'size'), { timeout: 5000 })
    .toBeLessThan(0.9);

  // 4. Undo via the SAME UndoManager Cmd-Z drives. Before Phase 5a this was a
  //    no-op for a knob edit (the bare proxy write was never tracked), so the
  //    stack would be empty and size would stay changed.
  await page.evaluate(() => {
    const w = window as unknown as { __undoManager: { undo: () => void } };
    w.__undoManager.undo();
  });

  // 5. The edit was tracked → undo reverts size to the seeded 0.9.
  await expect.poll(() => readParam(page, 'rev-1', 'size'), { timeout: 5000 }).toBeCloseTo(0.9, 5);
});
