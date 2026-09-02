// e2e/tests/face-trails.spec.ts
//
// THE TRAILS FACE, driven for real on the DEFAULT shell — the seams no other
// gate can see.
//
// ⚠ WHY A NEW FILE RATHER THAN FOUR MORE LEGS IN `trails.spec.ts`. That file's
// eight legs are the AGENTS.md rule-8 real-source chain (touch → x1 → a real
// VCA → audible RMS, the loop gate, note mode, poly, TRIG) plus three that
// assert the CARD'S DOM under `?shell=legacy`. Promotion does not remove the
// card from `?shell=legacy`, so NOT ONE of them is re-pointed or deleted — the
// build owes NEW default-shell legs, not replacements, and keeping them apart is
// what makes that visible in a diff.
//
// ⚠ THE MEMORY THIS FILE EXISTS TO SERVE: 377 of 431 e2e specs run on
// `?shell=legacy`, which is exactly how a face ships broken while every spec is
// green. Every leg below runs with NO shell override.
//
// ⚠ THE FILENAME AND ITS LANE. `e2e/webgl-heavy-globs.ts` classifies by PREFIX,
// and a spec swept into the heavy lane runs NOWHERE in PR CI (that lane was
// deleted in #839; the attest job skips it whenever the hash is unchanged) —
// green forever. Checked against the live glob list rather than assumed:
// neither `face-*` nor `trails-*` matches any heavy glob today, so this lands in
// the sharded `e2e` matrix. `face-trails.spec.ts` follows `face-mappy` /
// `face-videobox` / `face-painter`, and a `face-*` prefix cannot collide with a
// future module-named glob. Nothing here is WebGL-heavy: it reads DOM facts,
// graph state and one AnalyserNode, and samples no GPU pixels.
//
// WHAT THE OTHER GATES ALREADY HOLD, so this file does not repeat it:
//   * `trails-face-model.test.ts` — the rank, the tier ladder, the forced
//     `glyph: 'none'`, the audition probe, the two slots, the shared mirror.
//   * `trails-status-model.test.ts` — all six status kinds → lamp/error/hint.
//   * `face-rack-status-source.test.ts` — the body declares what it paints.
//   * `workflow-shell-faces.spec.ts` — the compact + dock PIXELS.
//   * `trails.spec.ts` — the audio, the decoder, the monitor, the card.
//
// WHAT NONE OF THEM CAN SEE, which is what is below:
//   1. ⚠ THAT THE MODULE IS USABLE UNDER THE SHELL AT ALL. Promotion stops both
//      default surfaces rendering `TrailsCard`. Every affordance a player
//      reaches without opening the dock is new DOM authored in this PR.
//   2. ⚠ THAT THE PRESS REACHES THIS NODE'S SEAM. `status().kind === 'bound'`
//      needs a Bela Trails on USB, which no runner has; the audition ledger is
//      the observable a runner CAN answer.
//   3. ⚠ THAT THE FACE DOES NOT DISTURB THE AUDIO PATH. Two mirror instances
//      now poll `read(node,'state')` at rAF where one card used to.
//   4. ⚠ A THROWN SHELL. The shared-derivation memory (a repair landing on
//      `ModuleShellPlaceholder` while `ModuleShell` kept throwing) says only
//      PROMOTING reveals that class, and only a `pageerror` guard catches it —
//      so every leg here takes `errorWatch`.

import { test, expect } from './_fixtures';
import { type Locator, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow, describeScopeWindow } from './_module-coverage-helpers';
import { installMidiMock } from '../_helpers/midi';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

