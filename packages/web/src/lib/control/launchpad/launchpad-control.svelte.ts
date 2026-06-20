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
  // L matrix
  lPadToClipIndex,
  lSceneSlotForRow,
  computeLSessionFrame,
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

// Blink toggles every BLINK_TICKS scheduler ticks (~25ms each) → ~2 Hz.
const BLINK_TICKS = 10;
const SHIFT_JUMP = 8; // SHIFT magnifies a nav step by a full screen (8 pads).

let boundNodeId: string | null = null;
let unsubKey: (() => void) | null = null;
let unsubTick: (() => void) | null = null;
let tickCount = 0;

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
  if (e.unit === 'L') handleL(nodeId, e);
  else handleR(nodeId, e);
}

/** Unit L is ALWAYS the live clip matrix + scene column. */
function handleL(nodeId: string, e: LaunchpadKeyEvent): void {
  const ev = e.ev;
  const data = liveData(nodeId);

  if (ev.type === 'pad') {
    const clipIdx = lPadToClipIndex(ev.x, ev.y);
    if (clipIdx === null) return;
    if (ev.s !== 1) return; // clip launch acts on press
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
// LED render loop — repaint BOTH units each scheduler tick.
// ---------------------------------------------------------------------------
function renderLeds(): void {
  if (!isPairBound()) return; // need both units bound to paint anything
  const nodeId = boundNodeId;
  const node = nodeId ? livePatch.nodes[nodeId] : null;
  if (!nodeId || !node) {
    // Paired but no clip-player bound yet — paint a dim "ready" glow so the
    // units are visibly alive + connected (add a clip-player to go live).
    // L (matrix) = dim blue, R (deck) = dim amber.
    setFrame('L', idleFrame(0, 0, 20));
    setFrame('R', idleFrame(14, 7, 0));
    return;
  }
  tickCount++;
  const blinkOn = Math.floor(tickCount / BLINK_TICKS) % 2 === 0;
  const data = node.data as ClipPlayerData | undefined;

  // UNIT L — ALWAYS the matrix (never the editor).
  setFrame(
    'L',
    computeLSessionFrame(data, {
      blinkOn,
      recording: recordArmed(data),
    }),
  );

  // UNIT R — deck / editor / length-edit.
  if (mode === 'lengthEdit') {
    const clip = clipAtIndex(data, editClipIndex);
    if (clip) { setFrame('R', computeRLengthFrame(clip)); return; }
    mode = 'session';
  }
  if (mode === 'edit') {
    const clip = clipAtIndex(data, editClipIndex);
    if (clip) {
      // The editor frame keys the playhead on the ABSOLUTE step; pass the live
      // playhead (-1 when the edited clip isn't playing). The 8-step window
      // starts at the (frozen/followed) absolute step via colOffset (page 0).
      const absPlayhead = editPlayhead(nodeId, data);
      setFrame('R', computeREditFrame(clip, {
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
  setFrame('R', computeRDeckFrame({
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

// ---------------------------------------------------------------------------
// Test seams.
// ---------------------------------------------------------------------------
export function __test_resetBinding(): void {
  stopLoops();
  boundNodeId = null;
  tickCount = 0;
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
  clipBuffer = null;
  bufferSourceIndex = null;
}
export function __test_mode(): {
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
} {
  return {
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
  };
}
