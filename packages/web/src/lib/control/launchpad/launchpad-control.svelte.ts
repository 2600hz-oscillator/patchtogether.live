// packages/web/src/lib/control/launchpad/launchpad-control.svelte.ts
//
// Binds the Launchpad PAIR (launchpad-device) to ONE focused clip-player node.
// The Launchpad analogue of monome-control.svelte.ts, with the owner-locked L/R
// split:
//
//   UNIT L = the 8×8 clip MATRIX, ALWAYS LIVE (never flips to the editor):
//     · clip pad → launch that clip in its lane (or stop the lane if it's the
//       one playing), written to node.data.queued[lane] (the SAME synced field
//       the card + monome write → multiplayer-synced).
//     · scene column → fire slot Y across ALL lanes (Ableton scene).
//
//   UNIT R = the COMMAND DECK (session); FLIPS to the note EDITOR while editing
//   (so L keeps the matrix). The deck holds EDIT / COPY / PASTE / PASTE-REV /
//   COPY-IND / DOUBLE / LENGTH-EDIT / NOW + per-lane STOP (scene col) +
//   transport / stop-all (top row). EDIT is a held modifier: hold EDIT on R +
//   tap a clip on L → enter the editor on R.
//
//   EDITOR (on R): 8×8 = note grid (X = step over an 8-step window = half a
//   16-step block, Y = pitch). ▲▼◀▶ scroll the window ±1; SHIFT (CC 95) held
//   makes them jump ±8 (a full screen). VEL (hold+tap), SCALE, FOLLOW on the
//   top row. EXIT = the top scene button.
//
//   LENGTH-EDIT (on R): the 2-row block/step rulers (opened by the deck's LEN
//   pad). EXIT back to the editor via the top scene button.
//
// LEDs are repainted each scheduler tick from the live clip/playing/queued state
// + the playhead (clip-playhead, NEVER a Y.Doc write). The binding (which
// clip-player + which physical ports are L vs R) is PER-MACHINE local
// (localStorage). LED frames are local render state, never synced.

import { patch as livePatch, ydoc } from '$lib/graph/store';
import * as Y from 'yjs';
import { getYjsValue } from '@syncedstore/core';
import { getSchedulerClock } from '$lib/audio/scheduler-clock';
import {
  connect as deviceConnect,
  onKey,
  setFrame,
  setLed,
  isPairBound,
  isSingleBound,
  isUnitBound,
  clearUnit,
  bindUnit,
  enumerateLaunchpadPorts,
  type LaunchpadKeyEvent,
  type LaunchpadPort,
  type LaunchpadUnit,
  type LaunchpadFrame,
} from './launchpad-device.svelte';
import { padNote, LP_WIDTH, LP_HEIGHT } from './launchpad-sysex';
import {
  // L matrix (pair)
  lPadToClipIndex,
  lSceneSlotForRow,
  computeLSessionFrame,
  lTopMuteLane,
  // R deck
  rDeckPad,
  rStopLaneForRow,
  computeRDeckFrame,
  DECK_ROW,
  DECK_COPY_IND_COL,
  CC_TRANSPORT,
  CC_STOP_ALL,
  CC_REC,
  CC_SONG,
  rDeckReset,
  rDeckMonoLane,
  rDeckMuteLane,
  rDeckRateLane,
  CC_TEMPO_DOWN,
  CC_TEMPO_UP,
  TEMPO_NUDGE_BPM,
  // R editor
  editPadToNote,
  computeREditFrame,
  CC_EDIT_ROW_UP,
  CC_EDIT_ROW_DOWN,
  CC_EDIT_STEP_LEFT,
  CC_EDIT_STEP_RIGHT,
  CC_SHIFT,
  CC_EDIT_VEL,
  CC_EDIT_SCALE,
  CC_EDIT_FOLLOW,
  isEditExitSceneRow,
  editSceneAction,
  // R length
  rLengthPad,
  computeRLengthFrame,
  EDIT_COLS,
  // KEYS mode (dual-Launchpad note/keyboard + clip-record)
  rDeckKeysHold,
  keysPad,
  computeKeysFrame,
  // SINGLE-mode (S2a) — views, right-column classifiers, per-view frames.
  type SingleView,
  type GridArmAction,
  type PermanentTopOpts,
  topRowAction,
  sceneIndexForCc,
  gridPadToClipIndexScrolled,
  slotForScene,
  highestContentScene,
  maxSceneScrollOffset,
  clampSceneScrollOffset,
  gridShiftRight,
  clipRight,
  keysScaleRight,
  keysArpShiftRight,
  controlRight,
  controlRehomePad,
  armTopLane,
  ARM_SHIFT_LANE,
  isLane8ArmPad,
  repeatPadOrdinal,
  repeatCountForOrdinal,
  probPadOrdinal,
  probLevelForOrdinal,
  paintPermanentTopRow,
  computeSingleGridFrame,
  computeSingleClipFrame,
  computeSingleKeysFrame,
  computeSingleControlFrame,
  computeSingleArrangerFrame,
} from './launchpad-map';
import { keyboardCellToMidi } from '$lib/audio/modules/keyboard-map';
import { clearStep, recordNoteAt, extendRecordedNote } from '$lib/audio/modules/clip-record';
import { pushAudition } from '$lib/audio/modules/clip-audition';
import {
  CLIP_LANES,
  CLIP_SLOTS,
  clipIndex,
  laneOf,
  slotOf,
  lanePlaying,
  laneQueued,
  laneMono,
  coerceClipRecord,
  defaultNoteClip,
  scaleSteps,
  toggleNoteAt,
  setNoteSpan,
  cycleVelocity,
  setNoteProb,
  setClipDefaultProb,
  clipDefaultProbEff,
  probEff,
  noteCovering,
  nextScale,
  doubleNoteClip,
  reverseClipSteps,
  copyClip,
  lengthFromBlockTap,
  lengthFromStepTap,
  readNoteRec,
  velLevelIndex,
  VEL_LEVELS,
  VEL_DEFAULT,
  laneSwing,
  clampSwing,
  MAX_SWING,
  isSwingCentered,
  pasteApplies,
  readScene,
  readSceneAutos,
  sceneWritePlan,
  readAutoClip,
  plainCloneAutoClip,
  reverseAutoClipRecord,
  toggleLaneAutomationArm,
  armedAutomationLanes,
  type AutoClipRecord,
  type ClipPlayerData,
  type ClipRecord,
  type NoteClipRecord,
  type CopyBuffer,
  type CopyBufferKind,
  type NoteRecState,
} from '$lib/audio/modules/clip-types';
import {
  setSceneRepeat,
  sceneRepeatCount,
  applySceneLaunchWrite,
} from '$lib/audio/modules/clip-scene-repeats';
import { getLanePlayhead } from '$lib/audio/modules/clip-playhead';
import {
  getAutomationRender,
  automationCountdownColor,
  automationCountdownOn,
} from '$lib/audio/modules/clip-automation-render';
import type { CountdownPaint } from './launchpad-map';
import { laneRateIndex, coerceRateIndex, RATE_MULTS } from '$lib/audio/modules/clip-clock';
import {
  createArpState,
  arpSetHeld,
  arpSetParams,
  arpAdvance,
  arpStepPeriod,
  type ArpState,
} from '$lib/audio/arp-engine';

export const STORAGE_KEY_NODE = 'pt.launchpad.boundClipNode';
export const STORAGE_KEY_LEFT = 'pt.launchpad.portLeft';
export const STORAGE_KEY_RIGHT = 'pt.launchpad.portRight';
// Single-unit deployment (additive, per-machine). When `deployment === 'single'`
// ONE physical Launchpad is bound to the L slot and a VIEW toggle flips its role
// between the L (clip) + R (control) functionality. These keys never affect the
// pair deployment — pair mode reads neither.
export const STORAGE_KEY_DEPLOYMENT = 'pt.launchpad.deployment'; // 'pair' | 'single'
// Single-mode active VIEW. Legacy values ('clip' = the old always-live matrix,
// 'control' = the old deck) migrate to the 4-view model on read: 'clip'→'grid',
// 'control'→'control'. New values: 'grid' | 'clip' | 'arranger' | 'control'.
export const STORAGE_KEY_VIEW = 'pt.launchpad.activeView';

// Blink toggles every BLINK_TICKS scheduler ticks (~25ms each) → ~2 Hz.
const BLINK_TICKS = 10;
const SHIFT_JUMP = 8; // SHIFT magnifies a nav step by a full screen (8 pads).

let boundNodeId: string | null = null;
let unsubKey: (() => void) | null = null;
let unsubTick: (() => void) | null = null;
let tickCount = 0;

// Deployment + single-unit VIEW. In 'pair' EVERYTHING below behaves exactly as
// before (L = the always-live matrix, R = the deck/editor — both physical units).
// In 'single' ONE device is bound to the L slot and drives a 4-VIEW surface over
// a PERMANENT top-CC nav row (transport · Grid · Clip · Arranger · Control · undo
// · redo · shift). KEYS is a SUB-VIEW of Clip (mode === 'keys'), entered FROM the
// Clip right column, not a top-row view. The permanent top row is intercepted
// FIRST in handleSingleKey (in every view incl. keys); pad/scene events then route
// to the active view's handler. Pair mode never reads `singleView`.
let deployment: 'pair' | 'single' = 'pair';
let singleView: SingleView = 'grid';
// The Clip/Keys edit target (single mode). Set by a Grid double-tap, or defaults
// to 0. The permanent CLIP button opens Clip on this index; KEYS is entered for it.
let selectedClipIndex = 0;

// Mode state (R unit's view; L is always the matrix — EXCEPT 'keys', which takes
// BOTH units for the note/keyboard + clip-record view, owner-locked Q4).
type LaunchpadMode = 'session' | 'edit' | 'lengthEdit' | 'keys';
let mode: LaunchpadMode = 'session';
let editClipIndex = 0;
// Held modifiers on R's deck.
let editArmed = false; // EDIT pad held → next L clip tap edits it
let copyHeld = false;
let pasteHeld = false;
let pasteRevHeld = false;
let nowHeld = false; // launch-immediate (queuedImmediate)
let shiftHeld = false; // CC 95 — magnitude(×8)+scope modifier
let velHeld = false; // VEL pad held in editor

// Editor windowing. The 8-wide note grid shows an 8-STEP window starting at an
// ABSOLUTE step `editWindowStart` (free per-step scroll — ◀/▶ move ±1, SHIFT
// makes them jump a full screen ±8). The pitch window scrolls by scale-degree
// rows. FOLLOW snaps the window to the playhead's 8-step block when playing.
let editAnchor: { step: number; midi: number } | null = null;
let editSpanned = false;
let editRowOffset = 0; // pitch-window scroll (scale degrees)
let editWindowStart = 0; // absolute step of the leftmost shown column (frozen value)
// SINGLE-mode Grid SCENE-window scroll — a LOCAL per-surface view offset (like
// editRowOffset / editWindowStart, NEVER synced to node.data): 0 = scenes 0..7
// at the top. The Grid-shift UP/DOWN buttons (repurposed from PASTE-REV / NOW)
// slide it so the 8 position-relative scene-launch buttons address `offset + i`.
let sceneScrollOffset = 0;
let followOn = true;
// Which mode the LENGTH-EDIT page returns to on EXIT ('edit' = the note editor,
// the legacy pair caller; 'keys' = the KEYS view, when LEN was opened from KEYS).
let lengthReturnMode: 'edit' | 'keys' = 'edit';
// SINGLE mode: which VIEW the LENGTH-EDIT page returns to (when not opened from
// KEYS). 'grid' when armed via Grid-shift Len; 'clip' when opened from the Clip
// right column. Pair ignores this (it uses lengthReturnMode only).
let lengthReturnView: SingleView = 'grid';

// ── KEYS mode (note/keyboard + clip-record). PAIR: both units flip together
// (16-wide keyboard). SINGLE: the lone device is the L half (8-wide keyboard,
// 8-cell whole-clip playhead strip); entry = hold note-REC/OVERDUB in CONTROL
// view (the hold survives the CC-98 flip, like EDIT) + double-tap a clip. ──
let keysClipIndex = 0; // the clip being played/recorded in KEYS
let keysRecHeld = false; // SESSION deck note-REC hold (overdub-OFF entry)
let keysOverdubHeld = false; // SESSION deck note-OVERDUB hold (overdub-ON entry)
const keysPressed = new Set<number>(); // MIDI notes currently sounding (for LED)
const keysOnsets = new Map<number, number>(); // midi → the step its onset recorded on
let keysPrevStep = -1; // last serviced playhead step (edge-detect wrap/crossing)
let keysStopAtWrap = false; // overdub toggled OFF mid-record → finish this loop, then stop
let keysOctaveShift = 0; // KEYS octave ± (semitones, multiples of 12) added to the keyboard root

// Per-machine copy buffer (NOT synced) — a TYPED clipboard: one CLIP or a whole
// SCENE (all 8 lanes' clips at a slot). Held as PLAIN deep-clones (never a live Y
// child). LOCAL to this surface, exactly like the old single-clip buffer.
let copyBuffer: CopyBuffer | null = null;
let bufferSourceIndex: number | null = null; // clip-kind source index (L turquoise glow); null for a scene buffer

// ── SINGLE-mode SHIFT (MOMENTARY HOLD-only) + tap-to-ARM (Grid-shift). ──
// Effective shift = shiftHeldSingle (CC 98 physically held: s=1 → true, s=0 →
// false). NO latch — a short tap does nothing but flicker the shift LED (owner:
// "shift functions … should be a hold"). The Grid-shift Copy/Paste/ClipDiv/Len
// functions are still tap-to-ARM: HOLD shift + tap the right-column button to
// arm, then the next grid tap (shift now released) consumes it. Swing± are
// direct nudges — neither arms. Pair mode never sets these (single-only), so
// pair stays byte-for-byte.
let shiftHeldSingle = false; // CC 98 momentary (distinct from pair's CC-95 shiftHeld)
let armedRightAction: GridArmAction | null = null; // Grid-shift tap-to-arm (or null)
let armTick = 0; // tickCount snapshot for the 4s auto-disarm
const ARM_TIMEOUT_TICKS = 160; // ~4s at 25ms/tick — auto-disarm a stale arm
// Clip-Div LOCAL preview while the ClipDiv arm is active: each target-clip tap
// cycles divIndex locally (the pad pulses at that rate); ONE writeClip commits it
// on disarm (avoids the per-tap Y.Doc write-storm — cv-modulation rule).
let divPreview: { clipIndex: number; divIndex: number } | null = null;
const SWING_STEP = 0.02; // Grid-shift Swing± nudge (coarser than 1% → one-handed).
// Swing meter render state (which way the last nudge moved, for the pad ramp).
let swingMeterActive = false;
let swingMeterDir: 'up' | 'down' | 'center' = 'center';

// ── SINGLE-mode ARP (KEYS view). The physically-held keys (keysPressed) feed the
// arp generator; the arp SOUNDS its sequence through the SAME pushAudition seam as
// KEYS. Advanced tick-granularly from the render loop, clocked by TIMELORDE bpm
// (independent of transport running), while KEYS is open OR the arp is latched.
let arp: ArpState = createArpState();
let arpOn = false;
let arpNextTime = 0; // performance.now() ms of the next arp step (0 = fire now).

// ── SCENE-REPEAT COUNT VIEW (owner 3-button, 2-hands gesture — single Grid).
// HOLD the permanent GRID button (CC 92) + HOLD a scene-launch button → the 8×8
// becomes the orange repeat-count bar for THAT scene (launchpad-map repeatView).
// While both are held, pad taps SET the count (pad k = k repeats, pad 64 =
// infinite); releasing EITHER button returns to the normal grid. The scene
// press under GRID-hold is SELECT-ONLY — it must never launch. The held button
// is POSITION-RELATIVE through sceneScrollOffset (resolved at press time), so a
// scrolled window edits the correct scene slot. GRID-hold detection never
// engages under shift (SHIFT+top-row is the per-lane automation arm — that
// gesture consumes the press before the view switch), so the two owner
// gestures cannot collide.
let gridHeldSingle = false; // the permanent GRID button is physically held
let repeatViewHeld: { sceneIndex: number; slot: number } | null = null;

// ── PER-NOTE PROBABILITY page (owner-spec'd — mirrors repeatViewHeld). SHIFT +
// press a note step in the single Clip note editor LATCHES this to that note;
// the 8×8 becomes the 40-level probability bar (launchpad-map probView). While
// latched, the NEXT pad tap sets the note's probability (probPadOrdinal →
// setNoteProb, an undoable edit) and clears the latch (auto-return to the clip
// view). Reset in resetSingleState. A pure single-unit editor gesture — the
// pair editor keeps its dedicated CC_EDIT_VEL for velocity.
let probEditHeld: { step: number; midi: number } | null = null;

// ── CLIP-DEFAULT PROBABILITY page (owner-spec'd — the clip-level sibling of
// probEditHeld, opened from the GRID view). SHIFT + press a Grid clip pad (with
// NO arm pending) LATCHES this to that clip; the 8×8 becomes the 40-level
// probability bar (ORANGE, reinforcing the clip-default colour source) for the
// clip's `defaultProb`. While latched, the NEXT pad tap sets the clip default
// (probPadOrdinal → setClipDefaultProb, an undoable edit) and clears the latch
// (auto-return to the grid); a bottom-3/out-of-bar tap cancels. Reset in
// resetSingleState. Single-unit only (mirrors #1106's per-note PROB page — the
// pair editor has no clip-default entry). Only opens on a pad that already holds
// a clip (an empty pad is a no-op — no clip to default).
let clipProbEditHeld: { clipIdx: number } | null = null;

