// e2e/tests/toybox-fixture-behavior.spec.ts
//
// APP-BEHAVIOR legs on the FIXTURE pack (#2070 migration phase, the
// coordinator-approved split): locks, revert, and graph-structure all
// asserted as EXACT PIXELS instead of perceptual floors or data-only
// equality. This file REGISTERS fixtures, so per the disjointness gate it
// never asserts engine-curation properties — those live in
// toybox-randomize.spec.ts against the real content population.
//
// ── The pinned seeds ───────────────────────────────────────────────────────
// Rolls here are seeded and their graphs FOLDED to an expected color by
// foldComputableGraph, which only understands {fade, over, map, lumakey} +
// spatial identities {tile, mirror} over FIX_FLAT layers. The seeds were
// scanned to roll exactly such graphs over the locked flats (2026-08-20). If
// an ENGINE change re-rolls one into a non-computable shape, the fold
// returns null and the test fails LOUDLY asking for a re-pin — a conscious
// re-scan, never a silent skip.

import { test, expect } from '@playwright/test';
import { openToyboxFaceTab } from './_helpers';
import {
  CHAIN_TOLERANCE,
  FLAT_TOLERANCE,
  FIX_FLAT,
  foldComputableGraph,
  type Rgb01,
} from '../_fixtures/toybox-fixture-shaders';
import {
  OFF,
  expectPixel,
  fadeGraph,
  passThrough,
  seedPatch,
  spawnWithFixtures,
  waitFramesInPage,
  type FixtureG,
} from './_toybox-fixture-helpers';

const RED: Rgb01 = [1, 0, 0];
const GREEN: Rgb01 = [0, 1, 0];
const BLUE: Rgb01 = [0, 0, 1];

const flatLayer = (rgb: Rgb01, locked = false) => ({
  kind: 'gen',
  contentId: FIX_FLAT.id,
  params: { fr: rgb[0], fg: rgb[1], fb: rgb[2] },
  ...(locked ? { locked: true } : {}),
});

async function roll(page: import('@playwright/test').Page, seed: number) {
  const res = await page.evaluate((s) => (globalThis as unknown as FixtureG).__toyboxRoll!(s), seed);
  expect(res, `roll(seed=${seed}) applied`).not.toBeNull();
  return res!;
}

async function layerJson(page: import('@playwright/test').Page, idx: number): Promise<string> {
  return page.evaluate((idx) => {
    const n = (globalThis as unknown as FixtureG).__patch.nodes['tb'];
    return JSON.stringify((n?.data as { layers?: unknown[] })?.layers?.[idx]);
  }, idx);
}

