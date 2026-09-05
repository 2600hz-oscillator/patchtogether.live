// e2e/tests/foxy-face-surface.spec.ts
//
// THE FOXY FACEPLATE — the surface promotion actually ships, and the three
// affordances that reach it only through the `fullViewBody` shell extension.
//
// ⚠ WHY THIS FILE EXISTS, and it is the #1929/#1934 lesson applied BEFORE the
// fact rather than after it. foxy already had two e2e specs and BOTH stay green
// through this promotion — `foxy.spec.ts` and
// `foxy-freeze-locks-wavetable.spec.ts` were written against the PRE-PROMOTION
// surface, which is precisely the one promotion does NOT change. The second is
// described
// in its own header as the parity proof for the FREEZE toggles and the EXPORT
// button; after promotion it proves those things about a card that neither
// default surface renders any more (`DockFullView.svelte` mounts `<ModuleShell>`
// once `migrated()` is true). Nothing goes red. The coverage simply stops
// pointing at what users see — "a gate whose precondition is the defect cannot
// fail on the defect", one step upstream.
//
// So this file tests the FACE. The older specs were KEPT rather than replaced:
// deleting them would have traded one blind spot for another.
//
// ⚠ WHAT IS DELIBERATELY *NOT* HERE. The claim that foxy KEEPS BUILDING while
// SCREEN is off cannot be observed from this side: the rasters advance inside
// the engine handle's `read()` seam, and any probe that injects a promise onto
// the page's main thread competes with the very loop it is measuring — the
// starvation class that produced 0.0000 readings elsewhere in this suite. That
// invariant is asserted at SOURCE in `foxy-face-model.test.ts` ("reads the tick
// BEFORE the collapse branch"), which is the repo's standing answer for an
// invariant no runtime gate can see (`card-range-source`, `face-readout-source`).
// Every subject below is a DOM or LAYOUT fact, reached through auto-retrying
// `expect` — no wall-clock waits and no frame counts, because nothing here
// reads a pixel.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

const BODY = '[data-testid="foxy-output-body"]';
const SCREEN = '[data-testid="foxy-face-screen-toggle"]';
const VIZ = '[data-testid="foxy-face-viz-toggle"]';
const EXPORT = '[data-testid="foxy-face-export-table"]';
const WAVETABLE = '[data-testid="foxy-face-wavetable"]';
/** The five live pictures, which are the whole reason the extension exists. */
const PICTURES = [
  'foxy-face-raster-a',
  'foxy-face-raster-b',
  'foxy-face-raster-c',
  'foxy-face-xyz',
  'foxy-face-wavetable',
];

async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar'))
    .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** Bring the node into the viewport — the lane band sits far down in flow space,
 *  so without this the tile is off-screen and every click times out. */
async function centerOnNode(page: Page, nodeId: string, zoom = 0.9): Promise<void> {
  await page.evaluate(
    ({ nodeId, zoom }) => {
      const w = globalThis as unknown as {
        __flow: {
          getInternalNode: (id: string) => {
            internals?: { positionAbsolute?: { x: number; y: number } };
            position?: { x: number; y: number };
            measured?: { width?: number; height?: number };
          } | undefined;
          setViewport: (vp: { x: number; y: number; zoom: number }, o?: { duration?: number }) => void;
        };
      };
      const n = w.__flow?.getInternalNode(nodeId);
      const pos = n?.internals?.positionAbsolute ?? n?.position ?? { x: 0, y: 0 };
      const wdt = n?.measured?.width ?? 200;
      const hgt = n?.measured?.height ?? 160;
      w.__flow.setViewport(
        {
          x: window.innerWidth / 2 - (pos.x + wdt / 2) * zoom,
          y: window.innerHeight / 2 - (pos.y + hgt / 2) * zoom,
          zoom,
        },
        { duration: 0 },
      );
    },
    { nodeId, zoom },
  );
}

