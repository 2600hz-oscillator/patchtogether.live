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
import type { MidiInputLike } from '$lib/audio/modules/midi-cv-buddy';
import type { MidiOutputLike } from '$lib/audio/modules/midi-out-buddy';
import {
  installSimulatedLaunchpad,
  __test_resetLaunchpad,
  __test_setAccess,
  type SimulatedLaunchpad,
  type MidiFullAccessLike,
} from './launchpad-device.svelte';
import {
  bindLaunchpadToClip,
  unbindLaunchpad,
  boundClipNode,
  startPairing,
  __test_resetBinding,
  __test_mode,
} from './launchpad-control.svelte';
import {
  DECK_EDIT_COL,
  DECK_COPY_COL,
  DECK_PASTE_COL,
  DECK_PASTE_REV_COL,
  DECK_NOW_COL,
  DECK_COPY_IND_COL,
  CC_TRANSPORT,
  CC_STOP_ALL,
  CC_REC,
  CC_SONG,
  CC_SHIFT,
  CC_EDIT_ROW_UP,
  CC_EDIT_STEP_RIGHT,
  CC_EDIT_VEL,
  CC_EDIT_SCALE,
  EDIT_EXIT_SCENE_ROW,
  EDIT_DOUBLE_SCENE_ROW,
  EDIT_LENGTH_SCENE_ROW,
  editPadToNote,
  lPadToClipIndex,
  clipIndexToLPad,
  // KEYS mode
  DECK_KEYS_REC_COL,
  DECK_KEYS_OVERDUB_COL,
  DECK_KEYS_ROW,
  KEYS_QREC_COL,
  KEYS_OVERDUB_COL,
  KEYS_EXIT_COL,
  KEYS_LEN_COL,
  KEYS_CTRL_ROW,
  KEYS_PH_ROW,
} from './launchpad-map';
import { SCENE_CCS, padNote } from './launchpad-sysex';
import { setLanePlayhead, clearPlayheads } from '$lib/audio/modules/clip-playhead';
import { drainAudition, clearAudition } from '$lib/audio/modules/clip-audition';
import {
  CLIP_LANES,
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
  clearPlayheads(NODE_ID);
  clearAudition(NODE_ID);
  sim = await installSimulatedLaunchpad();
});

// SCENE_CCS is top→bottom (index 0 = row 7). A scene-row Y press = the CC at
// index (7 - row). Helper to press a scene-column button by ROW.
const sceneCcForRow = (row: number) => SCENE_CCS[7 - row];

// The L matrix maps lane 0 → the TOP physical row (y = CLIP_LANES-1) so it
// matches the on-screen card (which renders lane 0 as the top grid row). A pad
// for (slot, lane) is therefore at physical (x=slot, y=yForLane(lane)).
const yForLane = (lane: number) => CLIP_LANES - 1 - lane;

describe('Launchpad L (matrix) → clip-player launch', () => {
  it('pressing a loaded clip pad on L queues that clip in its lane', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip(), [clipIndex(1, 1)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    expect(boundClipNode()).toBe(NODE_ID);
    sim.press('L', 0, yForLane(0)); // slot0 lane0 (top row)
    expect(queued()![0]).toBe(0);
    sim.press('L', 1, yForLane(1)); // slot1 lane1
    expect(queued()![1]).toBe(1);
  });

  it('pressing the currently-playing clip queues a stop for that lane', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() }, playing: [0, null, null, null, null, null, null, null] });
    bindLaunchpadToClip(NODE_ID);
    sim.press('L', 0, yForLane(0));
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
    sim.press('L', 3, yForLane(0)); // slot3 lane0 — not loaded
    sim.release('L', 0, yForLane(0));
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
    sim.press('L', 0, yForLane(0)); // launch with NOW held
    expect(queued()![0]).toBe(0);
    expect(queuedImmediate()![0]).toBe(true);
    sim.release('R', DECK_NOW_COL, 0);
  });
});

