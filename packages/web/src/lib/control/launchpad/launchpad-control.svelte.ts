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
import { padNote, LP_WIDTH, LP_HEIGHT, CC_TOP_SPARE_8 } from './launchpad-sysex';
import {
  // L matrix
  lPadToClipIndex,
  lSceneSlotForRow,
  computeLSessionFrame,
  clipArmAction,
  type ClipArmAction,
  type KeysArm,
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
  RGB_VIEW,
  // KEYS mode (dual-Launchpad note/keyboard + clip-record)
  rDeckKeysHold,
  keysPad,
  computeKeysFrame,
} from './launchpad-map';
import { keyboardCellToMidi } from '$lib/audio/modules/keyboard-map';
import { clearStep, recordNoteAt, extendRecordedNote } from '$lib/audio/modules/clip-record';
import { pushAudition } from '$lib/audio/modules/clip-audition';
import {
  CLIP_LANES,
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
  type ClipPlayerData,
  type NoteClipRecord,
  type NoteRecState,
} from '$lib/audio/modules/clip-types';
import { getLanePlayhead } from '$lib/audio/modules/clip-playhead';
import { laneRateIndex, RATE_MULTS } from '$lib/audio/modules/clip-clock';

export const STORAGE_KEY_NODE = 'pt.launchpad.boundClipNode';
export const STORAGE_KEY_LEFT = 'pt.launchpad.portLeft';
export const STORAGE_KEY_RIGHT = 'pt.launchpad.portRight';
// Single-unit deployment (additive, per-machine). When `deployment === 'single'`
// ONE physical Launchpad is bound to the L slot and a VIEW toggle flips its role
// between the L (clip) + R (control) functionality. These keys never affect the
// pair deployment — pair mode reads neither.
export const STORAGE_KEY_DEPLOYMENT = 'pt.launchpad.deployment'; // 'pair' | 'single'
export const STORAGE_KEY_VIEW = 'pt.launchpad.activeView'; // 'clip' | 'control'

// Blink toggles every BLINK_TICKS scheduler ticks (~25ms each) → ~2 Hz.
const BLINK_TICKS = 10;
const SHIFT_JUMP = 8; // SHIFT magnifies a nav step by a full screen (8 pads).

let boundNodeId: string | null = null;
let unsubKey: (() => void) | null = null;
let unsubTick: (() => void) | null = null;
let tickCount = 0;

// Deployment + single-unit VIEW. In 'pair' EVERYTHING below behaves exactly as
// before (L = the always-live matrix, R = the deck/editor — both physical units).
// In 'single' ONE device is bound to the L slot and `activeView` flips its role:
//   'clip'    → the device acts as UNIT L (clip matrix): keys → handleL, LED =
//               computeLSessionFrame.
//   'control' → the device acts as UNIT R (deck/editor/length): keys → handleR,
//               LED = the R frames. R's deck→edit→length sub-modes (the `mode`
//               machine below) keep working inside control view.
// The view flips via the on-card toggle OR hardware CC 98 (the spare top-right
// button — FREE in pair mode, see handleSingleKey). Flipping clip↔control does
// NOT reset the editor window state (editWindowStart/editRowOffset/followOn).
let deployment: 'pair' | 'single' = 'pair';
let activeView: 'clip' | 'control' = 'clip';

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
let followOn = true;
// Which mode the LENGTH-EDIT page returns to on EXIT ('edit' = the note editor,
// the legacy caller; 'keys' = the KEYS view, when LEN was opened from KEYS).
let lengthReturnMode: 'edit' | 'keys' = 'edit';

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

// Per-machine clip buffer (NOT synced).
let clipBuffer: NoteClipRecord | null = null;
let bufferSourceIndex: number | null = null; // which clip index is in the buffer (for the L turquoise glow)

