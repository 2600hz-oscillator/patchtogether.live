// packages/web/src/lib/control/launchpad/launchpad-play-every.test.ts
//
// PER-NOTE PLAY EVERY on the single-unit Launchpad — the owner's gesture: SHIFT +
// DOUBLE-tap a note (the second shift-tap on the SAME note, while the PROB page
// from the first tap is latched) ESCALATES to the PLAY-EVERY view: the 8×8's TOP
// ROW becomes 8 red pads (1..8), the current value lit; a top-row tap sets the
// note's play-every and auto-returns. Drives the REAL launchpad-device sim +
// REAL graph store (same harness as launchpad-prob.test.ts). Also pins the PURE
// ordinal mapping, the combined note colour (prob ⊕ red), and the frame paint.

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
  installSimulatedLaunchpadSingle,
  __test_resetLaunchpad,
  type SimulatedLaunchpad,
} from './launchpad-device.svelte';
import {
  bindLaunchpadToClip,
  setLaunchpadView,
  __test_resetBinding,
  __test_setDeployment,
  __test_mode,
} from './launchpad-control.svelte';
import {
  playEveryPadOrdinal,
  playEveryRgb,
  avgRgb,
  noteRgb,
  noteProbRgb,
  RGB_PLAY_EVERY_RED,
  RGB_WHITE,
  computeSingleClipFrame,
  type PermanentTopOpts,
  type Rgb,
} from './launchpad-map';
import { padNote, CC_TOP_SPARE_8 } from './launchpad-sysex';
import { clearPlayheads } from '$lib/audio/modules/clip-playhead';
import { clearAudition } from '$lib/audio/modules/clip-audition';
import { clipIndex, defaultNoteClip, type NoteClipRecord } from '$lib/audio/modules/clip-types';

const NODE_ID = 'cp1';
const CC_SHIFT = CC_TOP_SPARE_8; // 98
const TOP: PermanentTopOpts = {
  view: 'clip', keysActive: false, transportRunning: true,
  shift: { held: false }, canUndo: false, canRedo: false,
};

function clearPatch() {
  for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
  for (const k of Object.keys(livePatch.edges)) delete livePatch.edges[k];
}
/** A clip holding one note at step 0, midi 48 (= the default root → editor pad
 *  (0,0), so a shift-press there opens the PROB page for it). */
function clipWithRootNote(): NoteClipRecord {
  return { ...defaultNoteClip(), steps: [{ step: 0, midi: 48, velocity: 100, lengthSteps: 1 }] };
}
function seedClipPlayer(data: Record<string, unknown>) {
  clearPatch();
  livePatch.nodes[NODE_ID] = {
    id: NODE_ID, type: 'clipplayer', domain: 'audio', position: { x: 0, y: 0 }, params: {}, data,
  } as never;
}
function rootNotePlayEvery(): number | undefined {
  const clips = (livePatch.nodes[NODE_ID]!.data as { clips: Record<string, NoteClipRecord> }).clips;
  return clips[clipIndex(0, 0)]!.steps.find((s) => s.step === 0 && s.midi === 48)?.playEvery;
}

// ===========================================================================
// PURE — the play-every ordinal mapping + colour + frame paint.
// ===========================================================================
describe('PURE play-every mapping (top row only, 1..8)', () => {
  it('playEveryPadOrdinal: (0,7)=1 … (7,7)=8; every other pad null', () => {
    expect(playEveryPadOrdinal(0, 7)).toBe(1);
    expect(playEveryPadOrdinal(7, 7)).toBe(8);
    expect(playEveryPadOrdinal(3, 7)).toBe(4);
    expect(playEveryPadOrdinal(0, 6)).toBeNull(); // second row from top → inert
    expect(playEveryPadOrdinal(0, 0)).toBeNull();
    expect(playEveryPadOrdinal(-1, 7)).toBeNull();
    expect(playEveryPadOrdinal(8, 7)).toBeNull();
  });
});

describe('PURE play-every colour (red ∝ 1/N; averaged with prob when both)', () => {
  it('playEveryRgb dims with higher N (play-every-2 brightest, play-every-8 dimmest)', () => {
    const sum = (c: Rgb) => c[0] + c[1] + c[2];
    expect(sum(playEveryRgb(2))).toBeGreaterThan(sum(playEveryRgb(4)));
    expect(sum(playEveryRgb(4))).toBeGreaterThan(sum(playEveryRgb(8)));
    // red-dominant
    expect(playEveryRgb(2)[0]).toBeGreaterThan(playEveryRgb(2)[1]);
  });
  it('noteRgb: prob 1 + play-every 1 (default) → the plain probability colour (white)', () => {
    expect(noteRgb(undefined, { prob: 1 })).toEqual(RGB_WHITE);
    expect(noteRgb(undefined, {})).toEqual(RGB_WHITE);
  });
  it('noteRgb: prob 1 + play-every>1 → RED (∝ 1/N), NOT white', () => {
    expect(noteRgb(undefined, { playEvery: 2 })).toEqual(playEveryRgb(2));
    expect(noteRgb(undefined, { playEvery: 8 })).toEqual(playEveryRgb(8));
  });
  it('noteRgb: prob<1 AND play-every>1 → the AVERAGE of the prob colour and the red', () => {
    const ev = { prob: 0.25, playEvery: 3 };
    const expected = avgRgb(noteProbRgb(undefined, ev), playEveryRgb(3));
    expect(noteRgb(undefined, ev)).toEqual(expected);
  });
});

