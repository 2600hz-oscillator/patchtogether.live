// packages/web/src/lib/control/launchpad/launchpad-map.ts
//
// LAUNCHPAD PLACEMENT adapter — the 2× Launchpad Mini Mk3 surface laid over the
// controller-agnostic clip-surface core (`$lib/control/clip-surface-map`). It
// supplies ONLY the Launchpad-specific PLACEMENT (which pad/CC is which control
// on each unit) + the RGB COLOUR LANGUAGE, then defers every clip/edit/length
// DECISION to the shared brain — so the monome + both Launchpads are thin
// adapters over ONE model.
//
// Owner-LOCKED layout (Plan B + Plan C's "matrix never disappears"):
//
//   UNIT L = the clip MATRIX, PERMANENTLY (never flips to the editor):
//     · 8×8 pads: pad (x=slot, y=lane) ↔ clip index lane*8+slot. y is measured
//       from the BOTTOM (programmer-mode 11=bottom-left). Tap = launch/stop the
//       lane via node.data.queued[] (the SAME synced field the card + monome
//       write → multiplayer-synced for free).
//     · right SCENE column (CCs 89..19, top→bottom = rows 7..0) = SCENE LAUNCH:
//       scene button row y fires slot y across ALL lanes.
//
//   UNIT R = the COMMAND DECK (session); FLIPS to the 8-pitch × 8-step NOTE
//   EDITOR while editing (so L keeps the live matrix):
//     SESSION deck:
//       · top row (CC 91..95): ▲ ▼ ◀ ▶ + SHIFT(▣, CC 95). In session these are
//         spare (the editor uses them). CC 96 = TRANSPORT, CC 97 = STOP-ALL.
//       · right scene column (CC 89..19) = per-lane STOP (row y stops lane y).
//       · 8×8 deck pads, by functional COLUMN (x):
//           col 0  = EDIT (hold) — tap a clip on L to edit it
//           col 1  = COPY (hold) / col 2 = PASTE (hold) / col 3 = PASTE-REV (hold)
//           col 4  = COPY-INDICATOR (render-only buffer pulse)
//           col 5  = DOUBLE (tap)
//           col 6  = LENGTH-EDIT (tap → opens the 2-row length page on R)
//           col 7  = NOW/QNT launch-immediate modifier (hold)
//         (deck pads use ROW 0 only as the active control; rows 1..7 of those
//          columns are dark — the deck is intentionally sparse + legible.)
//     EDIT editor (R flips here):
//       · all 8×8 pads = the note grid: X = step over the shown 8-step window
//         (half a 16-step block), Y = pitch (8 in-key rows). y from the BOTTOM,
//         so row 0 = the lowest shown pitch.
//       · top row: ▲/▼ scroll pitch ±1 row, ◀/▶ scroll step ±1; SHIFT (CC 95)
//         held makes ▲▼◀▶ jump a full screen (±8). CC 96 = VEL (hold+tap a pad
//         to cycle velocity), CC 97 = SCALE cycle, CC 98 = FOLLOW toggle.
//       · right scene column: top (row 7) = EXIT; rows 6..0 spare.
//     LENGTH-EDIT page (R, opened by the deck's LEN pad):
//       · row 0 (bottom): end-BLOCK ruler (pads 0..7 → blocks 1..8); pad 7 of
//         row 7 (scene top) = EXIT.  row 1: end-STEP ruler (pads 0..15 don't
//         fit 8 wide → we use rows 1 + 2 for steps 1..8 / 9..16).
//
// RGB COLOUR LANGUAGE: the legend (`legend-colors.svg`). Each state maps to an
// exact RGB triple (0..127, the lighting-SysEx range). State always wins over a
// clip's own tint (Ableton convention). Animation (pulse/flash) is expressed
// here as a blink between two RGB triples on the binding's blink cadence (the
// device only does static RGB in our pipeline; pulse/flash are emulated by the
// render loop swapping triples — same as the monome's brightness blink).

import {
  CLIP_LANES,
  CLIP_SLOTS,
  SCENE_STRIDE,
  clipIndex,
  STEPS_PER_PAGE,
  MAX_EDIT_PAGES,
  type ClipPlayerData,
  type NoteClipRecord,
  lanePlaying,
  laneQueued,
  laneMono,
  laneMuted,
  laneColorEff,
  velBucket,
  noteCovering,
  SCALE_NAMES,
  isAutomationArmed,
  type CopyBufferKind,
} from '$lib/audio/modules/clip-types';
import { laneRateIndex, RATE_MULTS } from '$lib/audio/modules/clip-clock';
import type { ArpDirection } from '$lib/audio/arp-engine';
import {
  clipIndexForSlotLane,
  slotLaneForClipIndex,
  editPageCount,
  noteForCell,
  lengthEditAction,
  lengthRulers,
  type LengthEditAction,
} from '../clip-surface-map';
import { keyboardCellToMidi, noteRole } from '$lib/audio/modules/keyboard-map';
import { playheadCell } from '$lib/audio/modules/clip-record';
import type { ScaleName } from '$lib/mike/music-theory';
import {
  LP_WIDTH,
  LP_HEIGHT,
  padNote,
  CC_UP,
  CC_DOWN,
  CC_LEFT,
  CC_RIGHT,
  CC_SESSION,
  CC_TOP_SPARE_6,
  CC_TOP_SPARE_7,
  CC_TOP_SPARE_8,
  SCENE_CCS,
} from './launchpad-sysex';
import { type LaunchpadFrame, type LaunchpadUnit, emptyFrame } from './launchpad-device.svelte';

export { editPageCount, type LengthEditAction } from '../clip-surface-map';

// ---------------------------------------------------------------------------
// RGB COLOUR LANGUAGE (legend-colors.svg). 0..127 components.
// ---------------------------------------------------------------------------
export type Rgb = readonly [number, number, number];

export const RGB_OFF: Rgb = [0, 0, 0];
// Session clip states.
export const RGB_LOADED: Rgb = [14, 20, 28]; // dim blue (idle, has notes)
export const RGB_PLAYING: Rgb = [23, 104, 53]; // green (playing) — pulses (see blink)
export const RGB_PLAYING_DIM: Rgb = [8, 40, 20]; // (reserved) dim green — playing now renders SOLID, not pulsed
export const RGB_QUEUED: Rgb = [23, 104, 53]; // green (queued-launch) — FLASHES on/off
export const RGB_QUEUED_STOP: Rgb = [104, 23, 23]; // red (queued-stop) — flashes on/off
export const RGB_RECORDING: Rgb = [127, 16, 16]; // red (record-armed / recording) — pulses
// Control / function colours.
export const RGB_SCENE: Rgb = [112, 81, 21]; // amber (scene launch)
export const RGB_SCENE_DIM: Rgb = [24, 17, 4]; // dim amber (scene UP/DOWN at its scroll clamp — nothing more to reveal)
export const RGB_STOP_IDLE: Rgb = [69, 37, 16]; // dim red (stop lane idle)
export const RGB_STOP_ACTIVE: Rgb = [104, 23, 23]; // bright red (lane playing)
export const RGB_FUNC: Rgb = [60, 60, 70]; // function idle (white-ish)
export const RGB_FUNC_ON: Rgb = [122, 79, 112]; // held modifier (violet, bright)
export const RGB_FUNC_DIM: Rgb = [10, 10, 14]; // a no-op-right-now function pad
// ── Per-function DECK colours (owner-chosen) ── each deck pad gets its own hue
// so the command deck reads at a glance: EDIT orange · COPY/PASTE/P-REV green ·
// DBL + NOW purple · LEN yellow. Hold-modifiers brighten to the *_ON variant
// while held (the *_ON keeps the same hue so the colour identity never changes).
export const RGB_DECK_EDIT: Rgb = [60, 24, 0]; // orange (idle)
export const RGB_DECK_EDIT_ON: Rgb = [127, 56, 0]; // orange (held, bright)
export const RGB_DECK_COPY: Rgb = [12, 48, 16]; // green (idle)
export const RGB_DECK_COPY_ON: Rgb = [28, 110, 36]; // green (held, bright)
export const RGB_DECK_DBL: Rgb = [40, 14, 60]; // purple (DBL — tap)
export const RGB_DECK_LEN: Rgb = [56, 48, 6]; // yellow (LEN — tap)
export const RGB_DECK_NOW: Rgb = [40, 14, 60]; // purple (idle)
export const RGB_DECK_NOW_ON: Rgb = [104, 40, 127]; // purple (held, bright)
export const RGB_DECK_LEN_ON: Rgb = [110, 96, 12]; // yellow (LEN armed, bright)
export const RGB_DECK_DBL_ON: Rgb = [80, 28, 120]; // purple (DBL armed, bright)
export const RGB_TRANSPORT_ON: Rgb = [23, 104, 53]; // green (transport running)
export const RGB_RECORDING_DIM: Rgb = [30, 4, 4]; // down phase of the record-arm pulse
export const RGB_SONG_SESSION: Rgb = [16, 16, 20]; // SES/ARR idle (SESSION) — dim white
export const RGB_SONG_ARRANGE: Rgb = [90, 90, 100]; // SES/ARR in ARRANGEMENT — bright white
export const RGB_COPY_BUFFER: Rgb = [15, 99, 99]; // turquoise (CLIP copy buffer loaded) — pulses
export const RGB_COPY_BUFFER_DIM: Rgb = [4, 30, 30]; // down phase of the copy pulse
// A SCENE copy buffer (all 8 lanes' clips at a slot) reads with a DISTINCT amber-
// tinted colour so the buffer indicator + paste-target lights say "a whole scene
// is loaded", never confused with the turquoise single-clip buffer.
export const RGB_COPY_BUFFER_SCENE: Rgb = [110, 78, 12]; // amber (SCENE copy buffer loaded) — pulses
export const RGB_COPY_BUFFER_SCENE_DIM: Rgb = [26, 18, 3]; // down phase of the scene copy pulse
export const RGB_EXIT: Rgb = [104, 23, 23]; // red (EXIT)
// SINGLE-mode CC-98 VIEW-toggle indicator — a calm cyan so the dedicated
// view-flip button reads distinct from the function row (single mode only; in
// pair mode CC 98 is the editor FOLLOW toggle).
export const RGB_VIEW: Rgb = [10, 60, 60]; // cyan (CLIP ⇄ CONTROL view marker)
// Editor note colours (velocity buckets) + playhead.
export const RGB_NOTE_BY_VEL: readonly Rgb[] = [
  [29, 41, 57], // low velocity (dim blue)
  [37, 62, 96], // med
  [63, 91, 127], // high
];
export const RGB_NOTE_PLAYHEAD: Rgb = [127, 105, 29]; // a note under the playhead (yellow boost)
export const RGB_PLAYHEAD_WASH: Rgb = [40, 33, 9]; // the moving playhead column wash (amber, dim)
export const RGB_ROOT_GUIDE: Rgb = [10, 12, 16]; // faint marker on root-pitch-class rows
// LENGTH-EDIT page.
export const RGB_LEN_BLOCK: Rgb = [20, 28, 38]; // a counted block/step (dim)
export const RGB_LEN_END: Rgb = [63, 91, 127]; // the END block/step (bright)
// ── KEYS mode (dual-Launchpad note/keyboard + clip-record) ──
// Isomorphic-keyboard lighting (LinnStrument scheme): root cyan, in-scale green
// dimmed, out-of-scale very dim, a sounding/pressed pad white.
export const RGB_KEY_ROOT: Rgb = [0, 100, 127]; // cyan — every octave's root
export const RGB_KEY_INSCALE: Rgb = [0, 45, 0]; // green (dimmed so roots pop)
export const RGB_KEY_OUTSCALE: Rgb = [4, 4, 6]; // very dim (still playable — chromatic)
export const RGB_KEY_PRESSED: Rgb = [127, 127, 127]; // white — sounding now
// Playhead strip (top row): the whole clip across 16 cells (L 0..7 + R 8..15).
export const RGB_KEYS_PH_BASE: Rgb = [0, 6, 22]; // dull blue baseline
export const RGB_KEYS_PH_CUR: Rgb = [96, 96, 110]; // the current cell (white-ish)
// Bottom-row controls. QUEUE-REC differs by COLOUR not blink rate: dull yellow
// idle → flashing (bright) yellow armed → red recording.
export const RGB_QREC_IDLE: Rgb = [40, 34, 0]; // dull yellow (idle)
export const RGB_QREC_ARMED: Rgb = [110, 96, 0]; // bright yellow (armed, flashes)
export const RGB_QREC_REC: Rgb = [127, 16, 16]; // red (recording, pulses)
export const RGB_OD: Rgb = [40, 14, 60]; // light purple (overdub OFF)
export const RGB_OD_ON: Rgb = [104, 40, 127]; // bright purple (overdub ON)
// SESSION deck KEYS-entry hold buttons (dark deck pads, row 1 — NOT the arranger
// CC_REC). Distinct hue + name; brighten while held. Also drive the reclaimed
// CC-91 KEYS-ARM tri-state cell in single clip view (off = dim red idle, armed-
// REC = bright red, armed-OD = bright purple), so the arm cell reuses the same
// two hues the deck holds already speak.
export const RGB_KEYS_REC_HOLD: Rgb = [50, 6, 6]; // dim red (idle / KEYS-arm off)
export const RGB_KEYS_REC_HOLD_ON: Rgb = [127, 16, 16]; // red (held / armed-REC)
export const RGB_KEYS_OD_HOLD: Rgb = [30, 10, 45]; // dim purple (idle)
export const RGB_KEYS_OD_HOLD_ON: Rgb = [104, 40, 127]; // purple (held / armed-OD)
// ── RESET pad (P1) — snap every active lane back to step 1 (bumps resetNonce,
// the SAME field the card RST button + reset gate drive). A calm steel-blue so
// it reads as a distinct "re-sync" control (never confused with the red STOPs or
// the purple NOW). Momentary — lit statically as a "ready" indicator.
export const RGB_RESET: Rgb = [24, 52, 120]; // steel blue
// ── Per-lane MONO toggle (P4) — surface node.data.mono[lane] (card-only before).
// A teal deck row: ON (mono, one-note-per-column) bright, OFF (poly, default)
// dim. Teal is distinct from the row-0 COPY green + the amber scenes.
export const RGB_MONO_ON: Rgb = [8, 78, 92]; // teal (mono engaged)
export const RGB_MONO_OFF: Rgb = [4, 16, 20]; // dim teal (poly — the default)
// ── Per-lane MUTE toggle (P3) — a muted lane KEEPS advancing its playhead (stays
// locked to the transport) but emits NO audio. ON (muted) = bright orange, OFF
// (live) = dim. Orange is distinct from the red per-lane STOP (which halts the
// lane) so mute-in-place reads apart from stop.
export const RGB_MUTE_ON: Rgb = [110, 44, 4]; // orange (muted — silent, still running)
export const RGB_MUTE_OFF: Rgb = [6, 14, 8]; // dim (live)
// ── Per-lane RATE (P2) — surface the clip clock division node.data.rate[lane]
// (1/8·1/4·1/2·1·2x·4x = indices 0..5, card-only before). One deck pad per lane;
// tap cycles the rate up (wrapping). A cool→warm ramp so slower reads cooler,
// faster warmer; the default '1' (index 3) is green.
export const RGB_RATE_BY_INDEX: readonly Rgb[] = [
  [8, 12, 64], // 0 = 1/8  — deep blue
  [10, 34, 84], // 1 = 1/4  — blue
  [10, 62, 62], // 2 = 1/2  — teal
  [16, 72, 26], // 3 = 1    — green (default)
  [78, 60, 8], // 4 = 2x   — amber
  [96, 30, 6], // 5 = 4x   — orange-red
];
// ── Tempo nudge −/+ (P5) — step TIMELORDE bpm (CC 93/94). A calm neutral white
// so the two nudge buttons read as transport-adjacent, not a launch colour.
export const RGB_TEMPO_NUDGE: Rgb = [40, 40, 50]; // dim white
// ── KEYS panic (P7) — kill every sounding auditioned note. Red-orange so it
// reads as an emergency control, distinct from the adjacent red EXIT.
export const RGB_PANIC: Rgb = [96, 22, 0]; // red-orange
// ── KEYS octave ± / editor octave ± (P6/P7) — a neutral function hue.
export const RGB_OCTAVE: Rgb = RGB_FUNC;

