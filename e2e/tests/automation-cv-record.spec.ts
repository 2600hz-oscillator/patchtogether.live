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
// itself is not in e2e/webgl-heavy-globs.ts), and renderer-independent: all
// pad updates are frame-gated (`waitFrames`) and every wait is an
// `expect.poll` on the real subject, so SwiftShader's ~7.9 fps only stretches
// the same assertions.
//
// The AUDIO-cable CV-exclusion case (clip-automation.spec.ts case 10 — an LFO
// cv CABLE into an audio param records nothing) is UNCHANGED: audio-domain cv
// cables sum inside the Web Audio graph and fire no bridge tick; only the
// video cv-bridge has the activity seam today.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { waitForSoundingStep } from './_scheduler-control';
import { waitFrames } from '../_helpers/frames';
import type { Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const CP = 'cp';
const BD = 'bd';
const IDX = 0; // lane 0, slot 0 → flat stride-64 clip key 0
const CLIP_LEN = 8; // ~1s loops at 120bpm free-run 1/16 — fast, deterministic

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
  await waitForSoundingStep(page, CP, 3, { key: 'currentStep:0', timeoutMs: 8000 });
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

/** One wiggle beat: sweep the stick across [lo, hi] in graded sub-steps, each
 *  gated on 2 frames (1 for the pad poll to observe it, 1 for the bridge tick)
 *  — the SAME frame-gated cadence gamepad.spec.ts uses. GRADED, not a single
 *  flip, deliberately: `expect.poll` backs off to ≥1s between predicate calls,
 *  longer than the product's CV_ACTIVITY_IDLE_MS (300 ms), so a one-flip
 *  wiggler degenerates into flat step-functions — each re-grab segment holds
 *  ONE value and the record gate correctly drops it as unmoved (a real stick
 *  varies continuously; the scripted stand-in must too). Alternates direction
 *  per call so consecutive calls also differ. */
function makeWiggler(page: Page, lo: number, hi: number) {
  let flip = false;
  const SUB_STEPS = 5;
  return async (): Promise<void> => {
    flip = !flip;
    for (let i = 0; i < SUB_STEPS; i++) {
      const t = i / (SUB_STEPS - 1);
      const frac = flip ? t : 1 - t;
      await setStickX(page, lo + frac * (hi - lo));
      await waitFrames(page, 2);
    }
  };
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

  // RECORD: wiggle the stick (full sweeps) until the recorder has punched in
  // at the clip's wrap and committed a pass with the movement. The poll body
  // keeps the source ACTIVE while it waits — recording continues for exactly
  // as long as the assertion needs, on any renderer.
  const wiggle = makeWiggler(page, -0.85, 0.85);
  await expect
    .poll(
      async () => {
        await wiggle();
        return (await recordedEvents(page)).length;
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(1);

  // Park the stick, disarm (take done).
  await setStickX(page, 0);
  await armLane0(page);
  expect(await isLane0Armed(page)).toBe(false);

  // The take holds the MOVEMENT: a ±0.85 sweep across mix's 0..1 range spans
  // most of it — not a flat line at the store base.
  const events = await recordedEvents(page);
  const values = events.map((e) => e.value);
  const spread = Math.max(...values) - Math.min(...values);
  expect(spread, `recorded values should sweep, got ${values.map((v) => v.toFixed(2)).join(',')}`).toBeGreaterThan(0.3);

  // LOOP-WHEN-IDLE: with the stick parked, clip playback drives the recorded
  // movement through the engine — the param passes BOTH halves of the sweep
  // every ~1s loop. Polling the engine value IS the wait (no wall-clock).
  await expect
    .poll(async () => (await engineMix(page)) ?? -1, { timeout: 15_000 })
    .toBeGreaterThan(0.6);
  await expect
    .poll(async () => (await engineMix(page)) ?? 99, { timeout: 15_000 })
    .toBeLessThan(0.4);

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
  // (0.7↔0.95 → mix 0.85↔0.975 around the 0.5 base), live CV wins.
  const wiggleHigh = makeWiggler(page, 0.7, 0.95);
  await expect
    .poll(
      async () => {
        await wiggleHigh();
        return (await engineMix(page)) ?? -1;
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0.62);

  // Park → the activity hold decays and playback repossesses the param (the
  // recorded LOW envelope drives again).
  await setStickX(page, 0);
  await expect
    .poll(async () => (await engineMix(page)) ?? 99, { timeout: 15_000 })
    .toBeLessThan(0.45);

  // OVERDUB: arm and wiggle HIGH until the committed take contains the new
  // movement (values in the high band replace the covered window).
  await armLane0(page);
  expect(await isLane0Armed(page)).toBe(true);
  await expect
    .poll(
      async () => {
        await wiggleHigh();
        const evs = await recordedEvents(page);
        return evs.length ? Math.max(...evs.map((e) => e.value)) : -1;
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0.6);
  await setStickX(page, 0);
  await armLane0(page); // tidy: disarm
  expect(await isLane0Armed(page)).toBe(false);
});
