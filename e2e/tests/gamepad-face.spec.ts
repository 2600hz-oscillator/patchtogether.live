// e2e/tests/gamepad-face.spec.ts
//
// GAMEPAD, against the FACEPLATE — the DEFAULT renderer.
//
// ── ⚠ WHY THIS FILE EXISTS, AND WHY `gamepad.spec.ts` IS NOT ENOUGH ─────────
//
// All eighteen tests in `gamepad.spec.ts` ride the `rack` fixture, which is
// `/rack?shell=legacy&seed=none` by construction. That was CORRECT while this
// module rendered its legacy card in the lane, and it stays correct as coverage
// OF THAT CARD — the card still ships and `?shell=legacy` still renders it.
//
// It stops being sufficient the moment the module is PROMOTED, and the failure
// mode is the one that ships silently: those eighteen tests keep passing against
// a surface that is no longer what a player operates, while the FACE's remap,
// calibrate, invert and mapping paths have ZERO coverage. Green, and blind. The
// fixture says so in its own words — *"what a green run on `rack` structurally
// cannot see: everything the default renderer paints"*.
//
// So this file is the other half, and it is deliberately SMALL: three tests, one
// per seam that promotion moved. It does not re-prove the module's arithmetic
// (the deadzone, the ±1 remap, the calibration math and the in-place Y.Doc
// discipline are all unit-pinned in `gamepad.test.ts`,
// `gamepad-remap-ydoc.test.ts` and `gamepad-face-model.test.ts`); it proves that
// the BODY IS WIRED TO THEM.
//
// ── WHAT IT ASSERTS ON ──────────────────────────────────────────────────────
//
// The GRAPH, never pixels. Every gesture here has a durable observable in
// `node.params` or `node.data`, which is renderer-independent and is the same
// thing a collaborator and the undo stack see. The pixels are the dock VRT
// scenes' job.
//
// ⚠ The fake pad is the SAME monkey-patch `gamepad.spec.ts` uses. Playwright
// cannot dispatch real HID events, and the Gamepad API's gate is a physical
// button press on hardware no runner has — which is exactly why the resting
// (disconnected) surface is VRT-baselineable and the connected one is not.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { waitFrames } from '../_helpers/frames';

const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;
const NODE = 'gp';
const BUTTON_COUNT = 17;

async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack?seed=none');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({
    timeout: SLOW_RENDER ? 30_000 : 15_000,
  });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** Inject a fake pad into `navigator.getGamepads()`. Call BEFORE spawning —
 *  the FACTORY's rAF poll picks it up on its next tick, and the factory is what
 *  publishes the snapshot the body reads. */
async function installFakeGamepad(
  page: Page,
  state: { axes?: [number, number, number, number]; buttons?: number[] } = {},
): Promise<void> {
  await page.evaluate((s) => {
    const axes = s.axes ?? [0, 0, 0, 0];
    const values = s.buttons ?? (Array.from({ length: 17 }).fill(0) as number[]);
    const fakePad = {
      id: 'Xbox Wireless Controller (STD STUB)',
      index: 0,
      connected: true,
      timestamp: performance.now(),
      mapping: 'standard',
      axes,
      buttons: values.map((v) => ({ pressed: v > 0.5, touched: v > 0, value: v })),
    };
    const w = globalThis as unknown as { __fakePad: typeof fakePad };
    w.__fakePad = fakePad;
    (navigator as unknown as { getGamepads: () => unknown[] }).getGamepads = () => [
      w.__fakePad,
      null,
      null,
      null,
    ];
  }, state);
}

async function updateFakeGamepad(
  page: Page,
  state: { axes?: [number, number, number, number]; buttons?: number[] },
): Promise<void> {
  await page.evaluate((s) => {
    const w = globalThis as unknown as {
      __fakePad?: {
        axes: number[];
        buttons: { pressed: boolean; touched: boolean; value: number }[];
        timestamp: number;
      };
    };
    if (!w.__fakePad) return;
    if (s.axes) w.__fakePad.axes = s.axes;
    if (s.buttons) {
      w.__fakePad.buttons = s.buttons.map((v) => ({
        pressed: v > 0.5,
        touched: v > 0,
        value: v,
      }));
    }
    w.__fakePad.timestamp = performance.now();
  }, state);
}

