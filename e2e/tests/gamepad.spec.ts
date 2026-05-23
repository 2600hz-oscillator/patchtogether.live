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
