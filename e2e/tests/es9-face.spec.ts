// e2e/tests/es9-face.spec.ts
//
// THE ES-9 FACE, driven for real — and specifically the seams no other gate can
// see.
//
// `es9-face-model.test.ts` pins the ranking, the roster, the cluster shapes and
// every string the lamps can produce, painted or not.
// `face-rack-status-source.test.ts` proves the body declares what it paints.
// `faces-parity` proves every cell OPERATES.
// `workflow-shell-faces` photographs the plate.
//
// None of them can see:
//
//  1. THAT THE MEASUREMENTS SURVIVED THE MOVE. The resting-text ruling deleted
//     four readouts off this card — a state word, a rate/channel/round-trip row,
//     an xrun count and a CV-Buddy jack list — and sent them to `aria-label`.
//     A source gate cannot tell whether they survived; a unit test proves the
//     STRINGS exist but not that anything renders them. Here the DOM is asked
//     for BOTH halves: the painted text carries no measurement, the accessible
//     name does.
//  2. ⚠ THAT THE CV BUDDY LAMP CAN MOVE. Every other assertion in this file
//     observes it DARK, which is what an indicator that is dark in every
//     reachable state also looks like. A passing negative control proves the
//     probe can be read, not that it reads the right thing — so this file
//     spawns a real CV Buddy and watches the lamp light.
//  3. THAT BOTH GESTURES ARE ON THE LANE TILE. `curatedFace` deciding a key
//     survives the compact tier is a statement about the resolver; that the
//     button is in the DOM of a lane tile is a statement about the renderer,
//     and it is the whole practical argument for this promotion.
//
// Runs on /rack (no DB, no relay). The faceplate shell is the DEFAULT rack.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;

const NODE = 'es9f';

async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({
    timeout: SLOW_RENDER ? 30_000 : 15_000,
  });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** Open this node's dock faceplate, scoped by `data-shell-node` so a later
 *  swap of the dock's occupant cannot leave a stale locator asserting on
 *  someone else's plate. */
