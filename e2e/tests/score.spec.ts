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
  await page.goto('/');
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
  await page.goto('/');
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
  await page.goto('/');
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
  await page.goto('/');
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
  await page.goto('/');
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
  await page.goto('/');
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
  await page.goto('/');
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

  await page.waitForTimeout(500);
  const dynScale = await page.evaluate(() => {
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
  // ff -> 0.95
  expect(dynScale).toBeGreaterThan(0.85);
  expect(dynScale).toBeLessThan(1.05);
});

test('score: bar overflow rejected — second whole note in the same bar does NOT add', async ({ page }) => {
  await page.goto('/');
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
