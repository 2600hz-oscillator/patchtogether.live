// e2e/tests/electra-reconnect.spec.ts
//
// ELECTRA AUTO-RECONNECT (#2248) — "on patch load or F5 the Electra must be
// re-flashed by hand" is fixed by an automatic flash on the (load,
// device-connect) edge. These specs drive the REAL pipeline end to end —
// Canvas's load arm → permission query → broker connect → the same
// `electraSendToDevice` seam the button fires → preset + Lua SysEx on the
// wire — against `installElectraMidiMock` (real hardware cannot run in CI):
//
//   1. patch load with a granted permission + present device → the preset
//      upload happens with NO user action, exactly once, on the CTRL port.
//   2. device absent at load → nothing; hot-plug (statechange burst) → flash.
//   3. NEGATIVE CONTROLS: unrelated graph churn and non-Electra statechange
//      churn after the flash never re-flash; and without a granted permission
//      the whole path is dormant — zero `requestMIDIAccess` calls (the
//      no-ungestured-prompt contract).
//
// The pure edge/debounce machine is unit-pinned in
// `packages/web/src/lib/electra/auto-reconnect.test.ts`; what an e2e adds is
// the WIRING: that Canvas actually arms it on load, that the flash reaches the
// broker's management port, and that a rack gets all of this with zero clicks.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installElectraMidiMock } from '../_helpers/midi';

interface ElectraMidiGlobal {
  accessCallCount(): number;
  presetUploads(): number;
  luaUploads(): number;
  lastPresetPort(): string | null;
  plugIn(): void;
  addForeignPort(): void;
}

type WithElectraMock = { __electraMidi: ElectraMidiGlobal };

function mock(page: Page) {
  return {
    presetUploads: () =>
      page.evaluate(() => (window as unknown as WithElectraMock).__electraMidi.presetUploads()),
    luaUploads: () =>
      page.evaluate(() => (window as unknown as WithElectraMock).__electraMidi.luaUploads()),
    accessCalls: () =>
      page.evaluate(() => (window as unknown as WithElectraMock).__electraMidi.accessCallCount()),
    lastPresetPort: () =>
      page.evaluate(() => (window as unknown as WithElectraMock).__electraMidi.lastPresetPort()),
    plugIn: () =>
      page.evaluate(() => (window as unknown as WithElectraMock).__electraMidi.plugIn()),
    addForeignPort: () =>
      page.evaluate(() => (window as unknown as WithElectraMock).__electraMidi.addForeignPort()),
  };
}

async function bootWithElectra(page: Page): Promise<void> {
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'ec-1', type: 'electraControl', position: { x: 700, y: 60 }, domain: 'meta' },
    { id: 'adsr-1', type: 'adsr', position: { x: 60, y: 60 }, domain: 'audio' },
  ]);
}

test('patch load with a present Electra → the preset flashes with NO user action, once, on CTRL', async ({ page }) => {
  await installElectraMidiMock(page); // device present, permission granted
  const m = mock(page);
  await bootWithElectra(page);

  // The flash fires from the load arm alone — no click anywhere in this test.
  await expect.poll(() => m.presetUploads(), { timeout: 15_000 }).toBe(1);
  // The Lua layer rides the same flash…
  await expect.poll(() => m.luaUploads(), { timeout: 15_000 }).toBe(1);
  // …and management SysEx went down the CTRL port, not a numbered device bus
  // (a preset blasted down Port 1/2 would spew out the hardware DIN jacks).
  expect(await m.lastPresetPort()).toBe('electra-out-ctrl');
});

test('device connects AFTER load → the statechange burst debounces into ONE flash', async ({ page }) => {
  await installElectraMidiMock(page, { devicePresent: false });
  const m = mock(page);
  await bootWithElectra(page);

  // The machine armed and connected (access acquired) but has no device yet:
  // the load edge is parked, nothing was uploaded.
  await expect.poll(() => m.accessCalls(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  expect(await m.presetUploads()).toBe(0);

  // Hot-plug: the mock surfaces the Electra's six USB ports as six discrete
  // statechange events, the burst real hardware produces.
  await m.plugIn();
  await expect.poll(() => m.presetUploads(), { timeout: 15_000 }).toBe(1);
  await expect.poll(() => m.luaUploads(), { timeout: 15_000 }).toBe(1);
});

test('NEGATIVE CONTROLS: graph churn + foreign statechange never re-flash; no permission → fully dormant', async ({ page }) => {
  await installElectraMidiMock(page);
  const m = mock(page);
  await bootWithElectra(page);
  await expect.poll(() => m.presetUploads(), { timeout: 15_000 }).toBe(1);

  // Unrelated graph churn: a param moves, then the WHOLE graph is cleared and
  // respawned with an extra node (spawnPatch clears first — so this is also a
  // delete + re-add of the electraControl node itself, the harshest churn the
  // graph can produce short of an explicit patch LOAD).
  await page.evaluate(() => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
    };
    w.__patch.nodes['adsr-1']!.params.attack = 0.7;
  });
  await spawnPatch(page, [
    { id: 'ec-1', type: 'electraControl', position: { x: 700, y: 60 }, domain: 'meta' },
    { id: 'adsr-1', type: 'adsr', position: { x: 60, y: 60 }, domain: 'audio' },
    { id: 'noise-1', type: 'noise', position: { x: 60, y: 300 }, domain: 'audio' },
  ]);
  // Default shell renders modules as lane FACEPLATES, not xyflow cards — the
  // tile's `data-shell-type` is the shell-agnostic "the spawn landed" signal.
  await expect(page.locator('[data-shell-type="noise"]').first()).toBeVisible();

  // Statechange churn that is NOT an Electra appearing: a foreign interface.
  await m.addForeignPort();

  // pacing: ELECTRA_RECONNECT_SETTLE_MS (500 ms) is the product-side debounce
  // between a MIDI statechange and the auto-flash evaluate — waiting 3× past
  // it proves no deferred flash was parked behind the churn above, which an
  // instantaneous count read could not.
  await page.waitForTimeout(1500);
  expect(await m.presetUploads(), 'churn must never re-flash the device').toBe(1);
});

test('permission not yet granted → dormant: no requestMIDIAccess call, no upload (no ungestured prompt)', async ({ page }) => {
  await installElectraMidiMock(page, { permission: 'prompt' });
  const m = mock(page);
  await bootWithElectra(page);

  // Positive control that the rack (and the electra node) is really up — the
  // default shell mounts it as a lane faceplate, not an xyflow card.
  await expect(page.locator('[data-shell-type="electraControl"]').first()).toBeVisible();

  // pacing: ELECTRA_RECONNECT_SETTLE_MS (500 ms) is the product debounce ahead
  // of any auto-flash evaluate; waiting 3× past it proves the permission gate
  // stayed shut rather than merely not-having-fired-yet at read time.
  await page.waitForTimeout(1500);
  expect(await m.accessCalls(), 'must never request MIDI access without a granted permission').toBe(0);
  expect(await m.presetUploads()).toBe(0);
});