// ---------------------------------------------------------------------------
// SINGLE-MODE (S2a) COLOUR PALETTE — two families the docs render EXACT colours
// from (remap in ONE place). (a) the PERMANENT TOP-ROW navigation palette
// (purple views · yellow shift · red/green transport · orange undo/redo); and
// (b) the RIGHT-COLUMN function taxonomy (green = pattern · blue = timing ·
// orange = system · yellow = length), plus the KEYS-entry bright-orange override
// and the Swing± meter tints. Values REUSE the nearest existing triple where
// sensible (noted per line) so the single + pair surfaces stay colour-coherent.
// ---------------------------------------------------------------------------
// TOP-ROW NAVIGATION palette.
export const RGB_VIEW_IDLE: Rgb = [16, 6, 30]; // dim purple (a "you-are-not-here" view button)
export const RGB_VIEW_ACTIVE: Rgb = [104, 40, 127]; // bright purple (active view) — echoes RGB_DECK_NOW_ON
export const RGB_SHIFT_OFF: Rgb = [24, 20, 0]; // dim yellow (shift idle)
export const RGB_SHIFT_HELD: Rgb = [127, 112, 0]; // bright yellow (shift momentary-held)
export const RGB_SHIFT_LATCH: Rgb = [96, 82, 0]; // solid yellow (shift latched)
export const RGB_TRANSPORT_STOP: Rgb = [104, 23, 23]; // red (transport stopped) — echoes RGB_QUEUED_STOP
// RGB_TRANSPORT_ON (green, transport running) already exists above — reused as-is.
export const RGB_SYS: Rgb = [110, 50, 0]; // system orange (undo/redo · NOW · arp range · arp on/off)
export const RGB_SYS_DIM: Rgb = [22, 10, 0]; // dim system orange (a disabled/no-op system pad)
// RIGHT-COLUMN function taxonomy.
export const RGB_PATTERN: Rgb = [12, 48, 16]; // green (copy/paste/pasterev/double/follow/scales/row-nav) — echoes RGB_DECK_COPY
export const RGB_PATTERN_ARMED: Rgb = [28, 110, 36]; // bright green (armed/selected) — echoes RGB_DECK_COPY_ON
export const RGB_TIMING: Rgb = [10, 34, 84]; // blue (clip-div · swing± · step-scroll · arp-div) — echoes RGB_RATE_BY_INDEX[1]
export const RGB_TIMING_ARMED: Rgb = [40, 96, 127]; // bright blue (armed timing / block-jump)
// RGB_DECK_LEN (yellow, edit-clip-length) already exists above — reused for LEN.
export const RGB_KEYS_ENTRY: Rgb = [127, 56, 0]; // bright orange (KEYS entry — owner override) — echoes RGB_DECK_EDIT_ON
// SWING± METER tints (ramped pale→bright by level; green flash at dead-centre).
export const RGB_SWING_UP: Rgb = [110, 30, 127]; // bright purple (swing INCREASING)
export const RGB_SWING_DOWN: Rgb = [30, 80, 127]; // bright blue (swing DECREASING)
export const RGB_SWING_CENTER: Rgb = [23, 104, 53]; // green (returned to dead-centre 0) — echoes RGB_TRANSPORT_ON
// Misc single-mode washes.
export const RGB_VEL_WASH: Rgb = [6, 2, 10]; // faint purple (Clip velocity-edit mode grid wash)
export const RGB_ARRANGER_DIM: Rgb = [3, 1, 6]; // faint purple (inert Arranger grid)

// ---------------------------------------------------------------------------
// UNIT L — the clip matrix placement (PURE classifiers).
// ---------------------------------------------------------------------------

// The launchpad's programmer-mode y is measured from the BOTTOM (y=0 = bottom
// row). The on-screen ClipplayerCard renders lane 0 as the TOP grid row (it
// `#each`es lanes top→bottom). To make the launchpad MATCH WHAT YOU SEE on the
// card — tap the pad that's lit and you hit the clip you see — lane 0 lands on
// the launchpad's TOP physical row (y = CLIP_LANES-1) and lane 7 on the bottom.
// This flip is applied CONSISTENTLY in BOTH the decode (here) and the LED render
// (computeLSessionFrame), so a press lands on the clip whose LED is lit.
/** Launchpad physical y (0 = bottom) ↔ instrument lane (0 = card TOP row). The
 *  flip is its own inverse, so one helper serves both directions. */
export function lYToLane(y: number): number {
  return CLIP_LANES - 1 - y;
}

/** L pad (x=slot, y from BOTTOM) → flat clip index, or null when out of the
 *  matrix. y is flipped to a lane so the TOP row = lane 0 (matches the card). */
export function lPadToClipIndex(x: number, y: number): number | null {
  return clipIndexForSlotLane(x, lYToLane(y)); // launchpad L: pad.x = slot, pad.y flips to lane
}
/** Flat clip index → its (x=slot, y from BOTTOM) pad on unit L (lane→row flipped
 *  so lane 0 = the TOP physical row, matching the card). */
export function clipIndexToLPad(index: number): { x: number; y: number } {
  const { slot, lane } = slotLaneForClipIndex(index);
  return { x: slot, y: lYToLane(lane) }; // lYToLane is its own inverse
}
/** An L scene-column row → the slot it launches across all lanes, or null.
 *  Scene row y addresses slot y (rows 0..CLIP_SLOTS-1). */
export function lSceneSlotForRow(row: number): number | null {
  if (row >= 0 && row < CLIP_SLOTS) return row;
  return null;
}

// ---------------------------------------------------------------------------
// SINGLE-UNIT clip-view ARM ROW (top CCs 91..97). In single mode the clip view's
// top row is otherwise dead (handleL has no `top` branch), so it hosts a 7-cell
// ACTION-ARM strip: tap a cell to ARM an action, then tap a clip pad to apply it
// — two-handed deck ops without ever leaving the matrix view. CC 98 stays the
// view-flip. PAIR mode never reaches this (single-only routing), so the pair
// top-row roles (REC/SONG/transport/…) are untouched.
//   CC 91 (▲)      = KEYS      (sticky tri-state: off→armed-REC→armed-OD→off;
//                               then tap a clip → enter KEYS for it, one-handed,
//                               no view flip — the reclaimed NEW cell. NEW's
//                               create-a-clip role is covered by double-tapping
//                               an empty pad, which already opens the editor.)
//   CC 92 (▼)      = COPY (+ re-tap while loaded = clear buffer)
//   CC 93 (◀)      = PASTE     · CC 94 (▶) = PASTE-REV
//   CC 95 (▣)      = NOW       (sticky toggle, not arm-then-tap)
//   CC 96          = LENGTH    · CC 97 = DOUBLE
// 'keys' + 'now' are STICKY toggles (never stored in `armedAction`); the rest are
// arm-then-tap actions consumed by consumeArmed.
// ---------------------------------------------------------------------------
export type ClipArmAction =
  | 'keys'
  | 'copy'
  | 'paste'
  | 'pasteRev'
  | 'now'
  | 'length'
  | 'double';

/** Classify a single-mode clip-view top-row CC → its arm-strip action, or null
 *  for CC 98 (the view-flip) / any non-arm CC. PURE. */
export function clipArmAction(cc: number): ClipArmAction | null {
  switch (cc) {
    case CC_UP:
      return 'keys';
    case CC_DOWN:
      return 'copy';
    case CC_LEFT:
      return 'paste';
    case CC_RIGHT:
      return 'pasteRev';
    case CC_SESSION:
      return 'now';
    case CC_TOP_SPARE_6:
      return 'length';
    case CC_TOP_SPARE_7:
      return 'double';
    default:
      return null; // CC_TOP_SPARE_8 (98) = view-flip; everything else ignored
  }
}

/** SINGLE-mode CC-91 KEYS-ARM tri-state (the reclaimed NEW cell). off → armed
 *  with overdub OFF (true-replace) → armed with overdub ON (additive) → off. */
export type KeysArm = 'off' | 'rec' | 'od';

// ---------------------------------------------------------------------------
// UNIT R — SESSION command-deck placement.
// ---------------------------------------------------------------------------
// Deck control columns (the active pad is at ROW 0 of each column).
export const DECK_ROW = 0;
export const DECK_EDIT_COL = 0;
export const DECK_COPY_COL = 1;
export const DECK_PASTE_COL = 2;
export const DECK_PASTE_REV_COL = 3;
export const DECK_COPY_IND_COL = 4;
export const DECK_DOUBLE_COL = 5;
export const DECK_LENGTH_COL = 6;
export const DECK_NOW_COL = 7;

// Top-row CC roles (session deck): the ▲▼◀▶ arrows are unused in SESSION (the
// editor uses them), so the otherwise-idle top-left arrows host the arranger
// SONG controls. CC 96/97 = transport / stop-all. (CC 95 = SHIFT, reserved
// across both modes.)
//   CC 91 (▲) = REC   — song record-arm (node.data.recording), red + pulse
//   CC 92 (▼) = SONG  — SESSION ⇄ ARRANGEMENT (node.data.clipMode), white,
//                       distinct/lit in ARRANGEMENT
// These write the SAME node.data fields the ClipplayerCard's REC + SES/ARR
// buttons write, so the engine arranger (clip-arrange) records launches and
// arrangement playback runs identically whichever surface armed it.
export const CC_REC = CC_UP; // 91 — arranger record-arm
export const CC_SONG = CC_DOWN; // 92 — SESSION ⇄ ARRANGEMENT
export const CC_TRANSPORT = CC_TOP_SPARE_6; // 96
export const CC_STOP_ALL = CC_TOP_SPARE_7; // 97

/** Classify an R session-deck PAD press → a deck action, or null for a dark
 *  pad. Acts only on ROW 0; other rows are dark. */
export type DeckAction =
  | 'edit'
  | 'copy'
  | 'paste'
  | 'pasteRev'
  | 'double'
  | 'lengthEdit'
  | 'now';
export function rDeckPad(x: number, y: number): DeckAction | null {
  if (y !== DECK_ROW) return null;
  switch (x) {
    case DECK_EDIT_COL:
      return 'edit';
    case DECK_COPY_COL:
      return 'copy';
    case DECK_PASTE_COL:
      return 'paste';
    case DECK_PASTE_REV_COL:
      return 'pasteRev';
    case DECK_DOUBLE_COL:
      return 'double';
    case DECK_LENGTH_COL:
      return 'lengthEdit';
    case DECK_NOW_COL:
      return 'now';
    default:
      return null; // DECK_COPY_IND_COL is render-only
  }
}
/** An R scene-column row → the lane it STOPs (per-lane stop), or null. */
export function rStopLaneForRow(row: number): number | null {
  if (row >= 0 && row < CLIP_LANES) return row;
  return null;
}

// ── SESSION deck KEYS-entry hold buttons (dual-Launchpad note/keyboard mode).
// Placed on currently-DARK deck pads (row 1, above the function row) — NOT the
// arranger CC_REC. HOLD one + double-tap a clip on L → open the KEYS view for
// that clip: hold-REC enters overdub OFF, hold-OVERDUB enters overdub ON.
export const DECK_KEYS_ROW = 1;
export const DECK_KEYS_REC_COL = 0; // note-RECORD hold (overdub OFF entry)
export const DECK_KEYS_OVERDUB_COL = 1; // note-OVERDUB hold (overdub ON entry)
/** Classify a SESSION-deck pad → a KEYS-entry hold button, or null. Row 1 only. */
export function rDeckKeysHold(x: number, y: number): 'keysRec' | 'keysOverdub' | null {
  if (y !== DECK_KEYS_ROW) return null;
  if (x === DECK_KEYS_REC_COL) return 'keysRec';
  if (x === DECK_KEYS_OVERDUB_COL) return 'keysOverdub';
  return null;
}