// ⚠ AN EXPLICIT PER-TEST BUDGET. Playwright's default is 30 s and this suite
// does not override it, so a wait carrying no timeout of its own is bounded by a
// number that appears NOWHERE in the source — there is nothing to grep for but
// its absence. Both legs that boot the engine and open a dock take the shared
// export rather than a local number.
test.describe.configure({ mode: 'parallel', timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

const NODE = 'tr';

/** The scope RMS a closed VCA must stay under, and an open one must clear.
 *  The same floor `trails.spec.ts` uses, so the two cannot drift into disagreeing
 *  about what "audible" means. */
const AUDIBLE_FLOOR = 0.03;
/** Full window for the SILENCE half — no early exit, because an assertion of
 *  silence has nothing to exit early on. */
const SILENCE_WINDOW_MS = 500;
/** Cap that BOUNDS THE FAILURE for the audible half; the `untilPeak` target is
 *  the gate, and it names the field the assertion then reads. */
const AUDIBLE_CAP_MS = 6000;

/** Boot the DEFAULT shell. `?shell=legacy` is precisely the surface promotion
 *  does not change, so naming the absence of an override is the point. */
async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack?seed=none');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
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
 * resolving after a swap and assert the wrong node's surface. The retry is the
 * tv-librarian pattern: the tile button is hit-testable while a previous pane is
 * still tearing down, so one click can land on nothing.
 */
async function openDock(page: Page, nodeId: string): Promise<Locator> {
  const shell = laneShell(page, nodeId);
  await expect(shell).toBeVisible({ timeout: BOOT_MS });
  const dockShell = page
    .getByTestId('dock-full-view')
    .locator(`[data-testid="module-shell"][data-shell-tier="dock"][data-shell-node="${nodeId}"]`);
  await expect(async () => {
    if ((await dockShell.count()) === 0) {
      await shell.getByTestId('shell-open-dock').click();
    }
    await expect(dockShell).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  return dockShell;
}

/** The audition ledger, read IN THE PAGE. Exposed by
 *  `exposeAuditionLedgerForTests` under the same `testHooksEnabled()` gate
 *  `__moduleSpecs` uses. `-1` means the hook is absent, which the caller
 *  asserts rather than silently tolerating. */
async function auditionCount(page: Page, nodeId: string, seam: string): Promise<number> {
  return page.evaluate(
    ([id, s]) => {
      const log = (
        window as unknown as {
          __auditionLog?: () => { nodeId: string; seam: string; delivered: boolean }[];
        }
      ).__auditionLog;
      if (!log) return -1;
      return log().filter((r) => r.nodeId === id && r.seam === s && r.delivered).length;
    },
    [nodeId, seam] as const,
  );
}

/** Install the in-memory Trails through the app's own seam — the same hook
 *  `trails.spec.ts` uses, so the /trails/i port match, the shared
 *  `createMidiInputClaim` slot and the module's 14-bit assembler all execute. */
async function installSim(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const w = globalThis as unknown as { __trailsTestInstall?: () => Promise<boolean> };
    if (!w.__trailsTestInstall) return false;
    return await w.__trailsTestInstall();
  });
}

/** Put a finger on the pad. Coordinates are the pad's own 0..1. */
async function simTouch(page: Page, ch: number, x: number, y: number): Promise<void> {
  await page.evaluate(
    ({ ch, x, y }) => {
      const w = globalThis as unknown as {
        __trailsSim?: {
          gateOn(c: number): void;
          touch(c: number, x: number, y: number): void;
          send(bytes: number[]): void;
        };
      };
      if (!w.__trailsSim) throw new Error('__trailsSim missing — install the simulated Trails first');
      w.__trailsSim.gateOn(ch);
      w.__trailsSim.touch(ch, x, y);
    },
    { ch, x, y },
  );
}

test('@trails the LANE TILE paints the mirror and carries the CONNECT gesture', async ({
  page,
  errorWatch,
}) => {
  // ⚠ THE REGRESSION PIN FOR THE DEFECT THIS FACE FIXES. Before promotion the
  // lane held a placeholder tile with no controls at all, so a player who never
  // opened the dock could not grant MIDI, could not turn a knob, and could not
  // see whether the hardware was doing anything.
  await gotoShell(page);
  await spawnPatch(page, [{ id: NODE, type: 'trails', position: { x: 200, y: 200 }, domain: 'audio' }]);

  const lane = laneShell(page, NODE);
  await expect(lane).toBeVisible({ timeout: BOOT_MS });

  // ── the GESTURE, on the tile ────────────────────────────────────────────
  const connect = lane.getByTestId('shell-cell-trails-connect');
  await expect(connect, 'the CONNECT gesture is reachable without opening the dock').toBeVisible();
  await expect(connect).toBeEnabled();

  // ── the PICTURE, on the tile ────────────────────────────────────────────
  // The `tileBody` slot. Without it the promoted tile is three cells over a jack
  // rail and this module's one live picture would exist only behind the dock.
  const tilePad = lane.getByTestId(`trails-tile-pad-${NODE}`);
  await expect(tilePad, 'the pad mirror paints on the LANE TILE').toBeVisible();
  // ⚠ AND IT REALLY DREW. A `<canvas>` that mounted but never painted is visible,
  // has a box, and is entirely blank — which is the failure a visibility check
  // cannot tell from success. The backing store is only sized inside `paint()`,
  // so a non-zero `width` is proof the paint path RAN.
  const painted = await tilePad.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    return { w: c.width, h: c.height, cssW: c.clientWidth };
  });
  expect(painted.w, 'the mirror sized its backing store, i.e. paint() ran').toBeGreaterThan(0);
  expect(painted.h).toBeGreaterThan(0);
  // 40 px wide by declaration; the height is derived from the panel's own
  // millimetres, so the mirror must be TALLER than it is wide (85 x 85 mm pad
  // plus a 10 mm bar on the bottom edge) rather than square.
  expect(painted.cssW, 'the tile mirror is the small one').toBeLessThan(60);
  expect(painted.h / painted.w, 'the panel aspect, not a square').toBeGreaterThan(1);

  // ── the LAMP, dark, with its sentence on the accessible name ────────────
  const lamp = lane.getByTestId(`trails-tile-led-${NODE}`);
  await expect(lamp).toBeVisible();
  await expect(lamp, 'nothing is bound on a runner').toHaveAttribute('data-lit', '0');
  // ⚠ BOTH HALVES OF THE RESTING-TEXT RULING. The state is ANNOUNCED but never
  // painted: `face-resting-text-source` reads the declaration surface and the
  // shell, not an extension body's markup, and says so about its own blind spot;
  // the VRT baseline can photograph the lamp but cannot read an attribute.
  await expect(lamp).toHaveAttribute('aria-label', /Connect Trails|Not connected/i);
  const painted_text = (await lane.innerText()).toUpperCase();
  expect(painted_text, 'the tile really has text on it (vacuity control)').toContain('LINK');
  for (const forbidden of ['BOUND', 'STREAMING', 'NO PORT', 'IDLE']) {
    expect(painted_text, `the resting tile must not paint "${forbidden}"`).not.toContain(forbidden);
  }

  // ── and the LEGACY CARD is gone from the default shell ──────────────────
  // The half that proves this leg is reading the promoted surface rather than
  // the card wearing a different hat.
  await expect(page.getByTestId(`trails-card-${NODE}`)).toHaveCount(0);

  errorWatch.assertClean();
});

