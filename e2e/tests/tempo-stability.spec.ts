// e2e/tests/tempo-stability.spec.ts
//
// Tempo-stability regression spec for the fix in PR fix/tempo-stability.
//
// User report: "unstable tempo when dragging stuff around" / "unstable
// tempo in general". Root cause: each step sequencer self-managed a
// `setTimeout(tick, 25)` loop on the main thread; main-thread blocking
// (drag handlers + Svelte Flow rerender + Y.Doc rebroadcast) queued the
// tick callbacks behind the jank. With a 100 ms lookahead, anything
// longer than ~75 ms of starvation caused the audio thread to run dry
// and tempo would drift / jitter.
//
// Fix: (a) shared scheduler-clock module that drives the per-module
// tick from a Web Worker (jank-immune), and (b) bumped the per-module
// LOOKAHEAD_S from 0.1 to 0.2 (4x cushion).
//
// What this spec exercises:
//   1. Spawn a Sequencer at 120 BPM and let it run for ~3 seconds.
//   2. While it runs, repeatedly block the main thread with synthetic
//      busy-loops (~80 ms each, every ~250 ms) to simulate the kind of
//      jank a drag-and-render storm produces.
//   3. Assert the sequencer's monotonic `totalAdvances` counter still
//      reflects ~24 advances/sec (120 BPM ⇒ 16ths ⇒ 8 advances/sec)
//      ± a small margin. Without the fix, lost ticks would reduce the
//      observed advance rate; we'd see ≤ 6/sec instead of ≥ 7.5/sec.
//
// We use the engine `read('totalAdvances')` interface (already used by
// sequencer-clock.spec.ts) rather than analysing audio output — that
// interface is the production scheduler's authoritative count, and it
// would lag iff the lookahead window starved.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

/** 120 BPM 16th-note pulses arrive at 8/sec (60/120/4 = 0.125 s/step).
 *  Over ~2.5 s the production sequencer should advance ~20 times. We
 *  set a generous lower bound (≥ 16) so the test is robust against
 *  kernel/CI scheduling slop while still being miles above what a
 *  jank-starved scheduler would produce (which would land in the 6–10
 *  range). */
const SEQ_BPM = 120;
const RUN_MS = 2500;
const EXPECTED_ADVANCES_MIN = 16; // floor — well below the 20 we expect
const EXPECTED_ADVANCES_MAX = 24; // ceiling — guards against a stuck-firing bug

test('tempo-stability: sequencer keeps tempo under repeated main-thread jank', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      {
        id: 'seq',
        type: 'sequencer',
        params: { bpm: SEQ_BPM, length: 16, isPlaying: 1 },
      },
    ],
    [],
  );

  // Begin the synthetic main-thread jank in the background. Each block
  // is ~80 ms of busy-loop CPU; we issue them every ~250 ms over the
  // full run window. This mimics the worst-case duration of a Svelte
  // Flow drag-update + Y.Doc rebroadcast burst observed in production.
  // We run the jank inside the page context so it actually starves the
  // page's main thread (Playwright's `evaluate` calls also run there
  // but yield between calls, so we issue ONE long evaluate that does
  // all the blocking internally).
  const jankPromise = page.evaluate(
    async ({ runMs, blockMs, gapMs }) => {
      const start = performance.now();
      while (performance.now() - start < runMs) {
        const blockEnd = performance.now() + blockMs;
        // Busy-loop. NOTE: this MUST not yield; using setTimeout(0)
        // would defeat the test's purpose. The block runs on the
        // page's main thread, exactly where the legacy
        // setTimeout(tick) scheduler used to live.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        let acc = 0;
        while (performance.now() < blockEnd) {
          acc += Math.sin(performance.now()) * Math.cos(performance.now());
        }
        // Yield briefly between blocks so the page can run any other
        // microtasks (mirrors a real drag's per-frame rhythm).
        await new Promise((r) => setTimeout(r, gapMs));
      }
    },
    { runMs: RUN_MS, blockMs: 80, gapMs: 170 },
  );

  // Wait the same window for the sequencer to run + record its advance
  // counter. We sample the counter at the very end of the jank window.
  await jankPromise;

  const advances = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return -1;
    const node = w.__patch.nodes['seq'];
    const v = eng.read(node, 'totalAdvances');
    return typeof v === 'number' ? v : -1;
  });

  expect(
    advances,
    `120 BPM sequencer ran ${RUN_MS} ms with synthetic jank — observed ${advances} advances ` +
      `(expected ${EXPECTED_ADVANCES_MIN}..${EXPECTED_ADVANCES_MAX}). Below the floor means lost ticks; above the ceiling ` +
      `means the scheduler is double-firing.`,
  ).toBeGreaterThanOrEqual(EXPECTED_ADVANCES_MIN);
  expect(advances).toBeLessThanOrEqual(EXPECTED_ADVANCES_MAX);
});

