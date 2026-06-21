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

/** Frames the grid may run ahead of what's emitted WITHOUT it counting as a
 *  deficit. A perfectly on-pace render is ALWAYS ~1 frame behind (you emit a
 *  frame the very tick its grid slot becomes due), and a fast machine that just
 *  skipped a couple ticks is a transient — neither is "falling behind". Only a
 *  gap LARGER than this slack starts the sustained-deficit streak. (Used by the
 *  caller — RecorderboxRecorder.frame — to decide whether a tick is "behind".) */
export const DEFICIT_SLACK_FRAMES = 3;

/** Consecutive ticks the grid must be MEANINGFULLY behind (deficit >
 *  DEFICIT_SLACK_FRAMES) before it's judged SUSTAINED — a genuinely slow render,
 *  not a one-off hitch — and the per-tick catch-up cap is relaxed so video
 *  DURATION tracks wall-clock. Kept small (~4 ticks ≈ 0.13 s at 30 fps) so little
 *  A/V drift accrues before the ramp engages; the slack above is what prevents an
 *  on-pace render from ever reaching it. */
export const SUSTAINED_DEFICIT_TICKS = 4;

/** Per-tick emission cap ONCE the deficit is sustained: large enough that the
 *  video tracks the grid even at a very slow ~3 fps render (grid advancing ~10
 *  slots/tick) AND drains the small backlog accrued before the ramp engaged, yet
 *  bounded so a freak multi-second stall can't dump hundreds of duplicate frames
 *  in one tick (a visible stutter). 1 s of grid @ 30 fps. */
export const SUSTAINED_MAX_CATCHUP = 30;

/**
 * Decide, for one rAF tick, how many CFR frames to emit and at which grid index
 * each lands — the pure scheduling core the recorder's `frame()` calls.
 *
 * Given the frames already emitted (`emitted`) and the current elapsed wall time,
 * returns the list of grid frame INDICES to emit this tick:
 *   * grid AHEAD of wall time (`due <= emitted`) → `[]` (skip — never two frames
 *     in one slot on a fast machine).
 *   * grid BEHIND  (`due > emitted`) → catch up, emitting indices
 *     `emitted, emitted+1, …` up to `due-1`, but NO MORE than the effective cap
 *     frames in a single tick. The extra (duplicate) frames reuse the current
 *     canvas.
 *
 * THE EFFECTIVE PER-TICK LIMIT (the sustained-deficit / A-V-desync fix):
 *   * TRANSIENT deficit (`deficitStreak < SUSTAINED_DEFICIT_TICKS`) → emit at
 *     most `1 + maxCatchup` frames (default 3). A one-off hitch resumes from where
 *     it is and re-catches over the next few ticks — no burst of duplicated
 *     frames.
 *   * SUSTAINED deficit (`deficitStreak >= SUSTAINED_DEFICIT_TICKS`) → emit up to
 *     `SUSTAINED_MAX_CATCHUP` frames. Under a render PERSISTENTLY below ~10 fps
 *     the small transient limit (≤3/tick) can't keep pace with a 30 fps grid
 *     (which advances >3 slots/tick), so video `frameCount` would lag the grid
 *     FOREVER → the video track ends SHORTER than the sample-accurate audio →
 *     growing A/V desync. Raising the limit once the deficit is proven sustained
 *     lets `frameCount` track `due` so video DURATION tracks wall-clock. The
 *     extra frames are duplicates of the current canvas, spread across the slow
 *     ticks (the deficit accrues gradually + the limit is bounded), not dumped as
 *     one visible burst.
 *
 * The returned indices are always exactly `emitted, emitted+1, …` (contiguous on
 * the grid) so `CfrClock.ptsForFrame` yields a strictly increasing, evenly-spaced
 * PTS sequence with no gaps and no duplicates — the property that kills the
 * slow-mo, preserved in BOTH regimes. Pure + allocation-light (returns a small
 * array, usually length 0 or 1).
 *
 * @param deficitStreak consecutive prior ticks the caller observed MEANINGFULLY
 *        behind the grid (deficit > DEFICIT_SLACK_FRAMES). The caller bumps it
 *        while behind by more than the slack + resets it to 0 once it catches up
 *        within the slack. 0 (the default) preserves the original transient-only
 *        behavior for callers that don't track it.
 */
export function planCfrEmit(
  clock: CfrClock,
  emitted: number,
  elapsedSeconds: number,
  maxCatchup = 2,
  deficitStreak = 0,
): number[] {
  const due = clock.framesDue(elapsedSeconds);
  if (due <= emitted) return [];
  const sustained = deficitStreak >= SUSTAINED_DEFICIT_TICKS;
  // Per-tick limit: 1 (on pace) + transient catch-up, OR the relaxed sustained
  // limit once the deficit is proven persistent.
  const limit = sustained ? SUSTAINED_MAX_CATCHUP : 1 + Math.max(0, maxCatchup);
  const want = Math.min(due - emitted, limit);
  const out: number[] = [];
  for (let i = 0; i < want; i++) out.push(emitted + i);
  return out;
}
