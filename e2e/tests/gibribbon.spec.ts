// e2e/tests/gibribbon.spec.ts
//
// GIBRIBBON (the AUDIO-IN rewrite) — smoke + gameplay integration +
// gate-bridge coverage against the LEGACY shell (the `rack` fixture's
// surface; the faceplate half lives in gibribbon-face.spec.ts).
//
//   1. The card mounts cleanly with the 1024×576 playfield rendering
//      non-black (the white vector ribbon).
//   2. ATTRACT is HONEST: a bare module self-plays (score grows, the
//      lookahead lane fills with varied kinds) AND reports mode 'attract'.
//   3. The REAL CHAINS play, both of them:
//      - a fake navigator gamepad → the GAMEPAD module → cables →
//        gibribbon's button/axis jacks → the judge (presses counted, aim
//        written);
//      - a REAL AUDIO CABLE (noise → audio_in): MOVING audio wakes attract
//        into a live run and the analysed signal spawns events — "events
//        should only happen based on audio", proven through the cable.
//   4. Deterministic play via the `__gibribbonTestBands` seam: a band spike
//      spawns its mapped event, the correct press clears it (score up);
//      an uncleared event HITS the marine (health drops).
//   5. THE DEATH PATH (the owner's bug): repeated uncleared events degrade
//      the marine to GAME OVER, and the restart PORT starts a fresh run.
//   6. forcePulse bridges every event gate into a downstream SCOPE.ch1.
//
// DETERMINISTIC BY DESIGN: assertions read the engine's `read` state or a
// SCOPE analyser snapshot; timing is polled on engine observables (the ONE
// transport is the internal tempo — course ticks land every ~420 ms at the
// default knobs, so polls, not sleeps).

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch, type SpawnEdge } from './_helpers';
import { collectPageErrors } from './_page-errors';
import { AUDIO_READY_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';
import { pollGatePulsePeak, gatePulseMsg } from '../_helpers/scope-poll';

test.describe.configure({ mode: 'serial' });

/** Drive an input param (mirrors a patched cable's setParam write). */
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
        __patch: { nodes: Record<string, { id: string; type: string; domain: string; params: Record<string, number> }> };
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

/** Pulse a discrete input: rising edge then falling edge (edges are QUEUED
 *  by the factory, so no sleep is needed between the two writes). */
async function pulse(page: Page, nodeId: string, paramId: string): Promise<void> {
  await setParam(page, nodeId, paramId, 1);
  await setParam(page, nodeId, paramId, 0);
}

/** The deterministic AUDIO seam: while set, the factory feeds these four
 *  band levels to the extractor instead of its analyser fold (test-only —
 *  the analyser path is covered by the live-cable test below). */
async function setTestBands(page: Page, bands: [number, number, number, number] | null): Promise<void> {
  await page.evaluate((b) => {
    const w = globalThis as unknown as { __gibribbonTestBands?: number[] };
    if (b) w.__gibribbonTestBands = b;
    else delete w.__gibribbonTestBands;
  }, bands);
}

async function readKey(page: Page, nodeId: string, key: string): Promise<unknown> {
  return await page.evaluate(
    ({ id, k }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      const node = w.__patch.nodes[id];
      if (!eng || !node) return null;
      return eng.read(node, k) ?? null;
    },
    { id: nodeId, k: key },
  );
}

async function readNum(page: Page, nodeId: string, key: string): Promise<number | null> {
  const v = await readKey(page, nodeId, key);
  return typeof v === 'number' ? v : null;
}
async function readStr(page: Page, nodeId: string, key: string): Promise<string | null> {
  const v = await readKey(page, nodeId, key);
  return typeof v === 'string' ? v : null;
}

/** Put the module into deterministic PLAY mode (attract off — self-play
 *  stops on the next tick; the toggle is honest). */
async function deterministicPlay(page: Page, nodeId: string): Promise<void> {
  await setParam(page, nodeId, 'autoplay', 0);
  await expect.poll(async () => readStr(page, nodeId, 'mode'), { timeout: 5000 }).toBe('play');
}

/** Wait until the internal transport has carried the course past the
 *  count-in (it ticks by itself — ~420 ms per course tick at defaults). */
async function warmPastCountIn(page: Page, nodeId: string): Promise<void> {
  await expect
    .poll(async () => readNum(page, nodeId, 'tick'), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(3);
}

/** How many events the lookahead lane is currently showing — the observable
 *  form of "the extractor has spawned something". `read('lane')` is
 *  `upcomingLane()`, which lists exactly the UNRESOLVED events still ahead of
 *  the miss point. */
async function laneLength(page: Page, nodeId: string): Promise<number> {
  const lane = (await readKey(page, nodeId, 'lane')) as unknown[] | null;
  return Array.isArray(lane) ? lane.length : 0;
}

/**
 * Spike one band via the test seam until the extractor has actually SPAWNED
 * the event, then drop back to silence — ONE controlled spawn window.
 *
 * ⚠ TWO THINGS ABOUT THIS HELPER ARE LOAD-BEARING, AND THE OLD SHAPE HAD
 * NEITHER.
 *
 * 1. THE SPIKE GOES UP BEFORE `tick` IS SAMPLED. `courseTick()` consumes the
 *    four band levels INSTANTANEOUSLY at the tick boundary — it pushes
 *    `bands[i]` into each channel's history and hands the same array to
 *    `extractSpawn` — so the spike only counts if it is STANDING when a
 *    boundary fires. This helper used to read `t0` first and then raise the
 *    spike. A course tick landing in the gap between those two round-trips
 *    (~420 ms apart at the default tempo, and a loaded shard can stall a CDP
 *    round-trip well past that) already satisfies `tick > t0`, so the very
 *    first poll tore the spike straight back down having never let a boundary
 *    see it. Nothing spawned, and the caller then sat out its ENTIRE timeout
 *    waiting on a game it had given nothing to do — which reads as "the
 *    marine was never hit" or "the press never cleared the imp", i.e. as a
 *    product bug, when the module had behaved perfectly.
 *
 * 2. THE POSTCONDITION IS THE EVENT, NOT THE TICK. One consumed boundary is
 *    still not a spawn: `extractSpawn` vetoes any tick inside
 *    `minSpawnGapEasyTicks` of the last spawn. Holding the spike until the
 *    event is visible in the lookahead lane makes the helper's contract the
 *    thing its callers actually depend on, and turns a rate-limited tick into
 *    "keep the spike up one more tick" instead of a silent no-op.
 *
 * Both callers spike into a run that `deterministicPlay` has just restarted
 * (`restartRun` does `Object.assign(s, newRun(...))`), so the baseline is an
 * empty lane and this anchor cannot be vacuously satisfied by leftovers.
 */
async function spikeBand(page: Page, nodeId: string, band: number): Promise<void> {
  const laneBefore = await laneLength(page, nodeId);
  const bands: [number, number, number, number] = [0, 0, 0, 0];
  bands[band] = 0.95;
  // Spike FIRST — then sample the tick it has to survive.
  await setTestBands(page, bands);
  const t0 = (await readNum(page, nodeId, 'tick')) ?? 0;
  await expect
    .poll(async () => readNum(page, nodeId, 'tick'), {
      timeout: 10_000,
      message: 'a course tick must fire while the spike is standing for the extractor to see it',
    })
    .toBeGreaterThan(t0);
  await expect
    .poll(async () => laneLength(page, nodeId), {
      timeout: 10_000,
      message:
        `band ${band} was spiked to 0.95 across a course tick but no event reached the ` +
        'lookahead lane — the extractor never spawned, so the caller has nothing to judge',
    })
    .toBeGreaterThan(laneBefore);
  await setTestBands(page, [0, 0, 0, 0]);
}

async function readScopePeak(page: Page, scopeNodeId: string): Promise<number | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    const node = w.__patch.nodes[id];
    if (!eng || !node) return null;
    const snap = eng.read(node, 'snapshot') as { ch1: Float32Array } | undefined;
    if (!snap) return null;
    let peak = 0;
    for (let i = 0; i < snap.ch1.length; i++) {
      const a = Math.abs(snap.ch1[i]!);
      if (a > peak) peak = a;
    }
    return peak;
  }, scopeNodeId);
}

