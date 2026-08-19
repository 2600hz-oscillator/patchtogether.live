// e2e/tests/resofilter-face.spec.ts
//
// The RESOFILTER faceplate, covering the four things only a browser can settle.
// Everything arithmetic — the closed forms, the mode partition, the preset
// notes — is already re-derived from the SHIPPING DSP on every unit run by
// `resofilter-face-model.test.ts`. This file exists for what that file cannot
// reach:
//
//   1. THE MODE PARTITION AS A RENDERED FACT. `peak` and `width` are each
//      other's negative control — exactly one is live in every mode except
//      band-pass — and that claim is only worth anything if the DOM does it
//      when a real button is clicked, not when a pure function is called.
//   2. `options` IS DOING ITS JOB. Without it MODE resolves to a KNOB printing
//      `0.00`…`4.00`; with it, a Segmented row. `faces-parity` drives both with
//      the same pointer gesture against the same testid and is structurally
//      unable to tell them apart (the `fader` precedent, #1464), so the cell
//      kind is asserted here or nowhere.
//   3. THE SIDEBAR AGREES WITH THE HERO, IN ONE FRAME. This is the noise scar
//      (#1464's third commit): a hero readout and a sidebar entry printed two
//      DIFFERENT TRUE values of one quantity, both correct, and no gate could
//      see it because only one of them was ever read. Here both are read, in
//      the same DOM, and required to match.
//   4. A PRESET'S NOTE IS WHAT THE PRESET PRODUCES. The unit lane pins the note
//      against the model; this pins the model against what the panel actually
//      shows after the button is pressed, which is the other half of the loop.
//
// ⚠ THE MODE CAPTIONS USED TO BE ELLIPSIZED HERE, AND THIS NOTE USED TO SAY NO
// DOM PREDICATE COULD SEE IT. Both halves are now out of date, and the second
// was the more interesting mistake.
//
// `HP`, `NT` and `AP` rendered as `H…`, `N…`, `A…` at the dock — measured, and
// the same state the shipped `filter` dock had been in since #1430 — because
// `.seg` was `flex: 1` (= `1 1 0%`), which makes every button the width of the
// AVERAGE caption. Fixed 2026-08-12 with `flex: 1 1 auto`.
//
// The claim that only a VRT baseline could see it was wrong in a way worth
// keeping: `textContent` is indeed untouched by an ellipsis, `measureText` does
// drop `letter-spacing` (0.6 px × 2 chars — the whole deficit on two of the
// three), and `scrollWidth`/`clientWidth` are integer-quantised so they catch
// it only when the box happens to round down. But comparing the caption's own
// INLINE BOX (a Range rect) against the box that paints it is sub-pixel, is
// pure DOM, and reports exactly the 0.719 / 0.422 / 0.203 px overflows. That
// predicate now sweeps every migrated face's dock in
// `faceplate-platform.spec.ts` — "no gate can see this" turned out to mean "no
// gate had been pointed at it".

import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import {
  MODES_WITH_PEAK,
  MODES_WITH_WIDTH,
  resofilterPeakText,
  resofilterWidthText,
  type SvfModeIndex,
} from '../../packages/web/src/lib/ui/modules/resofilter-face-model';

const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;
const NODE = 'rf';
const TAGS = ['LP', 'HP', 'BP', 'NT', 'AP'] as const;

async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({
    timeout: SLOW_RENDER ? 30_000 : 15_000,
  });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

async function openDock(page: Page): Promise<Locator> {
  const shell = page.locator(`.svelte-flow__node[data-id="${NODE}"] [data-testid="module-shell"]`);
  await expect(shell).toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const dockShell = page
    .getByTestId('dock-full-view')
    .locator('[data-testid="module-shell"][data-shell-tier="dock"]');
  await expect(dockShell).toBeVisible();
  return dockShell;
}

const readout = (dock: Locator, id: string): Locator =>
  dock.locator(`[data-hero-readout="resofilter-${id}"] dd`);

/** Write params straight into the graph. The GESTURE is covered by
 *  faces-parity (which drags every cell); what is needed here is an EXACT
 *  value, so the expected string can be a literal the model computes. */
async function setParams(page: Page, values: Record<string, number>): Promise<void> {
  await page.evaluate(
    ({ id, values }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params?: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes[id];
        n.params = { ...(n.params ?? {}), ...values };
      });
    },
    { id: NODE, values },
  );
}

