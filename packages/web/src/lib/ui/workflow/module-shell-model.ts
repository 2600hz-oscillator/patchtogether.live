// packages/web/src/lib/ui/workflow/module-shell-model.ts
//
// PURE display helpers for the RACKLINE <ModuleShell> + <ModuleShellPlaceholder>
// (P0.3b). Everything a shell/placeholder needs to paint its frame that can be
// computed WITHOUT the DOM or the live registry lives here, so it is
// unit-testable + zero-flake and the components stay thin.
//
// Two things it decides:
//   1. the module's SPINE / domain colour — per the owner decision there is NO
//      separate --spine-* token: a module's spine IS its cable-domain hue, so we
//      resolve it to a `var(--cable-<type>)` reference off the module's primary
//      port (falling back to its domain). The cable is the patch language; the
//      spine paints the same hue as a lane reading aid.
//   2. the LANE face TIER — the LOD engine ($lib/ui/canvas/lod) emits the same
//      four-tier union the curation ladder consumes ('mini'|'compact'|'full'|
//      'dock'), but the LANE never shows the 'dock' full faceplate: that opens in
//      the bottom dock. So in the lane the richest LOD band ('dock', z≥0.95)
//      renders the 'full' (full-in-lane) face; only the dock-full VIEW uses 'dock'.

import type { Tier } from '$lib/ui/canvas/lod';
import type { FaceTier } from './curated-face';
import type { ParamCellKind } from './shell-control-kind';

/**
 * The uniform RACKLINE lane-tile WIDTH (px) EVERY shell/placeholder tile renders
 * at under the `?shell=1` preview — the owner "same-size all modules HORIZONTALLY"
 * premise. The mock's exact 192px tile (ux-proposal-b.html:598 "uniform 192×180
 * tile"). Shared by the CSS (`_module-card.css` pins the tile `width` to
 * `var(--shell-tile-w)`) and by Canvas's `wcolCardWidthPx` short-circuit, so the
 * RESERVED column slot equals the RENDERED tile → the band-centering (card center
 * == channel-number center) stays exact. Mirrors the `--shell-tile-w` token
 * (tokens.css); a unit gate locks them together.
 *
 * NOTE the tile is CENTERED in the app's 765px (34hp) channel-column band, so it
 * sits with wide gutters rather than filling the lane the way the mock's narrow
 * 216px lane does — the column pitch is app-scale and shared with the persisted
 * video-zone spawn geometry, so narrowing it is a separate (non-preview-gated)
 * follow-up. Uniformity + the mock tile dimensions are what this pass locks. */
export const SHELL_TILE_W = 192;

/**
 * The RACKLINE lane-slot HEIGHT (px) — ONE FIXED height at EVERY LOD tier (the
 * owner zoom-reposition fix, roundup option (c)). The OUTER slot box never
 * changes with zoom: only the CONTENT INSIDE the tile varies per tier (mini =
 * name + glyph centred in the fixed box; compact = the body knob row; full = the
 * denser face). A per-tier box height made flush-stack Y positions cascade-shift
 * whenever the zoom crossed a tier boundary; a tier-invariant slot means the
 * flow POSITIONS are byte-identical at every zoom. Pinned to the compact/full
 * design height — the mock's 180px .mod/.plate tile (ux-proposal-b.html).
 * Shared by the CSS (`_module-card.css` pins the tile box to `--shell-tile-h`,
 * tier-invariant) and by Canvas's `wcolCardHeightPx` (returns this SAME constant
 * at every zoom under the preview, so the RESERVED lane slot == the rendered
 * tile and the baseline number badge caps every tile flush). Mirrors the
 * `--shell-tile-h` token (tokens.css); a unit gate locks CSS↔TS. */
export const SHELL_TILE_H_SLOT = 180;

/** Back-compat alias for the fixed slot height (historical `SHELL_TILE_H` name). */
export const SHELL_TILE_H = SHELL_TILE_H_SLOT;

/**
 * Flow-space Y inset (px) applied to a VIDEO-ZONE default tile's TOP under the
 * `?shell=1` preview so the whole tile sits INSIDE the darker video area instead
 * of straddling its top edge. The zone's dashed border + "VIDEO" label are drawn
 * AT `COLUMN_BASELINE_Y` (`videoAreaBand` y0 == the tile's un-inset top), so a
 * tile anchored flush at the baseline puts its top jack-rail on the dashed line
 * and collides with the lane-number badges just above it. Nudging the tile down
 * by this inset clears the label + border with room to spare (the fixed slot is
 * SHELL_TILE_H_SLOT = 180, and 48 + 180 << the 540px video area). Applied ONLY in
 * the Canvas render override under the preview — the pure `videoZoneSlotPos`
 * default (used by the persisted spawn geometry) is UNCHANGED, so preview-OFF is
 * byte-identical and no Y.Doc position moves. */
