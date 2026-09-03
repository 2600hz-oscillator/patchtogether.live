// e2e/tests/chromaconsole.spec.ts
//
// ══════════════ THE BYTES-ON-THE-WIRE GATE FOR THE DEVICE MODULE ══════════════
//
// WHY THIS SPEC IS THE ONLY THING THAT CAN SEE THE SUBJECT.
//
// CLAUDE.md's poly/MIDI rule demands an e2e that wires the REAL default source
// into a module and asserts AUDIBLE RMS AT THE OUTPUT. A control-only device
// module cannot satisfy that: it has no audio path at all. The pedal's audio is
// patched through the ES-9 by hand and never enters the graph.
//
// The substitute is not weaker, it is the same argument applied to a different
// terminal. The rule exists because POLYHELM shipped green-but-silent — every
// gate drove the engine CLASS directly, so the real source→module→output chain
// was never exercised and the module produced nothing. The defence is "assert
// at the far end of the real chain, not at a seam you control".
//
// For this module the far end of the real chain is BYTES ON A MIDI PORT. So:
//   * the graph write goes through the REAL Y.Doc mutation path (the same write
//     a knob drag or a clip-automation lane performs), not `engine.setParam`;
//   * the reconciler and the real engine handle carry it;
//   * the assertion reads the exact bytes captured on a fake `MIDIOutput`.
// Nothing between the user gesture and the wire is stubbed. An analogous
// precedent already exists and is accepted: `midiOutBuddy` is exempt from the
// output-emit sweep for exactly this reason ("emits MIDI to external gear"),
// and its own spec asserts a captured NoteOn.
//
// ⚠ EVERY def-reading gate is blind here. contract-lock, module-docs-lint,
// card-def-agreement and the per-port sweeps all pass on a module that declares
// a perfect CC contract and transmits nothing. This file is the instrument.
//
// The instrument itself is negative-controlled in midi-out-buddy.spec.ts
// ('midi-out-capture-instrument'), which proves the capture buffer EXISTS
// rather than silently reporting an empty array from a mock that never
// installed.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installMidiOutCapture, readCapturedCcs, clearMidiOutCaptured } from '../_helpers/midi';

test.describe.configure({ mode: 'parallel' });

const TYPE = 'chromaconsole';
const NODE = 'm';

/** CC numbers, transcribed from Hologram's MIDI implementation chart (manual
 *  pp. 46-48). Written as LITERALS here on purpose: importing them from the
 *  descriptor would make this spec agree with the descriptor by construction
 *  and prove nothing about whether the descriptor is right. A wrong CC number
 *  must fail HERE. */
const CC_TILT = 64;
const CC_RATE = 66;
const CC_TIME = 68;
const CC_MIX = 70;
const CC_TAP_TEMPO = 93;

/** The pedal's USB port name, from Hologram's own firmware updater. */
const CHROMA_PORT = { id: 'chroma-0', name: 'HOLOGRAM Chroma Console MIDI' };
/** A decoy so auto-detect has something to get wrong. */
const OTHER_PORT = { id: 'other-0', name: 'Prophet Rev2' };

async function boot(page: Page, ports = [OTHER_PORT, CHROMA_PORT]): Promise<void> {
  await installMidiOutCapture(page, ports);
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: NODE, type: TYPE, position: { x: 200, y: 200 } }]);
  await expect(page.locator(`.svelte-flow__node:has([data-shell-type="${TYPE}"])`)).toBeVisible();
  // The port picker + actions live in the DOCK device body on the shell.
  await page.evaluate(
    (id) => (globalThis as unknown as { __openDockFullView: (id: string) => void }).__openDockFullView(id),
    NODE,
  );
  await expect(page.locator(`[data-testid="dock-fullview-pane"][data-pane-node="${NODE}"]`)).toBeVisible();
}

/** Click the card's real Connect button, which runs the real permission +
 *  auto-detect path. */
async function connect(page: Page): Promise<void> {
  // The shell's connect is the lane tile's ACTION cell; the picker it fills
  // is the dock device body's port select.
  await page
    .locator(`.svelte-flow__node[data-id="${NODE}"]`)
    .getByTestId('shell-cell-chromaconsole-connect')
    .click();
  // Auto-detect resolves synchronously against the fake; wait for the picker to
  // show the pedal selected rather than sleeping.
  await expect(dockBody(page).getByTestId(`chromaconsole-port-${NODE}`)).toHaveValue(CHROMA_PORT.id);
}

/** The dock pane's device body — the shell home of picker + actions. */
function dockBody(page: Page) {
  return page.locator(`[data-testid="dock-fullview-pane"][data-pane-node="${NODE}"]`);
}

