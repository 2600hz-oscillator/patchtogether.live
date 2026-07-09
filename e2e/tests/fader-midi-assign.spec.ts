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

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import type { Page } from '@playwright/test';

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

  const card = page.locator('.svelte-flow__node-fader').first();
  await expect(card).toBeVisible();

  // ---- A↔B fader ----
  await card.locator('[data-testid="fader-ab"]').click({ button: 'right' });
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
  await expect(card.locator('[data-testid="fader-ab-midi-badge"]'), 'A↔B shows bound badge').toBeVisible();

  // ---- dry/wet fader ----
  await card.locator('[data-testid="fader-drywet"]').click({ button: 'right' });
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-testid="ctx-electra-el1"]'), 'dry/wet is Electra-assignable').toBeVisible();
  await menu.locator('[data-testid="ctx-midi-learn"]').click();
  await injectCc(page, 1, 22, 64); // ≈ 0.504
  await expect
    .poll(() => readParam(page, 'fad1', 'dryWet'), { timeout: 4000 })
    .toBeGreaterThan(0.3);
  await expect(card.locator('[data-testid="fader-drywet-midi-badge"]'), 'dry/wet shows bound badge').toBeVisible();

});
