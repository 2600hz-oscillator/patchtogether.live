// packages/dsp/src/clip-recorder.ts
//
// THE CLIP RECORDER — one AudioWorklet with EIGHT stereo inputs, not eight
// recorders. Every armed lane is sliced inside ONE process() call against ONE
// `currentFrame`, so a multitrack pass is sample-aligned BY CONSTRUCTION: two
// channels armed together do not agree about time, they share it.
//
// FRAME-EXACTNESS IS THE WHOLE DESIGN. A take's window arrives as FRAME COUNTS
// (`startFrame` / `stopFrame`) resolved once on the main thread from
// `ctx.currentTime × ctx.sampleRate`; this processor only ever compares them
// against its own `currentFrame` and slices each 128-frame quantum with sample
// offsets. The LENGTH is the contract: a take is `stopFrame - startFrame`
// samples EXACTLY, whatever the main thread is doing, or it is refused and the
// commit says so. No `setInterval` anywhere, no frame count derived from a
// tick count (the blood-pcm lesson: a tick-shaped budget delivered 62 % of
// demand and the SCOPE read 0.0000).
//
// ⚠ THE RENDER CLOCK IS NOT GAP-FREE, and this file used to assume it was.
// "`to - from` summed over the take is `stopFrame - startFrame` exactly" holds
// only if `currentFrame` advances by exactly `n` between consecutive process()
// calls. When the OUTPUT DEVICE UNDERRUNS, Chrome's frame counter jumps past
// audio this thread was never asked to render — and a take that simply kept
// slicing fell behind the absolute window by the skipped interval: 287520 of
// 288000 frames, 480 short, exactly one Chromium/Linux output buffer (10 ms @
// 48 k) and NOT a multiple of the 128-frame quantum, which is what ruled out
// every other cause. The commit refused the short take and the whole take
// went to the recovery pile: one underrun anywhere inside a take destroyed
// it, and the longer the take the likelier it was.
//
// So there IS a third outcome, and this header now says so honestly: a
// full-length take containing a BOUNDED run of digital silence at the frames
// where the device dropped audio. That is the same rule the missing-input
// clause below has always applied, and it is the honest description of what
// the user's OUTPUT actually did — the speakers went silent for those frames
// too. The samples never existed, but the window still does; padding it keeps
// the length exact and every later sample AT ITS OWN FRAME, where skipping
// would have shifted the rest of the loop early. The pad is bounded by
// CLIP_RECORDER_MAX_GAP_FRAMES (one chunk, ~85 ms, cumulative over the take —
// symmetric with the slide bound); past it the lane REFUSES, because a loud
// refusal beats a hole nobody asked for. `done` carries `gapFrames`, so a
// padded take is OBSERVABLE rather than a silent repair. An on-time, gap-free
// take is bit-identical: the pad's guard needs `q0` to run AHEAD of the next
// expected sample, which a contiguous clock never does.
//
// ⚠ A LATE ARM SLIDES; IT NEVER TRUNCATES — and that is what keeps the LENGTH
// exact at the punch-in. It was FALSE as shipped, and the
// counter-example cost a whole take. `startFrame`
// is resolved on the main thread from `ctx.currentTime` plus a fixed lead
// (CLIP_REC_ARM_LEAD_S, 0.12 s); whether THIS thread has already rendered past
// it by the time the port drains is precisely what that thread cannot know.
// The old slice clamped its offset with `Math.max(0, startFrame - q0)`, so an
// arm that drained one quantum late silently dropped the HEAD of the window
// and returned 95872 of 96000 frames — and the commit demands
// `stopFrame - startFrame` byte-exactly, so the take was refused and the clip
// never written. The shortfall scaled with lateness (128 frames per quantum
// missed), and the head was also the part lost, so the take was out of phase
// with its own loop as well as short.
//
// The LENGTH is the contract. A late arm slides the WHOLE window by the miss
// and captures every requested sample; the punch-in slips by at most the miss.
// The slide is BOUNDED by CLIP_RECORDER_MAX_ARM_SLIP_FRAMES — an unbounded
// slide would trade a loud, recoverable failure for a silent musical one (a
// full-length take starting seconds from where it was asked to) — and past
// that bound the lane REFUSES with `frames: 0`, so the main thread keeps its
// recover scratch and says so. `done` carries the ACTUAL `startFrame`, so a
// slip is observable rather than inferred from a number that now always
// matches. An on-time arm is bit-identical: the slide's guard cannot fire when
// `startFrame` lands inside or after the current quantum.
//
// ⚠ A MISSING INPUT IS CAPTURED AS SILENCE, NEVER SKIPPED. The §4.3 sketch
// said `if (!l) continue`, but skipping a quantum SHIFTS every later sample
// earlier — a hole in the middle of a loop, the exact silence-padded
// discontinuity that made recorderbox click. The tap legs are connected for
// the module's whole life so buffers normally always arrive; if one ever does
// not, digital silence at the right frames keeps the takes aligned and the
// count exact (edge 13: a silent loop is a valid, diagnosable result).
//
// ⚠ `stopAt` NEVER EXTENDS A RESOLVED STOP. It applies only when the lane's
// stopFrame is null (an open endless take) or when the new frame is EARLIER
// (the budget cap-stop shortening a take). A second STOP during STOPPING is
// therefore a no-op STRUCTURALLY, not just by the main-thread machine's rule —
// stopping sooner mid-loop would produce a partial loop, the one outcome that
// mode exists to prevent, and stopping later would be a different take.
//
// Chunks are 4096 frames (~85 ms @ 48 k, ~12 posts/s/lane, ~94 posts/s at full
// multitrack — larger than recorderbox's 1024 because there is no muxer
// deadline to feed and eight lanes at 1024 would be 375 posts/s), planar
// [L…, R…], TRANSFERRED. `firstFrame` on a chunk is TAKE-RELATIVE, so a
// chunk's byte offset in the store is a pure function of the chunk
// (clip-media-drain.ts positions by it), never of how many chunks happened to
// land before it. The MessagePort buffers under main-thread load; the drain
// stalls and never skips, so the audio thread never drops a sample.
//
// NOT top-level-exported by design (a worklet entry must not leak into the
// esbuild ESM bundle / break ART's classic-script eval — same rule as every
// other dsp/src worklet). Captured in tests via a registerProcessor shim
// (clip-recorder.test.ts, the featurecv-snapshot / dx7-messages pattern).
// The port protocol lives in ./lib/clip-recorder-protocol.ts, imported by
// BOTH threads, so the two sides of the MessagePort cannot drift.