test('gibribbon: card mounts cleanly + the playfield renders the white ribbon', async ({ page }) => {
  const errors = collectPageErrors(page);

  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'g', type: 'gibribbon', position: { x: 200, y: 200 }, domain: 'video' },
  ]);

  const card = page.locator('.svelte-flow__node:has([data-shell-type="gibribbon"])');
  await expect(card).toBeVisible();
  await expect(card).toContainText(/gibribbon/i);

  // The playfield lives in the DOCK face body on the default shell (the same
  // GibribbonScreen component, same canvas testid).
  await page.evaluate(() => (globalThis as unknown as { __openDockFullView: (id: string) => void }).__openDockFullView('g'));
  const canvas = page.getByTestId('dock-full-view').locator('[data-testid="gibribbon-screen"]');
  await expect(canvas).toBeVisible();
  const size = await canvas.evaluate((el: Element) => {
    const c = el as HTMLCanvasElement;
    return { w: c.width, h: c.height };
  });
  expect(size.w).toBe(1024);
  expect(size.h).toBe(576);

  // ONE coarse pixel check: the white ribbon line is on screen.
  await expect
    .poll(
      async () =>
        await page.evaluate(() => {
          const c = document.querySelector(
            '[data-testid="dock-full-view"] [data-testid="gibribbon-screen"]',
          ) as HTMLCanvasElement | null;
          if (!c) return 0;
          const ctx = c.getContext('2d');
          if (!ctx) return 0;
          const img = ctx.getImageData(0, 0, c.width, c.height);
          let n = 0;
          for (let i = 0; i < img.data.length; i += 4) {
            if (img.data[i]! > 80 || img.data[i + 1]! > 80 || img.data[i + 2]! > 80) n += 1;
          }
          return n;
        }),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(50);

  // Benign noise is decided in ONE place (`_page-errors.ts`): the gitignored
  // /doom/DOOM1.WAD 404 is the named optional asset (line-art fallback by
  // design); anything else is significant.
  expect(errors.significant()).toEqual([]);
});

