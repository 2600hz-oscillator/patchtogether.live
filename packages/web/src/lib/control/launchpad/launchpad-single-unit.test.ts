// packages/web/src/lib/control/launchpad/launchpad-single-unit.test.ts
//
// SINGLE-UNIT (S2b) mode for the Launchpad clip-launcher — the 4-VIEW surface
// (Grid / Clip / Arranger / Control) over a PERMANENT top-CC nav row, with KEYS
// as a Clip sub-view + a built-in arp, hybrid shift latch/hold, Grid-shift
// tap-to-arm, per-clip div + per-lane swing, and launchpad-scoped undo/redo.
//
// The owner-locked PAIR invariant (L = clip matrix ALWAYS LIVE; R = deck/editor)
// must hold byte-for-byte — the 4-view surface exists ONLY in single mode. This
// file pins the pair regression first, then exercises the single-mode surface
// through the REAL launchpad-device sim + the REAL graph store (mocking only the
// scheduler clock so the LED loop can be stepped).

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
  installSimulatedLaunchpadSingle,
  __test_resetLaunchpad,
  isSingleBound,
  isPairBound,
  type SimulatedLaunchpad,
} from './launchpad-device.svelte';
import {
  bindLaunchpadToClip,
  unbindLaunchpad,
  boundClipNode,
  setLaunchpadView,
  launchpadDeployment,
  launchpadActiveView,
  __test_resetBinding,
  __test_setDeployment,
  __test_mode,
} from './launchpad-control.svelte';
import {
  clipIndexToGridPad,
  DECK_EDIT_COL,
  CC_TRANSPORT,
  CC_EDIT_FOLLOW,
  colTopCc,
  // performance-deck (CONTROL view)
  DECK_RESET_COL,
  DECK_RESET_ROW,
  DECK_MONO_ROW,
  DECK_MUTE_ROW,
  DECK_RATE_ROW,
  CTRL_TEMPO_ROW,
  CTRL_TEMPO_DOWN_COL,
  CTRL_TEMPO_UP_COL,
  CTRL_STOP_ALL_COL,
  CTRL_ARRANGE_ROW,
  CTRL_REC_COL,
  CTRL_SONG_COL,
  // KEYS controls
  KEYS_QREC_COL,
  KEYS_EXIT_COL,
  KEYS_PANIC_COL,
  KEYS_CTRL_ROW,
} from './launchpad-map';
import { RATE_MULTS } from '$lib/audio/modules/clip-clock';
import { setLanePlayhead, clearPlayheads } from '$lib/audio/modules/clip-playhead';
import { drainAudition, clearAudition } from '$lib/audio/modules/clip-audition';
import {
  SCENE_CCS,
  padNote,
  LP_HEIGHT,
  CC_TOP_SPARE_8,
  CC_UP,
  CC_DOWN,
  CC_LEFT,
  CC_RIGHT,
  CC_SESSION,
  CC_TOP_SPARE_6,
  CC_TOP_SPARE_7,
} from './launchpad-sysex';
import {
  CLIP_LANES,
  clipIndex,
  defaultNoteClip,
  laneSwing,
  SCALE_NAMES,
  type NoteClipRecord,
} from '$lib/audio/modules/clip-types';

const NODE_ID = 'cp1';

// Permanent top-row CC roles (identical in every view).
const CC_TRANSPORT_TOP = CC_UP; // 91
const CC_VIEW_GRID = CC_DOWN; // 92
const CC_VIEW_CLIP = CC_LEFT; // 93
const CC_VIEW_ARRANGER = CC_RIGHT; // 94
const CC_VIEW_CONTROL = CC_SESSION; // 95
const CC_UNDO = CC_TOP_SPARE_6; // 96
const CC_REDO = CC_TOP_SPARE_7; // 97
const CC_SHIFT = CC_TOP_SPARE_8; // 98

// Grid-shift right-column scene indices (0 = top).
const G_COPY = 0;
const G_PASTE = 1;
const G_CLIPDIV = 2;
const G_SWING_UP = 3;
const G_SWING_DOWN = 4;
const G_LEN = 5;
const G_PASTE_REV = 6;
const G_NOW = 7;
// Clip right-column scene indices.
const C_DOUBLE = 0;
const C_LENGTH = 1;
const C_FOLLOW = 2;
const C_KEYS = 3;
const C_ROW_UP = 4;
const C_ROW_DOWN = 5;
const C_STEP_LEFT = 6;
const C_STEP_RIGHT = 7;
// Keys no-shift right column (scale-select + arp toggle).
const K_ARP_TOGGLE = 7;
// Keys +shift right column (arp controls).
const KA_DIV_UP = 0;
const KA_UP = 2;
const KA_DOWN = 3;
const KA_UPDOWN = 4;
const KA_RANGE_UP = 5;
const KA_LATCH = 7;

const sceneCc = (sceneIndex: number) => SCENE_CCS[sceneIndex];
// L matrix maps lane 0 → the TOP physical row (pair helper, still used in pair tests).
const yForLane = (lane: number) => CLIP_LANES - 1 - lane;
const sceneRowCc = (row: number) => SCENE_CCS[LP_HEIGHT - 1 - row];