// SINGLE-mode Grid DOUBLE-TAP → select the clip + switch to Clip view. The FIRST
// tap launches IMMEDIATELY (no debounce/latency — owner: never slow a launch); a
// SECOND tap on the SAME clip within the window instead sets selectedClipIndex +
// opens the Clip view on it (and reverts the lane's play/queue state — see
// handleGridLaunch). We track the last tap's clip index + tickCount and call it a
// double-tap when the index matches AND the tick gap is within the window.
let lastTapClipIndex = -1; // -1 = no pending tap to pair with
let lastTapTick = 0; // tickCount snapshot of the last clip-pad tap
// The lane's PRIOR intent, snapshotted on the FIRST tap (BEFORE its toggle is
// applied) so a double-tap can REVERT the lane to exactly the play/queue state it
// was in before the double-tap began. Owner rule: a double-tap opens the editor
// WITHOUT changing whether the clip plays — EXCEPT a clip that was already QUEUED
// to start must still start (restoring the prior queued value leaves it queued).
//   · lastTapPrevQueued — the lane's `d.queued[lane]` value before the first tap.
//   · lastTapWasPlaying — whether the lane was already playing THIS clip's slot.
// See handleL's double-tap branch for how these reconcile the three prior states.
let lastTapPrevQueued: number | 'stop' | null = null;
let lastTapWasPlaying = false;
// ~11 ticks ≈ 275ms at 25ms/tick — between the card's 220ms click-debounce and a
// comfortable two-finger tap. Long enough to be hittable on hardware, short
// enough that two deliberate separate launches of the same clip don't trip it.
const DOUBLE_TAP_TICKS = 11;

/** Empty the copy buffer — turns off the turquoise source glow on L + the deck
 *  COPY-INDICATOR. (Tapping the COPY-INDICATOR pad clears it; the buffer also
 *  survives a re-bind otherwise, so this is the way to dismiss the glow.) */
function clearBuffer(): void {
  copyBuffer = null;
  bufferSourceIndex = null;
}

/** The buffered CLIP (buffer kind === 'clip'), else null. The single-clip paste
 *  paths (pair deck, clip-view, editor, grid clip-pad target) read through this,
 *  so a SCENE buffer NEVER pastes onto a single clip (clip→scene / scene→clip are
 *  no-ops — the type gate). */
function bufferClip(): NoteClipRecord | null {
  return copyBuffer?.kind === 'clip' ? copyBuffer.clip : null;
}
/** The buffered clip's SIBLING AUTOMATION (or null when the source carried
 *  none / the buffer isn't a clip) — pasted WITH the clip (envelope-belongs-
 *  to-the-clip). */
function bufferClipAuto(): AutoClipRecord | null {
  return copyBuffer?.kind === 'clip' ? copyBuffer.auto : null;
}
/** True when ANY buffer (clip OR scene) is loaded — lights the COPY-INDICATOR /
 *  the Paste button's pulse. */
function bufferLoaded(): boolean {
  return copyBuffer !== null;
}
/** The buffer kind ('clip' | 'scene'), or null when empty — drives the distinct
 *  paste colour + the paste-arm target dimming. */
function bufferKindOf(): CopyBufferKind | null {
  return copyBuffer?.kind ?? null;
}

/** Reactive version — bump on bind/unbind so card UI re-derives. */
let bindingVersion = $state(0);
export function bindingRune(): number {
  return bindingVersion;
}
export function boundClipNode(): string | null {
  return boundNodeId;
}

/** Reactive deployment/view version — bump so the card re-derives the toggle. */
let viewVersion = $state(0);
export function viewRune(): number {
  return viewVersion;
}
function bumpView(): void {
  viewVersion++;
}
/** The current deployment ('pair' | 'single'). */
export function launchpadDeployment(): 'pair' | 'single' {
  return deployment;
}
/** The active single-unit VIEW ('grid'|'clip'|'arranger'|'control'). Meaningless
 *  in pair mode (returns whatever the single machine last held). */
export function launchpadActiveView(): SingleView {
  return singleView;
}
/** Migrate a persisted STORAGE_KEY_VIEW value → a valid SingleView. Legacy 'clip'
 *  (the old always-live matrix) → 'grid'; legacy 'control' → 'control'. */
function coerceStoredView(raw: string | null): SingleView {
  if (raw === 'grid' || raw === 'arranger' || raw === 'control') return raw;
  // Legacy 'clip' meant the matrix → Grid; anything else defaults to Grid.
  return 'grid';
}

/** Persist deployment + the single-unit view (per-machine, additive). */
function persistDeployment(): void {
  try {
    localStorage.setItem(STORAGE_KEY_DEPLOYMENT, deployment);
    localStorage.setItem(STORAGE_KEY_VIEW, singleView);
  } catch {
    /* private mode — session-only */
  }
}

/** Set the single-unit VIEW (no-op in pair mode). The user-facing entry the card
 *  view-buttons call — routes exactly like a permanent-top-row view press
 *  (exits KEYS / length-edit, then switches). Repaints the device immediately. */
export function setLaunchpadView(view: SingleView): void {
  if (deployment !== 'single') return;
  const nodeId = boundNodeId;
  if (nodeId && livePatch.nodes[nodeId]) {
    selectView(nodeId, view);
  } else {
    setSingleViewInternal(view);
    renderLeds();
  }
}

/** Low-level view setter: leaving Grid commits/clears any pending Grid arm + div
 *  preview; then swaps the view + persists + bumps the card rune. Does NOT touch
 *  the KEYS/length sub-mode (callers handle exiting those). */
function setSingleViewInternal(view: SingleView): void {
  if (singleView === 'grid' && view !== 'grid') {
    if (boundNodeId) commitDivPreview(boundNodeId);
    armedRightAction = null;
    divPreview = null;
  }
  singleView = view;
  persistDeployment();
  bumpView();
}

function start(): void {
  stopLoops();
  tickCount = 0;
  mode = 'session';
  editArmed = false;
  copyHeld = false;
  pasteHeld = false;
  pasteRevHeld = false;
  nowHeld = false;
  shiftHeld = false;
  velHeld = false;
  editAnchor = null;
  editSpanned = false;
  editRowOffset = 0;
  editWindowStart = 0;
  followOn = true;
  lengthReturnMode = 'edit';
  lengthReturnView = 'grid';
  resetSingleState();
  lastTapClipIndex = -1;
  lastTapTick = 0;
  lastTapPrevQueued = null;
  lastTapWasPlaying = false;
  resetKeysState();
  // NOTE: copyBuffer survives a re-bind (it's the machine's clipboard).
  setupLaunchpadUndo(); // launchpad-scoped, origin-tagged undo/redo (single mode)
  unsubKey = onKey(handleKey);
  unsubTick = getSchedulerClock().subscribe(renderLeds);
  renderLeds(); // paint immediately so binding lights the units without waiting a tick
}
function stopLoops(): void {
  // Persist any pending Grid Clip-Div preview before dropping the loops, else an
  // un-disarmed preview is silently lost on unbind/rebind (single mode). Runs
  // while boundNodeId is still set (unbindLaunchpad nulls it AFTER this).
  if (deployment === 'single' && boundNodeId && livePatch.nodes[boundNodeId] && divPreview) {
    commitDivPreview(boundNodeId);
  }
  if (unsubKey) { unsubKey(); unsubKey = null; }
  if (unsubTick) { unsubTick(); unsubTick = null; }
  teardownLaunchpadUndo();
}
/** Reset the single-mode transient state (shift/arm/div-preview/swing/arp). */
function resetSingleState(): void {
  shiftHeldSingle = false;
  armedRightAction = null;
  armTick = 0;
  divPreview = null;
  sceneScrollOffset = 0;
  swingMeterActive = false;
  swingMeterDir = 'center';
  gridHeldSingle = false;
  repeatViewHeld = null;
  probEditHeld = null;
  clipProbEditHeld = null;
  velHeld = false; // the relocated single-mode VEL-hold (FOLLOW-row modifier)
  arp = createArpState();
  arpOn = false;
  arpNextTime = 0;
}
/** Clear all KEYS-mode transient state (not the synced node.data.noteRec). */
function resetKeysState(): void {
  keysClipIndex = 0;
  keysRecHeld = false;
  keysOverdubHeld = false;
  keysPressed.clear();
  keysOnsets.clear();
  keysPrevStep = -1;
  keysStopAtWrap = false;
  keysOctaveShift = 0;
}
/** Ensure the key handler + LED render loop are running WITHOUT resetting the
 *  edit/mode state (used after pairing so the units keep painting even before a
 *  clip-player is bound — renderLeds shows a dim "ready" frame while unbound). */
function ensureRenderLoop(): void {
  if (!unsubKey) unsubKey = onKey(handleKey);
  if (!unsubTick) unsubTick = getSchedulerClock().subscribe(renderLeds);
}
/** A uniform dim fill across all 8×8 pads — the "paired + alive but no
 *  clip-player bound yet" idle glow (so the units never sit dead-black). */
function idleFrame(r: number, g: number, b: number): LaunchpadFrame {
  const leds = new Map<number, [number, number, number]>();
  for (let y = 0; y < LP_HEIGHT; y++) {
    for (let x = 0; x < LP_WIDTH; x++) leds.set(padNote(x, y), [r, g, b]);
  }
  return { leds };
}

/** Bind the Launchpad pair to a clip-player node (persisted per-machine). */
export function bindLaunchpadToClip(nodeId: string): void {
  boundNodeId = nodeId;
  try {
    localStorage.setItem(STORAGE_KEY_NODE, nodeId);
  } catch {
    /* private mode — session-only bind */
  }
  start();
  bindingVersion++;
}

/** Unbind + blank both units. */
export function unbindLaunchpad(): void {
  try {
    localStorage.removeItem(STORAGE_KEY_NODE);
  } catch {
    /* noop */
  }
  stopLoops(); // commits any pending div preview while boundNodeId is still set
  boundNodeId = null;
  if (isPairBound()) {
    clearUnit('L');
    clearUnit('R');
  } else if (isSingleBound()) {
    clearUnit('L');
  }
  bindingVersion++;
}

/** Restore a persisted node binding on load (call once after the pair binds). */
export function restoreLaunchpadBinding(): void {
  try {
    const id = localStorage.getItem(STORAGE_KEY_NODE);
    if (id) {
      boundNodeId = id;
      start();
      bindingVersion++;
    }
  } catch {
    /* noop */
  }
}

// ---------------------------------------------------------------------------
// L/R PAIRING — the press-a-pad handshake. Connect (sysex), enumerate the
// `… MIDI` ports, light a prompt on each candidate, and ask the user to press a
// pad on the unit that should be LEFT. The pressed unit → L, the other → R.
// Both port ids persist per-machine (localStorage), so a re-load restores the
// pair without re-prompting. PURE port→unit mapping is testable via the helpers.
// ---------------------------------------------------------------------------

type PairListener = () => void;
const pairListeners = new Set<PairListener>();
let pairing = false;
let pairUnsub: (() => void) | null = null;

/** Reactive pairing-state version — bump so a card can show "press a pad…". */
let pairVersion = $state(0);
export function pairRune(): number {
  return pairVersion;
}
export function isPairing(): boolean {
  return pairing;
}
function bumpPair(): void {
  pairVersion++;
  for (const l of pairListeners) l();
}

/** The candidate Launchpad-MIDI ports the pair handshake found. */
export function launchpadPorts(): LaunchpadPort[] {
  return enumerateLaunchpadPorts();
}

/** Persist the resolved L/R port pair (per-machine). */
function persistPorts(left: LaunchpadPort, right: LaunchpadPort): void {
  try {
    localStorage.setItem(STORAGE_KEY_LEFT, JSON.stringify({ inputId: left.inputId, outputId: left.outputId }));
    localStorage.setItem(STORAGE_KEY_RIGHT, JSON.stringify({ inputId: right.inputId, outputId: right.outputId }));
  } catch {
    /* private mode — session-only */
  }
}
function readPersistedPort(key: string): { inputId: string; outputId: string } | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const o = JSON.parse(raw) as { inputId?: unknown; outputId?: unknown };
    if (typeof o.inputId === 'string' && typeof o.outputId === 'string') {
      return { inputId: o.inputId, outputId: o.outputId };
    }
  } catch {
    /* corrupt — ignore */
  }
  return null;
}

/**
 * Start the L/R pairing handshake. Connects (sysex, gesture-gated), enumerates
 * the Launchpad-MIDI ports, and binds each candidate so a pad press resolves
 * which unit is LEFT. While pairing, each candidate shows a centred dice-5
 * prompt (the 45/54-ish centre the owner confirmed). On a pad press the pressed
 * unit becomes LEFT, the other RIGHT; both are bound + persisted, and `onPaired`
 * fires. Returns false if access can't be acquired or fewer than 2 ports.
 */
export async function startPairing(onPaired?: () => void): Promise<boolean> {
  const ok = await deviceConnect();
  if (!ok) return false;
  const ports = enumerateLaunchpadPorts();
  if (ports.length < 2) {
    // Only one Launchpad → can't pair an L/R. (Owner uses two units.)
    return false;
  }
  // A pairing handshake commits the PAIR deployment (the default). Reset the
  // single-unit view so a later single-bind starts clean.
  deployment = 'pair';
  singleView = 'grid';
  // Bind the first two candidates provisionally to L and R so each can light a
  // prompt + report which pad the user pressed.
  const a = ports[0];
  const b = ports[1];
  bindUnit('L', a.inputId, a.outputId);
  bindUnit('R', b.inputId, b.outputId);
  pairing = true;
  bumpPair();
  // Light the dice-5 centre prompt on both units.
  lightPairPrompt('L');
  lightPairPrompt('R');
  pairUnsub = onKey((e) => {
    if (!pairing || e.ev.type !== 'pad' || e.ev.s !== 1) return;
    // The unit the user pressed becomes LEFT (the matrix).
    const leftUnit = e.unit;
    const left = leftUnit === 'L' ? a : b;
    const right = leftUnit === 'L' ? b : a;
    finishPairing(left, right);
    onPaired?.();
  });
  return true;
}

/** Paint the "press a pad" prompt: FILL the whole 8×8 of a candidate unit so
 *  BOTH units are unmistakably lit during pairing (the proof that both are alive
 *  + addressable — the thing that was broken when two identical units collapsed
 *  onto one output). The two provisional candidates get DISTINCT colours so you
 *  can see there really are two units responding; press any pad on the one you
 *  want as the LEFT/matrix unit. (Provisional 'L' = green, 'R' = blue — the
 *  press, not this label, decides the final L/R.) Diffed LED writes. */
function lightPairPrompt(unit: LaunchpadUnit): void {
  const [r, g, b] = unit === 'L' ? [0, 90, 30] : [0, 30, 100];
  for (let y = 0; y < LP_HEIGHT; y++) {
    for (let x = 0; x < LP_WIDTH; x++) setLed(unit, padNote(x, y), r, g, b);
  }
}

/** Commit a resolved L/R pair: bind both, persist, then KEEP the units lit. */
function finishPairing(left: LaunchpadPort, right: LaunchpadPort): void {
  pairing = false;
  if (pairUnsub) { pairUnsub(); pairUnsub = null; }
  bindUnit('L', left.inputId, left.outputId);
  bindUnit('R', right.inputId, right.outputId);
  persistPorts(left, right);
  deployment = 'pair';
  persistDeployment();
  bumpPair();
  // Keep BOTH units lit after pairing instead of clearing to black: run the
  // render loop even with no clip-player bound yet (renderLeds paints a dim
  // "ready" glow while unbound, the live matrix once bound) and paint one frame
  // now so they don't sit dark waiting for the first scheduler tick. setFrame
  // diffs, so this cleanly replaces the green/blue pairing flood. (The card's
  // onPaired auto-binds a clip-player if one exists, which restarts in live mode.)
  ensureRenderLoop();
  renderLeds();
}

/** Restore a persisted L/R pair (call after connect()). Returns true if both
 *  ports resolved + bound. Does NOT re-prompt. */
export function restoreLaunchpadPair(): boolean {
  const l = readPersistedPort(STORAGE_KEY_LEFT);
  const r = readPersistedPort(STORAGE_KEY_RIGHT);
  if (!l || !r) return false;
  const okL = bindUnit('L', l.inputId, l.outputId);
  const okR = bindUnit('R', r.inputId, r.outputId);
  if (okL && okR) {
    bumpPair();
    return true;
  }
  return false;
}

/** Cancel an in-flight pairing handshake (e.g. the card closed). */
export function cancelPairing(): void {
  if (!pairing) return;
  pairing = false;
  if (pairUnsub) { pairUnsub(); pairUnsub = null; }
  if (isUnitBound('L')) clearUnit('L');
  if (isUnitBound('R')) clearUnit('R');
  bumpPair();
}

// ---------------------------------------------------------------------------
// SINGLE-UNIT deployment — bind ONE Launchpad (no L/R handshake) to the L slot
// and flip its role with the VIEW toggle. Connects (sysex, gesture-gated),
// enumerates the Launchpad-MIDI ports, and binds the FIRST one to the L slot.
// The single path RELAXES the pair's `ports.length < 2` requirement — it needs
// just ONE port. The R slot stays UNBOUND (so isSingleBound() is true), and the
// control layer routes/paints the lone device per `singleView`.
// ---------------------------------------------------------------------------

/** Bind the SINGLE Launchpad (the first enumerated port) to the L slot. Returns
 *  false if access can't be acquired or NO Launchpad port is present. */
export async function startSingle(onBound?: () => void): Promise<boolean> {
  const ok = await deviceConnect();
  if (!ok) return false;
  const ports = enumerateLaunchpadPorts();
  if (ports.length < 1) return false; // single mode needs ONE device (vs pair's two)
  const a = ports[0];
  const okL = bindUnit('L', a.inputId, a.outputId);
  if (!okL) return false;
  // Make sure the R slot is clear so isSingleBound() holds (e.g. re-entering
  // single after a prior pair session left R bound).
  if (isUnitBound('R')) clearUnit('R');
  deployment = 'single';
  singleView = 'grid'; // a fresh single-bind always starts in the Grid view
  persistSinglePort(a);
  persistDeployment();
  ensureRenderLoop();
  renderLeds();
  bumpPair();
  bumpView();
  onBound?.();
  return true;
}

/** Persist the single device's port (reuses the LEFT port key — the lone device
 *  IS the L slot — and clears the RIGHT key so a restore can't mistake it for a
 *  pair). */
function persistSinglePort(port: LaunchpadPort): void {
  try {
    localStorage.setItem(STORAGE_KEY_LEFT, JSON.stringify({ inputId: port.inputId, outputId: port.outputId }));
    localStorage.removeItem(STORAGE_KEY_RIGHT);
  } catch {
    /* private mode — session-only */
  }
}

/** Restore a persisted SINGLE binding (call after connect()). Returns true if
 *  the lone port resolved + bound to the L slot. Does NOT re-prompt. */
