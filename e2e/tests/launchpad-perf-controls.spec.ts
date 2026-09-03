// e2e/tests/launchpad-perf-controls.spec.ts
//
// SINGLE-UNIT CONTROL-view PERFORMANCE controls, driven through the SAME
// decode/dispatch path real hardware uses (installSimulatedLaunchpadSingle +
// selecting the CONTROL view on the PERMANENT top row — CC 95). These pads write
// the SAME synced node state the card/engine already consume:
//
//   RESET (deck row 1 col 2)  → node.data.resetNonce → every active lane snaps to
//                               step 1 (the card RST / reset-gate field).
//   MUTE  (deck row 3, per-lane) → node.data.muted[lane] → the lane KEEPS
//                               advancing its playhead but emits NO audio.
//   MONO  (deck row 2) / RATE (deck row 4) → the mono[]/rate[] arrays.
//   TEMPO −/+ → the re-homed CONTROL-view grid pads (0,7)/(1,7) → TIMELORDE bpm
//               (the permanent top row now owns CC 91..98, so tempo moved off the
//               old CC 93/94 onto dark CONTROL grid pads — controlRehomePad).
//
// Deck pad coordinates mirror launchpad-map (DECK_RESET/MONO/MUTE/RATE rows); the
// lone device is the L slot, routed by the active VIEW, so we select CONTROL via
// the permanent top-row CC 95.

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow } from './_module-coverage-helpers';
import { SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';
// THE SAME reset instrument the CARD's RST test uses. Shared deliberately —
// see the header of _clip-reset-trace.ts.
import {
  CLIP_STEPS,
  NOMINAL_STEPS_PER_S,
  WRAP_PERIOD_MS,
  startStepTrace,
  stopStepTrace,
  waitForResetSnap,
  waitForWrap,
} from './_clip-reset-trace';

// ⚠ THE PER-TEST BUDGET IS A BOUND, AND IT WAS THE INVISIBLE 30 s DEFAULT.
//
// ⚠ THE SUMMED VARIANT, AND IT HARD-FAILED BOTH ATTEMPTS. The MUTE test below
// declares 15 000 + 8 000 + 4 000 + 15 000 = 42 000 ms of tolerance inside a
// 30 000 ms budget: the bounds cannot all be spent, so the test dies on the
// outer clock before the last poll can even start. Run 33503519404 (branch
// `fix/trails-note-mode-axes`, which touches NO launchpad code) failed it twice:
// `Test timeout of 32594ms exceeded` then `33150ms` — the odd numbers are
// `_setup-credit` crediting the fixture nav.
//
// ⚠ THIS DOES NOT UN-PARK ANYTHING. The two `test.fixme` FLAKE-PARK legs below
// stay parked exactly as they are; a reachable budget is a PRECONDITION of ever
// diagnosing them (the :303 park annotation says so in its own words — "un-park
// = the PAIR's budget diagnosis"), not the diagnosis itself.
//
// An inner bound at or above the budget that CONTAINS it can never come true:
// the outer clock kills the test first, so a legible `element not found` is
// converted into an illegible `Test timeout of 30000ms exceeded` — the class
// #2291 root-caused and #2293 repaired at its second call site. Nothing in this
// file said "30000"; `e2e/playwright.config.ts` never overrides Playwright's
// default, so there was nothing to grep for except the ABSENCE of a budget.
//
// The budget therefore comes from `boot-budget` (90 000 on CI/SwiftShader,
// 30 000 local) instead of the invisible default. A bound only costs wall-clock
// when it is EXCEEDED, so this adds exactly zero to a green run; lane cost stays
// gauged by `--global-timeout`, not by this.
//
// ⚠ BOUNDS ONLY. No assertion, subject or wait target changed here.
test.describe.configure({ mode: 'parallel', timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

// Deck pad placements (launchpad-map: DECK_RESET_COL/ROW, DECK_MONO/MUTE/RATE_ROW).
const RESET_PAD = { x: 2, y: 1 };
const MONO_ROW = 2;
const MUTE_ROW = 3;
const RATE_ROW = 4;
// Permanent top-row CONTROL-view select (topRowAction: CC 95 = control).
const CC_VIEW_CONTROL = 95;
// Re-homed TEMPO −/+ pads on the CONTROL grid's top row (controlRehomePad:
// CTRL_TEMPO_DOWN_COL=0, CTRL_TEMPO_UP_COL=1, CTRL_TEMPO_ROW=7).
const TEMPO_DOWN_PAD = { x: 0, y: 7 };
const TEMPO_UP_PAD = { x: 1, y: 7 };

type EngineW = {
  __engine?: () => { read: (node: { id: string; type: string; domain: string }, key: string) => unknown } | null;
  __patch: { nodes: Record<string, { id: string; type: string; domain: string; params?: Record<string, number>; data?: Record<string, unknown> }> };
  __ydoc: { transact: (fn: () => void) => void };
};

async function readEngine(page: Page, nodeId: string, key: string): Promise<number | null> {
  return await page.evaluate(({ id, k }) => {
    const w = globalThis as unknown as EngineW;
    const eng = w.__engine?.();
    const node = w.__patch.nodes[id];
    if (!eng || !node) return null;
    const v = eng.read(node, k);
    return typeof v === 'number' ? v : null;
  }, { id: nodeId, k: key });
}
async function waitForEngine(page: Page, nodeId: string, key: string, pred: (v: number) => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let last: number | null = null;
  while (Date.now() < deadline) {
    last = await readEngine(page, nodeId, key);
    if (typeof last === 'number' && pred(last)) return { ok: true, last };
    await page.waitForTimeout(50);
  }
  return { ok: false, last };
}

/** Read SEVERAL engine keys in ONE page.evaluate — an ATOMIC sample, so the
 *  values describe the same instant rather than successive ones. */
async function readEngineMany(page: Page, nodeId: string, keys: string[]): Promise<(number | null)[]> {
  return await page.evaluate(({ id, ks }) => {
    const w = globalThis as unknown as EngineW;
    const eng = w.__engine?.();
    const node = w.__patch.nodes[id];
    if (!eng || !node) return ks.map(() => null);
    return ks.map((k) => {
      const v = eng.read(node, k);
      return typeof v === 'number' ? v : null;
    });
  }, { id: nodeId, ks: keys });
}

/**
 * Wait until `pred` holds for EVERY key AT THE SAME INSTANT.
 *
 * Sequential `waitForEngine` calls cannot express a simultaneous condition, and
 * for a transient one they RACE: the second key's observation window only opens
 * once the first key's poll has resolved, by which time a fast-moving value may
 * have entered AND LEFT the band. That is exactly how the RESET assertion below
 * failed on CI — lane 0's poll absorbed the scheduler stall, then lane 1 was
 * sampled after it had already snapped to 0 and climbed back out (it read 84/85
 * = a value on its way UP, not a reset that never happened). Same wall-clock
 * race family as #1173.
 */
async function waitForEngineAll(
  page: Page,
  nodeId: string,
  keys: string[],
  pred: (v: number) => boolean,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let last: (number | null)[] = [];
  while (Date.now() < deadline) {
    last = await readEngineMany(page, nodeId, keys);
    if (last.every((v) => typeof v === 'number' && pred(v))) return { ok: true, last };
    await page.waitForTimeout(50);
  }
  return { ok: false, last };
}

/** Seed DENSE 128-step note clips (a note every step) in slot 0 of `lanes`, and
 *  queue them — via the same Y.Doc path the card/grid use. */
async function seedDenseClips(page: Page, nodeId: string, lanes: number[]) {
  await page.evaluate(({ id, ls }) => {
    const w = globalThis as unknown as EngineW;
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes[id];
      if (!n.data) n.data = {};
      const clips: Record<string, unknown> = {};
      const queued: (number | null)[] = new Array(8).fill(null);
      // Flat clip key is stride-64 (schema v2): clipIndex(slot=0, lane) = lane*64.
      // (The old `lane*8` only matched lane 0 → other lanes were never found = "saw -1".)
      for (const lane of ls) {
        clips[String(lane * 64)] = {
          kind: 'note', lengthSteps: 128, root: 48, loop: true,
          steps: Array.from({ length: 128 }, (_, s) => ({ step: s, midi: 72, velocity: 127, lengthSteps: 1 })),
        };
        queued[lane] = 0;
      }
      n.data.clips = clips;
      n.data.sv = 2; // already stride-64 → skip the legacy re-key migration
      n.data.queued = queued;
    });
  }, { id: nodeId, ls: lanes });
}

async function setTransport(page: Page, running: number, bpm = 240) {
  await page.evaluate(({ run, b }) => {
    const w = globalThis as unknown as EngineW;
    w.__ydoc.transact(() => {
      const tls = Object.values(w.__patch.nodes).filter((n) => n.type === 'timelorde');
      if (tls.length === 0) {
        w.__patch.nodes['tl-perf'] = {
          id: 'tl-perf', type: 'timelorde', domain: 'audio', position: { x: 0, y: 0 },
          params: { running: run, bpm: b }, data: {},
        } as never;
      } else {
        for (const n of tls) { if (!n.params) n.params = {}; n.params.running = run; n.params.bpm = b; }
      }
    });
  }, { run: running, b: bpm });
}

async function installSingle(page: Page, nodeId: string) {
  const ok = await page.evaluate(async (id) => {
    const w = globalThis as unknown as { __launchpadTestInstallSingle?: (id: string) => Promise<boolean> };
    return w.__launchpadTestInstallSingle ? await w.__launchpadTestInstallSingle(id) : false;
  }, nodeId);
  expect(ok, 'single simulated Launchpad install hook present').toBe(true);
}
const press = (page: Page, x: number, y: number) =>
  page.evaluate(({ x, y }) => (globalThis as unknown as { __launchpadSingleSim?: { press: (x: number, y: number) => void } }).__launchpadSingleSim!.press(x, y), { x, y });
// Select the CONTROL view via the PERMANENT top row (CC 95, press+release). The
// lone device binds into the CLIP view, so every perf test selects CONTROL first.
const selectControl = (page: Page) =>
  page.evaluate((c) => {
    const s = (globalThis as unknown as { __launchpadSingleSim?: { cc: (c: number, v: number) => void } }).__launchpadSingleSim!;
    s.cc(c, 127);
    s.cc(c, 0);
  }, CC_VIEW_CONTROL);
const nodeData = (page: Page, nodeId: string) =>
  page.evaluate((id) => (globalThis as unknown as EngineW).__patch.nodes[id]?.data ?? null, nodeId);

// ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
// NONDETERMINISM: 2 recovered-on-retry observation(s) across 1 SHA(s) / 1 branch(es) in the
// 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
// LOST WHILE PARKED: the hardware RESET pad on the single-unit CONTROL view — that it writes resetNonce and every active lane snaps to step 1, a live-performance control with no visual fallback.
// Re-enable only on a root cause (#1847); "it passes now" is not one.
test.fixme('@launchpad RESET pad snaps every active lane back to step 1 (control-deck)', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 2 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio',
      params: { quantize: 0, stepDiv: 2, gateLength: 0.9, octave: 0 } },
    { id: 'tl', type: 'timelorde', position: { x: 520, y: 80 }, domain: 'audio', params: { running: 0, bpm: 240 } },
  ]);
  await expect(page.locator('.svelte-flow__node:has([data-shell-type="clipplayer"])')).toHaveCount(1);
  await installSingle(page, 'cp');

  await seedDenseClips(page, 'cp', [0, 1]);
  await setTransport(page, 1);

  // both lanes well past the top (128-step clip → no wrap in this window).
  const l0 = await waitForEngine(page, 'cp', 'currentStep:0', (v) => v >= 8, 6000);
  expect(l0.ok, `lane 0 mid-clip before reset (saw ${l0.last})`).toBe(true);

  // ── WHY THIS IS NOT A TIMED STEP-BAND ANY MORE ──────────────────────────
  //
  // ⚠ THIS ASSERTION WAS BUDGET-BUMPED TWICE AND NEVER CHANGED SHAPE.
  //   #1100 (a79d360cb)  2500 → 5000 ms, "CI-LOAD RACE … saw step ~43/~45"
  //   #1174 (37cb72709)  two sequential 5000 ms polls → one atomic poll,
  //                      "the CI reading (84/85 at bpm 240) is a value on its
  //                       way UP — raising the timeout would have made it WORSE"
  // Both notes are correct and both left an ABSOLUTE `0 <= step <= 6` band read
  // over CDP after the press. A third bump is not a fix, and #1174's own
  // sentence says why: the binding constraint is the latency between the reset
  // FIRING and the first READ, so a longer window only buys more chances to
  // read a playhead that is climbing away at 16 steps/s.
  //
  // The band is not even SOUND. `MAX_CLIP_STEPS` is 128 at 16 steps/s, so the
  // natural wrap horizon is 8 s — a window long enough to absorb a stalled
  // main thread is also long enough to read `<= 6` from a LOOP WRAP with no
  // reset at all. The sibling CARD RST test measured exactly that (#1173, its
  // numbers are in _clip-reset-trace.ts) and was rebuilt; this test kept the
  // instrument that measurement condemned, while its comment claimed "same
  // tolerance as the card RST test".
  //
  // Two load-invariant observables replace it, and they answer DIFFERENT
  // questions — which is the point, because the old single band could not tell
  // "the pad never dispatched" from "the engine never consumed it".
  //
  //   A. `data.resetNonce` — a MONOTONIC COUNTER on synced node data, and the
  //      only thing `doReset()` writes. It proves pad → decode → dispatch →
  //      Y.Doc happened, with no timing dependence at all: a counter that has
  //      incremented stays incremented no matter how starved the thread was.
  //      This half is what the launchpad test is actually FOR.
  //   B. the shared in-page trace — a BACKWARD JUMP in both playheads too fast
  //      to be a wrap. `currentStep` is monotone between wraps and resets, so a
  //      decrease has exactly two causes and the wrap is excluded by
  //      ARITHMETIC. This half is the engine consuming the nonce.
  //
  // Neither has an acceptance window to widen. The recorder starts BEFORE the
  // press and keeps running through it, so however long dispatch takes, the
  // event is inside the trace rather than missed by a poll that arrived late.
  const nonceBefore = ((await nodeData(page, 'cp'))?.resetNonce as number | undefined) ?? 0;
  await startStepTrace(page, 'cp', ['currentStep:0', 'currentStep:1']);

  // Select the CONTROL view (permanent top row) + press the hardware RESET pad.
  await selectControl(page);
  await press(page, RESET_PAD.x, RESET_PAD.y);

  // A — the pad reached the graph. Counter comparison, not a step band.
  await expect
    .poll(
      async () => ((await nodeData(page, 'cp'))?.resetNonce as number | undefined) ?? 0,
      {
        message:
          `the RESET pad never incremented data.resetNonce (was ${nonceBefore}). That is the ` +
          `pad → launchpad-map decode → doReset → Y.Doc half, which has no timing in it — ` +
          `so this failing means the press was not routed, NOT that the runner was slow. ` +
          `Check the CONTROL view selection and DECK_RESET_COL/ROW.`,
        timeout: 5000,
      },
    )
    .toBeGreaterThan(nonceBefore);

  // B — the engine consumed it. Same predicate the card RST test calls.
  // Resolves in ~50 ms when healthy; the 8 s ceiling BOUNDS THE FAILURE and is
  // not the gate — it absorbs a starved main-thread scheduler tick (the only
  // consumer of resetNonce) without widening any acceptance window, because
  // there is no longer an acceptance window.
  const proved = await waitForResetSnap(page, 8000);
  const trace = await stopStepTrace(page);
  expect(
    proved,
    `resetNonce advanced (the pad dispatched), but no BACKWARD jump too fast to be a loop ` +
      `wrap was recorded — so the graph got the reset and the engine did not act on it. ` +
      `trace: ${JSON.stringify(trace)}`,
  ).toBe(true);

  // Still PLAYING (reset ≠ stop) + advancing.
  expect(await readEngine(page, 'cp', 'activeLane:0')).toBe(0);
  const resumed = await waitForEngine(page, 'cp', 'currentStep:0', (v) => v >= 6, 4000);
  expect(resumed.ok, `lane 0 kept advancing after reset (saw ${resumed.last})`).toBe(true);
});

// ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; body and assertions UNCHANGED.
//
// ⚠ THIS IS THE NEGATIVE CONTROL OF AN ALREADY-PARKED POSITIVE, and parking it
// is closing a half-open pair rather than widening the debt. The positive leg
// at :190 is parked; this is the control that keeps it honest, and the two are
// co-nondeterministic BY CONSTRUCTION — both ride the same free-running
// 128-step clip whose 8 s wrap is what the control exists to distinguish from a
// real reset. Leaving the control running while its positive sits parked is
// the "a passing negative control is not enough" problem from the other side:
// a control with no positive proves only that the probe can stay silent, which
// is half-coverage at best and misleading at worst.
//
// FIRST observation of THIS leg recovering (run 32725328269 shard 2/10,
// 2026-08-24 12:31Z; absent from main's previous 8 runs). NOT triaged as flake
// vs under-budget. UN-PARK IS THE PAIR'S BUDGET DIAGNOSIS — un-parking this one
// alone would restore a control whose positive is still parked, i.e. exactly
// the half-pair this park exists to end.
test.fixme('@launchpad RESET negative control: without the pad press, neither observable fires', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — recovered-on-retry, FIRST observation of THIS leg (run 32725328269 shard 2/10, 2026-08-24 12:31Z; not on main\'s previous 8 runs), NOT yet triaged as flake vs under-budget; NEGATIVE CONTROL of the already-parked positive at :190 — the pair is co-nondeterministic by construction (same free-running 128-step clip whose 8 s wrap is what this control distinguishes from a real reset), and a control without its positive is half-coverage; un-park = the PAIR\'s budget diagnosis' } }, async ({ page, rack }) => {
  // ⚠ THE LEG THAT KEEPS THE ONE ABOVE HONEST, and the one the old absolute
  // band could not have had: a free-running 128-step clip WRAPS every 8 s, and
  // a wrap reads `step <= 6` exactly like a reset does. Under the old
  // assertion, "the reset works" and "we waited long enough for a wrap" were
  // indistinguishable from the output.
  //
  // So: run the identical patch, select CONTROL, press NOTHING, and watch for
  // longer than a wrap horizon. Both observables must stay silent — the nonce
  // because nothing dispatched, and the trace because `waitForResetSnap`
  // excludes a wrap by arithmetic rather than by out-running it.
  await spawnPatch(page, [
    { id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio',
      params: { quantize: 0, stepDiv: 2, gateLength: 0.9, octave: 0 } },
    { id: 'tl', type: 'timelorde', position: { x: 520, y: 80 }, domain: 'audio', params: { running: 0, bpm: 240 } },
  ]);
  await expect(page.locator('.svelte-flow__node:has([data-shell-type="clipplayer"])')).toHaveCount(1);
  await installSingle(page, 'cp');
  await seedDenseClips(page, 'cp', [0, 1]);
  await setTransport(page, 1);

  const l0 = await waitForEngine(page, 'cp', 'currentStep:0', (v) => v >= 8, 6000);
  expect(l0.ok, `lane 0 mid-clip before the control window (saw ${l0.last})`).toBe(true);

  const nonceBefore = ((await nodeData(page, 'cp'))?.resetNonce as number | undefined) ?? 0;
  await startStepTrace(page, 'cp', ['currentStep:0', 'currentStep:1']);
  await selectControl(page);

  // NO press — and the window must CONTAIN a genuine wrap, which is precisely
  // what must not be mistaken for a reset.
  //
  // ⚠ THIS USED TO BE `waitForResetSnap(page, 9000)`, AND THE 9000 WAS THE BUG
  // (#1847 recovered-flake on #2150's run). 9000 ms is 1.125× the NOMINAL wrap
  // horizon, so the entire margin was 1 s of a runner being at nominal speed. It
  // is not: the failing run measured 9588 ms elapsed with 0 wraps, i.e. a lane
  // clock of ~13.3 steps/s against a nominal 16 — a perfectly healthy rack whose
  // wrap simply fell outside the window. Under-budgeted, not nondeterministic;
  // "the result is different here" and "the instrument is different here" need
  // opposite fixes, and this is the second.
  //
  // A BIGGER NUMBER IS NOT THE FIX EITHER — it is the same bug with more slack,
  // and it re-breaks on the next slower runner. A wrap is CLIP_STEPS of STEP
  // advance; its wall-clock duration is a property of the runner. So the gate is
  // now the WRAP EVENT and the clock only BOUNDS the failure, which is the lane
  // -clock form of "count frames, never milliseconds".
  //
  // The cap is DERIVED (`WRAP_PERIOD_MS` = CLIP_STEPS / NOMINAL_STEPS_PER_S) and
  // deliberately several periods wide: it is a bound on a hang, not an
  // acceptance window, so widening it cannot buy a pass the way widening the old
  // window did. A run that needs it has a lane clock under a quarter of nominal.
  const WRAP_CAP_MS = WRAP_PERIOD_MS * 4;
  const wraps = await waitForWrap(page, WRAP_CAP_MS);

  // The false-positive predicate scans EVERY drop recorded since
  // `startStepTrace`, including the wrap just observed — so this needs no window
  // of its own to be sound. The short derived slice is only so a jump landing
  // between the two calls is still seen.
  const falsePositive = await waitForResetSnap(page, WRAP_PERIOD_MS / 8);
  const trace = await stopStepTrace(page);
  const nonceAfter = ((await nodeData(page, 'cp'))?.resetNonce as number | undefined) ?? 0;

  expect(
    nonceAfter,
    'resetNonce moved with no pad pressed — something else is writing it',
  ).toBe(nonceBefore);
  expect(
    falsePositive,
    `waitForResetSnap reported a reset with NO pad pressed. Over ${trace.spanMs} ms it saw ` +
      `${trace.drops.length} backward jump(s) and classified one as too-fast-for-a-wrap; at ` +
      `rate ${trace.rate} steps/s those are loop wraps. The arithmetic wrap exclusion is ` +
      `broken, which would make the test above pass on a wrap. trace: ${JSON.stringify(trace)}`,
  ).toBe(false);
  // NON-VACUITY: the window must actually have contained the thing being
  // excluded, or "no false positive" is a statement about an idle rack.
  //
  // Units, because half the bugs in this area were unit confusions: `wraps` and
  // `drops` are a COUNT of backward jumps; `spanMs` / `WRAP_CAP_MS` /
  // `WRAP_PERIOD_MS` are wall clock; `rate` is STEPS PER SECOND. Reaching the
  // cap with 0 wraps now means the lane clock is under a quarter of nominal (or
  // stopped) — a real finding — rather than the old "your runner was 1.2x slow".
  //
  // ⚠ `trace.rate` IS A FLOOR, NOT A MEASUREMENT, and the message says so
  // because the draft of it quietly did the opposite. `startStepTrace` only ever
  // RAISES rate above nominal (`Math.max(rate, dS / dT)`) — deliberately, since
  // a faster assumed clock shrinks `wrapMs` and makes the wrap exclusion
  // stricter. The consequence is that rate CANNOT report a SLOW lane clock,
  // which is precisely the condition that produces this failure. Verified by
  // running this leg against a deliberately halved lane clock: the real rate was
  // 8 steps/s and the trace still reported 16. A diagnostic that misreports the
  // one quantity you would diagnose with is worse than no diagnostic, so it is
  // labelled rather than printed as if it were observed.
  expect(
    trace.drops.length,
    `no backward jump at all: ${wraps} wrap(s) in ${trace.spanMs} ms wall clock (cap ` +
      `${WRAP_CAP_MS} ms = 4 x WRAP_PERIOD_MS ${WRAP_PERIOD_MS} ms, itself CLIP_STEPS ` +
      `${CLIP_STEPS} / NOMINAL_STEPS_PER_S ${NOMINAL_STEPS_PER_S} steps/s). The clip never ` +
      `wrapped, so this control never exercised the wrap exclusion it exists to test. ` +
      `trace.rate ${trace.rate} steps/s is the wrap-exclusion clock FLOOR (never lowered below ` +
      `nominal by design), so it cannot show a slow lane clock — compare spanMs against ` +
      `WRAP_PERIOD_MS instead. Sampler: ${trace.samples} samples, max gap ${trace.maxGapMs} ms. ` +
      `Is the transport running?`,
  ).toBeGreaterThan(0);
});

