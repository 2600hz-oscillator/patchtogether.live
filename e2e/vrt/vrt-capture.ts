// e2e/vrt/vrt-capture.ts
//
// THE ONE CAPTURE SEAM for VRT scenes that carry a live surface.
//
// A VRT scene with a masked region is THREE assertions that must travel
// together, or the mask silently deletes coverage:
//
//   B. STRICT   — the card/faceplate with the live surfaces masked, at the
//                 tightened tolerance from vrt.config.ts. This is what catches
//                 primitive swaps, layout, labels and text.
//   C. COMPANION— the coverage the mask just deleted, restated as statistics
//                 over the masked region: content exists and is plausible.
//   E. NEGATIVE — the same companion, evaluated against a region that has been
//      CONTROL    forced dead. Proves the companion CAN fail. Runs on every
//                 run, in the same browser, on the same code path.
//
// Routing every masked capture through here is what makes the anti-vacuity
// guard enforceable: the guard greps the VRT specs for hand-rolled `mask:`
// arrays, so the only way to mask a region is to register it, and registering
// it obliges a companion.
//
// ORDER MATTERS. Companions and the negative control run BEFORE the strict
// screenshot:
//   * the negative control mutates the DOM (it covers the region with an
//     opaque div) and must be fully undone before any pixel is captured;
//   * if the strict comparison fails we still want the companion numbers in
//     the log, because "the trace moved" and "the trace vanished" are
//     different bugs and the ratio alone cannot tell them apart.

import { expect, type Locator, type Page } from '@playwright/test';
import {
  evaluateCompanion,
  killSurface,
  readSurfaceStats,
  type SurfaceStats,
} from './vrt-surface-stats';
import { liveSurfacesFor, type LiveSurface } from './vrt-live-surfaces';

/** Options accepted by `expect(...).toHaveScreenshot(...)` that a caller may
 *  still need (fullPage, clip, a longer timeout). `mask` and `maskColor` are
 *  deliberately NOT here — masks come from the registry or not at all. */
export interface VrtScreenshotOptions {
  fullPage?: boolean;
  timeout?: number;
  /** Extra CSS to hide before the capture. Chrome-hiding only — anything
   *  non-deterministic belongs in the registry with a companion. */
  omitBackground?: boolean;
}

function resolve(surface: LiveSurface, page: Page, target: Locator | Page): Locator {
  const root = surface.scope === 'page' ? page : target;
  return 'locator' in root
    ? (root as Locator | Page).locator(surface.selector)
    : page.locator(surface.selector);
}

/** One line per surface, greppable out of a run log:
 *    [vrt-companion] scene=scope surface=canvas live={...} dead={...}
 *  This is where the negative-control NUMBERS in the PR description come
 *  from — they are measured on every run, not typed in by hand. */
function logSurface(
  sceneId: string,
  surface: LiveSurface,
  live: SurfaceStats,
  dead: SurfaceStats,
): void {
  const fmt = (s: SurfaceStats): string =>
    `ink=${s.inkFraction.toFixed(4)} sd=${s.lumaStdDev.toFixed(2)} ` +
    `buckets=${s.distinctLumaBuckets} chroma=${s.meanChroma.toFixed(2)} ` +
    `${s.width}x${s.height}px`;
  // eslint-disable-next-line no-console
  console.log(
    `[vrt-companion] scene=${sceneId} surface="${surface.selector}" ` +
      `live{${fmt(live)}} dead{${fmt(dead)}}`,
  );
}

/**
 * Assert one masked surface: companion, then negative control.
 * Exported so a spec can assert a surface without taking a screenshot
 * (the frozen-render specs that include their canvas in the diff on purpose
 * still benefit from the "did it render anything" floor).
 */