export const SHELL_VIDEO_ZONE_TILE_INSET_Y = 48;

/** The minimal def shape the shell/placeholder model reads. */
export interface ShellDefLike {
  domain?: string;
  inputs?: readonly { id: string; type: string }[];
  outputs?: readonly { id: string; type: string }[];
  /** The def's concise role string ('modulation' / 'effects' / 'sources' …) —
   *  every Audio/Video/MetaModuleDef carries one. */
  category?: string;
  /** The def's palette classification (top/sub) — the role-line fallback. */
  palette?: { top: string; sub: string };
  /** Upstream OSS credit for a ported DSP — surfaced in the dock faceplate
   *  footer (PF-17), exactly as the legacy card surfaced it. */
  ossAttribution?: { author: string };
}

/** The five signal DOMAINS the RACKLINE kit colours chrome by (spine, jack dots,
 *  faceplate accent). */
export type SignalDomain = 'audio' | 'cv' | 'gate' | 'video' | 'poly';

/** Map a live CABLE type to its signal DOMAIN class (the kit's .audio/.cv/.gate/
 *  .video/.poly setters). Secondary cable types fold into their parent domain
 *  (pitch→cv, keys→poly, image/mono-video→video). Unknown → audio. Pure. */
export function domainClassForCable(cable: string | undefined): SignalDomain {
  switch (cable) {
    case 'gate':
      return 'gate';
    case 'cv':
    case 'pitch':
      return 'cv';
    case 'polyPitchGate':
    case 'keys':
      return 'poly';
    case 'video':
    case 'image':
    case 'mono-video':
      return 'video';
    case 'audio':
    default:
      return 'audio';
  }
}

/** The module's signal DOMAIN class — derived from its primary cable type (the
 *  same hue its spine is painted). Consumed by DockFullView to add the kit
 *  domain setter class to the `.faceplate` root. Pure. */
export function domainClassForDef(def: ShellDefLike | undefined): SignalDomain {
  return domainClassForCable(cableTypeForDef(def));
}

/** Map a module DOMAIN to a representative cable type (used only when a module
 *  declares no ports). Meta/unknown domains fall back to audio's hue. */
function cableTypeForDomain(domain: string | undefined): string {
  switch (domain) {
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    default:
      return 'audio';
  }
}

/**
 * The module's PRIMARY cable type — the hue its spine is painted. Prefers the
 * first OUTPUT's cable type (what the module emits reads as its identity), then
 * the first INPUT, then the domain fallback. Pure.
 */
export function cableTypeForDef(def: ShellDefLike | undefined): string {
  const out = def?.outputs?.[0]?.type;
  if (out) return out;
  const inp = def?.inputs?.[0]?.type;
  if (inp) return inp;
  return cableTypeForDomain(def?.domain);
}

/** The CSS colour reference for a module's spine/domain chrome:
 *  `var(--cable-<primaryType>)`. Consumed as the `--spine`/`--domain` custom
 *  property on the shell + placeholder roots. */
export function spineCableVar(def: ShellDefLike | undefined): string {
  return `var(--cable-${cableTypeForDef(def)})`;
}

// ── LIVE VIDEO THUMBNAILS (the shell video-visibility fix) ──────────────────
//
// Under the shell preview every video-DOMAIN module's lane tile shows a LIVE
// ANIMATED THUMBNAIL of its actual output in the glyph slot — the same picture
// its legacy card's on-card preview loop shows — instead of the generic static
// wave glyph (which read as "fake" on a video module and left no video visible
// anywhere). The thumbnail REUSES the exact legacy preview seam: each tick it
// asks the engine to blit THIS node's surface FBO into the shared drawing
// buffer (`videoEngine.blitOutputToDrawingBuffer(nodeId)`) and drawImage()s the
// engine canvas into a small 2D thumb canvas — no WebGL in the component, so
// the shell stays OUT of the WebGL attest basis. See VideoTileThumb.svelte.

/**
 * True when a module def renders the LIVE VIDEO THUMBNAIL in its lane tile's
 * glyph slot: exactly the VIDEO-domain defs — the ones the VideoEngine
 * registers a per-node surface FBO for (VideoEngine.addNode rejects any other
 * domain), so blitOutputToDrawingBuffer has something real to show. An
 * AUDIO-domain module with video-family PORTS (synesthesia's cross-domain
 * a_video_in / mono-video rasters) has NO engine surface — blitting it would
 * show a stale/black well — so it keeps the static domain glyph. Pure.
 */
export function hasVideoSurface(def: ShellDefLike | undefined): boolean {
  return def?.domain === 'video';
}

