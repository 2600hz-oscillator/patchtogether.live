import { test, expect, type Page } from './_fixtures';
import { spawnPatch } from './_helpers';
import { clearRigStoreOnce, installFakeShell, readRig, FAKE_SHELL_STORE_KEY } from '../_helpers/preflight-devices';
import { installMidiDeviceMock, injectMidiDeviceIn, unplugMidiPort, plugMidiPort } from '../_helpers/midi';
import { readScopePeakOverWindow } from './_module-coverage-helpers';
import { sampleScopeRms } from '../_helpers/scope-poll';
import { BOOT_MS } from '../_helpers/boot-budget';

const INPUT = { id: 'saved-trails', name: 'Bela Trails' };
const OTHER = { id: 'other-trails', name: 'Trails Two' };
const FLOOR = 0.03;

async function ready(page: Page): Promise<void> {
  await expect(page.getByTestId('preflight-panel')).toBeVisible({ timeout: BOOT_MS });
  await page.waitForFunction(() => (globalThis as unknown as { __preflightReady?: boolean }).__preflightReady, undefined, { timeout: BOOT_MS });
  await page.waitForLoadState('networkidle');
}

test.beforeEach(async ({ page }) => {
  await clearRigStoreOnce(page);
  await installFakeShell(page);
  await installMidiDeviceMock(page, { inputs: [INPUT, OTHER, { id: 'decoy', name: 'Other MIDI' }], outputs: [] });
});

test('saved TRAILS restores after document reload and rack entry, produces audio, and releases notes on unplug', async ({ page, errorWatch }) => {
  await page.goto('/preflight');
  await ready(page);
  await page.getByTestId('preflight-trails-connect').click();
  const select = page.getByTestId('preflight-trails-select');
  await expect(select.locator('option')).toHaveCount(3);
  await select.selectOption(INPUT.id);
  await expect.poll(async () => (await readRig(page)).trails).toEqual({ deviceId: INPUT.id, deviceName: INPUT.name });
  await page.reload();
  await ready(page);
  await expect(select).toHaveValue(INPUT.id);
  await expect(page.getByTestId('preflight-trails-connect')).toHaveText('rescan');
  await expect(page.getByTestId('preflight-trails-presence')).toHaveAttribute('data-state', 'ok');
  // No Connect gesture on this new renderer: restoration must attach the port.
  expect(await injectMidiDeviceIn(page, INPUT.id, [0xf8])).toBe(true);
  expect(await injectMidiDeviceIn(page, OTHER.id, [0xf8])).toBe(false);

  await page.getByTestId('preflight-enter').click();
  await page.waitForURL(/\/rack(\?|$)/);
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await spawnPatch(page, [
    { id: 'tr', type: 'trails', domain: 'audio', position: { x: 40, y: 40 } },
    { id: 'osc', type: 'analogVco', domain: 'audio', position: { x: 320, y: 40 } },
    { id: 'amp', type: 'vca', domain: 'audio', position: { x: 560, y: 40 }, params: { base: 0, cvAmount: 1 } },
    { id: 'scp', type: 'scope', domain: 'audio', position: { x: 800, y: 40 } },
  ], [
    { id: 'audio', from: { nodeId: 'osc', portId: 'sine' }, to: { nodeId: 'amp', portId: 'audio' }, sourceType: 'audio', targetType: 'audio' },
    { id: 'gate', from: { nodeId: 'tr', portId: 'g1' }, to: { nodeId: 'amp', portId: 'cv' }, sourceType: 'gate', targetType: 'cv' },
    { id: 'scope', from: { nodeId: 'amp', portId: 'audio' }, to: { nodeId: 'scp', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
  ]);
  // Render real Web Audio into Chromium's silent sink so a disconnected or
  // busy host audio interface cannot freeze this MIDI/DSP integration test.
  await page.evaluate(async () => {
    const w = window as unknown as { __engine(): { getDomain(name: string): { ctx: AudioContext & { setSinkId(sink: { type: 'none' }): Promise<void> } } } };
    await w.__engine().getDomain('audio').ctx.setSinkId({ type: 'none' });
  });
  const silent = await readScopePeakOverWindow(page, 'scp', 500);
  expect(silent.polls).toBeGreaterThan(0);
  expect(silent.rms).toBeLessThan(FLOOR);
  await expect.poll(() => injectMidiDeviceIn(page, INPUT.id, [0xf8])).toBe(true);
  expect(await injectMidiDeviceIn(page, OTHER.id, [0x90, 60, 100])).toBe(false);
  expect(await injectMidiDeviceIn(page, INPUT.id, [0x90, 60, 100])).toBe(true);
  const playing = await readScopePeakOverWindow(page, 'scp', 6000, { untilPeak: FLOOR });
  expect(playing.polls).toBeGreaterThan(0);
  expect(playing.peak).toBeGreaterThan(FLOOR);
  await unplugMidiPort(page, INPUT.id);
  const stopped = await sampleScopeRms(page, 'scp', 25, 20);
  expect(stopped.samples).toBeGreaterThan(0);
  expect(stopped.lo).toBeLessThan(FLOOR);
  expect((await readRig(page)).trails).toEqual({ deviceId: INPUT.id, deviceName: INPUT.name });
  await plugMidiPort(page, 'input', INPUT);
  await expect.poll(() => injectMidiDeviceIn(page, INPUT.id, [0xf8])).toBe(true);
  const persisted = await page.evaluate((key) => localStorage.getItem(key), FAKE_SHELL_STORE_KEY);
  expect(persisted).toContain(INPUT.id);
  const doc = await page.evaluate(() => (window as unknown as { __ydoc: { toJSON(): unknown } }).__ydoc.toJSON());
  expect(Object.keys(doc as object).length).toBeGreaterThan(0);
  expect(JSON.stringify(doc)).not.toContain(INPUT.id);
  errorWatch.assertClean();
});

test('missing TRAILS stays selected, can reconnect, and clearing the pick remains cleared after reload', async ({ page, errorWatch }) => {
  await page.goto('/preflight');
  await ready(page);
  await page.getByTestId('preflight-trails-connect').click();
  const select = page.getByTestId('preflight-trails-select');
  await select.selectOption(INPUT.id);
  await unplugMidiPort(page, INPUT.id);
  await expect(page.getByTestId('preflight-trails-presence')).toHaveAttribute('data-state', 'down');
  await expect(select).toHaveValue(INPUT.id);
  expect(await injectMidiDeviceIn(page, INPUT.id, [0xf8])).toBe(false);
  await plugMidiPort(page, 'input', INPUT);
  await expect(page.getByTestId('preflight-trails-presence')).toHaveAttribute('data-state', 'ok');
  await select.selectOption('');
  expect(await injectMidiDeviceIn(page, INPUT.id, [0xf8])).toBe(false);
  await page.reload();
  await ready(page);
  await expect(select).toHaveValue('');
  expect((await readRig(page)).trails).toBeUndefined();
  expect(await injectMidiDeviceIn(page, INPUT.id, [0xf8])).toBe(false);
  errorWatch.assertClean();
});
