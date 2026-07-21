// e2e/tests/patch-convenience.spec.ts
//
// Workflow-mode "Assign to channel N" — the folded-together right-click action,
// end-to-end against the live app + engine. One gesture does up to THREE things
// for channel N: assign the module to automation lane N (ALWAYS), wire the clip
// channel into it (if it is a playable instrument), and send its audio out to
// the mixer channel (if it has a main audio out). This is a LIGHT smoke: the
// unit layer (patch-convenience.test.ts) proves the per-shape edge sets for
// every module; here we prove the menu binding renders and the Canvas handler
// creates the real edges + the automation assignment.
//
// Eligibility is procedural (no allow-list): tidyvco is a poly INSTRUMENT with a
// stereo out (clip + mixer both apply → channel N wires BOTH); vca is an audio
// UTILITY with no note input (clip must NOT wire) but an audio out (mixer + auto).

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import type { Page } from '@playwright/test';

const CP = 'cp'; // clip player
const MX = 'mx'; // mixmaster
const TV = 'tv'; // tidyvco — poly instrument (clip + mixer)
const RV = 'rv'; // vca — audio utility (clip-ineligible; mixer + auto)

async function readEdges(page: Page): Promise<Record<string, { source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } }>> {
  return page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { edges: Record<string, unknown> } };
    return { ...w.__patch.edges } as Record<string, { source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } }>;
  });
}

/** The clip-player's module→lane automation assignment map. */
async function readAutoAssign(page: Page, playerId: string): Promise<Record<string, number>> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: { autoAssign?: Record<string, number> } }> } };
    return { ...(w.__patch.nodes[id]?.data?.autoAssign ?? {}) };
  }, playerId);
}

/** Right-click a node card to open its context menu. Uses the node wrapper's
 *  top-left corner (a stable, non-animated region). */
async function openNodeMenu(page: Page, nodeId: string): Promise<void> {
  await page
    .locator(`.svelte-flow__node[data-id="${nodeId}"]`)
    .click({ button: 'right', position: { x: 8, y: 8 } });
}

/** Open "Assign to channel ▸" and pick channel `ch` (0-based). */
async function assignToChannel(page: Page, ch: number): Promise<void> {
  const trigger = page.getByTestId('ctx-assign-channel');
  await expect(trigger).toBeVisible();
  await trigger.click();
  await page.getByTestId(`ctx-assign-channel-${ch}`).click();
}

test.beforeEach(async ({ page, rack }) => {
  void rack; // navigate to /rack (fixture) before bootstrapping the engine
  // TV and RV are RIGHT-CLICKED, so they go in the proven-clickable top band;
  // CP and MX are only referenced by testid in the (fixed-overlay) menu, which
  // scans ALL nodes regardless of viewport, so they can sit below the fold.
  await spawnPatch(page, [
    { id: TV, type: 'tidyVco', position: { x: 40, y: 40 }, domain: 'audio' },
    { id: RV, type: 'vca', position: { x: 40, y: 400 }, domain: 'audio' },
    { id: CP, type: 'clipplayer', position: { x: 760, y: 40 }, domain: 'audio' },
    { id: MX, type: 'mixmstrs', position: { x: 760, y: 400 }, domain: 'audio' },
  ]);
});

test('Assign to channel 1 on a both-directions instrument wires clip + mixer + automation', async ({ page }) => {
  await openNodeMenu(page, TV);
  await assignToChannel(page, 0); // channel 1 (0-based 0)

  // CLIP: the clip's channel-1 pitch/poly out (pitch1) now feeds the instrument.
  await expect
    .poll(async () => {
      const edges = Object.values(await readEdges(page));
      return edges.some((e) => e.source.nodeId === CP && e.source.portId === 'pitch1' && e.target.nodeId === TV);
    }, { timeout: 4000 })
    .toBe(true);

  // MIXER: the instrument's main out feeds BOTH mixer ch1 inputs (stereo pair).
  await expect
    .poll(async () => {
      const edges = Object.values(await readEdges(page));
      const toL = edges.some((e) => e.source.nodeId === TV && e.target.nodeId === MX && e.target.portId === 'ch1L');
      const toR = edges.some((e) => e.source.nodeId === TV && e.target.nodeId === MX && e.target.portId === 'ch1R');
      return toL && toR;
    }, { timeout: 4000 })
    .toBe(true);

  // AUTOMATION: the module is assigned to lane 0 (channel 1) on the clip player.
  await expect.poll(async () => (await readAutoAssign(page, CP))[TV], { timeout: 4000 }).toBe(0);
});

test('Assign to channel 1 on an audio utility (no note input) wires mixer + automation but NOT clip', async ({ page }) => {
  // Re-spawn WITHOUT the wide tidyvco so the vca is cleanly right-clickable.
  await spawnPatch(page, [
    { id: RV, type: 'vca', position: { x: 40, y: 40 }, domain: 'audio' },
    { id: CP, type: 'clipplayer', position: { x: 760, y: 40 }, domain: 'audio' },
    { id: MX, type: 'mixmstrs', position: { x: 760, y: 400 }, domain: 'audio' },
  ]);
  await openNodeMenu(page, RV);
  await expect(page.locator('.ctx-header')).toContainText('vca');
  await assignToChannel(page, 0);

  // MIXER: the vca out feeds both mixer ch1 inputs.
  await expect
    .poll(async () => {
      const edges = Object.values(await readEdges(page));
      const toL = edges.some((e) => e.source.nodeId === RV && e.target.nodeId === MX && e.target.portId === 'ch1L');
      const toR = edges.some((e) => e.source.nodeId === RV && e.target.nodeId === MX && e.target.portId === 'ch1R');
      return toL && toR;
    }, { timeout: 4000 })
    .toBe(true);

  // AUTOMATION assigned…
  await expect.poll(async () => (await readAutoAssign(page, CP))[RV], { timeout: 4000 }).toBe(0);

  // …but NO clip edge into the vca (it has no note input → clip is skipped).
  const edges = Object.values(await readEdges(page));
  expect(edges.some((e) => e.source.nodeId === CP && e.target.nodeId === RV)).toBe(false);
});

test('Assign automation only assigns the lane WITHOUT any clip/mixer wiring', async ({ page }) => {
  await openNodeMenu(page, TV);
  const trigger = page.getByTestId('ctx-assign-auto-only');
  await expect(trigger).toBeVisible();
  await trigger.click();
  await page.getByTestId('ctx-assign-auto-only-1').click(); // channel 2 (lane 1)

  // AUTOMATION assigned to lane 1…
  await expect.poll(async () => (await readAutoAssign(page, CP))[TV], { timeout: 4000 }).toBe(1);

  // …and NO convenience edges were created (neither clip nor mixer).
  const edges = Object.values(await readEdges(page));
  expect(edges.some((e) => e.source.nodeId === CP && e.target.nodeId === TV)).toBe(false);
  expect(edges.some((e) => e.source.nodeId === TV && e.target.nodeId === MX)).toBe(false);
});
