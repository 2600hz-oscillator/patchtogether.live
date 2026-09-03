// e2e/tests/score.spec.ts
//
// SCORE module — sheet-music sequencer. Covers Phase 1 user-facing flows:
// - Place note via duration tool + click
// - Drag-snap to nearest 16th tick
// - Sharp on note (per-note accidental)
// - Sharp on staff (key signature +1)
// - Tie two notes -> Tie object exists + SVG <path data-tie-id>
// - Currently-playing-note highlight via __engine().read(node, 'currentNoteId')
// - Dynamic affects amplitude (ff vs pp peak, observed via dynamicScale read)
// - Bar overflow rejected (red shake CSS, second whole note not added)

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { seedScoreThenPlay } from './_score-helpers';

test.describe.configure({ mode: 'parallel' });

interface ScoreNoteRow {
  id: string;
  bar: number;
  tick: number;
  duration: string;
  midi: number;
  staffStep: number;
  accidental: 'natural' | 'sharp' | 'flat' | null;
}

async function readScoreData(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { notes?: ScoreNoteRow[]; ties?: Array<{ id: string; fromNoteId: string; toNoteId: string }>; keySignature?: number; dynamics?: Array<{ id: string; level: string }> } }> };
    };
    const n = w.__patch.nodes['score'];
    return {
      notes: (n?.data?.notes ?? []) as ScoreNoteRow[],
      ties: (n?.data?.ties ?? []) as Array<{ id: string; fromNoteId: string; toNoteId: string }>,
      keySignature: (n?.data?.keySignature ?? 0) as number,
      dynamics: (n?.data?.dynamics ?? []) as Array<{ id: string; level: string }>,
    };
  });
}

test('score: place a note via the quarter tool + click', async ({ page, rackLegacy }) => {
  await spawnPatch(page, [{ id: 'score', type: 'score' }]);

  await page.locator('[data-testid="score-tool-quarter-score"]').click();
  const staff = page.locator('[data-testid="score-staff-score"]');
  const box = await staff.boundingBox();
  if (!box) throw new Error('no staff bbox');
  // Click roughly at the middle of bar 0, on the top staff line (F5).
  await page.mouse.click(box.x + 90, box.y + 30);

  await expect.poll(async () => (await readScoreData(page)).notes.length).toBeGreaterThan(0);
  const data = await readScoreData(page);
  expect(data.notes[0]).toMatchObject({ bar: 0, duration: 'quarter' });
  expect(data.notes[0].midi).toBeGreaterThanOrEqual(60);
  expect(data.notes[0].midi).toBeLessThanOrEqual(84);
});

test('score: drag-snap to nearest 16th tick', async ({ page, rackLegacy }) => {
  // Pre-seed a note at bar 0, tick 0 so we can grab + drag it.
  await spawnPatch(page, [
    {
      id: 'score',
      type: 'score',
      params: {},
    },
  ]);

  // Mutate the patch graph directly to seed one note (avoids click-coord flakiness).
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    const n = w.__patch.nodes['score'];
    if (!n) return;
    w.__ydoc.transact(() => {
      n.data = {
        notes: [{
          id: 'n1', bar: 0, tick: 0, duration: 'quarter',
          midi: 77, staffStep: 0, accidental: null,
        }],
        dynamics: [],
        ties: [],
        keySignature: 0,
      };
    });
  });

  // Drag the note across the bar — the resulting tick must be a multiple of 3
  // (16th-grid). We use the duration tool 'quarter' so quantizeTick uses 12-tick grid.
  const noteEl = page.locator('[data-note-id="n1"]').first();
  await expect(noteEl).toBeVisible();
  const nb = await noteEl.boundingBox();
  if (!nb) throw new Error('no note bbox');
  // Drag horizontally ~80px to the right.
  await page.mouse.move(nb.x + nb.width / 2, nb.y + nb.height / 2);
  await page.mouse.down();
  await page.mouse.move(nb.x + nb.width / 2 + 80, nb.y + nb.height / 2, { steps: 5 });
  await page.mouse.up();

  await expect.poll(async () => {
    const data = await readScoreData(page);
    return data.notes[0]?.tick;
  }).toBeGreaterThan(0);
  const data = await readScoreData(page);
  // tick must be a multiple of 3 (the quarter-tool grid is 12; 12 = multiple of 3 too)
  expect(data.notes[0].tick % 3).toBe(0);
});

