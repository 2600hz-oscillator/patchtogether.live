// packages/web/src/lib/control/clip-surface-map.ts
//
// CONTROLLER-AGNOSTIC clip-surface "brain" — the PURE clip↔cell logic every
// hardware control surface (monome grid, Launchpad, …) shares. It knows NOTHING
// about a specific surface's physical placement (where STOP / EDIT / a note row
// lands, how wide a frame is) — those are supplied by a per-controller
// PLACEMENT adapter (e.g. `monome/monome-map.ts` for the 16×8 monome, a future
// `launchpad/launchpad-map.ts` for the 8×8 ×2 Launchpad pair).
//
// What lives here (the shared brain):
//   - the clip-index ↔ (slot, lane) math,
//   - the EDIT-mode pitch/step math (row→MIDI, page count, a pad's step→note),
//   - the LENGTH-EDIT block/step classifier (abstract — no coordinates),
//   - the per-cell LED *decision* helpers (what level a clip cell / a note cell
//     should show) so two surfaces render identically from the same state.
//
// What does NOT live here (the placement adapter's job):
//   - the physical coordinates of every control pad,
//   - the frame width / row-major index,
//   - the device byte protocol.
//
// This is the heart of the rename (proposal §3.2): split the old monome-only
// `grid-clip-map.ts` into this placement-free core + a thin monome placement,
// so the monome + both Launchpads become thin adapters over ONE brain. The
// monome's externally-visible behaviour is UNCHANGED — `monome/monome-map.ts`
// re-exports this core's helpers and supplies the 16×8 coordinates exactly as
// before.

import {
  CLIP_LANES,
  CLIP_SLOTS,
  clipIndex,
  laneOf,
  slotOf,
  rowToMidi,
  noteCovering,
  velBucket,
  STEPS_PER_PAGE,
  MAX_EDIT_PAGES,
  lengthEndBlock,
  lengthEndStep,
  type NoteClipRecord,
} from '$lib/audio/modules/clip-types';

// ---------------------------------------------------------------------------
// Session LED levels (0-15 varibright) — the canonical state→level decisions a
// monome-style brightness surface uses. A richer (RGB) surface can map these to
// hues, but the STATE distinctions (empty/loaded/queued/playing/…) are shared.
// ---------------------------------------------------------------------------
export const LED_EMPTY = 0;
export const LED_LOADED = 6;
export const LED_QUEUED_LO = 3;
export const LED_QUEUED_HI = 12;
export const LED_PLAYING = 15;
export const LED_STOP_IDLE = 3;
export const LED_STOP_ACTIVE = 12;
export const LED_SCENE_IDLE = 4;
export const LED_EDIT_PAD = 5;
export const LED_TRANSPORT_ON = 15;
// COPY / PASTE / PASTE-REV held-modifier pads + the copy-buffer indicator.
export const LED_MOD_IDLE = 4; // a held-modifier pad at rest
export const LED_MOD_ON = 15; // a held-modifier pad while held
// COPY-INDICATOR pulse ramp (med→high→med→low), indexed off the blink cadence.
export const LED_COPY_IND_PULSE: readonly number[] = [8, 13, 8, 3];

// --- Edit-mode LED levels ---
export const LED_NOTE_BRIGHTNESS: readonly number[] = [5, 10, 15]; // low / med / high
export const LED_NOTE_PLAYHEAD = 15; // a note the playhead is currently over
export const LED_PLAYHEAD = 6; // wash on the current-step column (the pulse)
export const LED_ROOT_GUIDE = 1; // faint marker on root-pitch-class rows
export const LED_FUNC = 5; // a function-row pad (idle)
export const LED_FUNC_ON = 15; // a held function-row pad (e.g. VEL armed)
export const LED_FUNC_DIM = 2; // a function pad that is a no-op right now (dim)
export const LED_FUNC_FLASH = 12; // a flashing function pad (FOLLOW frozen)

// --- LENGTH-EDIT page LED levels (the 2-row length editor) ---
export const LED_LEN_BLOCK = 6; // a counted 16-step block (cells 1..endBlock−1)
export const LED_LEN_END = 15; // the END block / END step (bright)
export const LED_LEN_EXIT = 5; // the EXIT pad (row 0, cell 16)

// ---------------------------------------------------------------------------
// Clip-index math (placement-free). Which clip a (slot, lane) addresses, and
// the inverse. A surface decides WHERE the matrix lands; this decides WHICH clip
// a given (slot, lane) is.
// ---------------------------------------------------------------------------

/** (slot, lane) inside the clip matrix → flat clip index, or null when out of
 *  the 8×8 matrix. (Placement-free: a surface maps a pad to (slot, lane) first.) */
export function clipIndexForSlotLane(slot: number, lane: number): number | null {
  if (slot < 0 || slot >= CLIP_SLOTS || lane < 0 || lane >= CLIP_LANES) return null;
  return clipIndex(slot, lane); // lane*CLIP_SLOTS + slot
}
/** Flat clip index → its (slot, lane) within the clip matrix. */
export function slotLaneForClipIndex(index: number): { slot: number; lane: number } {
  return { slot: slotOf(index), lane: laneOf(index) };
}

