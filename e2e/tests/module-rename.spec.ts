// e2e/tests/module-rename.spec.ts
//
// RENAME DISPLAYS WHAT YOU TYPED — the #2247 report, verbatim: "i can type
// and rename modules but when i hit enter i am not shown the string i tried
// to rename it to."
//
// ROOT CAUSE. ModuleNameLabel's displayName was `$derived(
// resolveDisplayName(node, …))` over the syncedstore proxy — which is not
// runes-reactive — and the `node` prop keeps its object identity across a
// rename, so the derived re-ran NEVER: commit() wrote `data.name` into the
// Y.Doc and the label re-rendered the stale name. The fix subscribes the
// label to `nodeVersion(id)` (the repo's per-node invalidation signal) and
// re-reads the LIVE doc entry, so the commit — local or a peer's — re-renders
// the title in place.
//
// This drives the REAL gesture on ONE module: click the tile's name, type,
// Enter — then asserts BOTH halves: the rendered label shows the typed string
// (the reported symptom) and the doc carries it (the truth the render must
// follow). Runs on /rack in the normal e2e lane — no DB, no relay, no audio.

import { test, expect, type Page } from '@playwright/test';
import { setFlowViewport } from './_helpers';

// A VALID name: rename enforces DSL-identifier shape (validateRename —
// letters/digits/_, no spaces), because a module's name is how the DSL
// references it.
const NEW_NAME = 'MY_WOBBLER';

async function gotoShellWorkflow(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, unknown> };
        __setSpawnFlowPos?: unknown;
        __spawnFromPalette?: unknown;
      };
      return (
        typeof w.__setSpawnFlowPos === 'function' &&
        typeof w.__spawnFromPalette === 'function' &&
        !!w.__patch
      );
    },
    undefined,
    { timeout: 30_000 },
  );
}

/** Drive the REAL palette-drop path at `pos`; returns the new node id. */
async function spawnAt(page: Page, type: string, pos: { x: number; y: number }): Promise<string> {
  return page.evaluate(
    ({ type, pos }) => {
      const w = globalThis as unknown as {
        __setSpawnFlowPos: (p: { x: number; y: number }) => void;
        __spawnFromPalette: (t: string) => void;
        __patch: { nodes: Record<string, unknown> };
      };
      const before = new Set(Object.keys(w.__patch.nodes));
      w.__setSpawnFlowPos(pos);
      w.__spawnFromPalette(type);
      const added = Object.keys(w.__patch.nodes).find((id) => !before.has(id));
      if (!added) throw new Error(`spawn of ${type} added no node`);
      return added;
    },
    { type, pos },
  );
}

test.describe('module rename', () => {
  test('typing a name and hitting Enter SHOWS that name — and the doc carries it', async ({ page }) => {
    await gotoShellWorkflow(page);
    const id = await spawnAt(page, 'tidyVco', { x: 400, y: 300 });
    // Frame the card readably — fitView would fit the whole rack (lanes at
    // y=4320) and shrink the tile below clickability.
    await setFlowViewport(page, { x: 220 - 400 * 0.9, y: 120 - 300 * 0.9, zoom: 0.9 });

    const tile = page.locator(`.svelte-flow__node[data-id="${id}"]`);
    const nameButton = tile.getByTestId('tile-name-label-button');
    await expect(nameButton).toBeVisible();

    // The REAL gesture: click the name, type over the selected text, Enter.
    await nameButton.click();
    const input = tile.getByTestId('tile-name-label-input');
    await expect(input).toBeVisible();
    await input.fill(NEW_NAME);
    await input.press('Enter');

    // The reported symptom, asserted directly: the label the user is looking
    // at shows the string they typed — not the stale pre-rename name.
    await expect(input).toHaveCount(0); // edit mode closed (no rejection)
    await expect(tile.getByTestId('tile-name-label-error')).toHaveCount(0);
    await expect(nameButton).toHaveText(NEW_NAME);

    // …and the render is TRUTH-BACKED: the name is in the shared doc (what
    // peers see and what a save carries), not just local component state.
    await expect
      .poll(() =>
        page.evaluate(
          (nid) =>
            (globalThis as unknown as {
              __patch: { nodes: Record<string, { data?: { name?: string } } | undefined> };
            }).__patch.nodes[nid]?.data?.name ?? null,
          id,
        ),
      )
      .toBe(NEW_NAME);
  });
});
