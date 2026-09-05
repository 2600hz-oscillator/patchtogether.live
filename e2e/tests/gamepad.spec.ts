// e2e/tests/gamepad.spec.ts
//
// GAMEPAD module E2E. The browser Gamepad API isn't synthesisable
// from outside the page (Playwright can't dispatch real HID events),
// but we CAN monkey-patch navigator.getGamepads() to return a fake
// gamepad with stub axis/button values. This proves the full
// pipeline:
//
//   navigator.getGamepads() → gamepad factory polls + writes
//   ConstantSourceNodes → engine.read('snapshot') reflects them →
//   card poll → card LED + dot positions
//
// and lets us assert "patching gamepad.lx to wavesculpt.pos_x with a
// stub stick position pushes the wavesculpt's combined pos_x value".

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { waitFrames } from '../_helpers/frames';

/**
 * READINESS, not a duration (#1523).
 *
 * Everything in this file used to start with `waitForTimeout(150…200)` — a
 * guess at how long the card's rAF poll takes to notice the injected pad. The
 * card already tells us: `class:on={snapshot.connected}` lands on the status
 * line the first time that poll sees a gamepad, and the line switches from
 * "press any button to connect" to the pad's id. Waiting on the class is
 * waiting on the exact event the sleep was standing in for, so it is correct on
 * a fast machine and on a starved CI shard alike.
 */
/** Open the GAMEPAD dock pane (the mapping board — sticks, remap surface,
 *  calibration, save/load — is `fullViewBody`, dock-only; testids are
 *  node-suffixed) and return the BOARD locator. Idempotent. */
