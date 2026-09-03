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
// offsets. `to - from` summed over the take is `stopFrame - startFrame`
// EXACTLY, whatever the main thread is doing — a take is the requested number
// of samples or it is cancelled; there is no third outcome. No `setInterval`
// anywhere, no frame count derived from a tick count (the blood-pcm lesson:
// a tick-shaped budget delivered 62 % of demand and the SCOPE read 0.0000).
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
  CLIP_RECORDER_QUANTUM as RENDER_QUANTUM,
  type ClipRecorderInMsg as InMsg,
} from './lib/clip-recorder-protocol';

/** One lane's in-flight take. */
interface LaneTake {
  startFrame: number;
  stopFrame: number | null;
  /** Frames captured so far == the take-relative frame of the NEXT sample. */
  written: number;
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
          chunkFirst: 0,
          bufL: new Float32Array(CHUNK_FRAMES),
          bufR: new Float32Array(CHUNK_FRAMES),
          fill: 0,
        };
      } else if (m.type === 'stopAt') {
        const s = this.takes[lane];
        if (!s || !Number.isFinite(m.stopFrame)) return;
        const want = Math.max(s.startFrame, Math.trunc(m.stopFrame));
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

  /** Emit the final partial chunk + `done`, then retire the lane. */
  private finish(lane: number, s: LaneTake): void {
    this.flush(lane, s);
    this.port.postMessage({ type: 'done', lane, frames: s.written });
    this.takes[lane] = null;
  }
}

// The LITERAL is load-bearing: mono-normal-scan's `processorNameOf` derives
// the DSP→factory mapping from `registerProcessor('<literal>')`, so a constant
// here would leave this worklet's mono normal UNCHECKED rather than clean. The
// protocol's CLIP_RECORDER_PROCESSOR is pinned equal to this literal in
// clip-recorder.test.ts.
registerProcessor('clip-recorder', ClipRecorderProcessor);
