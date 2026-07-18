// e2e/tests/clipplayer-rate-reset.spec.ts
//
// CLIP PLAYER per-lane clock RATE (mult/div) + RESET, through the REAL chain:
// TIMELORDE (the rack transport) drives the engine's tick loop; the CARD's
// per-lane rate dropdowns + RST button write the synced node state the engine
// consumes; the `reset` gate INPUT is driven by a real cable from a sequencer's
// clock output (the controlled-edge pattern — the source spawns STOPPED so we
// decide exactly when edges arrive).
//
//   1. rate ratio — lanes at 1/2 : 1 : 2x advance in a 1:2:4 step ratio (read
//      atomically off the engine's audio-accurate per-lane playhead).
//   2. RST button — all ACTIVE clips snap back to step 1 (128-step clip → a
//      loop wrap cannot fake the snap).
//   3. reset gate input — clock edges into `reset` hold the playhead near the
//      top; removing them lets it climb again (proves the cable, not a stall).

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

type EngineW = {
  __engine?: () => {
    read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
  } | null;
  __patch: {
    nodes: Record<
      string,
      { id: string; type: string; domain: string; params?: Record<string, number>; data?: Record<string, unknown> }
    >;
  };
  __ydoc: { transact: (fn: () => void) => void };
};

/** Read one engine key for a node (null when the engine isn't up yet). */
async function readEngine(page: Page, nodeId: string, key: string): Promise<number | null> {
  return await page.evaluate(
    ({ id, k }) => {
      const w = globalThis as unknown as EngineW;
      const eng = w.__engine?.();
      const node = w.__patch.nodes[id];
      if (!eng || !node) return null;
      const v = eng.read(node, k);
      return typeof v === 'number' ? v : null;
    },
    { id: nodeId, k: key },
  );
}

/** Poll an engine key until `pred` holds (or time out). Returns the last value. */
async function waitForEngine(
  page: Page,
  nodeId: string,
  key: string,
  pred: (v: number) => boolean,
  timeoutMs: number,
): Promise<{ ok: boolean; last: number | null }> {
  const deadline = Date.now() + timeoutMs;
  let last: number | null = null;
  while (Date.now() < deadline) {
    last = await readEngine(page, nodeId, key);
    if (typeof last === 'number' && pred(last)) return { ok: true, last };
    await page.waitForTimeout(50);
  }
  return { ok: false, last };
}

/** Seed DENSE 128-step note clips (a note every step, so the playhead tracks)
 *  in slot 0 of the given lanes, and queue them — via the same Y.Doc path the
 *  card/grid use. 128 steps ≫ every window here → no loop wrap. */
async function seedDenseClips(page: Page, nodeId: string, lanes: number[]) {
  await page.evaluate(
    ({ id, ls }) => {
      const w = globalThis as unknown as EngineW;
      // Flat clip key is stride-64 (schema v2): clipIndex(slot=0, lane) = lane*64.
      // (The old stride-8 key `lane*8` only matched for lane 0 → lanes 1/2 were
      // never found → "saw -1"; the seed must match the engine's stride.)
      const SCENE_STRIDE = 64;
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes[id];
        if (!n.data) n.data = {};
        const clips: Record<string, unknown> = {};
        const queued: (number | null)[] = new Array(8).fill(null);
        for (const lane of ls) {
          clips[String(lane * SCENE_STRIDE)] = {
            kind: 'note',
            lengthSteps: 128,
            root: 48,
            loop: true,
            steps: Array.from({ length: 128 }, (_, s) => ({ step: s, midi: 72, velocity: 127, lengthSteps: 1 })),
          };
          queued[lane] = 0;
        }
        n.data.clips = clips;
        n.data.sv = 2; // already stride-64 → skip the legacy re-key migration
        n.data.queued = queued;
      });
    },
    { id: nodeId, ls: lanes },
  );
}

/** Flip every TIMELORDE's running (creating one if absent) at a fast bpm. */
async function setTransport(page: Page, running: number, bpm = 240) {
  await page.evaluate(
    ({ run, b }) => {
      const w = globalThis as unknown as EngineW;
      w.__ydoc.transact(() => {
        const tls = Object.values(w.__patch.nodes).filter((n) => n.type === 'timelorde');
        for (const n of tls) {
          if (!n.params) n.params = {};
          n.params.running = run;
          n.params.bpm = b;
        }
      });
    },
    { run: running, b: bpm },
  );
}