test('score: sharp tool on note toggles per-note accidental + transposes MIDI +1', async ({ page, rackLegacy }) => {
  await spawnPatch(page, [{ id: 'score', type: 'score' }]);

  // Seed an F5 note via quarter tool click on top line, then click again with sharp tool.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['score'];
      if (!n) return;
      n.data = {
        notes: [{ id: 'n1', bar: 0, tick: 0, duration: 'quarter', midi: 77, staffStep: 0, accidental: null }],
        dynamics: [],
        ties: [],
        keySignature: 0,
      };
    });
  });

  await page.locator('[data-testid="score-tool-sharp-score"]').click();
  const note = page.locator('[data-note-id="n1"]').first();
  await note.click();

  await expect.poll(async () => (await readScoreData(page)).notes[0]?.accidental).toBe('sharp');
  const data = await readScoreData(page);
  expect(data.notes[0].midi).toBe(78);
});

test('score: sharp tool on empty staff increments key signature', async ({ page, rackLegacy }) => {
  await spawnPatch(page, [{ id: 'score', type: 'score' }]);

  // Seed an F5 note (no per-note accidental) so we can verify it gets the key-sig sharp.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['score'];
      if (!n) return;
      n.data = {
        notes: [{ id: 'n1', bar: 0, tick: 0, duration: 'quarter', midi: 77, staffStep: 0, accidental: null }],
        dynamics: [],
        ties: [],
        keySignature: 0,
      };
    });
  });

  await page.locator('[data-testid="score-tool-sharp-score"]').click();
  const staff = page.locator('[data-testid="score-staff-score"]');
  const box = await staff.boundingBox();
  if (!box) throw new Error('no staff bbox');
  // Click somewhere on empty staff space (near bottom of row 1, far right -- avoid the note).
  await page.mouse.click(box.x + box.width - 50, box.y + 70);

  await expect.poll(async () => (await readScoreData(page)).keySignature).toBe(1);
  const data = await readScoreData(page);
  // F-letter line should now play as F#5 (MIDI 78) for the un-overridden note.
  expect(data.notes[0].midi).toBe(78);
});

test('score: tie tool — picking two notes creates a Tie object + SVG path', async ({ page, rackLegacy }) => {
  await spawnPatch(page, [{ id: 'score', type: 'score' }]);

  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['score'];
      if (!n) return;
      n.data = {
        notes: [
          { id: 'n1', bar: 0, tick: 0, duration: 'quarter', midi: 77, staffStep: 0, accidental: null },
          { id: 'n2', bar: 0, tick: 12, duration: 'quarter', midi: 76, staffStep: 1, accidental: null },
        ],
        dynamics: [],
        ties: [],
        keySignature: 0,
      };
    });
  });

  await page.locator('[data-testid="score-tool-tie-score"]').click();
  await page.locator('[data-note-id="n1"]').first().click();
  await page.locator('[data-note-id="n2"]').first().click();

  await expect.poll(async () => (await readScoreData(page)).ties.length).toBe(1);
  const data = await readScoreData(page);
  expect(data.ties[0]).toMatchObject({ fromNoteId: 'n1', toNoteId: 'n2' });
  // The SVG path should exist with a data-tie-id attribute.
  const tieId = data.ties[0].id;
  await expect(page.locator(`[data-tie-id="${tieId}"]`)).toBeVisible();
});

