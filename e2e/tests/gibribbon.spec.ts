// e2e/tests/gibribbon.spec.ts
//
// GIBRIBBON (the REWRITE) — smoke + gameplay integration + gate-bridge
// coverage against the LEGACY shell (the `rack` fixture's surface; the
// faceplate half lives in gibribbon-face.spec.ts).
//
//   1. The card mounts cleanly with the 1024×576 playfield rendering
//      non-black (the white vector ribbon).
//   2. ATTRACT is HONEST: a bare module self-plays (score grows, the
//      lookahead lane fills with varied kinds) AND reports mode 'attract' —
//      the F3 claim, end to end.
//   3. The REAL CHAIN plays: a fake navigator gamepad → the GAMEPAD module →
//      cables → gibribbon's button/axis jacks → the judge (presses counted,
//      aim written) — the spec §2.2 input path with no shortcut.
//   4. Deterministic external-clock play: clock+gate+CV spawn an imp, the
//      correct press clears it (score up); a missed event degrades health.
//   5. The NEW restart PORT hard-resets a run (fresh healthy game).
//   6. forcePulse bridges every event gate into a downstream SCOPE.ch1
//      (the cross-domain video→audio bridge, deterministically).
//
// DETERMINISTIC BY DESIGN: every gameplay assertion reads the engine's `read`
// state (score / health / mode / presses) or a SCOPE analyser snapshot — no
// pixel assertions beyond ONE coarse "is the canvas non-black?" check, and no
// un-annotated waits (readiness is polled on the engine observables; the game
// clock is the shared 25 ms scheduler, so `expect.poll` sees a tick within
// one interval).

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch, type SpawnEdge } from './_helpers';
import { collectPageErrors } from './_page-errors';

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

/** Pulse a discrete input: rising edge then falling edge. No sleep needed —
 *  the factory QUEUES edges (a counter, not a sampled level), so a burst of
 *  pulses is consumed intact by the next scheduler tick. */
