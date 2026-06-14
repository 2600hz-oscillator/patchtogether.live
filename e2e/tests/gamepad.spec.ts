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

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

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
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, [{ id: 'gp', type: 'gamepad', position: { x: 200, y: 200 } }]);
    await expect(page.locator('[data-testid="gamepad-card"]')).toBeVisible();
    await expect(page.locator('[data-testid="gamepad-card"] .status')).toContainText(
      /press any button/i,
    );
    expect(errors.filter((e) => !e.includes('DEP0040')), errors.join('; ')).toEqual([]);
  });

  test('connected state + live values flow into engine.read snapshot', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await installFakeGamepad(page, { axes: [0.6, -0.4, 0, 0] });
    await spawnPatch(page, [{ id: 'gp', type: 'gamepad', position: { x: 200, y: 200 } }]);
    // Give the rAF poll a few frames to pick up the fake.
    await page.waitForTimeout(200);

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

  test('LFO-style sweep: updating fake axes moves the engine.readParam(lx) over time', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await installFakeGamepad(page, { axes: [0, 0, 0, 0] });
    await spawnPatch(page, [{ id: 'gp', type: 'gamepad', position: { x: 200, y: 200 } }]);
    await page.waitForTimeout(150);

    const samples: number[] = [];
    for (let i = 0; i < 8; i++) {
      const ax = Math.sin(i * 0.5);   // moves between -1 .. +1
      await updateFakeGamepad(page, { axes: [ax, 0, 0, 0] });
      // Give the rAF poll one frame to push the new value
      await page.waitForTimeout(60);
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

  test('patch GAMEPAD.lx → WAVESCULPT.pos_x; fake stick drives wavesculpt camera', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
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
    await page.waitForTimeout(200);

    // With axes=[0,...], pos_x should be ~0 (knob default + zero CV).
    const posBefore = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => { readParam: (n: unknown, k: string) => unknown } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      const ws = w.__patch.nodes.ws;
      if (!eng || !ws) return -99;
      return (eng.readParam(ws, 'pos_x') as number | undefined) ?? -99;
    });
    expect(Math.abs(posBefore)).toBeLessThan(0.1);

    // Push the fake stick fully right. After ~200ms, engine.readParam
    // for wavesculpt.pos_x should report something > 0.5.
    await updateFakeGamepad(page, { axes: [1, 0, 0, 0] });
    await page.waitForTimeout(250);
    const posAfter = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => { readParam: (n: unknown, k: string) => unknown } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      const ws = w.__patch.nodes.ws;
      if (!eng || !ws) return -99;
      return (eng.readParam(ws, 'pos_x') as number | undefined) ?? -99;
    });
    expect(
      posAfter,
      `wavesculpt.pos_x with stick full-right = ${posAfter} (expected > 0.5)`,
    ).toBeGreaterThan(0.5);
  });

  test('GAMEPAD stick reaches BOTH extremes of WAVESCULPT.pos_x + moves the on-card joystick dot', async ({ page }) => {
    // Regression: the gamepad-driven camera joystick couldn't reach the
    // stick's extremes and the dot updated horribly slowly (the live-poll
    // was on a setInterval that got starved behind the card's WebGL render;
    // it now rides rAF). Assert (1) the full ±range is reachable via
    // engine.readParam AND (2) the rendered dot tracks to each extreme.
    await page.goto('/');
    await page.waitForLoadState('networkidle');
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
    await page.waitForTimeout(200);

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
    // The dot's `left` (px) within the 110px pad: full-left ≈ 0, full-right ≈ 110.
    const dotLeftPx = () => page.evaluate(() => {
      const dot = document.querySelector('[data-testid="wavesculpt-pad"] .dot') as HTMLElement | null;
      if (!dot) return -1;
      return parseFloat(dot.style.left || '-1');
    });

    // Full RIGHT → pos_x near +1 → dot near the right edge (>80% of the pad).
    await updateFakeGamepad(page, { axes: [1, 0, 0, 0] });
    await expect.poll(readPosX, { timeout: 2000 }).toBeGreaterThan(0.9);
    await expect.poll(dotLeftPx, { timeout: 2000 }).toBeGreaterThan(88);

    // Full LEFT → pos_x near -1 → dot near the left edge (<20% of the pad).
    await updateFakeGamepad(page, { axes: [-1, 0, 0, 0] });
    await expect.poll(readPosX, { timeout: 2000 }).toBeLessThan(-0.9);
    await expect.poll(dotLeftPx, { timeout: 2000 }).toBeLessThan(22);
  });

  test('calibrate left stick: sweep (simulated) → complete → locked range remaps to full ±1', async ({ page }) => {
    // The first deliverable: enter calibration MODE, sweep the fake stick
    // through a REDUCED range (a flight stick / worn pad that only reaches
    // ±0.6), complete, and assert that AFTER calibration the same ±0.6 raw
    // deflection now maps to (near) ±1 on lx — i.e. observed-max → full-max.
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await installFakeGamepad(page, { axes: [0, 0, 0, 0] });
    await spawnPatch(page, [{ id: 'gp', type: 'gamepad', position: { x: 200, y: 200 } }]);
    await page.waitForTimeout(150);

    const card = page.locator('[data-testid="gamepad-card"]');
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
    await card.getByTestId('gamepad-calibrate-start').click();
    await expect(card.getByTestId('gamepad-calib-mode')).toBeVisible();
    // "complete" starts disabled (no usable sweep yet).
    await expect(card.getByTestId('gamepad-calibrate-complete')).toBeDisabled();

    // Sweep the reduced range several times: hit each extreme on both axes.
    const sweepPts: [number, number][] = [
      [0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6],
      [0.6, 0.6], [-0.6, -0.6], [0, 0],
    ];
    for (let rep = 0; rep < 2; rep++) {
      for (const [x, y] of sweepPts) {
        await updateFakeGamepad(page, { axes: [x, y, 0, 0] });
        await page.waitForTimeout(40);
      }
    }
    // Now the sweep is usable → "complete" enables.
    await expect.poll(
      () => card.getByTestId('gamepad-calibrate-complete').isEnabled(),
      { timeout: 2000 },
    ).toBe(true);

    // Complete → mode exits, calibrated badge appears, range persisted to data.
    await card.getByTestId('gamepad-calibrate-complete').click();
    await expect(card.getByTestId('gamepad-calib-mode')).toBeHidden();
    await expect(card.getByTestId('gamepad-calibrated')).toBeVisible();

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

  test('clear calibration reverts the left stick to the fixed-deadzone path', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await installFakeGamepad(page, { axes: [0, 0, 0, 0] });
    await spawnPatch(page, [{ id: 'gp', type: 'gamepad', position: { x: 200, y: 200 } }]);
    await page.waitForTimeout(150);
    const card = page.locator('[data-testid="gamepad-card"]');

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
    await expect(card.getByTestId('gamepad-calibrated')).toBeVisible();
    await card.getByTestId('gamepad-calibrate-clear').click();
    await expect(card.getByTestId('gamepad-calibrated')).toBeHidden();
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

  test('right-click a button LED → arm → press a DIFFERENT physical button binds the output, and the output now follows it', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // All buttons released at rest (17 zeros) so the armed baseline is clean.
    await installFakeGamepad(page, { buttons: Array(17).fill(0) });
    await spawnPatch(page, [{ id: 'gp', type: 'gamepad', position: { x: 200, y: 200 } }]);
    await page.waitForTimeout(200);
    const card = page.locator('[data-testid="gamepad-card"]');

    // Baseline: the `a` output follows physical A (button 0). Pressing X
    // (button 2) does NOT light `a` yet.
    const pressX = [...Array(17).fill(0)]; pressX[2] = 1;
    await updateFakeGamepad(page, { buttons: pressX });
    await page.waitForTimeout(100);
    expect(await readGp(page, 'a')).toBe(0);
    // Release before arming so the baseline diff starts from rest.
    await updateFakeGamepad(page, { buttons: Array(17).fill(0) });
    await page.waitForTimeout(100);

    // Arm the `a` output's remap (right-click its LED) → banner appears.
    await card.getByTestId('gamepad-remap-a').click({ button: 'right' });
    await expect(card.getByTestId('gamepad-remap-banner')).toBeVisible();

    // Press physical X (button 2) → detector binds `a` → physical X.
    await updateFakeGamepad(page, { buttons: pressX });
    // Wait for the binding to be committed to node.data.
    await expect.poll(() => readBindings(page), { timeout: 3000 }).not.toBeNull();
    const bindings = await readBindings(page);
    expect(bindings?.a).toEqual({ kind: 'button', index: 2 });
    // Banner clears once bound.
    await expect(card.getByTestId('gamepad-remap-banner')).toBeHidden();

    // The `a` output now FOLLOWS physical X: holding X reads 1…
    await expect.poll(() => readGp(page, 'a'), { timeout: 2000 }).toBe(1);
    // …and pressing physical A (button 0) alone does NOT light `a` anymore.
    const pressA = [...Array(17).fill(0)]; pressA[0] = 1;
    await updateFakeGamepad(page, { buttons: pressA });
    await expect.poll(() => readGp(page, 'a'), { timeout: 2000 }).toBe(0);
  });

  test('"Remap X" under the left stick → move an axis → axis binding persists + output follows', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await installFakeGamepad(page, { axes: [0, 0, 0, 0] });
    await spawnPatch(page, [{ id: 'gp', type: 'gamepad', position: { x: 200, y: 200 } }]);
    await page.waitForTimeout(200);
    const card = page.locator('[data-testid="gamepad-card"]');

    // Arm the left-stick X remap (the user-preferred separate "Remap X" button).
    await card.getByTestId('gamepad-remap-lx').click();
    await expect(card.getByTestId('gamepad-remap-banner')).toBeVisible();

    // Move the RIGHT-stick X axis (index 2) fully → detector binds lx → axis 2.
    await updateFakeGamepad(page, { axes: [0, 0, 0.95, 0] });
    await expect.poll(() => readBindings(page), { timeout: 3000 }).not.toBeNull();
    const bindings = await readBindings(page);
    expect(bindings?.lx).toEqual({ kind: 'axis', index: 2 });
    await expect(card.getByTestId('gamepad-remap-banner')).toBeHidden();

    // The lx OUTPUT now follows axis 2: moving axis 2 drives lx, while the
    // original axis 0 no longer does.
    await updateFakeGamepad(page, { axes: [0, 0, 1, 0] });
    await expect.poll(() => readGp(page, 'lx'), { timeout: 2000 }).toBeGreaterThan(0.8);
    await updateFakeGamepad(page, { axes: [1, 0, 0, 0] }); // old axis 0 hard-right
    await expect.poll(() => readGp(page, 'lx'), { timeout: 2000 }).toBeLessThan(0.2);
  });

  test('Esc cancels an armed remap with no binding written', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await installFakeGamepad(page, { buttons: Array(17).fill(0) });
    await spawnPatch(page, [{ id: 'gp', type: 'gamepad', position: { x: 200, y: 200 } }]);
    await page.waitForTimeout(200);
    const card = page.locator('[data-testid="gamepad-card"]');

    await card.getByTestId('gamepad-remap-b').click({ button: 'right' });
    await expect(card.getByTestId('gamepad-remap-banner')).toBeVisible();
    // Cancel via Esc.
    await page.keyboard.press('Escape');
    await expect(card.getByTestId('gamepad-remap-banner')).toBeHidden();
    // Now press a button — it must NOT bind anything (listener disarmed).
    const pressX = [...Array(17).fill(0)]; pressX[2] = 1;
    await updateFakeGamepad(page, { buttons: pressX });
    await page.waitForTimeout(200);
    expect(await readBindings(page)).toBeNull();
  });

  test('remap the RIGHT stick after another remap → module KEEPS emitting (regression)', async ({ page }) => {
    // The shipped bug: the 2nd remap commit threw "reassigning object that
    // already occurs in the tree" out of the card's rAF poll, killing the poll
    // loop so the module went DEAD. Reproduce the user's flow: remap one output,
    // then remap the right-stick X, and assert the module STILL produces output.
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await installFakeGamepad(page, { axes: [0, 0, 0, 0], buttons: Array(17).fill(0) });
    await spawnPatch(page, [{ id: 'gp', type: 'gamepad', position: { x: 200, y: 200 } }]);
    await page.waitForTimeout(200);
    const card = page.locator('[data-testid="gamepad-card"]');

    // FIRST remap: arm the left-stick X (left-click, the axis path → no context
    // menu) and move axis 1 → binds lx→axis1.
    await card.getByTestId('gamepad-remap-lx').click();
    await expect(card.getByTestId('gamepad-remap-banner')).toBeVisible();
    await updateFakeGamepad(page, { axes: [0, 0.95, 0, 0] }); // only axis 1 moves
    await expect.poll(async () => (await readBindings(page))?.lx ?? null, { timeout: 3000 }).not.toBeNull();
    expect((await readBindings(page))?.lx).toEqual({ kind: 'axis', index: 1 });
    // Settle ALL axes to rest so the NEXT armed baseline diff only sees axis 0.
    await updateFakeGamepad(page, { axes: [0, 0, 0, 0] });
    await page.waitForTimeout(100);

    // SECOND remap (the one that broke): arm the right-stick X, move axis 0 →
    // binds rx→axis0. The shipped code threw out of the rAF poll HERE (the
    // bindings map already existed), killing the module. It must NOT throw.
    await card.getByTestId('gamepad-remap-rx').click();
    await expect(card.getByTestId('gamepad-remap-banner')).toBeVisible();
    await updateFakeGamepad(page, { axes: [0.95, 0, 0, 0] }); // only axis 0 moves
    await expect.poll(async () => (await readBindings(page))?.rx ?? null, { timeout: 3000 }).not.toBeNull();
    expect((await readBindings(page))?.rx).toEqual({ kind: 'axis', index: 0 });
    await expect(card.getByTestId('gamepad-remap-banner')).toBeHidden();

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

  test('INVERT toggle flips the sign of a stick axis (composes with remap)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await installFakeGamepad(page, { axes: [0, 0, 0, 0] });
    await spawnPatch(page, [{ id: 'gp', type: 'gamepad', position: { x: 200, y: 200 } }]);
    await page.waitForTimeout(200);
    const card = page.locator('[data-testid="gamepad-card"]');

    // Baseline: right-stick X (axis 2) hard-right → rx ≈ +1 (no invert).
    await updateFakeGamepad(page, { axes: [0, 0, 1, 0] });
    await expect.poll(() => readGp(page, 'rx'), { timeout: 2000 }).toBeGreaterThan(0.8);

    // Toggle INVERT on rx → the SAME hard-right deflection now reads ≈ -1.
    await card.getByTestId('gamepad-invert-rx').click();
    await expect(card.getByTestId('gamepad-invert-rx')).toHaveAttribute('aria-pressed', 'true');
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
    await card.getByTestId('gamepad-invert-rx').click();
    await expect(card.getByTestId('gamepad-invert-rx')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => readGp(page, 'rx'), { timeout: 2000 }).toBeGreaterThan(0.8);

    // Invert COMPOSES with a remap: remap rx → axis 0, invert it, push axis 0.
    // First settle ALL axes to rest so the armed baseline diff only sees axis 0
    // move (otherwise axis 2 releasing from +1 would out-delta axis 0 and the
    // detector would pick axis 2 = rx's own default).
    await updateFakeGamepad(page, { axes: [0, 0, 0, 0] });
    await expect.poll(() => readGp(page, 'rx'), { timeout: 2000 }).toBeCloseTo(0, 1);
    await card.getByTestId('gamepad-remap-rx').click();
    await expect(card.getByTestId('gamepad-remap-banner')).toBeVisible();
    await updateFakeGamepad(page, { axes: [0.95, 0, 0, 0] }); // only axis 0 moves
    await expect.poll(async () => (await readBindings(page))?.rx ?? null, { timeout: 3000 }).not.toBeNull();
    expect((await readBindings(page))?.rx).toEqual({ kind: 'axis', index: 0 });
    await card.getByTestId('gamepad-invert-rx').click();
    await updateFakeGamepad(page, { axes: [1, 0, 0, 0] }); // axis 0 hard-right, remapped→rx, inverted
    await expect.poll(() => readGp(page, 'rx'), { timeout: 2000 }).toBeLessThan(-0.8);
  });

  test('button press shows up as a gate (a-button)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await installFakeGamepad(page, { buttons: Array(17).fill(0) });
    await spawnPatch(page, [{ id: 'gp', type: 'gamepad', position: { x: 200, y: 200 } }]);
    await page.waitForTimeout(150);

    // A-button = standard index 0.
    const pressed: number[] = [...Array(17).fill(0)];
    pressed[0] = 1;
    await updateFakeGamepad(page, { buttons: pressed });
    await page.waitForTimeout(100);

    const aValue = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => { readParam: (n: unknown, k: string) => unknown } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      const gp = w.__patch.nodes.gp;
      if (!eng || !gp) return -99;
      return (eng.readParam(gp, 'a') as number | undefined) ?? -99;
    });
    expect(aValue).toBe(1);
  });
});
