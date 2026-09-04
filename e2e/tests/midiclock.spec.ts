// e2e/tests/midiclock.spec.ts
//
// MIDICLOCK end-to-end, against the FACEPLATE.
//
// ── WHAT CHANGED, AND WHY THE SPEC GOT STRONGER RATHER THAN JUST DIFFERENT ──
//
// This file used to drive `.svelte-flow__node-midiclock` — the legacy card —
// and its header said the module was "limited to mount + Connect-button +
// no-crash" because "Playwright can't synthesize a MIDI clock stream". The
// second clause is still true. The first is not, and the reason is the whole
// point of the promotion:
//
//   THE CONNECT GESTURE USED TO BE DOCK-ONLY. Under the default shell an
//   un-migrated module renders a `moduleShellPlaceholder` in the lane, so on a
//   module that is completely inert until MIDI access is granted, the grant
//   required first discovering the dock full view. `midiclock-connect-{n}` is
//   an `action` cell now, and an action cell is not dock-restricted (only
//   `panel` is), so the gesture is on the LANE TILE. That is a behaviour
//   change a user can feel, and the test for it is below.
//
// ── ⚠ WHAT THIS SPEC DELIBERATELY DOES NOT ASSERT ───────────────────────────
//
// That MIDI actually connects. No CI runner has a MIDI device or an origin
// that has granted MIDI, and `requestMIDIAccess` in that environment either
// rejects or is quietly suppressed — which is precisely the case
// `midi-access.ts` exists to NAME rather than to fix. So "the press reached the
// seam" is the honest observable here, and it is the same one the face's own
// audition probe reads. The divider math, the System Real-Time parsing and the
// `node.data` → `node.params` migration are unit-covered
// (`midiclock.test.ts`, `midiclock-factory.test.ts`); the strings on the device
// body are covered in `midiclock-status-model.test.ts`.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installMidiDeviceMock, injectMidiDeviceIn } from '../_helpers/midi';

const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;
const NODE = 'mc';

async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({
    timeout: SLOW_RENDER ? 30_000 : 15_000,
  });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** The LANE tile's shell for a node. */
function laneShell(page: Page, nodeId: string): Locator {
  return page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`);
}

/**
 * Open a node's dock faceplate, scoped by `data-shell-node`.
 *
 * ⚠ SCOPED BY NODE, NOT BY "the dock" — opening a second node's faceplate SWAPS
 * the dock's occupant, so a locator that only said "the dock" would keep
 * resolving after a swap and assert the wrong node's surface.
 */
async function openDock(page: Page, nodeId: string): Promise<Locator> {
  const shell = laneShell(page, nodeId);
  await expect(shell).toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const dockShell = page
    .getByTestId('dock-full-view')
    .locator(`[data-testid="module-shell"][data-shell-tier="dock"][data-shell-node="${nodeId}"]`);
  await expect(dockShell).toBeVisible();
  return dockShell;
}

/** The audition ledger, read IN THE PAGE. Exposed by
 *  `exposeAuditionLedgerForTests` under the same `testHooksEnabled()` gate
 *  `__moduleSpecs` uses. */
async function auditionCount(page: Page, nodeId: string, seam: string): Promise<number> {
  return page.evaluate(
    ([id, s]) => {
      const log = (window as unknown as { __auditionLog?: () => { nodeId: string; seam: string; delivered: boolean }[] })
        .__auditionLog;
      if (!log) return -1;
      return log().filter((r) => r.nodeId === id && r.seam === s && r.delivered).length;
    },
    [nodeId, seam] as const,
  );
}

/**
 * ⚠ WAIT FOR THE ENGINE HANDLE BEFORE PRESSING CONNECT — the precondition
 * `spawnPatch` does NOT establish, and the root cause of this file's flake.
 *
 * `spawnPatch` waits for the DOM node (`.svelte-flow__node[data-id]`) to mount.
 * The CONNECT cell needs something else entirely: `midiclockConnect` resolves
 * `engine.read(node, 'card-api')` ONCE, and when the RECONCILER has not yet
 * added the engine node it records `delivered: false` and returns. There is no
 * retry and no queue, so a press landing in that window is SILENTLY LOST — the
 * lane tile looks identical, `cardState.connected` never flips, and
 * `midiclock-device-select` (which only renders when connected) never appears.
 *
 * ⚠ AND NO TIMEOUT RECOVERS IT — which is why the fix is not a bigger budget.
 * Measured with the handle forced unavailable at press time: `device-select`
 * was STILL absent after 15 000 ms — three times the 5 s budget that failed on
 * CI — with the audition ledger reading `delivered=0 dropped=1`. Waiting for
 * the handle first: visible in 5 ms, `delivered=1 dropped=0`.
 *
 * Same disease as the mono-normal probe that read the port before the worklet
 * existed (#2356): a test driving a seam before the engine has the node.
 */
async function waitForCardApi(page: Page, nodeId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((id) => {
          const w = globalThis as unknown as {
            __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
            __patch: { nodes: Record<string, unknown> };
          };
          const eng = w.__engine?.();
          const node = w.__patch.nodes[id];
          return !!(eng && node && eng.read(node, 'card-api'));
        }, nodeId),
      {
        message:
          `the reconciler has added ${nodeId}'s ENGINE node, so a CONNECT press can reach ` +
          '`read(node, "card-api").connect()` instead of being dropped',
        timeout: SLOW_RENDER ? 30_000 : 15_000,
      },
    )
    .toBe(true);
}