test.describe('toybox fixture-based app behavior — exact pixels', () => {
  test('LOCKED layer survives rolls at PIXEL fidelity (single-frame check)', async ({ page }) => {
    // The lock contract as bytes on screen, not just data equality: after any
    // number of rolls, passing the locked layer through paints EXACTLY the
    // color it was locked with.
    test.setTimeout(180_000);
    await spawnWithFixtures(page);
    await seedPatch(page, [flatLayer(RED, true), flatLayer(GREEN), OFF, OFF], fadeGraph(0.5));
    const lockedBefore = await layerJson(page, 0);

    for (const seed of [3301, 3302]) {
      await roll(page, seed);
      expect(await layerJson(page, 0), `seed ${seed}: locked layer data changed`).toEqual(lockedBefore);
    }
    // Manual edits remain allowed on locked layers (locks bind the DICE): pass
    // the locked layer through and its EXACT color is still there.
    await seedPatch(
      page,
      [JSON.parse(lockedBefore) as Record<string, unknown>, flatLayer(GREEN), OFF, OFF],
      passThrough(0),
    );
    await expectPixel(page, 0.5, 0.5, RED, FLAT_TOLERANCE, 'locked layer after two rolls');
  });

  test('REVERT restores the pre-roll patch at PIXEL fidelity', async ({ page }) => {
    // "The patch you had is back" as bytes on screen: exact blue before the
    // session, exact blue after REVERT — with a probe-moves control in the
    // middle (the rolled composite must NOT read as blue, or the final
    // assertion could pass on a stuck frame).
    test.setTimeout(180_000);
    await spawnWithFixtures(page);
    await seedPatch(page, [flatLayer(BLUE), OFF, OFF, OFF], passThrough(0));
    await expectPixel(page, 0.5, 0.5, BLUE, FLAT_TOLERANCE, 'pre-roll blue');

    const before = await page.evaluate(() =>
      JSON.stringify((globalThis as unknown as FixtureG).__patch.nodes['tb']?.data ?? null),
    );
    await roll(page, 3310);
    const after = await page.evaluate(() =>
      JSON.stringify((globalThis as unknown as FixtureG).__patch.nodes['tb']?.data ?? null),
    );
    expect(after, 'roll must change the patch').not.toEqual(before);
    // Probe-moves control: wait for the rolled composite to leave exact blue.
    await page.waitForFunction(() => {
      const c = document.querySelector(
        '[data-testid="toybox-canvas"], [data-testid="toybox-face-canvas"]',
      ) as HTMLCanvasElement | null;
      if (!c) return false;
      const c2d = c.getContext('2d');
      if (!c2d) return false;
      const { data } = c2d.getImageData(Math.round(c.width / 2), Math.round(c.height / 2), 1, 1);
      return Math.abs(data[0]! - 0) > 12 || Math.abs(data[1]! - 0) > 12 || Math.abs(data[2]! - 255) > 12;
    }, undefined, { timeout: 20_000 });

    // REVERT lives on the presets tab of the faceplate console.
    await openToyboxFaceTab(page, 'presets');
    await page.getByTestId('toybox-randomize-revert').click();
    await expectPixel(page, 0.5, 0.5, BLUE, FLAT_TOLERANCE, 'post-revert blue');
  });

  test('GRAPH-STRUCTURE-THROUGH-PIXELS: a rolled topology over locked flats folds to its EXACT composite', async ({ page }) => {
    // The migration's flagship: "the graph changed AND the render reflects
    // it" as ONE assertion. All four slots locked (two flats + two off), so a
    // seeded roll can ONLY restructure the graph; the expected color is
    // FOLDED from the applied blob's own nodes/edges/params through the
    // same arithmetic the combine shader implements — derived from the
    // artifact, never hand-typed.
    test.setTimeout(180_000);
    await spawnWithFixtures(page);
    const shapes: string[] = [];
    for (const seed of [3026, 3027]) {
      await seedPatch(
        page,
        [
          flatLayer(RED, true),
          flatLayer(GREEN, true),
          { ...OFF, locked: true },
          { ...OFF, locked: true },
        ],
        passThrough(0),
      );
      const res = await roll(page, seed);
      const ops = res.blob.combine.nodes.filter((n) => n.kind !== 'source' && n.kind !== 'output');
      expect(ops.length, `seed ${seed}: structure must be non-trivial (units: op nodes)`).toBeGreaterThanOrEqual(2);
      shapes.push(JSON.stringify(ops.map((o) => o.kind).sort()));
      const folded = foldComputableGraph(
        res.blob.combine,
        res.blob.layers as Array<{ kind: string; contentId?: string | null; params?: Record<string, number> }>,
      );
      expect(
        folded,
        `seed ${seed} rolled a graph the fold cannot compute (ops: ${ops.map((o) => o.kind).join(',')}) — ` +
          're-scan and re-pin the seed (engine change), do not skip',
      ).not.toBeNull();
      await expectPixel(page, 0.5, 0.5, folded!, CHAIN_TOLERANCE, `seed ${seed} folded composite`);
    }
    // And the two pinned seeds are genuinely different STRUCTURES — the
    // "graph changed" half, asserted on the applied artifacts.
    expect(shapes[0], `both seeds rolled the same op multiset (${shapes[0]})`).not.toEqual(shapes[1]);
  });
});
