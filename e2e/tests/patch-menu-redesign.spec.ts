// e2e/tests/patch-menu-redesign.spec.ts
//
// Behavior coverage for the redesigned patch-menu interaction (UX rewrite):
//
//   1. The menu EDGE-ALIGNS to the card side it opened from. Right trigger →
//      menu's RIGHT edge ≈ card's RIGHT edge (never spilling past it). Left
//      trigger → menu's LEFT edge ≈ card's LEFT edge.
//   2. Drilling into INPUT overlay-REPLACES the root in the SAME vertical
//      spot (root hides; nothing stacks). A back affordance returns.
//   3. Left-clicking a port ROW (a "jack") spawns a dangling cursor-following
//      cable AND surfaces a "patch to" entry. Panning keeps the cable
//      following (click-carry, not drag).
//   4. With a cable carried: click "patch to" → click a target module →
//      click a VALID port → the edge materialises in the patch graph.
//   5. An INVALID carry-commit (output→output) makes no edge and closes
//      everything SILENTLY.
//   6. Esc mid-carry discards the cable + closes the menu.
//
// The chrome is body-portaled, so the open panel lives at
// [data-patch-panel-chrome="<nodeId>"] / [data-testid="patch-panel"], NOT
// inside the card node. Selectors here target the portaled chrome by node id.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

interface PatchEdge {
  id: string;
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
}

async function readEdges(page: Page): Promise<PatchEdge[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __patch: { edges: Record<string, PatchEdge> } };
    return Object.values(w.__patch.edges).filter(Boolean) as PatchEdge[];
  });
}

/** The portaled chrome for a given source node. */
function chrome(page: Page, nodeId: string) {
  return page.locator(`[data-patch-panel-chrome="${nodeId}"]`);
}

