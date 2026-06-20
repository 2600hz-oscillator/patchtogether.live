// packages/web/src/lib/control/launchpad/launchpad-control.test.ts
//
// Integration test for the Launchpad-pair ↔ clip-player binding, driven through
// the REAL launchpad-device (simulated transport) + the REAL graph store. Mocks
// only the scheduler-clock so the LED render loop can be stepped manually. The
// monome-control analogue, adapted to the L (matrix) / R (deck + editor) split.

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
import {
  installSimulatedLaunchpad,
  __test_resetLaunchpad,
  type SimulatedLaunchpad,
} from './launchpad-device.svelte';
import {
  bindLaunchpadToClip,
  unbindLaunchpad,
  boundClipNode,
  __test_resetBinding,
  __test_mode,
} from './launchpad-control.svelte';
import {
  DECK_EDIT_COL,
  DECK_COPY_COL,
  DECK_PASTE_COL,
  DECK_PASTE_REV_COL,
  DECK_NOW_COL,
  CC_TRANSPORT,
  CC_STOP_ALL,
  CC_SHIFT,
  CC_EDIT_ROW_UP,
  CC_EDIT_STEP_RIGHT,
  CC_EDIT_VEL,
  CC_EDIT_SCALE,
  EDIT_EXIT_SCENE_ROW,
  EDIT_DOUBLE_SCENE_ROW,
  EDIT_LENGTH_SCENE_ROW,
  editPadToNote,
} from './launchpad-map';
import { SCENE_CCS } from './launchpad-sysex';
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
function queuedImmediate() {
  return liveData().queuedImmediate as boolean[] | undefined;
}

let sim: SimulatedLaunchpad;
beforeEach(async () => {
  hoisted.tick = null;
  __test_resetBinding();
  __test_resetLaunchpad();
  clearPatch();
  sim = await installSimulatedLaunchpad();
});

// SCENE_CCS is top→bottom (index 0 = row 7). A scene-row Y press = the CC at
// index (7 - row). Helper to press a scene-column button by ROW.
const sceneCcForRow = (row: number) => SCENE_CCS[7 - row];

describe('Launchpad L (matrix) → clip-player launch', () => {
  it('pressing a loaded clip pad on L queues that clip in its lane', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip(), [clipIndex(1, 1)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    expect(boundClipNode()).toBe(NODE_ID);
    sim.press('L', 0, 0); // slot0 lane0
    expect(queued()![0]).toBe(0);
    sim.press('L', 1, 1); // slot1 lane1
    expect(queued()![1]).toBe(1);
  });

  it('pressing the currently-playing clip queues a stop for that lane', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() }, playing: [0, null, null, null, null, null, null, null] });
    bindLaunchpadToClip(NODE_ID);
    sim.press('L', 0, 0);
    expect(queued()![0]).toBe('stop');
  });

  it('the L scene column launches a slot across all lanes (empty lanes stop)', () => {
    seedClipPlayer({ clips: { [clipIndex(2, 0)]: noteClip(), [clipIndex(2, 1)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    sim.cc('L', sceneCcForRow(2), 127); // scene = slot 2 (row 2 → slot 2)
    expect(queued()![0]).toBe(2);
    expect(queued()![1]).toBe(2);
    expect(queued()![2]).toBe('stop'); // lane2 has no slot-2 clip
  });

  it('empty clip pad is a no-op; key release never launches', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    sim.press('L', 3, 0); // slot3 lane0 — not loaded
    sim.release('L', 0, 0);
    expect(queued()?.[0] ?? null).toBeNull();
    expect(queued()?.[3] ?? null).toBeNull();
  });
});

describe('Launchpad R (deck) — transport + per-lane stop + NOW', () => {
  it('R top-row CC 96 toggles TIMELORDE.running', () => {
    seedClipPlayer({ clips: {} });
    seedTimelorde(0);
    bindLaunchpadToClip(NODE_ID);
    sim.cc('R', CC_TRANSPORT, 127);
    expect((livePatch.nodes['tl']!.params as Record<string, number>).running).toBe(1);
  });

  it('R top-row CC 97 (STOP-ALL) queues stop on every lane', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() }, playing: [0, 0, null, null, null, null, null, null] });
    bindLaunchpadToClip(NODE_ID);
    sim.cc('R', CC_STOP_ALL, 127);
    expect(queued()).toEqual(['stop', 'stop', 'stop', 'stop', 'stop', 'stop', 'stop', 'stop']);
  });

  it('R scene column = per-lane STOP (only a playing lane)', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() }, playing: [0, null, null, null, null, null, null, null] });
    bindLaunchpadToClip(NODE_ID);
    sim.cc('R', sceneCcForRow(0), 127); // stop lane 0 (playing)
    expect(queued()![0]).toBe('stop');
    sim.cc('R', sceneCcForRow(1), 127); // lane1 idle → no-op
    expect(queued()![1]).toBeNull();
  });

  it('holding NOW on R makes an L launch fire immediately (queuedImmediate)', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    sim.press('R', DECK_NOW_COL, 0); // hold NOW
    expect(__test_mode().nowHeld).toBe(true);
    sim.press('L', 0, 0); // launch with NOW held
    expect(queued()![0]).toBe(0);
    expect(queuedImmediate()![0]).toBe(true);
    sim.release('R', DECK_NOW_COL, 0);
  });
});

