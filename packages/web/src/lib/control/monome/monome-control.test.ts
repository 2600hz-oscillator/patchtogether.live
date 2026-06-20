// packages/web/src/lib/control/monome/monome-control.test.ts
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
import { installSimulatedGrid, __test_resetGrid, type SimulatedGrid } from './monome-device.svelte';
import {
  bindGridToClip,
  unbindGrid,
  boundClipNode,
  __test_resetBinding,
  __test_mode,
} from './monome-control.svelte';
import {
  clipIndexToPad,
  editRowToMidi,
  CTRL_STOP_COL,
  CTRL_SCENE_COL,
  EDIT_PAD,
  COPY_PAD,
  PASTE_PAD,
  PASTE_REV_PAD,
  STOPALL_PAD,
  TRANSPORT_PAD,
  EDIT_EXIT_PAD,
  VEL_PAD,
  OCT_UP_PAD,
  ROW_UP_PAD,
  SCALE_PAD,
  FOLLOW_PAD,
  PAGE_LEFT_PAD,
  PAGE_RIGHT_PAD,
  DOUBLE_PAD,
  LENGTH_EDIT_PAD,
  LED_LOADED,
  LED_PLAYING,
} from './monome-map';
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

// ===========================================================================
// CLIP-LAUNCHER MODS: multi-page edit (FOLLOW/LEFT/RIGHT/DOUBLE/LENGTH) + copy
// ===========================================================================

const clipsAt = (idx: number) => (liveData().clips as Record<string, NoteClipRecord>)[String(idx)];
const tap = (x: number, y: number) => { sim.press(x, y); sim.release(x, y); };
/** Enter EDIT mode for the clip at index `idx` (default 0 = lane0/slot0). */
function enterEditAt(idx = 0) {
  const p = clipIndexToPad(idx);
  sim.press(EDIT_PAD.x, EDIT_PAD.y);
  sim.press(p.x, p.y);
  sim.release(EDIT_PAD.x, EDIT_PAD.y);
}

describe('grid EDIT mode — FOLLOW + page nav (LEFT/RIGHT)', () => {
  it('FOLLOW is on by default; tapping it freezes (and flashes via state)', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: { ...noteClip(), lengthSteps: 48 } } });
    bindGridToClip(NODE_ID);
    enterEditAt(0);
    expect(__test_mode().followOn).toBe(true);
    tap(FOLLOW_PAD.x, FOLLOW_PAD.y); // freeze
    expect(__test_mode().followOn).toBe(false);
    tap(FOLLOW_PAD.x, FOLLOW_PAD.y); // resume
    expect(__test_mode().followOn).toBe(true);
  });

  it('LEFT/RIGHT are no-ops while FOLLOWing (no state change)', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: { ...noteClip(), lengthSteps: 48 } } });
    bindGridToClip(NODE_ID);
    enterEditAt(0);
    expect(__test_mode().followOn).toBe(true);
    const before = __test_mode().editPage;
    tap(PAGE_RIGHT_PAD.x, PAGE_RIGHT_PAD.y);
    tap(PAGE_LEFT_PAD.x, PAGE_LEFT_PAD.y);
    expect(__test_mode().editPage).toBe(before); // unchanged while following
  });

  it('frozen: RIGHT advances the page, LEFT retreats, no-op at the ends', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: { ...noteClip(), lengthSteps: 48 } } }); // 3 pages
    bindGridToClip(NODE_ID);
    enterEditAt(0);
    tap(FOLLOW_PAD.x, FOLLOW_PAD.y); // freeze at page 0
    expect(__test_mode().editPage).toBe(0);
    tap(PAGE_LEFT_PAD.x, PAGE_LEFT_PAD.y); // no-op at leftmost
    expect(__test_mode().editPage).toBe(0);
    tap(PAGE_RIGHT_PAD.x, PAGE_RIGHT_PAD.y);
    tap(PAGE_RIGHT_PAD.x, PAGE_RIGHT_PAD.y);
    expect(__test_mode().editPage).toBe(2); // pages 0→1→2
    tap(PAGE_RIGHT_PAD.x, PAGE_RIGHT_PAD.y); // no-op at rightmost
    expect(__test_mode().editPage).toBe(2);
    tap(PAGE_LEFT_PAD.x, PAGE_LEFT_PAD.y);
    expect(__test_mode().editPage).toBe(1);
  });

  it('editing on a frozen page writes the GLOBAL step (page*16 + x)', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: { ...noteClip(), lengthSteps: 48, steps: [] } } });
    bindGridToClip(NODE_ID);
    enterEditAt(0);
    tap(FOLLOW_PAD.x, FOLLOW_PAD.y); // freeze
    tap(PAGE_RIGHT_PAD.x, PAGE_RIGHT_PAD.y); // page 1
    tap(2, 4); // local x=2 on page 1 → global step 18
    const steps = clipsAt(0).steps;
    expect(steps).toHaveLength(1);
    expect(steps[0].step).toBe(18);
  });

  it('resuming FOLLOW after the length SHRANK clamps editPage into range', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: { ...noteClip(), lengthSteps: 128 } } }); // 8 pages
    bindGridToClip(NODE_ID);
    enterEditAt(0);
    tap(FOLLOW_PAD.x, FOLLOW_PAD.y); // freeze
    for (let i = 0; i < 7; i++) tap(PAGE_RIGHT_PAD.x, PAGE_RIGHT_PAD.y); // page 7
    expect(__test_mode().editPage).toBe(7);
    // Shrink the clip to 16 (1 page) out-of-band, then resume FOLLOW.
    (clipsAt(0) as NoteClipRecord).lengthSteps = 16;
    tap(FOLLOW_PAD.x, FOLLOW_PAD.y); // resume → clamps
    expect(__test_mode().editPage).toBe(0);
  });
});