function clearPatch() {
  for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
  for (const k of Object.keys(livePatch.edges)) delete livePatch.edges[k];
}
function noteClip(): NoteClipRecord {
  return defaultNoteClip();
}
function clipWithNote(step = 0, midi = 60): NoteClipRecord {
  const c = noteClip();
  c.steps = [{ step, midi, velocity: 100, lengthSteps: 1 }];
  return c;
}
function seedClipPlayer(data: Record<string, unknown>) {
  clearPatch();
  livePatch.nodes[NODE_ID] = {
    id: NODE_ID, type: 'clipplayer', domain: 'audio', position: { x: 0, y: 0 }, params: {}, data,
  } as never;
}
function seedTimelorde(running: number, bpm = 120) {
  livePatch.nodes['tl'] = {
    id: 'tl', type: 'timelorde', domain: 'audio', position: { x: 0, y: 0 }, params: { running, bpm }, data: {},
  } as never;
}
function liveData() {
  return livePatch.nodes[NODE_ID]!.data as Record<string, unknown>;
}
function queued() {
  return liveData().queued as (number | 'stop' | null)[] | undefined;
}
function clipsOf() {
  return liveData().clips as Record<string, NoteClipRecord>;
}
// Press the SINGLE grid pad for a clip at (slot, lane) — the TRANSPOSED layout.
function pressClip(sim: SimulatedLaunchpad, slot: number, lane: number) {
  const p = clipIndexToGridPad(clipIndex(slot, lane));
  sim.press('L', p.x, p.y);
}
const tempoBpm = () => (livePatch.nodes['tl']!.params as Record<string, number>).bpm;
const tlRunning = () => (livePatch.nodes['tl']!.params as Record<string, number>).running;

beforeEach(() => {
  hoisted.tick = null;
  __test_resetBinding();
  __test_resetLaunchpad();
  clearPatch();
  clearPlayheads(NODE_ID);
  clearAudition(NODE_ID);
});

// ===========================================================================
// PAIR-MODE REGRESSION GUARD — the locked invariant must NOT shift. With a real
// PAIR installed the deployment is 'pair', the matrix is always L, and none of
// the single-mode 4-view surface applies.
// ===========================================================================
describe('PAIR regression — the single 4-view surface does not change pair behaviour', () => {
  let sim: SimulatedLaunchpad;
  beforeEach(async () => {
    sim = await installSimulatedLaunchpad();
  });

  it('a freshly-bound pair reports the PAIR deployment (default), never single', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    expect(isPairBound()).toBe(true);
    expect(isSingleBound()).toBe(false);
    expect(launchpadDeployment()).toBe('pair');
    expect(__test_mode().deployment).toBe('pair');
  });

  it('L launches + R deck still work exactly as before (matrix on L, deck on R)', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    seedTimelorde(0);
    bindLaunchpadToClip(NODE_ID);
    sim.press('L', 0, yForLane(0)); // L matrix
    expect(queued()![0]).toBe(0);
    sim.cc('R', CC_TRANSPORT, 127); // R deck transport
    expect(tlRunning()).toBe(1);
  });

  it('CC 98 in PAIR mode is the editor FOLLOW toggle — never a view switch', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    sim.press('R', DECK_EDIT_COL, 0);
    sim.press('L', 0, yForLane(0));
    sim.release('R', DECK_EDIT_COL, 0);
    expect(__test_mode().mode).toBe('edit');
    expect(__test_mode().followOn).toBe(true);
    sim.cc('R', CC_EDIT_FOLLOW, 127);
    expect(__test_mode().followOn, 'CC 98 still = FOLLOW in pair editor').toBe(false);
    expect(launchpadDeployment()).toBe('pair');
  });

  it('setLaunchpadView() is a no-op in pair mode', () => {
    seedClipPlayer({ clips: {} });
    bindLaunchpadToClip(NODE_ID);
    setLaunchpadView('control');
    expect(launchpadDeployment()).toBe('pair');
  });

  it('two fast L taps of the same clip in pair just launch — no view/edit change', () => {
    seedClipPlayer({
      clips: { [clipIndex(0, 0)]: noteClip() },
      playing: [0, null, null, null, null, null, null, null],
    });
    bindLaunchpadToClip(NODE_ID);
    sim.press('L', 0, yForLane(0)); // playing → queue stop
    expect(queued()![0]).toBe('stop');
    sim.press('L', 0, yForLane(0));
    expect(__test_mode().mode, 'pair never double-taps to a view').toBe('session');
    expect(launchpadDeployment()).toBe('pair');
  });

  it('pair-L top CC 91 toggles MUTE lane 0 (not an arm); a press still launches', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    sim.cc('L', colTopCc(0), 127); // pair-L top row = per-lane MUTE
    expect((liveData().muted as boolean[] | undefined)?.[0]).toBe(true);
    sim.press('L', 0, yForLane(0));
    expect(queued()![0], 'L press still launches (mute ≠ stop)').toBe(0);
  });

  it('the pair render still paints BOTH units (L matrix + R deck)', () => {
    seedClipPlayer({
      clips: { [clipIndex(0, 0)]: noteClip() },
      playing: [0, null, null, null, null, null, null, null],
    });
    seedTimelorde(1);
    bindLaunchpadToClip(NODE_ID);
    hoisted.tick!();
    const l = sim.ledAt('L', padNote(0, yForLane(0)));
    expect(l).not.toBeNull();
    expect(l![0] + l![1] + l![2]).toBeGreaterThan(0);
    expect(sim.ledAt('R', 11)).not.toBeNull(); // R deck EDIT pad
  });
});

