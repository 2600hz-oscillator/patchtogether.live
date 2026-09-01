// e2e/tests/automation-cv-record.spec.ts
//
// RECORD-CV-AUTOMATION (owner report, 2026-08): a cv-bridge-modulated param on
// a lane-ASSIGNED module — the owner's exact case is Gamepad → BACKDRAFT.mix —
// must behave like a hand on the knob:
//
//   armed + source MOVING  → the EFFECTIVE (base + CV) movement RECORDS into
//                            the playing clip's sibling `auto[k]` (overdub);
//   source IDLE (parked)   → the recorded movement LOOPS (clip playback drives);
//   source MOVING          → live CV OVERRIDES playback (and re-records while
//                            still armed).
//
// The seam is the VideoEngine cv-bridge's CvActivityDetector (cv-bridge-map.ts):
// an ACTIVE source stream grabs the param via the automation-touch registry
// under a `cv:<edgeId>` holder (same suspension path as a screen/MIDI hand);
// IDLE releases it and the bridge yields its per-frame write to the live
// clip-automation driver. Record capture for a cv-held param reads the
// ENGINE-EFFECTIVE value (`readEffectiveNorm`), never the store — and nothing
// here ever writes CV values into node.params (the CV-not-in-the-doc rule).
//
// Named `automation-*` (NOT `video-*`) deliberately: it runs in the normal
// sharded e2e lane — it is LIGHT (engine param reads, never pixels; BACKDRAFT
// itself is not in e2e/webgl-heavy-globs.ts), and renderer-independent: pad
// updates are frame-paced (in-page, one graded sub-step per rAF), waits on
// MONOTONIC state (a one-sided envelope, an overdub maximum) are
// `expect.poll` on the real subject, and both the RECORD stimulus+wait
// (driveStickUntilTakeMeets) and the PERIODIC loop-playback observation
// (observeMixSweep) run in-page per frame in one evaluate — a Playwright-side
// poll holds the stimulus for a round trip per level and phase-locks with the
// loop period. The clip length is sized in FRAMES (see CLIP_LEN). A slow
// renderer only stretches the same assertions.
//
// The AUDIO-cable CV-exclusion case (clip-automation.spec.ts case 10 — an LFO
// cv CABLE into an audio param records nothing) is UNCHANGED: audio-domain cv
// cables sum inside the Web Audio graph and fire no bridge tick; only the
// video cv-bridge has the activity seam today.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import type { Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const CP = 'cp';
const BD = 'bd';
const IDX = 0; // lane 0, slot 0 → flat stride-64 clip key 0
/** 32 steps ≈ 4 s loops at 120 bpm free-run 1/16. LENGTH IS LOAD-BEARING, in
 *  FRAMES: the pad→cv chain can express at most ONE stick level per rendered
 *  frame (the gamepad module polls per rAF), so a record pass can only hold
 *  movement if the loop spans SEVERAL frames. The old 8-step (~1 s) loop was
 *  0-1 frames on a starved CI shard (measured: scheduler tick 651 ms, run
 *  33279139157) — every pass sampled one flat level and the recorder's
 *  MOVE_EPS gate rightly dropped it, so 60 s of wiggling committed NOTHING.
 *  4 s spans ≥2 frames down to ~0.5 fps while costing a 60 fps run only a
 *  few extra seconds. */
const CLIP_LEN = 32;

// ── fake gamepad (same seam as gamepad.spec.ts: navigator.getGamepads stub) ──

async function installFakeGamepad(page: Page): Promise<void> {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (navigator as any).getGamepads = () => [w.__fakePad, null, null, null];
  });
}

/** Move the fake LEFT-STICK X to `lx` (the axis patched into BACKDRAFT.mix). */
async function setStickX(page: Page, lx: number): Promise<void> {
  await page.evaluate((v) => {
    const w = globalThis as unknown as { __fakePad?: { axes: number[]; timestamp: number } };
    if (!w.__fakePad) return;
    w.__fakePad.axes = [v, 0, 0, 0];
    w.__fakePad.timestamp = performance.now();
  }, lx);
}

// ── engine / store probes ────────────────────────────────────────────────────

