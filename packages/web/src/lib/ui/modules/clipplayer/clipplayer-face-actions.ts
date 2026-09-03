// packages/web/src/lib/ui/modules/clipplayer/clipplayer-face-actions.ts
//
// The clip player's WRITE seam — one plain-TypeScript action per gesture, used
// by BOTH surfaces (the legacy card and the v2 face's panels).
//
// ⚠ THIS IS THE `livecode` RULE APPLIED TO A LAUNCHER. The module-surfaces
// skill states it plainly: one-shot behaviour belongs in ONE action seam that
// both the legacy card and the v2 surface call, because promotion stops
// rendering the card on normal surfaces and any gesture that lives only in a
// component disappears with it while every registry test stays green. Every
// function below was a private closure inside `ClipplayerCard.svelte`; the card
// now calls these, so the two surfaces cannot drift.
//
// ⚠ SEPARATE FILE FROM THE MODEL NEXT DOOR, DELIBERATELY. `clipplayer-face-
// model.ts` is store-free and unit-testable as plain data; this half needs
// `patch` + `ydoc`. Keeping the reads pure is what lets the face's projections
// be tested without a Y.Doc, which is most of what there is to get wrong here.
//
// ⚠ EVERY MUTATION GOES THROUGH `clip-types` / `clip-scene-repeats`. Nothing
// here reimplements a write the engine or the Launchpad also performs — the
// array rebuilds below exist only because SyncedStore Y.Arrays reject index
// assignment, which is a storage fact, not a policy this file owns.

import { patch, ydoc } from '$lib/graph/store';
import { clipUndoTransact } from '$lib/control/clip-undo';
import {
  CLIP_LANES,
  clampSwing,
  coerceClipRecord,
  coerceCustomScale,
  coerceLaneColor,
  cycleVelocity,
  defaultNoteClip,
  doubleNoteClip,
  laneMono,
  laneOf,
  lanePlaying,
  laneQueued,
  slotOf,
  toggleCustomScaleNote,
  toggleLaneAutomationArm,
  toggleNoteAt,
  type ClipPlayerData,
  type NoteClipRecord,
} from '$lib/audio/modules/clip-types';
import { reconcileClipRemoval } from '$lib/audio/modules/clip-reconcile';
import { coerceSongRecState } from '$lib/audio/modules/clip-song';
import type { ScaleName } from '$lib/mike/music-theory';
import {
  RATE_DEFAULT_INDEX,
  RATE_MULTS,
  clipDivIndex,
  coerceRateIndex,
} from '$lib/audio/modules/clip-clock';
import {
  applySceneLaunchWrite,
  sceneRepeatCount,
  setSceneRepeat,
} from '$lib/audio/modules/clip-scene-repeats';
import { nextSceneRepeat } from './clipplayer-face-model';

/** The live `ClipPlayerData` of a clip-player node, or undefined. READ-ONLY —
 *  callers project it through `clipplayer-face-model`; mutation goes through
 *  the writers below. */
export function clipplayerData(nodeId: string): ClipPlayerData | undefined {
  return patch.nodes[nodeId]?.data as ClipPlayerData | undefined;
}

/** TRANSIENT write — launches, queues, arms, view state. Never undoable: the
 *  clip-undo stack is for CONTENT, and putting a launch on it would make ↶
 *  silently stop the music. */
export function writeClipplayerData(nodeId: string, mut: (d: ClipPlayerData) => void): void {
  const target = patch.nodes[nodeId];
  if (!target) return;
  ydoc.transact(() => {
    if (!target.data) target.data = {};
    mut(target.data as ClipPlayerData);
  });
}

/** PERSISTENT, UNDOABLE content write — notes, scale, length, clip-div, swing,
 *  scene repeats. Per-NODE stack (keyed by nodeId), so undoing here never
 *  reverts a sibling clip player's edit. */
export function writeClipplayerDataUndoable(
  nodeId: string,
  mut: (d: ClipPlayerData) => void,
): void {
  const target = patch.nodes[nodeId];
  if (!target) return;
  clipUndoTransact(nodeId, () => {
    if (!target.data) target.data = {};
    mut(target.data as ClipPlayerData);
  });
}

/** Rebuild-and-assign a per-lane array. SyncedStore Y.Arrays reject index
 *  assignment, so every per-lane write in this file takes this shape; it is
 *  here once rather than five times. */
