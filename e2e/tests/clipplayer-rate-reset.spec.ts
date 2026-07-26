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
//   2. RST button — all ACTIVE clips snap back to step 1, proved from an
//      in-page playhead trace as a BACKWARD JUMP too fast to be a loop wrap.
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

/** The seeded clip length. This is `MAX_CLIP_STEPS` (clip-types.ts): the engine
 *  coerces every clip through `clampStepCount`, so a longer clip CANNOT be
 *  seeded to push the loop-wrap horizon further out — see the reset test, which
 *  excludes a wrap arithmetically instead of by out-running it. */
const CLIP_STEPS = 128;
/** Nominal lane clock: stepDiv 2 = a 1/16 grid, @240 bpm = 62.5 ms/step. */
const NOMINAL_STEPS_PER_S = 16;

/** Seed DENSE 128-step note clips (a note every step, so the playhead tracks)
 *  in slot 0 of the given lanes, and queue them — via the same Y.Doc path the
 *  card/grid use. */
async function seedDenseClips(page: Page, nodeId: string, lanes: number[]) {
  await page.evaluate(
    ({ id, ls, len }) => {
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
            lengthSteps: len,
            root: 48,
            loop: true,
            steps: Array.from({ length: len }, (_, s) => ({ step: s, midi: 72, velocity: 127, lengthSteps: 1 })),
          };
          queued[lane] = 0;
        }
        n.data.clips = clips;
        n.data.sv = 2; // already stride-64 → skip the legacy re-key migration
        n.data.queued = queued;
      });
    },
    { id: nodeId, ls: lanes, len: CLIP_STEPS },
  );
}

// ── RESET PROOF: an IN-PAGE playhead trace, not a CDP poll ──────────────────
//
// WHY (measured 2026-07, after two failed hardenings): the RST test used to
// click reset and then POLL the engine over CDP for an ABSOLUTE "step <= 6"
// band. Under load a single `page.evaluate` round-trip costs ~1.5 s, so the
// FIRST read after `click()` landed long after the reset had already fired and
// the playhead had climbed back OUT of the band. Back-projecting a failing
// run's own numbers (15.65 steps/s — the nominal 16 for a 1/16 grid @240 bpm)
// put the playhead at ≈22 when `click()` returned, i.e. the reset had fired
// ~1.4 s earlier. Widening the band (2→6) and then the timeout (2500→5000)
// both failed because NEITHER is the binding constraint: the constraint is the
// latency between the reset FIRING and the first READ, and a longer timeout
// only buys more chances to read a playhead that is now climbing AWAY.
//
// The absolute band is not even SOUND under load. Injecting pre-read latency
// on an idle machine (the old assertion, same patch):
//     +0 ms    pass          +6000 ms  "pass" — on a natural LOOP WRAP
//     +1500 ms FAIL (103)    +9000 ms  FAIL (95)
//     +3000 ms FAIL (127)    +14000 ms "pass" — on a natural LOOP WRAP
// i.e. past the 8 s / 128-step wrap horizon it can go green WITHOUT the reset
// happening at all. A longer clip cannot fix that: `MAX_CLIP_STEPS` = 128 and
// the engine coerces every clip through `clampStepCount`, so a 512-step seed
// is silently clamped back to 128.
//
// So: record the playheads INSIDE the page on a 10 ms interval (no CDP in the
// detection path — measured max sampler gap ~30 ms even with 14 s of injected
// latency) and prove a BACKWARD JUMP that is arithmetically TOO FAST to be a
// loop wrap. `currentStep` is monotone between wraps and resets, so a decrease
// has exactly two causes and the wrap is EXCLUDED BY ARITHMETIC rather than by
// hoping the observation window is short. Strictly stronger than "happened to
// read low", and it has no wall-clock race left to widen.

type TraceDrop = { dt: number; prev: number[]; cur: number[]; wrapMs: number };
type TraceSummary = { samples: number; spanMs: number; maxGapMs: number; rate: number; drops: TraceDrop[] };
type TraceW = { __cpTrace?: { stop: () => void; read: () => TraceSummary } };

/** Start the in-page recorder for `keys` on `nodeId`. Each tick also classifies
 *  a backward jump: `wrapMs` is the MINIMUM time a free-running playhead would
 *  need to read `cur` after reading `prev` via a natural wrap, so `dt ≪ wrapMs`
 *  means the jump cannot be a wrap. */