test('score: currently-playing note highlight tracks engine.read currentNoteId', async ({ page, rackLegacy }) => {
  // Spawn STOPPED — seedScoreThenPlay starts the transport after the music
  // exists, so grid tick 0 is emitted with notes in place (see its header).
  await spawnPatch(page, [{ id: 'score', type: 'score', params: { bpm: 240, isPlaying: 0 } }]);

  // Seed a few notes spanning bars so the engine has something to play.
  await seedScoreThenPlay(page, 'score', {
    notes: [
      { id: 'n1', bar: 0, tick: 0, duration: 'quarter', midi: 77, staffStep: 0, accidental: null },
      { id: 'n2', bar: 0, tick: 12, duration: 'quarter', midi: 76, staffStep: 1, accidental: null },
      { id: 'n3', bar: 0, tick: 24, duration: 'quarter', midi: 74, staffStep: 3, accidental: null },
    ],
    dynamics: [],
    ties: [],
    keySignature: 0,
  });

  // Wait long enough for at least one note to fire (240 BPM 16th = 16/sec).
  await page.waitForTimeout(700);
  const noteId = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    return eng.read(w.__patch.nodes['score'], 'currentNoteId');
  });
  expect(['n1', 'n2', 'n3']).toContain(noteId);
});

// ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
// NONDETERMINISM: 5 recovered-on-retry observation(s) across 3 SHA(s) / 2 branch(es) in the
// 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
// LOST WHILE PARKED: that ALL THREE notes of a triplet group actually sound — triplet tick math that drops a position is inaudible as a bug and reads as a performance mistake.
// Re-enable only on a root cause (#1847); "it passes now" is not one.
test.fixme('score: every triplet position SOUNDS — all three notes of a triplet group', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 5 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page, rackLegacy }) => {
  // -- THE BUG THIS EXISTS FOR --------------------------------------------
  //
  // `triplet8th` is 4 grid ticks wide, so the toolbar snaps it to
  // {0,4,8,...,44} -- twelve positions per bar. The scheduler used to emit only
  // at `tickIndex * 3` = {0,3,6,...,45}, and `noteStartingAt` matches the tick
  // EXACTLY, so a triplet sounded iff its tick was a multiple of 3. Ticks 4
  // and 8 -- the 2nd and 3rd note of the group -- never fired, in any bar, in
  // either clock mode, since the module's first commit.
  //
  // The unit lane now asserts the placement grid is a subset of the reachable
  // grid (score-data.test.ts) and that score.ts runs the shared plan. This is
  // the leg that proves it END TO END, through the real seed -> Y.Doc ->
  // engine chain, because "placeable subset-of reachable" is still two pure
  // functions agreeing until something drives the actual scheduler.
  await spawnPatch(page, [{ id: 'score', type: 'score', params: { bpm: 240, isPlaying: 0 } }]);

  // One triplet group in beat 0: ticks 0 / 4 / 8. Pre-fix, only t1 could fire.
  await seedScoreThenPlay(page, 'score', {
    notes: [
      { id: 't1', bar: 0, tick: 0, duration: 'triplet8th', midi: 72, staffStep: 5, accidental: null },
      { id: 't2', bar: 0, tick: 4, duration: 'triplet8th', midi: 74, staffStep: 4, accidental: null },
      { id: 't3', bar: 0, tick: 8, duration: 'triplet8th', midi: 76, staffStep: 3, accidental: null },
    ],
    dynamics: [],
    ties: [],
    keySignature: 0,
  });

  // THE ACCUMULATOR LIVES IN THE PAGE, not in a Playwright poll loop. At
  // 240 BPM a bar is 1 s and the three notes are 83 ms apart, so a CDP
  // round-trip per sample would both starve the subject and miss notes -- and
  // "never sounded" and "never looked" print the same failure. An in-page
  // setInterval keeps sampling through a main-thread stall and the accumulated
  // Set survives it, so the report distinguishes the two.
  const seen = await page.evaluate(async () => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const ids = new Set<string>();
    const t0 = performance.now();
    let samples = 0;
    await new Promise<void>((resolve) => {
      const iv = setInterval(() => {
        samples++;
        const eng = w.__engine?.();
        const v = eng?.read(w.__patch.nodes['score'], 'currentNoteId');
        if (typeof v === 'string') ids.add(v);
        // Early-exit the moment all three have been seen; otherwise bound it.
        if (ids.size >= 3 || performance.now() - t0 > 6000) {
          clearInterval(iv);
          resolve();
        }
      }, 10);
    });
    return { ids: [...ids].sort(), samples, elapsedMs: Math.round(performance.now() - t0) };
  });

  expect(
    seen.ids,
    `only ${seen.ids.join(',') || '(none)'} sounded across ${seen.samples} samples in ` +
      `${seen.elapsedMs} ms. Ticks 4 and 8 are the 2nd and 3rd note of the triplet ` +
      `group; if they are missing, the scheduler is back to emitting only at slot ` +
      `boundaries and 8 of 12 triplet positions per bar are silent again. ` +
      `(samples=0 would mean the sampler never ran -- a different failure.)`,
  ).toEqual(['t1', 't2', 't3']);
  expect(seen.samples, 'the in-page sampler ran at all').toBeGreaterThan(0);
});