/** ENGINE-EFFECTIVE value of BACKDRAFT.mix (the video uniform — what the cv
 *  bridge and clip-automation playback actually drive). */
async function engineMix(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => { readParam: (n: unknown, p: string) => number | undefined } | null;
      __patch: { nodes: Record<string, unknown> };
    };
    const eng = w.__engine?.();
    const node = w.__patch?.nodes?.['bd'];
    if (!eng || !node) return null;
    const v = eng.readParam(node, 'mix');
    return typeof v === 'number' ? v : null;
  });
}

/** IN-PAGE observation window over the ENGINE-EFFECTIVE mix uniform: sample
 *  once per animation frame, reduce to min/max, early-exit the moment BOTH
 *  thresholds have been seen. ONE `page.evaluate` for the whole window — the
 *  repo's instrument rule (CLAUDE.md, scope-poll.ts): a Playwright-side
 *  `expect.poll` is one CDP round trip per sample on the SAME main thread as
 *  the subject, and its backoff settles at ~1 s — the same range as this
 *  spec's clip-loop period. A sampler near the loop period PHASE-LOCKS:
 *  measured under E2E_SWIFTSHADER=1 on the original ~1 s loop, it read the
 *  same top-of-sweep 0.918 on every sample for 15 s while playback looped
 *  underneath. The rAF reduction sees every rendered value instead, and the
 *  wall-clock bound only BOUNDS FAILURE (a healthy run exits on the
 *  threshold); `samples`/`elapsedMs` make a zero-sample window legible. */
async function observeMixSweep(
  page: Page,
  opts: { above: number; below: number; discardFrames: number; maxFrames: number; boundMs: number },
): Promise<{ min: number; max: number; samples: number; elapsedMs: number; state: string }> {
  return page.evaluate(
    ({ above, below, discardFrames, maxFrames, boundMs }) =>
      new Promise<{ min: number; max: number; samples: number; elapsedMs: number; state: string }>((resolve) => {
        const w = globalThis as unknown as {
          __engine?: () => { readParam: (n: unknown, p: string) => number | undefined } | null;
          __patch: { nodes: Record<string, unknown> };
        };
        const t0 = performance.now();
        let min = Infinity;
        let max = -Infinity;
        let samples = 0;
        let frames = 0;
        let done = false;
        /** Which side of the idle-yield seam is live at window end — makes a
         *  failed window legible (bridge never yielded vs playback never
         *  drove). Reads the engine's runtime internals defensively: a shape
         *  it cannot find is NAMED in the output rather than thrown or
         *  silently blanked, so the probe cannot masquerade as a finding. */
        const endState = (): string => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const eng = w.__engine?.() as any;
            const playing =
              (w.__patch?.nodes?.['cp'] as { data?: { playing?: unknown[] } } | undefined)?.data
                ?.playing?.[0] ?? null;
            if (!eng) return `engine-absent lanePlaying=${String(playing)}`;
            let cvHeld: unknown = 'no-bridge-matched';
            let detActive: unknown = 'no-bridge-matched';
            const bridges = eng.cvBridges instanceof Map ? (eng.cvBridges as Map<string, unknown>) : null;
            for (const b of (bridges?.values() ?? []) as Iterable<{
              targetNodeId?: string;
              mapping?: { targetParamId?: string };
              cvHeld?: boolean;
              detector?: { active: boolean } | null;
            }>) {
              if (b?.targetNodeId === 'bd' && b?.mapping?.targetParamId === 'mix') {
                cvHeld = b.cvHeld;
                detActive = b.detector ? b.detector.active : null;
              }
            }
            const transient =
              eng.transientMods instanceof Map || eng.transientMods instanceof Set
                ? eng.transientMods.has('bd\u0000mix')
                : 'transientMods-not-found';
            return `bridges=${String(bridges ? bridges.size : 'not-a-map')} cvHeld=${String(cvHeld)} detectorActive=${String(detActive)} transientDriver=${String(transient)} lanePlaying=${String(playing)}`;
          } catch (e) {
            return `state-probe-failed: ${String(e)}`;
          }
        };
        const finish = (): void => {
          if (done) return;
          done = true;
          clearTimeout(bound);
          resolve({ min, max, samples, elapsedMs: Math.round(performance.now() - t0), state: endState() });
        };
        // The bound must fire even if rAF stalls outright — a frozen renderer
        // should fail with "0 samples over N ms", not a mute test timeout.
        const bound = setTimeout(finish, boundMs);
        const tick = (): void => {
          if (done) return;
          frames += 1;
          // Warmup discard: the first frames may still carry the pre-park
          // uniform (the pad→bridge pipeline flushes the parked stick over a
          // frame or two) — a stale extremity must not fake a threshold.
          if (frames > discardFrames) {
            const eng = w.__engine?.();
            const node = w.__patch?.nodes?.['bd'];
            const v = eng && node ? eng.readParam(node, 'mix') : undefined;
            if (typeof v === 'number') {
              samples += 1;
              if (v < min) min = v;
              if (v > max) max = v;
            }
          }
          if ((max > above && min < below) || frames >= maxFrames) {
            finish();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    opts,
  );
}

/** The STORE (Y.Doc) value of BACKDRAFT.mix — must never move under CV. */
async function storeMix(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params?: Record<string, number> }> };
    };
    const v = w.__patch?.nodes?.['bd']?.params?.mix;
    return typeof v === 'number' ? v : null;
  });
}

