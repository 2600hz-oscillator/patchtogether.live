// e2e/tests/preset-slots-and-sets.spec.ts
//
// Quick-switch PRESET SLOT bar (top-left of the menu bar) + the portable
// `.set` (zip-of-zips of all five slots + the MIDI map).
//
// Behaviour pinned here (end-to-end through the REAL handlers, not just the
// pure cores — those have their own unit suites):
//   1. Five numbered slot buttons render; an EMPTY slot is RED.
//   2. Store a (fixtured) performance .zip into a slot → it turns GREEN.
//   3. LEFT-click the GREEN slot → it loads the stored perf (the patch changes:
//      a node from the preset appears) — no file dialog.
//   4. Clear the slot → it goes back to RED.
//   5. Save Set captures the bar into a `.set`; Load Set repopulates the slots
//      (occupied → green) from a captured `.set`.
//
// The perf-zip bytes are captured at runtime via the existing __perfZip export
// hook (so no committed binary fixture is needed), and pushed into a slot via
// the __presetSet hook (which mirrors the real load handler but skips the OS
// file picker — which Playwright can't drive headlessly). The slot's
// red→green→load→red lifecycle and the .set round-trip are otherwise exactly
// the production code paths.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const PRESET_NODE = 'preset-vco';

async function setup(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  return errors;
}

/** Count nodes in the live patch. */
async function nodeCount(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, unknown> } };
    return Object.keys(w.__patch.nodes).length;
  });
}

/** Capture the current rack as performance-zip bytes, base64'd over CDP. */
async function capturePerfZipB64(page: Page): Promise<string> {
  return await page.evaluate(async () => {
    const w = globalThis as unknown as { __perfZip: { export: () => Promise<Uint8Array> } };
    const bytes = await w.__perfZip.export();
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
    return btoa(bin);
  });
}

/** Push captured perf-zip bytes into a slot via the test hook (skips the OS
 *  picker). The hook mirrors the real load handler's IDB write + green flip. */
async function putSlotFromB64(page: Page, index: number, b64: string, label?: string): Promise<void> {
  await page.evaluate(async ({ index, b64, label }) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const w = globalThis as unknown as { __presetSet: { putSlot: (i: number, b: Uint8Array, l?: string) => Promise<void> } };
    await w.__presetSet.putSlot(index, bytes, label);
  }, { index, b64, label });
}

test.describe('Preset slots + portable .set', () => {
  test('empty=red → load=green → click loads → clear=red', async ({ page }) => {
    const errors = await setup(page);

    // ---- 1. The bar renders; slot 1 is empty (red). ----
    const bar = page.getByTestId('preset-slot-bar');
    await expect(bar).toBeVisible();
    const slot1 = page.getByTestId('preset-slot-1');
    await expect(slot1).toBeVisible();
    await expect(slot1).toHaveAttribute('data-occupied', 'false');

    // ---- Build a one-node preset + capture its perf zip. ----
    await spawnPatch(page, [
      { id: PRESET_NODE, type: 'analogVco', position: { x: 120, y: 120 } },
    ]);
    await expect.poll(() => nodeCount(page)).toBe(1);
    const presetB64 = await capturePerfZipB64(page);
    expect(presetB64.length).toBeGreaterThan(100);

    // ---- 2. Store into slot 1 → it turns green. ----
    await putSlotFromB64(page, 0, presetB64, 'vco.ptperf.zip');
    await expect(slot1).toHaveAttribute('data-occupied', 'true');

    // ---- Clear the rack (new, empty rack) so the load is observable. ----
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        for (const id of Object.keys(w.__patch.edges)) delete w.__patch.edges[id];
        for (const id of Object.keys(w.__patch.nodes)) delete w.__patch.nodes[id];
      });
    });
    await expect.poll(() => nodeCount(page)).toBe(0);

    // ---- 3. LEFT-click the green slot → the preset loads (node reappears). ----
    await slot1.click();
    await expect.poll(() => nodeCount(page), { timeout: 8000 }).toBe(1);
    await expect(page.locator(`.svelte-flow__node[data-id="${PRESET_NODE}"]`)).toBeVisible({ timeout: 8000 });

    // ---- 4. Right-click → Clear slot → back to red. ----
    await slot1.click({ button: 'right' });
    const menu = page.getByTestId('preset-slot-menu');
    await expect(menu).toBeVisible();
    await page.getByTestId('slot-menu-clear').click();
    await expect(slot1).toHaveAttribute('data-occupied', 'false');

    expect(errors, `page errors: ${errors.join('\n')}`).toEqual([]);
  });

  test('Save Set captures the bar → Load Set repopulates slots green', async ({ page }) => {
    const errors = await setup(page);

    // Build + capture a preset, store it into slots 1 and 3.
    await spawnPatch(page, [
      { id: PRESET_NODE, type: 'analogVco', position: { x: 120, y: 120 } },
    ]);
    await expect.poll(() => nodeCount(page)).toBe(1);
    const presetB64 = await capturePerfZipB64(page);
    await putSlotFromB64(page, 0, presetB64, 'a.ptperf.zip');
    await putSlotFromB64(page, 2, presetB64, 'b.ptperf.zip');

    await expect(page.getByTestId('preset-slot-1')).toHaveAttribute('data-occupied', 'true');
    await expect(page.getByTestId('preset-slot-3')).toHaveAttribute('data-occupied', 'true');
    await expect(page.getByTestId('preset-slot-2')).toHaveAttribute('data-occupied', 'false');

    // ---- 5a. Save Set → capture the .set bytes (via the hook, no download). ----
    const setB64 = await page.evaluate(async () => {
      const w = globalThis as unknown as { __presetSet: { buildSet: () => Promise<Uint8Array> } };
      const bytes = await w.__presetSet.buildSet();
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
      return btoa(bin);
    });
    expect(setB64.length, 'a .set carrying two perf zips is non-trivial').toBeGreaterThan(500);

    // The Save Set button itself is wired + enabled (clicks the real download).
    await expect(page.getByTestId('save-set-btn')).toBeEnabled();
    await expect(page.getByTestId('load-set-btn')).toBeEnabled();

    // ---- Clear ALL slots so Load Set's repopulate is observable. ----
    await page.evaluate(async () => {
      const w = globalThis as unknown as { __presetSet: { clearSlot: (i: number) => Promise<void> } };
      for (let i = 0; i < 5; i++) await w.__presetSet.clearSlot(i);
    });
    await expect(page.getByTestId('preset-slot-1')).toHaveAttribute('data-occupied', 'false');
    await expect(page.getByTestId('preset-slot-3')).toHaveAttribute('data-occupied', 'false');

    // ---- 5b. Load Set from the captured bytes → slots 1 & 3 green, 2 red. ----
    await page.evaluate(async (b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const w = globalThis as unknown as { __presetSet: { loadSet: (b: Uint8Array) => Promise<void> } };
      await w.__presetSet.loadSet(bytes);
    }, setB64);

    await expect(page.getByTestId('preset-slot-1')).toHaveAttribute('data-occupied', 'true');
    await expect(page.getByTestId('preset-slot-3')).toHaveAttribute('data-occupied', 'true');
    await expect(page.getByTestId('preset-slot-2')).toHaveAttribute('data-occupied', 'false');
    await expect(page.getByTestId('preset-slot-4')).toHaveAttribute('data-occupied', 'false');
    await expect(page.getByTestId('preset-slot-5')).toHaveAttribute('data-occupied', 'false');

    expect(errors, `page errors: ${errors.join('\n')}`).toEqual([]);
  });
});