test('score: dynamic marker scales the env output amplitude', async ({ page, rackLegacy }) => {
  // ⚠ THE 30s POLL CEILING BELOW WAS UNREACHABLE. Playwright's DEFAULT TEST
  // TIMEOUT is 30s (this config sets no global `timeout`), so the test budget
  // expired before the poll could ever spend its own — the 10s → 30s bump
  // bought only whatever was left after `spawnPatch`, roughly a third of it.
  // The wait bound and the TEST bound have to move together or the larger one
  // is decorative. Failure-path only: `expect.poll` returns the moment the
  // assertion passes, so green runs are unchanged.
  //
  // ⚠⚠ AND THE BUDGET WAS NEVER THE BUG. This test carried the SAME latent
  // defect as the tied-notes one below — its only note sits at grid tick 0 and
  // `lastDynamicScale` moves off the mf default ONLY when a note fires, so a
  // seed landing after the engine's first tick left it stuck at mf for the
  // whole poll. Same permanent loss, same "slow propagation" mis-diagnosis.
  // Fixed at the ordering, not the budget: seed first, play second.
  test.setTimeout(60_000);
  await spawnPatch(page, [{ id: 'score', type: 'score', params: { bpm: 240, isPlaying: 0 } }]);

  await seedScoreThenPlay(page, 'score', {
    notes: [
      { id: 'n1', bar: 0, tick: 0, duration: 'quarter', midi: 72, staffStep: 5, accidental: null },
    ],
    dynamics: [
      { id: 'd1', bar: 0, tick: 0, level: 'ff' },
    ],
    ties: [],
    keySignature: 0,
  });

  // dynamicScale is a DETERMINISTIC value (ff → 0.95). Poll the live read until
  // it settles into the expected band rather than a one-shot read after a fixed
  // sleep — same correctness assertion, tolerant of a slow first tick.
  const readDynScale = () =>
    page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => {
          read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      if (!eng) return -1;
      const v = eng.read(w.__patch.nodes['score'], 'dynamicScale');
      return typeof v === 'number' ? v : -1;
    });
  // ff -> 0.95 (band [0.85, 1.05]); poll until the engine reports it.
  //
  // ⚠ CEILING RAISED 10s → 30s (2026-08-02). The 10 s budget went red on
  // `e2e (shard 9/10)` with **Received: 0.55** — and 0.55 is not a value in
  // transit, it is `mf`, the DEFAULT in score-data.ts. So the engine had not
  // picked up the `n.data` write AT ALL inside the window; nothing was
  // half-applied and no ramp was caught mid-flight. Same diagnosis as the
  // comment above it, one budget later: this is propagation latency under ten
  // parallel e2e shards, not a different result. Reproduced green locally in
  // 6.0 s on a real GPU and 2.9 s under `E2E_SWIFTSHADER=1`, so the CI margin
  // is load, not renderer.
  //
  // `expect.poll` returns the moment the assertion passes, so a bigger ceiling
  // costs NOTHING on the happy path — it only stops a slow runner from being
  // read as a wrong answer. The band assertion below is unchanged and still
  // pins the actual value, so this cannot pass for the wrong reason.
  await expect
    .poll(readDynScale, { timeout: 30_000 })
    .toBeGreaterThan(0.85);
  expect(await readDynScale()).toBeLessThan(1.05);
});