// Calibration: same setup WITHOUT jank confirms the baseline advance
// rate matches our expectation. If this test fails, the jank test's
// thresholds are wrong, not the production scheduler.
test('tempo-stability: baseline (no jank) sequencer advance rate matches BPM', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      {
        id: 'seq2',
        type: 'sequencer',
        params: { bpm: SEQ_BPM, length: 16, isPlaying: 1 },
      },
    ],
    [],
  );

  await page.waitForTimeout(RUN_MS);

  const advances = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return -1;
    const node = w.__patch.nodes['seq2'];
    const v = eng.read(node, 'totalAdvances');
    return typeof v === 'number' ? v : -1;
  });

  // Baseline (no jank) should sit comfortably inside the same window.
  // If it drifts outside, our run-window math is off (or playwright's
  // waitForTimeout is unusually inaccurate).
  expect(advances).toBeGreaterThanOrEqual(EXPECTED_ADVANCES_MIN);
  expect(advances).toBeLessThanOrEqual(EXPECTED_ADVANCES_MAX);
});

// #229/#224 — catch-up correctness when a single stall outlasts the 200 ms
// lookahead. The intermittent-jank test above never forms a backlog (its
// 80 ms blocks are < the 200 ms lookahead). A real drag's dropped-frame
// storm can exceed the cushion: when the scheduler tick finally runs, every
// past-due step it tries to schedule gets clamped by Web Audio to "now" and
// bunches into an audible double/triple-hit + tempo lurch. The fix drops the
// past-due backlog (gate skipped, phase still advances) so the sequencer
// resumes in-tempo with a brief silence instead of a bunch.
//
// Deterministic assertion: `pastDueEmits` (emit invoked with a past
// timestamp) MUST stay 0 — that's logic-guaranteed by the drop guard, not
// timing-dependent. `lateStepsDropped > 0` confirms the stall actually
// exercised the catch-up path. Without the guard, pastDueEmits would be > 0.
//
// Parametrized across the step sequencers that advance with default (empty)
// patterns. `score` shares the identical drop guard but needs loaded notes
// to advance, so its regression coverage is a follow-up (the code path is
// the same one proven here).
for (const mod of ['sequencer', 'polyseqz', 'drumseqz'] as const) {
  test(`tempo-stability: ${mod} drops the past-due backlog under a stall > lookahead, never bunches (#229/#224)`, async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const id = `j_${mod}`;
    await spawnPatch(
      page,
      [{ id, type: mod, params: { bpm: SEQ_BPM, length: 16, isPlaying: 1 } }],
      [],
    );

    // Let the lookahead window fill normally for ~half a second first.
    await page.waitForTimeout(600);

    // One uninterrupted main-thread block well beyond the 200 ms lookahead —
    // the catch-up case (vs. the intermittent sub-lookahead jank above). The
    // scheduler-clock Worker keeps posting ticks during the block; they drain
    // the moment the block ends and the first one hits the past-due backlog.
    // 600 ms gives every grid (down to polyseqz's 8th notes) a ≥1-step
    // backlog past the 200 ms cushion.
    await page.evaluate(() => {
      const end = performance.now() + 600;
      let acc = 0;
      while (performance.now() < end) {
        acc += Math.sin(performance.now()) * Math.cos(performance.now());
      }
      return acc;
    });

    // Let the catch-up tick + a couple normal steps run.
    await page.waitForTimeout(400);

    const probe = await page.evaluate((nid) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      if (!eng) return { pastDueEmits: -1, lateStepsDropped: -1, advances: -1 };
      const node = w.__patch.nodes[nid];
      const num = (k: string) => {
        const v = eng.read(node, k);
        return typeof v === 'number' ? v : -1;
      };
      return {
        pastDueEmits: num('pastDueEmits'),
        lateStepsDropped: num('lateStepsDropped'),
        advances: num('totalAdvances'),
      };
    }, id);

    expect(
      probe.lateStepsDropped,
      `${mod}: a 600ms stall (> 200ms lookahead) must produce a dropped backlog (got ${probe.lateStepsDropped})`,
    ).toBeGreaterThan(0);
    expect(
      probe.pastDueEmits,
      `${mod}: no step may be scheduled in the past — that would clamp+bunch into a double-hit (got ${probe.pastDueEmits})`,
    ).toBe(0);

    // Recovery: it must keep advancing in-tempo after the stall.
    const before = probe.advances;
    await page.waitForTimeout(500);
    const after = await page.evaluate((nid) => {
      const w = globalThis as unknown as {
        __engine: () => {
          read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
        };
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const v = w.__engine().read(w.__patch.nodes[nid], 'totalAdvances');
      return typeof v === 'number' ? v : -1;
    }, id);
    expect(after, `${mod}: must resume advancing after the stall`).toBeGreaterThan(before);
  });
}