// ===========================================================================
// SINGLE — bind + the transposed GRID view (channel-per-column).
// ===========================================================================
describe('SINGLE — Grid view (transposed clip matrix + scene/row launch)', () => {
  let sim: SimulatedLaunchpad;
  beforeEach(async () => {
    sim = await installSimulatedLaunchpadSingle();
    __test_setDeployment('single', 'grid');
  });

  it('binds ONE device to the L slot (single-bound, not pair-bound), Grid default', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    expect(boundClipNode()).toBe(NODE_ID);
    expect(isSingleBound()).toBe(true);
    expect(isPairBound()).toBe(false);
    expect(launchpadDeployment()).toBe('single');
    expect(launchpadActiveView()).toBe('grid');
  });

  it('a grid pad launches its clip via the TRANSPOSED coordinate (x = lane)', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip(), [clipIndex(1, 1)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    pressClip(sim, 0, 0);
    expect(queued()![0]).toBe(0);
    pressClip(sim, 1, 1); // slot 1, lane 1
    expect(queued()![1]).toBe(1);
  });

  it('the scene column (no shift) fans a slot out across ALL lanes (a scene/row)', () => {
    seedClipPlayer({ clips: { [clipIndex(2, 0)]: noteClip(), [clipIndex(2, 1)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    sim.cc('L', sceneCc(2), 127); // scene index 2 → slot 2 across all lanes
    expect(queued()![0]).toBe(2);
    expect(queued()![1]).toBe(2);
    expect(queued()![2]).toBe('stop'); // no clip in that slot → stop
  });

  it('pressing a playing clip queues a stop', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() }, playing: [0, null, null, null, null, null, null, null] });
    bindLaunchpadToClip(NODE_ID);
    pressClip(sim, 0, 0);
    expect(queued()![0]).toBe('stop');
  });

  it('a DOUBLE-TAP selects the clip + switches to Clip view (and reverts the lane)', () => {
    const idx = clipIndex(1, 1);
    seedClipPlayer({ clips: { [idx]: noteClip() } });
    seedTimelorde(1);
    bindLaunchpadToClip(NODE_ID);
    pressClip(sim, 1, 1); // 1st tap → launch immediately
    expect(queued()![1], 'first tap launched').toBe(1);
    expect(__test_mode().singleView).toBe('grid');
    pressClip(sim, 1, 1); // 2nd tap → select + Clip view
    expect(__test_mode().singleView, 'double-tap → Clip view').toBe('clip');
    expect(__test_mode().selectedClipIndex, 'selected the double-tapped clip').toBe(idx);
    expect(queued()![1], 'the queued start was reverted (double-tap does not change play state)').toBeNull();
  });

  it('a DOUBLE-TAP of a PLAYING clip keeps it playing even after the stop applied (NOW) [regression]', () => {
    const idx = clipIndex(1, 1);
    seedClipPlayer({ clips: { [idx]: noteClip() }, playing: [null, 1, null, null, null, null, null, null] });
    seedTimelorde(1);
    bindLaunchpadToClip(NODE_ID);
    pressClip(sim, 1, 1); // 1st tap of a PLAYING clip → queues a stop
    // simulate the engine applying that stop before the 2nd tap (immediate: NOW /
    // QNT-off). Whole-array reassignment — the synced store rejects index writes.
    liveData().playing = [null, null, null, null, null, null, null, null];
    pressClip(sim, 1, 1); // 2nd tap (double-tap) → Clip view AND must RESTART the clip
    expect(__test_mode().singleView).toBe('clip');
    expect(queued()![1], 'double-tap restarted the clip — play state preserved in both directions').toBe(1);
  });

  it('paints the transposed matrix + the permanent top row on the lone device', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() }, playing: [0, null, null, null, null, null, null, null] });
    seedTimelorde(1);
    bindLaunchpadToClip(NODE_ID);
    hoisted.tick!();
    const p = clipIndexToGridPad(clipIndex(0, 0));
    const led = sim.ledAt('L', padNote(p.x, p.y));
    expect(led).not.toBeNull();
    expect(led![0] + led![1] + led![2]).toBeGreaterThan(0);
    // The permanent top row is lit (the active GRID button + shift button).
    const gridBtn = sim.ledAt('L', CC_VIEW_GRID);
    expect((gridBtn?.[0] ?? 0) + (gridBtn?.[1] ?? 0) + (gridBtn?.[2] ?? 0)).toBeGreaterThan(0);
  });
});

// ===========================================================================
// SINGLE — the PERMANENT TOP ROW is intercepted first in every view.
// ===========================================================================
describe('SINGLE — permanent top row (transport / views / undo / redo)', () => {
  let sim: SimulatedLaunchpad;
  beforeEach(async () => {
    sim = await installSimulatedLaunchpadSingle();
    __test_setDeployment('single', 'grid');
  });

  it('transport toggles from ANY view (grid + control)', () => {
    seedClipPlayer({ clips: {} });
    seedTimelorde(0);
    bindLaunchpadToClip(NODE_ID);
    sim.cc('L', CC_TRANSPORT_TOP, 127);
    expect(tlRunning()).toBe(1);
    setLaunchpadView('control');
    sim.cc('L', CC_TRANSPORT_TOP, 127);
    expect(tlRunning()).toBe(0);
  });

  it('the 4 view buttons switch the active view', () => {
    seedClipPlayer({ clips: {} });
    bindLaunchpadToClip(NODE_ID);
    sim.cc('L', CC_VIEW_CLIP, 127);
    expect(__test_mode().singleView).toBe('clip');
    sim.cc('L', CC_VIEW_CONTROL, 127);
    expect(__test_mode().singleView).toBe('control');
    sim.cc('L', CC_VIEW_ARRANGER, 127);
    expect(__test_mode().singleView).toBe('arranger');
    sim.cc('L', CC_VIEW_GRID, 127);
    expect(__test_mode().singleView).toBe('grid');
  });

  it('a top-row CC is consumed by the permanent row (no launch side effect)', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    sim.cc('L', CC_VIEW_CONTROL, 127); // switch view — must NOT launch
    expect(queued()?.[0] ?? null).toBeNull();
  });

  it('undo/redo revert a persistent edit (swing) — canUndo/canRedo track the stacks', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    expect(__test_mode().canUndo).toBe(false);
    // Latch shift, nudge swing up (a persistent, undoable edit).
    sim.cc('L', CC_SHIFT, 127);
    sim.cc('L', CC_SHIFT, 0); // short tap → latched
    sim.cc('L', sceneCc(G_SWING_UP), 127);
    expect(laneSwing(liveData(), 0)).toBeCloseTo(0.02, 5);
    expect(__test_mode().canUndo, 'a persistent edit is undoable').toBe(true);
    sim.cc('L', CC_UNDO, 127);
    expect(laneSwing(liveData(), 0), 'undo reverted the swing edit').toBeCloseTo(0, 5);
    expect(__test_mode().canRedo).toBe(true);
    sim.cc('L', CC_REDO, 127);
    expect(laneSwing(liveData(), 0), 'redo re-applied it').toBeCloseTo(0.02, 5);
  });
});

