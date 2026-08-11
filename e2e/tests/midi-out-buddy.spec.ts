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

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import {
  DEFAULT_FAKE_MIDI_OUT,
  installMidiOutCapture,
  readMidiOutCaptured,
} from '../_helpers/midi';

test.describe.configure({ mode: 'parallel' });

const TYPE = 'midiOutBuddy';

// The capturing Web MIDI mock now lives in `e2e/_helpers/midi.ts` — this
// spec's private copy was one of two verbatim duplicates (the other is in
// workflow-channel-columns.spec.ts) and a third was about to be written.
// The extracted helper keeps this spec's exact port id + name, so the wire
// behaviour is unchanged.
async function installFakeMidiOut(page: Page): Promise<void> {
  await installMidiOutCapture(page);
}

test('midi-out-buddy: drops + card mounts with EVERY declared input handle, no console errors', async ({ page, errorWatch }) => {
  await installFakeMidiOut(page);
  await page.goto('/rack?shell=legacy&seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'm', type: TYPE, position: { x: 200, y: 200 } }]);

  const card = page.locator(`.svelte-flow__node-${TYPE}`);
  await expect(card).toBeVisible();
  // Every declared input port renders a handle — the list is READ FROM THE
  // LIVE DEF, not re-typed here. It used to be the literal trio
  // ['gate','pitch','velocity'] under this same "every declared input"
  // comment, so when the def gained its `poly` bus the assertion kept passing
  // while checking 3 of 4 ports — a gate whose stated scope exceeded what it
  // verified, and the card shipped without a poly jack anyway (caught only by
  // modules.spec's handle COUNT). Deriving keeps the claim and the check the
  // same thing.
  const declaredInputs: string[] = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __moduleSpecs?: { type: string; inputs?: { id: string }[] }[];
    };
    const spec = (w.__moduleSpecs ?? []).find((s) => s.type === 'midiOutBuddy');
    return (spec?.inputs ?? []).map((p) => p.id);
  });
  expect(declaredInputs.length, 'def inputs resolved from __moduleSpecs').toBeGreaterThan(0);
  expect(declaredInputs, 'the poly bus is a declared input').toContain('poly');
  for (const portId of declaredInputs) {
    await expect(card.locator(`[data-handleid="${portId}"]`), `${portId} handle`).toHaveCount(1);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// THE INSTRUMENT'S OWN NEGATIVE CONTROL — runs on every pass, not once.
//
// `readMidiOutCaptured` returning `[]` has TWO causes that are indistinguishable
// from the return value alone: (a) the mock is installed and the app genuinely
// sent nothing, or (b) the init script never ran, so the hook does not exist and
// every "no bytes were sent" assertion in this file — and in the device specs
// that reuse this helper — passes vacuously forever.
//
// This is the `delivered: false` discipline from the audition ledger applied to
// a capture buffer: "recorded nothing" must be distinguishable from "never
// recorded". So the emptiness assertion is paired with a POSITIVE assertion
// that the buffer EXISTS and is an array. The companion direction — that the
// instrument really does see bytes when bytes are sent — is the captured-NoteOn
// test below, which is what makes this pair a both-directions control rather
// than half of one.
// ─────────────────────────────────────────────────────────────────────────────
test('midi-out-capture-instrument: the buffer EXISTS and is empty before anything sends', async ({ page }) => {
  await installFakeMidiOut(page);
  await page.goto('/rack?shell=legacy&seed=none');
  await page.waitForLoadState('networkidle');

  const probe = await page.evaluate(() => {
    const w = window as unknown as {
      __fakeMidiOutInstalled?: boolean;
      __midiOutSent?: unknown;
      __midiOutSentDetailed?: unknown;
    };
    return {
      installed: w.__fakeMidiOutInstalled === true,
      flatIsArray: Array.isArray(w.__midiOutSent),
      detailedIsArray: Array.isArray(w.__midiOutSentDetailed),
    };
  });

  // (a) The hook is really there. Without this, (b) proves nothing.
  expect(probe.installed, 'the capturing MIDI-out mock init script ran').toBe(true);
  expect(probe.flatIsArray, 'window.__midiOutSent is an array').toBe(true);
  expect(probe.detailedIsArray, 'window.__midiOutSentDetailed is an array').toBe(true);

  // (b) …and it is genuinely empty, because nothing has sent yet. A rack that
  // boots emitting MIDI on its own would redden here, which is itself worth
  // knowing.
  const captured = await readMidiOutCaptured(page);
  expect(
    captured,
    `expected an installed-but-empty capture buffer; got ${captured.length} message(s): ` +
      JSON.stringify(captured.slice(0, 4)),
  ).toEqual([]);

  // The port the helper exposes is the one specs select by id. Pinning it here
  // means a rename of DEFAULT_FAKE_MIDI_OUT fails in ONE obvious place rather
  // than as a mystery "device never connected" in every consumer.
  const portIds = await page.evaluate(async () => {
    const access = await navigator.requestMIDIAccess();
    return [...access.outputs.values()].map((o) => o.id);
  });
  expect(portIds, 'the fake exposes exactly the documented default port').toEqual([
    DEFAULT_FAKE_MIDI_OUT.id,
  ]);
});

test('midi-out-buddy: Connect MIDI… reveals the OUT device + channel selectors', async ({ page }) => {
  await installFakeMidiOut(page);
  await page.goto('/rack?shell=legacy&seed=none');
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

test('midi-out-buddy: SEQUENCER gate/pitch → captured MIDI NoteOn on the fake output', async ({ page, errorWatch }) => {
  test.setTimeout(45_000);
  await installFakeMidiOut(page);
  await page.goto('/rack?shell=legacy&seed=none');
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

});