/** Thumbnail render policy: a SMALL fixed-res 2D canvas (aspect-fit blit of the
 *  engine frame, engine is 1024×768 4:3 by default) at a THROTTLED fps. The
 *  legacy cards run their previews at full rAF over card-sized buffers; the
 *  lane tile is a ~170px-wide well, so quarter-ish res at 15fps reads
 *  identically and keeps 30+ tiles cheap. Visibility-gating (tap released when
 *  the tile is off-screen) lives in the component via IntersectionObserver;
 *  engine-side the blit's markWatched TTL (~1.5s) + the central card-visibility
 *  feed already decay unwatched chains (the synesthesia lazy-render lesson). */
export const VIDEO_THUMB_W = 160;
export const VIDEO_THUMB_H = 120;
export const VIDEO_THUMB_FPS = 15;

/** Aspect-fit `src` into `dst` (letterbox/pillarbox, centred) — the same fit
 *  rule every legacy video card's preview blit uses. Pure. */
export function thumbFitRect(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): { x: number; y: number; w: number; h: number } {
  const srcAspect = srcW > 0 && srcH > 0 ? srcW / srcH : 4 / 3;
  const dstAspect = dstW / dstH;
  if (dstAspect > srcAspect) {
    const h = dstH;
    const w = Math.round(h * srcAspect);
    return { x: Math.round((dstW - w) / 2), y: 0, w, h };
  }
  const w = dstW;
  const h = Math.round(w / srcAspect);
  return { x: 0, y: Math.round((dstH - h) / 2), w, h };
}

/**
 * The shell VIDEO-ZONE render-override X positions, PACKED left-to-right so a
 * LEGACY-rendered default (videoOut's real, freely-resizable card) gets its
 * ACTUAL width of room instead of one fixed tile slot. `widths` are the
 * rendered widths of the PRESENT video-zone defaults in spec order (a swapped
 * tile passes SHELL_TILE_W; legacy videoOut passes its live node.data.width);
 * `pitch` is the active shell column pitch — the inter-slot GAP is derived as
 * `pitch - SHELL_TILE_W` (24px at the 216 pitch), so an all-tile zone packs to
 * EXACTLY the historic fixed slots (originX + i*pitch, byte-identical), and a
 * resized videoOut simply pushes its neighbours right (pure render — nothing
 * persisted). Pure.
 */
export function videoZonePackedXs(originX: number, widths: readonly number[], pitch: number): number[] {
  const gap = pitch - SHELL_TILE_W;
  const xs: number[] = [];
  let x = originX;
  for (const w of widths) {
    xs.push(x);
    x += w + gap;
  }
  return xs;
}

/**
 * The FaceTier a module shows in its LANE for a given LOD tier. Identity for
 * mini/compact/full; the richest LOD band 'dock' collapses to 'full' in the lane
 * (the true 'dock' full faceplate is a separate VIEW rendered in the bottom
 * dock, never in the lane). Pure.
 */
export function laneFaceTier(tier: Tier): FaceTier {
  return tier === 'dock' ? 'full' : tier;
}

/** True when the shell should offer an "Expand · full view" affordance at this
 *  LOD tier — always in-lane (the dock faceplate is reachable at every tier);
 *  kept as a named predicate so the policy has one home if it tightens. */
export function offersFullView(_tier: Tier): boolean {
  return true;
}

/**
 * The MIGRATED tile's header ROLE line — what the badge row says instead of
 * repeating the type (the name row already identifies the module; "VCA / vca"
 * was redundant). Uses the def's own concise metadata, no new field: the
 * `category` role string ('modulation', 'effects', 'sources', 'utilities' …),
 * falling back to the palette sub-category ('Utility', 'VCOs', …). Returns
 * undefined for a def with neither — the caller keeps its current fallback
 * (the type). The un-migrated placeholder is NOT routed through this: it keeps
 * showing the raw type. Pure.
 */
export function roleLineForDef(def: ShellDefLike | undefined): string | undefined {
  const category = def?.category?.trim();
  if (category) return category;
  const sub = def?.palette?.sub?.trim();
  if (sub) return sub;
  return undefined;
}

