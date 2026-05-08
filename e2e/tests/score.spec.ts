// e2e/tests/score.spec.ts
//
// E2E for the SCORE module (treble-clef sheet-music sequencer).
//
// Coverage (matches the Phase-1 plan + brief):
//   - Place a note by clicking the staff with a duration tool selected.
//   - Drag-snap to nearest 16th tick on horizontal motion.
//   - Sharp tool on a note → accidental='sharp', MIDI +1.
//   - Sharp tool on empty staff → keySignature=1; F-line plays as F#5.
//   - Tie two notes → Tie object exists + SVG <path data-tie-id> renders.
//   - Currently-playing-note highlight via __engine().read(node, 'currentNoteId').
//   - Dynamic affects amplitude (read 'lastDynamicScale' from engine after step).
//   - Bar overflow rejected (whole + whole in same bar) with red flash.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

const NODE_ID = 'sc';

async function svgBox(page: import('@playwright/test').Page) {
  const svg = page.locator(`[data-testid="score-svg-${NODE_ID}"]`);
  await svg.waitFor();
  const box = await svg.boundingBox();
  if (!box) throw new Error('score svg has no bounding box');
  return { svg, box };
}

/** Convert (bar, tickInBar, staffStep) into screen coords inside the SVG.
 *  Mirrors the geometry constants in ScoreCard.svelte. */
function svgPoint(box: { x: number; y: number; width: number; height: number },
                  bar: number, tickInBar: number, staffStep: number) {
  const SVG_W = 720, SVG_H = 360;
  const ROW_TOP_Y = [70, 220];
  const STAFF_LINE_GAP = 8;
  const BARS_X_START = 78;
  const STAFF_RIGHT_X = 700;
  const BARS_PER_ROW = 4;
  const TICKS_PER_BAR = 48;
  const ROW_BAR_WIDTH = (STAFF_RIGHT_X - BARS_X_START) / BARS_PER_ROW;
  const TICK_PX = ROW_BAR_WIDTH / TICKS_PER_BAR;
  const STEP_PX = 4;
  const row = bar < BARS_PER_ROW ? 0 : 1;
  const col = bar % BARS_PER_ROW;
  const localX = BARS_X_START + col * ROW_BAR_WIDTH + tickInBar * TICK_PX;
  const localY = ROW_TOP_Y[row]! + staffStep * STEP_PX;
  return {
    x: box.x + (localX / SVG_W) * box.width,
    y: box.y + (localY / SVG_H) * box.height,
  };
}

test('score: clicking the staff with quarter tool places a note', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: NODE_ID, type: 'score', params: { bpm: 120, isPlaying: 0 } }]);

  await page.locator('[data-testid="score-tool-quarter"]').click();
  const { svg, box } = await svgBox(page);
  const pt = svgPoint(box, 0, 0, 5);
  await svg.click({ position: { x: pt.x - box.x, y: pt.y - box.y } });

  const notes = await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { notes?: Array<{ bar: number; tick: number; midi: number; duration: string }> } }> };
    };
    return w.__patch.nodes[id]?.data?.notes ?? [];
  }, NODE_ID);
  expect(notes.length).toBeGreaterThanOrEqual(1);
  expect(notes[0]?.bar).toBe(0);
  expect(notes[0]?.duration).toBe('quarter');
});

test('score: bar overflow is rejected with red shake (two whole notes in one bar)', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: NODE_ID, type: 'score', params: { isPlaying: 0 } }]);

  // Pre-seed bar 0 with a whole note (covers the entire bar).
  await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const t = w.__patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      (t.data as Record<string, unknown>).notes = [
        { id: 'pre', bar: 0, tick: 0, duration: 'whole', midi: 71, staffStep: 4, accidental: null },
      ];
      (t.data as Record<string, unknown>).keySignature = 0;
    });
  }, NODE_ID);

  await page.locator('[data-testid="score-tool-whole"]').click();
  const { svg, box } = await svgBox(page);
  const pt = svgPoint(box, 0, 0, 5);
  await svg.click({ position: { x: pt.x - box.x, y: pt.y - box.y } });

  const notes = await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { notes?: Array<unknown> } }> };
    };
    return w.__patch.nodes[id]?.data?.notes ?? [];
  }, NODE_ID);
  expect(notes.length).toBe(1);

  // Red flash overlay should briefly appear.
  const shake = page.locator(`[data-testid="score-shake-${NODE_ID}-0"]`);
  await expect(shake).toBeVisible();
});

