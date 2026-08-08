// e2e/vrt/_shell-faces.ts
//
// Shared scene machinery for the P1 CURATED FACES VRT (`workflow-shell-faces.
// spec.ts`) and its measurement probe (`vrt-fold-probe.spec.ts`).
//
// WHY A SHARED MODULE rather than a copy in each: the probe exists to explain
// the GATE's capture box. A probe that booted the scene even slightly
// differently would be measuring a different box, and the number it printed
// would be authoritative about nothing — the exact failure mode CLAUDE.md's
// "VALIDATE THE INSTRUMENT" section is about. One boot path, one fold reading,
// two consumers.
//
// (A `_`-prefixed file is not matched by vrt.config's testMatch, so nothing
// here registers tests. Importing a *.spec.ts from another spec WOULD register
// its tests twice, which is why the FACES roster lives here and not there.)

import { expect, type Locator, type Page } from '@playwright/test';
import { pinVrtFonts, awaitVrtFonts } from './_fonts';

/** The P1 migrated set (= STRICT_FACES). `pages` = the declared face.pages
 *  count the dock scene must render as labeled section bands — a per-scene
 *  structural gate that fails BEFORE the pixel pin if a page is dropped. */
export const FACES = [
  // batch 1
  { type: 'tidyVco', pages: 5 },
  { type: 'kickdrum', pages: 5 },
  { type: 'adsr', pages: 1 },
  { type: 'vca', pages: 1 },
  { type: 'lfo', pages: 1 },
  { type: 'cloudseed', pages: 8 },
  // batch 2 — the two pitched voices, the two drums, the two processors
  { type: 'dx7', pages: 4 },
  { type: 'sixstrum', pages: 5 },
  { type: 'snaredrum', pages: 5 },
  { type: 'tomtom', pages: 4 },
  { type: 'shimmershine', pages: 3 },
  { type: 'qbrt', pages: 2 },
  // batch 3 — the plucked-string voice + the four workhorse processors
  { type: 'karplus', pages: 2 },
  { type: 'filter', pages: 2 },
  { type: 'mixer', pages: 2 },
  // 2 → 1: `output blend` held a single knob and was a house template copied
  // across four defs; the three knobs are one idea and the band header now says
  // which of them sit inside the loop.
  { type: 'delay', pages: 1 },
  { type: 'reverb', pages: 2 },
  // batch B+ — the stereo crush
  { type: 'ringback', pages: 2 },
  // FACE BATCH 3 (2026-08-03) — the PF-20 wave. `pages` is the POST-hero-split
  // band count the dock renders, which is the declared `face.pages` length
  // unless a promotion empties a band (heroFacePlan drops an emptied band).
  { type: 'clap', pages: 4 },
  { type: 'drummergirl', pages: 2 },
  // ⚠ THE ONLY FACE IN THIS ROSTER WITH A MASKED REGION. analogVco is a
  // FREE-RUNNING oscillator, so the compact tile's live `scope` glyph is the
  // one glyph here that does NOT draw the flat centreline the header above
  // assumes — see VRT_LIVE_SURFACES['face-analogVco-compact'] for the measured
  // derivation and the companion that replaces the deleted coverage.
  { type: 'analogVco', pages: 2 },
  // ⚠ 8 bands trips DOCK_TAB_MIN_BANDS: this face renders as a TAB RAIL, by
  // design (five identical voice strips have no other shape). Do not merge it
  // back under seven.
  { type: 'pentemelodica', pages: 8 },
] as const;