async function pulse(page: Page, nodeId: string, paramId: string): Promise<void> {
  await setParam(page, nodeId, paramId, 1);
  await setParam(page, nodeId, paramId, 0);
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

/** Take the transport EXTERNAL and advance past the count-in with flat CV
 *  (nothing can spawn), so the next controlled spawn pulse lands. The first
 *  clock edge takes ownership instantly, pausing the internal tempo. */
async function warmUpPastCountIn(page: Page, nodeId: string): Promise<void> {
  for (const cv of ['cv1', 'cv2', 'cv3', 'cv4']) await setParam(page, nodeId, cv, 0);
  for (let i = 0; i < 4; i++) await pulse(page, nodeId, 'clock');
  // Readiness: ALL queued edges consumed → the course is past the count-in
  // (countInTicks = 2), so the next controlled spawn is eligible.
  await expect
    .poll(async () => readNum(page, nodeId, 'tick'), { timeout: 5000 })
    .toBeGreaterThanOrEqual(3);
}

/** Put the module into deterministic PLAY mode: attract off (self-play stops
 *  on the next tick — the toggle is honest) and confirmed via `mode`. */
async function deterministicPlay(page: Page, nodeId: string): Promise<void> {
  await setParam(page, nodeId, 'autoplay', 0);
  await expect.poll(async () => readStr(page, nodeId, 'mode'), { timeout: 5000 }).toBe('play');
}

/** Spawn ONE event deterministically: hold the channel spike HIGH across the
 *  clock edge until the scheduler tick that consumes it has landed (the
 *  stepper samples levels at TICK time — dropping the spike too early is a
 *  race a real cable never has, since a bridge holds its value). */
async function spawnEventOn(page: Page, nodeId: string, cvId: string): Promise<void> {
  const t0 = (await readNum(page, nodeId, 'tick')) ?? 0;
  await setParam(page, nodeId, cvId, 0.95);
  await setParam(page, nodeId, 'gate', 1);
  await pulse(page, nodeId, 'clock');
  await expect
    .poll(async () => readNum(page, nodeId, 'tick'), { timeout: 5000 })
    .toBeGreaterThan(t0);
  await setParam(page, nodeId, cvId, 0.0);
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

  await page.goto('/rack?shell=legacy&seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'g', type: 'gibribbon', position: { x: 200, y: 200 }, domain: 'video' },
  ]);

  const card = page.locator('.svelte-flow__node-gibribbon');
  await expect(card).toBeVisible();
  await expect(card).toContainText('GIBRIBBON');

  const canvas = card.locator('[data-testid="gibribbon-screen"]');
  await expect(canvas).toBeVisible();
  const size = await canvas.evaluate((el: Element) => {
    const c = el as HTMLCanvasElement;
    return { w: c.width, h: c.height };
  });
  expect(size.w).toBe(1024);
  expect(size.h).toBe(576);

  // ONE coarse pixel check: the white ribbon line is on screen. Polled on the
  // canvas itself (readiness), not a sleep.
  await expect
    .poll(
      async () =>
        await page.evaluate(() => {
          const c = document.querySelector(
            '.svelte-flow__node-gibribbon [data-testid="gibribbon-screen"]',
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
  // The F3 gate, end to end: the old AUTOPLAY crutch made an unpatched module
  // LOOK alive while masking whether the CV path worked. The rewrite's
  // attract mode self-plays through the REAL extractor + judge and REPORTS
  // the mode (the in-canvas ATTRACT label reads from the same state).
  await spawnPatch(page, [
    { id: 'g', type: 'gibribbon', position: { x: 200, y: 200 }, domain: 'video' },
  ]);
  await expect(page.locator('.svelte-flow__node-gibribbon')).toBeVisible();

  expect(await readStr(page, 'g', 'mode')).toBe('attract');

  // Self-play SCORES (the bot clears through the real judge)…
  await expect
    .poll(async () => readNum(page, 'g', 'score'), { timeout: 20_000, intervals: [500, 1000, 2000] })
    .toBeGreaterThan(0);

  // …and the lookahead lane shows a varied, readable queue (≥3 of the four
  // kinds within the opening seconds — the drop-and-play bar).
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

  // Still honestly labelled.
  expect(await readStr(page, 'g', 'mode')).toBe('attract');
});

test('gibribbon: the REAL CHAIN — fake pad → GAMEPAD module → cables → the judge', async ({ page, rack }) => {
  // The spec §2.2 player path with no shortcut: a (monkey-patched) navigator
  // gamepad drives the GAMEPAD module, whose a/x gate outs + lx/ly cv outs
  // cable into gibribbon's buttons and aim axes. Observables: the engine's
  // `presses` counter (a press REACHED the judge) and the axis param the
  // bridge writes.
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
      // Standard-mapping button 2 = X, button 0 = A; left stick = axes 0/1.
      { id: 'e-a', from: { nodeId: 'gp', portId: 'a' }, to: { nodeId: 'g', portId: 'a' }, sourceType: 'gate', targetType: 'gate' },
      { id: 'e-x', from: { nodeId: 'gp', portId: 'x' }, to: { nodeId: 'g', portId: 'x_btn' }, sourceType: 'gate', targetType: 'gate' },
      { id: 'e-lx', from: { nodeId: 'gp', portId: 'lx' }, to: { nodeId: 'g', portId: 'x' }, sourceType: 'cv', targetType: 'cv' },
      { id: 'e-ly', from: { nodeId: 'gp', portId: 'ly' }, to: { nodeId: 'g', portId: 'y' }, sourceType: 'cv', targetType: 'cv' },
    ] as SpawnEdge[],
  );
  await expect(page.locator('.svelte-flow__node-gibribbon')).toBeVisible();
  await deterministicPlay(page, 'g');

  const pressesBefore = (await readNum(page, 'g', 'presses')) ?? 0;

  // Press + release the pad's A button until the judge has seen it (the
  // gamepad factory polls on rAF; the bridge and the scheduler each add a
  // bounded latency, so poll the COUNTER, not a sleep).
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

test('gibribbon: clock+gate+CV spawns an imp → the correct press clears it (score up)', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'g', type: 'gibribbon', position: { x: 200, y: 200 }, domain: 'video' },
  ]);
  await expect(page.locator('.svelte-flow__node-gibribbon')).toBeVisible();
  await deterministicPlay(page, 'g');

  expect(await readNum(page, 'g', 'score')).toBe(0);
  await warmUpPastCountIn(page, 'g');

  // The ADAPTIVE extractor needs a VARYING channel (flat floors spawn
  // nothing): the warm-up ticks primed cv3's window at 0, so this spike is a
  // full-range prominence peak → it spawns on the beat.
  await spawnEventOn(page, 'g', 'cv3');

  // Scroll the imp toward the marine and hammer the X button: whichever
  // press lands while it is inside the phase-adjusted window clears it.
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
      eng.setParam(node, 'clock', 1);
      eng.setParam(node, 'clock', 0);
      eng.setParam(node, 'btn_x', 1);
      eng.setParam(node, 'btn_x', 0);
      const s = eng.read(node, 'score');
      return typeof s === 'number' && s > 0;
    },
    { id: 'g' },
    { timeout: 10_000, polling: 60 },
  ).catch(() => null);

  expect(cleared, 'a correct X press should clear the imp and raise the score').toBeTruthy();
  expect(await readNum(page, 'g', 'score')).toBeGreaterThan(0);
});

