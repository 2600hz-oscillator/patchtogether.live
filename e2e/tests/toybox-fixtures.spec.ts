// e2e/tests/toybox-fixtures.spec.ts
//
// THE FIXTURE-SHADER MECHANISM (#2070) — proves the deterministic pack loads
// through the product's own custom-shader seam and that EXACT compositing
// arithmetic is assertable on SwiftShader, replacing perceptual floors for
// app-behavior tests.
//
// ── WHERE THIS RUNS ─────────────────────────────────────────────────────────
// Matches `**/toybox-*.spec.ts` (WEBGL_HEAVY) so PR shards skip it; the ONE
// `@webgl-smoke`-tagged test is the PR lane's proof (same discipline as
// toybox-shader-validate.spec.ts). Every fixture is a pure function of
// (uv, params) — no iTime — so frames are byte-identical by construction and
// SwiftShader's frame rate is irrelevant to correctness.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO (yet) ───────────────────────────────
// No migration of the randomize perceptual sweep happens here (#2070
// constraint 4): the parts of that suite that test SHADER behavior (the
// dud-tail catalog audit, the real-shader smoke) stay real-shader; migrating
// the APP-behavior parts is sequenced behind a coordinator checkpoint.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import {
  FIX_FLAT,
  FIX_FRAG_INVERT,
  FIX_GRADIENT,
  FLAT_TOLERANCE,
  GRADIENT_TOLERANCE,
  expectedFade,
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

const flatLayer = (rgb: Rgb01) => ({
  kind: 'gen',
  contentId: FIX_FLAT.id,
  params: { fr: rgb[0], fg: rgb[1], fb: rgb[2] },
});

// ---------------------------------------------------------------------------
// FLOOR (@webgl-smoke): the mechanism end-to-end with exact arithmetic
// ---------------------------------------------------------------------------

test('@webgl-smoke fixture pack registers through the REAL seam and composites to EXACT pixel values', async ({ page }) => {
  test.setTimeout(120_000);
  await spawnWithFixtures(page);

  // FADE of pure red over pure green at 0.5 — a computed constant, not a
  // perceptual floor. expectedFade mirrors COMBINE_FRAG_SRC's uOp 0.
  await seedPatch(page, [flatLayer(RED), flatLayer(GREEN), OFF, OFF], fadeGraph(0.5));
  const mid = expectedFade(RED, GREEN, 0.5);
  await expectPixel(page, 0.5, 0.5, mid, FLAT_TOLERANCE, 'fade 0.5 of green over red');

  // POSITIVE CONTROL of the probe (validate-the-instrument): drive amount to
  // the extremes and the SAME probe must follow to two different, exact
  // values — proving it reads the composite the graph computes, not a stale
  // frame or the wrong surface.
  await seedPatch(page, [flatLayer(RED), flatLayer(GREEN), OFF, OFF], fadeGraph(1));
  await expectPixel(page, 0.5, 0.5, GREEN, FLAT_TOLERANCE, 'fade 1.0 (all top)');
  await seedPatch(page, [flatLayer(RED), flatLayer(GREEN), OFF, OFF], fadeGraph(0));
  await expectPixel(page, 0.5, 0.5, RED, FLAT_TOLERANCE, 'fade 0.0 (all base)');

  // FRAME STABILITY: fixtures read no clock, so two samples N frames apart
  // are the same bytes — determinism is a property of the pack, asserted.
  const sample = () =>
    page.evaluate(() => {
      const c = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement;
      const { data } = c.getContext('2d')!.getImageData(
        Math.round(c.width / 2),
        Math.round(c.height / 2),
        1,
        1,
      );
      return [data[0], data[1], data[2]];
    });
  const s1 = await sample();
  await waitFramesInPage(page, 30);
  const s2 = await sample();
  expect(s2, 'fixture frames must be byte-stable across 30 frames (canvas bytes)').toEqual(s1);
});

// ---------------------------------------------------------------------------
// HEAVY LANE — the rest of the mechanism
// ---------------------------------------------------------------------------

