// packages/web/src/lib/grid/grid-clip-binding.svelte.ts
//
// Binds the monome grid (grid-device) to ONE focused 8-lane clip-player node.
//
// SESSION mode (default):
//   - clip pad → launch that clip in its lane (or stop the lane if it's the one
//     playing), written to node.data.queued[lane] (the SAME synced per-lane
//     field the card writes), so the engine applies it on the next quantize
//     boundary and all peers see it.
//   - per-lane STOP column → queue-stop that lane.
//   - SCENE column → fire slot Y across ALL lanes at once (Ableton scene).
//   - STOP ALL / TRANSPORT (toggles TIMELORDE.running).
//   - HOLD the EDIT pad + tap a clip → enter EDIT mode for that clip.
//
// EDIT mode:
//   - the full grid is the clip's note editor; tap a cell to toggle a note
//     on/off, hold VEL + tap to cycle its velocity level, hold a note + tap
//     another in the row to tie a held span. ROW±/OCT± scroll the pitch window;
//     SCALE cycles the clip scale. The reserved EDIT pad exits.
//
// LEDs are repainted each scheduler tick from the live clip/playing/queued
// state (computeSessionLeds / computeEditLeds) with a ~2 Hz blink. The binding
// (which clip-player the grid drives) is PER-MACHINE local (localStorage) — the
// grid is the holder's hardware, like a MIDI-learn binding. LED frames are
// local render state, never synced.

import { patch as livePatch, ydoc } from '$lib/graph/store';
import { getSchedulerClock } from '$lib/audio/scheduler-clock';
import { onKey, setFrame, isConnected, type GridKeyEvent } from './grid-device.svelte';
import {
  padToClipIndex,
  stopLaneForPad,
  sceneSlotForPad,
  isEditPad,
  isStopAllPad,
  isTransportPad,
  isEditExitPad,
  isVelPad,
  isOctDownPad,
  isOctUpPad,
  isRowDownPad,
  isRowUpPad,
  isScalePad,
  isFollowPad,
  isPageLeftPad,
  isPageRightPad,
  isDoublePad,
  isLengthEditPad,
  isCopyPad,
  isPastePad,
  isPasteRevPad,
  editPadToNote,
  editPageCount,
  lengthEditPad,
  computeSessionLeds,
  computeEditLeds,
  computeLengthEditLeds,
} from './grid-clip-map';
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
  STEPS_PER_PAGE,
  type ClipPlayerData,
  type NoteClipRecord,
} from '$lib/audio/modules/clip-types';
import { getLanePlayhead } from '$lib/audio/modules/clip-playhead';

const STORAGE_KEY = 'pt.grid.boundClipNode';
// Blink toggles every BLINK_TICKS scheduler ticks (~25ms each) → ~2 Hz.
const BLINK_TICKS = 10;

let boundNodeId: string | null = null;
let unsubKey: (() => void) | null = null;
let unsubTick: (() => void) | null = null;
let tickCount = 0;

// Mode state (local — the grid's own view of the bound clip-player).
let mode: 'session' | 'edit' | 'lengthEdit' = 'session';
let editClipIndex = 0;
let editArmed = false; // EDIT pad held in session mode
// In EDIT mode: the currently-held note pad (anchor) + whether a held-span was
// created during this hold. A simple tap (press+release, no span) toggles the
// note; holding the anchor + tapping another pad in the same row ties them.
let editAnchor: { step: number; midi: number } | null = null;
let editSpanned = false;
let editRowOffset = 0; // pitch-window offset (OCT−/+ on the function row)
let velHeld = false; // the VELOCITY function pad is held
// Multi-page editing: which 16-step page is shown when FROZEN, and whether the
// shown page auto-scrolls with the playhead (FOLLOW, default on).
let editPage = 0;
let followOn = true;
// Session COPY/PASTE held modifiers + the per-machine clip buffer (NOT synced).
let copyHeld = false;
let pasteHeld = false;
let pasteRevHeld = false;
let clipBuffer: NoteClipRecord | null = null;

