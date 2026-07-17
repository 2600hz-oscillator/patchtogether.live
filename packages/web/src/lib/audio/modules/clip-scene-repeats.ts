// packages/web/src/lib/audio/modules/clip-scene-repeats.ts
//
// PURE model + helpers for SCENE REPEATS on the `clipplayer` module — a
// Deluge-style "play this scene N times, then move on" for the clip launcher.
// Kept out of clipplayer.ts so the count math, the next-scene selection, the
// frozen repeat unit, and the deviation (manual-interference) rules are all
// unit-testable with no engine. (This file exports no `*Def`, so the audio
// module glob ignores it.)
//
// MODEL (owner-locked semantics, 2026-07-16):
//   - Scenes loop FOREVER by default — that is "repeats: infinite", stored as
//     ABSENT/0 in `data.sceneRepeats` (a sparse per-slot map, per-KEY writes).
//     Valid set counts are 1..SCENE_REPEATS_MAX (63).
//   - ONE REPEAT = the LONGEST clip of the scene (lengthSteps × its effective
//     step duration incl. lane rate / clip div) completing a loop. The unit is
//     FROZEN at scene launch (Deluge discipline): mid-count clip-length/rate
//     edits do NOT move already-scheduled repeat boundaries. It is expressed in
//     BEATS so a tempo change simply rescales it — never wall-clock.
//   - After N repeats the engine AUTO-LAUNCHES the next scene DOWN that has
//     content (skipping empty rows) through the NORMAL quantized scene-launch
//     seam (`applySceneLaunchWrite`), so arranger-record captures it, LEDs
//     update and peers sync exactly like a hand-pressed scene button. After the
//     LAST content scene it keeps looping (deliberate divergence from Deluge's
//     stop-at-end — stage-safe for a live launcher).
//   - MANUAL ALWAYS WINS (the anti-"hostage launch" rule): any scene launch
//     re-anchors tracking to the newly-launched scene with a FRESH count (same
//     scene included), and launching an INDIVIDUAL clip outside the tracked
//     scene CANCELS tracking until the next scene launch. Muting lanes never
//     voids or alters the count (muted lanes keep advancing by design).
//
// SYNC / DETERMINISM:
//   - `data.sceneRepeats` is SYNCED content (per-key writes; duplicated with the
//     player). `data.sceneLaunch` is a tiny LWW intent marker `{slot, n}` bumped
//     in the SAME transaction as every whole-scene queued write — the
//     resetNonce-style observed counter every peer's engine re-anchors from
//     (adopt-without-fire on the first tick, so loading a patch never replays a
//     launch). The LIVE countdown itself is runtime-only render state — never
//     synced or persisted.
//   - The auto-advance write follows the queued-launch discipline: every peer
//     computes the SAME target from synced state, so concurrent writers write
//     identical content (idempotent/convergent — a duplicate application is a
//     no-op because `applyLaneQueued` only switches when the slot differs).

import {
  CLIP_LANES,
  SCENE_STRIDE,
  clipIndex,
  readClip,
  type ClipPlayerData,
} from './clip-types';
import { clipDivIndex, RATE_MULTS } from './clip-clock';

/** Highest settable repeat count. Pad 64 of the Launchpad repeat-count view maps
 *  to INFINITE (0), so the settable domain is 1..63 — a pure count, no launch
 *  modes folded into it (the Deluge one-dial −2/−1/0/N continuum is a documented
 *  footgun we deliberately avoid). */
export const SCENE_REPEATS_MAX = 63;

/** Coerce a raw stored value to a valid repeat count: an integer 1..63, else 0
 *  (= INFINITE — the default; invalid/corrupt values read as infinite). PURE. */
export function coerceSceneRepeat(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const t = Math.trunc(n);
  return t >= 1 && t <= SCENE_REPEATS_MAX ? t : 0;
}

/** Scene `slot`'s SET repeat count from node.data (0 = infinite/absent). PURE. */
export function sceneRepeatCount(
  data: { sceneRepeats?: Record<string, unknown> } | undefined,
  slot: number,
): number {
  return coerceSceneRepeat(data?.sceneRepeats?.[String(Math.trunc(slot))]);
}

