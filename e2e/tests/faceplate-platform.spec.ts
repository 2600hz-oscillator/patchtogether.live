// e2e/tests/faceplate-platform.spec.ts
//
// PF-20 — the DOM gate for the dock faceplate PLATFORM: the value readouts, the
// page header, the band hints, the hero slot and the sidebar.
//
// WHY AN E2E AND NOT ONLY UNITS. The pure model
// (dock-faceplate-model.test.ts) proves the ARITHMETIC — the hero split is
// total, a preset's writes are in range, an empty block is dropped. It is
// structurally blind to whether any of it reaches the screen: a `{#if}` that
// never fires, a CSS rule that hides the column, a prop that is never threaded
// through. Those are exactly the failures this platform is meant to end, so
// they get a DOM assertion.
//
// It is scoped to ONE module (kickdrum, the platform's first adopter and the
// face the owner put next to its mock) on purpose: the registry-wide render
// gate is faces-parity, which already sweeps every STRICT_FACES module and
// which the hero promotion had to survive. This spec is about the STRUCTURE
// around those controls.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { setNodeParams } from './_module-coverage-helpers';

const TYPE = 'kickdrum';

/** Boot workflow mode with the migrated shell. Same 15 s boot bound the other
 *  workflow specs carry — the FIRST test of a run pays SvelteKit's on-demand
 *  /rack route compile before the chrome mounts. */
async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack?mode=workflow&shell=1');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 15_000 });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** Open the dock full-view for node `id` and return the faceplate root. */
async function openFaceplate(page: Page, id: string) {
  const tile = page.locator(`.svelte-flow__node[data-id="${id}"] [data-testid="module-shell"]`);
  await expect(tile).toBeVisible();
  await tile.getByTestId('shell-open-dock').click();
  const fp = page.getByTestId('dock-full-view');
  await expect(fp).toBeVisible();
  await expect(fp.locator('[data-testid="module-shell"][data-shell-tier="dock"]')).toBeVisible();
  return fp;
}

/** The live value of a param on node `id`, straight out of the patch store —
 *  the durable truth the UI claims to be showing. `undefined` when untouched
 *  (node.params is a SPARSE overlay, which is the trap the width test below
 *  exists for). */
async function paramValue(page: Page, id: string, paramId: string): Promise<number | undefined> {
  return page.evaluate(
    ({ id, paramId }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params?: Record<string, number> } | undefined> };
      };
      return w.__patch.nodes[id]?.params?.[paramId];
    },
    { id, paramId },
  );
}

