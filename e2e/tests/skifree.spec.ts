// e2e/tests/skifree.spec.ts
//
// SKIFREE module end-to-end. This is the dedicated spec the per-port
// EXEMPT_OUTPUT_EMIT entry (`skifree.gate` / `skifree.out`) cross-references:
// the gate output ONLY fires on an in-game crash / eaten-by-yeti event, so
// the generic per-port sweep can't reach it — we drive the skier into a
// crash (and an eat) here via the bundle controller's test hooks and assert:
//
//   1. The card mounts cleanly + the canvas renders, and the PatchPanel
//      surfaces the x/y CV inputs + the gate / out outputs (handle presence).
//   2. CV → cursor: a CV source patched into `x` flips the snapshot's
//      `cvDriven` true (CV overrides the native-mouse path) and the engine
//      writes the synthesized cursor into the controller.
//   3. CRASH → gate: forcing the skier into an obstacle (controller
//      ._forceCrash) increments the snapshot crash counter AND pulses the
//      `gate` output, which a downstream SCOPE observes as a non-zero peak.
//   4. EATEN → gate: the yeti catching the skier (controller._forceEaten)
//      increments the eaten counter AND pulses the same gate.
//
// The bundle self-drives via rAF, so we don't need to wait on game RNG to
// reach the gate — the controller hooks fire the exact same hasHitObstacle
// path a real crash/eat would.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { readScopeSnapshot, summarize } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

interface SkifreeSnapshot {
  tick: number;
  distance: number;
  lives: number;
  crashes: number;
  eaten: number;
  lastEvent: 'crash' | 'eaten' | null;
  gameOver: boolean;
  cvDriven: boolean;
}

async function readSkifreeSnapshot(page: Page, nodeId: string): Promise<SkifreeSnapshot | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const node = w.__patch.nodes[id];
    if (!node) return null;
    const snap = eng.read(node, 'snapshot') as SkifreeSnapshot | undefined;
    return snap ?? null;
  }, nodeId);
}

/** Wait until the bundle controller is live on window.__skifree (the card
 *  creates it after the <script> bundle loads). */
async function waitForController(page: Page, timeout = 8000): Promise<boolean> {
  try {
    await page.waitForFunction(() => {
      const w = globalThis as unknown as { __skifree?: { controller?: unknown } };
      return !!w.__skifree?.controller;
    }, { timeout });
    return true;
  } catch { return false; }
}

async function forceCrash(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as unknown as { __skifree?: { controller?: { _forceCrash(): void } } };
    w.__skifree?.controller?._forceCrash();
  });
}

async function forceEaten(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as unknown as { __skifree?: { controller?: { _forceEaten(): void } } };
    w.__skifree?.controller?._forceEaten();
  });
}

async function resumeAudio(page: Page): Promise<void> {
  // Same flow as the other game specs — resume the AudioContext so the
  // scheduler-clock subscribers (the CV-tap reader + snapshot updater) fire.
  await page.locator('button:has-text("Tap to start")').first()
    .click({ timeout: 2000 }).catch(() => { /* already running */ });
}

test('skifree: card mounts, canvas renders, x/y inputs + gate/out outputs present', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 's', type: 'skifree', position: { x: 200, y: 160 } }]);

  const card = page.locator('.svelte-flow__node-skifree');
  await expect(card).toBeVisible();
  await expect(card).toContainText('SKIFREE');

  const canvas = card.locator('[data-testid="skifree-canvas"]');
  await expect(canvas).toBeVisible();
  const size = await canvas.evaluate((el: Element) => {
    const c = el as HTMLCanvasElement;
    return { w: c.width, h: c.height };
  });
  expect(size.w).toBeGreaterThan(0);
  expect(size.h).toBeGreaterThan(0);

  // Handle presence: x/y CV inputs + gate/out outputs render as patch handles.
  await expect(card.locator('[data-handleid="x"]')).toHaveCount(1);
  await expect(card.locator('[data-handleid="y"]')).toHaveCount(1);
  await expect(card.locator('[data-handleid="gate"]')).toHaveCount(1);
  await expect(card.locator('[data-handleid="out"]')).toHaveCount(1);

  expect(errors.filter((e) => !e.includes('AudioContext'))).toEqual([]);
});

