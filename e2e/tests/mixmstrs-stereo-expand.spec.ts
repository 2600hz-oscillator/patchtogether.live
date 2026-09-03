// e2e/tests/mixmstrs-stereo-expand.spec.ts
//
// RIGHT-CLICK A MIXMSTRS STEREO JACK → SEE ITS TWO L/R HOLES.
//
// The owner (2026-08-10): "i think what i want (for mixmasters ONLY) is to be
// able to right-click any stereo port and expand it to 2 L/R ports … i just
// need it for the mixmstrs inputs AND outputs including send and return."
//
// ⚠ THIS SPEC IS THE GATE FOR THE HALF THE UNIT TESTS CANNOT SEE.
// `stereo-jack-expansion.test.ts` proves the DERIVATION — hand it an expanded
// pair and it renders two rows. It is structurally blind to whether any gesture
// can ever produce that set, which is the exact failure #1426 documented on
// this same card: the planner had honoured per-leg patching all along and no
// menu could reach it. So the subject here is the RIGHT-CLICK, and the verdict
// is the rows that appear on the card afterwards.
//
// ⚠ AND IT ASSERTS THE ROWS, NOT THE MENU. A menu item that opens, closes and
// changes nothing would satisfy "the option is there" — the assertion after
// every gesture is that the panel now shows `ch1L` AND `ch1R` as separate
// rows, read off the DOM.
//
// RIGHT-CLICK IS CLAIMED BY TWO OTHER MENUS ALREADY, and which one you get
// depends on the jack's state. That is not incidental — it is the thing most
// likely to break, so all three routes are covered:
//   * UNPATCHED INPUT  → StereoExpandMenu   (nothing opened here before)
//   * UNPATCHED OUTPUT → the patch picker's expand row
//   * PATCHED anything → the unpatch menu's expand row

import { test, expect, type Page } from './_fixtures';
import { spawnPatch } from './_helpers';

const MIX = 'mix';
const ES9 = 'es9';

function chrome(page: Page, nodeId: string) {
  return page.locator(`[data-patch-panel-chrome="${nodeId}"]`);
}

function portRow(page: Page, nodeId: string, portId: string) {
  return chrome(page, nodeId).locator(
    `[data-testid="patch-panel-port-row"][data-port-id="${portId}"]`,
  );
}

/**
 * Open the panel and drill to where a given jack actually lives.
 *
 * Escape first: the patch trigger TOGGLES and the panel REMEMBERS its drill
 * view, so without a reset the second call in a test lands somewhere the row
 * does not exist (both hazards were found in es9-per-leg-patching.spec.ts).
 *
 * ⚠ ON THE DEFAULT SHELL THE RAIL MENU IS FLAT — the card's per-channel
 * SECTIONS (`Ch1`..`Ret2`) are a measured, documented delta of the lane rail
 * (#1762, recorded at the PatchPanel mount in ModuleShell.svelte): every jack
 * lives under the ordinary INPUT / OUTPUT navs, ports intact, grouping gone.
 */
async function openPanelAt(
  page: Page,
  nodeId: string,
  target: { nav: 'inputs' | 'outputs' },
) {
  await page.keyboard.press('Escape');
  await expect(chrome(page, nodeId)).toHaveCount(0);
  await page
    .locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-trigger"]`)
    .click();
  await expect(chrome(page, nodeId)).toHaveAttribute('aria-hidden', 'false');
  const row = chrome(page, nodeId).locator(
    `[data-testid="patch-panel-nav"][data-nav="${target.nav}"]`,
  );
  await expect(row, `${nodeId} must offer ${target.nav}`).toBeVisible();
  await row.click();
}

/** MIXMSTRS alone, or with an ES-9 when the test needs a real cable. */
async function spawnRig(page: Page, withEs9 = false) {
  const nodes = [
    { id: MIX, type: 'mixmstrs', position: { x: 700, y: 80 }, domain: 'audio' as const },
    ...(withEs9
      ? [{ id: ES9, type: 'es9', position: { x: 80, y: 80 }, domain: 'audio' as const }]
      : []),
  ];
  await spawnPatch(page, nodes);
  await expect(page.locator(`.svelte-flow__node[data-id="${MIX}"]`)).toBeVisible();
}

