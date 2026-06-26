// e2e/tests/mappy-export-import.spec.ts
//
// MAPPY EXPORT MAP / IMPORT MAP — round-trip the venue SURFACE LAYOUT across
// patches. The "map" is the projector-alignment: the COUNT of surfaces + each
// surface's corner geometry + per-surface FIT. Align once, export, reuse in a
// DIFFERENT patch at the same venue.
//
// Flow:
//   1. Spawn MAPPY, set up a known multi-surface layout (≥2 surfaces moved to
//      known corners, distinct FIT modes, count bumped) by writing node.data
//      the SAME way the card's drag does.
//   2. Click "export map" → intercept the browser download → read the JSON →
//      assert it carries those surfaces/positions/FIT/count.
//   3. Spawn a FRESH MAPPY (default 1 full-frame surface) → feed the exported
//      file to the hidden import <input> → assert the surfaces appear at the
//      SAVED positions, read back from the live store.
//
// Renderer-INDEPENDENT: this is a DOM + Y.Doc + JSON-file test — no canvas pixel
// read, no encoder, no camera — so it's stable on CI's SwiftShader. The spec
// name (mappy-export-import) matches NO heavy-WebGL glob, so it runs in the
// parallel sharded matrix (not the serialized GPU lane).

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

type Page = import('@playwright/test').Page;
type Node = { id: string; type: string; position: { x: number; y: number }; domain: 'video'; params?: Record<string, number> };

type SurfaceState = { corners: number[][]; fit?: boolean };

// Two clearly-distinct, off-default quads + mixed FIT, with a live count of 2.
const S1: number[][] = [[0.05, 0.95], [0.45, 0.92], [0.43, 0.55], [0.07, 0.58]];
const S2: number[][] = [[0.55, 0.4], [0.95, 0.42], [0.92, 0.05], [0.58, 0.08]];

/** Write a known layout into MAPPY's node.data the SAME way the card's drag +
 *  FIT toggle + count do (in place, in a Y.Doc transaction). */
async function setLayout(page: Page, id: string) {
  await page.evaluate(({ id, S1, S2 }) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { surfaces?: { corners: number[][]; fit?: boolean }[]; surfaceCount?: number }; params?: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes[id];
      if (!n) return;
      if (!n.data) n.data = {};
      // Build the WHOLE 6-surface array first (surface 1 + 2 configured), then
      // ONE fresh-array assignment — never an array index-assign (SyncedStore
      // arrays reject `arr[i] = …`; this mirrors mappy-edit's discipline).
      const surfaces = Array.from({ length: 6 }, (_v, i) => {
        if (i === 0) return { corners: S1, fit: false }; // surface 1 — CROP
        if (i === 1) return { corners: S2, fit: true }; // surface 2 — FIT
        return { corners: [[0, 0], [1, 0], [1, 1], [0, 1]] as number[][], fit: true };
      });
      n.data.surfaces = surfaces;
      n.data.surfaceCount = 2;
      if (n.params) n.params.surfaceCount = 2;
    });
  }, { id, S1, S2 });
}

/** Read MAPPY's live surface layout back out of the store. */
async function readLayout(page: Page, id: string) {
  return page.evaluate(({ id }) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { surfaces?: { corners: number[][]; fit?: boolean }[]; surfaceCount?: number } }> };
    };
    const n = w.__patch.nodes[id];
    const d = n?.data ?? {};
    return {
      surfaces: (d.surfaces ?? []).map((s) => ({ corners: s.corners, fit: s.fit })),
      count: d.surfaceCount,
    };
  }, { id });
}

async function setup(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  return errors;
}

function approxCorners(actual: number[][], expected: number[][], tol = 1e-6) {
  expect(actual).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i]![0]).toBeCloseTo(expected[i]![0], 6);
    expect(actual[i]![1]).toBeCloseTo(expected[i]![1], 6);
  }
  void tol;
}