describe('grid EDIT mode — DOUBLE', () => {
  it('DOUBLE duplicates the first half into a doubled length', () => {
    seedClipPlayer({
      clips: { [clipIndex(0, 0)]: { ...noteClip(), lengthSteps: 16, steps: [{ step: 0, midi: 60, lengthSteps: 1 }] } },
    });
    bindGridToClip(NODE_ID);
    enterEditAt(0);
    tap(DOUBLE_PAD.x, DOUBLE_PAD.y);
    const c = clipsAt(0);
    expect(c.lengthSteps).toBe(32);
    expect(c.steps.some((e) => e.step === 0)).toBe(true);
    expect(c.steps.some((e) => e.step === 16)).toBe(true); // mirrored copy
  });
  it('DOUBLE at MAX (128) is a no-op — NO write (clip object unchanged)', () => {
    seedClipPlayer({
      clips: { [clipIndex(0, 0)]: { ...noteClip(), lengthSteps: 128, steps: [{ step: 0, midi: 60, lengthSteps: 1 }] } },
    });
    bindGridToClip(NODE_ID);
    enterEditAt(0);
    const before = clipsAt(0);
    tap(DOUBLE_PAD.x, DOUBLE_PAD.y);
    expect(clipsAt(0)).toBe(before); // same reference — write was skipped
    expect(clipsAt(0).lengthSteps).toBe(128);
  });
});