// ── The LANE BODY PLAN — the no-clip guarantee ──────────────────────────────
//
// The RACKLINE lane tile is a FIXED 192×180 box (zoom no-op invariant), so how
// many WHOLE control cells fit is a design-time constant, not a runtime
// measurement. The plan renders ONLY whole cells — a ranked control (or the
// glyph) that cannot fit entirely inside the tile is simply not rendered
// in-lane (the dock faceplate always shows everything). Derivation, from the
// tile vocabulary (_rackline-tile.css):
//
//   body inner width = 192 − 11 (left pad) − 9 (right pad) = 172px
//   ROW  (mini/compact + small full faces): md knob columns capped at 46px
//     (--kcol-max), 9px gaps, glyph min 40px (the mock .tile-scope floor):
//       with glyph: n·46 + n·9 + 40 ≤ 172 → n ≤ 2  (glyph then FILLS the rest)
//       no glyph:   n·46 + (n−1)·9 ≤ 172 → n ≤ 3
//   PLATE (the 'full' tier when the row can't hold the face): the mock full
//     'plate' 3-col grid of sm knob cells, 42px rows (26 knob + 5 gap + 11
//     label), 4px row gaps in a ~112px body → 2 whole rows = 6 cells max; the
//     full-width glyph strip renders only when a whole 42px strip still fits
//     (i.e. the cells needed ≤ one row).
//
// ⚠ THE PLATE'S ROW HEIGHT IS A PROPERTY OF THE CELL KIND, NOT A CONSTANT
// (2026-08-11, marbles). Every number above assumes the plate's cell is a SMALL
// KNOB COLUMN — 42px — and for six months every cell was. `fader` (#1464) is
// 96px, and `grid-auto-rows: 42px` + `align-items: start` does not clip an
// over-tall cell: it PAINTS IT OVER THE ROW BELOW. marbles' full-tier tile
// measured THREE overlaps of exactly 50.0 CSS px (96 − 46 row pitch) — row 1's
// faders across row 2's, so every column showed TWO THUMBS, row 1's labels were
// covered, and column 3's `t_model` grid chip floated on top of the T BIAS
// fader. See `laneCellHeight`.
//
// This is the HEIGHT twin of `cellWidthClass` in dock-row-plan.ts, and it is
// the same bug: a planner and a renderer disagreeing about how big a cell kind
// is. The dock row planner learned WIDTH; the lane body planner never learned
// HEIGHT. Both now read the cell KIND rather than assuming one.
export const LANE_ROW_MAX_CELLS_WITH_GLYPH = 2;
export const LANE_ROW_MAX_CELLS = 3;
export const PLATE_COLS = 3;

/** The plate's DESIGN cell height (px): a small knob column — 26px knob + 5px
 *  gap + 11px label. Mirrors `--plate-row-h` in _rackline-tile.css. */
export const PLATE_ROW_H = 42;
/** The plate grid's row gap (px). Mirrors `.tile-body.plate { gap: 4px 6px }`. */
export const PLATE_GAP_Y = 4;
/**
 * The lane tile's BODY height (px) — what the 180px tile leaves between the
 * header and the jack rail. The design figure the plate was derived against
 * ("a ~112px body", above); MEASURED at 113.5 CSS px in Chromium, so this is
 * the conservative side and never over-provisions a row.
 */
export const LANE_BODY_H = 112;

/**
 * How tall each param cell kind renders in a LANE tile, in CSS px.
 *
 * ⚠ EXHAUSTIVE OVER `ParamCellKind` BY TYPE. `Record<ParamCellKind, number>`
 * makes a NEW cell kind a COMPILE error here rather than a silent default —
 * which is the whole point: `fader` reached production because every layout
 * path had a default for a kind it had never been taught, and a default is
 * indistinguishable from an answer. There is deliberately no fallback arm.
 *
 * Everything that paints inside a small knob column is `PLATE_ROW_H` — that IS
 * the design cell. `fader` is the outlier: `NeonFader` is an 80px slot plus a
 * 5px gap plus a 9px label (MEASURED after #1794: the cell's border box is
 * **94.0 CSS px**), i.e. 2.2 plate rows.
 *
 * ⚠ THE CONSTANT IS 96, NOT 94, AND THAT IS DELIBERATE. It was measured at 96.0
 * against the control this replaced (an 80px track + 4px gap + a 12px label)
 * and is a RESERVATION the plate's row arithmetic divides by, so it is checked
 * as a CEILING with a floor — never as equality — in
 * `e2e/tests/faceplate-platform.spec.ts`. Over-reserving by 2px is safe;
 * under-reserving is a cell overlap. Lowering it to 94 would buy nothing and
 * would remove the headroom the font-dependence of the label line box needs.
 */
export const LANE_CELL_H: Record<ParamCellKind, number> = {
  knob: PLATE_ROW_H,
  momentary: PLATE_ROW_H,
  toggle: PLATE_ROW_H,
  segmented: PLATE_ROW_H,
  selector: PLATE_ROW_H,
  grid: PLATE_ROW_H,
  color: PLATE_ROW_H,
  // The throw plus its 9px persistent readout line at the dock tier. The
  // readout occupies the hover tag's space rather than adding to it, which is
  // why one budget covers both tiers. (#1794 folded the transitional
  // `neon-fader` entry into this one — it carried the identical 96.)
  fader: 96,
  // A SQUARE pad plus its two-axis readout. Carried at its real height even
  // though `laneOrder` makes an xy cell DOCK-ONLY today, so the number is
  // already right if that ever changes — an entry that lied "42" would be a
  // trap set for the person who lifts the restriction, which is precisely how
  // `fader` shipped with the wrong width class.
  xy: 96,
};