// SINGLE-mode clip-view ARM STRIP (top CCs 91..97). Two-handed deck ops without
// leaving the matrix view: tap an arm cell → arm an action → tap a clip pad →
// apply. Reuses the existing modifier booleans (copyHeld/pasteHeld/pasteRevHeld)
// as the substrate where they map; `armedAction` is the only NEW discriminant
// (NEW/LENGTH/DOUBLE have no boolean). NOW is a sticky toggle (reuses nowHeld),
// NOT arm-then-tap. Pair mode never sets these (armClip is single-only), so the
// armed-consume guard in handleL is a dead branch in pair.
let armedAction: ClipArmAction | null = null; // null when nothing armed
let armTick = 0; // tickCount snapshot for the 4s auto-disarm
const ARM_TIMEOUT_TICKS = 160; // ~4s at 25ms/tick — auto-disarm a stale arm
// SINGLE-mode CC-91 KEYS-ARM tri-state (the reclaimed NEW cell). off → armed-REC
// (overdub OFF, red) → armed-OD (overdub ON, purple) → off. While armed, tapping
// ANY clip pad in clip view ENTERS KEYS for that clip (one hand, NO view flip) —
// overdub chosen by the tri-state at entry. Auto-disarms on ARM_TIMEOUT_TICKS.
// Pair mode never sets it (single-only, like armedAction). Independent of the
// arm-then-tap actions: arming KEYS clears any pending action-arm and vice versa.
let keysArm: KeysArm = 'off';
let keysArmTick = 0; // tickCount snapshot for the 4s auto-disarm

// SINGLE-mode clip-view DOUBLE-TAP → open the editor. The on-card UI launches on
// single-click + opens the note editor on double-click (ClipplayerCard
// onPadDblClick); single mode has no pair-style hold-EDIT (both halves can't be
// visible on one device), so a double-tap of a clip pad is the one-device way to
// open an EXISTING clip's editor. The FIRST tap still launches IMMEDIATELY (no
// debounce/latency — owner: never slow a launch); a SECOND tap on the SAME clip
// within the window instead opens the editor (mirroring handleL's editArmed
// branch). We track the last tap's clip index + tickCount and call it a
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
  clipBuffer = null;
  bufferSourceIndex = null;
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
/** The active single-unit view ('clip' | 'control'). Meaningless in pair mode. */
export function launchpadActiveView(): 'clip' | 'control' {
  return activeView;
}

/** Persist deployment + the single-unit view (per-machine, additive). */
function persistDeployment(): void {
  try {
    localStorage.setItem(STORAGE_KEY_DEPLOYMENT, deployment);
    localStorage.setItem(STORAGE_KEY_VIEW, activeView);
  } catch {
    /* private mode — session-only */
  }
}

/** Flip the single-unit VIEW between 'clip' and 'control' (no-op in pair mode).
 *  Preserves the editor window state (editWindowStart/editRowOffset/followOn) +
 *  the R deck→edit→length sub-mode across the flip — only the painted/routed
 *  ROLE changes. Repaints the device immediately so the new view lights up. */
export function toggleSingleView(): void {
  if (deployment !== 'single') return;
  setSingleView(activeView === 'clip' ? 'control' : 'clip');
}
function setSingleView(view: 'clip' | 'control'): void {
  if (deployment !== 'single') return;
  if (activeView === view) return;
  activeView = view;
  // Clear the deck's transient HOLD modifiers that can't span a view flip on a
  // single device — a COPY/PASTE/PASTE-REV/NOW held in control view never sees
  // its release once we switch to clip view (handleL ignores the release), which
  // would leave the modifier stuck. (editArmed deliberately SURVIVES: hold EDIT
  // in control, flip to clip, tap a clip = the single-unit "enter editor"
  // gesture; handleL consumes + clears editArmed itself. keysRecHeld /
  // keysOverdubHeld survive for the SAME reason — hold note-REC/OVERDUB in
  // control, flip, double-tap a clip = the single-unit "enter KEYS" gesture;
  // their releases in clip view still route to handleL where they're ignored,
  // but the KEYS entry consumes the double-tap first, and a release after
  // re-flipping to control clears them through handleRDeck as usual.)
  copyHeld = false;
  pasteHeld = false;
  pasteRevHeld = false;
  nowHeld = false;
  shiftHeld = false;
  // The arm strip is a clip-view-only concept — drop any pending arm (action or
  // the CC-91 KEYS-arm) on a flip.
  armedAction = null;
  keysArm = 'off';
  persistDeployment();
  bumpView();
  renderLeds(); // repaint the lone unit in its new role without waiting a tick
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
  armedAction = null;
  armTick = 0;
  keysArm = 'off';
  keysArmTick = 0;
  lastTapClipIndex = -1;
  lastTapTick = 0;
  lastTapPrevQueued = null;
  lastTapWasPlaying = false;
  resetKeysState();
  // NOTE: clipBuffer survives a re-bind (it's the machine's clipboard).
  unsubKey = onKey(handleKey);
  unsubTick = getSchedulerClock().subscribe(renderLeds);
  renderLeds(); // paint immediately so binding lights the units without waiting a tick
}
function stopLoops(): void {
  if (unsubKey) { unsubKey(); unsubKey = null; }
  if (unsubTick) { unsubTick(); unsubTick = null; }
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
  boundNodeId = null;
  try {
    localStorage.removeItem(STORAGE_KEY_NODE);
  } catch {
    /* noop */
  }
  stopLoops();
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
  activeView = 'clip';
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
// control layer routes/paints the lone device per `activeView`.
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
  activeView = 'clip'; // a fresh single-bind always starts in the clip view
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
  // Restore the persisted view so a reload resumes the view the user left.
  try {
    activeView = localStorage.getItem(STORAGE_KEY_VIEW) === 'control' ? 'control' : 'clip';
  } catch {
    activeView = 'clip';
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
    const v = localStorage.getItem(STORAGE_KEY_VIEW);
    activeView = v === 'control' ? 'control' : 'clip';
  } catch {
    deployment = 'pair';
    activeView = 'clip';
  }
}

