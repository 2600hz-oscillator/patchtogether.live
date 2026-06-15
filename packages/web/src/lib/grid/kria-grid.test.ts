// packages/web/src/lib/grid/kria-grid.test.ts
//
// Integration test for the grid↔KRIA binding, driven through the REAL
// grid-device (simulated transport) + the REAL graph store. Mocks only the
// scheduler-clock so the LED render loop can be stepped manually. Also covers
// the PURE kria-grid-map (key→action + LED frame).

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
  bindGridToKria,
  unbindKriaGrid,
  boundKriaNode,
  gridView,
  __test_resetKriaBinding,
} from './kria-grid.svelte';
import {
  keyToAction,
  computeKriaLeds,
  defaultView,
  NAV_ROW,
  TRACK_KEYS,
  PARAM_KEYS,
  PATTERN_KEY,
  TRIG_ROW,
  LED_FULL,
  LED_DIM,
} from './kria-grid-map';
import {
  defaultPattern,
  activePattern,
  type KriaData,
  type KriaPattern,
} from '$lib/audio/modules/kria-types';
import { GRID_WIDTH } from './mext';

const NODE_ID = 'k1';

function clearPatch() {
  for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
  for (const k of Object.keys(livePatch.edges)) delete livePatch.edges[k];
}
function seedKria(data: KriaData) {
  clearPatch();
  livePatch.nodes[NODE_ID] = {
    id: NODE_ID, type: 'kria', domain: 'audio', position: { x: 0, y: 0 }, params: {}, data,
  } as never;
}
function liveData(): KriaData {
  return livePatch.nodes[NODE_ID]!.data as KriaData;
}
function frameIdx(x: number, y: number): number {
  return y * GRID_WIDTH + x;
}

// ───────────────────────── PURE map ─────────────────────────
describe('kria-grid-map: keyToAction', () => {
  it('nav row maps track / param / pattern keys', () => {
    const v = defaultView();
    expect(keyToAction(TRACK_KEYS[2], NAV_ROW, v)).toEqual({ kind: 'selectTrack', track: 2 });
    expect(keyToAction(PARAM_KEYS[1], NAV_ROW, v)).toEqual({ kind: 'selectPage', page: 'note' });
    expect(keyToAction(PATTERN_KEY, NAV_ROW, v)).toEqual({ kind: 'togglePatternPage' });
  });
  it('TRIG page toggles the step at the trig row', () => {
    const v = { ...defaultView(), page: 'trig' as const };
    expect(keyToAction(5, TRIG_ROW, v)).toEqual({ kind: 'toggleTrig', step: 5 });
    expect(keyToAction(5, 0, v)).toEqual({ kind: 'none' }); // not the trig row
  });
  it('NOTE page maps Y to a degree (top row = high degree)', () => {
    const v = { ...defaultView(), page: 'note' as const };
    // bottom editor row (y=6) = degree 0; one row up (y=5) = degree 1.
    expect(keyToAction(3, 6, v)).toEqual({ kind: 'setNote', step: 3, degree: 0 });
    expect(keyToAction(3, 5, v)).toEqual({ kind: 'setNote', step: 3, degree: 1 });
  });
  it('OCTAVE page maps Y to an octave (bottom = +0)', () => {
    const v = { ...defaultView(), page: 'octave' as const };
    expect(keyToAction(0, 6, v)).toEqual({ kind: 'setOctave', step: 0, octave: 0 });
    expect(keyToAction(0, 1, v)).toEqual({ kind: 'setOctave', step: 0, octave: 5 });
  });
  it('pattern page row 0 cues a pattern slot', () => {
    const v = { ...defaultView(), patternPage: true };
    expect(keyToAction(7, 0, v)).toEqual({ kind: 'cuePattern', slot: 7 });
    expect(keyToAction(7, 1, v)).toEqual({ kind: 'none' });
  });
});