describe('Launchpad EDIT — hold EDIT on R + tap a clip on L', () => {
  function enterEdit(slot = 0, lane = 0) {
    sim.press('R', DECK_EDIT_COL, 0); // hold EDIT (deck)
    sim.press('L', slot, yForLane(lane)); // tap clip on the matrix → enter editor
    sim.release('R', DECK_EDIT_COL, 0);
  }
  const clipSteps = (idx = 0) => (liveData().clips as Record<string, NoteClipRecord>)[String(idx)].steps;

  it('hold EDIT (R) + tap a clip (L) enters edit; the matrix tap does NOT launch', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    sim.press('R', DECK_EDIT_COL, 0);
    expect(__test_mode().editArmed).toBe(true);
    sim.press('L', 0, yForLane(0));
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
    sim.press('L', 0, yForLane(0));
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
    sim.press('L', 0, yForLane(0));
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
    sim.press('L', 0, yForLane(0));
    sim.release('R', DECK_COPY_COL, 0);
    expect(__test_mode().bufferArmed).toBe(true);
    expect(__test_mode().bufferSourceIndex).toBe(0);
    // hold PASTE + tap an empty destination (slot1 lane0).
    sim.press('R', DECK_PASTE_COL, 0);
    sim.press('L', 1, yForLane(0));
    sim.release('R', DECK_PASTE_COL, 0);
    expect(clipAt(clipIndex(1, 0))).toBeTruthy();
    // the pasted clip carries the source's note.
    expect(clipAt(clipIndex(1, 0)).steps.some((s) => s.step === 1 && s.midi === 64)).toBe(true);
  });

  it('tapping the COPY-INDICATOR pad EMPTIES the buffer (turns off the turquoise glow)', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    // load the buffer from clip 0.
    sim.press('R', DECK_COPY_COL, 0); sim.press('L', 0, yForLane(0)); sim.release('R', DECK_COPY_COL, 0);
    expect(__test_mode().bufferArmed, 'buffer loaded').toBe(true);
    expect(__test_mode().bufferSourceIndex, 'glow on clip 0').toBe(0);
    // tap the COPY-INDICATOR pad → buffer cleared, glow off.
    sim.press('R', DECK_COPY_IND_COL, 0); sim.release('R', DECK_COPY_IND_COL, 0);
    expect(__test_mode().bufferArmed, 'buffer emptied').toBe(false);
    expect(__test_mode().bufferSourceIndex, 'turquoise glow cleared').toBeNull();
  });

  it('PASTE-REV pastes a time-reversed copy', () => {
    seedClipPlayer({
      clips: {
        [clipIndex(0, 0)]: { ...noteClip(), lengthSteps: 16, steps: [{ step: 0, midi: 64, lengthSteps: 1 }] },
      },
    });
    bindLaunchpadToClip(NODE_ID);
    sim.press('R', DECK_COPY_COL, 0); sim.press('L', 0, yForLane(0)); sim.release('R', DECK_COPY_COL, 0);
    sim.press('R', DECK_PASTE_REV_COL, 0); sim.press('L', 1, yForLane(0)); sim.release('R', DECK_PASTE_REV_COL, 0);
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
    // L: lane1 slot1 playing → its pad LED is lit (non-zero). lane 1 flips to
    // physical y = yForLane(1) so it reads at the card-matching row.
    const lit = sim.ledAt('L', padNote(1, yForLane(1)));
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
    sim.press('L', 0, yForLane(0));
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

// ===========================================================================
// BUG REGRESSIONS (fix/launchpad-clip-bugs). Each block reproduces a confirmed
// hardware bug the owner hit; written FAILING first, then the fix makes them
// pass. See the PR description for the audit table.
// ===========================================================================

describe('BUG 1 — L matrix Y-axis matches the on-screen card (lane 0 = TOP row)', () => {
  it('the card top-left clip (lane0,slot0) lights the launchpad TOP-left pad, not the bottom', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() }, playing: [0, null, null, null, null, null, null, null] });
    seedTimelorde(1);
    bindLaunchpadToClip(NODE_ID);
    hoisted.tick!();
    // lane 0 plays → its pad must be lit at the TOP physical row (y=7), slot col 0.
    const top = sim.ledAt('L', padNote(0, yForLane(0)));
    expect(top, 'lane0/slot0 lit at TOP row (y=7)').not.toBeNull();
    expect(top![0] + top![1] + top![2]).toBeGreaterThan(0);
    // the BOTTOM-left pad (y=0) = lane 7 slot 0 = empty → off — proves Y isn't inverted.
    const bottom = sim.ledAt('L', padNote(0, 0));
    expect((bottom?.[0] ?? 0) + (bottom?.[1] ?? 0) + (bottom?.[2] ?? 0)).toBe(0);
  });

  it('pressing the TOP-left pad on L launches lane 0 (the card top row)', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip(), [clipIndex(0, 7)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    sim.press('L', 0, yForLane(0)); // top-left physical pad
    expect(queued()![0], 'top-left pad → lane 0').toBe(0);
    expect(queued()![7] ?? null, 'lane 7 untouched').toBeNull();
    // and the BOTTOM-left pad addresses lane 7 (the card's bottom row).
    sim.press('L', 0, yForLane(7)); // = y 0 (bottom)
    expect(queued()![7], 'bottom-left pad → lane 7').toBe(0);
  });

  it('lPadToClipIndex / clipIndexToLPad round-trip with the card orientation', () => {
    for (let lane = 0; lane < CLIP_LANES; lane++) {
      const p = clipIndexToLPad(clipIndex(0, lane));
      expect(p.y, `lane ${lane} → physical y`).toBe(yForLane(lane));
      expect(lPadToClipIndex(p.x, p.y)).toBe(clipIndex(0, lane));
    }
  });
});

