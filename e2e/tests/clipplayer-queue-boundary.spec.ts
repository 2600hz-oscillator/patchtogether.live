// e2e/tests/clipplayer-queue-boundary.spec.ts
//
// Deluge launch quantization end-to-end (the owner-locked fix): with QNT on, a
// clip launched into an IDLE lane does NOT fire immediately while other clips
// play — it QUEUES and drops in at the next loop boundary of the LONGEST
// currently-playing clip (the shared reference bar). The exact boundary-timing
// math is pinned deterministically by the pure unit test
// (clip-launch-quantize.test.ts) and the engine unit test (clipplayer.test.ts);
// here we prove the real, synced end-to-end observable — the launch is QUEUED
// (not immediately playing) while a long clip loops, then becomes PLAYING — plus
// the escape: with NOTHING playing a QNT-on launch fires immediately.
//
// We read the SYNCED `playing`/`queued` set (what every peer + LED sees + what
// the audio engine consumes), not transient timing, so the assertion is stable
// on CI.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

const CP = 'qb-cp';

// A LONG (16-step) clip in lane 0, a SHORT (4-step) clip in lane 1, and a target
// clip in lane 2. clipIndex(slot, lane) = lane*64 + slot.
const LONG_CLIP = {
  kind: 'note', lengthSteps: 16, root: 48, loop: true,
  steps: Array.from({ length: 16 }, (_, s) => ({ step: s, midi: 60, velocity: 127, lengthSteps: 1 })),
};
const SHORT_CLIP = {
  kind: 'note', lengthSteps: 4, root: 48, loop: true,
  steps: Array.from({ length: 4 }, (_, s) => ({ step: s, midi: 64, velocity: 127, lengthSteps: 1 })),
};
const TARGET_CLIP = {
  kind: 'note', lengthSteps: 4, root: 48, loop: true,
  steps: [{ step: 0, midi: 67, velocity: 127, lengthSteps: 1 }],
};

/** Set every TIMELORDE running at a fixed bpm (create one if none). */
async function setTransport(page: import('@playwright/test').Page, running: number) {
  await page.evaluate((run) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type?: string; params?: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const tls = Object.values(w.__patch.nodes).filter((n) => n.type === 'timelorde');
      if (tls.length === 0) {
        w.__patch.nodes['tl-qb'] = {
          id: 'tl-qb', type: 'timelorde', domain: 'audio', position: { x: 0, y: 0 },
          params: { running: run, bpm: 120 }, data: {},
        } as never;
      } else {
        for (const n of tls) {
          if (!n.params) n.params = {};
          n.params.running = run;
          n.params.bpm = 120;
        }
      }
    });
  }, running);
}

/** Queue a per-lane launch/stop on the clip player (the synced field every pad
 *  surface writes). `immediate` sets the per-lane NOW override. */
async function queueLaunch(
  page: import('@playwright/test').Page,
  lanes: { lane: number; slot: number | 'stop' }[],
  immediate = false,
) {
  await page.evaluate(({ lanes, immediate }) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['qb-cp'];
      if (!n.data) n.data = {};
      const q = Array.isArray(n.data.queued) ? (n.data.queued as (number | 'stop' | null)[]).slice() : new Array(8).fill(null);
      const qi = Array.isArray(n.data.queuedImmediate) ? (n.data.queuedImmediate as boolean[]).slice() : new Array(8).fill(false);
      for (const { lane, slot } of lanes) {
        q[lane] = slot;
        if (immediate) qi[lane] = true;
      }
      n.data.queued = q;
      n.data.queuedImmediate = qi;
    });
  }, { lanes, immediate });
}

/** The clip player's synced per-lane `playing` and `queued` arrays. */
async function readState(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type?: string; data?: { playing?: unknown[]; queued?: unknown[] } }> };
    };
    const cp = Object.values(w.__patch.nodes).find((n) => n.type === 'clipplayer');
    return { playing: cp?.data?.playing ?? [], queued: cp?.data?.queued ?? [] };
  });
}

async function spawnClipPlayer(page: import('@playwright/test').Page, quantize: number) {
  await page.goto('/rack');
  await spawnPatch(page, [
    { id: CP, type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio',
      params: { quantize, stepDiv: 2, gateLength: 0.9, octave: 0 } },
  ]);
  await page.locator('.svelte-flow__node-clipplayer').first().waitFor({ state: 'visible' });
  // Seed the three clips.
  await page.evaluate(({ long, short, target }) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['qb-cp'];
      if (!n.data) n.data = {};
      n.data.clips = {
        '0': long, // clipIndex(0,0) — lane 0 slot 0 (LONG)
        '65': short, // clipIndex(1,1) — lane 1 slot 1 (SHORT)
        '130': target, // clipIndex(2,2) — lane 2 slot 2 (target)
      };
    });
  }, { long: LONG_CLIP, short: SHORT_CLIP, target: TARGET_CLIP });
}

test('@clipplayer QNT launch into an idle lane QUEUES to the long boundary (not immediate)', async ({ page }) => {
  await spawnClipPlayer(page, /* quantize */ 1);

  // Launch the LONG (lane 0) + SHORT (lane 1) together, then run the transport.
  // Nothing is playing yet → both start immediately (the "no reference bar" case).
  await queueLaunch(page, [{ lane: 0, slot: 0 }, { lane: 1, slot: 1 }]);
  await setTransport(page, 1);
  await expect
    .poll(async () => (await readState(page)).playing?.[0], { timeout: 5000 })
    .toBe(0);
  await expect.poll(async () => (await readState(page)).playing?.[1], { timeout: 5000 }).toBe(1);

  // Let them loop for a beat so the LONG clip is genuinely the reference bar.
  await page.waitForTimeout(500);

  // Now launch the target into IDLE lane 2 (QNT on, no NOW). It must NOT play
  // immediately — it stays QUEUED until the long clip's next loop boundary
  // (~2 s away at 120 bpm / 1/16 / 16 steps).
  await queueLaunch(page, [{ lane: 2, slot: 2 }]);
  await page.waitForTimeout(400);
  const mid = await readState(page);
  expect(mid.playing?.[2], 'lane 2 is NOT playing yet (queued, not immediate)').not.toBe(2);
  expect(mid.queued?.[2], 'lane 2 is still QUEUED (flashing)').toBe(2);

  // Given the full long loop, it drops in — lane 2 becomes PLAYING.
  await expect
    .poll(async () => (await readState(page)).playing?.[2], { timeout: 5000 })
    .toBe(2);
});

test('@clipplayer QNT launch with NOTHING playing fires immediately (no reference bar)', async ({ page }) => {
  await spawnClipPlayer(page, /* quantize */ 1);
  await setTransport(page, 1);

  // Nothing is playing → a QNT-on launch starts the groove now.
  await queueLaunch(page, [{ lane: 2, slot: 2 }]);
  await expect
    .poll(async () => (await readState(page)).playing?.[2], { timeout: 5000 })
    .toBe(2);
});