test.describe('MAPPY — export map / import map (surface layout)', () => {
  test.describe.configure({ timeout: 120_000 });

  test('export downloads the layout; import into a FRESH mappy restores the surfaces at saved positions', async ({ page }) => {
    const errors = await setup(page);

    // ── 1) source mappy with a known 2-surface layout ──
    await spawnPatch(page, [
      { id: 'mappy', type: 'mappy', position: { x: 200, y: 80 }, domain: 'video' },
    ] as Node[], []);
    await expect(page.locator('[data-testid="mappy-card"]')).toHaveCount(1);
    await setLayout(page, 'mappy');

    // ── 2) export → intercept the download → read the JSON ──
    const exportBtn = page.locator('[data-testid="mappy-export-map"]');
    await expect(exportBtn).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      exportBtn.click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^mappy-map-\d+\.json$/);

    const savedPath = await download.path();
    expect(savedPath, 'download saved to disk').toBeTruthy();
    const { readFileSync } = await import('node:fs');
    const json = readFileSync(savedPath!, 'utf8');
    const map = JSON.parse(json) as { kind: string; version: number; count: number; surfaces: { corners: number[][]; fit: boolean }[] };

    // payload shape: the venue layout
    expect(map.kind).toBe('mappy-map');
    expect(map.version).toBe(1);
    expect(map.count).toBe(2);
    expect(map.surfaces).toHaveLength(6);
    // the two configured surfaces are in the file at their saved positions + FIT
    approxCorners(map.surfaces[0]!.corners, S1);
    expect(map.surfaces[0]!.fit).toBe(false);
    approxCorners(map.surfaces[1]!.corners, S2);
    expect(map.surfaces[1]!.fit).toBe(true);

    // ── 3) FRESH mappy → import the file → surfaces restored at saved positions ──
    await spawnPatch(page, [
      { id: 'mappy2', type: 'mappy', position: { x: 200, y: 80 }, domain: 'video' },
    ] as Node[], []);
    await expect(page.locator('[data-testid="mappy-card"]')).toHaveCount(1);

    // sanity: the fresh mappy is at its default single full-frame surface
    const before = await readLayout(page, 'mappy2');
    expect(before.count ?? 1).toBe(1);

    // feed the exported file to the hidden import input (the button .click()s it)
    await page.locator('[data-testid="mappy-import-file"]').setInputFiles({
      name: 'venue-map.json',
      mimeType: 'application/json',
      buffer: Buffer.from(json, 'utf8'),
    });

    // the layout is restored from the store
    await expect.poll(async () => (await readLayout(page, 'mappy2')).count, { timeout: 10_000 }).toBe(2);
    const after = await readLayout(page, 'mappy2');
    approxCorners(after.surfaces[0]!.corners, S1);
    expect(after.surfaces[0]!.fit).toBe(false);
    approxCorners(after.surfaces[1]!.corners, S2);
    expect(after.surfaces[1]!.fit).toBe(true);

    // a success status is surfaced + the surfaces show in the legend (2 live)
    await expect(page.locator('[data-testid="mappy-map-status"]')).toHaveAttribute('data-status-kind', 'ok');
    await expect(page.locator('[data-testid="mappy-count-n"]')).toHaveText('2');

    expect(errors, `no page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('importing a FOREIGN/garbage file is rejected and does NOT mutate the layout', async ({ page }) => {
    const errors = await setup(page);

    await spawnPatch(page, [
      { id: 'mappy', type: 'mappy', position: { x: 200, y: 80 }, domain: 'video' },
    ] as Node[], []);
    await expect(page.locator('[data-testid="mappy-card"]')).toHaveCount(1);
    await setLayout(page, 'mappy');
    const before = await readLayout(page, 'mappy');

    // feed a non-MAPPY JSON file
    await page.locator('[data-testid="mappy-import-file"]').setInputFiles({
      name: 'not-a-map.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ kind: 'patch', version: 1, nodes: [] }), 'utf8'),
    });

    // an error status is shown
    await expect(page.locator('[data-testid="mappy-map-status"]')).toHaveAttribute('data-status-kind', 'err', { timeout: 10_000 });

    // …and the layout is UNCHANGED
    const after = await readLayout(page, 'mappy');
    expect(after.count).toBe(before.count);
    approxCorners(after.surfaces[0]!.corners, before.surfaces[0]!.corners);
    approxCorners(after.surfaces[1]!.corners, before.surfaces[1]!.corners);

    // also feed straight garbage bytes → still rejected, still no mutation
    await page.locator('[data-testid="mappy-import-file"]').setInputFiles({
      name: 'garbage.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{not valid json at all', 'utf8'),
    });
    await expect(page.locator('[data-testid="mappy-map-status"]')).toHaveAttribute('data-status-kind', 'err', { timeout: 10_000 });
    const after2 = await readLayout(page, 'mappy');
    expect(after2.count).toBe(before.count);
    approxCorners(after2.surfaces[0]!.corners, before.surfaces[0]!.corners);

    expect(errors, `no page errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