describe('BUG 2 — tapping a loaded clip in an already-playing lane switches it', () => {
  it('lane already playing slot0; tapping loaded slot2 queues slot2 (not a no-op/stop)', () => {
    seedClipPlayer({
      clips: { [clipIndex(0, 0)]: noteClip(), [clipIndex(2, 0)]: noteClip() },
      playing: [0, null, null, null, null, null, null, null],
    });
    bindLaunchpadToClip(NODE_ID);
    // tap the DIFFERENT loaded clip in the same (top) lane.
    sim.press('L', 2, yForLane(0));
    expect(queued()![0], 'switch queued to slot 2').toBe(2);
  });
});

describe('BUG 3 — create a clip from an EMPTY pad (hold EDIT + tap empty)', () => {
  it('hold EDIT on R + tap an empty pad on L creates a clip there + flips R to the editor', () => {
    seedClipPlayer({ clips: {} });
    bindLaunchpadToClip(NODE_ID);
    sim.press('R', DECK_EDIT_COL, 0); // hold EDIT
    expect(__test_mode().editArmed, 'EDIT armed while held').toBe(true);
    sim.press('L', 4, yForLane(3)); // empty pad: lane3 slot4
    const idx = clipIndex(4, 3);
    expect((liveData().clips as Record<string, unknown>)[String(idx)], 'clip created at tapped index').toBeTruthy();
    expect(__test_mode().mode, 'R flipped to the editor').toBe('edit');
    expect(__test_mode().editClipIndex).toBe(idx);
    expect(queued()?.[3] ?? null, 'an empty-pad EDIT tap does NOT launch').toBeNull();
    sim.release('R', DECK_EDIT_COL, 0);
  });
});

