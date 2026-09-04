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
 *  the final (partial) chunk. `frames === 0` is a REFUSAL — the arm drained
 *  more than CLIP_RECORDER_MAX_ARM_SLIP_FRAMES past its own punch-in and the
 *  lane was retired rather than slid.
 *
 *  `startFrame` is the ABSOLUTE frame of the take's first captured sample —
 *  the requested start plus whatever slip a late arm cost, and on a refusal
 *  the frame the audio thread had already reached. It exists so a slip is
 *  OBSERVABLE: without it the main thread cannot tell a punched-on-time take
 *  from one that slid, and a silent slide is exactly what this field is here
 *  to stop being silent. */
export interface ClipRecorderDoneMsg {
  type: 'done';
  lane: number;
  frames: number;
  startFrame: number;
}
export type ClipRecorderOutMsg = ClipRecorderChunkMsg | ClipRecorderDoneMsg;
