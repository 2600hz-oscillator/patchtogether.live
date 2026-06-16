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
  __test_mode,
} from './grid-clip-binding.svelte';
import {
  clipIndexToPad,
  editRowToMidi,
  CTRL_STOP_COL,
  CTRL_SCENE_COL,
  EDIT_PAD,
  STOPALL_PAD,
  TRANSPORT_PAD,
  EDIT_EXIT_PAD,
  VEL_PAD,
  OCT_UP_PAD,
  ROW_UP_PAD,
  SCALE_PAD,
  LED_LOADED,
  LED_PLAYING,
} from './grid-clip-map';
import {
  clipIndex,
  defaultNoteClip,
  scaleSteps,
  velLevelIndex,
  VEL_DEFAULT,
  VEL_LEVELS,
  type NoteClipRecord,
} from '$lib/audio/modules/clip-types';

const NODE_ID = 'cp1';

function clearPatch() {
  for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
  for (const k of Object.keys(livePatch.edges)) delete livePatch.edges[k];
}
function noteClip(): NoteClipRecord {
  return defaultNoteClip();
}
function seedClipPlayer(data: Record<string, unknown>) {
  clearPatch();
  livePatch.nodes[NODE_ID] = {
    id: NODE_ID, type: 'clipplayer', domain: 'audio', position: { x: 0, y: 0 }, params: {}, data,
  } as never;
}
function seedTimelorde(running: number) {
  livePatch.nodes['tl'] = {
    id: 'tl', type: 'timelorde', domain: 'audio', position: { x: 0, y: 0 }, params: { running }, data: {},
  } as never;
}
function liveData() {
  return livePatch.nodes[NODE_ID]!.data as Record<string, unknown>;
}
function queued() {
  return liveData().queued as (number | 'stop' | null)[] | undefined;
}

let sim: SimulatedGrid;
beforeEach(async () => {
  hoisted.tick = null;
  __test_resetBinding();
  __test_resetGrid();
  clearPatch();
  sim = await installSimulatedGrid();
});

describe('grid → clip-player launch (Session, per-lane)', () => {
  it('pressing a loaded clip pad queues that clip in its lane', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip(), [clipIndex(1, 1)]: noteClip() } });
    bindGridToClip(NODE_ID);
    expect(boundClipNode()).toBe(NODE_ID);
    sim.press(0, 0); // lane0 slot0
    expect(queued()![0]).toBe(0);
    sim.press(1, 1); // lane1 slot1
    expect(queued()![1]).toBe(1);
  });

  it('pressing the currently-playing clip queues a stop for that lane', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() }, playing: [0, null, null, null, null, null, null, null] });
    bindGridToClip(NODE_ID);
    sim.press(0, 0);
    expect(queued()![0]).toBe('stop');
  });

  it('the per-lane STOP column stops only a playing lane', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() }, playing: [0, null, null, null, null, null, null, null] });
    bindGridToClip(NODE_ID);
    sim.press(CTRL_STOP_COL, 0); // lane0 playing → stop
    expect(queued()![0]).toBe('stop');
    sim.press(CTRL_STOP_COL, 1); // lane1 idle → no-op
    expect(queued()![1]).toBeNull();
  });

  it('the SCENE column launches a slot across all lanes (empty lanes stop)', () => {
    seedClipPlayer({ clips: { [clipIndex(2, 0)]: noteClip(), [clipIndex(2, 1)]: noteClip() } });
    bindGridToClip(NODE_ID);
    sim.press(CTRL_SCENE_COL, 2); // scene = slot 2
    expect(queued()![0]).toBe(2);
    expect(queued()![1]).toBe(2);
    expect(queued()![2]).toBe('stop'); // lane2 has no slot-2 clip
  });

  it('STOP ALL queues stop on every lane', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() }, playing: [0, 0, null, null, null, null, null, null] });
    bindGridToClip(NODE_ID);
    sim.press(STOPALL_PAD.x, STOPALL_PAD.y);
    expect(queued()).toEqual(['stop', 'stop', 'stop', 'stop', 'stop', 'stop', 'stop', 'stop']);
  });

  it('TRANSPORT pad toggles TIMELORDE.running', () => {
    seedClipPlayer({ clips: {} });
    seedTimelorde(0);
    bindGridToClip(NODE_ID);
    sim.press(TRANSPORT_PAD.x, TRANSPORT_PAD.y);
    expect((livePatch.nodes['tl']!.params as Record<string, number>).running).toBe(1);
  });

  it('empty clip pad is a no-op; key release never acts', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindGridToClip(NODE_ID);
    sim.press(3, 0); // lane0 slot3 — not loaded
    sim.release(0, 0);
    expect(queued()?.[0] ?? null).toBeNull();
    expect(queued()?.[3] ?? null).toBeNull();
  });
});