/** Recorded events for `auto[IDX].tracks['bd::mix']` on the clip player. */
async function recordedEvents(page: Page): Promise<{ step: number; value: number }[]> {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: {
        nodes: Record<string, { data?: { auto?: Record<string, { tracks?: Record<string, { events?: Array<{ step?: number; value?: number }> }> }> } }>;
      };
    };
    const evs = w.__patch?.nodes?.['cp']?.data?.auto?.['0']?.tracks?.['bd::mix']?.events;
    if (!Array.isArray(evs)) return [];
    return evs.map((e) => ({ step: Number(e.step), value: Number(e.value) }));
  });
}

/** JSON snapshot of the NOTE clip (byte-identical assertion). */
async function noteClipSnapshot(page: Page): Promise<string> {
  return page.evaluate(() =>
    JSON.stringify(
      (globalThis as unknown as { __patch: { nodes: Record<string, { data?: { clips?: Record<string, unknown> } }> } })
        .__patch?.nodes?.['cp']?.data?.clips?.['0'] ?? null,
    ),
  );
}

/** Seed the note clip + MODULE→lane assignment (+ optional existing automation
 *  track) directly into the store — the deterministic setup path the
 *  clip-automation specs use. */
async function seedClip(
  page: Page,
  opts: { track?: { step: number; value: number }[] } = {},
): Promise<void> {
  await page.evaluate(
    ({ len, track }) => {
      const w = globalThis as unknown as {
        __ydoc: { transact: (fn: () => void) => void };
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      };
      w.__ydoc.transact(() => {
        const node = w.__patch.nodes['cp'];
        if (!node.data) node.data = {};
        const data = node.data as {
          clips?: Record<string, unknown>;
          auto?: Record<string, unknown>;
          autoAssign?: Record<string, number>;
        };
        if (!data.clips) data.clips = {};
        data.clips['0'] = {
          kind: 'note',
          steps: [{ step: 0, midi: 60 }],
          lengthSteps: len,
          root: 48,
          loop: true,
        };
        if (track) {
          if (!data.auto) data.auto = {};
          data.auto['0'] = { tracks: { 'bd::mix': { events: track } } };
        }
        if (!data.autoAssign) data.autoAssign = {};
        data.autoAssign['bd'] = 0;
      });
    },
    { len: CLIP_LEN, track: opts.track },
  );
}

/** Launch the seeded clip in lane 0 and gate on it SOUNDING. */
async function launchClip(page: Page): Promise<void> {
  await page.getByTestId(`clipplayer-pad-${IDX}`).click();
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: { playing?: unknown[] } }> };
      };
      return w.__patch?.nodes?.['cp']?.data?.playing?.[0] === 0;
    },
    undefined,
    { timeout: 6000 },
  );
  await waitForStepAtLeast(page, 3, 20_000);
}

