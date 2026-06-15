// packages/web/src/lib/grid/grid-clip-binding.svelte.ts
//
// Phase 3 — binds the monome grid (lib/grid/grid-device) to ONE focused
// clip-player node, in Session/launch mode:
//   - grid key-down on a clip pad → launch it (or stop it if it's playing),
//     written to the clip-player's node.data.queued (the SAME synced field the
//     card writes), so the engine applies it on the next quantize boundary and
//     all peers see it.
//   - the STOP pad → queue-stop the playing clip.
//   - the grid's LEDs are repainted each scheduler tick from the clip-player's
//     live clip + playing/queued state (computeSessionLeds), with a ~2 Hz blink.
//
// The binding (which clip-player the grid drives) is PER-MACHINE local
// (localStorage) — the grid is the holder's hardware, like a MIDI-learn
// binding. The LED frame is local render state, never synced. (Plan §5.)

import { patch as livePatch, ydoc } from '$lib/graph/store';
import { getSchedulerClock } from '$lib/audio/scheduler-clock';
import { onKey, setFrame, isConnected, type GridKeyEvent } from './grid-device.svelte';
import { padToClipIndex, isStopPad, computeSessionLeds } from './grid-clip-map';
import type { ClipPlayerData } from '$lib/audio/modules/clip-types';

const STORAGE_KEY = 'pt.grid.boundClipNode';
// Blink toggles every BLINK_TICKS scheduler ticks (~25ms each) → ~2 Hz.
const BLINK_TICKS = 10;

let boundNodeId: string | null = null;
let unsubKey: (() => void) | null = null;
let unsubTick: (() => void) | null = null;
let tickCount = 0;

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

function writeQueued(nodeId: string, q: string | 'stop'): void {
  const node = livePatch.nodes[nodeId];
  if (!node) return;
  ydoc.transact(() => {
    if (!node.data) node.data = {};
    (node.data as ClipPlayerData).queued = q;
  });
}

function handleKey(e: GridKeyEvent): void {
  if (e.s !== 1) return; // act on press, not release
  const nodeId = boundNodeId;
  if (!nodeId) return;
  const node = livePatch.nodes[nodeId];
  if (!node) return;
  const data = node.data as ClipPlayerData | undefined;

  if (isStopPad(e.x, e.y)) {
    if ((data?.playing ?? null) !== null) writeQueued(nodeId, 'stop');
    return;
  }
  const clipIdx = padToClipIndex(e.x, e.y);
  if (clipIdx === null) return; // an unused control pad
  const key = String(clipIdx);
  if ((data?.playing ?? null) === key) {
    writeQueued(nodeId, 'stop'); // press the playing clip → stop
  } else if (data?.clips?.[key]) {
    writeQueued(nodeId, key); // press a loaded clip → launch (quantized in the engine)
  }
  // Empty pad: no-op on the grid (clips are created from the card in v1).
}

function renderLeds(): void {
  const nodeId = boundNodeId;
  if (!nodeId || !isConnected()) return;
  const node = livePatch.nodes[nodeId];
  if (!node) return;
  tickCount++;
  const blinkOn = Math.floor(tickCount / BLINK_TICKS) % 2 === 0;
  setFrame(computeSessionLeds(node.data as ClipPlayerData | undefined, blinkOn));
}

/** Reset ALL binding state — test isolation. */
export function __test_resetBinding(): void {
  stopLoops();
  boundNodeId = null;
  tickCount = 0;
}
