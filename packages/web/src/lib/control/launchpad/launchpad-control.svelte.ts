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
} from './launchpad-map';
import {
  CLIP_LANES,
  clipIndex,
  laneOf,
  slotOf,
  lanePlaying,
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
  type ClipPlayerData,
  type NoteClipRecord,
} from '$lib/audio/modules/clip-types';
import { getLanePlayhead } from '$lib/audio/modules/clip-playhead';

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

// Mode state (R unit's view; L is always the matrix).
let mode: 'session' | 'edit' | 'lengthEdit' = 'session';
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
  // gesture; handleL consumes + clears editArmed itself.)
  copyHeld = false;
  pasteHeld = false;
  pasteRevHeld = false;
  nowHeld = false;
  shiftHeld = false;
  // The arm strip is a clip-view-only concept — drop any pending arm on a flip.
  armedAction = null;
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
  armedAction = null;
  armTick = 0;
  // NOTE: clipBuffer survives a re-bind (it's the machine's clipboard).
  unsubKey = onKey(handleKey);
  unsubTick = getSchedulerClock().subscribe(renderLeds);
  renderLeds(); // paint immediately so binding lights the units without waiting a tick
}
function stopLoops(): void {
  if (unsubKey) { unsubKey(); unsubKey = null; }
  if (unsubTick) { unsubTick(); unsubTick = null; }
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
  // PAIR mode (unchanged): L = the always-live matrix, R = deck/editor.
  if (e.unit === 'L') handleL(nodeId, e);
  else handleR(nodeId, e);
}

/**
 * SINGLE-UNIT routing. The lone device is bound to the L slot, so every event
 * arrives tagged unit:'L'; we route it by the ACTIVE VIEW, not the unit tag:
 *   · CC 98 (the spare top-right button) ALWAYS flips clip↔control — it's free
 *     in pair mode (pair never reaches this path). On a single device CC 98 is
 *     the DEDICATED view-flip, so it takes over the slot the pair editor used
 *     for FOLLOW. FOLLOW is therefore not on a button in single mode; it still
 *     defaults ON each time you enter the editor (and EXIT/re-enter re-enables
 *     it), which is the single-unit tradeoff for one device doing both roles.
 *   · clip view    → handleL (the clip matrix + scene column).
 *   · control view → handleR (the deck / editor / length — the SAME R brain).
 */
function handleSingleKey(nodeId: string, e: LaunchpadKeyEvent): void {
  if (e.ev.type === 'top' && e.ev.cc === CC_TOP_SPARE_8) {
    if (e.ev.s === 1) toggleSingleView(); // flip on press only (release is a no-op)
    return;
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
  const action = armedAction;
  switch (action) {
    case 'new': {
      // Only onto an EMPTY pad (don't clobber a loaded clip).
      if (!data?.clips?.[String(clipIdx)]) {
        editData(nodeId, (d) => {
          if (!d.clips) d.clips = {};
          if (!d.clips[String(clipIdx)]) d.clips[String(clipIdx)] = defaultNoteClip();
        });
        editClipIndex = clipIdx;
        mode = 'edit';
        editAnchor = null;
        editSpanned = false;
        editRowOffset = 0;
        editWindowStart = 0;
        followOn = true;
        velHeld = false;
        disarmClip();
        setSingleView('control'); // show the editor (also clears armedAction)
        return;
      }
      break; // loaded pad under NEW = no-op
    }
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

/** Unit L is ALWAYS the live clip matrix + scene column. */
function handleL(nodeId: string, e: LaunchpadKeyEvent): void {
  const ev = e.ev;
  const data = liveData(nodeId);

  if (ev.type === 'pad') {
    const clipIdx = lPadToClipIndex(ev.x, ev.y);
    if (clipIdx === null) return;
    if (ev.s !== 1) return; // clip launch acts on press
    // SINGLE-mode arm strip: an armed action consumes the next clip-pad tap
    // (two-handed deck op). Pair mode never sets armedAction, so this is a dead
    // branch in pair → the existing modifier branches below stay byte-for-byte.
    if (deployment === 'single' && armedAction) {
      consumeArmed(nodeId, clipIdx, data);
      return;
    }
    // Held-modifier branches FIRST (the modifiers live on R, read here).
    if (editArmed) {
      // hold-EDIT (on R) + tap a clip (on L) → enter the editor on R.
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
  }
}

function handleREdit(nodeId: string, e: LaunchpadKeyEvent): void {
  const ev = e.ev;
  const clip = clipAtIndex(liveData(nodeId), editClipIndex);
  if (!clip) { mode = 'session'; return; }

  // Scene column: top = EXIT · row 6 = DOUBLE · row 5 = LENGTH-EDIT.
  if (ev.type === 'scene') {
    if (ev.s !== 1) return;
    const act = editSceneAction(ev.row);
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
      if (followOn) {
        // freeze on the window currently shown (capture before clearing).
        editWindowStart = shownWindowStart(clip);
        followOn = false;
        clampWindow(clip);
      } else {
        followOn = true;
        clampWindow(clip);
      }
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

function handleRLength(nodeId: string, e: LaunchpadKeyEvent): void {
  const ev = e.ev;
  const clip = clipAtIndex(liveData(nodeId), editClipIndex);
  if (!clip) { mode = 'session'; return; }
  if (ev.type === 'scene') {
    if (ev.s !== 1) return;
    if (isEditExitSceneRow(ev.row)) { mode = 'edit'; clampWindow(clip); }
    return;
  }
  if (ev.type !== 'pad' || ev.s !== 1) return;
  const act = rLengthPad(ev.x, ev.y);
  if (!act) return;
  if (act.kind === 'exit') { mode = 'edit'; clampWindow(clip); return; }
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

/** Paint the L-role (clip matrix) frame onto a physical unit. In SINGLE clip
 *  view, also paint the action-arm strip + aiming wash (the `arm` opt). Pair mode
 *  passes no `arm`, so the top row + matrix render byte-for-byte as before. */
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
        ? { armedAction, bufferLoaded: clipBuffer !== null, nowOn: nowHeld }
        : undefined,
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
    data,
  }));
}

/** The CC-98 indicator colour for the active view on the single device (a calm
 *  cyan so the dedicated view-flip button reads distinct from the function row). */
const VIEW_LED: [number, number, number] = [10, 60, 60];

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
  // arms). Guards against an "armed then walked away" modal trap.
  if (single && armedAction && tickCount - armTick > ARM_TIMEOUT_TICKS) {
    disarmClip();
  }

  if (single) {
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
  armedAction = null;
  armTick = 0;
  clipBuffer = null;
  bufferSourceIndex = null;
}
export function __test_mode(): {
  deployment: 'pair' | 'single';
  activeView: 'clip' | 'control';
  mode: 'session' | 'edit' | 'lengthEdit';
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
  };
}

/** Test seam: force the deployment + view (so a unit test can drive single mode
 *  without the connect()/enumerate handshake). Does NOT touch the binding. */
export function __test_setDeployment(d: 'pair' | 'single', view: 'clip' | 'control' = 'clip'): void {
  deployment = d;
  activeView = view;
}