describe('kria-grid-map: computeKriaLeds', () => {
  it('lights the selected track + page in the nav row', () => {
    const view = { track: 2, page: 'note' as const, patternPage: false };
    const frame = computeKriaLeds({
      pattern: defaultPattern(),
      view,
      playStep: -1,
      occupied: new Array(16).fill(false),
      active: 0,
      cued: null,
      blinkOn: true,
    });
    expect(frame[frameIdx(TRACK_KEYS[2], NAV_ROW)]).toBe(LED_FULL);
    expect(frame[frameIdx(TRACK_KEYS[0], NAV_ROW)]).toBe(LED_DIM);
    expect(frame[frameIdx(PARAM_KEYS[1], NAV_ROW)]).toBe(LED_FULL); // note page selected
  });
  it('lights trig steps that are ON', () => {
    const pat: KriaPattern = defaultPattern();
    pat.tracks[0]!.trig[4] = true;
    const frame = computeKriaLeds({
      pattern: pat,
      view: { track: 0, page: 'trig', patternPage: false },
      playStep: -1,
      occupied: new Array(16).fill(false),
      active: 0,
      cued: null,
      blinkOn: true,
    });
    expect(frame[frameIdx(4, TRIG_ROW)]).toBe(LED_FULL);
    expect(frame[frameIdx(5, TRIG_ROW)]).not.toBe(LED_FULL);
  });
});

// ───────────────────── live binding ─────────────────────
let sim: SimulatedGrid;
beforeEach(async () => {
  hoisted.tick = null;
  __test_resetKriaBinding();
  __test_resetGrid();
  clearPatch();
  sim = await installSimulatedGrid();
});

describe('grid → KRIA binding', () => {
  it('binds + restores default view', () => {
    seedKria({ active: 0, patterns: { "0": defaultPattern() } });
    bindGridToKria(NODE_ID);
    expect(boundKriaNode()).toBe(NODE_ID);
    expect(gridView()).toEqual(defaultView());
  });

  it('a TRIG pad press toggles the step in the live store', () => {
    seedKria({ active: 0, patterns: { "0": defaultPattern() } });
    bindGridToKria(NODE_ID);
    // Default view is track 0, TRIG page. Press step 6 on the trig row.
    sim.press(6, TRIG_ROW);
    const pat = activePattern(liveData())!;
    expect(pat.tracks[0]!.trig[6]).toBe(true);
    // Press again → toggles off.
    sim.press(6, TRIG_ROW);
    expect(activePattern(liveData())!.tracks[0]!.trig[6]).toBe(false);
  });

  it('selecting a track + NOTE page routes edits to that track', () => {
    seedKria({ active: 0, patterns: { "0": defaultPattern() } });
    bindGridToKria(NODE_ID);
    sim.press(TRACK_KEYS[1], NAV_ROW); // select track 2 (index 1)
    sim.press(PARAM_KEYS[1], NAV_ROW); // NOTE page
    expect(gridView().track).toBe(1);
    expect(gridView().page).toBe('note');
    // Bottom editor row (y=6) = degree 0 on step 2.
    sim.press(2, 5); // degree 1
    expect(activePattern(liveData())!.tracks[1]!.note[2]).toBe(1);
  });

  it('pattern page: cue a loaded slot', () => {
    seedKria({ active: 0, patterns: { "0": defaultPattern(), "1": defaultPattern() } });
    bindGridToKria(NODE_ID);
    sim.press(PATTERN_KEY, NAV_ROW); // open pattern page
    expect(gridView().patternPage).toBe(true);
    sim.press(1, 0); // cue slot 1
    expect(liveData().cued).toBe(1);
  });

  it('LED render loop repaints from KRIA state each tick', () => {
    const pat = defaultPattern();
    pat.tracks[0]!.trig[3] = true;
    seedKria({ active: 0, patterns: { "0": pat } });
    bindGridToKria(NODE_ID);
    expect(hoisted.tick).toBeTruthy();
    hoisted.tick!(); // one render pass
    expect(sim.ledAt(3, TRIG_ROW)).toBe(LED_FULL);
    // selected track 0 nav key full.
    expect(sim.ledAt(TRACK_KEYS[0], NAV_ROW)).toBe(LED_FULL);
  });

  it('unbind stops driving + blanks the grid', () => {
    seedKria({ active: 0, patterns: { "0": defaultPattern() } });
    bindGridToKria(NODE_ID);
    unbindKriaGrid();
    expect(boundKriaNode()).toBeNull();
    sim.press(6, TRIG_ROW); // no longer bound
    expect(activePattern(liveData())!.tracks[0]!.trig[6]).toBe(false);
  });

  it('key release does not trigger an action', () => {
    seedKria({ active: 0, patterns: { "0": defaultPattern() } });
    bindGridToKria(NODE_ID);
    sim.release(6, TRIG_ROW);
    expect(activePattern(liveData())!.tracks[0]!.trig[6]).toBe(false);
  });
});
