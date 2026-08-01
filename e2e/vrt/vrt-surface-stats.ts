// e2e/vrt/vrt-surface-stats.ts
//
// THE INSTRUMENT behind the VRT live-surface masks.
//
// A mask deletes pixel coverage. On its own that is the vacuous-assertion
// pattern this repo keeps re-producing: a scope that renders NOTHING AT ALL
// passes forever, because the only thing looking at it was the screenshot we
// just told Playwright to paint magenta. So every masked region owes a
// COMPANION assertion, and this file is what companions are made of.
//
// WHY PIXEL STATISTICS RATHER THAN A LOOSE SCREENSHOT
//
//   The masked surfaces are non-deterministic in PHASE, not in CONTENT: an
//   AnalyserNode-driven sine trace captured 4 ms later is the same trace at a
//   different x-offset. A loose-tolerance screenshot is the wrong instrument
//   for that — it is sensitive to exactly the axis that legitimately varies
//   (position) and blind to the axis under test (is anything drawn at all).
//   Statistics over the region — ink coverage, luminance spread, how many
//   distinct luminance levels are present — are INVARIANT to phase and still
//   collapse to a known value on a dead render. That is the property we want:
//   stable across runs, and provably failing when the surface goes blank.
//
//   (CLAUDE.md "VALIDATE THE INSTRUMENT": before believing a measurement, ask
//   what it is invariant to. These are invariant to trace phase and to a
//   global brightness shift of the background — and NOT invariant to "nothing
//   was rendered", which is the dimension under test.)
//
// HOW THE PIXELS ARE READ
//
//   `locator.screenshot()` → PNG bytes → decoded back INSIDE the page via an
//   <img> + a scratch 2D canvas → getImageData. The round-trip looks odd but
//   it is the only read that works uniformly across every surface class we
//   have:
//     * 2D canvases (scope / dockscope traces) — getContext('2d') would work,
//     * WebGL canvases — getContext('webgl2') readback returns a CLEARED
//       drawing buffer outside the render loop when preserveDrawingBuffer is
//       false (which is the default and what most of our video modules use),
//     * <video> elements and plain DOM text regions — no canvas context at all.
//   The composited screenshot is what the VRT diff would have seen, so it is
//   also the honest thing to measure: we assert about the same pixels the mask
//   removed, not about an internal buffer that may not match.
//
// NEGATIVE CONTROL (CLAUDE.md: "negative-control the instrument, not just the
// code"). `killSurface()` covers the region with an opaque flat div — pixel-
// identical to a surface that renders nothing — and the caller asserts BOTH
// that the statistics collapse AND that the companion rejects them. An
// assertion you cannot make fail is not evidence.

import type { Locator, Page } from '@playwright/test';

/** A pixel differing from the modal (background) luminance by at least this
 *  many 0-255 levels counts as "ink". 16/255 ≈ 6 % — comfortably above PNG
 *  round-trip / colour-management noise (which is ≤ 1 level in practice) and
 *  comfortably below any real trace-vs-background contrast we draw. */
export const INK_DELTA = 16;

/** A 16-level luminance bucket counts as "present" once it holds at least
 *  this fraction of the region's pixels. Filters out stray AA pixels so
 *  `distinctLumaBuckets` reports STRUCTURE, not dither. */
export const BUCKET_PRESENCE = 0.0025;

/** Statistics over one masked region. Every field is invariant to WHERE the
 *  content sits inside the region (phase / scroll / rotation) and sensitive to
 *  WHETHER there is content. */
export interface SurfaceStats {
  /** Captured region size, in DEVICE pixels (deviceScaleFactor is pinned to 1
   *  in vrt.config.ts, so these equal CSS px — the unit is stated because
   *  half the instrument bugs in this repo were unit confusions). */
  width: number;
  height: number;
  pixels: number;
  /** Mean luminance, 0-255 (Rec.709). */
  meanLuma: number;
  /** Population standard deviation of luminance, 0-127.5. EXACTLY 0 for any
   *  flat fill, whatever colour it is. */
  lumaStdDev: number;
  /** Fraction of pixels whose luminance is >= INK_DELTA away from the modal
   *  8-level luminance bucket — i.e. "how much of this region is not
   *  background". 0 for a flat fill. */
  inkFraction: number;
  /** How many of the 16 luminance buckets hold >= BUCKET_PRESENCE of the
   *  region. 1 for a flat fill; >= 2 needs genuine tonal structure. */
  distinctLumaBuckets: number;
  /** Mean per-pixel chroma (max channel - min channel), 0-255. 0 for any
   *  greyscale render — used only where COLOUR is the deleted coverage. */
  meanChroma: number;
}