/** Spawn foxy on the DEFAULT shell and open its dock faceplate. */
async function openFace(page: Page) {
  await gotoShell(page);
  await spawnPatch(
    page,
    [{ id: 'sut', type: 'foxy', position: { x: 400, y: 60 }, domain: 'audio', params: {} }],
    [],
  );
  await centerOnNode(page, 'sut');
  const shell = page.locator('.svelte-flow__node[data-id="sut"] [data-testid="module-shell"]');
  await expect(shell, 'the foxy shell tile').toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  await shell.getByTestId('shell-open-dock').click();
  const fv = page.getByTestId('dock-full-view');
  await expect(fv, 'the dock full view').toBeVisible();
  return fv;
}

/** The persisted flags, read off the live patch rather than the DOM — the DOM is
 *  the thing under test, so reading it back would prove nothing about whether
 *  the state landed anywhere durable. */
async function persisted(page: Page, key: string): Promise<unknown> {
  return page.evaluate((k) => {
    const w = window as unknown as {
      __patch?: { nodes?: Record<string, { data?: Record<string, unknown> }> };
    };
    return w.__patch?.nodes?.sut?.data?.[k];
  }, key);
}

test.describe('foxy: the FACE surface (what ships)', () => {
  // The SwiftShader budget, from the ONE export site rather than a literal — a
  // flat wall-clock number is a different assertion on every runner. This
  // BOUNDS the failure; it is not what any test here asserts.
  test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS);

  test('ALL FIVE PICTURES are reachable from the faceplate at all', async ({ page }) => {
    // ⚠ THE LEG THE LEGACY SPECS CANNOT HAVE. `hasVideoSurface` is
    // `domain === 'video'` and foxy is an AUDIO def, so before this extension
    // there was no route to any of these — promotion would have replaced the
    // module's entire internal world with knobs while both legacy specs stayed
    // green. This fails if `foxyDef.face.extension` is dropped or its
    // shell-extension stops resolving.
    const fv = await openFace(page);
    await expect(fv.locator(BODY), 'the foxy fullViewBody').toBeVisible();
    for (const id of PICTURES) {
      await expect(fv.getByTestId(id), `${id} is painted on the face`).toBeVisible();
    }
    // The hero picture has real size — a 0-height canvas is "present" too.
    await expect
      .poll(async () => (await fv.locator(WAVETABLE).boundingBox())?.height ?? 0,
        { message: 'the live wavetable occupies real vertical space' })
      .toBeGreaterThan(50);
  });

  test('THE TAB RAIL engaged: seven bands exist, exactly one is shown', async ({ page }) => {
    // The rail is what 33 controls in seven honest groups BUY, and it engages
    // through `DOCK_TAB_MIN_BANDS` rather than a `face.tabbed` declaration
    // (asserted, with its negative control, in foxy-face-model.test.ts). Here
    // it is checked on the shipping surface: a railed face shows ONE band at a
    // time, so a regression that stopped railing would paint all seven at once.
    const fv = await openFace(page);
    await expect(fv.locator('[data-testid="face-page"]'), 'seven declared pages').toHaveCount(7);
    // ⚠ ONE ROUND TRIP PER SAMPLE, and the first draft got this wrong in a way
    // that recovered-on-retry on CI (#1847). It polled `pages.all()` and called
    // `isVisible()` per band — EIGHT round trips per sample, each hopping the
    // same main thread this module's own render loop was saturating, so the
    // instrument was competing with its subject and timed out at 5 s. `:visible`
    // is resolved IN THE PAGE by Playwright's selector engine and `toHaveCount`
    // auto-retries, so one sample is one hop.
    await expect(
      fv.locator('[data-testid="face-page"]:visible'),
      'a railed face renders exactly ONE band at a time',
    ).toHaveCount(1);
  });

  test('SCREEN starts ON, collapses the pictures, RECLAIMS the space, and comes back', async ({ page }) => {
    const fv = await openFace(page);
    const toggle = fv.locator(SCREEN);

    // Absent ⇒ false ⇒ ON, so an existing rack opens unchanged.
    await expect(toggle, 'starts ON').toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toHaveText('SCREEN ON');
    await expect(fv.locator(WAVETABLE)).toBeVisible();

    await toggle.click();
    await expect(toggle, 'now OFF').toHaveAttribute('aria-pressed', 'false');
    await expect(toggle).toHaveText('SCREEN OFF');
    // ⚠ RECLAIMED, not merely invisible. `visibility: hidden` would keep the
    // box and buy the player nothing, which is the point of the ruling.
    for (const id of PICTURES) {
      await expect(fv.getByTestId(id), `${id} is gone, not hidden`).toHaveCount(0);
    }
    // …and the control that turns them back on did not vanish with them.
    await expect(toggle, 'the toggle survives its own OFF state').toBeVisible();

    await toggle.click();
    await expect(fv.locator(WAVETABLE), 'the pictures return').toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  test('SCREEN state PERSISTS across closing and reopening the dock', async ({ page }) => {
    // The owner's stated floor. This body unmounts with the dock (the
    // #1531/#1574/#1583 class), so a component `$state` boolean would pass
    // every other assertion in this file and fail exactly this one.
    //
    // ONE round trip, not one per tab: the invariant is node-keyed, and a
    // per-tab loop is n chances to lose one coin flip (#1847).
    await openFace(page);
    expect(await persisted(page, 'previewCollapsed'), 'nothing written before the first click')
      .toBeFalsy();

    await page.locator(SCREEN).click();
    await expect(page.locator(SCREEN)).toHaveAttribute('aria-pressed', 'false');
    expect(await persisted(page, 'previewCollapsed'), 'OFF is persisted to the patch').toBe(true);

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dock-full-view')).toHaveCount(0);

    const shell = page.locator('.svelte-flow__node[data-id="sut"] [data-testid="module-shell"]');
    await shell.getByTestId('shell-open-dock').click();
    await expect(page.getByTestId('dock-full-view')).toBeVisible();

    await expect(page.locator(SCREEN), 'still OFF after a remount')
      .toHaveAttribute('aria-pressed', 'false');
  });

  test('the SCOPE/3D flip persists too — it is node.data, not component state', async ({ page }) => {
    // The legacy card keeps this in component `$state`; the face cannot, for
    // the same unmount reason as SCREEN. Default '3d' matches the card, so a
    // node that has never been flipped renders identically on both surfaces.
    const fv = await openFace(page);
    const viz = fv.locator(VIZ);
    await expect(viz, 'defaults to the 3D surface').toHaveText('3D');
    expect(await persisted(page, 'vizMode'), 'nothing written before the first click').toBeFalsy();

    await viz.click();
    await expect(viz).toHaveText('SCOPE');
    expect(await persisted(page, 'vizMode'), 'the flip is persisted').toBe('scope');

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dock-full-view')).toHaveCount(0);
    const shell = page.locator('.svelte-flow__node[data-id="sut"] [data-testid="module-shell"]');
    await shell.getByTestId('shell-open-dock').click();
    await expect(page.getByTestId('dock-full-view')).toBeVisible();
    await expect(page.locator(VIZ), 'still SCOPE after a remount').toHaveText('SCOPE');
  });

  test('EXPORT is revealed ONLY while FREEZE TABLE is on — the precondition IS the probe', async ({ page }) => {
    // ⚠ THE PRECONDITION IS PART OF THE CLAIM, not setup for it. EXPORT is the
    // one control on this face that appears in a single mode, which is the
    // owner's named example of a genuine width earner — so "it is present"
    // proves nothing unless "it is absent by default" is proved in the same
    // test. Asserting only the reveal would pass on a button that is always
    // there.
    const fv = await openFace(page);
    await expect(fv.locator(EXPORT), 'hidden while the table is live').toHaveCount(0);

    // ⚠ THE RAIL IS IN THE WAY, AND THAT IS THE FACE WORKING. FREEZE TABLE is a
    // PARAM cell on the `freeze` page, and a railed face renders only the
    // ACTIVE band — the face opens on `vco`, so the control is not reachable
    // until its own tab is selected. (The first draft of this test clicked
    // straight at the cell and timed out, which is the rail proving itself.)
    await fv.getByTestId('faceplate-tab-freeze').click();

    const freeze = fv.getByTestId('control-freezeTable');
    await expect(freeze, 'the freeze page is now the active band').toBeVisible();
    await freeze.click();

    await expect(fv.locator(EXPORT), 'revealed once the table is pinned').toBeVisible();

    await freeze.click();
    await expect(fv.locator(EXPORT), 'and it goes away again').toHaveCount(0);
  });
});