/** TIGHT per-scene diff budgets (absolute pixels; Playwright takes the MIN of
 *  this and the config ratio budget).
 *
 *  ⚠ COMPACT_MAX_DIFF IS CURRENTLY INERT, and saying so is the point — a budget
 *  nobody has re-measured reads as protection it may not provide. MEASURED
 *  2026-08-08: a compact tile is 88×82 = 7216 px, and vrt.config's
 *  `maxDiffPixelRatio` was TIGHTENED from 0.05 to 0.01 on 2026-07-31, so the
 *  ratio now allows 72 px and is the binding term. 150 was chosen against the
 *  old 0.05 (~350 px) and has been the looser of the two ever since. It is kept
 *  because it is the DECLARED intent and it binds again on any tile over
 *  15 000 px, not because it is doing work today. The dock
 *  faceplate is a full-width element (1220 × 322…1003 now that it is captured
 *  unfolded): 1500 px matches the workflow-shell-zoom scene budget, and it stays
 *  the binding term because Playwright takes the MIN — the config's 0.01 ratio
 *  on even the smallest of these (1220×322) allows 3928 px. Unfolding therefore
 *  did NOT loosen the budget. */
export const COMPACT_MAX_DIFF = 150;
export const DOCK_MAX_DIFF = 1500;

// ── THE FOLD ────────────────────────────────────────────────────────────────
//
// The dock pane is `max-height: min(60vh, 680px)` — declared TWICE, on
// Canvas.svelte's `.dock-fullview-drawer` and on DockFullView's own
// `.dock-faceplate` — wrapped around `.faceplate-scroll` (`overflow: auto`). So
// the captured element's height is `min(content, min(60vh, 680px))`, and
// whatever the content has past that is SCROLLED — absent from the image.
//
// MEASURED (vrt-fold-probe, this worktree, CSS px, content = the
// `.faceplate-scroll` scrollHeight; capture = content + 72 px of pane chrome):
//
//   face           content   hidden @720   hidden at the 680 px cap
//                                          (i.e. at ANY viewport ≥ 1134 px,
//                                           where 60vh stops being the min)
//   drummergirl        930          578          330
//   kickdrum           852          500          252
//   tidyVco            711          359          111
//   sixstrum           681          329           81
//   dx7                679          327           79
//   snaredrum          595          243            0
//   clap               550          198            0
//   pentemelodica      517          165            0
//   filter             402           50            0
//   (the other 12       ≤328           0            0)
//
// So NINE of 21 dock baselines were truncated, which is exactly the nine PNGs
// committed at 425 px — the signature of a clamped capture rather than a
// measured one. THE SECOND COLUMN IS THE POINT: raising the viewport is NOT a
// fix, because `min()`'s other term is a hard 680 px, so five faces stay folded
// at ANY window height. The clamp has to come off for the scene to see the
// faceplate at all.
//
// `unfoldDockPane` takes it off. The capture then contains the whole faceplate
// — the SCROLLABLE CONTENT rather than the WINDOW — which is a deliberate
// choice: a VRT exists to notice that a layout changed, and content the user
// reaches by scrolling is still part of the layout. It costs nothing in
// fidelity because the faceplate's layout does not depend on the pane height
// (measured: `scrollbarW = 0` on every face — Chromium here paints OVERLAY
// scrollbars, so removing the overflow steals no width and the 12 already-
// unfolded faces render byte-identically).
//
// `FOLD_VIEWPORT` then only has to be TALL ENOUGH to hold the unfolded pane:
// the drawer is `position: absolute; bottom: 0`, so a pane taller than its
// container would extend above the viewport top and Playwright could not scroll
// it into view (the container does not scroll). 1400 px leaves ~300 px of
// headroom over today's tallest face (drummergirl, 1002 px of pane) and the
// dock test ASSERTS that headroom rather than assuming it.
export const FOLD_VIEWPORT = { width: 1280, height: 1400 } as const;
/** The viewport the scene used before the unfold — reproduces the 432 px clamp
 *  regime for the negative control, and the config default for every other
 *  scene in this file (the compact tile is pinned at 1280×720). */
export const LEGACY_FOLD_VIEWPORT = { width: 1280, height: 720 } as const;
/** The clamp the CSS resolved to at the legacy viewport: `min(60vh, 680px)` with
 *  60vh = 432 px. What the negative control re-applies. */
export const LEGACY_FOLD_CLAMP_PX = 432;
/** The capture height that clamp produced: 432 minus the pane's own 4 px
 *  padding and subpixel rounding. Every one of the nine truncated baselines is
 *  committed at exactly this height, which is how they were identified. */