describe('grid EDIT mode (hold EDIT + tap → note editor)', () => {
  // enter EDIT mode on clip 0 (lane0/slot0 = pad 0,0).
  function enterEdit() {
    sim.press(EDIT_PAD.x, EDIT_PAD.y); // hold EDIT
    sim.press(0, 0); // tap clip 0 → enter edit (consumed, not launched)
    sim.release(EDIT_PAD.x, EDIT_PAD.y);
  }
  const tapEdit = (x: number, y: number) => {
    sim.press(x, y);
    sim.release(x, y);
  };
  const clipSteps = () => (liveData().clips as Record<string, NoteClipRecord>)['0'].steps;

  it('hold EDIT + tap a clip enters edit (no launch)', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindGridToClip(NODE_ID);
    sim.press(EDIT_PAD.x, EDIT_PAD.y);
    expect(__test_mode().editArmed).toBe(true);
    sim.press(0, 0);
    expect(__test_mode().mode).toBe('edit');
    expect(__test_mode().editClipIndex).toBe(0);
    expect(queued()?.[0] ?? null).toBeNull(); // did not launch
    sim.release(EDIT_PAD.x, EDIT_PAD.y);
  });

  it('hold EDIT + tap an EMPTY clip creates the clip AND enters its editor', () => {
    seedClipPlayer({ clips: {} }); // nothing initialized yet
    bindGridToClip(NODE_ID);
    sim.press(EDIT_PAD.x, EDIT_PAD.y); // hold EDIT
    sim.press(3, 2); // tap an uninitialized pad (lane2 slot3)
    sim.release(EDIT_PAD.x, EDIT_PAD.y);
    const idx = clipIndex(3, 2);
    // the clip was materialized in place …
    expect((liveData().clips as Record<string, NoteClipRecord>)[String(idx)]).toBeTruthy();
    // … and we are now editing it (no card round-trip, no launch).
    expect(__test_mode().mode).toBe('edit');
    expect(__test_mode().editClipIndex).toBe(idx);
    expect(queued()?.[2] ?? null).toBeNull();
  });

  it('a tap (press+release) toggles a note ON, tap again OFF', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindGridToClip(NODE_ID);
    enterEdit();
    tapEdit(3, 4);
    expect(clipSteps()).toHaveLength(1);
    expect(clipSteps()[0]).toMatchObject({ step: 3, midi: editRowToMidi(noteClip(), 4), lengthSteps: 1 });
    tapEdit(3, 4);
    expect(clipSteps()).toHaveLength(0);
  });

  it('hold a note + tap another in the same row → one held note spanning them', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindGridToClip(NODE_ID);
    enterEdit();
    sim.press(2, 4); // hold the anchor
    sim.press(5, 4); // tap another pad in the same row → tie
    sim.release(5, 4);
    sim.release(2, 4); // releasing the anchor after a span does NOT toggle
    expect(clipSteps()).toHaveLength(1);
    expect(clipSteps()[0]).toMatchObject({
      step: 2,
      midi: editRowToMidi(noteClip(), 4),
      lengthSteps: 4, // steps 2..5 held as one note
    });
  });

  it('hold VEL + tap a note cycles its velocity UP one level (does not remove it)', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindGridToClip(NODE_ID);
    enterEdit();
    tapEdit(3, 4); // place a note at the default level
    expect(clipSteps()[0].velocity).toBe(VEL_DEFAULT);
    sim.press(VEL_PAD.x, VEL_PAD.y); // hold VEL
    expect(__test_mode().velHeld).toBe(true);
    sim.press(3, 4); // tap the note → cycle velocity (no toggle)
    sim.release(3, 4);
    sim.release(VEL_PAD.x, VEL_PAD.y);
    expect(clipSteps()).toHaveLength(1); // still there
    expect(clipSteps()[0].velocity).toBe(VEL_LEVELS[velLevelIndex(VEL_DEFAULT) + 1]); // up one level
  });

  it('OCT+ shifts the pitch window a whole octave (scaleLen rows) so a note lands an octave up', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindGridToClip(NODE_ID);
    enterEdit();
    const scaleLen = scaleSteps(noteClip().scale).length; // major = 7 degrees
    sim.press(OCT_UP_PAD.x, OCT_UP_PAD.y); // shift window up one octave
    expect(__test_mode().editRowOffset).toBe(scaleLen);
    tapEdit(3, 4);
    // One octave up from the un-shifted note (= same row + 12 semitones).
    expect(clipSteps()[0].midi).toBe(editRowToMidi(noteClip(), 4) + 12);
    expect(clipSteps()[0].midi).toBe(editRowToMidi(noteClip(), 4, scaleLen));
  });

  it('ROW+ shifts the pitch window by a single scale-degree row', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindGridToClip(NODE_ID);
    enterEdit();
    sim.press(ROW_UP_PAD.x, ROW_UP_PAD.y); // shift window up one row
    expect(__test_mode().editRowOffset).toBe(1);
    tapEdit(3, 4);
    expect(clipSteps()[0].midi).toBe(editRowToMidi(noteClip(), 4, 1));
  });

  it('the SCALE pad cycles the clip scale (major → minor → …)', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindGridToClip(NODE_ID);
    enterEdit();
    // default clip is major
    expect((liveData().clips as Record<string, NoteClipRecord>)['0'].scale).toBe('major');
    sim.press(SCALE_PAD.x, SCALE_PAD.y);
    expect((liveData().clips as Record<string, NoteClipRecord>)['0'].scale).toBe('minor');
  });

  it('tapping the function-row EDIT pad exits to session', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindGridToClip(NODE_ID);
    enterEdit();
    expect(__test_mode().mode).toBe('edit');
    sim.press(EDIT_EXIT_PAD.x, EDIT_EXIT_PAD.y); // tap to exit
    expect(__test_mode().mode).toBe('session');
  });
});

describe('LED render loop', () => {
  it('repaints the grid from per-lane state on each tick', () => {
    seedClipPlayer({
      clips: { [clipIndex(0, 0)]: noteClip(), [clipIndex(1, 1)]: noteClip() },
      playing: [null, 1, null, null, null, null, null, null],
    });
    bindGridToClip(NODE_ID);
    expect(hoisted.tick).toBeTruthy();
    hoisted.tick!();
    expect(sim.ledAt(0, 0)).toBe(LED_LOADED); // lane0 slot0 loaded
    const p = clipIndexToPad(clipIndex(1, 1));
    expect(sim.ledAt(p.x, p.y)).toBe(LED_PLAYING); // lane1 slot1 playing
  });
});

describe('unbind', () => {
  it('stops driving + blanks the grid', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindGridToClip(NODE_ID);
    unbindGrid();
    expect(boundClipNode()).toBeNull();
    sim.press(0, 0);
    expect(queued()?.[0] ?? null).toBeNull();
  });
});
