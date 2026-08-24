// packages/web/src/lib/control/monome/kria-grid.svelte.ts
//
// Binds the monome grid (lib/control/monome/monome-device) to ONE focused KRIA node. This
// is KRIA's OWN binding (the clip-launcher has its own grid-clip-binding) —
// last-bound module owns the singleton grid (fine for v1, like ClipplayerCard).
//
//   - grid key-down → keyToAction() → apply to the KRIA node's data/params via
//     the same Y.Doc path the card uses (so collaborators + the card stay in
//     sync). TRACK / PARAM / PATTERN selection is LOCAL view state (the grid
//     holder's view), step/note/octave/duration edits + pattern cues are SYNCED.
//   - the grid LEDs are repainted each scheduler tick from the KRIA node's live
//     pattern + playhead (computeKriaLeds), with a ~2 Hz blink for the cue.
//
// The binding (which KRIA node the grid drives) is PER-MACHINE local
// (localStorage). The LED frame + the view (track/page) are local render state,
// never synced.

import { patch as livePatch } from '$lib/graph/store';
import { getSchedulerClock } from '$lib/audio/scheduler-clock';
import { onKey, setFrame, isConnected, type GridKeyEvent } from './monome-device.svelte';
import {
  keyToAction,
  computeKriaLeds,
  defaultView,
  KRIA_PATTERNS,
  type KriaGridView,
} from './kria-grid-map';
import {
  activePattern,
  slotOccupied,
  setNote as setNoteHelper,
  setOctave as setOctaveHelper,
  setDuration as setDurationHelper,
  toggleTrig as toggleTrigHelper,
  type KriaData,
} from '$lib/audio/modules/kria-types';
// ⚠ THE SHARED WRITE SEAM — the same one the card and the faceplate call.
// This file used to carry its OWN `mutateTrack` + `cloneTrack`, a near-copy of
// the card's, and both copies carried both defects: an untagged
// `ydoc.transact` (so a grid edit was outside Cmd-Z) and a whole-pattern
// reassignment (so a grid edit clobbered a collaborator's other track). Sharing
// the seam is what makes "the grid path and the face write the same keys" a
// property of the code instead of a thing to re-verify.
import { editKriaTrack, selectKriaPattern } from '$lib/audio/modules/kria-writes';

const STORAGE_KEY = 'pt.grid.boundKriaNode';
const BLINK_TICKS = 10; // ~2 Hz at the 25ms scheduler tick

let boundNodeId: string | null = null;
let unsubKey: (() => void) | null = null;
let unsubTick: (() => void) | null = null;
let tickCount = 0;
let view: KriaGridView = defaultView();

let bindingVersion = $state(0);
export function bindingRune(): number {
  return bindingVersion;
}
export function boundKriaNode(): string | null {
  return boundNodeId;
}
/** The grid holder's current view (track/page) — exposed so the card can mirror
 *  it. Local, never synced. */
export function gridView(): KriaGridView {
  return { ...view };
}

function start(): void {
  stopLoops();
  tickCount = 0;
  unsubKey = onKey(handleKey);
  unsubTick = getSchedulerClock().subscribe(renderLeds);
}
function stopLoops(): void {
  if (unsubKey) { unsubKey(); unsubKey = null; }
  if (unsubTick) { unsubTick(); unsubTick = null; }
}

export function bindGridToKria(nodeId: string): void {
  boundNodeId = nodeId;
  view = defaultView();
  try {
    localStorage.setItem(STORAGE_KEY, nodeId);
  } catch {
    /* private mode / no storage */
  }
  start();
  bindingVersion++;
}

export function unbindKriaGrid(): void {
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

export function restoreKriaGridBinding(): void {
  try {
    const id = localStorage.getItem(STORAGE_KEY);
    if (id) {
      boundNodeId = id;
      view = defaultView();
      start();
      bindingVersion++;
    }
  } catch {
    /* noop */
  }
}

function handleKey(e: GridKeyEvent): void {
  if (e.s !== 1) return; // act on press only
  const nodeId = boundNodeId;
  if (!nodeId) return;
  if (!livePatch.nodes[nodeId]) return;

  const action = keyToAction(e.x, e.y, view);
  switch (action.kind) {
    case 'selectTrack':
      view = { ...view, track: action.track };
      bindingVersion++;
      break;
    case 'selectPage':
      view = { ...view, page: action.page, patternPage: false };
      bindingVersion++;
      break;
    case 'togglePatternPage':
      view = { ...view, patternPage: !view.patternPage };
      bindingVersion++;
      break;
    case 'cuePattern':
      selectKriaPattern(nodeId, action.slot);
      break;
    case 'toggleTrig':
      editKriaTrack(nodeId, view.track, (t) => toggleTrigHelper(t, action.step));
      break;
    case 'setNote':
      editKriaTrack(nodeId, view.track, (t) => setNoteHelper(t, action.step, action.degree));
      break;
    case 'setOctave':
      editKriaTrack(nodeId, view.track, (t) => setOctaveHelper(t, action.step, action.octave));
      break;
    case 'setDuration':
      editKriaTrack(nodeId, view.track, (t) => setDurationHelper(t, action.step, action.duration));
      break;
    case 'none':
      break;
  }
}

function renderLeds(): void {
  const nodeId = boundNodeId;
  if (!nodeId || !isConnected()) return;
  const node = livePatch.nodes[nodeId];
  if (!node) return;
  tickCount++;
  const blinkOn = Math.floor(tickCount / BLINK_TICKS) % 2 === 0;
  const data = (node.data ?? {}) as KriaData;
  const pattern = activePattern(data);
  const occupied = Array.from({ length: KRIA_PATTERNS }, (_, i) => slotOccupied(data, i));
  // Playhead step for the selected track — read from the engine handle if the
  // card has wired it via node.data._step (kept simple: 0 fallback for tests).
  const playStep =
    Array.isArray((data as { _steps?: number[] })._steps)
      ? ((data as { _steps?: number[] })._steps?.[view.track] ?? -1)
      : -1;
  setFrame(
    computeKriaLeds({
      pattern,
      view,
      playStep,
      occupied,
      active: typeof data.active === 'number' ? data.active : 0,
      cued: data.cued ?? null,
      blinkOn,
    }),
  );
}

/** Test reset — clears ALL binding state. */
export function __test_resetKriaBinding(): void {
  stopLoops();
  boundNodeId = null;
  tickCount = 0;
  view = defaultView();
}
