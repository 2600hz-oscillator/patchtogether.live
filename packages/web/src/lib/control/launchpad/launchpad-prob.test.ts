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
  RGB_PROB_ORANGE,
  RGB_WHITE,
  probNoteRgb,
  probNoteRgbOrange,
  noteProbRgb,
  computeSingleClipFrame,
  computeSingleGridFrame,
  clipIndexToGridPad,
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
  clipDefaultProbEff,
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
/** Is lane 8 (index ARM_SHIFT_LANE = 7) automation-armed? The lane-8 arm pad is
 *  (7,7) — the SAME pad as prob-bar ordinal 8 (the 20% level). A shift-HELD tap
 *  there on a PROB page must set the probability, NOT arm lane 8. */
function lane8Armed(): boolean {
  const auto = (livePatch.nodes[NODE_ID]!.data as {
    automation?: { lanes?: Record<string, unknown> };
  }).automation;
  return !!(auto?.lanes && auto.lanes['7']);
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

  // FIX 1 (the masking gap): every test ABOVE releases shift before tapping a
  // level, so none exercise a shift-HELD level tap. Pad (7,7) = prob ordinal 8
  // (the 20% level) is ALSO the lane-8 arm pad, intercepted BEFORE the view
  // routing. Without the `!probEditHeld` guard on that interception, a shift-HELD
  // tap there is STOLEN to arm lane 8 and leaves the PROB page stranded.
  it('SHIFT STILL HELD + a level tap writes the note prob then auto-clears (regression: shift-held path)', () => {
    openClip();
    sim.cc('L', CC_SHIFT, 127); // hold shift — and KEEP it held
    sim.press('L', 0, 0); // open PROB for the root note
    expect(__test_mode().probEditActive).toBe(true);
    sim.press('L', 3, 4); // ordinal 28 = 70%, shift STILL HELD (row y=4 = ordinals 25..32)
    expect(probPadOrdinal(3, 4)).toBe(28);
    expect(__test_mode().probEditActive, 'auto-cleared even with shift held').toBe(false);
    expect(rootNoteProb()).toBeCloseTo(probLevelForOrdinal(28), 6);
  });

  it('SHIFT STILL HELD + the (7,7)=20% level pad sets the note prob and does NOT arm lane 8 (the stolen level)', () => {
    openClip();
    sim.cc('L', CC_SHIFT, 127); // hold shift — KEEP it held (the masked case)
    sim.press('L', 0, 0); // open PROB for the root note
    expect(__test_mode().probEditActive).toBe(true);
    expect(probPadOrdinal(7, 7)).toBe(8); // (7,7) = ordinal 8 = 20% AND the lane-8 arm pad
    sim.press('L', 7, 7); // the exact stolen pad, shift STILL HELD
    expect(__test_mode().probEditActive, 'PROB page auto-cleared (not stranded)').toBe(false);
    expect(rootNoteProb(), 'the 20% level was written to the note').toBeCloseTo(probLevelForOrdinal(8), 6);
    expect(lane8Armed(), 'the (7,7) tap was NOT stolen to arm lane 8').toBe(false);
  });
});

// ===========================================================================
// CLIP-DEFAULT PROBABILITY — the source-aware colour (noteProbRgb) + the ORANGE
// grid PROB page frame paint.
// ===========================================================================
describe('PURE source-aware note colour (noteProbRgb: purple = override, orange = clip default)', () => {
  const clipWithDefault = (defaultProb: number, notePrs: (number | undefined)[]): NoteClipRecord => ({
    ...defaultNoteClip(),
    defaultProb,
    steps: notePrs.map((p, i) => (p === undefined ? { step: i, midi: 60 } : { step: i, midi: 60, prob: p })),
  });
  it('a note WITHOUT an override under a clip default → ORANGE ramp (red dominates, blue floored)', () => {
    const clip = clipWithDefault(0.5, [undefined]);
    const rgb = noteProbRgb(clip, clip.steps[0]);
    expect(rgb).toEqual(probNoteRgbOrange(0.5));
    expect(rgb[0], 'red is the dominant channel').toBeGreaterThan(rgb[1]);
    expect(rgb[2], 'blue floored for orange').toBe(0);
  });
  it('a note WITH an override → PURPLE ramp (blue dominates), beating the clip default', () => {
    const clip = clipWithDefault(0.5, [0.25]);
    const rgb = noteProbRgb(clip, clip.steps[0]);
    expect(rgb).toEqual(probNoteRgb(0.25));
    expect(rgb[2], 'blue is the dominant channel').toBeGreaterThan(rgb[1]);
  });
  it('effective 100% → WHITE from either source', () => {
    expect(noteProbRgb(clipWithDefault(1, [undefined]), {})).toEqual(RGB_WHITE); // clip default 1
    expect(noteProbRgb({ ...defaultNoteClip() }, { prob: 1 })).toEqual(RGB_WHITE); // note override 1
  });
});