test.describe('PF-20 dock faceplate platform (kickdrum)', () => {
  test('the faceplate is a designed panel: header, hero, readouts, hints, sidebar', async ({ page }) => {
    await gotoShell(page);
    await spawnPatch(page, [{ id: 'k', type: TYPE, position: { x: 460, y: 240 } }]);
    const fp = await openFaceplate(page, 'k');
    const shell = fp.locator('[data-testid="module-shell"]');

    // ── 1. THE PAGE HEADER — a title and a sentence, not a bare knob grid. ──
    const head = shell.getByTestId('face-head');
    await expect(head, 'the faceplate declares a page header').toBeVisible();
    await expect(head).toContainText('Voice');
    await expect(head, 'the hint says what the instrument IS').toContainText(
      /three decoupled generators/i,
    );

    // ── 2. A VALUE UNDER EVERY KNOB (the largest single share of the drift). ──
    //
    // Registry-driven: count the KNOB cells the dock rendered and require the
    // same number of readouts. A hardcoded list would go stale the moment the
    // face is re-ranked, and — worse — would still pass if the readout stopped
    // rendering for a param nobody listed.
    const knobCells = shell.locator('[data-cell-control="knob"]');
    const knobCount = await knobCells.count();
    expect(knobCount, 'the dock renders kickdrum’s dials').toBeGreaterThan(15);
    const readouts = shell.locator('[data-cell-control="knob"] [data-testid^="readout-"]');
    await expect(
      readouts,
      'EVERY dock dial prints its value — bare labels were the mock’s biggest complaint',
    ).toHaveCount(knobCount);
    // …and the value is the FORMATTED one, units included, not a bare float.
    await expect(shell.getByTestId('readout-sub_decay')).toHaveText('450 ms');
    await expect(shell.getByTestId('readout-tune')).toHaveText('50.0 Hz');

    // ── 3. THE HERO — promoted ONCE, with its live readouts. ──
    const hero = shell.getByTestId('face-hero');
    await expect(hero).toBeVisible();
    await expect(
      shell.locator('[data-testid="control-tune"]'),
      'TUNE was PROMOTED into the hero, not COPIED — a second cell would fail faces-parity',
    ).toHaveCount(1);
    await expect(
      hero.locator('[data-testid="control-tune"]'),
      'and the one cell is the hero’s',
    ).toBeVisible();
    const heroReadouts = shell.getByTestId('face-hero-readouts');
    await expect(heroReadouts).toContainText('450 ms');
    await expect(heroReadouts).toContainText('24.0 st');

    // ── 4. BAND HINTS — a header that describes its group. ──
    const subBand = shell.locator('[data-face-page="sub"]');
    await expect(subBand.locator('.page-hint')).toHaveText('depth sine · always mono');

    // ── 5. THE SIDEBAR — outside the shell, four blocks, all painted. ──
    const side = fp.getByTestId('face-sidebar');
    await expect(side).toBeVisible();
    await expect(
      side.locator('[data-testid^="control-"]'),
      'a sidebar block must NEVER emit a control-<paramId> testid (faces-parity multiset)',
    ).toHaveCount(0);
    await expect(side.getByTestId('side-flow')).toBeVisible();
    await expect(side.getByTestId('side-presets')).toBeVisible();
    await expect(side.getByTestId('side-readouts')).toBeVisible();
    await expect(side.getByTestId('sidebar-panel-stereo-crossover')).toBeVisible();
    // The chain names the three generators as generators.
    await expect(side.locator('[data-flow-role="generator"]')).toHaveCount(3);
  });

  test('the crossover panel reads the DEFAULT width, not zero (node.params is SPARSE)', async ({ page }) => {
    // REGRESSION. The panel read `node.params.width` bare and fell back to 0,
    // so a freshly spawned kickdrum printed `WIDTH 0%` beside a dial reading
    // 0.20 — a picture contradicting the control next to it. Nothing else could
    // see it: the param is genuinely untouched, so the store IS empty, and the
    // pure model has no opinion about defaults.
    await gotoShell(page);
    await spawnPatch(page, [{ id: 'k', type: TYPE, position: { x: 460, y: 240 } }]);
    const fp = await openFaceplate(page, 'k');

    expect(
      await paramValue(page, 'k', 'width'),
      'precondition: width is UNTOUCHED, so node.params has no entry for it',
    ).toBeUndefined();
    await expect(
      fp.getByTestId('sidebar-panel-width'),
      'the picture shows the def default (0.20 → 20%), not a bare-store zero',
    ).toHaveText('width 20%');
  });

  test('a PRESET is a real action: it writes params, lights itself, and un-lights on edit', async ({ page }) => {
    await gotoShell(page);
    await spawnPatch(page, [{ id: 'k', type: TYPE, position: { x: 460, y: 240 } }]);
    const fp = await openFaceplate(page, 'k');
    const shell = fp.locator('[data-testid="module-shell"]');
    const side = fp.getByTestId('face-sidebar');

    const boom = side.getByTestId('face-preset-sub-boom');
    await expect(boom, 'a fresh module sits on NO preset').toHaveAttribute('aria-pressed', 'false');

    await boom.click();

    // (a) it WROTE — the durable graph moved, not just a highlight.
    await expect
      .poll(() => paramValue(page, 'k', 'tune'), { message: 'SUB BOOM tunes to 38 Hz' })
      .toBe(38);
    expect(await paramValue(page, 'k', 'sub_decay'), 'and stretches the tail to 800 ms').toBe(800);

    // (b) the DIAL followed, so the panel and the control agree.
    await expect(shell.getByTestId('readout-tune')).toHaveText('38.0 Hz');

    // (c) it LIGHTS — and only it.
    await expect(boom).toHaveAttribute('aria-pressed', 'true');
    await expect(
      side.locator('[aria-pressed="true"]'),
      'exactly one preset row is lit',
    ).toHaveCount(1);

    // (d) …and moving ONE knob off it un-lights the row. A list that keeps a
    //     stale entry lit is lying about the module's state, and that is the
    //     failure a "does clicking highlight it" test cannot see.
    await setNodeParams(page, 'k', { tune: 44 });
    await expect(shell.getByTestId('readout-tune')).toHaveText('44.0 Hz');
    await expect(boom, 'edited away from the preset ⇒ nothing is lit').toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});