async function startStepTrace(page: Page, nodeId: string, keys: string[]): Promise<void> {
  await page.evaluate(
    ({ id, ks, len, nominal }) => {
      const w = globalThis as unknown as EngineW & TraceW;
      const t: number[] = [];
      const s: number[][] = [];
      const drops: TraceDrop[] = [];
      let runStart = 0; // index of the first sample of the current drop-free run
      let rate = nominal;
      let maxGapMs = 0;
      const h = setInterval(() => {
        const eng = w.__engine?.();
        const node = w.__patch.nodes[id];
        if (!eng || !node || t.length >= 5000) return;
        const now = performance.now();
        const cur = ks.map((k) => {
          const v = eng.read(node, k);
          return typeof v === 'number' ? v : NaN;
        });
        if (t.length) {
          const dt = now - t[t.length - 1];
          if (dt > maxGapMs) maxGapMs = dt;
          const prev = s[s.length - 1];
          const finite = prev.every(Number.isFinite) && cur.every(Number.isFinite);
          if (finite && prev.every((p, L) => cur[L] < p)) {
            // `- 1` is ONE STEP of read quantization: `prev` may have been read
            // at the very END of its step and `cur` at the very START of its
            // own. Without it a tight 127→0 wrap looks instantaneous and is
            // misread as a reset (verified against a real wrap).
            const wrapMs = Math.min(
              ...prev.map((p, L) => (Math.max(0, len - p - 1 + Math.max(0, cur[L])) / rate) * 1000),
            );
            drops.push({ dt, prev, cur, wrapMs });
            runStart = t.length; // a fresh drop-free run starts at THIS sample
          } else if (finite && runStart < t.length) {
            // Re-measure the FREE-RUNNING rate over the current drop-free run,
            // so the wrap exclusion never trusts a hard-coded tempo. Only ever
            // raised above nominal: a FASTER assumed clock shrinks `wrapMs`,
            // which is the conservative direction (harder to call a wrap a reset).
            const dS = cur[0] - s[runStart][0];
            const dT = (now - t[runStart]) / 1000;
            if (dT > 0.4 && dS > 0) rate = Math.max(rate, dS / dT);
          }
        }
        t.push(now);
        s.push(cur);
      }, 10);
      w.__cpTrace = {
        stop: () => clearInterval(h),
        read: () => ({ samples: t.length, spanMs: t.length ? t[t.length - 1] - t[0] : 0, maxGapMs, rate, drops }),
      };
    },
    { id: nodeId, ks: keys, len: CLIP_STEPS, nominal: NOMINAL_STEPS_PER_S },
  );
}

/** Wait until the trace holds a backward jump too fast to be a wrap, that lands
 *  near the top. Polls IN-PAGE (`waitForFunction`), so no CDP round-trip sits in
 *  the detection path — that latency IS the bug this replaces. Returns on the
 *  first qualifying jump (~50 ms on a healthy run: no added wall time). */
async function waitForResetSnap(page: Page, timeoutMs: number): Promise<boolean> {
  try {
    await page.waitForFunction(
      () => {
        const drops = (globalThis as unknown as TraceW).__cpTrace?.read().drops ?? [];
        return drops.some((d) => d.dt < d.wrapMs * 0.5 && d.cur.every((c) => c <= 6));
      },
      undefined,
      { timeout: timeoutMs, polling: 25 },
    );
    return true;
  } catch {
    return false;
  }
}

/** Stop the recorder and return everything it saw (the failure message). */
async function stopStepTrace(page: Page): Promise<TraceSummary> {
  return await page.evaluate(() => {
    const tr = (globalThis as unknown as TraceW).__cpTrace;
    if (!tr) return { samples: 0, spanMs: 0, maxGapMs: 0, rate: 0, drops: [] };
    tr.stop();
    return tr.read();
  });
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

  // Both lanes well past the top, so a snap back to step 1 is a real jump.
  const l0 = await waitForEngine(page, 'cp', 'currentStep:0', (v) => v >= 8, 6000);
  expect(l0.ok, `lane 0 mid-clip before reset (saw ${l0.last})`).toBe(true);

  // Record BOTH playheads in-page across the click (see the RESET PROOF block
  // above for why this replaced the post-click CDP poll). The recorder is
  // running before the click and keeps running regardless of how long `click()`
  // itself takes — under load it has burned 2.2-6.3 s, and the reset fires
  // somewhere INSIDE that, which is exactly what the old poll kept missing.
  await startStepTrace(page, 'cp', ['currentStep:0', 'currentStep:1']);
  await page.getByTestId('clipplayer-reset').click();

  // PROOF: both lanes jump BACKWARD, together, to the top of the clip, in far
  // less time than a natural 128-step loop wrap would need to land them there.
  // `currentStep` only ever decreases via a wrap or a reset, and the wrap is
  // ruled out arithmetically — so this is the RST button and nothing else.
  // Resolves in ~50 ms when healthy; the 8 s ceiling only pays out on a real
  // failure and absorbs a starved main-thread scheduler tick (the only place
  // resetNonce is consumed) without widening any acceptance window.
  const proved = await waitForResetSnap(page, 8000);
  const trace = await stopStepTrace(page);
  expect(
    proved,
    `both lanes snapped BACKWARD to the top on the reset, too fast to be a loop wrap — ` +
      `trace: ${JSON.stringify(trace)}`,
  ).toBe(true);
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