export async function assertLiveSurface(
  sceneId: string,
  surface: LiveSurface,
  page: Page,
  target: Locator | Page,
): Promise<void> {
  const all = resolve(surface, page, target);
  if (surface.expectCount !== undefined) {
    await expect(
      all,
      `${sceneId}: live surface "${surface.selector}" element count — ` +
        'the mask hides these regions, so their PRESENCE is only asserted here',
    ).toHaveCount(surface.expectCount);
  }
  const loc = all.nth(surface.nth ?? 0);

  // ── C. COMPANION ────────────────────────────────────────────────────────
  const live = await readSurfaceStats(loc);
  const verdict = evaluateCompanion(surface.companion, live);

  // ── E. NEGATIVE CONTROL ────────────────────────────────────────────────
  // Cover the region with an opaque flat div — pixel-identical to a surface
  // that rendered nothing — and re-measure through the SAME read path.
  const restore = await killSurface(loc);
  let dead: SurfaceStats;
  try {
    dead = await readSurfaceStats(loc);
  } finally {
    await restore();
  }
  const deadVerdict = evaluateCompanion(surface.companion, dead);

  logSurface(sceneId, surface, live, dead);

  // Two-sided, in this order, because a failure of the FIRST invalidates the
  // second: if the kill didn't actually produce a flat region then "the
  // companion rejected it" proves nothing about dead renders.
  expect(
    dead.lumaStdDev,
    `${sceneId}: NEGATIVE CONTROL is broken — covering "${surface.selector}" with an ` +
      'opaque div did not produce a flat region, so the control proves nothing. ' +
      `Measured stdDev=${dead.lumaStdDev.toFixed(3)} luma-levels (expected ~0).`,
  ).toBeLessThan(1);
  expect(
    deadVerdict.ok,
    `${sceneId}: VACUOUS COMPANION — "${surface.selector}" masked, but the companion ` +
      'ACCEPTS a dead render, so the mask deleted the coverage outright. ' +
      `Checks against the dead region:\n  ${deadVerdict.checked.join('\n  ')}`,
  ).toBe(false);

  expect(
    verdict.ok,
    `${sceneId}: live surface "${surface.selector}" failed its companion — the region is ` +
      'masked out of the pixel diff, so this assertion is the ONLY thing standing ' +
      `between a blank render and a green test.\n  ${verdict.checked.join('\n  ')}\n` +
      `  why this region is masked: ${surface.why}`,
  ).toBe(true);
}

/**
 * Capture a VRT scene: run every registered companion + negative control,
 * then take the STRICT masked screenshot.
 *
 * A scene with no registry entry takes no mask and is strict everywhere —
 * that is the default and the intended common case.
 */
export async function expectVrtSceneScreenshot(args: {
  page: Page;
  /** Snapshot name WITHOUT `.png`. Doubles as the registry key. */
  sceneId: string;
  /** What is screenshotted: a card locator, or the page for composites. */
  target: Locator | Page;
  /**
   * THE RATCHETED ESCAPE HATCH — selectors from the pre-registry
   * `VRT_MODULE_MASKS` table, resolved against `target`. These have NO
   * companion: the region is deleted from the diff and nothing replaces it.
   * The only caller is vrt.spec.ts, and the count is capped by a shrinking
   * ceiling in packages/web/src/lib/ui/vrt-live-surfaces.test.ts. Do not add
   * new callers — register the surface instead.
   */
  legacyMaskSelectors?: string[];
  options?: VrtScreenshotOptions;
}): Promise<void> {
  const { page, sceneId, target, options } = args;
  const surfaces = liveSurfacesFor(sceneId);

  for (const surface of surfaces) {
    await assertLiveSurface(sceneId, surface, page, target);
  }

  const targetLocator = target as Locator;
  const mask = [
    ...surfaces.map((s) => resolve(s, page, target)),
    ...(args.legacyMaskSelectors ?? []).map((sel) => targetLocator.locator(sel)),
  ];
  await expect(targetLocator).toHaveScreenshot(`${sceneId}.png`, {
    mask,
    maskColor: '#ff00ff',
    ...options,
  });
}