test('per-lane rate: card dropdowns set 1/2 : 1 : 2x lanes advancing at a 1:2:4 ratio', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio',
      params: { quantize: 0, stepDiv: 2, gateLength: 0.9, octave: 0 } },
    { id: 'tl', type: 'timelorde', position: { x: 520, y: 80 }, domain: 'audio',
      params: { running: 0, bpm: 240 } },
  ]);
  const card = page.locator('.svelte-flow__node-clipplayer');
  await expect(card).toHaveCount(1);

  // Set the rates on the CARD (the owner's dropdown): lane0=1/2, lane2=2x
  // (lane1 stays at the default '1'). Values are RATE_LABELS indices.
  await page.getByTestId('clipplayer-rate-0').selectOption('2'); // 1/2
  await page.getByTestId('clipplayer-rate-2').selectOption('4'); // 2x
  // The dropdown wrote the synced per-lane state the engine consumes.
  const rate = await page.evaluate(
    () => (globalThis as unknown as EngineW).__patch.nodes['cp'].data?.rate as number[] | undefined,
  );
  expect(rate?.[0]).toBe(2);
  expect(rate?.[1] ?? 3).toBe(3);
  expect(rate?.[2]).toBe(4);

  // Launch dense clips on lanes 0..2 with the transport STOPPED, then start it:
  // the transport-start realign anchors all three lanes to one common origin.
  await seedDenseClips(page, 'cp', [0, 1, 2]);
  await setTransport(page, 1);

  // Let the 2x lane get well into its (no-wrap) 128 steps. base step @240bpm,
  // 1/16 grid = 62.5 ms → 2x ≈ 32 steps/s.
  const going = await waitForEngine(page, 'cp', 'currentStep:2', (v) => v >= 40, 8000);
  expect(going.ok, `2x lane advanced well into the clip (saw ${going.last})`).toBe(true);

  // ONE atomic read of all three playheads (audio-accurate, common origin) —
  // the ratio must be 1:2:4 (÷2 : 1 : ×2), ±2 steps of read slack.
  const [c0, c1, c2] = (await page.evaluate(() => {
    const w = globalThis as unknown as EngineW;
    const eng = w.__engine?.();
    const node = w.__patch.nodes['cp'];
    return [0, 1, 2].map((L) => (eng && node ? Number(eng.read(node, `currentStep:${L}`)) : NaN));
  })) as [number, number, number];
  expect(Number.isFinite(c0) && Number.isFinite(c1) && Number.isFinite(c2)).toBe(true);
  expect(Math.abs(c1 - 2 * c0), `1x (${c1}) ≈ 2 × ÷2 lane (${c0})`).toBeLessThanOrEqual(2);
  expect(Math.abs(c2 - 2 * c1), `2x (${c2}) ≈ 2 × 1x lane (${c1})`).toBeLessThanOrEqual(3);
  expect(Math.abs(c2 - 4 * c0), `2x (${c2}) ≈ 4 × ÷2 lane (${c0})`).toBeLessThanOrEqual(4);
});

test('RST button: all active clips snap back to step 1 and keep playing', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio',
      params: { quantize: 0, stepDiv: 2, gateLength: 0.9, octave: 0 } },
    { id: 'tl', type: 'timelorde', position: { x: 520, y: 80 }, domain: 'audio',
      params: { running: 0, bpm: 240 } },
  ]);
  await expect(page.locator('.svelte-flow__node-clipplayer')).toHaveCount(1);

  await seedDenseClips(page, 'cp', [0, 1]);
  await setTransport(page, 1);

  // Both lanes well past the top (128-step clip → no wrap inside this window).
  const l0 = await waitForEngine(page, 'cp', 'currentStep:0', (v) => v >= 8, 6000);
  expect(l0.ok, `lane 0 mid-clip before reset (saw ${l0.last})`).toBe(true);

  await page.getByTestId('clipplayer-reset').click();

  // Snap: the playhead jumps back near the top LONG before a natural wrap (8 s).
  // The acceptance band is <=6, not <=2: at 240 bpm the clock keeps CLIMBING
  // during the reset's dispatch latency, so a [0,2] window is a race the poll
  // can miss (it caught the playhead already back up at 28 on a loaded CI
  // shard). The pre-reset gate above required step >= 8, so ANY observation
  // <= 6 is unambiguous proof of the backward snap (nothing reads that low
  // before the reset) while tolerating the fast clock — the assertion's
  // meaning is unchanged, only the race is removed.
  //
  // DETECTION TIMEOUT (5000 ms, was 2500): `currentStep` is derived from the
  // AUDIO clock (ctx.currentTime vs pre-scheduled events) and keeps climbing
  // even while the MAIN-THREAD scheduler tick — the only place resetNonce is
  // consumed — is momentarily starved on a loaded CI runner. When that stall
  // ran past 2500 ms the snap hadn't been processed yet and the poll expired at
  // step ~43 (CI-only; passes locally + under 4-worker load). 5000 ms tolerates
  // the stall and is still WELL under the 8 s / 128-step wrap horizon, so a
  // natural loop wrap can never fake the low reading. Band unchanged.
  const snapped0 = await waitForEngine(page, 'cp', 'currentStep:0', (v) => v >= 0 && v <= 6, 5000);
  expect(snapped0.ok, `lane 0 snapped back toward the top (saw ${snapped0.last})`).toBe(true);
  const snapped1 = await waitForEngine(page, 'cp', 'currentStep:1', (v) => v >= 0 && v <= 6, 5000);
  expect(snapped1.ok, `lane 1 snapped with the same reset (saw ${snapped1.last})`).toBe(true);
  // Still PLAYING (reset ≠ stop) and still advancing.
  expect(await readEngine(page, 'cp', 'activeLane:0')).toBe(0);
  const resumed = await waitForEngine(page, 'cp', 'currentStep:0', (v) => v >= 6, 4000);
  expect(resumed.ok, `lane 0 kept advancing after the reset (saw ${resumed.last})`).toBe(true);
});