/** Set scene `slot`'s repeat count IN PLACE — the ONE write seam every surface
 *  shares. PER-KEY set/delete on the sparse `sceneRepeats` map (the same merge
 *  discipline as `autoAssign` / `auto[k].tracks`): setting infinite (0/invalid)
 *  DELETES the key, so concurrent edits of DIFFERENT scenes merge key-by-key.
 *  The container itself is created at the factory load seam; the lazy init here
 *  is the defensive fallback. Call inside the caller's transaction. */
export function setSceneRepeat(d: ClipPlayerData, slot: number, count: number): void {
  const key = String(Math.max(0, Math.min(SCENE_STRIDE - 1, Math.trunc(slot))));
  const c = coerceSceneRepeat(count);
  if (!d.sceneRepeats || typeof d.sceneRepeats !== 'object') d.sceneRepeats = {};
  if (c === 0) {
    if (key in d.sceneRepeats) delete d.sceneRepeats[key];
  } else {
    d.sceneRepeats[key] = c;
  }
}

/** The card flair text for a SET count: "×N", or '' for infinite (the quieter
 *  option — infinite shows nothing). PURE; the card renders exactly this. */
export function sceneRepeatFlair(count: number): string {
  const c = coerceSceneRepeat(count);
  return c > 0 ? `×${c}` : '';
}

/** The card flair text while a scene is ACTIVELY counting: "p/N" where p is the
 *  current pass ordinal (1-based, clamped to N). PURE. */
export function sceneRepeatProgressFlair(done: number, total: number): string {
  const t = coerceSceneRepeat(total);
  if (t === 0) return '';
  const p = Math.max(1, Math.min(t, Math.trunc(done) + 1));
  return `${p}/${t}`;
}

// ---------------------------------------------------------------------------
// Scene-launch INTENT marker + the shared launch-plan/write seam.
// ---------------------------------------------------------------------------

/** Read + coerce the scene-launch intent marker `{slot, n}`, or null. PURE. */
export function readSceneLaunch(
  data: { sceneLaunch?: unknown } | undefined,
): { slot: number; n: number } | null {
  const raw = data?.sceneLaunch;
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const slot = Number(r.slot);
  const n = Number(r.n);
  if (!Number.isInteger(slot) || slot < 0 || slot >= SCENE_STRIDE) return null;
  if (!Number.isFinite(n)) return null;
  return { slot, n };
}

/** True when ANY lane holds a clip at `slot`. PURE. */
export function sceneHasContent(
  data: { clips?: Record<string, unknown> } | undefined,
  slot: number,
): boolean {
  const clips = data?.clips;
  if (!clips) return false;
  for (let lane = 0; lane < CLIP_LANES; lane++) {
    if (clips[String(clipIndex(slot, lane))]) return true;
  }
  return false;
}

/** The next scene DOWN from `fromSlot` that has content (skipping empty rows),
 *  or null when no content scene exists below — the caller keeps looping the
 *  current scene (never stops, never wraps to the top). PURE. */
export function nextContentScene(
  data: { clips?: Record<string, unknown> } | undefined,
  fromSlot: number,
): number | null {
  for (let slot = Math.trunc(fromSlot) + 1; slot < SCENE_STRIDE; slot++) {
    if (sceneHasContent(data, slot)) return slot;
  }
  return null;
}

/** Build the per-lane queued array a SCENE LAUNCH writes: `slot` where the lane
 *  holds a clip there, 'stop' where it doesn't. `anyContent` false = the scene
 *  is empty (the launch is a no-op — never a stop-all storm). PURE. */
export function sceneLaunchPlan(
  data: { clips?: Record<string, unknown> } | undefined,
  slot: number,
): { queued: (number | 'stop')[]; anyContent: boolean } {
  const queued = new Array<number | 'stop'>(CLIP_LANES).fill('stop');
  let anyContent = false;
  for (let lane = 0; lane < CLIP_LANES; lane++) {
    if (data?.clips?.[String(clipIndex(slot, lane))]) {
      queued[lane] = slot;
      anyContent = true;
    }
  }
  return { queued, anyContent };
}