test('gibribbon: ATTRACT is honest — a bare module self-plays AND says so', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'g', type: 'gibribbon', position: { x: 200, y: 200 }, domain: 'video' },
  ]);
  await expect(page.locator('.svelte-flow__node:has([data-shell-type="gibribbon"])')).toBeVisible();

  expect(await readStr(page, 'g', 'mode')).toBe('attract');

  // Self-play SCORES (the bot clears through the real judge — and it also
  // deliberately fumbles, so the damage ladder is visible in attract).
  await expect
    .poll(async () => readNum(page, 'g', 'score'), { timeout: 20_000, intervals: [500, 1000, 2000] })
    .toBeGreaterThan(0);

  // …and the lookahead lane shows a varied, readable queue.
  const seenKinds = new Set<string>();
  await expect
    .poll(
      async () => {
        const lane = (await readKey(page, 'g', 'lane')) as { kind: string; button: string }[] | null;
        for (const slot of lane ?? []) {
          seenKinds.add(slot.kind);
          expect(['a', 'b', 'x', 'y']).toContain(slot.button);
        }
        return seenKinds.size;
      },
      { timeout: 20_000, intervals: [250, 250, 500] },
    )
    .toBeGreaterThanOrEqual(3);

  expect(await readStr(page, 'g', 'mode')).toBe('attract');
});