describe('Launchpad EDIT — hold EDIT on R + tap a clip on L', () => {
  function enterEdit(slot = 0, lane = 0) {
    sim.press('R', DECK_EDIT_COL, 0); // hold EDIT (deck)
    sim.press('L', slot, lane); // tap clip on the matrix → enter editor
    sim.release('R', DECK_EDIT_COL, 0);
  }
  const clipSteps = (idx = 0) => (liveData().clips as Record<string, NoteClipRecord>)[String(idx)].steps;

  it('hold EDIT (R) + tap a clip (L) enters edit; the matrix tap does NOT launch', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    sim.press('R', DECK_EDIT_COL, 0);
    expect(__test_mode().editArmed).toBe(true);
    sim.press('L', 0, 0);
    expect(__test_mode().mode).toBe('edit');
    expect(__test_mode().editClipIndex).toBe(0);
    expect(queued()?.[0] ?? null).toBeNull(); // did not launch
    sim.release('R', DECK_EDIT_COL, 0);
  });

  it('hold EDIT + tap an EMPTY clip creates it AND enters its editor', () => {
    seedClipPlayer({ clips: {} });
    bindLaunchpadToClip(NODE_ID);
    enterEdit(3, 2); // empty pad lane2 slot3
    const idx = clipIndex(3, 2);
    expect((liveData().clips as Record<string, NoteClipRecord>)[String(idx)]).toBeTruthy();
    expect(__test_mode().mode).toBe('edit');
    expect(__test_mode().editClipIndex).toBe(idx);
  });

  it('a tap on the R note grid toggles a note ON, then OFF', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    enterEdit();
    // tap pad (step 3, pitch row 4) on R.
    const expected = editPadToNote(noteClip(), 3, 4)!;
    sim.press('R', 3, 4); sim.release('R', 3, 4);
    expect(clipSteps()).toHaveLength(1);
    expect(clipSteps()[0]).toMatchObject({ step: expected.step, midi: expected.midi, lengthSteps: 1 });
    sim.press('R', 3, 4); sim.release('R', 3, 4);
    expect(clipSteps()).toHaveLength(0);
  });

  it('hold a note + tap another in the same row → a held span', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    enterEdit();
    sim.press('R', 2, 4); // anchor
    sim.press('R', 5, 4); // tie
    sim.release('R', 5, 4);
    sim.release('R', 2, 4);
    expect(clipSteps()).toHaveLength(1);
    expect(clipSteps()[0]).toMatchObject({ step: 2, lengthSteps: 4 });
  });

  it('hold VEL (CC 96) + tap a note cycles its velocity', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    enterEdit();
    sim.press('R', 3, 4); sim.release('R', 3, 4); // place at default
    expect(clipSteps()[0].velocity).toBe(VEL_DEFAULT);
    sim.cc('R', CC_EDIT_VEL, 127); // hold VEL
    expect(__test_mode().velHeld).toBe(true);
    sim.press('R', 3, 4); sim.release('R', 3, 4); // cycle (no toggle)
    sim.cc('R', CC_EDIT_VEL, 0);
    expect(clipSteps()).toHaveLength(1);
    expect(clipSteps()[0].velocity).toBe(VEL_LEVELS[velLevelIndex(VEL_DEFAULT) + 1]);
  });

  it('SCALE (CC 97) cycles the clip scale; EXIT (top scene) leaves edit', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    enterEdit();
    expect((liveData().clips as Record<string, NoteClipRecord>)['0'].scale).toBe('major');
    sim.cc('R', CC_EDIT_SCALE, 127);
    expect((liveData().clips as Record<string, NoteClipRecord>)['0'].scale).toBe('minor');
    sim.cc('R', sceneCcForRow(EDIT_EXIT_SCENE_ROW), 127); // top scene = EXIT
    expect(__test_mode().mode).toBe('session');
  });
});