/**
 * The SHARED scene-launch WRITE seam — mutate `d` IN PLACE inside the caller's
 * transaction. Every whole-scene launch path (Launchpad single Grid + pair L
 * scene column, monome scene column, and the engine's repeat auto-advance) goes
 * through here so ONE write shape carries the launch AND the `sceneLaunch`
 * intent marker every peer's repeat tracker re-anchors from:
 *   - `d.queued` = the whole per-lane plan (one transaction — the same
 *     wholesale replace stop-all uses, not 8 separate lane writes);
 *   - `d.queuedImmediate` = all-true when `immediate` (the NOW modifier);
 *   - `d.sceneLaunch` = `{slot, n: prev+1}` — a small LWW value (like
 *     resetNonce), bumped ONLY when the launch actually fires.
 * An EMPTY scene returns false and writes NOTHING (content-gated, matching the
 * dark scene button). Returns true when the launch was written.
 */
export function applySceneLaunchWrite(
  d: ClipPlayerData,
  slot: number,
  immediate: boolean,
): boolean {
  const { queued, anyContent } = sceneLaunchPlan(d, slot);
  if (!anyContent) return false;
  d.queued = queued;
  if (immediate) d.queuedImmediate = new Array<boolean>(CLIP_LANES).fill(true);
  const prev = readSceneLaunch(d);
  d.sceneLaunch = { slot: Math.trunc(slot), n: (prev?.n ?? 0) + 1 };
  return true;
}

// ---------------------------------------------------------------------------
// The FROZEN repeat unit (beats) — computed ONCE when tracking (re)anchors.
// ---------------------------------------------------------------------------

/**
 * The scene's repeat ANCHOR at launch: the lane holding the scene's LONGEST
 * clip (ties → the lowest lane) plus that loop's length in BEATS — the frozen
 * per-repeat unit. `stepsPerBeat` is the global STEP grid (STEP_DIV_SPB of the
 * player's stepDiv). A lane's effective step rate honours the same
 * `clipDivIndex` seam the engine latches (clip.div overrides the lane rate), so
 * the unit matches what the engine will actually play at launch time. Returns
 * null for an empty scene. Beats-domain on purpose: a tempo change rescales the
 * countdown; a mid-count length/rate EDIT does NOT (the unit is frozen). PURE.
 */
export function sceneRepeatAnchor(
  data: ClipPlayerData | undefined,
  slot: number,
  stepsPerBeat: number,
): { lane: number; unitBeats: number; stepBeats: number } | null {
  const spb = Number.isFinite(stepsPerBeat) && stepsPerBeat > 0 ? stepsPerBeat : 4;
  let best: { lane: number; unitBeats: number; stepBeats: number } | null = null;
  for (let lane = 0; lane < CLIP_LANES; lane++) {
    const clip = readClip(data, clipIndex(slot, lane));
    if (!clip) continue;
    // NON-NOTE clips (forward-declared 'audio'/'snapshot' shells) loop with
    // len 1 in the engine (`len = kind === 'note' ? lengthSteps : 1`) — mirror
    // that here so a scene whose only content is non-note still ANCHORS (the
    // targeting set `sceneHasContent` counts it, so the repeat chain must not
    // silently die on it). Raw junk that coerces away anchors nothing.
    const mult = RATE_MULTS[clipDivIndex(clip.kind === 'note' ? clip : null, data, lane)];
    const stepBeats = 1 / (spb * mult);
    const len = clip.kind === 'note' ? Math.max(1, clip.lengthSteps) : 1;
    const unitBeats = len * stepBeats;
    if (!best || unitBeats > best.unitBeats) best = { lane, unitBeats, stepBeats };
  }
  return best;
}

