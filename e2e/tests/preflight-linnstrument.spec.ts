// PRE-FLIGHT — the LINNSTRUMENT row, driven through the shared WebMIDI double
// (installMidiDeviceMock): named input + output ports, a grant whose timing the
// test decides, byte capture on the output.
//
// What this proves, in order:
//   1. CONNECT enumerates the port through the sysex:false seam (a late Allow
//      — `grant: 'hang'` + grantMidiNow — is honoured, midi-access.ts
//      `onLateResolve`).
//   2. Picking the port writes `rigBindings().setLinnstrument({deviceId})`
//      and the presence lamp follows the LIVE roster.
//   3. THE APPLY STEP IS THE DEVICE LAYER'S: the pick alone puts the instrument
//      into User Firmware Mode — the NRPN 245 transaction leaves the paired
//      OUTPUT port with no further click. (linnstrument-device.ts resolvePorts)
//   4. THE BINDING LIVES IN THE RIG (ADR-011): it is in localStorage
//      `pt:rig-bindings:v1`, survives a reload, and is ABSENT from the Y.Doc
//      after entering the rack — a shared patch never carries a port id.
//
// The bytes are what the firmware documentation says; no LinnStrument was
// connected (the package's C02/C03). ARMED WITH errorWatch.

import { test, expect, type Page } from './_fixtures';
import { installMidiDeviceMock, grantMidiNow, readMidiOutCaptured } from '../_helpers/midi';
import { clearRigStoreOnce, readRig } from '../_helpers/preflight-devices';

const RIG_LS_KEY = 'pt:rig-bindings:v1';
const LINN_IN = 'linn-in';
const LINN_OUT = 'linn-out';
const PORT_NAME = 'LinnStrument MIDI';

// NRPN 245 = User Firmware Mode: MSB 1, LSB 117, data 1 (on).
const USER_MODE_ON: number[][] = [
  [0xb0, 99, 1],
  [0xb0, 98, 117],
  [0xb0, 6, 0],
  [0xb0, 38, 1],
  [0xb0, 101, 127],
  [0xb0, 100, 127],
];

function containsRun(writes: number[][], seq: number[][]): boolean {
  for (let i = 0; i + seq.length <= writes.length; i++) {
    if (seq.every((m, j) => m.every((b, k) => writes[i + j]?.[k] === b) && writes[i + j]?.length === m.length)) return true;
  }
  return false;
}

/** `__preflightReady` is set in onMount, which lands BEFORE SvelteKit's
 *  hydration finishes its route-data fetch; a client navigation started in
 *  that window reports "Failed to fetch" on the console, which errorWatch
 *  (rightly) reddens. So wait for the document to settle, not just mount. */
async function settlePreflight(page: Page): Promise<void> {
  await expect(page.getByTestId('preflight-panel')).toBeVisible();
  await page.waitForFunction(
    () => (globalThis as unknown as { __preflightReady?: boolean }).__preflightReady === true,
    undefined,
    { timeout: 15_000 },
  );
  await page.waitForLoadState('networkidle');
}

async function gotoPreflight(page: Page): Promise<void> {
  await page.goto('/preflight');
  await settlePreflight(page);
}

async function readRigFromLocalStorage(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  }, RIG_LS_KEY);
}

