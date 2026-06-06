// e2e/tests/midi-out-buddy.spec.ts
//
// MIDI-OUT-BUDDY (label "MIDI CV BUDDY OUT") end-to-end coverage.
//
// This is the OUTPUT complement of midi-cv-buddy: gate/pitch/velocity CV in →
// MIDI notes out to an external device. Real hardware isn't available in CI,
// so we install a FAKE navigator.requestMIDIAccess whose MIDIOutput CAPTURES
// every `send()` into window.__midiOutSent. We then:
//   1. spawn the module + a self-running SEQUENCER, wire SEQUENCER.gate →
//      midiOutBuddy.gate and SEQUENCER.pitch → midiOutBuddy.pitch,
//   2. connect the module via its card-api + select the fake output,
//   3. play the sequencer and assert a MIDI NoteOn (0x90..0x9F) was captured.
//
// Handle presence + the no-console-error spawn are the lighter assertions;
// the captured-NoteOn is the real proof the CV→MIDI send path fires. The pure
// CV→MIDI mapping + note-tracking math is covered by the unit test
// (packages/web/src/lib/audio/modules/midi-out-buddy.test.ts).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

const TYPE = 'midiOutBuddy';

// Init script: replace navigator.requestMIDIAccess with a fake that exposes a
// single capturing OUTPUT. Must run BEFORE the app boots so the first
// requestMIDIAccess sees the fake.
const fakeMidiOutScript = `
(() => {
  if (window.__fakeMidiOutInstalled) return;
  window.__fakeMidiOutInstalled = true;
  window.__midiOutSent = []; // array of number[] messages

  const output = {
    id: 'fake-midi-out-0',
    name: 'Fake MIDI Out (Playwright)',
    manufacturer: 'PatchTogether',
    state: 'connected',
    connection: 'open',
    type: 'output',
    version: '1.0',
    send(data) { window.__midiOutSent.push(Array.from(data)); },
    clear() {},
  };
  const access = {
    sysexEnabled: false,
    inputs: new Map(),
    outputs: new Map([[output.id, output]]),
    onstatechange: null,
  };
  navigator.requestMIDIAccess = async () => access;
})();
`;

async function installFakeMidiOut(page: Page): Promise<void> {
  await page.addInitScript({ content: fakeMidiOutScript });
}

test('midi-out-buddy: drops + card mounts with the 3 input handles, no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await installFakeMidiOut(page);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'm', type: TYPE, position: { x: 200, y: 200 } }]);

  const card = page.locator(`.svelte-flow__node-${TYPE}`);
  await expect(card).toBeVisible();
  // Every declared input port renders a handle.
  for (const portId of ['gate', 'pitch', 'velocity']) {
    await expect(card.locator(`[data-handleid="${portId}"]`)).toHaveCount(1);
  }
  expect(errors, errors.join('; ')).toEqual([]);
});

test('midi-out-buddy: Connect MIDI… reveals the OUT device + channel selectors', async ({ page }) => {
  await installFakeMidiOut(page);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'm', type: TYPE, position: { x: 200, y: 200 } }]);

  const card = page.locator(`.svelte-flow__node-${TYPE}`);
  await expect(card).toBeVisible();
  const btn = card.getByRole('button', { name: /Connect MIDI/ });
  await expect(btn).toBeVisible();
  await btn.click();
  // The fake resolves immediately → the device + channel dropdowns appear.
  await expect(card.locator('select')).toHaveCount(2);
  // The fake output is listed by name.
  await expect(card.getByRole('option', { name: 'Fake MIDI Out (Playwright)' })).toHaveCount(1);
});

test('midi-out-buddy: SEQUENCER gate/pitch → captured MIDI NoteOn on the fake output', async ({ page }) => {
  test.setTimeout(45_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await installFakeMidiOut(page);
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // SEQUENCER (fast, playing) → midiOutBuddy gate + pitch.
  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'sequencer', position: { x: 60, y: 60 }, params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.5 } },
      { id: 'm', type: TYPE, position: { x: 400, y: 60 } },
    ],
    [
      { id: 'e-gate', from: { nodeId: 'seq', portId: 'gate' }, to: { nodeId: 'm', portId: 'gate' }, sourceType: 'gate', targetType: 'gate' },
      { id: 'e-pitch', from: { nodeId: 'seq', portId: 'pitch' }, to: { nodeId: 'm', portId: 'pitch' }, sourceType: 'cv', targetType: 'cv' },
    ],
  );

  // Seed sequencer steps (defaults are all off) so it actually pulses gate.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['seq'];
      if (!n) return;
      if (!n.data) n.data = {};
      n.data.steps = [
        { on: true, midi: 72 }, // C5 = +1 V/oct
        { on: true, midi: 67 },
        { on: true, midi: 64 },
        { on: true, midi: 60 },
      ];
    });
  });

  // Connect the module's MIDI output + select the fake device.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    return (async () => {
      const eng = w.__engine?.();
      const node = w.__patch.nodes['m'];
      if (!eng || !node) return;
      const api = eng.read(node, 'card-api') as
        | { connect: () => Promise<boolean>; selectDevice: (id: string | null) => void }
        | undefined;
      if (!api) return;
      await api.connect();
      api.selectDevice('fake-midi-out-0');
    })();
  });

  // Poll until a NoteOn (status 0x90..0x9F) is captured. The sequencer at
  // 240 BPM steps every 250 ms, so a few seconds is plenty.
  await page.waitForFunction(
    () => {
      const sent = (window as unknown as { __midiOutSent?: number[][] }).__midiOutSent ?? [];
      return sent.some((m) => (m[0] ?? 0) >= 0x90 && (m[0] ?? 0) <= 0x9f && (m[2] ?? 0) > 0);
    },
    undefined,
    { timeout: 20_000 },
  );

  const sent = await page.evaluate(() => (window as unknown as { __midiOutSent: number[][] }).__midiOutSent);
  const noteOn = sent.find((m) => (m[0] ?? 0) >= 0x90 && (m[0] ?? 0) <= 0x9f && (m[2] ?? 0) > 0);
  expect(noteOn, 'a NoteOn was sent').toBeTruthy();
  if (noteOn) {
    // Channel 1 (default) → status 0x90; note is a valid 7-bit value; velocity 1..127.
    expect(noteOn[0]).toBe(0x90);
    expect(noteOn[1]).toBeGreaterThanOrEqual(0);
    expect(noteOn[1]).toBeLessThanOrEqual(127);
    expect(noteOn[2]).toBeGreaterThanOrEqual(1);
    expect(noteOn[2]).toBeLessThanOrEqual(127);
  }

  expect(errors, errors.join('; ')).toEqual([]);
});