// ---------------------------------------------------------------------------
// The repeat TRACKER — pure state + transitions the engine tick drives. All of
// this is PER-PEER runtime state (never synced); peers converge through the
// `sceneLaunch` marker + the idempotent advance write.
// ---------------------------------------------------------------------------

/** Per-peer runtime tracking of the ACTIVE scene's repeat count. */
export interface SceneRepeatTrack {
  /** The tracked (active) scene slot. */
  slot: number;
  /** TRANSITION GRACE: every slot that was ACTUALLY PLAYING (synced `playing`)
   *  when this tracker anchored, other than the tracked slot — those lanes
   *  drain into the new scene at their own quantize boundaries and must not
   *  read as deviations meanwhile. Seeded from the REAL playing state (never
   *  just the prior tracker's slot — a launch made while no tracker was live,
   *  e.g. after an individual-clip cancel or a reload adopt, still gets full
   *  grace). Slots are removed as they drain; empty = full strictness. */
  prevSlots: Set<number>;
  /** The FROZEN per-repeat unit in beats (longest clip at launch). */
  unitBeats: number;
  /** The anchor lane's STEP size in beats at launch. The engine's scheduling
   *  loop processes a wrap when the pass's LAST step enters the lookahead —
   *  one step-duration BEFORE the boundary — so the advance decision widens
   *  its window by exactly this much to land the queued write ahead of that
   *  final-step scheduling (the anchor lane then applies it sample-accurately
   *  AT the boundary wrap). */
  stepBeats: number;
  /** The frozen anchor lane (the longest clip's lane at launch) — used to pin
   *  `startBeat` to the actual audible switch boundary. */
  anchorLane: number;
  /** Whether the scene has audibly STARTED (its anchor lane switched to it). */
  started: boolean;
  /** The engine beat-clock reading at the scene's start boundary. */
  startBeat: number;
}

/** A fresh tracker anchored to a just-launched scene. `playing` = the SYNCED
 *  per-lane playing set at anchor time — every slot still playing (≠ the new
 *  scene) becomes transition grace, so the launch survives its own first-tick
 *  deviation check regardless of what tracker (if any) came before. PURE. */
export function anchorSceneRepeatTrack(
  data: ClipPlayerData | undefined,
  slot: number,
  stepsPerBeat: number,
  playing: readonly (number | null)[] | undefined,
): SceneRepeatTrack | null {
  const anchor = sceneRepeatAnchor(data, slot, stepsPerBeat);
  if (!anchor) return null; // empty scene — nothing to track
  const prevSlots = new Set<number>();
  for (let lane = 0; lane < CLIP_LANES; lane++) {
    const p = playing?.[lane];
    if (typeof p === 'number' && p !== slot) prevSlots.add(p);
  }
  return {
    slot,
    prevSlots,
    unitBeats: anchor.unitBeats,
    stepBeats: anchor.stepBeats,
    anchorLane: anchor.lane,
    started: false,
    startBeat: 0,
  };
}

/** Completed repeats of a STARTED tracker at `beatClock` (0 before start).
 *  Epsilon-forgiving so a boundary read lands on the boundary's pass. PURE. */
export function sceneRepeatsDone(track: SceneRepeatTrack, beatClock: number): number {
  if (!track.started || track.unitBeats <= 0) return 0;
  return Math.max(0, Math.floor((beatClock - track.startBeat) / track.unitBeats + 1e-6));
}

/**
 * MANUAL-INTERFERENCE detector (the deliberate, deterministic cancel): true
 * when the synced queued/playing state shows a lane launched OUTSIDE the
 * tracked scene — an individual clip launch (or any launch path that bypassed
 * the scene seam). Rules:
 *   - a QUEUED slot number ≠ the tracked slot → deviation;
 *   - a PLAYING slot number ≠ the tracked slot AND ≠ prevSlot (lanes still
 *     draining the previous scene during the transition are fine) → deviation;
 *   - per-lane STOPs and MUTEs are NOT deviations (mute never voids the count;
 *     a stopped lane just leaves the frozen schedule to the remaining lanes).
 * PURE.
 */