export function restoreLaunchpadSingle(): boolean {
  const l = readPersistedPort(STORAGE_KEY_LEFT);
  if (!l) return false;
  const okL = bindUnit('L', l.inputId, l.outputId);
  if (!okL) return false;
  if (isUnitBound('R')) clearUnit('R');
  deployment = 'single';
  // Restore the persisted view (migrated) so a reload resumes where the user left.
  try {
    singleView = coerceStoredView(localStorage.getItem(STORAGE_KEY_VIEW));
  } catch {
    singleView = 'grid';
  }
  bumpPair();
  bumpView();
  return true;
}

/** Restore the persisted deployment + view (call once on load, before binding,
 *  so a re-load resumes single mode in the right view). Pair is the default. */
export function restoreLaunchpadDeployment(): void {
  try {
    const d = localStorage.getItem(STORAGE_KEY_DEPLOYMENT);
    deployment = d === 'single' ? 'single' : 'pair';
    singleView = coerceStoredView(localStorage.getItem(STORAGE_KEY_VIEW));
  } catch {
    deployment = 'pair';
    singleView = 'grid';
  }
}

// --- graph helpers (in-place Y discipline; identical to monome-control) ---
function liveData(nodeId: string): ClipPlayerData | undefined {
  return livePatch.nodes[nodeId]?.data as ClipPlayerData | undefined;
}
// ── Launchpad-scoped UNDO/REDO (multiplayer-safe). A per-instance transaction
// ORIGIN tags PERSISTENT clip edits (div/swing/length/paste/content/scale); a
// Yjs UndoManager scoped to that origin captures ONLY those, so CC96/CC97 undo
// the launchpad's own persistent edits without ever reverting a collaborator (a
// different origin) or a transient launch (no origin). Transient launches
// (queueLane / restoreQueued / activateLaneClearQueue) transact WITHOUT the
// origin, so they never land on the stack. The origin is only APPLIED in single
// mode, so pair transactions stay byte-for-byte (undefined origin). ──
const LAUNCHPAD_UNDO_ORIGIN = Symbol('launchpad-undo-origin');
let lpUndo: Y.UndoManager | null = null;

/** Construct the launchpad UndoManager over the bound doc's nodes Y.Map, scoped
 *  to the launchpad origin. Reuses syncedStore's underlying Y type (no map
 *  rebuild — the yjs-save-load discipline). No-op / null on any failure. */
function setupLaunchpadUndo(): void {
  teardownLaunchpadUndo();
  try {
    const yNodes = getYjsValue(livePatch.nodes) as Y.AbstractType<unknown> | undefined;
    if (yNodes) {
      lpUndo = new Y.UndoManager(yNodes, {
        trackedOrigins: new Set<unknown>([LAUNCHPAD_UNDO_ORIGIN]),
        captureTimeout: 300,
      });
    }
  } catch {
    lpUndo = null;
  }
}
function teardownLaunchpadUndo(): void {
  if (lpUndo) {
    try { lpUndo.destroy(); } catch { /* ignore */ }
    lpUndo = null;
  }
}
function lpCanUndo(): boolean {
  return !!lpUndo && lpUndo.undoStack.length > 0;
}
function lpCanRedo(): boolean {
  return !!lpUndo && lpUndo.redoStack.length > 0;
}
function lpDoUndo(): void {
  if (lpUndo && lpUndo.undoStack.length > 0) lpUndo.undo();
  renderLeds();
}
function lpDoRedo(): void {
  if (lpUndo && lpUndo.redoStack.length > 0) lpUndo.redo();
  renderLeds();
}

function editData(
  nodeId: string,
  mut: (d: ClipPlayerData) => void,
  opts: { undoable?: boolean } = {},
): void {
  const node = livePatch.nodes[nodeId];
  if (!node) return;
  // Tag PERSISTENT edits with the launchpad origin so lpUndo captures them —
  // single mode ONLY (pair keeps the undefined origin, byte-for-byte).
  const origin = opts.undoable && deployment === 'single' ? LAUNCHPAD_UNDO_ORIGIN : undefined;
  ydoc.transact(() => {
    if (!node.data) node.data = {};
    mut(node.data as ClipPlayerData);
  }, origin);
}
function queueLane(nodeId: string, lane: number, action: number | 'stop' | null, immediate = false): void {
  editData(nodeId, (d) => {
    const base: (number | 'stop' | null)[] = new Array(CLIP_LANES).fill(null);
    if (Array.isArray(d.queued)) {
      for (let i = 0; i < d.queued.length && i < CLIP_LANES; i++) base[i] = d.queued[i];
    }
    base[lane] = action;
    d.queued = base;
    if (immediate) {
      const imm = new Array<boolean>(CLIP_LANES).fill(false);
      if (Array.isArray(d.queuedImmediate)) {
        for (let i = 0; i < d.queuedImmediate.length && i < CLIP_LANES; i++) imm[i] = !!d.queuedImmediate[i];
      }
      imm[lane] = true;
      d.queuedImmediate = imm;
    }
  });
}
/** Restore a lane's `d.queued[lane]` to a snapshotted prior value (in-place Y
 *  write, mirroring queueLane's array build). Used by the double-tap revert: it
 *  un-does the first tap's queued write so the lane's INTENT matches what it was
 *  before the double-tap (a queued start stays queued; a queued stop is cancelled;
 *  a fresh start is un-queued). Does NOT touch queuedImmediate — playback
 *  reconciliation (the rare "already crossed a boundary" case) is a separate
 *  explicit queueLane(stop, immediate) call in the caller. */
function restoreQueued(nodeId: string, lane: number, prev: number | 'stop' | null): void {
  editData(nodeId, (d) => {
    const base: (number | 'stop' | null)[] = new Array(CLIP_LANES).fill(null);
    if (Array.isArray(d.queued)) {
      for (let i = 0; i < d.queued.length && i < CLIP_LANES; i++) base[i] = d.queued[i];
    }
    base[lane] = prev;
    d.queued = base;
  });
}
function clipAtIndex(data: ClipPlayerData | undefined, index: number): NoteClipRecord | null {
  const c = coerceClipRecord(data?.clips?.[String(index)]);
  return c && c.kind === 'note' ? c : null;
}
function editPlayhead(nodeId: string, data: ClipPlayerData | undefined): number {
  const lane = laneOf(editClipIndex);
  return lanePlaying(data, lane) === slotOf(editClipIndex) ? getLanePlayhead(nodeId, lane) : -1;
}
/** Largest valid absolute window start for `clip` (so the 8-wide window's last
 *  column never runs past the last step; ≥0). */
function maxWindowStart(clip: NoteClipRecord): number {
  return Math.max(0, clip.lengthSteps - EDIT_COLS);
}
/** The absolute step the leftmost shown column maps to: the playhead's 8-step
 *  block while FOLLOWing (0 when not playing), else the clamped frozen value. */
function shownWindowStart(clip: NoteClipRecord): number {
  if (followOn) {
    const ph = boundNodeId ? editPlayhead(boundNodeId, liveData(boundNodeId)) : -1;
    if (ph < 0) return 0;
    // snap to the EDIT_COLS-wide block the playhead is in, clamped.
    return Math.min(maxWindowStart(clip), Math.floor(ph / EDIT_COLS) * EDIT_COLS);
  }
  return Math.max(0, Math.min(maxWindowStart(clip), editWindowStart));
}
function clampWindow(clip: NoteClipRecord): void {
  editWindowStart = Math.max(0, Math.min(maxWindowStart(clip), editWindowStart));
}
function writeClip(
  nodeId: string,
  next: NoteClipRecord,
  index: number = editClipIndex,
  opts: { undoable?: boolean } = { undoable: true },
): void {
  editData(
    nodeId,
    (d) => {
      if (!d.clips) d.clips = {};
      d.clips[String(index)] = { ...next, steps: next.steps.map((s) => ({ ...s })) };
    },
    { undoable: opts.undoable ?? true },
  );
}

/** PASTE-path clip write: the clip PLUS its sibling automation, atomically in
 *  ONE undoable transaction. The ENVELOPE BELONGS TO THE CLIP: pasting a clip
 *  replaces the destination's `auto[k]` with the buffer's copy — or DELETES the
 *  destination's stale record when the source carried none — so a paste can
 *  never leave a ghost envelope playing under foreign notes. (Plain-cloned so
 *  pasting one buffer to many targets never shares refs.) NOTE edits to a clip
 *  keep using `writeClip` — they must never touch the sibling automation. */
function writeClipWithAuto(
  nodeId: string,
  next: NoteClipRecord,
  auto: AutoClipRecord | null,
  index: number,
): void {
  const plainAuto = plainCloneAutoClip(auto);
  editData(
    nodeId,
    (d) => {
      if (!d.clips) d.clips = {};
      d.clips[String(index)] = { ...next, steps: next.steps.map((s) => ({ ...s })) };
      if (!d.auto) d.auto = {};
      const key = String(index);
      if (plainAuto) d.auto[key] = plainAuto;
      else if (d.auto[key] !== undefined && d.auto[key] !== null) delete d.auto[key];
    },
    { undoable: true },
  );
}
function timelordeNode(): { node: { params?: Record<string, number> }; id: string } | null {
  for (const [id, n] of Object.entries(livePatch.nodes)) {
    if ((n as { type?: string } | undefined)?.type === 'timelorde') {
      return { node: n as { params?: Record<string, number> }, id };
    }
  }
  return null;
}
function transportRunning(): boolean {
  const t = timelordeNode();
  if (!t) return false;
  const r = t.node.params?.running;
  return typeof r === 'number' ? r >= 0.5 : true;
}
function toggleTransport(): void {
  const t = timelordeNode();
  if (!t) return;
  const next = transportRunning() ? 0 : 1;
  ydoc.transact(() => {
    const n = livePatch.nodes[t.id];
    if (n) {
      if (!n.params) n.params = {};
      (n.params as Record<string, number>).running = next;
    }
  });
}
function recordArmed(data: ClipPlayerData | undefined): boolean {
  return data?.recording === true;
}
function arrangeMode(data: ClipPlayerData | undefined): boolean {
  return data?.clipMode === 'arrangement';
}
/** Toggle the arranger record-arm — the SAME node.data.recording field the
 *  ClipplayerCard's REC button writes. The clipplayer factory captures each
 *  applied launch into node.data.arrangement while this is true (session mode);
 *  arming clears the log + restarts song time (engine rising-edge, v1 replace). */
function toggleRecording(nodeId: string): void {
  editData(nodeId, (d) => {
    d.recording = !d.recording;
  });
}
/** Flip SESSION ⇄ ARRANGEMENT — the SAME node.data.clipMode field the card's
 *  SES/ARR button writes. ARRANGEMENT replays the recorded launch log. */
function toggleArrangeMode(nodeId: string): void {
  editData(nodeId, (d) => {
    d.clipMode = d.clipMode === 'arrangement' ? 'session' : 'arrangement';
  });
}
/** PER-LANE automation arm/disarm from the Launchpad (SHIFT+top-row column /
 *  the SHFT double-tap for lane 8) — the EXACT same write seam the card's
 *  per-lane ◉ uses (toggleLaneAutomationArm: rebuild-and-assign the lanes
 *  array, stamp this client as the lane's single-writer recorderId when
 *  arming, pre-create the lane's auto shell), so pad and card stay in sync
 *  via the synced per-lane flags. */
function toggleLaneAutoArm(nodeId: string, lane: number): void {
  editData(nodeId, (d) => {
    toggleLaneAutomationArm(d, lane, ydoc.clientID);
  });
}

// ── Performance-deck seams (P1/P4/P3/P2/P5). Each writes the SAME synced node
// field the engine already consumes (or the card writes), so the surface only
// SURFACES existing model capability — no new engine logic on the launchpad side
// except the RESET nonce bump / MUTE flag that the engine reads. All are
// deployment-agnostic (single deck + pair share them via handleRDeck/handleL). ──

/** RESET — bump node.data.resetNonce (the SAME synced counter the card RST button
 *  + the reset gate drive) so every peer's engine snaps all ACTIVE lanes to step
 *  1 at a common re-anchor. A counter (not a boolean) so repeated taps re-fire. */
function doReset(nodeId: string): void {
  editData(nodeId, (d) => {
    d.resetNonce = (typeof d.resetNonce === 'number' ? d.resetNonce : 0) + 1;
  });
}
/** Toggle lane L's MONO flag (node.data.mono[lane]) — one note per column on
 *  note entry vs poly. In-place Y write (build-then-assign, like queueLane). */
function toggleMono(nodeId: string, lane: number): void {
  editData(nodeId, (d) => {
    const m = new Array<boolean>(CLIP_LANES).fill(false);
    if (Array.isArray(d.mono)) for (let i = 0; i < d.mono.length && i < CLIP_LANES; i++) m[i] = !!d.mono[i];
    m[lane] = !m[lane];
    d.mono = m;
  });
}
/** Toggle lane L's MUTE flag (node.data.muted[lane]) — the lane keeps advancing
 *  its playhead but emits no audio (the engine gates it). In-place Y write. */
function toggleMute(nodeId: string, lane: number): void {
  editData(nodeId, (d) => {
    const m = new Array<boolean>(CLIP_LANES).fill(false);
    if (Array.isArray(d.muted)) for (let i = 0; i < d.muted.length && i < CLIP_LANES; i++) m[i] = !!d.muted[i];
    m[lane] = !m[lane];
    d.muted = m;
  });
}
/** Cycle lane L's clock RATE up one step, wrapping (node.data.rate[lane]) — the
 *  SAME per-lane rate array the card dropdown writes + the engine consumes. */
function cycleRate(nodeId: string, lane: number): void {
  editData(nodeId, (d) => {
    const r = new Array<number>(CLIP_LANES);
    for (let i = 0; i < CLIP_LANES; i++) r[i] = laneRateIndex(d, i); // coerce existing
    r[lane] = (r[lane] + 1) % RATE_MULTS.length;
    d.rate = r;
  });
}
/** Nudge TIMELORDE's bpm by ±delta (clamped 10..300) — reuses the transport
 *  reach the PLAY toggle already uses (writes params.bpm the way it writes
 *  running). A no-op when no TIMELORDE is on the canvas. */
function nudgeTempo(delta: number): void {
  const t = timelordeNode();
  if (!t) return;
  ydoc.transact(() => {
    const n = livePatch.nodes[t.id];
    if (!n) return;
    if (!n.params) n.params = {};
    const p = n.params as Record<string, number>;
    const cur = typeof p.bpm === 'number' ? p.bpm : 120;
    p.bpm = Math.max(10, Math.min(300, cur + delta));
  });
}

// ---------------------------------------------------------------------------
// KEYS mode (note/keyboard + clip-record). Pair AND single deployments — the
// handlers below are deployment-agnostic; only entry-routing + the painted
// frame (16- vs 8-cell playhead) differ, and both live at the routing seams.
// ---------------------------------------------------------------------------

/** The bottom-left keyboard cell pitch for a clip — the clip's root shifted by
 *  the live KEYS octave offset (P7), so every octave of the (shifted) root lights
 *  cyan and the scale-lighting is anchored. The offset is used CONSISTENTLY by
 *  both the LED paint + the note dispatch (both call this), so a shifted pad
 *  sounds the pitch it lights. */
function keysKeyboardRoot(clip: NoteClipRecord): number {
  return clip.root + keysOctaveShift;
}
/** KEYS octave ± (P7): shift the keyboard up/down by `delta` semitones (±12),
 *  clamped so the shifted root stays in a sane band. Repaints immediately. */
function keysShiftOctave(delta: number): void {
  keysOctaveShift = Math.max(-48, Math.min(48, keysOctaveShift + delta));
  renderLeds();
}
/** Off the arp's currently-sounding note (if any) on `lane`. Every KEYS teardown
 *  calls this so a running/latched arp never strands a voice. SINGLE only (pair
 *  has no arp). */
function silenceArp(nodeId: string, lane: number): void {
  if (deployment === 'single' && arp.playing !== null) {
    pushAudition(nodeId, { lane, midi: arp.playing, velocity: 0, on: false });
  }
}
/** KEYS PANIC (P7): kill every sounding auditioned note (release-all) without
 *  leaving KEYS or touching the recorded clip — an emergency "all notes off". */
function keysPanic(nodeId: string): void {
  const lane = laneOf(keysClipIndex);
  for (const midi of keysPressed) pushAudition(nodeId, { lane, midi, velocity: 0, on: false });
  keysPressed.clear();
  keysOnsets.clear();
  // The emergency all-notes-off must also kill the ARP: off its sounding note
  // and drop its (possibly latched) held-note pool so it stops generating —
  // else it keeps cycling octave-expanded pitches that aren't in keysPressed.
  // arpOn is left as-is, so re-pressing a key resumes arping.
  if (deployment === 'single') {
    silenceArp(nodeId, lane);
    arp = createArpState(arp.params);
    arpNextTime = 0;
  }
  renderLeds();
}
/** Snap a note-on velocity to a stored VEL level. Velocity-insensitive pads
 *  (velocity 0/absent) fall back to VEL_DEFAULT (no device fork — a Launchpad X
 *  is expressive automatically). */
function keysCaptureVel(velocity: number): number {
  if (!Number.isFinite(velocity) || velocity <= 0) return VEL_DEFAULT;
  return VEL_LEVELS[velLevelIndex(velocity)] ?? VEL_DEFAULT;
}

/** Write a fresh KEYS note-record state (armed/recording OFF). */
function initNoteRec(nodeId: string, lane: number, slot: number, overdub: boolean): void {
  editData(nodeId, (d) => {
    d.noteRec = { lane, slot, armed: false, recording: false, overdub };
  });
}
/** Patch the existing KEYS note-record state (no-op if none). */
function patchNoteRec(nodeId: string, patch: Partial<NoteRecState>): void {
  editData(nodeId, (d) => {
    const cur = readNoteRec(d);
    if (!cur) return;
    d.noteRec = { ...cur, ...patch };
  });
}
/** Drop the KEYS note-record state entirely (EXIT to session). */
function clearNoteRecField(nodeId: string): void {
  editData(nodeId, (d) => {
    d.noteRec = null;
  });
}
/** Make a lane active on `slot` + clear any pending launch/immediate on it (so a
 *  queued clip can't yank the take mid-record). The engine adopts `playing`. */
