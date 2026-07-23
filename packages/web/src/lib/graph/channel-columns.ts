// packages/web/src/lib/graph/channel-columns.ts
//
// WORKFLOW CHANNEL COLUMNS — PURE geometry + ordered-membership array helpers.
//
// The workflow-mode canvas is projected as 8 numbered CHANNEL COLUMNS (1..8) with
// a SENDS rail (SEND 1 / SEND 2) to their right. A module dropped/added in a
// column joins that channel's vertical DSP chain (source → filter → reverb →
// mixer channel); a module dropped in a send box joins that aux-send loop.
//
// SCHEMA (the load-bearing collab design — see workflow-mode-channel-columns):
//   * MEMBERSHIP truth = a scalar on the member node: `data.channel: 1..8` (a
//     column member) or `data.sendSlot: 1|2` (a send tenant). An independent
//     CRDT key on an independent node → no last-writer-wins loss.
//   * ORDER = an explicit `string[]` per column on the pinned-mixmstrs node
//     (`data.columns['1'..'8']` / `data.sends['1'|'2']`). The chain is a PURE
//     function of this array; on-screen slot is COMPUTED from the array index
//     (position = render output), so a drag-nudge can never reorder the chain
//     and per-user layouts stay free.
//   * A lost concurrent append (node has data.channel===ch but is missing from
//     the order array — the array is last-writer-wins in a Y.Map value) SELF-
//     HEALS: reconcileColumnOrder ADOPTS it at the bottom (sorted for cross-peer
//     determinism), which is the feature's own "added at bottom" semantic.
//
// PURE — no Svelte / Yjs / DOM. Geometry reuses the rack-grid pitches; the
// Canvas owns the side effects (Yjs writes, reading nodeFootprintPx from the DOM).

import { HP_UNIT, RACK_UNIT, snapPositionToGrid } from '$lib/ui/rack-grid';

// ---------------- Constants ----------------

/** The workflow view has exactly 8 channel columns (= the 8 mixmstrs channels).
 *  HARD CAP — no scroll/page beyond 8. */
export const COLUMN_COUNT = 8;

/** Number of aux-send boxes in the sends rail (= the 2 mixmstrs aux sends). */
export const SEND_BOX_COUNT = 2;

/** Column width in flow-space px. A FIXED 34 HP (34 × 22.5 = 765px) so the
 *  WIDEST workflow cards fit WITHOUT clipping: tidyvco + sixstrum are 4hp = 720px
 *  wide, and with the 22.5px left pad (COLUMN_PAD_X) the card's right edge lands
 *  at 742.5px, leaving a 22.5px right gutter before the divider (owner: "columns
 *  must be wide enough to hold tidyvco AND sixstrum without clipping"). The send
 *  boxes track this width (SEND_BOX_W = COLUMN_W). */
export const COLUMN_HP = 34;
export const COLUMN_W = COLUMN_HP * HP_UNIT;

/** The RACKLINE `?shell=1` preview column PITCH (px). The mock's tight 8-lane
 *  rack (ux-proposal-b.html:598) is a UNIFORM 192px tile (SHELL_TILE_W in
 *  module-shell-model.ts) on a 216px lane pitch — a clean 24px gutter (the 192
 *  tile centered leaves 12px each side). This narrows the app-scale 765px
 *  (34hp) band that was sized for the old FULL cards, so the uniform shell tiles
 *  FILL their lanes instead of floating in huge gutters.
 *
 *  It is used ONLY under the preview: every pitch-dependent geometry fn below
 *  takes the ACTIVE pitch as a trailing param that DEFAULTS to COLUMN_W, so a
 *  preview-OFF call (no arg) is byte-identical to before. The Canvas resolves
 *  the pitch once (columnPitch(shellPreview)) and threads it into the
 *  RENDER-derived positions / drop hit-tests / overlay bands / viewport nav —
 *  never into a PERSISTED write (spawn x/y + grow-up push-ups keep COLUMN_W), so
 *  narrowing is a pure render derivation: collab-safe, no Y.Doc change. */
export const SHELL_COLUMN_W = 216;

/** Resolve the active column pitch for the current view: the tight shell pitch
 *  under the `?shell=1` preview, else the app-scale COLUMN_W (34hp / 765px). The
 *  Canvas calls this and threads the result into the pure geometry fns so those
 *  stay flag-free (preview-off passes COLUMN_W → identical math). */
export function columnPitch(shellPreview: boolean): number {
  return shellPreview ? SHELL_COLUMN_W : COLUMN_W;
}

/** Each aux-send box is one column wide; the two boxes sit SIDE BY SIDE to the
 *  right of column 8 (owner: "the send columns should be next to each other").
 *  (Width standardization is a deliberate follow-up.) */
export const SEND_BOX_W = COLUMN_W;
export const SEND_RAIL_W = SEND_BOX_W * SEND_BOX_COUNT;

/** Flow-space origin of the column band (top-left). Columns and the sends rail
 *  are laid out to the right of this point. Kept at the flow origin so the
 *  overlay + hit-tests share one coordinate frame. */
export const COLUMN_ORIGIN_X = 0;
export const COLUMN_TOP_Y = 0;

/** Vertical slot pitch — the deterministic per-index stacking height. A clean
 *  4u (RACK_UNIT × 4 = 720px) multiple so a 3u instrument fits with a 1u gap AND
 *  every derived slot Y lands on the 180px rack grid (snap is a no-op). Keeps
 *  position a pure function of the array index. */