describe('grid LENGTH-EDIT page', () => {
  it('LENGTH-EDIT pad opens the length page; EXIT returns to the editor', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: { ...noteClip(), lengthSteps: 16 } } });
    bindGridToClip(NODE_ID);
    enterEditAt(0);
    tap(LENGTH_EDIT_PAD.x, LENGTH_EDIT_PAD.y);
    expect(__test_mode().mode).toBe('lengthEdit');
    tap(15, 0); // EXIT pad (row 0, cell 16)
    expect(__test_mode().mode).toBe('edit');
  });
  it('row-0 block tap sets length to C*16 (non-destructive)', () => {
    seedClipPlayer({
      clips: { [clipIndex(0, 0)]: { ...noteClip(), lengthSteps: 16, steps: [{ step: 5, midi: 60, lengthSteps: 1 }] } },
    });
    bindGridToClip(NODE_ID);
    enterEditAt(0);
    tap(LENGTH_EDIT_PAD.x, LENGTH_EDIT_PAD.y);
    tap(7, 0); // block 8 (1-based) → 128 steps
    expect(clipsAt(0).lengthSteps).toBe(128);
    expect(clipsAt(0).steps).toHaveLength(1); // steps[] untouched
  });
  it('row-1 step tap trims the end block (length 113 = block 8 then step 1)', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: { ...noteClip(), lengthSteps: 16 } } });
    bindGridToClip(NODE_ID);
    enterEditAt(0);
    tap(LENGTH_EDIT_PAD.x, LENGTH_EDIT_PAD.y);
    tap(7, 0); // block 8 → 128
    tap(0, 1); // row-1 step 1 → 113
    expect(clipsAt(0).lengthSteps).toBe(113);
  });
  it('setting length NEVER prunes notes past the new end (retained, replays)', () => {
    seedClipPlayer({
      clips: {
        [clipIndex(0, 0)]: {
          ...noteClip(),
          lengthSteps: 64,
          steps: [{ step: 40, midi: 60, lengthSteps: 1 }], // lives past a shrink to 16
        },
      },
    });
    bindGridToClip(NODE_ID);
    enterEditAt(0);
    tap(LENGTH_EDIT_PAD.x, LENGTH_EDIT_PAD.y);
    tap(0, 0); // block 1 → 16 steps (shrink)
    expect(clipsAt(0).lengthSteps).toBe(16);
    expect(clipsAt(0).steps).toContainEqual({ step: 40, midi: 60, lengthSteps: 1 }); // retained
  });
});

