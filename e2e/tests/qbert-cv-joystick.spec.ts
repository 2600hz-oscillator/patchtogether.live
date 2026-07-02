// e2e/tests/qbert-cv-joystick.spec.ts
//
// QBERT CV → joystick → evt_move gate path.
//
// SKIPS unless the QBERT ROM is locally installed (mirror of DOOM's
// doomWadPresent skip pattern) — the ROM is gitignored + user-provided,
// so CI runs without it.
//
// When the ROM is present:
//   1. Spawn QBERT
//   2. Drive coin_in HIGH (rising edge) → coin inserted
//   3. Drive start_in HIGH (rising edge) → game started
//   4. Drive joy_x → +0.8 (joystick south-east)
//   5. Wait for the runtime to fire `evt_move` events; assert the CSN
//      pulses are observable on the audio_out / evt_move gate via the
//      module's forcePulse-style read hook (we read the runtime's
//      drainEvents through the module extras).
//
// We DON'T wire QBERT → SCOPE end-to-end here — the cross-domain gate→audio
// bridge is exercised by the DOOM evt_kill suite; this spec proves the
// CV-INPUT → runtime joystick → evt_move RUNTIME path.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

async function isRomPresent(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    try {
      const r = await fetch('/roms/qbert/qbert.zip', { method: 'HEAD' });
      return r.ok;
    } catch {
      return false;
    }
  });
}

async function setParam(page: Page, nodeId: string, paramId: string, value: number): Promise<void> {
  await page.evaluate(
    ({ id, k, v }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          setParam: (
            node: { id: string; type: string; domain: string; params: Record<string, number> },
            paramId: string,
            value: number,
          ) => void;
        } | null;
        __patch: {
          nodes: Record<string, { id: string; type: string; domain: string; params: Record<string, number> }>;
        };
      };
      const eng = w.__engine?.();
      const node = w.__patch.nodes[id];
      if (!eng || !node) return;
      node.params[k] = v;
      eng.setParam(node, k, v);
    },
    { id: nodeId, k: paramId, v: value },
  );
}

/** Read the runtime's pending event queue (snapshot — does NOT drain
 *  it, so the next-poll comparison still sees the same events). */
async function readEventCount(page: Page, nodeId: string): Promise<number> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    const node = w.__patch.nodes[id];
    if (!eng || !node) return 0;
    const extras = eng.read(node, 'extras') as
      | {
          getRuntime: () => {
            drainEvents: () => { type: string; tic: number }[];
            isInitialized: () => boolean;
          } | null;
        }
      | undefined;
    const rt = extras?.getRuntime?.() ?? null;
    if (!rt || !rt.isInitialized()) return 0;
    // We DO drain on read here — the test's loop drives a fresh event
    // stream + counts what we've seen since the previous tick.
    const evts = rt.drainEvents();
    return evts.filter((e) => e.type === 'move').length;
  }, nodeId);
}

test('qbert: ROM present + coin+start+joy_x=+0.8 → evt_move events fire', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  if (!(await isRomPresent(page))) {
    test.skip(
      true,
      'qbert.zip is not in packages/web/static/roms/qbert/ — run `task setup:qbert` to enable this spec',
    );
  }

  await spawnPatch(page, [
    { id: 'q', type: 'qbert', position: { x: 200, y: 200 }, domain: 'video' },
  ]);
  const card = page.locator('.svelte-flow__node-qbert');
  await expect(card).toBeVisible();

  // Wait for the ROM load to settle (it's async — the runtime swaps in
  // once the fetch + parseRomZip resolve). The card's `loaded` flag
  // flips true after the swap.
  await page.waitForFunction(
    (id) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      const node = w.__patch.nodes[id];
      if (!eng || !node) return false;
      return eng.read(node, 'loaded') === true;
    },
    'q',
    { timeout: 8000, polling: 100 },
  );

  // Drive the gates + joystick. Rising-edge convention: a 1-then-0
  // sequence yields one rising edge; we hold the gate HIGH because the
  // edge detector is hysteresis-based + the runtime only acts on the
  // press (insertCoin / pressStart are single-shot).
  await setParam(page, 'q', 'cv_coin_in', 1);
  await page.waitForTimeout(20);
  await setParam(page, 'q', 'cv_start_in', 1);
  await page.waitForTimeout(20);
  await setParam(page, 'q', 'cv_joy_x', 0.8);
  // joy_y stays 0 — pure-x falls into the SE diagonal via the inactive-
  // axis bias (see joy-cv.ts).

  // Drain any events that fired during the gate writes (these don't
  // count toward the move-event check — the runtime starts firing
  // moves only after enough tics elapse with a direction held).
  await readEventCount(page, 'q');

  // Wait up to 4s for the engine's rAF loop to drive the runtime
  // through enough tics that the synthetic move-event stream fires at
  // least once. The synthetic cadence is "one move event every 8 internal
  // tics" while a direction is held; runTic is called once per video
  // frame (~16 ms at 60 fps), so the first event lands within ~130 ms
  // under the engine + ample headroom for CI rAF throttling.
  const ok = await page.waitForFunction(
    async (id) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      const node = w.__patch.nodes[id];
      if (!eng || !node) return false;
      const extras = eng.read(node, 'extras') as
        | {
            getRuntime: () => {
              drainEvents: () => { type: string; tic: number }[];
              isInitialized: () => boolean;
            } | null;
          }
        | undefined;
      const rt = extras?.getRuntime?.() ?? null;
      if (!rt || !rt.isInitialized()) return false;
      const evts = rt.drainEvents();
      return evts.some((e) => e.type === 'move');
    },
    'q',
    { timeout: 5000, polling: 100 },
  );

  expect(ok).toBeTruthy();
});