test('@trails the DOCK body paints the mirror, and MON reports what the module does NOT understand', async ({
  page,
  errorWatch,
}) => {
  // ⚠ THE SAME INSTRUMENT AS `trails.spec.ts`'s MON leg, ON THE OTHER SURFACE.
  // That leg asserts the CARD'S `<pre>` under `?shell=legacy` and still passes;
  // this asserts the BODY'S, under the default shell. The unrecognised-frame
  // half is the whole value of the affordance: every wire constant this module
  // has is a reading of a manual, and a monitor that only showed traffic the
  // decoder already understood could not falsify a single one of them.
  await gotoShell(page);
  await spawnPatch(page, [{ id: NODE, type: 'trails', position: { x: 200, y: 200 }, domain: 'audio' }]);
  const dock = await openDock(page, NODE);

  const body = dock.getByTestId(`trails-face-body-${NODE}`);
  await expect(body).toBeVisible();
  await expect(body.getByTestId(`trails-face-pad-${NODE}`), 'the dock mirror').toBeVisible();
  // The bar caption — a LANDMARK naming the surface's own condition, gated on
  // the same flag as the hatch it explains.
  await expect(body.getByTestId(`trails-face-bar-note-${NODE}`)).toContainText(
    'not sent over USB-MIDI',
  );

  // ⚠ EXACTLY ONE CONNECT AFFORDANCE ON THE WHOLE PLATE. The gesture is a ranked
  // ACTION cell — that is what puts it on the lane tile — so a second button
  // inside the body would be one gesture with two affordances and a second thing
  // to keep in sync. This asserts the band has it and the body does not.
  await expect(body.getByRole('button', { name: /Connect/i })).toHaveCount(0);
  await expect(dock.getByTestId('shell-cell-trails-connect')).toHaveCount(1);

  // ── MON is ABSENT AT REST, which is what makes it permitted at all ──────
  await expect(body.getByTestId(`trails-face-mon-text-${NODE}`)).toHaveCount(0);
  await expect(body.getByTestId(`trails-face-loops-${NODE}`)).toHaveCount(0);

  // ── open it, and drive REAL frames through the REAL decoder ─────────────
  expect(await installSim(page), 'simulated Trails installed (needs VITE_E2E_HOOKS)').toBe(true);
  await body.getByTestId(`trails-face-mon-${NODE}`).click();
  await expect(body.getByTestId(`trails-face-mon-${NODE}`)).toHaveAttribute('aria-pressed', 'true');

  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __trailsSim?: {
        touch(c: number, x: number, y: number): void;
        send(bytes: number[]): void;
        noteTouch(c: number, x: number, y: number, v?: number): void;
        noteRelease(c: number, x: number, y: number): void;
      };
    };
    const sim = w.__trailsSim!;
    sim.touch(1, 0.5, 0.5); // four frames the decoder understands
    // CC47 is the fine partner the MIDI convention would pair with CC15. A
    // firmware using it would look EXACTLY like this, and the readout has to
    // name it rather than silently dropping it.
    for (let i = 0; i < 5; i++) sim.send([0xb0, 47, 0x40]);
    // A strike and its running-status release share one row (the release is a
    // note-ON at velocity 0), so the row's raw last byte is 0 between strikes.
    // The page must show the STRIKE's velocity — the owner's first real capture
    // read `last=0` on a device struck 53 times and was nearly reported as
    // "Trails sends velocity 0".
    for (let i = 0; i < 3; i++) {
      sim.noteTouch(1, 81, 81, 97);
      sim.noteRelease(1, 81, 81);
    }
  });

  const log = body.getByTestId(`trails-face-mon-text-${NODE}`);
  await expect(log).toContainText('ch1[1X] CC47', { timeout: 10_000 });
  // ⚠ THE COUNT, not the words. The header prints "N not decoded" even when N is
  // zero, so asserting the bare phrase would pass on a monitor that had silently
  // dropped every unrecognised frame — the one failure this exists to catch.
  await expect(log).toContainText('5 not decoded');
  await expect(log).toContainText('trails-decode.ts');
  await expect(log, 'the row the module DOES understand, unflagged').toContainText('ch1[1X] CC15');
  await expect(log, 'the STRIKE velocity, not the release zero').toContainText('vel=97');
  await expect(log).not.toContainText('vel=0');
  await expect(log, 'the label carries no momentary state').not.toContainText('NOTE 81 on');

  // The counters line came with it, and it is a RATIO rather than four lamps.
  await expect(body.getByTestId(`trails-face-loops-${NODE}`)).toContainText(/loops \d+ · edges/);

  // ⚠ THE `<pre>` IS SELECTABLE, which is the deliverable rather than a style:
  // the summary exists to be pasted into a message.
  await expect(log).toHaveCSS('user-select', 'text');

  // ── and it CLOSES again, taking both measurements off the plate ─────────
  await body.getByTestId(`trails-face-mon-${NODE}`).click();
  await expect(body.getByTestId(`trails-face-mon-text-${NODE}`)).toHaveCount(0);
  await expect(body.getByTestId(`trails-face-loops-${NODE}`)).toHaveCount(0);

  errorWatch.assertClean();
});