describe('grid SESSION — COPY / PASTE / PASTE-REVERSE held modifiers', () => {
  function seedTwo() {
    seedClipPlayer({
      clips: {
        [clipIndex(0, 0)]: {
          ...noteClip(),
          lengthSteps: 16,
          steps: [
            { step: 0, midi: 60, lengthSteps: 1 },
            { step: 4, midi: 64, lengthSteps: 2 },
          ],
        },
      },
    });
  }

  it('HOLD COPY + tap a clip arms the per-machine buffer (indicator armed)', () => {
    seedTwo();
    bindGridToClip(NODE_ID);
    expect(__test_mode().bufferArmed).toBe(false);
    sim.press(COPY_PAD.x, COPY_PAD.y); // hold COPY
    expect(__test_mode().copyHeld).toBe(true);
    sim.press(0, 0); // tap the source clip
    sim.release(0, 0);
    sim.release(COPY_PAD.x, COPY_PAD.y);
    expect(__test_mode().bufferArmed).toBe(true);
    // copying never queues a launch.
    expect(queued()?.[0] ?? null).toBeNull();
  });

  it('HOLD PASTE + tap an EMPTY slot CREATES the clip from the buffer', () => {
    seedTwo();
    bindGridToClip(NODE_ID);
    // copy clip 0 …
    sim.press(COPY_PAD.x, COPY_PAD.y); tap(0, 0); sim.release(COPY_PAD.x, COPY_PAD.y);
    // … paste into empty lane2/slot3 (pad 3,2).
    sim.press(PASTE_PAD.x, PASTE_PAD.y);
    tap(3, 2);
    sim.release(PASTE_PAD.x, PASTE_PAD.y);
    const dst = clipsAt(clipIndex(3, 2));
    expect(dst).toBeTruthy();
    expect(dst.steps).toHaveLength(2);
    expect(dst.steps).toContainEqual({ step: 0, midi: 60, lengthSteps: 1 });
  });

  it('PASTE OVERWRITES an existing clip', () => {
    seedTwo();
    // a different existing clip at lane1/slot1.
    (liveData().clips as Record<string, NoteClipRecord>)[String(clipIndex(1, 1))] = {
      ...defaultNoteClip(),
      steps: [{ step: 7, midi: 72, lengthSteps: 1 }],
    };
    bindGridToClip(NODE_ID);
    sim.press(COPY_PAD.x, COPY_PAD.y); tap(0, 0); sim.release(COPY_PAD.x, COPY_PAD.y);
    sim.press(PASTE_PAD.x, PASTE_PAD.y); tap(1, 1); sim.release(PASTE_PAD.x, PASTE_PAD.y);
    const dst = clipsAt(clipIndex(1, 1));
    expect(dst.steps).toHaveLength(2); // replaced with the 2-note buffer
    expect(dst.steps.some((e) => e.midi === 72)).toBe(false);
  });

  it('PASTE-REVERSE pastes a time-reversed copy', () => {
    seedTwo();
    bindGridToClip(NODE_ID);
    sim.press(COPY_PAD.x, COPY_PAD.y); tap(0, 0); sim.release(COPY_PAD.x, COPY_PAD.y);
    sim.press(PASTE_REV_PAD.x, PASTE_REV_PAD.y); tap(3, 2); sim.release(PASTE_REV_PAD.x, PASTE_REV_PAD.y);
    const dst = clipsAt(clipIndex(3, 2));
    // original: step0 (len1) + step4 (len2). reversed in a 16-step clip:
    //   step0 → 16-(0+1)=15 ; step4 (len2) → 16-(4+2)=10 (len2).
    expect(dst.steps).toContainEqual({ step: 15, midi: 60, lengthSteps: 1 });
    expect(dst.steps).toContainEqual({ step: 10, midi: 64, lengthSteps: 2 });
  });

  it('PASTE clones events — the destination shares NO refs with the source', () => {
    seedTwo();
    bindGridToClip(NODE_ID);
    sim.press(COPY_PAD.x, COPY_PAD.y); tap(0, 0); sim.release(COPY_PAD.x, COPY_PAD.y);
    sim.press(PASTE_PAD.x, PASTE_PAD.y); tap(3, 2); sim.release(PASTE_PAD.x, PASTE_PAD.y);
    const src = clipsAt(0);
    const dst = clipsAt(clipIndex(3, 2));
    expect(dst.steps[0]).not.toBe(src.steps[0]); // distinct event objects
    // mutating the source after paste never touches the destination.
    src.steps[0].midi = 99;
    expect(dst.steps.some((e) => e.midi === 99)).toBe(false);
  });

  it('PASTE with an EMPTY buffer is a no-op (nothing created)', () => {
    seedTwo();
    bindGridToClip(NODE_ID);
    sim.press(PASTE_PAD.x, PASTE_PAD.y); tap(3, 2); sim.release(PASTE_PAD.x, PASTE_PAD.y);
    expect(clipsAt(clipIndex(3, 2)) ?? null).toBeNull();
  });

  it('modifier precedence: editArmed > copy > paste (EDIT wins, opens the editor)', () => {
    seedTwo();
    bindGridToClip(NODE_ID);
    // arm the buffer first so a paste WOULD be possible.
    sim.press(COPY_PAD.x, COPY_PAD.y); tap(0, 0); sim.release(COPY_PAD.x, COPY_PAD.y);
    // now hold BOTH edit + paste, then tap a clip → EDIT takes precedence.
    sim.press(EDIT_PAD.x, EDIT_PAD.y);
    sim.press(PASTE_PAD.x, PASTE_PAD.y);
    sim.press(1, 1); // tap clip
    sim.release(1, 1);
    sim.release(PASTE_PAD.x, PASTE_PAD.y);
    sim.release(EDIT_PAD.x, EDIT_PAD.y);
    expect(__test_mode().mode).toBe('edit'); // edit won — did not paste
  });
});

describe('grid SESSION — COPY/PASTE never launch (modifiers gate the clip pad)', () => {
  it('a plain clip tap (no modifier) still launches normally', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindGridToClip(NODE_ID);
    sim.press(0, 0);
    expect(queued()![0]).toBe(0); // ordinary launch unaffected
  });
});
