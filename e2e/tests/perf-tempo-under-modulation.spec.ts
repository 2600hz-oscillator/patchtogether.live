// e2e/tests/perf-tempo-under-modulation.spec.ts
//
// Regression spec for the "tempo / audio glitching when faders are
// hand-modulated" user report. Complement to `tempo-stability.spec.ts`
// (PR #90):
//
//   - PR #90 protected the audio scheduler against main-thread JANK
//     by moving its tick to a Web Worker + bumping its lookahead. The
//     audio thread now rides out short blocking bursts unconditionally.
//
//   - This spec protects against the orthogonal *throughput* problem
//     on the param-update path. A real hand-drag on a Fader fires
//     pointermove at 120–240 Hz on modern hardware. Without
//     coalescing, EACH event mutates the SyncedStore patch graph,
//     which rebuilds the snapshot bus payload (O(n+e)) and pushes it
//     to every subscriber (audio reconciler walks the snapshot; the
//     Canvas Svelte UI re-runs many `$derived` blocks; SvelteFlow
//     re-paints its node-array). On a heavy graph this storm visibly
//     freezes the UI and — on slower hardware than CI's headless
//     Chromium — eventually starves the audio scheduler's lookahead.
//
// User-reported diagnostic: LFOs driving the SAME AudioParam never
// glitch, because Web Audio's `.connect(audioParam)` path is wholly
// inside the audio thread (it never touches the JS patch graph). The
// contrast localised the bug to the manual-modulation code path.
//
// Fix (this branch): the Fader + Knob controls now rAF-coalesce their
// `onchange` (= patch-store mutation) callbacks. Local `liveValue`
// still updates synchronously inside `pointermove` (visual snap
// preserved), but the patch-store commit batches to at most one per
// frame (~60 Hz) regardless of how fast pointermove fires.
//
// What we assert
// --------------
// The load-bearing invariant of the fix is: under a high-rate fader
// drag, the number of Y.Doc updates fired stays comfortably below
// the number of pointermove events the fader sees. We measure:
//
//   - pointerEvents: how many pointermoves the fader received
//   - yDocCommits:  how many Yjs `update` events fired
//   - ratio = commits / events
//
// Without the fix, ratio ≈ 0.8 (essentially 1:1 — every move triggers
// a commit). With the fix, ratio ≤ ~0.1 (one commit per frame, many
// pointermoves per frame at typical drag rates).
//
// We choose a comfortable ratio ceiling that's WAY below the
// un-coalesced regime but well above the fix's actual performance,
// so CI scheduler slop never flakes it. Asserting the invariant
// directly (rather than its downstream tempo effect) makes the spec
// sensitive — PR #90's worker tick is robust enough to keep tempo
// stable even under the un-coalesced 240 Hz burst on a small graph,
// so a tempo-only assertion would pass even with the regression
// re-introduced.
//
// We ALSO assert (a) the underlying patch mutation actually happens
// — guard against a stress that silently no-ops, and (b) the
// downstream tempo doesn't drift — backstop for the broader user
// symptom even if a future change loosens the ratio invariant.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

const SEQ_BPM = 120;
/** 120 BPM 16th-note pulses arrive at 8/sec. Over a 3 s window the
 *  scheduler advances ~24 times. Floor / ceiling generous enough to
 *  ride out CI scheduler slop while well outside what a starved
 *  scheduler would produce. */
const RUN_MS = 3000;
const TEMPO_MIN = 20;
const TEMPO_MAX = 28;

/** Maximum acceptable commit-to-pointerEvent ratio under high-rate
 *  drag. The fix achieves ≈ 0.085 on local hardware; the
 *  un-coalesced regression sits at ≈ 0.79. We pick 0.30 — well below
 *  the regression, well above the fix's headroom — so a CI worker
 *  that throttles rAF to ~30 Hz still passes. */
const MAX_COMMIT_RATIO = 0.3;

/** Lower bound on pointerEvents so we know the stress actually ran
 *  (defensive — see `expect(baseAfter).not.toBe(baseBefore)` below
 *  for the same idea applied to the patch store). */
const MIN_POINTER_EVENTS = 200;

/** Read the sequencer's monotonic step counter via the dev-only
 *  `__engine` global (same surface PR #90's spec uses). Diagnostic
 *  negative sentinels:
 *    -1 = __engine global missing or null
 *    -2 = patch.nodes[id] missing
 *    -3 = engine.read returned a non-number
 */
async function readAdvances(page: Page, nodeId: string): Promise<number> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string } | undefined> };
    };
    const eng = w.__engine?.();
    if (!eng) return -1;
    const node = w.__patch.nodes[id];
    if (!node) return -2;
    const v = eng.read(node, 'totalAdvances');
    return typeof v === 'number' ? v : -3;
  }, nodeId);
}

