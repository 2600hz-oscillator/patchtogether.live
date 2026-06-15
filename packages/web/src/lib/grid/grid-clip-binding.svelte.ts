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
//   - the full grid is the clip's note editor; press a cell to cycle its note
//     OFF→MED→LOW→HIGH→off (cycleNoteAt). The reserved EDIT pad exits.
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
  editPadToNote,
  computeSessionLeds,
  computeEditLeds,
} from './grid-clip-map';
import {
  CLIP_LANES,
  clipIndex,
  laneOf,
  slotOf,
  lanePlaying,
  coerceClipRecord,
  toggleNoteAt,
  setNoteSpan,
  cycleVelocity,
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
let mode: 'session' | 'edit' = 'session';
let editClipIndex = 0;
let editArmed = false; // EDIT pad held in session mode
// In EDIT mode: the currently-held note pad (anchor) + whether a held-span was
// created during this hold. A simple tap (press+release, no span) toggles the
// note; holding the anchor + tapping another pad in the same row ties them.
let editAnchor: { step: number; midi: number } | null = null;
let editSpanned = false;
let editOctave = 0; // pitch-window offset (OCT−/+ on the function row)
let velHeld = false; // the VELOCITY function pad is held

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
  editOctave = 0;
  velHeld = false;
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
/** Persist a new clip record at the editor's slot (cloning steps for Yjs). */
function writeClip(nodeId: string, next: NoteClipRecord): void {
  editData(nodeId, (d) => {
    if (!d.clips) d.clips = {};
    d.clips[String(editClipIndex)] = { ...next, steps: next.steps.map((s) => ({ ...s })) };
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
    if (e.s === 1 && isOctDownPad(e.x, e.y)) { editOctave -= 1; return; }
    if (e.s === 1 && isOctUpPad(e.x, e.y)) { editOctave += 1; return; }

    const note = editPadToNote(clip, e.x, e.y, editOctave);
    if (!note) return; // a non-control function-row / out-of-range pad
    if (e.s === 1) {
      if (velHeld) {
        // VELOCITY modifier: cycle this note's velocity (or place at MED).
        writeClip(nodeId, cycleVelocity(clip, note.step, note.midi));
      } else if (editAnchor && editAnchor.midi === note.midi && editAnchor.step !== note.step) {
        // hold a note + tap another in the SAME row → one held note spanning them
        writeClip(nodeId, setNoteSpan(clip, editAnchor.step, note.step, note.midi));
        editSpanned = true;
      } else {
        editAnchor = { step: note.step, midi: note.midi };
        editSpanned = false;
      }
    } else if (!velHeld && editAnchor && editAnchor.step === note.step && editAnchor.midi === note.midi) {
      // releasing the anchor with no span = a simple tap → toggle the note on/off
      if (!editSpanned) writeClip(nodeId, toggleNoteAt(clip, note.step, note.midi));
      editAnchor = null;
      editSpanned = false;
    }
    return;
  }

  if (e.s !== 1) return; // session controls act on press

  // --- SESSION mode ---
  const data = liveData(nodeId);

  const clipIdx = padToClipIndex(e.x, e.y);
  if (clipIdx !== null) {
    if (editArmed) {
      editClipIndex = clipIdx; // hold-EDIT + tap → open the editor
      mode = 'edit';
      editArmed = false;
      editAnchor = null;
      editSpanned = false;
      editOctave = 0;
      velHeld = false;
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
  const blinkOn = Math.floor(tickCount / BLINK_TICKS) % 2 === 0;
  const data = node.data as ClipPlayerData | undefined;
  if (mode === 'edit') {
    const clip = clipAtIndex(data, editClipIndex);
    if (clip) {
      // Show the playhead only when the edited clip's lane is actually playing it.
      const lane = laneOf(editClipIndex);
      const ph = lanePlaying(data, lane) === slotOf(editClipIndex) ? getLanePlayhead(nodeId, lane) : -1;
      setFrame(computeEditLeds(clip, ph, editOctave, velHeld));
      return;
    }
    mode = 'session'; // clip vanished — fall back
  }
  setFrame(
    computeSessionLeds(data, blinkOn, { transportRunning: transportRunning(), editArmed }),
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
  editOctave = 0;
  velHeld = false;
}
/** Read internal mode state — tests only. */
export function __test_mode(): {
  mode: 'session' | 'edit';
  editClipIndex: number;
  editArmed: boolean;
  editOctave: number;
  velHeld: boolean;
} {
  return { mode, editClipIndex, editArmed, editOctave, velHeld };
}