/** Reactive version — bump on bind/unbind so card UI re-derives. */
let bindingVersion = $state(0);
export function bindingRune(): number {
  return bindingVersion;
}
/** The clip-player node the grid currently drives, or null. */
export function boundClipNode(): string | null {
  return boundNodeId;
}

function start(): void {
  stopLoops();
  tickCount = 0;
  mode = 'session';
  editArmed = false;
  editAnchor = null;
  editSpanned = false;
  editRowOffset = 0;
  velHeld = false;
  editPage = 0;
  followOn = true;
  copyHeld = false;
  pasteHeld = false;
  pasteRevHeld = false;
  // NOTE: clipBuffer survives a re-bind on purpose (it's the machine's clipboard).
  unsubKey = onKey(handleKey);
  unsubTick = getSchedulerClock().subscribe(renderLeds);
}
function stopLoops(): void {
  if (unsubKey) { unsubKey(); unsubKey = null; }
  if (unsubTick) { unsubTick(); unsubTick = null; }
}

/** Bind the grid to a clip-player node (persisted per-machine) + start I/O. */
export function bindGridToClip(nodeId: string): void {
  boundNodeId = nodeId;
  try {
    localStorage.setItem(STORAGE_KEY, nodeId);
  } catch {
    /* private mode / no storage — bind for this session only */
  }
  start();
  bindingVersion++;
}

/** Unbind + blank the grid. */
export function unbindGrid(): void {
  boundNodeId = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* noop */
  }
  stopLoops();
  if (isConnected()) setFrame(new Uint8Array(128));
  bindingVersion++;
}

/** Restore a persisted binding on load (call once after the grid connects). */
export function restoreGridBinding(): void {
  try {
    const id = localStorage.getItem(STORAGE_KEY);
    if (id) {
      boundNodeId = id;
      start();
      bindingVersion++;
    }
  } catch {
    /* noop */
  }
}

// --- graph helpers (in-place Y discipline) ---
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
function queueLane(nodeId: string, lane: number, action: number | 'stop' | null): void {
  editData(nodeId, (d) => {
    // SyncedStore Y.Arrays reject index assignment — rebuild a plain array and
    // assign the whole thing (the same discipline the factory uses).
    const base: (number | 'stop' | null)[] = new Array(CLIP_LANES).fill(null);
    if (Array.isArray(d.queued)) {
      for (let i = 0; i < d.queued.length && i < CLIP_LANES; i++) base[i] = d.queued[i];
    }
    base[lane] = action;
    d.queued = base;
  });
}
function clipAtIndex(data: ClipPlayerData | undefined, index: number): NoteClipRecord | null {
  const c = coerceClipRecord(data?.clips?.[String(index)]);
  return c && c.kind === 'note' ? c : null;
}
/** The live playhead step for the edited clip's lane, or -1 when it isn't the
 *  lane's currently-playing slot (= not playing this clip). */
function editPlayhead(nodeId: string, data: ClipPlayerData | undefined): number {
  const lane = laneOf(editClipIndex);
  return lanePlaying(data, lane) === slotOf(editClipIndex) ? getLanePlayhead(nodeId, lane) : -1;
}
/** The 16-step page the editor should SHOW for `clip`: the live playhead page
 *  while FOLLOWing (page 0 when not playing), else the frozen editPage. */
function shownEditPage(clip: NoteClipRecord): number {
  if (followOn) {
    const ph = boundNodeId ? editPlayhead(boundNodeId, liveData(boundNodeId)) : -1;
    return ph >= 0 ? Math.floor(ph / STEPS_PER_PAGE) : 0;
  }
  return Math.max(0, Math.min(editPageCount(clip) - 1, editPage));
}
/** Re-clamp editPage into range (e.g. after the length shrank while frozen). */
function clampEditPage(clip: NoteClipRecord): void {
  editPage = Math.max(0, Math.min(editPageCount(clip) - 1, editPage));
}
/** Persist a clip record at a clip index (default = the editor's slot), cloning
 *  every event object so we never reuse a ref / index-assign a live Y.Array —
 *  the whole map entry is rebuilt + assigned in ONE transaction (paste/edit). */
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