async function openDock(page: Page, nodeId: string): Promise<Locator> {
  const shell = page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`);
  await expect(shell).toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const dockShell = page
    .getByTestId('dock-full-view')
    .locator(`[data-testid="module-shell"][data-shell-tier="dock"][data-shell-node="${nodeId}"]`);
  await expect(dockShell).toBeVisible();
  return dockShell;
}

test.describe('ES-9 face — the bridge status strip', () => {
  test('all three lamps are DARK with no helper, and each CARRIES its deleted readout', async ({
    page,
  }) => {
    await gotoShell(page);
    await spawnPatch(page, [{ id: NODE, type: 'es9', position: { x: 120, y: 120 } }]);
    const dock = await openDock(page, NODE);

    const body = dock.getByTestId(`es9-bridge-body-${NODE}`);
    await expect(body).toBeVisible();

    // ── the lamps, and the sentences they carry ──────────────────────────
    //
    // No CI runner has an es9-bridge process listening on localhost, which is
    // the whole reason this module exists — so the link is down, no meters
    // arrive and no CV Buddy is in the rack. All three dark is the correct
    // resting state, and the SENTENCES are where the four deleted readouts
    // went.
    const bridge = dock.getByTestId(`es9-led-bridge-${NODE}`);
    await expect(bridge).toHaveAttribute('data-lit', '0');
    await expect(bridge, 'the state word became a sentence on the lamp').toHaveAttribute(
      'aria-label',
      /no es9-bridge app answered/i,
    );
    // `StatusLed` binds `title` as well as `aria-label`, which is what makes
    // hovering name the exact failure a two-state lamp cannot show.
    await expect(bridge).toHaveAttribute('title', /ws:\/\//);

    const xrun = dock.getByTestId(`es9-led-xrun-${NODE}`);
    await expect(xrun).toHaveAttribute('data-lit', '0');
    await expect(xrun, 'the xrun COUNT became a sentence').toHaveAttribute(
      'aria-label',
      /nothing is being measured/i,
    );

    const cvb = dock.getByTestId(`es9-led-cvbuddy-${NODE}`);
    await expect(cvb).toHaveAttribute('data-lit', '0');
    await expect(cvb, 'the jack LIST became a sentence').toHaveAttribute(
      'aria-label',
      /no CV Buddy/i,
    );

    // ── and NONE of it paints ────────────────────────────────────────────
    //
    // The other half of the same claim, and the one a source gate is blind to.
    // The plate may paint the module NAME, section labels, control captions and
    // option names — never a measurement. `kHz`, `ms`, a `u/o` pair and a bare
    // decimal are the four shapes the deleted rows had.
    //
    // ⚠ THE XRUN CHECK IS `xrun` FOLLOWED BY A NUMBER, NOT `xrun`. The word
    // itself is a lamp CAPTION, which is permitted and is painted deliberately
    // — a lamp present and dark says "healthy" where the card's `0/0` had to
    // argue that a zero must always render. What may not paint is the COUNT.
    const painted = (await dock.innerText()).replace(/\s+/g, ' ');
    expect(painted, 'no rate').not.toMatch(/kHz/i);
    expect(painted, 'no round-trip').not.toMatch(/\bms\b/i);
    expect(painted, 'no xrun COUNT (the caption is fine)').not.toMatch(/xruns?\s*[\d(]/i);
    expect(painted, 'no under/over pair').not.toMatch(/\b\d+\s*\/\s*\d+\b/);
    expect(painted, 'no channel count').not.toMatch(/16×16/);
    expect(painted, 'no decimal anywhere on the plate').not.toMatch(/\d+\.\d/);
    // POSITIVE CONTROL for the same read: the plate DID paint the things it
    // should, so the absences above are not an empty element.
    expect(painted).toMatch(/BRIDGE/);
    expect(painted).toMatch(/OUT JACKS/i);
    expect(painted).toMatch(/AUDIO/);
  });

  test('⚠ POSITIVE CONTROL — a real CV Buddy LIGHTS the claim lamp', async ({ page }) => {
    // Every other assertion in this file observes that lamp dark. An indicator
    // that is dark in every reachable state is decoration, and its `aria-label`
    // is where the whole reason for the lamp lives: those jacks' out-class is
    // owned by a reconciler, so a change made in the OUT band is reverted.
    await gotoShell(page);
    await spawnPatch(page, [{ id: NODE, type: 'es9', position: { x: 120, y: 120 } }]);
    const dock = await openDock(page, NODE);
    const cvb = dock.getByTestId(`es9-led-cvbuddy-${NODE}`);
    await expect(cvb).toHaveAttribute('data-lit', '0');

    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __setSpawnFlowPos: (p: { x: number; y: number }) => void;
        __spawnFromPalette: (t: string) => void;
      };
      w.__setSpawnFlowPos({ x: 600, y: 400 });
      w.__spawnFromPalette('cvBuddy');
    });

    // Auto-retrying: the assertion IS the wait, so there is no wall-clock
    // budget to tune per renderer.
    await expect(cvb, 'a CV Buddy in the rack claims out jacks').toHaveAttribute('data-lit', '1');
    await expect(cvb).toHaveAttribute('aria-label', /driving out jacks/i);
    await expect(cvb, 'and it says the claimed cells will be reverted').toHaveAttribute(
      'aria-label',
      /reverted/i,
    );
  });
});

test.describe('ES-9 face — the gestures reach the LANE TILE', () => {
  test('CONNECT and DISCONNECT are in the lane tile DOM, not only the dock', async ({ page }) => {
    // ⚠ THE PRACTICAL ARGUMENT FOR THIS PROMOTION, asserted at the RENDERER.
    // Before it, `laneRenderKind` gave es9 a placeholder — a rackline tile with
    // ZERO ranked controls — so both gestures AND all 22 routing params were
    // reachable only by first discovering that the dock full view exists, on a
    // module that is silent until the helper answers.
    await gotoShell(page);
    await spawnPatch(page, [{ id: NODE, type: 'es9', position: { x: 120, y: 120 } }]);

    const lane = page.locator(`.svelte-flow__node[data-id="${NODE}"]`);
    await expect(lane).toHaveCount(1);
    await expect(
      lane.getByTestId('shell-cell-es9-connect'),
      'the gesture the module is silent without must be ON the tile',
    ).toHaveCount(1);
    await expect(lane.getByTestId('shell-cell-es9-disconnect')).toHaveCount(1);

    // NEGATIVE CONTROL for the same read: the tile does NOT carry all 24 keys —
    // the tier caps are geometry, so a lane tile showing everything would make
    // the assertion above true for any ranking at all.
    await expect(
      lane.getByTestId('control-in14_class'),
      'the ranked-last key is a DOCK control',
    ).toHaveCount(0);
  });
});