/** Wait until the sequencer has produced at least one step. Catches
 *  the race where the test asks for the advance count before the
 *  engine has finished materialising the node + the scheduler has
 *  kicked off. */
async function waitForSequencerWarm(page: Page, nodeId: string): Promise<void> {
  await page.waitForFunction(
    (id) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          read: (n: { id: string; type: string; domain: string }, key: string) => unknown;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string } | undefined> };
      };
      const eng = w.__engine?.();
      if (!eng) return false;
      const node = w.__patch.nodes[id];
      if (!node) return false;
      const v = eng.read(node, 'totalAdvances');
      return typeof v === 'number' && v > 0;
    },
    nodeId,
    { timeout: 5000 },
  );
}

interface StressResult {
  pointerEvents: number;
  commits: number;
}

/** Stress the patch-store hot path by synthesizing high-rate
 *  pointermove events on the first fader inside `cardLocator`. We
 *  bypass Playwright's rate-limited `page.mouse.move` (each step
 *  ~5–10 ms = ~150 Hz max) in favour of dispatching real
 *  PointerEvents from page context, so we can produce 1000+
 *  events/sec — the realistic rate a fast hand-drag on a 240 Hz
 *  tablet produces.
 *
 *  Returns: how many pointermoves were dispatched and how many Yjs
 *  `update` events fired in response (the load-bearing measurement). */
async function stressFader(
  page: Page,
  cardLocator: string,
  durationMs: number,
): Promise<StressResult> {
  const fader = page.locator(`${cardLocator} .track`).first();
  await fader.scrollIntoViewIfNeeded();
  const box = await fader.boundingBox();
  if (!box) throw new Error('stressFader: could not measure fader bounds');

  return await page.evaluate(
    async ({ box, durationMs }) => {
      // Re-locate the precise track element by bounding-rect match
      // (defends against node-position changes between the bounding-
      // box capture above and the dispatch loop below).
      const all = document.querySelectorAll<HTMLElement>('.svelte-flow__node .track');
      let track: HTMLElement | null = null;
      for (const t of all) {
        const r = t.getBoundingClientRect();
        if (
          Math.abs(r.x - box.x) < 4 &&
          Math.abs(r.y - box.y) < 4 &&
          Math.abs(r.width - box.width) < 4
        ) {
          track = t;
          break;
        }
      }
      if (!track) throw new Error('stressFader: could not relocate track in page');

      // Count Yjs `update` events fired during the stress window. The
      // patch store mutates inside ydoc.transact(), so each
      // pointermove that survives coalescing fires exactly one
      // update. With coalescing active this approaches frame-rate
      // (~60 Hz); without, it tracks pointer-event rate.
      let commits = 0;
      const w = globalThis as unknown as {
        __ydoc?: {
          on: (e: string, cb: () => void) => void;
          off: (e: string, cb: () => void) => void;
        };
      };
      const onUpdate = () => {
        commits++;
      };
      w.__ydoc?.on('update', onUpdate);

      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const pid = 1;
      const dispatch = (type: string, clientX: number, clientY: number): void => {
        const ev = new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: pid,
          pointerType: 'mouse',
          clientX,
          clientY,
          button: 0,
          buttons: type === 'pointerup' ? 0 : 1,
        });
        track!.dispatchEvent(ev);
      };

      dispatch('pointerdown', cx, cy);
      const start = performance.now();
      let i = 0;
      try {
        while (performance.now() - start < durationMs) {
          // Zig-zag within the track. Use sin so the value changes
          // smoothly + always differs from the previous step (avoids
          // the no-op `newValue !== value` skip inside the Fader
          // handler).
          const phase = i * 0.07;
          const yFrac = 0.5 + 0.45 * Math.sin(phase);
          const ty = box.y + 4 + yFrac * (box.height - 8);
          dispatch('pointermove', cx, ty);
          // Yield every 8 events so the page can run rAF + engine
          // callbacks. We're stressing per-event cost, not freezing
          // the page.
          if (i % 8 === 7) {
            await new Promise<void>((r) => setTimeout(r, 0));
          }
          i++;
        }
      } finally {
        dispatch('pointerup', cx, cy);
        w.__ydoc?.off('update', onUpdate);
      }
      return { pointerEvents: i, commits };
    },
    { box, durationMs },
  );
}