/** Open the panel from a given trigger side. */
async function openFrom(page: Page, nodeId: string, side: 'left' | 'right') {
  const testid = side === 'left' ? 'patch-trigger' : 'patch-trigger-right';
  await page
    .locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="${testid}"]`)
    .click();
  await expect(chrome(page, nodeId)).toHaveAttribute('aria-hidden', 'false');
}

async function spawnSeqAdsr(page: Page) {
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'seq', type: 'kria', position: { x: 80, y: 120 } },
    // ⚠ x clears KRIA's card, MEASURED at 755 px wide (the deleted SEQUENCER
    // card was far narrower). At x:760 the kria card covered this node and
    // intercepted its clicks. Do not tighten without re-measuring.
    { id: 'adsr', type: 'adsr', position: { x: 900, y: 120 } },
  ]);
}

// ── (1) edge-alignment ──────────────────────────────────────────────────

test('the rail trigger anchors the menu BESIDE the tile — top-aligned, never covering it', async ({ page }) => {
  // ⚠ The card's left/right corner-trigger edge-alignment claims died with
  // the card (one rail trigger on the shell — see patch-panel.spec.ts's
  // header + the S2 manifest). The shell contract, measured: the portaled
  // menu opens ADJACENT to the tile's left edge, top-aligned, so it never
  // hides the tile it patches.
  await spawnSeqAdsr(page);
  await openFrom(page, 'adsr', 'left');

  const card = await page
    .locator('.svelte-flow__node[data-id="adsr"]')
    .boundingBox();
  const menu = await chrome(page, 'adsr').boundingBox();
  expect(card).toBeTruthy();
  expect(menu).toBeTruthy();
  if (!card || !menu) return;

  // Beside, not over: the menu's right edge lands at (or left of) the tile's
  // left edge, within a small gutter.
  expect(menu.x + menu.width).toBeLessThanOrEqual(card.x + 1);
  expect(card.x - (menu.x + menu.width), 'flush beside the tile, not floating away').toBeLessThanOrEqual(24);
  // Top-aligned with the tile.
  expect(Math.abs(menu.y - card.y)).toBeLessThanOrEqual(4);
});

// ── (2) overlay-replace drill ────────────────────────────────────────────

test('clicking INPUT overlay-replaces root at the same top (root hidden)', async ({
  page,
}) => {
  await spawnSeqAdsr(page);
  await openFrom(page, 'adsr', 'left');

  const root = chrome(page, 'adsr').locator('[data-testid="patch-panel-root"]');
  await expect(root).toBeVisible();
  const rootTop = (await chrome(page, 'adsr').boundingBox())!.y;

  // Drill into INPUT.
  await chrome(page, 'adsr')
    .locator('[data-testid="patch-panel-nav"][data-nav="inputs"]')
    .click();

  // Root is gone; the inputs view replaces it.
  await expect(root).toHaveCount(0);
  const inputs = chrome(page, 'adsr').locator('[data-testid="patch-panel-inputs"]');
  await expect(inputs).toBeVisible();
  // ADSR's input labels are present.
  const labels = await inputs
    .locator('[data-testid="port-row-label"]')
    .allTextContents();
  expect(labels.map((s) => s.trim())).toContain('ATTACK');

  // Replaced in the SAME vertical spot (chrome top unchanged within a few px).
  const drilledTop = (await chrome(page, 'adsr').boundingBox())!.y;
  expect(Math.abs(drilledTop - rootTop)).toBeLessThanOrEqual(6);

  // Back returns to root.
  await chrome(page, 'adsr').locator('[data-testid="patch-panel-back"]').click();
  await expect(
    chrome(page, 'adsr').locator('[data-testid="patch-panel-root"]'),
  ).toBeVisible();
});

// ── (3) jack-click → dangling cable + patch-to; pan keeps the cable ──────

test('jack-click spawns a dangling cable + shows "patch to"; pan keeps the cable', async ({
  page,
}) => {
  await spawnSeqAdsr(page);
  await openFrom(page, 'seq', 'left');

  // Drill into OUTPUT and click the gate output row (the "jack").
  await chrome(page, 'seq')
    .locator('[data-testid="patch-panel-nav"][data-nav="outputs"]')
    .click();
  await chrome(page, 'seq')
    .locator('[data-testid="patch-panel-port-row"][data-port-id="gate1"]')
    .click();

  // A cable now dangles from the cursor.
  // Nudge the cursor so PickupCable has a cursor point to draw to.
  await page.mouse.move(500, 300);
  await expect(page.locator('[data-testid="pickup-cable"]')).toBeVisible();

  // The source panel surfaces a "patch to" entry (carry mode, root view).
  await expect(
    chrome(page, 'seq').locator('[data-testid="patch-panel-patch-to"]'),
  ).toBeVisible();

  // Pan the canvas — the cable still follows (click-carry, not drag).
  await page.mouse.move(600, 400);
  await expect(page.locator('[data-testid="pickup-cable"]')).toBeVisible();
});

// ── (4) carry → patch-to → module → valid port → edge materialises ───────

test('carry → patch to → target module → valid port commits the edge', async ({
  page,
}) => {
  await spawnSeqAdsr(page);
  await openFrom(page, 'seq', 'left');

  await chrome(page, 'seq')
    .locator('[data-testid="patch-panel-nav"][data-nav="outputs"]')
    .click();
  await chrome(page, 'seq')
    .locator('[data-testid="patch-panel-port-row"][data-port-id="gate1"]')
    .click();
  await page.mouse.move(500, 300);

  // Click "patch to" → the picker takes over; the dangling cable hides.
  await chrome(page, 'seq').locator('[data-testid="patch-panel-patch-to"]').click();
  await expect(page.locator('[data-testid="port-context-menu"]')).toBeVisible();
  await expect(page.locator('[data-testid="pickup-cable"]')).toHaveCount(0);

  // Pick ADSR → its gate input.
  await page.locator('[data-testid="patch-to-module"][data-node-id="adsr"]').click();
  await page.locator('[data-testid="patch-to-port"][data-port-id="gate"]').click();

  // Menu closes; the edge exists.
  await expect(page.locator('[data-testid="port-context-menu"]')).toHaveCount(0);
  await expect
    .poll(async () => (await readEdges(page)).length, { timeout: 2000 })
    .toBe(1);
  const edges = await readEdges(page);
  expect(edges[0]!.source).toEqual({ nodeId: 'seq', portId: 'gate1' });
  expect(edges[0]!.target).toEqual({ nodeId: 'adsr', portId: 'gate' });
});

// ── (5) invalid carry-commit (output→output) → no edge, silent close ─────

test('invalid carry-commit (output→output) makes no edge + closes silently', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'lfo', type: 'lfo', position: { x: 80, y: 120 } },
    { id: 'osc', type: 'analogVco', position: { x: 760, y: 120 } },
  ]);

  // Carry an OUTPUT cable from LFO.phase0.
  await openFrom(page, 'lfo', 'left');
  await chrome(page, 'lfo')
    .locator('[data-testid="patch-panel-nav"][data-nav="outputs"]')
    .click();
  await chrome(page, 'lfo')
    .locator('[data-testid="patch-panel-port-row"][data-port-id="phase0"]')
    .click();
  await page.mouse.move(500, 300);
  await expect(page.locator('[data-testid="pickup-cable"]')).toBeVisible();

  // Navigate to the VCO panel + drill into its OUTPUT submenu, then click a
  // VCO OUTPUT row while still carrying — output→output is INVALID. (UX item
  // 5: "click a panel → click submenu → click an INVALID point".)
  await openFrom(page, 'osc', 'left');
  await chrome(page, 'osc')
    .locator('[data-testid="patch-panel-nav"][data-nav="outputs"]')
    .click();
  // analogVco's main audio output row.
  await chrome(page, 'osc')
    .locator('[data-testid="patch-panel-port-row"][data-direction="output"]')
    .first()
    .click();

  // Cable + menus vanish; NO edge; silent (no toast surfaced).
  await expect(page.locator('[data-testid="pickup-cable"]')).toHaveCount(0);
  await expect(chrome(page, 'osc')).toHaveCount(0);
  await expect(page.locator('[data-testid="port-context-menu"]')).toHaveCount(0);
  expect((await readEdges(page)).length).toBe(0);
});

// ── (6) Esc mid-carry discards ───────────────────────────────────────────

test('Esc mid-carry discards the cable + closes the menu', async ({ page }) => {
  await spawnSeqAdsr(page);
  await openFrom(page, 'seq', 'left');

  await chrome(page, 'seq')
    .locator('[data-testid="patch-panel-nav"][data-nav="outputs"]')
    .click();
  await chrome(page, 'seq')
    .locator('[data-testid="patch-panel-port-row"][data-port-id="gate1"]')
    .click();
  await page.mouse.move(500, 300);
  await expect(page.locator('[data-testid="pickup-cable"]')).toBeVisible();

  await page.keyboard.press('Escape');

  await expect(page.locator('[data-testid="pickup-cable"]')).toHaveCount(0);
  await expect(chrome(page, 'seq')).toHaveCount(0);
  expect((await readEdges(page)).length).toBe(0);
});
