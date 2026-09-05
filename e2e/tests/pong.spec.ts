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

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
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

test('pong: drop module → the shell mounts with no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'p', type: 'pong', position: { x: 200, y: 200 } }]);
  const tile = page.locator('.svelte-flow__node:has([data-shell-type="pong"])');
  await expect(tile).toBeVisible();
  await expect(tile).toContainText(/pong/i);
  // The 16-bit screen lives in the DOCK face body on the default shell; its
  // canvas must render with a non-zero backing store.
  await page.evaluate(() => (globalThis as unknown as { __openDockFullView: (id: string) => void }).__openDockFullView('p'));
  const canvas = page.locator('[data-testid="pong-face-canvas"]');
  await expect(canvas).toBeVisible();
  const size = await canvas.evaluate((el: Element) => {
    const c = el as HTMLCanvasElement;
    return { w: c.width, h: c.height };
  });
  expect(size.w).toBeGreaterThan(0);
  expect(size.h).toBeGreaterThan(0);
  expect(errors.filter((e) => !e.includes('AudioContext'))).toEqual([]);
});

test('pong: ball moves across simulated time (game-loop ticks)', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'p', type: 'pong', position: { x: 200, y: 200 } }]);

  // Trigger the audio gate (so the AudioContext resumes — modules need it).
  // The card mount kicks off the engine via Canvas's ensureEngine; the
  // scheduler-clock subscription is engine-independent so it tick regardless,
  // but the analyser taps + ConstantSourceNodes need the audio context to
  // exist (which the spawnPatch path materialises).
  await page.locator('button:has-text("Tap to start")').first().click({ timeout: 2000 }).catch(() => { /* no gate */ });

  // Take a baseline, then wait for the ball to have MOVED away from it.
  //
  // #1523: this was `waitForTimeout(200)` → snap1 → `waitForTimeout(600)` →
  // snap2 → assert they differ. Two guesses, and the second one had to be long
  // enough for the game loop on the slowest machine while the assertion itself
  // ("has anything changed?") is available at any moment. Polling asks the real
  // question and stops as soon as the answer is yes.
  await expect
    .poll(() => readPongSnapshot(page, 'p'), {
      timeout: 10_000,
      message: 'pong snapshot must become readable',
    })
    .not.toBeNull();
  const snap1 = (await readPongSnapshot(page, 'p'))!;

  // Either the ball position changed, OR a score event already happened
  // (which re-centers the ball — that's also evidence the loop is running).
  await expect
    .poll(
      async () => {
        const s = await readPongSnapshot(page, 'p');
        if (!s) return false;
        const moved = Math.abs(s.ballX - snap1.ballX) + Math.abs(s.ballY - snap1.ballY) > 0.001;
        const scored = s.scoreL + s.scoreR > snap1.scoreL + snap1.scoreR;
        return moved || scored;
      },
      {
        timeout: 10_000,
        message: `the game loop never moved the ball or scored (baseline=${JSON.stringify(snap1)})`,
      },
    )
    .toBe(true);
});

test('pong: CV source patched into paddle_left moves the on-screen paddle', async ({ page, rack }) => {
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

  await expect
    .poll(() => readPongSnapshot(page, 'p'), {
      timeout: 10_000,
      message: 'pong snapshot must become readable',
    })
    .not.toBeNull();
  const initial = (await readPongSnapshot(page, 'p'))!;

  // Threshold is a noise floor — the paddle is a low-passed integrator of
  // the incoming CV, so per-tick deltas are tiny (millivolts of position).
  // The load-bearing claim is "CV actually drove paddle motion" — not "by N
  // units". 0.001 separates real motion from float-equality jitter.
  //
  // The old form slept 1.5 s ("~3 BUGGLES woggle events at its ~2 Hz base
  // rate") and read once. BUGGLES is stochastic, so that was a bet on the
  // arrival time of a random event — poll for the motion instead and the bet
  // disappears.
  await expect
    .poll(
      async () => {
        const s = await readPongSnapshot(page, 'p');
        return s ? Math.abs(s.paddleLY - initial.paddleLY) : 0;
      },
      {
        timeout: 15_000,
        message: `left paddle never moved from ${initial.paddleLY} despite the CV source`,
      },
    )
    .toBeGreaterThan(0.001);
});
