// e2e/tests/patch-convenience.spec.ts
//
// Workflow-mode right-click convenience actions, end-to-end against the live
// app + engine. Asserts the owner's hard requirement: the option APPEARS and
// WORKS for an eligible module AND is ABSENT for an ineligible one — proving the
// menu binding renders and the Canvas wiring creates the real edges (the unit
// layer, patch-convenience.test.ts, already proves the eligibility predicate
// for every module).
//
// Eligibility is procedural (no allow-list): tidyvco is a poly INSTRUMENT
// (Control-from-Clip + Send-to-Mixer both apply); vca is an audio UTILITY with
// no note input (Control-from-Clip must NOT appear) but an audio out
// (Send-to-Mixer applies).

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import type { Page } from '@playwright/test';

const CP = 'cp'; // clip player
const MX = 'mx'; // mixmaster
const TV = 'tv'; // tidyvco — poly instrument
const RV = 'rv'; // vca — audio utility (no note input → clip-ineligible; audio out → mixer-eligible)

async function readEdges(page: Page): Promise<Record<string, { source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } }>> {
  return page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { edges: Record<string, unknown> } };
    return { ...w.__patch.edges } as Record<string, { source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } }>;
  });
}

/** Right-click a node card to open its context menu. Uses the node wrapper's
 *  top-left corner (a stable, non-animated region). */
async function openNodeMenu(page: Page, nodeId: string): Promise<void> {
  await page
    .locator(`.svelte-flow__node[data-id="${nodeId}"]`)
    .click({ button: 'right', position: { x: 8, y: 8 } });
}

test.beforeEach(async ({ page, rack }) => {
  void rack; // navigate to /rack (fixture) before bootstrapping the engine
  // Only TV and RV are RIGHT-CLICKED, so they go in the proven-clickable top
  // band; CP and MX are only referenced by testid in the (fixed-overlay) menu,
  // which scans ALL nodes regardless of viewport, so they can sit below the fold
  // (Playwright can't scroll the transformed SvelteFlow canvas to click them).
  // TV and RV are RIGHT-CLICKED — stack them vertically at the same x with a
  // generous gap so the WIDE tidyvco card can't overlap the vca beneath it (an
  // overlapping card's header intercepts the click). CP and MX are only
  // referenced by testid in the fixed-overlay menu, so their position/overlap
  // is irrelevant — park them off to the right.
  await spawnPatch(page, [
    { id: TV, type: 'tidyVco', position: { x: 40, y: 40 }, domain: 'audio' },
    { id: RV, type: 'vca', position: { x: 40, y: 400 }, domain: 'audio' },
    { id: CP, type: 'clipplayer', position: { x: 760, y: 40 }, domain: 'audio' },
    { id: MX, type: 'mixmstrs', position: { x: 760, y: 400 }, domain: 'audio' },
  ]);
});

test('Control-from-Clip APPEARS on an instrument and wires the clip channel into it', async ({ page }) => {
  await openNodeMenu(page, TV);
  // The menu item exists (tidyvco is clip-eligible + a clip-player is present).
  const trigger = page.getByTestId(`ctx-clipcontrol-${CP}`);
  await expect(trigger).toBeVisible();
  await trigger.click();
  // Pick channel 1 (0-based index 0).
  await page.getByTestId(`ctx-clipcontrol-${CP}-channel-0`).click();

  // HARD STATE ASSERTION: an edge now runs from the clip's channel-1 pitch/poly
  // out (pitch1) INTO the tidyvco node (poly instrument → one poly edge).
  await expect
    .poll(async () => {
      const edges = Object.values(await readEdges(page));
      return edges.some(
        (e) => e.source.nodeId === CP && e.source.portId === 'pitch1' && e.target.nodeId === TV,
      );
    }, { timeout: 4000 })
    .toBe(true);
});

test('Send-to-Mixer APPEARS on an audio module and wires its out into the mixer channel', async ({ page }) => {
  await openNodeMenu(page, TV);
  const trigger = page.getByTestId(`ctx-sendtomixer-${MX}`);
  await expect(trigger).toBeVisible();
  await trigger.click();
  await page.getByTestId(`ctx-sendtomixer-${MX}-channel-0`).click();

  // HARD STATE ASSERTION: the module's main out feeds BOTH mixer ch1 inputs
  // (ch1L + ch1R — stereo pair, or a mono out filling both).
  await expect
    .poll(async () => {
      const edges = Object.values(await readEdges(page));
      const toL = edges.some((e) => e.source.nodeId === TV && e.target.nodeId === MX && e.target.portId === 'ch1L');
      const toR = edges.some((e) => e.source.nodeId === TV && e.target.nodeId === MX && e.target.portId === 'ch1R');
      return toL && toR;
    }, { timeout: 4000 })
    .toBe(true);
});

test('Control-from-Clip is ABSENT on an audio utility with no note input (but Send-to-Mixer still appears)', async ({ page }) => {
  // Re-spawn WITHOUT the wide tidyvco card so the vca is the only thing top-left
  // and is cleanly right-clickable (spawnPatch clears + rebuilds the patch).
  await spawnPatch(page, [
    { id: RV, type: 'vca', position: { x: 40, y: 40 }, domain: 'audio' },
    { id: CP, type: 'clipplayer', position: { x: 760, y: 40 }, domain: 'audio' },
    { id: MX, type: 'mixmstrs', position: { x: 760, y: 400 }, domain: 'audio' },
  ]);
  await openNodeMenu(page, RV);
  // Confirm the menu that opened is actually vca's (not a stray node).
  await expect(page.locator('.ctx-header')).toContainText('vca');
  // vca has no pitch/poly/note-gate input → NOT clip-eligible → no item.
  await expect(page.getByTestId(`ctx-clipcontrol-${CP}`)).toHaveCount(0);
  // vca DOES have an audio out → Send-to-Mixer IS offered.
  await expect(page.getByTestId(`ctx-sendtomixer-${MX}`)).toBeVisible();
});
