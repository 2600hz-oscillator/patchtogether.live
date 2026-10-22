import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow, describeScopeWindow } from './_module-coverage-helpers';
import { sampleScopeRms } from '../_helpers/scope-poll';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS);

interface DualTrails {
  send(id: string, bytes: number[]): void;
  connected(id: string, connected: boolean): void;
  stream(id: string, enabled: boolean): void;
}
declare global { interface Window { __dualTrails: DualTrails } }

async function installInputs(page: Page) {
  await page.addInitScript(() => {
    type Input = { id: string; name: string; state: string; onmidimessage: ((e: { data: Uint8Array; timeStamp: number }) => void) | null };
    const inputs = new Map<string, Input>(['usb-a', 'usb-b'].map((id) => [
      id, { id, name: 'Bela Trails', state: 'connected', onmidimessage: null },
    ]));
    const access = { inputs, outputs: new Map(), onstatechange: null as (() => void) | null };
    Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async () => access });
    const timers = new Map<string, number>();
    window.__dualTrails = {
      send(id, bytes) {
        const input = inputs.get(id)!;
        if (input.state === 'connected') input.onmidimessage?.({ data: Uint8Array.from(bytes), timeStamp: performance.now() });
      },
      connected(id, connected) {
        inputs.get(id)!.state = connected ? 'connected' : 'disconnected';
        access.onstatechange?.();
      },
      stream(id, enabled) {
        clearInterval(timers.get(id));
        if (!enabled) return;
        const send = () => {
          window.__dualTrails.send(id, [0xb0, 15, 100]);
          window.__dualTrails.send(id, [0xb1, 15, 50]);
        };
        send();
        // The simulated USB source cadence, not a renderer readiness delay.
        timers.set(id, window.setInterval(send, 20));
      },
    };
  });
}

async function spawnChains(page: Page) {
  await spawnPatch(page, [
    { id: 'osc', type: 'analogVco', domain: 'audio', position: { x: 0, y: 0 } },
    ...['a', 'b'].flatMap((id, i) => [
      { id, type: 'trails', domain: 'audio' as const, position: { x: 200 + i * 300, y: 100 } },
      { id: 'vca-' + id, type: 'vca', domain: 'audio' as const, position: { x: 200, y: 400 + i * 200 }, params: { base: 0, cvAmount: 1 } },
      { id: 'scope-' + id, type: 'scope', domain: 'audio' as const, position: { x: 600, y: 400 + i * 200 } },
    ]),
  ], ['a', 'b'].flatMap((id) => [
    { id: 'osc-' + id, from: { nodeId: 'osc', portId: 'sine' }, to: { nodeId: 'vca-' + id, portId: 'audio' }, sourceType: 'audio' as const, targetType: 'audio' as const },
    { id: 'gate-' + id, from: { nodeId: id, portId: 'g1' }, to: { nodeId: 'vca-' + id, portId: 'cv' }, sourceType: 'gate' as const, targetType: 'cv' as const },
    { id: 'out-' + id, from: { nodeId: 'vca-' + id, portId: 'audio' }, to: { nodeId: 'scope-' + id, portId: 'ch1' }, sourceType: 'audio' as const, targetType: 'audio' as const },
  ]));
}

async function dock(page: Page, id: string) {
  const plate = page.getByTestId('dock-full-view').locator(`[data-shell-tier="dock"][data-shell-node="${id}"]`);
  await expect(async () => {
    if (!(await plate.count())) {
      await page.locator(`.svelte-flow__node[data-id="${id}"]`).getByTestId('shell-open-dock').click();
    }
    await expect(plate).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: BOOT_MS });
  return plate;
}

async function audible(page: Page, id: string) {
  const result = await readScopePeakOverWindow(page, 'scope-' + id, 6000, { untilPeak: 0.03 });
  expect(result.peak, describeScopeWindow(result)).toBeGreaterThan(0.03);
}

async function silent(page: Page, id: string) {
  // First let the analyser flush old sound, then require an entire silent window.
  await expect.poll(async () => (await sampleScopeRms(page, 'scope-' + id, 4, 20)).hi).toBeLessThan(0.03);
  const result = await readScopePeakOverWindow(page, 'scope-' + id, 500);
  expect(result.polls, describeScopeWindow(result)).toBeGreaterThan(0);
  expect(result.peak, describeScopeWindow(result)).toBeLessThan(0.03);
}

test('@trails two same-name USB devices route independently through the picker and survive unplug/reload', async ({ page, errorWatch }, testInfo) => {
  await installInputs(page);
  await page.goto('/rack?seed=none');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await spawnChains(page);
  const a = await dock(page, 'a');
  await a.getByTestId('shell-cell-trails-connect').click();
  await a.getByTestId('trails-input-a').selectOption('usb-a');
  const b = await dock(page, 'b');
  await b.getByTestId('trails-input-b').selectOption('usb-b');
  await expect(b.getByTestId('trails-input-b')).toContainText('Bela Trails · usb-a');
  await expect(b.getByTestId('trails-input-b')).toContainText('Bela Trails · usb-b');
  await b.screenshot({ path: testInfo.outputPath('trails-input-picker.png') });

  await silent(page, 'a');
  await silent(page, 'b');
  await page.evaluate(() => window.__dualTrails.stream('usb-a', true));
  await audible(page, 'a');
  await silent(page, 'b'); // A's continuous CC must never reach B.

  await page.evaluate(() => {
    window.__dualTrails.stream('usb-a', false);
    window.__dualTrails.send('usb-a', [0x90, 60, 100]);
    window.__dualTrails.send('usb-b', [0x90, 72, 100]);
  });
  await audible(page, 'a');
  await audible(page, 'b');
  await page.evaluate(() => window.__dualTrails.connected('usb-a', false));
  await silent(page, 'a');
  await audible(page, 'b'); // Unplugging A must not reset B's held note.
  const missing = await dock(page, 'a');
  await expect(missing.getByTestId('trails-face-status-a')).toContainText('not connected');
  await expect(missing.getByTestId('trails-input-a')).toHaveValue('usb-a');

  await page.evaluate(() => {
    window.__dualTrails.connected('usb-a', true);
    window.__dualTrails.stream('usb-a', true);
    window.__dualTrails.send('usb-b', [0x90, 72, 0]);
  });
  await audible(page, 'a');
  await silent(page, 'b');

  // Reload restores local choices by node id; browser MIDI still needs CONNECT.
  await page.reload();
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await spawnChains(page);
  const restoredA = await dock(page, 'a');
  await restoredA.getByTestId('shell-cell-trails-connect').click();
  await expect(restoredA.getByTestId('trails-input-a')).toHaveValue('usb-a');
  const restoredB = await dock(page, 'b');
  await expect(restoredB.getByTestId('trails-input-b')).toHaveValue('usb-b');
  await page.evaluate(() => window.__dualTrails.stream('usb-b', true));
  await silent(page, 'a');
  await audible(page, 'b');
  errorWatch.assertClean();
});