function activateLaneClearQueue(nodeId: string, lane: number, slot: number): void {
  editData(nodeId, (d) => {
    const playing: (number | null)[] = new Array(CLIP_LANES).fill(null);
    if (Array.isArray(d.playing)) {
      for (let i = 0; i < d.playing.length && i < CLIP_LANES; i++) playing[i] = d.playing[i];
    }
    playing[lane] = slot;
    d.playing = playing;
    const q: (number | 'stop' | null)[] = new Array(CLIP_LANES).fill(null);
    if (Array.isArray(d.queued)) {
      for (let i = 0; i < d.queued.length && i < CLIP_LANES; i++) q[i] = d.queued[i];
    }
    q[lane] = null;
    d.queued = q;
    const imm = new Array<boolean>(CLIP_LANES).fill(false);
    if (Array.isArray(d.queuedImmediate)) {
      for (let i = 0; i < d.queuedImmediate.length && i < CLIP_LANES; i++) imm[i] = !!d.queuedImmediate[i];
    }
    imm[lane] = false;
    d.queuedImmediate = imm;
  });
}

/** Open the KEYS view for a clip index (materialize a default clip if empty),
 *  launch it playing, keyboard live, record armed-but-idle. `overdub` is preset
 *  by the entry gesture (hold-REC = OFF, hold-OVERDUB = ON). */
function enterKeys(
  nodeId: string,
  clipIdx: number,
  overdub: boolean,
  data: ClipPlayerData | undefined,
): void {
  // A LATCHED arp kept running on the PREVIOUS keys clip's lane (forceExitKeys
  // preserves it) — off its sounding note before we retarget + reset the arp
  // state below, else it strands a voice on the old lane.
  silenceArp(nodeId, laneOf(keysClipIndex));
  if (!data?.clips?.[String(clipIdx)]) {
    editData(
      nodeId,
      (d) => {
        if (!d.clips) d.clips = {};
        if (!d.clips[String(clipIdx)]) d.clips[String(clipIdx)] = defaultNoteClip();
      },
      { undoable: true },
    );
  }
  keysClipIndex = clipIdx;
  mode = 'keys';
  keysRecHeld = false;
  keysOverdubHeld = false;
  keysPressed.clear();
  keysOnsets.clear();
  keysPrevStep = -1;
  keysStopAtWrap = false;
  keysOctaveShift = 0;
  editArmed = false;
  lastTapClipIndex = -1;
  // Fresh KEYS session → clear the arp note-set + turn it OFF (params preserved).
  arp = createArpState(arp.params);
  arpOn = false;
  arpNextTime = 0;
  const lane = laneOf(clipIdx);
  const slot = slotOf(clipIdx);
  // Launch the clip so KEYS opens with it PLAYING (immediate — never delay).
  if (lanePlaying(liveData(nodeId), lane) !== slot) queueLane(nodeId, lane, slot, true);
  initNoteRec(nodeId, lane, slot, overdub);
}

/** EXIT tap in KEYS: recording → stop record (stay in KEYS); armed → cancel arm
 *  (stay in KEYS, idle); idle → back to session. */
function keysExit(nodeId: string, data: ClipPlayerData | undefined): void {
  const rec = readNoteRec(data);
  if (rec?.recording) {
    patchNoteRec(nodeId, { recording: false, armed: false });
    keysStopAtWrap = false;
    // flush any held onsets' spans so a note held across EXIT isn't left open
    finishHeldOnsets(nodeId, data, rec.lane);
    return;
  }
  if (rec?.armed) {
    patchNoteRec(nodeId, { armed: false });
    return;
  }
  // Idle → session. Silence EVERYTHING KEYS is sounding before we blank state,
  // else clearing keysPressed / the arp below strands open voices (this must
  // mirror forceExitKeys, which flushes both). The live held keyboard notes are
  // only actually sounding when the arp is OFF (arp-on suppresses direct
  // auditions), but a note-off for a silent note is a harmless no-op.
  const lane = laneOf(keysClipIndex);
  for (const midi of keysPressed) pushAudition(nodeId, { lane, midi, velocity: 0, on: false });
  // SINGLE: silence + reset the arp (its sequence should not outlive an explicit
  // KEYS EXIT). Pair never runs the arp, so this is single-guarded.
  if (deployment === 'single' && arpOn) {
    silenceArp(nodeId, lane);
    arpOn = false;
    arp = createArpState(arp.params);
    arpNextTime = 0;
  }
  mode = 'session';
  clearNoteRecField(nodeId);
  resetKeysState();
}

/** QUEUE-REC tap: arm (flashing yellow) → recording begins on the next loop wrap
 *  (auto-start the transport if stopped). Re-tap while armed cancels. Blocked
 *  while the arranger is armed or in arrangement mode (so the two never cross). */
function keysQueueRec(nodeId: string, data: ClipPlayerData | undefined): void {
  const rec = readNoteRec(data);
  if (!rec) return;
  if (rec.recording) return; // EXIT stops a recording, not QUEUE-REC
  if (rec.armed) {
    patchNoteRec(nodeId, { armed: false });
    return;
  }
  if (recordArmed(data) || arrangeMode(data)) return; // arranger guard
  patchNoteRec(nodeId, { armed: true });
  keysPrevStep = getLanePlayhead(nodeId, rec.lane);
  if (!transportRunning()) toggleTransport(); // auto-start at step 0
}

/** OVERDUB toggle (the in-view purple control). OFF→ON = additive from now; ON→
 *  OFF while recording = finish the current loop then stop (owner: overdub loops
 *  endlessly until toggled off, stopping at the loop end). */
function keysToggleOverdub(nodeId: string, data: ClipPlayerData | undefined): void {
  const rec = readNoteRec(data);
  if (!rec) return;
  const next = !rec.overdub;
  patchNoteRec(nodeId, { overdub: next });
  if (rec.recording && rec.overdub && !next) keysStopAtWrap = true; // ON→OFF mid-record
  else keysStopAtWrap = false;
}

/** Open the LENGTH page from KEYS (returns to KEYS on EXIT). */
function openLengthFromKeys(nodeId: string, data: ClipPlayerData | undefined): void {
  if (!clipAtIndex(data, keysClipIndex)) return;
  editClipIndex = keysClipIndex;
  lengthReturnMode = 'keys';
  mode = 'lengthEdit';
}

/** Close any still-open recorded onsets (their spans) — called on stop/EXIT so a
 *  note held when recording stops still gets a length. */
function finishHeldOnsets(nodeId: string, data: ClipPlayerData | undefined, lane: number): void {
  if (keysOnsets.size === 0) return;
  const offStep = getLanePlayhead(nodeId, lane);
  if (offStep < 0) { keysOnsets.clear(); return; }
  for (const [midi, onStep] of keysOnsets) {
    const clip = clipAtIndex(liveData(nodeId), keysClipIndex);
    if (!clip) break;
    const next = extendRecordedNote(clip, onStep, midi, offStep);
    if (next !== clip) writeClip(nodeId, next, keysClipIndex);
  }
  keysOnsets.clear();
}

/** Route a KEYS-mode key event on a unit (both units are the keyboard). */
function handleKeysUnit(nodeId: string, unit: LaunchpadUnit, e: LaunchpadKeyEvent): void {
  const ev = e.ev;
  if (ev.type !== 'pad') return; // KEYS uses the 8×8 only (top/scene ignored)
  const p = keysPad(unit, ev.x, ev.y);
  if (!p) return;
  if (p.kind === 'note') {
    handleKeysNote(nodeId, p.col, p.row, ev.s, ev.velocity);
    return;
  }
  if (ev.s !== 1) return; // controls act on press
  const data = liveData(nodeId);
  if (p.kind === 'exit') keysExit(nodeId, data);
  else if (p.kind === 'qrec') keysQueueRec(nodeId, data);
  else if (p.kind === 'overdub') keysToggleOverdub(nodeId, data);
  else if (p.kind === 'octUp') keysShiftOctave(+12);
  else if (p.kind === 'octDown') keysShiftOctave(-12);
  else if (p.kind === 'panic') keysPanic(nodeId);
  else if (p.kind === 'len') openLengthFromKeys(nodeId, data);
  // p.kind === 'playhead' → display only, no-op.
}

/** A keyboard note press/release in KEYS: audition live (always) + capture into
 *  the clip while recording. */
function handleKeysNote(nodeId: string, col: number, row: number, s: 0 | 1, velocity: number): void {
  const data = liveData(nodeId);
  const clip = clipAtIndex(data, keysClipIndex);
  if (!clip) return;
  const lane = laneOf(keysClipIndex);
  const midi = keyboardCellToMidi(col, row, keysKeyboardRoot(clip));
  const rec = readNoteRec(data);
  // SINGLE + arp ON: the note feeds the arp HELD-SET (not a direct audition/
  // record). The arp SOUNDS its own sequence from the render loop (serviceArp).
  // Pair never sets arpOn, so this branch is single-only.
  if (deployment === 'single' && arpOn) {
    if (s === 1) {
      if (keysPressed.has(midi)) return;
      keysPressed.add(midi);
    } else {
      keysPressed.delete(midi);
    }
    arp = arpSetHeld(arp, [...keysPressed]);
    if (arpNextTime === 0) arpNextTime = nowMs(); // (re)start the arp clock
    return;
  }
  if (s === 1) {
    if (keysPressed.has(midi)) return; // already down (dedupe)
    keysPressed.add(midi);
    const vel = keysCaptureVel(velocity);
    pushAudition(nodeId, { lane, midi, velocity: vel, on: true });
    if (rec?.recording) {
      const step = getLanePlayhead(nodeId, lane);
      if (step >= 0) {
        const mono = laneMono(data, lane);
        const next = recordNoteAt(clip, step, midi, { mono, velocity: vel });
        if (next !== clip) {
          writeClip(nodeId, next, keysClipIndex);
          keysOnsets.set(midi, step); // track for note-off span capture
        }
      }
    }
  } else {
    keysPressed.delete(midi);
    pushAudition(nodeId, { lane, midi, velocity: 0, on: false });
    if (rec?.recording && keysOnsets.has(midi)) {
      const onStep = keysOnsets.get(midi)!;
      const offStep = getLanePlayhead(nodeId, lane);
      if (offStep >= 0) {
        const next = extendRecordedNote(clip, onStep, midi, offStep);
        if (next !== clip) writeClip(nodeId, next, keysClipIndex);
      }
      keysOnsets.delete(midi);
    }
  }
}

/** Per-tick KEYS record servicing (driven by the LED render loop). Handles the
 *  arm→record transition on the loop wrap, the TRUE-REPLACE clear as the playhead
 *  crosses each step (overdub OFF), and the overdub finish-at-loop-end stop. */
function serviceKeysRecord(nodeId: string, data: ClipPlayerData | undefined): void {
  const rec = readNoteRec(data);
  if (!rec) return;
  const lane = rec.lane;
  const step = getLanePlayhead(nodeId, lane);
  const wrapped = step === 0 && keysPrevStep !== 0; // entered step 0 (start/loop)
  if (rec.armed && !rec.recording) {
    if (wrapped) {
      // START: make the target active + clear queue, flip armed→recording.
      activateLaneClearQueue(nodeId, lane, rec.slot);
      patchNoteRec(nodeId, { armed: false, recording: true });
      keysOnsets.clear();
    }
  } else if (rec.recording) {
    if (step !== keysPrevStep && step >= 0) {
      // TRUE REPLACE (overdub OFF, not finishing): clear the step we just entered
      // so this pass's keypresses replace its onsets; an un-played step wipes.
      if (!rec.overdub && !keysStopAtWrap) {
        const clip = clipAtIndex(liveData(nodeId), keysClipIndex);
        if (clip) {
          const next = clearStep(clip, step);
          if (next !== clip) writeClip(nodeId, next, keysClipIndex);
        }
      }
      // Overdub finished (toggled OFF mid-record): stop at the loop end.
      if (wrapped && keysStopAtWrap) {
        finishHeldOnsets(nodeId, liveData(nodeId), lane);
        patchNoteRec(nodeId, { recording: false });
        keysStopAtWrap = false;
      }
    }
  }
  keysPrevStep = step;
}

// ---------------------------------------------------------------------------
// Inbound key routing — split by unit.
// ---------------------------------------------------------------------------
function handleKey(e: LaunchpadKeyEvent): void {
  const nodeId = boundNodeId;
  if (!nodeId || !livePatch.nodes[nodeId]) return;
  if (deployment === 'single') {
    handleSingleKey(nodeId, e);
    return;
  }
  // PAIR mode: L = the always-live matrix, R = deck/editor — EXCEPT KEYS, which
  // takes BOTH units as the note/keyboard + clip-record view.
  if (mode === 'keys') {
    handleKeysUnit(nodeId, e.unit, e);
    return;
  }
  // LENGTH page opened FROM keys: L keeps the live keyboard, R is the ruler.
  if (mode === 'lengthEdit' && lengthReturnMode === 'keys') {
    if (e.unit === 'L') handleKeysUnit(nodeId, 'L', e);
    else handleR(nodeId, e);
    return;
  }
  if (e.unit === 'L') handleL(nodeId, e);
  else handleR(nodeId, e);
}

// ===========================================================================
// SINGLE-UNIT routing (S2b). The lone device is bound to the L slot, so every
// event arrives tagged unit:'L'; we route it by the PERMANENT TOP ROW first,
// then by the active mode/view:
//   · The permanent top CCs (91..98) are intercepted FIRST in EVERY view incl.
//     KEYS + length-edit: transport · Grid · Clip · Arranger · Control · undo ·
//     redo · shift. A view button while in KEYS exits KEYS to that view.
//   · KEYS (mode==='keys') is a Clip SUB-VIEW: pad = keyboard/controls, scene
//     column = scale-select / arp (or +shift the arp control column).
//   · length-edit (mode==='lengthEdit') is a full-device takeover; EXIT (scene)
//     returns to Grid / Clip / KEYS per how it was opened.
//   · else route by singleView: grid → handleSingleGrid, clip → handleSingleClip,
//     control → handleSingleControl, arranger → inert.
// ===========================================================================
function singleShiftEff(): boolean {
  return shiftHeldSingle;
}

function handleSingleKey(nodeId: string, e: LaunchpadKeyEvent): void {
  const ev = e.ev;
  // 1) PERMANENT TOP ROW — intercepted first, in every view (incl. keys/length).
  if (ev.type === 'top') {
    const action = topRowAction(ev.cc);
    if (action !== null) handleTopRow(nodeId, action, ev.s, ev.cc);
    return; // any top CC is owned by the permanent row (no fall-through)
  }
  // 1b) LANE-8 AUTOMATION ARM (owner gesture): while SHIFT is HELD, the pad
  // directly below SHFT (LANE8_ARM_PAD, topmost 8×8 row, rightmost column)
  // toggles lane 8's arm — the compass's col-8 is the shift button itself, so
  // lane 8 borrows the pad beneath it (lanes 1-7 are SHIFT+top CC in
  // handleTopRow). Intercepted HERE, before the view routing, so it works from
  // EVERY view exactly like the top-row arm map. CONSUMED — never a grid/clip
  // action. Only on PRESS while shift is effective. NOT while the repeat-count
  // view owns pad taps (GRID+scene hold, which is entered without shift — the
  // view keeps every pad for count-setting even if shift is added mid-hold).
  if (
    ev.type === 'pad' &&
    ev.s === 1 &&
    singleShiftEff() &&
    !repeatViewHeld &&
    !clipProbEditHeld &&
    isLane8ArmPad(ev.x, ev.y)
  ) {
    toggleLaneAutoArm(nodeId, ARM_SHIFT_LANE);
    renderLeds();
    return;
  }
  // 2) length-edit takeover (scene EXIT returns to the opener's view).
  if (mode === 'lengthEdit') {
    handleRLength(nodeId, e);
    return;
  }
  // 3) KEYS sub-view owns pad + scene (top already handled above).
  if (mode === 'keys') {
    handleSingleKeys(nodeId, e);
    return;
  }
  // 4) route by active view.
  switch (singleView) {
    case 'grid':
      handleSingleGrid(nodeId, e);
      break;
    case 'clip':
      handleSingleClip(nodeId, e);
      break;
    case 'control':
      handleSingleControl(nodeId, e);
      break;
    case 'arranger':
      break; // inert — no pad/scene handlers
  }
}

/** The permanent top row (identical in every view). Press-only for transport /
 *  views / undo / redo; both edges for shift (the momentary hold). PER-LANE
 *  AUTOMATION ARM (owner gesture): while shift is HELD, a top-row press on
 *  columns 1..7 toggles THAT lane's automation arm and is CONSUMED — the
 *  button's normal function (transport / view flip / undo / redo) must NOT fire
 *  under shift. Works from EVERY view. Lane 8 is HOLD-SHIFT + the pad below
 *  SHFT (LANE8_ARM_PAD, handled in handleSingleKey); the shift button routes to
 *  handleShift. */
function handleTopRow(
  nodeId: string,
  action: ReturnType<typeof topRowAction>,
  s: 0 | 1,
  cc: number,
): void {
  // GRID release ALWAYS ends the repeat-view hold — even if shift engaged
  // mid-hold (the physical hold ended either way; the shift-consume branch
  // below would otherwise swallow the release and leave the hold stuck).
  if (action === 'grid' && s === 0) {
    gridHeldSingle = false;
    if (repeatViewHeld) {
      repeatViewHeld = null;
      renderLeds();
    }
  }
  if (action !== 'shift' && singleShiftEff()) {
    if (s === 1) {
      const lane = armTopLane(cc);
      if (lane !== null) {
        toggleLaneAutoArm(nodeId, lane);
        renderLeds();
      }
    }
    return; // consumed under shift — never the normal function
  }
  switch (action) {
    case 'transport':
      if (s === 1) toggleTransport();
      break;
    case 'grid':
      // Tap-to-switch is unchanged (fires on PRESS, like every view button);
      // the press ADDITIONALLY arms the GRID-hold so HOLD GRID + HOLD a scene
      // button opens the repeat-count view (release clears it above). Holding
      // GRID while already in Grid view was a no-op re-select before — the
      // hold-arm is the only new behavior.
      if (s === 1) {
        selectView(nodeId, 'grid');
        gridHeldSingle = true;
      }
      break;
    case 'clip':
    case 'arranger':
    case 'control':
      if (s === 1) selectView(nodeId, action);
      break;
    case 'undo':
      if (s === 1) lpDoUndo();
      break;
    case 'redo':
      if (s === 1) lpDoRedo();
      break;
    case 'shift':
      handleShift(nodeId, s);
      break;
    default:
      break;
  }
}