/** The rendered lane height (px) of one param cell kind. */
export function laneCellHeight(kind: ParamCellKind): number {
  return LANE_CELL_H[kind];
}

/**
 * A KNOB COLUMN THAT ALSO PAINTS AN EARNED READOUT LINE (px).
 *
 * ⚠ THE ONE CELL HEIGHT `LANE_CELL_H` STRUCTURALLY CANNOT HOLD, which is why it
 * sits beside the table rather than in it. That Record is keyed by
 * `ParamCellKind`; THIS height is a property of the PARAM. `KnobConic` paints a
 * readout whenever the param declares a vocabulary (`options` / `landmarks` /
 * `format` — `knobReadout`'s gate), so two cells of the identical kind 'knob',
 * side by side in one plate, are 42 px and 57 px.
 *
 * MEASURED 2026-08-12 on adsr's full-tier plate: 55.0 CSS px in the app's own
 * font stack; 57 under the VRT scenes' PINNED webfonts (the 9 px readout line
 * box becomes 10 and the 11 px label 12) — the same environment spread
 * `LANE_CELL_H.fader` records at 96 vs 94. The CEILING is taken, for the same
 * reason: over-reserving costs a few px of airiness, under-reserving is a cell
 * painting over the row below.
 */
export const LANE_KNOB_READOUT_H = 57;

/** The vertical room the plate has for rows, gap included (px) — a row costs
 *  `h + PLATE_GAP_Y` and the last row's gap is not paid, so the budget carries
 *  one spare gap. */
const PLATE_AVAIL_H = LANE_BODY_H + PLATE_GAP_Y;

/**
 * How many WHOLE rows of `cellH`-tall cells the plate can show. At the design
 * cell (42px) this is 2 — i.e. it REPRODUCES the `PLATE_MAX_ROWS = 2` it
 * replaced, which is the check that the arithmetic is the one the constant was
 * hand-derived from. At a 96px fader cell it is 1. Never 0: a tile that renders
 * nothing is worse than one over-tall cell, and `laneBodyPlan` still caps the
 * COUNT so nothing is painted outside the body.
 */
export function plateRowsFor(cellH: number): number {
  return Math.max(1, Math.floor(PLATE_AVAIL_H / (cellH + PLATE_GAP_Y)));
}

/** Whole rows of the DESIGN cell — the historic `PLATE_MAX_ROWS`, now derived
 *  rather than typed. */
export const PLATE_MAX_ROWS = plateRowsFor(PLATE_ROW_H);

/** Does a full-width glyph strip (one design row) still fit BELOW `rows` rows
 *  of `cellH` cells? At 1 row of 42px: 46 + 42 = 88 ≤ 116 → yes. At 2 rows:
 *  92 + 42 = 134 > 116 → no. Exactly the `rows <= 1` rule it replaces, and it
 *  additionally refuses the strip under a row of 96px faders (100 + 42 = 142). */
export function plateGlyphFits(rows: number, cellH: number): boolean {
  return rows * (cellH + PLATE_GAP_Y) + PLATE_ROW_H <= PLATE_AVAIL_H;
}

// ── PER-ROW TRACKS: only a cell with a LOWER NEIGHBOUR can paint over one ────
//
// ⚠ THE PLATE'S TRACK IS A PROPERTY OF A ROW, NOT OF THE FACE, and answering
// both with one number is what produced the adsr overlap. `grid-auto-rows` sets
// ONE size for every row; `align-items: start` means a cell taller than its
// track is NOT clipped — it paints over whatever is beneath it. So a single
// per-face track has to be tall enough for the tallest cell ANYWHERE, and
// `plateRowsFor` then divides the body by that inflated number and evicts rows
// that had nothing wrong with them.
//
// MEASURED 2026-08-12 over all 32 migrated faces at the full lane tier, with a
// TWO-AXIS overlap test (x AND y). ⚠ Use both axes: a y-only test reports every
// same-row sibling as overlapping and gives 11 faces. The truth is:
//
//     7 faces overlap, EVERY ONE of them by exactly 9.0 CSS px
//       (adsr, cloudseed, delay, kickdrum, lfo, macrooscillator, ringback)
//     32 readout-bearing cells across 11 faces
//     4 of those 11 have NOTHING BENEATH the tall cell and collide with nothing
//       (cofefve, filter, resofilter, tidyVco)
//
// "All exactly 9.0" is the tell that this is structural, not per-module: 9.0 =
// 55 (the rendered readout cell) − 46 (the 42 px track + 4 px gap row pitch).
// One mechanism, seven instances — so the fix belongs in the pitch, not in a
// per-face exception.
//
// The rule this file now implements: A ROW IS AS TALL AS ITS OWN TALLEST CELL,
// and rows are admitted while they still fit the body. A tall cell in the LAST
// row costs nothing (nothing is beneath it); a tall cell anywhere else pushes
// only the rows BELOW it down, instead of shrinking the whole plate.
/**
 * The plate's per-ROW track heights (px), in row order, for `cellHeights` laid
 * out 3-across — admitting rows while the running total still fits the body.
 *
 * Never empty: a tile that renders nothing is worse than one over-tall row, and
 * `laneBodyPlan` caps the CELL COUNT to what these rows hold, so nothing is
 * painted outside the body either way.
 */