/**
 * The full assertion for one rail: collapsed → ONE row addressing the left
 * port, expanded → BOTH legs as their own rows.
 *
 * The collapsed leg is not decoration. Without it the expanded assertion would
 * also pass on a card that had simply never collapsed the pair, so the pair
 * of assertions is what makes this evidence of the GESTURE rather than of the
 * card's resting layout.
 */
async function expectCollapsed(page: Page, left: string, right: string) {
  await expect(
    portRow(page, MIX, left),
    `${left} must be the one collapsed row before expanding`,
  ).toBeVisible();
  await expect(
    portRow(page, MIX, right),
    `${right} must NOT have its own row while the pair is collapsed`,
  ).toHaveCount(0);
}

async function expectExpanded(page: Page, left: string, right: string) {
  await expect(
    portRow(page, MIX, left),
    `${left} must have its own row after expanding`,
  ).toBeVisible();
  await expect(
    portRow(page, MIX, right),
    `${right} must have its own row after expanding — this is the whole feature`,
  ).toBeVisible();
}

test.describe('MIXMSTRS stereo jacks expand to L/R on right-click', () => {
  // ---- ROUTE 1: UNPATCHED INPUT. The case that had NO menu at all, and the
  // one the owner hit — a mixer channel he wants to feed from two mono
  // hardware points.
  test('an unpatched CHANNEL input expands into its two legs', async ({ page, rack }) => {
    await spawnRig(page);
    await openPanelAt(page, MIX, { nav: 'inputs' });
    await expectCollapsed(page, 'ch1L', 'ch1R');

    await portRow(page, MIX, 'ch1L').click({ button: 'right' });
    const menu = page.getByTestId('stereo-expand-menu');
    await expect(
      menu,
      'right-clicking an unpatched stereo input used to fall through to the ' +
        "browser's own menu — this is the gesture that did nothing",
    ).toBeVisible();
    await menu.getByTestId('stereo-expand-toggle').click();

    await expectExpanded(page, 'ch1L', 'ch1R');
  });

  test('a RETURN input expands, and collapses again from either leg', async ({ page, rack }) => {
    await spawnRig(page);
    await openPanelAt(page, MIX, { nav: 'inputs' });
    await expectCollapsed(page, 'ret1L', 'ret1R');

    await portRow(page, MIX, 'ret1L').click({ button: 'right' });
    await page.getByTestId('stereo-expand-menu').getByTestId('stereo-expand-toggle').click();
    await expectExpanded(page, 'ret1L', 'ret1R');

    // Collapsing from the RIGHT leg is the interesting direction: that row is
    // an ordinary single-port descriptor with no sibling metadata on it, so it
    // can only work if the pair is resolved from the DEF.
    await portRow(page, MIX, 'ret1R').click({ button: 'right' });
    const menu = page.getByTestId('stereo-expand-menu');
    await expect(menu.getByTestId('stereo-expand-toggle')).toHaveAttribute(
      'data-expanded',
      'true',
    );
    await menu.getByTestId('stereo-expand-toggle').click();
    await expectCollapsed(page, 'ret1L', 'ret1R');
  });

  test('expanding ONE channel leaves the others collapsed', async ({ page, rack }) => {
    await spawnRig(page);
    await openPanelAt(page, MIX, { nav: 'inputs' });

    await portRow(page, MIX, 'ch1L').click({ button: 'right' });
    await page.getByTestId('stereo-expand-menu').getByTestId('stereo-expand-toggle').click();
    await expectExpanded(page, 'ch1L', 'ch1R');

    // Ch2 shares the flat INPUT list on the shell rail (#1762) — the
    // expansion must not leak into the sibling pair's rows.
    await expectCollapsed(page, 'ch2L', 'ch2R');

    // …and Ch1 is still expanded after CLOSING and re-drilling, so the
    // gesture is not a transient artefact of the view that made it.
    await openPanelAt(page, MIX, { nav: 'inputs' });
    await expectExpanded(page, 'ch1L', 'ch1R');
  });

  // ---- ROUTE 2: UNPATCHED OUTPUT → the patch picker already claims this
  // right-click, so the expand row lives inside it.
  test('an unpatched SEND output expands from the patch picker', async ({ page, rack }) => {
    await spawnRig(page);
    await openPanelAt(page, MIX, { nav: 'outputs' });
    await expectCollapsed(page, 'send1L', 'send1R');

    await portRow(page, MIX, 'send1L').click({ button: 'right' });
    const picker = page.locator('[data-testid="port-context-menu"]');
    await expect(picker).toBeVisible();
    const row = picker.getByTestId('patch-expand-stereo');
    await expect(
      row,
      'the picker claims right-click on an unpatched output, so it must carry ' +
        'the expand row or SEND has no expand gesture at all',
    ).toBeVisible();
    await row.click();

    await expectExpanded(page, 'send1L', 'send1R');
  });

  test('MASTER expands the same way', async ({ page, rack }) => {
    await spawnRig(page);
    await openPanelAt(page, MIX, { nav: 'outputs' });
    await expectCollapsed(page, 'masterL', 'masterR');

    await portRow(page, MIX, 'masterL').click({ button: 'right' });
    await page.locator('[data-testid="port-context-menu"]').getByTestId('patch-expand-stereo').click();

    await expectExpanded(page, 'masterL', 'masterR');
  });

  // ---- ROUTE 3: PATCHED → the unpatch menu claims the right-click. This is
  // when the user MOST wants the two holes (which leg is that cable on?), so a
  // gesture that stopped working the moment a cable landed would be useless.
  test('a PATCHED jack still expands, via the unpatch menu', async ({ page, rack }) => {
    await spawnRig(page, true);

    // Put a real cable on the pair first, through the ordinary patch flow: the
    // collapsed stereo MASTER jack onto a mono ES-9 physical point. That is a
    // WIDTH MISMATCH, so since 2026-08-12 it asks which channel before it
    // writes — answering is part of the ordinary flow now, not extra ceremony.
    await openPanelAt(page, MIX, { nav: 'outputs' });
    await portRow(page, MIX, 'masterL').click({ button: 'right' });
    const picker = page.locator('[data-testid="port-context-menu"]');
    await expect(picker).toBeVisible();
    await picker.locator(`[data-testid="patch-to-module"][data-node-id="${ES9}"]`).click();
    await picker
      .locator('[data-testid="patch-to-port"][data-port-id="out1"][data-leg=""]')
      .click();
    await expect(picker).toHaveCount(0);
    const chooser = page.getByTestId('stereo-drop-choice');
    await expect(chooser, 'a stereo jack onto a mono ES-9 point must ask').toBeVisible();
    await chooser.locator('[data-testid="stereo-drop-choice-option"][data-mode="left"]').click();
    await expect(chooser).toHaveCount(0);

    await openPanelAt(page, MIX, { nav: 'outputs' });
    await portRow(page, MIX, 'masterL').click({ button: 'right' });
    const unpatch = page.locator('[data-testid="unpatch-menu"]');
    await expect(
      unpatch,
      'a patched point opens the unpatch menu — that precedence is unchanged',
    ).toBeVisible();
    const row = unpatch.getByTestId('unpatch-expand-stereo');
    await expect(
      row,
      'the expand gesture must survive a cable landing on the jack — this is ' +
        'exactly when the user needs to see WHICH LEG it is on',
    ).toBeVisible();
    await row.click();

    await expectExpanded(page, 'masterL', 'masterR');
  });

  // ---- SCOPE CONTROL. The owner asked for mixmstrs only "for now". This is
  // the assertion that would go red if someone widened the opt-in without
  // meaning to — and it is a REAL control: twotracks derives stereo pairs
  // exactly like mixmstrs does, so a gate keyed on "has pairs" would fail here.
  test('a module that is NOT opted in offers no expand row', async ({ page, rack }) => {
    await spawnPatch(page, [
      { id: 'tt', type: 'twotracks', position: { x: 300, y: 120 }, domain: 'audio' },
    ]);
    await expect(page.locator('.svelte-flow__node[data-id="tt"]')).toBeVisible();
    await openPanelAt(page, 'tt', { nav: 'outputs' });

    const rows = chrome(page, 'tt').locator('[data-testid="patch-panel-port-row"]');
    await expect(rows.first()).toBeVisible();
    await rows.first().click({ button: 'right' });

    // Whatever menu (if any) opens, it must not carry an expand affordance.
    await expect(page.getByTestId('stereo-expand-menu')).toHaveCount(0);
    await expect(page.getByTestId('patch-expand-stereo')).toHaveCount(0);
    await expect(page.getByTestId('unpatch-expand-stereo')).toHaveCount(0);
  });
});