test('score: bar overflow rejected — second whole note in the same bar does NOT add', async ({ page, rackLegacy }) => {
  await spawnPatch(page, [{ id: 'score', type: 'score' }]);

  await page.locator('[data-testid="score-tool-whole-score"]').click();
  const staff = page.locator('[data-testid="score-staff-score"]');
  const box = await staff.boundingBox();
  if (!box) throw new Error('no staff bbox');

  // First whole-note click: lands somewhere in bar 0, takes the whole bar.
  await page.mouse.click(box.x + 90, box.y + 30);
  await expect.poll(async () => (await readScoreData(page)).notes.length).toBe(1);

  // Second click in the same bar should be rejected.
  await page.mouse.click(box.x + 95, box.y + 30);
  // Wait a beat for any animation / state propagation.
  await page.waitForTimeout(150);
  const data = await readScoreData(page);
  expect(data.notes.length).toBe(1);
});

// ----------------------------------------------------------------------
// v2 features: page navigation, stop-bar + loop, tied-note single envelope
// ----------------------------------------------------------------------

async function readScoreV2(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
    };
    const n = w.__patch.nodes['score'];
    const d = (n?.data ?? {}) as Record<string, unknown>;
    return {
      pages: typeof d.pages === 'number' ? (d.pages as number) : 1,
      loop: typeof d.loop === 'boolean' ? (d.loop as boolean) : false,
      stopBar: d.stopBar as { bar: number; tick: number } | undefined,
    };
  });
}

test('score: page nav — add a page, navigate via arrows, counter shows correctly', async ({ page, rackLegacy }) => {
  await spawnPatch(page, [{ id: 'score', type: 'score' }]);

  // Default: 1 page. Counter shows "1 / 1".
  const counter = page.locator('[data-testid="score-page-counter-score"]');
  await expect(counter).toHaveText('1 / 1');
  // Prev disabled at page 1; Next disabled when only 1 page.
  await expect(page.locator('[data-testid="score-page-prev-score"]')).toBeDisabled();
  await expect(page.locator('[data-testid="score-page-next-score"]')).toBeDisabled();

  // Add a page. Counter denominator updates; current page stays at 1 until
  // the user navigates with the → arrow.
  await page.locator('[data-testid="score-page-add-score"]').click();
  await expect.poll(async () => (await readScoreV2(page)).pages).toBe(2);
  await expect(counter).toHaveText('1 / 2');
  await expect(page.locator('[data-testid="score-page-next-score"]')).toBeEnabled();

  // Navigate to page 2 via →.
  await page.locator('[data-testid="score-page-next-score"]').click();
  await expect(counter).toHaveText('2 / 2');
  // Prev now enabled, next disabled.
  await expect(page.locator('[data-testid="score-page-prev-score"]')).toBeEnabled();
  await expect(page.locator('[data-testid="score-page-next-score"]')).toBeDisabled();

  // Add up to MAX_PAGES (4 total). Click "+" twice more.
  await page.locator('[data-testid="score-page-add-score"]').click();
  await page.locator('[data-testid="score-page-add-score"]').click();
  await expect.poll(async () => (await readScoreV2(page)).pages).toBe(4);
  // Counter denominator now 4; we're still on page 2 (no auto-jump).
  await expect(counter).toHaveText('2 / 4');
  // Add button now disabled (cap reached).
  await expect(page.locator('[data-testid="score-page-add-score"]')).toBeDisabled();

  // Navigate forward to page 4.
  await page.locator('[data-testid="score-page-next-score"]').click();
  await expect(counter).toHaveText('3 / 4');
  await page.locator('[data-testid="score-page-next-score"]').click();
  await expect(counter).toHaveText('4 / 4');
  // Next disabled (already on last page).
  await expect(page.locator('[data-testid="score-page-next-score"]')).toBeDisabled();

  // Navigate prev twice.
  await page.locator('[data-testid="score-page-prev-score"]').click();
  await expect(counter).toHaveText('3 / 4');
  await page.locator('[data-testid="score-page-prev-score"]').click();
  await expect(counter).toHaveText('2 / 4');

  // Next.
  await page.locator('[data-testid="score-page-next-score"]').click();
  await expect(counter).toHaveText('3 / 4');
});