// --- graph helpers (in-place Y discipline; identical to monome-control) ---
function liveData(nodeId: string): ClipPlayerData | undefined {
  return livePatch.nodes[nodeId]?.data as ClipPlayerData | undefined;
}
function editData(nodeId: string, mut: (d: ClipPlayerData) => void): void {
  const node = livePatch.nodes[nodeId];
  if (!node) return;
  ydoc.transact(() => {
    if (!node.data) node.data = {};
    mut(node.data as ClipPlayerData);
  });
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
function writeClip(nodeId: string, next: NoteClipRecord, index: number = editClipIndex): void {
  editData(nodeId, (d) => {
    if (!d.clips) d.clips = {};
    d.clips[String(index)] = { ...next, steps: next.steps.map((s) => ({ ...s })) };
  });
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
/** KEYS PANIC (P7): kill every sounding auditioned note (release-all) without
 *  leaving KEYS or touching the recorded clip — an emergency "all notes off". */
function keysPanic(nodeId: string): void {
  const lane = laneOf(keysClipIndex);
  for (const midi of keysPressed) pushAudition(nodeId, { lane, midi, velocity: 0, on: false });
  keysPressed.clear();
  keysOnsets.clear();
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
  if (!data?.clips?.[String(clipIdx)]) {
    editData(nodeId, (d) => {
      if (!d.clips) d.clips = {};
      if (!d.clips[String(clipIdx)]) d.clips[String(clipIdx)] = defaultNoteClip();
    });
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
  // Idle → session. Blank the KEYS state; the matrix + deck repaint next tick.
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

/**
 * SINGLE-UNIT routing. The lone device is bound to the L slot, so every event
 * arrives tagged unit:'L'; we route it by the ACTIVE VIEW, not the unit tag:
 *   · CC 98 (the spare top-right button) flips clip↔control — it's free in pair
 *     mode (pair never reaches this path). On a single device CC 98 is the
 *     DEDICATED view-flip, so it takes over the slot the pair editor used for
 *     FOLLOW. The single editor's FOLLOW instead lives on the scene column
 *     (EDIT_FOLLOW_SCENE_ROW — row 4, right under EXIT/DBL/LEN), so freeze +
 *     re-follow stay fully reachable on one device.
 *   · KEYS mode owns the WHOLE device (there is no view concept inside it):
 *     every event routes to the keys handler as the L half, and CC 98 is
 *     swallowed until EXIT (the lit EXIT pad is the way out). The LENGTH page
 *     opened from KEYS likewise owns the device until its EXIT returns to KEYS.
 *   · clip view    → handleL (the clip matrix + scene column).
 *   · control view → handleR (the deck / editor / length — the SAME R brain).
 */
function handleSingleKey(nodeId: string, e: LaunchpadKeyEvent): void {
  // KEYS (and the LENGTH page opened from KEYS) suspend the view machinery on
  // the lone device — the mode owns the surface until EXIT.
  if (mode === 'keys') {
    if (e.ev.type === 'top' && e.ev.cc === CC_TOP_SPARE_8) return; // no view flip inside KEYS
    handleKeysUnit(nodeId, 'L', e);
    return;
  }
  if (mode === 'lengthEdit' && lengthReturnMode === 'keys') {
    if (e.ev.type === 'top' && e.ev.cc === CC_TOP_SPARE_8) return;
    handleR(nodeId, e); // the ruler; EXIT returns to KEYS
    return;
  }
  if (e.ev.type === 'top' && e.ev.cc === CC_TOP_SPARE_8) {
    if (e.ev.s === 1) toggleSingleView(); // flip on press only (release is a no-op)
    return;
  }
  // Deck-HOLD releases landing in CLIP view: the flip-spanning holds (EDIT /
  // note-REC / note-OVERDUB, set in control view) are held on the SAME physical
  // pads whichever view is active — so when their release arrives in clip view
  // (where handleL ignores releases), clear the matching hold here. Without
  // this a release-without-consume leaves a STUCK modifier (a stuck keys-hold
  // suppresses every launch = a modal trap). A release after the gesture
  // already consumed the hold falls through harmlessly.
  if (activeView === 'clip' && e.ev.type === 'pad' && e.ev.s === 0) {
    const keysHold = rDeckKeysHold(e.ev.x, e.ev.y);
    if (keysHold === 'keysRec' && keysRecHeld) { keysRecHeld = false; return; }
    if (keysHold === 'keysOverdub' && keysOverdubHeld) { keysOverdubHeld = false; return; }
    if (rDeckPad(e.ev.x, e.ev.y) === 'edit' && editArmed) { editArmed = false; return; }
  }
  // Clip-view ARM ROW: top CCs 91..97 are the single-mode action-arm strip (the
  // clip view's top row is otherwise dead — handleL has no `top` branch). Route
  // them to armClip and DON'T fall through to handleL.
  if (activeView === 'clip' && e.ev.type === 'top' && clipArmAction(e.ev.cc) !== null) {
    armClip(e.ev.cc, e.ev.s);
    return;
  }
  if (activeView === 'clip') handleL(nodeId, e);
  else handleR(nodeId, e);
}

/** SINGLE-mode clip-view arm-strip handler (press-only). Maps a top CC →
 *  ClipArmAction, gates PASTE/PASTE-REV on a loaded buffer, toggles NOW sticky,
 *  and arms (or disarms / clears-buffer on a re-tap) the rest. Sets the matching
 *  modifier boolean substrate + `armedAction` and snapshots `armTick` for the
 *  auto-disarm. */
function armClip(cc: number, s: 0 | 1): void {
  if (s !== 1) return; // press-only
  const action = clipArmAction(cc);
  if (action === null) return;

  // NOW is a STICKY TOGGLE — it does not arm; it flips the launch-immediate flag
  // that ordinary clip/scene taps already pass into queueLane. (Composes with
  // launching, matching the pair NOW intent.)
  if (action === 'now') {
    nowHeld = !nowHeld;
    renderLeds();
    return;
  }

  // KEYS (CC 91, the reclaimed NEW cell) is a STICKY TRI-STATE — off → armed-REC
  // (overdub OFF) → armed-OD (overdub ON) → off. It does not go through the arm-
  // then-tap substrate; a clip-pad tap while armed enters KEYS (handleL). Arming
  // KEYS clears any pending action-arm (they're mutually exclusive on the strip).
  if (action === 'keys') {
    keysArm = keysArm === 'off' ? 'rec' : keysArm === 'rec' ? 'od' : 'off';
    if (keysArm !== 'off') {
      armedAction = null;
      copyHeld = false;
      pasteHeld = false;
      pasteRevHeld = false;
      keysArmTick = tickCount;
    }
    renderLeds();
    return;
  }

  // Re-tapping the armed cell DISARMS it (COPY: clears the buffer if loaded).
  if (armedAction === action) {
    if (action === 'copy' && clipBuffer !== null) clearBuffer();
    disarmClip();
    return;
  }

  // PASTE / PASTE-REV only arm when there's something to paste; otherwise a
  // single red blink (no arm) — the strip already shows them dim.
  if ((action === 'paste' || action === 'pasteRev') && clipBuffer === null) {
    disarmClip(); // ensure nothing stays armed; LED stays dim (no-op cue)
    return;
  }

  // Arm. Reuse the existing modifier booleans as the substrate where they map.
  // Arming an action cancels a pending KEYS-arm (mutually exclusive on the strip).
  keysArm = 'off';
  copyHeld = action === 'copy';
  pasteHeld = action === 'paste';
  pasteRevHeld = action === 'pasteRev';
  armedAction = action;
  armTick = tickCount;
  renderLeds();
}

/** Clear any armed state (back to plain launching). Leaves NOW (sticky) alone. */
function disarmClip(): void {
  armedAction = null;
  copyHeld = false;
  pasteHeld = false;
  pasteRevHeld = false;
  renderLeds();
}

/** Apply the armed action to a clip pad tap (single mode). Validates the target
 *  per action; an illegal target is a no-op that simply disarms (the LED loop
 *  shows the matrix returning to normal). Runs the SAME helper bodies the pair
 *  modifier branches use, so behaviour stays consistent across deployments. */
function consumeArmed(nodeId: string, clipIdx: number, data: ClipPlayerData | undefined): void {
  // An armed tap is NOT a launch — clear the double-tap tracker so a stale
  // pending launch-tap can't later pair with a plain tap of the same clip.
  lastTapClipIndex = -1;
  const action = armedAction;
  switch (action) {
    // NOTE: NEW's create-a-clip role was reclaimed for KEYS (CC 91) — a fresh
    // clip + editor is now made by DOUBLE-TAPPING an empty pad (openEditor). So
    // consumeArmed only ever sees the arm-then-tap actions below ('keys'/'now'
    // never reach here — they're handled sticky in armClip/handleL).
    case 'copy': {
      const c = clipAtIndex(data, clipIdx);
      if (c) {
        clipBuffer = copyClip(c);
        bufferSourceIndex = clipIdx;
      }
      break; // empty pad = no-op
    }
    case 'paste': {
      if (clipBuffer) writeClip(nodeId, copyClip(clipBuffer), clipIdx);
      break;
    }
    case 'pasteRev': {
      if (clipBuffer) writeClip(nodeId, reverseClipSteps(copyClip(clipBuffer)), clipIdx);
      break;
    }
    case 'length': {
      // Only onto a LOADED clip; open the length page (control view shows it).
      if (clipAtIndex(data, clipIdx)) {
        editClipIndex = clipIdx;
        mode = 'lengthEdit';
        disarmClip();
        setSingleView('control');
        return;
      }
      break; // empty = no-op
    }
    case 'double': {
      const clip = clipAtIndex(data, clipIdx);
      if (clip) {
        editClipIndex = clipIdx;
        const next = doubleNoteClip(clip);
        if (next !== clip) writeClip(nodeId, next, clipIdx);
      }
      break; // empty / at-max = no-op
    }
    default:
      break;
  }
  disarmClip();
}

/** Open the note editor on a clip index, creating a default clip if the pad is
 *  empty. The SAME body as handleL's editArmed branch (pair hold-EDIT) + the
 *  consumeArmed NEW branch — the canonical "enter the editor" reset. Flips the
 *  single device to control view so the editor is shown. */
function openEditor(nodeId: string, clipIdx: number, data: ClipPlayerData | undefined): void {
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
  setSingleView('control'); // show the editor on the lone device
}

/** Unit L is ALWAYS the live clip matrix + scene column. */
function handleL(nodeId: string, e: LaunchpadKeyEvent): void {
  const ev = e.ev;
  const data = liveData(nodeId);

  if (ev.type === 'pad') {
    const clipIdx = lPadToClipIndex(ev.x, ev.y);
    if (clipIdx === null) return;
    if (ev.s !== 1) return; // clip launch acts on press
    // SINGLE-mode CC-91 KEYS-ARM: while armed, a clip-pad tap ENTERS KEYS for it
    // (overdub per the tri-state) — one hand, no view flip. This runs BEFORE the
    // launch path (same suppression contract as the action-arm), BEFORE the
    // action-arm consume, and BEFORE the double-tap tracker, so the first tap
    // enters KEYS and the double-tap editor never engages. Pair never arms it.
    if (deployment === 'single' && keysArm !== 'off') {
      const overdub = keysArm === 'od';
      keysArm = 'off';
      lastTapClipIndex = -1;
      enterKeys(nodeId, clipIdx, overdub, data);
      return;
    }
    // SINGLE-mode arm strip: an armed action consumes the next clip-pad tap
    // (two-handed deck op). Pair mode never sets armedAction, so this is a dead
    // branch in pair → the existing modifier branches below stay byte-for-byte.
    if (deployment === 'single' && armedAction) {
      consumeArmed(nodeId, clipIdx, data);
      return;
    }
    // KEYS ENTRY (pair + single): holding note-REC or note-OVERDUB on the R deck
    // SUPPRESSES the launch on L taps (mirror editArmed) and a DOUBLE-TAP of a
    // clip opens the KEYS view for it — hold-REC = overdub OFF, hold-OVERDUB =
    // overdub ON. The double-tap (two taps of the same clip within the window) is
    // the safety layer against accidental entry into a destructive mode. In
    // SINGLE mode the hold is set in the CONTROL view's deck and SURVIVES the
    // CC-98 flip to clip view (like editArmed — the one-device gesture family).
    if (keysRecHeld || keysOverdubHeld) {
      if (clipIdx === lastTapClipIndex && tickCount - lastTapTick <= DOUBLE_TAP_TICKS) {
        lastTapClipIndex = -1;
        enterKeys(nodeId, clipIdx, keysOverdubHeld, data);
        return;
      }
      lastTapClipIndex = clipIdx;
      lastTapTick = tickCount;
      // Snapshot the lane's prior intent even for this SUPPRESSED tap: if the
      // hold is released between the taps, the next quick tap of the same clip
      // falls into the single double-tap-editor branch, whose revert reads these
      // — a stale snapshot would mis-revert the lane. The suppressed tap changed
      // nothing, so snapshotting NOW makes that revert a harmless no-op.
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
        clipBuffer = copyClip(c);
        bufferSourceIndex = clipIdx;
      }
      return;
    }
    if (pasteHeld && clipBuffer) {
      writeClip(nodeId, copyClip(clipBuffer), clipIdx);
      return;
    }
    if (pasteRevHeld && clipBuffer) {
      writeClip(nodeId, reverseClipSteps(copyClip(clipBuffer)), clipIdx);
      return;
    }
    // SINGLE + clip view: a DOUBLE-TAP of a clip pad opens its note editor (the
    // one-device analogue of the card's double-click → edit, since single mode
    // can't hold-EDIT on a second unit). The FIRST tap launches IMMEDIATELY below
    // (no debounce — owner: never slow a launch); a SECOND tap on the SAME clip
    // within DOUBLE_TAP_TICKS opens the editor AND REVERTS the lane to the state
    // it was in before the first tap (owner rule: a double-tap opens the editor
    // WITHOUT changing whether the clip plays). Pair mode never reaches this
    // (deployment !== 'single'), so the pair launch path is byte-for-byte
    // unchanged.
    if (deployment === 'single' && activeView === 'clip') {
      if (clipIdx === lastTapClipIndex && tickCount - lastTapTick <= DOUBLE_TAP_TICKS) {
        lastTapClipIndex = -1; // consume — don't let a 3rd tap re-trigger off this pair
        // Revert the lane to its PRIOR intent (snapshotted on the first tap):
        //   · prior STOPPED   → restoring queued un-queues the first tap's start.
        //     If a boundary passed and the clip ALREADY started, snap it back with
        //     an immediate stop (a ≤~275ms blip is the accepted rare edge).
        //   · prior QUEUED-to-start (not playing) → restoring leaves it QUEUED, so
        //     it STILL starts at the boundary (the owner's key requirement).
        //   · prior PLAYING   → restoring cancels the stop the first tap queued, so
        //     it keeps playing.
        const lane = laneOf(clipIdx);
        const slot = slotOf(clipIdx);
        restoreQueued(nodeId, lane, lastTapPrevQueued);
        if (!lastTapWasPlaying && lanePlaying(liveData(nodeId), lane) === slot) {
          // The first tap's queued start crossed a boundary between the two taps —
          // the clip is now actually playing though it was stopped before the
          // double-tap. Force it back to stopped immediately.
          queueLane(nodeId, lane, 'stop', /* immediate */ true);
        }
        openEditor(nodeId, clipIdx, data);
        return;
      }
      // First tap (or a stale/different one): SNAPSHOT the lane's prior intent
      // BEFORE applying the toggle (so a paired second tap can revert it), record
      // the tap, then fall through to the immediate launch below.
      const lane = laneOf(clipIdx);
      const slot = slotOf(clipIdx);
      lastTapPrevQueued = laneQueued(data, lane);
      lastTapWasPlaying = lanePlaying(data, lane) === slot;
      lastTapClipIndex = clipIdx;
      lastTapTick = tickCount;
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
    for (let lane = 0; lane < CLIP_LANES; lane++) {
      const has = data?.clips?.[String(clipIndex(slot, lane))];
      queueLane(nodeId, lane, has ? slot : 'stop', nowHeld);
    }
    return;
  }

  // PAIR unit-L TOP ROW (CC 91..98) = the 8 per-lane MUTE pads (col = lane) — the
  // previously-dead, always-visible matrix top row now hosts live-performance
  // MUTE. Single mode never routes top CCs to handleL (handleSingleKey's arm-row
  // + view-flip intercept them all), so this branch is reached only in pair.
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
  // 3,2,1,0 are the P6 extras (both modes): COPY snapshots the edited clip to
  // the machine clipboard, PASTE replaces it with the buffer, OCT ± jump the
  // pitch window up/down a whole octave.
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
    } else if (act === 'copy') {
      clipBuffer = copyClip(clip);
      bufferSourceIndex = editClipIndex;
    } else if (act === 'paste') {
      if (clipBuffer) writeClip(nodeId, copyClip(clipBuffer));
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
function handleRLength(nodeId: string, e: LaunchpadKeyEvent): void {
  const ev = e.ev;
  const clip = clipAtIndex(liveData(nodeId), editClipIndex);
  if (!clip) { mode = 'session'; return; }
  if (ev.type === 'scene') {
    if (ev.s !== 1) return;
    if (isEditExitSceneRow(ev.row)) { mode = lengthExitMode(); clampWindow(clip); }
    return;
  }
  if (ev.type !== 'pad' || ev.s !== 1) return;
  const act = rLengthPad(ev.x, ev.y);
  if (!act) return;
  if (act.kind === 'exit') { mode = lengthExitMode(); clampWindow(clip); return; }
  const nextLen =
    act.kind === 'block' ? lengthFromBlockTap(act.block) : lengthFromStepTap(clip.lengthSteps, act.step);
  editData(nodeId, (d) => {
    const c = d.clips?.[String(editClipIndex)] as NoteClipRecord | undefined;
    if (c) c.lengthSteps = nextLen;
  });
}

// ---------------------------------------------------------------------------
// LED render loop. PAIR: repaint BOTH units each tick (L = matrix, R = deck).
// SINGLE: repaint the LONE device (the L slot) in its active-view role.
// ---------------------------------------------------------------------------

/** Paint the L-role (clip matrix) frame onto a physical unit. In SINGLE clip view
 *  the top row is the action-arm strip (incl. the CC-91 KEYS-arm) + aiming wash
 *  (the `arm` opt). In PAIR (withArmStrip=false — the only other caller) the top
 *  row is instead the 8 per-lane MUTE pads (`lTopMute`); the matrix + scene render
 *  byte-for-byte as before. */
function paintLRole(
  target: LaunchpadUnit,
  data: ClipPlayerData | undefined,
  blinkOn: boolean,
  withArmStrip = false,
): void {
  setFrame(
    target,
    computeLSessionFrame(data, {
      blinkOn,
      recording: recordArmed(data),
      arm: withArmStrip
        ? { armedAction, bufferLoaded: clipBuffer !== null, nowOn: nowHeld, keysArm }
        : undefined,
      lTopMute: !withArmStrip, // pair-L top row = per-lane MUTE
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
        bufferLoaded: clipBuffer !== null, // lights the editor PASTE scene pad
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
    bufferArmed: clipBuffer !== null,
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

/** The CC-98 indicator colour for the active view on the single device (a calm
 *  cyan so the dedicated view-flip button reads distinct from the function row).
 *  Sourced from the shared map (`RGB_VIEW`) so the firmware + docs never drift. */
const VIEW_LED: readonly [number, number, number] = RGB_VIEW;

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
      // The lone device shows the view it's in: dim blue (clip) / dim amber
      // (control) + the CC-98 view marker.
      setFrame('L', activeView === 'clip' ? idleFrame(0, 0, 20) : idleFrame(14, 7, 0));
      setLed('L', CC_TOP_SPARE_8, VIEW_LED[0], VIEW_LED[1], VIEW_LED[2]);
    } else {
      setFrame('L', idleFrame(0, 0, 20)); // L (matrix) = dim blue
      setFrame('R', idleFrame(14, 7, 0)); // R (deck) = dim amber
    }
    return;
  }
  tickCount++;
  const blinkOn = Math.floor(tickCount / BLINK_TICKS) % 2 === 0;
  const data = node.data as ClipPlayerData | undefined;

  // Auto-disarm a stale clip-view arm after ~4s (single mode only; pair never
  // arms). Guards against an "armed then walked away" modal trap. The CC-91
  // KEYS-arm auto-disarms on the same timeout (set inline — the paint below reads
  // keysArm, so no recursive repaint is needed).
  if (single && armedAction && tickCount - armTick > ARM_TIMEOUT_TICKS) {
    disarmClip();
  }
  if (single && keysArm !== 'off' && tickCount - keysArmTick > ARM_TIMEOUT_TICKS) {
    keysArm = 'off';
  }

  if (single) {
    // KEYS owns the lone device (no view concept inside it): service the record
    // machine, paint the single (8-cell-playhead) keys frame, and skip the view
    // marker — CC 98 is swallowed in KEYS, so a lit marker would lie. The same
    // applies to the LENGTH page opened FROM keys (the ruler owns the device
    // until its EXIT returns to KEYS).
    if (mode === 'keys') {
      serviceKeysRecord(nodeId, data);
      if (paintKeysRole('L', nodeId, data, blinkOn)) return;
      mode = 'session'; // the KEYS clip vanished — fall through to the views
    }
    if (mode === 'lengthEdit' && lengthReturnMode === 'keys') {
      paintRRole('L', nodeId, data, blinkOn);
      return;
    }
    // ONE device, role chosen by the active view. The CC-98 view marker is set
    // AFTER the role frame in EITHER view (and after the R painter's early
    // returns in edit/length modes), so it always reflects the active view on
    // the lone device + survives the setFrame diff. (setLed is a per-LED write
    // that runs after setFrame, so it wins over whatever the frame painted at
    // CC 98 — e.g. the editor's FOLLOW colour.)
    if (activeView === 'clip') paintLRole('L', data, blinkOn, true);
    else paintRRole('L', nodeId, data, blinkOn);
    setLed('L', CC_TOP_SPARE_8, VIEW_LED[0], VIEW_LED[1], VIEW_LED[2]);
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
  activeView = 'clip';
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
  armedAction = null;
  armTick = 0;
  keysArm = 'off';
  keysArmTick = 0;
  lastTapClipIndex = -1;
  lastTapTick = 0;
  lastTapPrevQueued = null;
  lastTapWasPlaying = false;
  clipBuffer = null;
  bufferSourceIndex = null;
  resetKeysState();
}
export function __test_mode(): {
  deployment: 'pair' | 'single';
  activeView: 'clip' | 'control';
  mode: LaunchpadMode;
  editClipIndex: number;
  editArmed: boolean;
  copyHeld: boolean;
  pasteHeld: boolean;
  pasteRevHeld: boolean;
  nowHeld: boolean;
  shiftHeld: boolean;
  velHeld: boolean;
  editRowOffset: number;
  editWindowStart: number;
  followOn: boolean;
  bufferArmed: boolean;
  bufferSourceIndex: number | null;
  armedAction: ClipArmAction | null;
  keysArm: KeysArm;
  lengthReturnMode: 'edit' | 'keys';
  keysClipIndex: number;
  keysRecHeld: boolean;
  keysOverdubHeld: boolean;
  keysOctaveShift: number;
  keysPressedCount: number;
} {
  return {
    deployment,
    activeView,
    mode,
    editClipIndex,
    editArmed,
    copyHeld,
    pasteHeld,
    pasteRevHeld,
    nowHeld,
    shiftHeld,
    velHeld,
    editRowOffset,
    editWindowStart,
    followOn,
    bufferArmed: clipBuffer !== null,
    bufferSourceIndex,
    armedAction,
    keysArm,
    lengthReturnMode,
    keysClipIndex,
    keysRecHeld,
    keysOverdubHeld,
    keysOctaveShift,
    keysPressedCount: keysPressed.size,
  };
}

/** Test seam: force the deployment + view (so a unit test can drive single mode
 *  without the connect()/enumerate handshake). Does NOT touch the binding. */
export function __test_setDeployment(d: 'pair' | 'single', view: 'clip' | 'control' = 'clip'): void {
  deployment = d;
  activeView = view;
}