describe('BUG 4 — transport RESTARTS (toggle stop → start → stop again)', () => {
  it('CC 96 toggles TIMELORDE.running both directions, repeatedly', () => {
    seedClipPlayer({ clips: {} });
    seedTimelorde(1); // running
    bindLaunchpadToClip(NODE_ID);
    const running = () => (livePatch.nodes['tl']!.params as Record<string, number>).running;
    expect(running()).toBe(1);
    sim.cc('R', CC_TRANSPORT, 127); // → stop
    expect(running(), 'first press stops').toBe(0);
    sim.cc('R', CC_TRANSPORT, 127); // → RESTART
    expect(running(), 'second press RESTARTS').toBe(1);
    sim.cc('R', CC_TRANSPORT, 127); // → stop again
    expect(running(), 'third press stops again').toBe(0);
  });

  it('CC 97 (stop-all) is distinct from CC 96 (transport) and does NOT touch running', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() }, playing: [0, null, null, null, null, null, null, null] });
    seedTimelorde(1);
    bindLaunchpadToClip(NODE_ID);
    sim.cc('R', CC_STOP_ALL, 127);
    expect(queued()).toEqual(['stop', 'stop', 'stop', 'stop', 'stop', 'stop', 'stop', 'stop']);
    expect((livePatch.nodes['tl']!.params as Record<string, number>).running, 'stop-all leaves transport running').toBe(1);
  });
});

// ===========================================================================
// ARRANGER (Phase C) — REC + SES⇄ARR on the R deck write the SAME node.data
// fields the ClipplayerCard writes, so the engine's clip-arrange records +
// replays identically. (The end-to-end arrangement CAPTURE — armed REC +
// launch → an event in node.data.arrangement — needs the real engine factory,
// so it lives in the e2e real-source-chain spec; here we pin the field writes.)
// ===========================================================================
describe('ARRANGER — REC + SES⇄ARR (R deck top row)', () => {
  it('CC 91 (REC) toggles node.data.recording (the arranger record-arm)', () => {
    seedClipPlayer({ clips: {} });
    bindLaunchpadToClip(NODE_ID);
    expect(liveData().recording ?? false, 'starts disarmed').toBeFalsy();
    sim.cc('R', CC_REC, 127);
    expect(liveData().recording, 'REC arms recording').toBe(true);
    sim.cc('R', CC_REC, 127);
    expect(liveData().recording, 'REC disarms').toBe(false);
  });

  it('CC 92 (SONG) flips node.data.clipMode SESSION ⇄ ARRANGEMENT', () => {
    seedClipPlayer({ clips: {} });
    bindLaunchpadToClip(NODE_ID);
    expect(liveData().clipMode ?? 'session', 'starts in SESSION').not.toBe('arrangement');
    sim.cc('R', CC_SONG, 127);
    expect(liveData().clipMode, 'SONG → ARRANGEMENT').toBe('arrangement');
    sim.cc('R', CC_SONG, 127);
    expect(liveData().clipMode, 'SONG → back to SESSION').toBe('session');
  });

  it('REC + SONG light their deck LEDs from state (red pulse / white)', () => {
    seedClipPlayer({ clips: {}, recording: true, clipMode: 'arrangement' });
    seedTimelorde(1);
    bindLaunchpadToClip(NODE_ID);
    hoisted.tick!();
    const rec = sim.ledAt('R', CC_REC);
    expect(rec, 'REC LED painted').not.toBeNull();
    expect(rec![0], 'REC is red (R channel high)').toBeGreaterThan(rec![1]);
    const song = sim.ledAt('R', CC_SONG);
    expect(song, 'SONG LED painted').not.toBeNull();
    expect(song![0] + song![1] + song![2], 'SONG lit in ARRANGEMENT').toBeGreaterThan(0);
  });
});