test('score: page count is capped at 4 — add button disabled at max', async ({ page, rackLegacy }) => {
  // Seed with 4 pages directly.
  await spawnPatch(page, [{ id: 'score', type: 'score' }]);
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['score'];
      if (!n) return;
      n.data = {
        notes: [],
        dynamics: [],
        ties: [],
        keySignature: 0,
        pages: 4,
        loop: false,
      };
    });
  });
  await expect(page.locator('[data-testid="score-page-add-score"]')).toBeDisabled();
  await expect(page.locator('[data-testid="score-page-counter-score"]')).toHaveText('1 / 4');
});

test('score: loop toggle persists in score data', async ({ page, rackLegacy }) => {
  await spawnPatch(page, [{ id: 'score', type: 'score' }]);

  // Default: loop=false.
  await expect.poll(async () => (await readScoreV2(page)).loop).toBe(false);

  await page.locator('[data-testid="score-tool-loop-score"]').click();
  await expect.poll(async () => (await readScoreV2(page)).loop).toBe(true);

  await page.locator('[data-testid="score-tool-loop-score"]').click();
  await expect.poll(async () => (await readScoreV2(page)).loop).toBe(false);
});

test('score: stop-bar — placing the marker writes to score data', async ({ page, rackLegacy }) => {
  await spawnPatch(page, [{ id: 'score', type: 'score' }]);

  // Activate stop-bar tool.
  await page.locator('[data-testid="score-tool-stop-score"]').click();

  // Click on the staff at a known position. The exact (bar, tick) depends on
  // the layout — we just assert that *some* stopBar gets written.
  const staff = page.locator('[data-testid="score-staff-score"]');
  const box = await staff.boundingBox();
  if (!box) throw new Error('no staff bbox');
  await page.mouse.click(box.x + 200, box.y + 30);

  await expect.poll(async () => {
    const d = await readScoreV2(page);
    return d.stopBar !== undefined;
  }).toBe(true);
  const sb = (await readScoreV2(page)).stopBar;
  expect(sb).toBeDefined();
  expect(typeof sb!.bar).toBe('number');
  expect(typeof sb!.tick).toBe('number');
  // Tick should be quantized to a 16th boundary.
  expect(sb!.tick % 3).toBe(0);

  // Stop-bar SVG is rendered.
  await expect(page.locator('[data-testid="score-stop-bar-score"]')).toBeVisible();
});

test('score: stop-bar + loop=on wraps tickIndex back to 0 at end of sequence', async ({ page, rackLegacy }) => {
  await spawnPatch(page, [
    { id: 'score', type: 'score', params: { bpm: 240, isPlaying: 0 } },
  ]);

  // Tiny sequence: notes only in bars 0..1, stop-bar at bar 2, loop ON.
  await seedScoreThenPlay(page, 'score', {
    notes: [
      { id: 'n1', bar: 0, tick: 0, duration: 'quarter', midi: 60, staffStep: 10, accidental: null },
    ],
    dynamics: [],
    ties: [],
    keySignature: 0,
    pages: 1,
    loop: true,
    stopBar: { bar: 2, tick: 0 },
  });

  // Wait long enough for several wraps. 240 BPM 16th = ~15.625ms;
  // stop at bar 2 means stop at 32nd 16th-step (~500ms). Wait ~2 seconds.
  await page.waitForTimeout(1500);
  const tickIdx = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (node: unknown, key: string) => unknown } | null;
      __patch: { nodes: Record<string, unknown> };
    };
    const e = w.__engine?.();
    if (!e) return -1;
    const v = e.read(w.__patch.nodes['score'], 'tickIndex');
    return typeof v === 'number' ? v : -1;
  });
  // tickIndex must remain in [0, stop16ths-1] = [0, 31] when looping.
  // The stopBar bar=2 tick=0 = grid 96 → 32 sixteenths.
  expect(tickIdx).toBeGreaterThanOrEqual(0);
  expect(tickIdx).toBeLessThan(32);
});

