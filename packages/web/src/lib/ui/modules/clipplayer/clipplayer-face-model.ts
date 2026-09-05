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
  audioRecState,
  clipHasAudio,
  clipIndex,
  clipPadState,
  coerceClipRecord,
  laneColorEff,
  laneMono,
  laneMuted,
  laneOf,
  lanePlaying,
  laneQueued,
  laneRecArm,
  laneRecMode,
  slotOf,
  type ClipPadState,
  type ClipPlayerData,
  type ClipRecord,
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

/** A launch-grid pad's four painted states — the SHARED type, re-exported under
 *  this file's own name so the face's callers need not learn a second one.
 *
 *  ⚠ AN ALIAS, NOT A COPY. `ClipPadState` is the one definition; declaring the
 *  union again here is how the card and the face come to disagree about what is
 *  playing, which is the whole reason `clip-pad-state` exists. */
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
  /** CLAUSE 7 — this slot holds RECORDED AUDIO, which earns the pad its PURPLE
   *  BORDER.
   *
   *  ⚠ A FLAG, NOT A `ClipplayerPadState` RUNG, and the distinction is
   *  load-bearing. The state ladder is a PRIORITY chain: `playing` and `queued`
   *  outrank `loaded`, so a recorded clip would lose its border the instant it
   *  sounded — exactly when a player most needs to see which clips hold takes.
   *  "Holds audio" is orthogonal to "what is this pad doing right now", so it
   *  is painted as an overlay on top of whatever state the pad is in. It also
   *  keeps `clipPadState` — and its cross-surface agreement pin — untouched. */
  hasAudio: boolean;
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
  /** CLAUSE 3 — this lane's AUDIO record toggle. ⚠ Distinct from `armed`
   *  above, which is the AUTOMATION arm: two recorders that look alike and are
   *  not, each keeping its own field (the same separation `noteRec` /
   *  `automation` / `audioRec` already settled on). */
  recArmed: boolean;
  /** CLAUSE 5 — this lane's CLIP-vs-ENDLESS switch. `'single'` is the owner's
   *  CLIP: record exactly one loop, then stop. */
  recMode: 'single' | 'endless';
  /** Whether this lane is mid-take, so the surface can show the toggle as
   *  actively recording rather than merely armed. */
  recPhase: 'idle' | 'armed' | 'recording' | 'stopping';
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

/**
 * How a pad paints, from stored data alone — DELEGATED to the shared ladder.
 *
 * ⚠ THIS USED TO RE-TYPE THE LADDER, and that is a merge-order collision rather
 * than an oversight: #2326 authored this function against a tree where the
 * shared `clipPadState` did not exist yet, and #2329 landed that helper (plus
 * the scan that forbids a second copy) an hour earlier. Neither PR ran the
 * other's tests, so main went red on `clip-pad-state.test.ts` — "a clipplayer
 * surface computes pad state itself instead of calling clipPadState".
 *
 * The two implementations were line-for-line identical in precedence (queued
 * beats playing; a pending STOP on the playing pad reads queued), differing
 * only in how the last rung asks whether a clip exists — `clipRecordAt` here
 * versus `readClip` there, both of which coerce and both of which answer null
 * for a malformed record. So this is behaviour-preserving by inspection, and
 * `clipplayer-face-model.test.ts`'s own four pad-state cases pin it.
 *
 * Kept as a named wrapper rather than deleted: the face's callers already
 * import this name, and a thin delegation is the seam the scan is asking for.
 */
export function clipplayerPadState(
  data: ClipPlayerData | undefined,
  index: number,
): ClipplayerPadState {
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
        hasAudio: clipHasAudio(clipRecordAt(data, index) as ClipRecord | null),
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
      recArmed: laneRecArm(data, lane),
      recMode: laneRecMode(data, lane),
      recPhase: audioRecState(data, lane)?.phase ?? 'idle',
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
