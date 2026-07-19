// packages/web/src/lib/control/launchpad/launchpad-prob.test.ts
//
// PER-NOTE PROBABILITY page on the single-unit Launchpad — the owner's gesture:
// SHIFT + press a step in the single Clip note editor LATCHES the PROB page (the
// 8×8 becomes a 40-level probability bar for that note, TOP 5 ROWS only); the next
// pad tap sets the note's probability and auto-returns to the clip view. Velocity
// relocates onto a held VEL modifier (the FOLLOW scene row) — see the
// launchpad-single-unit spec. Drives the REAL launchpad-device sim + REAL graph
// store (scheduler clock mocked so the LED loop is stepped) — same harness as
// launchpad-scene-repeats.test.ts. Also pins the PURE prob-bar mapping + paint.

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
  probPadOrdinal,
  probLevelForOrdinal,
  probLitCount,
  PROB_ROWS,
  RGB_PROB,
  RGB_WHITE,
  probNoteRgb,
  computeSingleClipFrame,
  type PermanentTopOpts,
} from './launchpad-map';
import { SCENE_CCS, padNote, CC_TOP_SPARE_8 } from './launchpad-sysex';
import { clearPlayheads } from '$lib/audio/modules/clip-playhead';
import { clearAudition } from '$lib/audio/modules/clip-audition';
import {
  clipIndex,
  defaultNoteClip,
  probLevelToValue,
  valueToProbLevel,
  PROB_LEVELS,
  type NoteClipRecord,
} from '$lib/audio/modules/clip-types';

const NODE_ID = 'cp1';
const CC_SHIFT = CC_TOP_SPARE_8; // 98
const C_FOLLOW = 2; // clip right-column scene index = the relocated VEL-hold row
const sceneCc = (sceneIndex: number) => SCENE_CCS[sceneIndex];

const TOP: PermanentTopOpts = {
  view: 'clip',
  keysActive: false,
  transportRunning: true,
  shift: { held: false },
  canUndo: false,
  canRedo: false,
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
function clipsOf() {
  return (livePatch.nodes[NODE_ID]!.data as { clips: Record<string, NoteClipRecord> }).clips;
}
function rootNoteProb(): number | undefined {
  return clipsOf()[clipIndex(0, 0)]!.steps.find((s) => s.step === 0 && s.midi === 48)?.prob;
}

// ===========================================================================
// PURE — the 40-level probability-bar mapping (TOP 5 rows only) + paint truth.
// ===========================================================================
describe('PURE prob-page mapping (top 5 rows, row-major from the upper-left)', () => {
  it('probPadOrdinal: (0,7) = 1, (7,7) = 8, (0,6) = 9, (7,3) = 40; bottom 3 rows null', () => {
    expect(probPadOrdinal(0, 7)).toBe(1);
    expect(probPadOrdinal(7, 7)).toBe(8);
    expect(probPadOrdinal(0, 6)).toBe(9);
    expect(probPadOrdinal(7, 3)).toBe(40); // last of the top 5 rows = PROB_LEVELS
    // the bottom 3 rows (y = 2, 1, 0) are inert
    expect(probPadOrdinal(0, 2)).toBeNull();
    expect(probPadOrdinal(7, 1)).toBeNull();
    expect(probPadOrdinal(0, 0)).toBeNull();
    // out of grid
    expect(probPadOrdinal(-1, 7)).toBeNull();
    expect(probPadOrdinal(0, 8)).toBeNull();
    expect(PROB_ROWS).toBe(5);
  });
  it('probLevelForOrdinal: pad k = k*2.5%, pad 40 = exactly 1.0 (100%)', () => {
    expect(probLevelForOrdinal(1)).toBeCloseTo(0.025, 10);
    expect(probLevelForOrdinal(20)).toBeCloseTo(0.5, 10);
    expect(probLevelForOrdinal(40)).toBe(1);
  });
  it('probLitCount: N lights pads 1..N (= valueToProbLevel); 100% lights all 40', () => {
    expect(probLitCount(probLevelToValue(10))).toBe(10);
    expect(probLitCount(1)).toBe(PROB_LEVELS); // 100% → all 40
    expect(probLitCount(0)).toBe(1); // a 0% note still shows level 1
    expect(probLitCount(0.5)).toBe(20);
  });
});

describe('PURE note colour = probability (probNoteRgb)', () => {
  it('100% → white; lower probability → a dimmer purple (never near-black)', () => {
    expect(probNoteRgb(1)).toEqual(RGB_WHITE);
    const low = probNoteRgb(0.05);
    const high = probNoteRgb(0.9);
    // purple-family: the blue channel dominates green
    expect(low[2]).toBeGreaterThan(low[1]);
    expect(high[2]).toBeGreaterThan(high[1]);
    // brighter with higher probability, but a low note stays visible
    expect(high[2]).toBeGreaterThan(low[2]);
    expect(low[0] + low[1] + low[2]).toBeGreaterThan(0);
  });
});

describe('PURE prob-page frame paint — computeSingleClipFrame(probView)', () => {
  function litOrdinals(prob: number): number[] {
    const frame = computeSingleClipFrame(clipWithRootNote(), { top: TOP, probView: { prob } });
    const lit: number[] = [];
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const led = frame.leds.get(padNote(x, y))!;
        if (led[0] + led[1] + led[2] > 0) {
          const k = probPadOrdinal(x, y);
          expect(k, `lit pad (${x},${y}) is inside the top-5-row bar`).not.toBeNull();
          expect(led).toEqual(RGB_PROB); // every lit bar pad is the prob purple
          lit.push(k!);
        }
      }
    }
    return lit.sort((a, b) => a - b);
  }
  it('prob 25% → EXACTLY pads 1..10 lit purple (top 5 rows); bottom 3 rows dark', () => {
    expect(litOrdinals(probLevelToValue(10))).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
  });
  it('prob 100% → ALL 40 top-5-row pads lit (never the bottom 3)', () => {
    expect(litOrdinals(1)).toHaveLength(40);
  });
});