describe('PURE clip-PROB grid frame paint — computeSingleGridFrame(clipProbView) is ORANGE', () => {
  function litOrdinals(prob: number): { ords: number[]; allOrange: boolean } {
    const frame = computeSingleGridFrame(undefined, { top: { ...TOP, view: 'grid' }, clipProbView: { prob } });
    const ords: number[] = [];
    let allOrange = true;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const led = frame.leds.get(padNote(x, y))!;
        if (led[0] + led[1] + led[2] > 0) {
          const k = probPadOrdinal(x, y);
          expect(k, `lit pad (${x},${y}) is inside the top-5-row bar`).not.toBeNull();
          if (JSON.stringify(led) !== JSON.stringify(RGB_PROB_ORANGE)) allOrange = false;
          ords.push(k!);
        }
      }
    }
    return { ords: ords.sort((a, b) => a - b), allOrange };
  }
  it('clip default 25% → pads 1..10 lit ORANGE (top 5 rows); NOT the purple per-note colour', () => {
    const { ords, allOrange } = litOrdinals(probLevelToValue(10));
    expect(ords).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    expect(allOrange, 'every lit clip-PROB bar pad is orange, not purple').toBe(true);
    expect(RGB_PROB_ORANGE).not.toEqual(RGB_PROB); // the two pages are distinct hues
  });
  it('clip default 100% → all 40 top-5-row pads lit orange', () => {
    expect(litOrdinals(1).ords).toHaveLength(40);
  });
});