// ── SESSION-deck PERFORMANCE controls on the previously-dead deck rows (P1/P4/
// P3/P2). Shared by the single CONTROL deck AND pair unit R (handleRDeck /
// computeRDeckFrame), so single (which IS the R brain) and pair match:
//   row 1 col 2 = RESET (snap all active lanes to step 1 — bumps resetNonce).
//   row 2       = per-lane MONO toggle (mono[lane]).
//   row 3       = per-lane MUTE toggle (muted[lane] — advance-but-silent).
//   row 4       = per-lane RATE cycle (rate[lane] — 1/8..4x, taps step up).
// Each is a currently-dark pad; none touches the row-0 function pads, the KEYS
// holds (row 1 cols 0-1), the scene STOP column, or any top CC.
export const DECK_RESET_COL = 2;
export const DECK_RESET_ROW = DECK_KEYS_ROW; // row 1 (beside the KEYS holds)
export const DECK_MONO_ROW = 2;
export const DECK_MUTE_ROW = 3;
export const DECK_RATE_ROW = 4;
/** Is this deck pad the RESET pad? (row 1, col 2.) PURE. */
export function rDeckReset(x: number, y: number): boolean {
  return y === DECK_RESET_ROW && x === DECK_RESET_COL;
}
/** Deck MONO-row pad → its lane (col = lane 0..7), or null. PURE. */
export function rDeckMonoLane(x: number, y: number): number | null {
  return y === DECK_MONO_ROW && x >= 0 && x < CLIP_LANES ? x : null;
}
/** Deck MUTE-row pad → its lane (col = lane 0..7), or null. PURE. */
export function rDeckMuteLane(x: number, y: number): number | null {
  return y === DECK_MUTE_ROW && x >= 0 && x < CLIP_LANES ? x : null;
}
/** Deck RATE-row pad → its lane (col = lane 0..7), or null. PURE. */
export function rDeckRateLane(x: number, y: number): number | null {
  return y === DECK_RATE_ROW && x >= 0 && x < CLIP_LANES ? x : null;
}

// ── SESSION-deck top-row TEMPO NUDGE (P5). CC 93/94 are dead in the session deck
// (no `top` branch handles them there; the editor uses them as ◀/▶ but that is a
// different mode/frame), so they host tempo −/+ that steps TIMELORDE's bpm.
export const CC_TEMPO_DOWN = CC_LEFT; // 93
export const CC_TEMPO_UP = CC_RIGHT; // 94
export const TEMPO_NUDGE_BPM = 2; // ±2 bpm per tap (clamped 10..300 in the handler)

// ── PAIR unit-L TOP ROW — the previously-dead 8 CCs (91..98) become the 8
// per-lane MUTE pads on the always-visible matrix unit (col = lane). Single mode
// never routes top CCs to handleL (the arm strip + view flip intercept them), so
// this branch is pair-only in practice. Shared toggleMute seam with the deck.
/** A top CC (91..98) → its column 0..7, or null. PURE. */
export function topCcCol(cc: number): number | null {
  const col = cc - CC_UP;
  return col >= 0 && col < LP_WIDTH ? col : null;
}
/** A column 0..7 → its top CC (91..98). PURE. */
export function colTopCc(col: number): number {
  return CC_UP + col;
}
/** Pair unit-L top-CC → the MUTE lane it toggles (col = lane), or null. PURE. */
export function lTopMuteLane(cc: number): number | null {
  const col = topCcCol(cc);
  return col !== null && col < CLIP_LANES ? col : null;
}

// ---------------------------------------------------------------------------
// UNIT R — EDIT note-grid placement (8 pitch rows × 8 step columns).
// ---------------------------------------------------------------------------
export const EDIT_ROWS = LP_HEIGHT; // 8 pitch rows (full grid — no function row eaten)
export const EDIT_COLS = LP_WIDTH; // 8 step columns = HALF a 16-step block

/** Editor pitch row (y from BOTTOM, 0 = lowest shown) → logical core row. The
 *  core treats row 0 as the bottom-of-window note, increasing up — which is
 *  exactly the Launchpad's bottom-origin y, so this is the identity (unlike the
 *  monome's top-down flip). */
export function editYToLogicalRow(y: number): number {
  return y;
}

/** An edit-mode pad (x=step-col, y=pitch) → the {step, midi} it edits, or null
 *  for an out-of-grid / past-length cell. `colOffset` scrolls the 8-step window
 *  within the clip (realStep = page*16 + colOffset + x via the core), `page`
 *  selects the 16-step block, `rowOffset` scrolls the pitch window. */
export function editPadToNote(
  clip: NoteClipRecord,
  x: number,
  y: number,
  opts: { rowOffset?: number; colOffset?: number; page?: number } = {},
): { step: number; midi: number } | null {
  if (x < 0 || x >= EDIT_COLS || y < 0 || y >= EDIT_ROWS) return null;
  const colOffset = opts.colOffset ?? 0;
  // The core's noteForCell takes a window COLUMN; we widen the window by
  // colOffset (the 8-step half-block scroll) before handing it the column.
  return noteForCell(clip, colOffset + x, editYToLogicalRow(y), opts.rowOffset ?? 0, opts.page ?? 0);
}

// Editor top-row CC roles.
export const CC_EDIT_ROW_UP = CC_UP; // 91 — pitch +1 (SHIFT: +8)
export const CC_EDIT_ROW_DOWN = CC_DOWN; // 92 — pitch -1 (SHIFT: -8)
export const CC_EDIT_STEP_LEFT = CC_LEFT; // 93 — step -1 (SHIFT: -8)
export const CC_EDIT_STEP_RIGHT = CC_RIGHT; // 94 — step +1 (SHIFT: +8)
export const CC_SHIFT = CC_SESSION; // 95 — magnitude(×8)+scope modifier
export const CC_EDIT_VEL = CC_TOP_SPARE_6; // 96 — hold + tap to cycle velocity
export const CC_EDIT_SCALE = CC_TOP_SPARE_7; // 97 — cycle the clip scale
export const CC_EDIT_FOLLOW = CC_TOP_SPARE_8; // 98 — FOLLOW toggle

// Editor scene-column functions (the full 8×8 is the note grid, so DOUBLE +
// LENGTH-EDIT live on the otherwise-spare right scene column):
//   row 7 (top) = EXIT · row 6 = DOUBLE · row 5 = LENGTH-EDIT.
//   row 4 = FOLLOW — SINGLE MODE ONLY. In pair mode FOLLOW is CC 98 on the top
//   row, but the single device's CC 98 is the dedicated view-flip, so single
//   mode gives FOLLOW a real button on the next spare scene row (opt-in via the
//   classifier's `followButton` / the frame's `followSceneButton` so the pair
//   surface is untouched byte-for-byte).
export const EDIT_EXIT_SCENE_ROW = LP_HEIGHT - 1; // 7
export const EDIT_DOUBLE_SCENE_ROW = LP_HEIGHT - 2; // 6
export const EDIT_LENGTH_SCENE_ROW = LP_HEIGHT - 3; // 5
export const EDIT_FOLLOW_SCENE_ROW = LP_HEIGHT - 4; // 4 — single mode only
// ── EDITOR scene-column extras (P6) on the previously-dead bottom scene rows
// (3,2,1,0). Both deployments (pair had these rows free too; single's row 4 is
// FOLLOW, rows 3..0 were dead). COPY snapshots the edited clip, PASTE writes the
// buffer over it, OCT ± shift the whole clip ±12 semitones (transpose).
export const EDIT_COPY_SCENE_ROW = 3;
export const EDIT_PASTE_SCENE_ROW = 2;
export const EDIT_OCT_UP_SCENE_ROW = 1;
export const EDIT_OCT_DOWN_SCENE_ROW = 0;
export function isEditExitSceneRow(row: number): boolean {
  return row === EDIT_EXIT_SCENE_ROW;
}
export type EditSceneAction =
  | 'exit'
  | 'double'
  | 'lengthEdit'
  | 'follow'
  | 'copy'
  | 'paste'
  | 'octUp'
  | 'octDown'
  | null;
export function editSceneAction(row: number, opts: { followButton?: boolean } = {}): EditSceneAction {
  if (row === EDIT_EXIT_SCENE_ROW) return 'exit';
  if (row === EDIT_DOUBLE_SCENE_ROW) return 'double';
  if (row === EDIT_LENGTH_SCENE_ROW) return 'lengthEdit';
  if (opts.followButton && row === EDIT_FOLLOW_SCENE_ROW) return 'follow';
  if (row === EDIT_COPY_SCENE_ROW) return 'copy';
  if (row === EDIT_PASTE_SCENE_ROW) return 'paste';
  if (row === EDIT_OCT_UP_SCENE_ROW) return 'octUp';
  if (row === EDIT_OCT_DOWN_SCENE_ROW) return 'octDown';
  return null;
}

// ---------------------------------------------------------------------------
// UNIT R — LENGTH-EDIT page placement. Row 0 = end-BLOCK ruler (pads 0..7 →
// blocks 1..8). Rows 1+2 = end-STEP ruler (steps 1..8 on row 1, 9..16 on row
// 2). EXIT = the top scene button (row 7), same as the editor.
// ---------------------------------------------------------------------------
export const LEN_BLOCK_ROW = 0;
export const LEN_STEP_LO_ROW = 1; // steps 1..8
export const LEN_STEP_HI_ROW = 2; // steps 9..16

/** Classify a LENGTH-EDIT pad on unit R → its action, or null. The EXIT is the
 *  top scene button (handled by the scene-row path), so PAD presses are only
 *  block/step here. */
export function rLengthPad(x: number, y: number): LengthEditAction | null {
  if (y === LEN_BLOCK_ROW) {
    // cell 0..MAX_EDIT_PAGES-1 → block 1..N
    return lengthEditAction(0, x, false);
  }
  if (y === LEN_STEP_LO_ROW) {
    return lengthEditAction(1, x, false); // steps 1..8
  }
  if (y === LEN_STEP_HI_ROW) {
    return lengthEditAction(1, x + STEPS_PER_PAGE / 2, false); // steps 9..16
  }
  return null;
}

// ---------------------------------------------------------------------------
// KEYS mode (note/keyboard + clip-record). In PAIR deployment BOTH units flip
// here together, side-by-side = 16 wide:
//   · top row (y=7) = PLAYHEAD strip, 16 cells (L cols 0..7 = clip cells 0..7,
//     R cols 0..7 = cells 8..15) — the whole clip.
//   · middle 6 rows (y=1..6) = isomorphic KEYBOARD, 6×16 (LinnStrument chromatic
//     fourths), CONTINUOUS across the L|R seam (L col x = keyboard col x, R col x
//     = keyboard col x+8; y=1 = keyboard row 0 up to y=6 = row 5).
//   · bottom row (y=0) = CONTROLS (on unit L only): EXIT · QUEUE-REC · OVERDUB ·
//     LEN; the rest dark (and unit R's bottom row is dark).
// In SINGLE deployment the lone device IS the L half: keyboard cols 0..7 (6×8),
// the same bottom-row controls, and the playhead strip compressed to 8 cells
// spanning the WHOLE clip (KeysFrameOpts.phCells = LP_WIDTH) so the moving dot
// never runs off the one surface.
// ---------------------------------------------------------------------------
export const KEYS_PH_ROW = LP_HEIGHT - 1; // top row (y=7) = playhead strip
export const KEYS_KB_ROW_LO = 1; // keyboard band y=1..6 (row 0 = y=1)
export const KEYS_KB_ROW_HI = LP_HEIGHT - 2; // 6
export const KEYS_KB_ROWS = KEYS_KB_ROW_HI - KEYS_KB_ROW_LO + 1; // 6
export const KEYS_CTRL_ROW = 0; // bottom row (y=0) = controls (unit L only)
export const KEYS_PH_CELLS = LP_WIDTH * 2; // 16 playhead cells across the pair
// Bottom-row control columns (unit L). P7 adds octave ± / panic on the three
// previously-dead cols 3/4/5 (col 6 stays dark).
export const KEYS_EXIT_COL = 0;
export const KEYS_QREC_COL = 1;
export const KEYS_OVERDUB_COL = 2;
export const KEYS_OCT_DOWN_COL = 3; // shift the keyboard down an octave
export const KEYS_OCT_UP_COL = 4; // shift the keyboard up an octave
export const KEYS_PANIC_COL = 5; // kill every sounding auditioned note
export const KEYS_LEN_COL = LP_WIDTH - 1; // 7 (far right)

/** What a KEYS-mode pad does on a given unit. `note` carries the CONTINUOUS
 *  keyboard column (0..15) + row (0..5). Controls are on unit L's bottom row;
 *  `playhead` is display-only (a tap there is a no-op). PURE. */
export type KeysPad =
  | { kind: 'note'; col: number; row: number }
  | { kind: 'exit' }
  | { kind: 'qrec' }
  | { kind: 'overdub' }
  | { kind: 'octUp' }
  | { kind: 'octDown' }
  | { kind: 'panic' }
  | { kind: 'len' }
  | { kind: 'playhead' }
  | null;

export function keysPad(unit: LaunchpadUnit, x: number, y: number): KeysPad {
  if (x < 0 || x >= LP_WIDTH || y < 0 || y >= LP_HEIGHT) return null;
  if (y === KEYS_PH_ROW) return { kind: 'playhead' };
  if (y >= KEYS_KB_ROW_LO && y <= KEYS_KB_ROW_HI) {
    const col = unit === 'L' ? x : x + LP_WIDTH; // continuous across the L|R seam
    return { kind: 'note', col, row: y - KEYS_KB_ROW_LO };
  }
  // y === KEYS_CTRL_ROW (bottom row) — controls live on unit L only.
  if (unit !== 'L') return null;
  if (x === KEYS_EXIT_COL) return { kind: 'exit' };
  if (x === KEYS_QREC_COL) return { kind: 'qrec' };
  if (x === KEYS_OVERDUB_COL) return { kind: 'overdub' };
  if (x === KEYS_OCT_DOWN_COL) return { kind: 'octDown' };
  if (x === KEYS_OCT_UP_COL) return { kind: 'octUp' };
  if (x === KEYS_PANIC_COL) return { kind: 'panic' };
  if (x === KEYS_LEN_COL) return { kind: 'len' };
  return null;
}

