// e2e/tests/clipplayer-queue-boundary.spec.ts
//
// Deluge launch quantization end-to-end (the owner-locked fix): with QNT on, a
// clip launched into an IDLE lane does NOT fire immediately while other clips
// play — it QUEUES and drops in at the next loop boundary of the LONGEST
// currently-playing clip (the shared reference bar). The exact boundary-timing
// math is pinned deterministically by the pure unit test
// (clip-launch-quantize.test.ts) and the engine unit test (clipplayer.test.ts);
// here we prove the real, synced end-to-end observable — the launch is QUEUED
// (not immediately playing) while a long clip loops, and then drops in ON the
// long clip's own wrap — plus the escape: with NOTHING playing a QNT-on launch
// fires immediately.
//
// We read the SYNCED `playing`/`queued` set (what every peer + LED sees + what
// the audio engine consumes), and we read it from an IN-PAGE recorder that also
// ARMS the launch at a known phase of the reference bar — so the proof is the
// Deluge SEMANTICS (queued → drops in at the wrap), not a wall-clock window
// racing a cyclic boundary. See the BOUNDARY PROOF block below for the measured
// reason that distinction is load-bearing on CI.

import type { Page } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

// ── the per-test BUDGET is a BOUND, and the default one is unreachable ──────
//
// #1990. This spec recovered `timedOut -> passed` on CI (shard 4 of #1983, job
// 96284278875). The error was NOT the 5 s poll below timing out — it was
// `Test timeout of 30000ms exceeded` pointing at line 322, i.e. Playwright's
// INVISIBLE default per-test budget, which this suite does not override in
// `e2e/playwright.config.ts`.
//
// The arithmetic that makes 30 s unreachable here, from this file's own
// constants — nothing new is guessed:
//
//   * BOOT is bounded at BOOT_MS = 30 s on CI, and that number is not padding:
//     it is what a loaded 2-core runner needs for first paint (`boot-budget.ts`,
//     #1875). So boot ALONE may legitimately consume the entire default budget.
//   * On top of boot this test spends IRREDUCIBLE REAL TIME on the transport
//     clock, which does not go faster on a faster machine: arming waits for the
//     LONG clip to reach step ARM_LO..ARM_HI of its 16-step / 2 s bar (up to
//     ~1.9 s), then the drop-in waits (LONG_STEPS - armStep) steps for the
//     boundary (1.0-1.6 s). ~2-3.5 s of wall clock that no runner can compress.
//
// So the green path needs boot + ~3.5 s against a budget sized for boot alone.
// MEASURED locally on a warm server: 7.0 s of the 30 s — 23 %. CI blew all 30,
// i.e. >4.3x the local figure, which is inside the documented CI swing (>=2x
// run-to-run, #1860) with ten shards competing on top.
//
// `SLOW_BOOT_TEST_TIMEOUT_MS` is the shared remedy for exactly this shape
// ("a spec whose WHOLE test timed out on a slow runner while waiting on a
// post-boot subject") and is already carried by clipplayer-edit-launch,
// dx7-operator-panel, blood-mount, freezeframe-screen-toggle and
// workflow-drawer-face. It is 90 s on CI and UNCHANGED at 30 s locally, so this
// alters nothing about a local run.
//
// ⚠ This raises a BOUND, never an assertion. Every timing claim below is
// untouched, and a budget only pays out on a run that was going to be a false
// red — the test exits the moment the drop-in is seen, so a green run costs
// exactly what it cost before.
test.describe.configure({ mode: 'parallel', timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

const CP = 'qb-cp';

// ── The reference bar's arithmetic (all derived, nothing magic) ─────────────
/** The LONG clip's length — it is the reference bar (the longest playing clip). */
const LONG_STEPS = 16;
/** `setTransport` pins every TIMELORDE here; `stepDiv: 2` = 4 steps/beat (1/16). */
const BPM = 120;
const STEPS_PER_BEAT = 4;
/** 125 ms — one step of the reference bar. */
const STEP_MS = (60 / BPM / STEPS_PER_BEAT) * 1000;
/** The engine writes the synced `playing` flip when the boundary enters its
 *  scheduling window — `LOOKAHEAD_S` (0.2) + the 0.05 tick margin in
 *  clipplayer.ts — i.e. up to 250 ms (2 steps) BEFORE the audible wrap. */
const LOOKAHEAD_MS = 250;
/** So a boundary drop-in is written while the reference bar is sounding one of
 *  its last 3 steps (13, 14, 15). Anything earlier is not the boundary. */
const WRAP_ADJACENT_FROM = LONG_STEPS - 3;
/** Arm the launch here — mid-bar, 8..13 steps (1.0-1.6 s) short of the wrap, so
 *  "waited for the boundary" and "fired immediately" are far apart on BOTH the
 *  step axis and the time axis whatever phase the run happens to catch. */
const ARM_LO = 3;
const ARM_HI = 8;

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
  await page.goto('/rack?seed=none');
  await spawnPatch(page, [
    { id: CP, type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio',
      params: { quantize, stepDiv: 2, gateLength: 0.9, octave: 0 } },
  ]);
  // ⚠ `locator.waitFor()` documents "Defaults to 0 - no timeout" and is bounded
  // ONLY by the per-test budget — it is the form `e2e-boot-bound-source.test.ts`
  // deliberately does NOT read (see its scope note). Unbounded, a slow spawn
  // silently spends the whole budget here and the timeout then surfaces at
  // whatever line happened to be awaiting when it ran out — which is exactly how
  // #1990 reported at line 322 (a 5 s poll) rather than at the spawn that ate it.
  // An explicit BOOT_MS makes the failure ATTRIBUTABLE; it does not make the test
  // wait any longer on a green run.
  await page
    .locator('.svelte-flow__node:has([data-shell-type="clipplayer"])')
    .first()
    .waitFor({ state: 'visible', timeout: BOOT_MS });
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

// ── BOUNDARY PROOF: an IN-PAGE trace that ARMS ITSELF at a known phase ─────
//
// WHY (measured 2026-07-26, the 4th load-induced flake in this family): the
// test used to queue the launch at whatever moment it got to, sleep a FIXED
// 400 ms, and take ONE CDP read of the synced set. That is a fixed budget
// raced against a CYCLIC ~2 s boundary, and it fails in TWO independent ways.
//
//   1. UNDER-BUDGETED for the read. Injecting only pre-read latency (the CDP
//      round-trip cost CI load adds — #1173 measured ~1.5 s/evaluate under
//      load) is a clean MONOTONE dose-response on an idle machine:
//        +0/300/600/900 ms → pass      +1200/1500/2000/3000 ms → FAIL(playing)
//      i.e. the read simply lands after the drop-in has already happened.
//
//   2. NOT SOUND — and this is the part no timeout can fix. The verdict is a
//      function of the PHASE φ at which the launch happens to land inside the
//      2 s reference bar, which the old test neither controlled nor measured.
//      Injecting latency BEFORE the queue (which only moves φ) is CYCLIC, not
//      monotone — lane-0's audible step at queue time in brackets:
//        +0 [0] pass    +750 [8]  pass     +1375 [13] FAIL   +2000 [2] pass
//        +250 [4] pass  +1000 [10] FAIL    +1500 [14] pass   +2250 [4] pass
//        +500 [6] pass  +1125 [11] FAIL    +1750 [0]  pass   +2500 [6] pass
//      The same cycle shows up in the LOAD parameter itself. Throttling the
//      renderer (CDP Emulation.setCPUThrottlingRate — the faithful "loaded CI
//      shard" model: the main thread slows, the audio clock does not) walks φ
//      around the bar and the verdict follows it around:
//        1x [0] pass   6x [5] pass    12x [6] pass   20x [10] FAIL  28x pass
//        2x [2] pass   8x [5] pass    16x [7] pass   24x [12] FAIL  32x pass
//        4x [4] pass  10x [6] pass                                  40x FAIL
//      MORE load goes GREEN again. A test whose verdict is non-monotone in the
//      load is not measuring the engine — for φ in the last ~third of the bar
//      a PERFECTLY CORRECT engine fails it (the boundary is genuinely <400 ms
//      away, so the drop-in genuinely IS immediate), and its green runs were
//      green only because an idle machine's fast round-trips reliably parked φ
//      at step 0-2 of 16, leaving ~1.1 s of margin over the 400 ms budget.
//      Widening 400 → N cannot fix that: it moves the cliff, and past 2 s the
//      window swallows the whole bar and asserts nothing at all.
//
// So: control the phase and prove the SEMANTICS instead of out-running them.
// One in-page 10 ms recorder (a) waits for the reference bar's own audible
// playhead to reach a known mid-bar step and does the queue write ITSELF right
// there — no CDP round-trip between deciding the phase and committing it —
// then (b) records the synced `playing`/`queued` set until the drop-in. The
// test polls the recorder with `waitForFunction`, so no CDP latency sits in the
// detection path either. What we then assert is what the Deluge model actually
// promises — the launch stayed QUEUED and dropped in AT the reference bar's
// wrap — which the old test never checked at all: it only ever asked whether
// the drop-in had happened yet at one arbitrary instant.

type LaunchTrace = {
  armed: boolean;
  /** performance.now() at the queue write, and lane 0's audible step there. */
  armT: number;
  armStep: number;
  /** First sample that saw the synced `playing[lane]` flip, + lane 0's step. */
  flipT: number | null;
  flipStep0: number | null;
  /** Last sample that saw lane QUEUED and NOT playing (the flashing state). */
  lastQueuedOnlyT: number | null;
  queuedOnlySamples: number;
  /** Reference-bar wraps observed after the arm (diagnostic: a starved engine
   *  tick can miss a boundary and take the NEXT one — still a valid drop-in). */
  wrapsAfterArm: number;
  samples: number;
  maxGapMs: number;
};
type TraceW = { __qbTrace?: { stop: () => void; read: () => LaunchTrace } };

/**
 * Start the in-page recorder. It ARMS ITSELF: the queued launch is written the
 * moment lane 0's AUDIBLE playhead (`currentStep:0` — what you hear, not the
 * lookahead position) is inside [armLo, armHi], so every run measures from a
 * known distance to the reference bar's wrap instead of wherever the harness
 * happened to arrive. Sampling continues past the arm until the synced
 * `playing[lane]` flip is seen.
 */
async function startLaunchTrace(
  page: Page,
  opts: { nodeId: string; lane: number; slot: number; armLo: number; armHi: number },
): Promise<void> {
  await page.evaluate(({ nodeId, lane, slot, armLo, armHi }) => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (node: unknown, key: string) => unknown } | null;
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    } & TraceW;
    const tr: LaunchTrace = {
      armed: false, armT: 0, armStep: -1,
      flipT: null, flipStep0: null,
      lastQueuedOnlyT: null, queuedOnlySamples: 0,
      wrapsAfterArm: 0, samples: 0, maxGapMs: 0,
    };
    let prevStep0 = -1;
    let lastT = 0;
    const h = setInterval(() => {
      const eng = w.__engine?.();
      const node = w.__patch.nodes[nodeId];
      if (!eng || !node || tr.samples >= 5000) return;
      const now = performance.now();
      const raw = eng.read(node, 'currentStep:0');
      const s0 = typeof raw === 'number' ? raw : -1;
      if (tr.samples > 0) {
        const dt = now - lastT;
        if (dt > tr.maxGapMs) tr.maxGapMs = dt;
      }
      lastT = now;
      tr.samples++;

      if (!tr.armed) {
        // Wait for a KNOWN phase of the reference bar, then queue RIGHT HERE —
        // the write and the phase decision are the same page turn.
        if (s0 < armLo || s0 > armHi) return;
        w.__ydoc.transact(() => {
          const n = w.__patch.nodes[nodeId];
          if (!n.data) n.data = {};
          const q = Array.isArray(n.data.queued)
            ? (n.data.queued as (number | 'stop' | null)[]).slice()
            : new Array(8).fill(null);
          q[lane] = slot;
          n.data.queued = q;
        });
        tr.armed = true;
        tr.armT = now;
        tr.armStep = s0;
        prevStep0 = s0;
      } else {
        if (prevStep0 >= 0 && s0 >= 0 && s0 < prevStep0) tr.wrapsAfterArm++;
        prevStep0 = s0;
      }

      if (tr.flipT !== null) return;
      const d = node.data as { playing?: unknown[]; queued?: unknown[] } | undefined;
      if (d?.playing?.[lane] === slot) {
        tr.flipT = now;
        tr.flipStep0 = s0;
      } else if (d?.queued?.[lane] === slot) {
        tr.queuedOnlySamples++;
        tr.lastQueuedOnlyT = now;
      }
    }, 10);
    w.__qbTrace = { stop: () => clearInterval(h), read: () => tr };
  }, opts);
}