// ===========================================================================
// GESTURE — SHIFT + a Grid clip pad opens the CLIP-DEFAULT PROB page; a selector
// tap writes setClipDefaultProb + auto-returns. Arm still consumes; no-shift
// still launches.
// ===========================================================================
describe('SINGLE Grid — the SHIFT+clip CLIP-DEFAULT PROB page gesture', () => {
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
  /** Seed one clip at (slot 0, lane 0) and enter GRID view. */
  function openGrid() {
    seedClipPlayer({ clips: { [clipIndex(0, 0)]: clipWithRootNote() } });
    bindLaunchpadToClip(NODE_ID);
    setLaunchpadView('grid');
    expect(__test_mode().singleView).toBe('grid');
    expect(__test_mode().clipProbEditActive).toBe(false);
  }
  /** Press the grid pad for clip (slot 0, lane 0). */
  function pressClip00() {
    const p = clipIndexToGridPad(clipIndex(0, 0));
    sim.press('L', p.x, p.y);
  }
  function clipDefault(): number | undefined {
    return clipsOf()[clipIndex(0, 0)]!.defaultProb;
  }

  it('SHIFT + press a clip pad (no arm) opens the CLIP-DEFAULT PROB page', () => {
    openGrid();
    sim.cc('L', CC_SHIFT, 127);
    pressClip00();
    expect(__test_mode().clipProbEditActive).toBe(true);
    expect(__test_mode().clipProbClipIndex).toBe(clipIndex(0, 0));
  });

  it('SHIFT + press an EMPTY pad does NOT open the page (no clip to default)', () => {
    openGrid();
    sim.cc('L', CC_SHIFT, 127);
    const p = clipIndexToGridPad(clipIndex(1, 1)); // an empty slot
    sim.press('L', p.x, p.y);
    expect(__test_mode().clipProbEditActive).toBe(false);
  });

  it('a selector tap writes the clip default then AUTO-RETURNS to the grid', () => {
    openGrid();
    sim.cc('L', CC_SHIFT, 127);
    pressClip00(); // open the clip-PROB page
    sim.cc('L', CC_SHIFT, 0); // release shift
    expect(__test_mode().clipProbEditActive).toBe(true);
    sim.press('L', 0, 7); // pad (0,7) = ordinal 1 = 2.5%
    expect(__test_mode().clipProbEditActive).toBe(false); // auto-return
    expect(clipDefault()).toBeCloseTo(0.025, 6);
    expect(valueToProbLevel(clipDefault()!)).toBe(1);
  });

  it('a selector tap on pad 40 sets 100% → the defaultProb key is DELETED', () => {
    openGrid();
    // Drop to 2.5% first so there IS a key to delete.
    sim.cc('L', CC_SHIFT, 127);
    pressClip00();
    sim.cc('L', CC_SHIFT, 0);
    sim.press('L', 0, 7); // ordinal 1 = 2.5%
    expect(clipDefault()).toBeCloseTo(0.025, 6);
    // Re-open and set 100% via pad (7,3) = ordinal 40 → key deleted.
    sim.cc('L', CC_SHIFT, 127);
    pressClip00();
    sim.cc('L', CC_SHIFT, 0);
    sim.press('L', 7, 3); // ordinal 40 = 100%
    expect(__test_mode().clipProbEditActive).toBe(false);
    expect(clipDefault(), '100% deletes the defaultProb key').toBeUndefined();
  });

  it('a bottom-3-row tap CANCELS (clears the latch, no write)', () => {
    openGrid();
    sim.cc('L', CC_SHIFT, 127);
    pressClip00();
    sim.cc('L', CC_SHIFT, 0);
    expect(__test_mode().clipProbEditActive).toBe(true);
    sim.press('L', 3, 1); // y=1 → a bottom-3 inert pad → cancel
    expect(__test_mode().clipProbEditActive).toBe(false);
    expect(clipDefault(), 'no write on cancel').toBeUndefined();
  });

  it('the frame reflects the stored clip default (its bar lights to the level)', () => {
    openGrid();
    sim.cc('L', CC_SHIFT, 127);
    pressClip00();
    sim.cc('L', CC_SHIFT, 0);
    sim.press('L', 0, 6); // ordinal 9 → 22.5%
    // re-open: the bar should now light exactly probLitCount(defaultProb) pads.
    sim.cc('L', CC_SHIFT, 127);
    pressClip00();
    expect(__test_mode().clipProbEditActive).toBe(true);
    const eff = clipDefaultProbEff(clipsOf()[clipIndex(0, 0)]);
    expect(probLitCount(eff)).toBe(9);
  });

  it('SHIFT + an ARMED copy + clip CONSUMES the arm (copies) — NOT the PROB page', () => {
    openGrid();
    sim.cc('L', CC_SHIFT, 127); // hold shift
    sim.cc('L', sceneCc(0), 127); // grid-shift scene 0 = COPY → arm it
    expect(__test_mode().armedRightAction).toBe('copy');
    pressClip00(); // shift + armed + clip → consume the arm (copy), not open PROB
    expect(__test_mode().clipProbEditActive, 'armed press did not open the clip-PROB page').toBe(false);
    expect(__test_mode().bufferArmed, 'the clip was copied into the buffer').toBe(true);
    expect(__test_mode().armedRightAction, 'auto-disarmed after applying').toBeNull();
  });

  it('NO-SHIFT + clip still LAUNCHES (the page never opens without shift)', () => {
    openGrid();
    pressClip00(); // no shift
    expect(__test_mode().clipProbEditActive).toBe(false);
    // a launch/queue was applied to lane 0 (not a prob-page open).
    const q = (livePatch.nodes[NODE_ID]!.data as { queued?: (number | 'stop' | null)[] }).queued;
    expect(Array.isArray(q)).toBe(true);
  });

  // FIX 1 symmetry: the clip-default page already carries `!clipProbEditHeld` on
  // the lane-8 interception (commit ee35f9a3), so a shift-HELD level tap — even
  // on the (7,7)=20% level that doubles as the lane-8 arm pad — must set the clip
  // default and NOT arm lane 8. Mirrors the per-note regression above.
  it('SHIFT STILL HELD + the (7,7)=20% level pad sets the clip default and does NOT arm lane 8', () => {
    openGrid();
    sim.cc('L', CC_SHIFT, 127); // hold shift — KEEP it held
    pressClip00(); // open the clip-default PROB page
    expect(__test_mode().clipProbEditActive).toBe(true);
    expect(probPadOrdinal(7, 7)).toBe(8); // (7,7) = ordinal 8 = 20% AND the lane-8 arm pad
    sim.press('L', 7, 7); // shift STILL HELD
    expect(__test_mode().clipProbEditActive, 'clip-PROB page auto-cleared (not stranded)').toBe(false);
    expect(clipDefault(), 'the 20% level was written as the clip default').toBeCloseTo(
      probLevelForOrdinal(8),
      6,
    );
    expect(lane8Armed(), 'the (7,7) tap was NOT stolen to arm lane 8').toBe(false);
  });
});
