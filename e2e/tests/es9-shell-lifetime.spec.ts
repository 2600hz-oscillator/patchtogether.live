// e2e/tests/es9-shell-lifetime.spec.ts
//
// THE ES-9 HARDWARE CONNECTION MUST OUTLIVE ITS CARD.
//
// Owner report 2026-08-05: under `?mode=workflow&shell=1` the ES-9 stopped
// sending data whenever its card was not expanded, because `Es9Card` built the
// bridge client on mount and disconnected it in `onDestroy` — the live hardware
// stream's lifetime was a Svelte component's lifetime.
//
// The first fix carved `es9` out of the shell swap so the card stayed in the
// lane permanently. That bought "always mounted" by surrendering both the
// compact tile and the dock EXPAND affordance, which the owner then rejected
// (2026-08-07): "i would like the card to just work normally: show as compact
// on screen but still work, expand to full view in dock".
//
// Ownership now sits on the ENGINE NODE ($lib/audio/es9/bridge-owner), so this
// spec asserts the shape that was previously impossible:
//   * `?shell=1` renders a COMPACT tile, not the full card;
//   * the bridge is owned ANYWAY — with no card mounted at all;
//   * EXPAND opens the dock full view, COLLAPSE closes it, and neither touches
//     the connection;
//   * deleting the NODE is the one thing that does release it.
//
// ⚠ SCOPE: this proves the connection's LIFETIME, not that audio flows — there
// is no ES-9 hardware or native helper on CI, so the bridge will sit
// disconnected. Lifetime is exactly the axis the bug was on; the transport is
// covered by es9-transport.test.ts.

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

const NODE = 'es9a';

/** Does the ENGINE own a bridge for this node? (Canvas test hook — the DOM
 *  cannot show this, which is the whole reason the bug was invisible.) */
async function bridgeOwned(page: Page): Promise<boolean> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as { __es9HasBridge?: (n: string) => boolean };
    return !!w.__es9HasBridge?.(id);
  }, NODE);
}

/** Is the real Es9Card mounted anywhere in the document? */
async function cardMounted(page: Page): Promise<boolean> {
  return (await page.locator(`[data-testid="es9-status-${NODE}"]`).count()) > 0;
}

/**
 * Is the module's own DOCK FULL-VIEW surface mounted anywhere?
 *
 * ⚠ THIS USED TO BE `cardMounted` AND HAD TO MOVE WHEN es9 WAS PROMOTED. The
 * dock full view renders `<ModuleShell view="dock-full">` for a migrated
 * module, so `Es9Card` is not what expands any more — the faceplate's own
 * extension body is. Re-pointing rather than deleting is the honest fix,
 * because the SUBJECT of the tests below is the connection's lifetime across
 * expand/collapse, and that subject is unchanged: it just needs a locator for
 * "the pane is open" that survives the promotion. The bridge lamp is that
 * locator — it mounts and unmounts with the pane, and nothing else does.
 */
async function faceBodyMounted(page: Page): Promise<boolean> {
  return (await page.locator(`[data-testid="es9-bridge-body-${NODE}"]`).count()) > 0;
}

async function spawnEs9(page: Page): Promise<void> {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: NODE, type: 'es9', position: { x: 140, y: 140 }, domain: 'audio' },
  ]);
  await expect.poll(() => bridgeOwned(page), { timeout: 10_000 }).toBe(true);
}

test('?shell=1 renders es9 COMPACT, and the bridge is owned with NO card mounted', async ({
  page,
  rack,
}) => {
  await spawnEs9(page);

  // The lane tile is a shell tile — NOT the legacy card. This is the half the
  // previous fix had to give up.
  //
  // ⚠ IT IS `moduleShell`, NOT `moduleShellPlaceholder`, SINCE THE PROMOTION,
  // and the difference is the whole point of it. A placeholder is a rackline
  // tile with ZERO ranked controls, so both connect gestures AND all 22
  // routing params lived behind the dock full view on a module that is silent
  // until one of them is pressed. es9 now declares a `face`, so the lane paints
  // `<ModuleShell>` with ranked cells — CONNECT first.
  const lane = page.locator(`.svelte-flow__node[data-id="${NODE}"]`);
  await expect(lane).toHaveCount(1);
  const laneClass = (await lane.getAttribute('class')) ?? '';
  expect(laneClass, 'es9 renders as a faced shell tile, not its legacy card').toContain(
    'moduleShell',
  );
  expect(
    laneClass,
    'and NOT the placeholder it rendered before promotion — the ranked cells are the point',
  ).not.toContain('moduleShellPlaceholder');

  // …and the connection exists regardless. Before this change the bridge could
  // not exist without a mounted card; now the card is not even rendered.
  expect(await cardMounted(page), 'no Es9Card is mounted in the lane').toBe(false);
  expect(await bridgeOwned(page), 'the ENGINE owns the bridge anyway').toBe(true);
});

test('EXPAND to dock then COLLAPSE does not touch the connection', async ({ page, rack }) => {
  await spawnEs9(page);

  // Open the dock full view (the same call the tile's EXPAND button makes).
  await page.evaluate((id) => {
    const w = globalThis as unknown as { __openDockFullView?: (n: string) => void };
    w.__openDockFullView?.(id);
  }, NODE);
  await expect.poll(() => faceBodyMounted(page), { timeout: 10_000 }).toBe(true);
  expect(await bridgeOwned(page), 'still owned while expanded').toBe(true);
  // ⚠ AND THE LEGACY CARD IS NOWHERE, which is the promotion's own claim and
  // the reason the locator above had to move. Asserted rather than assumed: if
  // the dock ever went back to mounting the card, the lifetime tests below
  // would still pass while measuring a different surface.
  expect(await cardMounted(page), 'the dock renders the FACE, not the card').toBe(false);

  // COLLAPSE — the exact gesture that used to kill the stream. ESC closes the
  // whole dock full view (Canvas's dock-key handler).
  await page.keyboard.press('Escape');
  await expect.poll(() => faceBodyMounted(page), { timeout: 10_000 }).toBe(false);

  expect(await bridgeOwned(page), 'THE BUG: collapsing must NOT drop the bridge').toBe(true);

  // Re-expanding must not open a SECOND client either (the native app accepts
  // one) — it simply finds the same owner.
  await page.evaluate((id) => {
    const w = globalThis as unknown as { __openDockFullView?: (n: string) => void };
    w.__openDockFullView?.(id);
  }, NODE);
  await expect.poll(() => faceBodyMounted(page), { timeout: 10_000 }).toBe(true);
  expect(await bridgeOwned(page)).toBe(true);
});

test('NEGATIVE CONTROL — deleting the NODE does release the bridge', async ({ page, rack }) => {
  // Without this, every assertion above would pass against an implementation
  // that simply never released anything.
  await spawnEs9(page);
  // Delete through the real store — the reconciler then disposes the engine
  // handle, which is the ONLY path that releases the bridge.
  await page.evaluate((id) => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, unknown> } };
    delete w.__patch.nodes[id];
  }, NODE);
  await expect
    .poll(() => bridgeOwned(page), { timeout: 10_000 })
    .toBe(false);
});

// The `preview OFF` leg (legacy card in-lane + bridge owned) was DELETED by
// the S2 inversion: its subject was the legacy renderer itself. The bridge's
// card-independence is pinned by the three tests above on the shell users get.