export const COLUMN_SLOT_H = RACK_UNIT * 4; // 720px (grid-aligned)

/** Left padding inside a column band so cards don't butt the divider — the
 *  FALLBACK gutter used only when a card's width is unknown. When the width IS
 *  known the card is CENTERED in the band instead (columnCardX), giving equal
 *  left/right gutters that match the band-centered channel number + guide lines
 *  (see columnBandCenterX). For a 4hp/720px card in a 34hp/765px band the two
 *  agree (gutter 22.5 each side); a narrower card would otherwise hug the left
 *  edge and drift ~tens of px LEFT of its number — the offset bug this fixes. */
export const COLUMN_PAD_X = HP_UNIT; // 22.5px

/** The number of slots budgeted above the baseline before a column overflows
 *  upward (visual band height). Columns are BOTTOM-ANCHORED: the FIRST-added
 *  member sits just above the baseline near the channel number, and each later
 *  member stacks flush UPWARD (owner: "the first module added should be at the
 *  bottom of the column no matter where I click; adding FX stacks them on top"). */
export const COLUMN_MAX_SLOTS = 6;
export const COLUMN_H = COLUMN_SLOT_H * COLUMN_MAX_SLOTS;

/** The flow-space Y BASELINE the columns bottom-anchor to — where the numbered
 *  1..8 labels sit. Member `i` of a `total`-member column is placed ABOVE it. */
export const COLUMN_BASELINE_Y = COLUMN_TOP_Y + COLUMN_H;

// ---------------- Geometry (pure) ----------------

// Every X-layout fn below takes the active column `pitch` as a trailing param
// that DEFAULTS to COLUMN_W — a preview-OFF call (no arg) is byte-identical to
// the fixed-765 behaviour; the Canvas passes SHELL_COLUMN_W under `?shell=1`. The
// send box + rail track the column pitch (SEND_BOX_W === COLUMN_W by design), so
// one `pitch` scalar drives the whole horizontal layout.

/** The `[x0, x1)` flow-space horizontal band of channel column `ch` (1-based). */
export function columnXBand(ch: number, pitch: number = COLUMN_W): [number, number] {
  const x0 = COLUMN_ORIGIN_X + (ch - 1) * pitch;
  return [x0, x0 + pitch];
}

/** The flow-space CENTER X of column `ch`'s band — where the guide-line pair
 *  brackets and the channel NUMBER badge center. The single X that a card's own
 *  center must match (columnCardX). */
export function columnBandCenterX(ch: number, pitch: number = COLUMN_W): number {
  const [x0, x1] = columnXBand(ch, pitch);
  return (x0 + x1) / 2;
}

/** The flow-space CENTER X of send box `slot`'s band. */
export function sendBandCenterX(slot: number, pitch: number = COLUMN_W): number {
  const [x0, x1] = sendBoxXBand(slot, pitch);
  return (x0 + x1) / 2;
}

/** The flow-space TOP-LEFT X that CENTERS a card of pixel width `widthPx` inside
 *  column `ch`'s band — so the card's center lands on columnBandCenterX(ch)
 *  (== the channel number's center). Equal left/right gutters. Falls back to the
 *  fixed left pad when width is unknown/zero. (Under the shell pitch a 192px tile
 *  in the 216px band lands with a clean 12px gutter each side.) */
export function columnCardX(ch: number, widthPx: number, pitch: number = COLUMN_W): number {
  const [x0] = columnXBand(ch, pitch);
  return widthPx > 0 ? x0 + (pitch - widthPx) / 2 : x0 + COLUMN_PAD_X;
}

/** Send-box twin of columnCardX — centers a card of width `widthPx` in box `slot`
 *  (the box is one pitch wide). */
export function sendCardX(slot: number, widthPx: number, pitch: number = COLUMN_W): number {
  const [x0] = sendBoxXBand(slot, pitch);
  return widthPx > 0 ? x0 + (pitch - widthPx) / 2 : x0 + COLUMN_PAD_X;
}

/** The `[x0, x1)` flow-space band of send box `slot` (1|2) — SIDE BY SIDE right
 *  of column 8. Each box is one pitch wide. */
export function sendBoxXBand(slot: number, pitch: number = COLUMN_W): [number, number] {
  const railX0 = COLUMN_ORIGIN_X + COLUMN_COUNT * pitch;
  const x0 = railX0 + (slot - 1) * pitch;
  return [x0, x0 + pitch];
}

/** The `[x0, x1)` flow-space band of the WHOLE sends rail (both boxes). */
export function sendRailXBand(pitch: number = COLUMN_W): [number, number] {
  const x0 = COLUMN_ORIGIN_X + COLUMN_COUNT * pitch;
  return [x0, x0 + pitch * SEND_BOX_COUNT];
}

/**
 * Hit-test a flow-space X to a drop target:
 *   * 1..8            — the channel column at that X.
 *   * 'send'          — the sends rail (which box is resolved by sendBoxForFlowX).
 *   * null            — outside the workflow bands (free canvas).
 */