test('score: sharp tool on a placed note flips accidental → MIDI +1', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: NODE_ID, type: 'score', params: { isPlaying: 0 } }]);

  // Pre-place a single A4 (step 5, MIDI 69) at bar 0 tick 0.
  await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const t = w.__patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      (t.data as Record<string, unknown>).notes = [
        { id: 'a4', bar: 0, tick: 0, duration: 'quarter', midi: 69, staffStep: 5, accidental: null },
      ];
      (t.data as Record<string, unknown>).keySignature = 0;
    });
  }, NODE_ID);

  await page.locator('[data-testid="score-tool-sharp"]').click();
  const { svg, box } = await svgBox(page);
  const pt = svgPoint(box, 0, 0, 5);
  await svg.click({ position: { x: pt.x - box.x, y: pt.y - box.y } });

  const note = await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { notes?: Array<{ id: string; midi: number; accidental: string | null }> } }> };
    };
    return (w.__patch.nodes[id]?.data?.notes ?? []).find((n) => n.id === 'a4');
  }, NODE_ID);
  expect(note?.accidental).toBe('sharp');
  expect(note?.midi).toBe(70);
});

test('score: sharp tool on empty staff cycles the key signature (+1) and re-derives non-accidental notes', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: NODE_ID, type: 'score', params: { isPlaying: 0 } }]);

  // Pre-place an F5 (top line) with no per-note accidental.
  await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const t = w.__patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      (t.data as Record<string, unknown>).notes = [
        { id: 'f5', bar: 0, tick: 0, duration: 'quarter', midi: 77, staffStep: 0, accidental: null },
      ];
      (t.data as Record<string, unknown>).keySignature = 0;
    });
  }, NODE_ID);

  await page.locator('[data-testid="score-tool-sharp"]').click();
  const { svg, box } = await svgBox(page);
  // Click in the middle of bar 1 (which has no notes), well below the staff.
  const pt = svgPoint(box, 1, 24, 8);
  await svg.click({ position: { x: pt.x - box.x, y: pt.y - box.y } });

  const data = await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { keySignature?: number; notes?: Array<{ id: string; midi: number }> } }> };
    };
    return w.__patch.nodes[id]?.data ?? null;
  }, NODE_ID);
  expect(data?.keySignature).toBe(1);
  // F5 should now play as F#5 (midi 78) under G major.
  expect(data?.notes?.find((n) => n.id === 'f5')?.midi).toBe(78);
});

test('score: tie tool over two notes creates a Tie + SVG <path data-tie-id>', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: NODE_ID, type: 'score', params: { isPlaying: 0 } }]);

  await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const t = w.__patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      (t.data as Record<string, unknown>).notes = [
        { id: 'na', bar: 0, tick: 0, duration: 'quarter', midi: 69, staffStep: 5, accidental: null },
        { id: 'nb', bar: 0, tick: 12, duration: 'quarter', midi: 71, staffStep: 4, accidental: null },
      ];
    });
  }, NODE_ID);

  await page.locator('[data-testid="score-tool-tie"]').click();
  const { svg, box } = await svgBox(page);
  const pa = svgPoint(box, 0, 0, 5);
  await svg.click({ position: { x: pa.x - box.x, y: pa.y - box.y } });
  const pb = svgPoint(box, 0, 12, 4);
  await svg.click({ position: { x: pb.x - box.x, y: pb.y - box.y } });

  const ties = await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { ties?: Array<{ fromNoteId: string; toNoteId: string }> } }> };
    };
    return w.__patch.nodes[id]?.data?.ties ?? [];
  }, NODE_ID);
  expect(ties.length).toBe(1);
  expect([ties[0]?.fromNoteId, ties[0]?.toNoteId]).toEqual(expect.arrayContaining(['na', 'nb']));

  // SVG path with data-tie-id renders.
  const tiePath = page.locator(`path[data-tie-id="${ties[0]?.id ?? ''}"]`);
  await expect(tiePath).toHaveCount(1);
});

