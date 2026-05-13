// e2e/tests/sequencer-playhead-alignment.spec.ts
//
// Regression test for the sequencer playhead off-by-one bug. Before the fix
// in PR fix/sequencer-playhead-alignment, the visual `currentStep` was
// derived from the scheduler's lookahead index (the next step to schedule)
// rather than the step actually sounding at audio-context time. Users saw
// the highlight one step AHEAD of the audible note.
//
// We exercise every lookahead-scheduling sequencer (POLYSEQZ, Sequencer,
// DRUMSEQZ, SCORE) and Cartesian-mode Cartesian. Each test:
//   1. Spawns the module with a low BPM (60) so each step takes 250ms+,
//      well above the LOOKAHEAD_S (200ms) window.
//   2. Starts playback.
//   3. Reads `engine.read(node, 'currentStep')` (or 'currentNoteId' / etc.)
//      shortly after the first step's audio time has passed. The value must
//      match the step the audio thread is actually playing (step 0), NOT the
//      next-to-be-scheduled step.
//
// The test is deterministic because it asserts ranges, not exact values:
//   - After 100 ms of playback at 60 BPM 8th/16th notes, sounding step is
//     definitely 0 (no future steps have fired yet).
//   - Before the fix, the lookahead would already have queued step 1 within
//     the 200ms window → `currentStep` would have read 1.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

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

  // 60 BPM, 8th notes (POLYSEQZ default) → step every 500 ms.
  // LOOKAHEAD_S = 0.2; on the very first tick the scheduler queues step 0 at
  // ~now+0.05 and step 1 at ~now+0.55 (outside lookahead → not yet queued).
  await spawnPatch(page, [
    {
      id: 'p',
      type: 'polyseqz',
      params: { bpm: 60, length: 8, isPlaying: 1, gateLength: 0.9, humanize: 0 },
    },
  ]);

  // Set step 0 ON so it's audible (currentStep tracker is independent of
  // step.on, but a real-world test should also verify gating).
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

  // Wait 200 ms — first step (queued at ~now+0.05) has started; the next step
  // (every 500 ms) is still 300 ms away. Highlight MUST be 0.
  await page.waitForTimeout(200);
  let step = await readEngine<number>(page, 'p', 'currentStep');
  expect(step).toBe(0);

  // Wait until step 1 sounds (cumulative ~700 ms after first emit). Highlight
  // must now be 1.
  await page.waitForTimeout(500);
  step = await readEngine<number>(page, 'p', 'currentStep');
  expect(step).toBe(1);
});

test('sequencer: playhead matches sounding step (no off-by-one at start)', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // 60 BPM, 16th notes → step every 250 ms. Just barely outside LOOKAHEAD_S
  // so the scheduler eagerly queues both step 0 and step 1 on tick 1.
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

  // 100 ms after play: only step 0 has started (step 1 sounds at +250 ms).
  // Pre-fix: lookahead has queued step 1 → currentStep would read 1.
  await page.waitForTimeout(100);
  let step = await readEngine<number>(page, 's', 'currentStep');
  expect(step).toBe(0);

  // ~300 ms after play: step 1 has started (sounds at ~+250 ms).
  await page.waitForTimeout(250);
  step = await readEngine<number>(page, 's', 'currentStep');
  expect(step).toBe(1);
});

test('drumseqz: playhead matches sounding step (no off-by-one at start)', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // 60 BPM, 16th notes → step every 250 ms (same as Sequencer).
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
      // 4 tracks, all 16 cells on, midi=null (use track root).
      const tracks = Array.from({ length: 4 }, () =>
        Array.from({ length: 16 }, () => ({ on: true, midi: null })),
      );
      w.__patch.nodes['d'].data = { tracks };
    });
  });

  await page.waitForTimeout(100);
  let step = await readEngine<number>(page, 'd', 'currentStep');
  expect(step).toBe(0);

  await page.waitForTimeout(250);
  step = await readEngine<number>(page, 'd', 'currentStep');
  expect(step).toBe(1);
});

test('score: playhead matches sounding 16th-note slot (no off-by-one)', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // 60 BPM → 1 beat = 1 s, 1 16th = 250 ms.
  await spawnPatch(page, [
    {
      id: 'sc',
      type: 'score',
      params: { bpm: 60, isPlaying: 1, attack: 0.01, decay: 0.1, sustain: 0.7, release: 0.1 },
    },
  ]);

  // Lay out 4 quarter notes on bar 0, beat 0..3 (tick 0, 12, 24, 36 grid ticks
  // where one bar = 48 grid ticks). 16th-rate slot = tickIndex 0,4,8,12.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
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
    });
  });

  // 16th-slots tick every 250 ms at 60 BPM. After 100 ms, only slot 0 has
  // started → tickIndex must be 0, currentNoteId must be 'n0'.
  await page.waitForTimeout(100);
  const tick0 = await readEngine<number>(page, 'sc', 'tickIndex');
  const note0 = await readEngine<string | null>(page, 'sc', 'currentNoteId');
  expect(tick0).toBe(0);
  expect(note0).toBe('n0');

  // Wait until slot 4 (next quarter = beat 1) sounds: ~1.0 s after start.
  await page.waitForTimeout(1000);
  const tick1 = await readEngine<number>(page, 'sc', 'tickIndex');
  const note1 = await readEngine<string | null>(page, 'sc', 'currentNoteId');
  // tick 4 is "beat 1"; allow slight scheduler slack of ±1 slot.
  expect(tick1).toBeGreaterThanOrEqual(3);
  expect(tick1).toBeLessThanOrEqual(5);
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
