// e2e/tests/face-chromaconsole.spec.ts
//
// THE CHROMA CONSOLE FACE, driven on the DEFAULT shell, all the way to BYTES ON
// A MIDI PORT.
//
// ⚠ WHY THIS FILE EXISTS AT ALL, when `chromaconsole.spec.ts` already asserts
// the wire. All ten of its tests were written against the PRE-PROMOTION surface,
// so after promotion it stays green over a surface no player meets. This is the
// shipping-shell leg it owes, and it is the ONLY thing in the
// tree that can see the faced chain end to end.
//
// ⚠ AND IT IS THE POLY/MIDI RULE'S TERMINAL, NOT A SUBSTITUTE FOR IT. CLAUDE.md
// demands that a MIDI module wire the REAL default-mode source through the
// module to an audible-output assertion, because POLYHELM shipped green-and-
// silent when every gate drove the engine class directly. A control-only device
// module has no audio path at all — the pedal's audio is patched through the
// ES-9 by hand and never enters the graph — so the far end of its real chain is
// BYTES ON A MIDI PORT. Here, as in the legacy suite: the value is written
// through the REAL Y.Doc mutation path (the write a knob drag or an automation
// lane performs, never `engine.setParam`), the reconciler and the real engine
// handle carry it, and the assertion reads the exact bytes captured on a fake
// `MIDIOutput`. The capture instrument itself is negative-controlled in
// `midi-out-buddy.spec.ts` ('midi-out-capture-instrument'), which proves the
// buffer exists rather than silently reporting an empty array.
//
// ⚠ THE FILENAME IS DELIBERATE. `chromaconsole-*` matches no entry in
// `e2e/webgl-heavy-globs.ts` today, but `face-` is the shape
// `face-videobox.spec.ts` established and it cannot be swept into the serialized
// video lane by a future glob named after a module. A spec that lands in the
// heavy lane runs NOWHERE in PR CI and is green forever. Nothing here is
// WebGL-heavy: it reads DOM facts, graph state and captured MIDI bytes, and
// samples no pixels.
//
// WHAT THE OTHER GATES ALREADY COVER, so this file does not:
//   `chromaconsole-face-model.test.ts` — the rank, the two separate seams, the
//     auto-detect tie-break, the body's refusal to import a value formatter.
//   `chromaconsole-status-model.test.ts` — every string, painted or spoken.
//   `faces-parity` — that every ranked cell operates and every param has exactly
//     one control element.
//   `face-rack-status-source.test.ts` — that the body declares what it paints.
// None of them can see: that CONNECT reaches the LANE TILE and actually binds a
// port; that a slot write still reaches the wire with no card mounted anywhere;
// that PUSH ALL re-asserts eight controllers; that reassigning a slot rewires
// which CC moves; or that an enum-assigned slot's second surface does not break
// the param-cell identity `faces-parity` asserts.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import {
  clearMidiOutCaptured,
  installMidiOutCapture,
  readCapturedCcs,
} from '../_helpers/midi';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

const TYPE = 'chromaconsole';
const NODE = 'ccf';

/** CC numbers, transcribed from Hologram's MIDI implementation chart (manual
 *  pp. 46-48). LITERALS on purpose: importing them from the descriptor would
 *  make this spec agree with the descriptor by construction and prove nothing
 *  about whether the descriptor is right. A wrong CC number must fail HERE. */
const CC_TILT = 64;
const CC_MIX = 70;
const CC_TAP_TEMPO = 93;
/** Whole-pedal BYPASS — `role: 'enum'`, the slot shape that gets a second
 *  surface. Its two named ranges (BYPASS 0..63, ENGAGE 64..127) are why no
 *  honest knob exists for it. */
const CC_BYPASS = 91;

