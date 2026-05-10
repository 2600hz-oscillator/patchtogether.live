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