test('@trails CONNECT from the LANE TILE reaches this node\'s own seam, and the body NAMES the no', async ({
  page,
  errorWatch,
}) => {
  // ⚠ THE OBSERVABLE A RUNNER CAN ANSWER. `status().kind === 'bound'` needs a
  // granted origin AND a physical Bela Trails on USB, so a state probe would be
  // permanently red on a perfectly live control. The audition ledger asks the
  // question that IS answerable: did the press resolve a callable off the live
  // engine handle and call it. The old shape of this test — click the button,
  // assert the surface is still visible — is the assertion-free click the ledger
  // was built to end: a completely dead button passes it.
  //
  // The mock's one input is named "Mock MIDI Input", which `/trails/i` must NOT
  // match — so this is also the port matcher's negative control on a real page.
  await installMidiMock(page);
  await gotoShell(page);
  await spawnPatch(page, [{ id: NODE, type: 'trails', position: { x: 200, y: 200 }, domain: 'audio' }]);

  // Spawning alone must not have asked for MIDI. The grant is gesture-gated and
  // lives nowhere else; a face that auto-connected would prompt on patch load.
  const preCalls = await page.evaluate(() => {
    const w = globalThis as unknown as { __mockMidi: { accessCallCount(): number } };
    return w.__mockMidi.accessCallCount();
  });
  expect(preCalls, 'mounting the FACE must never ask for MIDI access').toBe(0);

  const before = await auditionCount(page, NODE, 'engine-message');
  expect(before, 'the audition ledger is exposed (VITE_E2E_HOOKS)').toBeGreaterThanOrEqual(0);

  await laneShell(page, NODE).getByTestId('shell-cell-trails-connect').click();

  // Auto-retrying: the press is synchronous but the ledger read is a round-trip,
  // and `connect()` is deliberately fire-and-forget (an `await` above
  // `requestMIDIAccess` spends the user activation).
  await expect
    .poll(() => auditionCount(page, NODE, 'engine-message'), {
      message:
        'the CONNECT press must reach `read(node, "card-api").connect()` and report DELIVERED',
    })
    .toBeGreaterThan(before);

  // …and it really reached the BROWSER, not merely the seam.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const w = globalThis as unknown as { __mockMidi: { accessCallCount(): number } };
        return w.__mockMidi.accessCallCount();
      }),
    )
    .toBeGreaterThan(0);

  // ── THE OUTCOME IS NAMED RATHER THAN SILENT ────────────────────────────
  // The dock body's error line, verbatim from the binding layer — the only
  // instruction in the product for the failure a player will actually hit.
  const dock = await openDock(page, NODE);
  const err = dock.getByTestId(`trails-face-status-${NODE}`);
  await expect(err).toContainText(/USB-C/, { timeout: 10_000 });
  await expect(err, 'a fault is announced, not merely coloured').toHaveAttribute('role', 'alert');

  // ⚠ AND THE LAMP MOVED — the half a naive port loses. `StatusLed`'s tone
  // styles only the LIT lamp, so `lit={bound}` would render this fault
  // pixel-identically to a fresh spawn and silently delete one of the legacy
  // card's three LED states. A fault is LIT and WARN.
  const lamp = dock.getByTestId(`trails-face-led-${NODE}`);
  await expect(lamp).toHaveAttribute('data-lit', '1');
  await expect(lamp).toHaveClass(/warn/);

  // The port matcher's negative control: a foreign port must not be adopted.
  const kind = await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
      __patch: { nodes: Record<string, unknown> };
    };
    const eng = w.__engine?.();
    const node = w.__patch.nodes[id];
    if (!eng || !node) return null;
    const st = eng.read(node, 'state') as { status: { kind: string; portNames: string[] } };
    return st.status;
  }, NODE);
  expect(kind?.kind).toBe('no-port');
  expect(kind?.portNames, 'a foreign port must not be adopted').toEqual([]);

  errorWatch.assertClean();
});