test('gibribbon: REAL AUDIO CABLE — noise into audio_in wakes attract and spawns the course', async ({ page, rack }) => {
  // The owner's redirect, proven through a real cable: an audio module's out
  // → gibribbon.audio_in → the module's OWN analyser → bands → events. The
  // test wiggles the noise LEVEL so the signal MOVES (a stationary source is
  // deliberately not "interesting" — the resting floor holds), which both
  // wakes attract into a live run and drives spawns.
  await spawnPatch(
    page,
    [
      { id: 'n', type: 'noise', position: { x: 80, y: 120 }, domain: 'audio' },
      { id: 'g', type: 'gibribbon', position: { x: 520, y: 120 }, domain: 'video' },
    ],
    [
      {
        id: 'e-audio',
        from: { nodeId: 'n', portId: 'white' },
        to: { nodeId: 'g', portId: 'audio_in' },
        sourceType: 'audio',
        targetType: 'audio',
      } as SpawnEdge,
    ],
  );
  await expect(page.locator('.svelte-flow__node:has([data-shell-type="gibribbon"])')).toBeVisible();

  // Wiggle the source level ~4 Hz from the test (the cable and the analysis
  // are fully real; only the modulation hand is ours) until the audio
  // registers as presence AND the analysed course populates.
  let lvl = 0;
  await expect
    .poll(
      async () => {
        lvl = lvl === 0 ? 1 : 0;
        await setParam(page, 'n', 'level', lvl);
        return await readStr(page, 'g', 'mode');
      },
      { timeout: 20_000, intervals: [120] },
    )
    .toBe('play');

  // …and the analysed signal populates the course (events spawned FROM the
  // cable, nothing else driving).
  await expect
    .poll(
      async () => {
        lvl = lvl === 0 ? 1 : 0;
        await setParam(page, 'n', 'level', lvl);
        const lane = (await readKey(page, 'g', 'lane')) as unknown[] | null;
        return lane?.length ?? 0;
      },
      { timeout: 30_000, intervals: [150] },
    )
    .toBeGreaterThan(0);
});

test('gibribbon: the REAL CHAIN — fake pad → GAMEPAD module → cables → the judge', async ({ page, rack }) => {
  await page.evaluate(() => {
    const fakePad = {
      id: 'Xbox Wireless Controller (STD STUB)',
      index: 0,
      connected: true,
      timestamp: performance.now(),
      mapping: 'standard',
      axes: [0, 0, 0, 0] as number[],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    };
    const w = globalThis as unknown as { __fakePad: typeof fakePad };
    w.__fakePad = fakePad;
    (navigator as unknown as { getGamepads: () => unknown[] }).getGamepads = () => [
      w.__fakePad, null, null, null,
    ];
  });

  await spawnPatch(
    page,
    [
      { id: 'gp', type: 'gamepad', position: { x: 80, y: 120 }, domain: 'audio' },
      { id: 'g', type: 'gibribbon', position: { x: 520, y: 120 }, domain: 'video' },
    ],
    [
      { id: 'e-a', from: { nodeId: 'gp', portId: 'a' }, to: { nodeId: 'g', portId: 'a' }, sourceType: 'gate', targetType: 'gate' },
      { id: 'e-x', from: { nodeId: 'gp', portId: 'x' }, to: { nodeId: 'g', portId: 'x_btn' }, sourceType: 'gate', targetType: 'gate' },
      { id: 'e-lx', from: { nodeId: 'gp', portId: 'lx' }, to: { nodeId: 'g', portId: 'x' }, sourceType: 'cv', targetType: 'cv' },
      { id: 'e-ly', from: { nodeId: 'gp', portId: 'ly' }, to: { nodeId: 'g', portId: 'y' }, sourceType: 'cv', targetType: 'cv' },
    ] as SpawnEdge[],
  );
  await expect(page.locator('.svelte-flow__node:has([data-shell-type="gibribbon"])')).toBeVisible();
  await deterministicPlay(page, 'g');

  const pressesBefore = (await readNum(page, 'g', 'presses')) ?? 0;

  await expect
    .poll(
      async () => {
        await page.evaluate(() => {
          const w = globalThis as unknown as {
            __fakePad?: { buttons: { pressed: boolean; touched: boolean; value: number }[]; timestamp: number };
          };
          if (!w.__fakePad) return;
          w.__fakePad.buttons[0] = { pressed: true, touched: true, value: 1 };
          w.__fakePad.timestamp = performance.now();
        });
        await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
        await page.evaluate(() => {
          const w = globalThis as unknown as {
            __fakePad?: { buttons: { pressed: boolean; touched: boolean; value: number }[]; timestamp: number };
          };
          if (!w.__fakePad) return;
          w.__fakePad.buttons[0] = { pressed: false, touched: false, value: 0 };
          w.__fakePad.timestamp = performance.now();
        });
        return (await readNum(page, 'g', 'presses')) ?? 0;
      },
      { timeout: 15_000, intervals: [100, 200, 400] },
    )
    .toBeGreaterThan(pressesBefore);

  // The stick reaches the AIM axes through the cv cables.
  await page.evaluate(() => {
    const w = globalThis as unknown as { __fakePad?: { axes: number[]; timestamp: number } };
    if (!w.__fakePad) return;
    w.__fakePad.axes = [0.8, -0.6, 0, 0];
    w.__fakePad.timestamp = performance.now();
  });
  await expect
    .poll(
      async () =>
        await page.evaluate((id) => {
          const w = globalThis as unknown as {
            __engine?: () => {
              readParam: (n: { id: string; type: string; domain: string }, k: string) => number | undefined;
            } | null;
            __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
          };
          const eng = w.__engine?.();
          const node = w.__patch.nodes[id];
          if (!eng || !node) return 0;
          return eng.readParam(node, 'axis_x') ?? 0;
        }, 'g'),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0.2);
});