/**
 * Write a slot param through the REAL graph mutation path — the same Y.Doc
 * write `setNodeParam` performs for a knob drag or an automation lane. NOT
 * `engine.setParam`: driving the engine directly is precisely the shortcut that
 * let POLYHELM ship silent.
 */
async function writeSlot(page: Page, slotId: string, value: number): Promise<void> {
  await page.evaluate(
    ({ nodeId, slot, v }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes[nodeId];
        if (n) n.params[slot] = v;
      });
    },
    { nodeId: NODE, slot: slotId, v: value },
  );
}

/** Poll until at least `n` CC messages have been captured. */
async function waitForCcs(page: Page, n: number): Promise<void> {
  await page.waitForFunction(
    (want) => {
      const sent = (window as unknown as { __midiOutSent?: number[][] }).__midiOutSent ?? [];
      return sent.filter((m) => (m[0] ?? 0) >= 0xb0 && (m[0] ?? 0) <= 0xbf).length >= want;
    },
    n,
    { timeout: 10_000 },
  );
}

test('chromaconsole: a slot write reaches the wire as the RIGHT CC on the RIGHT channel', async ({
  page,
  errorWatch,
}) => {
  await boot(page);
  await connect(page);
  await clearMidiOutCaptured(page);

  // slot1 holds TILT by default.
  await writeSlot(page, 'slot1', 100);
  await waitForCcs(page, 1);

  const ccs = await readCapturedCcs(page, CHROMA_PORT.id);
  expect(ccs, 'exactly the one CC the write should produce').toEqual([
    { channel: 1, cc: CC_TILT, value: 100 },
  ]);
  void errorWatch;
});

test('chromaconsole: RATE is CC 66 and TIME is CC 68 (the pair the research had swapped)', async ({
  page,
}) => {
  await boot(page);
  await connect(page);
  await clearMidiOutCaptured(page);

  await writeSlot(page, 'slot2', 11); // RATE
  await waitForCcs(page, 1);
  await writeSlot(page, 'slot3', 22); // TIME
  await waitForCcs(page, 2);
  await writeSlot(page, 'slot4', 33); // MIX
  await waitForCcs(page, 3);

  expect(await readCapturedCcs(page, CHROMA_PORT.id)).toEqual([
    { channel: 1, cc: CC_RATE, value: 11 },
    { channel: 1, cc: CC_TIME, value: 22 },
    { channel: 1, cc: CC_MIX, value: 33 },
  ]);
});

// ─────────────────────────────────────────────────────────────────────────────
// REDUNDANCY, END TO END — and an explicit note about what this pair does NOT
// prove, because it was measured rather than assumed.
//
// ⚠ MEASURED 2026-08-08: wedging `CcSuppressor.shouldSend` to "always send" and
// re-running the first test below leaves it GREEN. The transmitter's suppression
// is NOT what makes it pass — an identical `params[slot] = v` write produces no
// Y.Doc change event, so the graph coalesces the duplicate long before the
// engine, and `handle.setParam` is called exactly once. The assertion is true
// for a reason other than the one its name suggests.
//
// That is worth stating rather than deleting. The pair still earns its place:
// it pins the END-TO-END property (a user repeating a value does not put a
// second message on the wire), which is the thing a DIN cable cares about, and
// it would catch a regression that made the graph re-emit unchanged params.
//
// But the TRANSMITTER's suppression is a unit concern and is pinned in
// `packages/web/src/lib/midi/cc-out.test.ts`, where the same wedge turns FOUR
// tests red in both directions. If you are changing suppression, that is the
// file that will tell you; this one will not.
// ─────────────────────────────────────────────────────────────────────────────

test('chromaconsole: repeating a value puts no second message on the wire (graph-coalesced)', async ({ page }) => {
  await boot(page);
  await connect(page);
  await clearMidiOutCaptured(page);

  await writeSlot(page, 'slot1', 64);
  await waitForCcs(page, 1);
  await writeSlot(page, 'slot1', 64);
  // Give a redundant message every chance to appear before concluding it did not.
  await page.waitForTimeout(300);

  expect(
    await readCapturedCcs(page, CHROMA_PORT.id),
    'the identical value must not reach the wire twice (see the block comment: ' +
      'this is graph coalescing, not the transmitter suppressor)',
  ).toEqual([{ channel: 1, cc: CC_TILT, value: 64 }]);
});

test('chromaconsole: a CHANGED value IS transmitted, including a return to a previous one', async ({
  page,
}) => {
  await boot(page);
  await connect(page);
  await clearMidiOutCaptured(page);

  await writeSlot(page, 'slot1', 10);
  await waitForCcs(page, 1);
  await writeSlot(page, 'slot1', 20);
  await waitForCcs(page, 2);
  await writeSlot(page, 'slot1', 10); // back — still a change
  await waitForCcs(page, 3);

  expect(await readCapturedCcs(page, CHROMA_PORT.id)).toEqual([
    { channel: 1, cc: CC_TILT, value: 10 },
    { channel: 1, cc: CC_TILT, value: 20 },
    { channel: 1, cc: CC_TILT, value: 10 },
  ]);
});