test('@trails the FACE does not disturb the audio path — a touch still opens a real VCA', async ({
  page,
  errorWatch,
}) => {
  // ⚠ THE LEG THAT WOULD CATCH A BODY THAT STARVED THE ENGINE. Promotion puts
  // TWO mirror instances on screen for one node — the lane tile and the open
  // dock pane are mounted at the same time — and each polls
  // `read(node, 'state')` on its own rAF where one card used to. This re-runs
  // `trails.spec.ts`'s line-178 chain under the DEFAULT shell with the dock
  // OPEN, which is the worst case that ships.
  //
  // The VCA spawns CLOSED (`base` 0, `cvAmount` 1), so its output IS the
  // module's X jack made audible: silent at rest, open under a touch. That gives
  // the positive assertion its own negative control in the same test.
  await gotoShell(page);
  await spawnPatch(
    page,
    [
      { id: NODE, type: 'trails', position: { x: 60, y: 60 }, domain: 'audio' },
      { id: 'vco', type: 'analogVco', position: { x: 360, y: 60 }, domain: 'audio' },
      // Stated rather than relied on, so a future change to the VCA's defaults
      // reddens here instead of quietly making the negative control vacuous.
      {
        id: 'vca',
        type: 'vca',
        position: { x: 640, y: 60 },
        domain: 'audio',
        params: { base: 0, cvAmount: 1 },
      },
      {
        id: 'scp',
        type: 'scope',
        position: { x: 920, y: 60 },
        domain: 'audio',
        params: { timeMs: 200 },
      },
    ],
    [
      {
        id: 'e-osc',
        from: { nodeId: 'vco', portId: 'sine' },
        to: { nodeId: 'vca', portId: 'audio' },
        sourceType: 'audio',
        targetType: 'audio',
      },
      {
        id: 'e-cv',
        from: { nodeId: NODE, portId: 'x1' },
        to: { nodeId: 'vca', portId: 'cv' },
        sourceType: 'cv',
        targetType: 'cv',
      },
      {
        id: 'e-scope',
        from: { nodeId: 'vca', portId: 'audio' },
        to: { nodeId: 'scp', portId: 'ch1' },
        sourceType: 'audio',
        targetType: 'audio',
      },
    ],
  );

  // BOTH surfaces mounted at once — the condition being tested.
  const dock = await openDock(page, NODE);
  await expect(dock.getByTestId(`trails-face-pad-${NODE}`)).toBeVisible();
  await expect(laneShell(page, NODE).getByTestId(`trails-tile-pad-${NODE}`)).toBeVisible();

  // (1) NEGATIVE CONTROL, first and over a FULL window with no early exit.
  const before = await readScopePeakOverWindow(page, 'scp', SILENCE_WINDOW_MS);
  expect(before.polls, 'the SCOPE was actually sampled').toBeGreaterThan(0);
  expect(
    before.rms,
    `a closed VCA must be silent before any touch — ${describeScopeWindow(before)}`,
  ).toBeLessThan(AUDIBLE_FLOOR);

  // (2) The real connect path, then a real 14-bit CC touch on the wire.
  expect(await installSim(page), 'simulated Trails installed (needs VITE_E2E_HOOKS)').toBe(true);
  await simTouch(page, 1, 0.9, 0.5);

  // (3) THE AUDIBLE ASSERTION. x1 ≈ 0.9 is the VCA's gain now.
  //     ⚠ `peak`, matching the `untilPeak` target — the exit condition must
  //     imply the assertion, and an `rms` read at the instant a peak-keyed
  //     window closes is whatever a mostly-pre-touch buffer happened to hold.
  const flowing = await readScopePeakOverWindow(page, 'scp', AUDIBLE_CAP_MS, {
    untilPeak: AUDIBLE_FLOOR,
  });
  expect(flowing.polls, 'the SCOPE was sampled across the audible window').toBeGreaterThan(0);
  expect(
    flowing.peak,
    `a touch on x1 must open the VCA with the face mounted — ${describeScopeWindow(flowing)}`,
  ).toBeGreaterThan(AUDIBLE_FLOOR);

  // (4) …and the MIRRORS agree with the audio. Both surfaces read ONE engine
  //     snapshot, so they cannot disagree with each other — but they CAN
  //     disagree with the jack, which is what this checks: the same gesture that
  //     opened the VCA is the one the picture is drawn from.
  const state = await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
      __patch: { nodes: Record<string, unknown> };
    };
    const eng = w.__engine?.();
    const node = w.__patch.nodes[id];
    if (!eng || !node) return null;
    return eng.read(node, 'state') as {
      axisMessages: number;
      channels: { x: number; gate: boolean }[];
    };
  }, NODE);
  expect(state?.axisMessages, 'the assembler decoded the touch').toBeGreaterThan(0);
  expect(state?.channels[0]?.x).toBeCloseTo(0.9, 2);
  expect(state?.channels[0]?.gate).toBe(true);

  errorWatch.assertClean();
});
