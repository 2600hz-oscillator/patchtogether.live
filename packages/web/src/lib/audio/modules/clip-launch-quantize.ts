// packages/web/src/lib/audio/modules/clip-launch-quantize.ts
//
// PURE launch-quantization helper for the `clipplayer` session scheduler — the
// Deluge "quantize a queued launch to the LONGEST currently-playing clip's next
// loop boundary" model. Kept out of clipplayer.ts so the boundary math is
// unit-testable with no engine, and DELIBERATELY out of clip-types.ts /
// clip-clock.ts so the (grand-attest-basis) data model + clock tables don't grow
// scheduler knowledge and don't drift the grand hash. (This file exports no
// `*Def`, so the audio module glob ignores it.)
//
// MODEL (owner-locked, 2026-07-20): a queued launch does NOT fire immediately
// just "because the target lane was idle". Instead it quantizes to the next
// loop-wrap of the currently-playing clip with the greatest LOOP DURATION
// (lenSteps × the lane's step duration) — the reference "bar", exactly the way
// SCENE REPEATS anchor to the scene's longest clip (clip-scene-repeats.ts
// `sceneRepeatAnchor`). "Loop start" is ambiguous with mixed-length clips, so a
// single shared boundary keeps every lane phase-locked.
//
// This helper only computes the BOUNDARY. The three immediacy ESCAPES stay in
// the caller: (a) NOTHING is playing — this returns null → the caller launches
// immediately (no reference groove, so start the groove now); (b) a per-lane NOW
// override; (c) QNT off. Escapes (b)/(c) never call this.
//
// SYNC / DETERMINISM: the caller feeds SYNCED clip lengths + each lane's own
// audio-clock phase. The boundary is a peer-local ctx TIME, but it names the
// SAME musical wrap on every peer (shared bpm + clip lengths + phase origin), so
// peers converge exactly like the scene-repeat auto-advance (each applies at its
// own sample clock; the `playing` write is idempotent).

/** One currently-playing lane's clock, as the scheduler tracks it. */
export interface PlayingLaneClock {
  /** The playing clip's loop length in steps (≥ 1; non-note shells loop as 1). */
  lenSteps: number;
  /** The lane's step duration in seconds — the base step ÷ its rate/div
   *  multiplier (clip-clock.ts `laneStepDur`). */
  laneStepDur: number;
  /** ctx time (s) the lane's NEXT step (index `stepIndex`) is scheduled to emit. */
  nextStepTime: number;
  /** Index of that next step within [0, lenSteps). */
  stepIndex: number;
}

/**
 * The GLOBAL launch-quantization boundary (ctx seconds): the NEXT loop-wrap time
 * of the currently-playing lane with the greatest LOOP DURATION
 * (`lenSteps × laneStepDur` — the Deluge reference bar). Ties go to the FIRST
 * such lane in `playing` order (the lowest lane, matching `sceneRepeatAnchor`'s
 * "ties → lowest lane").
 *
 * A lane's NEXT step to EMIT is step `stepIndex`, scheduled at `nextStepTime`.
 * So step 0 (the loop start = a wrap) next SOUNDS `((lenSteps − stepIndex) mod
 * lenSteps)` steps later, i.e. at
 * `nextStepTime + ((lenSteps − stepIndex) mod lenSteps) × laneStepDur`. The
 * modulo is load-bearing: the scheduler parks a lane at `stepIndex 0` with
 * `nextStepTime` = the IMMINENT (not-yet-emitted) wrap once that wrap sits just
 * beyond the audio lookahead — so `stepIndex 0` means the wrap is `nextStepTime`
 * itself (0 steps away), NOT a full loop later. The result is rolled forward by
 * whole loops to stay strictly after `now` (defensive: a lane whose next step
 * already slipped into the past still yields a future boundary; the scheduler
 * normally holds `nextStepTime` ahead of `now`, so the roll rarely runs).
 *
 * Returns null when `playing` is empty — NOTHING is playing, so there is no
 * reference groove and the caller launches immediately. PURE.
 */
export function nextLaunchBoundary(
  playing: readonly PlayingLaneClock[],
  now: number,
): number | null {
  let best: { dur: number; wrap: number } | null = null;
  for (const p of playing) {
    const step = Number.isFinite(p.laneStepDur) && p.laneStepDur > 0 ? p.laneStepDur : 0;
    if (step <= 0) continue; // a lane with no valid step duration can't anchor a bar
    const len = Math.max(1, Math.floor(p.lenSteps));
    const dur = len * step;
    const idx = Math.min(Math.max(0, Math.floor(p.stepIndex)), len - 1);
    let wrap = p.nextStepTime + ((len - idx) % len) * step;
    if (Number.isFinite(now)) {
      while (wrap <= now) wrap += dur; // keep the boundary strictly in the future
    }
    // STRICT `>` on loop DURATION → the LONGEST clip; equal durations keep the
    // FIRST (lowest) lane, matching sceneRepeatAnchor's tie rule.
    if (!best || dur > best.dur) best = { dur, wrap };
  }
  return best ? best.wrap : null;
}