// ===========================================================================
// SINGLE — SHIFT hybrid latch/hold.
// ===========================================================================
describe('SINGLE — shift latch vs hold', () => {
  let sim: SimulatedLaunchpad;
  beforeEach(async () => {
    sim = await installSimulatedLaunchpadSingle();
    __test_setDeployment('single', 'grid');
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: clipWithNote() } });
    bindLaunchpadToClip(NODE_ID);
  });

  it('a SHORT tap toggles the latch; a second tap unlatches', () => {
    sim.cc('L', CC_SHIFT, 127);
    sim.cc('L', CC_SHIFT, 0); // tap → latched
    expect(__test_mode().shiftLatched).toBe(true);
    expect(__test_mode().shiftHeldSingle).toBe(false);
    sim.cc('L', CC_SHIFT, 127);
    sim.cc('L', CC_SHIFT, 0); // tap → unlatched
    expect(__test_mode().shiftLatched).toBe(false);
  });

  it('a HOLD (ticks between press + release) is momentary — no latch on release', () => {
    sim.cc('L', CC_SHIFT, 127);
    expect(__test_mode().shiftHeldSingle).toBe(true);
    for (let i = 0; i < 15; i++) hoisted.tick!(); // long hold (> DOUBLE_TAP_TICKS)
    sim.cc('L', CC_SHIFT, 0);
    expect(__test_mode().shiftHeldSingle).toBe(false);
    expect(__test_mode().shiftLatched, 'a long hold does not latch').toBe(false);
  });

  it('while shift is HELD, the scene column is the grid-shift palette (arm COPY)', () => {
    sim.cc('L', CC_SHIFT, 127); // hold
    sim.cc('L', sceneCc(G_COPY), 127); // arm COPY (only reachable under shift)
    expect(__test_mode().armedRightAction).toBe('copy');
  });
});