// ---------------------------------------------------------------------------
// LED FRAMES (PURE) — build a LaunchpadFrame for each unit/mode from the shared
// brain. The render loop in launchpad-control passes the blink phase so pulses /
// flashes animate (the device only does static RGB; animation = swapping
// triples on the blink cadence, exactly like the monome's brightness blink).
// ---------------------------------------------------------------------------

function put(frame: LaunchpadFrame, index: number, rgb: Rgb): void {
  frame.leds.set(index, [rgb[0], rgb[1], rgb[2]]);
}

// ── UNIT L (the clip matrix) ──
export interface LSessionOpts {
  blinkOn?: boolean;
  /** True if this clip-player is record-armed (paints empty pads dim red). */
  recording?: boolean;
  /** SINGLE-mode clip-view arm strip (undefined / unset in pair mode → the top
   *  row + matrix paint EXACTLY as before). When provided, the top CCs 91..97
   *  paint the 7-cell arm palette, and `armedAction` (non-null) overlays the
   *  aiming wash on the 8×8 (loaded pads one step brighter, empties a faint dot)
   *  so the user can see where an armed action will land. */
  arm?: {
    armedAction: ClipArmAction | null;
    bufferLoaded: boolean;
    nowOn: boolean;
    /** CC-91 KEYS-arm tri-state (the reclaimed NEW cell). */
    keysArm: KeysArm;
  };
  /** PAIR unit L: paint the previously-dead top row (CC 91..98) as the 8 per-lane
   *  MUTE pads (col = lane), read from the `data` passed to computeLSessionFrame.
   *  Undefined in single mode (the arm strip owns the top row) → the top row
   *  paints exactly as before. */
  lTopMute?: boolean;
}

// The faint target dot painted on EMPTY pads under the aiming wash.
const RGB_AIM_DOT: Rgb = RGB_FUNC_DIM;
/** Brighten a triple by ~40% (clamped) — the aiming-wash "one step brighter" for
 *  loaded pads, so the legal targets pop while an action is armed. */
function brighten(rgb: Rgb): Rgb {
  const f = (v: number) => Math.min(127, Math.round(v * 1.5) + 4);
  return [f(rgb[0]), f(rgb[1]), f(rgb[2])];
}

export function computeLSessionFrame(
  data: ClipPlayerData | undefined,
  opts: LSessionOpts = {},
): LaunchpadFrame {
  const frame = emptyFrame();
  const blinkOn = opts.blinkOn ?? true;
  const clips = data?.clips ?? {};
  // Overlay the aiming wash when an arm-then-tap action is armed OR the CC-91
  // KEYS-arm is live (a clip tap will enter KEYS) — both aim at a clip pad.
  const aiming = !!opts.arm && (!!opts.arm.armedAction || opts.arm.keysArm !== 'off');
  for (let lane = 0; lane < CLIP_LANES; lane++) {
    const pl = lanePlaying(data, lane);
    const q = laneQueued(data, lane);
    for (let slot = 0; slot < CLIP_SLOTS; slot++) {
      const idx = clipIndex(slot, lane);
      const pad = clipIndexToLPad(idx); // lane→row flipped (lane 0 = TOP row, matches the card)
      const note = padNote(pad.x, pad.y);
      let rgb: Rgb = RGB_OFF;
      if (pl === slot) {
        // PLAYING = SOLID green (steady — the Ableton idiom: a running clip is
        // solid, a QUEUED clip blinks). A blinking "playing" reads as queued on
        // the hardware, which confused the owner — so playing never blinks here.
        // The ONLY blink while playing is a queued-STOP (flashes red until the
        // boundary), so you can see a stop is pending.
        rgb = q === 'stop' ? (blinkOn ? RGB_QUEUED_STOP : RGB_OFF) : RGB_PLAYING;
      } else if (q === slot) {
        rgb = blinkOn ? RGB_QUEUED : RGB_OFF; // queued-launch flashes
      } else if (clips[String(idx)]) {
        // A loaded clip is steady dim blue. We deliberately do NOT flash the
        // copy-SOURCE clip here: the copy buffer is a frozen SNAPSHOT taken at
        // copy time (see copyClip in launchpad-control), so the live source is
        // no longer special — a "source" glow read as a persistent, confusing
        // link. The buffer-loaded state is shown ONLY by the BUF pad on R (tap
        // it to clear). The blink is reserved for playing/queued state.
        rgb = RGB_LOADED;
      } else if (opts.recording) {
        rgb = RGB_STOP_IDLE; // record-armed empty slot = dim red (Ableton idiom)
      }
      // Aiming wash (single-mode, an action armed): bump loaded/playing pads one
      // step brighter as legal targets; show a faint dot on empties so the whole
      // matrix reads as "tap a pad to apply the armed action".
      if (aiming) {
        if (rgb === RGB_OFF) rgb = RGB_AIM_DOT;
        else rgb = brighten(rgb);
      }
      put(frame, note, rgb);
    }
  }
  // L scene column (CCs 89..19, top→bottom). Each lit amber (idle). SCENE_CCS
  // is top→bottom = rows 7..0; scene row y → slot y, so light rows 0..CLIP_SLOTS-1.
  for (let i = 0; i < SCENE_CCS.length; i++) {
    const row = LP_HEIGHT - 1 - i; // SCENE_CCS[0] = top = row 7
    put(frame, SCENE_CCS[i], row < CLIP_SLOTS ? RGB_SCENE : RGB_OFF);
  }
  // SINGLE-mode clip-view ARM STRIP (top CCs 91..97) — painted when opts.arm is
  // supplied (single mode). PAIR mode instead lights the top row as the 8 per-lane
  // MUTE pads when opts.lTopMute is set (col = lane). They are mutually exclusive
  // (single has arm, pair has lTopMute), and a plain pair clip-role with neither
  // leaves the top row dark, exactly as before this change.
  if (opts.arm) paintClipArmStrip(frame, opts.arm, blinkOn);
  else if (opts.lTopMute) {
    for (let lane = 0; lane < CLIP_LANES; lane++) {
      put(frame, colTopCc(lane), laneMuted(data, lane) ? RGB_MUTE_ON : RGB_MUTE_OFF);
    }
  }
  return frame;
}

/** Paint the 7-cell single-mode arm strip onto the top row (CCs 91..97). Idle
 *  cells show their hue so the row reads as a palette; the armed cell brightens
 *  to its *_ON; COPY pulses turquoise while the buffer is loaded; PASTE/PASTE-REV
 *  dim when no buffer; NOW lights purple while sticky-on. CC 98 is left to the
 *  caller's view marker. PURE. */
function paintClipArmStrip(
  frame: LaunchpadFrame,
  arm: { armedAction: ClipArmAction | null; bufferLoaded: boolean; nowOn: boolean; keysArm: KeysArm },
  blinkOn: boolean,
): void {
  const a = arm.armedAction;
  // KEYS-ARM (CC 91) — the reclaimed NEW cell. Sticky tri-state: off = dim red
  // (KEYS entry available), armed-REC = bright red (overdub OFF), armed-OD =
  // bright purple (overdub ON). Tapping a clip while armed enters KEYS for it.
  put(
    frame,
    CC_UP,
    arm.keysArm === 'rec'
      ? RGB_KEYS_REC_HOLD_ON
      : arm.keysArm === 'od'
      ? RGB_KEYS_OD_HOLD_ON
      : RGB_KEYS_REC_HOLD,
  );
  // COPY (CC 92) — turquoise pulse when the buffer holds a clip, else green.
  put(
    frame,
    CC_DOWN,
    a === 'copy'
      ? RGB_DECK_COPY_ON
      : arm.bufferLoaded
      ? (blinkOn ? RGB_COPY_BUFFER : RGB_COPY_BUFFER_DIM)
      : RGB_DECK_COPY,
  );
  // PASTE (CC 93) / PASTE-REV (CC 94) — dim when no buffer (a no-op-right-now).
  put(frame, CC_LEFT, a === 'paste' ? RGB_DECK_COPY_ON : arm.bufferLoaded ? RGB_DECK_COPY : RGB_FUNC_DIM);
  put(
    frame,
    CC_RIGHT,
    a === 'pasteRev' ? RGB_DECK_COPY_ON : arm.bufferLoaded ? RGB_DECK_COPY : RGB_FUNC_DIM,
  );
  // NOW (CC 95) — sticky toggle: bright purple while on, idle purple otherwise.
  put(frame, CC_SESSION, arm.nowOn ? RGB_DECK_NOW_ON : RGB_DECK_NOW);
  // LENGTH (CC 96) — yellow, brightens when armed.
  put(frame, CC_TOP_SPARE_6, a === 'length' ? RGB_DECK_LEN_ON : RGB_DECK_LEN);
  // DOUBLE (CC 97) — purple, brightens when armed.
  put(frame, CC_TOP_SPARE_7, a === 'double' ? RGB_DECK_DBL_ON : RGB_DECK_DBL);
}

// ── UNIT R (session command deck) ──
export interface RSessionOpts {
  blinkOn?: boolean;
  transportRunning?: boolean;
  editArmed?: boolean;
  copyHeld?: boolean;
  pasteHeld?: boolean;
  pasteRevHeld?: boolean;
  nowHeld?: boolean;
  bufferArmed?: boolean;
  /** Arranger record-arm (node.data.recording) — lights REC red + pulse. */
  recording?: boolean;
  /** Arrangement mode (node.data.clipMode === 'arrangement') — lights SONG white. */
  arrangeMode?: boolean;
  /** KEYS-entry hold buttons held (dual-Launchpad note mode) — brighten them. */
  keysRecHeld?: boolean;
  keysOverdubHeld?: boolean;
  /** Which lanes are playing (lights per-lane STOP active). */
  data?: ClipPlayerData | undefined;
}

export function computeRDeckFrame(opts: RSessionOpts = {}): LaunchpadFrame {
  const frame = emptyFrame();
  const blinkOn = opts.blinkOn ?? true;
  // Per-function colours (owner palette): EDIT orange · COPY/PASTE/P-REV green ·
  // DBL + NOW purple · LEN yellow. Hold-modifiers brighten to *_ON while held.
  const mod = (col: number, on: boolean, idle: Rgb, bright: Rgb) =>
    put(frame, padNote(col, DECK_ROW), on ? bright : idle);
  mod(DECK_EDIT_COL, !!opts.editArmed, RGB_DECK_EDIT, RGB_DECK_EDIT_ON);
  mod(DECK_COPY_COL, !!opts.copyHeld, RGB_DECK_COPY, RGB_DECK_COPY_ON);
  mod(DECK_PASTE_COL, !!opts.pasteHeld, RGB_DECK_COPY, RGB_DECK_COPY_ON);
  mod(DECK_PASTE_REV_COL, !!opts.pasteRevHeld, RGB_DECK_COPY, RGB_DECK_COPY_ON);
  mod(DECK_NOW_COL, !!opts.nowHeld, RGB_DECK_NOW, RGB_DECK_NOW_ON);
  put(frame, padNote(DECK_DOUBLE_COL, DECK_ROW), RGB_DECK_DBL); // DBL — purple (tap)
  put(frame, padNote(DECK_LENGTH_COL, DECK_ROW), RGB_DECK_LEN); // LEN — yellow (tap)
  // KEYS-entry hold buttons (row 1, dark deck pads): note-REC + note-OVERDUB.
  put(
    frame,
    padNote(DECK_KEYS_REC_COL, DECK_KEYS_ROW),
    opts.keysRecHeld ? RGB_KEYS_REC_HOLD_ON : RGB_KEYS_REC_HOLD,
  );
  put(
    frame,
    padNote(DECK_KEYS_OVERDUB_COL, DECK_KEYS_ROW),
    opts.keysOverdubHeld ? RGB_KEYS_OD_HOLD_ON : RGB_KEYS_OD_HOLD,
  );
  // COPY-INDICATOR — turquoise pulse while the buffer holds a clip.
  put(
    frame,
    padNote(DECK_COPY_IND_COL, DECK_ROW),
    opts.bufferArmed ? (blinkOn ? RGB_COPY_BUFFER : RGB_COPY_BUFFER_DIM) : RGB_OFF,
  );
  // Top-row transport + stop-all + arranger SONG controls.
  put(frame, CC_TRANSPORT, opts.transportRunning ? RGB_TRANSPORT_ON : RGB_STOP_IDLE);
  put(frame, CC_STOP_ALL, RGB_STOP_IDLE);
  // REC (CC 91): red, pulses while record-armed; dim red at rest.
  put(
    frame,
    CC_REC,
    opts.recording ? (blinkOn ? RGB_RECORDING : RGB_RECORDING_DIM) : RGB_STOP_IDLE,
  );
  // SONG (CC 92): bright white in ARRANGEMENT, dim white in SESSION.
  put(frame, CC_SONG, opts.arrangeMode ? RGB_SONG_ARRANGE : RGB_SONG_SESSION);
  // TEMPO NUDGE −/+ (CC 93/94): the previously-dead session-deck arrows.
  put(frame, CC_TEMPO_DOWN, RGB_TEMPO_NUDGE);
  put(frame, CC_TEMPO_UP, RGB_TEMPO_NUDGE);
  // RESET pad (row 1, col 2): steel blue — snap all active lanes to step 1.
  put(frame, padNote(DECK_RESET_COL, DECK_RESET_ROW), RGB_RESET);
  // Per-lane performance rows (col = lane): MONO (teal), MUTE (orange when muted),
  // RATE (a cool→warm ramp per rate index). All read from the live node data.
  for (let lane = 0; lane < CLIP_LANES; lane++) {
    put(frame, padNote(lane, DECK_MONO_ROW), laneMono(opts.data, lane) ? RGB_MONO_ON : RGB_MONO_OFF);
    put(frame, padNote(lane, DECK_MUTE_ROW), laneMuted(opts.data, lane) ? RGB_MUTE_ON : RGB_MUTE_OFF);
    put(frame, padNote(lane, DECK_RATE_ROW), RGB_RATE_BY_INDEX[laneRateIndex(opts.data, lane)]);
  }
  // R scene column = per-lane STOP (bright red where a lane plays).
  for (let i = 0; i < SCENE_CCS.length; i++) {
    const row = LP_HEIGHT - 1 - i;
    if (row >= CLIP_LANES) {
      put(frame, SCENE_CCS[i], RGB_OFF);
      continue;
    }
    const playing = lanePlaying(opts.data, row) !== null;
    put(frame, SCENE_CCS[i], playing ? RGB_STOP_ACTIVE : RGB_STOP_IDLE);
  }
  return frame;
}

