// e2e/tests/mobile-matrix.spec.ts
//
// PATCH tab (/m/synth) — the mobile FROM→TO pair matrix. Drives crosspoints
// like a user and asserts the RIGHT edges materialize (correct source→target
// DIRECTION, not just a count), that unpatch/replace/fanout behave, stereo
// pairs double-patch, mixmstrs sectioning scopes the grid, and the ALL CABLES
// overview edits the scene. Real store reads via the __patch hook.

import { test, expect } from '@playwright/test';
import { MOBILE_USE, AUDIBLE_RMS, bootFirstBleep, edgeCount, readEdges, readOutputRms } from './_mobile-helpers';

test.use(MOBILE_USE);

async function addReverb(page: import('@playwright/test').Page) {
  await page.getByTestId('m-add-fab').tap();
  await page.getByTestId('m-add-reverb').tap();
  await expect(page.getByTestId('m-pager-title')).toHaveText('reverb');
}

async function setRails(page: import('@playwright/test').Page, from: string, to: string) {
  await page.getByTestId('m-tab-patch').tap();
  await expect(page.getByTestId('m-patch-tab')).toBeVisible();
  await page.getByTestId('m-rail-from').tap();
  await page.getByTestId(`m-pick-${from}`).tap();
  await page.getByTestId('m-rail-to').tap();
  await page.getByTestId(`m-pick-${to}`).tap();
}