// ===========================================================================
// SINGLE — GRID-shift tap-to-ARM (copy / paste / paste-rev / clip-div / len) +
// swing nudge + NOW.
// ===========================================================================
describe('SINGLE — Grid-shift tap-to-arm + swing + now', () => {
  let sim: SimulatedLaunchpad;
  beforeEach(async () => {
    sim = await installSimulatedLaunchpadSingle();
    __test_setDeployment('single', 'grid');
  });
  // Latch shift once so the scene column is the grid-shift palette for the test.
  function latchShift() {
    sim.cc('L', CC_SHIFT, 127);
    sim.cc('L', CC_SHIFT, 0);
    expect(__test_mode().shiftLatched).toBe(true);
  }

  it('arm COPY → tap a loaded clip → buffer loaded + auto-disarm', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: clipWithNote(2, 67) } });
    bindLaunchpadToClip(NODE_ID);
    latchShift();
    sim.cc('L', sceneCc(G_COPY), 127);
    expect(__test_mode().armedRightAction).toBe('copy');
    pressClip(sim, 0, 0); // copy the loaded clip
    expect(__test_mode().bufferArmed).toBe(true);
    expect(__test_mode().bufferSourceIndex).toBe(clipIndex(0, 0));
    expect(__test_mode().armedRightAction, 'auto-disarmed after applying').toBeNull();
  });

  it('arm PASTE → tap an empty dest → the buffer clip is written there', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: clipWithNote(2, 67) } });
    bindLaunchpadToClip(NODE_ID);
    latchShift();
    sim.cc('L', sceneCc(G_COPY), 127);
    pressClip(sim, 0, 0); // copy
    sim.cc('L', sceneCc(G_PASTE), 127);
    expect(__test_mode().armedRightAction).toBe('paste');
    pressClip(sim, 1, 1); // paste into an empty slot
    const dest = clipsOf()[clipIndex(1, 1)];
    expect(dest).toBeTruthy();
    expect(dest.steps.some((st) => st.midi === 67)).toBe(true);
    expect(__test_mode().armedRightAction).toBeNull();
  });

  it('arm PASTE-REV → tap a dest → steps mirrored', () => {
    const src = noteClip();
    src.lengthSteps = 16;
    src.steps = [{ step: 0, midi: 60, velocity: 100, lengthSteps: 1 }];
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: src } });
    bindLaunchpadToClip(NODE_ID);
    latchShift();
    sim.cc('L', sceneCc(G_COPY), 127);
    pressClip(sim, 0, 0); // copy
    sim.cc('L', sceneCc(G_PASTE_REV), 127);
    pressClip(sim, 1, 1);
    const dest = clipsOf()[clipIndex(1, 1)];
    expect(dest.steps).toHaveLength(1);
    expect(dest.steps[0].step, 'reversed: 16 − 0 − 1 = 15').toBe(15);
  });

  it('PASTE with an EMPTY buffer does NOT arm', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: clipWithNote() } });
    bindLaunchpadToClip(NODE_ID);
    latchShift();
    sim.cc('L', sceneCc(G_PASTE), 127);
    expect(__test_mode().armedRightAction).toBeNull();
  });

  it('re-tapping an armed button disarms it', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: clipWithNote() } });
    bindLaunchpadToClip(NODE_ID);
    latchShift();
    sim.cc('L', sceneCc(G_COPY), 127);
    expect(__test_mode().armedRightAction).toBe('copy');
    sim.cc('L', sceneCc(G_COPY), 127); // re-tap → disarm
    expect(__test_mode().armedRightAction).toBeNull();
  });

  it('CLIP-DIV cycles a LOCAL preview per tap; ONE write commits on disarm', () => {
    const c = clipWithNote();
    c.lengthSteps = 16; // no div set → falls back to lane rate (default index 3)
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: c } });
    bindLaunchpadToClip(NODE_ID);
    latchShift();
    sim.cc('L', sceneCc(G_CLIPDIV), 127);
    expect(__test_mode().armedRightAction).toBe('clipDiv');
    pressClip(sim, 0, 0); // preview → div index 4 (3 + 1), NOT yet written
    expect(__test_mode().divPreview).toEqual({ clipIndex: clipIndex(0, 0), divIndex: 4 });
    expect(clipsOf()[clipIndex(0, 0)].div, 'not committed while armed').toBeUndefined();
    expect(__test_mode().armedRightAction, 'clip-div stays armed while cycling').toBe('clipDiv');
    // Disarm (re-tap the CLIP-DIV button) → the single committing write.
    sim.cc('L', sceneCc(G_CLIPDIV), 127);
    expect(clipsOf()[clipIndex(0, 0)].div, 'committed on disarm').toBe(4);
    expect(__test_mode().divPreview).toBeNull();
  });

  it('CLIP-DIV auto-disarm (timeout) commits the pending preview', () => {
    const c = clipWithNote();
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: c } });
    seedTimelorde(1);
    bindLaunchpadToClip(NODE_ID);
    latchShift();
    sim.cc('L', sceneCc(G_CLIPDIV), 127);
    pressClip(sim, 0, 0); // preview div 4
    for (let i = 0; i < 200; i++) hoisted.tick!(); // > ARM_TIMEOUT_TICKS
    expect(__test_mode().armedRightAction).toBeNull();
    expect(clipsOf()[clipIndex(0, 0)].div, 'timeout committed the preview').toBe(4);
  });

  it('LEN arm → tap a loaded clip → length-edit; EXIT returns to Grid', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: clipWithNote() } });
    bindLaunchpadToClip(NODE_ID);
    latchShift();
    sim.cc('L', sceneCc(G_LEN), 127);
    expect(__test_mode().armedRightAction).toBe('len');
    pressClip(sim, 0, 0);
    expect(__test_mode().mode).toBe('lengthEdit');
    expect(__test_mode().editClipIndex).toBe(clipIndex(0, 0));
    expect(__test_mode().lengthReturnView).toBe('grid');
    // EXIT (top scene) → back to Grid.
    sim.cc('L', sceneRowCc(LP_HEIGHT - 1), 127);
    expect(__test_mode().mode).toBe('session');
    expect(__test_mode().singleView).toBe('grid');
  });

  it('SWING+ / SWING− nudge swing[selectedChannel] by ±0.02 (undoable, direct — no arm)', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: clipWithNote() } }); // selectedClipIndex 0 → lane 0
    bindLaunchpadToClip(NODE_ID);
    latchShift();
    sim.cc('L', sceneCc(G_SWING_UP), 127);
    expect(__test_mode().armedRightAction, 'swing is a direct nudge, not an arm').toBeNull();
    expect(laneSwing(liveData(), 0)).toBeCloseTo(0.02, 5);
    sim.cc('L', sceneCc(G_SWING_UP), 127);
    expect(laneSwing(liveData(), 0)).toBeCloseTo(0.04, 5);
    sim.cc('L', sceneCc(G_SWING_DOWN), 127);
    sim.cc('L', sceneCc(G_SWING_DOWN), 127);
    expect(laneSwing(liveData(), 0)).toBeCloseTo(0, 5);
    expect(__test_mode().swingMeterDir, 'centered → green-flash meter dir').toBe('center');
  });

  it('NOW is a sticky toggle: clip taps launch immediate', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: clipWithNote() } });
    bindLaunchpadToClip(NODE_ID);
    latchShift();
    sim.cc('L', sceneCc(G_NOW), 127);
    expect(__test_mode().nowHeld).toBe(true);
    // Unlatch shift so a plain grid tap launches (shift-tap-armed clips are consumed).
    sim.cc('L', CC_SHIFT, 127);
    sim.cc('L', CC_SHIFT, 0);
    pressClip(sim, 0, 0);
    expect(queued()![0]).toBe(0);
    const imm = liveData().queuedImmediate as boolean[] | undefined;
    expect(imm?.[0]).toBe(true);
  });

  it('leaving Grid clears a pending arm (commits a clip-div preview)', () => {
    const c = clipWithNote();
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: c } });
    bindLaunchpadToClip(NODE_ID);
    latchShift();
    sim.cc('L', sceneCc(G_CLIPDIV), 127);
    pressClip(sim, 0, 0); // preview div 4
    setLaunchpadView('clip'); // leave Grid
    expect(__test_mode().armedRightAction).toBeNull();
    expect(clipsOf()[clipIndex(0, 0)].div, 'preview committed on leaving Grid').toBe(4);
  });
});

