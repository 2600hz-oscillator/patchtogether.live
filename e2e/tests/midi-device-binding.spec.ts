// e2e/tests/midi-device-binding.spec.ts
//
// THE MIDI DEVICE-BINDING REGRESSION SUITE — grant, enumerate, pick, send,
// re-plug, reload — driven on the DEFAULT shell through the surfaces a player
// actually touches.
//
// ⚠ THE FILENAME IS LOAD-BEARING. `e2e/webgl-heavy-globs.ts` classifies by
// PREFIX glob, and a spec swept into the WebGL-heavy list is EXCLUDED from the
// sharded e2e matrix — i.e. it runs NOWHERE on a pull request and is green
// forever (the `node-source-videobox.spec.ts` incident). There is no `**/midi-*`
// glob today, which is exactly the kind of fact that changes without anyone
// re-reading this file. Nothing here samples a pixel or boots a renderer.
//
// ── WHY THIS FILE EXISTS: WHAT THE EXISTING GATES CANNOT SEE ────────────────
//
// `midi-out-buddy.spec.ts` is the module's byte-level spec and it boots
// `?shell=legacy` in all four tests — a surface no player meets (the 377-of-431
// problem in AGENTS.md). Worse for this class: its one send test reaches
// `engine.read(node,'card-api')` and calls `connect()` + `selectDevice()`
// DIRECTLY, so the two gestures that were actually broken — pressing CONNECT
// and picking a port — have never been driven. `midiclock.spec.ts` drives the
// real cell but stops at "the roster appeared". Nothing anywhere drove a
// RELOADED patch, which is where the defect below lives.
//
// ── THE DEFECT THIS PINS (owner report, 2026-09-02) ─────────────────────────
//
// `MIDIPort.id` is implementation-defined and Chrome regenerates it between
// sessions, so a saved patch's `data.lastDeviceId` routinely names nothing.
// #2228 added the cure — `data.lastDeviceName` plus the shared `resolveDevice`
// — and wired it into `cameraInput` ONLY: every MIDI surface WROTE the name at
// pick time and no MIDI factory ever READ it back. On top of that,
// midiOutBuddy's grant path guarded its pick (`if (!selectedDeviceId)`) where
// its three siblings assign unconditionally, so a stale-but-truthy id BLOCKED
// the pick entirely and the module stayed bound to a port that does not exist.
//
// Measured on this build before the fix, in leg 2 below: grant succeeds,
// `connected` goes true, the picker renders with `selectedIndex === -1` (BLANK
// — the bound value matches no option), and a running sequencer produced
// ZERO captured messages. Owner's words: "pressing connect never yields a
// working output picker", "can't select a midi out".
//
// ── POSITIVE CONTROLS ──────────────────────────────────────────────────────
//
// Leg 2 is itself the control and it was RED first: reverting either half of
// the fix (the guard, or the name resolve) reproduces the numbers above —
// `selectedIndex === -1` with the guard, and `session2-port-a` (the WRONG
// synth, which looks fine) with the guard removed but no name resolve. Leg 1
// negative-controls the INSTRUMENT: it asserts on the port NOT auto-selected,
// so a mock that ignored the pick would fail rather than pass by luck.
//
// NO WALL-CLOCK GATES. Every wait is an auto-retrying `expect` or a
// `waitForFunction` on the real subject; the only wall-clock numbers are the
// shared boot budget, which BOUNDS a failure rather than gating a pass.

import { test, expect, type Page } from '@playwright/test';
import { seedKriaWith, buildKriaMidiData } from './_helpers';
import {
  installMidiDeviceMock,
  grantMidiNow,
  unplugMidiPort,
  injectMidiDeviceIn,
  readMidiOutCaptured,
  clearMidiOutCaptured,
} from '../_helpers/midi';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

/** Two output ports with DISTINCT names, so "it bound the right one" is a real
 *  claim rather than the only thing it could have done. */
const OUT_A = { id: 'session2-port-a', name: 'Decoy Out A' };
const OUT_B = { id: 'session2-port-b', name: 'Target Out B' };
/** The id the PREVIOUS session saved for OUT_B. Chrome regenerated it. */
const STALE_B_ID = 'session1-port-b';