/** Switch the active view from a top-row button (or the card). Exits KEYS /
 *  length-edit cleanly, then swaps the view. Selecting Clip targets the current
 *  selectedClipIndex (editClipIndex stays synced for the window helpers). */
function selectView(nodeId: string, view: SingleView): void {
  if (mode === 'keys') forceExitKeys(nodeId);
  if (mode === 'lengthEdit') mode = 'session';
  if (view === 'clip') editClipIndex = selectedClipIndex;
  // Clear the note-editor hold modifiers on any view switch so a PROB page /
  // VEL-hold never "sticks" across views (mirrors the repeat-view GRID-release
  // clear). Both are momentary single-Clip-view gestures. The GRID-view clip-
  // default PROB page clears the same way.
  probEditHeld = null;
  clipProbEditHeld = null;
  velHeld = false;
  setSingleViewInternal(view);
  renderLeds();
}

/** Fully leave KEYS to session (a view-button press exits KEYS unconditionally).
 *  Flushes any sounding keyboard notes; keeps a LATCHED arp running (on the same
 *  lane), else stops + resets the arp. */
function forceExitKeys(nodeId: string): void {
  const data = liveData(nodeId);
  const rec = readNoteRec(data);
  if (rec?.recording) finishHeldOnsets(nodeId, data, rec.lane);
  const lane = laneOf(keysClipIndex);
  const savedClip = keysClipIndex;
  for (const midi of keysPressed) pushAudition(nodeId, { lane, midi, velocity: 0, on: false });
  const keepArp = arpOn && arp.params.latch;
  if (arpOn && !arp.params.latch && arp.playing !== null) {
    pushAudition(nodeId, { lane, midi: arp.playing, velocity: 0, on: false });
  }
  mode = 'session';
  clearNoteRecField(nodeId);
  resetKeysState();
  if (keepArp) {
    keysClipIndex = savedClip; // a latched arp keeps sounding on its lane
  } else {
    arpOn = false;
    arp = createArpState(arp.params);
    arpNextTime = 0;
  }
}

/** SHIFT (CC 98): MOMENTARY HOLD — effective shift = held (s=1 → true, s=0 →
 *  false). No latch: a short tap just flickers the shift LED and does nothing
 *  else. Releasing shift disarms any Grid tap-to-arm EXCEPT the sticky
 *  COPY/PASTE (they persist so the no-shift matrix can host the copy/paste
 *  TARGET — a clip pad or a scene-launch button; they auto-disarm on consume,
 *  the 4s timeout, or leaving Grid). Clip-Div commits its pending preview on
 *  release; Len drops. */
function handleShift(nodeId: string, s: 0 | 1): void {
  shiftHeldSingle = s === 1;
  if (
    !shiftHeldSingle &&
    armedRightAction &&
    armedRightAction !== 'copy' &&
    armedRightAction !== 'paste'
  ) {
    disarmGridArm(nodeId);
  }
  renderLeds();
}

// ── GRID view (transposed 8×8 matrix; scene column = row-launch OR the grid-
// shift function palette). ──
function handleSingleGrid(nodeId: string, e: LaunchpadKeyEvent): void {
  const ev = e.ev;
  const data = liveData(nodeId);
  const shift = singleShiftEff();
  if (ev.type === 'pad') {
    // CLIP-DEFAULT PROB page latched (SHIFT + a clip pad opened it): a pad tap on
    // the top-5-row ORANGE bar SETS the clip's default probability (undoable) then
    // clears the latch (auto-return to the grid); a bottom-3/out-of-bar tap
    // cancels. Intercepted BEFORE the repeat-view + launch paths (mirrors the
    // per-note PROB page interception in handleSingleClip).
    if (clipProbEditHeld) {
      if (ev.s === 1) {
        const k = probPadOrdinal(ev.x, ev.y);
        if (k !== null) {
          const ci = clipProbEditHeld.clipIdx;
          const clip = clipAtIndex(liveData(nodeId), ci);
          if (clip) writeClip(nodeId, setClipDefaultProb(clip, probLevelForOrdinal(k)), ci, { undoable: true });
        }
        clipProbEditHeld = null;
        renderLeds();
      }
      return;
    }
    // SCENE-REPEAT COUNT VIEW: while GRID + a scene button are both held, pad
    // taps SET the held scene's repeat count — pad k (row-major from the
    // upper-left) = k repeats, pad 64 = back to INFINITE. A persistent musical
    // edit → undoable (launchpad-scoped undo); the LED bar updates live.
    if (repeatViewHeld) {
      if (ev.s !== 1) return;
      const k = repeatPadOrdinal(ev.x, ev.y);
      if (k !== null) {
        const slot = repeatViewHeld.slot;
        lastTapClipIndex = -1; // a count tap is never a launch double-tap half
        editData(nodeId, (d) => setSceneRepeat(d, slot, repeatCountForOrdinal(k)), {
          undoable: true,
        });
        renderLeds();
      }
      return;
    }
    if (ev.s !== 1) return; // launch acts on press
    // Scrolled mapping: a pad in an EMPTY scene (scene ≥ CLIP_SLOTS) → null → a
    // dark no-op (nothing to launch/create there).
    const clipIdx = gridPadToClipIndexScrolled(ev.x, ev.y, sceneScrollOffset);
    if (clipIdx === null) return;
    // SHIFT + a clip pad (with NO arm pending) → open the CLIP-DEFAULT PROB page
    // for that clip (owner gesture). Under shift an ARMED copy/paste/div/len
    // still CONSUMES the arm below (unchanged); a no-shift tap still launches. The
    // only behaviour lost is the incidental "hold-shift + tap launches" (shift was
    // ignored on the grid) — intended. Only opens on a pad that holds a clip.
    if (shift && !armedRightAction) {
      openClipProbPage(nodeId, clipIdx);
      return;
    }
    // A pending arm consumes the next clip-pad tap → this pad is a CLIP target.
    // Under shift ANY arm (copy/paste/clip-div/len) consumes here; with shift
    // released only the STICKY copy/paste arms survive (clip-div/len disarmed on
    // release), so a no-shift pad tap while armed is a single-clip copy/paste.
    if (armedRightAction) {
      consumeGridArm(nodeId, clipIdx, data);
      return;
    }
    handleGridLaunch(nodeId, clipIdx, data);
    return;
  }
  if (ev.type === 'scene') {
    const sceneIndex = sceneIndexForCc(ev.cc);
    if (sceneIndex === null) return;
    // SCENE-REPEAT COUNT VIEW: releasing the HELD scene button exits back to
    // the normal grid (releasing GRID exits via handleTopRow).
    if (ev.s !== 1) {
      if (repeatViewHeld && repeatViewHeld.sceneIndex === sceneIndex) {
        repeatViewHeld = null;
        renderLeds();
      }
      return;
    }
    // HOLD GRID + press a scene button → open (or switch to) that scene's
    // repeat-count view. SELECT-ONLY: the press must NOT launch the scene, hit
    // the shift palette, or consume a copy/paste arm. POSITION-RELATIVE: the
    // button edits the scrolled scene `offset + sceneIndex` (the owner-called-
    // out case), resolved at press time.
    if (gridHeldSingle) {
      const slot = slotForScene(sceneScrollOffset + sceneIndex);
      if (slot !== null) {
        repeatViewHeld = { sceneIndex, slot };
        renderLeds();
      }
      return;
    }
    // Under shift the scene column is the grid-shift palette (arm/nudge/scroll).
    if (shift) { handleGridShiftButton(nodeId, sceneIndex); return; }
    // No-shift + a STICKY copy/paste arm → this scene-launch button is a WHOLE-
    // SCENE target (copy that scene, or paste a scene buffer over it). Otherwise
    // it is the normal scene launch.
    if (armedRightAction === 'copy' || armedRightAction === 'paste') {
      consumeSceneArm(nodeId, sceneIndex, data);
      return;
    }
    handleSceneLaunch(nodeId, sceneIndex, data);
    return;
  }
}

/** SHIFT + a Grid clip pad (no arm) → LATCH the CLIP-DEFAULT PROB page for that
 *  clip: the 8×8 becomes the orange 40-level bar and the next pad tap writes
 *  setClipDefaultProb. Only opens on a pad that already holds a clip (an empty pad
 *  is a no-op — there is no clip to carry a default; the owner spec is "shift +
 *  press a clip pad"). Clears any pending launch double-tap so the open never
 *  pairs with a prior tap. */
function openClipProbPage(nodeId: string, clipIdx: number): void {
  if (!clipAtIndex(liveData(nodeId), clipIdx)) return; // no clip here → nothing to default
  clipProbEditHeld = { clipIdx };
  lastTapClipIndex = -1; // a prob-page open is never a launch double-tap half
  renderLeds();
}

/** No-shift grid clip tap: single-tap = launch/stop; DOUBLE-TAP (same clip within
 *  the window) = select it + open Clip view on it (reverting the lane's play/queue
 *  state so the double-tap never changes whether it plays — owner rule). */
function handleGridLaunch(nodeId: string, clipIdx: number, data: ClipPlayerData | undefined): void {
  const lane = laneOf(clipIdx);
  const slot = slotOf(clipIdx);
  if (clipIdx === lastTapClipIndex && tickCount - lastTapTick <= DOUBLE_TAP_TICKS) {
    lastTapClipIndex = -1; // consume — a 3rd tap must not re-fire off this pair
    // Revert the lane to its prior intent (snapshotted on the first tap) so the
    // double-tap NEVER changes whether the clip plays (owner rule) — in BOTH
    // directions, including the immediate case (NOW held / QNT off) where the
    // first tap's launch/stop already applied within the double-tap window.
    restoreQueued(nodeId, lane, lastTapPrevQueued);
    const nowPlaying = lanePlaying(liveData(nodeId), lane) === slot;
    if (!lastTapWasPlaying && nowPlaying) {
      queueLane(nodeId, lane, 'stop', /* immediate */ true); // first tap launched it → undo
    } else if (lastTapWasPlaying && !nowPlaying) {
      queueLane(nodeId, lane, slot, /* immediate */ true); // first tap stopped it → restart
    }
    setSelectedClip(clipIdx);
    // Materialize a default clip if the pad was empty so Clip view can edit it.
    if (!data?.clips?.[String(clipIdx)]) {
      editData(
        nodeId,
        (d) => {
          if (!d.clips) d.clips = {};
          if (!d.clips[String(clipIdx)]) d.clips[String(clipIdx)] = defaultNoteClip();
        },
        { undoable: true },
      );
    }
    // Fresh editor window for the newly-selected clip.
    editAnchor = null;
    editSpanned = false;
    editRowOffset = 0;
    editWindowStart = 0;
    followOn = true;
    setSingleViewInternal('clip');
    renderLeds();
    return;
  }
  // First tap: snapshot prior intent, record the tap, then launch/stop.
  lastTapPrevQueued = laneQueued(data, lane);
  lastTapWasPlaying = lanePlaying(data, lane) === slot;
  lastTapClipIndex = clipIdx;
  lastTapTick = tickCount;
  if (lanePlaying(data, lane) === slot) queueLane(nodeId, lane, 'stop', nowHeld);
  else if (data?.clips?.[String(clipIdx)]) queueLane(nodeId, lane, slot, nowHeld);
  // else empty: no launch, but the tap is recorded (double-tap of empty → creates + selects).
}

/** No-shift scene/row launch: a grid ROW = one clip per channel (a scene). The 8
 *  buttons are POSITION-RELATIVE — button `sceneIndex` (0 = top) launches the
 *  scrolled scene `offset + sceneIndex`, firing that slot across ALL lanes (stop
 *  lanes with no clip in it). A scene out of range OR EMPTY (no clip in any lane)
 *  → no-op (nothing to launch; matches the dark content-gated scene button). */
function handleSceneLaunch(nodeId: string, sceneIndex: number, data: ClipPlayerData | undefined): void {
  void data;
  const slot = slotForScene(sceneScrollOffset + sceneIndex);
  if (slot === null) return; // scene out of range = dark / no launch
  // The SHARED scene-launch seam (clip-scene-repeats): ONE transaction writes
  // the whole per-lane queued plan (never 8 separate lane writes) AND bumps the
  // `sceneLaunch` marker every peer's repeat tracker re-anchors from. A fully-
  // EMPTY scene writes nothing (content-gated — matches the dark scene button;
  // no stop-all storm).
  editData(nodeId, (d) => {
    applySceneLaunchWrite(d, slot, nowHeld);
  });
}

/** Grid + shift right column: Copy/Paste/PasteRev/ClipDiv/Len are tap-to-ARM;
 *  Swing± are direct nudges; NOW is a sticky toggle. */
function handleGridShiftButton(nodeId: string, sceneIndex: number): void {
  switch (gridShiftRight(sceneIndex)) {
    case 'copy':
    case 'paste':
    case 'clipDiv':
    case 'len':
      toggleGridArm(nodeId, gridShiftRight(sceneIndex) as GridArmAction);
      break;
    case 'swingUp':
      nudgeSwing(nodeId, +SWING_STEP);
      break;
    case 'swingDown':
      nudgeSwing(nodeId, -SWING_STEP);
      break;
    case 'scrollUp':
      scrollScenes(nodeId, -1); // amber UP (was PASTE-REV): toward scene 0
      break;
    case 'scrollDown':
      scrollScenes(nodeId, +1); // amber DOWN (was NOW): reveal the next scene
      break;
    default:
      break;
  }
}

/** Slide the Grid scene-window by ±1 (UP = −1, toward scene 0). Clamps at the top
 *  (offset 0) and at the lazy DOWN limit (one empty scene past the deepest clip,
 *  capped at MAX_SCENES). LOCAL view state — never writes node.data. */
function scrollScenes(nodeId: string, delta: number): void {
  const data = liveData(nodeId);
  const next = clampSceneScrollOffset(sceneScrollOffset + delta, highestContentScene(data));
  if (next === sceneScrollOffset) return;
  sceneScrollOffset = next;
  renderLeds();
}

/** Tap a Grid-shift function button → arm it (or disarm on a re-tap; COPY re-tap
 *  clears the buffer). Only one arm at a time. Paste requires a buffer. */
function toggleGridArm(nodeId: string, action: GridArmAction): void {
  if (armedRightAction === action) {
    if (action === 'copy' && bufferLoaded()) clearBuffer();
    disarmGridArm(nodeId);
    return;
  }
  // Switching arms → commit any pending Clip-Div preview from the previous arm.
  if (armedRightAction === 'clipDiv') commitDivPreview(nodeId);
  if (action === 'paste' && !bufferLoaded()) {
    // Nothing to paste → don't arm (the button stays its idle green).
    armedRightAction = null;
    divPreview = null;
    renderLeds();
    return;
  }
  armedRightAction = action;
  armTick = tickCount;
  if (action !== 'clipDiv') divPreview = null;
  renderLeds();
}

/** Disarm the Grid tap-to-arm (committing a pending Clip-Div preview as ONE write). */
function disarmGridArm(nodeId: string): void {
  if (armedRightAction === 'clipDiv') commitDivPreview(nodeId);
  armedRightAction = null;
  divPreview = null;
  renderLeds();
}

/** Commit the local Clip-Div preview (if any) as a SINGLE writeClip — the engine
 *  latches `clip.div` at the clip's next loop boundary. No-op if unchanged. */
function commitDivPreview(nodeId: string): void {
  if (!divPreview) return;
  const { clipIndex: ci, divIndex } = divPreview;
  divPreview = null;
  const clip = clipAtIndex(liveData(nodeId), ci);
  if (clip && clip.div !== divIndex) {
    writeClip(nodeId, { ...clip, div: divIndex }, ci, { undoable: true });
  }
}

/** Consume a Grid-shift arm on a clip-pad tap. Copy/Paste/Len apply + auto-disarm;
 *  Clip-Div cycles a LOCAL preview (stays armed; one write on disarm).
 *  Empty/illegal targets are no-ops that simply disarm. */
function consumeGridArm(nodeId: string, clipIdx: number, data: ClipPlayerData | undefined): void {
  lastTapClipIndex = -1; // an armed tap isn't a launch
  switch (armedRightAction) {
    case 'copy': {
      // Copy a SINGLE clip onto the typed buffer (kind: 'clip') — the clip's
      // sibling automation rides along (the envelope belongs to the clip).
      const c = clipAtIndex(data, clipIdx);
      if (c) {
        copyBuffer = { kind: 'clip', clip: copyClip(c), auto: readAutoClip(data, clipIdx) };
        bufferSourceIndex = clipIdx;
      }
      disarmGridArm(nodeId);
      break;
    }
    case 'paste': {
      // A clip pad is a CLIP target — applies only for a CLIP buffer (a SCENE
      // buffer → scene→clip NO-OP, gated by pasteApplies). The buffer + the other
      // clips stay untouched on a no-op. The paste carries the buffer's
      // automation and clears the destination's stale record (one transaction).
      const bc = bufferClip();
      if (bc && copyBuffer && pasteApplies(copyBuffer.kind, 'clip')) {
        writeClipWithAuto(nodeId, copyClip(bc), bufferClipAuto(), clipIdx);
      }
      disarmGridArm(nodeId);
      break;
    }
    case 'len': {
      if (clipAtIndex(data, clipIdx)) {
        editClipIndex = clipIdx;
        lengthReturnMode = 'edit';
        lengthReturnView = 'grid';
        mode = 'lengthEdit';
        armedRightAction = null;
        divPreview = null;
        renderLeds();
        return;
      }
      disarmGridArm(nodeId); // empty = no-op
      break;
    }
    case 'clipDiv': {
      const c = clipAtIndex(data, clipIdx);
      if (c) {
        // Switching target clips commits the previous preview first.
        if (divPreview && divPreview.clipIndex !== clipIdx) commitDivPreview(nodeId);
        if (divPreview && divPreview.clipIndex === clipIdx) {
          divPreview = { clipIndex: clipIdx, divIndex: (divPreview.divIndex + 1) % RATE_MULTS.length };
        } else {
          const cur = typeof c.div === 'number' ? coerceRateIndex(c.div) : laneRateIndex(data, laneOf(clipIdx));
          divPreview = { clipIndex: clipIdx, divIndex: (cur + 1) % RATE_MULTS.length };
        }
        renderLeds();
      }
      // STAYS armed — cycles per tap; commits once on disarm.
      break;
    }
    default:
      disarmGridArm(nodeId);
      break;
  }
}