function writeLaneArray<T>(
  d: ClipPlayerData,
  key: 'rate' | 'mono' | 'queued' | 'queuedImmediate' | 'laneColor',
  fill: T,
  coerce: (v: unknown) => T,
  lane: number,
  value: T,
): void {
  const base = new Array<T>(CLIP_LANES).fill(fill);
  const raw = (d as unknown as Record<string, unknown>)[key];
  if (Array.isArray(raw)) {
    for (let i = 0; i < CLIP_LANES && i < raw.length; i++) base[i] = coerce(raw[i]);
  }
  base[lane] = value;
  (d as unknown as Record<string, unknown>)[key] = base;
}

/** Set lane L's clock RATE (an index into `RATE_MULTS`). */
export function setClipplayerLaneRate(nodeId: string, lane: number, idx: number): void {
  writeClipplayerData(nodeId, (d) => {
    writeLaneArray(d, 'rate', RATE_DEFAULT_INDEX, coerceRateIndex, lane, coerceRateIndex(idx));
  });
}

/** Pick lane L's clip colour — tints its whole column, its Launchpad LEDs and
 *  (through `node.data.laneColor`) every mixmstrs channel accent in the rack. */
export function setClipplayerLaneColor(nodeId: string, lane: number, color: string): void {
  writeClipplayerData(nodeId, (d) => {
    writeLaneArray<string | null>(d, 'laneColor', null, coerceLaneColor, lane, coerceLaneColor(color));
  });
}

/** Flip lane L between MONO (replace-on-add) and POLY (stacked chord). */
export function toggleClipplayerLaneMono(nodeId: string, lane: number): void {
  writeClipplayerData(nodeId, (d) => {
    const base = new Array<boolean>(CLIP_LANES).fill(false);
    if (Array.isArray(d.mono)) {
      for (let i = 0; i < CLIP_LANES && i < d.mono.length; i++) base[i] = !!d.mono[i];
    }
    base[lane] = !base[lane];
    d.mono = base;
  });
}

/** Flip lane L's automation record ARM. Claims (or releases) that lane's
 *  single-writer through the shared seam the Launchpad gesture also uses. */
export function toggleClipplayerLaneArm(nodeId: string, lane: number): void {
  writeClipplayerData(nodeId, (d) => {
    toggleLaneAutomationArm(d, lane, ydoc.clientID);
  });
}

/** Cycle scene S's repeat count (∞ → 2 → 3 → 4 → 8 → ∞). UNDOABLE: a repeat
 *  count is content — a whole-scene copy carries it. */
export function cycleClipplayerSceneRepeat(nodeId: string, slot: number): void {
  // ⚠ THE CURRENT COUNT IS READ THROUGH THE SHARED SEAM, never off the raw map:
  // `sceneRepeatCount` is what coerces a corrupt or out-of-range stored value
  // to INFINITE, and a local re-read would let the two surfaces start their
  // cycle from different places on exactly the data that is already wrong.
  const next = nextSceneRepeat(sceneRepeatCount(clipplayerData(nodeId), slot));
  writeClipplayerDataUndoable(nodeId, (d) => {
    setSceneRepeat(d, slot, next);
  });
}

/** Queue (or stop) a lane. `immediate` is the NOW override — the launch drops
 *  next tick regardless of QNT. */
export function queueClipplayerLane(
  nodeId: string,
  lane: number,
  action: number | 'stop' | null,
  immediate = false,
): void {
  writeClipplayerData(nodeId, (d) => {
    const base: (number | 'stop' | null)[] = new Array(CLIP_LANES).fill(null);
    if (Array.isArray(d.queued)) {
      for (let i = 0; i < d.queued.length && i < CLIP_LANES; i++) base[i] = d.queued[i];
    }
    base[lane] = action;
    d.queued = base;
    if (immediate) {
      const imm = new Array<boolean>(CLIP_LANES).fill(false);
      if (Array.isArray(d.queuedImmediate)) {
        for (let i = 0; i < d.queuedImmediate.length && i < CLIP_LANES; i++) {
          imm[i] = !!d.queuedImmediate[i];
        }
      }
      imm[lane] = true;
      d.queuedImmediate = imm;
    }
  });
}

/** Create the clip at a flat index if the slot is empty. A FRESH clip owns
 *  fresh automation, so any stale sibling `auto[k]` is cleared with it. */
export function ensureClipplayerClip(nodeId: string, index: number): void {
  const d0 = clipplayerData(nodeId);
  if ((d0?.clips ?? {})[String(index)]) return;
  writeClipplayerData(nodeId, (d) => {
    if (!d.clips) d.clips = {};
    d.clips[String(index)] = defaultNoteClip();
    const key = String(index);
    if (d.auto && d.auto[key] !== undefined && d.auto[key] !== null) delete d.auto[key];
  });
}