/** A flat fill of any colour. The anti-vacuity guard evaluates every
 *  registered companion against this and requires REJECTION — a companion
 *  that accepts it is decoration. Exported so the unit-lane guard and the
 *  e2e negative control agree on what "dead" means. */
export const DEAD_RENDER_STATS: SurfaceStats = {
  width: 200,
  height: 80,
  pixels: 16_000,
  meanLuma: 0,
  lumaStdDev: 0,
  inkFraction: 0,
  distinctLumaBuckets: 1,
  meanChroma: 0,
};

/** A MID-GREY flat fill — the second dead render. A companion that only
 *  asserts `minMeanLuma` would pass a black-only test and still be blind to a
 *  grey wash, so the guard checks both. */
export const DEAD_RENDER_STATS_GREY: SurfaceStats = {
  ...DEAD_RENDER_STATS,
  meanLuma: 128,
};

/** The companion assertion for one masked surface: the coverage the mask
 *  deleted, restated as floors on the statistics above.
 *
 *  Every field is a FLOOR or a CEILING, never an equality — the whole point is
 *  to be insensitive to the phase drift that made the region non-deterministic
 *  while still failing on a blank render. */
export interface SurfaceCompanion {
  /** Minimum ink coverage (fraction of the region, 0-1). */
  minInkFraction?: number;
  /** Maximum ink coverage — catches a surface that blew out to full-white or
   *  to garbage. Optional; NEVER sufficient on its own (a flat fill has ink
   *  0, which satisfies any ceiling). */
  maxInkFraction?: number;
  /** Minimum luminance standard deviation (0-127.5). */
  minLumaStdDev?: number;
  /** Minimum count of populated 16-level luminance buckets (1-16). >= 2
   *  rejects every flat fill by construction. */
  minDistinctLumaBuckets?: number;
  /** Minimum mean chroma (0-255). Only for surfaces where COLOUR is the
   *  deleted coverage; a greyscale trace legitimately scores ~0. */
  minMeanChroma?: number;
  /** WHAT THESE NUMBERS MEAN: the measured live value and what a dead render
   *  scores. Required — a threshold with no stated derivation is a threshold
   *  nobody can re-derive when it goes red. Enforced (length) by the
   *  anti-vacuity guard. */
  rationale: string;
}

export interface CompanionVerdict {
  ok: boolean;
  /** Human-readable failures, one per violated floor. */
  failures: string[];
  /** Every floor that was checked, pass or fail — printed on failure so the
   *  next reader can see the measured value next to the bar. */
  checked: string[];
}

/** Pure predicate: does `stats` satisfy `companion`? Pure on purpose — the
 *  unit-lane anti-vacuity guard calls it against DEAD_RENDER_STATS with no
 *  browser in sight, which is what makes that guard zero-flake. */
export function evaluateCompanion(
  companion: SurfaceCompanion,
  stats: SurfaceStats,
): CompanionVerdict {
  const failures: string[] = [];
  const checked: string[] = [];

  const check = (
    label: string,
    bar: number | undefined,
    value: number,
    cmp: 'min' | 'max',
  ): void => {
    if (bar === undefined) return;
    const bad = cmp === 'min' ? value < bar : value > bar;
    const line = `${label}=${value.toFixed(5)} ${cmp === 'min' ? '>=' : '<='} ${bar}`;
    checked.push(`${bad ? 'FAIL' : 'ok  '} ${line}`);
    if (bad) failures.push(line);
  };

  check('inkFraction', companion.minInkFraction, stats.inkFraction, 'min');
  check('inkFraction', companion.maxInkFraction, stats.inkFraction, 'max');
  check('lumaStdDev', companion.minLumaStdDev, stats.lumaStdDev, 'min');
  check(
    'distinctLumaBuckets',
    companion.minDistinctLumaBuckets,
    stats.distinctLumaBuckets,
    'min',
  );
  check('meanChroma', companion.minMeanChroma, stats.meanChroma, 'min');

  return { ok: failures.length === 0, failures, checked };
}

/** Does this companion have at least one floor that a flat fill FAILS?
 *  The single rule the anti-vacuity guard exists to enforce. Kept here, next
 *  to `evaluateCompanion`, so the two can never drift. */
