// packages/web/src/lib/ui/modules/clipplayer/clipplayer-face-model.ts
//
// The PURE view model behind the clip player's v2 face — one projection of
// `node.data` per surface the faceplate paints, and nothing else.
//
// ⚠ WHY IT EXISTS SEPARATELY FROM THE CARD. `ClipplayerCard.svelte` is 3,652
// lines and every one of these projections is currently an inline `$derived`
// inside it, reachable only by mounting the card. The face paints the SAME
// states from FIVE different components (the launch panel, the four per-lane /
// per-scene rows, the tile strip), so the projection has to leave the
// component or be re-typed five times — and a re-typed pad state is exactly
// the "the card and the face disagree about what is playing" defect the whole
// faces programme keeps finding.
//
// ⚠ PURE, AND DELIBERATELY STORE-FREE. Nothing here imports `$lib/graph/store`
// (the WRITES live next door in `clipplayer-face-actions.ts`), so every clause
// below is a plain function of a plain object and its unit test needs no
// browser, no Y.Doc and no engine. The split is the wavecel/samsloop
// `*-actions` convention, applied to a module whose reads are the harder half.
//
// ⚠ AND IT IS A PROJECTION, NOT A SECOND SOURCE OF TRUTH. Every clause
// delegates to the shared `clip-types` / `clip-clock` / `clip-scene-repeats`
// seams the ENGINE and the Launchpad already read — `lanePlaying`,
// `laneQueued`, `laneMono`, `laneRateIndex`, `sceneRepeatCount`,
// `armedAutomationLanes`, `laneColorEff`. There is no arithmetic here that the
// card could disagree with, because there is no arithmetic here at all.

import {
  CLIP_LANES,
  CLIP_SLOTS,
  armedAutomationLanes,
  autoAssignCounts,
  autoClipHasTracks,
  clipIndex,
  clipPadState,
  coerceClipRecord,
  laneColorEff,
  laneMono,
  laneMuted,
  laneOf,
  lanePlaying,
  laneQueued,
  slotOf,
  type ClipPadState,
  type ClipPlayerData,
} from '$lib/audio/modules/clip-types';
import { RATE_LABELS, laneRateIndex } from '$lib/audio/modules/clip-clock';
import { sceneRepeatCount, sceneRepeatFlair } from '$lib/audio/modules/clip-scene-repeats';

/**
 * WHERE the right-click menu was opened and WHAT it acts on.
 *
 * A `clip` open comes from a launcher PAD and scopes every row to the whole
 * clip; a `note` open comes from a piano-roll CELL and scopes the three
 * probability rows to that one note. Both carry the target clip's FLAT INDEX —
 * never a "selected" clip, because a pad menu is routinely opened on a pad that
 * is not the one loaded in the editor.
 *
 * ⚠ IT LIVES IN THE MODEL, NOT IN THE MENU COMPONENT, because three surfaces
 * hold one of these in their own `$state` (the card, the launch panel, the note
 * panel) and a `<script lang="ts">` cannot export a type to them.
 */
export type ClipplayerMenuAt =
  | { kind: 'note'; x: number; y: number; idx: number; step: number; midi: number; row: number }
  | { kind: 'clip'; x: number; y: number; idx: number };

/** A launch-grid pad's four painted states.
 *
 *  ⚠ AN ALIAS OF THE SHARED `ClipPadState`, NOT A SECOND DECLARATION. The
 *  legacy card and this face paint the SAME grid, and while each owned its own
 *  copy of the ladder they had already drifted on its last clause — see
 *  `clipPadState` in `clip-types`. Re-typing the union here would let them
 *  drift again in the type as well as the logic. */
export type ClipplayerPadState = ClipPadState;

/** One pad of the 8×8 launch grid. */
export interface ClipplayerPadView {
  /** Flat clip index — `clipIndex(slot, lane)`, the key `data.clips` uses. */
  index: number;
  lane: number;
  slot: number;
  state: ClipplayerPadState;
  /** The clip carries recorded automation (the teal corner dot). */
  hasAuto: boolean;
  /** There is a clip in this slot at all — the predicate the pad's TOOLTIP and
   *  its right-click menu must share, so the tooltip can never promise a menu
   *  that will not open. */
  hasClip: boolean;
}

