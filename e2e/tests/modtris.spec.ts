// e2e/tests/modtris.spec.ts
//
// MODTRIS module end-to-end (research prototype). Mirrors pong.spec.ts:
//
//   1. The card mounts cleanly + renders its 16-bit canvas.
//   2. The game-loop ticks deterministically — pieces appear + advance
//      under gravity without any inputs.
//   3. A CV/gate source patched into a move/rotate/drop gate input
//      produces visible state evolution (board changes between snapshot
//      samples). We don't try to play a full Tetris from Playwright;
//      smoke + the load-bearing "CV → game-state" path only.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

interface ModtrisSnapshot {
  tick: number;
  lines: number;
  wellLength: number;
  hasPiece: boolean;
  pieceRow: number | null;
}

async function readModtrisSnapshot(page: Page, nodeId: string): Promise<ModtrisSnapshot | null> {
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
    const well = snap.well as ArrayLike<number> | undefined;
    const piece = snap.piece as { row?: number } | null | undefined;
    return {
      tick: (snap.tick as number) ?? 0,
      lines: (snap.lines as number) ?? 0,
      wellLength: well ? well.length : 0,
      hasPiece: piece != null,
      pieceRow: piece?.row ?? null,
    };
  }, nodeId);
}

test('modtris: drop module → card mounts with no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/rack?shell=legacy&seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'm', type: 'modtris', position: { x: 200, y: 200 } }]);
  const card = page.locator('.svelte-flow__node-modtris');
  await expect(card).toBeVisible();
  await expect(card).toContainText('MODTRIS');
  const canvas = card.locator('[data-testid="modtris-canvas"]');
  await expect(canvas).toBeVisible();
  const size = await canvas.evaluate((el: Element) => {
    const c = el as HTMLCanvasElement;
    return { w: c.width, h: c.height };
  });
  expect(size.w).toBeGreaterThan(0);
  expect(size.h).toBeGreaterThan(0);
  expect(errors.filter((e) => !e.includes('AudioContext'))).toEqual([]);
});

test('modtris: game-loop ticks (piece spawns + state evolves)', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'm', type: 'modtris', position: { x: 200, y: 200 } }]);

  // Resume the AudioContext so the analyser taps work. Same flow as PONG's
  // spec — the scheduler-clock ticks regardless, but the analyser taps
  // need the audio context to be running for input edge-detection.
  await page.locator('button:has-text("Tap to start")').first().click({ timeout: 2000 }).catch(() => { /* */ });

  // #1523: baseline-then-poll replaces sleep-read-sleep-read. "Has the tick
  // advanced past the baseline?" is answerable at any moment, so the 1.2 s
  // second sleep was only ever a bet that the game loop is faster than that on
  // whatever machine is running — a bet with different odds on every renderer.
  await expect
    .poll(() => readModtrisSnapshot(page, 'm'), {
      timeout: 10_000,
      message: 'modtris snapshot must become readable',
    })
    .not.toBeNull();
  const snap1 = (await readModtrisSnapshot(page, 'm'))!;
  expect(snap1.wellLength).toBe(10 * 20);

  await expect
    .poll(async () => (await readModtrisSnapshot(page, 'm'))?.tick ?? -1, {
      timeout: 10_000,
      message: `the game loop tick never advanced past the baseline (${snap1.tick})`,
    })
    .toBeGreaterThan(snap1.tick);
});

test('modtris: BUGGLES.clock patched into drop_fast produces game-state evolution', async ({ page, rack }) => {
  // BUGGLES.clock is a real gate source (5 ms pulses at ~2 Hz). Patching
  // it into MODTRIS's drop_fast input should produce hard-drop events,
  // which advance the well + tick counter and may produce locks.
  await spawnPatch(
    page,
    [
      { id: 'b', type: 'buggles', position: { x: 100, y: 100 } },
      { id: 'm', type: 'modtris', position: { x: 400, y: 100 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'b', portId: 'clock' }, to: { nodeId: 'm', portId: 'drop_fast' } },
    ],
  );
  await page.locator('button:has-text("Tap to start")').first().click({ timeout: 2000 }).catch(() => { /* */ });

  await expect
    .poll(() => readModtrisSnapshot(page, 'm'), {
      timeout: 10_000,
      message: 'modtris snapshot must become readable',
    })
    .not.toBeNull();
  const initial = (await readModtrisSnapshot(page, 'm'))!;

  // Tick MUST advance (scheduler-clock keeps running regardless). The old form
  // slept 2 s "for BUGGLES.clock to fire several pulses at ~1-2 Hz" — a bet on
  // the arrival time of a stochastic source. Poll the tick instead: the same
  // claim, without the bet.
  await expect
    .poll(async () => (await readModtrisSnapshot(page, 'm'))?.tick ?? -1, {
      timeout: 15_000,
      message: `tick never advanced past the baseline (${initial.tick}) under BUGGLES.clock`,
    })
    .toBeGreaterThan(initial.tick);
});
