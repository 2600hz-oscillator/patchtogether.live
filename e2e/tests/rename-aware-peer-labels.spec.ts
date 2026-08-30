// e2e/tests/rename-aware-peer-labels.spec.ts
//
// PEER LABELS FOLLOW A RENAME (#2264). The owner's report, verbatim: a
// rear-card port tooltip read "← FROM camera #1.OUT" while that camera was
// RENAMED to "feedback" — "we don't need to see the 'from' and it is much
// more useful to see the human-assignable label than the object number".
//
// This drives the REAL rename gesture on ONE module (the tile-name-label
// seam, exactly like module-rename.spec.ts), patches it to a second module
// via the proven precise-commit hook, then asserts the PEER surfaces on the
// TARGET's rear card:
//
//   * the hole TOOLTIP (title + aria mirror) names the source by its RENAME,
//     arrow-only — "← feedback.ENV", no FROM word, no "#N";
//   * the painted endpoint CHIP shows the rename ("← feedback").
//
// The un-renamed fallback (type label + #N) is pinned byte-identical by the
// unit suites (port-patch-helpers.test.ts / unpatch-menu.test.ts) and by
// patch-panel-jack-indicator.spec.ts, so this spec only has to prove the
// rename half actually flows through the live store → portConnections →
// RearCard chain, including the rename-liveness subscription (the rename
// lands AFTER the target's card is already rendered, which is exactly the
// re-render the nodeVersion plumbing exists for).

import { test, expect, type Page } from '@playwright/test';
import { setFlowViewport } from './_helpers';
import { pressFlipKey } from './_flip-key';

// A VALID rename: DSL-identifier shape (validateRename — letters/digits/_,
// no spaces). Lowercase on purpose — it is the owner's exact string, and the
// chip lowercases anyway, so the assertion is byte-honest on both surfaces.
const NEW_NAME = 'feedback';

async function gotoShellWorkflow(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, unknown> };
        __setSpawnFlowPos?: unknown;
        __spawnFromPalette?: unknown;
        __openDockFullView?: unknown;
        __handleConnect?: unknown;
      };
      return (
        typeof w.__setSpawnFlowPos === 'function' &&
        typeof w.__spawnFromPalette === 'function' &&
        typeof w.__openDockFullView === 'function' &&
        typeof w.__handleConnect === 'function' &&
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

test.describe('rename-aware peer labels (#2264)', () => {
  test('the TARGET rear card names a renamed source by its rename — tooltip and chip, no FROM', async ({
    page,
  }) => {
    await gotoShellWorkflow(page);

    // adsr (the module we rename) → vca (whose rear card names it as a peer).
    // Mono cv edge (adsr.env → vca.cv) so no stereo chooser interposes —
    // the same pair rear-view-patching.spec.ts uses.
    const srcId = await spawnAt(page, 'adsr', { x: 400, y: 300 });
    const dstId = await spawnAt(page, 'vca', { x: 950, y: 300 });

    // Frame the source tile readably (fitView would fit the whole rack and
    // shrink the tile below clickability — module-rename.spec.ts's numbers).
    await setFlowViewport(page, { x: 220 - 400 * 0.9, y: 120 - 300 * 0.9, zoom: 0.9 });

    // THE REAL RENAME GESTURE: click the tile's name, type, Enter.
    const tile = page.locator(`.svelte-flow__node[data-id="${srcId}"]`);
    const nameButton = tile.getByTestId('tile-name-label-button');
    await expect(nameButton).toBeVisible();
    await nameButton.click();
    const input = tile.getByTestId('tile-name-label-input');
    await expect(input).toBeVisible();
    await input.fill(NEW_NAME);
    await input.press('Enter');
    await expect(input).toHaveCount(0); // edit closed, rename accepted
    await expect(tile.getByTestId('tile-name-label-error')).toHaveCount(0);
    await expect(nameButton).toHaveText(NEW_NAME);

    // Patch renamed → target via the precise programmatic commit (the same
    // edge the drill-down picker writes; no preceding __handleConnectStart =
    // a PICK, not a drag — the proven pattern from rear-view-patching.spec).
    await page.evaluate(
      ({ srcId, dstId }) => {
        const w = globalThis as unknown as {
          __handleConnect: (c: {
            source: string;
            target: string;
            sourceHandle: string;
            targetHandle: string;
          }) => void;
        };
        w.__handleConnect({ source: srcId, target: dstId, sourceHandle: 'env', targetHandle: 'cv' });
      },
      { srcId, dstId },
    );
    await expect
      .poll(
        () =>
          page.evaluate(
            ({ srcId, dstId }) => {
              const w = globalThis as unknown as {
                __patch: {
                  edges: Record<
                    string,
                    | { source: { nodeId: string }; target: { nodeId: string } }
                    | undefined
                  >;
                };
              };
              return Object.values(w.__patch.edges).filter(
                (e) => e && e.source.nodeId === srcId && e.target.nodeId === dstId,
              ).length;
            },
            { srcId, dstId },
          ),
        { timeout: 5000 },
      )
      .toBe(1);

    // Open the TARGET's dock full-view and flip it to the rear card — the
    // owner's surface (same seam as workflow-rear-card.spec.ts).
    await page.evaluate(
      (id) => (globalThis as unknown as { __openDockFullView: (id: string) => void }).__openDockFullView(id),
      dstId,
    );
    const faceplate = page.getByTestId('dock-full-view');
    await expect(faceplate).toBeVisible();
    await pressFlipKey(page);
    await expect(faceplate).toHaveAttribute('data-flipped', 'true');

    const rear = faceplate.getByTestId('rear-card');
    await expect(rear).toBeVisible();
    const jack = rear.locator('[data-testid="back-jack"][data-port-id="cv"]');
    await expect(jack).toHaveAttribute('data-patched', 'true');

    // THE TOOLTIP — the exact surface of the owner's report. The rename,
    // verbatim; the port keeps its uppercase convention; arrow only.
    const title = await jack.getAttribute('title');
    expect(title, 'a patched hole must carry a remote title').toBeTruthy();
    expect(title!, `tooltip names the RENAME, got: ${title}`).toContain(`← ${NEW_NAME}.ENV`);
    expect(title!, 'no FROM word — arrow only (#2264)').not.toContain('FROM');
    expect(title!, 'a rename never needs a #N (unique by construction)').not.toContain('#');

    // THE CHIP — the painted "who is plugged in here" text.
    const chip = jack.locator('.ep');
    await expect(chip, `chip shows the rename, not the type label`).toHaveText(`← ${NEW_NAME}`);
  });
});