export function plateRowTracks(cellHeights: readonly number[]): number[] {
  const rows: number[] = [];
  let used = 0;
  for (let i = 0; i < cellHeights.length; i += PLATE_COLS) {
    const h = Math.max(PLATE_ROW_H, ...cellHeights.slice(i, i + PLATE_COLS));
    const cost = (rows.length ? PLATE_GAP_Y : 0) + h;
    if (rows.length && used + cost > LANE_BODY_H) break;
    used += cost;
    rows.push(h);
  }
  return rows.length ? rows : [Math.max(PLATE_ROW_H, cellHeights[0] ?? PLATE_ROW_H)];
}

/** The stacked height of `rows` tracks including the gaps between them (px). */
export function plateRowsHeight(rows: readonly number[]): number {
  if (!rows.length) return 0;
  return rows.reduce((a, b) => a + b, 0) + (rows.length - 1) * PLATE_GAP_Y;
}

/**
 * Does a full-width glyph strip still fit BELOW these per-row tracks? Same
 * question `plateGlyphFits` asks, against the real row heights rather than one
 * assumed cell.
 *
 * ⚠ AND IT REFUSES OUTRIGHT ON A TALLER-THAN-DESIGN ROW, which is a deliberate
 * conservatism rather than arithmetic. The STRIP's own height is modelled here
 * as one design row, and that model is WRONG: measured 2026-08-12 at the full
 * lane tier, a live scope strip renders **84 CSS px** (delay, reverb, cloudseed)
 * where others render 40 (adsr, kickdrum, lfo, ringback). The 42 px budget has
 * only ever been calibrated against design-height rows, where two rows already
 * exclude the strip and a single row leaves enough slack that the error was
 * invisible.
 *
 * Per-row tracks would otherwise hand a strip to every plate that shrank to one
 * TALL row — and measured, that newly gives cloudseed an 84 px scope in ~12 px
 * of remaining room. Trading a 9 px overlap for a picture sliced to a seventh of
 * itself is not a fix. So: design rows keep the behaviour they have had since
 * the plate shipped; a tall row refuses the strip until the strip's real height
 * is modelled per glyph kind. That is the named follow-up, with its numbers.
 */
export function plateGlyphFitsRows(rows: readonly number[]): boolean {
  if (rows.some((h) => h > PLATE_ROW_H)) return false;
  return plateRowsHeight(rows) + PLATE_GAP_Y + PLATE_ROW_H <= LANE_BODY_H;
}

// ── The DOCK HERO GLYPH width — owner P1 batch-1 feedback ───────────────────
//
// The dock faceplate's hero glyph must NOT span the full faceplate width: it
// spans roughly the FIRST FOUR KNOB COLUMNS of the control grid, leaving blank
// space to its right (the gallery-mock proportion). Derived from the shared
// knob-column vocabulary so the cap stays aligned to the grid the section
// bands lay out below it.
/** Knob columns the dock hero glyph spans. */
export const DOCK_HERO_GLYPH_COLS = 4;
/** The knob-column design width (px) — mirrors --kcol-max / laneBodyPlan's
 *  46px fit constant (_rackline-tile.css). */
export const DOCK_KCOL_W = 46;
/** The dock page-controls column gap (px) — mirrors `.page-controls` gap. */
export const DOCK_PAGE_GAP_X = 10;
/** The dock hero glyph width cap (px): 4 knob columns + the 3 gaps between
 *  them = 214. Applied by ModuleShell as `--dock-hero-glyph-w`. */
export const DOCK_HERO_GLYPH_W =
  DOCK_HERO_GLYPH_COLS * DOCK_KCOL_W + (DOCK_HERO_GLYPH_COLS - 1) * DOCK_PAGE_GAP_X;