// ── UNIT R (note editor) ──
export interface REditOpts {
  rowOffset?: number;
  colOffset?: number;
  page?: number;
  /** Live playhead step (-1 when the edited clip isn't playing). */
  playheadStep?: number;
  velArmed?: boolean;
  followOn?: boolean;
  shiftHeld?: boolean;
  /** SINGLE mode: paint the FOLLOW pad on scene row 4 (CC 98 is the view-flip,
   *  so the single editor's FOLLOW lives on the scene column). Pair mode leaves
   *  this unset → row 4 stays dark, exactly as before. */
  followSceneButton?: boolean;
  /** Clipboard holds a clip — lights the editor PASTE scene pad (dim otherwise). */
  bufferLoaded?: boolean;
}

export function computeREditFrame(clip: NoteClipRecord, opts: REditOpts = {}): LaunchpadFrame {
  const frame = emptyFrame();
  const rowOffset = opts.rowOffset ?? 0;
  const colOffset = opts.colOffset ?? 0;
  const page = opts.page ?? 0;
  const playheadStep = opts.playheadStep ?? -1;
  const rootPc = ((clip.root % 12) + 12) % 12;
  for (let y = 0; y < EDIT_ROWS; y++) {
    for (let x = 0; x < EDIT_COLS; x++) {
      const note = editPadToNote(clip, x, y, { rowOffset, colOffset, page });
      const index = padNote(x, y);
      if (!note) {
        put(frame, index, RGB_OFF);
        continue;
      }
      const onPlayhead = note.step === playheadStep;
      const cov = noteCovering(clip, note.step, note.midi);
      if (cov) {
        put(frame, index, onPlayhead ? RGB_NOTE_PLAYHEAD : RGB_NOTE_BY_VEL[velBucket(cov.velocity)]);
      } else if (onPlayhead) {
        put(frame, index, RGB_PLAYHEAD_WASH);
      } else if (((note.midi % 12) + 12) % 12 === rootPc) {
        put(frame, index, RGB_ROOT_GUIDE);
      } else {
        put(frame, index, RGB_OFF);
      }
    }
  }
  // Top-row nav + edit functions.
  const shift = !!opts.shiftHeld;
  put(frame, CC_EDIT_ROW_UP, RGB_FUNC);
  put(frame, CC_EDIT_ROW_DOWN, RGB_FUNC);
  put(frame, CC_EDIT_STEP_LEFT, RGB_FUNC);
  put(frame, CC_EDIT_STEP_RIGHT, RGB_FUNC);
  put(frame, CC_SHIFT, shift ? RGB_FUNC_ON : RGB_FUNC);
  put(frame, CC_EDIT_VEL, opts.velArmed ? RGB_FUNC_ON : RGB_FUNC);
  put(frame, CC_EDIT_SCALE, RGB_FUNC);
  put(frame, CC_EDIT_FOLLOW, opts.followOn ? RGB_TRANSPORT_ON : RGB_FUNC_ON);
  // Scene column: top = EXIT (red), row 6 = DOUBLE, row 5 = LENGTH-EDIT. SINGLE
  // mode adds FOLLOW on row 4 (green = following, violet = frozen). Rows 3,2,1,0
  // are the P6 extras (both modes): COPY (green) · PASTE (green when the buffer
  // holds a clip, dim otherwise) · OCT+ / OCT− (transpose the whole clip ±12).
  for (let i = 0; i < SCENE_CCS.length; i++) {
    const row = LP_HEIGHT - 1 - i;
    let rgb: Rgb = RGB_OFF;
    if (row === EDIT_EXIT_SCENE_ROW) rgb = RGB_EXIT;
    else if (row === EDIT_DOUBLE_SCENE_ROW || row === EDIT_LENGTH_SCENE_ROW) rgb = RGB_FUNC;
    else if (opts.followSceneButton && row === EDIT_FOLLOW_SCENE_ROW)
      rgb = opts.followOn ? RGB_TRANSPORT_ON : RGB_FUNC_ON;
    else if (row === EDIT_COPY_SCENE_ROW) rgb = RGB_DECK_COPY;
    else if (row === EDIT_PASTE_SCENE_ROW) rgb = opts.bufferLoaded ? RGB_DECK_COPY : RGB_FUNC_DIM;
    else if (row === EDIT_OCT_UP_SCENE_ROW || row === EDIT_OCT_DOWN_SCENE_ROW) rgb = RGB_OCTAVE;
    put(frame, SCENE_CCS[i], rgb);
  }
  return frame;
}

// ── UNIT R (length-edit page) ──
export function computeRLengthFrame(clip: NoteClipRecord): LaunchpadFrame {
  const frame = emptyFrame();
  const { endBlock, endStep } = lengthRulers(clip);
  // Row 0: end-BLOCK ruler (pads 0..MAX_EDIT_PAGES-1 → blocks 1..N).
  for (let x = 0; x < LP_WIDTH; x++) {
    const cell = x + 1;
    let rgb: Rgb = RGB_OFF;
    if (x < MAX_EDIT_PAGES) rgb = cell < endBlock ? RGB_LEN_BLOCK : cell === endBlock ? RGB_LEN_END : RGB_OFF;
    put(frame, padNote(x, LEN_BLOCK_ROW), rgb);
  }
  // Rows 1+2: end-STEP ruler (steps 1..8 on row 1, 9..16 on row 2).
  for (let x = 0; x < LP_WIDTH; x++) {
    const lo = x + 1; // step 1..8
    put(
      frame,
      padNote(x, LEN_STEP_LO_ROW),
      lo < endStep ? RGB_LEN_BLOCK : lo === endStep ? RGB_LEN_END : RGB_OFF,
    );
    const hi = x + 1 + STEPS_PER_PAGE / 2; // step 9..16
    put(
      frame,
      padNote(x, LEN_STEP_HI_ROW),
      hi < endStep ? RGB_LEN_BLOCK : hi === endStep ? RGB_LEN_END : RGB_OFF,
    );
  }
  // EXIT (top scene button).
  for (let i = 0; i < SCENE_CCS.length; i++) {
    const row = LP_HEIGHT - 1 - i;
    put(frame, SCENE_CCS[i], row === EDIT_EXIT_SCENE_ROW ? RGB_EXIT : RGB_OFF);
  }
  return frame;
}

// ── KEYS mode (note/keyboard + clip-record) — one unit's 8×8 frame ──
export interface KeysFrameOpts {
  /** Which physical unit — decides the keyboard column offset (L 0..7, R 8..15)
   *  + the playhead cell range (L 0..7, R 8..15), and whether controls paint. */
  unit: LaunchpadUnit;
  /** Bottom-left keyboard cell pitch (MIDI); the clip's root anchors the scale. */
  keyboardRoot: number;
  /** The clip's scale (undefined = chromatic — nothing out-of-scale). */
  scale?: ScaleName;
  /** Live sounding step (-1 = not playing) — drives the playhead strip. */
  playheadStep?: number;
  /** Clip length in steps — scales the 16-cell playhead strip. */
  lengthSteps?: number;
  /** MIDI notes currently sounding (KEYS keypresses) — painted white. */
  pressed?: ReadonlySet<number>;
  /** Queue-REC armed (flashing yellow). */
  recArmed?: boolean;
  /** Recording now (red). */
  recording?: boolean;
  /** Overdub ON (bright purple) vs OFF (light purple). */
  overdub?: boolean;
  blinkOn?: boolean;
  /** Playhead-strip cell count. Defaults to the 16-cell PAIR strip (L 0..7 + R
   *  8..15). SINGLE mode passes LP_WIDTH (8): the lone device's top row spans
   *  the WHOLE clip in 8 cells, so the moving dot never leaves the surface. */
  phCells?: number;
}

export function computeKeysFrame(opts: KeysFrameOpts): LaunchpadFrame {
  const frame = emptyFrame();
  const blinkOn = opts.blinkOn ?? true;
  const root = opts.keyboardRoot;
  const scale = opts.scale;
  const pressed = opts.pressed;
  const colBase = opts.unit === 'L' ? 0 : LP_WIDTH; // keyboard col offset
  const phBase = opts.unit === 'L' ? 0 : LP_WIDTH; // playhead cell offset

  // Keyboard band (y = KEYS_KB_ROW_LO..KEYS_KB_ROW_HI, row 0..5 bottom→up).
  for (let ry = 0; ry < KEYS_KB_ROWS; ry++) {
    const y = KEYS_KB_ROW_LO + ry;
    for (let x = 0; x < LP_WIDTH; x++) {
      const midi = keyboardCellToMidi(colBase + x, ry, root);
      let rgb: Rgb;
      if (pressed?.has(midi)) {
        rgb = RGB_KEY_PRESSED;
      } else {
        const role = noteRole(midi, root, scale);
        rgb = role === 'root' ? RGB_KEY_ROOT : role === 'inscale' ? RGB_KEY_INSCALE : RGB_KEY_OUTSCALE;
      }
      put(frame, padNote(x, y), rgb);
    }
  }

  // Playhead strip (top row, y=7): the whole clip across 16 cells. The current
  // cell DENOTES the record state by COLOUR — red (pulse) while recording,
  // yellow (flash) while armed, white otherwise — so the moving dot itself reads
  // as a "recording now" indicator across the top of both units.
  const step = opts.playheadStep ?? -1;
  const len = opts.lengthSteps ?? 16;
  const phCells = opts.phCells ?? KEYS_PH_CELLS;
  const cur = step >= 0 ? playheadCell(step, len, phCells) : -1;
  const curRgb: Rgb = opts.recording
    ? blinkOn ? RGB_QREC_REC : RGB_RECORDING_DIM
    : opts.recArmed
      ? blinkOn ? RGB_QREC_ARMED : RGB_KEYS_PH_BASE
      : RGB_KEYS_PH_CUR;
  for (let x = 0; x < LP_WIDTH; x++) {
    const cell = phBase + x;
    put(frame, padNote(x, KEYS_PH_ROW), cell === cur ? curRgb : RGB_KEYS_PH_BASE);
  }

  // Bottom-row controls (unit L only; unit R's bottom row stays dark).
  if (opts.unit === 'L') {
    put(frame, padNote(KEYS_EXIT_COL, KEYS_CTRL_ROW), RGB_EXIT);
    // QUEUE-REC differs by COLOUR: idle dull yellow → armed bright yellow (flash)
    // → recording red (pulse). One global blink phase carries flash + pulse.
    let qrec: Rgb;
    if (opts.recording) qrec = blinkOn ? RGB_QREC_REC : RGB_RECORDING_DIM;
    else if (opts.recArmed) qrec = blinkOn ? RGB_QREC_ARMED : RGB_OFF;
    else qrec = RGB_QREC_IDLE;
    put(frame, padNote(KEYS_QREC_COL, KEYS_CTRL_ROW), qrec);
    put(frame, padNote(KEYS_OVERDUB_COL, KEYS_CTRL_ROW), opts.overdub ? RGB_OD_ON : RGB_OD);
    // P7: octave ± (neutral) + PANIC (red-orange) on the previously-dead cols 3/4/5.
    put(frame, padNote(KEYS_OCT_DOWN_COL, KEYS_CTRL_ROW), RGB_OCTAVE);
    put(frame, padNote(KEYS_OCT_UP_COL, KEYS_CTRL_ROW), RGB_OCTAVE);
    put(frame, padNote(KEYS_PANIC_COL, KEYS_CTRL_ROW), RGB_PANIC);
    put(frame, padNote(KEYS_LEN_COL, KEYS_CTRL_ROW), RGB_DECK_LEN);
  }
  return frame;
}

// ===========================================================================
// SINGLE-UNIT REWORK (S2a) — the single-pad Launchpad layout: a 4-view surface
// (Grid / Clip / Arranger / Control) with a PERMANENT top-CC nav row + a hybrid
// shift layer, all over the SAME clip-surface brain. Everything below is
// SINGLE-MODE ONLY and PURE — the stateful handlers (view enum, shift latch/
// hold, tap-to-arm, undo/redo, arp wiring) live in launchpad-control (S2b) and
// consume these classifiers + frame builders. The PAIR-mode code above is
// untouched. Design: .myrobots/plans/launchpad-single-rework-2026-07-12.md.
//
// COORDINATES: the right SCENE column is addressed by SCENE INDEX 0..7 =
// TOP→bottom (scene index i ↔ SCENE_CCS[i] ↔ physical bottom-origin row
// LP_HEIGHT-1-i). EVERY single-mode right-column classifier below takes that
// scene index. The GRID 8×8 is TRANSPOSED vs pair unit-L: x = channel/lane
// (0..7 left→right); the slot runs TOP→bottom (top row = slot 0), so slot =
// LP_HEIGHT-1-y.
// ===========================================================================

// ── Views + permanent top-row navigation ──
export type SingleView = 'grid' | 'clip' | 'arranger' | 'control';
export type TopRowAction =
  | 'transport'
  | 'grid'
  | 'clip'
  | 'arranger'
  | 'control'
  | 'undo'
  | 'redo'
  | 'shift';

/** Classify a permanent top-row CC (91..98) → its nav action, or null. This row
 *  NEVER changes meaning per view: CC91 transport · 92 Grid · 93 Clip · 94
 *  Arranger · 95 Control · 96 undo · 97 redo · 98 shift. PURE. */
export function topRowAction(cc: number): TopRowAction | null {
  switch (cc) {
    case CC_UP:
      return 'transport'; // 91
    case CC_DOWN:
      return 'grid'; // 92
    case CC_LEFT:
      return 'clip'; // 93
    case CC_RIGHT:
      return 'arranger'; // 94
    case CC_SESSION:
      return 'control'; // 95
    case CC_TOP_SPARE_6:
      return 'undo'; // 96
    case CC_TOP_SPARE_7:
      return 'redo'; // 97
    case CC_TOP_SPARE_8:
      return 'shift'; // 98
    default:
      return null;
  }
}