test('score: stop-bar + loop=off stops playback at end of sequence', async ({ page, rackLegacy }) => {
  await spawnPatch(page, [
    { id: 'score', type: 'score', params: { bpm: 480, isPlaying: 0 } },
  ]);

  // Stop after just 1 bar at high BPM → ~125ms total.
  await seedScoreThenPlay(page, 'score', {
    notes: [
      { id: 'n1', bar: 0, tick: 0, duration: 'quarter', midi: 60, staffStep: 10, accidental: null },
    ],
    dynamics: [],
    ties: [],
    keySignature: 0,
    pages: 1,
    loop: false,
    stopBar: { bar: 1, tick: 0 },
  });

  // Wait well past end-of-sequence.
  await page.waitForTimeout(800);
  // isPlaying should have been cleared by the engine.
  const isPlaying = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params?: Record<string, number> }> };
    };
    return (w.__patch.nodes['score']?.params?.isPlaying ?? 0) >= 0.5;
  });
  expect(isPlaying).toBe(false);
});

/**
 * Wait IN THE PAGE for a score-engine readout to reach `want`, and report the
 * gate read in the SAME sample that saw it.
 *
 * ⚠ Deliberately NOT a Playwright-side `expect.poll`. A poll loop that
 * round-trips `page.evaluate` once per sample runs on the SAME main thread as
 * the thing it measures, so a loaded runner starves the subject and the sampler
 * together (CLAUDE.md: "never sample a page-side quantity with a Playwright-side
 * poll loop"). Worse, "the value never armed" and "the sampler never got to
 * look" print the SAME `Received: -1` and are indistinguishable from the output
 * — which is exactly the red that took main down on c31e9be9.
 *
 * This is ONE evaluate. Sampling happens on an in-page interval that costs no
 * protocol traffic, and the accumulated `seen` set SURVIVES a stall, so a thread
 * frozen for seconds and then resumed still reports every value it computed.
 * `samples` / `elapsedMs` go into the assertion message, so the next red run is
 * diagnosable instead of a coin flip.
 *
 * `deadlineMs` BOUNDS THE FAILURE — it is not the gate. The gate is the
 * `.toBe()` at the call site, unchanged. The waiter returns on the FIRST match,
 * so a larger bound costs nothing on the happy path.
 */
async function waitForScoreReadout(
  page: import('@playwright/test').Page,
  key: string,
  want: number,
  deadlineMs: number,
): Promise<{ value: number; gate: number; samples: number; elapsedMs: number; seen: number[] }> {
  return await page.evaluate(
    ({ key, want, deadlineMs }) =>
      new Promise<{
        value: number;
        gate: number;
        samples: number;
        elapsedMs: number;
        seen: number[];
      }>((resolve) => {
        const w = globalThis as unknown as {
          __engine?: () => { read: (node: unknown, key: string) => unknown } | null;
          __patch: { nodes: Record<string, unknown> };
        };
        const t0 = performance.now();
        const seen = new Set<number>();
        let samples = 0;
        let timer: ReturnType<typeof setInterval> | undefined;
        const num = (v: unknown) => (typeof v === 'number' ? v : Number.NaN);
        const read = () => {
          const e = w.__engine?.();
          const node = w.__patch.nodes['score'];
          if (!e || !node) return { value: Number.NaN, gate: Number.NaN };
          return { value: num(e.read(node, key)), gate: num(e.read(node, 'gateValue')) };
        };
        const tick = () => {
          samples += 1;
          const r = read();
          seen.add(r.value);
          if (r.value === want || performance.now() - t0 >= deadlineMs) {
            if (timer !== undefined) clearInterval(timer);
            resolve({ ...r, samples, elapsedMs: performance.now() - t0, seen: [...seen] });
          }
        };
        timer = setInterval(tick, 25);
        tick();
      }),
    { key, want, deadlineMs },
  );
}

