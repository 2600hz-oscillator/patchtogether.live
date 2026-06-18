// packages/dsp/src/recorderbox-capture.ts
//
// RECORDERBOX capture-tap AudioWorklet. Runs on the AUDIO THREAD: reads the
// merged stereo input, batches BATCH_FRAMES per channel, and POSTS a planar
// Float32 block ([L…, R…], transferred) to the main thread. The MessagePort
// BUFFERS under main-thread load, so the audio thread NEVER drops a sample — the
// fix for recorderbox's recording clicks/pops (the old MediaStreamAudioTrackSource
// dropped samples when the AAC encoder backed up, then mediabunny silence-padded
// the gap = the click). The main thread drains the posts through mediabunny's
// backpressured AudioSampleSource.add() (see recorderbox-capture-drain.ts +
// recorderbox-recorder.ts).
//
// ARM/DISARM: the tap is connected for the module's whole life, but only POSTS
// while ARMED (during a recording), so it never buffers messages between takes.
//
// NOT top-level-exported by design (a worklet entry must not leak into the
// esbuild ESM bundle / break ART's classic-script eval — see the file-header note
// on the other dsp/src/*.ts worklets). Captured in tests via a registerProcessor
// shim.

// ~21 ms @ 48 kHz → ~47 posts/sec: low message overhead, low added latency.
const BATCH_FRAMES = 1024;

interface ArmMessage { type: 'arm' | 'disarm' }

class RecorderboxCaptureProcessor extends AudioWorkletProcessor {
  private bufL = new Float32Array(BATCH_FRAMES);
  private bufR = new Float32Array(BATCH_FRAMES);
  private fill = 0;
  private armed = false;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data as ArmMessage;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'arm') {
        this.fill = 0;
        this.armed = true;
      } else if (m.type === 'disarm') {
        this.flush(); // emit the final partial batch so a take isn't truncated
        this.armed = false;
        this.fill = 0;
      }
    };
  }

  process(inputs: Float32Array[][]): boolean {
    if (!this.armed) return true; // not recording → tap idle (no posts, no buffering)
    const input = inputs[0];
    const l = input?.[0];
    if (!l) return true;
    const r = input?.[1] ?? l; // mono-safe: duplicate L when only one channel is present
    const n = l.length;
    for (let i = 0; i < n; i++) {
      this.bufL[this.fill] = l[i] ?? 0;
      this.bufR[this.fill] = r[i] ?? 0;
      this.fill++;
      if (this.fill === BATCH_FRAMES) this.flush();
    }
    return true;
  }

  /** Emit the accumulated frames as one planar block, transferring the buffer. */
  private flush(): void {
    const frames = this.fill;
    if (frames === 0) return;
    const data = new Float32Array(frames * 2);
    data.set(this.bufL.subarray(0, frames), 0);      // L plane
    data.set(this.bufR.subarray(0, frames), frames); // R plane
    this.port.postMessage({ data, frames }, [data.buffer]);
    this.fill = 0;
  }
}

registerProcessor('recorderbox-capture', RecorderboxCaptureProcessor);