const IN_A = { id: 'session2-in-a', name: 'Decoy In A' };
const IN_B = { id: 'session2-in-b', name: 'Target In B' };
const STALE_IN_B_ID = 'session1-in-b';

async function boot(page: Page): Promise<void> {
  await page.goto('/rack?seed=none');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => typeof (globalThis as unknown as { __ensureEngine?: unknown }).__ensureEngine === 'function',
  );
  await page.evaluate(async () => {
    await (globalThis as unknown as { __ensureEngine: () => Promise<unknown> }).__ensureEngine();
  });
}

interface SeedNode {
  id: string;
  type: string;
  params?: Record<string, number>;
  data?: Record<string, unknown>;
}
interface SeedEdge {
  id: string;
  from: { nodeId: string; portId: string };
  to: { nodeId: string; portId: string };
  sourceType: string;
  targetType: string;
}

/**
 * Build a patch INCLUDING `node.data`.
 *
 * ⚠ `spawnPatch` CANNOT BE USED HERE: it drops `data` on the floor (it writes
 * only id/type/domain/position/params), and `data` is the entire subject of
 * this file — the saved device binding lives nowhere else. One Y.Doc
 * transaction, the same shape `loadEnvelopeIntoStore` produces when a patch is
 * opened over a running one.
 */
async function seedPatch(page: Page, nodes: SeedNode[], edges: SeedEdge[] = []): Promise<void> {
  await page.evaluate(
    ({ nodes, edges }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        for (const id of Object.keys(w.__patch.edges)) delete w.__patch.edges[id];
        for (const id of Object.keys(w.__patch.nodes)) delete w.__patch.nodes[id];
        nodes.forEach((n, i) => {
          w.__patch.nodes[n.id] = {
            id: n.id,
            type: n.type,
            domain: 'audio',
            position: { x: 80 + i * 340, y: 80 },
            params: n.params ?? {},
            ...(n.data ? { data: n.data } : {}),
          };
        });
        for (const e of edges) {
          w.__patch.edges[e.id] = {
            id: e.id,
            source: e.from,
            target: e.to,
            sourceType: e.sourceType,
            targetType: e.targetType,
          };
        }
      });
    },
    { nodes, edges },
  );
  for (const n of nodes) {
    // `.first()` — a pinned module (TIMELORDE) renders on the canvas AND in
    // its workflow surface, so the id matches twice. Either mount proves the
    // node materialized, which is all this wait is for.
    await expect(page.locator(`.svelte-flow__node[data-id="${n.id}"]`).first()).toBeVisible({
      timeout: BOOT_MS,
    });
  }
}