// ===========================================================================
// REAL PAIRING HANDSHAKE (the bug the simulated seam HID). installSimulatedLaunchpad
// binds L→simL, R→simR in order, so it never exercises the L↔R SWAP that
// finishPairing does when the user picks the provisional-R unit as LEFT. On real
// hardware that swap nulled the LEFT unit's input handler → LEFT pads dead (no
// launch / no edit) while RIGHT kept working. This drives the REAL
// startPairing → press → finishPairing path and asserts the LEFT unit launches.
// ===========================================================================
describe('Real L/R pairing handshake — LEFT unit is LIVE after a swap', () => {
  // A fake input whose onmidimessage is a settable property (real-MIDIAccess
  // shape), so the test can "press" by reading the handler back + calling it.
  function fakeInput(id: string): MidiInputLike {
    return {
      id, name: 'LPMiniMK3 MIDI In', manufacturer: 'Focusrite - Novation',
      state: 'connected', onmidimessage: null,
    } as unknown as MidiInputLike;
  }
  function fakeOutput(id: string): MidiOutputLike {
    return {
      id, name: 'LPMiniMK3 MIDI Out', manufacturer: 'Focusrite - Novation',
      state: 'connected', send: () => {},
    } as unknown as MidiOutputLike;
  }
  function press(input: MidiInputLike, note: number) {
    (input.onmidimessage as ((e: { data: Uint8Array; timeStamp: number }) => void) | null)?.({
      data: new Uint8Array([0x90, note, 100]), timeStamp: 0,
    });
  }

  it('after the user picks the provisional-R unit as LEFT, LEFT pads launch clips', async () => {
    // Two identical units, distinct ids. (padNote(0,7)=81 = card top-left.)
    const inA = fakeInput('inA');
    const inB = fakeInput('inB');
    const access: MidiFullAccessLike = {
      inputs: new Map<string, MidiInputLike>([['inA', inA], ['inB', inB]]),
      outputs: new Map<string, MidiOutputLike>([['outA', fakeOutput('outA')], ['outB', fakeOutput('outB')]]),
      onstatechange: null,
    };
    __test_setAccess(access); // so startPairing's connect() resolves to this access

    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });

    // Run the REAL pairing handshake. Provisional: L=inA, R=inB.
    const started = await startPairing();
    expect(started, 'pairing started with two ports').toBe(true);

    // The user presses a pad on the unit they want as LEFT — and they press the
    // unit that was provisionally bound to 'R' (inB). finishPairing then SWAPS:
    // L=inB, R=inA. This is the path that used to kill inB's handler.
    press(inB, 81);

    // Bind a clip-player to the freshly-paired units (the card's onPaired flow).
    bindLaunchpadToClip(NODE_ID);

    // Now press the LEFT physical unit (inB, the card top-left clip) → it MUST
    // launch lane 0 (proves the LEFT input handler survived the swap).
    press(inB, 81); // padNote(0,7) → lane 0, slot 0
    expect(queued()?.[0], 'LEFT unit (inB) launches lane 0 after the swap').toBe(0);

    unbindLaunchpad();
  });
});

// ===========================================================================
// KEYS mode (dual-Launchpad note/keyboard + clip-record). Pair-only v1. The
// launchpad binding is a global singleton with no engine, so the record capture
// reads the playhead from clip-playhead (which the engine normally publishes);
// tests set it directly via setLanePlayhead + step the LED render loop manually
// (hoisted.tick) to drive the arm→record + true-replace state machine.
// ===========================================================================
describe('KEYS mode — entry (hold REC/OVERDUB on R deck + double-tap a clip on L)', () => {
  const noteRec = () => liveData().noteRec as
    | { lane: number; slot: number; armed: boolean; recording: boolean; overdub: boolean }
    | null
    | undefined;

  it('hold note-REC + double-tap a clip enters KEYS overdub OFF; a single tap while held does NOT launch', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    sim.press('R', DECK_KEYS_REC_COL, DECK_KEYS_ROW); // hold note-REC (deck row 1)
    expect(__test_mode().keysRecHeld).toBe(true);
    // first tap: suppressed (no launch, still session).
    sim.press('L', 0, yForLane(0));
    expect(queued()?.[0] ?? null, 'single tap while held does NOT launch').toBeNull();
    expect(__test_mode().mode).toBe('session');
    // second tap (same clip, same tick window) → enter KEYS.
    sim.press('L', 0, yForLane(0));
    expect(__test_mode().mode).toBe('keys');
    expect(__test_mode().keysClipIndex).toBe(0);
    expect(noteRec()!.overdub, 'hold-REC entry = overdub OFF').toBe(false);
    expect(noteRec()!.recording).toBe(false);
    // the clip is launched (queued immediate) so KEYS opens with it playing.
    expect(queued()![0]).toBe(0);
  });

  it('hold note-OVERDUB → KEYS overdub ON', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    sim.press('R', DECK_KEYS_OVERDUB_COL, DECK_KEYS_ROW);
    sim.press('L', 0, yForLane(0));
    sim.press('L', 0, yForLane(0));
    expect(__test_mode().mode).toBe('keys');
    expect(noteRec()!.overdub, 'hold-OVERDUB entry = overdub ON').toBe(true);
  });

  it('entry MATERIALIZES a default clip when the slot is empty', () => {
    seedClipPlayer({ clips: {} });
    bindLaunchpadToClip(NODE_ID);
    sim.press('R', DECK_KEYS_REC_COL, DECK_KEYS_ROW);
    sim.press('L', 2, yForLane(1)); // empty pad lane1 slot2
    sim.press('L', 2, yForLane(1));
    const idx = clipIndex(2, 1);
    expect((liveData().clips as Record<string, unknown>)[String(idx)], 'clip materialized').toBeTruthy();
    expect(__test_mode().keysClipIndex).toBe(idx);
  });
});