// ===========================================================================
// SINGLE — CLIP view (note editor on selectedClipIndex + right column).
// ===========================================================================
describe('SINGLE — Clip view', () => {
  let sim: SimulatedLaunchpad;
  beforeEach(async () => {
    sim = await installSimulatedLaunchpadSingle();
    __test_setDeployment('single', 'grid');
  });
  // Select clip 0 + switch to Clip view.
  function openClip(len = 16) {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: { ...noteClip(), lengthSteps: len } } });
    bindLaunchpadToClip(NODE_ID);
    setLaunchpadView('clip');
    expect(__test_mode().singleView).toBe('clip');
    expect(__test_mode().selectedClipIndex).toBe(0);
  }

  it('DOUBLE (right col) doubles the selected clip length', () => {
    openClip(8);
    sim.cc('L', sceneCc(C_DOUBLE), 127);
    expect(clipsOf()[clipIndex(0, 0)].lengthSteps).toBe(16);
  });

  it('LENGTH (right col) opens the length page; EXIT returns to Clip', () => {
    openClip();
    sim.cc('L', sceneCc(C_LENGTH), 127);
    expect(__test_mode().mode).toBe('lengthEdit');
    expect(__test_mode().lengthReturnView).toBe('clip');
    sim.cc('L', sceneRowCc(LP_HEIGHT - 1), 127); // EXIT
    expect(__test_mode().mode).toBe('session');
    expect(__test_mode().singleView).toBe('clip');
  });

  it('FOLLOW (right col) toggles the follow flag', () => {
    openClip();
    expect(__test_mode().followOn).toBe(true);
    sim.cc('L', sceneCc(C_FOLLOW), 127);
    expect(__test_mode().followOn).toBe(false);
  });

  it('KEYS (right col) enters KEYS for the selected clip', () => {
    openClip();
    seedTimelorde(1);
    sim.cc('L', sceneCc(C_KEYS), 127);
    expect(__test_mode().mode).toBe('keys');
    expect(__test_mode().keysClipIndex).toBe(clipIndex(0, 0));
  });

  it('ROW UP/DOWN scroll pitch ±1; shift = a page jump', () => {
    openClip(64);
    sim.cc('L', sceneCc(C_ROW_UP), 127);
    expect(__test_mode().editRowOffset).toBe(1);
    sim.cc('L', sceneCc(C_ROW_DOWN), 127);
    expect(__test_mode().editRowOffset).toBe(0);
    // shift → page jump (±8).
    sim.cc('L', CC_SHIFT, 127);
    sim.cc('L', CC_SHIFT, 0); // latch
    sim.cc('L', sceneCc(C_ROW_UP), 127);
    expect(__test_mode().editRowOffset).toBe(8);
  });

  it('STEP ◀/▶ scroll the window; shift = a block jump', () => {
    openClip(64);
    sim.cc('L', sceneCc(C_STEP_RIGHT), 127); // +1 (freezes follow)
    expect(__test_mode().editWindowStart).toBe(1);
    expect(__test_mode().followOn).toBe(false);
    sim.cc('L', CC_SHIFT, 127);
    sim.cc('L', CC_SHIFT, 0); // latch shift
    sim.cc('L', sceneCc(C_STEP_RIGHT), 127); // +8 block
    expect(__test_mode().editWindowStart).toBe(9);
  });

  it('the 8×8 note grid edits notes (toggle on); under shift it cycles velocity', () => {
    openClip(16);
    // toggle a note ON at the bottom-left editor cell (press + release).
    sim.press('L', 0, 0);
    sim.release('L', 0, 0);
    const clip = clipsOf()[clipIndex(0, 0)];
    expect(clip.steps.length, 'a note was added').toBeGreaterThan(0);
    const before = clip.steps[0].velocity;
    // shift → velocity-cycle the same note.
    sim.cc('L', CC_SHIFT, 127);
    sim.cc('L', CC_SHIFT, 0); // latch
    sim.press('L', 0, 0);
    const after = clipsOf()[clipIndex(0, 0)].steps[0].velocity;
    expect(after, 'shift cycled the velocity').not.toBe(before);
  });
});