test('perf-tempo-under-modulation: hand-drag coalesces patch-store commits to ≤ rAF rate', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Sequencer at 120 BPM (so tempo backstop has signal) + a VCA whose
  // Base fader we'll stress. The VCA is a convenient "card with a
  // fader and a CV input" and lives on the same module-coverage path
  // that the user-reported RUTTEZRA case also lives on.
  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'sequencer', params: { bpm: SEQ_BPM, length: 16, isPlaying: 1 } },
      { id: 'vca', type: 'vca', params: { base: 0.5, cvAmount: 1 } },
    ],
    [],
  );

  await waitForSequencerWarm(page, 'seq');
  const advancesBefore = await readAdvances(page, 'seq');
  const baseBefore = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> } | undefined> };
    };
    return w.__patch.nodes['vca']?.params?.['base'];
  });

  const stressResult = await stressFader(page, '[data-id="vca"]', RUN_MS).catch((err) => {
    console.error('drag helper threw:', err);
    return { pointerEvents: 0, commits: 0 } as StressResult;
  });

  const advancesAfter = await readAdvances(page, 'seq');
  const baseAfter = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> } | undefined> };
    };
    return w.__patch.nodes['vca']?.params?.['base'];
  });
  const tempoDelta = advancesAfter - advancesBefore;
  const ratio = stressResult.commits / Math.max(1, stressResult.pointerEvents);

  // Diagnostic log so CI runs surface the actual measurement.
  // eslint-disable-next-line no-console
  console.log(
    `[perf-tempo-under-modulation] tempoDelta=${tempoDelta} ` +
      `(${advancesBefore}→${advancesAfter}) ` +
      `base ${baseBefore}→${baseAfter} ` +
      `pointerEvents=${stressResult.pointerEvents} ` +
      `yDocCommits=${stressResult.commits} ` +
      `ratio=${ratio.toFixed(3)}`,
  );

  // 1) The stress actually ran. Guards a spec that selector-misses
  //    or has its synthetic events silently dropped.
  expect(
    stressResult.pointerEvents,
    `stressFader dispatched only ${stressResult.pointerEvents} pointermoves; ` +
      `expected ≥ ${MIN_POINTER_EVENTS}. The stress isn't loading the ` +
      `path it's supposed to test — check the selector + event dispatch.`,
  ).toBeGreaterThanOrEqual(MIN_POINTER_EVENTS);

  // 2) The stress actually mutated the patch. Catches the case where
  //    pointermoves fire but the Fader's drag state machine rejects
  //    them (e.g. no pointerdown setup), so commit count would
  //    legitimately stay at 0.
  expect(
    baseAfter,
    `stressFader did not mutate vca.base (before=${baseBefore} after=${baseAfter}). ` +
      `The stress reached the DOM but not the patch store.`,
  ).not.toBe(baseBefore);

  // 3) THE invariant the fix guarantees: commits/event ratio stays
  //    below the threshold. Without the fix this lands at ~0.79
  //    (essentially 1:1). With it, ~0.08 (one commit per frame).
  expect(
    ratio,
    `Commit/pointerEvent ratio ${ratio.toFixed(3)} exceeds ` +
      `${MAX_COMMIT_RATIO}. Fader is no longer rAF-coalescing its ` +
      `patch-store mutations — every pointermove is producing its ` +
      `own Yjs update. This is the regression that caused the ` +
      `user-reported "tempo glitches under hand modulation" symptom.`,
  ).toBeLessThanOrEqual(MAX_COMMIT_RATIO);

  // 4) Backstop: tempo doesn't drift. PR #90's worker-tick scheduler
  //    keeps this stable even when the ratio invariant breaks (on a
  //    small graph in headless Chromium), but on real hardware /
  //    heavier graphs a broken coalescer would eventually starve the
  //    audio thread. Asserting this catches the broader user symptom
  //    even if a future change loosens the ratio assertion above.
  expect(
    tempoDelta,
    `120 BPM sequencer ran ${RUN_MS} ms under fader stress — observed ` +
      `${tempoDelta} new advances (expected ${TEMPO_MIN}..${TEMPO_MAX}).`,
  ).toBeGreaterThanOrEqual(TEMPO_MIN);
  expect(tempoDelta).toBeLessThanOrEqual(TEMPO_MAX);
});

// Baseline (no drag) — calibrates the tempo-window thresholds. If
// this drifts outside the same window the RUN_MS math is wrong, not
// the scheduler. Mirrors the calibration test in tempo-stability.
test('perf-tempo-under-modulation: baseline (no drag) advance rate matches BPM', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'seqB', type: 'sequencer', params: { bpm: SEQ_BPM, length: 16, isPlaying: 1 } },
    ],
    [],
  );
  await waitForSequencerWarm(page, 'seqB');
  const before = await readAdvances(page, 'seqB');
  await page.waitForTimeout(RUN_MS);
  const after = await readAdvances(page, 'seqB');
  const delta = after - before;
  expect(delta).toBeGreaterThanOrEqual(TEMPO_MIN);
  expect(delta).toBeLessThanOrEqual(TEMPO_MAX);
});