export interface LaneBodyPlan {
  /** 'row' = the mock .mod inline body; 'plate' = the full-tier 3-col grid. */
  layout: 'row' | 'plate';
  /** How many ranked controls render in-lane (a prefix of the curated list). */
  cellCount: number;
  /** Whether the glyph renders in-lane at this tier. */
  glyph: boolean;
  /** Knob size for the rendered cells (mini's lg override stays a view concern). */
  knobSize: 'sm' | 'md';
  /**
   * The plate's PER-ROW grid track heights (px), row order — what ModuleShell
   * writes to `grid-template-rows`. Empty for the ROW layout.
   *
   * ⚠ A LIST, NOT A NUMBER, AND THAT IS THE FIX. The CSS cannot derive it:
   * `grid-auto-rows` is one fixed track for every row and `align-items: start`
   * means a cell taller than its track paints OVER the row below instead of
   * being clipped. One number per PLATE forces the whole grid to the tallest
   * cell anywhere in it and then evicts rows to pay for it; one number per ROW
   * costs only the rows that actually contain a tall cell.
   */
  rowTracks: number[];
}

/**
 * The lane body plan for a curated face: which layout, how many WHOLE cells,
 * and whether the glyph fits.
 *
 * `cells` is ONE HEIGHT PER RANKED CONTROL, in rank order. That is the point:
 * the plate lays cells out 3-across, so WHICH row a tall cell lands in decides
 * whether it can paint over anything, and a single number cannot express that.
 *
 * For convenience it also accepts the historic form — a COUNT, with an optional
 * uniform `uniformCellH` — which means "this many cells, all this tall". Same
 * answers as before for every caller that has only same-height cells; the list
 * form is the one the shell uses. `hasGlyph` = face.glyph !== 'none'. Pure —
 * geometry constants only, so the guarantee is unit-testable. The 'dock' tier
 * never reaches this (the dock faceplate renders pages / wraps freely).
 */
export function laneBodyPlan(
  cells: number | readonly number[],
  hasGlyph: boolean,
  tier: FaceTier,
  uniformCellH: number = PLATE_ROW_H,
): LaneBodyPlan {
  // The historic form — a COUNT of cells that are all the same height — is kept
  // because it is what most callers mean and it is exactly what this function
  // used to take. It is synthesized into the list form so there is ONE code
  // path below. Capped at what a plate can ever hold: callers legitimately pass
  // "more controls than could possibly fit" (the old `faceTierCap` passed
  // MAX_SAFE_INTEGER), and every branch below treats any count ≥ 6 alike.
  const cellHeights =
    typeof cells === 'number'
      ? (Array<number>(Math.max(0, Math.min(cells, PLATE_COLS * PLATE_MAX_ROWS))).fill(
          uniformCellH,
        ) as readonly number[])
      : cells;
  const controlCount = typeof cells === 'number' ? cells : cells.length;
  const rowMax = hasGlyph ? LANE_ROW_MAX_CELLS_WITH_GLYPH : LANE_ROW_MAX_CELLS;
  if (tier === 'mini') {
    return {
      layout: 'row',
      cellCount: Math.min(controlCount, 1),
      glyph: hasGlyph,
      knobSize: 'md',
      rowTracks: [],
    };
  }
  if (tier === 'compact' || controlCount <= rowMax) {
    // The design-point row: whole md cells + the glyph filling the remainder.
    // The ROW layout lays its cells side by side, so a tall cell costs height
    // once, not once per row — a 96px fader clears the 112px body with room to
    // spare, which is why the compact tile was correct while the plate was not.
    return {
      layout: 'row',
      cellCount: Math.min(controlCount, rowMax),
      glyph: hasGlyph,
      knobSize: 'md',
      rowTracks: [],
    };
  }
  // 'full' with a face too big for the row → the 3-col plate grid, whole rows
  // only. Ranked controls outrank the glyph: the strip renders only when a
  // whole strip-row still fits UNDER the cell rows.
  //
  // ⚠ `plateRowTracks` is the no-clip guarantee actually being kept, and it
  // replaced TWO wrong answers in a row. First the constant 2 — correct for a
  // 42px cell and a lie for any other, failing as OVERLAP rather than
  // truncation, so it did not even look like a fit bug. Then `plateRowsFor`,
  // one track for the whole plate — which fixes the overlap by evicting rows,
  // and evicts them from faces whose tall cell was in the LAST row and could
  // never have overlapped anything (measured: 4 of the 11 readout-bearing
  // faces). Per-row tracks charge the height to the row that incurs it.
  const rowTracks = plateRowTracks(cellHeights);
  const cellCount = Math.min(controlCount, PLATE_COLS * rowTracks.length);
  const usedTracks = rowTracks.slice(0, Math.ceil(cellCount / PLATE_COLS));
  return {
    layout: 'plate',
    cellCount,
    glyph: hasGlyph && plateGlyphFitsRows(usedTracks),
    knobSize: 'sm',
    rowTracks: usedTracks,
  };
}