test.describe('mobile matrix — crosspoint wiring', () => {
  test('a legalEmpty cell patches in the correct source→target direction', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = await bootFirstBleep(page);
    await addReverb(page);
    await setRails(page, 'analogVco', 'reverb');

    // analogVco.square is unconsumed; reverb.audio is free → hollow ring.
    const cell = page.getByTestId('m-cell-square-audio');
    await expect(cell).toBeVisible();
    await expect(cell).toHaveAttribute('data-kind', 'legalEmpty');

    const before = await edgeCount(page);
    await cell.tap();
    await expect.poll(() => edgeCount(page)).toBe(before + 1);
    await expect(cell).toHaveAttribute('data-kind', 'direct');

    // The edge runs analogVco.square → reverb.audio (NOT reversed).
    const edges = await readEdges(page);
    expect(edges).toContainEqual({ st: 'analogVco', sp: 'square', tt: 'reverb', tp: 'audio' });
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('a direct cell unpatches on tap (+ undo pill)', async ({ page }) => {
    test.setTimeout(120_000);
    await bootFirstBleep(page);
    // delay.audio → mixmstrs ch1 is a template edge; find it in the CH1 grid.
    await setRails(page, 'delay', 'mixmstrs');
    // Default section CH1; the ch1 L+R pair is already patched (direct).
    const pairCell = page.getByTestId('m-cell-audio-ch1L+R');
    await expect(pairCell).toBeVisible();
    await expect(pairCell).toHaveAttribute('data-kind', 'direct');

    const before = await edgeCount(page);
    await pairCell.tap();
    await expect(page.getByTestId('m-undo-pill')).toBeVisible();
    await expect.poll(() => edgeCount(page)).toBe(before - 2); // both L and R drop
    await expect(pairCell).toHaveAttribute('data-kind', 'legalEmpty');
  });

  test('a mono source into a stereo pair row double-patches both sides', async ({ page }) => {
    test.setTimeout(120_000);
    await bootFirstBleep(page);
    await setRails(page, 'analogVco', 'mixmstrs');
    await page.getByTestId('m-mix-section-ch2').tap();

    const pairCell = page.getByTestId('m-cell-square-ch2L+R');
    await expect(pairCell).toBeVisible();
    await expect(pairCell).toHaveAttribute('data-kind', 'legalEmpty');
    const before = await edgeCount(page);
    await pairCell.tap();
    await expect.poll(() => edgeCount(page)).toBe(before + 2);
    const edges = await readEdges(page);
    expect(edges).toContainEqual({ st: 'analogVco', sp: 'square', tt: 'mixmstrs', tp: 'ch2L' });
    expect(edges).toContainEqual({ st: 'analogVco', sp: 'square', tt: 'mixmstrs', tp: 'ch2R' });
  });

  test('an occupied input warns before replacing (+ Cancel is non-destructive)', async ({ page }) => {
    test.setTimeout(120_000);
    await bootFirstBleep(page);
    await setRails(page, 'analogVco', 'vca');
    // vca.audio is fed by analogVco.saw → a sine tap is a destructive replace.
    const cell = page.getByTestId('m-cell-sine-audio');
    await expect(cell).toBeVisible();
    await expect(cell).toHaveAttribute('data-kind', 'inputTaken');

    const before = await edgeCount(page);
    await cell.tap();
    await expect(page.getByTestId('m-replace-sheet')).toBeVisible();
    // Cancel: nothing changes.
    await page.getByText('Cancel', { exact: true }).tap();
    await expect(page.getByTestId('m-replace-sheet')).toHaveCount(0);
    expect(await edgeCount(page)).toBe(before);

    // Replace: the saw cable is swapped for sine (edge count unchanged).
    await cell.tap();
    await page.getByTestId('m-replace-confirm').tap();
    await expect.poll(() => edgeCount(page)).toBe(before);
    const edges = await readEdges(page);
    expect(edges).toContainEqual({ st: 'analogVco', sp: 'sine', tt: 'vca', tp: 'audio' });
    expect(edges).not.toContainEqual({ st: 'analogVco', sp: 'saw', tt: 'vca', tp: 'audio' });
    // Still audible (sine now drives the VCA).
    await expect.poll(() => readOutputRms(page), { timeout: 15_000 }).toBeGreaterThan(AUDIBLE_RMS);
  });
});

test.describe('mobile matrix — overview + scoping', () => {
  test('ALL CABLES lists the scene and ✕ removes an edge', async ({ page }) => {
    test.setTimeout(120_000);
    await bootFirstBleep(page);
    await page.getByTestId('m-tab-patch').tap();
    await page.getByTestId('m-all-cables-toggle').tap();
    const list = page.getByTestId('m-cable-list');
    await expect(list).toBeVisible();
    const rows = list.locator('.cable-row');
    const n0 = await rows.count();
    expect(n0).toBeGreaterThan(0);
    await rows.first().locator('.cable-x').tap();
    await expect(page.getByTestId('m-undo-pill')).toBeVisible();
    await expect.poll(() => rows.count()).toBe(n0 - 1);
  });

  test('mixmstrs sectioning scopes the grid + exposes the cv expander', async ({ page }) => {
    test.setTimeout(120_000);
    await bootFirstBleep(page);
    await setRails(page, 'delay', 'mixmstrs');
    // Default section CH1 shows the patched pair; the CH3 row is not visible
    // (sectioning scopes the 77 mixmstrs inputs to one channel at a time).
    await expect(page.getByTestId('m-cell-audio-ch1L+R')).toHaveAttribute('data-kind', 'direct');
    await expect(page.getByTestId('m-cell-audio-ch3L+R')).toHaveCount(0);

    await page.getByTestId('m-mix-section-ch3').tap();
    // Now CH3 is in scope and CH1 has been scoped away.
    await expect(page.getByTestId('m-cell-audio-ch1L+R')).toHaveCount(0);
    // delay.audio already feeds ch1, so patching it into ch3 is a fanout (the
    // cell is present + patchable, just non-destructive).
    await expect(page.getByTestId('m-cell-audio-ch3L+R')).toHaveAttribute('data-kind', 'outputFanout');
    // The per-section CV inputs are collapsed behind a "+ cv" expander.
    await expect(page.getByTestId('m-cv-expander')).toBeVisible();
    await page.getByTestId('m-cv-expander').tap();
    await expect(page.getByTestId('m-cv-expander')).toHaveCount(0);
  });

  test('the FROM/TO rails swap', async ({ page }) => {
    test.setTimeout(120_000);
    await bootFirstBleep(page);
    await setRails(page, 'analogVco', 'mixmstrs');
    await expect(page.getByTestId('m-rail-from')).toContainText('analog');
    await expect(page.getByTestId('m-rail-to')).toContainText('mixmstrs');
    await page.getByTestId('m-rail-swap').tap();
    await expect(page.getByTestId('m-rail-from')).toContainText('mixmstrs');
    await expect(page.getByTestId('m-rail-to')).toContainText('analog');
  });
});