// ===========================================================================
// SINGLE — KEYS sub-view (scale-select + arp); the top row still works.
// ===========================================================================
describe('SINGLE — KEYS sub-view (scale + arp)', () => {
  let sim: SimulatedLaunchpad;
  beforeEach(async () => {
    sim = await installSimulatedLaunchpadSingle();
    __test_setDeployment('single', 'grid');
  });
  const noteRec = () => liveData().noteRec as { armed?: boolean; recording?: boolean; overdub?: boolean } | null | undefined;
  function enterKeys() {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    seedTimelorde(1);
    bindLaunchpadToClip(NODE_ID);
    setLaunchpadView('clip');
    sim.cc('L', sceneCc(C_KEYS), 127); // Clip → KEYS
    expect(__test_mode().mode).toBe('keys');
  }

  it('a scale button writes clip.scale; CHROMATIC removes it', () => {
    enterKeys();
    sim.cc('L', sceneCc(1), 127); // scale index 1 = minor
    expect(clipsOf()[clipIndex(0, 0)].scale).toBe(SCALE_NAMES[1]);
    sim.cc('L', sceneCc(6), 127); // chromatic = the absence of a scale
    expect(clipsOf()[clipIndex(0, 0)].scale).toBeUndefined();
  });

  it('ARP toggle + param edits update the arp state', () => {
    enterKeys();
    expect(__test_mode().arpOn).toBe(false);
    sim.cc('L', sceneCc(K_ARP_TOGGLE), 127); // arp ON (no shift)
    expect(__test_mode().arpOn).toBe(true);
    // shift → the arp control column.
    sim.cc('L', CC_SHIFT, 127);
    sim.cc('L', CC_SHIFT, 0); // latch
    sim.cc('L', sceneCc(KA_DOWN), 127);
    expect(__test_mode().arpDir).toBe('down');
    sim.cc('L', sceneCc(KA_UPDOWN), 127);
    expect(__test_mode().arpDir).toBe('updown');
    sim.cc('L', sceneCc(KA_UP), 127);
    expect(__test_mode().arpDir).toBe('up');
    const divBefore = __test_mode().arpDivIndex;
    sim.cc('L', sceneCc(KA_DIV_UP), 127);
    expect(__test_mode().arpDivIndex, 'arp div moved').not.toBe(divBefore);
    sim.cc('L', sceneCc(KA_RANGE_UP), 127);
    expect(__test_mode().arpRangeIndex).toBe(1);
    sim.cc('L', sceneCc(KA_LATCH), 127);
    expect(__test_mode().arpLatch).toBe(true);
  });

  it('with arp OFF a keyboard note auditions directly; with arp ON it feeds the arp pool', () => {
    enterKeys();
    drainAudition(NODE_ID); // discard entry noise
    // arp OFF: a keyboard press auditions immediately.
    sim.press('L', 2, 1); // keyboard col 2 row 0
    expect(drainAudition(NODE_ID).length, 'direct audition when arp is off').toBeGreaterThan(0);
    sim.release('L', 2, 1);
    drainAudition(NODE_ID);
    // arp ON: a press feeds the pool (no immediate direct audition), the loop sounds it.
    sim.cc('L', sceneCc(K_ARP_TOGGLE), 127);
    sim.press('L', 3, 1); // keyboard col 3 row 0
    expect(__test_mode().arpPoolLen, 'the held note is in the arp pool').toBeGreaterThan(0);
    expect(drainAudition(NODE_ID).length, 'no direct audition when arp is on').toBe(0);
    hoisted.tick!(); // the render loop advances the arp → it sounds a note
    expect(drainAudition(NODE_ID).some((e) => e.on), 'the arp sounded a note-on').toBe(true);
  });

  it('a view button EXITS KEYS to that view; transport still toggles from KEYS', () => {
    enterKeys();
    sim.cc('L', CC_TRANSPORT_TOP, 127); // transport toggles even inside KEYS
    expect(tlRunning()).toBe(0);
    sim.cc('L', CC_VIEW_GRID, 127); // a view button exits KEYS
    expect(__test_mode().mode).toBe('session');
    expect(__test_mode().singleView).toBe('grid');
  });

  it('QUEUE-REC → record on the wrap → a keypress lands in the clip', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    seedTimelorde(0);
    bindLaunchpadToClip(NODE_ID);
    setLaunchpadView('clip');
    sim.cc('L', sceneCc(C_KEYS), 127);
    sim.press('L', KEYS_QREC_COL, KEYS_CTRL_ROW);
    expect(noteRec()!.armed).toBe(true);
    setLanePlayhead(NODE_ID, 0, 0); // the wrap
    hoisted.tick!();
    expect(noteRec()!.recording).toBe(true);
    setLanePlayhead(NODE_ID, 0, 5);
    sim.press('L', 3, 2); // col 3 row 1 → midi 48 + 3 + 5 = 56
    sim.release('L', 3, 2);
    expect(clipsOf()[clipIndex(0, 0)].steps.some((s) => s.step === 5 && s.midi === 56)).toBe(true);
  });

  it('EXIT with a key held flushes the note-off (no stuck note) [regression]', () => {
    enterKeys(); // arp OFF → a keyboard press auditions directly
    drainAudition(NODE_ID); // discard entry noise
    sim.press('L', 2, 1); // hold a keyboard note
    const ons = drainAudition(NODE_ID).filter((e) => e.on);
    expect(ons.length, 'the held note sounded').toBeGreaterThan(0);
    const heldMidi = ons[0]!.midi;
    sim.press('L', KEYS_EXIT_COL, KEYS_CTRL_ROW); // idle EXIT → session
    expect(__test_mode().mode).toBe('session');
    expect(
      drainAudition(NODE_ID).some((e) => !e.on && e.midi === heldMidi),
      'EXIT flushed the held note-off',
    ).toBe(true);
  });

  it('PANIC stops the arp: offs its note + clears the (latched) pool [regression]', () => {
    enterKeys();
    sim.cc('L', sceneCc(K_ARP_TOGGLE), 127); // arp ON
    sim.press('L', 3, 1); // hold a note → into the arp pool
    expect(__test_mode().arpPoolLen).toBeGreaterThan(0);
    hoisted.tick!(); // the arp sounds a note
    drainAudition(NODE_ID);
    sim.press('L', KEYS_PANIC_COL, KEYS_CTRL_ROW); // PANIC
    expect(__test_mode().arpPoolLen, 'PANIC cleared the arp pool').toBe(0);
    hoisted.tick!();
    expect(
      drainAudition(NODE_ID).some((e) => e.on),
      'no new arp note-on after PANIC',
    ).toBe(false);
  });
});

