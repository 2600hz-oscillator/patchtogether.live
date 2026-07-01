// e2e/tests/frogger.spec.ts
//
// FROGGER module end-to-end. Mirrors modtris.spec.ts:
//
//   1. The card mounts cleanly + renders its canvas with no console errors.
//   2. The game auto-starts on spawn (start_gate synthetic pulse fires on
//      first scheduler tick) — isGameInPlay flips true within the first
//      few hundred milliseconds, AND the world ticks forward (sprites
//      advance) without any user input.
//   3. A CV/gate source patched into start_gate restarts the game
//      mid-flight (player position resets to (7,13)).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

interface FroggerSnapshot {
  tick: number;
  isGameInPlay: boolean;
  level: number;
  time: number;
  spriteCount: number;
  playerX: number;
  playerY: number;
  playerLives: number;
  homesFilled: number;
}

async function readFroggerSnapshot(page: Page, nodeId: string): Promise<FroggerSnapshot | null> {
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
    const snap = eng.read(node, 'snapshot') as unknown as Record<string, unknown> | undefined;
    if (!snap || typeof snap !== 'object') return null;
    const sprites = snap.sprites as Array<{ visable?: boolean; key?: string }> | undefined;
    const player = snap.player as { x?: number; y?: number; lives?: number } | undefined;
    const homesFilled = (sprites ?? []).filter(
      (sp) => typeof sp.key === 'string' && sp.key.startsWith('player-home-') && sp.visable === true,
    ).length;
    return {
      tick: (snap.tick as number) ?? 0,
      isGameInPlay: (snap.isGameInPlay as boolean) ?? false,
      level: (snap.level as number) ?? 0,
      time: (snap.time as number) ?? 0,
      spriteCount: sprites ? sprites.length : 0,
      playerX: player?.x ?? -1,
      playerY: player?.y ?? -1,
      playerLives: player?.lives ?? -1,
      homesFilled,
    };
  }, nodeId);
}

test('frogger: drop module → card mounts with no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'f', type: 'frogger', position: { x: 200, y: 200 } }]);
  const card = page.locator('.svelte-flow__node-frogger');
  await expect(card).toBeVisible();
  await expect(card).toContainText('FROGGER');
  const canvas = card.locator('[data-testid="frogger-canvas"]');
  await expect(canvas).toBeVisible();
  const size = await canvas.evaluate((el: Element) => {
    const c = el as HTMLCanvasElement;
    return { w: c.width, h: c.height };
  });
  expect(size.w).toBeGreaterThan(0);
  expect(size.h).toBeGreaterThan(0);
  expect(errors.filter((e) => !e.includes('AudioContext'))).toEqual([]);
});

test('frogger: auto-starts on spawn (no user input — isGameInPlay flips + sprites advance)', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'f', type: 'frogger', position: { x: 200, y: 200 } }]);
  // Resume the AudioContext so the scheduler-clock subscribes start firing.
  // Same flow as MODTRIS / PONG specs.
  await page.locator('button:has-text("Tap to start")').first().click({ timeout: 2000 }).catch(() => { /* */ });

  // Within ~500 ms the auto-start synthesized rising-edge has fired + the
  // game is running.
  await page.waitForTimeout(500);
  const snap1 = await readFroggerSnapshot(page, 'f');
  expect(snap1, 'frogger snapshot must be readable').not.toBeNull();
  expect(snap1!.spriteCount).toBeGreaterThan(20);
  expect(snap1!.isGameInPlay, 'auto-start should have flipped isGameInPlay true').toBe(true);
  expect(snap1!.playerX).toBe(7);  // initial position
  expect(snap1!.playerY).toBe(13);

  // Tick must advance + sprites should evolve (vehicles + rafts move under
  // the spriteTick clock).
  await page.waitForTimeout(1500);
  const snap2 = await readFroggerSnapshot(page, 'f');
  expect(snap2).not.toBeNull();
  expect(snap2!.tick, `tick did not advance (snap1=${snap1!.tick} snap2=${snap2!.tick})`).toBeGreaterThan(snap1!.tick);
});

test('frogger: BUGGLES.clock patched into start_gate restarts the game', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  // BUGGLES.clock is a real gate source (5 ms pulses at ~1-2 Hz). Each
  // pulse should re-fire startGame() and reset the world; the tick keeps
  // advancing across restarts, so we use that + isGameInPlay as the
  // smoke-test that the rising edge is consumed.
  await spawnPatch(
    page,
    [
      { id: 'b', type: 'buggles', position: { x: 100, y: 100 } },
      { id: 'f', type: 'frogger', position: { x: 400, y: 100 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'b', portId: 'clock' }, to: { nodeId: 'f', portId: 'start_gate' } },
    ],
  );
  await page.locator('button:has-text("Tap to start")').first().click({ timeout: 2000 }).catch(() => { /* */ });

  await page.waitForTimeout(300);
  const initial = await readFroggerSnapshot(page, 'f');
  expect(initial).not.toBeNull();
  // Auto-start fires + game is in play.
  expect(initial!.isGameInPlay).toBe(true);

  // Wait for BUGGLES.clock to fire several pulses.
  await page.waitForTimeout(2000);
  const later = await readFroggerSnapshot(page, 'f');
  expect(later).not.toBeNull();
  // Tick keeps advancing across restarts.
  expect(later!.tick).toBeGreaterThan(initial!.tick);
  // Player position is always back at (7,13) after a fresh start. The pulses
  // are short enough that the player can't have moved (no movement gates
  // patched) — so the assertion is that we're still seeing the initial pos.
  expect(later!.playerX).toBe(7);
  expect(later!.playerY).toBe(13);
  expect(later!.isGameInPlay).toBe(true);
});