// ── THE SHELL VIEW UNION ────────────────────────────────────────────────────
//
// WHICH SURFACE is a `<ModuleShell>` mounted on. Three members, and the third
// is the whole of #1739:
//
//   * 'lane'      — the 192×180 workflow lane tile: a tier-CURATED subset of the
//                   controls plus the `PatchPanel` lane rail.
//   * 'dock-full' — a `DockFullView` pane: the full faceplate (every control,
//                   every page) and NO `PatchPanel`, because that host owns a
//                   better patch surface — the flip-to-`RearCard` jack field on
//                   its own title bar.
//   * 'drawer'    — a `DockCardHost` rail card, i.e. the pinned `m`/`e` tray:
//                   the full faceplate AND the `PatchPanel` lane rail. That
//                   combination exists for exactly one reason — the tray host
//                   has NO title bar, so it has no flip-to-`RearCard`, so
//                   without the shell's own jack rail (and the
//                   `.card-back-panel` it puts in the tile, which the
//                   canvas-wide rear view reveals through the ancestor-generic
//                   `.rear-view .rl-tile:has(> .patch-panel-host >
//                   .card-back-panel)` rule) the tray would have NO JACKS AT
//                   ALL. Two shipped specs patch `masterL` out of and `ch1L`
//                   into that drawer.
//
// ⚠ THE DOCK-vs-LANE QUESTION IS `view !== 'lane'`, NEVER `view === 'dock-full'`.
// Every band/tier/hero decision keyed off `'dock-full'` is really asking "is
// this the full faceplate?", and the answer is yes on both dock surfaces. A
// re-typed `=== 'dock-full'` is a silent default: the drawer would fall back to
// the LANE branch and paint a 6-of-91-control plate.
export type ShellView = 'lane' | 'dock-full' | 'drawer';

/** TRUE on the surfaces that paint the FULL faceplate (both dock hosts). The
 *  one place the union is collapsed to that question. Pure. */
export function isFaceplateView(view: ShellView): boolean {
  return view !== 'lane';
}

// ── THE DOCK FULL-VIEW HEAD (#1726) ─────────────────────────────────────────
//
// Three things compete for the top of a dock faceplate and only one of them
// can have it: the extension's own full-width SURFACE (`ShellExtension`'s
// `fullViewBody` slot), the face's own promoted picture (`hero.cell`), and the
// shell's generic GLYPH — which for a video-domain def is the live
// `VideoTileThumb`. The precedence was an inline expression in ModuleShell
// (`hasGlyph && !(view === 'dock-full' && hero?.cell)`); pulling it out is what
// makes the NEW arm testable without a browser, since the repo's unit lane is
// `environment: 'node'` and mounts no Svelte components.
//
// ⚠ The invariant that keeps every existing faceplate byte-identical is that
// with `hasExtensionBody: false` this returns EXACTLY the old expression. That
// is asserted as a permanent leg of module-shell-model.test.ts rather than
// asserted once here in prose — a VRT baseline is the only other thing that
// would have caught a drift, and it would have caught it 25 minutes later.

/** What paints at the head of a dock full view. */
export interface DockFullViewHeadPlan {
  /** The extension's bespoke full-width body renders (dock full view only). */
  extBody: boolean;
  /** The shell's generic hero glyph (video thumbnail / scope / topology plate)
   *  renders. False when something more specific has claimed the head. */
  heroGlyph: boolean;
}

/**
 * Resolve the dock full view's head. Pure — no def, no engine, no DOM.
 *
 * Precedence, most specific first:
 *   1. `hasExtensionBody` — the module brought its own full-width surface.
 *   2. `heroCell` — the face promoted one of its own cells to the hero stage.
 *   3. the generic glyph.
 *
 * `extBody` is dock-only: a 192px lane tile cannot paint a module's full
 * surface, and the lane already has the thumbnail glyph for identity.
 */
export function dockFullViewHeadPlan(args: {
  view: ShellView;
  /** The shell has SOMETHING generic to paint (`glyphKind !== 'none'` or a
   *  video surface) — `ModuleShell`'s `hasGlyph`. */
  hasGlyph: boolean;
  /** The face declares `hero.cell` (dock-only by construction). */
  heroCell: boolean;
  /** The resolved extension exports the `fullViewBody` slot. */
  hasExtensionBody: boolean;
}): DockFullViewHeadPlan {
  // `isFaceplateView`, not `=== 'dock-full'`: the pinned drawer paints the same
  // full faceplate and wants the same head precedence (#1739).
  const dock = isFaceplateView(args.view);
  const extBody = dock && args.hasExtensionBody;
  return {
    extBody,
    heroGlyph: args.hasGlyph && !(dock && (args.heroCell || args.hasExtensionBody)),
  };
}
