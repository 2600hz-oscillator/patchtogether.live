// packages/web/src/lib/control/launchpad/launchpad-scene-repeats.test.ts
//
// SCENE REPEATS on the single-unit Launchpad — the owner's 3-button, two-hands
// gesture: HOLD the permanent GRID button + HOLD a scene-launch button → the
// 8×8 becomes the orange REPEAT-COUNT view for that scene; taps set the count
// (pad k = k repeats, pad 64 = infinite); releasing either button returns to
// the grid. Drives the REAL launchpad-device sim + the REAL graph store
// (scheduler clock mocked so the LED loop is stepped manually) — same harness
// as launchpad-single-unit.test.ts. Also pins the PURE repeat-view mapping +
// the frame paint truth (pads 1..N lit === the stored count).

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
  __test_resetBinding,
  __test_setDeployment,
  __test_mode,
} from './launchpad-control.svelte';
import {
  repeatPadOrdinal,
  repeatCountForOrdinal,
  repeatLitCount,
  computeSingleGridFrame,
  RGB_REPEAT,
  RGB_SCENE,
  type PermanentTopOpts,
} from './launchpad-map';
import { SCENE_CCS, padNote, CC_DOWN, CC_TOP_SPARE_8 } from './launchpad-sysex';
import { clearPlayheads } from '$lib/audio/modules/clip-playhead';
import { clearAudition } from '$lib/audio/modules/clip-audition';
import {
  CLIP_LANES,
  clipIndex,
  defaultNoteClip,
  laneAutomationArmed,
  type ClipPlayerData,
  type NoteClipRecord,
} from '$lib/audio/modules/clip-types';
import { readSceneLaunch } from '$lib/audio/modules/clip-scene-repeats';

const NODE_ID = 'cp1';
const CC_VIEW_GRID = CC_DOWN; // 92 — the permanent GRID button
const CC_SHIFT = CC_TOP_SPARE_8; // 98
const G_SCROLL_DOWN = 7; // grid-shift right column, bottom = scene-window DOWN
const sceneCc = (sceneIndex: number) => SCENE_CCS[sceneIndex];
/** The pad at 1-indexed row-major ordinal k (upper-left = 1). */
const padForOrdinal = (k: number) => ({ x: (k - 1) % 8, y: 7 - Math.floor((k - 1) / 8) });

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
function liveData() {
  return livePatch.nodes[NODE_ID]!.data as ClipPlayerData;
}
function repeatsMap() {
  return (liveData().sceneRepeats ?? {}) as Record<string, number>;
}
function queued() {
  return liveData().queued as (number | 'stop' | null)[] | undefined;
}

const TOP: PermanentTopOpts = {
  view: 'grid',
  keysActive: false,
  transportRunning: true,
  shift: { latched: false, held: false },
  canUndo: false,
  canRedo: false,
};

// ===========================================================================
// PURE — the repeat-view mapping + paint truth.
// ===========================================================================
describe('PURE repeat-view mapping (row-major from the upper-left)', () => {
  it('repeatPadOrdinal: upper-left = 1, second in the top row = 2, bottom-right = 64', () => {
    expect(repeatPadOrdinal(0, 7)).toBe(1);
    expect(repeatPadOrdinal(1, 7)).toBe(2);
    expect(repeatPadOrdinal(7, 7)).toBe(8);
    expect(repeatPadOrdinal(0, 6)).toBe(9);
    expect(repeatPadOrdinal(7, 0)).toBe(64);
    expect(repeatPadOrdinal(-1, 0)).toBeNull();
    expect(repeatPadOrdinal(0, 8)).toBeNull();
  });
  it('repeatCountForOrdinal: pad k = k repeats, pad 64 = INFINITE (0)', () => {
    expect(repeatCountForOrdinal(1)).toBe(1);
    expect(repeatCountForOrdinal(16)).toBe(16);
    expect(repeatCountForOrdinal(63)).toBe(63);
    expect(repeatCountForOrdinal(64)).toBe(0);
  });
  it('repeatLitCount: N lights pads 1..N; infinite/invalid lights ALL 64', () => {
    expect(repeatLitCount(16)).toBe(16);
    expect(repeatLitCount(1)).toBe(1);
    expect(repeatLitCount(63)).toBe(63);
    expect(repeatLitCount(0)).toBe(64);
    expect(repeatLitCount(64)).toBe(64);
    expect(repeatLitCount(-2)).toBe(64);
  });
});

