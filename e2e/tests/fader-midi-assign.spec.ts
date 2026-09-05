// e2e/tests/fader-midi-assign.spec.ts
//
// FADER's two HORIZONTAL crossfade sliders — A↔B (`fader`) and DRY↔WET
// (`dryWet`) — are raw <input type=range> elements, not the standard Knob/
// Fader controls, so they historically had NO right-click MIDI/Electra
// assignment. This proves the fix: both sliders now wire the shared
// makeMidiAssignable factory + ControlContextMenu, so right-click → MIDI Learn
// binds a CC that drives the param, and the control-surface / Electra entries
// are present in the menu.
//
// Simulated MIDI (no hardware / no permission prompt) via the dev-only
// __midiTestInstall / __midiTestInject hooks — same path real CCs take.
//
// ── ⚠ THE 2026-09-05 CI FAILURE WAS AN INSTRUMENT DEFECT, NOT A PRODUCT ONE ──
//
// It read, alarmingly, as a functional-parity break: `ctx-electra-el1` asserted
// VISIBLE on one line, and the very next line's click on `ctx-midi-learn` timed
// out — "the menu lost MIDI Learn on the new surface". Judged rather than
// assumed, and it is not:
//
//   1. `ControlContextMenu.svelte` renders `ctx-midi-learn` UNCONDITIONALLY as
//      the FIRST child of the menu — there is no `{#if}` anywhere near it. A
//      menu that is open at all contains it, so a menu proven open by the
//      Electra assertion one line above cannot be missing it.
//   2. The error was `locator.click: Test timeout of 31636 ms exceeded` — the
//      TEST BUDGET expiring mid-click, not `element(s) not found`.
//   3. The A↔B leg EARLIER IN THE SAME TEST clicks that same testid and
//      succeeds. One menu is fine and the second is not, which is a clock, not
//      a render.
//   4. Local: 7.3 s for the whole file.
//
// So MIDI-learn is present and binds; parity holds. What was missing is the
// instrument's ability to SAY which of the two it was — a bare `.click()`
// reports the same timeout whether the item is absent or the budget ran out.
// The dry/wet leg now asserts the item VISIBLE before clicking it, exactly as
// the A↔B leg already did, so a real regression fails by name instead.
//
// The budget itself is the `SLOW_BOOT_TEST_TIMEOUT_MS` subject: re-pointing
// this spec off the deleted surface added a dock open, and a dock mount no
// longer overlaps page load.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import type { Page } from '@playwright/test';
import { SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

test.describe.configure({ mode: 'parallel' });

async function readParam(page: Page, nodeId: string, paramId: string): Promise<number | undefined> {
  return page.evaluate(
    ({ nodeId, paramId }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      return w.__patch?.nodes?.[nodeId]?.params?.[paramId];
    },
    { nodeId, paramId },
  );
}

async function installSimMidi(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof (globalThis as unknown as {
    __midiTestInstall?: () => boolean;
  }).__midiTestInstall === 'function');
  await page.evaluate(() => {
    (globalThis as unknown as { __midiTestInstall: () => boolean }).__midiTestInstall();
  });
}

async function injectCc(page: Page, channel: number, cc: number, value: number): Promise<void> {
  await page.evaluate(
    ({ channel, cc, value }) => {
      const w = globalThis as unknown as {
        __midiTestInject?: (c: number, cc: number, v: number) => boolean;
      };
      if (typeof w.__midiTestInject !== 'function') {
        throw new Error('__midiTestInject hook not present — DEV build expected');
      }
      w.__midiTestInject(channel, cc, value);
    },
    { channel, cc, value },
  );
}

test('FADER A↔B + dry/wet sliders are MIDI/Electra assignable (right-click → learn → CC drives param)', async ({ page, rack, errorWatch }) => {
  test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS);
  await page.evaluate(() => window.localStorage.removeItem('pt.midi-bindings.v1'));

  await spawnPatch(
    page,
    [
      { id: 'fad1', type: 'fader', position: { x: 140, y: 140 }, domain: 'video', params: { fader: 0, dryWet: 0 } },
      // An ElectraControl in the patch so the menu's Electra-assign entry renders.
      { id: 'el1', type: 'electraControl', position: { x: 520, y: 140 }, domain: 'meta' },
    ],
  );
  await installSimMidi(page);

  const tile = page.locator('.svelte-flow__node[data-id="fad1"] [data-testid="module-shell"]');
  await expect(tile).toBeVisible();
  // The sliders live on the dock ladder on the shell; MIDI/Electra assign is
  // the same control-context-menu, opened from the control itself.
  await tile.getByTestId('shell-open-dock').click();
  const dock = page.getByTestId('dock-full-view');
  await expect(dock).toBeVisible();
  const abSlider = dock.getByTestId('control-fader');
  const dwSlider = dock.getByTestId('control-dryWet');
  // ⚠ `scrollIntoViewIfNeeded()` stood here and on the dry/wet leg below. It
  // waits for the element to be STABLE with no timeout of its own, and the
  // fader's dock body is a live video surface that keeps the pane painting, so
  // on a loaded runner it burns the whole test budget on a page that is fully
  // rendered. `scrollIntoView` via evaluate is the DOM call underneath, with no
  // actionability contract; every gesture after it is unchanged.
  await abSlider.evaluate((el) => el.scrollIntoView({ block: 'center' }));

  // ---- A↔B fader ----
  await abSlider.click({ button: 'right' });
  const menu = page.locator('[data-testid="control-context-menu"]');
  await expect(menu, 'right-click opens the control menu').toBeVisible();
  await expect(menu.locator('[data-testid="ctx-midi-learn"]'), 'menu offers MIDI Learn').toBeVisible();
  // Electra assignment lives in this same menu (the "Send to <electra>" entry).
  await expect(menu.locator('[data-testid="ctx-electra-el1"]'), 'A↔B is Electra-assignable').toBeVisible();

  await menu.locator('[data-testid="ctx-midi-learn"]').click();
  await injectCc(page, 1, 21, 100); // CC 100/127 ≈ 0.787
  await expect
    .poll(() => readParam(page, 'fad1', 'fader'), { timeout: 4000 })
    .toBeGreaterThan(0.5);
  // The card's per-fader midi badge died with it; the binding's OBSERVABLE
  // effect (CC drives the param) is asserted above, and the shared badge
  // behaviour is pinned by midi-learn.spec.ts on the shell.

  // ---- dry/wet fader ----
  await dwSlider.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await dwSlider.click({ button: 'right' });
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-testid="ctx-electra-el1"]'), 'dry/wet is Electra-assignable').toBeVisible();
  // ⚠ ASSERTED BEFORE IT IS CLICKED — the discriminator this leg was missing.
  // `ControlContextMenu` renders this item unconditionally, so its ABSENCE
  // would be a functional-parity break and must fail by NAME. A bare click
  // reports the same timeout for "gone" and for "budget expired".
  await expect(menu.locator('[data-testid="ctx-midi-learn"]'), 'dry/wet menu offers MIDI Learn').toBeVisible();
  await menu.locator('[data-testid="ctx-midi-learn"]').click();
  await injectCc(page, 1, 22, 64); // ≈ 0.504
  await expect
    .poll(() => readParam(page, 'fad1', 'dryWet'), { timeout: 4000 })
    .toBeGreaterThan(0.3);

});