describe('Editor SHIFT windowing (×8 jump)', () => {
  function enterEdit() {
    sim.press('R', DECK_EDIT_COL, 0);
    sim.press('L', 0, 0);
    sim.release('R', DECK_EDIT_COL, 0);
  }
  it('▲ scrolls pitch +1 row; SHIFT+▲ jumps +8 rows', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    enterEdit();
    sim.cc('R', CC_EDIT_ROW_UP, 127);
    expect(__test_mode().editRowOffset).toBe(1);
    // hold SHIFT → next ▲ jumps +8.
    sim.cc('R', CC_SHIFT, 127);
    expect(__test_mode().shiftHeld).toBe(true);
    sim.cc('R', CC_EDIT_ROW_UP, 127);
    expect(__test_mode().editRowOffset).toBe(1 + 8);
    sim.cc('R', CC_SHIFT, 0);
  });

  it('▶ scrolls the step window ±1; SHIFT+▶ jumps a full screen (+8) on a long clip', () => {
    // a 64-step clip (room to scroll; maxWindowStart = 64-8 = 56).
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: { ...noteClip(), lengthSteps: 64 } } });
    bindLaunchpadToClip(NODE_ID);
    enterEdit();
    expect(__test_mode().editWindowStart).toBe(0);
    sim.cc('R', CC_EDIT_STEP_RIGHT, 127); // +1 step (per-step scroll)
    expect(__test_mode().editWindowStart).toBe(1);
    // SHIFT+▶ jumps a full screen (+8): 1 → 9.
    sim.cc('R', CC_SHIFT, 127);
    sim.cc('R', CC_EDIT_STEP_RIGHT, 127);
    expect(__test_mode().editWindowStart).toBe(9);
    sim.cc('R', CC_SHIFT, 0);
    // ◀ scrolls back -1.
    sim.cc('R', CC_EDIT_STEP_RIGHT, 127); // 10
    expect(__test_mode().editWindowStart).toBe(10);
  });
});

