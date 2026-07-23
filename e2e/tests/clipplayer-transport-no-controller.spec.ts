// e2e/tests/clipplayer-transport-no-controller.spec.ts
//
// P0 REGRESSION GUARD (#1165, PR feat/push2-control-phase1): the clip player's
// OWN card transport (the ▶/■ button → TIMELORDE.running) must START and STOP
// with NO Push / controller involved — and the Push 2 control integration (the
// module card's presence, or a bind→unbind of a Push) must NOT disable it.
//
// The Push 2 work injected an alternate control surface + (in the reverted
// c7d8e27c) a Y.Doc-`update` observer that repainted the shared launchpad-control
// render path on every write; the owner reported the clip player could no longer
// START transport from the card. This is the coverage that was missing: it drives
// the SAME seam the card's start/stop button calls (setNodeParam → the rack
// TIMELORDE's `running`) and asserts a full start↔stop cycle, first with no
// controller at all, then with the push2 module present, then after a Push
// bind+unbind.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

type W = {
  __patch: { nodes: Record<string, { type?: string; params?: Record<string, number> }> };
};

/** The rack TIMELORDE's `running` param — what the card transport writes. */
async function timelordeRunning(page: import('@playwright/test').Page): Promise<number | undefined> {
  return page.evaluate(() => {
    for (const n of Object.values((globalThis as unknown as W).__patch.nodes)) {
      if (n?.type === 'timelorde') return n.params?.running;
    }
    return undefined;
  });
}

/** Click the card transport button via a DOM dispatch (viewport-independent —
 *  the card may sit off the visible pane after a bare spawn). */
async function clickTransport(page: import('@playwright/test').Page, id: string): Promise<void> {
  await page.evaluate(
    (cpId) => (document.querySelector(`[data-testid="clipplayer-transport-${cpId}"]`) as HTMLButtonElement | null)?.click(),
    id,
  );
}

/** Spawn a clip player + a stopped TIMELORDE (the rack clock a fresh rack always
 *  has — auto-spawned dawless, or the workflow pinned clock), and open a clip. */
async function seedClipRack(page: import('@playwright/test').Page, extra: Parameters<typeof spawnPatch>[1] = []) {
  await spawnPatch(page, [
    { id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' },
    { id: 'tl', type: 'timelorde', position: { x: 80, y: 400 }, domain: 'audio', params: { running: 0 } },
    ...extra,
  ]);
  const card = page.locator('.svelte-flow__node-clipplayer');
  await expect(card).toHaveCount(1);
  // Make a clip: double-click lane-0 slot-0's launch pad.
  await card.locator('[data-clip="0"]').dblclick();
  const transport = page.getByTestId('clipplayer-transport-cp');
  await expect(transport).toBeVisible();
  return transport;
}

/** Assert a full START → STOP → START cycle from the card, with the button glyph
 *  tracking the state (▶ stopped, ■ running). TIMELORDE starts stopped (0). */
async function assertStartsAndStops(page: import('@playwright/test').Page, transport: import('@playwright/test').Locator) {
  expect(await timelordeRunning(page), 'seeded stopped').toBe(0);
  await expect(transport).toHaveText('▶');

  await clickTransport(page, 'cp'); // START
  await expect.poll(() => timelordeRunning(page)).toBe(1);
  await expect(transport).toHaveText('■');

  await clickTransport(page, 'cp'); // STOP
  await expect.poll(() => timelordeRunning(page)).toBe(0);
  await expect(transport).toHaveText('▶');

  await clickTransport(page, 'cp'); // START again
  await expect.poll(() => timelordeRunning(page)).toBe(1);
  await expect(transport).toHaveText('■');
}

test('card transport starts + stops with NO controller connected', async ({ page, rack }) => {
  const transport = await seedClipRack(page);
  await assertStartsAndStops(page, transport);
});

test('the mere presence of a push2Control module does NOT disable card transport', async ({ page, rack }) => {
  const transport = await seedClipRack(page, [
    { id: 'px', type: 'push2Control', position: { x: 520, y: 80 }, domain: 'meta' },
  ]);
  await expect(page.getByTestId('push2-control-card')).toHaveCount(1);
  await assertStartsAndStops(page, transport);
});

test('binding then unbinding a (simulated) Push leaves card transport working', async ({ page, rack }) => {
  const transport = await seedClipRack(page, [
    { id: 'px', type: 'push2Control', position: { x: 520, y: 80 }, domain: 'meta' },
  ]);

  // Bind a simulated Push to the clip player (injects the control surface).
  const installed = await page.evaluate(async () => {
    const w = globalThis as unknown as { __push2TestInstall?: (id: string) => Promise<boolean> };
    return w.__push2TestInstall ? await w.__push2TestInstall('cp') : false;
  });
  expect(installed, 'simulated Push install hook present (VITE_E2E_HOOKS)').toBe(true);

  // Unbind it via the card's Unbind button.
  const unbind = page.getByTestId('push2-control-bind');
  await expect(unbind).toHaveText(/Unbind/);
  await page.evaluate(() => (document.querySelector('[data-testid="push2-control-bind"]') as HTMLButtonElement | null)?.click());

  // The clip player's own transport still starts + stops from the card.
  await assertStartsAndStops(page, transport);
});