test('gibribbon: a band spike spawns its imp → the correct press clears it (score up)', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'g', type: 'gibribbon', position: { x: 200, y: 200 }, domain: 'video' },
  ]);
  await expect(page.locator('.svelte-flow__node:has([data-shell-type="gibribbon"])')).toBeVisible();
  await deterministicPlay(page, 'g');

  expect(await readNum(page, 'g', 'score')).toBe(0);
  await warmPastCountIn(page, 'g');

  // The adaptive extractor needs a VARYING band: silence primed the
  // baseline, so this spike is a full-range prominence peak on the high-mid
  // band → an IMP spawns.
  await spikeBand(page, 'g', 2);

  // The imp approaches over ~8 course ticks; hammer X until a press lands
  // inside the phase-adjusted window.
  const cleared = await page.waitForFunction(
    ({ id }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
          setParam: (n: { id: string; type: string; domain: string; params: Record<string, number> }, k: string, v: number) => void;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string; params: Record<string, number> }> };
      };
      const eng = w.__engine?.();
      const node = w.__patch.nodes[id];
      if (!eng || !node) return false;
      eng.setParam(node, 'btn_x', 1);
      eng.setParam(node, 'btn_x', 0);
      const s = eng.read(node, 'score');
      return typeof s === 'number' && s > 0;
    },
    { id: 'g' },
    { timeout: 15_000, polling: 60 },
  ).catch(() => null);

  expect(cleared, 'a correct X press should clear the imp and raise the score').toBeTruthy();
  expect(await readNum(page, 'g', 'score')).toBeGreaterThan(0);
  await setTestBands(page, null);
});

test('gibribbon: an uncleared event HITS the marine — health drops below healthy', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'g', type: 'gibribbon', position: { x: 200, y: 200 }, domain: 'video' },
  ]);
  await expect(page.locator('.svelte-flow__node:has([data-shell-type="gibribbon"])')).toBeVisible();
  await deterministicPlay(page, 'g');

  expect(await readStr(page, 'g', 'health')).toBe('healthy');
  await warmPastCountIn(page, 'g');

  // One bass spike, no press: the loop reaches the marine and hits him.
  await spikeBand(page, 'g', 0);
  await expect
    .poll(async () => readStr(page, 'g', 'health'), { timeout: 15_000 })
    .not.toBe('healthy');
  expect(['wounded', 'critical', 'dead']).toContain(await readStr(page, 'g', 'health'));
  await setTestBands(page, null);
});