test('@launchpad MUTE pad silences a running lane in place — RMS drops to ~0 while its step keeps advancing; unmute returns audio', async ({ page, rack }) => {
  await spawnPatch(
    page,
    [
      { id: 'cp', type: 'clipplayer', position: { x: 60, y: 60 }, domain: 'audio',
        params: { quantize: 0, stepDiv: 2, gateLength: 0.9, octave: 0 } },
      { id: 'vco', type: 'analogVco', position: { x: 360, y: 60 }, domain: 'audio' },
      { id: 'vca', type: 'vca', position: { x: 640, y: 60 }, domain: 'audio', params: { base: 0, cvAmount: 1 } },
      { id: 'scp', type: 'scope', position: { x: 920, y: 60 }, domain: 'audio', params: { timeMs: 200 } },
      { id: 'tl', type: 'timelorde', position: { x: 60, y: 360 }, domain: 'audio', params: { running: 0, bpm: 240 } },
    ],
    [
      { id: 'h1', from: { nodeId: 'cp', portId: 'pitch1' }, to: { nodeId: 'vco', portId: 'pitch' }, sourceType: 'polyPitchGate', targetType: 'pitch' },
      { id: 'h2', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'vca', portId: 'audio' }, sourceType: 'audio', targetType: 'audio' },
      { id: 'h3', from: { nodeId: 'cp', portId: 'gate1' }, to: { nodeId: 'vca', portId: 'cv' }, sourceType: 'gate', targetType: 'cv' },
      { id: 'h4', from: { nodeId: 'vca', portId: 'audio' }, to: { nodeId: 'scp', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
    ],
  );
  await expect(page.locator('.svelte-flow__node:has([data-shell-type="clipplayer"])')).toHaveCount(1);
  await installSingle(page, 'cp');

  await seedDenseClips(page, 'cp', [0]); // dense lane 0 → continuous audio
  await setTransport(page, 1);

  // Lane 0 runs → AUDIBLE.
  let live = await readScopePeakOverWindow(page, 'scp', 600);
  await expect
    .poll(async () => { live = await readScopePeakOverWindow(page, 'scp', 600); return live.rms; }, { timeout: 15000, message: 'audible while lane 0 runs' })
    .toBeGreaterThan(0.03);
  const stepBeforeMute = (await readEngine(page, 'cp', 'currentStep:0')) ?? -1;
  expect(stepBeforeMute).toBeGreaterThanOrEqual(0);

  // MUTE lane 0 (control deck, row 3 col 0) → output falls to ~0.
  await selectControl(page);
  await press(page, 0, MUTE_ROW);
  expect((await nodeData(page, 'cp') as { muted?: boolean[] } | null)?.muted?.[0]).toBe(true);
  await expect
    .poll(async () => (await readScopePeakOverWindow(page, 'scp', 400)).rms, { timeout: 8000, message: 'muted lane falls silent' })
    .toBeLessThan(0.03);
  // ...but its playhead KEEPS advancing (mute ≠ stop, still locked to transport).
  const advanced = await waitForEngine(page, 'cp', 'currentStep:0', (v) => v > (stepBeforeMute % 128) || v < stepBeforeMute, 4000);
  expect(advanced.ok, `muted lane kept advancing (saw ${advanced.last}, was ${stepBeforeMute})`).toBe(true);
  expect(await readEngine(page, 'cp', 'activeLane:0'), 'still active (mute ≠ stop)').toBe(0);

  // UNMUTE → audio returns.
  await press(page, 0, MUTE_ROW);
  expect((await nodeData(page, 'cp') as { muted?: boolean[] } | null)?.muted?.[0]).toBe(false);
  await expect
    .poll(async () => (await readScopePeakOverWindow(page, 'scp', 600)).rms, { timeout: 15000, message: 'audio returns after unmute' })
    .toBeGreaterThan(0.03);
});

test('@launchpad MONO / RATE / tempo deck pads write the synced node state', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio', params: {} },
    { id: 'tl', type: 'timelorde', position: { x: 520, y: 80 }, domain: 'audio', params: { running: 0, bpm: 120 } },
  ]);
  await expect(page.locator('.svelte-flow__node:has([data-shell-type="clipplayer"])')).toHaveCount(1);
  await installSingle(page, 'cp');
  await selectControl(page); // → CONTROL (the deck)

  // MONO lane 3 (row 2, col 3).
  await press(page, 3, MONO_ROW);
  expect((await nodeData(page, 'cp') as { mono?: boolean[] } | null)?.mono?.[3]).toBe(true);
  // RATE lane 1 cycles up from the default '1' (index 3) → 2x (index 4).
  await press(page, 1, RATE_ROW);
  expect((await nodeData(page, 'cp') as { rate?: number[] } | null)?.rate?.[1]).toBe(4);
  // Tempo nudge − / + (the re-homed CONTROL-view grid pads) step TIMELORDE bpm
  // (clamped 10..300).
  const bpm0 = await page.evaluate(() => (globalThis as unknown as EngineW).__patch.nodes['tl'].params?.bpm);
  await press(page, TEMPO_UP_PAD.x, TEMPO_UP_PAD.y);
  const bpmUp = await page.evaluate(() => (globalThis as unknown as EngineW).__patch.nodes['tl'].params?.bpm);
  expect(bpmUp!).toBeGreaterThan(bpm0!);
  await press(page, TEMPO_DOWN_PAD.x, TEMPO_DOWN_PAD.y);
  await press(page, TEMPO_DOWN_PAD.x, TEMPO_DOWN_PAD.y);
  const bpmDown = await page.evaluate(() => (globalThis as unknown as EngineW).__patch.nodes['tl'].params?.bpm);
  expect(bpmDown!).toBeLessThan(bpmUp!);
});
