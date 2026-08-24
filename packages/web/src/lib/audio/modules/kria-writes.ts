// packages/web/src/lib/audio/modules/kria-writes.ts
//
// THE ONE WRITE SEAM for kria's sequencer state.
//
// `kria-types.ts` owns the arithmetic and is pure (no store, no Y.Doc). This
// file owns the WRITES, and it is the only module that touches `node.data` for
// kria. Three surfaces call it — the legacy card, the faceplate's step-grid
// panel and its band cells, and the monome grid bridge — which is what makes
// "the grid path and the face write the same keys through the same helper" a
// property of the code rather than a thing to re-verify.
//
// ==========================================================================
// TWO DEFECTS THIS FILE EXISTS TO CLOSE, both of which were present TWICE
// ==========================================================================
//
// (1) EVERY SEQUENCER EDIT WAS OUTSIDE Cmd-Z. `KriaCard.svelte`'s `writeData`
//     and `kria-grid.svelte.ts`'s `mutateTrack` each called `ydoc.transact(fn)`
//     with NO origin argument. `store.ts` configures the UndoManager with
//     `trackedOrigins: new Set([LOCAL_ORIGIN])`, so an untagged transaction
//     (origin `null`) is silently not captured: every step click, every pattern
//     cue, every seeded slot was un-undoable. Three lines away in the same
//     card, `setNodeParam` was correctly tagged — so the BPM knob and the RUN
//     button were undoable while the instrument was not. No gate could see it:
//     `mutate.guard.test.ts` anchors its regex on the literal token `.params`,
//     and this whole module's state lives in `.data`.
//
//     Everything here routes `mutateNode`, which defaults to `LOCAL_ORIGIN`.
//
// (2) ONE CELL CLICK REWROTE THE WHOLE PATTERN. Both call sites deep-cloned all
//     four tracks and assigned `d.patterns[slot] = {…}` — four tracks × seven
//     lanes × sixteen steps per click. In a multiplayer product that is not
//     merely wasteful: two collaborators editing DIFFERENT TRACKS of the same
//     pattern overwrote each other, because last-writer-wins applied to the
//     whole object.
//
//     `writeTrackDiff` writes only the cells that actually changed.
//
// ==========================================================================
// ⚠ WHAT IS AND IS NOT ASSIGNABLE — MEASURED, not reasoned
// ==========================================================================
// `node.data` rides SyncedStore, so everything nested under it is a live Y
// type behind a proxy. Measured against a real store before this was written:
//
//   `track.trig[step] = v`          THROWS "array assignment is not
//                                   implemented / supported" — a nested step
//                                   lane is a live Y.Array.
//   `track.trig.splice(step, 1, v)` WORKS, persists, and leaves length 16.
//   `track.loopLength = 8`          WORKS — a per-track scalar is a Y.Map key.
//   `pattern.scale = 'minor'`       WORKS — same reason.
//   `bank['0'] = {…plain object…}`  WORKS — which is why the bank is a
//                                   string-keyed RECORD (kria-types.ts:135).
//
// So the granular write is splice-per-step plus direct assignment per scalar,
// and NO persistence migration is required. The deep clone the old call sites
// used is not "wrong" — reassigning a live Y type at two paths is a real hazard
// — it was simply reaching for a whole-object swap where a keyed write exists.

import { mutateNode } from '$lib/graph/mutate';
import {
  KRIA_PATTERNS,
  KRIA_STEPS,
  KRIA_TRACKS,
  activePattern,
  coerceScale,
  coerceTrack,
  defaultPattern,
  slotOccupied,
  type KriaData,
  type KriaPattern,
  type KriaPatternBank,
  type KriaScaleName,
  type KriaTrack,
} from './kria-types';

/**
 * The origin for NAVIGATION writes — which track/lane you are looking at.
 *
 * ⚠ A DELIBERATELY NON-TRACKED ORIGIN, and the distinction is the point.
 * The selection has to live in `node.data` (a cell's `value(node)` receives
 * only the node, and component state does not survive a dock collapse or an
 * LRU eviction) — but navigating is not editing. Tagged LOCAL_ORIGIN, Cmd-Z
 * would walk back through every track button you pressed instead of through
 * the notes you wrote. `mutate.ts` takes `{ origin }` for exactly this.
 */
export const KRIA_VIEW_ORIGIN = Symbol('kria-view');

/** Per-step lanes — the arrays that need `splice`. */
const STEP_LANES = [
  'trig', 'ratchet', 'note', 'octave', 'duration', 'probability', 'glide',
] as const satisfies readonly (keyof KriaTrack)[];

/** Per-track scalars — plain Y.Map keys, directly assignable. */
const TRACK_SCALARS = [
  'loopStart', 'loopLength', 'timeDivision', 'direction', 'muted',
] as const satisfies readonly (keyof KriaTrack)[];

/** Clamp a slot index into the bank. */
function slotIndex(n: unknown): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(KRIA_PATTERNS - 1, v));
}

/** Clamp a track index. */
export function trackIndex(n: unknown): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(KRIA_TRACKS - 1, v));
}

/**
 * Ensure `data.patterns` and the ACTIVE slot exist, and return the LIVE pattern
 * object (a Y.Map proxy) to mutate in place. Seeding an empty slot is a CREATE,
 * so it assigns a whole plain object — the one place that is correct.
 */
function liveActivePattern(d: KriaData): Record<string, unknown> | null {
  if (!d.patterns || typeof d.patterns !== 'object') d.patterns = {} as KriaPatternBank;
  const slot = String(slotIndex(d.active ?? 0));
  const bank = d.patterns as unknown as Record<string, unknown>;
  if (!bank[slot]) bank[slot] = defaultPattern();
  const pat = bank[slot];
  return pat && typeof pat === 'object' ? (pat as Record<string, unknown>) : null;
}