/** Stop the recorder and return everything it saw (the failure message). */
async function stopLaunchTrace(page: Page): Promise<LaunchTrace> {
  return await page.evaluate(() => {
    const tr = (globalThis as unknown as TraceW).__qbTrace;
    if (!tr) {
      return {
        armed: false, armT: 0, armStep: -1, flipT: null, flipStep0: null,
        lastQueuedOnlyT: null, queuedOnlySamples: 0, wrapsAfterArm: 0,
        samples: 0, maxGapMs: 0,
      } satisfies LaunchTrace;
    }
    tr.stop();
    return tr.read();
  });
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

  // Now launch the target into IDLE lane 2 (QNT on, no NOW) at a KNOWN mid-bar
  // phase — the recorder arms itself when the LONG clip is 8..13 steps short of
  // its wrap (see the BOUNDARY PROOF block above for why the old fixed 400 ms
  // window was both under-budgeted AND unsound).
  await startLaunchTrace(page, { nodeId: CP, lane: 2, slot: 2, armLo: ARM_LO, armHi: ARM_HI });
  const dropped = await page
    .waitForFunction(
      () => ((globalThis as unknown as TraceW).__qbTrace?.read().flipT ?? null) !== null,
      undefined,
      // Resolves the moment the drop-in is seen (no added green-path wall time).
      // The ceiling only pays out on a real failure, and absorbs the arm wait
      // (≤ 1 bar), the bar itself, and a starved engine tick deferring the
      // drop-in to the NEXT boundary.
      { timeout: 12_000, polling: 25 },
    )
    .then(() => true)
    .catch(() => false);
  const tr = await stopLaunchTrace(page);
  const dump = `trace: ${JSON.stringify(tr)}`;
  expect(dropped, `the queued launch dropped in — ${dump}`).toBe(true);
  expect(tr.armed, `the launch was armed mid-bar — ${dump}`).toBe(true);
  expect(tr.armStep, `armed inside [${ARM_LO}, ${ARM_HI}] — ${dump}`).toBeGreaterThanOrEqual(ARM_LO);
  expect(tr.armStep, `armed inside [${ARM_LO}, ${ARM_HI}] — ${dump}`).toBeLessThanOrEqual(ARM_HI);
  const flipT = tr.flipT as number;
  const flipStep0 = tr.flipStep0 as number;

  // 1. It was QUEUED (flashing), not immediate: the last observation before the
  //    drop-in still showed lane 2 queued-and-not-playing, so there is no
  //    unobserved window it could have been playing in. Tolerance is the
  //    recorder's OWN measured sampling gap — not a guessed constant.
  expect(tr.queuedOnlySamples, `lane 2 was seen QUEUED (flashing) — ${dump}`).toBeGreaterThan(0);
  expect(
    flipT - (tr.lastQueuedOnlyT as number),
    `lane 2 was still QUEUED immediately before the drop-in — ${dump}`,
  ).toBeLessThanOrEqual(tr.maxGapMs + STEP_MS);

  // 2. It WAITED: the drop-in is at least most of the way from the arm phase to
  //    the boundary. A LOWER bound on elapsed time is load-safe — a starved
  //    machine can only ever DELAY the flip, never advance it, and the audio
  //    clock this is measured against is not main-thread-scheduled.
  const minWaitMs = (LONG_STEPS - tr.armStep) * STEP_MS - LOOKAHEAD_MS - STEP_MS;
  expect(
    flipT - tr.armT,
    `the drop-in waited ~${Math.round(minWaitMs)} ms for the boundary instead of firing now — ${dump}`,
  ).toBeGreaterThanOrEqual(minWaitMs * 0.7);

  // 3. It landed ON the reference bar: the flip was written while the LONG clip
  //    was sounding one of its last 3 steps (the engine commits a boundary
  //    launch up to LOOKAHEAD_MS = 2 steps early). The escape hatch is the same
  //    self-measured gap — a sampler stalled past the wrap reads a small step —
  //    so a starved main thread can't turn this into a false failure, while an
  //    immediate launch (which lands at armStep ≤ 8) still cannot satisfy it.
  const landedOnBoundary =
    flipStep0 >= WRAP_ADJACENT_FROM || flipStep0 * STEP_MS <= tr.maxGapMs + STEP_MS;
  expect(
    landedOnBoundary,
    `the drop-in landed at the LONG clip's wrap (step ${flipStep0} of ${LONG_STEPS}) — ${dump}`,
  ).toBe(true);

  // 4. And the SYNCED set every peer + LED reads agrees: lane 2 is PLAYING and
  //    no longer queued.
  const after = await readState(page);
  expect(after.playing?.[2], 'lane 2 is PLAYING (synced set)').toBe(2);
  expect(after.queued?.[2] ?? null, 'lane 2 is no longer queued (synced set)').toBeNull();
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