test('chromaconsole: PUSH ALL re-asserts every slot even though nothing changed', async ({ page }) => {
  await boot(page);
  await connect(page);
  await writeSlot(page, 'slot1', 55);
  await waitForCcs(page, 1);
  await clearMidiOutCaptured(page);

  // The only resync a receive-only device can have. If suppression were not
  // cleared here, the button would do nothing at all — and it is the single
  // most important control on the card.
  await page
    .locator(`.svelte-flow__node[data-id="${NODE}"]`)
    .getByTestId('shell-cell-chromaconsole-pushall')
    .click();
  await waitForCcs(page, 8);

  const ccs = await readCapturedCcs(page, CHROMA_PORT.id);
  expect(ccs.length, 'one message per assigned slot').toBe(8);
  expect(ccs.map((c) => c.cc), 'the eight PRIMARY controllers').toEqual([
    64, 66, 68, 70, 65, 67, 69, 71,
  ]);
  expect(ccs.find((c) => c.cc === CC_TILT)!.value, 'the current value, not the default').toBe(55);
});

test('chromaconsole: with NO output selected, a write sends nothing and is RECORDED undelivered', async ({
  page,
}) => {
  // The negative control that matters most: "sent nothing" and "never tried"
  // must be distinguishable, or a dead module looks identical to an idle one.
  await boot(page);
  await connect(page);
  const card = dockBody(page);
  await card.getByTestId(`chromaconsole-port-${NODE}`).selectOption('');
  await clearMidiOutCaptured(page);

  await writeSlot(page, 'slot1', 42);
  await page.waitForTimeout(300);

  expect(await readCapturedCcs(page), 'nothing may reach any port').toEqual([]);

  const ledger = await page.evaluate((nodeId) => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
      __patch: { nodes: Record<string, unknown> };
    };
    const eng = w.__engine?.();
    const node = w.__patch.nodes[nodeId];
    if (!eng || !node) return null;
    return eng.read(node, 'ledger') as { delivered: boolean; reason?: string }[] | undefined;
  }, NODE);

  expect(ledger, 'the ledger is reachable').toBeTruthy();
  const undelivered = (ledger ?? []).filter((r) => !r.delivered);
  expect(undelivered.length, 'the attempt is recorded, not dropped').toBeGreaterThan(0);
  expect(undelivered.at(-1)!.reason).toBe('no-port');
});

test('chromaconsole: an ACTION fires on every press, at the same value', async ({ page }) => {
  await boot(page);
  await connect(page);
  await clearMidiOutCaptured(page);

  const card = dockBody(page);
  const tap = card.getByTestId(`chromaconsole-action-${NODE}-tapTempo`);
  await tap.click();
  await waitForCcs(page, 1);
  await tap.click();
  await waitForCcs(page, 2);

  // Two taps must be two messages — a tap tempo that dedupes can never set a
  // tempo. This is the case that justifies actions bypassing suppression.
  const ccs = await readCapturedCcs(page, CHROMA_PORT.id);
  expect(ccs.filter((c) => c.cc === CC_TAP_TEMPO).length).toBe(2);
});

test('chromaconsole: auto-detect picks the pedal by name and ignores the decoy', async ({ page }) => {
  await boot(page, [OTHER_PORT, CHROMA_PORT]);
  await connect(page);

  const card = dockBody(page);
  await expect(card.getByTestId(`chromaconsole-port-${NODE}`)).toHaveValue(CHROMA_PORT.id);

  await clearMidiOutCaptured(page);
  await writeSlot(page, 'slot1', 77);
  await waitForCcs(page, 1);

  // Nothing may reach the decoy — sending a pedal's CCs into somebody's synth
  // is the failure mode that makes over-eager auto-detect worse than none.
  expect(await readCapturedCcs(page, OTHER_PORT.id)).toEqual([]);
  expect(await readCapturedCcs(page, CHROMA_PORT.id)).toHaveLength(1);
});

test('chromaconsole: with NO matching port, auto-detect selects nothing rather than guessing', async ({
  page,
}) => {
  await boot(page, [OTHER_PORT]);
  await page
    .locator(`.svelte-flow__node[data-id="${NODE}"]`)
    .getByTestId('shell-cell-chromaconsole-connect')
    .click();
  await expect(dockBody(page).getByTestId(`chromaconsole-port-${NODE}`)).toHaveValue('');

  await clearMidiOutCaptured(page);
  await writeSlot(page, 'slot1', 88);
  await page.waitForTimeout(300);
  expect(await readCapturedCcs(page), 'silence beats sending to the wrong device').toEqual([]);
});