/** One instrument lane (a COLUMN of the launch grid). */
export interface ClipplayerLaneView {
  lane: number;
  /** The EFFECTIVE colour — the picked colour, else the lane's default hue.
   *  Always a concrete `#rrggbb`, never null, so a caller cannot paint a lane
   *  with no colour at all. */
  color: string;
  /** MONO = one note per column (replace-on-add). POLY = a stacked chord. An
   *  EDIT-TIME constraint: the engine never reads it. */
  mono: boolean;
  /** Index into `RATE_LABELS` / `RATE_MULTS`. */
  rate: number;
  rateLabel: string;
  /** This lane's automation record arm (per-lane, continuous overdub). */
  armed: boolean;
  muted: boolean;
  /** How many MODULES are assigned to this lane's automation. */
  assigned: number;
  /** The slot currently sounding, or null. */
  playing: number | null;
  /** The pending launch: a slot index, `'stop'`, or null for nothing pending. */
  queued: number | 'stop' | null;
}

/** One scene (a ROW of the launch grid) and its repeat count. */
export interface ClipplayerSceneView {
  slot: number;
  /** 0 = infinite (the quiet default), else the finite pass count. */
  count: number;
  /** The painted flair — `∞` for infinite, `×N` otherwise. NOT the live
   *  progress: `p/N` is engine state and belongs to the body's poll, never to
   *  a pure projection of stored data. */
  label: string;
}

/** How a pad paints, from stored data alone.
 *
 *  ⚠ THE PRECEDENCE IS LOAD-BEARING AND IT IS NOT ALPHABETICAL. A queued slot
 *  reads `queued` even when it is the playing one, because a pending STOP on
 *  the playing pad is the single most important thing the grid can tell you —
 *  and `lanePlaying === slot` is true throughout it. */
export function clipplayerPadState(
  data: ClipPlayerData | undefined,
  index: number,
): ClipplayerPadState {
  // ⚠ DELEGATES. THE LADDER IS NOT RE-TYPED HERE, AND A GATE ENFORCES THAT.
  //
  // This face and the legacy `ClipplayerCard` paint the same 8×8 grid, and
  // while each carried its own copy of the precedence ladder they had ALREADY
  // drifted on the last clause: the card asked `clips[k] ? …` (raw truthiness)
  // while this asked `coerceClipRecord(clips[k]) !== null`. A record that
  // coerces away — the retired stamped `kind:'automation'` clip, any junk —
  // painted LOADED on the card and EMPTY on the face. The coerced reading won
  // and moved into `clip-types`, where both surfaces read it.
  //
  // `clip-pad-state.test.ts` source-scans the clipplayer surfaces and reddens
  // on one that writes the `queued === slot` rung itself, so this cannot
  // silently become a second copy again.
  return clipPadState(data, index);
}

/** The NOTE clip stored at a flat index, or null. Coerced through the shared
 *  reader so a malformed record reads as absent rather than throwing into the
 *  render. */
function clipRecordAt(data: ClipPlayerData | undefined, index: number): unknown {
  const rec = (data?.clips ?? {})[String(index)];
  return rec ? coerceClipRecord(rec) : null;
}

/** Every pad of the visible 8×8 grid, in FLAT INDEX order.
 *
 *  ⚠ FLAT ORDER, NOT ROW-MAJOR-BY-SLOT, because `clipIndex(slot, lane)` is the
 *  storage key and the caller lays out by `lane`/`slot` off the view. Handing
 *  back a nested array would put a second layout opinion in the model. */
export function clipplayerPadViews(data: ClipPlayerData | undefined): ClipplayerPadView[] {
  const auto = (data as { auto?: Record<string, unknown> } | undefined)?.auto ?? {};
  const out: ClipplayerPadView[] = [];
  for (let lane = 0; lane < CLIP_LANES; lane++) {
    for (let slot = 0; slot < CLIP_SLOTS; slot++) {
      const index = clipIndex(slot, lane);
      out.push({
        index,
        lane,
        slot,
        state: clipplayerPadState(data, index),
        hasAuto: autoClipHasTracks(auto[String(index)]),
        hasClip: clipRecordAt(data, index) !== null,
      });
    }
  }
  return out;
}

