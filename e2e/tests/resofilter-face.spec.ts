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
// ⚠ WHAT THIS FILE DELIBERATELY DOES NOT ASSERT: that the five MODE captions
// are legible. Three of them (`HP`, `NT`, `AP`) are ellipsized to `H…`, `N…`,
// `A…` at the dock — measured, and the same state the shipped `filter` dock has
// been in since #1430 — and NO DOM predicate can see it: `textContent` is
// untouched by an ellipsis, `scrollWidth === clientWidth` for a single line,
// and `measureText` drops `letter-spacing` (0.6 px × 2 chars, which is the
// whole deficit). The VRT dock baseline is the only surface that can, and
// `e2e/vrt/_shell-faces.ts` says what it is expected to show.

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
  test('PEAK and WIDTH swap live-ness with MODE, driven through the real buttons', async ({
    page,
  }) => {
    test.setTimeout(SLOW_RENDER ? 90_000 : 45_000);
    await gotoShell(page);
    await spawnPatch(page, [{ id: NODE, type: 'resofilter', position: { x: 300, y: 200 } }]);
    const dock = await openDock(page);

    // A resonance where both quantities are unmistakable, written once.
    await setParams(page, { resonance: 0.9, cutoff: 1000, mix: 1 });

    const seen: string[] = [];
    for (const [i, tag] of TAGS.entries()) {
      const mode = i as SvfModeIndex;
      // Click the real Segmented chip. `.seg` captions are ellipsized for three
      // of the five, so match on the ACCESSIBLE name / title rather than the
      // painted text — the DOM keeps the full caption either way.
      await dock
        .locator('[data-testid="control-mode"]')
        .locator('button, [role="radio"]')
        .nth(i)
        .click();

      const p = { cutoff: 1000, resonance: 0.9, mode, mix: 1 } as const;
      const peak = resofilterPeakText(p);
      const width = resofilterWidthText(p);

      await expect(readout(dock, 'peak-db'), `${tag}: peak`).toHaveText(peak);
      await expect(readout(dock, 'band-width'), `${tag}: width`).toHaveText(width);

      // THE PARTITION, as a rendered fact: exactly one of the two is `—`,
      // except in band-pass where both are live. A model that got the mode
      // partition wrong prints a number precisely where the other prints `—`.
      expect(peak === '—', `${tag}: peak blank?`).toBe(!MODES_WITH_PEAK.has(mode));
      expect(width === '—', `${tag}: width blank?`).toBe(!MODES_WITH_WIDTH.has(mode));
      expect(peak === '—' && width === '—', `${tag}: never both blank`).toBe(false);
      seen.push(`${peak} / ${width}`);
    }

    // …and the five states are not five copies of one PAIR, which is exactly
    // what a `{ paramId: 'resonance' }` readout would have produced (one
    // string, five times). Measured at resonance 0.9: LP and HP both read
    // `+14.0 dB / —`, BP reads `+14.0 dB / 0.288 oct`, and NT and AP both read
    // `— / 0.288 oct` — THREE distinct pairs off one dial, which is the face's
    // whole claim expressed as a count.
    expect(
      new Set(seen).size,
      `${TAGS.join('/')} → ${seen.join(' · ')}`,
    ).toBe(3);

    // CV REACH is the mirror — it did NOT move across any of that, because it
    // is a function of CUTOFF alone…
    await expect(readout(dock, 'cv-reach')).toHaveText('20 Hz – 10.99 kHz');
    // …and it DOES move when CUTOFF does. Both directions, so a frozen readout
    // cannot pass either leg.
    await setParams(page, { cutoff: 5000 });
    await expect(readout(dock, 'cv-reach')).toHaveText('20 Hz – 14.99 kHz');
    await setParams(page, { cutoff: 1000 });
    await expect(readout(dock, 'cv-reach')).toHaveText('20 Hz – 10.99 kHz');
  });

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

  test('the sidebar picture agrees with the hero, in one frame — the noise scar', async ({
    page,
  }) => {
    // #1464 shipped a face whose hero printed −10.8/−23.1 dB while a sidebar
    // block two inches below read −7.1/−12.5, both numbers TRUE, both of the
    // same quantity, in one screenshot. Nothing caught it because only one of
    // them was ever read by a gate. Here the panel legend and the hero readout
    // are required to be the same string, in four different states.
    test.setTimeout(SLOW_RENDER ? 90_000 : 45_000);
    await gotoShell(page);
    await spawnPatch(page, [{ id: NODE, type: 'resofilter', position: { x: 300, y: 200 } }]);
    const dock = await openDock(page);
    const panel = page.getByTestId('sidebar-panel-svf-response');
    await expect(panel, 'the response picture renders (a registered panelId)').toBeVisible();
    const legendValue = page.getByTestId('sidebar-panel-svf-value');
    const legendMode = page.getByTestId('sidebar-panel-svf-mode');

    for (const [i, tag] of TAGS.entries()) {
      const mode = i as SvfModeIndex;
      await setParams(page, { mode, resonance: 0.9, cutoff: 1000, mix: 1 });
      await expect(legendMode).toHaveText(tag);
      // The legend prints whichever of the two is live in this mode — the same
      // rule, off the same model, as the hero.
      const hero = MODES_WITH_PEAK.has(mode) ? 'peak-db' : 'band-width';
      const expected = (await readout(dock, hero).textContent())?.trim() ?? '';
      expect(expected, `${tag}: the hero prints a value`).not.toBe('—');
      // uppercase: the legend is `text-transform: uppercase`, the hero is not,
      // so compare case-insensitively rather than pretending they are one node.
      await expect(legendValue).toHaveText(new RegExp(`^${expected.replace(/[.+]/g, '\\$&')}$`, 'i'));
    }
  });

  test('every PRESET produces the value printed beside it', async ({ page }) => {
    // The other half of the loop the unit lane closes: there the note is pinned
    // against the model, here the model is pinned against what the panel shows
    // once the button has actually written the params.
    test.setTimeout(SLOW_RENDER ? 90_000 : 45_000);
    await gotoShell(page);
    await spawnPatch(page, [{ id: NODE, type: 'resofilter', position: { x: 300, y: 200 } }]);
    const dock = await openDock(page);

    const presets: [string, 'peak-db' | 'band-width'][] = [
      ['squelch', 'peak-db'],
      ['notch-out', 'band-width'],
      ['phaser', 'band-width'],
      ['gentle-lp', 'peak-db'],
    ];
    const sidebar = page.getByTestId('dock-full-view');
    for (const [id, which] of presets) {
      const row = sidebar.getByTestId(`face-preset-${id}`);
      await expect(row, `preset '${id}' is offered`).toBeVisible();
      // ⚠ READ THE NOTE ELEMENT, NOT THE ROW. `textContent` on the row returns
      // `squelch+20.0 dB` — it has no line breaks and no separator — so the
      // obvious `.split('\n').pop()` yields the label glued to the note. And
      // `innerText` is not the fix: it APPLIES `text-transform`, so the note
      // comes back `+20.0 DB` against a hero reading `+20.0 dB`. Two DOM
      // readers of "the text" disagreeing about what the text is, which is the
      // same class of blindness as the ellipsis this file's header describes —
      // hence the exact locator plus a case-insensitive compare.
      const note = (await row.locator('.pr-note').textContent())?.trim() ?? '';
      expect(note, `preset '${id}' carries a note`).not.toBe('');
      await row.click();
      await expect(readout(dock, which), `preset '${id}' → ${which}`).toHaveText(
        new RegExp(`^${note.replace(/[.+*?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      );
    }
  });
});
