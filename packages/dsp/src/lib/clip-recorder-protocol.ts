// packages/dsp/src/lib/clip-recorder-protocol.ts
//
// THE CLIP-RECORDER PORT PROTOCOL — one spelling for both threads. The worklet
// (../clip-recorder.ts) imports these constants and shapes into the audio
// thread; the web wiring (packages/web/src/lib/audio/clip-recorder-node.ts)
// imports the SAME file by relative path (the cube-dsp / analog-delay-core
// convention), so the two sides of the MessagePort cannot drift: a renamed
// field is a tsc error on both, not a silently-dead message on one.
//
// PURE DATA ONLY. Nothing here touches an AudioWorkletGlobalScope ambient or a
// DOM type, so it loads in node tests, in the esbuild worklet bundle, and in
// the web bundle alike. (Files in dsp/src/lib are NOT built as worklet
// entries — the build globs only src/*.ts — so this adds no dist artifact and
// no .sha pin of its own; it rides inside clip-recorder.js.)

/** The registered processor name — `new AudioWorkletNode(ctx, THIS)`. */
export const CLIP_RECORDER_PROCESSOR = 'clip-recorder';

/** Lanes = clip-launcher lanes = mixmstrs channels. The web side pins this
 *  against its own CLIP_LANES in clip-recorder-node.test.ts — this scope
 *  cannot import the launcher's constant, so the identity is asserted, not
 *  assumed. */
export const CLIP_RECORDER_LANES = 8;

/** Frames per posted chunk: ~85 ms @ 48 k, ~12 posts/s/lane, ~94 posts/s at
 *  full multitrack. Larger than recorderbox's 1024 because there is no muxer
 *  deadline to feed, and eight lanes at 1024 would be 375 posts/s. */
export const CLIP_RECORDER_CHUNK_FRAMES = 4096;

/** AudioWorkletGlobalScope render quantum — the frame count a quantum
 *  advances when an input buffer is absent. */
export const CLIP_RECORDER_QUANTUM = 128;

/** ⚠ HOW LATE AN ARM MAY DRAIN AND STILL BE HONOURED — one chunk, 32 render
 *  quanta, ~85 ms @ 48 k.
 *
 *  `startFrame` is resolved on the MAIN thread from `ctx.currentTime` plus a
 *  fixed lead, and whether the audio thread has already rendered past it by
 *  the time the port drains is exactly what that thread cannot know. A few
 *  quanta of lateness is ordinary scheduling jitter, and the worklet SLIDES
 *  the window so the take's LENGTH stays exact (see the worklet header).
 *
 *  Past this bound the punch-in is not late, it is WRONG — a stalled render
 *  thread, a stale clock, an arm resolved against another context — and
 *  sliding would trade a loud, recoverable failure for a silent musical one:
 *  a full-length take beginning somewhere nobody asked for. So the lane
 *  REFUSES instead, and the commit's byte-exact check keeps the scratch.
 *
 *  The ceiling is set by the main thread's own patience: the commit awaits
 *  `done` for CLIP_REC_DONE_TIMEOUT_MS (3 s) and a slid take reports `done`
 *  that much later, so an unbounded slide degrades into "worklet never
 *  reported done" regardless. One chunk is the recorder's own granularity,
 *  ~35x inside that ceiling, and small enough that a slid punch-in is a
 *  timing wobble rather than a different take. */
export const CLIP_RECORDER_MAX_ARM_SLIP_FRAMES = CLIP_RECORDER_CHUNK_FRAMES;

/** ⚠ HOW MUCH RENDER-CLOCK GAP A TAKE MAY ABSORB AS SILENCE — one chunk,
 *  ~85 ms @ 48 k, symmetric with CLIP_RECORDER_MAX_ARM_SLIP_FRAMES.
 *
 *  The audio render clock is NOT gap-free. When the OUTPUT DEVICE underruns,
 *  `currentFrame` jumps past audio this thread was never asked to render —
 *  one Chromium/Linux output buffer is 480 frames, and 480 is not a multiple
 *  of the 128-frame quantum, which is how a clock gap is told apart from
 *  every other shortfall. Those samples do not exist, but the WINDOW still
 *  does: the worklet pads the hole with digital silence at the right frames
 *  (the missing-input rule), so the take stays full-length and in phase and
 *  the whole of it is not lost to one glitch.
 *
 *  Past this bound the hole is not a click, it is a RUINED take — a stalled
 *  render thread, a device that went away — and padding would trade a loud,
 *  recoverable failure for a silent musical one. So the lane REFUSES instead
 *  (`frames: 0`), the commit's byte-exact check keeps the scratch, and
 *  `gapFrames` on `done` names the cause. The bound is CUMULATIVE over the
 *  take, exactly as the slide bound accumulates over an arm. */