describe('KEYS mode — live audition + record capture', () => {
  const noteRec = () => liveData().noteRec as
    | { armed: boolean; recording: boolean; overdub: boolean }
    | null
    | undefined;
  const clipAt = (idx: number) => (liveData().clips as Record<string, NoteClipRecord>)[String(idx)];
  function enterKeysVia(hold: number = DECK_KEYS_REC_COL, slot = 0, lane = 0) {
    sim.press('R', hold, DECK_KEYS_ROW);
    sim.press('L', slot, yForLane(lane));
    sim.press('L', slot, yForLane(lane));
    sim.release('R', hold, DECK_KEYS_ROW);
  }

  it('a keyboard press in KEYS pushes a live-audition note (transport-independent)', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    enterKeysVia();
    drainAudition(NODE_ID); // discard anything from setup
    // press keyboard pad (L, x=2, y=1) → col 2 row 0 → midi = root(48)+2 = 50.
    sim.press('L', 2, 1);
    const ev = drainAudition(NODE_ID);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ lane: 0, midi: 50, on: true });
    sim.release('L', 2, 1);
    expect(drainAudition(NODE_ID)[0]).toMatchObject({ midi: 50, on: false });
  });

  it('QUEUE-REC arms (flashing yellow) then records on the loop wrap; a keypress lands in the clip', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    seedTimelorde(0);
    bindLaunchpadToClip(NODE_ID);
    enterKeysVia();
    // tap QUEUE-REC (L bottom row) → armed (+ auto-start transport).
    sim.press('L', KEYS_QREC_COL, KEYS_CTRL_ROW);
    expect(noteRec()!.armed, 'QUEUE-REC arms').toBe(true);
    expect((livePatch.nodes['tl']!.params as Record<string, number>).running, 'auto-started').toBe(1);
    // simulate the lane playhead wrapping to step 0 → recording begins.
    setLanePlayhead(NODE_ID, 0, 0);
    hoisted.tick!();
    expect(noteRec()!.recording, 'records on the wrap').toBe(true);
    expect(noteRec()!.armed).toBe(false);
    // now sounding step 5; a keyboard press records there.
    setLanePlayhead(NODE_ID, 0, 5);
    sim.press('L', 3, 2); // col 3 row 1 → midi = 48 + 3 + 5 = 56
    sim.release('L', 3, 2);
    expect(clipAt(0).steps.some((s) => s.step === 5 && s.midi === 56), 'note captured at step 5').toBe(true);
  });

  it('TRUE-REPLACE (overdub OFF): the playhead crossing a step CLEARS its prior onsets', () => {
    seedClipPlayer({
      clips: { [clipIndex(0, 0)]: { ...noteClip(), steps: [{ step: 5, midi: 60, lengthSteps: 1 }] } },
    });
    bindLaunchpadToClip(NODE_ID);
    enterKeysVia(); // overdub OFF
    // force recording (arm + wrap).
    sim.press('L', KEYS_QREC_COL, KEYS_CTRL_ROW);
    setLanePlayhead(NODE_ID, 0, 0);
    hoisted.tick!();
    expect(noteRec()!.recording).toBe(true);
    // playhead approaches then enters step 5 → its prior note is punched out.
    setLanePlayhead(NODE_ID, 0, 4); hoisted.tick!();
    expect(clipAt(0).steps.some((s) => s.step === 5), 'note still there before crossing').toBe(true);
    setLanePlayhead(NODE_ID, 0, 5); hoisted.tick!();
    expect(clipAt(0).steps.some((s) => s.step === 5), 'true-replace cleared step 5').toBe(false);
  });

  it('OVERDUB ON is additive — the playhead crossing does NOT clear', () => {
    seedClipPlayer({
      clips: { [clipIndex(0, 0)]: { ...noteClip(), steps: [{ step: 5, midi: 60, lengthSteps: 1 }] } },
    });
    bindLaunchpadToClip(NODE_ID);
    enterKeysVia(DECK_KEYS_OVERDUB_COL); // overdub ON
    sim.press('L', KEYS_QREC_COL, KEYS_CTRL_ROW);
    setLanePlayhead(NODE_ID, 0, 0);
    hoisted.tick!();
    setLanePlayhead(NODE_ID, 0, 4); hoisted.tick!();
    setLanePlayhead(NODE_ID, 0, 5); hoisted.tick!();
    expect(clipAt(0).steps.some((s) => s.step === 5), 'overdub keeps the prior note').toBe(true);
  });

  it('MONO lane records first-note-priority (one note per step)', () => {
    seedClipPlayer({
      clips: { [clipIndex(0, 0)]: noteClip() },
      mono: [true, false, false, false, false, false, false, false],
    });
    bindLaunchpadToClip(NODE_ID);
    enterKeysVia();
    sim.press('L', KEYS_QREC_COL, KEYS_CTRL_ROW);
    setLanePlayhead(NODE_ID, 0, 0);
    hoisted.tick!();
    setLanePlayhead(NODE_ID, 0, 2);
    sim.press('L', 1, 2); sim.release('L', 1, 2); // midi 48+1+5 = 54
    sim.press('L', 3, 2); sim.release('L', 3, 2); // midi 56 — dropped (mono)
    const here = clipAt(0).steps.filter((s) => s.step === 2);
    expect(here, 'mono: one note per step').toHaveLength(1);
    expect(here[0].midi).toBe(54);
  });
});