export function columnForFlowX(x: number, pitch: number = COLUMN_W): number | 'send' | null {
  const [railX0, railX1] = sendRailXBand(pitch);
  if (x >= railX0 && x < railX1) return 'send';
  if (x < COLUMN_ORIGIN_X) return null;
  const idx = Math.floor((x - COLUMN_ORIGIN_X) / pitch);
  if (idx < 0 || idx >= COLUMN_COUNT) return null;
  return idx + 1;
}

/** Which send box (1|2) a flow-space X lands in — the two boxes are side by
 *  side, so it's an X hit-test (not Y). */
export function sendBoxForFlowX(x: number, pitch: number = COLUMN_W): 1 | 2 {
  const railX0 = COLUMN_ORIGIN_X + COLUMN_COUNT * pitch;
  return x < railX0 + pitch ? 1 : 2;
}

/**
 * Deterministic flow-space TOP-LEFT position of member `index` (0-based, 0 = top
 * / source) of a `total`-member column `ch`. BOTTOM-ANCHORED: the tail
 * (index = total-1) sits one slot above the baseline (near the number), and
 * earlier members stack UPWARD — so appending a member lands it at the bottom.
 * Position is a PURE function of (ch, index, total): the chain order IS the
 * on-screen order. Grid-snapped.
 */
export function columnMemberPos(ch: number, index: number, total: number, pitch: number = COLUMN_W): { x: number; y: number } {
  const [x0] = columnXBand(ch, pitch);
  const n = Math.max(total, index + 1);
  return snapPositionToGrid({
    x: x0 + COLUMN_PAD_X,
    y: COLUMN_BASELINE_Y - (n - index) * COLUMN_SLOT_H,
  });
}

/** Deterministic TOP-LEFT position of send-box `slot` tenant `index` of `total`
 *  — bottom-anchored like a column, in the box's own X band. */
export function sendMemberPos(slot: number, index: number, total: number, pitch: number = COLUMN_W): { x: number; y: number } {
  const [x0] = sendBoxXBand(slot, pitch);
  const n = Math.max(total, index + 1);
  return snapPositionToGrid({
    x: x0 + COLUMN_PAD_X,
    y: COLUMN_BASELINE_Y - (n - index) * COLUMN_SLOT_H,
  });
}

/** The flow-space position for a NEW member appended at the BOTTOM of column
 *  `ch` that currently has `currentCount` members (the new bottom slot). */
export function columnBottomFlowPos(ch: number, currentCount: number, pitch: number = COLUMN_W): { x: number; y: number } {
  return columnMemberPos(ch, currentCount, currentCount + 1, pitch);
}

/**
 * FLUSH bottom-up stacking (owner: "modules stack at the BOTTOM and grow UPWARD,
 * sitting directly on top of each other with NO vertical space between them. The
 * FIRST module added should be at the BOTTOM of the column no matter where I
 * click; adding more FX stacks them on TOP.").
 * Given each member's PIXEL height in ARRAY order — index 0 = the FIRST-added
 * member, which is ANCHORED at the column BOTTOM; the last index = the NEWEST
 * member, at the TOP — returns the top-left flow-space position of every member
 * such that:
 *   - the FIRST (index 0, bottom-anchored) member's BOTTOM edge sits exactly on
 *     COLUMN_BASELINE_Y (just above the channel number),
 *   - each LATER member sits FLUSH directly on top of the one before it (its
 *     bottom edge == the previous member's top edge — zero gap), stacking upward,
 *   - a single member therefore lands at the very bottom of the column.
 * Position is a PURE function of (ch, heights) — heights are derived from each
 * member's rack tier (a per-TYPE constant), so every peer computes the SAME
 * layout (collab-convergent). X is the column's left pad; Y is exact (heights are
 * rack-grid multiples, so the result is grid-aligned without a snap step).
 */
export function columnFlushPositions(
  ch: number,
  heightsPx: readonly number[],
  widthsPx?: readonly number[],
  pitch: number = COLUMN_W,
): { x: number; y: number }[] {
  const [x0] = columnXBand(ch, pitch);
  const padX = x0 + COLUMN_PAD_X;
  const out: { x: number; y: number }[] = new Array(heightsPx.length);
  let bottom = COLUMN_BASELINE_Y;
  for (let i = 0; i < heightsPx.length; i++) {
    const top = bottom - (heightsPx[i] ?? COLUMN_SLOT_H);
    // CENTER each card in the band by its OWN width (so card-center == band-
    // center == channel-number center); fall back to the left pad when widths
    // aren't supplied (back-compat: legacy callers get the historical x).
    const w = widthsPx?.[i];
    out[i] = { x: w != null ? columnCardX(ch, w, pitch) : padX, y: top };
    bottom = top; // the next member stacks flush ON TOP of this one
  }
  return out;
}

/** Send-box twin of columnFlushPositions — flush bottom-up in the box's own X
 *  band. Index 0 (first-added) is anchored at the bottom; later tenants stack up. */
export function sendFlushPositions(
  slot: number,
  heightsPx: readonly number[],
  widthsPx?: readonly number[],
  pitch: number = COLUMN_W,
): { x: number; y: number }[] {
  const [x0] = sendBoxXBand(slot, pitch);
  const padX = x0 + COLUMN_PAD_X;
  const out: { x: number; y: number }[] = new Array(heightsPx.length);
  let bottom = COLUMN_BASELINE_Y;
  for (let i = 0; i < heightsPx.length; i++) {
    const top = bottom - (heightsPx[i] ?? COLUMN_SLOT_H);
    const w = widthsPx?.[i];
    out[i] = { x: w != null ? sendCardX(slot, w, pitch) : padX, y: top };
    bottom = top; // the next tenant stacks flush ON TOP of this one
  }
  return out;
}