export const LEGACY_FOLD_PX = 425;

/** The ONE managed style element the fold overrides live in, so the scene can
 *  toggle between regimes instead of accumulating `addStyleTag` layers. */
const FOLD_STYLE_ID = 'vrt-dock-fold';

/**
 * Take the `max-height: min(60vh, 680px)` clamp OFF the dock pane, so the
 * captured element is the whole faceplate rather than its top fold.
 *
 * Both declarations have to go — Canvas's `.dock-fullview-drawer` AND
 * DockFullView's `.dock-faceplate`. Overriding one leaves the other clamping,
 * which looks exactly like a fix and is not; that is why this asserts the
 * result (`hiddenY === 0`) at the call site rather than trusting the CSS.
 */
export async function unfoldDockPane(page: Page): Promise<void> {
  await setFoldStyle(
    page,
    '.dock-fullview-drawer,.dock-faceplate{max-height:none !important;}',
  );
}

/** Put a clamp BACK at `px`, reproducing the pre-fix capture box. Used by the
 *  negative control to demonstrate what the old scene could not see. */
export async function refoldDockPane(page: Page, px: number): Promise<void> {
  await setFoldStyle(
    page,
    `.dock-fullview-drawer,.dock-faceplate{max-height:${px}px !important;}`,
  );
}

async function setFoldStyle(page: Page, css: string): Promise<void> {
  await page.evaluate(
    ({ id, css }) => {
      let el = document.getElementById(id) as HTMLStyleElement | null;
      if (!el) {
        el = document.createElement('style');
        el.id = id;
        document.head.appendChild(el);
      }
      el.textContent = css;
    },
    { id: FOLD_STYLE_ID, css },
  );
  await settle(page);
}

/** Wait until the Canvas dev spawn/viewport hooks are registered. */
export async function waitForHooks(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __setSpawnFlowPos?: unknown;
        __spawnFromPalette?: unknown;
        __flow?: unknown;
      };
      return (
        typeof w.__setSpawnFlowPos === 'function' &&
        typeof w.__spawnFromPalette === 'function' &&
        !!w.__flow
      );
    },
    undefined,
    { timeout: 20_000 },
  );
}

/** Boot `?shell=1`, spawn `type` into lane 1 via the REAL palette-drop path,
 *  and return the member's node id. Also kills animation jitter + hides the
 *  floating flow chrome (the zoom-scene stability recipe). */
export async function bootWithFace(page: Page, type: string): Promise<string> {
  await pinVrtFonts(page);
  await page.goto('/rack?mode=workflow&shell=1');
  await page.waitForLoadState('networkidle');
  await awaitVrtFonts(page);
  await waitForHooks(page);

  await page.evaluate((t) => {
    const w = globalThis as unknown as {
      __setSpawnFlowPos: (p: { x: number; y: number }) => void;
      __spawnFromPalette: (t: string) => void;
    };
    // x=30 lands inside narrowed column 1's [0, SHELL_COLUMN_W) band.
    w.__setSpawnFlowPos({ x: 30, y: 40 });
    w.__spawnFromPalette(t);
  }, type);
  await page.waitForFunction(() => {
    const w = globalThis as unknown as {
      __patch?: { nodes: Record<string, { data?: { columns?: Record<string, string[]> } } | undefined> };
    };
    return (w.__patch?.nodes['pinned-mixmstrs']?.data?.columns?.['1'] ?? []).length === 1;
  });
  const memberId = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { columns?: Record<string, string[]> } } | undefined> };
    };
    return (w.__patch.nodes['pinned-mixmstrs']?.data?.columns?.['1'] ?? [])[0] ?? '';
  });
  expect(memberId, `${type}: the lane-1 member spawned`).not.toBe('');

  await page.addStyleTag({
    content:
      '.svelte-flow__minimap,.svelte-flow__controls,.svelte-flow__attribution,.minimap-toggle{display:none !important;}' +
      '*,*::before,*::after{animation:none !important;transition:none !important;}',
  });
  return memberId;
}

