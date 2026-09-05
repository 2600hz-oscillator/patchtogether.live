// packages/web/src/lib/ui/modules/clipplayer/clipplayer-face-selection.svelte.ts
//
// WHICH CLIP the face's piano roll is editing — shared between the LAUNCH
// panel (where you double-click a pad to open it) and the NOTE panel (which
// draws it), which are registered as two INDEPENDENT shell cells and therefore
// cannot share component state directly. The dx7 map/detail precedent
// (`dx7-selection.svelte.ts`), applied to a launcher.
//
// ⚠ DELIBERATELY NOT IN `node.data`, and the spec is explicit about why: the
// card's `cardView` and its clip selection are "personal authoring lenses" —
// syncing them would move a collaborator's screen mid-edit. Keyed by nodeId so
// two clip players in one rack keep separate selections.
//
// ⚠ NODE-KEYED, NOT COMPONENT-STATE, which is the whole point (#1531/#1574/
// #1583): the dock full view and the lane tile mount and unmount around the
// same node constantly, and a selection held in either component would reset
// every time the dock collapsed. It survives unmount because it is not owned
// by a mount.

import { SvelteMap } from 'svelte/reactivity';
import { patch } from '$lib/graph/store';
import { CLIP_LANES, SCENE_STRIDE, laneOf, slotOf } from '$lib/audio/modules/clip-types';

const selection = new SvelteMap<string, number>();

/** PER-LANE selected slot, per node — `nodeId → slot[CLIP_LANES]`.
 *
 * ⚠ THE FLAT SELECTION ABOVE CANNOT ANSWER CLAUSE 2. The owner's rule is
 * "audio is recorded into the SELECTED CLIP of a lane", and the record toggle
 * is per lane — so every lane needs a selected slot AT THE SAME TIME. One flat
 * index names exactly one (lane, slot) pair, so it can only answer for the lane
 * it happens to sit in; asking it for lane 5's selection while the editor is on
 * lane 2 has no answer at all.
 *
 * So this map remembers, per lane, the last slot selected IN that lane. The
 * flat `selection` is unchanged and still drives the editor — the two are
 * written together by `clipplayerSelectClip`, which is the only way either
 * moves, so they cannot drift.
 *
 * ⚠ VIEW-LOCAL FOR THE SAME REASON THE FLAT ONE IS. It is a personal authoring
 * lens, never patch content: syncing it would move a collaborator's screen. It
 * is also the RIGHT scope for recording — the take belongs in the clip the
 * person who armed it was looking at, and the single-writer lease already means
 * exactly one peer records a given lane. */
const laneSelection = new SvelteMap<string, number[]>();

/** STICKY NOW, per node — while on, a plain launch fires IMMEDIATELY, ignoring
 *  QNT, exactly as a shift-click does.
 *
 * ⚠ IT IS HERE RATHER THAN IN THE LAUNCH PANEL BECAUSE TWO CELLS LAUNCH. The
 * panel's own note argued for component state on the grounds that NOW is "a
 * modifier on the pad click, and the pad click is here", and that a second
 * node-keyed registry was too much machinery to carry one boolean. Both halves
 * were true of PADS and neither survives the SCENE band: `ClipplayerScenePanel`
 * is a separate cell that also calls `launchClipplayerScene`, so with NOW held
 * in the grid the two launch affordances on one faceplate silently disagreed
 * about the modifier — the grid honoured it, the scenes band did not, and the
 * legacy card has ONE `nowSticky` governing both (`launchScene` reads the same
 * flag `launchPad` does). The registry the objection declined to add is this
 * file, which already existed for exactly this reason.
 *
 * ⚠ STILL VIEW-LOCAL AND NEVER SYNCED. A performance modifier is not patch
 * content: it must not reach a collaborator's screen, which is why it lives
 * beside the clip selection rather than in `node.data`. */
const nowSticky = new SvelteMap<string, boolean>();

/** Whether `nodeId`'s next launch — pad or scene — ignores QNT. */
export function clipplayerNowSticky(nodeId: string): boolean {
  return nowSticky.get(nodeId) ?? false;
}

/** Toggle/set sticky NOW for `nodeId`. */
export function clipplayerSetNowSticky(nodeId: string, on: boolean): void {
  nowSticky.set(nodeId, on);
  pruneDeletedNodes();
}

/** The flat clip index the face's editor is showing for `nodeId` (default 0 —
 *  lane 1, slot 1, the pad a fresh player's eye lands on). */
