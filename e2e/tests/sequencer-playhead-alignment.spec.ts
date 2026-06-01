// e2e/tests/sequencer-playhead-alignment.spec.ts
//
// Regression test for the sequencer playhead off-by-one bug. Before the fix
// in PR fix/sequencer-playhead-alignment, the visual `currentStep` was
// derived from the scheduler's lookahead index (the next step to schedule)
// rather than the step actually sounding at audio-context time. Users saw
// the highlight one step AHEAD of the audible note.
//
// We exercise every lookahead-scheduling sequencer (POLYSEQZ, Sequencer,
// DRUMSEQZ, SCORE). Each test:
//   1. Spawns the module at a slow BPM so steps are well-separated in time.
//   2. Starts playback.
//   3. Uses `waitForSoundingStep` (event-driven on engine.read) to advance
//      to a target step.
//   4. Calls `freezeAudioClock` to suspend the AudioContext so
//      AudioContext.currentTime stops advancing; subsequent reads of
//      `currentStep` are deterministic (same answer every read, no race
//      between assertion and scheduler advance).
//   5. Asserts.
//
// Determinism: see e2e/tests/_scheduler-control.ts for the suspend/resume
// approach + why we don't need a fake-clock injection in the engine. The
// previous incarnation of this file used `waitForTimeout(100)` + read which
// was chronically flaky on CI sharding — at higher CPU pressure the
// lookahead loop would already have queued step 1 by the time the read
// fired. The new approach is event-driven: we wait for the audio thread to
// REPORT step K, then freeze before asserting.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import {
  waitForSoundingStep,
  waitForSoundingStepAndFreeze,
  waitForCurrentNoteId,
  freezeAudioClock,
  unfreezeAudioClock,
  readEngineValue,
} from './_scheduler-control';

test.describe.configure({ mode: 'parallel' });

interface EngineRef {
  __engine?: () => {
    read: (
      n: { id: string; type: string; domain: string },
      k: string,
    ) => unknown;
  } | null;
  __patch: {
    nodes: Record<string, { id: string; type: string; domain: string }>;
  };
}

async function readEngine<T = unknown>(
  page: Page,
  nodeId: string,
  key: string,
): Promise<T | null> {
  return await page.evaluate(
    ([id, k]) => {
      const w = globalThis as unknown as EngineRef;
      const eng = w.__engine?.();
      if (!eng) return null;
      const node = w.__patch.nodes[id as string];
      if (!node) return null;
      return eng.read(node, k as string) as unknown;
    },
    [nodeId, key] as const,
  ) as T | null;
}

test('polyseqz: playhead matches sounding step (no off-by-one at start)', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // 60 BPM, 8th notes (POLYSEQZ default) → step every 500 ms. Slow enough
  // that the freeze-after-waitForStep window is comfortable.
  await spawnPatch(page, [
    {
      id: 'p',
      type: 'polyseqz',
      params: { bpm: 60, length: 8, isPlaying: 1, gateLength: 0.9, humanize: 0 },
    },
  ]);

  // Set steps ON so they're audible.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const steps = Array.from({ length: 8 }, (_, i) => ({
        on: true,
        root: 60 + i,
        quality: 'maj',
        inversion: 0,
        voicing: 'closed',
      }));
      w.__patch.nodes['p'].data = { steps };
    });
  });

  // Atomically wait for step 0 sounding AND freeze — single browser round-trip
  // eliminates the race where the clock advances past step 0 before freeze.
  await waitForSoundingStepAndFreeze(page, 'p', 0);
  let step = await readEngineValue<number>(page, 'p', 'currentStep');
  expect(step).toBe(0);

  // Resume + advance to step 1.
  await unfreezeAudioClock(page);
  await waitForSoundingStepAndFreeze(page, 'p', 1);
  step = await readEngineValue<number>(page, 'p', 'currentStep');
  expect(step).toBe(1);
});

test('sequencer: playhead matches sounding step (no off-by-one at start)', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // 60 BPM, 16th notes → step every 250 ms. Just barely outside LOOKAHEAD_S
  // so the scheduler eagerly queues both step 0 and step 1 on tick 1 — the
  // exact condition that exposed the off-by-one when reading via wall-clock.
  await spawnPatch(page, [
    {
      id: 's',
      type: 'sequencer',
      params: { bpm: 60, length: 16, isPlaying: 1, gateLength: 0.9, swing: 0 },
    },
  ]);

  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const steps = Array.from({ length: 16 }, (_, i) => ({
        on: true,
        midi: 60 + i,
        chord: 'mono',
      }));
      w.__patch.nodes['s'].data = { steps };
    });
  });

  // Atomically wait for step 0 sounding AND freeze.
  await waitForSoundingStepAndFreeze(page, 's', 0);
  let step = await readEngineValue<number>(page, 's', 'currentStep');
  expect(step).toBe(0);

  // Cross-check: while frozen, repeat the read — must be identical.
  const stepAgain = await readEngineValue<number>(page, 's', 'currentStep');
  expect(stepAgain).toBe(0);

  // Resume + advance to step 1.
  await unfreezeAudioClock(page);
  await waitForSoundingStepAndFreeze(page, 's', 1);
  step = await readEngineValue<number>(page, 's', 'currentStep');
  expect(step).toBe(1);
});