function handleKey(e: GridKeyEvent): void {
  const nodeId = boundNodeId;
  if (!nodeId || !livePatch.nodes[nodeId]) return;

  // SESSION EDIT pad (15,0) — hold to arm; a clip tap then enters the editor.
  if (mode === 'session' && isEditPad(e.x, e.y)) {
    editArmed = e.s === 1;
    return;
  }

  // --- LENGTH-EDIT page (2-row length editor) ---
  if (mode === 'lengthEdit') {
    if (e.s !== 1) return; // acts on press
    const clip = clipAtIndex(liveData(nodeId), editClipIndex);
    if (!clip) { mode = 'session'; return; }
    const act = lengthEditPad(e.x, e.y);
    if (!act) return; // an unused pad — TRUE no-op
    if (act.kind === 'exit') {
      mode = 'edit'; // plain tap → back to the clip editor
      clampEditPage(clip);
      return;
    }
    const nextLen =
      act.kind === 'block' ? lengthFromBlockTap(act.block) : lengthFromStepTap(clip.lengthSteps, act.step);
    // Non-destructive: ONLY lengthSteps changes (steps[] is never pruned).
    editData(nodeId, (d) => {
      const c = d.clips?.[String(editClipIndex)] as NoteClipRecord | undefined;
      if (c) c.lengthSteps = nextLen;
    });
    return;
  }

  // --- EDIT mode: rows 0..6 = note grid, bottom row = function controls ---
  if (mode === 'edit') {
    const clip = clipAtIndex(liveData(nodeId), editClipIndex);
    if (!clip) { if (e.s === 1) mode = 'session'; return; }

    // function row
    if (isEditExitPad(e.x, e.y)) {
      if (e.s === 1) { mode = 'session'; editAnchor = null; editSpanned = false; velHeld = false; }
      return;
    }
    if (isVelPad(e.x, e.y)) { velHeld = e.s === 1; return; } // hold-modifier
    // ROW± shift the pitch window by ONE scale-degree row; OCT± by a whole
    // octave (= scaleLen rows for the active scale).
    const scaleLen = scaleSteps(clip.scale).length;
    if (e.s === 1 && isRowDownPad(e.x, e.y)) { editRowOffset -= 1; return; }
    if (e.s === 1 && isRowUpPad(e.x, e.y)) { editRowOffset += 1; return; }
    if (e.s === 1 && isOctDownPad(e.x, e.y)) { editRowOffset -= scaleLen; return; }
    if (e.s === 1 && isOctUpPad(e.x, e.y)) { editRowOffset += scaleLen; return; }
    if (e.s === 1 && isScalePad(e.x, e.y)) {
      // Cycle the clip's scale (major→minor→pentatonic→chromatic→…). The note
      // DATA is unchanged — only the row math; chromatic spreads notes apart.
      editData(nodeId, (d) => {
        const c = d.clips?.[String(editClipIndex)] as NoteClipRecord | undefined;
        if (!c) return;
        const ns = nextScale(c.scale);
        if (ns) c.scale = ns;
        else delete c.scale; // chromatic = no scale set
      });
      return;
    }
    // FOLLOW — tap-toggle (act on key-DOWN only, like a toggle, NOT press-hold).
    if (e.s === 1 && isFollowPad(e.x, e.y)) {
      if (followOn) {
        // freeze on the page currently shown — capture the live page BEFORE
        // clearing followOn (shownEditPage reads followOn).
        editPage = shownEditPage(clip);
        followOn = false;
        clampEditPage(clip);
      } else {
        // resume → shownEditPage now snaps to the live playhead (0 if stopped).
        followOn = true;
        clampEditPage(clip);
      }
      return;
    }
    // LEFT / RIGHT — only act when FROZEN and the target page is in range; else a
    // TRUE no-op (no state change). No-op while following.
    if (e.s === 1 && isPageLeftPad(e.x, e.y)) {
      if (!followOn && editPage > 0) editPage -= 1;
      return;
    }
    if (e.s === 1 && isPageRightPad(e.x, e.y)) {
      if (!followOn && editPage < editPageCount(clip) - 1) editPage += 1;
      return;
    }
    // DOUBLE — duplicate the first half into a doubled length. At 128 it's a
    // no-op: doubleNoteClip returns the SAME ref → skip the write (no Y churn).
    if (e.s === 1 && isDoublePad(e.x, e.y)) {
      const next = doubleNoteClip(clip);
      if (next !== clip) writeClip(nodeId, next);
      return;
    }
    // LENGTH-EDIT — open the 2-row length page.
    if (e.s === 1 && isLengthEditPad(e.x, e.y)) {
      mode = 'lengthEdit';
      editAnchor = null;
      editSpanned = false;
      velHeld = false;
      return;
    }

    const page = shownEditPage(clip);
    const note = editPadToNote(clip, e.x, e.y, editRowOffset, page);
    if (!note) return; // a non-control function-row / out-of-range pad
    // Mono lanes replace-on-add; poly lanes cap at POLY_CHANNEL_PAIRS per column.
    const mono = laneMono(liveData(nodeId), laneOf(editClipIndex));
    if (e.s === 1) {
      if (velHeld) {
        // VELOCITY modifier: cycle this note's velocity (or place at default).
        writeClip(nodeId, cycleVelocity(clip, note.step, note.midi));
      } else if (editAnchor && editAnchor.midi === note.midi && editAnchor.step !== note.step) {
        // hold a note + tap another in the SAME row → one held note spanning them
        writeClip(nodeId, setNoteSpan(clip, editAnchor.step, note.step, note.midi, { mono }));
        editSpanned = true;
      } else {
        editAnchor = { step: note.step, midi: note.midi };
        editSpanned = false;
      }
    } else if (!velHeld && editAnchor && editAnchor.step === note.step && editAnchor.midi === note.midi) {
      // releasing the anchor with no span = a simple tap → toggle the note on/off
      if (!editSpanned) writeClip(nodeId, toggleNoteAt(clip, note.step, note.midi, { mono }));
      editAnchor = null;
      editSpanned = false;
    }
    return;
  }

  // SESSION held-modifiers (COPY / PASTE / PASTE-REV) act on BOTH edges (hold).
  if (mode === 'session') {
    if (isCopyPad(e.x, e.y)) { copyHeld = e.s === 1; return; }
    if (isPastePad(e.x, e.y)) { pasteHeld = e.s === 1; return; }
    if (isPasteRevPad(e.x, e.y)) { pasteRevHeld = e.s === 1; return; }
  }

  if (e.s !== 1) return; // session controls act on press

  // --- SESSION mode ---
  const data = liveData(nodeId);

  const clipIdx = padToClipIndex(e.x, e.y);
  if (clipIdx !== null) {
    // Held-modifier branches FIRST, in precedence order editArmed > copy > paste.
    // Only one is realistically held at a time; this fixes the order if not.
    if (editArmed) {
      // hold-EDIT + tap → open the editor. If the slot is EMPTY, create the clip
      // first so the gesture both initializes AND enters it (no card round-trip):
      // without this, entering edit on an empty slot finds no clip and bounces
      // back to session.
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
      velHeld = false;
      followOn = true;
      editPage = 0;
      return;
    }
    if (copyHeld) {
      const c = clipAtIndex(data, clipIdx);
      if (c) clipBuffer = copyClip(c); // → per-machine buffer (not the Y.Doc)
      return;
    }
    if (pasteHeld && clipBuffer) {
      // PASTE = overwrite OR create (plain assignment handles both). ONE undoable
      // transaction with CLONED events (writeClip's discipline).
      writeClip(nodeId, copyClip(clipBuffer), clipIdx);
      return;
    }
    if (pasteRevHeld && clipBuffer) {
      writeClip(nodeId, reverseClipSteps(copyClip(clipBuffer)), clipIdx);
      return;
    }
    const lane = laneOf(clipIdx);
    const slot = slotOf(clipIdx);
    if (lanePlaying(data, lane) === slot) queueLane(nodeId, lane, 'stop');
    else if (data?.clips?.[String(clipIdx)]) queueLane(nodeId, lane, slot);
    return;
  }

  const stopLane = stopLaneForPad(e.x, e.y);
  if (stopLane !== null) {
    if (lanePlaying(data, stopLane) !== null) queueLane(nodeId, stopLane, 'stop');
    return;
  }

  const sceneSlot = sceneSlotForPad(e.x, e.y);
  if (sceneSlot !== null) {
    for (let lane = 0; lane < CLIP_LANES; lane++) {
      const has = data?.clips?.[String(clipIndex(sceneSlot, lane))];
      queueLane(nodeId, lane, has ? sceneSlot : 'stop');
    }
    return;
  }

  if (isStopAllPad(e.x, e.y)) {
    editData(nodeId, (d) => { d.queued = new Array(CLIP_LANES).fill('stop'); });
    return;
  }
  if (isTransportPad(e.x, e.y)) {
    toggleTransport();
    return;
  }
}