// ===========================================================================
// GESTURE — SHIFT + step opens the PROB page; a selector tap writes + returns.
// ===========================================================================
describe('SINGLE Clip — the SHIFT+step PROB page gesture', () => {
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
    expect(__test_mode().probEditActive).toBe(false);
  }

  it('SHIFT + press a note step opens the PROB page (probEditActive)', () => {
    openClip();
    sim.cc('L', CC_SHIFT, 127); // hold shift
    sim.press('L', 0, 0); // the root note's pad (step 0, midi 48)
    expect(__test_mode().probEditActive).toBe(true);
  });

  it('SHIFT + press an EMPTY cell does NOT open the page (no note to set)', () => {
    openClip();
    sim.cc('L', CC_SHIFT, 127);
    sim.press('L', 3, 3); // an empty cell
    expect(__test_mode().probEditActive).toBe(false);
  });

  it('a selector tap writes the probability then AUTO-RETURNS to the clip view', () => {
    openClip();
    sim.cc('L', CC_SHIFT, 127);
    sim.press('L', 0, 0); // open PROB for the root note
    sim.cc('L', CC_SHIFT, 0); // release shift
    expect(__test_mode().probEditActive).toBe(true);
    // pad (0,7) = ordinal 1 = 2.5%.
    sim.press('L', 0, 7);
    expect(__test_mode().probEditActive).toBe(false); // auto-return
    expect(rootNoteProb()).toBeCloseTo(0.025, 6);
    // the LED bar for that note now lights exactly 1 pad
    expect(valueToProbLevel(rootNoteProb()!)).toBe(1);
  });

  it('a selector tap on pad 40 sets 100% → the prob key is DELETED (default)', () => {
    openClip();
    // Drop to 2.5% first so there IS a key to delete.
    sim.cc('L', CC_SHIFT, 127);
    sim.press('L', 0, 0);
    sim.cc('L', CC_SHIFT, 0);
    sim.press('L', 0, 7); // ordinal 1 = 2.5%
    expect(rootNoteProb()).toBeCloseTo(0.025, 6);
    // Re-open and set 100% via pad (7,3) = ordinal 40 → the key is deleted.
    sim.cc('L', CC_SHIFT, 127);
    sim.press('L', 0, 0);
    sim.cc('L', CC_SHIFT, 0);
    sim.press('L', 7, 3); // ordinal 40 = 100%
    expect(__test_mode().probEditActive).toBe(false);
    expect(rootNoteProb(), '100% deletes the prob key').toBeUndefined();
  });

  it('a bottom-3-row tap CANCELS (clears the latch, no write)', () => {
    openClip();
    sim.cc('L', CC_SHIFT, 127);
    sim.press('L', 0, 0);
    sim.cc('L', CC_SHIFT, 0);
    expect(__test_mode().probEditActive).toBe(true);
    sim.press('L', 3, 1); // y=1 → a bottom-3 (inert) pad → cancel
    expect(__test_mode().probEditActive).toBe(false);
    expect(rootNoteProb(), 'no write on cancel').toBeUndefined();
  });
});