describe('KEYS mode — EXIT / QUEUE-REC cancel / LEN return', () => {
  const noteRec = () => liveData().noteRec as { armed: boolean; recording: boolean } | null | undefined;
  function enterKeysVia() {
    sim.press('R', DECK_KEYS_REC_COL, DECK_KEYS_ROW);
    sim.press('L', 0, yForLane(0));
    sim.press('L', 0, yForLane(0));
    sim.release('R', DECK_KEYS_REC_COL, DECK_KEYS_ROW);
  }

  it('EXIT while recording stops record but STAYS in KEYS; a 2nd EXIT → session', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    enterKeysVia();
    sim.press('L', KEYS_QREC_COL, KEYS_CTRL_ROW);
    setLanePlayhead(NODE_ID, 0, 0);
    hoisted.tick!();
    expect(noteRec()!.recording).toBe(true);
    sim.press('L', KEYS_EXIT_COL, KEYS_CTRL_ROW); // 1st EXIT
    expect(__test_mode().mode, 'stays in KEYS').toBe('keys');
    expect(noteRec()!.recording, 'recording stopped').toBe(false);
    sim.press('L', KEYS_EXIT_COL, KEYS_CTRL_ROW); // 2nd EXIT
    expect(__test_mode().mode, 'back to session').toBe('session');
    expect(liveData().noteRec ?? null, 'noteRec cleared').toBeNull();
  });

  it('EXIT while queued-but-not-recording CANCELS the arm (idle KEYS)', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    enterKeysVia();
    sim.press('L', KEYS_QREC_COL, KEYS_CTRL_ROW);
    expect(noteRec()!.armed).toBe(true);
    sim.press('L', KEYS_EXIT_COL, KEYS_CTRL_ROW);
    expect(__test_mode().mode, 'stays in KEYS').toBe('keys');
    expect(noteRec()!.armed, 'arm cancelled').toBe(false);
  });

  it('QUEUE-REC re-tap while armed cancels the arm', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    enterKeysVia();
    sim.press('L', KEYS_QREC_COL, KEYS_CTRL_ROW);
    expect(noteRec()!.armed).toBe(true);
    sim.press('L', KEYS_QREC_COL, KEYS_CTRL_ROW);
    expect(noteRec()!.armed).toBe(false);
  });

  it('OVERDUB control toggles the overdub flag', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    enterKeysVia(); // overdub OFF
    sim.press('L', KEYS_OVERDUB_COL, KEYS_CTRL_ROW);
    expect((liveData().noteRec as { overdub: boolean }).overdub).toBe(true);
    sim.press('L', KEYS_OVERDUB_COL, KEYS_CTRL_ROW);
    expect((liveData().noteRec as { overdub: boolean }).overdub).toBe(false);
  });

  it('LEN opens the length page and EXITs back to KEYS (not the editor)', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    enterKeysVia();
    sim.press('L', KEYS_LEN_COL, KEYS_CTRL_ROW);
    expect(__test_mode().mode).toBe('lengthEdit');
    expect(__test_mode().lengthReturnMode).toBe('keys');
    // a block tap sets the length (R length page still works).
    sim.press('R', 1, 0); sim.release('R', 1, 0); // block 2 → 32 steps
    expect((liveData().clips as Record<string, NoteClipRecord>)['0'].lengthSteps).toBe(32);
    // EXIT (top scene on R) → back to KEYS.
    sim.cc('R', sceneCcForRow(EDIT_EXIT_SCENE_ROW), 127);
    expect(__test_mode().mode, 'LEN EXIT returns to KEYS').toBe('keys');
  });
});