/** LAUNCH a pad: create-and-arm an empty slot, stop a playing one, else queue
 *  it. The card's single-click gesture, verbatim. */
export function launchClipplayerPad(nodeId: string, index: number, immediate = false): void {
  const lane = laneOf(index);
  const slot = slotOf(index);
  const d = clipplayerData(nodeId);
  if (!(d?.clips ?? {})[String(index)]) {
    ensureClipplayerClip(nodeId, index);
    queueClipplayerLane(nodeId, lane, slot, immediate);
    return;
  }
  if (lanePlaying(d, lane) === slot) queueClipplayerLane(nodeId, lane, 'stop', immediate);
  else queueClipplayerLane(nodeId, lane, slot, immediate);
}

/** Fire slot S across every CONTENT lane — the grid row is the scene. */
export function launchClipplayerScene(nodeId: string, slot: number, immediate = false): void {
  writeClipplayerData(nodeId, (d) => {
    applySceneLaunchWrite(d, slot, immediate);
  });
}

/** Stop every lane (the panic button). */
export function stopAllClipplayerLanes(nodeId: string): void {
  writeClipplayerData(nodeId, (d) => {
    d.queued = new Array(CLIP_LANES).fill('stop');
  });
}

/** RESET — bump the synced nonce; every peer's engine snaps ACTIVE lanes back
 *  to step 1 and re-anchors the shared rate-phase origin. Queued launches keep. */
export function resetClipplayerLanes(nodeId: string): void {
  writeClipplayerData(nodeId, (d) => {
    d.resetNonce = (typeof d.resetNonce === 'number' ? d.resetNonce : 0) + 1;
  });
}

/** Arm/disarm SONG-REC.
 *
 * ⚠ ARMING STAMPS THIS CLIENT AS THE RECORDER, and that is not optional: the
 * song print is SINGLE-WRITER, so exactly one peer commits it. An arm written
 * without a `recorderId` arms a take nobody owns. */
export function toggleClipplayerSongRec(nodeId: string): void {
  writeClipplayerData(nodeId, (d) => {
    const cur = coerceSongRecState(d.songRec);
    if (cur?.armed) d.songRec = null;
    else d.songRec = { armed: true, mode: cur?.mode ?? 'replace', recorderId: ydoc.clientID };
  });
}

/** REPLACE ⇄ OVERDUB for SONG-REC (REPLACE = arming clears + restarts at bar 1). */
export function toggleClipplayerSongRecMode(nodeId: string): void {
  writeClipplayerData(nodeId, (d) => {
    const cur = coerceSongRecState(d.songRec) ?? {};
    d.songRec = { ...cur, mode: cur.mode === 'overdub' ? 'replace' : 'overdub' };
  });
}

/** MUTE a lane — it keeps advancing (and keeps its playhead) but emits no
 *  audio. A property of the whole lane, not a per-step value. */
export function toggleClipplayerLaneMute(nodeId: string, lane: number): void {
  writeClipplayerData(nodeId, (d) => {
    const m = new Array<boolean>(CLIP_LANES).fill(false);
    if (Array.isArray(d.muted)) {
      for (let i = 0; i < CLIP_LANES && i < d.muted.length; i++) m[i] = !!d.muted[i];
    }
    m[lane] = !m[lane];
    d.muted = m;
  });
}

/** Queue a STOP on one lane — the dedicated per-lane stop, distinct from
 *  clicking its playing pad. */
export function stopClipplayerLane(nodeId: string, lane: number): void {
  queueClipplayerLane(nodeId, lane, 'stop');
}

/** The NOTE clip at a flat index, or null. */
export function clipplayerClipAt(nodeId: string, index: number): NoteClipRecord | null {
  const rec = coerceClipRecord((clipplayerData(nodeId)?.clips ?? {})[String(index)]);
  return rec && rec.kind === 'note' ? rec : null;
}

/** Write one clip's record — undoable, and normalised to PLAIN objects so a
 *  SyncedStore proxy is never stored inside another node's document. */
export function writeClipplayerClip(nodeId: string, index: number, next: NoteClipRecord): void {
  const key = String(index);
  writeClipplayerDataUndoable(nodeId, (d) => {
    if (!d.clips) d.clips = {};
    d.clips[key] = { ...next, steps: next.steps.map((s) => ({ ...s })) };
  });
}