/** The flow-space position for a NEW tenant appended at the BOTTOM of send box
 *  `slot` that currently has `currentCount` tenants. */
export function sendBottomFlowPos(slot: number, currentCount: number, pitch: number = COLUMN_W): { x: number; y: number } {
  return sendMemberPos(slot, currentCount, currentCount + 1, pitch);
}

/**
 * Compute the insert INDEX (into the ORDER array) for a reorder drop. Order index
 * 0 = the bottom-anchored, first-added member (largest Y); index grows UPWARD
 * (smaller Y) — see columnFlushPositions. `memberCenters` are the siblings'
 * flush slot-center Y positions IN ORDER-ARRAY ORDER (excluding the dragged
 * member); they descend in Y (index 0 = bottom = largest Y).
 *
 * The insert index = the number of siblings sitting BELOW the drop point (center
 * Y strictly greater than dropY): those keep the low indices, the dropped member
 * takes the next slot up. This is a pure MULTISET count, so it is independent of
 * the array's iteration order and correct for the descending-Y layout:
 *   - drop at the very BOTTOM (large dropY) → 0 siblings below → index 0 (bottom),
 *   - drop at the very TOP (small dropY) → all siblings below → append (top).
 */
export function indexForDropY(memberCenters: readonly number[], dropY: number): number {
  let below = 0;
  for (const c of memberCenters) if (c > dropY) below++;
  return below;
}

// ---------------- Lane HEIGHT (uniform grow-up) ----------------
//
// The guide lines default to a SHORT band (~2× a tidyvco card) above the
// baseline. When any column's member STACK is taller than that default, ALL 8
// lanes grow upward TOGETHER to the same height = max(default, tallest stack) —
// "the lines all extend upwards". The baseline (channel numbers) stays pinned at
// the bottom; growth is upward only (a smaller top Y). Heights are the per-TYPE
// rack-unit card heights columnFlushPositions already sums, so every peer
// computes the SAME lane height (collab-convergent, no write needed).

/** The default lane height as a MULTIPLE of a reference card height: 2× a
 *  tidyvco (a tidyvco is 3u = 540px → default 1080px). The caller supplies the
 *  reference card's pixel height (derived from the live rack tier), keeping this
 *  file free of the rack-size registry. */
export function defaultLaneHeightPx(refCardHeightPx: number): number {
  return refCardHeightPx * 2;
}

/** The UNIFORM lane height: the LARGER of the default and the tallest column /
 *  send stack (each stack height = the sum of its members' card heights). Pure
 *  max — every peer feeding the same per-type heights converges. */
export function computeLaneHeightPx(
  stackHeightsPx: readonly number[],
  defaultHeightPx: number,
): number {
  let h = defaultHeightPx;
  for (const s of stackHeightsPx) if (s > h) h = s;
  return h;
}

/** The flow-space TOP Y of every lane guide line for a given lane height. The
 *  baseline is fixed at the bottom; a taller lane has a SMALLER top Y (grows
 *  upward). */
export function laneTopYForHeight(laneHeightPx: number): number {
  return COLUMN_BASELINE_Y - laneHeightPx;
}

// ---------------- Grow-up push (canvas modules clear the lanes) ----------------
//
// When the lanes grow upward, any NON-lane canvas module sitting above them
// whose box now dips BELOW the new line-top is PUSHED UP so it clears the lane
// region — even a LOCKED module (the push writes committed graph position, not a
// drag). The new Y snaps to the rack grid so the module lands at a LOCKABLE
// position. A pure, deterministic compute (position = f(laneTop, module box)) →
// a single-actor compute-then-commit converges across peers; re-running it once
// the modules have cleared yields an EMPTY plan (idempotent — no write storm).