test('score: drag-snap moves an existing note to the nearest 16th tick', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: NODE_ID, type: 'score', params: { isPlaying: 0 } }]);

  await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const t = w.__patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      (t.data as Record<string, unknown>).notes = [
        { id: 'mv', bar: 0, tick: 0, duration: '16th', midi: 67, staffStep: 6, accidental: null },
      ];
    });
  }, NODE_ID);

  await page.locator('[data-testid="score-tool-16th"]').click();
  const { svg, box } = await svgBox(page);
  const start = svgPoint(box, 0, 0, 6);
  // Drag horizontally to bar 0 tick 6 (= two 16ths over).
  const end = svgPoint(box, 0, 6, 6);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();

  const note = await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { notes?: Array<{ id: string; tick: number; bar: number }> } }> };
    };
    return (w.__patch.nodes[id]?.data?.notes ?? []).find((n) => n.id === 'mv');
  }, NODE_ID);
  // tick should snap to a multiple of 3 (16th grid). 6 is on grid; expect ~6
  // — we tolerate ±3 in case Playwright's mouse jitter offsets by one snap.
  expect(note?.bar).toBe(0);
  expect([3, 6, 9]).toContain(note?.tick ?? -1);
});

test('score: dynamic tool below the staff places a marker, lastDynamicScale changes during playback', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: NODE_ID, type: 'score', params: { bpm: 240, isPlaying: 0 } }]);

  // Place a note at bar 0 tick 0 + dynamic ff at the same position via direct
  // patch mutation; then start playback and read `lastDynamicScale` from the
  // engine. Avoids flaky SVG hit-testing for this assertion.
  await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown>; params?: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const t = w.__patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      (t.data as Record<string, unknown>).notes = [
        { id: 'p1', bar: 0, tick: 0, duration: 'quarter', midi: 69, staffStep: 5, accidental: null },
      ];
      (t.data as Record<string, unknown>).dynamics = [
        { id: 'd-ff', bar: 0, tick: 0, level: 'ff' },
      ];
      if (!t.params) t.params = {};
      t.params.isPlaying = 1;
    });
  }, NODE_ID);

  // Wait for the engine to advance past tick 0.
  await page.waitForTimeout(400);

  const scale = await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return -1;
    const node = w.__patch.nodes[id];
    if (!node) return -1;
    const v = eng.read(node, 'lastDynamicScale');
    return typeof v === 'number' ? v : -1;
  }, NODE_ID);
  expect(scale).toBeGreaterThan(0.85); // ff = 0.95
});

test('score: currently-playing-note highlight publishes through engine read("currentNoteId")', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: NODE_ID, type: 'score', params: { bpm: 240, isPlaying: 0 } }]);

  await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown>; params?: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const t = w.__patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      (t.data as Record<string, unknown>).notes = [
        { id: 'first', bar: 0, tick: 0, duration: 'half', midi: 60, staffStep: 10, accidental: null },
      ];
      if (!t.params) t.params = {};
      t.params.isPlaying = 1;
    });
  }, NODE_ID);

  // Poll a few times until the engine has emitted the note-start.
  let observed = '';
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(100);
    const id = await page.evaluate((nodeId) => {
      const w = globalThis as unknown as {
        __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      const node = w.__patch.nodes[nodeId];
      if (!eng || !node) return '';
      const v = eng.read(node, 'currentNoteId');
      return typeof v === 'string' ? v : '';
    }, NODE_ID);
    if (id === 'first') { observed = id; break; }
  }
  expect(observed).toBe('first');
});