describe('Deck DOUBLE / LENGTH-EDIT / copy-paste', () => {
  function enterEdit() {
    sim.press('R', DECK_EDIT_COL, 0);
    sim.press('L', 0, 0);
    sim.release('R', DECK_EDIT_COL, 0);
  }
  const clipAt = (idx: number) => (liveData().clips as Record<string, NoteClipRecord>)[String(idx)];

  it('DOUBLE (editor scene row 6) duplicates the pattern into a doubled length', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: { ...noteClip(), steps: [{ step: 0, midi: 60, lengthSteps: 1 }], lengthSteps: 16 } } });
    bindLaunchpadToClip(NODE_ID);
    enterEdit();
    sim.cc('R', sceneCcForRow(EDIT_DOUBLE_SCENE_ROW), 127); // DOUBLE on the editor scene column
    expect(clipAt(0).lengthSteps).toBe(32);
    expect(clipAt(0).steps.some((s) => s.step === 16 && s.midi === 60)).toBe(true);
  });

  it('LENGTH-EDIT (editor scene row 5) opens the length page; a block tap sets the length', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    enterEdit();
    sim.cc('R', sceneCcForRow(EDIT_LENGTH_SCENE_ROW), 127); // LENGTH-EDIT on the editor scene column
    expect(__test_mode().mode).toBe('lengthEdit');
    sim.press('R', 2, 0); sim.release('R', 2, 0); // block 3 → 48 steps
    expect(clipAt(0).lengthSteps).toBe(48);
    sim.cc('R', sceneCcForRow(EDIT_EXIT_SCENE_ROW), 127); // EXIT → back to edit
    expect(__test_mode().mode).toBe('edit');
  });

  it('hold COPY (R) + tap a clip (L) loads the buffer; PASTE creates a copy', () => {
    seedClipPlayer({
      clips: {
        [clipIndex(0, 0)]: { ...noteClip(), steps: [{ step: 1, midi: 64, lengthSteps: 1 }] },
      },
    });
    bindLaunchpadToClip(NODE_ID);
    // hold COPY + tap the source clip.
    sim.press('R', DECK_COPY_COL, 0);
    sim.press('L', 0, 0);
    sim.release('R', DECK_COPY_COL, 0);
    expect(__test_mode().bufferArmed).toBe(true);
    expect(__test_mode().bufferSourceIndex).toBe(0);
    // hold PASTE + tap an empty destination (slot1 lane0).
    sim.press('R', DECK_PASTE_COL, 0);
    sim.press('L', 1, 0);
    sim.release('R', DECK_PASTE_COL, 0);
    expect(clipAt(clipIndex(1, 0))).toBeTruthy();
    // the pasted clip carries the source's note.
    expect(clipAt(clipIndex(1, 0)).steps.some((s) => s.step === 1 && s.midi === 64)).toBe(true);
  });

  it('PASTE-REV pastes a time-reversed copy', () => {
    seedClipPlayer({
      clips: {
        [clipIndex(0, 0)]: { ...noteClip(), lengthSteps: 16, steps: [{ step: 0, midi: 64, lengthSteps: 1 }] },
      },
    });
    bindLaunchpadToClip(NODE_ID);
    sim.press('R', DECK_COPY_COL, 0); sim.press('L', 0, 0); sim.release('R', DECK_COPY_COL, 0);
    sim.press('R', DECK_PASTE_REV_COL, 0); sim.press('L', 1, 0); sim.release('R', DECK_PASTE_REV_COL, 0);
    // a note at step 0 (len 1) in a 16-step clip mirrors to step 15.
    expect(clipAt(clipIndex(1, 0)).steps.some((s) => s.step === 15 && s.midi === 64)).toBe(true);
  });
});

describe('LED render loop (both units)', () => {
  it('repaints L (matrix) + R (deck) from per-lane state on each tick', () => {
    seedClipPlayer({
      clips: { [clipIndex(0, 0)]: noteClip(), [clipIndex(1, 1)]: noteClip() },
      playing: [null, 1, null, null, null, null, null, null],
    });
    seedTimelorde(1);
    bindLaunchpadToClip(NODE_ID);
    expect(hoisted.tick).toBeTruthy();
    hoisted.tick!();
    // L: lane1 slot1 playing → its pad LED is lit (non-zero).
    const lit = sim.ledAt('L', /* padNote(1,1) */ 22);
    expect(lit).not.toBeNull();
    expect(lit![0] + lit![1] + lit![2]).toBeGreaterThan(0);
    // R: the EDIT deck pad is lit (function colour).
    const deck = sim.ledAt('R', /* padNote(0,0) */ 11);
    expect(deck).not.toBeNull();
  });
});

describe('unbind', () => {
  it('stops driving the matrix', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    unbindLaunchpad();
    expect(boundClipNode()).toBeNull();
    sim.press('L', 0, 0);
    expect(queued()?.[0] ?? null).toBeNull();
  });
});

describe('sanity: editPadToNote octave math used by the editor', () => {
  it('a row shift moves a placed note up the scale', () => {
    const clip = noteClip();
    const scaleLen = scaleSteps(clip.scale).length;
    const base = editPadToNote(clip, 0, 0)!;
    const shifted = editPadToNote(clip, 0, 0, { rowOffset: scaleLen })!;
    expect(shifted.midi).toBe(base.midi + 12); // one octave up
  });
});
