// e2e/tests/pong.spec.ts
//
// PONG module end-to-end (research prototype):
//
//   1. The card mounts cleanly + renders its 16-bit canvas.
//   2. With no inputs patched the game ticks deterministically — ball
//      moves and score events eventually fire (no paddles → both sides
//      eventually miss).
//   3. A CV source (BUGGLES.smooth) patched into paddle_left moves the
//      LEFT paddle's reported Y on the snapshot. This proves the
//      end-to-end CV-in → game-state path.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

interface PongSnapshot {
  ballX: number;
  ballY: number;
  ballVX: number;
  ballVY: number;
  scoreL: number;
  scoreR: number;
  paddleLY: number;
  paddleRY: number;
}

async function readPongSnapshot(page: Page, nodeId: string): Promise<PongSnapshot | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const node = w.__patch.nodes[id];
    if (!node) return null;
    const snap = eng.read(node, 'snapshot');
    if (!snap || typeof snap !== 'object') return null;
    const s = snap as Record<string, number>;
    return {
      ballX: s.ballX, ballY: s.ballY,
      ballVX: s.ballVX, ballVY: s.ballVY,
      scoreL: s.scoreL, scoreR: s.scoreR,
      paddleLY: s.paddleLY, paddleRY: s.paddleRY,
    };
  }, nodeId);
}

test('pong: drop module → card mounts with no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'p', type: 'pong', position: { x: 200, y: 200 } }]);
  const card = page.locator('.svelte-flow__node-pong');
  await expect(card).toBeVisible();
  await expect(card).toContainText('PONG');
  // The canvas must render with a non-zero backing store.
  const canvas = card.locator('[data-testid="pong-canvas"]');
  await expect(canvas).toBeVisible();
  const size = await canvas.evaluate((el: Element) => {
    const c = el as HTMLCanvasElement;
    return { w: c.width, h: c.height };
  });
  expect(size.w).toBeGreaterThan(0);
  expect(size.h).toBeGreaterThan(0);
  expect(errors.filter((e) => !e.includes('AudioContext'))).toEqual([]);
});

test('pong: ball moves across simulated time (game-loop ticks)', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'p', type: 'pong', position: { x: 200, y: 200 } }]);

  // Trigger the audio gate (so the AudioContext resumes — modules need it).
  // The card mount kicks off the engine via Canvas's ensureEngine; the
  // scheduler-clock subscription is engine-independent so it tick regardless,
  // but the analyser taps + ConstantSourceNodes need the audio context to
  // exist (which the spawnPatch path materialises).
  await page.locator('button:has-text("Tap to start")').first().click({ timeout: 2000 }).catch(() => { /* no gate */ });

  // Sample the snapshot twice with a delay; the ball should move between
  // them. (Even at scheduler-clock's 25 ms tick, ~500 ms gives 20 ticks of
  // motion.)
  await page.waitForTimeout(200);
  const snap1 = await readPongSnapshot(page, 'p');
  expect(snap1, 'pong snapshot must be readable').not.toBeNull();
  await page.waitForTimeout(600);
  const snap2 = await readPongSnapshot(page, 'p');
  expect(snap2).not.toBeNull();

  // Either the ball position changed, OR a score event already happened
  // (which re-centers the ball — that's also evidence the loop is running).
  const moved = Math.abs(snap2!.ballX - snap1!.ballX) + Math.abs(snap2!.ballY - snap1!.ballY) > 0.001;
  const scored = (snap2!.scoreL + snap2!.scoreR) > (snap1!.scoreL + snap1!.scoreR);
  expect(moved || scored, `ball did not move (snap1=${JSON.stringify(snap1)}, snap2=${JSON.stringify(snap2)})`)
    .toBe(true);
});

test('pong: CV source patched into paddle_left moves the on-screen paddle', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  // BUGGLES is the simplest CV source we have. Its `smooth` output is a
  // slow-changing voltage in roughly [-1, +1] — exactly what we feed into
  // a paddle CV input. The exact paddle position is non-deterministic
  // (BUGGLES is stochastic), but a non-zero PADDLE Y motion is the
  // load-bearing assertion: it proves the CV-in → game-state path works.
  await spawnPatch(
    page,
    [
      { id: 'b', type: 'buggles', position: { x: 100, y: 100 } },
      { id: 'p', type: 'pong',    position: { x: 400, y: 100 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'b', portId: 'smooth' }, to: { nodeId: 'p', portId: 'paddle_left' } },
    ],
  );
  await page.locator('button:has-text("Tap to start")').first().click({ timeout: 2000 }).catch(() => { /* */ });

  await page.waitForTimeout(300);
  const initial = await readPongSnapshot(page, 'p');
  expect(initial).not.toBeNull();

  // Wait long enough for BUGGLES to fire several woggle events (its
  // base rate is ~2 Hz; 1.5 s = ~3 events).
  await page.waitForTimeout(1500);
  const later = await readPongSnapshot(page, 'p');
  expect(later).not.toBeNull();

  // Threshold is a noise floor — the paddle is a low-passed integrator of
  // the incoming CV, so per-tick deltas are tiny (millivolts of position).
  // The load-bearing claim is "CV actually drove paddle motion" — not "by N
  // units". 0.001 separates real motion from float-equality jitter.
  const paddleMoved = Math.abs(later!.paddleLY - initial!.paddleLY) > 0.001;
  expect(
    paddleMoved,
    `left paddle did not move from ${initial!.paddleLY} to ${later!.paddleLY} despite CV source`,
  ).toBe(true);
});