import {
  CLIP_RECORDER_CHUNK_FRAMES as CHUNK_FRAMES,
  CLIP_RECORDER_LANES as NUM_LANES,
  CLIP_RECORDER_MAX_ARM_SLIP_FRAMES as MAX_ARM_SLIP,
  CLIP_RECORDER_MAX_GAP_FRAMES as MAX_GAP,
  CLIP_RECORDER_QUANTUM as RENDER_QUANTUM,
  type ClipRecorderInMsg as InMsg,
} from './lib/clip-recorder-protocol';

/** One lane's in-flight take. */
interface LaneTake {
  startFrame: number;
  stopFrame: number | null;
  /** Frames captured so far == the take-relative frame of the NEXT sample. */
  written: number;
  /** How far a late arm slid this take's punch-in, in frames. Zero for every
   *  on-time arm. It is what rebases an incoming absolute `stopAt` — the main
   *  thread computes every boundary from the start it REQUESTED. */
  slip: number;
  /** Frames of digital silence padded where the render clock skipped ahead
   *  mid-take (see the file header). Zero on a gap-free clock. Cumulative, and
   *  bounded by MAX_GAP — past the bound the lane refuses. */
  gap: number;
  /** Take-relative first frame of the chunk currently accumulating. */
  chunkFirst: number;
  bufL: Float32Array;
  bufR: Float32Array;
  fill: number;
}