function laneShell(page: Page, nodeId: string) {
  return page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`);
}

/** The dock full view — where a device module's PORT PICKER lives.
 *  `dockFullViewHeadPlan` gates the extension body on `view !== 'lane'`, so the
 *  roster exists on this surface and nowhere else. */
async function openDock(page: Page, nodeId: string) {
  const dock = page
    .getByTestId('dock-full-view')
    .locator(`[data-testid="module-shell"][data-shell-tier="dock"][data-shell-node="${nodeId}"]`);
  if ((await dock.count()) === 0) {
    await laneShell(page, nodeId).getByTestId('shell-open-dock').click();
  }
  await expect(dock).toBeVisible({ timeout: BOOT_MS });
  return dock;
}

/** A midiOutBuddy wired to a self-running KRIA — the REAL default-mode source
 *  chain the MIDI-module rule demands, never the engine handle directly. */
async function seedSequencedOutBuddy(
  page: Page,
  nodeId: string,
  data?: Record<string, unknown>,
): Promise<void> {
  await seedPatch(
    page,
    [
      { id: 'seq', type: 'kria', params: { bpm: 240, running: 1 } },
      { id: nodeId, type: 'midiOutBuddy', ...(data ? { data } : {}) },
    ],
    [
      {
        id: 'e-gate',
        from: { nodeId: 'seq', portId: 'gate1' },
        to: { nodeId, portId: 'gate' },
        sourceType: 'gate',
        targetType: 'gate',
      },
      {
        id: 'e-pitch',
        from: { nodeId: 'seq', portId: 'pitch1' },
        to: { nodeId, portId: 'pitch' },
        sourceType: 'cv',
        targetType: 'cv',
      },
    ],
  );
  await seedKriaWith(page, 'seq', buildKriaMidiData([72, 67, 64, 60], { duration: 0.5 }));
}

/** Wait for a NoteOn on ONE port. The gate is the byte pattern; the timeout
 *  bounds the failure. */
async function waitForNoteOnFrom(page: Page, portId: string): Promise<void> {
  await page.waitForFunction(
    (id) => {
      const sent =
        (window as unknown as { __midiOutSentDetailed?: { portId: string; bytes: number[] }[] })
          .__midiOutSentDetailed ?? [];
      return sent.some(
        (m) =>
          m.portId === id &&
          (m.bytes[0] ?? 0) >= 0x90 &&
          (m.bytes[0] ?? 0) <= 0x9f &&
          (m.bytes[2] ?? 0) > 0,
      );
    },
    portId,
    { timeout: SLOW_BOOT_TEST_TIMEOUT_MS },
  );
}

// ── 1. GRANT → ENUMERATE → PICK → EXACT BYTES, all through the real surface ──

test('a granted midiOutBuddy enumerates every output, and the PICKED one gets the notes', async ({
  page,
}) => {
  test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 4);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await installMidiDeviceMock(page, { outputs: [OUT_A, OUT_B] });
  await boot(page);
  await seedSequencedOutBuddy(page, 'mob');

  const dock = await openDock(page, 'mob');

  // Pre-grant: no roster exists, because Web MIDI shows no port before consent.
  await expect(dock.getByTestId('midi-out-buddy-output-select-mob')).toHaveCount(0);

  // THE GESTURE — the ranked action cell, not the engine handle.
  await dock.getByTestId('shell-cell-midi-out-buddy-connect').click();

  const select = dock.getByTestId('midi-out-buddy-output-select-mob');
  await expect(select, 'the grant must reveal the port roster').toBeVisible({ timeout: BOOT_MS });
  await expect(
    select.locator('option'),
    'every enumerated output is offered, plus the empty prompt',
  ).toHaveText(['(pick one)', OUT_A.name, OUT_B.name]);

  // ⚠ THE SECOND PORT ON PURPOSE. The module auto-binds the first one, so
  // asserting on OUT_A would pass even if the pick did nothing at all.
  await select.selectOption(OUT_B.id);
  await clearMidiOutCaptured(page);

  await waitForNoteOnFrom(page, OUT_B.id);
  const captured = await readMidiOutCaptured(page);

  const onB = captured.filter((m) => m.portId === OUT_B.id);
  const noteOn = onB.find((m) => (m.bytes[0] ?? 0) === 0x90 && (m.bytes[2] ?? 0) > 0);
  expect(noteOn, 'a NoteOn reached the CHOSEN port').toBeTruthy();
  // EXACT BYTES: status 0x90 is NoteOn on channel 1 (the default), and the
  // sequencer's notes are the four this test seeded.
  expect(noteOn!.bytes[0]).toBe(0x90);
  expect([72, 67, 64, 60]).toContain(noteOn!.bytes[1]);
  expect(noteOn!.bytes[2]).toBeGreaterThanOrEqual(1);
  expect(noteOn!.bytes[2]).toBeLessThanOrEqual(127);
  // …and the matching NoteOff, so the external instrument is never stranded.
  await expect
    .poll(
      async () =>
        (await readMidiOutCaptured(page, OUT_B.id)).some((m) => (m.bytes[0] ?? 0) === 0x80),
      { message: 'the gate falling edge sends NoteOff', timeout: SLOW_BOOT_TEST_TIMEOUT_MS },
    )
    .toBe(true);

  expect(
    captured.filter((m) => m.portId === OUT_A.id),
    'and NOTHING went to the port the player did not choose',
  ).toEqual([]);
  expect(errors, 'no pageerror from the binding path').toEqual([]);
});

// ── 2. THE OWNER'S BUG: a reloaded patch whose port id was regenerated ───────

test('a reloaded patch rebinds by NAME when the saved port id no longer exists', async ({
  page,
}) => {
  test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 4);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await installMidiDeviceMock(page, { outputs: [OUT_A, OUT_B] });
  await boot(page);
  // Exactly what a previous session wrote: an id Chrome has since regenerated,
  // and the name that outlives it.
  await seedSequencedOutBuddy(page, 'mob', {
    lastDeviceId: STALE_B_ID,
    lastDeviceName: OUT_B.name,
  });

  const dock = await openDock(page, 'mob');
  await dock.getByTestId('shell-cell-midi-out-buddy-connect').click();

  const select = dock.getByTestId('midi-out-buddy-output-select-mob');
  await expect(select).toBeVisible({ timeout: BOOT_MS });

  // ⚠ PRE-FIX THIS WAS -1 AND '' — a blank picker bound to a phantom port.
  await expect
    .poll(async () => select.evaluate((el) => (el as HTMLSelectElement).selectedIndex), {
      message: 'the picker must show a REAL port, never a phantom',
      timeout: BOOT_MS,
    })
    .toBeGreaterThan(0);
  await expect(
    select,
    'and it is the SAVED hardware by name — not merely the first port',
  ).toHaveValue(OUT_B.id);

  // The consequence that actually matters: the notes go somewhere.
  await waitForNoteOnFrom(page, OUT_B.id);
  const onA = await readMidiOutCaptured(page, OUT_A.id);
  expect(onA, 'the decoy port stays silent — a name match is not a shrug').toEqual([]);
  expect(errors).toEqual([]);
});

// ── 3. A REFUSED GRANT IS VISIBLE — never a dead button ─────────────────────

test('a DENIED grant surfaces a readable reason instead of doing nothing', async ({ page }) => {
  test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 3);
  await installMidiDeviceMock(page, { outputs: [OUT_A], grant: 'deny' });
  await boot(page);
  await seedPatch(page, [{ id: 'mob', type: 'midiOutBuddy' }]);

  const dock = await openDock(page, 'mob');
  await dock.getByTestId('shell-cell-midi-out-buddy-connect').click();

  const err = dock.getByTestId('midi-out-buddy-access-error-mob');
  await expect(err, 'a refusal must be SAID — the whole point of midi-access.ts').toBeVisible({
    timeout: BOOT_MS,
  });
  await expect(err).toContainText(/refused/i);
  // The lamp agrees with the line, rather than claiming a connection.
  await expect(dock.getByTestId('midi-out-buddy-led-midi-mob')).toHaveAttribute('data-lit', '0');
  await expect(dock.getByTestId('midi-out-buddy-output-select-mob')).toHaveCount(0);
});

// ── 4. A LATE GRANT REPAINTS — the suppressed-prompt path ───────────────────

test('a grant answered AFTER the no-prompt timeout still reveals the roster', async ({ page }) => {
  // The budget covers MIDI_PROMPT_TIMEOUT_MS (8 s) plus a boot.
  test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 6);
  await installMidiDeviceMock(page, { outputs: [OUT_A, OUT_B], grant: 'hang' });
  await boot(page);
  await seedPatch(page, [{ id: 'mob', type: 'midiOutBuddy' }]);

  const dock = await openDock(page, 'mob');
  await dock.getByTestId('shell-cell-midi-out-buddy-connect').click();

  // Chromium quietly suppresses the prompt on a low-engagement origin, which is
  // indistinguishable from a broken button — so the app says so on a timeout.
  await expect(
    dock.getByTestId('midi-out-buddy-access-error-mob'),
    'the suppressed-prompt case must not be silent',
  ).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

  // …and when the user finally presses Allow, `onLateResolve` must repaint
  // rather than throw the grant away and demand a second click.
  await grantMidiNow(page);
  await expect(dock.getByTestId('midi-out-buddy-output-select-mob')).toBeVisible({
    timeout: BOOT_MS,
  });
  await expect(dock.getByTestId('midi-out-buddy-access-error-mob')).toHaveCount(0);
  await expect(dock.getByTestId('midi-out-buddy-led-midi-mob')).toHaveAttribute('data-lit', '1');
});

// ── 5. A PORT THAT DISAPPEARS AFTER THE GRANT ──────────────────────────────

test('unplugging the bound output is survived — no pageerror, and the module says so', async ({
  page,
}) => {
  test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 4);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await installMidiDeviceMock(page, { outputs: [OUT_A, OUT_B] });
  await boot(page);
  await seedSequencedOutBuddy(page, 'mob');

  const dock = await openDock(page, 'mob');
  await dock.getByTestId('shell-cell-midi-out-buddy-connect').click();
  const select = dock.getByTestId('midi-out-buddy-output-select-mob');
  await expect(select).toBeVisible({ timeout: BOOT_MS });
  await select.selectOption(OUT_B.id);
  await waitForNoteOnFrom(page, OUT_B.id);

  // Pull the cable. Chromium keeps the port enumerated with state
  // 'disconnected', and this mock's `send()` throws on it exactly as the real
  // one does — so a module that kept writing would surface here.
  expect(await unplugMidiPort(page, OUT_B.id)).toBe(true);
  await clearMidiOutCaptured(page);

  // The sequencer keeps running. What must NOT happen is an unhandled throw out
  // of the scheduler tick, which would take the whole rack's clock with it.
  await expect
    .poll(async () => (await readMidiOutCaptured(page, OUT_A.id)).length, {
      message: 'a vanished port must not silently re-route notes to another synth',
      timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
    })
    .toBe(0);
  expect(errors, 'a disconnected port is handled, not thrown out of the tick').toEqual([]);
});

// ── 6. THE HANDLE SURVIVES A RECONCILER PASS ───────────────────────────────

test('the device binding survives a reconciler pass — the handle is not rebuilt under it', async ({
  page,
}) => {
  test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 4);
  await installMidiDeviceMock(page, { outputs: [OUT_A, OUT_B] });
  await boot(page);
  await seedSequencedOutBuddy(page, 'mob');

  const dock = await openDock(page, 'mob');
  await dock.getByTestId('shell-cell-midi-out-buddy-connect').click();
  const select = dock.getByTestId('midi-out-buddy-output-select-mob');
  await expect(select).toBeVisible({ timeout: BOOT_MS });
  await select.selectOption(OUT_B.id);
  await waitForNoteOnFrom(page, OUT_B.id);

  /** Stamp the live handle and read the stamp back — a rebuilt handle loses it.
   *  Identity, not a revision counter: #2321 made a type/domain change at a
   *  reused id a remove + an add, and this is the assertion that an ORDINARY
   *  edit is neither. */
  const stamp = async (): Promise<string | null> =>
    page.evaluate((id) => {
      const w = globalThis as unknown as {
        __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
        __patch: { nodes: Record<string, unknown> };
      };
      const api = w.__engine?.()?.read(w.__patch.nodes[id], 'card-api') as
        | (Record<string, unknown> & { __bindingStamp?: string })
        | undefined;
      if (!api) return null;
      api.__bindingStamp ??= `stamp-${Math.random().toString(36).slice(2)}`;
      return api.__bindingStamp;
    }, 'mob');

  const before = await stamp();
  expect(before, 'PRECONDITION: a live handle answers the card-api key').not.toBeNull();

  // An ordinary graph edit: move the node. That is a Y.Doc transaction, so the
  // reconciler runs a full pass over a snapshot containing this node.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { position: { x: number; y: number } }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['mob'];
      if (n) n.position.x = n.position.x + 17;
    });
  });

  await expect
    .poll(stamp, {
      message: 'the reconciler must not tear down and rebuild a bound device handle',
      timeout: BOOT_MS,
    })
    .toBe(before);

  // And the binding still WORKS, which is the half a stamp cannot prove.
  await clearMidiOutCaptured(page);
  await waitForNoteOnFrom(page, OUT_B.id);
});

// ── 7. THE INPUT SIDE — midiclock, same defect class, same fix ─────────────

test('midiclock rebinds its INPUT by name, and the rebound port drives the module', async ({
  page,
}) => {
  test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 4);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await installMidiDeviceMock(page, { outputs: [], inputs: [IN_A, IN_B] });
  await boot(page);
  await seedPatch(page, [
    {
      id: 'mc',
      type: 'midiclock',
      data: { lastDeviceId: STALE_IN_B_ID, lastDeviceName: IN_B.name },
    },
  ]);

  const dock = await openDock(page, 'mc');
  await dock.getByTestId('shell-cell-midiclock-connect').click();

  const select = dock.getByTestId('midiclock-device-select-mc');
  await expect(select).toBeVisible({ timeout: BOOT_MS });
  // Pre-fix this bound IN_A: the saved id resolved to nothing and the
  // hand-rolled pick fell through to "the first input" — a real port, so it
  // looked healthy, listening to the wrong hardware.
  await expect(select, 'the saved input is found by NAME after its id churned').toHaveValue(IN_B.id);

  // …and the module is really SUBSCRIBED to it: bytes injected on the rebound
  // port must reach the app, which only happens if `onmidimessage` was attached
  // to THAT port.
  await expect
    .poll(async () => injectMidiDeviceIn(page, IN_B.id, [0xf8]), {
      message: 'the rebound input has the live handler attached',
      timeout: BOOT_MS,
    })
    .toBe(true);
  expect(
    await injectMidiDeviceIn(page, IN_A.id, [0xf8]),
    'and the decoy input was NOT the one subscribed',
  ).toBe(false);
  expect(errors).toEqual([]);
});

// ── 8. POLYPHONY — a CLIP LANE's chord reaches the wire as CONCURRENT notes ──
//
// ⚠ THE DEFECT (owner report, 2026-09-02: "midi out on a poly lane to a poly
// synth isn't playing polyphony"). CLIPPLAYER's playback path built its poly
// cable with `lanesFromFiring` — the notes STARTING on this step packed into
// lanes 0..n-1 — and handed it to `PolySender.scheduleStep`, which writes ALL
// sixteen lanes (`lanes[i] ?? { pitch: 0, gate: 0 }`). So an onset CLOSED every
// voice it did not itself fill, and re-packed from lane 0 on top of a note that
// was still sounding: the new pitch landed on the held note's lane under a gate
// that never fell, MIDI-OUT-BUDDY's per-lane edge tracker saw no new rise, and
// it went on sounding the first pitch.
//
// Measured on this exact chain before the fix — peak concurrency ONE, and 60
// was the only pitch ever transmitted across ten onsets. After: peak THREE,
// all three pitches, overlapping.
//
// ⚠ WHY THE STAGGERED SHAPE, AND NOT A PLAIN CHORD. A chord whose notes all
// start on the SAME step was always fine (measured: 6 voices, 20/20 onsets),
// because one step's firing set then contains every voice and the positional
// pack happens to be right. Every existing clip test prints co-onset chords,
// which is precisely why all of them stayed green over this. The shape that
// breaks is the ordinary musical one: a note entering while another is held.
//
// The allocator's own rules (re-arm, lowest-free, steal-soonest-ending, the
// retire boundary) are pinned in `clip-types.test.ts`. This leg exists because
// that layer cannot see the consequence: bytes on a MIDI port.
test('a clip lane chord reaches the wire as CONCURRENT MIDI notes', async ({ page }) => {
  test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 6);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await installMidiDeviceMock(page, { outputs: [OUT_A, OUT_B] });
  await boot(page);

  // TIMELORDE + CLIPPLAYER + MIDI-OUT-BUDDY, wired the way the lane tap wires
  // them (`midiOutBuddyDef.chainWiring.laneTap`): the lane's poly pitch cable
  // into `poly`, its mono gate into `gate`, its velocity into `velocity`.
  await seedPatch(
    page,
    [
      { id: 'tl', type: 'timelorde', params: { running: 0, bpm: 200 } },
      {
        id: 'cp',
        type: 'clipplayer',
        params: { quantize: 0, stepDiv: 2, gateLength: 0.9, octave: 0 },
        data: {
          clips: {
            // Lane 0, slot 0. THREE OVERLAPPING NOTES: each enters while the
            // previous is still held, and all three are down together from
            // step 4 on.
            '0': {
              kind: 'note',
              lengthSteps: 8,
              root: 48,
              loop: true,
              steps: [
                { step: 0, midi: 60, velocity: 100, lengthSteps: 8 },
                { step: 2, midi: 64, velocity: 100, lengthSteps: 6 },
                { step: 4, midi: 67, velocity: 100, lengthSteps: 4 },
              ],
            },
          },
          queued: [0, null, null, null, null, null, null, null],
        },
      },
      { id: 'mob', type: 'midiOutBuddy' },
    ],
    [
      { id: 'e-poly', from: { nodeId: 'cp', portId: 'pitch1' }, to: { nodeId: 'mob', portId: 'poly' }, sourceType: 'polyPitchGate', targetType: 'polyPitchGate' },
      { id: 'e-gate', from: { nodeId: 'cp', portId: 'gate1' }, to: { nodeId: 'mob', portId: 'gate' }, sourceType: 'gate', targetType: 'gate' },
      { id: 'e-vel', from: { nodeId: 'cp', portId: 'vel1' }, to: { nodeId: 'mob', portId: 'velocity' }, sourceType: 'cv', targetType: 'cv' },
    ],
  );

  const dock = await openDock(page, 'mob');
  await dock.getByTestId('shell-cell-midi-out-buddy-connect').click();
  const select = dock.getByTestId('midi-out-buddy-output-select-mob');
  await expect(select).toBeVisible({ timeout: BOOT_MS });
  await select.selectOption(OUT_B.id);
  await clearMidiOutCaptured(page);

  // Run the rack transport. CLIPPLAYER has no clock of its own.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type?: string; params?: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      for (const n of Object.values(w.__patch.nodes)) {
        if (n.type === 'timelorde') {
          if (!n.params) n.params = {};
          n.params.running = 1;
          n.params.bpm = 200;
        }
      }
    });
  });

  /** Peak simultaneous sounding notes on the chosen port, and which pitches
   *  were down at that moment — replayed from the captured byte stream, so the
   *  claim is about the WIRE and not about any app state. */
  const peakChord = async (): Promise<{ peak: number; pitches: number[] }> => {
    const msgs = await readMidiOutCaptured(page, OUT_B.id);
    const held = new Set<number>();
    let peak = 0;
    let pitches: number[] = [];
    for (const m of msgs) {
      const status = m.bytes[0] ?? 0;
      const pitch = m.bytes[1] ?? 0;
      const vel = m.bytes[2] ?? 0;
      if (status >= 0x90 && status <= 0x9f && vel > 0) held.add(pitch);
      else if (status >= 0x80 && status <= 0x9f) held.delete(pitch);
      if (held.size > peak) {
        peak = held.size;
        pitches = [...held].sort((a, b) => a - b);
      }
    }
    return { peak, pitches };
  };

  // The gate: THREE notes down at once. Polled because the transport has to
  // reach step 4 for all three to overlap — the timeout BOUNDS the failure.
  await expect
    .poll(async () => (await peakChord()).peak, {
      message: 'three overlapping clip notes must be three sounding MIDI notes',
      timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
    })
    .toBeGreaterThanOrEqual(3);

  const { pitches } = await peakChord();
  expect(pitches, 'and they are the three DISTINCT pitches the clip holds').toEqual([60, 64, 67]);

  // Every voice is a real, matched note — never a Note On with no Note Off, and
  // never a stranded pitch on the external instrument.
  const all = await readMidiOutCaptured(page, OUT_B.id);
  const ons = all.filter((m) => (m.bytes[0] ?? 0) === 0x90 && (m.bytes[2] ?? 0) > 0);
  expect(ons.length, 'PRECONDITION: the chain really transmitted').toBeGreaterThanOrEqual(3);
  expect(new Set(ons.map((m) => m.bytes[1])), 'all three voices reached the wire').toEqual(
    new Set([60, 64, 67]),
  );

  // ⚠ POLLED, NOT READ. The peak gate above returns the INSTANT the third voice
  // arrives — which is before any of them is due to end, so a bare read here
  // would be asserting that a note was released early. The release is its own
  // observable event; wait for it, bounded.
  await expect
    .poll(
      async () =>
        (await readMidiOutCaptured(page, OUT_B.id)).filter((m) => (m.bytes[0] ?? 0) === 0x80)
          .length,
      {
        message: 'each voice is released, never stranded on the instrument',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      },
    )
    .toBeGreaterThanOrEqual(3);

  expect(
    await readMidiOutCaptured(page, OUT_A.id),
    'nothing leaked to the port the player did not choose',
  ).toEqual([]);
  expect(errors).toEqual([]);
});