test('reset gate input: clock edges hold the playhead at the top; removing them frees it', async ({ page, rack }) => {
  await spawnPatch(
    page,
    [
      { id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio',
        params: { quantize: 0, stepDiv: 2, gateLength: 0.9, octave: 0 } },
      { id: 'tl', type: 'timelorde', position: { x: 520, y: 80 }, domain: 'audio',
        params: { running: 0, bpm: 240 } },
      // STOPPED at spawn — we decide exactly when reset edges start/stop.
      // 240 bpm → a clock pulse every 250 ms while playing.
      { id: 'rstSeq', type: 'sequencer', position: { x: 80, y: 460 }, domain: 'audio',
        params: { bpm: 240, length: 4, isPlaying: 0 } },
    ],
    [
      { id: 'e_rst', from: { nodeId: 'rstSeq', portId: 'clock' }, to: { nodeId: 'cp', portId: 'reset' },
        sourceType: 'gate', targetType: 'gate' },
    ],
  );
  await expect(page.locator('.svelte-flow__node-clipplayer')).toHaveCount(1);

  await seedDenseClips(page, 'cp', [0]);
  await setTransport(page, 1);

  const before = await waitForEngine(page, 'cp', 'currentStep:0', (v) => v >= 8, 6000);
  expect(before.ok, `lane 0 mid-clip before edges arrive (saw ${before.last})`).toBe(true);

  // Start the reset clock → a rising edge every 250 ms snaps the lane back.
  await page.evaluate(() => {
    const w = globalThis as unknown as EngineW;
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['rstSeq'];
      if (!n.params) n.params = {};
      n.params.isPlaying = 1;
    });
  });
  const snapped = await waitForEngine(page, 'cp', 'currentStep:0', (v) => v >= 0 && v <= 2, 3000);
  expect(snapped.ok, `reset edge snapped lane 0 to step 1 (saw ${snapped.last})`).toBe(true);
  // While edges keep arriving (every ~4 base steps), the playhead stays pinned
  // near the top — it can never climb anywhere near where it was.
  let maxSeen = -1;
  const holdUntil = Date.now() + 1500;
  while (Date.now() < holdUntil) {
    const v = await readEngine(page, 'cp', 'currentStep:0');
    if (typeof v === 'number' && v > maxSeen) maxSeen = v;
    await page.waitForTimeout(50);
  }
  expect(maxSeen, `playhead held near the top under repeated resets (max ${maxSeen})`).toBeLessThanOrEqual(6);

  // Stop the reset clock → the lane climbs freely again (the wire was the cause).
  await page.evaluate(() => {
    const w = globalThis as unknown as EngineW;
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['rstSeq'];
      if (!n.params) n.params = {};
      n.params.isPlaying = 0;
    });
  });
  const freed = await waitForEngine(page, 'cp', 'currentStep:0', (v) => v >= 8, 6000);
  expect(freed.ok, `playhead climbed again once edges stopped (saw ${freed.last})`).toBe(true);
});
