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

import { patch as livePatch, ydoc } from '$lib/graph/store';
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
  defaultPattern,
  slotOccupied,
  setNote as setNoteHelper,
  setOctave as setOctaveHelper,
  setDuration as setDurationHelper,
  toggleTrig as toggleTrigHelper,
  coerceTrack,
  type KriaData,
  type KriaPattern,
  type KriaPatternBank,
} from '$lib/audio/modules/kria-types';

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

/** Read + coerce the KRIA node's active pattern, ensuring the slot exists. */
function ensureActivePattern(nodeId: string): { data: KriaData; pattern: KriaPattern; active: number } | null {
  const node = livePatch.nodes[nodeId];
  if (!node) return null;
  const data = (node.data ?? {}) as KriaData;
  const active = typeof data.active === 'number' ? data.active : 0;
  const pat = activePattern(data) ?? defaultPattern();
  return { data, pattern: pat, active };
}

/** Mutate the active pattern's track t under the Y.Doc transaction discipline.
 *  The mutator returns a NEW track; we deep-clone into node.data (never reassign
 *  a live Y type at two paths). */
function mutateTrack(nodeId: string, trackIdx: number, fn: (t: ReturnType<typeof coerceTrack>) => ReturnType<typeof coerceTrack>): void {
  const ctx = ensureActivePattern(nodeId);
  if (!ctx) return;
  const next = fn(coerceTrack(ctx.pattern.tracks[trackIdx]));
  ydoc.transact(() => {
    const node = livePatch.nodes[nodeId];
    if (!node) return;
    if (!node.data) node.data = {};
    const d = node.data as KriaData;
    if (!d.patterns || typeof d.patterns !== 'object') d.patterns = {} as KriaPatternBank;
    // Clone the whole active pattern, replacing track trackIdx.
    const patClone: KriaPattern = {
      scale: ctx.pattern.scale,
      root: ctx.pattern.root,
      tracks: ctx.pattern.tracks.map((tr, i) =>
        i === trackIdx
          ? cloneTrack(next)
          : cloneTrack(coerceTrack(tr)),
      ),
    };
    // String-keyed record assignment — SyncedStore-safe (no array index set).
    d.patterns[String(ctx.active)] = patClone;
  });
}

function cloneTrack(t: ReturnType<typeof coerceTrack>): ReturnType<typeof coerceTrack> {
  return {
    trig: t.trig.slice(),
    ratchet: t.ratchet.slice(),
    note: t.note.slice(),
    octave: t.octave.slice(),
    duration: t.duration.slice(),
    probability: t.probability.slice(),
    glide: t.glide.slice(),
    loopStart: t.loopStart,
    loopLength: t.loopLength,
    timeDivision: t.timeDivision,
    direction: t.direction,
    muted: t.muted,
  };
}

function cuePattern(nodeId: string, slot: number): void {
  const node = livePatch.nodes[nodeId];
  if (!node) return;
  ydoc.transact(() => {
    if (!node.data) node.data = {};
    const d = node.data as KriaData;
    // If nothing is playing yet (no active set) just activate; else cue it.
    if (d.active === undefined || d.active === null) {
      d.active = slot;
      d.cued = null;
    } else if (d.active === slot) {
      d.cued = null; // re-tap active clears a pending cue
    } else {
      d.cued = slot;
    }
  });
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
      cuePattern(nodeId, action.slot);
      break;
    case 'toggleTrig':
      mutateTrack(nodeId, view.track, (t) => toggleTrigHelper(t, action.step));
      break;
    case 'setNote':
      mutateTrack(nodeId, view.track, (t) => setNoteHelper(t, action.step, action.degree));
      break;
    case 'setOctave':
      mutateTrack(nodeId, view.track, (t) => setOctaveHelper(t, action.step, action.octave));
      break;
    case 'setDuration':
      mutateTrack(nodeId, view.track, (t) => setDurationHelper(t, action.step, action.duration));
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