export function clipplayerSelectedClip(nodeId: string): number {
  return selection.get(nodeId) ?? 0;
}

/** Open a clip in the face's editor. Out-of-range indices are IGNORED rather
 *  than clamped: a clamp would silently open a DIFFERENT clip than the one the
 *  caller named, which on a launcher is an edit landing in the wrong lane.
 *
 * ⚠ THE BOUND IS THE STRIDE-64 KEY SPACE (`CLIP_LANES * SCENE_STRIDE`), NOT
 * `CLIP_COUNT`. A flat clip index is `clipIndex(slot, lane) = lane * 64 + slot`
 * (clip-types.ts, schema v2), so every visible pad OFF lane 1 already sits at
 * 64 or above — lane 8 slot 8 is 455. This guard shipped checking `CLIP_COUNT`
 * (the visible 8×8 = 64, a PAD count, not a key ceiling), which silently
 * swallowed the selection for 56 of the 64 pads: the launch panel's
 * double-click created the clip and then this early-return dropped the select,
 * so the editor band stayed bound to whatever it last showed — the owner's
 * "changing clips in the grid doesn't update what clip I am editing below". */
export function clipplayerSelectClip(nodeId: string, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= CLIP_LANES * SCENE_STRIDE) return;
  selection.set(nodeId, index);
  // …and remember it as THIS LANE's selection (clause 2). Written here rather
  // than derived on read, because a derivation could only ever recover the one
  // lane the flat index sits in.
  const lane = laneOf(index);
  const slots = laneSelection.get(nodeId) ?? new Array<number>(CLIP_LANES).fill(0);
  slots[lane] = slotOf(index);
  laneSelection.set(nodeId, slots);
  pruneDeletedNodes();
}

/** Mark `slot` as `lane`'s record target WITHOUT moving the editor.
 *
 * ⚠ A SEPARATE GESTURE FROM `clipplayerSelectClip`, on purpose. Double-click is
 * "open this clip in the editor", and it CREATES a clip in an empty slot and
 * navigates away from the grid — none of which a player wants merely to say
 * "record into that one". Worse, the clip it creates is a NOTE clip, which the
 * recorder then refuses, so double-click could never be the record-target
 * gesture. A plain pad CLICK calls this instead: it moves nothing the player
 * can see except which pad the lane's record button is aimed at.
 */
export function clipplayerSelectLaneSlot(nodeId: string, lane: number, slot: number): void {
  if (!Number.isInteger(lane) || lane < 0 || lane >= CLIP_LANES) return;
  if (!Number.isInteger(slot) || slot < 0 || slot >= SCENE_STRIDE) return;
  const slots = laneSelection.get(nodeId) ?? new Array<number>(CLIP_LANES).fill(0);
  slots[lane] = slot;
  laneSelection.set(nodeId, slots);
  pruneDeletedNodes();
}

/** CLAUSE 2 — the slot the record toggle for `lane` will record into: the last
 *  clip selected in that lane, or slot 0 for a lane never touched (the pad a
 *  fresh player's eye lands on, matching the flat selection's own default). */
export function clipplayerSelectedSlotForLane(nodeId: string, lane: number): number {
  if (!Number.isInteger(lane) || lane < 0 || lane >= CLIP_LANES) return 0;
  const slot = laneSelection.get(nodeId)?.[lane];
  return typeof slot === 'number' && slot >= 0 && slot < SCENE_STRIDE ? slot : 0;
}

/** Drop selections for nodes that no longer exist.
 *
 * ⚠ IT RUNS ON WRITE RATHER THAN BEING EXPORTED FOR A CALLER TO REMEMBER, and
 * that is deliberate: the sibling `dx7ForgetSelection` has been exported since
 * it was written and has NEVER been called anywhere in the tree, so dx7's map
 * grows one entry per spawned-and-deleted node for the life of the session.
 * An unwired cleanup export is a leak wearing a tidy name. Selecting is the
 * only event that can grow this map, so it is also the only place that needs
 * to bound it. */
function pruneDeletedNodes(): void {
  for (const id of selection.keys()) {
    if (!patch.nodes[id]) selection.delete(id);
  }
  for (const id of nowSticky.keys()) {
    if (!patch.nodes[id]) nowSticky.delete(id);
  }
  for (const id of laneSelection.keys()) {
    if (!patch.nodes[id]) laneSelection.delete(id);
  }
}
