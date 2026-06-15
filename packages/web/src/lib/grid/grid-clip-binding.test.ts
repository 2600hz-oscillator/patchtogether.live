// packages/web/src/lib/grid/grid-clip-binding.test.ts
//
// Integration test for the grid↔clip-player binding, driven through the REAL
// grid-device (simulated transport) + the REAL graph store. Mocks only the
// scheduler-clock so the LED render loop can be stepped manually.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ tick: null as null | (() => void) }));
vi.mock('$lib/audio/scheduler-clock', () => ({
  SCHEDULER_TICK_MS: 25,
  getSchedulerClock: () => ({
    subscribe: (fn: () => void) => {
      hoisted.tick = fn;
      return () => { hoisted.tick = null; };
    },
    usingWorker: false,
    dispose: () => {},
  }),
}));

import { patch as livePatch } from '$lib/graph/store';
import { installSimulatedGrid, __test_resetGrid, type SimulatedGrid } from './grid-device.svelte';
import {
  bindGridToClip,
  unbindGrid,
  boundClipNode,
  __test_resetBinding,
} from './grid-clip-binding.svelte';
import { STOP_PAD, clipIndexToPad, LED_LOADED, LED_PLAYING } from './grid-clip-map';

const NODE_ID = 'cp1';

function clearPatch() {
  for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
  for (const k of Object.keys(livePatch.edges)) delete livePatch.edges[k];
}
function noteClip() {
  return { kind: 'note', steps: [], lengthSteps: 16, root: 48, loop: true };
}
function seedClipPlayer(data: Record<string, unknown>) {
  clearPatch();
  livePatch.nodes[NODE_ID] = {
    id: NODE_ID, type: 'clipplayer', domain: 'audio', position: { x: 0, y: 0 }, params: {}, data,
  } as never;
}
function liveData() {
  return livePatch.nodes[NODE_ID]!.data as Record<string, unknown>;
}

let sim: SimulatedGrid;
beforeEach(async () => {
  hoisted.tick = null;
  __test_resetBinding();
  __test_resetGrid();
  clearPatch();
  sim = await installSimulatedGrid();
});

describe('grid → clip-player launch (Session mode)', () => {
  it('pressing a loaded clip pad queues that clip', () => {
    seedClipPlayer({ clips: { '0': noteClip(), '9': noteClip() } });
    bindGridToClip(NODE_ID);
    expect(boundClipNode()).toBe(NODE_ID);
    sim.press(0, 0); // clip 0
    expect(liveData().queued).toBe('0');
    // clip 9 is at (x=1,y=1)
    sim.press(1, 1);
    expect(liveData().queued).toBe('9');
  });

  it('pressing the currently-playing clip queues a stop', () => {
    seedClipPlayer({ clips: { '0': noteClip() }, playing: '0' });
    bindGridToClip(NODE_ID);
    sim.press(0, 0);
    expect(liveData().queued).toBe('stop');
  });

  it('the STOP pad queues a stop only while a clip plays', () => {
    seedClipPlayer({ clips: { '0': noteClip() }, playing: '0' });
    bindGridToClip(NODE_ID);
    sim.press(STOP_PAD.x, STOP_PAD.y);
    expect(liveData().queued).toBe('stop');
  });

  it('pressing an empty pad is a no-op (clips are created from the card)', () => {
    seedClipPlayer({ clips: { '0': noteClip() } });
    bindGridToClip(NODE_ID);
    sim.press(3, 0); // clip 3 — not loaded
    expect(liveData().queued).toBeUndefined();
  });

  it('key release does not trigger an action', () => {
    seedClipPlayer({ clips: { '0': noteClip() } });
    bindGridToClip(NODE_ID);
    sim.release(0, 0);
    expect(liveData().queued).toBeUndefined();
  });
});

describe('LED render loop', () => {
  it('repaints the grid from clip-player state on each tick', () => {
    seedClipPlayer({ clips: { '0': noteClip(), '9': noteClip() }, playing: '9' });
    bindGridToClip(NODE_ID);
    expect(hoisted.tick).toBeTruthy();
    hoisted.tick!(); // one render pass
    // clip 0 loaded → medium; clip 9 (x1,y1) playing → full bright.
    expect(sim.ledAt(0, 0)).toBe(LED_LOADED);
    const p = clipIndexToPad(9);
    expect(sim.ledAt(p.x, p.y)).toBe(LED_PLAYING);
  });
});

describe('unbind', () => {
  it('stops driving + blanks the grid', () => {
    seedClipPlayer({ clips: { '0': noteClip() } });
    bindGridToClip(NODE_ID);
    unbindGrid();
    expect(boundClipNode()).toBeNull();
    sim.press(0, 0); // no longer bound
    expect(liveData().queued).toBeUndefined();
  });
});
