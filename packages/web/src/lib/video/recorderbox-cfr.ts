// packages/web/src/lib/video/recorderbox-cfr.ts
//
// CONSTANT-FRAME-RATE (CFR) clock for the RECORDERBOX video track — the OSX
// "slow-motion in Preview/QuickTime" fix.
//
// ── The bug (root cause) ─────────────────────────────────────────────────────
// The recorder used to timestamp each encoded video frame off WALL CLOCK
// (`(performance.now() - t0) / 1000`) and emit one frame per requestAnimationFrame
// tick. rAF cadence is VARIABLE under render load (a heavy ACIDWARP / a busy
// machine drops below 30 Hz; a fast one runs above it), and the recorder also
// DROPS a frame entirely while the previous encode is still draining
// (addInFlight). So the encoded PTS stream is irregular:
//
//   * Sparse stretches — a busy second yields ~12 frames whose PTS still span
//     ~1 s of timeline. The muxer carries `frameRate: 30` metadata, so a player
//     sees 12 frames stretched across a 1 s window @ 30 fps declared → it plays
//     that region in SLOW MOTION. Moving the scrubber left forces a re-decode
//     from the previous keyframe at normal cadence ("full speed restored") —
//     exactly the reported symptom.
//   * Collisions — above 30 Hz, multiple wall-clock PTS snap to the same 1/30 s
//     slot (mediabunny's `frameRate` snap → "multiple frames with the same
//     timestamp"), producing 0-duration samples + an irregular track.
//
// The muxer's per-frame `frameRate` snap can't repair an already-irregular input
// stream; the defect is the INPUT PTS, derived from wall clock.
//
// ── The fix ──────────────────────────────────────────────────────────────────
// Derive PTS from a MONOTONIC FRAME INDEX on a FIXED GRID, not wall clock. Each
// emitted frame's PTS is exactly `index / fps` (0, 1/30, 2/30, …) with a constant
// `1/fps` duration → a perfectly even grid, zero collisions. The recorder asks
// this clock, per rAF, how many grid frames "should" exist by the current elapsed
// wall time (`framesDue`) and emits to catch the grid up (drop when ahead,
// duplicate the current canvas — bounded — when behind), so the encoded stream is
// true CFR regardless of rAF jitter. The muxer's `frameRate: 30` then becomes a
// TRUTHFUL declaration of an already-on-grid stream, not a lossy repair.
//
// This module is PURE — no browser API, no mediabunny — so the grid logic is
// unit-tested headlessly + CI-safe (the slow-mo regression net).

/**
 * A constant-frame-rate clock. Maps elapsed wall-clock seconds to how many CFR
 * frames "should" have been emitted by now (so the caller can drop or catch up to
 * the grid), and maps a frame index to its exact grid PTS.
 */
export class CfrClock {
  /** Exact frame duration in seconds (`1/fps`) — every emitted frame uses this. */
  readonly frameDuration: number;

  constructor(private readonly fps: number) {
    if (!(fps > 0)) throw new Error('CfrClock: fps must be > 0');
    this.frameDuration = 1 / fps;
  }

  /**
   * How many frames the CFR grid expects to exist at `elapsedSeconds`. The caller
   * compares this to how many it has actually emitted to decide whether to emit 0
   * (ahead of the grid → skip, no collision), 1 (on pace), or N (behind → catch
   * up by duplicating, bounded by the caller). Floors to whole grid slots; a tiny
   * epsilon absorbs float jitter right at a slot boundary so e.g. elapsed exactly
   * `2/30` reliably reports 2, not 1.
   */
  framesDue(elapsedSeconds: number): number {
    if (!(elapsedSeconds > 0)) return 0;
    return Math.floor(elapsedSeconds * this.fps + 1e-6);
  }

  /** The exact grid PTS (seconds) for frame `index`: `index / fps`. Evenly
   *  spaced (0, 1/fps, 2/fps, …) — the heart of the CFR fix. */
  ptsForFrame(index: number): number {
    return index / this.fps;
  }
}

/**
 * Decide, for one rAF tick, how many CFR frames to emit and at which grid index
 * each lands — the pure scheduling core the recorder's `frame()` calls.
 *
 * Given the frames already emitted (`emitted`) and the current elapsed wall time,
 * returns the list of grid frame INDICES to emit this tick:
 *   * grid AHEAD of wall time (`due <= emitted`) → `[]` (skip — never two frames
 *     in one slot on a fast machine).
 *   * grid BEHIND  (`due > emitted`) → catch up, emitting indices
 *     `emitted, emitted+1, …` up to `due-1`, but NO MORE than `maxCatchup` frames
 *     in a single tick (a long stall can't flood the encoder; the timeline simply
 *     resumes from where it is — playback duration tracks real elapsed time within
 *     the catch-up bound). The extra (duplicate) frames reuse the current canvas.
 *
 * The returned indices are always exactly `emitted, emitted+1, …` (contiguous on
 * the grid) so `CfrClock.ptsForFrame` yields a strictly increasing, evenly-spaced
 * PTS sequence with no gaps and no duplicates — the property that kills the
 * slow-mo. Pure + allocation-light (returns a small array, usually length 0 or 1).
 */
export function planCfrEmit(
  clock: CfrClock,
  emitted: number,
  elapsedSeconds: number,
  maxCatchup = 2,
): number[] {
  const due = clock.framesDue(elapsedSeconds);
  if (due <= emitted) return [];
  // Emit one frame for being on pace, plus up to `maxCatchup` extra to close a
  // gap — total capped at (1 + maxCatchup) frames per tick.
  const want = Math.min(due - emitted, 1 + Math.max(0, maxCatchup));
  const out: number[] = [];
  for (let i = 0; i < want; i++) out.push(emitted + i);
  return out;
}