/** Consume a STICKY copy/paste arm on a SCENE-LAUNCH button (no-shift) → this is a
 *  WHOLE-SCENE target. COPY snapshots the scroll-mapped scene (all 8 lanes' clips)
 *  onto the typed buffer as PLAIN clones. PASTE full-REPLACES that scene from a
 *  SCENE buffer (clip→scene is a NO-OP, gated by pasteApplies — buffer + targets
 *  untouched). Either way the arm auto-disarms. Scroll-aware: the target slot is
 *  slotForScene(sceneScrollOffset + sceneIndex). */
function consumeSceneArm(
  nodeId: string,
  sceneIndex: number,
  data: ClipPlayerData | undefined,
): void {
  lastTapClipIndex = -1; // an armed tap isn't a launch
  const slot = slotForScene(sceneScrollOffset + sceneIndex);
  if (slot === null) { disarmGridArm(nodeId); return; } // scene out of range
  if (armedRightAction === 'copy') {
    // The scene buffer carries each lane's clip AND its sibling automation
    // (envelope-belongs-to-the-clip — a scene duplicate is a perform gesture)
    // AND the scene's REPEAT COUNT (counts are content — they travel with the
    // scene; 0 = infinite/none).
    copyBuffer = {
      kind: 'scene',
      clips: readScene(data, slot),
      autos: readSceneAutos(data, slot),
      repeats: sceneRepeatCount(data, slot),
    };
    bufferSourceIndex = null; // a scene has no single source pad
  } else if (copyBuffer && pasteApplies(copyBuffer.kind, 'scene')) {
    // pasteApplies(kind, 'scene') is true ONLY for a scene buffer — the `.kind`
    // check narrows the union for TS; a clip buffer here is the clip→scene NO-OP.
    if (copyBuffer.kind === 'scene') {
      pasteSceneInto(nodeId, slot, copyBuffer.clips, copyBuffer.autos, copyBuffer.repeats ?? 0);
    }
  }
  disarmGridArm(nodeId);
}

/** FULL-REPLACE a scene at `targetSlot` from a scene buffer's PLAIN clones, in ONE
 *  origin-tagged transaction (→ a SINGLE undo step). Each of the 8 lanes is set to
 *  its plain clone, or its key DELETED when the source lane was empty — so a lane
 *  the source scene left empty EMPTIES the target lane — and the same for each
 *  clip's SIBLING AUTOMATION (`auto[k]` set from the buffer / deleted when the
 *  source carried none): the envelope belongs to the clip, so a full scene
 *  replace can never leave a ghost envelope under a foreign clip. Whole-clip
 *  plain reassigns (never a live Y splice), per the yjs-save-load discipline. */
function pasteSceneInto(
  nodeId: string,
  targetSlot: number,
  sceneClips: (ClipRecord | null)[],
  sceneAutos?: (AutoClipRecord | null)[],
  sceneRepeats = 0,
): void {
  const plan = sceneWritePlan(targetSlot, sceneClips, sceneAutos);
  editData(
    nodeId,
    (d) => {
      if (!d.clips) d.clips = {};
      if (!d.auto) d.auto = {};
      for (const { index, value, auto } of plan) {
        const key = String(index);
        if (value === null) {
          // Only delete a key that EXISTS — the syncedStore proxy's deleteProperty
          // trap throws on a missing key. An already-empty target lane is a no-op.
          if (d.clips[key] !== undefined && d.clips[key] !== null) delete d.clips[key];
        } else {
          d.clips[key] = value;
        }
        if (auto === null) {
          if (d.auto[key] !== undefined && d.auto[key] !== null) delete d.auto[key];
        } else {
          d.auto[key] = auto;
        }
      }
      // The scene's REPEAT COUNT travels with the scene (counts are content):
      // full-replace sets the target's count from the buffer, and a countless
      // source CLEARS the target's key — no ghost counts, same discipline as
      // the sibling automation above. Part of the same undo step.
      setSceneRepeat(d, targetSlot, sceneRepeats);
    },
    { undoable: true },
  );
}

/** Nudge swing[selectedChannel] by ±SWING_STEP (clamped). selectedChannel = the
 *  lane of selectedClipIndex. Drives the Swing± pad meter (up/down/center flash). */
function nudgeSwing(nodeId: string, delta: number): void {
  const lane = laneOf(selectedClipIndex);
  const next = clampSwing(laneSwing(liveData(nodeId), lane) + delta);
  editData(
    nodeId,
    (d) => {
      const arr = new Array<number>(CLIP_LANES).fill(0);
      if (Array.isArray(d.swing)) {
        for (let i = 0; i < d.swing.length && i < CLIP_LANES; i++) arr[i] = clampSwing(d.swing[i]);
      }
      arr[lane] = next;
      d.swing = arr;
    },
    { undoable: true },
  );
  swingMeterActive = true;
  swingMeterDir = isSwingCentered(next) ? 'center' : delta > 0 ? 'up' : 'down';
  renderLeds();
}

// ── CLIP view (note editor on selectedClipIndex; scene column = clipRight). ──
function setSelectedClip(idx: number): void {
  selectedClipIndex = idx;
  editClipIndex = idx; // keep synced so the window/playhead helpers track it
}
/** Materialize (if empty) + return the selected clip. Used when an edit needs a
 *  real clip to write into. */
function ensureSelClip(nodeId: string): NoteClipRecord {
  let clip = clipAtIndex(liveData(nodeId), selectedClipIndex);
  if (!clip) {
    editData(
      nodeId,
      (d) => {
        if (!d.clips) d.clips = {};
        if (!d.clips[String(selectedClipIndex)]) d.clips[String(selectedClipIndex)] = defaultNoteClip();
      },
      { undoable: true },
    );
    clip = clipAtIndex(liveData(nodeId), selectedClipIndex)!;
  }
  return clip;
}
function writeClipSel(nodeId: string, next: NoteClipRecord): void {
  writeClip(nodeId, next, selectedClipIndex, { undoable: true });
}

function handleSingleClip(nodeId: string, e: LaunchpadKeyEvent): void {
  const ev = e.ev;
  const data = liveData(nodeId);
  const shift = singleShiftEff();
  if (ev.type === 'scene') {
    const sceneIndex = sceneIndexForCc(ev.cc);
    if (sceneIndex === null) return;
    // VEL-HOLD (relocated velocity modifier, decision #1): the FOLLOW scene row,
    // held with NO shift, is a MOMENTARY velocity modifier — mirrors the pair
    // editor's dedicated CC_EDIT_VEL button (both editors now cycle velocity via
    // a held VEL modifier). Single mode has no spare top-row CC (the permanent
    // compass) and a packed right column, so VEL borrows the FOLLOW row; FOLLOW
    // toggle relocates to SHIFT + this row. Both key edges tracked (hold).
    if (clipRight(sceneIndex) === 'follow' && !shift) {
      velHeld = ev.s === 1;
      renderLeds();
      return;
    }
    if (ev.s !== 1) return;
    handleClipRight(nodeId, sceneIndex, shift, data);
    return;
  }
  if (ev.type !== 'pad') return;
  // PROB PAGE latched (SHIFT + step opened it): intercept pad presses BEFORE
  // note-toggle (mirrors the repeat-view interception) — a pad tap on the top-5-
  // row bar picks the note's probability level via an UNDOABLE write, then clears
  // the latch (auto-return to the clip view). A bottom-3/out-of-bar tap cancels.
  if (probEditHeld) {
    if (ev.s === 1) {
      const k = probPadOrdinal(ev.x, ev.y);
      if (k !== null) {
        const { step, midi } = probEditHeld;
        const clip = clipAtIndex(liveData(nodeId), selectedClipIndex);
        if (clip) writeClipSel(nodeId, setNoteProb(clip, step, midi, probLevelForOrdinal(k)));
      }
      probEditHeld = null;
      renderLeds();
    }
    return;
  }
  // Note grid. On press, materialize the clip if needed; on release, only act if
  // a clip already exists (don't create one from a stray release).
  const clip = ev.s === 1 ? ensureSelClip(nodeId) : clipAtIndex(data, selectedClipIndex);
  if (!clip) return;
  const note = editPadToNote(clip, ev.x, ev.y, { rowOffset: editRowOffset, colOffset: shownWindowStart(clip), page: 0 });
  if (!note) return;
  const mono = laneMono(liveData(nodeId), laneOf(selectedClipIndex));
  // SHIFT + press a step → open the PER-NOTE PROBABILITY page for the COVERING
  // note (decision #1 — relocated off the old shift=velocity gesture). Only a
  // cell that already holds a note opens the page (setNoteProb never creates a
  // note); an empty cell is a no-op.
  if (shift) {
    if (ev.s === 1) {
      const cov = noteCovering(clip, note.step, note.midi);
      if (cov) {
        probEditHeld = { step: cov.step, midi: cov.midi };
        renderLeds();
      }
    }
    return;
  }
  // VEL-HOLD + press → cycle the note's velocity (the relocated velocity gesture,
  // mirroring the pair editor's velHeld path).
  if (velHeld) {
    if (ev.s === 1) writeClipSel(nodeId, cycleVelocity(clip, note.step, note.midi));
    return;
  }
  if (ev.s === 1) {
    if (editAnchor && editAnchor.midi === note.midi && editAnchor.step !== note.step) {
      writeClipSel(nodeId, setNoteSpan(clip, editAnchor.step, note.step, note.midi, { mono }));
      editSpanned = true;
    } else {
      editAnchor = { step: note.step, midi: note.midi };
      editSpanned = false;
    }
  } else if (editAnchor && editAnchor.step === note.step && editAnchor.midi === note.midi) {
    if (!editSpanned) writeClipSel(nodeId, toggleNoteAt(clip, note.step, note.midi, { mono }));
    editAnchor = null;
    editSpanned = false;
  }
}

/** Clip right column: Double · LengthEdit · Follow · Keys · RowUp · RowDown ·
 *  Step◀ · Step▶. Under shift Row±/Step± jump a page/block. */
function handleClipRight(
  nodeId: string,
  sceneIndex: number,
  shift: boolean,
  data: ClipPlayerData | undefined,
): void {
  switch (clipRight(sceneIndex)) {
    case 'double': {
      const clip = clipAtIndex(data, selectedClipIndex);
      if (clip) {
        const next = doubleNoteClip(clip);
        if (next !== clip) writeClipSel(nodeId, next);
      }
      break;
    }
    case 'lengthEdit': {
      if (clipAtIndex(data, selectedClipIndex)) {
        editClipIndex = selectedClipIndex;
        lengthReturnMode = 'edit';
        lengthReturnView = 'clip';
        mode = 'lengthEdit';
        renderLeds();
      }
      break;
    }
    case 'follow': {
      const clip = ensureSelClip(nodeId);
      toggleFollow(clip);
      renderLeds();
      break;
    }
    case 'keys':
      enterKeys(nodeId, selectedClipIndex, /* overdub */ false, data);
      break;
    case 'rowUp':
      editRowOffset += shift ? SHIFT_JUMP : 1;
      renderLeds();
      break;
    case 'rowDown':
      editRowOffset -= shift ? SHIFT_JUMP : 1;
      renderLeds();
      break;
    case 'stepLeft': {
      const clip = ensureSelClip(nodeId);
      scrollStep(clip, shift ? -SHIFT_JUMP : -1);
      renderLeds();
      break;
    }
    case 'stepRight': {
      const clip = ensureSelClip(nodeId);
      scrollStep(clip, shift ? +SHIFT_JUMP : +1);
      renderLeds();
      break;
    }
    default:
      break;
  }
}

// ── KEYS sub-view (right column = scale-select / arp; pad = keyboard/controls). ──
function handleSingleKeys(nodeId: string, e: LaunchpadKeyEvent): void {
  const ev = e.ev;
  if (ev.type === 'scene') {
    if (ev.s !== 1) return;
    const sceneIndex = sceneIndexForCc(ev.cc);
    if (sceneIndex === null) return;
    if (singleShiftEff()) handleKeysArp(nodeId, sceneIndex);
    else handleKeysScale(nodeId, sceneIndex);
    return;
  }
  // pad = keyboard + bottom-row controls (EXIT/QREC/OVERDUB/OCT±/PANIC/LEN).
  handleKeysUnit(nodeId, 'L', e);
}

/** KEYS no-shift right column: set clip.scale to the tapped scale (chromatic =
 *  remove the scale), or toggle the arp on/off. */
function handleKeysScale(nodeId: string, sceneIndex: number): void {
  const r = keysScaleRight(sceneIndex);
  if (r === null) return;
  if (r === 'arpToggle') {
    arpToggle(nodeId);
    return;
  }
  const clip = clipAtIndex(liveData(nodeId), keysClipIndex);
  if (!clip) return;
  const next: NoteClipRecord = { ...clip };
  if (r.scale) next.scale = r.scale;
  else delete next.scale; // chromatic = the absence of a scale
  writeClip(nodeId, next, keysClipIndex, { undoable: true });
  renderLeds();
}

/** KEYS + shift right column: the arp control column (div ± / direction / range
 *  ± / latch). All edit the live arp state. arpDivUp = toward the FASTER (larger)
 *  multiplier (lower ARP_DIVISIONS index); arpRangeUp = a wider octave span. */
function handleKeysArp(nodeId: string, sceneIndex: number): void {
  switch (keysArpShiftRight(sceneIndex)) {
    case 'arpDivUp':
      arp = arpSetParams(arp, { divisionIndex: arp.params.divisionIndex - 1 });
      break;
    case 'arpDivDown':
      arp = arpSetParams(arp, { divisionIndex: arp.params.divisionIndex + 1 });
      break;
    case 'arpUp':
      arp = arpSetParams(arp, { direction: 'up' });
      break;
    case 'arpDown':
      arp = arpSetParams(arp, { direction: 'down' });
      break;
    case 'arpUpDown':
      arp = arpSetParams(arp, { direction: 'updown' });
      break;
    case 'arpRangeUp':
      arp = arpSetParams(arp, { octaveRangeIndex: arp.params.octaveRangeIndex + 1 });
      break;
    case 'arpRangeDown':
      arp = arpSetParams(arp, { octaveRangeIndex: arp.params.octaveRangeIndex - 1 });
      break;
    case 'arpLatch':
      arp = arpSetParams(arp, { latch: !arp.params.latch });
      break;
    default:
      break;
  }
  renderLeds();
}

/** Toggle the arp on/off. ON: silence the directly-sounding held notes + seed the
 *  arp from them. OFF: flush the arp's sounding note + re-audition the held keys. */
function arpToggle(nodeId: string): void {
  arpOn = !arpOn;
  const lane = laneOf(keysClipIndex);
  if (arpOn) {
    for (const midi of keysPressed) pushAudition(nodeId, { lane, midi, velocity: 0, on: false });
    arp = arpSetHeld(arp, [...keysPressed]);
    arpNextTime = 0; // fire on the next service tick
  } else {
    if (arp.playing !== null) {
      pushAudition(nodeId, { lane, midi: arp.playing, velocity: 0, on: false });
      arp = { ...arp, playing: null };
    }
    for (const midi of keysPressed) pushAudition(nodeId, { lane, midi, velocity: VEL_DEFAULT, on: true });
    arpNextTime = 0;
  }
  renderLeds();
}

/** Monotonic wall clock (ms) for the arp step scheduler. */
function nowMs(): number {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}
/** TIMELORDE bpm (default 120 when absent). */
function transportBpm(): number {
  const t = timelordeNode();
  const b = t?.node.params?.bpm;
  return typeof b === 'number' && b > 0 ? b : 120;
}

/** Advance the arp from the render loop (tick-granular). Runs while KEYS is open
 *  OR the arp is latched, clocked by bpm (independent of the transport). NOTE:
 *  generation is tick-granular (~25 ms) for v1 — a follow-up could move it into
 *  the clipplayer factory for sample-accurate scheduling. */
function serviceArp(nodeId: string): void {
  if (!arpOn) return;
  if (mode !== 'keys' && !arp.params.latch) return; // stopped when you leave KEYS non-latched
  const lane = laneOf(keysClipIndex);
  if (arp.pool.length === 0) {
    if (arp.playing !== null) applyArpStep(nodeId, lane, arpAdvance(arp)); // flush the final note-off
    arpNextTime = 0;
    return;
  }
  const now = nowMs();
  const beatMs = (60 / transportBpm()) * 1000;
  const stepMs = arpStepPeriod(beatMs, arp.params.divisionIndex);
  if (arpNextTime === 0) arpNextTime = now;
  if (now - arpNextTime > beatMs * 8) arpNextTime = now; // recover from a long stall (backgrounded tab)
  let guard = 0;
  while (now >= arpNextTime && guard < 32) {
    applyArpStep(nodeId, lane, arpAdvance(arp));
    arpNextTime += stepMs;
    guard++;
  }
}
function applyArpStep(nodeId: string, lane: number, step: ReturnType<typeof arpAdvance>): void {
  if (step.noteOff !== undefined) pushAudition(nodeId, { lane, midi: step.noteOff, velocity: 0, on: false });
  if (step.noteOn !== undefined) pushAudition(nodeId, { lane, midi: step.noteOn, velocity: VEL_DEFAULT, on: true });
  arp = step.state;
}