test('gibribbon: THE DEATH PATH — repeated hits reach GAME OVER, restart PORT revives', async ({ page, rack }) => {
  // The owner's bug, as an e2e: the marine MUST die when hit enough — and
  // the restart gate must bring him back.
  await spawnPatch(page, [
    { id: 'g', type: 'gibribbon', position: { x: 200, y: 200 }, domain: 'video' },
  ]);
  await expect(page.locator('.svelte-flow__node:has([data-shell-type="gibribbon"])')).toBeVisible();
  await deterministicPlay(page, 'g');
  await warmPastCountIn(page, 'g');

  // A metronome of bass spikes with NO presses: every loop that reaches the
  // marine degrades him a form — healthy → wounded → critical → DEAD.
  let hi = true;
  await expect
    .poll(
      async () => {
        hi = !hi;
        await setTestBands(page, hi ? [0.95, 0, 0, 0] : [0, 0, 0, 0]);
        return await readKey(page, 'g', 'dead');
      },
      { timeout: 45_000, intervals: [300] },
    )
    .toBe(true);
  await setTestBands(page, null);
  expect(await readStr(page, 'g', 'health')).toBe('dead');

  // The restart PORT (same paramTarget path a patched cable uses).
  await pulse(page, 'g', 'restart_btn');
  await expect.poll(async () => readStr(page, 'g', 'health'), { timeout: 5000 }).toBe('healthy');
  expect(await readNum(page, 'g', 'score')).toBe(0);
  expect(await readStr(page, 'g', 'mode')).toBe('play');
});

// ── gate-bridge coverage: every event gate reaches a downstream SCOPE ────────
const GATE_PORTS = ['evt_hit', 'evt_miss', 'evt_fire', 'evt_kill', 'evt_gameover'] as const;

for (const port of GATE_PORTS) {
  test(`gibribbon: ${port} bridges into scope.ch1 (forcePulse)`, async ({ page, rack }) => {
    // ⚠ THE INNER CAP MUST FIT INSIDE THE OUTER BUDGET, and the first attempt
    // at this fix did not. Raising the poll to `AUDIO_READY_MS` (30 s on CI)
    // without touching the test budget put a 30 s wait inside Playwright's 30 s
    // default, so the test died at 31.5 s with a BARE `Test timeout` and the
    // poll never got to report its own message — a strictly worse failure than
    // the one being repaired, because it says nothing about the subject.
    // Nested bounds: the budget covers the spawn AND the audio cap.
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS);
    const scopeId = `scope-${port}`;
    await spawnPatch(
      page,
      [
        { id: 'g', type: 'gibribbon', position: { x: 200, y: 120 }, domain: 'video' },
        { id: scopeId, type: 'scope', position: { x: 560, y: 120 }, domain: 'audio' },
      ],
      [
        {
          id: `e-${port}`,
          from: { nodeId: 'g', portId: port },
          to: { nodeId: scopeId, portId: 'ch1' },
          sourceType: 'gate',
          targetType: 'audio', // scope ch1 declared audio; accepts gate via the bridge
        } as SpawnEdge,
      ],
    );
    await expect(page.locator('.svelte-flow__node:has([data-shell-type="gibribbon"])')).toBeVisible();

    expect((await readScopePeak(page, scopeId)) ?? 0).toBeLessThan(0.2);

    // ⚠ THE HAND-ROLLED FIRE-THEN-READ LOOP IS GONE — see `pollGatePulsePeak`.
    // It called `forcePulse` and read the analyser ring in the SAME synchronous
    // tick, so it read the ring BEFORE the pulse had been rendered into it and
    // depended on a LATER round trip coinciding with a still-high window. That
    // coincidence stops happening on a loaded shard, and the failure MOVED
    // between members of this very loop: `evt_hit` on one CI run, `evt_kill`
    // and `evt_miss` on the next. Five interchangeable ports cannot have five
    // separate bridge defects.
    //
    // The seam pulses AND samples in the page, on independent timers, and
    // LATCHES the peak — so a pulse only has to be caught once by any sample,
    // ever, instead of by the one sample that happens to follow it.
    const r = await pollGatePulsePeak(page, {
      sourceNodeId: 'g',
      port,
      scopeNodeId: scopeId,
      threshold: 0.4,
      boundMs: AUDIO_READY_MS,
    });
    expect(r.hookFound, `${port}: extras.forcePulse never resolved — ${gatePulseMsg(port, r)}`).toBe(true);
    expect(
      r.reachedThreshold,
      `${port} should pulse SCOPE.ch1 above the floor via the gate bridge — ${gatePulseMsg(port, r)}`,
    ).toBe(true);
  });
}