// #score-tied-gate (re-enabled, wave-3): the tied-note held-gate read used a FLAT
// waitForTimeout(400) + a single read, so under CI load the read could land BEFORE
// the scheduler had emitted the tie-start note A — at which point
// `tiedGateHoldUntilTick` is still its -1 "not yet armed" sentinel (set to the
// chain-end tick only inside emitTick for the tied-start role) and `gateValue`
// is still 0. That's the intermittent -1 the old comment chased; it's a timing
// race, not an off-by-one in any search window. The fix awaits the held-gate
// signal deterministically: wait for `tiedGateHoldUntilTick` to arm to 36 (the
// chain-end grid tick) and read the gate in the same sample — the tied-start
// branch writes both together.
//
// ⚠ RED MAIN, 2026-08-02 (c31e9be9) and AGAIN 2026-08-03 (run 30784972908),
// both on `e2e (shard 9/10)`, both `Received: -1` on the attempt AND the retry.
// #1294 blamed propagation latency under ten parallel shards and enlarged the
// wait. THAT DIAGNOSIS WAS WRONG, and the second red disproved it outright: the
// sampler was healthy (1001 in-page samples / 25000 ms is exactly the 25 ms
// cadence — zero starvation) and shard 9 ran 8.6 min against 8.4 min on a green
// main run. Nothing was slow. The subject genuinely never armed, for 25 full
// seconds, because it never could:
//
//   the test spawned the node ALREADY PLAYING and seeded the music in a SECOND
//   round trip, so grid tick 0 — the tie-START slot, the only role that writes
//   tiedGateHoldUntilTick — could be consumed while the score was still empty.
//   loop:false means tick 0 never comes round again. A permanent loss, and
//   `seen: [-1]` with no NaN is its exact fingerprint: engine and node readable
//   throughout, just never asked to play anything.
//
// See `seedScoreThenPlay` for the measurement and the fix. The lesson for the
// next one: "slower here" and "genuinely different here" print the same red,
// and a budget was the answer to neither.
test('score: tied notes produce a single sustained envelope (engine-level held gate)', async ({ page, rackLegacy }) => {
  // 25s in-page wait bound + spawn/goto must fit INSIDE the test budget, or the
  // test timeout fires first and the bound is decorative. Failure-path only —
  // the waiter returns on first match, so green runs are unchanged.
  test.setTimeout(60_000);
  await spawnPatch(page, [
    { id: 'score', type: 'score', params: { bpm: 120, isPlaying: 0 } },
  ]);

  // Tied chain: A -> B -> C, three quarters at MIDI 60. With our held-gate
  // emission the engine reports `currentNoteId` as 'A' for the entire span,
  // and `tiedGateHoldUntilTick` is the chain-end grid tick (36).
  await seedScoreThenPlay(page, 'score', {
    notes: [
      { id: 'A', bar: 0, tick: 0, duration: 'quarter', midi: 60, staffStep: 10, accidental: null },
      { id: 'B', bar: 0, tick: 12, duration: 'quarter', midi: 60, staffStep: 10, accidental: null },
      { id: 'C', bar: 0, tick: 24, duration: 'quarter', midi: 60, staffStep: 10, accidental: null },
    ],
    dynamics: [],
    ties: [
      { id: 't1', fromNoteId: 'A', toNoteId: 'B' },
      { id: 't2', fromNoteId: 'B', toNoteId: 'C' },
    ],
    keySignature: 0,
    pages: 1,
    loop: false,
  });

  // Await the engine arming the held-gate hold-tick instead of a flat wait. The
  // tied-start branch sets tiedGateHoldUntilTick = 36 (chain-end grid tick) only
  // once note A is actually emitted; before that it's the -1 sentinel.
  const held = await waitForScoreReadout(page, 'tiedGateHoldUntilTick', 36, 25_000);
  const where = `${held.samples} in-page samples / ${Math.round(held.elapsedMs)} ms; values seen: [${held.seen.join(', ')}]`;
  expect(held.value, `tiedGateHoldUntilTick armed to the chain-end grid tick — ${where}`).toBe(36);
  // Gate is high (1) during the tied span. The tied-start branch writes
  // lastEmittedGate = 1 TOGETHER WITH the hold tick, so this is read from the
  // SAME in-page sample that saw 36 — one instant, no second round trip, and no
  // window in which the span could end between the two reads.
  expect(held.gate, `gate HIGH in the same sample that armed the hold — ${where}`).toBe(1);
});