// ── CONTROL view (performance deck: RESET/MONO/MUTE/RATE + per-lane STOP; the
// re-homed transport nudges / STOP-ALL / arranger REC / SONG on dark grid pads). ──
function handleSingleControl(nodeId: string, e: LaunchpadKeyEvent): void {
  const ev = e.ev;
  const data = liveData(nodeId);
  if (ev.type === 'pad') {
    if (ev.s !== 1) return; // control taps act on press
    // Performance rows (RESET · per-lane MONO / MUTE / RATE).
    if (rDeckReset(ev.x, ev.y)) { doReset(nodeId); return; }
    const monoLane = rDeckMonoLane(ev.x, ev.y);
    if (monoLane !== null) { toggleMono(nodeId, monoLane); return; }
    const muteLane = rDeckMuteLane(ev.x, ev.y);
    if (muteLane !== null) { toggleMute(nodeId, muteLane); return; }
    const rateLane = rDeckRateLane(ev.x, ev.y);
    if (rateLane !== null) { cycleRate(nodeId, rateLane); return; }
    // Re-homed deck top-row functions (tempo ∓ / STOP-ALL / arranger REC / SONG).
    switch (controlRehomePad(ev.x, ev.y)) {
      case 'tempoDown': nudgeTempo(-TEMPO_NUDGE_BPM); return;
      case 'tempoUp': nudgeTempo(+TEMPO_NUDGE_BPM); return;
      case 'stopAll':
        editData(nodeId, (d) => { d.queued = new Array(CLIP_LANES).fill('stop'); });
        return;
      case 'rec': toggleRecording(nodeId); return;
      case 'song': toggleArrangeMode(nodeId); return;
      default: return;
    }
  }
  if (ev.type === 'scene') {
    if (ev.s !== 1) return;
    const sceneIndex = sceneIndexForCc(ev.cc);
    if (sceneIndex === null) return;
    const lane = controlRight(sceneIndex);
    if (lane === null) return;
    if (lanePlaying(data, lane) !== null) queueLane(nodeId, lane, 'stop', nowHeld);
  }
}

/** Unit L is ALWAYS the live clip matrix + scene column. */
function handleL(nodeId: string, e: LaunchpadKeyEvent): void {
  const ev = e.ev;
  const data = liveData(nodeId);

  if (ev.type === 'pad') {
    const clipIdx = lPadToClipIndex(ev.x, ev.y);
    if (clipIdx === null) return;
    if (ev.s !== 1) return; // clip launch acts on press
    // KEYS ENTRY (pair): holding note-REC or note-OVERDUB on the R deck
    // SUPPRESSES the launch on L taps (mirror editArmed) and a DOUBLE-TAP of a
    // clip opens the KEYS view for it — hold-REC = overdub OFF, hold-OVERDUB =
    // overdub ON. The double-tap (two taps of the same clip within the window) is
    // the safety layer against accidental entry into a destructive mode.
    if (keysRecHeld || keysOverdubHeld) {
      if (clipIdx === lastTapClipIndex && tickCount - lastTapTick <= DOUBLE_TAP_TICKS) {
        lastTapClipIndex = -1;
        enterKeys(nodeId, clipIdx, keysOverdubHeld, data);
        return;
      }
      lastTapClipIndex = clipIdx;
      lastTapTick = tickCount;
      lastTapPrevQueued = laneQueued(data, laneOf(clipIdx));
      lastTapWasPlaying = lanePlaying(data, laneOf(clipIdx)) === slotOf(clipIdx);
      return; // single tap while a KEYS-hold is held = suppressed (no launch)
    }
    // Held-modifier branches FIRST (the modifiers live on R, read here).
    if (editArmed) {
      // hold-EDIT (on R) + tap a clip (on L) → enter the editor on R. Not a
      // launch → clear the double-tap tracker so it can't mis-pair later.
      lastTapClipIndex = -1;
      if (!data?.clips?.[String(clipIdx)]) {
        editData(nodeId, (d) => {
          if (!d.clips) d.clips = {};
          if (!d.clips[String(clipIdx)]) d.clips[String(clipIdx)] = defaultNoteClip();
        });
      }
      editClipIndex = clipIdx;
      mode = 'edit';
      editArmed = false;
      editAnchor = null;
      editSpanned = false;
      editRowOffset = 0;
      editWindowStart = 0;
      followOn = true;
      velHeld = false;
      return;
    }
    if (copyHeld) {
      const c = clipAtIndex(data, clipIdx);
      if (c) {
        copyBuffer = { kind: 'clip', clip: copyClip(c), auto: readAutoClip(data, clipIdx) };
        bufferSourceIndex = clipIdx;
      }
      return;
    }
    // PASTE / PASTE-REV act only with a CLIP buffer loaded (a scene buffer is a
    // no-op on a single clip); with no clip buffer the tap falls through to launch,
    // exactly as before. Both carry the buffer's automation (PASTE-REV mirrors
    // the envelope in time to match the reversed notes) and clear the
    // destination's stale record — the envelope belongs to the clip.
    if (pasteHeld && bufferClip()) {
      writeClipWithAuto(nodeId, copyClip(bufferClip()!), bufferClipAuto(), clipIdx);
      return;
    }
    if (pasteRevHeld && bufferClip()) {
      const src = bufferClip()!;
      const auto = bufferClipAuto();
      writeClipWithAuto(
        nodeId,
        reverseClipSteps(copyClip(src)),
        auto ? reverseAutoClipRecord(auto, src.lengthSteps) : null,
        clipIdx,
      );
      return;
    }
    const lane = laneOf(clipIdx);
    const slot = slotOf(clipIdx);
    if (lanePlaying(data, lane) === slot) queueLane(nodeId, lane, 'stop', nowHeld);
    else if (data?.clips?.[String(clipIdx)]) queueLane(nodeId, lane, slot, nowHeld);
    return;
  }

  if (ev.type === 'scene') {
    if (ev.s !== 1) return;
    const slot = lSceneSlotForRow(ev.row);
    if (slot === null) return;
    // The SHARED scene-launch seam: one transaction for the whole scene (was 8
    // separate queueLane writes) + the `sceneLaunch` marker bump the repeat
    // tracker re-anchors from. Content-gated like the single-mode launch (an
    // empty scene is a no-op, not a stop-all).
    editData(nodeId, (d) => {
      applySceneLaunchWrite(d, slot, nowHeld);
    });
    return;
  }

  // PAIR unit-L TOP ROW (CC 91..98) = the 8 per-lane MUTE pads (col = lane) — the
  // previously-dead, always-visible matrix top row now hosts live-performance
  // MUTE. handleL is PAIR-ONLY now (single routes to handleSingleKey's per-view
  // handlers), so this branch is reached only in pair.
  if (ev.type === 'top') {
    if (ev.s !== 1) return;
    const lane = lTopMuteLane(ev.cc);
    if (lane !== null) toggleMute(nodeId, lane);
    return;
  }
}

/** Unit R: the command deck (session) / note editor / length-edit page. */
function handleR(nodeId: string, e: LaunchpadKeyEvent): void {
  const ev = e.ev;

  // SHIFT (CC 95) is a global held modifier across all R modes.
  if (ev.type === 'top' && ev.cc === CC_SHIFT) {
    shiftHeld = ev.s === 1;
    return;
  }

  if (mode === 'lengthEdit') return handleRLength(nodeId, e);
  if (mode === 'edit') return handleREdit(nodeId, e);
  return handleRDeck(nodeId, e);
}

function handleRDeck(nodeId: string, e: LaunchpadKeyEvent): void {
  const ev = e.ev;
  const data = liveData(nodeId);

  if (ev.type === 'pad') {
    // Tap the COPY-INDICATOR pad to EMPTY the buffer (turns off the turquoise
    // source glow on L). It's render-only otherwise, so handle it before the
    // rDeckPad classifier (which returns null for it).
    if (ev.x === DECK_COPY_IND_COL && ev.y === DECK_ROW) {
      if (ev.s === 1) clearBuffer();
      return;
    }
    // KEYS-entry hold buttons (dark deck pads, row 1) — pair AND single. HELD
    // modifiers (act on both edges): hold one + double-tap a clip on L → open
    // KEYS. In single mode the hold is set here (CONTROL view) and survives the
    // CC-98 flip to clip view, where the double-tap lands (see handleL).
    {
      const keysHold = rDeckKeysHold(ev.x, ev.y);
      if (keysHold === 'keysRec') { keysRecHeld = ev.s === 1; return; }
      if (keysHold === 'keysOverdub') { keysOverdubHeld = ev.s === 1; return; }
    }
    // PERFORMANCE rows on the previously-dead deck pads (P1/P4/P3/P2) — TAP
    // actions (press only). RESET (row 1 col 2), then the per-lane MONO / MUTE /
    // RATE rows (row 2 / 3 / 4, col = lane). These pads are dark on the stock
    // deck, so they can't collide with the row-0 function pads, the KEYS holds
    // (row 1 cols 0-1), or the scene STOP column.
    if (rDeckReset(ev.x, ev.y)) { if (ev.s === 1) doReset(nodeId); return; }
    {
      const monoLane = rDeckMonoLane(ev.x, ev.y);
      if (monoLane !== null) { if (ev.s === 1) toggleMono(nodeId, monoLane); return; }
      const muteLane = rDeckMuteLane(ev.x, ev.y);
      if (muteLane !== null) { if (ev.s === 1) toggleMute(nodeId, muteLane); return; }
      const rateLane = rDeckRateLane(ev.x, ev.y);
      if (rateLane !== null) { if (ev.s === 1) cycleRate(nodeId, rateLane); return; }
    }
    const action = rDeckPad(ev.x, ev.y);
    if (!action) return;
    // EDIT / COPY / PASTE / PASTE-REV / NOW are HELD modifiers (act on both edges).
    if (action === 'edit') { editArmed = ev.s === 1; return; }
    if (action === 'copy') { copyHeld = ev.s === 1; return; }
    if (action === 'paste') { pasteHeld = ev.s === 1; return; }
    if (action === 'pasteRev') { pasteRevHeld = ev.s === 1; return; }
    if (action === 'now') { nowHeld = ev.s === 1; return; }
    if (ev.s !== 1) return; // the remaining are tap actions
    if (action === 'double') {
      const clip = clipAtIndex(data, editClipIndex);
      if (clip) {
        const next = doubleNoteClip(clip);
        if (next !== clip) writeClip(nodeId, next);
      }
      return;
    }
    if (action === 'lengthEdit') {
      // Open the length page for the most-recently-edited clip (or clip 0).
      if (clipAtIndex(data, editClipIndex)) mode = 'lengthEdit';
      return;
    }
    return;
  }

  if (ev.type === 'scene') {
    if (ev.s !== 1) return;
    const lane = rStopLaneForRow(ev.row);
    if (lane === null) return;
    if (lanePlaying(data, lane) !== null) queueLane(nodeId, lane, 'stop', nowHeld);
    return;
  }

  if (ev.type === 'top') {
    if (ev.s !== 1) return;
    if (ev.cc === CC_TRANSPORT) { toggleTransport(); return; }
    if (ev.cc === CC_STOP_ALL) {
      editData(nodeId, (d) => { d.queued = new Array(CLIP_LANES).fill('stop'); });
      return;
    }
    if (ev.cc === CC_REC) { toggleRecording(nodeId); return; }
    if (ev.cc === CC_SONG) { toggleArrangeMode(nodeId); return; }
    // TEMPO NUDGE −/+ (CC 93/94) — step TIMELORDE's bpm (clamped 10..300). These
    // CCs are dead in the session deck (the editor uses them as ◀/▶ in a separate
    // mode/frame, so no collision).
    if (ev.cc === CC_TEMPO_DOWN) { nudgeTempo(-TEMPO_NUDGE_BPM); return; }
    if (ev.cc === CC_TEMPO_UP) { nudgeTempo(+TEMPO_NUDGE_BPM); return; }
  }
}

function handleREdit(nodeId: string, e: LaunchpadKeyEvent): void {
  const ev = e.ev;
  const clip = clipAtIndex(liveData(nodeId), editClipIndex);
  if (!clip) { mode = 'session'; return; }

  // Scene column: top = EXIT · row 6 = DOUBLE · row 5 = LENGTH-EDIT. SINGLE
  // mode adds row 4 = FOLLOW (CC 98 is the view-flip on one device, so the
  // single editor's FOLLOW lives here; pair keeps row 4 dark + inert). Rows
  // 1,0 = OCT ± — they jump the pitch WINDOW up/down a whole octave. Rows 3,2
  // are dark + inert (copy/paste is a Grid-page-only feature).
  if (ev.type === 'scene') {
    if (ev.s !== 1) return;
    const act = editSceneAction(ev.row, { followButton: deployment === 'single' });
    if (act === 'exit') {
      mode = 'session';
      editAnchor = null;
      editSpanned = false;
      velHeld = false;
    } else if (act === 'double') {
      const next = doubleNoteClip(clip);
      if (next !== clip) writeClip(nodeId, next);
    } else if (act === 'lengthEdit') {
      mode = 'lengthEdit';
    } else if (act === 'follow') {
      toggleFollow(clip);
    } else if (act === 'octUp') {
      editRowOffset += scaleSteps(clip.scale).length; // one octave = a scale's degrees
    } else if (act === 'octDown') {
      editRowOffset -= scaleSteps(clip.scale).length;
    }
    return;
  }

  // Top-row nav + edit functions.
  if (ev.type === 'top') {
    if (ev.cc === CC_EDIT_VEL) { velHeld = ev.s === 1; return; } // hold-modifier
    if (ev.s !== 1) return; // the rest act on press
    const mag = shiftHeld ? SHIFT_JUMP : 1;
    if (ev.cc === CC_EDIT_ROW_UP) { editRowOffset += mag; return; }
    if (ev.cc === CC_EDIT_ROW_DOWN) { editRowOffset -= mag; return; }
    if (ev.cc === CC_EDIT_STEP_RIGHT) { scrollStep(clip, +mag); return; }
    if (ev.cc === CC_EDIT_STEP_LEFT) { scrollStep(clip, -mag); return; }
    if (ev.cc === CC_EDIT_SCALE) {
      editData(nodeId, (d) => {
        const c = d.clips?.[String(editClipIndex)] as NoteClipRecord | undefined;
        if (!c) return;
        const ns = nextScale(c.scale);
        if (ns) c.scale = ns;
        else delete c.scale;
      });
      return;
    }
    if (ev.cc === CC_EDIT_FOLLOW) {
      toggleFollow(clip);
      return;
    }
    return;
  }

  // Note grid pads. The 8-step window starts at the (frozen or followed) absolute
  // step; colOffset carries it (page stays 0 → realStep = windowStart + x).
  if (ev.type !== 'pad') return;
  const note = editPadToNote(clip, ev.x, ev.y, { rowOffset: editRowOffset, colOffset: shownWindowStart(clip), page: 0 });
  if (!note) return;
  const mono = laneMono(liveData(nodeId), laneOf(editClipIndex));
  if (ev.s === 1) {
    if (velHeld) {
      writeClip(nodeId, cycleVelocity(clip, note.step, note.midi));
    } else if (editAnchor && editAnchor.midi === note.midi && editAnchor.step !== note.step) {
      writeClip(nodeId, setNoteSpan(clip, editAnchor.step, note.step, note.midi, { mono }));
      editSpanned = true;
    } else {
      editAnchor = { step: note.step, midi: note.midi };
      editSpanned = false;
    }
  } else if (!velHeld && editAnchor && editAnchor.step === note.step && editAnchor.midi === note.midi) {
    if (!editSpanned) writeClip(nodeId, toggleNoteAt(clip, note.step, note.midi, { mono }));
    editAnchor = null;
    editSpanned = false;
  }
}

/** FOLLOW toggle — the ONE body behind the pair's CC-98 button AND the single
 *  editor's scene-row-4 FOLLOW pad. ON→OFF freezes on the window currently
 *  shown (capture before clearing); OFF→ON resumes tracking the playhead. */
function toggleFollow(clip: NoteClipRecord): void {
  if (followOn) {
    editWindowStart = shownWindowStart(clip);
    followOn = false;
    clampWindow(clip);
  } else {
    followOn = true;
    clampWindow(clip);
  }
}

/** Scroll the step window by `delta` ABSOLUTE steps (◀/▶ = ±1, SHIFT = ±8). The
 *  window free-scrolls per step across the clip — no half-block snapping (owner:
 *  "◀/▶ = ±1 step"). While FOLLOWing, the first manual scroll freezes (captures
 *  the live window start) so the user can move off the playhead. */
function scrollStep(clip: NoteClipRecord, delta: number): void {
  if (followOn) {
    editWindowStart = shownWindowStart(clip);
    followOn = false;
  }
  editWindowStart = Math.max(0, Math.min(maxWindowStart(clip), editWindowStart + delta));
}

/** Where LENGTH-EDIT EXIT returns to: KEYS if opened from KEYS, else the editor. */
function lengthExitMode(): 'edit' | 'keys' {
  return lengthReturnMode === 'keys' ? 'keys' : 'edit';
}
/** EXIT the length page. PAIR: back to the editor / KEYS (lengthExitMode). SINGLE:
 *  back to KEYS if opened from KEYS, else to the Grid/Clip VIEW it was opened from
 *  (lengthReturnView). */
function exitLengthEdit(clip: NoteClipRecord): void {
  if (deployment === 'single') {
    if (lengthReturnMode === 'keys') {
      mode = 'keys';
    } else {
      mode = 'session';
      setSingleViewInternal(lengthReturnView);
    }
    clampWindow(clip);
    return;
  }
  mode = lengthExitMode(); // pair path unchanged
  clampWindow(clip);
}
function handleRLength(nodeId: string, e: LaunchpadKeyEvent): void {
  const ev = e.ev;
  const clip = clipAtIndex(liveData(nodeId), editClipIndex);
  if (!clip) { mode = 'session'; return; }
  if (ev.type === 'scene') {
    if (ev.s !== 1) return;
    if (isEditExitSceneRow(ev.row)) exitLengthEdit(clip);
    return;
  }
  if (ev.type !== 'pad' || ev.s !== 1) return;
  const act = rLengthPad(ev.x, ev.y);
  if (!act) return;
  if (act.kind === 'exit') { exitLengthEdit(clip); return; }
  const nextLen =
    act.kind === 'block' ? lengthFromBlockTap(act.block) : lengthFromStepTap(clip.lengthSteps, act.step);
  editData(
    nodeId,
    (d) => {
      const c = d.clips?.[String(editClipIndex)] as NoteClipRecord | undefined;
      if (c) c.lengthSteps = nextLen;
    },
    { undoable: true },
  );
}

// ---------------------------------------------------------------------------
// LED render loop. PAIR: repaint BOTH units each tick (L = matrix, R = deck).
// SINGLE: repaint the LONE device (the L slot) in its active-view role.
// ---------------------------------------------------------------------------

/** Paint the L-role (clip matrix) frame onto a physical unit. PAIR-ONLY now (the
 *  single device paints the per-view frames): the top row is the 8 per-lane MUTE
 *  pads (`lTopMute`); the matrix + scene render byte-for-byte as before. */