export function rejectsDeadRender(companion: SurfaceCompanion): boolean {
  return (
    !evaluateCompanion(companion, DEAD_RENDER_STATS).ok &&
    !evaluateCompanion(companion, DEAD_RENDER_STATS_GREY).ok
  );
}

/** In-page pixel reducer. Runs as a string in the browser (page.evaluate), so
 *  it must not close over anything from this module — the constants are
 *  passed in. */
async function reduceScreenshot(
  page: Page,
  base64: string,
  inkDelta: number,
  bucketPresence: number,
): Promise<SurfaceStats> {
  return page.evaluate(
    async ({ b64, delta, presence }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('vrt-surface-stats: no 2D context for the scratch canvas');
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, w, h);

      const n = w * h;
      const hist = new Float64Array(256);
      let sum = 0;
      let sumSq = 0;
      let chroma = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        sum += y;
        sumSq += y * y;
        hist[Math.min(255, Math.max(0, Math.round(y)))] += 1;
        chroma += Math.max(r, g, b) - Math.min(r, g, b);
      }
      const meanLuma = sum / n;
      const variance = Math.max(0, sumSq / n - meanLuma * meanLuma);

      // Modal 8-level bucket = the background. Ink = everything far from it.
      const coarse = new Float64Array(32);
      for (let y = 0; y < 256; y++) coarse[y >> 3] += hist[y];
      let modal = 0;
      for (let i = 1; i < 32; i++) if (coarse[i] > coarse[modal]) modal = i;
      const modalCentre = modal * 8 + 3.5;
      let ink = 0;
      for (let y = 0; y < 256; y++) {
        if (Math.abs(y - modalCentre) >= delta) ink += hist[y];
      }

      const fine = new Float64Array(16);
      for (let y = 0; y < 256; y++) fine[y >> 4] += hist[y];
      let distinct = 0;
      for (let i = 0; i < 16; i++) if (fine[i] >= n * presence) distinct += 1;

      return {
        width: w,
        height: h,
        pixels: n,
        meanLuma,
        lumaStdDev: Math.sqrt(variance),
        inkFraction: ink / n,
        distinctLumaBuckets: distinct,
        meanChroma: chroma / n,
      };
    },
    { b64: base64, delta: inkDelta, presence: bucketPresence },
  );
}

/** Screenshot one element and reduce it to `SurfaceStats`.
 *
 *  Throws with an actionable message when the region has no area — a 0x0
 *  surface IS a dead render, and saying so beats Playwright's generic
 *  "element is not visible". */
export async function readSurfaceStats(loc: Locator): Promise<SurfaceStats> {
  const box = await loc.boundingBox();
  if (!box || box.width < 1 || box.height < 1) {
    throw new Error(
      `vrt-surface-stats: region has no area (${box ? `${box.width}x${box.height}` : 'no box'} CSS px). ` +
        'A zero-area live surface renders nothing — either the selector is wrong or the surface is dead.',
    );
  }
  const png = await loc.screenshot({ animations: 'disabled', timeout: 15_000 });
  return reduceScreenshot(loc.page(), png.toString('base64'), INK_DELTA, BUCKET_PRESENCE);
}

/** Where two captures of the same region disagree. Used by the frame-stability
 *  probe to answer "WHICH element is still repainting?" — pass/fail lives
 *  elsewhere; this is a measurement. */
export interface RegionDiff {
  width: number;
  height: number;
  /** Pixels differing by >= `threshold` on any channel (0-255). */
  diffPixels: number;
  /** Bounding box of those pixels, or null when there are none. */
  box: { x0: number; y0: number; x1: number; y1: number } | null;
}

/**
 * Compare two PNG captures and report where they differ.
 *
 * Decoded IN THE PAGE via <img> + a scratch canvas, exactly like
 * `reduceScreenshot` above — deliberately NOT with a node-side PNG library.
 * The only one available here (`pngjs`) is an undeclared transitive of
 * Playwright's own dependency tree: it resolves today by hoisting luck and
 * would break the probe on any install that hoists differently. The browser
 * already has a PNG decoder and we are already driving it.
 */