describe('PURE frame paint — the LED truth IS the stored count', () => {
  function litOrdinals(count: number): number[] {
    const frame = computeSingleGridFrame(undefined, {
      top: TOP,
      repeatView: { count, sceneIndex: 0 },
    });
    const lit: number[] = [];
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const led = frame.leds.get(padNote(x, y))!;
        if (led[0] + led[1] + led[2] > 0) {
          expect(led).toEqual(RGB_REPEAT); // every lit pad is the system orange
          lit.push(repeatPadOrdinal(x, y)!);
        }
      }
    }
    return lit.sort((a, b) => a - b);
  }
  it('count 16 → EXACTLY pads 1..16 lit orange (the top two rows)', () => {
    expect(litOrdinals(16)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
  });
  it('count 1 → only the upper-left pad; count 63 → all but pad 64', () => {
    expect(litOrdinals(1)).toEqual([1]);
    expect(litOrdinals(63)).toEqual(Array.from({ length: 63 }, (_, i) => i + 1));
  });
  it('INFINITE (0) → ALL 64 pads lit', () => {
    expect(litOrdinals(0)).toHaveLength(64);
  });
  it('the HELD scene button paints bright amber regardless of content', () => {
    const frame = computeSingleGridFrame(undefined, {
      top: TOP,
      repeatView: { count: 4, sceneIndex: 2 },
    });
    expect(frame.leds.get(SCENE_CCS[2])).toEqual(RGB_SCENE);
  });
});