/**
 * DELETE the clip at a flat index — notes AND its sibling automation, in one
 * undoable transaction.
 *
 * Three deliberate choices, carried over verbatim from the card's own
 * `deleteClipAt` (its comment is the authority):
 *   1. NO CONFIRM — the write is undoable through the clip-undo stack.
 *   2. A PLAYING (or QUEUED) clip is STOPPED FIRST and IMMEDIATELY, so the lane
 *      is never left pointing at a slot whose clip no longer exists — a pad
 *      that reads lit while nothing sounds.
 *   3. The envelope belongs to the clip, so `auto[k]` goes with it.
 */
export function deleteClipplayerClip(nodeId: string, index: number): void {
  const lane = laneOf(index);
  const slot = slotOf(index);
  const d0 = clipplayerData(nodeId);
  if (lanePlaying(d0, lane) === slot || laneQueued(d0, lane) === slot) {
    queueClipplayerLane(nodeId, lane, 'stop', true);
  }
  writeClipplayerDataUndoable(nodeId, (d) => {
    const key = String(index);
    if (d.clips) delete d.clips[key];
    if (d.auto && d.auto[key] !== undefined && d.auto[key] !== null) delete d.auto[key];
  });
}

/** The clip LENGTHS the editor's step-count button cycles through, and the
 *  SCALES its scale tag cycles through. Both imported by every surface that
 *  performs the gesture rather than re-typed beside it. */
export const CLIP_LENGTH_CYCLE = [16, 32, 64, 128, 8] as const;
export const CLIP_SCALE_CYCLE: readonly (ScaleName | undefined)[] = [
  'major',
  'minor',
  'pentatonic',
  undefined,
];
/** The swing nudge — matches the Launchpad's SWING± step (coarser than 1%). */
export const SWING_STEP = 0.02;

/** Mutate one stored clip record in place, undoably. Returns nothing; a caller
 *  that needs the previous record for a scheduler reconcile reads it first. */
function editClipRecord(
  nodeId: string,
  index: number,
  mut: (c: NoteClipRecord) => void,
): void {
  const key = String(index);
  writeClipplayerDataUndoable(nodeId, (d) => {
    const c = (d.clips ?? {})[key] as NoteClipRecord | undefined;
    if (c) mut(c);
  });
}

/** Cycle the clip's SCALE (major → minor → pentatonic → chromatic). */
export function cycleClipplayerClipScale(nodeId: string, index: number): void {
  const clip = clipplayerClipAt(nodeId, index);
  if (!clip) return;
  const i = CLIP_SCALE_CYCLE.indexOf(clip.scale);
  const next = CLIP_SCALE_CYCLE[(i + 1) % CLIP_SCALE_CYCLE.length];
  editClipRecord(nodeId, index, (c) => {
    if (next) c.scale = next;
    else delete c.scale;
  });
}

/** Cycle the clip's LENGTH in steps. */
export function cycleClipplayerClipLength(nodeId: string, index: number): void {
  const clip = clipplayerClipAt(nodeId, index);
  if (!clip) return;
  const i = CLIP_LENGTH_CYCLE.indexOf(clip.lengthSteps as (typeof CLIP_LENGTH_CYCLE)[number]);
  const next = CLIP_LENGTH_CYCLE[(i + 1) % CLIP_LENGTH_CYCLE.length]!;
  editClipRecord(nodeId, index, (c) => {
    c.lengthSteps = next;
  });
}

/** Cycle the clip's OWN division (overrides the lane rate; the engine latches
 *  it at the loop boundary so a mid-loop edit never moves the current loop). */
export function cycleClipplayerClipDiv(nodeId: string, index: number): void {
  const clip = clipplayerClipAt(nodeId, index);
  if (!clip) return;
  const cur = clipDivIndex(clip, clipplayerData(nodeId), laneOf(index));
  const next = (cur + 1) % RATE_MULTS.length;
  editClipRecord(nodeId, index, (c) => {
    c.div = next;
  });
}

/** DOUBLE — copy the clip's notes into a clip of twice the length. */
export function doubleClipplayerClip(nodeId: string, index: number): void {
  const clip = clipplayerClipAt(nodeId, index);
  if (!clip) return;
  writeClipplayerClip(nodeId, index, doubleNoteClip(clip));
}

/** Nudge the clip's LANE swing by ±`SWING_STEP`, clamped into [0, MAX_SWING]. */
export function nudgeClipplayerLaneSwing(nodeId: string, index: number, dir: 1 | -1): void {
  const lane = laneOf(index);
  writeClipplayerDataUndoable(nodeId, (d) => {
    const base = new Array<number>(CLIP_LANES).fill(0);
    if (Array.isArray(d.swing)) {
      for (let i = 0; i < CLIP_LANES && i < d.swing.length; i++) base[i] = clampSwing(d.swing[i]);
    }
    base[lane] = clampSwing((base[lane] ?? 0) + dir * SWING_STEP);
    d.swing = base;
  });
}