export async function diffRegion(
  page: Page,
  aBase64: string,
  bBase64: string,
  threshold = 12,
): Promise<RegionDiff> {
  return page.evaluate(
    async ({ a, b, thr }) => {
      const decode = async (b64: string): Promise<ImageData> => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('vrt-surface-stats: no 2D context for the scratch canvas');
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, c.width, c.height);
      };
      const A = await decode(a);
      const B = await decode(b);
      if (A.width !== B.width || A.height !== B.height) {
        return { width: A.width, height: A.height, diffPixels: -1, box: null };
      }
      const W = A.width;
      const H = A.height;
      let n = 0;
      let x0 = W;
      let y0 = H;
      let x1 = -1;
      let y1 = -1;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const d = Math.max(
            Math.abs(A.data[i] - B.data[i]),
            Math.abs(A.data[i + 1] - B.data[i + 1]),
            Math.abs(A.data[i + 2] - B.data[i + 2]),
          );
          if (d < thr) continue;
          n++;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
      return {
        width: W,
        height: H,
        diffPixels: n,
        box: n === 0 ? null : { x0, y0, x1, y1 },
      };
    },
    { a: aBase64, b: bBase64, thr: threshold },
  );
}

/**
 * Force a surface DEAD, and return the undo.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE CONTROL IS `opacity: 0` ON THE ELEMENT ITSELF — not an overlay.
 *
 * The first version of this covered the region with an opaque BLACK `position:
 * fixed` div. That control had two defects, and both of them are the
 * "validate the INSTRUMENT" failure mode:
 *
 *   1. IT MODELLED THE WRONG DEAD RENDER. A canvas that never painted does not
 *      composite to black — it composites to whatever is BEHIND it, i.e. the
 *      card face. Asserting the companion rejects a BLACK rectangle proves
 *      nothing about whether it rejects the actual failure (a transparent
 *      canvas showing the card background through it), and a companion whose
 *      only floor is `minMeanChroma` or `minLumaStdDev` could plausibly pass
 *      the real failure while failing the black one.
 *
 *   2. IT LEAKED. `getBoundingClientRect()` returns FRACTIONAL coordinates
 *      under xyflow's viewport transform, so a `position:fixed` box laid out
 *      from them rounds to a different device pixel than the canvas does and
 *      left a LIVE FRINGE along the edges (scope measured ink=0.0103 /
 *      stdDev=4.10 with the surface "dead"). That was patched with a 3 px
 *      inflation — a fudge factor covering for the wrong mechanism.
 *
 * Setting `opacity: 0` on the element has neither problem: it is EXACTLY the
 * pixels an unpainted surface produces, it cannot be misaligned because it is
 * not a separate box, and it needs no magic number.
 *
 * ⚠ IT IS APPLIED AS A STYLESHEET RULE, NOT AS AN INLINE STYLE, and that
 * distinction is load-bearing. The first version set `el.style.opacity = 0`
 * inline. TIMELORDE's display canvas carries a REACTIVE inline style
 * (`style={`--wiz-pulse:${pulse}`}`), and when Svelte re-rendered it between
 * the kill and the read it rewrote the whole `style` attribute and silently
 * wiped the kill — measured live: two of three runs read
 * `dead{ink=0.0000 sd=0.00}` and the third read `dead{ink=0.5989 sd=63.22}`,
 * i.e. the LIVE surface, reported as the dead one. A negative control that
 * intermittently doesn't fire is worse than none: it makes a vacuous companion
 * look proven. A rule in an injected stylesheet, keyed off an attribute the
 * framework does not manage, survives any re-render of the element.
 *
 * The kill is then VERIFIED (computed opacity really is 0) before the caller
 * measures anything — so "the control didn't take effect" can never again be
 * mistaken for "the surface is alive".
 */
export async function killSurface(loc: Locator): Promise<() => Promise<void>> {
  const token = await loc.evaluate((el) => {
    const t = `vrt-dead-${Math.random().toString(36).slice(2)}`;
    el.setAttribute('data-vrt-dead', t);
    const style = document.createElement('style');
    style.id = `style-${t}`;
    style.textContent = `[data-vrt-dead="${t}"]{opacity:0 !important;}`;
    document.head.appendChild(style);
    return t;
  });
  const applied = await loc.evaluate((el) => getComputedStyle(el).opacity);
  if (applied !== '0') {
    throw new Error(
      'vrt-surface-stats: the NEGATIVE CONTROL did not take effect — computed opacity is ' +
        `"${applied}", expected "0". Every companion result measured after this point would ` +
        'be meaningless, so this throws rather than reporting a live surface as dead.',
    );
  }
  const page = loc.page();
  return async () => {
    await page.evaluate((t) => {
      document.getElementById(`style-${t}`)?.remove();
      document.querySelector(`[data-vrt-dead="${t}"]`)?.removeAttribute('data-vrt-dead');
    }, token);
  };
}