/** A canvas module's flow-space box + id, as the push planner reads it. */
export interface ModuleBoxLike {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The full flow-space X span the lanes occupy (columns 1..8 + the sends rail) —
 *  a module must horizontally overlap this to be considered "over the lanes". */
export function laneRegionXBand(pitch: number = COLUMN_W): [number, number] {
  return [COLUMN_ORIGIN_X, sendRailXBand(pitch)[1]];
}

/**
 * Plan the grow-up push. For each candidate module (the caller passes only
 * NON-lane, non-video canvas modules) that (a) horizontally overlaps the lane
 * region and (b) has its BOTTOM edge below the new lane top (`laneTopY`) — i.e.
 * it dips into the lanes — return a new grid-snapped TOP Y that lifts its bottom
 * edge to (at or above) `laneTopY`. Snapping DOWN to the grid guarantees the
 * bottom clears the lane top AND the module lands on a lockable row. Modules
 * that already clear the lanes (or don't overlap) get no entry → idempotent.
 */
export function planLanePushUps(
  modules: readonly ModuleBoxLike[],
  laneTopY: number,
  gridY: number = RACK_UNIT,
  pitch: number = COLUMN_W,
): { id: string; y: number }[] {
  const [rx0, rx1] = laneRegionXBand(pitch);
  const out: { id: string; y: number }[] = [];
  for (const m of modules) {
    const overlapsX = m.x < rx1 && m.x + m.w > rx0;
    if (!overlapsX) continue;
    const bottom = m.y + m.h;
    if (bottom <= laneTopY) continue; // already clears the lane top
    // Lift so the bottom edge sits AT/above laneTopY, snapped DOWN to the grid
    // (floor → the new bottom is ≤ laneTopY, and the top lands on a lock row).
    const newTop = Math.floor((laneTopY - m.h) / gridY) * gridY;
    if (newTop < m.y) out.push({ id: m.id, y: newTop });
  }
  return out;
}

// ---------------- Video area (the purple video zone) ----------------
//
// Below the channel-lane baseline sits the VIDEO ZONE — the video-domain analog
// of the audio mixer strip. A purple-outlined region sized to hold video cards:
// its height matches a backdraft card (3u / 540px — backdraft's default box) and
// it spans the FULL lane band (columns 1..8) so several video modules fit side
// by side. A fresh workflow rack auto-spawns ONE videoOut inside it as the
// default video sink.

/** The video zone's height in flow-space px = a backdraft card's default box
 *  (3u = 540px). */
export const VIDEO_AREA_HEIGHT = RACK_UNIT * 3;

/** The video zone's flow-space rect: full column band width (columns 1..8, NOT
 *  the sends rail), directly below the baseline. (Width choice: the column band
 *  — the widest natural "strip" — rather than a single backdraft width.) */
export function videoAreaBand(pitch: number = COLUMN_W): { x0: number; x1: number; y0: number; y1: number } {
  return {
    x0: COLUMN_ORIGIN_X,
    x1: COLUMN_ORIGIN_X + COLUMN_COUNT * pitch,
    y0: COLUMN_BASELINE_Y,
    y1: COLUMN_BASELINE_Y + VIDEO_AREA_HEIGHT,
  };
}

/** Deterministic node ids for the auto-spawned video-zone default trio (the
 *  CRDT convergence keys — like the pinned-<type> singletons). videoOut is the
 *  master video SINK; recorderbox records the master A/V; synesthesia renders
 *  audio-reactive visuals from the master mix. */
export const DEFAULT_VIDEO_OUT_ID = 'workflow-videoOut';
export const DEFAULT_RECORDERBOX_ID = 'workflow-recorderbox';
export const DEFAULT_SYNESTHESIA_ID = 'workflow-synesthesia';

/** Horizontal pitch between the video-zone default cards' TOP-LEFT corners —
 *  one channel-column width (765px). The widest default card (synesthesia,
 *  460px) clears its neighbour with a comfortable gutter, and each slot lands
 *  grid-snapped (COLUMN_W is a whole multiple of HP_UNIT). */
export const VIDEO_ZONE_SLOT_PITCH_X = COLUMN_W;

/** Grid-snapped TOP-LEFT position for video-zone slot `index` (0-based, laid out
 *  left→right along the zone's top edge). Slot 0 is the historical videoOut
 *  position (near the zone's left edge), so extending the zone never moves the
 *  pre-existing videoOut card. */
export function videoZoneSlotPos(index: number, pitch: number = VIDEO_ZONE_SLOT_PITCH_X): { x: number; y: number } {
  return snapPositionToGrid({
    x: COLUMN_ORIGIN_X + COLUMN_PAD_X + index * pitch,
    y: COLUMN_BASELINE_Y,
  });
}

/** Grid-snapped TOP-LEFT spawn position for the default videoOut, inside the
 *  video area near its left edge (a 360×360 videoOut fits with headroom below
 *  the 540px zone). Slot 0 of the video-zone layout. */
export function videoOutSpawnPos(): { x: number; y: number } {
  return videoZoneSlotPos(0);
}

/** One video-zone default module the workflow ensure auto-spawns + auto-wires.
 *  Each carries its OWN one-shot latch key (stored on the pinned mixer) so a
 *  user delete is respected forever, like the videoOut latch. */
export interface VideoZoneDefaultSpec {
  /** Deterministic node id (the CRDT convergence key). */
  id: string;
  /** Registered module type. */
  type: string;
  /** Registry domain ('video' | 'audio' — synesthesia is an audio module that
   *  lives in the video zone). */
  domain: 'video' | 'audio';
  /** `node.data` latch key on the pinned mixer: "this default was seeded once". */
  seededFlag: string;
  /** Grid-snapped TOP-LEFT spawn position (its video-zone slot). */
  pos: { x: number; y: number };
  /** Nominal card width (px) — the no-overlap layout guarantee (unit-tested). */
  nominalWidth: number;
  /** True when this module's default wiring needs the master videoOut present
   *  (recorderbox taps its pass-through OUT for the master video). */
  requiresVideoOut: boolean;
}

/** The video-zone default trio, laid out left→right. videoOut (slot 0) keeps its
 *  historical position; recorderbox (slot 1) + synesthesia (slot 2) are the P-next
 *  additions. Card widths: videoOut 360, recorderbox 248, synesthesia 460. */
export const VIDEO_ZONE_DEFAULTS: readonly VideoZoneDefaultSpec[] = [
  { id: DEFAULT_VIDEO_OUT_ID, type: 'videoOut', domain: 'video', seededFlag: 'workflowVideoOutSeeded', pos: videoZoneSlotPos(0), nominalWidth: 360, requiresVideoOut: false },
  { id: DEFAULT_RECORDERBOX_ID, type: 'recorderbox', domain: 'video', seededFlag: 'workflowRecorderboxSeeded', pos: videoZoneSlotPos(1), nominalWidth: 248, requiresVideoOut: true },
  { id: DEFAULT_SYNESTHESIA_ID, type: 'synesthesia', domain: 'audio', seededFlag: 'workflowSynesthesiaSeeded', pos: videoZoneSlotPos(2), nominalWidth: 460, requiresVideoOut: false },
] as const;

/** The two NEW video-zone defaults the extended ensure spawns (videoOut has its
 *  own pre-existing ensure effect). */
export const VIDEO_ZONE_EXTRA_DEFAULTS: readonly VideoZoneDefaultSpec[] =
  VIDEO_ZONE_DEFAULTS.filter((s) => s.id !== DEFAULT_VIDEO_OUT_ID);

/** Minimal node view for the default-video-zone presence checks. */
export interface VideoOutNodeLike {
  type: string;
}

/** True when the rack has NO videoOut yet → the ensure must spawn the default
 *  one. (Presence is by TYPE: any existing videoOut — user- or auto-spawned —
 *  satisfies the "one default sink" invariant, so we never add a second.) */
export function needsDefaultVideoOut(nodes: ReadonlyArray<VideoOutNodeLike>): boolean {
  return !nodes.some((n) => n.type === 'videoOut');
}

/** True when the rack has NO node of `type` yet → the ensure must spawn the
 *  default one. Presence is by TYPE (any existing instance satisfies the "one
 *  default" invariant), mirroring needsDefaultVideoOut. */
export function rackLacksType(nodes: ReadonlyArray<VideoOutNodeLike>, type: string): boolean {
  return !nodes.some((n) => n.type === type);
}

// ---------------- Video-zone default WIRING (master A/V taps) ----------------
//
// Owner directive: a fresh workflow rack's video zone records + reacts to the
// MASTER bus out of the box. recorderbox captures the final master VIDEO (a tap
// on the videoOut sink's pass-through OUT) plus the master AUDIO (mixmstrs
// masterL/R); synesthesia renders audio-reactive visuals from the master mix
// (masterL→A, masterR→B). Deterministic edge ids (the handleConnect
// `e-<src>-<srcPort>-<dst>-<dstPort>` template) make two racing clients
// converge on ONE Y.Map entry per wire — CRDT-safe like the node ids. The wires
// are seeded in the SAME transact as the module spawn (gated by the module's
// own seed latch), so a user delete of the module OR a wire is never re-fought.

/** One video-zone default wire (a full Edge-shaped record; ids deterministic). */
export interface VideoZoneWire {
  id: string;
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
  sourceType: 'video' | 'audio';
  targetType: 'video' | 'audio';
}

/** Resolve the master video-out node id recorderbox taps for the master video:
 *  the auto-spawned workflow-videoOut if present, else the first videoOut of any
 *  origin (a user-brought sink), else null (no video sink yet → wire later). */
export function resolveMasterVideoOutId(
  nodes: ReadonlyArray<{ id: string; type: string }>,
): string | null {
  if (nodes.some((n) => n.id === DEFAULT_VIDEO_OUT_ID)) return DEFAULT_VIDEO_OUT_ID;
  const anyVideoOut = nodes.find((n) => n.type === 'videoOut');
  return anyVideoOut ? anyVideoOut.id : null;
}

const MASTER_MIX_ID = 'pinned-mixmstrs';

/**
 * The default wires INTO a freshly-seeded video-zone module, FROM the master
 * buses. Pure — the caller writes them in the spawn transact (skipping occupied
 * targets / existing edge ids). Port ids are pinned by the defs + unit contract:
 *   - recorderbox: `in`←videoOut `out` (master video), `audio_l`/`audio_r`←
 *     mixmstrs `masterL`/`masterR` (master audio). The video wire is omitted
 *     when no videoOut exists yet (recorderbox still records master audio; the
 *     spawn is gated on a videoOut existing so this is defensive).
 *   - synesthesia: `a_in`←mixmstrs `masterL`, `b_in`←mixmstrs `masterR`.
 */
export function videoZoneWiresFor(
  type: 'recorderbox' | 'synesthesia',
  videoOutId: string | null,
): VideoZoneWire[] {
  if (type === 'recorderbox') {
    const wires: VideoZoneWire[] = [];
    if (videoOutId) {
      wires.push({
        id: `e-${videoOutId}-out-${DEFAULT_RECORDERBOX_ID}-in`,
        source: { nodeId: videoOutId, portId: 'out' },
        target: { nodeId: DEFAULT_RECORDERBOX_ID, portId: 'in' },
        sourceType: 'video', targetType: 'video',
      });
    }
    wires.push(
      {
        id: `e-${MASTER_MIX_ID}-masterL-${DEFAULT_RECORDERBOX_ID}-audio_l`,
        source: { nodeId: MASTER_MIX_ID, portId: 'masterL' },
        target: { nodeId: DEFAULT_RECORDERBOX_ID, portId: 'audio_l' },
        sourceType: 'audio', targetType: 'audio',
      },
      {
        id: `e-${MASTER_MIX_ID}-masterR-${DEFAULT_RECORDERBOX_ID}-audio_r`,
        source: { nodeId: MASTER_MIX_ID, portId: 'masterR' },
        target: { nodeId: DEFAULT_RECORDERBOX_ID, portId: 'audio_r' },
        sourceType: 'audio', targetType: 'audio',
      },
    );
    return wires;
  }
  // synesthesia
  return [
    {
      id: `e-${MASTER_MIX_ID}-masterL-${DEFAULT_SYNESTHESIA_ID}-a_in`,
      source: { nodeId: MASTER_MIX_ID, portId: 'masterL' },
      target: { nodeId: DEFAULT_SYNESTHESIA_ID, portId: 'a_in' },
      sourceType: 'audio', targetType: 'audio',
    },
    {
      id: `e-${MASTER_MIX_ID}-masterR-${DEFAULT_SYNESTHESIA_ID}-b_in`,
      source: { nodeId: MASTER_MIX_ID, portId: 'masterR' },
      target: { nodeId: DEFAULT_SYNESTHESIA_ID, portId: 'b_in' },
      sourceType: 'audio', targetType: 'audio',
    },
  ];
}

// ---------------- Viewport navigation (workflow keyboard pan) ----------------
//
// The workflow keys pan the SvelteFlow viewport to FRAME a lane or the video
// zone WITHOUT changing zoom. xyflow's viewport is the affine map
//   screenPx = flowCoord * zoom + translate
// so translate = desiredScreenPx − flowCoord * zoom. These PURE helpers compute
// the {x, y, zoom} the Canvas hands straight to setViewport; the Canvas supplies
// the live SCREEN-space pane size + current zoom, keeps zoom fixed, and animates.

/** The live viewport as the pan math reads it: SCREEN-space width/height (px) of
 *  the flow pane (getBoundingClientRect) + the current zoom factor (kept fixed). */
export interface ViewportMetrics {
  widthPx: number;
  heightPx: number;
  zoom: number;
}

/** A SvelteFlow viewport transform: {x, y} = the screen-px pan translate (where
 *  flow-origin {0,0} lands on screen), plus the zoom factor. */
export interface ViewportTransform {
  x: number;
  y: number;
  zoom: number;
}

/**
 * Pan so channel column `ch` is (a) HORIZONTALLY CENTERED in the viewport and
 * (b) its BASELINE (the row where the channel number sits) at the viewport
 * BOTTOM, at the current zoom. From screen = flow*zoom + translate:
 *   - horizontal center: columnBandCenterX(ch)·zoom + x == widthPx/2
 *   - baseline at bottom: COLUMN_BASELINE_Y·zoom + y == heightPx
 */
export function laneCenterViewport(ch: number, vp: ViewportMetrics, pitch: number = COLUMN_W): ViewportTransform {
  const { widthPx, heightPx, zoom } = vp;
  return {
    x: widthPx / 2 - columnBandCenterX(ch, pitch) * zoom,
    y: heightPx - COLUMN_BASELINE_Y * zoom,
    zoom,
  };
}

/**
 * Pan so the video area's LOWER-LEFT corner (videoAreaBand min-x, max-y) maps to
 * the viewport's LOWER-LEFT corner — screen (0, heightPx) — at the current zoom.
 * From screen = flow*zoom + translate:
 *   - left edge at screen x 0: videoAreaBand().x0·zoom + x == 0
 *   - bottom edge at screen bottom: videoAreaBand().y1·zoom + y == heightPx
 */
export function videoAreaViewport(vp: ViewportMetrics, pitch: number = COLUMN_W): ViewportTransform {
  const { heightPx, zoom } = vp;
  const b = videoAreaBand(pitch);
  return {
    x: -b.x0 * zoom,
    y: heightPx - b.y1 * zoom,
    zoom,
  };
}

/**
 * Pan so SEND box `slot` is (a) horizontally centered and (b) its BASELINE at the
 * viewport bottom — the send-rail twin of laneCenterViewport. Pure.
 */
export function sendBoxCenterViewport(slot: number, vp: ViewportMetrics, pitch: number = COLUMN_W): ViewportTransform {
  const { widthPx, heightPx, zoom } = vp;
  return {
    x: widthPx / 2 - sendBandCenterX(slot, pitch) * zoom,
    y: heightPx - COLUMN_BASELINE_Y * zoom,
    zoom,
  };
}

/** The flow-space CENTER X of the WHOLE channel-column band (columns 1..8) — the
 *  horizontal anchor the on-load lane framing centers on. */
export function laneBandCenterX(pitch: number = COLUMN_W): number {
  return (COLUMN_ORIGIN_X + COLUMN_COUNT * pitch) / 2;
}

/**
 * On-LOAD lane framing: center the whole 8-column band horizontally with the
 * lane BASELINE at the viewport bottom, at the current zoom. Lands the camera on
 * the channel lanes (their headroom fills the viewport above the baseline)
 * instead of the bottom video zone that a bare fitView anchors on (only the
 * video-zone nodes are xyflow-visible on a fresh rack — the channel singletons
 * are canvas-hidden). Pure.
 */
export function fitLanesViewport(vp: ViewportMetrics, pitch: number = COLUMN_W): ViewportTransform {
  const { widthPx, heightPx, zoom } = vp;
  return {
    x: widthPx / 2 - laneBandCenterX(pitch) * zoom,
    y: heightPx - COLUMN_BASELINE_Y * zoom,
    zoom,
  };
}

/**
 * Adjust a lane/send CENTER transform (from laneCenterViewport /
 * sendBoxCenterViewport) so a just-added member occupying flow-Y
 * [memberTopY, memberTopY + memberHeightPx] is fully in view. The base transform
 * already puts the baseline at the viewport bottom, so a SHORT stack's newest
 * member is visible above it and the base is returned unchanged. When the stack
 * is TALLER than the viewport the newest member's TOP falls above the viewport;
 * in that case re-center the member vertically (keeping the lane centered
 * horizontally) so the newest tile is guaranteed on screen. Pure.
 */
export function revealMemberViewport(
  base: ViewportTransform,
  memberTopY: number,
  memberHeightPx: number,
  vp: ViewportMetrics,
): ViewportTransform {
  // screen y = flowY*zoom + base.y ⇒ the top visible flow-Y (screen y === 0):
  const visibleTopFlowY = -base.y / base.zoom;
  if (memberTopY >= visibleTopFlowY) return base; // member fully in view
  const memberCenterY = memberTopY + memberHeightPx / 2;
  return { x: base.x, y: vp.heightPx / 2 - memberCenterY * base.zoom, zoom: base.zoom };
}

// ---------------- Ordered-membership array helpers (pure, CRDT-safe) ----------------

/** Minimal node view the membership reconciler reads — the id + the scalar
 *  membership keys (`data.channel` / `data.sendSlot`). */
export interface ColumnNodeView {
  id: string;
  /** node.data.channel (1..8) — column membership truth, or undefined. */
  channel?: number;
  /** node.data.sendSlot (1|2) — send membership truth, or undefined. */
  sendSlot?: number;
}

/** De-duplicate an id array preserving FIRST occurrence order. */
export function dedup(order: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of order) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Reconcile ONE column's order array against the live membership truth
 * (`data.channel`). PURE + idempotent + collab-convergent:
 *   1. KEEP the current order, dropping ids that no longer exist OR whose
 *      data.channel !== ch (a stale/moved/deleted member), de-duped.
 *   2. ADOPT-at-bottom any node whose data.channel === ch that is MISSING from
 *      the kept order (a lost concurrent append), appended in SORTED id order so
 *      every peer converges on the same tail ordering.
 * The result is the healed order; re-running it on its own output is a no-op.
 */
export function reconcileColumnOrder(
  currentOrder: readonly string[],
  ch: number,
  nodes: ReadonlyMap<string, ColumnNodeView>,
): string[] {
  const keep = dedup(currentOrder).filter((id) => nodes.get(id)?.channel === ch);
  const present = new Set(keep);
  const adopted: string[] = [];
  for (const v of nodes.values()) {
    if (v.channel === ch && !present.has(v.id)) adopted.push(v.id);
  }
  adopted.sort();
  return [...keep, ...adopted];
}

/** Reconcile ONE send box's order array against `data.sendSlot` — the send-loop
 *  twin of reconcileColumnOrder (same prune + adopt-at-bottom discipline). */
export function reconcileSendOrder(
  currentOrder: readonly string[],
  slot: number,
  nodes: ReadonlyMap<string, ColumnNodeView>,
): string[] {
  const keep = dedup(currentOrder).filter((id) => nodes.get(id)?.sendSlot === slot);
  const present = new Set(keep);
  const adopted: string[] = [];
  for (const v of nodes.values()) {
    if (v.sendSlot === slot && !present.has(v.id)) adopted.push(v.id);
  }
  adopted.sort();
  return [...keep, ...adopted];
}

/** Append `id` at the BOTTOM of `order` (no-op if already present). */
export function insertBottom(order: readonly string[], id: string): string[] {
  return order.includes(id) ? [...order] : [...order, id];
}

/** Insert `id` at the TOP of `order` (no-op if already present). */
export function insertTop(order: readonly string[], id: string): string[] {
  return order.includes(id) ? [...order] : [id, ...order];
}

/** Remove `id` from `order`. */
export function removeFrom(order: readonly string[], id: string): string[] {
  return order.filter((x) => x !== id);
}

/**
 * Move `id` to `newIndex` within `order` (a reorder). The index is interpreted
 * against the array WITH `id` removed, so `newIndex === length-after-removal`
 * means "to the end". Clamped. No-op if `id` is absent.
 */
export function reorder(order: readonly string[], id: string, newIndex: number): string[] {
  if (!order.includes(id)) return [...order];
  const without = order.filter((x) => x !== id);
  const idx = Math.max(0, Math.min(without.length, Math.trunc(newIndex)));
  return [...without.slice(0, idx), id, ...without.slice(idx)];
}

/** Result of moving a member between two columns/boxes. */
export interface MoveResult {
  from: string[];
  to: string[];
}

/**
 * Move `id` out of `fromOrder` and append it at the bottom of `toOrder`. Used
 * for a cross-column drag (and column→send / send→column). If `id` isn't in
 * `fromOrder` it is still added to `toOrder` (the membership scalar is truth;
 * this keeps the order arrays consistent with it).
 */
export function moveBetween(
  fromOrder: readonly string[],
  toOrder: readonly string[],
  id: string,
): MoveResult {
  return { from: removeFrom(fromOrder, id), to: insertBottom(toOrder, id) };
}