describe('PURE play-every frame paint — computeSingleClipFrame(playEveryView)', () => {
  it('paints EXACTLY the top row (8 pads), the current value the brightest', () => {
    const frame = computeSingleClipFrame(clipWithRootNote(), { top: TOP, playEveryView: { playEvery: 3 } });
    // Only the top row (y=7) carries play-every pads; the grid below is dark.
    let topLit = 0;
    let brightestX = -1;
    let brightestSum = -1;
    for (let x = 0; x < 8; x++) {
      const led = frame.leds.get(padNote(x, 7))!;
      const sum = led[0] + led[1] + led[2];
      if (sum > 0) topLit++;
      if (sum > brightestSum) { brightestSum = sum; brightestX = x; }
      expect(led[0], `pad (${x},7) is red-ish`).toBeGreaterThanOrEqual(led[2]);
    }
    expect(topLit, 'all 8 top-row pads carry a red indicator').toBe(8);
    expect(brightestX, 'play-every-3 → pad index 2 is the lit one').toBe(2);
    expect(frame.leds.get(padNote(2, 7))).toEqual(RGB_PLAY_EVERY_RED); // current = full red
  });
});

// ===========================================================================
// GESTURE — SHIFT + double-tap a note → play-every view; a top-row tap writes.
// ===========================================================================
describe('SINGLE Clip — the SHIFT + DOUBLE-tap PLAY EVERY view gesture', () => {
  let sim: SimulatedLaunchpad;
  beforeEach(async () => {
    hoisted.tick = null;
    __test_resetBinding();
    __test_resetLaunchpad();
    clearPatch();
    clearPlayheads(NODE_ID);
    clearAudition(NODE_ID);
    sim = await installSimulatedLaunchpadSingle();
    __test_setDeployment('single', 'grid');
  });
  function openClip() {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: clipWithRootNote() } });
    bindLaunchpadToClip(NODE_ID);
    setLaunchpadView('clip');
    expect(__test_mode().singleView).toBe('clip');
    expect(__test_mode().playEveryViewActive).toBe(false);
  }

  it('SHIFT + double-tap a note escalates the PROB page to the PLAY-EVERY view', () => {
    openClip();
    sim.cc('L', CC_SHIFT, 127); // hold shift
    sim.press('L', 0, 0); // tap 1 → opens the PROB page
    expect(__test_mode().probEditActive).toBe(true);
    expect(__test_mode().playEveryViewActive).toBe(false);
    sim.press('L', 0, 0); // tap 2 (shift still held) on the SAME note → escalate
    expect(__test_mode().probEditActive, 'prob page handed off').toBe(false);
    expect(__test_mode().playEveryViewActive, 'now in the play-every view').toBe(true);
  });

  it('a top-row tap sets the note’s play-every, then AUTO-RETURNS to the clip view', () => {
    openClip();
    sim.cc('L', CC_SHIFT, 127);
    sim.press('L', 0, 0); // prob page
    sim.press('L', 0, 0); // → play-every view
    sim.cc('L', CC_SHIFT, 0); // release shift
    expect(__test_mode().playEveryViewActive).toBe(true);
    sim.press('L', 2, 7); // top-row pad index 2 → play-every 3
    expect(__test_mode().playEveryViewActive, 'auto-return').toBe(false);
    expect(rootNotePlayEvery()).toBe(3);
  });

  it('top-row pad 0 (play-every 1) DELETES the key (back to every loop)', () => {
    openClip();
    // First set to 4.
    sim.cc('L', CC_SHIFT, 127);
    sim.press('L', 0, 0);
    sim.press('L', 0, 0);
    sim.cc('L', CC_SHIFT, 0);
    sim.press('L', 3, 7); // play-every 4
    expect(rootNotePlayEvery()).toBe(4);
    // Re-open and set back to 1 → key deleted.
    sim.cc('L', CC_SHIFT, 127);
    sim.press('L', 0, 0);
    sim.press('L', 0, 0);
    sim.cc('L', CC_SHIFT, 0);
    sim.press('L', 0, 7); // play-every 1
    expect(__test_mode().playEveryViewActive).toBe(false);
    expect(rootNotePlayEvery(), 'play-every 1 removes the key (byte-identical default)').toBeUndefined();
  });

  it('a NON-top-row tap CANCELS the play-every view (no write)', () => {
    openClip();
    sim.cc('L', CC_SHIFT, 127);
    sim.press('L', 0, 0);
    sim.press('L', 0, 0);
    sim.cc('L', CC_SHIFT, 0);
    expect(__test_mode().playEveryViewActive).toBe(true);
    sim.press('L', 3, 3); // a mid-grid pad (not the top row) → cancel
    expect(__test_mode().playEveryViewActive).toBe(false);
    expect(rootNotePlayEvery(), 'no write on cancel').toBeUndefined();
  });

  it('a SINGLE shift-tap (no double) still opens the PROB page, not play-every', () => {
    openClip();
    sim.cc('L', CC_SHIFT, 127);
    sim.press('L', 0, 0); // one shift-tap only
    expect(__test_mode().probEditActive).toBe(true);
    expect(__test_mode().playEveryViewActive).toBe(false);
  });
});
