// e2e/tests/_toybox-fixture-helpers.ts
//
// Shared Playwright-side helpers for the FIXTURE-registering toybox specs
// (#2070). ⚠ Importing `spawnWithFixtures` makes a spec a FIXTURE-REGISTERING
// spec: it mutates the randomize roll pools, so the disjointness gate in
// toybox-fixtures.spec.ts lists this helper's name among its markers — an
// importer is classified `registers` even though the raw hook name never
// appears in its source. Keep it that way: extracting a helper must never
// launder a marker out of the gate's sight.

import { expect, type Page } from '@playwright/test';
import { openToyboxDock, spawnPatch, TOYBOX_CANVAS_SEL } from './_helpers';
import { TOYBOX_FIXTURE_PACK, toBytes, type Rgb01 } from '../_fixtures/toybox-fixture-shaders';

export type FixtureG = {
  __toyboxRegisterFixtureContent?: (
    entries: unknown[],
  ) => Promise<Array<{ id: string; ok: boolean; errors: unknown[] }>>;
  __toyboxRoll?: (seed?: number) => Promise<{
    archetypeId: string;
    seed: number;
    blob: {
      layers: Array<Record<string, unknown>>;
      combine: {
        nodes: Array<{ id: string; kind: string; layer?: number; params?: Record<string, number> }>;
        edges: Array<{ from: string; to: string; toPort: string }>;
      };
      cvRoutes: Record<string, unknown>;
    };
  } | null>;
  __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
  __ydoc: { transact: (fn: () => void) => void };
};

/** Spawn a lone TOYBOX (id 'tb') on the DEFAULT shell, open its dock (the
 *  console — and with it the preview canvas — mounts there), and register the
 *  whole fixture pack through the harness hook, asserting every entry
 *  compiles. (`__toyboxRegisterFixtureContent` itself is layout-level, but the
 *  pixel gates these specs run need the console's canvas.) */
export async function spawnWithFixtures(page: Page): Promise<void> {
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'tb', type: 'toybox', position: { x: 420, y: 40 }, domain: 'video' }]);
  await openToyboxDock(page);
  await expect
    .poll(
      () => page.evaluate(() => typeof (globalThis as unknown as FixtureG).__toyboxRegisterFixtureContent),
      { message: '__toyboxRegisterFixtureContent hook must be installed (+layout, VITE_E2E_HOOKS build)' },
    )
    .toBe('function');
  const results = await page.evaluate(
    (pack) => (globalThis as unknown as FixtureG).__toyboxRegisterFixtureContent!(pack),
    TOYBOX_FIXTURE_PACK as unknown as unknown[],
  );
  for (const fix of TOYBOX_FIXTURE_PACK) {
    const r = results.find((x) => x.id === fix.id);
    expect(r, `fixture ${fix.id} must be in the registration report`).toBeTruthy();
    expect(r!.ok, `fixture ${fix.id} must COMPILE (diagnostics: ${JSON.stringify(r!.errors)})`).toBe(true);
  }
}

/** Write layers + a combine graph in one transact. */
export async function seedPatch(
  page: Page,
  layers: Array<Record<string, unknown>>,
  combine: Record<string, unknown>,
): Promise<void> {
  await page.evaluate(
    ({ layers, combine }) => {
      const g = globalThis as unknown as FixtureG;
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

export const OFF = { kind: 'off', contentId: null, params: {} };
export const SRC_NODES = [
  { id: 'src0', kind: 'source', layer: 0, x: 14, y: 14 },
  { id: 'src1', kind: 'source', layer: 1, x: 14, y: 66 },
  { id: 'src2', kind: 'source', layer: 2, x: 14, y: 118 },
  { id: 'src3', kind: 'source', layer: 3, x: 14, y: 170 },
];
export const OUT_NODE = { id: 'out', kind: 'output', x: 286, y: 66 };

/** Pass layer `i` straight to OUT. */
export const passThrough = (i: number) => ({
  nodes: [...SRC_NODES, OUT_NODE],
  edges: [{ id: 'e1', from: `src${i}`, to: 'out', toPort: 'in0' }],
});

/** Fold src0+src1 through one FADE at `amount` into OUT. */
export const fadeGraph = (amount: number) => ({
  nodes: [...SRC_NODES, { id: 'op1', kind: 'fade', x: 120, y: 40, params: { amount } }, OUT_NODE],
  edges: [
    { id: 'e1', from: 'src0', to: 'op1', toPort: 'in0' },
    { id: 'e2', from: 'src1', to: 'op1', toPort: 'in1' },
    { id: 'e3', from: 'op1', to: 'out', toPort: 'in0' },
  ],
});

/** Sample the preview canvas at PROPORTIONAL coords, polled in page until the
 *  pixel is within `tol` of `expected` (tolerates async compile), reporting
 *  the last pixel WITH UNITS on failure. */
export async function expectPixel(
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
      ({ fx, fy, want, tol, sel }) => {
        const c = document.querySelector(sel) as HTMLCanvasElement | null;
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
      { fx, fy, want, tol, sel: TOYBOX_CANVAS_SEL },
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

export async function waitFramesInPage(page: Page, n: number): Promise<void> {
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