test('skifree: CV patched into x flips cvDriven true (CV overrides mouse)', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  // BUGGLES.smooth is a continuous ±1 CV source — patch it into x so the
  // factory's CV tap sees a non-zero connection and flips cvDriven.
  await spawnPatch(
    page,
    [
      { id: 'b', type: 'buggles', position: { x: 80, y: 80 } },
      { id: 's', type: 'skifree', position: { x: 420, y: 80 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'b', portId: 'smooth' }, to: { nodeId: 's', portId: 'x' } },
    ],
  );
  await resumeAudio(page);
  await expect.poll(async () => {
    const snap = await readSkifreeSnapshot(page, 's');
    return snap?.cvDriven ?? false;
  }, { timeout: 6000, message: 'cvDriven should flip true once a CV source is patched into x' }).toBe(true);
});

test('skifree: crash → gate pulse reaches a downstream SCOPE + crash counter increments', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 's', type: 'skifree', position: { x: 120, y: 120 } },
      { id: 'sc', type: 'scope', position: { x: 520, y: 120 } },
    ],
    [
      { id: 'e1', from: { nodeId: 's', portId: 'gate' }, to: { nodeId: 'sc', portId: 'ch1' }, sourceType: 'gate', targetType: 'audio' },
    ],
  );
  await resumeAudio(page);
  expect(await waitForController(page), 'bundle controller should come up').toBe(true);

  const before = await readSkifreeSnapshot(page, 's');
  expect(before, 'snapshot should be readable').not.toBeNull();
  const crashesBefore = before!.crashes;

  // Fire crashes in a windowed loop + poll the SCOPE: each crash pulses the
  // 10 ms gate, and we want at least one pulse to land inside a scope frame.
  // The crash COUNTER is the deterministic primary assertion; the SCOPE peak
  // is the signal-flow (gate actually reaches the audio graph) assertion.
  let scopePeak = 0;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await forceCrash(page);
    await page.waitForTimeout(60);
    const snap = await readScopeSnapshot(page, 'sc');
    if (snap) {
      const p = summarize(snap.ch1).peak;
      if (p > scopePeak) scopePeak = p;
      if (scopePeak > 0.5) break;
    }
  }

  const after = await readSkifreeSnapshot(page, 's');
  expect(after, 'snapshot should still be readable').not.toBeNull();
  expect(after!.crashes, 'crash counter must increment').toBeGreaterThan(crashesBefore);
  expect(after!.lastEvent).toBe('crash');
  expect(scopePeak, `gate pulse should reach SCOPE (peak=${scopePeak})`).toBeGreaterThan(0.5);
});

test('skifree: eaten-by-yeti → gate pulse + eaten counter increments', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 's', type: 'skifree', position: { x: 120, y: 120 } },
      { id: 'sc', type: 'scope', position: { x: 520, y: 120 } },
    ],
    [
      { id: 'e1', from: { nodeId: 's', portId: 'gate' }, to: { nodeId: 'sc', portId: 'ch1' }, sourceType: 'gate', targetType: 'audio' },
    ],
  );
  await resumeAudio(page);
  expect(await waitForController(page)).toBe(true);

  const before = await readSkifreeSnapshot(page, 's');
  const eatenBefore = before?.eaten ?? 0;

  let scopePeak = 0;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await forceEaten(page);
    await page.waitForTimeout(60);
    const snap = await readScopeSnapshot(page, 'sc');
    if (snap) {
      const p = summarize(snap.ch1).peak;
      if (p > scopePeak) scopePeak = p;
      if (scopePeak > 0.5) break;
    }
  }

  const after = await readSkifreeSnapshot(page, 's');
  expect(after, 'snapshot should be readable').not.toBeNull();
  expect(after!.eaten, 'eaten counter must increment').toBeGreaterThan(eatenBefore);
  expect(after!.lastEvent).toBe('eaten');
  expect(scopePeak, `eaten gate pulse should reach SCOPE (peak=${scopePeak})`).toBeGreaterThan(0.5);
});