function renderLeds(): void {
  const nodeId = boundNodeId;
  if (!nodeId || !isConnected()) return;
  const node = livePatch.nodes[nodeId];
  if (!node) return;
  tickCount++;
  const blinkPhase = Math.floor(tickCount / BLINK_TICKS);
  const blinkOn = blinkPhase % 2 === 0;
  const data = node.data as ClipPlayerData | undefined;
  if (mode === 'lengthEdit') {
    const clip = clipAtIndex(data, editClipIndex);
    if (clip) { setFrame(computeLengthEditLeds(clip)); return; }
    mode = 'session'; // clip vanished — fall back
  }
  if (mode === 'edit') {
    const clip = clipAtIndex(data, editClipIndex);
    if (clip) {
      // Show the playhead only when the edited clip's lane is actually playing it.
      const ph = editPlayhead(nodeId, data);
      setFrame(computeEditLeds(clip, ph, { rowOffset: editRowOffset, velArmed: velHeld, followOn, editPage }));
      return;
    }
    mode = 'session'; // clip vanished — fall back
  }
  setFrame(
    computeSessionLeds(data, blinkOn, {
      transportRunning: transportRunning(),
      editArmed,
      copyHeld,
      pasteHeld,
      pasteRevHeld,
      bufferArmed: clipBuffer !== null,
      blinkPhase,
    }),
  );
}

/** Reset ALL binding state — test isolation. */
export function __test_resetBinding(): void {
  stopLoops();
  boundNodeId = null;
  tickCount = 0;
  mode = 'session';
  editClipIndex = 0;
  editArmed = false;
  editAnchor = null;
  editSpanned = false;
  editRowOffset = 0;
  velHeld = false;
  editPage = 0;
  followOn = true;
  copyHeld = false;
  pasteHeld = false;
  pasteRevHeld = false;
  clipBuffer = null;
}
/** Read internal mode state — tests only. */
export function __test_mode(): {
  mode: 'session' | 'edit' | 'lengthEdit';
  editClipIndex: number;
  editArmed: boolean;
  editRowOffset: number;
  velHeld: boolean;
  editPage: number;
  followOn: boolean;
  copyHeld: boolean;
  pasteHeld: boolean;
  pasteRevHeld: boolean;
  bufferArmed: boolean;
} {
  return {
    mode,
    editClipIndex,
    editArmed,
    editRowOffset,
    velHeld,
    editPage,
    followOn,
    copyHeld,
    pasteHeld,
    pasteRevHeld,
    bufferArmed: clipBuffer !== null,
  };
}