/** Scene INDEX (0 = top … 7 = bottom) for a right-column CC, or null. Inverse of
 *  SCENE_CCS[i]; S2b uses it to route a decoded scene press to the active view's
 *  right-column classifier. PURE. */
export function sceneIndexForCc(cc: number): number | null {
  const i = SCENE_CCS.indexOf(cc as (typeof SCENE_CCS)[number]);
  return i >= 0 ? i : null;
}

// ── GRID transpose (channel-per-COLUMN) ──
/** SINGLE grid pad (x = lane 0..7, y from BOTTOM) → flat clip index, or null out
 *  of the matrix. The slot runs top→bottom, so slot = LP_HEIGHT-1-y, lane = x. */
export function gridPadToClipIndex(x: number, y: number): number | null {
  if (x < 0 || x >= CLIP_LANES || y < 0 || y >= LP_HEIGHT) return null;
  return clipIndexForSlotLane(LP_HEIGHT - 1 - y, x); // slot = LP_HEIGHT-1-y, lane = x
}
/** Flat clip index → its SINGLE grid pad {x = lane, y from BOTTOM}. Inverse of
 *  gridPadToClipIndex (slot 0 = the TOP physical row). PURE. */
export function clipIndexToGridPad(index: number): { x: number; y: number } {
  const { slot, lane } = slotLaneForClipIndex(index);
  return { x: lane, y: LP_HEIGHT - 1 - slot };
}
/** A grid ROW (scene index 0 = top … 7 = bottom) → the SLOT it launches across
 *  ALL channels (a grid row = one clip per channel = a scene), or null. Top row =
 *  slot 0, so slot = sceneIndex. PURE. */
export function gridSceneRowToSlot(sceneIndex: number): number | null {
  return sceneIndex >= 0 && sceneIndex < CLIP_SLOTS ? sceneIndex : null;
}

// ── SCENE-SCROLL WINDOW (single-mode Grid view: reach scenes beyond the 8 rows) ──
// A "scene" is a SLOT fired across all channels. The launchpad shows an 8-row
// WINDOW onto the scene axis; `sceneScrollOffset` (0 = scenes 0..7 at the top)
// slides it. The stored slot axis now spans MAX_SCENES (= SCENE_STRIDE) SLOTS
// (schema-v2 fixed-stride clip keys), so a scene 0..MAX_SCENES-1 backs a REAL,
// populatable slot — the scroll reaches clips placed in scenes ≥ 8. An EMPTY
// scene (no clip in any lane) paints DARK and its launch is a no-op (content-
// gated in computeSingleGridFrame + handleSceneLaunch), and the lazy DOWN reveal
// (maxSceneScrollOffset) still only exposes ONE empty scene past the deepest clip.
export const SCENE_WINDOW = LP_HEIGHT; // 8 visible scene rows (the grid height)
export const MAX_SCENES = SCENE_STRIDE; // 64 — the stored scene ceiling (= the flat-key stride)

/** The GLOBAL scene addressed by a visible scene-column INDEX (0 = top row) at a
 *  scroll offset. offset 0 → scene = sceneIndex. PURE. */
export function sceneForWindowIndex(offset: number, sceneIndex: number): number {
  return offset + sceneIndex;
}

/** The stored SLOT backing a global scene (scene == slot for the whole axis now),
 *  or null when the scene is out of range (< 0 or ≥ MAX_SCENES). A scene in range
 *  with no clips is EMPTY (dark / launch no-op) but still a real, populatable
 *  slot — emptiness is decided by content, not by this returning null. PURE. */
export function slotForScene(scene: number): number | null {
  return scene >= 0 && scene < MAX_SCENES ? scene : null;
}

/** The highest scene index (= slot) that holds ANY clip across all channels, or
 *  -1 when the player is empty. Bounds the lazy DOWN reveal. Scans the FULL
 *  MAX_SCENES slot axis so content placed in scenes ≥ 8 is reachable. PURE. */
export function highestContentScene(data: ClipPlayerData | undefined): number {
  const clips = data?.clips ?? {};
  let hi = -1;
  for (let slot = 0; slot < MAX_SCENES; slot++) {
    for (let lane = 0; lane < CLIP_LANES; lane++) {
      if (clips[String(clipIndex(slot, lane))]) {
        hi = slot;
        break;
      }
    }
  }
  return hi;
}

/** The maximum scroll offset. DOWN lazily reveals ONE empty scene past the
 *  highest scene that holds a clip ("reveal existing+1"), never scrolls past a
 *  full window at the top, and never puts the bottom row past `maxScenes`. So an
 *  empty player can't scroll; content through slot 7 reveals scene 8 (dark);
 *  content deeper (once storage grows) reveals proportionally further. PURE. */
export function maxSceneScrollOffset(
  highestContent: number,
  windowHeight: number = SCENE_WINDOW,
  maxScenes: number = MAX_SCENES,
): number {
  const bottom = Math.max(windowHeight - 1, Math.min(maxScenes - 1, highestContent + 1));
  return bottom - (windowHeight - 1);
}

/** Clamp a raw offset into [0, maxSceneScrollOffset]. Non-finite ⇒ 0. PURE. */
export function clampSceneScrollOffset(
  raw: number,
  highestContent: number,
  windowHeight: number = SCENE_WINDOW,
  maxScenes: number = MAX_SCENES,
): number {
  const max = maxSceneScrollOffset(highestContent, windowHeight, maxScenes);
  const n = Number.isFinite(raw) ? Math.trunc(raw) : 0;
  return Math.max(0, Math.min(max, n));
}

/** SINGLE grid PAD (x = lane, y from BOTTOM) → flat clip index at a scroll
 *  `offset`, or null when out of the matrix OR the pad's scene is out of range.
 *  offset 0 === `gridPadToClipIndex`. Uses `clipIndex` (not clipIndexForSlotLane,
 *  which caps at the visible CLIP_SLOTS) so a scrolled-in scene ≥ 8 maps to its
 *  real stored slot. PURE. */
export function gridPadToClipIndexScrolled(x: number, y: number, offset: number): number | null {
  if (x < 0 || x >= CLIP_LANES || y < 0 || y >= LP_HEIGHT) return null;
  const scene = offset + (LP_HEIGHT - 1 - y); // top row (y=7) = scene `offset`
  const slot = slotForScene(scene);
  return slot === null ? null : clipIndex(slot, x); // slot = scene, lane = x
}

/** The PHYSICAL grid pad {x = lane, y from BOTTOM} showing a stored slot at a
 *  scroll `offset`, or null when that slot is scrolled off the window. Inverse of
 *  gridPadToClipIndexScrolled for the loaded region (scene == slot). PURE. */
export function gridPadForScrolledSlot(
  slot: number,
  lane: number,
  offset: number,
): { x: number; y: number } | null {
  const row = slot - offset; // window row from the TOP (0 = top)
  if (row < 0 || row >= LP_HEIGHT) return null;
  return { x: lane, y: LP_HEIGHT - 1 - row };
}

// ── Right-column classifiers (per view). All take a SCENE INDEX (0 = top). ──
export type GridShiftAction =
  | 'copy'
  | 'paste'
  | 'clipDiv'
  | 'swingUp'
  | 'swingDown'
  | 'len'
  | 'scrollUp'
  | 'scrollDown';
/** The tap-to-ARM subset of GridShiftAction (Swing± are DIRECT nudges + Scroll▲▼
 *  slide the scene window — none of those is armed). S2b stores one of these in
 *  armedRightAction. */
export type GridArmAction = 'copy' | 'paste' | 'clipDiv' | 'len';

const GRID_SHIFT_ACTIONS: readonly GridShiftAction[] = [
  'copy', // 0 (top)
  'paste', // 1
  'clipDiv', // 2
  'swingUp', // 3
  'swingDown', // 4
  'len', // 5
  'scrollUp', // 6 — was PASTE-REV; repurposed to the amber scene-window UP button
  'scrollDown', // 7 (bottom) — was NOW; repurposed to the amber scene-window DOWN button
];
/** Grid + shift right column (scene 0..7 top→bottom): Copy · Paste · ClipDiv ·
 *  Swing+ · Swing− · Len · PasteRev · Now. Null out of range. PURE. */
export function gridShiftRight(sceneIndex: number): GridShiftAction | null {
  return sceneIndex >= 0 && sceneIndex < GRID_SHIFT_ACTIONS.length
    ? GRID_SHIFT_ACTIONS[sceneIndex]
    : null;
}

export type ClipRightAction =
  | 'double'
  | 'lengthEdit'
  | 'follow'
  | 'keys'
  | 'rowUp'
  | 'rowDown'
  | 'stepLeft'
  | 'stepRight';
const CLIP_RIGHT_ACTIONS: readonly ClipRightAction[] = [
  'double', // 0 (top)
  'lengthEdit', // 1
  'follow', // 2
  'keys', // 3
  'rowUp', // 4
  'rowDown', // 5
  'stepLeft', // 6
  'stepRight', // 7 (bottom)
];
/** Clip view right column (scene 0..7): Double · LengthEdit · Follow · Keys ·
 *  RowUp · RowDown · Step◀ · Step▶. Null out of range. PURE. */
export function clipRight(sceneIndex: number): ClipRightAction | null {
  return sceneIndex >= 0 && sceneIndex < CLIP_RIGHT_ACTIONS.length
    ? CLIP_RIGHT_ACTIONS[sceneIndex]
    : null;
}

/** Keys view (NO shift) right column (scene 0..7): scales major..mixolydian
 *  (0..5, in SCALE_NAMES order), CHROMATIC (6 = {scale:undefined}), ARP on/off
 *  toggle (7). Null out of range. Chromatic is represented as {scale:undefined}
 *  (NOT the string 'chromatic') so S2b writes it straight onto clip.scale. PURE. */
export function keysScaleRight(
  sceneIndex: number,
): { scale: ScaleName | undefined } | 'arpToggle' | null {
  if (sceneIndex === 7) return 'arpToggle';
  if (sceneIndex === 6) return { scale: undefined }; // chromatic (absence of a scale)
  if (sceneIndex >= 0 && sceneIndex <= 5) return { scale: SCALE_NAMES[sceneIndex] };
  return null;
}

export type KeysArpAction =
  | 'arpDivUp'
  | 'arpDivDown'
  | 'arpUp'
  | 'arpDown'
  | 'arpUpDown'
  | 'arpRangeUp'
  | 'arpRangeDown'
  | 'arpLatch';
const KEYS_ARP_ACTIONS: readonly KeysArpAction[] = [
  'arpDivUp', // 0 (top)
  'arpDivDown', // 1
  'arpUp', // 2
  'arpDown', // 3
  'arpUpDown', // 4
  'arpRangeUp', // 5
  'arpRangeDown', // 6
  'arpLatch', // 7 (bottom)
];
/** Keys view (+ shift) right column (scene 0..7): ArpDiv+ · ArpDiv− · ArpUp ·
 *  ArpDown · ArpUpDown · ArpRange+ · ArpRange− · ArpLatch. Null out of range. PURE. */
export function keysArpShiftRight(sceneIndex: number): KeysArpAction | null {
  return sceneIndex >= 0 && sceneIndex < KEYS_ARP_ACTIONS.length
    ? KEYS_ARP_ACTIONS[sceneIndex]
    : null;
}

/** Control view right column = per-lane STOP (reuses rStopLaneForRow semantics).
 *  Scene index 0 (top) = lane 7 … scene 7 (bottom) = lane 0 (row = lane, exactly
 *  like the pair deck's STOP column). Returns the lane, or null. PURE. */
export function controlRight(sceneIndex: number): number | null {
  if (sceneIndex < 0 || sceneIndex >= LP_HEIGHT) return null;
  return rStopLaneForRow(LP_HEIGHT - 1 - sceneIndex);
}

// ── CONTROL view RE-HOME pads — the displaced deck top-row functions land on
// currently-dark deck grid pads (the permanent CC row owns the real top row).
// Transport nudges + STOP-ALL group on the TOP grid row; arranger REC/SONG one
// row below. Remaining cols stay dark for legibility. (RESET / MONO / MUTE / RATE
// reuse the shared rDeckReset / rDeckMonoLane / rDeckMuteLane / rDeckRateLane
// classifiers; per-lane STOP is controlRight.)
export const CTRL_TEMPO_ROW = LP_HEIGHT - 1; // 7 (top grid row)
export const CTRL_TEMPO_DOWN_COL = 0; // (0,7)
export const CTRL_TEMPO_UP_COL = 1; // (1,7)
export const CTRL_STOP_ALL_COL = 3; // (3,7)
export const CTRL_ARRANGE_ROW = LP_HEIGHT - 2; // 6
export const CTRL_REC_COL = 0; // (0,6)
export const CTRL_SONG_COL = 1; // (1,6)
/** AUTOMATION record-arm — a dark deck pad on the arrange row (2,6), grouped
 *  beside the arranger REC (0,6) + SONG (1,6). Chosen because it is UNUSED in the
 *  Control view (RESET is (2,1); MONO/MUTE/RATE own rows 2/3/4; STOP-ALL is
 *  (3,7); the per-lane STOP scene column + the Grid-shift copy/paste/scene-scroll
 *  /swing/div/len palette are OTHER views) and semantically it is a record-arm,
 *  so it sits with the other record/mode controls. */
export const CTRL_AUTO_ARM_COL = 2; // (2,6)

export type ControlRehomeAction =
  | 'tempoDown'
  | 'tempoUp'
  | 'stopAll'
  | 'rec'
  | 'song'
  | 'autoArm';