/**
 * Press CONNECT from the LANE tile, and prove the press REACHED THE SEAM.
 *
 * Waits for the engine handle first, then asserts the audition ledger recorded
 * a DELIVERED press — so a dropped press fails LOUDLY here, naming its cause,
 * instead of surfacing seconds later as "device-select not found" on whatever
 * assertion happens to come next.
 */
async function connectFromLane(page: Page, nodeId: string): Promise<void> {
  await waitForCardApi(page, nodeId);
  const before = await auditionCount(page, nodeId, 'engine-message');
  await laneShell(page, nodeId).getByTestId('shell-cell-midiclock-connect').click();
  await expect
    .poll(() => auditionCount(page, nodeId, 'engine-message'), {
      message: 'the CONNECT press reached the live engine handle and reported DELIVERED',
    })
    .toBeGreaterThan(before);
}

test.describe('MIDICLOCK faceplate', () => {
  test('the LANE TILE carries the CONNECT gesture — the defect this face fixes', async ({ page }) => {
    // ⚠ THE REGRESSION PIN FOR D4, and it is the test that would have caught the
    // original defect had the module been faced. Before promotion the lane held
    // a placeholder tile with no controls at all, so a player who never opened
    // the dock could not use this module for anything.
    await gotoShell(page);
    await spawnPatch(page, [{ id: NODE, type: 'midiclock', position: { x: 200, y: 200 } }]);

    const lane = laneShell(page, NODE);
    await expect(lane).toBeVisible();

    const connect = lane.getByTestId(`shell-cell-midiclock-connect`);
    await expect(connect, 'the CONNECT gesture is reachable without opening the dock').toBeVisible();
    await expect(connect).toBeEnabled();

    // …and the DIVISION is here too. Both ranked keys survive `laneOrder`,
    // which is what `midiclock-face-model.test.ts` asserts structurally; this
    // is the half that proves they PAINT.
    await expect(lane.getByTestId(`control-divisor`)).toBeVisible();
  });

  test('pressing CONNECT reaches the engine seam — not merely "does not crash"', async ({ page }) => {
    // ⚠ THE OLD VERSION OF THIS TEST CLICKED THE BUTTON AND ASSERTED THE CARD
    // WAS STILL VISIBLE. That is the assertion-free-click shape the audition
    // ledger was built to end: a completely dead button passes it. The
    // observable is whether the press RESOLVED A CALLABLE off the live engine
    // handle and called it, which is knowable on a runner with no MIDI at all.
    await gotoShell(page);
    await spawnPatch(page, [{ id: NODE, type: 'midiclock', position: { x: 200, y: 200 } }]);

    // The press can only reach the seam once the RECONCILER has added the
    // engine node — `spawnPatch` only guarantees the DOM node. Without this the
    // subject of this very test (a DELIVERED press) is a coin flip.
    await waitForCardApi(page, NODE);

    const before = await auditionCount(page, NODE, 'engine-message');
    expect(before, 'the audition ledger is exposed (VITE_E2E_HOOKS)').toBeGreaterThanOrEqual(0);

    await laneShell(page, NODE).getByTestId(`shell-cell-midiclock-connect`).click();

    // Auto-retrying: the press is synchronous but the ledger read is a
    // round-trip, and `connect()` is deliberately fire-and-forget.
    await expect
      .poll(() => auditionCount(page, NODE, 'engine-message'), {
        message: 'the CONNECT press must reach `read(node, "card-api").connect()` and report DELIVERED',
      })
      .toBeGreaterThan(before);

    // The shell survives whichever branch Web MIDI takes — granted with an
    // empty roster, rejected, or the suppressed-prompt timeout.
    await expect(laneShell(page, NODE)).toBeVisible();
  });

  test('the DOCK carries the device body, in its PRE-CONNECT state', async ({ page }) => {
    // ⚠ THIS IS ALSO THE STATE THE VRT BASELINE PHOTOGRAPHS, which is why the
    // exemption could be discharged: `requestMIDIAccess` is never called until
    // a CONNECT press, so `access` is null and the device roster does not exist
    // rather than merely being empty. Asserting the branch here means the
    // baseline's precondition is checked by something other than the baseline.
    await gotoShell(page);
    await spawnPatch(page, [{ id: NODE, type: 'midiclock', position: { x: 200, y: 200 } }]);
    const dock = await openDock(page, NODE);

    const body = dock.getByTestId(`midiclock-device-body-${NODE}`);
    await expect(body).toBeVisible();
    // Pre-connect: the empty-state copy and no picker.
    await expect(body.getByTestId(`midiclock-device-select-${NODE}`)).toHaveCount(0);
    await expect(body).toContainText('One-time per origin');

    // ⚠ AND EXACTLY ONE CONNECT AFFORDANCE ON THE WHOLE PLATE. The gesture is a
    // ranked ACTION CELL — that is what puts it on the lane tile — so a second
    // button inside the body would be one gesture with two affordances: clutter
    // under "compact is the default", and a second thing to keep in sync. This
    // asserts the band has it and the body does not.
    await expect(body.getByRole('button', { name: /Connect MIDI/ })).toHaveCount(0);
    await expect(dock.getByTestId('shell-cell-midiclock-connect')).toHaveCount(1);
  });

  test('the state words are UNPAINTED but PRESENT — the resting-text ruling, both halves', async ({ page }) => {
    // ⚠ A SOURCE GATE CANNOT SEE THIS. `face-resting-text-source` reads the
    // declaration surface and the shell, not a body's markup, and says so about
    // its own blind spot; the dock VRT baseline can photograph the lamp but
    // cannot read an attribute. So both halves are asserted here: the surface
    // paints no state word, AND the state is announced.
    await gotoShell(page);
    await spawnPatch(page, [{ id: NODE, type: 'midiclock', position: { x: 200, y: 200 } }]);
    const dock = await openDock(page, NODE);
    const body = dock.getByTestId(`midiclock-device-body-${NODE}`);

    // ── the PAINTED text carries no state word ──────────────────────────────
    const painted = (await body.innerText()).toUpperCase();
    for (const forbidden of ['RUNNING', 'STOPPED', 'TICKS', 'STATE:']) {
      expect(painted, `the resting faceplate must not paint "${forbidden}"`).not.toContain(forbidden);
    }
    // ⚠ NEGATIVE CONTROL for the read itself. `innerText` on a mis-resolved or
    // empty element is '' and would satisfy every assertion above — "the
    // surface is compliant" and "the surface is not there" must not look alike.
    expect(painted, 'the body really has text on it').toContain('ONE-TIME PER ORIGIN');

    // ── the ACCESSIBLE name carries it ──────────────────────────────────────
    const run = body.getByTestId(`midiclock-led-run-${NODE}`);
    await expect(run).toBeVisible();
    await expect(run, 'the lamp is DARK before a device is bound').toHaveAttribute('data-lit', '0');
    await expect(
      run,
      'the external transport state survives the readout deletion, in aria-label',
    ).toHaveAttribute('aria-label', /transport/i);

    const midi = body.getByTestId(`midiclock-led-midi-${NODE}`);
    await expect(midi).toHaveAttribute('data-lit', '0');
    await expect(
      midi,
      'and NOT-YET-ASKED is distinguishable from REFUSED — the whole point of the midi-access seam',
    ).toHaveAttribute('aria-label', /press Connect MIDI/i);

    // ⚠ WHAT THIS TEST STRUCTURALLY CANNOT SEE, stated rather than implied.
    // Both lamps read the body's `cardState`, whose INITIAL `$state` value is
    // byte-identical to what a freshly-booted engine's `snapshotState()`
    // returns — `{connected:false, permissionDenied:false, devices:[],
    // selectedDeviceId:null, running:false}`. So "the body subscribed and the
    // engine said not-connected" and "the body never subscribed at all" produce
    // the SAME DOM here, and no assertion on this surface can separate them
    // while the module is unbound. There is no pre-connect state that only a
    // live subscription can produce, so this is a real gap rather than a
    // missing assertion.
    //
    // What DOES close most of it, one test up: the CONNECT press proves
    // `getActiveEngine()?.read(node, 'card-api')` resolves for this node in
    // this environment, through the SAME `midiclockApi(nodeId)` helper the body
    // subscribes with. What remains unproven is only that the body's `$effect`
    // ran — a Svelte lifecycle question, not a wiring one — and the POST-connect
    // half (a live device roster reaching the picker) is unreachable on a
    // runner with no MIDI hardware by construction. `midiclock-status-model
    // .test.ts` owns every string this surface can produce; nothing here can
    // photograph or read them once they are `aria-label` only.
  });

  test('the DIVISION is a real param: the segmented cell commits into the graph', async ({ page }) => {
    // ⚠ THE ASSERTION THE OLD SPEC COULD NOT MAKE AT ALL, because before this
    // PR the division was a `node.data` key written by a bare proxy assignment.
    // Reading it back off `node.params` is what proves it went through the
    // ordinary origin-tagged seam — i.e. that it is automatable, MIDI-learnable
    // and undoable like any other value.
    await gotoShell(page);
    await spawnPatch(page, [{ id: NODE, type: 'midiclock', position: { x: 200, y: 200 } }]);
    const dock = await openDock(page, NODE);

    const cell = dock.getByTestId(`control-divisor`);
    await expect(cell).toBeVisible();

    // All five divisions are visible at once — that is what `segmented` buys
    // over a dropdown, and it is the reason no `paramCells` override exists.
    for (const label of ['1/4', '1/8', '1/16', '1/32', 'raw']) {
      await expect(cell.getByRole('radio', { name: label, exact: true })).toBeVisible();
    }

    await cell.getByRole('radio', { name: '1/16', exact: true }).click();
    await expect
      .poll(
        () =>
          page.evaluate((id) => {
            const w = globalThis as unknown as {
              __patch: { nodes: Record<string, { params?: Record<string, number> } | undefined> };
            };
            return w.__patch.nodes[id]?.params?.divisor ?? null;
          }, NODE),
        { message: 'picking 1/16 must land 6 in node.params.divisor' },
      )
      .toBe(6);
  });

  test('MIDI Start is READ: the transport goes RUNNING and the clock advances (owner repro)', async ({ page }) => {
    // ⚠ THE OWNER'S GESTURE, END TO END, ON THE DEFAULT SHELL (report 2026-09-03:
    // "midiclock doesn't seem to read start"). Fresh module, CONNECT from the
    // lane tile, device auto-bound, then the wire speaks: 0xFA (Start), a burst
    // of 0xF8 (clock), 0xFC (Stop). The observable is the RUN lamp — the one
    // surface in the product that says whether the external transport is
    // rolling — plus the tick count moving, read on demand off the live handle
    // exactly the way the state contract documents.
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await installMidiDeviceMock(page, {
      outputs: [],
      inputs: [{ id: 'hw-in-a', name: 'HW Drum Machine' }],
    });
    await gotoShell(page);
    await spawnPatch(page, [{ id: NODE, type: 'midiclock', position: { x: 200, y: 200 } }]);

    // CONNECT from the LANE — the exact affordance a player meets first.
    // Guarded: an unguarded press here had the same latent flake as the DEBUG
    // TAIL test below, it simply had not surfaced yet.
    await connectFromLane(page, NODE);
    const dock = await openDock(page, NODE);
    const select = dock.getByTestId(`midiclock-device-select-${NODE}`);
    await expect(select).toBeVisible();
    await expect(select, 'the one connected input is auto-bound').toHaveValue('hw-in-a');

    // POSITIVE CONTROL for the instrument: inject() is false until the app has
    // really attached `onmidimessage` to THIS port — poll on that truth, then
    // every later injection is known to land on a live handler.
    const run = dock.getByTestId(`midiclock-led-run-${NODE}`);
    await expect(run, 'pre-start: the lamp is dark').toHaveAttribute('data-lit', '0');
    await expect
      .poll(async () => injectMidiDeviceIn(page, 'hw-in-a', [0xfa]), {
        message: 'the bound input has the live handler attached (0xFA delivered)',
      })
      .toBe(true);

    // ── START WAS READ ──────────────────────────────────────────────────────
    await expect(run, 'MIDI Start raises RUN — the owner-reported defect line').toHaveAttribute(
      'data-lit',
      '1',
    );

    // ── THE CLOCK ADVANCES ──────────────────────────────────────────────────
    await page.evaluate(() => {
      const w = window as unknown as {
        __midiDeviceMock: { inject(p: string, b: number[]): boolean };
      };
      for (let i = 0; i < 48; i++) w.__midiDeviceMock.inject('hw-in-a', [0xf8]);
    });
    await expect
      .poll(
        () =>
          page.evaluate((id) => {
            const w = globalThis as unknown as {
              __engine?: () => {
                read: (n: unknown, k: string) => { ticksReceived?: number } | undefined;
              } | null;
              __patch: { nodes: Record<string, unknown> };
            };
            const eng = w.__engine?.();
            const node = w.__patch.nodes[id];
            if (!eng || !node) return -1;
            return eng.read(node, 'state')?.ticksReceived ?? -1;
          }, NODE),
        { message: '48 injected 0xF8 ticks are counted by the live handle' },
      )
      .toBeGreaterThanOrEqual(48);

    // ── AND STOP DROPS IT ───────────────────────────────────────────────────
    expect(await injectMidiDeviceIn(page, 'hw-in-a', [0xfc])).toBe(true);
    await expect(run, 'MIDI Stop lowers RUN').toHaveAttribute('data-lit', '0');
    expect(errors).toEqual([]);
  });

  test('the DEBUG TAIL: open shows decoded traffic, pause drops it, clear empties it, closed records NOTHING', async ({ page }) => {
    // ⚠ THE OWNER-REQUESTED AFFORDANCE, driven end to end. The tail's whole
    // reason to exist is separating "no bytes arrive on the bound port" from
    // "bytes arrive and are dropped", so the test drives BOTH transport and
    // channel-voice bytes (the module itself filters the latter — the tap must
    // not) and then proves the zero-cost-when-closed contract behaviourally:
    // traffic injected while the panel is closed is NOT in the tail when it
    // reopens, because nothing was subscribed to record it.
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await installMidiDeviceMock(page, {
      outputs: [],
      inputs: [{ id: 'hw-in-a', name: 'HW Drum Machine' }],
    });
    await gotoShell(page);
    await spawnPatch(page, [{ id: NODE, type: 'midiclock', position: { x: 200, y: 200 } }]);

    // ⚠ THE FLAKE THIS FILE HAD. An unguarded press here was dropped whenever
    // the reconciler had not yet added the engine node, and the failure landed
    // on the assertion below as "device-select not found" — 5 s of waiting for
    // a state that was never coming. See `connectFromLane`.
    await connectFromLane(page, NODE);
    const dock = await openDock(page, NODE);
    await expect(dock.getByTestId(`midiclock-device-select-${NODE}`)).toBeVisible();

    // Closed at rest: the panel does not exist, only its toggle does.
    //
    // ⚠ `toHaveCount(0)` CANNOT CARRY THIS ALONE — it is equally true of a body
    // that never rendered, which is exactly the failure mode above. The toggle's
    // PRESENCE is the positive half: it proves the debug affordance rendered, so
    // the panel's absence is a real fact about the closed state rather than
    // about an empty dock.
    await expect(dock.getByTestId(`midiclock-debug-${NODE}`)).toBeVisible();
    const tail = dock.getByTestId(`midiclock-tail-${NODE}`);
    await expect(tail).toHaveCount(0);

    // Wait for the module's input subscription BEFORE opening the tail, so the
    // first injected byte below is known to land on a live handler.
    await expect
      .poll(async () => injectMidiDeviceIn(page, 'hw-in-a', [0xfa]), {
        message: 'the bound input has the live handler attached',
      })
      .toBe(true);

    // ── OPEN: rows render, decoded ──────────────────────────────────────────
    await dock.getByTestId(`midiclock-debug-${NODE}`).click();
    await expect(tail).toBeVisible();
    await expect(tail, 'an open, empty tail states the honest negative').toContainText(
      'no traffic',
    );

    await injectMidiDeviceIn(page, 'hw-in-a', [0xfa]);
    await injectMidiDeviceIn(page, 'hw-in-a', [0xf8]);
    await injectMidiDeviceIn(page, 'hw-in-a', [0x90, 60, 100]); // note-on: NOT transport — the tap must show it anyway
    await expect(tail).toContainText('START');
    await expect(tail).toContainText('CLOCK');
    await expect(tail, 'channel-voice traffic is visible too — hex + decode').toContainText(
      'NOTE ON C4',
    );
    await expect(tail, 'the raw bytes are on the row').toContainText('90 3C 64');

    // ── PAUSE: traffic during a pause is dropped, resume records again ──────
    await dock.getByTestId(`midiclock-tail-pause-${NODE}`).click();
    await injectMidiDeviceIn(page, 'hw-in-a', [0xfc]); // Stop, sent while paused
    await dock.getByTestId(`midiclock-tail-pause-${NODE}`).click(); // resume
    await injectMidiDeviceIn(page, 'hw-in-a', [0xfb]); // Continue, sent after resume
    await expect(tail, 'the post-resume byte arrives').toContainText('CONTINUE');
    await expect(tail, 'the paused-away byte does not').not.toContainText('STOP');

    // ── CLEAR ───────────────────────────────────────────────────────────────
    await dock.getByTestId(`midiclock-tail-clear-${NODE}`).click();
    await expect(tail).toContainText('no traffic');
    await expect(tail).not.toContainText('START');

    // ── CLOSED = UNSUBSCRIBED, proven behaviourally ─────────────────────────
    await dock.getByTestId(`midiclock-debug-${NODE}`).click();
    await expect(tail).toHaveCount(0);
    await injectMidiDeviceIn(page, 'hw-in-a', [0x90, 61, 100]); // C#4, while closed
    await dock.getByTestId(`midiclock-debug-${NODE}`).click();
    await expect(tail).toBeVisible();
    // POSITIVE CONTROL for the negative below: a byte sent now DOES land…
    await injectMidiDeviceIn(page, 'hw-in-a', [0x90, 62, 100]); // D4
    await expect(tail).toContainText('NOTE ON D4');
    // …so the closed-time byte's absence is a real fact about the closed tap,
    // not about a dead panel.
    await expect(tail, 'nothing was recorded while closed').not.toContainText('C#4');

    expect(errors).toEqual([]);
  });

  test('the four documented outputs are on the shell patch surface', async ({ page }) => {
    // ⚠ THE PORT LABELS CHANGE ON PROMOTION, AND THAT IS THE CORRECT DIRECTION.
    // This test used to assert `CLK / RUN / START / STOP` — the abbreviations
    // in `MidiclockCard.svelte`'s hand-written `PortDescriptor` list, which
    // existed nowhere else in the product. The shell derives its patch surface
    // from the DEF, so it shows the port IDS: `clock`, `run`, `midistart`,
    // `midistop`. Those are the names in `contract-lock.txt`, in the generated
    // I/O reference, and in every `docs.outputs` sentence — so the promotion
    // makes the jack a player patches agree with the documentation they read
    // about it. Recorded rather than silently updated, because "an assertion
    // changed" and "the product changed" must not look the same in a diff.
    await gotoShell(page);
    await spawnPatch(page, [{ id: NODE, type: 'midiclock', position: { x: 200, y: 200 } }]);
    await page
      .locator(`.svelte-flow__node[data-id="${NODE}"] [data-testid="patch-trigger"]`)
      .click();
    const chrome = page.locator(`[data-patch-panel-chrome="${NODE}"]`);
    await expect(chrome).toHaveAttribute('aria-hidden', 'false');
    await chrome.locator('[data-testid="patch-panel-nav"][data-nav="outputs"]').click();
    for (const port of ['CLOCK', 'RUN', 'MIDISTART', 'MIDISTOP']) {
      await expect(chrome).toContainText(port);
    }
  });
});