/** Center the viewport on the lane-1 member (members bottom-anchor toward the
 *  4320 lane baseline) at `zoom`, then wait for the LOD face tier to settle on
 *  the member's tile + two rAFs so the tier content swap lands. */
export async function frameMember(
  page: Page,
  memberId: string,
  zoom: number,
  tier: string,
): Promise<void> {
  await page.evaluate(
    ({ memberId, zoom }) => {
      const w = globalThis as unknown as {
        __flow: {
          getInternalNode: (id: string) => { internals?: { positionAbsolute?: { x: number; y: number } }; position?: { x: number; y: number }; measured?: { width?: number; height?: number } } | undefined;
          setViewport: (vp: { x: number; y: number; zoom: number }, o?: { duration?: number }) => void;
        };
      };
      const inode = w.__flow.getInternalNode(memberId);
      const x = inode?.internals?.positionAbsolute?.x ?? inode?.position?.x ?? 0;
      const y = inode?.internals?.positionAbsolute?.y ?? inode?.position?.y ?? 0;
      const cx = x + (inode?.measured?.width ?? 192) / 2;
      const cy = y + (inode?.measured?.height ?? 180) / 2;
      const pane = document.querySelector('.svelte-flow') as HTMLElement;
      const r = pane.getBoundingClientRect();
      w.__flow.setViewport({ x: r.width / 2 - cx * zoom, y: r.height / 2 - cy * zoom, zoom }, { duration: 0 });
    },
    { memberId, zoom },
  );
  await page.waitForFunction(
    ({ memberId, tier }) => {
      const el = document.querySelector(
        `.svelte-flow__node[data-id="${memberId}"] [data-testid="module-shell"]`,
      );
      return !!el && el.getAttribute('data-shell-tier') === tier;
    },
    { memberId, tier },
    { timeout: 10_000 },
  );
  await settle(page);
}

/** Click the member's jack-rail EXPAND affordance and wait for the dock
 *  full-view to mount at the 'dock' face tier with `pages` section bands. */
export async function openDock(page: Page, memberId: string, pages: number): Promise<Locator> {
  await page
    .locator(`.svelte-flow__node[data-id="${memberId}"] [data-testid="module-shell"]`)
    .getByTestId('shell-open-dock')
    .click();

  const faceplate = page.getByTestId('dock-full-view');
  await expect(faceplate).toBeVisible();
  // The migrated shell mounts at the 'dock' face tier with its curated
  // SECTION BANDS — one per declared face page.
  await expect(faceplate.locator('[data-testid="module-shell"][data-shell-tier="dock"]')).toBeVisible();
  await expect(faceplate.locator('[data-testid="face-page"]')).toHaveCount(pages);
  await settle(page);
  return faceplate;
}

/** Two rAFs — long enough for a tier/content swap to land and paint. */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

/** What the dock capture box can and cannot contain, in CSS px. */
export interface FoldGeometry {
  /** The captured element's own height — the PNG's height. CSS px. */
  captureH: number;
  /** `.faceplate-scroll` content extent vs the extent it can show. CSS px. */
  scrollH: number;
  clientH: number;
  scrollW: number;
  clientW: number;
  /** Content the capture CANNOT contain, per axis. CSS px, 0 = fully captured. */
  hiddenY: number;
  hiddenX: number;
  /** Vertical scrollbar width stolen from the content's layout width. CSS px. */
  scrollbarW: number;
  /** Per-band geometry, offsets relative to the captured element's top. */
  bands: Array<{ id: string; top: number; h: number; rendered: boolean }>;
  /** Bands the browser lays out with area (a tab rail hides the inactive ones). */
  renderedBands: number;
  /** Tab-rail chips, 0 when the face renders as one scrolling column. */
  tabs: number;
  /** The pane's top edge in viewport coords. NEGATIVE = the pane has grown off
   *  the top of the window and Playwright cannot scroll it into view, because
   *  the drawer is absolutely positioned in a non-scrolling container. This is
   *  the headroom the dock scene asserts. CSS px. */
  topY: number;
  viewportH: number;
}