test.describe('toybox fixture mechanism — heavy proofs', () => {
  test('GRADIENT maps position into pixel values (orientation pinned by measurement)', async ({ page }) => {
    test.setTimeout(120_000);
    await spawnWithFixtures(page);
    await seedPatch(page, [{ kind: 'gen', contentId: FIX_GRADIENT.id, params: { gb: 0.5 } }, OFF, OFF, OFF], passThrough(0));
    // R = uv.x: unambiguous left→right.
    await expectPixel(page, 0.25, 0.5, [0.25, 0.5, 0.5], GRADIENT_TOLERANCE, 'gradient at x=0.25');
    await expectPixel(page, 0.75, 0.5, [0.75, 0.5, 0.5], GRADIENT_TOLERANCE, 'gradient at x=0.75');
    // G = uv.y. MEASURED orientation (pinned 2026-08-20): the preview blit
    // preserves GL's bottom-origin — canvas TOP row is uv.y ≈ 1. If a future
    // pipeline change flips the blit, these two go red and the new
    // orientation is a deliberate decision, not a drift.
    await expectPixel(page, 0.5, 0.1, [0.5, 0.9, 0.5], GRADIENT_TOLERANCE, 'gradient near canvas top');
    await expectPixel(page, 0.5, 0.9, [0.5, 0.1, 0.5], GRADIENT_TOLERANCE, 'gradient near canvas bottom');
  });

  test('FRAG fixture proves the scene-input chain with exact arithmetic', async ({ page }) => {
    test.setTimeout(120_000);
    await spawnWithFixtures(page);
    const base: Rgb01 = [0.8, 0.2, 0.4];
    await seedPatch(
      page,
      [flatLayer(base), { kind: 'frag', contentId: FIX_FRAG_INVERT.id, params: {} }, OFF, OFF],
      passThrough(1),
    );
    // invert(scene) of a flat (r,g,b) is exactly (1-r, 1-g, 1-b).
    await expectPixel(page, 0.5, 0.5, [0.2, 0.8, 0.6], FLAT_TOLERANCE, 'frag invert of flat base');
  });

  test('@webgl-smoke GATE: fixture-registering specs and engine-curation specs stay DISJOINT', () => {
    // The coordinator-approved boundary rule (#2070), enforced rather than
    // remembered: registering fixtures ALTERS the randomize roll pools
    // (fixtures are listed GEN content), so a spec file that registers them
    // must never assert engine-CURATION properties (perceptual floors, the
    // DIM catalog classification) — those measure the REAL content
    // population — and the real-shader suite must never register fixtures.
    // File-level disjointness, scanned over the ARTIFACT (every
    // toybox-*.spec.ts that exists, so a future migration file auto-enrolls;
    // a later "consistency" edit that merges the two concerns reddens here).
    // Marker literals are concatenated so this gate cannot flag itself.
    const FIXTURE_MARKERS = [
      // the registration seam — presence means the file mutates the roll pools
      '__toybox' + 'RegisterFixtureContent',
      // the shared helper that CALLS the seam (_toybox-fixture-helpers.ts):
      // without this, extracting the call into a helper would launder the
      // marker out of the gate's sight — an importer registers just the same
      'spawn' + 'WithFixtures',
    ];
    const CURATION_MARKERS = [
      // the perceptual liveness floor — measures REAL content brightness
      'expect' + 'Alive(',
      // the DIM catalog audit hook — classifies the REAL GEN population
      '__toybox' + 'DimGen',
      // the perceptual floor constants — only meaningful over real content
      'LIT40' + '_FLOOR',
    ];
    const classify = (src: string) => ({
      registers: FIXTURE_MARKERS.some((m) => src.includes(m)),
      curates: CURATION_MARKERS.some((m) => src.includes(m)),
    });

    // NEGATIVE CONTROLS, both directions, through the SAME predicate the
    // gate calls (house style): the classifier must flag a merged source and
    // must pass each concern alone.
    const merged = classify(
      `await (globalThis).${FIXTURE_MARKERS[0]}(pack); await ${CURATION_MARKERS[0]}page, 'x');`,
    );
    expect(merged.registers && merged.curates, 'classifier must FLAG a merged source').toBe(true);
    const regOnly = classify(`await (globalThis).${FIXTURE_MARKERS[0]}(pack);`);
    expect(regOnly.registers && !regOnly.curates, 'registration alone must classify clean').toBe(true);
    const curOnly = classify(`await ${CURATION_MARKERS[0]}page, 'x');`);
    expect(curOnly.curates && !curOnly.registers, 'curation alone must classify clean').toBe(true);

    // The gate proper — deny-by-default over every toybox spec that exists.
    const testsDir = dirname(fileURLToPath(import.meta.url));
    const offenders: string[] = [];
    for (const f of readdirSync(testsDir)) {
      if (!f.startsWith('toybox-') || !f.endsWith('.spec.ts')) continue;
      const c = classify(readFileSync(join(testsDir, f), 'utf8'));
      if (c.registers && c.curates) offenders.push(f);
    }
    expect(
      offenders,
      'these spec files BOTH register fixtures AND assert engine-curation properties — ' +
        'split them: fixture pools and real-content measurements must stay disjoint (#2070)',
    ).toEqual([]);
  });

  test('a fixture that fails to COMPILE is refused per-entry, loudly, and never registers', async ({ page }) => {
    // The seam's validation half: the hook must be unable to register a
    // broken fixture (the silently-black-layer class). Negative control of
    // the registration instrument.
    test.setTimeout(60_000);
    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');
    await expect
      .poll(() => page.evaluate(() => typeof (globalThis as unknown as FixtureG).__toyboxRegisterFixtureContent))
      .toBe('function');
    const broken = {
      id: 'e2e-fix-broken',
      label: 'E2E BROKEN',
      family: 'GEN',
      shadertoy: true,
      params: [],
      glsl: 'data:text/plain;charset=utf-8,' + encodeURIComponent('void mainImage(out vec4 c, in vec2 p) { c = THIS_DOES_NOT_COMPILE; }'),
    };
    const results = await page.evaluate(
      (b) => (globalThis as unknown as FixtureG).__toyboxRegisterFixtureContent!([b]),
      broken,
    );
    expect(results[0]!.ok, 'a non-compiling fixture must be refused').toBe(false);
    expect(results[0]!.errors.length, 'the refusal must carry compiler diagnostics').toBeGreaterThan(0);
  });
});