/** EMPTY the clip's notes (and, atomically, its automation — the envelope
 *  belongs to the clip) while KEEPING the clip record. Distinct from
 *  `deleteClipplayerClip`, which removes the clip itself. */
export function emptyClipplayerClip(nodeId: string, index: number): void {
  const prev = clipplayerClipAt(nodeId, index);
  const key = String(index);
  writeClipplayerDataUndoable(nodeId, (d) => {
    const c = (d.clips ?? {})[key] as NoteClipRecord | undefined;
    if (c) c.steps = [];
    if (d.auto && d.auto[key] !== undefined && d.auto[key] !== null) delete d.auto[key];
  });
  // Every note removed → reconcile the scheduler so a voice sounding on a
  // PLAYING clip is cut NOW rather than at the next loop.
  if (prev) reconcileClipRemoval(nodeId, prev, { ...prev, steps: [] }, index, clipplayerData(nodeId));
}

/** Toggle one note on/off, honouring the lane's MONO (replace-on-add) rule, and
 *  reconcile the scheduler when the edit REMOVED a note. */
export function toggleClipplayerNote(
  nodeId: string,
  index: number,
  step: number,
  midi: number,
): void {
  const clip = clipplayerClipAt(nodeId, index);
  if (!clip) return;
  const data = clipplayerData(nodeId);
  const next = toggleNoteAt(clip, step, midi, { mono: laneMono(data, laneOf(index)) });
  writeClipplayerClip(nodeId, index, next);
  reconcileClipRemoval(nodeId, clip, next, index, clipplayerData(nodeId));
}

/** Cycle one cell's VELOCITY level (the shift-click gesture). Places a note at
 *  the default level on an empty cell, matching the Launchpad's VEL hold. */
export function cycleClipplayerNoteVelocity(
  nodeId: string,
  index: number,
  step: number,
  midi: number,
): void {
  const clip = clipplayerClipAt(nodeId, index);
  if (!clip) return;
  writeClipplayerClip(nodeId, index, cycleVelocity(clip, step, midi));
}

/** Check/uncheck one row in a lane's CUSTOM SCALE membership. */
export function toggleClipplayerScaleRow(nodeId: string, lane: number, midi: number): void {
  writeClipplayerDataUndoable(nodeId, (d) => {
    const base: (number[] | null)[] = new Array(CLIP_LANES).fill(null);
    if (Array.isArray(d.customScale)) {
      for (let i = 0; i < CLIP_LANES && i < d.customScale.length; i++) {
        base[i] = coerceCustomScale(d.customScale[i]);
      }
    }
    base[lane] = toggleCustomScaleNote(coerceCustomScale(base[lane]), midi);
    d.customScale = base;
  });
}

/** APPLY (hide every unchecked row) ⇄ REMOVE (unhide them). REMOVE KEEPS the
 *  membership set, so re-applying is one click. */
export function setClipplayerCustomScaleOn(nodeId: string, lane: number, on: boolean): void {
  writeClipplayerDataUndoable(nodeId, (d) => {
    const base = new Array<boolean>(CLIP_LANES).fill(false);
    if (Array.isArray(d.customScaleOn)) {
      for (let i = 0; i < CLIP_LANES && i < d.customScaleOn.length; i++) {
        base[i] = !!d.customScaleOn[i];
      }
    }
    base[lane] = on;
    d.customScaleOn = base;
  });
}

/** PASTE a clipboard clip (and its automation) over the slot at `index` —
 *  notes and envelopes atomically, the card's mirror of the Launchpad's
 *  `writeClipWithAuto`. A source that carried NO automation deletes the
 *  target's stale record: the envelope belongs to the clip. */
export function pasteClipplayerClip(
  nodeId: string,
  index: number,
  next: NoteClipRecord,
  auto: unknown,
): void {
  const key = String(index);
  writeClipplayerDataUndoable(nodeId, (d) => {
    if (!d.clips) d.clips = {};
    d.clips[key] = { ...next, steps: next.steps.map((s) => ({ ...s })) };
    if (!d.auto) d.auto = {};
    if (auto) d.auto[key] = auto as never;
    else if (d.auto[key] !== undefined && d.auto[key] !== null) delete d.auto[key];
  });
}