test('gibribbon: a missed event degrades the marine (health drops below healthy)', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'g', type: 'gibribbon', position: { x: 200, y: 200 }, domain: 'video' },
  ]);
  await expect(page.locator('.svelte-flow__node-gibribbon')).toBeVisible();
  await deterministicPlay(page, 'g');

  expect(await readStr(page, 'g', 'health')).toBe('healthy');
  await warmUpPastCountIn(page, 'g');

  // Spawn a loop (cv1 spike on the beat), then clock it past the miss line
  // with no press. spawnPos 1.44 → missPos −0.12 is 9 course ticks; 12 with
  // margin.
  await spawnEventOn(page, 'g', 'cv1');
  for (let i = 0; i < 12; i++) await pulse(page, 'g', 'clock');

  await expect
    .poll(async () => readStr(page, 'g', 'health'), { timeout: 5000 })
    .not.toBe('healthy');
  expect(['wounded', 'critical', 'dead']).toContain(await readStr(page, 'g', 'health'));
});

test('gibribbon: the NEW restart PORT hard-resets to a fresh healthy run', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'g', type: 'gibribbon', position: { x: 200, y: 200 }, domain: 'video' },
  ]);
  await expect(page.locator('.svelte-flow__node-gibribbon')).toBeVisible();
  await deterministicPlay(page, 'g');
  await warmUpPastCountIn(page, 'g');

  // Cost the marine a rung so the reset is observable in BOTH score-shaped
  // and health-shaped state.
  await spawnEventOn(page, 'g', 'cv1');
  for (let i = 0; i < 12; i++) await pulse(page, 'g', 'clock');
  await expect
    .poll(async () => readStr(page, 'g', 'health'), { timeout: 5000 })
    .not.toBe('healthy');

  // The restart PORT (same paramTarget path a patched cable uses).
  await pulse(page, 'g', 'restart_btn');
  await expect.poll(async () => readStr(page, 'g', 'health'), { timeout: 5000 }).toBe('healthy');
  expect(await readNum(page, 'g', 'score')).toBe(0);
  expect(await readNum(page, 'g', 'tick')).toBe(0);
  expect(await readStr(page, 'g', 'mode')).toBe('play');
});

// ── gate-bridge coverage: every event gate reaches a downstream SCOPE ────────
const GATE_PORTS = ['evt_hit', 'evt_miss', 'evt_fire', 'evt_kill', 'evt_gameover'] as const;

for (const port of GATE_PORTS) {
  test(`gibribbon: ${port} bridges into scope.ch1 (forcePulse)`, async ({ page, rack }) => {
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
    await expect(page.locator('.svelte-flow__node-gibribbon')).toBeVisible();

    // Baseline: gate idle → scope reads ~0.
    expect((await readScopePeak(page, scopeId)) ?? 0).toBeLessThan(0.2);

    const ok = await page.waitForFunction(
      ({ id, p, sid }) => {
        const w = globalThis as unknown as {
          __engine?: () => {
            read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
          } | null;
          __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
        };
        const eng = w.__engine?.();
        if (!eng) return false;
        const node = w.__patch.nodes[id];
        const scope = w.__patch.nodes[sid];
        if (!node || !scope) return false;
        const extras = eng.read(node, 'extras') as { forcePulse?: (p: string) => void } | undefined;
        if (!extras || typeof extras.forcePulse !== 'function') return false;
        extras.forcePulse(p);
        const snap = eng.read(scope, 'snapshot') as { ch1: Float32Array } | undefined;
        if (!snap) return false;
        let peak = 0;
        for (let i = 0; i < snap.ch1.length; i++) {
          const a = Math.abs(snap.ch1[i]!);
          if (a > peak) peak = a;
        }
        return peak > 0.4;
      },
      { id: 'g', p: port, sid: scopeId },
      { timeout: 6000, polling: 50 },
    ).catch(() => null);

    expect(ok, `${port} should pulse SCOPE.ch1 above the floor via the gate bridge`).toBeTruthy();
  });
}
