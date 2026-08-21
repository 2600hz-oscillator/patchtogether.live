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

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import {
  FIX_FLAT,
  FIX_FRAG_INVERT,
  FIX_GRADIENT,
  FLAT_TOLERANCE,
  GRADIENT_TOLERANCE,
  TOYBOX_FIXTURE_PACK,
  expectedFade,
  toBytes,
  type Rgb01,
} from '../_fixtures/toybox-fixture-shaders';

type G = {
  __toyboxRegisterFixtureContent?: (
    entries: unknown[],
  ) => Promise<Array<{ id: string; ok: boolean; errors: unknown[] }>>;
  __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
  __ydoc: { transact: (fn: () => void) => void };
};

/** Spawn a lone TOYBOX and register the fixture pack through the harness
 *  hook. EVERY entry must validate through the real compile probe — a
 *  broken fixture fails here, per entry, with its compiler diagnostics. */
async function spawnWithFixtures(page: Page): Promise<void> {
  await page.goto('/rack?shell=legacy&seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'tb', type: 'toybox', position: { x: 420, y: 40 }, domain: 'video' }]);
  await page.locator('.svelte-flow__node-toybox').first().waitFor({ state: 'visible', timeout: 10_000 });
  await expect
    .poll(() => page.evaluate(() => typeof (globalThis as unknown as G).__toyboxRegisterFixtureContent), {
      message: '__toyboxRegisterFixtureContent hook must be installed (+layout, VITE_E2E_HOOKS build)',
    })
    .toBe('function');
  const results = await page.evaluate(
    (pack) => (globalThis as unknown as G).__toyboxRegisterFixtureContent!(pack),
    TOYBOX_FIXTURE_PACK as unknown as unknown[],
  );
  // Derived membership over the pack — iterate it, no counts.
  for (const fix of TOYBOX_FIXTURE_PACK) {
    const r = results.find((x) => x.id === fix.id);
    expect(r, `fixture ${fix.id} must be in the registration report`).toBeTruthy();
    expect(r!.ok, `fixture ${fix.id} must COMPILE (diagnostics: ${JSON.stringify(r!.errors)})`).toBe(true);
  }
}

/** Write layers + a combine graph in one transact (the toybox-video-inputs
 *  data-seed shape). */
async function seedPatch(
  page: Page,
  layers: Array<Record<string, unknown>>,
  combine: Record<string, unknown>,
): Promise<void> {
  await page.evaluate(
    ({ layers, combine }) => {
      const g = globalThis as unknown as G;
      g.__ydoc.transact(() => {
        const n = g.__patch.nodes['tb'];
        if (!n) return;
        if (!n.data) n.data = {};
        (n.data as Record<string, unknown>).layers = layers;
        (n.data as Record<string, unknown>).combine = combine;
      });
    },
    { layers, combine },
  );
}

const OFF = { kind: 'off', contentId: null, params: {} };
const SRC_NODES = [
  { id: 'src0', kind: 'source', layer: 0, x: 14, y: 14 },
  { id: 'src1', kind: 'source', layer: 1, x: 14, y: 66 },
  { id: 'src2', kind: 'source', layer: 2, x: 14, y: 118 },
  { id: 'src3', kind: 'source', layer: 3, x: 14, y: 170 },
];
const OUT_NODE = { id: 'out', kind: 'output', x: 286, y: 66 };

/** Pass layer `i` straight to OUT. */
const passThrough = (i: number) => ({
  nodes: [...SRC_NODES, OUT_NODE],
  edges: [{ id: 'e1', from: `src${i}`, to: 'out', toPort: 'in0' }],
});

/** Fold src0+src1 through one FADE at `amount` into OUT. */
const fadeGraph = (amount: number) => ({
  nodes: [...SRC_NODES, { id: 'op1', kind: 'fade', x: 120, y: 40, params: { amount } }, OUT_NODE],
  edges: [
    { id: 'e1', from: 'src0', to: 'op1', toPort: 'in0' },
    { id: 'e2', from: 'src1', to: 'op1', toPort: 'in1' },
    { id: 'e3', from: 'op1', to: 'out', toPort: 'in0' },
  ],
});

/**
 * Sample the preview canvas at PROPORTIONAL coords (fx, fy in 0..1, canvas
 * top-left origin), polled IN PAGE until the pixel is within `tol` of
 * `expected` (tolerates async GLSL fetch+compile), reporting the last pixel
 * seen WITH UNITS on failure. The canvas aspect equals the engine aspect
 * (CANVAS_H is derived from ENGINE_W/H), so proportional coords map straight
 * onto engine UV with no letterbox.
 */
async function expectPixel(
  page: Page,
  fx: number,
  fy: number,
  expected: Rgb01,
  tol: number,
  label: string,
): Promise<void> {
  const want = toBytes(expected);
  try {
    await page.waitForFunction(
      ({ fx, fy, want, tol }) => {
        const c = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement | null;
        if (!c) return false;
        const c2d = c.getContext('2d');
        if (!c2d) return false;
        const x = Math.min(c.width - 1, Math.round(fx * c.width));
        const y = Math.min(c.height - 1, Math.round(fy * c.height));
        const { data } = c2d.getImageData(x, y, 1, 1);
        const w = globalThis as unknown as { __fixPixel?: number[] };
        w.__fixPixel = [data[0]!, data[1]!, data[2]!];
        return (
          Math.abs(data[0]! - want[0]!) <= tol &&
          Math.abs(data[1]! - want[1]!) <= tol &&
          Math.abs(data[2]! - want[2]!) <= tol
        );
      },
      { fx, fy, want, tol },
      { timeout: 20_000 },
    );
  } catch (err) {
    const got = await page
      .evaluate(() => (globalThis as unknown as { __fixPixel?: number[] }).__fixPixel)
      .catch(() => undefined);
    throw new Error(
      `${label}: pixel at (${fx}, ${fy} of canvas) expected rgb(${want.join(',')}) ±${tol} ` +
        `but last saw rgb(${(got ?? []).join(',')}) — units: canvas bytes 0..255`,
      { cause: err },
    );
  }
}

async function waitFramesInPage(page: Page, n: number): Promise<void> {
  await page.evaluate(
    (n) =>
      new Promise<void>((r) => {
        let i = 0;
        const t = () => (++i >= n ? r() : requestAnimationFrame(t));
        requestAnimationFrame(t);
      }),
    n,
  );
}

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

  test('a fixture that fails to COMPILE is refused per-entry, loudly, and never registers', async ({ page }) => {
    // The seam's validation half: the hook must be unable to register a
    // broken fixture (the silently-black-layer class). Negative control of
    // the registration instrument.
    test.setTimeout(60_000);
    await page.goto('/rack?shell=legacy&seed=none');
    await page.waitForLoadState('networkidle');
    await expect
      .poll(() => page.evaluate(() => typeof (globalThis as unknown as G).__toyboxRegisterFixtureContent))
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
      (b) => (globalThis as unknown as G).__toyboxRegisterFixtureContent!([b]),
      broken,
    );
    expect(results[0]!.ok, 'a non-compiling fixture must be refused').toBe(false);
    expect(results[0]!.errors.length, 'the refusal must carry compiler diagnostics').toBeGreaterThan(0);
  });
});