/** All eight lanes.
 *
 *  `exists` filters DANGLING automation assignments (a module that has since
 *  been deleted) out of the `assigned` count — the same guard the card's chip
 *  row takes, so the face can never count a ghost while the prune catches up.
 *  Omitted = count every stored assignment. */
export function clipplayerLaneViews(
  data: ClipPlayerData | undefined,
  exists?: (moduleId: string) => boolean,
): ClipplayerLaneView[] {
  const arms = armedAutomationLanes(data);
  const assigned = autoAssignCounts(data, exists);
  const out: ClipplayerLaneView[] = [];
  for (let lane = 0; lane < CLIP_LANES; lane++) {
    const rate = laneRateIndex(data, lane);
    out.push({
      lane,
      color: laneColorEff(data, lane),
      mono: laneMono(data, lane),
      rate,
      rateLabel: RATE_LABELS[rate] ?? RATE_LABELS[3]!,
      armed: !!arms[lane],
      muted: laneMuted(data, lane),
      assigned: assigned[lane] ?? 0,
      playing: lanePlaying(data, lane),
      queued: laneQueued(data, lane),
    });
  }
  return out;
}

/** All eight scenes. */
export function clipplayerSceneViews(data: ClipPlayerData | undefined): ClipplayerSceneView[] {
  const out: ClipplayerSceneView[] = [];
  for (let slot = 0; slot < CLIP_SLOTS; slot++) {
    const count = sceneRepeatCount(data, slot);
    out.push({ slot, count, label: count === 0 ? '∞' : sceneRepeatFlair(count) });
  }
  return out;
}

/**
 * The repeat counts the card's click gesture cycles through, in order.
 *
 * ⚠ IMPORTED BY BOTH SURFACES, NEVER RE-TYPED. The legacy card owns this
 * gesture today (`cycleSceneRepeat`, `ClipplayerCard.svelte`) and the face's
 * scene row performs the identical one; two copies of the ring would let the
 * two surfaces disagree about what the NEXT press does, which is the class of
 * divergence `card-def-debt` exists to record and this seam exists to prevent.
 * 0 is INFINITE and is deliberately first: the cycle starts and ends at the
 * quiet default.
 */
export const SCENE_REPEAT_CYCLE = [0, 2, 3, 4, 8] as const;

/** The next repeat count after `cur` in the card's cycle. An unrecognised
 *  count (a Launchpad-set 1–63 that is not on the ring) falls to the ring's
 *  FIRST entry — infinite — rather than to `cur`, so the gesture is never a
 *  no-op on a scene the hardware configured. */
export function nextSceneRepeat(cur: number): number {
  const i = SCENE_REPEAT_CYCLE.indexOf(cur as (typeof SCENE_REPEAT_CYCLE)[number]);
  if (i < 0) return SCENE_REPEAT_CYCLE[0];
  return SCENE_REPEAT_CYCLE[(i + 1) % SCENE_REPEAT_CYCLE.length]!;
}

/** Does the rack hold a clip in ANY slot? Drives the launch panel's empty
 *  state — a grid of 64 identical dark squares says nothing about whether the
 *  instrument is loaded or the patch is new. */
export function clipplayerHasAnyClip(data: ClipPlayerData | undefined): boolean {
  const clips = data?.clips ?? {};
  for (const k of Object.keys(clips)) {
    if (clipRecordAt(data, Number(k)) !== null) return true;
  }
  return false;
}

/** How many lanes are sounding right now — the tile strip's one number, and
 *  the only thing a 192 px tile can honestly say about a 64-slot launcher. */
export function clipplayerPlayingLaneCount(data: ClipPlayerData | undefined): number {
  let n = 0;
  for (let lane = 0; lane < CLIP_LANES; lane++) {
    if (lanePlaying(data, lane) !== null) n++;
  }
  return n;
}