/** Classify a CONTROL-view re-homed grid pad → its action, or null. PURE. */
export function controlRehomePad(x: number, y: number): ControlRehomeAction | null {
  if (y === CTRL_TEMPO_ROW) {
    if (x === CTRL_TEMPO_DOWN_COL) return 'tempoDown';
    if (x === CTRL_TEMPO_UP_COL) return 'tempoUp';
    if (x === CTRL_STOP_ALL_COL) return 'stopAll';
    return null;
  }
  if (y === CTRL_ARRANGE_ROW) {
    if (x === CTRL_REC_COL) return 'rec';
    if (x === CTRL_SONG_COL) return 'song';
    if (x === CTRL_AUTO_ARM_COL) return 'autoArm';
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// SINGLE-MODE LED FRAMES (PURE). Each view's frame paints its 8×8 + right column
// then the PERMANENT TOP ROW via the shared paintPermanentTopRow. The render loop
// (S2b) passes the blink phase (software pulse/flash) + all the stateful opts.
// ---------------------------------------------------------------------------

// ── Meter ramp helpers (pale→bright per level) for the Swing± meter. PURE. ──
function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
function lerpRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const u = clamp01(t);
  const f = (x: number, y: number) => Math.max(0, Math.min(127, Math.round(x + (y - x) * u)));
  return [f(a[0], b[0]), f(a[1], b[1]), f(a[2], b[2])];
}
/** Ramp a tint pale→full by level 0..1 (the meter's low end is ~12% of the tint). */
function rampRgb(tint: Rgb, level0to1: number): Rgb {
  const pale: Rgb = [
    Math.round(tint[0] * 0.12),
    Math.round(tint[1] * 0.12),
    Math.round(tint[2] * 0.12),
  ];
  return lerpRgb(pale, tint, level0to1);
}

/** The PERMANENT top-row contract — the fields EVERY single-mode frame supplies
 *  to paintPermanentTopRow. S2b builds one of these per render pass. */
export interface PermanentTopOpts {
  /** The active view — its nav button lights bright; the other three dim. */
  view: SingleView;
  /** In KEYS (a sub-view of Clip) → the CLIP button lights bright too. */
  keysActive: boolean;
  transportRunning: boolean;
  /** Shift state for the CC98 LED (dim off · bright held · solid latched). The
   *  EFFECTIVE shift (latched || held) also drives the right-column alt meanings
   *  in every view frame (the frames read it from here — there is no separate
   *  `shift` field to keep in sync). */
  shift: { latched: boolean; held: boolean };
  /** Undo / redo stacks non-empty → the orange CC96 / CC97 light; else dim. */
  canUndo: boolean;
  canRedo: boolean;
}

/** Paint the permanent nav row (CC 91..98) onto a frame — identical in every
 *  view: transport (red stopped / green running), the 4 view buttons (bright
 *  purple = active; Clip bright while KEYS is open), undo/redo (orange, dim when
 *  the stack is empty), shift (yellow: dim off / bright held / solid latched).
 *  PURE. */
export function paintPermanentTopRow(frame: LaunchpadFrame, opts: PermanentTopOpts): void {
  put(frame, CC_UP, opts.transportRunning ? RGB_TRANSPORT_ON : RGB_TRANSPORT_STOP);
  put(frame, CC_DOWN, opts.view === 'grid' ? RGB_VIEW_ACTIVE : RGB_VIEW_IDLE);
  put(frame, CC_LEFT, opts.view === 'clip' || opts.keysActive ? RGB_VIEW_ACTIVE : RGB_VIEW_IDLE);
  put(frame, CC_RIGHT, opts.view === 'arranger' ? RGB_VIEW_ACTIVE : RGB_VIEW_IDLE);
  put(frame, CC_SESSION, opts.view === 'control' ? RGB_VIEW_ACTIVE : RGB_VIEW_IDLE);
  put(frame, CC_TOP_SPARE_6, opts.canUndo ? RGB_SYS : RGB_SYS_DIM);
  put(frame, CC_TOP_SPARE_7, opts.canRedo ? RGB_SYS : RGB_SYS_DIM);
  put(
    frame,
    CC_TOP_SPARE_8,
    opts.shift.held ? RGB_SHIFT_HELD : opts.shift.latched ? RGB_SHIFT_LATCH : RGB_SHIFT_OFF,
  );
}

/** Effective shift = latched OR momentary-held (drives right-column alt colours). */
function effShift(top: PermanentTopOpts): boolean {
  return top.shift.latched || top.shift.held;
}

// ── SINGLE Grid view ──
export interface SingleGridOpts {
  top: PermanentTopOpts;
  blinkOn?: boolean;
  /** This clip-player is record-armed → empty pads show dim red. */
  recording?: boolean;
  /** The armed tap-to-arm right-column action (grid+shift) → brightened. */
  armedRightAction?: GridArmAction | null;
  /** The copy buffer holds SOMETHING → the Paste button pulses. */
  bufferLoaded?: boolean;
  /** WHICH kind the buffer holds — a CLIP buffer pulses turquoise, a SCENE buffer
   *  amber. Also drives the paste-arm target dimming (below). Undefined/null =
   *  empty. */
  bufferKind?: CopyBufferKind | null;
  /** Scene-window scroll offset (0 = scenes 0..7). Slides the matrix + scene
   *  column so visual row r shows scene `offset + r`. Default 0. */
  sceneScrollOffset?: number;
  /** UP is actionable (offset > 0) → bright amber; else dim. Default true. */
  canScrollUp?: boolean;
  /** DOWN can reveal a further scene → bright amber; else dim. Default true. */
  canScrollDown?: boolean;
  /** Pulse the TARGET clip pad blue in time with its chosen division (the Clip-Div
   *  arm preview — the meter is ON the pad, not the top row). S2b toggles `on` on
   *  the division's phase. */
  divPulse?: { clipIndex: number; on: boolean };
  /** Swing± meter: ramp the Swing+ (purple) / Swing− (blue) button pale→bright by
   *  level, or flash both green at dead-centre. Only rendered under shift. */
  swingMeter?: { active: boolean; dir: 'up' | 'down' | 'center'; level0to1: number };
  /** AUTOMATION countdown flash for the automation clip's matrix cell (last 4
   *  beats before its own wrap). Painted only when that clip's scene is inside the
   *  current scroll window. */
  autoCountdown?: (CountdownPaint & { clipIndex: number }) | null;
}

/** The clip-state colour for a matrix pad — identical semantics to
 *  computeLSessionFrame (playing SOLID green · queued-launch flash green ·
 *  queued-stop flash red · loaded dim blue · record-armed empty dim red · else
 *  off), just re-used for the transposed single grid. PURE. */
/** Parse a `#rgb` / `#rrggbb` hex → an RGB triple in the 0..127 lighting range
 *  (the card stores the picked channel colour as hex; the pad LEDs are 0..127). */
export function hexToRgb127(hex: string): Rgb {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const v = (i: number) => {
    const n = parseInt(h.slice(i, i + 2), 16);
    return Number.isFinite(n) ? Math.round((n * 127) / 255) : 0;
  };
  return [v(0), v(2), v(4)];
}
/** Scale an RGB triple's brightness (for the dim loaded state off a picked colour). */
function scaleRgb(rgb: Rgb, f: number): Rgb {
  return [Math.round(rgb[0] * f), Math.round(rgb[1] * f), Math.round(rgb[2] * f)];
}

function singleClipStateRgb(
  data: ClipPlayerData | undefined,
  idx: number,
  slot: number,
  lane: number,
  blinkOn: boolean,
  recording: boolean,
): Rgb {
  const pl = lanePlaying(data, lane);
  const q = laneQueued(data, lane);
  // Every channel's EFFECTIVE colour (the picked colour, else its default hue)
  // tints the clip states on the pad — dim when loaded, full when playing,
  // flashing when queued — so the pad matches the CARD for ALL channels, not
  // just picked ones. Empty pads stay OFF; a queued-STOP keeps the semantic RED
  // so a pending stop still reads regardless of the channel colour.
  const base = hexToRgb127(laneColorEff(data, lane));
  if (pl === slot) {
    if (q === 'stop') return blinkOn ? RGB_QUEUED_STOP : RGB_OFF;
    return base;
  }
  if (q === slot) return blinkOn ? base : RGB_OFF;
  if ((data?.clips ?? {})[String(idx)]) return scaleRgb(base, 0.32);
  if (recording) return RGB_STOP_IDLE;
  return RGB_OFF;
}

function swingButtonRgb(which: 'up' | 'down', meter: SingleGridOpts['swingMeter']): Rgb {
  if (!meter || !meter.active) return RGB_TIMING;
  if (meter.dir === 'center') return RGB_SWING_CENTER; // flashed green on return-to-centre
  if (meter.dir === which) return rampRgb(which === 'up' ? RGB_SWING_UP : RGB_SWING_DOWN, meter.level0to1);
  return RGB_TIMING;
}

function gridShiftRightRgb(sceneIndex: number, opts: SingleGridOpts, blinkOn: boolean): Rgb {
  const armed = opts.armedRightAction ?? null;
  switch (gridShiftRight(sceneIndex)) {
    case 'copy':
      return armed === 'copy' ? RGB_PATTERN_ARMED : RGB_PATTERN;
    case 'paste':
      if (armed === 'paste') return RGB_PATTERN_ARMED;
      if (!opts.bufferLoaded) return RGB_PATTERN;
      // A loaded buffer pulses the Paste button its buffer-kind colour: turquoise
      // for a CLIP buffer, amber for a whole SCENE.
      return opts.bufferKind === 'scene'
        ? (blinkOn ? RGB_COPY_BUFFER_SCENE : RGB_COPY_BUFFER_SCENE_DIM)
        : (blinkOn ? RGB_COPY_BUFFER : RGB_COPY_BUFFER_DIM);
    case 'clipDiv':
      return armed === 'clipDiv' ? RGB_TIMING_ARMED : RGB_TIMING;
    case 'swingUp':
      return swingButtonRgb('up', opts.swingMeter);
    case 'swingDown':
      return swingButtonRgb('down', opts.swingMeter);
    case 'len':
      return armed === 'len' ? RGB_DECK_LEN_ON : RGB_DECK_LEN;
    case 'scrollUp':
      // amber (scene colour) UP — dim when already at the top (offset 0).
      return opts.canScrollUp === false ? RGB_SCENE_DIM : RGB_SCENE;
    case 'scrollDown':
      // amber (scene colour) DOWN — dim when no further scene can be revealed.
      return opts.canScrollDown === false ? RGB_SCENE_DIM : RGB_SCENE;
    default:
      return RGB_OFF;
  }
}

/** SINGLE Grid view — the transposed 8×8 clip matrix + the right column (no-shift
 *  scene/row launch OR the grid-shift function palette) + the permanent top row.
 *  Alt (shift) meanings render only when the effective shift is true. PURE. */
export function computeSingleGridFrame(
  data: ClipPlayerData | undefined,
  opts: SingleGridOpts,
): LaunchpadFrame {
  const frame = emptyFrame();
  const blinkOn = opts.blinkOn ?? true;
  const shift = effShift(opts.top);
  const recording = !!opts.recording;
  const offset = opts.sceneScrollOffset ?? 0;
  // PASTE-ARM target dimming (VISIBLE no-op, not silent): while a paste is armed in
  // the no-shift matrix, only the buffer's VALID target class lights — a SCENE
  // buffer lights the scene-launch column + dims the clip pads; a CLIP buffer keeps
  // the clip pads + dims the scene column. So an illegal target (scene→clip /
  // clip→scene) reads as "not a target" rather than a mystery no-op. Only under
  // no-shift (under shift the right column is the grid-shift palette). COPY leaves
  // both classes lit — either is a legal copy source.
  const pasteArmed = !shift && opts.armedRightAction === 'paste' && !!opts.bufferLoaded;
  const sceneBuffer = opts.bufferKind === 'scene';
  const dimClipPads = pasteArmed && sceneBuffer; // clip pads are the invalid class
  const dimSceneCol = pasteArmed && !sceneBuffer; // scene column is the invalid class
  // Transposed clip matrix (x = lane, scene top→bottom) through the scroll window:
  // visual row r (top = 0) shows scene `offset + r`. Each in-range scene paints its
  // per-cell clip state (an empty cell is DARK); a scene out of range (≥ MAX_SCENES)
  // is DARK.
  for (let lane = 0; lane < CLIP_LANES; lane++) {
    for (let row = 0; row < LP_HEIGHT; row++) {
      const y = LP_HEIGHT - 1 - row;
      const slot = slotForScene(offset + row);
      if (slot === null) {
        put(frame, padNote(lane, y), RGB_OFF);
        continue;
      }
      const idx = clipIndex(slot, lane);
      let rgb = singleClipStateRgb(data, idx, slot, lane, blinkOn, recording);
      if (dimClipPads) rgb = scaleRgb(rgb, 0.15); // invalid target class → dimmed
      put(frame, padNote(lane, y), rgb);
    }
  }
  // Clip-Div preview: pulse the target clip pad blue in time with its division
  // (only when that clip's scene is inside the current scroll window).
  if (opts.divPulse) {
    const { slot, lane } = slotLaneForClipIndex(opts.divPulse.clipIndex);
    const pad = gridPadForScrolledSlot(slot, lane, offset);
    if (pad) put(frame, padNote(pad.x, pad.y), opts.divPulse.on ? RGB_TIMING_ARMED : RGB_TIMING);
  }
  // AUTOMATION countdown: flash the automation clip's own matrix cell 🟡🟡🔴🔴 in
  // the last 4 beats before its wrap (only when its scene is in the scroll window).
  if (opts.autoCountdown) {
    const { slot, lane } = slotLaneForClipIndex(opts.autoCountdown.clipIndex);
    const pad = gridPadForScrolledSlot(slot, lane, offset);
    if (pad) put(frame, padNote(pad.x, pad.y), countdownRgb(opts.autoCountdown));
  }
  // Right column: no-shift = scene/row launch (amber when the scene HAS a clip in
  // any lane; flash when a lane is queued that slot; DARK for an EMPTY scene —
  // content-gated so a scrolled-in empty scene reads as "nothing to launch");
  // +shift = the grid-shift function palette (incl. the amber scene-window UP/DOWN).
  const clips = data?.clips ?? {};
  for (let i = 0; i < SCENE_CCS.length; i++) {
    let rgb: Rgb;
    if (shift) {
      rgb = gridShiftRightRgb(i, opts, blinkOn);
    } else {
      const slot = slotForScene(offset + i);
      if (slot === null) rgb = RGB_OFF;
      else if (pasteArmed && sceneBuffer) {
        // Scene-buffer paste armed: every in-range scene is a VALID target (even
        // an empty one — a scene paste can FILL it), pulsing the amber scene-buffer
        // colour so the scene column reads as "tap to paste the scene here".
        rgb = blinkOn ? RGB_COPY_BUFFER_SCENE : RGB_COPY_BUFFER_SCENE_DIM;
      } else if (dimSceneCol) {
        rgb = RGB_SCENE_DIM; // clip-buffer paste: scene column is the invalid class
      } else {
        let anyQueued = false;
        let anyContent = false;
        for (let lane = 0; lane < CLIP_LANES; lane++) {
          if (clips[String(clipIndex(slot, lane))]) anyContent = true;
          if (laneQueued(data, lane) === slot) {
            anyQueued = true;
            break;
          }
        }
        rgb = anyQueued
          ? (blinkOn ? RGB_QUEUED : RGB_OFF)
          : anyContent
          ? RGB_SCENE
          : RGB_OFF; // empty scene → dark (content-gated)
      }
    }
    put(frame, SCENE_CCS[i], rgb);
  }
  paintPermanentTopRow(frame, opts.top);
  return frame;
}

// ── SINGLE Clip view (note editor) ──
export interface SingleClipOpts {
  top: PermanentTopOpts;
  rowOffset?: number;
  colOffset?: number;
  page?: number;
  /** Live playhead step (-1 when the edited clip isn't playing). */
  playheadStep?: number;
  followOn?: boolean;
  /** Velocity-edit mode (shift in Clip) → a subtle wash over the note grid. S2b
   *  drives this (typically = the effective shift). */
  velEditing?: boolean;
  blinkOn?: boolean;
}

function clipRightRgb(sceneIndex: number, opts: SingleClipOpts, shift: boolean): Rgb {
  switch (clipRight(sceneIndex)) {
    case 'double':
    case 'lengthEdit':
      return RGB_PATTERN;
    case 'follow':
      return opts.followOn ? RGB_PATTERN_ARMED : RGB_PATTERN;
    case 'keys':
      return RGB_KEYS_ENTRY;
    case 'rowUp':
    case 'rowDown':
      return shift ? RGB_PATTERN_ARMED : RGB_PATTERN; // shift = page/octave tint
    case 'stepLeft':
    case 'stepRight':
      return shift ? RGB_TIMING_ARMED : RGB_TIMING; // shift = block-jump tint
    default:
      return RGB_OFF;
  }
}

/** SINGLE Clip view — the note editor 8×8 (+ playhead) reusing the pair editor's
 *  note colouring, but with the clipRight right column + the permanent top row
 *  (the editor's own top-CC nav is REPLACED by the permanent row). Under shift a
 *  faint velocity-edit wash tints the empty grid cells (velEditing). PURE. */
export function computeSingleClipFrame(clip: NoteClipRecord, opts: SingleClipOpts): LaunchpadFrame {
  const frame = emptyFrame();
  const rowOffset = opts.rowOffset ?? 0;
  const colOffset = opts.colOffset ?? 0;
  const page = opts.page ?? 0;
  const playheadStep = opts.playheadStep ?? -1;
  const velEditing = !!opts.velEditing;
  const shift = effShift(opts.top);
  const rootPc = ((clip.root % 12) + 12) % 12;
  const bg: Rgb = velEditing ? RGB_VEL_WASH : RGB_OFF;
  for (let y = 0; y < EDIT_ROWS; y++) {
    for (let x = 0; x < EDIT_COLS; x++) {
      const note = editPadToNote(clip, x, y, { rowOffset, colOffset, page });
      const index = padNote(x, y);
      if (!note) {
        put(frame, index, bg);
        continue;
      }
      const onPlayhead = note.step === playheadStep;
      const cov = noteCovering(clip, note.step, note.midi);
      if (cov) {
        put(frame, index, onPlayhead ? RGB_NOTE_PLAYHEAD : RGB_NOTE_BY_VEL[velBucket(cov.velocity)]);
      } else if (onPlayhead) {
        put(frame, index, RGB_PLAYHEAD_WASH);
      } else if (((note.midi % 12) + 12) % 12 === rootPc) {
        put(frame, index, RGB_ROOT_GUIDE);
      } else {
        put(frame, index, bg);
      }
    }
  }
  for (let i = 0; i < SCENE_CCS.length; i++) {
    put(frame, SCENE_CCS[i], clipRightRgb(i, opts, shift));
  }
  paintPermanentTopRow(frame, opts.top);
  return frame;
}

// ── SINGLE Keys view (sub-view of Clip) ──
export interface SingleKeysOpts {
  top: PermanentTopOpts;
  /** Keyboard + playhead + bottom-controls inputs (forwarded to computeKeysFrame;
   *  the unit is fixed to the lone device and the playhead strip is the single
   *  8-cell strip, phCells = LP_WIDTH). */
  keyboardRoot: number;
  scale?: ScaleName;
  playheadStep?: number;
  lengthSteps?: number;
  pressed?: ReadonlySet<number>;
  recArmed?: boolean;
  recording?: boolean;
  overdub?: boolean;
  blinkOn?: boolean;
  // Right column (no-shift scale-select / +shift arp).
  /** The clip's selected scale (bright in the scale-select column; undefined =
   *  chromatic → the CHROMATIC button is the selected one). */
  selectedScale: ScaleName | undefined;
  arpOn: boolean;
  arpDir: ArpDirection;
  /** Current arp division / octave-range indices (the Div± / Range± buttons are
   *  static nudges — these are kept on the contract for parity + a future meter). */
  arpDivIndex: number;
  arpRangeIndex: number;
  arpLatch: boolean;
}

function keysScaleRightRgb(sceneIndex: number, selectedScale: ScaleName | undefined, arpOn: boolean): Rgb {
  const r = keysScaleRight(sceneIndex);
  if (r === null) return RGB_OFF;
  if (r === 'arpToggle') return arpOn ? RGB_SYS : RGB_SYS_DIM;
  return r.scale === selectedScale ? RGB_PATTERN_ARMED : RGB_PATTERN;
}
function keysArpRightRgb(sceneIndex: number, opts: SingleKeysOpts): Rgb {
  switch (keysArpShiftRight(sceneIndex)) {
    case 'arpDivUp':
    case 'arpDivDown':
      return RGB_TIMING;
    case 'arpUp':
      return opts.arpDir === 'up' ? RGB_PATTERN_ARMED : RGB_PATTERN;
    case 'arpDown':
      return opts.arpDir === 'down' ? RGB_PATTERN_ARMED : RGB_PATTERN;
    case 'arpUpDown':
      return opts.arpDir === 'updown' ? RGB_PATTERN_ARMED : RGB_PATTERN;
    case 'arpRangeUp':
    case 'arpRangeDown':
      return RGB_SYS;
    case 'arpLatch':
      return opts.arpLatch ? RGB_SYS : RGB_SYS_DIM;
    default:
      return RGB_OFF;
  }
}

/** SINGLE Keys view — the isomorphic keyboard + playhead strip + bottom controls
 *  (via computeKeysFrame, single 8-cell strip) PLUS the right column: no-shift
 *  scale-select + arp on/off; +shift the arp control column. Permanent top row on
 *  top. PURE. */
export function computeSingleKeysFrame(opts: SingleKeysOpts): LaunchpadFrame {
  const frame = computeKeysFrame({
    unit: 'L',
    keyboardRoot: opts.keyboardRoot,
    scale: opts.scale,
    playheadStep: opts.playheadStep,
    lengthSteps: opts.lengthSteps,
    pressed: opts.pressed,
    recArmed: opts.recArmed,
    recording: opts.recording,
    overdub: opts.overdub,
    blinkOn: opts.blinkOn,
    phCells: LP_WIDTH, // single: the playhead strip spans the whole clip in 8 cells
  });
  const shift = effShift(opts.top);
  for (let i = 0; i < SCENE_CCS.length; i++) {
    put(
      frame,
      SCENE_CCS[i],
      shift ? keysArpRightRgb(i, opts) : keysScaleRightRgb(i, opts.selectedScale, opts.arpOn),
    );
  }
  paintPermanentTopRow(frame, opts.top);
  return frame;
}

// ── SINGLE Control view (session performance deck, re-homed) ──
/** The resolved AUTOMATION COUNTDOWN flash for a pad — a colour bucket + the
 *  on/off pulse phase, derived (in the control layer) from the published
 *  automation render state via the pure automationCountdown* helpers. `clipIndex`
 *  (grid view only) marks WHICH matrix cell is the automation clip. */
export interface CountdownPaint {
  color: 'yellow' | 'red';
  on: boolean;
}

/** Map a countdown colour + pulse phase to an RGB (bright on-beat / dim between),
 *  reusing the existing record/qrec palette. PURE. */
export function countdownRgb(paint: CountdownPaint): Rgb {
  if (paint.color === 'yellow') return paint.on ? RGB_QREC_ARMED : RGB_QREC_IDLE;
  return paint.on ? RGB_RECORDING : RGB_RECORDING_DIM;
}

export interface SingleControlOpts {
  top: PermanentTopOpts;
  blinkOn?: boolean;
  /** Arranger record-arm (node.data.recording) — lights the re-homed REC red + pulse. */
  recording?: boolean;
  /** Arrangement mode (node.data.clipMode === 'arrangement') — lights re-homed SONG. */
  arrangeMode?: boolean;
  /** AUTOMATION countdown flash for the AUTO-arm pad (last 4 beats before the
   *  automation clip's own wrap). Overrides the steady armed/idle colour. */
  autoCountdown?: CountdownPaint | null;
  data?: ClipPlayerData | undefined;
}

/** SINGLE Control view — the session performance deck (RESET · per-lane MONO /
 *  MUTE / RATE rows · per-lane STOP scene column) with the displaced transport /
 *  arranger controls RE-HOMED onto dark grid pads (TEMPO−/+ + STOP-ALL on the top
 *  grid row; REC / SONG one row below), and the permanent top row on top. The old
 *  deck top row + the row-0 EDIT/COPY/… functions are NOT painted (re-homed to
 *  the permanent row + Grid-shift respectively). PURE. */
export function computeSingleControlFrame(opts: SingleControlOpts): LaunchpadFrame {
  const frame = emptyFrame();
  const blinkOn = opts.blinkOn ?? true;
  const data = opts.data;
  // RESET (row 1 col 2) + per-lane MONO / MUTE / RATE rows (col = lane).
  put(frame, padNote(DECK_RESET_COL, DECK_RESET_ROW), RGB_RESET);
  for (let lane = 0; lane < CLIP_LANES; lane++) {
    put(frame, padNote(lane, DECK_MONO_ROW), laneMono(data, lane) ? RGB_MONO_ON : RGB_MONO_OFF);
    put(frame, padNote(lane, DECK_MUTE_ROW), laneMuted(data, lane) ? RGB_MUTE_ON : RGB_MUTE_OFF);
    put(frame, padNote(lane, DECK_RATE_ROW), RGB_RATE_BY_INDEX[laneRateIndex(data, lane)]);
  }
  // Per-lane STOP scene column (row = lane, exactly like the pair deck).
  for (let i = 0; i < SCENE_CCS.length; i++) {
    const row = LP_HEIGHT - 1 - i;
    if (row >= CLIP_LANES) {
      put(frame, SCENE_CCS[i], RGB_OFF);
      continue;
    }
    put(frame, SCENE_CCS[i], lanePlaying(data, row) !== null ? RGB_STOP_ACTIVE : RGB_STOP_IDLE);
  }
  // Re-homed transport nudges + STOP-ALL (top grid row) and arranger REC / SONG.
  put(frame, padNote(CTRL_TEMPO_DOWN_COL, CTRL_TEMPO_ROW), RGB_TEMPO_NUDGE);
  put(frame, padNote(CTRL_TEMPO_UP_COL, CTRL_TEMPO_ROW), RGB_TEMPO_NUDGE);
  put(frame, padNote(CTRL_STOP_ALL_COL, CTRL_TEMPO_ROW), RGB_STOP_IDLE);
  put(
    frame,
    padNote(CTRL_REC_COL, CTRL_ARRANGE_ROW),
    opts.recording ? (blinkOn ? RGB_RECORDING : RGB_RECORDING_DIM) : RGB_STOP_IDLE,
  );
  put(
    frame,
    padNote(CTRL_SONG_COL, CTRL_ARRANGE_ROW),
    opts.arrangeMode ? RGB_SONG_ARRANGE : RGB_SONG_SESSION,
  );
  // AUTOMATION record-arm — pulses red (the record-arm colour) while armed, dim
  // red when idle (mirrors the arranger REC beside it). Reads the SYNCED arm flag
  // so a card/peer arm shows on the pad. In the last 4 beats before the automation
  // clip's own wrap the countdown OVERRIDES it (🟡🟡🔴🔴 recordist pre-roll). Same
  // one-press create-if-none + arm the card's ＋AUTO/ARM does (handler owns write).
  put(
    frame,
    padNote(CTRL_AUTO_ARM_COL, CTRL_ARRANGE_ROW),
    opts.autoCountdown
      ? countdownRgb(opts.autoCountdown)
      : isAutomationArmed(data)
        ? (blinkOn ? RGB_RECORDING : RGB_RECORDING_DIM)
        : RGB_STOP_IDLE,
  );
  paintPermanentTopRow(frame, opts.top);
  return frame;
}

// ── SINGLE Arranger view (inert placeholder) ──
export interface SingleArrangerOpts {
  top: PermanentTopOpts;
}
/** SINGLE Arranger view — an INERT placeholder: a faint dim 8×8, a dark right
 *  column, and the permanent top row (Arranger active). No handlers wire to it
 *  yet (REC / SONG park in Control). PURE. */
export function computeSingleArrangerFrame(opts: SingleArrangerOpts): LaunchpadFrame {
  const frame = emptyFrame();
  for (let y = 0; y < LP_HEIGHT; y++) {
    for (let x = 0; x < LP_WIDTH; x++) put(frame, padNote(x, y), RGB_ARRANGER_DIM);
  }
  for (let i = 0; i < SCENE_CCS.length; i++) put(frame, SCENE_CCS[i], RGB_OFF);
  paintPermanentTopRow(frame, opts.top);
  return frame;
}