// ---------------------------------------------------------------------------
// EDIT-mode pitch/step math (placement-free).
// ---------------------------------------------------------------------------

/**
 * Logical pitch ROW (0 = bottom-of-window note, increasing up) → MIDI for a
 * clip, with a `rowOffset` that scrolls the pitch window by whole scale-degree
 * rows. Surface-independent: a placement adapter converts its own physical row
 * to this logical row before calling.
 */
export function editLogicalRowToMidi(clip: NoteClipRecord, logicalRow: number): number {
  return rowToMidi(logicalRow, clip.root, clip.scale);
}

/** Number of 16-step pages a clip spans (1..MAX_EDIT_PAGES). */
export function editPageCount(clip: NoteClipRecord): number {
  return Math.max(1, Math.min(MAX_EDIT_PAGES, Math.ceil(clip.lengthSteps / STEPS_PER_PAGE)));
}

/**
 * A note cell given a window COLUMN (0-based, within the shown window of width
 * `windowWidth`), a logical pitch row, the scroll `rowOffset`, and the shown
 * `page` → the {step, midi} it edits, or null when the step is beyond the clip's
 * length. `realStep = page*STEPS_PER_PAGE + col`. Placement-free: the adapter
 * has already excluded function/out-of-grid cells + converted to (col, row).
 */
export function noteForCell(
  clip: NoteClipRecord,
  col: number,
  logicalRow: number,
  rowOffset = 0,
  page = 0,
): { step: number; midi: number } | null {
  if (col < 0) return null;
  const realStep = page * STEPS_PER_PAGE + col;
  if (realStep >= clip.lengthSteps) return null; // beyond the clip
  return { step: realStep, midi: editLogicalRowToMidi(clip, rowOffset + logicalRow) };
}

/** The LED level a note cell should show: empty, the root guide, the moving
 *  playhead wash, a placed note by its velocity bucket, or a note boosted under
 *  the playhead. Shared so every surface renders the editor identically. */
export function noteCellLevel(
  clip: NoteClipRecord,
  step: number,
  midi: number,
  onPlayhead: boolean,
): number {
  const cov = noteCovering(clip, step, midi);
  if (cov) return onPlayhead ? LED_NOTE_PLAYHEAD : LED_NOTE_BRIGHTNESS[velBucket(cov.velocity)];
  let base = LED_EMPTY;
  if (onPlayhead) base = LED_PLAYHEAD; // the moving pulse column
  const rootPc = ((clip.root % 12) + 12) % 12;
  if (((midi % 12) + 12) % 12 === rootPc) base = Math.max(base, LED_ROOT_GUIDE);
  return base;
}

/** Which window page the editor SHOWS for a clip: the live playhead's page when
 *  FOLLOWing (page 0 when not playing), else the clamped frozen page. */
export function shownEditPageFor(
  clip: NoteClipRecord,
  followOn: boolean,
  playheadStep: number,
  frozenPage: number,
): number {
  if (followOn) return playheadStep >= 0 ? Math.floor(playheadStep / STEPS_PER_PAGE) : 0;
  return Math.max(0, Math.min(editPageCount(clip) - 1, frozenPage));
}

// ---------------------------------------------------------------------------
// LENGTH-EDIT classifier (placement-free) — maps an abstract ruler cell to its
// action. ROW 0 = the 16-step BLOCK the pattern ends in (1-based); ROW 0's last
// pad = EXIT; ROW 1 = the STEP within that end block (1-based).
// ---------------------------------------------------------------------------
export type LengthEditAction =
  | { kind: 'exit' }
  | { kind: 'block'; block: number } // 1-based 16-step block
  | { kind: 'step'; step: number }; // 1-based step within the end block

/**
 * Classify a LENGTH-EDIT ruler cell → its action, or null for an unused cell.
 * `row` 0 = the block ruler (cells 0..MAX_EDIT_PAGES-1 → blocks 1..N) + the EXIT
 * cell (when `isExit`); `row` 1 = the step ruler (cells 0..STEPS_PER_PAGE-1 →
 * steps 1..N). The placement adapter decides which physical pad is the EXIT.
 */
export function lengthEditAction(row: number, cell: number, isExit: boolean): LengthEditAction | null {
  if (isExit) return { kind: 'exit' };
  if (row === 0 && cell >= 0 && cell < MAX_EDIT_PAGES) return { kind: 'block', block: cell + 1 };
  if (row === 1 && cell >= 0 && cell < STEPS_PER_PAGE) return { kind: 'step', step: cell + 1 };
  return null;
}

/** The two length-ruler readouts a surface paints (the END block + END step of
 *  the clip's length). Placement-free; the surface lays them onto its rows. */
export function lengthRulers(clip: NoteClipRecord): { endBlock: number; endStep: number } {
  const L = Math.max(1, clip.lengthSteps);
  return { endBlock: lengthEndBlock(L), endStep: lengthEndStep(L) };
}

/** The pulse level for the COPY-INDICATOR at a blink phase (animates without
 *  extra state). Shared so every surface pulses the indicator identically. */
export function copyIndicatorLevel(blinkPhase: number): number {
  const n = LED_COPY_IND_PULSE.length;
  return LED_COPY_IND_PULSE[((blinkPhase % n) + n) % n];
}
