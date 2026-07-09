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

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

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

/** Wait until the game has actually BOOTED — i.e. the bundle's `player`
 *  (Skier) instance exists. `window.SkiFree.create()` returns a controller
 *  synchronously, but the game's classes (player/game) are only built after
 *  the two sprite-sheet PNGs finish loading (loadImagesThen → buildGame), an
 *  async step. Until then `_forceCrash`/`_forceEaten` are no-ops (`if
 *  (!player) return;`), so firing immediately after `waitForController`
 *  raced the image load and intermittently left the counters at 0. We detect
 *  readiness by firing a probe crash and checking the controller's own
 *  getState().crashes actually moves (the cheapest stable boot signal the
 *  controller exposes; the probe crash is accounted for by reading the
 *  baseline AFTER readiness in the event helper). */
async function waitForGameReady(page: Page, timeout = 10000): Promise<boolean> {
  try {
    await page.waitForFunction(() => {
      const w = globalThis as unknown as {
        __skifree?: { controller?: { _forceCrash(): void; getState(): { crashes: number } } };
      };
      const ctl = w.__skifree?.controller;
      if (!ctl) return false;
      const before = ctl.getState().crashes;
      ctl._forceCrash();
      return ctl.getState().crashes > before;
    }, { timeout, polling: 50 });
    return true;
  } catch { return false; }
}

/**
 * Force a crash / eaten event AND, in the SAME page-side evaluate, immediately
 * sample the downstream SCOPE at sub-pulse granularity, max-holding the peak.
 *
 * Why in-page: the gate is a 10 ms ConstantSourceNode pulse and the SCOPE's
 * analyser buffer is fftSize=2048 (~43 ms at 48 kHz). The pulse is only
 * observable while it's still inside that ~43 ms tail window. A Playwright
 * `forceX(); waitForTimeout(60); readScopeSnapshot()` loop adds a full
 * page->node->page round-trip (plus a 60 ms gap) between firing the pulse and
 * reading the scope, by which point the 10 ms excursion has reliably scrolled
 * out of the analyser buffer — so the scope read always saw peak=0 even though
 * the pulse genuinely reached the audio graph. Doing the fire + the rapid
 * poll loop inside one evaluate removes that latency entirely and catches the
 * pulse deterministically (the excursion is visible in the analyser tail for
 * ~40 ms after the event, so a 250 ms in-page poll at ~2 ms cadence always
 * lands ≥1 read on the high portion).
 *
 * Returns the max ch1 peak seen during the sampling window AND the controller's
 * crash/eaten counters read in the same evaluate, so the caller asserts the
 * counter that this very call advanced (no separate snapshot round-trip that
 * could lag a scheduler tick behind).
 */
async function forceEventAndCapture(
  page: Page,
  event: 'crash' | 'eaten',
  scopeNodeId: string,
): Promise<{ peak: number; crashes: number; eaten: number; lastEvent: string | null }> {
  return await page.evaluate(
    async ({ evt, scId }) => {
      const w = globalThis as unknown as {
        __skifree?: {
          controller?: {
            _forceCrash(): void;
            _forceEaten(): void;
            getState(): { crashes: number; eaten: number; lastEvent: string | null };
          };
        };
        __engine?: () => {
          read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const ctl = w.__skifree?.controller;
      if (evt === 'crash') ctl?._forceCrash();
      else ctl?._forceEaten();
      const st = ctl?.getState() ?? { crashes: 0, eaten: 0, lastEvent: null };

      const eng = w.__engine?.();
      const scNode = w.__patch.nodes[scId];
      let peak = 0;
      if (eng && scNode) {
        const t0 = performance.now();
        // Sample for 250 ms at ~2 ms cadence. The pulse fires at
        // ctx.currentTime+5 ms and is observable in the analyser tail for
        // ~40 ms after it ends, so this window comfortably brackets it.
        while (performance.now() - t0 < 250) {
          const snap = eng.read(scNode, 'snapshot') as { ch1: Float32Array } | undefined;
          if (snap && snap.ch1) {
            const ch1 = snap.ch1;
            for (let i = 0; i < ch1.length; i++) {
              const a = Math.abs(ch1[i]);
              if (a > peak) peak = a;
            }
            if (peak > 0.5) break; // got the pulse — stop early
          }
          await new Promise((r) => setTimeout(r, 2));
        }
      }
      return { peak, crashes: st.crashes, eaten: st.eaten, lastEvent: st.lastEvent };
    },
    { evt: event, scId: scopeNodeId },
  );
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

  await page.goto('/rack');
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

test('skifree: CV patched into x flips cvDriven true (CV overrides mouse)', async ({ page, rack }) => {
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

test('skifree: crash → gate pulse reaches a downstream SCOPE + crash counter increments', async ({ page, rack }) => {
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
  // Wait until the game has booted (sprite sheets loaded → player exists), else
  // _forceCrash is a no-op and the counter never moves. (This probe itself
  // fires one crash; we read the baseline AFTER it so the assertion measures
  // only the crashes this test deliberately drives.)
  expect(await waitForGameReady(page), 'game should boot (player ready)').toBe(true);

  const before = await readSkifreeSnapshot(page, 's');
  expect(before, 'snapshot should be readable').not.toBeNull();
  const crashesBefore = before!.crashes;

  // Fire a crash and, in the same page-side evaluate, immediately sample the
  // SCOPE at sub-pulse granularity so the 10 ms gate excursion is caught
  // before it scrolls out of the analyser's ~43 ms buffer. Retry across a few
  // crashes for robustness (each crash pulses an identical gate; the COUNTER
  // is the deterministic primary assertion, the SCOPE peak the signal-flow
  // assertion that the gate actually reaches the audio graph).
  let scopePeak = 0;
  let crashesNow = crashesBefore;
  let lastEvent: string | null = null;
  for (let i = 0; i < 5 && scopePeak <= 0.5; i++) {
    const r = await forceEventAndCapture(page, 'crash', 'sc');
    if (r.peak > scopePeak) scopePeak = r.peak;
    crashesNow = r.crashes;
    lastEvent = r.lastEvent;
  }

  expect(crashesNow, 'crash counter must increment').toBeGreaterThan(crashesBefore);
  expect(lastEvent).toBe('crash');
  expect(scopePeak, `gate pulse should reach SCOPE (peak=${scopePeak})`).toBeGreaterThan(0.5);
});

test('skifree: eaten-by-yeti → gate pulse + eaten counter increments', async ({ page, rack }) => {
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
  // Wait until the game has booted before firing — see the crash test.
  expect(await waitForGameReady(page), 'game should boot (player ready)').toBe(true);

  const before = await readSkifreeSnapshot(page, 's');
  const eatenBefore = before?.eaten ?? 0;

  // Same in-page fire + fast-sample approach as the crash test (see
  // forceEventAndCapture): the eaten path pulses the identical 10 ms gate.
  let scopePeak = 0;
  let eatenNow = eatenBefore;
  let lastEvent: string | null = null;
  for (let i = 0; i < 5 && scopePeak <= 0.5; i++) {
    const r = await forceEventAndCapture(page, 'eaten', 'sc');
    if (r.peak > scopePeak) scopePeak = r.peak;
    eatenNow = r.eaten;
    lastEvent = r.lastEvent;
  }

  expect(eatenNow, 'eaten counter must increment').toBeGreaterThan(eatenBefore);
  expect(lastEvent).toBe('eaten');
  expect(scopePeak, `eaten gate pulse should reach SCOPE (peak=${scopePeak})`).toBeGreaterThan(0.5);
});