// ===========================================================================
// GESTURE — HOLD GRID + HOLD a scene button on the real sim.
// ===========================================================================
describe('SINGLE Grid — the 3-button repeat-count gesture', () => {
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

  function seedAndBind(data: Record<string, unknown> = { clips: { [clipIndex(0, 0)]: noteClip(), [clipIndex(1, 0)]: noteClip() } }) {
    seedClipPlayer(data);
    bindLaunchpadToClip(NODE_ID);
  }
  /** HOLD GRID (press without release). */
  const holdGrid = () => sim.cc('L', CC_VIEW_GRID, 127);
  const releaseGrid = () => sim.cc('L', CC_VIEW_GRID, 0);
  const holdScene = (i: number) => sim.cc('L', sceneCc(i), 127);
  const releaseScene = (i: number) => sim.cc('L', sceneCc(i), 0);
  const tapPad = (k: number) => {
    const p = padForOrdinal(k);
    sim.press('L', p.x, p.y);
    sim.release('L', p.x, p.y);
  };

  it('GRID-hold + scene-hold ENTERS the repeat view WITHOUT launching', () => {
    seedAndBind();
    holdGrid();
    expect(__test_mode().gridHeldSingle).toBe(true);
    holdScene(0);
    expect(__test_mode().repeatViewSlot).toBe(0);
    // SELECT-ONLY: the scene press must NOT have queued a launch.
    expect(queued() ?? new Array(CLIP_LANES).fill(null)).toEqual(new Array(CLIP_LANES).fill(null));
    expect(readSceneLaunch(liveData())).toBeNull();
  });

  it('taps set the count (pad k = k repeats); pad 64 = back to INFINITE; live per-key writes', () => {
    seedAndBind();
    holdGrid();
    holdScene(0);
    tapPad(5);
    expect(repeatsMap()).toEqual({ '0': 5 });
    tapPad(16); // re-tap = overwrite, still one key
    expect(repeatsMap()).toEqual({ '0': 16 });
    tapPad(64); // infinite → key deleted
    expect(repeatsMap()).toEqual({});
    // Taps never launched anything.
    expect(queued() ?? new Array(CLIP_LANES).fill(null)).toEqual(new Array(CLIP_LANES).fill(null));
  });

  it('releasing the SCENE button exits back to the grid (taps launch again)', () => {
    seedAndBind();
    holdGrid();
    holdScene(0);
    releaseScene(0);
    expect(__test_mode().repeatViewSlot).toBeNull();
    releaseGrid();
    expect(__test_mode().gridHeldSingle).toBe(false);
    // Normal grid behavior restored: a pad tap launches.
    sim.press('L', 0, 7); // lane 0, slot 0 (transposed grid, top-left)
    expect(queued()![0]).toBe(0);
  });

  it('releasing GRID exits too (either held button ends the view)', () => {
    seedAndBind();
    holdGrid();
    holdScene(1);
    expect(__test_mode().repeatViewSlot).toBe(1);
    releaseGrid();
    expect(__test_mode().repeatViewSlot).toBeNull();
    expect(__test_mode().gridHeldSingle).toBe(false);
    // The still-held scene button's RELEASE after GRID went up is inert.
    releaseScene(1);
    expect(queued() ?? new Array(CLIP_LANES).fill(null)).toEqual(new Array(CLIP_LANES).fill(null));
  });

  it('SCROLL-AWARE (owner case): with the window scrolled, the held button edits the CORRECT scene slot', () => {
    // Content down to scene 8 so the window can scroll.
    seedAndBind({
      clips: { [clipIndex(0, 0)]: noteClip(), [clipIndex(8, 0)]: noteClip() },
    });
    // Slide the window down once via the grid-shift SCR▼ (hold shift so the
    // release never latches).
    sim.cc('L', CC_SHIFT, 127);
    sim.cc('L', sceneCc(G_SCROLL_DOWN), 127);
    sim.cc('L', sceneCc(G_SCROLL_DOWN), 0);
    sim.cc('L', CC_SHIFT, 0);
    expect(__test_mode().sceneScrollOffset).toBe(1);
    // HOLD GRID + the TOP scene button now edits scene offset+0 = slot 1.
    holdGrid();
    holdScene(0);
    expect(__test_mode().repeatViewSlot).toBe(1);
    tapPad(2);
    expect(repeatsMap()).toEqual({ '1': 2 });
    // And a lower button maps position-relatively too (button 7 → slot 8).
    holdScene(7);
    expect(__test_mode().repeatViewSlot).toBe(8);
    tapPad(3);
    expect(repeatsMap()).toEqual({ '1': 2, '8': 3 });
  });

  it('NO shift-arm collision: SHIFT + GRID toggles lane 1 automation arm — never the hold or a view change', () => {
    seedAndBind();
    sim.cc('L', CC_SHIFT, 127); // hold shift
    sim.cc('L', CC_VIEW_GRID, 127); // SHIFT+top-row col 1 = lane 1 arm toggle
    sim.cc('L', CC_VIEW_GRID, 0);
    sim.cc('L', CC_SHIFT, 0);
    expect(laneAutomationArmed(liveData(), 1)).toBe(true);
    expect(__test_mode().gridHeldSingle, 'the consumed press never arms the hold').toBe(false);
    expect(__test_mode().repeatViewSlot).toBeNull();
    // And the scene column under shift stays the palette, not the repeat view.
    sim.cc('L', CC_SHIFT, 127);
    holdScene(0); // = COPY arm, not a repeat view
    expect(__test_mode().repeatViewSlot).toBeNull();
    sim.cc('L', sceneCc(0), 0);
    sim.cc('L', CC_SHIFT, 0);
  });

  it('LED truth: the painted bar tracks the STORED count live while tapping', () => {
    seedAndBind();
    holdGrid();
    holdScene(0);
    tapPad(3);
    hoisted.tick!(); // step the render loop
    const lit = (k: number) => {
      const p = padForOrdinal(k);
      const led = sim.ledAt('L', padNote(p.x, p.y));
      return !!led && led[0] + led[1] + led[2] > 0;
    };
    expect(lit(1)).toBe(true);
    expect(lit(3)).toBe(true);
    expect(lit(4), 'pad 4 dark for count 3').toBe(false);
    expect(lit(64)).toBe(false);
    tapPad(64); // infinite → all 64
    hoisted.tick!();
    expect(lit(4)).toBe(true);
    expect(lit(64)).toBe(true);
    // Release both → the normal grid paint returns (pad 64 goes dark again —
    // scene 7 column 7 has no clip).
    releaseScene(0);
    releaseGrid();
    hoisted.tick!();
    expect(lit(64)).toBe(false);
  });

  it('LED truth with modifiers active: the repeat view paints the plain SCENE column (no paste pulse, no palette) — presses are select-only', () => {
    // The reachable modifier states during the hold: a STICKY paste arm left
    // pending before the gesture, and shift engaged MID-hold. (A shift latched
    // BEFORE the GRID press can never enter the view — that press is the
    // SHIFT+top-row arm toggle by design.) In both states every scene press
    // while GRID is held is select-only, so the column must not advertise the
    // paste-target pulse or the shift palette.
    seedAndBind({ clips: { [clipIndex(0, 0)]: noteClip(), [clipIndex(2, 0)]: noteClip() } });
    const latch = () => { sim.cc('L', CC_SHIFT, 127); sim.cc('L', CC_SHIFT, 0); };
    // Load a SCENE buffer + leave PASTE sticky-armed (the no-shift column would
    // now pulse the amber scene-buffer colour on every in-range scene).
    latch();
    sim.cc('L', sceneCc(0), 127); // COPY arm
    sim.cc('L', sceneCc(0), 0);
    latch(); // unlatch — sticky
    sim.cc('L', sceneCc(2), 127); // whole-scene copy source
    sim.cc('L', sceneCc(2), 0);
    latch();
    sim.cc('L', sceneCc(1), 127); // PASTE arm
    sim.cc('L', sceneCc(1), 0);
    latch(); // unlatch — sticky paste, scene buffer loaded
    expect(__test_mode().armedRightAction).toBe('paste');
    holdGrid();
    holdScene(0);
    expect(__test_mode().repeatViewSlot, 'GRID-hold outranks the sticky paste arm').toBe(0);
    expect(__test_mode().armedRightAction, 'the arm was NOT consumed by the select-only press').toBe('paste');
    hoisted.tick!();
    expect(sim.ledAt('L', SCENE_CCS[0]), 'held anchor = bright amber').toEqual([112, 81, 21]);
    expect(sim.ledAt('L', SCENE_CCS[5]), 'empty scene row DARK — no paste-target pulse').toEqual([0, 0, 0]);
    // Engage shift MID-hold: still the plain scene paint, never the palette
    // (SCENE_CCS[5] would be the yellow LEN button under the palette).
    sim.cc('L', CC_SHIFT, 127);
    hoisted.tick!();
    expect(sim.ledAt('L', SCENE_CCS[5]), 'no palette under mid-hold shift').toEqual([0, 0, 0]);
    sim.cc('L', CC_SHIFT, 0);
    releaseScene(0);
    releaseGrid();
    // The sticky paste-target pulse returns once the hold ends.
    hoisted.tick!();
    const after = sim.ledAt('L', SCENE_CCS[5])!;
    expect(
      after[0] + after[1] + after[2],
      'paste pulse (either blink phase) returns after the hold',
    ).toBeGreaterThan(0);
  });

  it('scene COPY/PASTE carries the repeat count with the scene (full replace; countless source clears)', () => {
    seedAndBind({
      clips: {
        [clipIndex(2, 0)]: noteClip(), // source scene 2 (will carry ×5)
        [clipIndex(3, 0)]: noteClip(), // countless source scene 3
        [clipIndex(5, 1)]: noteClip(), // target scene 5 (pre-existing ×9)
      },
      sceneRepeats: { '2': 5, '5': 9 },
    });
    const latch = () => { sim.cc('L', CC_SHIFT, 127); sim.cc('L', CC_SHIFT, 0); };
    const copyScene = (idx: number) => {
      latch();
      sim.cc('L', sceneCc(0), 127); // COPY (shift palette index 0)
      sim.cc('L', sceneCc(0), 0);
      latch(); // unlatch — COPY is sticky
      sim.cc('L', sceneCc(idx), 127); // no-shift scene button = whole-scene source
      sim.cc('L', sceneCc(idx), 0);
    };
    const pasteSceneAt = (idx: number) => {
      latch();
      sim.cc('L', sceneCc(1), 127); // PASTE (shift palette index 1)
      sim.cc('L', sceneCc(1), 0);
      latch(); // unlatch — PASTE is sticky
      sim.cc('L', sceneCc(idx), 127);
      sim.cc('L', sceneCc(idx), 0);
    };
    copyScene(2);
    pasteSceneAt(5); // ×5 travels with the scene; the target's ×9 is replaced
    expect(repeatsMap()).toEqual({ '2': 5, '5': 5 });
    copyScene(3); // a COUNTLESS scene…
    pasteSceneAt(5); // …full-replace CLEARS the target's count (no ghost ×5)
    expect(repeatsMap()).toEqual({ '2': 5 });
  });

  it('a plain scene launch (no GRID hold) still launches AND bumps the sceneLaunch marker', () => {
    seedAndBind();
    sim.cc('L', sceneCc(0), 127);
    expect(queued()![0]).toBe(0);
    expect(readSceneLaunch(liveData())).toEqual({ slot: 0, n: 1 });
    sim.cc('L', sceneCc(0), 0);
    sim.cc('L', sceneCc(0), 127); // relaunch bumps n (fresh count semantics)
    expect(readSceneLaunch(liveData())?.n).toBe(2);
  });
});
