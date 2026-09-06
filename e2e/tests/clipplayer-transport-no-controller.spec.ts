// e2e/tests/clipplayer-transport-no-controller.spec.ts
//
// P0 REGRESSION GUARD (#1165, PR feat/push2-control-phase1): the clip player's
// OWN on-screen transport (the ▶/■ button → TIMELORDE.running) must START and
// STOP with NO Push / controller involved — and the Push 2 control integration
// (the module's presence, or a bind→unbind of a Push) must NOT disable it.
//
// The Push 2 work injected an alternate control surface + (in the reverted
// c7d8e27c) a Y.Doc-`update` observer that repainted the shared launchpad-control
// render path on every write; the owner reported the clip player could no longer
// START transport from its own surface. This is the coverage that was missing:
// it drives the SAME seam the deck's start/stop button calls (setNodeParam → the
// rack TIMELORDE's `running`) and asserts a full start↔stop cycle, first with no
// controller at all, then with the push2 module present, then after a Push
// bind+unbind. On the default shell the transport button lives in the clip
// player's DOCK deck; the Push unbind lives in the push2 dock surface body.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

type W = {
  __patch: { nodes: Record<string, { type?: string; params?: Record<string, number> }> };
  __openDockFullView?: (id: string) => void;
};

/** The rack TIMELORDE's `running` param — what the deck transport writes. */
async function timelordeRunning(page: import('@playwright/test').Page): Promise<number | undefined> {
  return page.evaluate(() => {
    for (const n of Object.values((globalThis as unknown as W).__patch.nodes)) {
      if (n?.type === 'timelorde') return n.params?.running;
    }
    return undefined;
  });
}

/** Click the deck transport button via a DOM dispatch (scroll-independent —
 *  the deck row may sit below the dock's fold). */
async function clickTransport(page: import('@playwright/test').Page, id: string): Promise<void> {
  await page.evaluate(
    (cpId) => (document.querySelector(`[data-testid="clipplayer-transport-${cpId}"]`) as HTMLButtonElement | null)?.click(),
    id,
  );
}

/** Spawn a clip player + a stopped TIMELORDE (the rack clock a fresh rack always
 *  has — the auto-spawned canvas one, or the pinned clock), open the clip
 *  player's dock, and bind a clip. */
async function seedClipRack(page: import('@playwright/test').Page, extra: Parameters<typeof spawnPatch>[1] = []) {
  await spawnPatch(page, [
    { id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' },
    { id: 'tl', type: 'timelorde', position: { x: 80, y: 400 }, domain: 'audio', params: { running: 0 } },
    ...extra,
  ]);
  const tile = page.locator('.svelte-flow__node[data-id="cp"] [data-testid="module-shell"]');
  await expect(tile).toBeVisible();
  await tile.getByTestId('shell-open-dock').click();
  const dock = page.getByTestId('dock-full-view');
  await expect(dock).toBeVisible();
  // Make a clip: double-click lane-0 slot-0's launch pad.
  await dock.locator('[data-clip="0"]').dblclick();
  const transport = dock.getByTestId('clipplayer-transport-cp');
  await transport.scrollIntoViewIfNeeded();
  await expect(transport).toBeVisible();
  return transport;
}

/** Assert a full START → STOP → START cycle from the deck, with the button glyph
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

// ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body was re-pointed at the
// dock full view by the S2 legacy-removal inversion (same seam, shell surface).
// NONDETERMINISM: 9 recovered-on-retry observation(s) across 9 SHA(s) / 5 branch(es) in the
// 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
// LOST WHILE PARKED: the #1165 P0 regression guard: the clip player's own transport must work with NO Push or controller present — the owner-reported break a controller integration caused.
// Re-enable only on a root cause (#1847); "it passes now" is not one.
test.fixme('deck transport starts + stops with NO controller connected', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 9 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page, rack }) => {
  const transport = await seedClipRack(page);
  await assertStartsAndStops(page, transport);
});

// ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body was re-pointed at the
// dock full view by the S2 legacy-removal inversion (same seam, shell surface).
// NONDETERMINISM: 9 recovered-on-retry observation(s) across 9 SHA(s) / 5 branch(es) in the
// 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
// LOST WHILE PARKED: the negative leg of #1165 — spawning a push2Control module must not disable the clip player's start/stop, which is precisely how the original defect manifested.
// Re-enable only on a root cause (#1847); "it passes now" is not one.
test.fixme('the mere presence of a push2Control module does NOT disable deck transport', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 9 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page, rack }) => {
  const transport = await seedClipRack(page, [
    { id: 'px', type: 'push2Control', position: { x: 520, y: 80 }, domain: 'meta' },
  ]);
  await expect(
    page.locator('.svelte-flow__node:has([data-shell-type="push2Control"])'),
  ).toHaveCount(1);
  await assertStartsAndStops(page, transport);
});

test('binding then unbinding a (simulated) Push leaves deck transport working', async ({ page, rack }) => {
  const transport = await seedClipRack(page, [
    { id: 'px', type: 'push2Control', position: { x: 520, y: 80 }, domain: 'meta' },
  ]);

  // Bind a simulated Push to the clip player (injects the control surface).
  const installed = await page.evaluate(async () => {
    const w = globalThis as unknown as { __push2TestInstall?: (id: string) => Promise<boolean> };
    return w.__push2TestInstall ? await w.__push2TestInstall('cp') : false;
  });
  expect(installed, 'simulated Push install hook present (VITE_E2E_HOOKS)').toBe(true);

  // Unbind it via the push2 dock surface's Bind button (a second dock pane —
  // the dock supports one per node, and testids are node-scoped).
  await page.evaluate(() => (globalThis as unknown as W).__openDockFullView?.('px'));
  const pxPane = page.locator('[data-testid="dock-fullview-pane"][data-pane-node="px"]');
  await expect(pxPane).toBeVisible();
  const unbind = pxPane.getByTestId('push2-face-bind-px');
  await expect(unbind).toHaveText(/Unbind/);
  await page.evaluate(() => (document.querySelector('[data-testid="push2-face-bind-px"]') as HTMLButtonElement | null)?.click());

  // The clip player's own transport still starts + stops from its deck.
  await assertStartsAndStops(page, transport);
});