test.describe('PRE-FLIGHT — the LinnStrument row binds through the rig, never the patch', () => {
  test.beforeEach(async ({ page }) => {
    await clearRigStoreOnce(page);
    await installMidiDeviceMock(page, {
      inputs: [
        { id: LINN_IN, name: PORT_NAME },
        { id: 'push2-in', name: 'Ableton Push 2 Live Port' }, // a decoy the matcher must ignore
      ],
      outputs: [
        { id: LINN_OUT, name: PORT_NAME },
        { id: 'push2-out', name: 'Ableton Push 2 Live Port' },
      ],
      grant: 'hang',
    });
  });

  test('connect → select → presence → User Mode on the wire → rig store, not the Y.Doc', async ({ page, errorWatch }) => {
    await gotoPreflight(page);
    const presence = page.getByTestId('preflight-linnstrument-presence');
    const sel = page.getByTestId('preflight-linnstrument-select');

    // Before the grant: nothing listed, lamp idle, and no bytes have left any port.
    await expect(sel.locator('option')).toHaveCount(1);
    await expect(presence).toHaveAttribute('data-state', 'idle');
    expect(await readMidiOutCaptured(page)).toEqual([]);

    // The gesture — the prompt "hangs" until the user answers it late.
    await page.getByTestId('preflight-linnstrument-connect').click();
    await expect(sel.locator('option')).toHaveCount(1); // still nothing: no grant yet
    await grantMidiNow(page);

    // Enumeration through the sysex:false seam: ONLY the LinnStrument port.
    await expect(sel.locator('option', { hasText: PORT_NAME })).toHaveCount(1);
    await expect(sel.locator('option', { hasText: /Push 2/ })).toHaveCount(0);
    await expect(presence).toHaveAttribute('data-state', 'ok');
    // Granted but unbound: the device layer has NOT touched the instrument.
    expect(containsRun((await readMidiOutCaptured(page, LINN_OUT)).map((m) => m.bytes), USER_MODE_ON)).toBe(false);

    // THE PICK writes the rig store…
    await sel.selectOption(LINN_IN);
    await expect
      .poll(async () => ((await readRig(page)).linnstrument as { deviceId?: string } | undefined)?.deviceId, {
        message: 'picking the LinnStrument writes rigBindings().setLinnstrument({deviceId})',
      })
      .toBe(LINN_IN);
    await expect(presence).toHaveAttribute('data-state', 'ok');

    // …and the device layer APPLIES it: User Firmware Mode entry goes out on
    // the paired output, with no further click. Sampled until present with a
    // bounded cap, then re-read and asserted on the second sample.
    await expect
      .poll(async () => containsRun((await readMidiOutCaptured(page, LINN_OUT)).map((m) => m.bytes), USER_MODE_ON), {
        message: 'the pick alone enters User Firmware Mode (NRPN 245) on the LinnStrument output',
        timeout: 10_000,
      })
      .toBe(true);
    const outBytes = (await readMidiOutCaptured(page, LINN_OUT)).map((m) => m.bytes);
    expect(containsRun(outBytes, USER_MODE_ON)).toBe(true);
    // Per-row axis enables follow the entry (CC 9..12 = 1 on every row channel).
    for (let row = 0; row < 8; row++) {
      for (const cc of [9, 10, 11, 12]) {
        expect(outBytes.some((m) => m[0] === (0xb0 | row) && m[1] === cc && m[2] === 1), `row ${row} CC${cc}`).toBe(true);
      }
    }
    // NEGATIVE CONTROL — the decoy output received nothing.
    expect(await readMidiOutCaptured(page, 'push2-out')).toEqual([]);

    // THE BINDING LIVES IN localStorage under the rig key…
    const ls = await readRigFromLocalStorage(page);
    expect(ls?.linnstrument).toEqual({ deviceId: LINN_IN });

    // …survives a reload (the store re-hydrates from the same key)…
    await page.reload();
    await settlePreflight(page);
    await expect
      .poll(async () => ((await readRig(page)).linnstrument as { deviceId?: string } | undefined)?.deviceId)
      .toBe(LINN_IN);
    await expect(sel).toHaveValue(LINN_IN);
    // A fresh document has NOT prompted: the roster is empty until the gesture,
    // so a bound-but-unscanned lamp reads 'down' (not connected) — that is the
    // honest reading of "we cannot see the port yet", never a silent prompt.
    await expect(presence).toHaveAttribute('data-state', 'down');
    expect(await readMidiOutCaptured(page, LINN_OUT)).toEqual([]);

    // …and is ABSENT from the Y.Doc once the rack is open (ADR-011).
    await page.getByTestId('preflight-enter').click();
    await page.waitForURL(/\/rack(\?|$)/, { timeout: 30_000 });
    await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
    const doc = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __ydoc?: { toJSON?: () => Record<string, unknown>; share?: Map<string, unknown> };
        __rigBindings?: () => Record<string, unknown>;
      };
      const d = w.__ydoc;
      const json = d && typeof d.toJSON === 'function' ? d.toJSON() : null;
      return {
        keys: json ? Object.keys(json) : null,
        text: json ? JSON.stringify(json) : null,
        rig: w.__rigBindings ? w.__rigBindings() : null,
      };
    });
    // The doc is real (it has shared types) — an empty doc would pass vacuously.
    expect(doc.keys, '__ydoc.toJSON() reachable on the rack').not.toBeNull();
    expect(doc.keys!.length).toBeGreaterThan(0);
    expect(doc.text).not.toContain(LINN_IN);
    expect(doc.text).not.toContain('"linnstrument"');
    // …while the rig store on the SAME page still carries it.
    expect((doc.rig?.linnstrument as { deviceId?: string } | undefined)?.deviceId).toBe(LINN_IN);
    errorWatch.assertClean();
  });

  test('clearing the pick releases the port: User Mode exit goes out and the store drops the key', async ({ page, errorWatch }) => {
    await gotoPreflight(page);
    await page.getByTestId('preflight-linnstrument-connect').click();
    await grantMidiNow(page);
    const sel = page.getByTestId('preflight-linnstrument-select');
    await expect(sel.locator('option', { hasText: PORT_NAME })).toHaveCount(1);
    await sel.selectOption(LINN_IN);
    await expect
      .poll(async () => containsRun((await readMidiOutCaptured(page, LINN_OUT)).map((m) => m.bytes), USER_MODE_ON), { timeout: 10_000 })
      .toBe(true);

    await sel.selectOption('');
    await expect.poll(async () => (await readRig(page)).linnstrument).toBeUndefined();
    // NRPN 245 = 0: the temporary User Mode layer is released.
    await expect
      .poll(async () => {
        const bytes = (await readMidiOutCaptured(page, LINN_OUT)).map((m) => m.bytes);
        return containsRun(bytes, [[0xb0, 99, 1], [0xb0, 98, 117], [0xb0, 6, 0], [0xb0, 38, 0]]);
      }, { message: 'clearing the pick sends the User Firmware Mode exit', timeout: 10_000 })
      .toBe(true);
    expect((await readRigFromLocalStorage(page))?.linnstrument).toBeUndefined();
    errorWatch.assertClean();
  });
});