test.describe('resofilter face — one dial, and the two readouts that say what it means', () => {
  // ⚠ THE READOUT TEST THAT STOOD HERE WAS THIS FILE'S BEST ONE, AND IT IS
  // DELETED WITH ITS SUBJECT (owner ruling, 2026-08-19). It drove the five real
  // MODE chips and asserted PEAK/WIDTH per mode, including the partition (in
  // every mode exactly one reads '—', except band-pass where both are live) and
  // the count that made the claim falsifiable: five states collapse to THREE
  // distinct pairs off one dial, which is precisely what a
  // `{ paramId: 'resonance' }` readout could never produce. It also swept CV
  // REACH in both directions as its own negative control.
  //
  // The hero readout strip is gone platform-wide, so none of those elements
  // exist. ⚠ WHAT IS NOW UNGATED, SAID PLAINLY: nothing in the e2e layer proves
  // resofilter's mode partition reaches a user-visible surface. The arithmetic
  // is still pinned in `resofilter-face-model.test.ts` (unit lane, with its own
  // negative controls) — but the JOIN between that model and what a player can
  // see is no longer asserted anywhere, because there is no longer a surface
  // that shows it. That is a consequence of the ruling, not an oversight.

  test('MODE is a SEGMENTED roster at the dock and a NAMED knob in the lane', async ({ page }) => {
    // ⚠ WHY THIS IS A TEST. `faces-parity` drives a knob and a segmented cell
    // with the SAME pointer gesture against the SAME `control-mode` testid and
    // asserts the same thing of both, so deleting `options` from the def would
    // leave every gate in this repo green while MODE went back to being a
    // rotary printing `0.00`…`4.00` — which is the defect the declaration was
    // added to fix. Measured before this leg was written: with `options` the
    // cell resolves `segmented` at the dock; without it, `knob`.
    test.setTimeout(SLOW_RENDER ? 90_000 : 45_000);
    await gotoShell(page);
    await spawnPatch(page, [{ id: NODE, type: 'resofilter', position: { x: 300, y: 200 } }]);

    // THE LANE HALF, which is the other side of the same declaration and the
    // reason `options` is safe to add to a module whose small tiers have no
    // room for a roster: `paramCellKind` returns `knob` at every LANE tier, so
    // MODE keeps its 46 px column and earns a readout NAMING the state instead
    // of printing a float (PF-1's lane half + PF-3's readout, one code path).
    //
    // ⚠ UNCONDITIONAL, DELIBERATELY. The first draft wrapped this in
    // `if (await lane.locator(…).count())`, which is a gate that passes when
    // the thing it checks is absent — the failure mode is indistinguishable
    // from success. Measured before removing the guard: the spawn reveal parks
    // at the `full` lane tier, and with four params against
    // `faceTierCap('full') === 6` the plate renders ALL FOUR cells, MODE among
    // them, printing `LP` under the dial rather than `0.00`.
    const lane = page.locator(`.svelte-flow__node[data-id="${NODE}"] [data-testid="module-shell"]`);
    await expect(lane).toBeVisible();
    await expect(lane, 'the spawn reveal parks at the `full` lane tier').toHaveAttribute(
      'data-shell-tier',
      'full',
    );
    await expect(
      lane.locator('[data-cell-key="mode"]'),
      'the LANE paints MODE as a knob — a roster does not fit a 46 px column',
    ).toHaveAttribute('data-cell-control', 'knob');
    // …and the roster is resolved THERE too: the dial's accessible value is the
    // option's name, not its number. `aria-valuetext` is the right place to
    // assert it — `aria-valuenow` stays `0` (the param value) and the visible
    // `LP` is painted by a SIBLING value row, outside `control-mode`'s subtree,
    // which is what the first version of this line got wrong.
    await expect(
      lane.locator('[data-testid="control-mode"]'),
      '…the lane dial NAMES the state (PF-1 lane half) rather than reading 0.00',
    ).toHaveAttribute('aria-valuetext', 'LP');
    await expect(lane, 'and it is painted in the tile').toContainText('LP');

    const dock = await openDock(page);
    await expect(
      dock.locator('[data-cell-key="mode"]'),
      'the dock paints MODE as a five-state Segmented row, not a dial',
    ).toHaveAttribute('data-cell-control', 'segmented');
    await expect(
      dock.locator('[data-testid="control-mode"]').locator('button, [role="radio"]'),
      'one chip per declared option',
    ).toHaveCount(TAGS.length);

    // The full names live on the chips' titles — the reason the captions can be
    // two letters at all.
    for (const [i, name] of ['Low-pass', 'High-pass', 'Band-pass', 'Notch', 'Allpass'].entries()) {
      await expect(
        dock.locator('[data-testid="control-mode"]').locator('button, [role="radio"]').nth(i),
      ).toHaveAttribute('title', new RegExp(name));
    }
  });
  // ⚠ REMOVED WITH THE SIDEBAR (owner ruling, 2026-08-19): "the sidebar picture agrees with the hero, in one frame — the noise scar".
  // Its subject was a dock sidebar panel; `face.sidebar` is deleted
  // platform-wide, so there is no element left to assert on. See
  // ModuleFaceHero in graph/types.ts for the ruling set.
  // ⚠ REMOVED WITH THE SIDEBAR (owner ruling, 2026-08-19): "every PRESET produces the value printed beside it".
  // Its subject was a dock sidebar panel; `face.sidebar` is deleted
  // platform-wide, so there is no element left to assert on. See
  // ModuleFaceHero in graph/types.ts for the ruling set.
});