async function openGpBoard(page: Page) {
  await page.waitForFunction(
    () =>
      typeof (globalThis as unknown as { __openDockFullView?: unknown }).__openDockFullView ===
      'function',
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(
    (i) => (globalThis as unknown as { __openDockFullView: (x: string) => void }).__openDockFullView(i),
    'gp',
  );
  const board = page
    .locator('[data-testid="dock-fullview-pane"][data-pane-node="gp"]')
    .getByTestId('gamepad-body-gp');
  await expect(board).toBeVisible({ timeout: 60_000 });
  return board;
}

/** READINESS, not a duration (#1523): the PAD lamp lights the first time the
 *  board's rAF poll sees the injected fake (`data-lit` — the card's `.status
 *  .on` line became the StatusLed). Returns the board. */
const cardConnected = async (page: Page) => {
  const board = await openGpBoard(page);
  await expect(
    board.getByTestId('gamepad-led-pad-gp'),
    'the GAMEPAD PAD lamp never reported a connected pad — the rAF poll did not see the injected fake',
  ).toHaveAttribute('data-lit', '1');
  return board;
};

/** Inject a fake gamepad into navigator.getGamepads(). Call BEFORE
 *  spawning the GAMEPAD module — the factory's rAF poll picks it up
 *  on its next tick. The stub keeps the same `id` + mapping shape
 *  the real Xbox controller reports so the module code follows the
 *  exact same code path. */
async function installFakeGamepad(
  page: Page,
  state: {
    axes?: [number, number, number, number];
    buttons?: number[];  // 0..1 per button; .pressed = value > 0.5
  } = {},
): Promise<void> {
  await page.evaluate((s) => {
    const axes = s.axes ?? [0, 0, 0, 0];
    const buttonValues = s.buttons ?? Array.from({ length: 17 }).fill(0) as number[];
    const buttons = buttonValues.map((v) => ({
      pressed: v > 0.5,
      touched: v > 0,
      value: v,
    }));
    const fakePad = {
      id: 'Xbox Wireless Controller (STD STUB)',
      index: 0,
      connected: true,
      timestamp: performance.now(),
      mapping: 'standard',
      axes,
      buttons,
    };
    // Override on a per-test basis. Wrap so we can update axes/buttons
    // without re-injecting.
    const w = globalThis as unknown as { __fakePad: typeof fakePad };
    w.__fakePad = fakePad;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (navigator as any).getGamepads = () => [w.__fakePad, null, null, null];
  }, state);
}

/** Update the fake gamepad's axes/buttons mid-test. */
async function updateFakeGamepad(
  page: Page,
  state: { axes?: [number, number, number, number]; buttons?: number[] },
): Promise<void> {
  await page.evaluate((s) => {
    const w = globalThis as unknown as { __fakePad: { axes: number[]; buttons: Array<{ pressed: boolean; touched: boolean; value: number }>; timestamp: number } };
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

test.describe('GAMEPAD module', () => {
  test('spawns with no console errors + card shows the "press a button" prompt', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [{ id: 'gp', type: 'gamepad', position: { x: 200, y: 200 } }]);
    const board = await openGpBoard(page);
    // No pad: the PAD lamp is dark and the empty state carries the prompt.
    await expect(board.getByTestId('gamepad-led-pad-gp')).toHaveAttribute('data-lit', '0');
    await expect(board).toContainText(/press any button/i);
    expect(errors.filter((e) => !e.includes('DEP0040')), errors.join('; ')).toEqual([]);
  });

  test('connected state + live values flow into engine.read snapshot', async ({ page, rack }) => {
    await installFakeGamepad(page, { axes: [0.6, -0.4, 0, 0] });
    await spawnPatch(page, [{ id: 'gp', type: 'gamepad', position: { x: 200, y: 200 } }]);
    await cardConnected(page);

    const snap = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      const gp = w.__patch.nodes.gp;
      if (!eng || !gp) return null;
      return eng.read(gp, 'snapshot');
    });
    expect(snap).not.toBeNull();
    const s = snap as { connected: boolean; id: string; values: Record<string, number> };
    expect(s.connected).toBe(true);
    expect(s.id).toContain('Xbox');
    // axes[0] = 0.6 → lx after deadzone is just under 0.6
    expect(s.values.lx).toBeGreaterThan(0.5);
    // axes[1] = -0.4 → engine ly is +0.4 (Y inverted so +1 = stick up)
    expect(s.values.ly).toBeGreaterThan(0.3);
  });

  test('LFO-style sweep: updating fake axes moves the engine.readParam(lx) over time', async ({ page, rack }) => {
    await installFakeGamepad(page, { axes: [0, 0, 0, 0] });
    await spawnPatch(page, [{ id: 'gp', type: 'gamepad', position: { x: 200, y: 200 } }]);
    await cardConnected(page);

    const samples: number[] = [];
    for (let i = 0; i < 8; i++) {
      const ax = Math.sin(i * 0.5);   // moves between -1 .. +1
      await updateFakeGamepad(page, { axes: [ax, 0, 0, 0] });
      // The factory reads navigator.getGamepads() on rAF and writes the
      // ConstantSourceNode from there, so "the new axis has been published" is a
      // FRAME count and nothing else: one frame to observe, one to publish. The
      // old `waitForTimeout(60)` bought ~4 frames locally and ~0.5 on a
      // SwiftShader shard — the same line asserting two different things.
      await waitFrames(page, 2);
      const v = await page.evaluate(() => {
        const w = globalThis as unknown as {
          __engine?: () => { readParam: (n: unknown, k: string) => unknown } | null;
          __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
        };
        const eng = w.__engine?.();
        const gp = w.__patch.nodes.gp;
        if (!eng || !gp) return 0;
        const rp = eng.readParam(gp, 'lx') as number | undefined;
        return rp ?? 0;
      });
      samples.push(v);
    }
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const variance = samples.reduce((s, v) => s + (v - mean) ** 2, 0) / samples.length;
    const stddev = Math.sqrt(variance);
    expect(stddev, `lx samples should move: ${samples.map((s) => s.toFixed(3)).join(', ')}`).toBeGreaterThan(0.1);
  });

  test('patch GAMEPAD.lx → WAVESCULPT.pos_x; fake stick drives wavesculpt camera', async ({ page, rack }) => {
    await installFakeGamepad(page, { axes: [0, 0, 0, 0] });
    await spawnPatch(
      page,
      [
        { id: 'gp', type: 'gamepad',    position: { x: 100, y: 200 } },
        { id: 'ws', type: 'wavesculpt', position: { x: 600, y: 100 }, domain: 'audio' },
      ],
      [
        {
          id: 'e_gp_ws',
          from: { nodeId: 'gp', portId: 'lx' },
          to:   { nodeId: 'ws', portId: 'pos_x' },
          sourceType: 'cv',
          targetType: 'cv',
        },
      ],
    );
    await cardConnected(page);

    const posX = () => page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => { readParam: (n: unknown, k: string) => unknown } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      const ws = w.__patch.nodes.ws;
      if (!eng || !ws) return -99;
      return (eng.readParam(ws, 'pos_x') as number | undefined) ?? -99;
    });

    // With axes=[0,...], pos_x should be ~0 (knob default + zero CV). Polling
    // the value IS the wait: sleeping first and reading once only differs from
    // this in what it does when the read is early — it fails instead of
    // retrying.
    await expect
      .poll(async () => Math.abs(await posX()), { timeout: 5_000 })
      .toBeLessThan(0.1);

    // Push the fake stick fully right → wavesculpt.pos_x follows it past 0.5.
    await updateFakeGamepad(page, { axes: [1, 0, 0, 0] });
    await expect.poll(posX, { timeout: 5_000 }).toBeGreaterThan(0.5);
  });

  test('GAMEPAD stick reaches BOTH extremes of WAVESCULPT.pos_x', async ({ page, rack }) => {
    // Regression: the gamepad-driven camera joystick couldn't reach the
    // stick's extremes and the dot updated horribly slowly (the live-poll
    // was on a setInterval that got starved behind the card's WebGL render;
    // it now rides rAF). Assert (1) the full ±range is reachable via
    // engine.readParam AND (2) the rendered dot tracks to each extreme.
    await installFakeGamepad(page, { axes: [0, 0, 0, 0] });
    await spawnPatch(
      page,
      [
        { id: 'gp', type: 'gamepad',    position: { x: 100, y: 200 } },
        { id: 'ws', type: 'wavesculpt', position: { x: 600, y: 100 }, domain: 'audio' },
      ],
      [
        {
          id: 'e_gp_ws',
          from: { nodeId: 'gp', portId: 'lx' },
          to:   { nodeId: 'ws', portId: 'pos_x' },
          sourceType: 'cv',
          targetType: 'cv',
        },
      ],
    );
    await cardConnected(page);

    const readPosX = () => page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => { readParam: (n: unknown, k: string) => unknown } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      const ws = w.__patch.nodes.ws;
      if (!eng || !ws) return -99;
      return (eng.readParam(ws, 'pos_x') as number | undefined) ?? -99;
    });
    // (The card-dot leg died with the card, and NOT as lost coverage: the
    // face's camera pad deliberately shows the PARAM while CV moves the
    // PICTURE — WavesculptOutputBody: "do not 'fix' the pad to follow CV",
    // a known owner-listed defect the face does not build on. The full-range
    // engine read below is the whole surviving claim.)

    // Full RIGHT → pos_x near +1.
    await updateFakeGamepad(page, { axes: [1, 0, 0, 0] });
    await expect.poll(readPosX, { timeout: 2000 }).toBeGreaterThan(0.9);

    // Full LEFT → pos_x near -1.
    await updateFakeGamepad(page, { axes: [-1, 0, 0, 0] });
    await expect.poll(readPosX, { timeout: 2000 }).toBeLessThan(-0.9);
  });

  test('calibrate left stick: sweep (simulated) → complete → locked range remaps to full ±1', async ({ page, rack }) => {
    // The first deliverable: enter calibration MODE, sweep the fake stick
    // through a REDUCED range (a flight stick / worn pad that only reaches
    // ±0.6), complete, and assert that AFTER calibration the same ±0.6 raw
    // deflection now maps to (near) ±1 on lx — i.e. observed-max → full-max.
    await installFakeGamepad(page, { axes: [0, 0, 0, 0] });
    await spawnPatch(page, [{ id: 'gp', type: 'gamepad', position: { x: 200, y: 200 } }]);

    const card = await openGpBoard(page);
    const readLx = () => page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => { readParam: (n: unknown, k: string) => unknown } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      const gp = w.__patch.nodes.gp;
      if (!eng || !gp) return -99;
      return (eng.readParam(gp, 'lx') as number | undefined) ?? -99;
    });

    // Baseline (un-calibrated): raw 0.6 → lx ≈ 0.56 (fixed-deadzone path), i.e.
    // the stick can't reach +1 at its reduced extreme.
    await updateFakeGamepad(page, { axes: [0.6, 0, 0, 0] });
    await expect.poll(readLx, { timeout: 2000 }).toBeGreaterThan(0.4);
    await expect.poll(readLx, { timeout: 2000 }).toBeLessThan(0.7);

    // Enter calibration mode.
    await card.getByTestId('gamepad-calibrate-left-gp').click();
    // In-mode: the calib row swaps to COMPLETE / CANCEL.
    await expect(card.getByTestId('gamepad-calibrate-complete-gp')).toBeVisible();
    // "complete" starts disabled (no usable sweep yet).
    await expect(card.getByTestId('gamepad-calibrate-complete-gp')).toBeDisabled();

    // Sweep the reduced range several times: hit each extreme on both axes.
    const sweepPts: [number, number][] = [
      [0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6],
      [0.6, 0.6], [-0.6, -0.6], [0, 0],
    ];
    for (let rep = 0; rep < 2; rep++) {
      for (const [x, y] of sweepPts) {
        await updateFakeGamepad(page, { axes: [x, y, 0, 0] });
        // Calibration accumulates observed min/max ON THE rAF POLL, so a sweep
        // point only counts if a frame runs while it is set. That is a frame
        // count by definition; `waitForTimeout(40)` was a third of a frame on a
        // SwiftShader shard, which silently drops sweep points and leaves
        // "complete" disabled.
        await waitFrames(page, 2);
      }
    }
    // Now the sweep is usable → "complete" enables.
    await expect.poll(
      () => card.getByTestId('gamepad-calibrate-complete-gp').isEnabled(),
      { timeout: 2000 },
    ).toBe(true);

    // Complete → mode exits, calibrated badge appears, range persisted to data.
    await card.getByTestId('gamepad-calibrate-complete-gp').click();
    await expect(card.getByTestId('gamepad-calibrate-complete-gp')).toHaveCount(0);
    await expect(card.getByTestId('gamepad-led-cal-left-gp')).toHaveAttribute('data-lit', '1');

    // The calibration was written ONCE to node.data (single committed value).
    const cal = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: { leftStickCalibration?: unknown } }> };
      };
      return w.__patch.nodes.gp?.data?.leftStickCalibration ?? null;
    });
    expect(cal).not.toBeNull();

    // AFTER calibration: the SAME raw 0.6 deflection now reaches (near) +1.
    await updateFakeGamepad(page, { axes: [0.6, 0, 0, 0] });
    await expect.poll(readLx, { timeout: 2000 }).toBeGreaterThan(0.9);
    // And full-left raw -0.6 reaches (near) -1.
    await updateFakeGamepad(page, { axes: [-0.6, 0, 0, 0] });
    await expect.poll(readLx, { timeout: 2000 }).toBeLessThan(-0.9);
    // Centre still reads ~0 (no snap-back drift).
    await updateFakeGamepad(page, { axes: [0, 0, 0, 0] });
    await expect.poll(readLx, { timeout: 2000 }).toBeCloseTo(0, 1);
  });

  test('clear calibration reverts the left stick to the fixed-deadzone path', async ({ page, rack }) => {
    await installFakeGamepad(page, { axes: [0, 0, 0, 0] });
    await spawnPatch(page, [{ id: 'gp', type: 'gamepad', position: { x: 200, y: 200 } }]);
    const card = await openGpBoard(page);

    // Seed a calibration directly via node.data (the committed shape), then
    // assert the clear affordance removes it.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      };
      const gp = w.__patch.nodes.gp;
      if (!gp.data) gp.data = {};
      gp.data.leftStickCalibration = { minX: -0.6, maxX: 0.6, minY: -0.6, maxY: 0.6, deadzone: 0.1 };
    });
    await expect(card.getByTestId('gamepad-led-cal-left-gp')).toHaveAttribute('data-lit', '1');
    await card.getByTestId('gamepad-calibrate-clear-left-gp').click();
    await expect(card.getByTestId('gamepad-led-cal-left-gp')).toHaveAttribute('data-lit', '0');
    const cleared = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: { leftStickCalibration?: unknown } }> };
      };
      return w.__patch.nodes.gp?.data?.leftStickCalibration ?? null;
    });
    expect(cleared).toBeNull();
  });

  // ─────────────────────── CONTROL REMAP ───────────────────────
  // Right-click a button LED / trigger label → arm a button-remap; the next
  // physical press binds that output. "Remap X/Y" buttons under a stick arm an
  // axis-remap; the next axis the user moves binds it. Bindings persist on
  // node.data.bindings (synced) and the read loop follows them the next frame.

  const readBindings = (page: Page) => page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { bindings?: Record<string, { kind: string; index: number }> } }> };
    };
    return w.__patch.nodes.gp?.data?.bindings ?? null;
  });
  const readGp = (page: Page, port: string) => page.evaluate((p) => {
    const w = globalThis as unknown as {
      __engine?: () => { readParam: (n: unknown, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    const gp = w.__patch.nodes.gp;
    if (!eng || !gp) return -99;
    return (eng.readParam(gp, p) as number | undefined) ?? -99;
  }, port);

  test('right-click a button LED → arm → press a DIFFERENT physical button binds the output, and the output now follows it', async ({ page, rack }) => {
    // All buttons released at rest (17 zeros) so the armed baseline is clean.
    await installFakeGamepad(page, { buttons: Array(17).fill(0) });
    await spawnPatch(page, [{ id: 'gp', type: 'gamepad', position: { x: 200, y: 200 } }]);
    await cardConnected(page);
    const card = await openGpBoard(page);

    // Baseline: the `a` output follows physical A (button 0). Pressing X
    // (button 2) does NOT light `a` yet.
    const pressX = [...Array(17).fill(0)]; pressX[2] = 1;
    await updateFakeGamepad(page, { buttons: pressX });
    // A NEGATIVE assertion cannot be polled — "still 0" is true at t=0 whether
    // or not the poll ever looked. What it needs is proof that the reader RAN
    // and chose not to change the value, which is a count of frames.
    await waitFrames(page, 3);
    expect(await readGp(page, 'a')).toBe(0);
    // Release before arming so the baseline diff starts from rest — the rest
    // position only lands once the rAF poll has observed it.
    await updateFakeGamepad(page, { buttons: Array(17).fill(0) });
    await waitFrames(page, 3);

    // Arm the `a` output's remap (right-click its LED) → banner appears.
    await card.getByTestId('gamepad-remap-a-gp').click({ button: 'right' });
    // The card's banner became the ARMED state on the control itself.
    await expect(card.getByTestId('gamepad-remap-a-gp')).toHaveClass(/armed/);
    // The armed listener seeds its baseline on the NEXT poll tick — give it
    // frames before the stimulus (the gamepad-face recipe; a press that lands
    // before the seed is captured INTO the baseline and never diffs).
    await waitFrames(page, 3);

    // Press physical X (button 2) → detector binds `a` → physical X.
    await updateFakeGamepad(page, { buttons: pressX });
    // Wait for the binding to be committed to node.data.
    await expect.poll(() => readBindings(page), { timeout: 3000 }).not.toBeNull();
    const bindings = await readBindings(page);
    expect(bindings?.a).toEqual({ kind: 'button', index: 2 });
    // The armed state clears once bound.
    await expect(card.getByTestId('gamepad-remap-a-gp')).not.toHaveClass(/armed/);

    // The `a` output now FOLLOWS physical X: holding X reads 1…
    await expect.poll(() => readGp(page, 'a'), { timeout: 2000 }).toBe(1);
    // …and pressing physical A (button 0) alone does NOT light `a` anymore.
    const pressA = [...Array(17).fill(0)]; pressA[0] = 1;
    await updateFakeGamepad(page, { buttons: pressA });
    await expect.poll(() => readGp(page, 'a'), { timeout: 2000 }).toBe(0);
  });

  test('"Remap X" under the left stick → move an axis → axis binding persists + output follows', async ({ page, rack }) => {
    await installFakeGamepad(page, { axes: [0, 0, 0, 0] });
    await spawnPatch(page, [{ id: 'gp', type: 'gamepad', position: { x: 200, y: 200 } }]);
    await cardConnected(page);
    const card = await openGpBoard(page);

    // Arm the left-stick X remap (the user-preferred separate "Remap X" button).
    await card.getByTestId('gamepad-remap-lx-gp').click();
    await expect(card.getByTestId('gamepad-remap-lx-gp')).toHaveClass(/armed/);
    await waitFrames(page, 3); // baseline seeds on the next poll tick

    // Move the RIGHT-stick X axis (index 2) fully → detector binds lx → axis 2.
    await updateFakeGamepad(page, { axes: [0, 0, 0.95, 0] });
    await expect.poll(() => readBindings(page), { timeout: 3000 }).not.toBeNull();
    const bindings = await readBindings(page);
    expect(bindings?.lx).toEqual({ kind: 'axis', index: 2 });
    await expect(card.getByTestId('gamepad-remap-lx-gp')).not.toHaveClass(/armed/);

    // The lx OUTPUT now follows axis 2: moving axis 2 drives lx, while the
    // original axis 0 no longer does.
    await updateFakeGamepad(page, { axes: [0, 0, 1, 0] });
    await expect.poll(() => readGp(page, 'lx'), { timeout: 2000 }).toBeGreaterThan(0.8);
    await updateFakeGamepad(page, { axes: [1, 0, 0, 0] }); // old axis 0 hard-right
    await expect.poll(() => readGp(page, 'lx'), { timeout: 2000 }).toBeLessThan(0.2);
  });

  test('Esc cancels an armed remap with no binding written', async ({ page, rack }) => {
    await installFakeGamepad(page, { buttons: Array(17).fill(0) });
    await spawnPatch(page, [{ id: 'gp', type: 'gamepad', position: { x: 200, y: 200 } }]);
    await cardConnected(page);
    const card = await openGpBoard(page);

    await card.getByTestId('gamepad-remap-b-gp').click({ button: 'right' });
    await expect(card.getByTestId('gamepad-remap-b-gp')).toHaveClass(/armed/);
    // Cancel via Esc. ⚠ The body claims the key CAPTURE-phase while a remap is
    // armed (the menu-Esc pattern), so the dock full view must survive the
    // press — an Esc that also unmounted this board would "cancel" any remap
    // by killing the listener, which is what made this assert pass vacuously
    // before the fix.
    await page.keyboard.press('Escape');
    await expect(card.getByTestId('gamepad-remap-b-gp')).not.toHaveClass(/armed/);
    await expect(card, 'the dock pane survived the armed-remap Esc').toBeVisible();
    // Now press a button — it must NOT bind anything (listener disarmed).
    const pressX = [...Array(17).fill(0)]; pressX[2] = 1;
    await updateFakeGamepad(page, { buttons: pressX });
    // Negative assertion: give the detector real frames to run in and decline,
    // rather than a duration that may be less than one frame on CI.
    await waitFrames(page, 4);
    expect(await readBindings(page)).toBeNull();
  });

  test('remap the RIGHT stick after another remap → module KEEPS emitting (regression)', async ({ page, rack }) => {
    // The shipped bug: the 2nd remap commit threw "reassigning object that
    // already occurs in the tree" out of the card's rAF poll, killing the poll
    // loop so the module went DEAD. Reproduce the user's flow: remap one output,
    // then remap the right-stick X, and assert the module STILL produces output.
    await installFakeGamepad(page, { axes: [0, 0, 0, 0], buttons: Array(17).fill(0) });
    await spawnPatch(page, [{ id: 'gp', type: 'gamepad', position: { x: 200, y: 200 } }]);
    await cardConnected(page);
    const card = await openGpBoard(page);

    // FIRST remap: arm the left-stick X (left-click, the axis path → no context
    // menu) and move axis 1 → binds lx→axis1.
    await card.getByTestId('gamepad-remap-lx-gp').click();
    await expect(card.getByTestId('gamepad-remap-lx-gp')).toHaveClass(/armed/);
    await waitFrames(page, 3); // baseline seeds on the next poll tick
    await updateFakeGamepad(page, { axes: [0, 0.95, 0, 0] }); // only axis 1 moves
    await expect.poll(async () => (await readBindings(page))?.lx ?? null, { timeout: 3000 }).not.toBeNull();
    expect((await readBindings(page))?.lx).toEqual({ kind: 'axis', index: 1 });
    // Settle ALL axes to rest so the NEXT armed baseline diff only sees axis 0.
    // "At rest" is a state the rAF poll has to OBSERVE before the next arm, so
    // this is frames, not milliseconds.
    await updateFakeGamepad(page, { axes: [0, 0, 0, 0] });
    await waitFrames(page, 3);

    // SECOND remap (the one that broke): arm the right-stick X, move axis 0 →
    // binds rx→axis0. The shipped code threw out of the rAF poll HERE (the
    // bindings map already existed), killing the module. It must NOT throw.
    await card.getByTestId('gamepad-remap-rx-gp').click();
    await expect(card.getByTestId('gamepad-remap-rx-gp')).toHaveClass(/armed/);
    await waitFrames(page, 3); // baseline seeds on the next poll tick
    await updateFakeGamepad(page, { axes: [0.95, 0, 0, 0] }); // only axis 0 moves
    await expect.poll(async () => (await readBindings(page))?.rx ?? null, { timeout: 3000 }).not.toBeNull();
    expect((await readBindings(page))?.rx).toEqual({ kind: 'axis', index: 0 });
    await expect(card.getByTestId('gamepad-remap-rx-gp')).not.toHaveClass(/armed/);

    // The module is STILL ALIVE: rx now follows axis 0 (push axis 0 hard-right)…
    await updateFakeGamepad(page, { axes: [1, 0, 0, 0] });
    await expect.poll(() => readGp(page, 'rx'), { timeout: 2000 }).toBeGreaterThan(0.8);
    // …and the FIRST remap survived: lx follows axis 1.
    await updateFakeGamepad(page, { axes: [0, 1, 0, 0] });
    await expect.poll(() => readGp(page, 'lx'), { timeout: 2000 }).toBeGreaterThan(0.8);
    // …and an UN-remapped output still works (a-button via physical A = button 0).
    const pressA = [...Array(17).fill(0)]; pressA[0] = 1;
    await updateFakeGamepad(page, { axes: [0, 0, 0, 0], buttons: pressA });
    await expect.poll(() => readGp(page, 'a'), { timeout: 2000 }).toBe(1);
  });

  test('INVERT toggle flips the sign of a stick axis (composes with remap)', async ({ page, rack }) => {
    await installFakeGamepad(page, { axes: [0, 0, 0, 0] });
    await spawnPatch(page, [{ id: 'gp', type: 'gamepad', position: { x: 200, y: 200 } }]);
    await cardConnected(page);
    const card = await openGpBoard(page);

    // Baseline: right-stick X (axis 2) hard-right → rx ≈ +1 (no invert).
    await updateFakeGamepad(page, { axes: [0, 0, 1, 0] });
    await expect.poll(() => readGp(page, 'rx'), { timeout: 2000 }).toBeGreaterThan(0.8);

    // Toggle INVERT on rx → the SAME hard-right deflection now reads ≈ -1.
    await card.getByTestId('gamepad-invert-rx-gp').click();
    await expect(card.getByTestId('gamepad-invert-rx-gp')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => readGp(page, 'rx'), { timeout: 2000 }).toBeLessThan(-0.8);
    // Persisted on node.data.invert (synced).
    const inv = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: { invert?: Record<string, boolean> } }> };
      };
      return w.__patch.nodes.gp?.data?.invert ?? null;
    });
    expect(inv?.rx).toBe(true);

    // Toggle OFF → back to +1.
    await card.getByTestId('gamepad-invert-rx-gp').click();
    await expect(card.getByTestId('gamepad-invert-rx-gp')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => readGp(page, 'rx'), { timeout: 2000 }).toBeGreaterThan(0.8);

    // Invert COMPOSES with a remap: remap rx → axis 0, invert it, push axis 0.
    // First settle ALL axes to rest so the armed baseline diff only sees axis 0
    // move (otherwise axis 2 releasing from +1 would out-delta axis 0 and the
    // detector would pick axis 2 = rx's own default).
    await updateFakeGamepad(page, { axes: [0, 0, 0, 0] });
    await expect.poll(() => readGp(page, 'rx'), { timeout: 2000 }).toBeCloseTo(0, 1);
    await card.getByTestId('gamepad-remap-rx-gp').click();
    await expect(card.getByTestId('gamepad-remap-rx-gp')).toHaveClass(/armed/);
    await waitFrames(page, 3); // baseline seeds on the next poll tick
    await updateFakeGamepad(page, { axes: [0.95, 0, 0, 0] }); // only axis 0 moves
    await expect.poll(async () => (await readBindings(page))?.rx ?? null, { timeout: 3000 }).not.toBeNull();
    expect((await readBindings(page))?.rx).toEqual({ kind: 'axis', index: 0 });
    await card.getByTestId('gamepad-invert-rx-gp').click();
    await updateFakeGamepad(page, { axes: [1, 0, 0, 0] }); // axis 0 hard-right, remapped→rx, inverted
    await expect.poll(() => readGp(page, 'rx'), { timeout: 2000 }).toBeLessThan(-0.8);
  });

  test('button press shows up as a gate (a-button)', async ({ page, rack }) => {
    await installFakeGamepad(page, { buttons: Array(17).fill(0) });
    await spawnPatch(page, [{ id: 'gp', type: 'gamepad', position: { x: 200, y: 200 } }]);
    await cardConnected(page);

    // A-button = standard index 0.
    const pressed: number[] = [...Array(17).fill(0)];
    pressed[0] = 1;
    await updateFakeGamepad(page, { buttons: pressed });

    // The gate value IS the subject — poll it instead of sleeping and reading
    // once. Same assertion, but it cannot fail merely for being early.
    await expect
      .poll(() => readGp(page, 'a'), { timeout: 5_000 })
      .toBe(1);
  });

  // ─────────────────────── RIGHT-STICK CALIBRATION ───────────────────────
  // Symmetric to the left-stick calibration: enter right-stick MODE, sweep the
  // fake RIGHT stick (axes 2,3) through a REDUCED ±0.6 range, complete, and
  // assert AFTER calibration the same ±0.6 deflection now maps to (near) ±1 on
  // rx, persisting to node.data.rightStickCalibration.
  test('calibrate RIGHT stick: sweep (simulated) → complete → locked range remaps to full ±1', async ({ page, rack }) => {
    await installFakeGamepad(page, { axes: [0, 0, 0, 0] });
    await spawnPatch(page, [{ id: 'gp', type: 'gamepad', position: { x: 200, y: 200 } }]);

    const card = await openGpBoard(page);
    const readRx = () => page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => { readParam: (n: unknown, k: string) => unknown } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      const gp = w.__patch.nodes.gp;
      if (!eng || !gp) return -99;
      return (eng.readParam(gp, 'rx') as number | undefined) ?? -99;
    });

    // Baseline (un-calibrated): right-stick raw axis2=0.6 → rx ≈ 0.56 (can't reach +1).
    await updateFakeGamepad(page, { axes: [0, 0, 0.6, 0] });
    await expect.poll(readRx, { timeout: 2000 }).toBeGreaterThan(0.4);
    await expect.poll(readRx, { timeout: 2000 }).toBeLessThan(0.7);

    // Enter RIGHT-stick calibration mode.
    await card.getByTestId('gamepad-calibrate-right-gp').click();
    // In-mode: the calib row swaps to COMPLETE / CANCEL, and the RIGHT stick
    // pad is the armed one (the mode indicator moved off text onto the pad).
    await expect(card.getByTestId('gamepad-calibrate-complete-gp')).toBeVisible();
    await expect(card.getByTestId('gamepad-stick-right-gp')).toHaveClass(/armed/);
    await expect(card.getByTestId('gamepad-calibrate-complete-gp')).toBeDisabled();

    // Sweep the RIGHT stick's reduced range (axes 2,3) several times.
    const sweepPts: [number, number][] = [
      [0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6],
      [0.6, 0.6], [-0.6, -0.6], [0, 0],
    ];
    for (let rep = 0; rep < 2; rep++) {
      for (const [rx, ry] of sweepPts) {
        await updateFakeGamepad(page, { axes: [0, 0, rx, ry] });
        // Same as the left-stick sweep above: a point is only recorded if a
        // frame runs while it is set, so the unit is frames.
        await waitFrames(page, 2);
      }
    }
    await expect.poll(
      () => card.getByTestId('gamepad-calibrate-complete-gp').isEnabled(),
      { timeout: 2000 },
    ).toBe(true);

    // Complete → mode exits, RIGHT calibrated badge appears, range persisted.
    await card.getByTestId('gamepad-calibrate-complete-gp').click();
    await expect(card.getByTestId('gamepad-calibrate-complete-gp')).toHaveCount(0);
    await expect(card.getByTestId('gamepad-led-cal-right-gp')).toHaveAttribute('data-lit', '1');

    const cal = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: { rightStickCalibration?: unknown } }> };
      };
      return w.__patch.nodes.gp?.data?.rightStickCalibration ?? null;
    });
    expect(cal).not.toBeNull();

    // AFTER calibration: the SAME raw 0.6 deflection now reaches (near) +1.
    await updateFakeGamepad(page, { axes: [0, 0, 0.6, 0] });
    await expect.poll(readRx, { timeout: 2000 }).toBeGreaterThan(0.9);
    await updateFakeGamepad(page, { axes: [0, 0, -0.6, 0] });
    await expect.poll(readRx, { timeout: 2000 }).toBeLessThan(-0.9);
    // Centre reads ~0 (no snap-back drift).
    await updateFakeGamepad(page, { axes: [0, 0, 0, 0] });
    await expect.poll(readRx, { timeout: 2000 }).toBeCloseTo(0, 1);

    // The LEFT stick is unaffected (no left calibration committed).
    const leftCal = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: { leftStickCalibration?: unknown } }> };
      };
      return w.__patch.nodes.gp?.data?.leftStickCalibration ?? null;
    });
    expect(leftCal).toBeNull();
  });

  // ─────────────────────── SAVE / LOAD MAPPING + PRESETS ───────────────────────

  test('save mapping triggers a .json download of the current control config', async ({ page, rack }) => {
    await installFakeGamepad(page, { axes: [0, 0, 0, 0] });
    await spawnPatch(page, [{ id: 'gp', type: 'gamepad', position: { x: 200, y: 200 } }]);
    const card = await openGpBoard(page);

    // Seed some config so the saved mapping is non-trivial.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      };
      const gp = w.__patch.nodes.gp;
      if (!gp.data) gp.data = {};
      gp.data.bindings = { a: { kind: 'button', index: 2 } };
      gp.data.invert = { rx: true };
    });

    // Click "save mapping" and capture the triggered download.
    const downloadPromise = page.waitForEvent('download', { timeout: 5000 });
    await card.getByTestId('gamepad-save-mapping-gp').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.json$/);

    // The downloaded bytes are a valid mapping containing the seeded config.
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    const json = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    expect(json.bindings?.a).toEqual({ kind: 'button', index: 2 });
    expect(json.invert?.rx).toBe(true);

    // The MAPPING lamp latches the outcome (its detail rides the aria-label —
    // the card's status toast became a StatusLed).
    await expect(card.getByTestId('gamepad-led-mapping-gp')).toHaveAttribute('aria-label', /saved/i);
  });

  test('load preset "NXT Gladiator" applies WITHOUT killing the module (rAF poll stays alive)', async ({ page }) => {
    // The preset funnels through applyMapping (the same in-place mutation as the
    // remap commit). A bad in-place write would throw out of the card's rAF poll
    // and kill the module — assert the module STILL emits afterwards.
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');
    await installFakeGamepad(page, { axes: [0, 0, 0, 0], buttons: Array(17).fill(0) });
    await spawnPatch(page, [{ id: 'gp', type: 'gamepad', position: { x: 200, y: 200 } }]);
    await cardConnected(page);
    const card = await openGpBoard(page);

    const readGp = (port: string) => page.evaluate((p) => {
      const w = globalThis as unknown as {
        __engine?: () => { readParam: (n: unknown, k: string) => unknown } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      const gp = w.__patch.nodes.gp;
      if (!eng || !gp) return -99;
      return (eng.readParam(gp, p) as number | undefined) ?? -99;
    }, port);

    // The preset dropdown is pre-populated with "NXT Gladiator".
    await expect(
      card.getByTestId('gamepad-preset-gp').locator('option', { hasText: 'NXT Gladiator' }),
    ).toHaveCount(1);

    // Select it → applies the placeholder (default) mapping; status confirms.
    await card.getByTestId('gamepad-preset-gp').selectOption('NXT Gladiator');
    await expect(card.getByTestId('gamepad-led-mapping-gp')).toHaveAttribute('aria-label', /NXT Gladiator/);

    // The module is STILL ALIVE: the rAF poll keeps pushing values. Push axis 0
    // hard-right and the lx output follows it (default mapping → lx = axis 0).
    await updateFakeGamepad(page, { axes: [1, 0, 0, 0] });
    await expect.poll(() => readGp('lx'), { timeout: 2000 }).toBeGreaterThan(0.8);
    // …and a button gate still works through the (default) mapping.
    const pressA = [...Array(17).fill(0)]; pressA[0] = 1;
    await updateFakeGamepad(page, { axes: [0, 0, 0, 0], buttons: pressA });
    await expect.poll(() => readGp('a'), { timeout: 2000 }).toBe(1);

    expect(errors.filter((e) => !e.includes('DEP0040')), errors.join('; ')).toEqual([]);
  });

  test('load mapping from JSON file applies the bindings + survives a 2nd load (rAF alive)', async ({ page, rack }) => {
    await installFakeGamepad(page, { axes: [0, 0, 0, 0], buttons: Array(17).fill(0) });
    await spawnPatch(page, [{ id: 'gp', type: 'gamepad', position: { x: 200, y: 200 } }]);
    await cardConnected(page);
    const card = await openGpBoard(page);

    const readGp = (port: string) => page.evaluate((p) => {
      const w = globalThis as unknown as {
        __engine?: () => { readParam: (n: unknown, k: string) => unknown } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      const gp = w.__patch.nodes.gp;
      if (!eng || !gp) return -99;
      return (eng.readParam(gp, p) as number | undefined) ?? -99;
    }, port);

    // Load a mapping that binds the `a` output to physical X (button 2).
    const mapping1 = JSON.stringify({ bindings: { a: { kind: 'button', index: 2 } } });
    await card.getByTestId('gamepad-load-mapping-gp').setInputFiles({
      name: 'm1.json',
      mimeType: 'application/json',
      buffer: Buffer.from(mapping1, 'utf-8'),
    });
    await expect.poll(async () => {
      return await page.evaluate(() => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { data?: { bindings?: Record<string, unknown> } }> };
        };
        return w.__patch.nodes.gp?.data?.bindings?.a ?? null;
      });
    }, { timeout: 3000 }).toEqual({ kind: 'button', index: 2 });

    // The `a` output now follows physical X.
    const pressX = [...Array(17).fill(0)]; pressX[2] = 1;
    await updateFakeGamepad(page, { buttons: pressX });
    await expect.poll(() => readGp('a'), { timeout: 2000 }).toBe(1);

    // Load a SECOND mapping (the over-existing path) — must not throw out of the
    // rAF poll. This one inverts rx instead.
    const mapping2 = JSON.stringify({ invert: { rx: true } });
    await card.getByTestId('gamepad-load-mapping-gp').setInputFiles({
      name: 'm2.json',
      mimeType: 'application/json',
      buffer: Buffer.from(mapping2, 'utf-8'),
    });
    await expect.poll(async () => {
      return await page.evaluate(() => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { data?: { invert?: Record<string, boolean> } }> };
        };
        return w.__patch.nodes.gp?.data?.invert?.rx ?? null;
      });
    }, { timeout: 3000 }).toBe(true);

    // Module still alive: rx axis (2) hard-right now reads NEGATIVE (inverted).
    await updateFakeGamepad(page, { axes: [0, 0, 1, 0] });
    await expect.poll(() => readGp('rx'), { timeout: 2000 }).toBeLessThan(-0.8);

    // Loading GARBAGE JSON is ignored gracefully (no throw, module still alive).
    await card.getByTestId('gamepad-load-mapping-gp').setInputFiles({
      name: 'junk.json',
      mimeType: 'application/json',
      buffer: Buffer.from('not json at all {{{', 'utf-8'),
    });
    await expect(card.getByTestId('gamepad-led-mapping-gp')).toHaveAttribute('aria-label', /ignored/i);
    // rx invert is unchanged + the poll still drives output.
    await updateFakeGamepad(page, { axes: [0, 0, 1, 0] });
    await expect.poll(() => readGp('rx'), { timeout: 2000 }).toBeLessThan(-0.8);
  });
});