/**
 * Measure the dock capture box. ONE implementation, read by the gate's scope
 * assertion and by the probe, so the two cannot disagree about what "below the
 * fold" means.
 *
 * ⚠ UNITS: CSS px throughout. The dock drawer is NOT inside xyflow's zoom
 * transform (it is an absolutely-positioned sibling of `.svelte-flow__viewport`
 * — see Canvas's `.dock-fullview-drawer`), so unlike `card-control-overflow`
 * these numbers need no zoom division and ARE the PNG's pixels at DPR 1.
 */
export async function readFoldGeometry(page: Page): Promise<FoldGeometry> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="dock-full-view"]') as HTMLElement | null;
    if (!el) throw new Error('_shell-faces: no [data-testid="dock-full-view"] mounted');
    const sc = el.querySelector('.faceplate-scroll') as HTMLElement | null;
    if (!sc) throw new Error('_shell-faces: the faceplate has no .faceplate-scroll container');
    const er = el.getBoundingClientRect();
    const scr = sc.getBoundingClientRect();
    const bands = Array.from(el.querySelectorAll('[data-testid="face-page"]')).map((node) => {
      const b = node as HTMLElement;
      const r = b.getBoundingClientRect();
      return {
        id: b.getAttribute('data-face-page') ?? b.id ?? '?',
        top: Math.round(r.top - er.top),
        h: Math.round(r.height),
        rendered: r.width > 0 && r.height > 0,
      };
    });
    return {
      captureH: Math.round(er.height),
      scrollH: sc.scrollHeight,
      clientH: sc.clientHeight,
      scrollW: sc.scrollWidth,
      clientW: sc.clientWidth,
      hiddenY: Math.max(0, sc.scrollHeight - sc.clientHeight),
      hiddenX: Math.max(0, sc.scrollWidth - sc.clientWidth),
      scrollbarW: Math.round(scr.width - sc.clientWidth),
      bands,
      renderedBands: bands.filter((b) => b.rendered).length,
      tabs: el.querySelectorAll('[data-face-tab]').length,
      topY: Math.round(er.top),
      viewportH: window.innerHeight,
    };
  });
}

/** The band whose BOTTOM sits lowest in the faceplate — the one a fold hides
 *  first, and therefore the one the negative control perturbs. Derived from the
 *  live layout, never hardcoded, so a renamed or re-packed band cannot leave the
 *  control quietly poking at nothing. */
export function lowestBand(g: FoldGeometry): { id: string; top: number; h: number } {
  const rendered = g.bands.filter((b) => b.rendered);
  if (rendered.length === 0) throw new Error('_shell-faces: the faceplate rendered no bands');
  return rendered.reduce((lo, b) => (b.top + b.h > lo.top + lo.h ? b : lo));
}

/** Shift one band sideways by `px`, a pure PAINT change (no reflow, so no other
 *  band moves and the pane's height is untouched). The negative control's
 *  perturbation: the smallest edit that is unambiguously confined to one band. */
export async function perturbBand(page: Page, bandId: string, px: number): Promise<void> {
  await setFoldStyle(
    page,
    '.dock-fullview-drawer,.dock-faceplate{max-height:none !important;}' +
      `[data-face-page="${bandId}"]{transform:translateX(${px}px) !important;}`,
  );
}

/** The perturbation under the OLD clamp — the pair that shows the pre-fix scene
 *  could not see it. `px` is the clamp height to restore. */
export async function perturbBandFolded(
  page: Page,
  bandId: string,
  px: number,
  clampPx: number,
): Promise<void> {
  await setFoldStyle(
    page,
    `.dock-fullview-drawer,.dock-faceplate{max-height:${clampPx}px !important;}` +
      `[data-face-page="${bandId}"]{transform:translateX(${px}px) !important;}`,
  );
}