/** Wait until lane 0's sounding step has REACHED `n` — `>=`, never `===`: the
 *  sounding step is a MOVING counter sampled by a poller, and under CI
 *  starvation the scheduler advances it in multi-step batches while poll
 *  evaluations arrive late — an equality wait can simply never observe its
 *  125 ms window (measured: run 33281413825, both waits that timed out were
 *  `=== n` step waits). A monotone `>=` cannot miss within the first loop. */
async function waitForStepAtLeast(page: Page, n: number, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    ({ id, t }) => {
      const w = globalThis as unknown as {
        __engine?: () => { read: (n: unknown, k: string) => number | undefined } | null;
        __patch: { nodes: Record<string, unknown> };
      };
      const eng = w.__engine?.();
      const node = w.__patch?.nodes?.[id];
      if (!eng || !node) return false;
      const v = eng.read(node, 'currentStep:0');
      return typeof v === 'number' && v >= t;
    },
    { id: CP, t: n },
    { timeout: timeoutMs, polling: 25 },
  );
}

async function armLane0(page: Page): Promise<void> {
  await page.getByTestId('clipplayer-auto-arm-0').click();
}

async function isLane0Armed(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: {
        nodes: Record<string, { data?: { automation?: { lanes?: ({ arm?: boolean } | null)[] } } }>;
      };
    };
    return w.__patch?.nodes?.['cp']?.data?.automation?.lanes?.[0]?.arm === true;
  });
}

/** The shared patch: clipplayer + gamepad (audio) → BACKDRAFT.mix (video cv
 *  bridge) → videoOut. The fake pad must be installed BEFORE the gamepad
 *  module spawns (its rAF poll adopts it on the next tick). */