// ⚠ THE NEGATIVE CONTROL FOR THE LATCH ITSELF, and it is not optional. A
// monotone "highest peak ever seen" probe is exactly the kind of instrument
// that can quietly stop being able to report ZERO — a stray reading, a wrong
// scope id resolving to a live node, or a latch that starts non-empty would all
// make every port above pass for the wrong reason, forever, and no amount of
// re-running the positive legs could tell.
//
// ⚠ THE FIRST VERSION OF THIS CONTROL WAS WRONG, AND CI CAUGHT IT — WHICH IS
// THE CONTROL WORKING, JUST NOT AT WHAT I AIMED IT. It kept the `evt_hit` edge
// wired and merely stopped PULSING, then required the scope to rest near zero.
// It failed with `peak 1.0000 from 21 sample(s) / 0 pulse(s)`, and the reading
// was HONEST: gibribbon SELF-PLAYS in ATTRACT mode and its demo bot
// deliberately fumbles, so a fumble fires `evt_hit` for real. The probe was
// reporting a pulse the TEST had not sent but the MODULE had — so the leg could
// never distinguish "the latch invented signal" from "the game scored a hit".
//
// The subject is the LATCH, not the module, so the control now removes the only
// path signal could take: gibribbon and the scope are spawned with NO EDGE
// BETWEEN THEM. Nothing the game does can reach ch1. Any non-zero reading is
// then manufactured by the instrument by definition, which is exactly — and
// only — the claim this leg makes.
test('gibribbon: with NO cable, the latched probe reads zero — it cannot manufacture a pulse', async ({
  page,
  rack,
}) => {
  test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS);
  const scopeId = 'scope-control';
  await spawnPatch(page, [
    { id: 'g', type: 'gibribbon', position: { x: 200, y: 120 }, domain: 'video' },
    // Deliberately UNPATCHED — see the note above. The gibribbon is spawned at
    // all so the page carries the same load as the positive legs.
    { id: scopeId, type: 'scope', position: { x: 560, y: 120 }, domain: 'audio' },
  ]);
  await expect(page.locator('.svelte-flow__node:has([data-shell-type="gibribbon"])')).toBeVisible();

  // A SHORTER bound than the positive legs, deliberately: this one is waiting
  // for nothing to happen, so it should spend the whole window and say so
  // rather than exit early.
  const r = await pollGatePulsePeak(page, {
    sourceNodeId: 'g',
    port: 'evt_hit',
    scopeNodeId: scopeId,
    threshold: 0.4,
    boundMs: 3_000,
    pulseEveryMs: 0, // ← the control: arm the latch, never fire
  });

  expect(r.pulses, `the control must not pulse — ${gatePulseMsg('control', r)}`).toBe(0);
  expect(
    r.samples,
    `the control must actually SAMPLE, or it proves nothing — ${gatePulseMsg('control', r)}`,
  ).toBeGreaterThan(0);
  expect(
    r.reachedThreshold,
    `an UNCABLED scope crossed the floor — the latch is reporting signal that had no path to it: ` +
      gatePulseMsg('control', r),
  ).toBe(false);
  expect(
    r.peak,
    `an uncabled scope must rest at zero — ${gatePulseMsg('control', r)}`,
  ).toBeLessThan(0.2);
});