export const CLIP_RECORDER_MAX_GAP_FRAMES = CLIP_RECORDER_CHUNK_FRAMES;

// ---------------------------------------------------------------------------
// Main thread → worklet
// ---------------------------------------------------------------------------

/** Arm a lane for a take window (ABSOLUTE context frames; stopFrame null = an
 *  open endless take). Replaces any prior state on the lane wholesale. */
export interface ClipRecorderArmMsg {
  type: 'arm';
  lane: number;
  startFrame: number;
  stopFrame: number | null;
}
/** Resolve a lane's stop to an absolute frame. NEVER EXTENDS a resolved stop
 *  (see the worklet header) — a duplicate STOP is structurally a no-op, and
 *  an earlier frame (the budget cap-stop) shortens.
 *
 *  ⚠ The frame is expressed in the timeline the main thread REQUESTED, not the
 *  one the take actually got. Every boundary up there is computed from the
 *  requested `startFrame` (`clipRecEndlessStopFrame` = start + n × unit), so a
 *  take that slid by a late arm must add its own slip before comparing — the
 *  worklet does that rebasing, and it is why a slid ENDLESS take stops after a
 *  whole number of units rather than `slip` frames short of one. */
export interface ClipRecorderStopMsg {
  type: 'stopAt';
  lane: number;
  stopFrame: number;
}
/** Discard a lane's take silently: no final chunk, no done. */
export interface ClipRecorderCancelMsg {
  type: 'cancel';
  lane: number;
}
export type ClipRecorderInMsg =
  | ClipRecorderArmMsg
  | ClipRecorderStopMsg
  | ClipRecorderCancelMsg;

// ---------------------------------------------------------------------------
// Worklet → main thread
// ---------------------------------------------------------------------------

/** One capture chunk: planar [L…, R…] float32, TRANSFERRED. `firstFrame` is
 *  TAKE-relative, so a chunk's byte offset in the store is a pure function of
 *  the chunk, never of how many chunks happened to land before it. */
export interface ClipRecorderChunkMsg {
  type: 'chunk';
  lane: number;
  firstFrame: number;
  frames: number;
  data: Float32Array;
}
/** The take is complete: exactly `frames` frames were captured. Posted after
 *  the final (partial) chunk. `frames === 0` is a REFUSAL — either the arm
 *  drained more than CLIP_RECORDER_MAX_ARM_SLIP_FRAMES past its own punch-in
 *  (`gapFrames === 0`), or the render clock skipped more than
 *  CLIP_RECORDER_MAX_GAP_FRAMES mid-take (`gapFrames` > the bound) — and the
 *  lane was retired rather than slid or padded.
 *
 *  `startFrame` is the ABSOLUTE frame of the take's first captured sample —
 *  the requested start plus whatever slip a late arm cost. On a SLIDE refusal
 *  it is the frame the audio thread had already reached; on a GAP refusal it
 *  is the punch-in the take actually got, so the main thread does not read a
 *  glitch as a slip. It exists so a slip is OBSERVABLE: without it the main
 *  thread cannot tell a punched-on-time take from one that slid, and a silent
 *  slide is exactly what this field is here to stop being silent.
 *
 *  `gapFrames` is how many of the `frames` are DIGITAL SILENCE the worklet
 *  padded where the render clock skipped (see CLIP_RECORDER_MAX_GAP_FRAMES).
 *  Zero for every take rendered on a gap-free clock. It is here for the same
 *  reason `startFrame` is: a padded hole that nobody can see is a silent
 *  repair, and the commit path reports it so the next investigator has a
 *  number to read. */
export interface ClipRecorderDoneMsg {
  type: 'done';
  lane: number;
  frames: number;
  startFrame: number;
  gapFrames: number;
}
export type ClipRecorderOutMsg = ClipRecorderChunkMsg | ClipRecorderDoneMsg;