async function spawnOwnerPatch(page: Page): Promise<void> {
  await installFakeGamepad(page);
  await spawnPatch(
    page,
    [
      { id: CP, type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' },
      { id: 'gp', type: 'gamepad', position: { x: 80, y: 520 }, domain: 'audio' },
      { id: BD, type: 'backdraft', position: { x: 520, y: 80 }, domain: 'video' },
      { id: 'out', type: 'videoOut', position: { x: 900, y: 80 }, domain: 'video' },
    ],
    [
      {
        id: 'e_cv',
        from: { nodeId: 'gp', portId: 'lx' },
        to: { nodeId: BD, portId: 'mix' },
        sourceType: 'cv',
        targetType: 'cv',
      },
      {
        id: 'e_vid',
        from: { nodeId: BD, portId: 'out' },
        to: { nodeId: 'out', portId: 'in' },
        sourceType: 'video',
        targetType: 'video',
      },
    ],
  );
  await expect(page.getByTestId('clipplayer-card')).toBeVisible();
}

/** IN-PAGE record driver: sweep the fake stick across [lo, hi] in graded
 *  sub-steps, ONE SUB-STEP PER ANIMATION FRAME — the gamepad module adopts pad
 *  state per rAF, so one level per frame is the most ANY renderer can express;
 *  pacing from the test side instead parks the stick for a full CDP round trip
 *  per level, longer than a whole loop on a starved shard (and longer than the
 *  idle hold, so the grab decays between iterations). Each frame also reads
 *  the COMMITTED take and finishes the moment `until` is met — `spread` for a
 *  fresh take that must hold movement, `max` for an overdub that must reach a
 *  band — stimulus and observation in ONE evaluate (the instrument rule).
 *  Direction alternates per sweep so consecutive frames always differ. The
 *  wall-clock bound only bounds failure; `frames`/`elapsedMs`/`count` make a
 *  dead run legible. */
async function driveStickUntilTakeMeets(
  page: Page,
  opts: {
    lo: number;
    hi: number;
    subSteps: number;
    until: { metric: 'spread' | 'max'; threshold: number };
    maxFrames: number;
    boundMs: number;
  },
): Promise<{ spread: number; max: number; count: number; frames: number; elapsedMs: number }> {
  return page.evaluate(
    ({ lo, hi, subSteps, until, maxFrames, boundMs }) =>
      new Promise<{ spread: number; max: number; count: number; frames: number; elapsedMs: number }>((resolve) => {
        const w = globalThis as unknown as {
          __fakePad?: { axes: number[]; timestamp: number };
          __patch: {
            nodes: Record<
              string,
              { data?: { auto?: Record<string, { tracks?: Record<string, { events?: Array<{ value?: number }> }> }> } }
            >;
          };
        };
        const t0 = performance.now();
        let frames = 0;
        let sub = 0;
        let dirUp = true;
        let spread = 0;
        let takeMax = -Infinity;
        let count = 0;
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          clearTimeout(bound);
          resolve({ spread, max: takeMax, count, frames, elapsedMs: Math.round(performance.now() - t0) });
        };
        const bound = setTimeout(finish, boundMs);
        const tick = (): void => {
          if (done) return;
          frames += 1;
          sub += 1;
          if (sub >= subSteps) {
            sub = 0;
            dirUp = !dirUp;
          }
          const t = sub / (subSteps - 1);
          const frac = dirUp ? t : 1 - t;
          if (w.__fakePad) {
            w.__fakePad.axes = [lo + frac * (hi - lo), 0, 0, 0];
            w.__fakePad.timestamp = performance.now();
          }
          const evs = w.__patch?.nodes?.['cp']?.data?.auto?.['0']?.tracks?.['bd::mix']?.events;
          if (Array.isArray(evs) && evs.length >= 2) {
            let mn = Infinity;
            let mx = -Infinity;
            for (const e of evs) {
              const v = Number(e?.value);
              if (Number.isFinite(v)) {
                if (v < mn) mn = v;
                if (v > mx) mx = v;
              }
            }
            count = evs.length;
            spread = mx > mn ? mx - mn : 0;
            takeMax = mx;
            const met = until.metric === 'spread' ? spread > until.threshold : takeMax > until.threshold;
            if (met) {
              finish();
              return;
            }
          }
          if (frames >= maxFrames) {
            finish();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    opts,
  );
}

/** IN-PAGE settle watcher: resolve once the committed take has read
 *  byte-identical (and non-empty) for `quietSamples` consecutive timer
 *  samples. Timer-paced ON PURPOSE — see the call site: the writer is the
 *  audio scheduler, itself a main-thread timer, so a serviced quiet run
 *  brackets any pending commit. The bound only bounds failure and the result
 *  carries the diagnostics either way. */
async function waitTakeSettled(
  page: Page,
  opts: { quietSamples: number; sampleMs: number; boundMs: number },
): Promise<{ settled: boolean; quietRun: number; checks: number; elapsedMs: number }> {
  return page.evaluate(
    ({ quietSamples, sampleMs, boundMs }) =>
      new Promise<{ settled: boolean; quietRun: number; checks: number; elapsedMs: number }>((resolve) => {
        const w = globalThis as unknown as {
          __patch: {
            nodes: Record<
              string,
              { data?: { auto?: Record<string, { tracks?: Record<string, { events?: unknown[] }> }> } }
            >;
          };
        };
        const t0 = performance.now();
        let prev = '';
        let quietRun = 0;
        let checks = 0;
        const finish = (settled: boolean): void => {
          clearInterval(timer);
          clearTimeout(bound);
          resolve({ settled, quietRun, checks, elapsedMs: Math.round(performance.now() - t0) });
        };
        const bound = setTimeout(() => finish(false), boundMs);
        const timer = setInterval(() => {
          checks += 1;
          const evs = w.__patch?.nodes?.['cp']?.data?.auto?.['0']?.tracks?.['bd::mix']?.events;
          const cur = JSON.stringify(evs ?? null);
          quietRun = cur !== 'null' && cur !== '[]' && cur === prev ? quietRun + 1 : 0;
          prev = cur;
          if (quietRun >= quietSamples) finish(true);
        }, sampleMs);
      }),
    opts,
  );
}

/** IN-PAGE override driver: wiggle the stick across [lo, hi] one graded
 *  sub-step per frame while reading the ENGINE-EFFECTIVE mix each frame;
 *  finishes the moment a sample crosses `above` (live CV winning the uniform).
 *  Same instrument shape as driveStickUntilTakeMeets, for the same reason: a
 *  test-side wiggle parks the stick for a CDP round trip per level, and on a
 *  starved renderer that pause outlives the idle hold — the cv grab decays
 *  BETWEEN poll iterations and the read catches playback instead of the live
 *  write (measured at 20× CPU throttle over SwiftShader: 0.35 after 30 s). */
async function wiggleUntilEngineAbove(
  page: Page,
  opts: { lo: number; hi: number; subSteps: number; above: number; maxFrames: number; boundMs: number },
): Promise<{ max: number; samples: number; frames: number; elapsedMs: number }> {
  return page.evaluate(
    ({ lo, hi, subSteps, above, maxFrames, boundMs }) =>
      new Promise<{ max: number; samples: number; frames: number; elapsedMs: number }>((resolve) => {
        const w = globalThis as unknown as {
          __fakePad?: { axes: number[]; timestamp: number };
          __engine?: () => { readParam: (n: unknown, p: string) => number | undefined } | null;
          __patch: { nodes: Record<string, unknown> };
        };
        const t0 = performance.now();
        let frames = 0;
        let sub = 0;
        let dirUp = true;
        let max = -Infinity;
        let samples = 0;
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          clearTimeout(bound);
          resolve({ max, samples, frames, elapsedMs: Math.round(performance.now() - t0) });
        };
        const bound = setTimeout(finish, boundMs);
        const tick = (): void => {
          if (done) return;
          frames += 1;
          sub += 1;
          if (sub >= subSteps) {
            sub = 0;
            dirUp = !dirUp;
          }
          const t = sub / (subSteps - 1);
          const frac = dirUp ? t : 1 - t;
          if (w.__fakePad) {
            w.__fakePad.axes = [lo + frac * (hi - lo), 0, 0, 0];
            w.__fakePad.timestamp = performance.now();
          }
          const eng = w.__engine?.();
          const node = w.__patch?.nodes?.['bd'];
          const v = eng && node ? eng.readParam(node, 'mix') : undefined;
          if (typeof v === 'number') {
            samples += 1;
            if (v > max) max = v;
          }
          if (max > above || frames >= maxFrames) {
            finish();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    opts,
  );
}

test('OWNER CASE: gamepad CV movement on a lane-assigned BACKDRAFT records into the clip; the parked stick loops it back; the store and note clip never move', async ({ page, rack }) => {
  void rack;
  test.setTimeout(120_000);
  await spawnOwnerPatch(page);
  await seedClip(page);

  const storeBefore = await storeMix(page);
  const clipBefore = await noteClipSnapshot(page);

  await launchClip(page);
  await armLane0(page);
  expect(await isLane0Armed(page)).toBe(true);

  // RECORD: wiggle the stick (graded sweeps) until the COMMITTED take itself
  // holds real movement. The condition is the take's SPREAD, not an event
  // count: continuous overdub means every wrap re-commits, so the loop that
  // finally plays back is a mosaic of the LAST passes over each step window —
  // on a slow renderer one sweep spans several 1 s passes, and a pass that
  // caught only one flat fragment can satisfy a count while holding no
  // movement at all (measured under E2E_SWIFTSHADER=1: a take of
  // `0.08×3, 0.31×5`). 0.15 ≈ ¾ of one graded sub-step delta (adjacent
  // sub-steps map ~0.21 apart), so any committed pass carrying ≥2 sub-step
  // levels clears it and a flat take cannot. Driven IN-PAGE, one sub-step per
  // frame: a Playwright-side wiggle holds each level for a full CDP round
  // trip — longer than a whole loop on a starved shard, so every pass reads
  // one flat level (measured: CI run 33279139157, 60 s → zero events).
  const rec = await driveStickUntilTakeMeets(page, {
    lo: -0.85,
    hi: 0.85,
    subSteps: 5,
    until: { metric: 'spread', threshold: 0.15 },
    maxFrames: 3600,
    boundMs: 60_000, // bounds FAILURE only; finishes the moment spread crosses
  });
  const recSeen = `committed ${rec.count} events, spread ${rec.spread.toFixed(3)} after ${rec.frames} frames / ${rec.elapsedMs} ms`;
  expect(rec.frames, `record driver never ticked — renderer stalled? (${recSeen})`).toBeGreaterThan(0);
  expect(rec.spread, `recorder should commit a take with movement (${recSeen})`).toBeGreaterThan(0.15);

  // DISARM FIRST, park SECOND — order is load-bearing: disarm commits the
  // in-flight partial pass (disarmLane → commitLanePass), so parking while
  // still armed would record the stick's 0.5 park-hold OVER the take just
  // asserted. Disarming now bounds the contamination to the one segment
  // between the poll's last read and the click; the park then writes nothing.
  await armLane0(page);
  expect(await isLane0Armed(page)).toBe(false);
  await setStickX(page, 0);

  // THE DISARM IS A SYNCED FLAG THE AUDIO SCHEDULER APPLIES ON ITS OWN TICK —
  // and the recorder's final partial-pass commit lands THERE, not at the
  // click. Reading the take too early derives the loop marks from a STALE
  // mosaic while playback loops the settled one (measured under
  // E2E_SWIFTSHADER=1: observed playback max 0.918 against a stale-read
  // takeMax 0.313 — 9 of 12 repeats under load). Wait until the committed
  // take has been QUIET for a run of timer samples — an in-page setInterval
  // watcher, deliberately timer-paced, not rAF-paced: the writer (the audio
  // scheduler) is itself a main-thread timer, so if the watcher's interval
  // fired N times the scheduler's expired intervals were serviced in between
  // — the quiet run genuinely brackets the commit. (An earlier wrap-passage
  // wait here used `=== step` equality and could never observe its window on
  // a starved shard — run 33281413825.)
  const settle = await waitTakeSettled(page, { quietSamples: 10, sampleMs: 150, boundMs: 20_000 });
  expect(
    settle.settled,
    `take should settle after disarm (quiet run ${settle.quietRun}/${10} across ${settle.checks} checks in ${settle.elapsedMs} ms)`,
  ).toBe(true);

  // The FINAL take (nothing can change it now) still holds genuine movement.
  // Floor 0.1 = 20× the recorder's MOVE_EPS: the loop-phase marks below are
  // DERIVED from this take, so the semantic weight sits there — this floor
  // only rejects a take flattened to noise.
  const events = await recordedEvents(page);
  const values = events.map((e) => e.value);
  const takeMin = Math.min(...values);
  const takeMax = Math.max(...values);
  const spread = takeMax - takeMin;
  expect(spread, `final take should hold movement, got ${values.map((v) => v.toFixed(2)).join(',')}`).toBeGreaterThan(0.1);

  // LOOP-WHEN-IDLE: with the stick parked, clip playback must drive the
  // engine through BOTH ends of the take's OWN envelope — thresholds derived
  // from the take, so the assertion is renderer-independent by construction
  // (whatever fragment a slow renderer recorded, playback must reproduce IT).
  // Observed IN-PAGE (observeMixSweep): a Playwright-side `expect.poll`
  // phase-locks with the loop period once its backoff reaches the same range
  // (measured under E2E_SWIFTSHADER=1 on the original ~1 s loop: pinned at
  // 0.92 for 15 s while playback looped underneath). The parked bridge
  // writes ONE constant (~the 0.5 base) until the idle hold decays and it
  // yields — a constant can cross at most one of the two marks, so
  // satisfying BOTH inside one window proves playback drove.
  const above = takeMax - 0.3 * spread;
  const below = takeMin + 0.3 * spread;
  const sweep = await observeMixSweep(page, {
    above,
    below,
    discardFrames: 3, // pad→bridge park-flush (pad poll + bridge tick + margin)
    maxFrames: 3600, // 60 s of 60 fps — the belt when the clock is unreliable
    boundMs: 30_000, // bounds FAILURE only (≥7 loops); healthy runs exit on threshold
  });
  const seen = `take [${takeMin.toFixed(3)}, ${takeMax.toFixed(3)}] → marks <${below.toFixed(3)} / >${above.toFixed(3)}; saw min ${sweep.min.toFixed(3)} / max ${sweep.max.toFixed(3)} over ${sweep.samples} samples in ${sweep.elapsedMs} ms; end state: ${sweep.state}`;
  expect(sweep.samples, `engine never sampled — renderer stalled? (${seen})`).toBeGreaterThan(0);
  expect(sweep.max, `looped playback should reach the take's HIGH end (${seen})`).toBeGreaterThan(above);
  expect(sweep.min, `looped playback should reach the take's LOW end (${seen})`).toBeLessThan(below);

  // CV never reached the shared doc: the store base and the NOTE clip are
  // byte-identical to before the take.
  expect(await storeMix(page)).toBe(storeBefore);
  expect(await noteClipSnapshot(page)).toBe(clipBefore);
});

test('live stick movement OVERRIDES the recorded playback; parking hands the param back; overdub while armed re-records the new movement', async ({ page, rack }) => {
  void rack;
  test.setTimeout(120_000);
  await spawnOwnerPatch(page);
  // A seeded LOW recorded envelope (0.15..0.35) — deterministic playback to
  // override; the live wiggle lives in a disjoint HIGH band (>0.6).
  await seedClip(page, {
    track: [
      { step: 0, value: 0.15 },
      { step: 4, value: 0.35 },
      { step: 7, value: 0.15 },
    ],
  });
  await launchClip(page);

  // Playback drives the LOW envelope (stick parked at 0 — idle source yields).
  await expect
    .poll(async () => (await engineMix(page)) ?? 99, { timeout: 15_000 })
    .toBeLessThan(0.45);

  // LIVE-OVERRIDES-PLAYBACK: while the stick moves in the HIGH band
  // (0.7↔0.95 → mix 0.85↔0.975 around the 0.5 base), live CV wins. Driven and
  // observed IN-PAGE per frame — see wiggleUntilEngineAbove for why a
  // test-side wiggle+poll decays the grab between iterations on a starved
  // renderer. 0.62 is unreachable by the seeded envelope (≤0.35) and by the
  // parked bridge (~0.5): only a live high-band write crosses it.
  const ov = await wiggleUntilEngineAbove(page, {
    lo: 0.7,
    hi: 0.95,
    subSteps: 5,
    above: 0.62,
    maxFrames: 3600,
    boundMs: 30_000, // bounds FAILURE only; exits on the first live crossing
  });
  const ovSeen = `saw max ${ov.max.toFixed(3)} over ${ov.samples} samples / ${ov.frames} frames in ${ov.elapsedMs} ms`;
  expect(ov.samples, `engine never sampled — renderer stalled? (${ovSeen})`).toBeGreaterThan(0);
  expect(ov.max, `live high-band CV should win the uniform over playback (${ovSeen})`).toBeGreaterThan(0.62);

  // Park → the activity hold decays and playback repossesses the param (the
  // recorded LOW envelope drives again).
  await setStickX(page, 0);
  await expect
    .poll(async () => (await engineMix(page)) ?? 99, { timeout: 15_000 })
    .toBeLessThan(0.45);

  // OVERDUB: arm and wiggle HIGH until the COMMITTED take contains the new
  // movement (values in the high band replace the covered window) — the same
  // in-page driver as the owner-case record phase, finishing on the take's
  // MAX: 0.6 is unreachable by the seeded envelope (≤0.35), so only a
  // re-recorded live value crosses it.
  await armLane0(page);
  expect(await isLane0Armed(page)).toBe(true);
  const od = await driveStickUntilTakeMeets(page, {
    lo: 0.7,
    hi: 0.95,
    subSteps: 5,
    until: { metric: 'max', threshold: 0.6 },
    maxFrames: 3600,
    boundMs: 60_000, // bounds FAILURE only; finishes on the first high commit
  });
  const odSeen = `committed ${od.count} events, max ${od.max.toFixed(3)} after ${od.frames} frames / ${od.elapsedMs} ms`;
  expect(od.frames, `overdub driver never ticked — renderer stalled? (${odSeen})`).toBeGreaterThan(0);
  expect(od.max, `overdub should re-record the live high band into the take (${odSeen})`).toBeGreaterThan(0.6);
  await setStickX(page, 0);
  await armLane0(page); // tidy: disarm
  expect(await isLane0Armed(page)).toBe(false);
});
