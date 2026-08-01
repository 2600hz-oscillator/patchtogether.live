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

/** The `toHaveScreenshot` options a caller may still legitimately need.
 *
 *  `mask` and `maskColor` are deliberately ABSENT: masks come from the
 *  registry or not at all, and the anti-vacuity guard greps the specs to keep
 *  it that way. The tolerance knobs (`threshold` / `maxDiffPixelRatio` /
 *  `maxDiffPixels`) are absent for the same reason — a per-scene budget is a
 *  mask with extra steps, and it belongs in one reviewed place, not scattered
 *  across capture sites. */
export interface VrtScreenshotOptions {
  fullPage?: boolean;
  timeout?: number;
}

/** Resolve a registered surface against the right root. 'target' (default)
 *  scopes the selector INSIDE the element being screenshotted; 'page' scopes
 *  it to the document, for page-level composite captures where the live region
 *  sits outside the card (a footer readout, a floating picker). */
function resolve(surface: LiveSurface, page: Page, target: Locator | Page): Locator {
  const root = surface.scope === 'page' ? page : target;
  return root.locator(surface.selector);
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
  const loc = resolve(surface, page, target);
  // ONE ENTRY = ONE REGION = ONE COMPANION. This assertion is what makes the
  // masked set and the companioned set the SAME set: everything `loc` matches
  // is masked below, and everything `loc` matches is measured here. A selector
  // that has quietly started matching two elements fails HERE, rather than
  // silently masking a second region that nothing asserts.
  await expect(
    loc,
    `${sceneId}: live surface "${surface.selector}" must match EXACTLY ONE element — ` +
      'the mask hides it, so its presence (and that there is only one of it) is ' +
      'asserted here or nowhere. A card that grew a second matching element needs a ' +
      'narrowed selector plus its own registry entry + companion, not a wider mask.',
  ).toHaveCount(surface.expectCount);

  // ── C. COMPANION ────────────────────────────────────────────────────────
  const live = await readSurfaceStats(loc);
  const verdict = evaluateCompanion(surface.companion, live);

  // ── E. NEGATIVE CONTROL ────────────────────────────────────────────────
  // Force the surface to `opacity: 0` — pixel-identical to a surface that
  // rendered nothing, because that is literally what an unpainted canvas
  // composites to — and re-measure through the SAME read path.
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
  // second: if the kill didn't actually remove the content then "the companion
  // rejected it" proves nothing about dead renders.
  //
  // `killSurface` already threw if the computed opacity was not 0, so the
  // manipulation is known to have LANDED. What is checked here is that it had
  // the expected EFFECT on the pixels we read — the read path is a separate
  // mechanism from the DOM write and could return a stale or cached capture.
  //
  // The bar is INK, and only ink. `opacity: 0` reveals the CARD FACE behind
  // the surface, which is emphatically not flat — MEASURED backdrops range
  // from ink 0.0000 / sd 0.00 (timelorde) to ink 0.0242 / sd 9.59 (toybox,
  // whose backdrop scores 61 % of the LIVE stdDev). So a stdDev collapse bar
  // would assert something about each card's background rather than about the
  // surface, and would be red on toybox for no defect at all. Ink is the
  // statistic that actually separates them on every surface measured.
  expect(
    dead.inkFraction,
    `${sceneId}: NEGATIVE CONTROL is broken — "${surface.selector}" reads as INKED with the ` +
      'surface forced to opacity:0, so content survived the kill and the companion result ' +
      'below proves nothing. ' +
      `live ink=${live.inkFraction.toFixed(5)} → dead ink=${dead.inkFraction.toFixed(5)} ` +
      '(fraction of pixels off the modal background; expected well under half of live).',
  ).toBeLessThan(live.inkFraction * 0.5);
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