class ClipRecorderProcessor extends AudioWorkletProcessor {
  private takes: (LaneTake | null)[] = new Array(NUM_LANES).fill(null);

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data as InMsg;
      if (!m || typeof m !== 'object') return;
      const lane = (m as { lane?: unknown }).lane;
      if (typeof lane !== 'number' || !Number.isInteger(lane) || lane < 0 || lane >= NUM_LANES) return;
      if (m.type === 'arm') {
        if (!Number.isFinite(m.startFrame)) return;
        if (m.stopFrame !== null && !(Number.isFinite(m.stopFrame) && m.stopFrame > m.startFrame)) return;
        this.takes[lane] = {
          startFrame: Math.trunc(m.startFrame),
          stopFrame: m.stopFrame === null ? null : Math.trunc(m.stopFrame),
          written: 0,
          slip: 0,
          gap: 0,
          chunkFirst: 0,
          bufL: new Float32Array(CHUNK_FRAMES),
          bufR: new Float32Array(CHUNK_FRAMES),
          fill: 0,
        };
      } else if (m.type === 'stopAt') {
        const s = this.takes[lane];
        if (!s || !Number.isFinite(m.stopFrame)) return;
        // REBASE into this take's own timeline before comparing. The main
        // thread resolves every boundary from the start it REQUESTED
        // (`clipRecEndlessStopFrame` = requestedStart + n × unitFrames), so on
        // a take that slid, an absolute stop would land `slip` frames early —
        // re-creating in ENDLESS mode exactly the truncation the slide exists
        // to remove. `slip` is 0 for every on-time arm, so this is the identity
        // on the path that ships today.
        const want = Math.max(s.startFrame, Math.trunc(m.stopFrame) + s.slip);
        // Never EXTEND a resolved stop — see the file header.
        if (s.stopFrame === null || want < s.stopFrame) s.stopFrame = want;
      } else if (m.type === 'cancel') {
        // Discard silently: no done, no final chunk — the scratch on the main
        // thread is the caller's to free.
        this.takes[lane] = null;
      }
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const q0 = currentFrame; // ONE clock for every lane in this call
    for (let lane = 0; lane < NUM_LANES; lane++) {
      const s = this.takes[lane];
      if (!s) continue;
      const l = inputs[lane]?.[0];
      const r = inputs[lane]?.[1] ?? l; // mono-safe: duplicate L (recorderbox rule)
      const n = l?.length ?? RENDER_QUANTUM;
      const q1 = q0 + n;
      // ⚠ LATE ARM — SLIDE, NEVER TRUNCATE (see the file header). Nothing has
      // been captured and the whole quantum is already past the punch-in: the
      // message lost the race. Move the WINDOW, not its length. The guard is
      // the late-arm signature and nothing else — an on-time arm has
      // `q0 <= startFrame`, and any take with a sample in it fails the first
      // two clauses — so the shipping path is untouched.
      if (s.written === 0 && s.fill === 0 && q0 > s.startFrame) {
        const miss = q0 - s.startFrame;
        if (s.slip + miss > MAX_ARM_SLIP) {
          this.refuse(lane, q0, 0);
          continue;
        }
        s.slip += miss;
        s.startFrame += miss;
        if (s.stopFrame !== null) s.stopFrame += miss;
      }
      // ⚠ THE RENDER CLOCK IS NOT GAP-FREE (see the file header). An output-
      // device underrun advances `currentFrame` past audio this thread was
      // never asked to render. Those samples do not exist — but the window
      // still does, and a take that simply stops counting is BOTH short (the
      // commit refuses it and the whole take is lost) and out of phase (every
      // later sample slides earlier against the loop grid). Capture the hole as
      // SILENCE at the right frames, exactly as the missing-input clause below
      // does — bounded, and refused past the bound. The guard is the gap
      // signature and nothing else: `expected` is the absolute frame of the
      // NEXT sample, and on a contiguous clock `q0 === expected` for every
      // quantum after the punch-in. `written > 0` makes this and the slide
      // above mutually exclusive by construction — a gap AT the punch-in is
      // indistinguishable from a late arm and is handled as one.
      const expected = s.startFrame + s.written;
      if (s.written > 0 && q0 > expected) {
        const hole = Math.min(q0 - expected, (s.stopFrame ?? Infinity) - expected);
        if (s.gap + hole > MAX_GAP) {
          this.refuse(lane, s.startFrame, s.gap + hole);
          continue;
        }
        for (let i = 0; i < hole; i++) {
          s.bufL[s.fill] = 0;
          s.bufR[s.fill] = 0;
          s.fill++;
          s.written++;
          s.gap++;
          if (s.fill === CHUNK_FRAMES) this.flush(lane, s);
        }
      }
      // Slice the quantum against the take window — SAMPLE OFFSETS, not seconds.
      const from = Math.max(0, s.startFrame - q0);
      const to = Math.min(n, (s.stopFrame ?? Infinity) - q0);
      for (let i = from; i < to; i++) {
        s.bufL[s.fill] = l?.[i] ?? 0;
        s.bufR[s.fill] = r?.[i] ?? 0;
        s.fill++;
        s.written++;
        if (s.fill === CHUNK_FRAMES) this.flush(lane, s);
      }
      if (s.stopFrame !== null && q1 >= s.stopFrame) this.finish(lane, s);
    }
    return true;
  }

  /** Post the accumulating chunk as one planar block, transferring the buffer. */
  private flush(lane: number, s: LaneTake): void {
    const frames = s.fill;
    if (frames === 0) return;
    const data = new Float32Array(frames * 2);
    data.set(s.bufL.subarray(0, frames), 0); // L plane
    data.set(s.bufR.subarray(0, frames), frames); // R plane
    this.port.postMessage(
      { type: 'chunk', lane, firstFrame: s.chunkFirst, frames, data },
      [data.buffer],
    );
    s.chunkFirst = s.written;
    s.fill = 0;
  }

  /** Emit the final partial chunk + `done`, then retire the lane. `startFrame`
   *  is where the take ACTUALLY punched in — requested plus slip — so the main
   *  thread can see a slide instead of inferring one from a count that now
   *  always matches; `gapFrames` is how much of the take is padded silence,
   *  so a device glitch is a number on the commit rather than a silent
   *  repair. */
  private finish(lane: number, s: LaneTake): void {
    this.flush(lane, s);
    this.port.postMessage({
      type: 'done',
      lane,
      frames: s.written,
      startFrame: s.startFrame,
      gapFrames: s.gap,
    });
    this.takes[lane] = null;
  }

  /** REFUSE a take: retire the lane and report zero frames. The commit's
   *  byte-exact check then fails LOUDLY and keeps the recover scratch — which
   *  is the point. Two causes, told apart by the fields:
   *   - the arm drained further past its punch-in than the slide may absorb:
   *     `startFrame` is the frame this thread had actually reached, `gapFrames`
   *     is 0;
   *   - the render clock skipped further mid-take than the pad may absorb:
   *     `startFrame` is the punch-in the take really got (so the main thread
   *     does not read the glitch as a slip) and `gapFrames` is the hole that
   *     broke the bound.
   *  Sliding or padding a take this far would have been silent and wrong; a
   *  short take was silent and wrong; a refusal that names its own cause is
   *  neither. */
  private refuse(lane: number, startFrame: number, gapFrames: number): void {
    this.port.postMessage({ type: 'done', lane, frames: 0, startFrame, gapFrames });
    this.takes[lane] = null;
  }
}

// The LITERAL is load-bearing: mono-normal-scan's `processorNameOf` derives
// the DSP→factory mapping from `registerProcessor('<literal>')`, so a constant
// here would leave this worklet's mono normal UNCHECKED rather than clean. The
// protocol's CLIP_RECORDER_PROCESSOR is pinned equal to this literal in
// clip-recorder.test.ts.
registerProcessor('clip-recorder', ClipRecorderProcessor);
