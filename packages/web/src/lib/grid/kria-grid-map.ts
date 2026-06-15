// packages/web/src/lib/grid/kria-grid-map.ts
//
// PURE mapping between the monome grid's 16×8 surface and KRIA's full-grid
// layout (clean-room reimagining of monome Kria's grid UX — behavior from the
// public docs, no monome source). Hardware-free so the pad↔edit math and the
// LED-frame computation are unit-testable; the binding (kria-grid.svelte.ts)
// wires these to the live grid + graph store.
//
// Layout (rows 0-7 top→bottom, cols 0-15 left→right):
//   Bottom row (y=7) — the always-visible nav row:
//     cols 0-3   : TRACK select (track 1-4)
//     cols 6-9   : PARAMETER select (TRIG / NOTE / OCTAVE / DURATION)
//     col  15    : PATTERN page toggle
//   Rows 0-6 — the active page editor for the selected track:
//     TRIG     : row 6 = the 16 step triggers (on/off). (Rows 0-5 reserved.)
//     NOTE     : a 7-row column fader per step (rows 0-6, top=high degree).
//     OCTAVE   : a 6-row column fader per step (rows 1-6, +0..+5).
//     DURATION : a 6-row downward column fader per step (rows 1-6).
//   PATTERN page (when toggled): row 0 = 16 pattern slots (tap = cue/launch).

import { GRID_WIDTH, GRID_CELLS } from './mext';
import {
  KRIA_STEPS,
  KRIA_TRACKS,
  KRIA_PATTERNS,
  scaleSemitones,
  type KriaPattern,
  type KriaScaleName,
} from '$lib/audio/modules/kria-types';

export type KriaPage = 'trig' | 'note' | 'octave' | 'duration';
export const KRIA_PAGES: readonly KriaPage[] = ['trig', 'note', 'octave', 'duration'] as const;

// LED levels (0-15 varibright).
export const LED_OFF = 0;
export const LED_DIM = 3;
export const LED_MED = 7;
export const LED_BRIGHT = 12;
export const LED_FULL = 15;

export const NAV_ROW = 7;
/** Nav-row x positions. */
export const TRACK_KEYS = [0, 1, 2, 3] as const;
export const PARAM_KEYS = [6, 7, 8, 9] as const; // trig / note / octave / duration
export const PATTERN_KEY = 15;

/** UI state the grid binding holds locally (which track/page is selected, and
 *  whether the pattern page is showing). Not synced — it's the holder's view. */
export interface KriaGridView {
  track: number; // 0..KRIA_TRACKS-1
  page: KriaPage;
  patternPage: boolean;
}

export function defaultView(): KriaGridView {
  return { track: 0, page: 'trig', patternPage: false };
}

// Editor row spans per page (top row index .. bottom row index, inclusive).
export const NOTE_ROWS = { top: 0, bottom: 6 } as const; // 7 rows → 7 degrees
export const OCTAVE_ROWS = { top: 1, bottom: 6 } as const; // 6 rows → +0..+5
export const DURATION_ROWS = { top: 1, bottom: 6 } as const; // 6 rows
export const TRIG_ROW = 6;

/** Number of NOTE degrees the editor can address (rows 0-6 = 7 degrees). */
export const NOTE_DEGREE_RANGE = NOTE_ROWS.bottom - NOTE_ROWS.top + 1; // 7

// ---------------------------------------------------------------------------
// Key → edit action (PURE)
// ---------------------------------------------------------------------------
export type KriaAction =
  | { kind: 'selectTrack'; track: number }
  | { kind: 'selectPage'; page: KriaPage }
  | { kind: 'togglePatternPage' }
  | { kind: 'cuePattern'; slot: number }
  | { kind: 'toggleTrig'; step: number }
  | { kind: 'setNote'; step: number; degree: number }
  | { kind: 'setOctave'; step: number; octave: number }
  | { kind: 'setDuration'; step: number; duration: number }
  | { kind: 'none' };

/**
 * Resolve a grid key press (x,y) to a KRIA edit action, given the current view.
 * Pure: it never touches the store — the binding applies the action.
 */
export function keyToAction(x: number, y: number, view: KriaGridView): KriaAction {
  // Nav row is always active.
  if (y === NAV_ROW) {
    if ((TRACK_KEYS as readonly number[]).includes(x)) {
      return { kind: 'selectTrack', track: x };
    }
    const pIdx = (PARAM_KEYS as readonly number[]).indexOf(x);
    if (pIdx >= 0) return { kind: 'selectPage', page: KRIA_PAGES[pIdx]! };
    if (x === PATTERN_KEY) return { kind: 'togglePatternPage' };
    return { kind: 'none' };
  }

  // Pattern page: row 0 = the 16 pattern slots.
  if (view.patternPage) {
    if (y === 0 && x >= 0 && x < KRIA_PATTERNS) return { kind: 'cuePattern', slot: x };
    return { kind: 'none' };
  }

  // Editor pages — x = step (must be a valid step column).
  if (x < 0 || x >= KRIA_STEPS) return { kind: 'none' };
  const step = x;

  switch (view.page) {
    case 'trig':
      if (y === TRIG_ROW) return { kind: 'toggleTrig', step };
      return { kind: 'none' };
    case 'note': {
      if (y < NOTE_ROWS.top || y > NOTE_ROWS.bottom) return { kind: 'none' };
      // Top row = highest degree. degree 0 at bottom.
      const degree = NOTE_ROWS.bottom - y;
      return { kind: 'setNote', step, degree };
    }
    case 'octave': {
      if (y < OCTAVE_ROWS.top || y > OCTAVE_ROWS.bottom) return { kind: 'none' };
      const octave = OCTAVE_ROWS.bottom - y; // bottom = +0, top = +5
      return { kind: 'setOctave', step, octave };
    }
    case 'duration': {
      if (y < DURATION_ROWS.top || y > DURATION_ROWS.bottom) return { kind: 'none' };
      // Kria DURATION: lower (more rows lit downward) = longer. A press at row
      // r sets duration = (rows from top down to r) / total rows.
      const total = DURATION_ROWS.bottom - DURATION_ROWS.top + 1;
      const filled = y - DURATION_ROWS.top + 1;
      return { kind: 'setDuration', step, duration: filled / total };
    }
  }
}

