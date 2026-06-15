// packages/web/src/lib/grid/grid-clip-map.ts
//
// PURE mapping between the monome grid's 16×8 surface and the clip-player's
// 64-slot clip page (Phase 3 — Session/launch mode). Kept hardware-free so the
// pad↔clip math and the LED-frame computation are unit-testable; the binding
// (grid-clip-binding.svelte.ts) wires these to the live grid + graph store.
//
// Layout (DECIDED, plan §4.1): LEFT 8×8 quadrant (cols 0-7) = the 64 clips
// (row-major: clip i at col i%8, row floor(i/8)); RIGHT 8×8 quadrant (cols
// 8-15) = controls. v1 wires one control — a STOP pad (bottom-right). The
// remaining control pads stay dark, reserved for Phase 4 (MODE / note-edit,
// scene launch).

import {
  CLIP_TRACKS,
  CLIP_SCENES,
  clipIndex,
  type ClipPlayerData,
} from '$lib/audio/modules/clip-types';
import { GRID_WIDTH, GRID_CELLS } from './mext';

// Session-mode LED levels (0-15 varibright).
export const LED_EMPTY = 0;
export const LED_LOADED = 6;
export const LED_QUEUED_LO = 3;
export const LED_QUEUED_HI = 12;
export const LED_PLAYING = 15;
export const LED_STOP_IDLE = 3;
export const LED_STOP_ACTIVE = 12;

/** The STOP control pad — bottom-right corner of the right quadrant. */
export const STOP_PAD = { x: GRID_WIDTH - 1, y: CLIP_SCENES - 1 } as const;

/** A left-quadrant pad (x,y) → flat clip index, or null for a control pad / oob. */
export function padToClipIndex(x: number, y: number): number | null {
  if (x < 0 || x >= CLIP_TRACKS || y < 0 || y >= CLIP_SCENES) return null;
  return clipIndex(x, y); // y*CLIP_TRACKS + x
}

/** Flat clip index → its (x,y) on the grid's left quadrant. */
export function clipIndexToPad(index: number): { x: number; y: number } {
  return { x: index % CLIP_TRACKS, y: Math.floor(index / CLIP_TRACKS) };
}

export function isStopPad(x: number, y: number): boolean {
  return x === STOP_PAD.x && y === STOP_PAD.y;
}

/** Row-major frame offset for (x,y) in a 16-wide grid. */
function frameIndex(x: number, y: number): number {
  return y * GRID_WIDTH + x;
}

/**
 * Compute the full 128-cell Session LED frame from the clip-player's live data
 * + a blink phase. Empty = off, loaded = medium, queued-to-launch = blink
 * dim↔bright, playing = full, queued-to-stop = the playing pad blinks down. The
 * STOP control pad is dim when idle, brighter while a clip plays. The grid
 * device diffs this against the last frame, so recomputing every tick is cheap.
 * Local render state — never synced.
 */
export function computeSessionLeds(
  data: ClipPlayerData | undefined,
  blinkOn: boolean,
): Uint8Array {
  const frame = new Uint8Array(GRID_CELLS);
  const clips = data?.clips ?? {};
  const playing = data?.playing ?? null;
  const queued = data?.queued ?? null;

  for (let i = 0; i < CLIP_TRACKS * CLIP_SCENES; i++) {
    const key = String(i);
    const { x, y } = clipIndexToPad(i);
    const fi = frameIndex(x, y);
    if (playing === key) {
      // Playing — full bright, or blink-down if a stop is queued.
      frame[fi] = queued === 'stop' && blinkOn ? LED_LOADED : LED_PLAYING;
    } else if (queued === key) {
      frame[fi] = blinkOn ? LED_QUEUED_HI : LED_QUEUED_LO;
    } else if (clips[key]) {
      frame[fi] = LED_LOADED;
    } else {
      frame[fi] = LED_EMPTY;
    }
  }

  frame[frameIndex(STOP_PAD.x, STOP_PAD.y)] = playing !== null ? LED_STOP_ACTIVE : LED_STOP_IDLE;
  return frame;
}