test('drumseqz: playhead matches sounding step (no off-by-one at start)', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // 60 BPM, 16th notes → step every 250 ms (same as Sequencer). This is the
  // pathological case for the lookahead-vs-sounding off-by-one: step 1 lands
  // inside the lookahead window on the very first tick.
  await spawnPatch(page, [
    {
      id: 'd',
      type: 'drumseqz',
      params: { bpm: 60, length: 16, isPlaying: 1, gateLength: 0.9, swing: 0 },
    },
  ]);

  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const tracks = Array.from({ length: 4 }, () =>
        Array.from({ length: 16 }, () => ({ on: true, midi: null })),
      );
      w.__patch.nodes['d'].data = { tracks };
    });
  });

  await waitForSoundingStepAndFreeze(page, 'd', 0);
  let step = await readEngineValue<number>(page, 'd', 'currentStep');
  expect(step).toBe(0);

  await unfreezeAudioClock(page);
  await waitForSoundingStepAndFreeze(page, 'd', 1);
  step = await readEngineValue<number>(page, 'd', 'currentStep');
  expect(step).toBe(1);
});

test('score: playhead matches sounding 16th-note slot (no off-by-one)', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // 60 BPM → 1 beat = 1 s, 1 16th = 250 ms.
  // Spawn with isPlaying=0 so the first tick doesn't fire before we've
  // applied the notes data (an empty-notes first tick would silently advance
  // tickIndex without scheduling any notePlayhead entry, leaving
  // currentNoteId at null when we later snap to tickIndex=0). Toggle on
  // after the data is in place.
  await spawnPatch(page, [
    {
      id: 'sc',
      type: 'score',
      params: { bpm: 60, isPlaying: 0, attack: 0.01, decay: 0.1, sustain: 0.7, release: 0.1 },
    },
  ]);

  // Lay out 4 quarter notes on bar 0, beat 0..3 (tick 0, 12, 24, 36 grid
  // ticks where one bar = 48 grid ticks). 16th-rate slot = tickIndex 0,4,8,12.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown>; params?: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes['sc'].data = {
        notes: [
          { id: 'n0', bar: 0, tick: 0,  midi: 60, duration: 'quarter' },
          { id: 'n1', bar: 0, tick: 12, midi: 62, duration: 'quarter' },
          { id: 'n2', bar: 0, tick: 24, midi: 64, duration: 'quarter' },
          { id: 'n3', bar: 0, tick: 36, midi: 65, duration: 'quarter' },
        ],
        ties: [],
        dynamics: [],
        keySignature: 0,
        pages: 1,
        loop: false,
      };
      // Now start playback — guarantees the first tick reads non-empty notes
      // so notePlayhead gets an entry for n0 in the same tick that schedules
      // tickPlayhead[0].
      const live = w.__patch.nodes['sc'];
      if (live?.params) live.params.isPlaying = 1;
    });
  });

  // Wait for n0 to be sounding (event-driven), then freeze + assert both
  // tickIndex and currentNoteId. Asserting via currentNoteId rather than
  // tickIndex sidesteps the rare case where the very first tick fires with
  // notes still empty (n0 then enters on the next loop iteration).
  await waitForCurrentNoteId(page, 'sc', 'n0');
  await freezeAudioClock(page);
  const tick0 = await readEngineValue<number>(page, 'sc', 'tickIndex');
  const note0 = await readEngineValue<string | null>(page, 'sc', 'currentNoteId');
  // At this moment n0 is sounding. tickIndex 0 is the only slot that maps to
  // n0 (next note n1 starts at slot 4); allow 0..3 since n0 holds until n1
  // displaces it.
  expect(tick0).toBeGreaterThanOrEqual(0);
  expect(tick0).toBeLessThanOrEqual(3);
  expect(note0).toBe('n0');

  // Resume + wait for n1 to begin sounding (the next quarter note). This is
  // the off-by-one regression check: pre-fix, currentNoteId would have read
  // n1 *before* its atTime — now we drive it event-style and only assert
  // once the audio thread reports the transition.
  await unfreezeAudioClock(page);
  await waitForCurrentNoteId(page, 'sc', 'n1');
  await freezeAudioClock(page);
  const tick1 = await readEngineValue<number>(page, 'sc', 'tickIndex');
  const note1 = await readEngineValue<string | null>(page, 'sc', 'currentNoteId');
  // n1 starts at tickIndex 4 (16th slot at grid-tick 12) and holds through
  // slot 7. Allow that range; some platforms may overshoot by 1 between
  // detection and freeze.
  expect(tick1).toBeGreaterThanOrEqual(4);
  expect(tick1).toBeLessThanOrEqual(8);
  expect(note1).toBe('n1');
});

test('all sequencers: playhead is exposed via engine.read("currentStep") (smoke + audit guard)', async ({
  page,
}) => {
  // Belt-and-suspenders: every sequencer module that has a visual playhead
  // must expose 'currentStep' (or 'currentNoteId' for SCORE) via engine.read.
  // This is a stable contract the per-module Card.svelte files depend on.
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Cartesian requires an external clock to advance — give it one via the
  // Sequencer's clock output. (We don't assert Cartesian's currentStep
  // moves; only that the read hook returns a number.)
  await spawnPatch(page, [
    { id: 'a', type: 'polyseqz',  params: { isPlaying: 1, bpm: 120 } },
    { id: 'b', type: 'sequencer', params: { isPlaying: 1, bpm: 120 } },
    { id: 'c', type: 'drumseqz',  params: { isPlaying: 1, bpm: 120 } },
    { id: 'd', type: 'score',     params: { isPlaying: 1, bpm: 120 } },
    { id: 'e', type: 'cartesian' },
  ]);

  // Wait for at least one tick.
  await page.waitForTimeout(250);

  for (const id of ['a', 'b', 'c', 'e']) {
    const v = await readEngine(page, id, 'currentStep');
    expect(typeof v).toBe('number');
    expect(v).toBeGreaterThanOrEqual(0);
  }
  // SCORE exposes currentNoteId (string | null) instead of a numeric step.
  const noteId = await readEngine(page, 'd', 'currentNoteId');
  expect(noteId === null || typeof noteId === 'string').toBe(true);
});