function paintLRole(target: LaunchpadUnit, data: ClipPlayerData | undefined, blinkOn: boolean): void {
  setFrame(
    target,
    computeLSessionFrame(data, {
      blinkOn,
      recording: recordArmed(data),
      lTopMute: true, // pair-L top row = per-lane MUTE
    }),
  );
}

/** Paint the R-role (deck / editor / length) frame onto a physical unit. The
 *  `mode` machine (session→edit→length) is the SAME in pair + single. */
function paintRRole(
  target: LaunchpadUnit,
  nodeId: string,
  data: ClipPlayerData | undefined,
  blinkOn: boolean,
): void {
  if (mode === 'lengthEdit') {
    const clip = clipAtIndex(data, editClipIndex);
    if (clip) { setFrame(target, computeRLengthFrame(clip)); return; }
    mode = 'session';
  }
  if (mode === 'edit') {
    const clip = clipAtIndex(data, editClipIndex);
    if (clip) {
      // The editor frame keys the playhead on the ABSOLUTE step; pass the live
      // playhead (-1 when the edited clip isn't playing). The 8-step window
      // starts at the (frozen/followed) absolute step via colOffset (page 0).
      const absPlayhead = editPlayhead(nodeId, data);
      setFrame(target, computeREditFrame(clip, {
        rowOffset: editRowOffset,
        colOffset: shownWindowStart(clip),
        page: 0,
        playheadStep: absPlayhead,
        velArmed: velHeld,
        followOn,
        shiftHeld,
        // SINGLE: FOLLOW gets a real pad on scene row 4 (CC 98 is the view
        // flip). Pair leaves row 4 dark — its FOLLOW is the CC-98 button.
        followSceneButton: deployment === 'single',
      }));
      return;
    }
    mode = 'session';
  }
  setFrame(target, computeRDeckFrame({
    blinkOn,
    transportRunning: transportRunning(),
    editArmed,
    copyHeld,
    pasteHeld,
    pasteRevHeld,
    nowHeld,
    bufferArmed: bufferClip() !== null, // pair deck indicator = a CLIP buffer (pair can't paste a scene)
    recording: recordArmed(data),
    arrangeMode: arrangeMode(data),
    keysRecHeld,
    keysOverdubHeld,
    data,
  }));
}

/** Paint the KEYS view onto a unit (pair: both units are the keyboard; single:
 *  the lone device is the L half with an 8-cell whole-clip playhead strip).
 *  Returns false when the KEYS clip has vanished (caller drops to session). */
function paintKeysRole(
  target: LaunchpadUnit,
  nodeId: string,
  data: ClipPlayerData | undefined,
  blinkOn: boolean,
): boolean {
  const clip = clipAtIndex(data, keysClipIndex);
  if (!clip) return false;
  const lane = laneOf(keysClipIndex);
  const ph = lanePlaying(data, lane) === slotOf(keysClipIndex) ? getLanePlayhead(nodeId, lane) : -1;
  const rec = readNoteRec(data);
  setFrame(
    target,
    computeKeysFrame({
      unit: target,
      keyboardRoot: keysKeyboardRoot(clip),
      scale: clip.scale,
      playheadStep: ph,
      lengthSteps: clip.lengthSteps,
      pressed: keysPressed,
      recArmed: rec?.armed,
      recording: rec?.recording,
      overdub: rec?.overdub,
      blinkOn,
      // SINGLE: the whole clip across the lone device's 8 top-row cells (the
      // pair spreads 16 cells over L+R; one device compresses to 8 so the
      // moving dot never runs off the surface).
      phCells: deployment === 'single' ? LP_WIDTH : undefined,
    }),
  );
  return true;
}

/** Build the PERMANENT top-row opts for the current single-mode render pass.
 *  `laneArms` carries every lane's SYNCED automation arm (the always-visible
 *  red-flash overlay + the shift-active arm map); `blinkOn` shares the render
 *  loop's blink phase so the arm flash pulses with the other record lights. */
function buildTopOpts(): PermanentTopOpts {
  const data = boundNodeId
    ? (livePatch.nodes[boundNodeId]?.data as ClipPlayerData | undefined)
    : undefined;
  return {
    view: singleView,
    keysActive: mode === 'keys',
    transportRunning: transportRunning(),
    shift: { held: shiftHeldSingle },
    canUndo: lpCanUndo(),
    canRedo: lpCanRedo(),
    laneArms: armedAutomationLanes(data),
    blinkOn: Math.floor(tickCount / BLINK_TICKS) % 2 === 0,
  };
}
/** Software pulse phase for the Clip-Div preview pad (faster div → faster blink). */
function divPulsePhase(divIndex: number): boolean {
  const mult = RATE_MULTS[coerceRateIndex(divIndex)];
  const period = Math.max(1, Math.round(BLINK_TICKS / mult));
  return Math.floor(tickCount / period) % 2 === 0;
}
/** The selected clip's live playhead step (-1 when it isn't playing). */
function selPlayhead(nodeId: string, data: ClipPlayerData | undefined): number {
  const lane = laneOf(selectedClipIndex);
  return lanePlaying(data, lane) === slotOf(selectedClipIndex) ? getLanePlayhead(nodeId, lane) : -1;
}
/** The PER-LANE automation COUNTDOWN paints for the bound player — one entry
 *  per RECORDING lane inside its 4-beat pre-roll (the clipplayer tick publishes
 *  the per-lane render state; the pure helpers bucket each to a colour +
 *  on-beat pulse). Each carries its clip's flat index so the Grid view can
 *  flash EVERY recording lane's matrix cell on ITS own wrap. Null when none. */
function autoCountdownPaints(
  nodeId: string,
): (CountdownPaint & { clipIndex: number })[] | null {
  const rs = getAutomationRender(nodeId);
  if (!rs) return null;
  const out: (CountdownPaint & { clipIndex: number })[] = [];
  for (const l of rs.lanes) {
    if (!l.recording) continue;
    const color = automationCountdownColor(l.beatsToLoopEnd);
    if (!color) continue;
    out.push({ color, on: automationCountdownOn(l.beatPhase), clipIndex: clipIndex(l.slot, l.lane) });
  }
  return out.length ? out : null;
}
// (The Control-view AUTO pad's soonest-lane countdown helper is retired with
// the pad — per-lane countdowns stay on the Grid matrix cells, and the
// permanent top row carries the per-lane ARM state in every view.)
/** Paint the SINGLE KEYS sub-view (keyboard + scale/arp right column + permanent
 *  top row). Returns false when the KEYS clip vanished (caller drops to session). */
function paintSingleKeys(
  nodeId: string,
  data: ClipPlayerData | undefined,
  blinkOn: boolean,
  top: PermanentTopOpts,
): boolean {
  const clip = clipAtIndex(data, keysClipIndex);
  if (!clip) return false;
  const lane = laneOf(keysClipIndex);
  const ph = lanePlaying(data, lane) === slotOf(keysClipIndex) ? getLanePlayhead(nodeId, lane) : -1;
  const rec = readNoteRec(data);
  setFrame(
    'L',
    computeSingleKeysFrame({
      top,
      keyboardRoot: keysKeyboardRoot(clip),
      scale: clip.scale,
      playheadStep: ph,
      lengthSteps: clip.lengthSteps,
      pressed: keysPressed,
      recArmed: rec?.armed,
      recording: rec?.recording,
      overdub: rec?.overdub,
      blinkOn,
      selectedScale: clip.scale,
      arpOn,
      arpDir: arp.params.direction,
      arpDivIndex: arp.params.divisionIndex,
      arpRangeIndex: arp.params.octaveRangeIndex,
      arpLatch: arp.params.latch,
    }),
  );
  return true;
}

function renderLeds(): void {
  const single = deployment === 'single';
  if (!single && !isPairBound()) return; // pair needs both units to paint
  if (single && !isSingleBound()) return; // single needs the lone L-slot device
  const nodeId = boundNodeId;
  const node = nodeId ? livePatch.nodes[nodeId] : null;
  if (!nodeId || !node) {
    // Bound device(s) but no clip-player yet — paint a dim "ready" glow so the
    // surface is visibly alive (add a clip-player to go live).
    if (single) {
      // The lone device shows a dim wash tinted by the active view + the live
      // permanent top row (nav is reachable even before a clip-player binds).
      const idle =
        singleView === 'control'
          ? idleFrame(14, 7, 0)
          : singleView === 'arranger'
          ? idleFrame(6, 2, 12)
          : idleFrame(0, 0, 20);
      paintPermanentTopRow(idle, buildTopOpts());
      setFrame('L', idle);
    } else {
      setFrame('L', idleFrame(0, 0, 20)); // L (matrix) = dim blue
      setFrame('R', idleFrame(14, 7, 0)); // R (deck) = dim amber
    }
    return;
  }
  tickCount++;
  const blinkOn = Math.floor(tickCount / BLINK_TICKS) % 2 === 0;
  const data = node.data as ClipPlayerData | undefined;

  // Auto-disarm a stale Grid tap-to-arm after ~4s (single mode only; pair never
  // arms). Guards against an "armed then walked away" modal trap. Done inline (no
  // recursive renderLeds) — commit any pending Clip-Div preview as it clears.
  if (single && armedRightAction && tickCount - armTick > ARM_TIMEOUT_TICKS) {
    if (armedRightAction === 'clipDiv') commitDivPreview(nodeId);
    armedRightAction = null;
    divPreview = null;
  }

  if (single) {
    // Advance the arp (tick-granular; runs while KEYS is open or the arp is
    // latched, clocked by bpm — independent of the transport).
    serviceArp(nodeId);
    const top = buildTopOpts();
    // KEYS sub-view owns the surface — service the record machine, paint the
    // single (8-cell-playhead) keys frame + the permanent top row.
    if (mode === 'keys') {
      serviceKeysRecord(nodeId, data);
      if (paintSingleKeys(nodeId, data, blinkOn, top)) return;
      mode = 'session'; // the KEYS clip vanished — fall through to the views
    }
    // Length-edit is a full-device takeover (the ruler owns the surface; EXIT via
    // the scene column returns to the opener's view).
    if (mode === 'lengthEdit') {
      const clip = clipAtIndex(data, editClipIndex);
      if (clip) {
        // The permanent top row stays lit + live even during the length ruler
        // (the ruler only uses the 8×8 + scene column) — the row NEVER goes dark.
        const frame = computeRLengthFrame(clip);
        paintPermanentTopRow(frame, top);
        setFrame('L', frame);
        return;
      }
      mode = 'session';
    }
    // Else paint the active VIEW's frame (each includes the permanent top row).
    switch (singleView) {
      case 'grid':
        setFrame(
          'L',
          computeSingleGridFrame(data, {
            top,
            blinkOn,
            recording: recordArmed(data),
            armedRightAction,
            bufferLoaded: bufferLoaded(),
            bufferKind: bufferKindOf(),
            sceneScrollOffset,
            canScrollUp: sceneScrollOffset > 0,
            canScrollDown: sceneScrollOffset < maxSceneScrollOffset(highestContentScene(data)),
            repeatView: repeatViewHeld
              ? {
                  count: sceneRepeatCount(data, repeatViewHeld.slot),
                  sceneIndex: repeatViewHeld.sceneIndex,
                }
              : undefined,
            // CLIP-DEFAULT PROB page: while a clip is latched, the 8×8 is its
            // orange default-probability bar (reads the clip's current default).
            clipProbView: clipProbEditHeld
              ? { prob: clipDefaultProbEff(clipAtIndex(data, clipProbEditHeld.clipIdx) ?? undefined) }
              : null,
            divPulse: divPreview
              ? { clipIndex: divPreview.clipIndex, on: divPulsePhase(divPreview.divIndex) }
              : undefined,
            swingMeter: singleShiftEff()
              ? {
                  active: swingMeterActive,
                  dir: swingMeterDir,
                  level0to1: laneSwing(data, laneOf(selectedClipIndex)) / MAX_SWING,
                }
              : undefined,
            autoCountdown: autoCountdownPaints(nodeId),
          }),
        );
        break;
      case 'clip': {
        const clip = clipAtIndex(data, selectedClipIndex) ?? defaultNoteClip();
        setFrame(
          'L',
          computeSingleClipFrame(clip, {
            top,
            rowOffset: editRowOffset,
            colOffset: shownWindowStart(clip),
            page: 0,
            playheadStep: selPlayhead(nodeId, data),
            followOn,
            // VEL-hold wash (the relocated velocity modifier), not shift (shift
            // now opens the PROB page).
            velEditing: velHeld,
            // PROB page: while a note is latched, the 8×8 is its probability bar.
            probView: probEditHeld
              ? { prob: probEff(noteCovering(clip, probEditHeld.step, probEditHeld.midi)) }
              : null,
            blinkOn,
          }),
        );
        break;
      }
      case 'arranger':
        setFrame('L', computeSingleArrangerFrame({ top }));
        break;
      case 'control':
        setFrame(
          'L',
          computeSingleControlFrame({
            top,
            blinkOn,
            recording: recordArmed(data),
            arrangeMode: arrangeMode(data),
            data,
          }),
        );
        break;
    }
    return;
  }

  // KEYS mode (pair-only): both units are the note/keyboard + clip-record view.
  // Service the record state machine first (arm→record on wrap, true-replace
  // clear, overdub finish), then paint both units.
  if (mode === 'keys') {
    serviceKeysRecord(nodeId, data);
    if (paintKeysRole('L', nodeId, data, blinkOn) && paintKeysRole('R', nodeId, data, blinkOn)) return;
    mode = 'session'; // the KEYS clip vanished — fall through to the matrix/deck
  }
  // LENGTH page opened FROM keys: L keeps the live keyboard, R is the ruler.
  if (mode === 'lengthEdit' && lengthReturnMode === 'keys') {
    if (paintKeysRole('L', nodeId, data, blinkOn)) {
      paintRRole('R', nodeId, data, blinkOn);
      return;
    }
    mode = 'session';
  }

  // PAIR (unchanged): UNIT L = the matrix ALWAYS, UNIT R = deck/editor/length.
  paintLRole('L', data, blinkOn);
  paintRRole('R', nodeId, data, blinkOn);
}

// ---------------------------------------------------------------------------
// Test seams.
// ---------------------------------------------------------------------------
export function __test_resetBinding(): void {
  stopLoops();
  boundNodeId = null;
  tickCount = 0;
  deployment = 'pair';
  singleView = 'grid';
  selectedClipIndex = 0;
  mode = 'session';
  editClipIndex = 0;
  editArmed = false;
  copyHeld = false;
  pasteHeld = false;
  pasteRevHeld = false;
  nowHeld = false;
  shiftHeld = false;
  velHeld = false;
  editAnchor = null;
  editSpanned = false;
  editRowOffset = 0;
  editWindowStart = 0;
  followOn = true;
  lengthReturnMode = 'edit';
  lengthReturnView = 'grid';
  resetSingleState();
  lastTapClipIndex = -1;
  lastTapTick = 0;
  lastTapPrevQueued = null;
  lastTapWasPlaying = false;
  copyBuffer = null;
  bufferSourceIndex = null;
  resetKeysState();
}
export function __test_mode(): {
  deployment: 'pair' | 'single';
  singleView: SingleView;
  selectedClipIndex: number;
  mode: LaunchpadMode;
  editClipIndex: number;
  editArmed: boolean;
  copyHeld: boolean;
  pasteHeld: boolean;
  pasteRevHeld: boolean;
  nowHeld: boolean;
  shiftHeld: boolean;
  shiftHeldSingle: boolean;
  velHeld: boolean;
  editRowOffset: number;
  editWindowStart: number;
  sceneScrollOffset: number;
  gridHeldSingle: boolean;
  repeatViewSlot: number | null;
  probEditActive: boolean;
  clipProbEditActive: boolean;
  clipProbClipIndex: number | null;
  followOn: boolean;
  bufferArmed: boolean;
  bufferKind: CopyBufferKind | null;
  bufferSourceIndex: number | null;
  armedRightAction: GridArmAction | null;
  divPreview: { clipIndex: number; divIndex: number } | null;
  swingMeterDir: 'up' | 'down' | 'center';
  lengthReturnMode: 'edit' | 'keys';
  lengthReturnView: SingleView;
  keysClipIndex: number;
  keysRecHeld: boolean;
  keysOverdubHeld: boolean;
  keysOctaveShift: number;
  keysPressedCount: number;
  arpOn: boolean;
  arpDir: ArpState['params']['direction'];
  arpDivIndex: number;
  arpRangeIndex: number;
  arpLatch: boolean;
  arpPoolLen: number;
  canUndo: boolean;
  canRedo: boolean;
} {
  return {
    deployment,
    singleView,
    selectedClipIndex,
    mode,
    editClipIndex,
    editArmed,
    copyHeld,
    pasteHeld,
    pasteRevHeld,
    nowHeld,
    shiftHeld,
    shiftHeldSingle,
    velHeld,
    editRowOffset,
    editWindowStart,
    sceneScrollOffset,
    gridHeldSingle,
    repeatViewSlot: repeatViewHeld?.slot ?? null,
    probEditActive: probEditHeld !== null,
    clipProbEditActive: clipProbEditHeld !== null,
    clipProbClipIndex: clipProbEditHeld?.clipIdx ?? null,
    followOn,
    bufferArmed: bufferLoaded(),
    bufferKind: bufferKindOf(),
    bufferSourceIndex,
    armedRightAction,
    divPreview,
    swingMeterDir,
    lengthReturnMode,
    lengthReturnView,
    keysClipIndex,
    keysRecHeld,
    keysOverdubHeld,
    keysOctaveShift,
    keysPressedCount: keysPressed.size,
    arpOn,
    arpDir: arp.params.direction,
    arpDivIndex: arp.params.divisionIndex,
    arpRangeIndex: arp.params.octaveRangeIndex,
    arpLatch: arp.params.latch,
    arpPoolLen: arp.pool.length,
    canUndo: lpCanUndo(),
    canRedo: lpCanRedo(),
  };
}

/** Test seam: force the deployment + view (so a unit test can drive single mode
 *  without the connect()/enumerate handshake). Does NOT touch the binding. */
export function __test_setDeployment(d: 'pair' | 'single', view: SingleView = 'grid'): void {
  deployment = d;
  singleView = view;
}

/** Test seam: the current typed copy buffer (clip | scene | null) — so a test can
 *  assert what a scene COPY captured without going through a paste. */
export function __test_copyBuffer(): CopyBuffer | null {
  return copyBuffer;
}