/**
 * Write `next` onto the LIVE track, touching only what differs.
 *
 * The diff is what makes concurrent editing safe: peer A moving track 3's loop
 * length no longer transmits (and therefore no longer overwrites) peer B's
 * track-1 note edit, because A's transaction contains one key.
 */
function writeTrackDiff(live: Record<string, unknown>, next: KriaTrack): void {
  for (const lane of STEP_LANES) {
    const arr = live[lane];
    if (!Array.isArray(arr)) {
      // Absent or corrupt on an older save — seed the whole lane once.
      live[lane] = (next[lane] as unknown[]).slice();
      continue;
    }
    const want = next[lane] as unknown[];
    for (let i = 0; i < KRIA_STEPS; i++) {
      if (arr[i] !== want[i]) arr.splice(i, 1, want[i]);
    }
  }
  for (const key of TRACK_SCALARS) {
    if (live[key] !== next[key]) live[key] = next[key];
  }
}

/**
 * Apply a pure track mutator to track `t` of the ACTIVE pattern of `nodeId`.
 *
 * `fn` receives the coerced track and returns a NEW one (the `kria-types`
 * helper shape). Returning `null` — which `applyLaneEdit` does for an inert
 * grid row — writes nothing and opens no undo entry.
 */
export function editKriaTrack(
  nodeId: string,
  t: number,
  fn: (track: KriaTrack) => KriaTrack | null,
): void {
  const idx = trackIndex(t);
  mutateNode(nodeId, (node) => {
    if (!node.data) node.data = {};
    const d = node.data as KriaData;
    const pat = liveActivePattern(d);
    if (!pat) return;
    const tracks = pat.tracks;
    if (!Array.isArray(tracks)) return;
    const liveTrack = tracks[idx];
    if (!liveTrack || typeof liveTrack !== 'object') return;
    const next = fn(coerceTrack(liveTrack));
    if (!next) return;
    writeTrackDiff(liveTrack as Record<string, unknown>, next);
  });
}

/** Set the ACTIVE pattern's shared scale. */
export function setKriaScale(nodeId: string, scale: KriaScaleName): void {
  mutateNode(nodeId, (node) => {
    if (!node.data) node.data = {};
    const pat = liveActivePattern(node.data as KriaData);
    if (!pat) return;
    const v = coerceScale(scale);
    if (pat.scale !== v) pat.scale = v;
  });
}

/** Set the ACTIVE pattern's MIDI root. */
export function setKriaRoot(nodeId: string, midi: number): void {
  mutateNode(nodeId, (node) => {
    if (!node.data) node.data = {};
    const pat = liveActivePattern(node.data as KriaData);
    if (!pat) return;
    const v = Math.round(Number(midi));
    if (Number.isFinite(v) && pat.root !== v) pat.root = v;
  });
}

/**
 * Tap a pattern slot: seed-and-activate an empty one, clear the cue when the
 * ACTIVE slot is re-tapped, otherwise CUE it for a quantized switch.
 */
export function selectKriaPattern(nodeId: string, slot: number): void {
  const s = slotIndex(slot);
  mutateNode(nodeId, (node) => {
    if (!node.data) node.data = {};
    const d = node.data as KriaData;
    if (!d.patterns || typeof d.patterns !== 'object') d.patterns = {} as KriaPatternBank;
    if (!slotOccupied(d, s)) {
      (d.patterns as unknown as Record<string, unknown>)[String(s)] = defaultPattern();
      d.active = s;
      d.cued = null;
      return;
    }
    if ((d.active ?? 0) === s) d.cued = null;
    else d.cued = s;
  });
}

// ── VIEW STATE (non-undoable by design — see KRIA_VIEW_ORIGIN) ──────────────

/** The selected track, lane and view, persisted so the band cells and the grid
 *  panel cannot disagree about which track is on screen. */
export interface KriaView {
  selTrack?: number;
  selLane?: string;
  showPatterns?: boolean;
}

function writeView(nodeId: string, patch: KriaView): void {
  mutateNode(
    nodeId,
    (node) => {
      if (!node.data) node.data = {};
      const d = node.data as Record<string, unknown>;
      for (const [k, v] of Object.entries(patch)) {
        if (d[k] !== v) d[k] = v;
      }
    },
    { origin: KRIA_VIEW_ORIGIN },
  );
}

export function selectKriaTrack(nodeId: string, t: number): void {
  writeView(nodeId, { selTrack: trackIndex(t) });
}
export function selectKriaLane(nodeId: string, lane: string): void {
  writeView(nodeId, { selLane: lane, showPatterns: false });
}
export function showKriaPatterns(nodeId: string, on: boolean): void {
  writeView(nodeId, { showPatterns: !!on });
}

/** Read the selected track index off a node (0 when unset). */
export function readSelTrack(data: KriaData | undefined): number {
  return trackIndex((data as { selTrack?: number } | undefined)?.selTrack ?? 0);
}

/** The coerced ACTIVE pattern of a node's data, never null. */
export function readActivePattern(data: KriaData | undefined): KriaPattern {
  return activePattern(data) ?? defaultPattern();
}

/** The coerced SELECTED track of a node's data, never null. */
export function readSelectedTrack(data: KriaData | undefined): KriaTrack {
  const pat = readActivePattern(data);
  return coerceTrack(pat.tracks[readSelTrack(data)]);
}