describe('KEYS mode — arranger guard + render', () => {
  it('QUEUE-REC is blocked while the arranger is record-armed', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() }, recording: true });
    bindLaunchpadToClip(NODE_ID);
    // enter KEYS (recording=true is the ARRANGER field, not noteRec).
    sim.press('R', DECK_KEYS_REC_COL, DECK_KEYS_ROW);
    sim.press('L', 0, yForLane(0));
    sim.press('L', 0, yForLane(0));
    sim.release('R', DECK_KEYS_REC_COL, DECK_KEYS_ROW);
    sim.press('L', KEYS_QREC_COL, KEYS_CTRL_ROW);
    expect((liveData().noteRec as { armed: boolean }).armed, 'blocked by the arranger').toBe(false);
  });

  it('KEYS repaints BOTH units (keyboard + playhead) each tick', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    seedTimelorde(1);
    bindLaunchpadToClip(NODE_ID);
    sim.press('R', DECK_KEYS_REC_COL, DECK_KEYS_ROW);
    sim.press('L', 0, yForLane(0));
    sim.press('L', 0, yForLane(0));
    sim.release('R', DECK_KEYS_REC_COL, DECK_KEYS_ROW);
    hoisted.tick!();
    // both units light their keyboard band (y=1..6) — a mid pad is non-black.
    const l = sim.ledAt('L', padNote(0, 3));
    const r = sim.ledAt('R', padNote(0, 3));
    expect((l?.[0] ?? 0) + (l?.[1] ?? 0) + (l?.[2] ?? 0), 'L keyboard lit').toBeGreaterThan(0);
    expect((r?.[0] ?? 0) + (r?.[1] ?? 0) + (r?.[2] ?? 0), 'R keyboard lit').toBeGreaterThan(0);
    // the top row (playhead strip) is painted on both units.
    expect(sim.ledAt('L', padNote(0, KEYS_PH_ROW)), 'L playhead strip painted').not.toBeNull();
  });
});