// ===========================================================================
// SINGLE — CONTROL view (performance deck + re-homed transport/arranger pads).
// ===========================================================================
describe('SINGLE — Control view', () => {
  let sim: SimulatedLaunchpad;
  beforeEach(async () => {
    sim = await installSimulatedLaunchpadSingle();
    __test_setDeployment('single', 'control');
  });

  it('RESET / MONO / MUTE / RATE act on the deck rows', () => {
    seedClipPlayer({ clips: {}, rate: [3, 3, 3, 3, 3, 3, 3, 3] });
    bindLaunchpadToClip(NODE_ID);
    sim.press('L', DECK_RESET_COL, DECK_RESET_ROW);
    expect(liveData().resetNonce).toBe(1);
    sim.press('L', 3, DECK_MONO_ROW);
    expect((liveData().mono as boolean[])?.[3]).toBe(true);
    sim.press('L', 5, DECK_MUTE_ROW);
    expect((liveData().muted as boolean[])?.[5]).toBe(true);
    sim.press('L', 1, DECK_RATE_ROW);
    expect((liveData().rate as number[])?.[1]).toBe(4); // 1 → 2x
    // rate wraps a full lap.
    for (let i = 0; i < RATE_MULTS.length; i++) sim.press('L', 1, DECK_RATE_ROW);
    expect((liveData().rate as number[])?.[1]).toBe(4);
  });

  it('re-homed TEMPO ∓ / STOP-ALL / REC / SONG act on their dark grid pads', () => {
    seedClipPlayer({ clips: {}, playing: [0, null, null, null, null, null, null, null] });
    seedTimelorde(1, 120);
    bindLaunchpadToClip(NODE_ID);
    sim.press('L', CTRL_TEMPO_UP_COL, CTRL_TEMPO_ROW);
    expect(tempoBpm()).toBe(122);
    sim.press('L', CTRL_TEMPO_DOWN_COL, CTRL_TEMPO_ROW);
    sim.press('L', CTRL_TEMPO_DOWN_COL, CTRL_TEMPO_ROW);
    expect(tempoBpm()).toBe(118);
    sim.press('L', CTRL_STOP_ALL_COL, CTRL_TEMPO_ROW);
    expect((liveData().queued as (number | 'stop' | null)[]).every((q) => q === 'stop')).toBe(true);
    sim.press('L', CTRL_REC_COL, CTRL_ARRANGE_ROW);
    expect(liveData().recording).toBe(true);
    sim.press('L', CTRL_SONG_COL, CTRL_ARRANGE_ROW);
    expect(liveData().clipMode).toBe('arrangement');
  });

  it('the per-lane STOP scene column stops a playing lane', () => {
    const playing: (number | null)[] = new Array(CLIP_LANES).fill(null);
    playing[0] = 0; // lane 0 playing (scene index 7 = bottom = lane 0)
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() }, playing });
    bindLaunchpadToClip(NODE_ID);
    sim.cc('L', sceneCc(LP_HEIGHT - 1), 127); // scene index 7 → lane 0
    expect(queued()![0]).toBe('stop');
  });

  it('paints the deck frame on the lone device', () => {
    seedClipPlayer({ clips: {}, mono: [true, false, false, false, false, false, false, false] });
    seedTimelorde(0);
    bindLaunchpadToClip(NODE_ID);
    hoisted.tick!();
    const reset = sim.ledAt('L', padNote(DECK_RESET_COL, DECK_RESET_ROW));
    expect(reset![0] + reset![1] + reset![2]).toBeGreaterThan(0);
  });
});

// ===========================================================================
// SINGLE — ARRANGER view is inert (no pad/scene handlers), still paints.
// ===========================================================================
describe('SINGLE — Arranger view is inert', () => {
  let sim: SimulatedLaunchpad;
  beforeEach(async () => {
    sim = await installSimulatedLaunchpadSingle();
    __test_setDeployment('single', 'arranger');
  });

  it('pad + scene presses do nothing; the frame still paints + the top row works', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    seedTimelorde(0);
    bindLaunchpadToClip(NODE_ID);
    sim.press('L', 0, 0); // a pad — inert
    sim.cc('L', sceneCc(0), 127); // a scene — inert
    expect(queued()?.[0] ?? null, 'arranger is inert').toBeNull();
    // The permanent top row still works (transport).
    sim.cc('L', CC_TRANSPORT_TOP, 127);
    expect(tlRunning()).toBe(1);
    hoisted.tick!();
    const arrBtn = sim.ledAt('L', CC_VIEW_ARRANGER);
    expect((arrBtn?.[0] ?? 0) + (arrBtn?.[1] ?? 0) + (arrBtn?.[2] ?? 0), 'arranger button lit').toBeGreaterThan(0);
  });
});

// ===========================================================================
// SINGLE — unbind tears down the lone device.
// ===========================================================================
describe('SINGLE — unbind', () => {
  let sim: SimulatedLaunchpad;
  beforeEach(async () => {
    sim = await installSimulatedLaunchpadSingle();
    __test_setDeployment('single', 'grid');
  });

  it('unbind stops driving + a later press is a no-op', () => {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: noteClip() } });
    bindLaunchpadToClip(NODE_ID);
    unbindLaunchpad();
    expect(boundClipNode()).toBeNull();
    pressClip(sim, 0, 0);
    expect(queued()?.[0] ?? null).toBeNull();
  });
});