/** The LANE tile's shell for a node. */
function laneShell(page: Page, nodeId: string): Locator {
  return page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`);
}

/**
 * Open a node's dock faceplate, SCOPED BY NODE — opening a second node's
 * faceplate swaps the dock's occupant, so a locator that only said "the dock"
 * would keep resolving after a swap and assert the wrong node's surface.
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

/** `node.data`, read in the page. The durable observable for every gesture on
 *  the mapping board — and the one a collaborator and Cmd-Z also see. */
async function readData(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> } | undefined> };
    };
    const d = w.__patch?.nodes?.[id]?.data;
    return d ? JSON.parse(JSON.stringify(d)) : null;
  }, NODE);
}

async function readPadIndex(page: Page): Promise<number | null> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params?: Record<string, number> } | undefined> };
    };
    return w.__patch?.nodes?.[id]?.params?.padIndex ?? null;
  }, NODE);
}

/** The PAD lamp reports connected. READINESS, not a duration: the lamp's
 *  `data-lit` flips the first time the body's poll sees the injected pad, which
 *  is the exact event a sleep would have been standing in for. */
function padLampLit(dock: Locator): Locator {
  return dock.locator(`[data-testid="gamepad-led-pad-${NODE}"][data-lit="1"]`);
}

test.describe('GAMEPAD faceplate', () => {
  test('the LANE TILE carries the SLOT picker, and it WRITES — the tier promotion adds', async ({
    page,
  }) => {
    // ⚠ THE REGRESSION PIN FOR WHAT THIS PROMOTION IS FOR. `gamepad` was not in
    // `NON_SHELL_LANE_TYPES`, so its lane render was `'placeholder'`: a uniform
    // rackline tile with NO ranked controls at all, whose `⤢` was the only way
    // to reach anything. The SLOT picker is a segmented cell now, and a
    // segmented cell is not dock-restricted (only `panel` is), so it is on the
    // tile. That is a behaviour change a player can feel.
    await gotoShell(page);
    await spawnPatch(page, [{ id: NODE, type: 'gamepad', position: { x: 200, y: 200 } }]);

    const lane = laneShell(page, NODE);
    await expect(lane).toBeVisible();
    await expect(
      lane.locator('[data-cell-key="padIndex"]'),
      'the SLOT picker is reachable without opening the dock',
    ).toBeVisible();

    // ⚠ UNSET AT SPAWN, not zero-valued: a fresh node carries no `padIndex` key
    // at all and the factory falls back to the def's default. Reading `?? 0` is
    // therefore the honest baseline — and it is also what makes the assertion
    // after the click load-bearing, since a WRITE is what materialises the key.
    expect(
      (await readPadIndex(page)) ?? 0,
      'slot 0 at spawn (the key is unset until something writes it)',
    ).toBe(0);

    // ⚠ THE LANE CELL IS A KNOB AND THAT IS CORRECT, NOT A BUG. `paramCellKind`
    // returns `'knob'` for a roster param at every tier except the dock, because
    // a 46 px lane column cannot hold a four-button roster. So the DRIVE half of
    // this test happens on the dock cell, where the roster resolves `segmented`
    // — and that is exactly what the roster exists for: without it the dock cell
    // would ALSO be a four-position dial, on which a drag quantises straight
    // back to where it started (the `moog962` inertness class, invisible to
    // every def-reading gate). Clicking an option is only possible because the
    // roster is there.
    const dock = await openDock(page, NODE);
    const cell = dock.locator('[data-cell-key="padIndex"]');
    await expect(cell).toBeVisible();
    // `Segmented` renders its options as `role="radio"`, not plain buttons —
    // driven by the ROLE rather than a class so the assertion survives a
    // restyle of the primitive.
    await cell.getByRole('radio', { name: '2', exact: true }).click();
    await expect
      .poll(() => readPadIndex(page), {
        timeout: 5_000,
        message: 'picking a slot on the segmented SLOT cell never reached node.params.padIndex',
      })
      .toBe(2);
  });

  test('the DOCK BODY arms a REMAP and commits the binding to node.data', async ({ page }) => {
    // The gesture promotion moved: right-clicking a button LED arms a listener,
    // and the next physical control past the threshold binds that output. The
    // Gamepad API has no events, so the armed listener DIFFS consecutive polls
    // — which is why the baseline has to be observed at rest first.
    await gotoShell(page);
    await installFakeGamepad(page, { buttons: Array(BUTTON_COUNT).fill(0) });
    await spawnPatch(page, [{ id: NODE, type: 'gamepad', position: { x: 200, y: 200 } }]);
    const dock = await openDock(page, NODE);
    await expect(padLampLit(dock), 'the body poll never saw the injected pad').toBeVisible();

    const led = dock.getByTestId(`gamepad-remap-a-${NODE}`);
    await expect(led).toBeVisible();

    // NEGATIVE CONTROL, and it cannot be polled: "still unbound" is true at
    // t = 0 whether or not the poll ever looked. What it needs is proof the
    // reader RAN and chose not to bind, which is a count of FRAMES.
    const pressX = Array(BUTTON_COUNT).fill(0);
    pressX[2] = 1;
    await updateFakeGamepad(page, { buttons: pressX });
    await waitFrames(page, 4);
    expect(
      (await readData(page))?.bindings ?? null,
      'a button press with NOTHING armed committed a binding',
    ).toBeNull();

    // Back to rest, observed, then arm.
    await updateFakeGamepad(page, { buttons: Array(BUTTON_COUNT).fill(0) });
    await waitFrames(page, 4);
    await led.click({ button: 'right' });

    // Press physical X (button 2) → the detector binds the `a` OUTPUT to it.
    await updateFakeGamepad(page, { buttons: pressX });
    await expect
      .poll(() => (readData(page) as Promise<{ bindings?: Record<string, unknown> } | null>).then((d) => d?.bindings?.a ?? null), {
        timeout: 8_000,
        message:
          'arming a remap on the FACE and moving a physical control never committed a binding '
          + '— the body is not wired to detectChangedControl / applyBindingToData',
      })
      .toEqual({ kind: 'button', index: 2 });

    // ⚠ AND THE CLEAR GESTURE, because a bind with no un-bind is half a control.
    // Alt-click is the LED's reset, exactly as on the card.
    await led.click({ modifiers: ['Alt'] });
    await expect
      .poll(() => (readData(page) as Promise<{ bindings?: Record<string, unknown> } | null>).then((d) => d?.bindings?.a ?? null), {
        timeout: 5_000,
        message: 'alt-clicking a bound LED on the FACE never cleared the override',
      })
      .toBeNull();
  });

  test('the DOCK BODY inverts an axis and completes a CALIBRATION, both persisted', async ({
    page,
  }) => {
    test.setTimeout(SLOW_RENDER ? 120_000 : 60_000);
    await gotoShell(page);
    await installFakeGamepad(page, { axes: [0, 0, 0, 0] });
    await spawnPatch(page, [{ id: NODE, type: 'gamepad', position: { x: 200, y: 200 } }]);
    const dock = await openDock(page, NODE);
    await expect(padLampLit(dock)).toBeVisible();

    // ── INVERT — one in-place node.data write, and it round-trips ──────────
    const invert = dock.getByTestId(`gamepad-invert-lx-${NODE}`);
    await expect(invert).toHaveAttribute('aria-pressed', 'false');
    await invert.click();
    await expect(invert).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(() => (readData(page) as Promise<{ invert?: Record<string, unknown> } | null>).then((d) => d?.invert?.lx ?? null), {
        timeout: 5_000,
        message: 'the FACE\'s invert toggle never reached node.data.invert',
      })
      .toBe(true);

    // ── CALIBRATE — the sweep, gated by the module's own usability rule ────
    const start = dock.getByTestId(`gamepad-calibrate-left-${NODE}`);
    await start.click();
    const complete = dock.getByTestId(`gamepad-calibrate-complete-${NODE}`);
    // ⚠ "AM I THERE YET" IS ANSWERED BY A CONTROL'S ENABLED STATE, not by a
    // printed number — which is half the reason the card's four live decimals
    // could be deleted rather than merely moved. `sweepIsUsable` requires a
    // ≥ 0.2 span on BOTH axes and a real sample count.
    await expect(complete, 'COMPLETE starts disabled — no usable sweep yet').toBeDisabled();

    // Sweep. Each point only counts if a FRAME runs while it is set (the fold
    // happens on the body's rAF), so the wait is a frame count by definition.
    const pts: [number, number][] = [
      [0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6], [0.6, 0.6], [-0.6, -0.6], [0, 0],
    ];
    for (let rep = 0; rep < 2; rep++) {
      for (const [x, y] of pts) {
        await updateFakeGamepad(page, { axes: [x, y, 0, 0] });
        await waitFrames(page, 2);
      }
    }
    await expect(complete, 'a usable sweep never enabled COMPLETE').toBeEnabled({
      timeout: 10_000,
    });

    await complete.click();
    await expect
      .poll(
        () =>
          (readData(page) as Promise<{ leftStickCalibration?: unknown } | null>).then(
            (d) => d?.leftStickCalibration ?? null,
          ),
        {
          timeout: 5_000,
          message: 'completing a calibration on the FACE never wrote node.data',
        },
      )
      .not.toBeNull();

    // The CAL L lamp is the surface that replaced the `calibrated` badge — a
    // picture, with the sentence on `aria-label`. Asserting it here is what
    // makes "the badge was deleted, not the finding" checkable end to end.
    await expect(
      dock.locator(`[data-testid="gamepad-led-cal-left-${NODE}"][data-lit="1"]`),
      'the CAL L lamp did not light after a completed calibration',
    ).toBeVisible();
  });
});
