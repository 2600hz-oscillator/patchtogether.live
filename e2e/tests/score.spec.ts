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

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

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

test('score: place a note via the quarter tool + click', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
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

test('score: drag-snap to nearest 16th tick', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
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

test('score: sharp tool on note toggles per-note accidental + transposes MIDI +1', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
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

test('score: sharp tool on empty staff increments key signature', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
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

test('score: tie tool — picking two notes creates a Tie object + SVG path', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
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

test('score: currently-playing note highlight tracks engine.read currentNoteId', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'score', type: 'score', params: { bpm: 240, isPlaying: 1 } }]);

  // Seed a few notes spanning bars so the engine has something to play.
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
          { id: 'n3', bar: 0, tick: 24, duration: 'quarter', midi: 74, staffStep: 3, accidental: null },
        ],
        dynamics: [],
        ties: [],
        keySignature: 0,
      };
    });
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

test('score: dynamic marker scales the env output amplitude', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'score', type: 'score', params: { bpm: 240, isPlaying: 1 } }]);

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
          { id: 'n1', bar: 0, tick: 0, duration: 'quarter', midi: 72, staffStep: 5, accidental: null },
        ],
        dynamics: [
          { id: 'd1', bar: 0, tick: 0, level: 'ff' },
        ],
        ties: [],
        keySignature: 0,
      };
    });
  });

  // CI-load robustness: dynamicScale is a DETERMINISTIC value (ff → 0.95), but
  // a fixed 500ms wait raced the engine picking up the n.data write under CI
  // load (score env-amplitude `toBeGreaterThan` flake). Poll the live read
  // until it settles into the expected band instead of a one-shot read after a
  // fixed sleep — same correctness assertion, tolerant of slow propagation.
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
  await expect
    .poll(readDynScale, { timeout: 10_000 })
    .toBeGreaterThan(0.85);
  expect(await readDynScale()).toBeLessThan(1.05);
});

test('score: bar overflow rejected — second whole note in the same bar does NOT add', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
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

test('score: page nav — add a page, navigate via arrows, counter shows correctly', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
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

test('score: page count is capped at 4 — add button disabled at max', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
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

test('score: loop toggle persists in score data', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'score', type: 'score' }]);

  // Default: loop=false.
  await expect.poll(async () => (await readScoreV2(page)).loop).toBe(false);

  await page.locator('[data-testid="score-tool-loop-score"]').click();
  await expect.poll(async () => (await readScoreV2(page)).loop).toBe(true);

  await page.locator('[data-testid="score-tool-loop-score"]').click();
  await expect.poll(async () => (await readScoreV2(page)).loop).toBe(false);
});

test('score: stop-bar — placing the marker writes to score data', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
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

test('score: stop-bar + loop=on wraps tickIndex back to 0 at end of sequence', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'score', type: 'score', params: { bpm: 240, isPlaying: 1 } },
  ]);

  // Tiny sequence: notes only in bars 0..1, stop-bar at bar 2, loop ON.
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
          { id: 'n1', bar: 0, tick: 0, duration: 'quarter', midi: 60, staffStep: 10, accidental: null },
        ],
        dynamics: [],
        ties: [],
        keySignature: 0,
        pages: 1,
        loop: true,
        stopBar: { bar: 2, tick: 0 },
      };
    });
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

test('score: stop-bar + loop=off stops playback at end of sequence', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'score', type: 'score', params: { bpm: 480, isPlaying: 1 } },
  ]);

  // Stop after just 1 bar at high BPM → ~125ms total.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown>; params?: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['score'];
      if (!n) return;
      n.data = {
        notes: [
          { id: 'n1', bar: 0, tick: 0, duration: 'quarter', midi: 60, staffStep: 10, accidental: null },
        ],
        dynamics: [],
        ties: [],
        keySignature: 0,
        pages: 1,
        loop: false,
        stopBar: { bar: 1, tick: 0 },
      };
    });
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

// #score-tied-gate (re-enabled, wave-3): the tied-note held-gate read used a FLAT
// waitForTimeout(400) + a single read, so under CI load the read could land BEFORE
// the scheduler had emitted the tie-start note A — at which point
// `tiedGateHoldUntilTick` is still its -1 "not yet armed" sentinel (set to the
// chain-end tick only inside emitTick for the tied-start role) and `gateValue`
// is still 0. That's the intermittent -1 the old comment chased; it's a timing
// race, not an off-by-one in any search window. The fix awaits the held-gate
// signal deterministically: poll `tiedGateHoldUntilTick` until it arms to 36
// (the chain-end grid tick), then read the gate — which is guaranteed high once
// the hold tick is set, since both are written together in the tied-start branch.
test('score: tied notes produce a single sustained envelope (engine-level held gate)', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'score', type: 'score', params: { bpm: 120, isPlaying: 1 } },
  ]);

  // Tied chain: A -> B -> C, three quarters at MIDI 60. With our held-gate
  // emission the engine reports `currentNoteId` as 'A' for the entire span,
  // and `tiedGateHoldUntilTick` is the chain-end grid tick (36).
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
      };
    });
  });

  // Await the engine arming the held-gate hold-tick instead of a flat wait. The
  // tied-start branch sets tiedGateHoldUntilTick = 36 (chain-end grid tick) only
  // once note A is actually emitted; before that it's the -1 sentinel. Polling
  // for 36 makes the test deterministic regardless of how long the scheduler
  // takes to fire A's emitTick under CI load (backed-off intervals so we don't
  // hammer engine.read while the audio thread catches up).
  await expect
    .poll(
      async () =>
        await page.evaluate(() => {
          const w = globalThis as unknown as {
            __engine?: () => { read: (node: unknown, key: string) => unknown } | null;
            __patch: { nodes: Record<string, unknown> };
          };
          const e = w.__engine?.();
          if (!e) return -999;
          const v = e.read(w.__patch.nodes['score'], 'tiedGateHoldUntilTick');
          return typeof v === 'number' ? v : -999;
        }),
      { timeout: 10_000, intervals: [125, 250, 500] },
    )
    .toBe(36);
  // Gate is high (1) during the tied span. The tied-start branch writes
  // lastEmittedGate = 1 together with the hold tick above, so once the poll
  // sees 36 the gate read is guaranteed high — no separate race window.
  const gate = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (node: unknown, key: string) => unknown } | null;
      __patch: { nodes: Record<string, unknown> };
    };
    const e = w.__engine?.();
    if (!e) return -1;
    const v = e.read(w.__patch.nodes['score'], 'gateValue');
    return typeof v === 'number' ? v : -1;
  });
  expect(gate).toBe(1);
});