export function sceneRepeatDeviates(
  track: Pick<SceneRepeatTrack, 'slot' | 'prevSlots'>,
  queued: readonly (number | 'stop' | null)[] | undefined,
  playing: readonly (number | null)[] | undefined,
): boolean {
  for (let lane = 0; lane < CLIP_LANES; lane++) {
    const q = queued?.[lane];
    if (typeof q === 'number' && q !== track.slot) return true;
    const p = playing?.[lane];
    if (typeof p === 'number' && p !== track.slot && !track.prevSlots.has(p)) return true;
  }
  return false;
}

/** Remove DRAINED slots from the transition grace set IN PLACE: a grace slot
 *  no lane still plays or queues is deleted, so a later manual launch INTO an
 *  old scene reads as the deviation it is. Call once per tick. PURE mutation
 *  of the tracker's set. */
export function drainScenePrevSlots(
  track: Pick<SceneRepeatTrack, 'prevSlots'>,
  queued: readonly (number | 'stop' | null)[] | undefined,
  playing: readonly (number | null)[] | undefined,
): void {
  if (track.prevSlots.size === 0) return;
  for (const s of [...track.prevSlots]) {
    let live = false;
    for (let lane = 0; lane < CLIP_LANES; lane++) {
      if (queued?.[lane] === s || playing?.[lane] === s) {
        live = true;
        break;
      }
    }
    if (!live) track.prevSlots.delete(s);
  }
}

/** True when a STARTED tracked scene has NO lane EFFECTIVELY playing it any
 *  more — every scene lane is stopped OR carries a PENDING manual 'stop'
 *  (per-lane stops / stop-all). Tracking cancels so a silent (or about-to-be-
 *  silent) rack never surprise-launches the next scene N units later — and the
 *  pending-stop check matters because the advance decision runs in the
 *  scheduler lookahead, BEFORE a queued stop applies: without it the advance's
 *  whole-scene write could clobber the user's stop-all (manual always wins).
 *  A lane with a pending (re)launch of the scene still counts as playing. PURE. */
export function sceneAllLanesStopped(
  track: Pick<SceneRepeatTrack, 'slot' | 'started'>,
  queued: readonly (number | 'stop' | null)[] | undefined,
  playing: readonly (number | null)[] | undefined,
): boolean {
  if (!track.started) return false;
  for (let lane = 0; lane < CLIP_LANES; lane++) {
    const q = queued?.[lane];
    if (q === track.slot) return false; // pending (re)launch of the scene
    if (playing?.[lane] === track.slot && q !== 'stop') return false; // playing, no pending stop
  }
  return true;
}

/**
 * The advance DECISION for one tick: with N set (finite), the advance fires
 * when the frozen boundary `startBeat + N*unitBeats` falls inside the
 * scheduler's lookahead window, so the queued write lands BEFORE any lane's
 * scheduling loop processes that boundary wrap (each lane then applies it at
 * its own next loop boundary — the normal QNT behavior; for equal-length clips
 * that IS the section boundary, sample-accurately). N is read FRESH from the
 * synced count each evaluation — a mid-count edit applies at the next boundary
 * evaluation (latched: lowering N below the already-elapsed count advances at
 * the NEXT boundary, never retroactively; raising N moves the boundary out).
 * There is deliberately NO one-shot latch: when no content scene exists below,
 * the caller simply finds no target and re-evaluates next tick — so raising N
 * or ADDING a content scene later re-arms the advance instead of dying on a
 * missed moment. A successful advance re-anchors the tracker, which naturally
 * ends this scene's evaluations. PURE.
 */
export function sceneRepeatShouldAdvance(
  track: SceneRepeatTrack,
  count: number,
  beatClock: number,
  lookaheadBeats: number,
): boolean {
  const n = coerceSceneRepeat(count);
  if (n === 0) return false; // infinite — never advance
  if (!track.started || track.unitBeats <= 0) return false;
  const boundary = track.startBeat + n * track.unitBeats;
  return beatClock + Math.max(0, lookaheadBeats) >= boundary;
}