// ---------------------------------------------------------------------------
// LED frame computation (PURE)
// ---------------------------------------------------------------------------
function frameIndex(x: number, y: number): number {
  return y * GRID_WIDTH + x;
}

/** Highest NOTE degree the editor renders (top row). Degrees above this still
 *  edit on the card but the grid caps at NOTE_DEGREE_RANGE-1. */
function clampDegreeForGrid(deg: number): number {
  return Math.max(0, Math.min(NOTE_DEGREE_RANGE - 1, deg));
}

/**
 * Compute the full 128-cell LED frame for KRIA, given the active pattern, the
 * grid view, the per-track playhead step (for the selected track), the pattern
 * slot occupancy + active/cued slots, and a blink phase.
 */
export function computeKriaLeds(opts: {
  pattern: KriaPattern | null;
  view: KriaGridView;
  playStep: number; // current step under the selected track's playhead
  occupied: boolean[]; // length KRIA_PATTERNS
  active: number;
  cued: number | null;
  blinkOn: boolean;
}): Uint8Array {
  const { pattern, view, playStep, occupied, active, cued, blinkOn } = opts;
  const frame = new Uint8Array(GRID_CELLS);

  // --- Nav row ---
  for (const x of TRACK_KEYS) {
    frame[frameIndex(x, NAV_ROW)] = x === view.track ? LED_FULL : LED_DIM;
  }
  PARAM_KEYS.forEach((x, i) => {
    const isSel = !view.patternPage && KRIA_PAGES[i] === view.page;
    frame[frameIndex(x, NAV_ROW)] = isSel ? LED_FULL : LED_DIM;
  });
  frame[frameIndex(PATTERN_KEY, NAV_ROW)] = view.patternPage ? LED_FULL : LED_DIM;

  if (!pattern) return frame;
  const track = pattern.tracks[view.track] ?? pattern.tracks[0]!;

  // --- Pattern page ---
  if (view.patternPage) {
    for (let s = 0; s < KRIA_PATTERNS; s++) {
      let lvl = occupied[s] ? LED_MED : LED_OFF;
      if (s === active) lvl = LED_FULL;
      if (cued !== null && s === cued) lvl = blinkOn ? LED_BRIGHT : LED_DIM;
      frame[frameIndex(s, 0)] = lvl;
    }
    return frame;
  }

  // --- Editor pages (selected track) ---
  const win = new Set(loopWindowSet(track));
  for (let step = 0; step < KRIA_STEPS; step++) {
    const inLoop = win.has(step);
    const isPlay = step === playStep;
    switch (view.page) {
      case 'trig': {
        const on = track.trig[step];
        let lvl = on ? LED_FULL : inLoop ? LED_DIM : LED_OFF;
        if (isPlay) lvl = Math.max(lvl, LED_MED);
        frame[frameIndex(step, TRIG_ROW)] = lvl;
        break;
      }
      case 'note': {
        const deg = clampDegreeForGrid(track.note[step] ?? 0);
        const row = NOTE_ROWS.bottom - deg;
        const lvl = isPlay ? LED_FULL : track.trig[step] ? LED_BRIGHT : LED_MED;
        frame[frameIndex(step, row)] = lvl;
        break;
      }
      case 'octave': {
        const oct = Math.max(0, Math.min(5, track.octave[step] ?? 0));
        // Light a column from the bottom up to (bottom - oct).
        for (let r = OCTAVE_ROWS.bottom; r >= OCTAVE_ROWS.bottom - oct; r--) {
          frame[frameIndex(step, r)] = isPlay ? LED_FULL : LED_MED;
        }
        break;
      }
      case 'duration': {
        const total = DURATION_ROWS.bottom - DURATION_ROWS.top + 1;
        const filled = Math.max(1, Math.round((track.duration[step] ?? 0.5) * total));
        for (let r = DURATION_ROWS.top; r < DURATION_ROWS.top + filled; r++) {
          frame[frameIndex(step, r)] = isPlay ? LED_FULL : LED_MED;
        }
        break;
      }
    }
  }
  return frame;
}

/** Loop-window step set for LED rendering (avoid importing the heavier helper
 *  cycle; mirror loopWindow's wrap math). */
function loopWindowSet(track: { loopStart: number; loopLength: number }): number[] {
  const start = ((track.loopStart % KRIA_STEPS) + KRIA_STEPS) % KRIA_STEPS;
  const len = Math.max(1, Math.min(KRIA_STEPS, track.loopLength));
  const out: number[] = [];
  for (let i = 0; i < len; i++) out.push((start + i) % KRIA_STEPS);
  return out;
}

/** Convenience used by the card's grid mirror: the human label per scale. */
export function scaleDegreeCount(scale: KriaScaleName): number {
  return scaleSemitones(scale).length;
}

export { KRIA_TRACKS, KRIA_STEPS, KRIA_PATTERNS };