/** The pedal's USB port name, from Hologram's own firmware updater. */
const CHROMA_PORT = { id: 'chroma-0', name: 'HOLOGRAM Chroma Console MIDI' };
/** A decoy so auto-detect has something to get wrong. */
const OTHER_PORT = { id: 'other-0', name: 'Prophet Rev2' };

async function boot(page: Page, ports = [OTHER_PORT, CHROMA_PORT]): Promise<void> {
  await installMidiOutCapture(page, ports);
  // Plain /rack — the shipping shell, which is the whole subject of this file.
  await page.goto('/rack?seed=none');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
  await spawnPatch(page, [{ id: NODE, type: TYPE, position: { x: 240, y: 200 } }], [], {
    mountTimeout: BOOT_MS,
  });
}

/** The LANE tile's shell for the node. */
function laneShell(page: Page): Locator {
  return page.locator(`.svelte-flow__node[data-id="${NODE}"] [data-testid="module-shell"]`);
}

/** Open the dock faceplate, scoped BY NODE. The tile button is hit-testable
 *  while a previous pane is still tearing down, so one click can land on
 *  nothing — hence the retry rather than a bare click. */
async function openDock(page: Page): Promise<Locator> {
  const shell = laneShell(page);
  await expect(shell).toBeVisible({ timeout: BOOT_MS });
  const dockShell = page
    .getByTestId('dock-full-view')
    .locator(`[data-testid="module-shell"][data-shell-tier="dock"][data-shell-node="${NODE}"]`);
  await expect(async () => {
    if ((await dockShell.count()) === 0) {
      await shell.getByTestId('shell-open-dock').click();
    }
    await expect(dockShell).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  return dockShell;
}

/**
 * Write a slot param through the REAL graph mutation path — the same Y.Doc write
 * `setNodeParam` performs for a knob drag or an automation lane. NOT
 * `engine.setParam`: driving the engine directly is the shortcut that let
 * POLYHELM ship silent.
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

/** Wait until at least `n` CC messages have been captured — an OBSERVABLE, not a
 *  sleep. The reconciler carries the graph write to the handle on its own tick. */
async function waitForCcs(page: Page, n: number): Promise<void> {
  await page.waitForFunction(
    (want) => {
      const sent = (window as unknown as { __midiOutSent?: number[][] }).__midiOutSent ?? [];
      return sent.filter((m) => (m[0] ?? 0) >= 0xb0 && (m[0] ?? 0) <= 0xbf).length >= want;
    },
    n,
    { timeout: BOOT_MS },
  );
}

/** The audition ledger, read IN THE PAGE (never polled from Node — the repo rule
 *  about sampling a page-side quantity across the protocol). */
async function auditions(page: Page): Promise<{ delivered: number; total: number }> {
  return page.evaluate((id) => {
    const log = (
      window as unknown as {
        __auditionLog?: () => { nodeId: string; seam: string; delivered: boolean }[];
      }
    ).__auditionLog;
    if (!log) return { delivered: -1, total: -1 };
    const rows = log().filter((r) => r.nodeId === id && r.seam === 'engine-message');
    return { delivered: rows.filter((r) => r.delivered).length, total: rows.length };
  }, NODE);
}

/** Bind the pedal through the RANKED LANE CELL — the gesture the promotion moved
 *  out of the dock, pressed where a player meets the module. */
async function connectFromLane(page: Page): Promise<void> {
  const connect = laneShell(page).getByTestId('shell-cell-chromaconsole-connect');
  await expect(connect, 'CONNECT reaches the lane tier').toBeEnabled();
  await connect.click();
}

test.describe('CHROMA CONSOLE faceplate — the faced chain reaches the wire', () => {
  // ⚠ A PAGE ERROR FAILS EVERY TEST IN THIS FILE. A TypeError inside a `$derived`
  // does not surface as a thrown assertion — it takes the subtree's render down
  // and the symptom lands somewhere else entirely (the tv-librarian-face
  // incident, twice).
  test.beforeEach(({ page }) => {
    page.on('pageerror', (err) => {
      throw new Error(`uncaught page error during a chromaconsole face test: ${err.message}`);
    });
  });

  test('the LANE TILE is the SHELL: CONNECT binds the pedal and a slot write reaches the wire', async ({
    page,
  }) => {
    // The dock's lazy body chunk plus a real engine boot serialise behind this —
    // bounded from the one export site, never a flat literal.
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await boot(page);

    // ⚠ THE PRECONDITION THE WHOLE FILE RESTS ON. Before promotion the default
    // shell painted this module as a uniform lane PLACEHOLDER with zero ranked
    // controls, so every gesture — connect, the picker, push all, eight knobs —
    // was reachable only by expanding the dock.
    await expect(laneShell(page), 'the lane renders ModuleShell').toBeVisible();

    // ⚠ THE FACEPLATE IS OPENED **BEFORE** THE GRANT, AND THE ORDER IS THE
    // ASSERTION. The body's own empty state paints "Press Connect MIDI to grant
    // access and pick the pedal", so the path a player actually walks is: open
    // the plate, read the instruction, press the cell — with this surface
    // already mounted. A grant writes NOTHING to the Y.Doc (the port and the
    // channel live on the device HANDLE), so a body whose reads are keyed only
    // on the node and on its own gestures repaints for neither, and the picker
    // stays empty under a hint telling you to use it. Connecting first and
    // opening afterwards — the cheaper order — is exactly the order that cannot
    // see it, because a fresh mount reads the handle once on the way up.
    const dock = await openDock(page);
    const body = dock.locator(`[data-testid="chromaconsole-device-body-${NODE}"]`);
    await expect(body).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    await expect(
      body.locator(`[data-testid="chromaconsole-port-${NODE}"]`),
      'nothing is bound before the grant',
    ).toHaveValue('');

    // ── THE PRESS REACHES THE SEAM. The observable is the AUDITION LEDGER: a
    // grant writes nothing to the graph, so `readData` is structurally blind to
    // this gesture and a dead button would satisfy any DOM assertion.
    const before = await auditions(page);
    expect(before.total, 'the audition ledger is exposed to this build').toBeGreaterThanOrEqual(0);
    await connectFromLane(page);
    await expect
      .poll(async () => (await auditions(page)).delivered, {
        message: 'the CONNECT press resolved a callable off the live handle and called it',
        timeout: BOOT_MS,
      })
      .toBeGreaterThan(before.delivered);

    // ── AUTO-DETECT PICKED THE PEDAL, NOT THE DECOY, and the ALREADY-OPEN body
    // says so. This is the shared `matchPortByHint` seam running for the first
    // time in production: earliest HINT wins, which is why the descriptor orders
    // its hints most-specific-first.
    await expect(body.locator(`[data-testid="chromaconsole-port-${NODE}"]`)).toHaveValue(
      CHROMA_PORT.id,
    );

    // ── THE WIRE. A REAL graph write, carried by the reconciler and the real
    // handle, arriving as the right CC on the right channel.
    await clearMidiOutCaptured(page);
    await writeSlot(page, 'slot1', 99);
    await waitForCcs(page, 1);
    expect(await readCapturedCcs(page, CHROMA_PORT.id)).toEqual([
      { channel: 1, cc: CC_TILT, value: 99 },
    ]);

    // ── PUSH ALL, FROM THE LANE TILE. It is rank 2 for a reason no other binder
    // has: the pedal never reports back, so re-asserting every slot is the only
    // reconciliation that exists in either direction. Eight assigned slots, eight
    // messages, though nothing changed.
    await clearMidiOutCaptured(page);
    await laneShell(page).getByTestId('shell-cell-chromaconsole-pushall').click();
    await waitForCcs(page, 8);
    const pushed = await readCapturedCcs(page, CHROMA_PORT.id);
    expect(pushed.length, 'one message per assigned slot').toBe(8);
    expect(
      pushed.find((m) => m.cc === CC_TILT)?.value,
      'and the value it re-asserts is the one the graph holds',
    ).toBe(99);
  });

  test('the SLOT BOARD names what the band cannot, and ASSIGN rewires which CC moves', async ({
    page,
  }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await boot(page);
    await connectFromLane(page);
    const dock = await openDock(page);
    const body = dock.locator(`[data-testid="chromaconsole-device-body-${NODE}"]`);
    await expect(body).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    // ⚠ THE TRADE, PINNED SO A CHANGE TO IT IS DELIBERATE. The band cell is
    // captioned `slot 1` because `deviceSlotParams` mints eight identical params
    // and a cell caption is `ParamDef.label` with no node input. The NAME lives
    // on the board — owner decisions 2026-08-31 item 7, two operable surfaces per
    // slot. If per-node captions ever ship, this assertion is where it shows.
    await expect(body.locator(`[data-testid="chromaconsole-slot-${NODE}-1"]`)).toContainText('tilt');
    await expect(
      body.locator(`[data-testid="chromaconsole-slot-${NODE}-2"]`),
      'and a pedal-quantized control is marked as one',
    ).toContainText('·snap');

    // ⚠ NO VALUE IS PAINTED. The card's per-slot readout is deleted, not
    // relocated — and the board must not have grown one back. `4` would be the
    // shortest possible readout for slot 4's default (MIX = 64), so this asserts
    // the absence of digits rather than of one string.
    await expect(
      body.locator(`[data-testid="chromaconsole-slot-${NODE}-4"]`),
      'the chip names the control and does not report its value',
    ).toHaveText(/^4\s*mix\s*$/);

    // ── ASSIGN IS A MODE. At rest the board is eight names; the pickers appear
    // only while editing, which is what keeps the plate compact.
    await expect(body.locator(`[data-testid="chromaconsole-assign-${NODE}-1"]`)).toHaveCount(0);
    await body.locator(`[data-testid="chromaconsole-assign-mode-${NODE}"]`).click();
    const picker = body.locator(`[data-testid="chromaconsole-assign-${NODE}-1"]`);
    await expect(picker).toBeVisible();

    // ── REWIRE SLOT 1 TO AN ENUM CONTROL. Two things must follow: the chip's
    // NAME changes (the per-node fact the band cannot show), and the same graph
    // write now moves a DIFFERENT controller on the wire.
    await picker.selectOption('standardBypass');
    await body.locator(`[data-testid="chromaconsole-assign-mode-${NODE}"]`).click();
    await expect(body.locator(`[data-testid="chromaconsole-slot-${NODE}-1"]`)).not.toContainText(
      'tilt',
    );

    // ⚠ THE ENUM SLOT'S SECOND SURFACE, AND THE IDENTITY IT MUST NOT BREAK. A
    // slot assigned to a named-range selector is operable here as a real
    // Segmented, because its states are named ranges and no honest knob exists
    // for them. `faces-parity` asserts EXACT MULTISET equality between the dock's
    // `[data-testid^="control-"]` elements and the def's param ids, so this
    // second surface must NOT emit `control-slot1` — and the sweep itself can
    // never see this, because it never assigns an enum control.
    const seg = body.locator(`[data-testid="chromaconsole-seg-${NODE}-slot1"]`);
    await expect(seg, 'the enum slot gets its real primitive').toBeVisible();
    await expect(
      dock.locator('[data-testid="control-slot1"]'),
      'and exactly ONE element still claims to be slot1\'s cell',
    ).toHaveCount(1);

    // The wire follows the assignment: BYPASS ALL, not TILT.
    await clearMidiOutCaptured(page);
    await writeSlot(page, 'slot1', 120);
    await waitForCcs(page, 1);
    expect(await readCapturedCcs(page, CHROMA_PORT.id)).toEqual([
      { channel: 1, cc: CC_BYPASS, value: 120 },
    ]);

    // ⚠ AND THE SECOND SURFACE FOLLOWS THE GRAPH — THE ROUND TRIP, NOT THE
    // WRITE. Every assertion above this one reads the WIRE or `node.params`, and
    // [[yjs-proxy-stable-identity-defeats-derived]] is precisely the bug that
    // passes all of them: `patch.nodes[id]` is a proxy with STABLE IDENTITY, so a
    // `$derived` reading it never propagates and the picture freezes while the
    // graph is correct. The board must repaint for a value written ANYWHERE it
    // does not own — the band knob directly above it, a clip-automation lane, a
    // rack-mate, a Cmd-Z of the reassignment this PR just made undoable.
    //
    // `slot1` is 64 when it becomes a BYPASS slot (tilt's default), and 64 ties
    // between the two range midpoints (32 / 96), which `nearestSegmentValue`
    // resolves EARLIER — so a frozen board sits on BYPASS. 120 is unambiguously
    // ENGAGE. The two states are therefore distinguishable, which is the only
    // reason this assertion can discriminate at all.
    await expect(
      seg.getByRole('radio').nth(1),
      'the board repaints for a graph write it did not make',
    ).toHaveAttribute('aria-checked', 'true');

    // And pressing a segment writes the range's midpoint through the same param,
    // reaching the same controller — the second surface is a real control, not a
    // decoration.
    await clearMidiOutCaptured(page);
    await seg.getByRole('radio').first().click();
    await waitForCcs(page, 1);
    const fromSegment = await readCapturedCcs(page, CHROMA_PORT.id);
    expect(fromSegment[0]?.cc).toBe(CC_BYPASS);
    expect(fromSegment[0]?.value, 'the BYPASS range midpoint, not the ENGAGE one').toBeLessThan(64);
  });

  test('a PEDAL COMMAND fires on every press, at the same value', async ({ page }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await boot(page);
    await connectFromLane(page);
    const dock = await openDock(page);
    const body = dock.locator(`[data-testid="chromaconsole-device-body-${NODE}"]`);
    await expect(body).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    // ⚠ THE SUPPRESSOR MUST NOT SWALLOW THE SECOND TAP. A device command acts on
    // RECEIPT, so the same value twice must go out twice — `fireAction` resyncs
    // the transmitter's memory for exactly this reason. Without it two taps at
    // the same value would send once and the tempo would never update. The five
    // commands are body buttons rather than cells (they are the DEVICE's
    // transport, not this module's controls), and this is the only gate that
    // presses one on the faced surface.
    await clearMidiOutCaptured(page);
    const tap = body.locator(`[data-testid="chromaconsole-action-${NODE}-tapTempo"]`);
    await tap.click();
    await tap.click();
    await waitForCcs(page, 2);
    const taps = await readCapturedCcs(page, CHROMA_PORT.id);
    expect(taps.length).toBe(2);
    expect(taps.every((m) => m.cc === CC_TAP_TEMPO)).toBe(true);
    expect(taps[0]?.value).toBe(taps[1]?.value);

    // ⚠ AND AN ACTION IS NOT A PARAM WRITE. It touches no Y.Doc and enters no
    // undo stack, so Cmd-Z can never re-fire a destructive pedal command — the
    // reason `role: 'action'` controls are refused an automatable slot at all.
    const params = await page.evaluate((id) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      return Object.keys(w.__patch.nodes[id]?.params ?? {});
    }, NODE);
    expect(params).not.toContain('tapTempo');

    // A slot write still reaches its own controller afterwards: the action's
    // resync did not disturb the slot the player was holding.
    await clearMidiOutCaptured(page);
    await writeSlot(page, 'slot4', 12);
    await waitForCcs(page, 1);
    expect(await readCapturedCcs(page, CHROMA_PORT.id)).toEqual([
      { channel: 1, cc: CC_MIX, value: 12 },
    ]);
  });
});
