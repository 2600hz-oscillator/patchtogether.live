// packages/dsp/src/samsloop.ts
//
// SAMSLOOP — loop-based sample player AudioWorklet.
//
// User uploads a .wav (≤250 KB), AudioContext.decodeAudioData turns it into
// a Float32Array, the host posts the samples here via `loadSample`. The
// processor reads through that buffer with a fractional read-cursor and a
// linear-interpolation tap, controlled by:
//   - rate  (AudioParam, varispeed multiplier; combined slider + CV at the
//           host side and clamped to [-3, +3]). Negative = reverse playback.
//           1.0 is unity = "1× normal playback". The host's mapping
//           convention is:
//             slider center = +1.0 (forward unity, dead-center on knob)
//             full right    = +2.0 (forward 2×)
//             full left     = −2.0 (reverse 2×)
//             rate = 0      → playback FROZEN
//             rate < 0      → cursor walks BACKWARDS
//             CV ±1 V sums on top, so two ±1 V LFOs at full deflection can
//             still push the rate as low as ±3.
//
// Sample-rate compensation: the cursor advances by
// `rate * (bufferRate / contextRate)` per output sample, so rate=1.0 plays
// the sample at its captured pitch regardless of the AudioContext's
// native rate. (Without this scale, a 24 kHz buffer in a 48 kHz context
// at rate=1 would play at 2× perceived speed — the bug that prompted
// this defaultValue/mapping rework.) The host posts `sampleRate` in the
// loadSample message; bufferRate defaults to the context rate (1.0
// scale) when not provided so legacy patches still load.
//   - mode  (AudioParam, 0=one-shot, 1=loop). Discrete; we round inside.
//   - start (AudioParam, sample-index lower bound; clamped to [0, len-1]).
//   - end   (AudioParam, sample-index upper bound; clamped to [start+1, len]).
//   - trig  (audio-rate input, rising edge resets the read-cursor to start
//           (or to end-1 if rate is negative) so a gate can retrigger the
//           sample without uploading it again).
//
// Output is mono. The audio graph's stereo handling (StereoVCA, mixmstrs)
// can convert this to stereo downstream — matching other one-shot sources
// in the codebase (noise, analog-vco, macrooscillator's `out`).

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  process?(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
declare function registerProcessor(name: string, ctor: typeof AudioWorkletProcessor): void;

interface LoadSampleMessage {
  type: 'loadSample';
  samples: ArrayBuffer; // Float32 PCM, mono-mixed-down at the host side
  /** Native sample rate of the loaded buffer. The worklet scales the
   *  read-cursor by `bufferRate / contextRate` so rate=1.0 plays at the
   *  sample's captured pitch regardless of the AudioContext's rate.
   *  Optional for backward compatibility — falls back to the context's
   *  own sample rate (= 1.0 scale, legacy behavior) if omitted. */
  sampleRate?: number;
}
interface ResetMessage {
  type: 'reset';
}
type SamsloopMessage = LoadSampleMessage | ResetMessage;

const TRIG_THRESHOLD = 0.5;

class SamsloopProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // Combined slider + CV varispeed. ±3 hard ceiling so a fully-pinned
      // slider plus a fully-pinned CV LFO can't run the read-cursor faster
      // than 3× (avoids audible aliasing past ~3× — past that it sounds
      // like noise anyway).
      { name: 'rate',  defaultValue: 1, minValue: -3, maxValue: 3,  automationRate: 'a-rate' as const },
      // Loop vs one-shot. 0 = one-shot (clamp + go silent at end), 1 = loop
      // (wrap back to start). Read at the start of each block and rounded.
      { name: 'mode',  defaultValue: 1, minValue: 0,  maxValue: 1,  automationRate: 'k-rate' as const },
      // Selected playback window. The host clamps via the slider's
      // [0, sampleLen] range; the worklet additionally clamps per-sample
      // so a stale value (e.g. set while the previous sample was loaded)
      // can't read off the end of a shorter newly-loaded buffer.
      { name: 'start', defaultValue: 0,    minValue: 0, maxValue: 1e9, automationRate: 'k-rate' as const },
      { name: 'end',   defaultValue: 1e9,  minValue: 0, maxValue: 1e9, automationRate: 'k-rate' as const },
    ];
  }

  /** The decoded sample. Empty Float32Array until `loadSample` arrives. */
  private buffer: Float32Array = new Float32Array(0);
  /** Fractional read-cursor in sample-frames within `buffer`. */
  private cursor = 0;
  /** Whether we're currently emitting audio. One-shot mode flips this off
   *  when the cursor leaves the [start, end] window; loop mode never does. */
  private active = true;
  /** Trigger edge detection. */
  private lastTrig = 0;
  /** Cursor scale = bufferSampleRate / contextSampleRate. At scale=1 the
   *  cursor advances one buffer-sample per output sample (legacy behavior:
   *  the buffer plays at the context's rate, NOT its captured rate, which
   *  is wrong when bufferRate ≠ contextRate). Set on `loadSample`; defaults
   *  to 1 so a stale buffer from before the host started passing
   *  sampleRate still plays. */
  private rateScale = 1;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.port.onmessage = (e: MessageEvent) => this.handleMessage(e.data as SamsloopMessage);
  }

  private handleMessage(msg: SamsloopMessage): void {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'loadSample') {
      if (!(msg.samples instanceof ArrayBuffer)) return;
      this.buffer = new Float32Array(msg.samples);
      this.cursor = 0;
      this.active = true;
      // Update the cursor scale. If the host omitted sampleRate we default
      // to the context rate so the cursor advances 1 sample per output
      // frame (the legacy behavior — keeps old saved patches sounding the
      // same as they did before the rate-mapping rework).
      const bufRate = typeof msg.sampleRate === 'number' && msg.sampleRate > 0
        ? msg.sampleRate
        : sampleRate;
      this.rateScale = bufRate / sampleRate;
    } else if (msg.type === 'reset') {
      this.cursor = 0;
      this.active = true;
    }
  }

  /** Linear interpolation tap. Wraps to silence outside [0, len-1]. */
  private read(pos: number): number {
    const len = this.buffer.length;
    if (len === 0) return 0;
    if (pos < 0 || pos >= len - 1) {
      // For sub-sample positions in the [len-1, len) gap, just clamp to
      // the last sample. Out-of-range returns silence — the loop/one-shot
      // logic in process() keeps `cursor` inside [start, end] in normal
      // operation; this branch is the defensive floor.
      if (pos >= len - 1 && pos < len) return this.buffer[len - 1] ?? 0;
      return 0;
    }
    const i = Math.floor(pos);
    const f = pos - i;
    const a = this.buffer[i] ?? 0;
    const b = this.buffer[i + 1] ?? 0;
    return a + (b - a) * f;
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]?.[0];
    if (!out) return true;

    if (this.buffer.length === 0) {
      out.fill(0);
      return true;
    }

    const rateArr = parameters.rate!;
    const modeArr = parameters.mode!;
    const startArr = parameters.start!;
    const endArr = parameters.end!;
    const trigIn = inputs[0]?.[0];

    // k-rate params: read once per block.
    const mode = Math.round(modeArr[0] ?? 1); // 0=one-shot, 1=loop
    const startRaw = startArr[0] ?? 0;
    const endRaw = endArr[0] ?? this.buffer.length;
    const len = this.buffer.length;
    // Clamp the window to the actual buffer. start < end always (the host's
    // slider clamps too, but this is the load-bearing defensive clamp for
    // a stale param value left over from a previous, longer upload).
    let start = Math.max(0, Math.min(len - 1, startRaw));
    let end = Math.max(start + 1, Math.min(len, endRaw));

    for (let i = 0; i < out.length; i++) {
      // Trigger rising-edge → retrigger sample playback from the window edge
      // (start if playing forward, end-1 if playing reverse). Detect the
      // edge before sample emission so the very first sample of the new
      // burst lands in this same frame.
      if (trigIn) {
        const t = trigIn[i] ?? 0;
        if (this.lastTrig < TRIG_THRESHOLD && t >= TRIG_THRESHOLD) {
          const rate0 = rateArr.length > 1 ? (rateArr[i] ?? 1) : (rateArr[0] ?? 1);
          this.cursor = rate0 >= 0 ? start : end - 1;
          this.active = true;
        }
        this.lastTrig = t;
      }

      if (!this.active) {
        out[i] = 0;
        continue;
      }

      // Read the fractional sample at the current cursor.
      out[i] = this.read(this.cursor);

      // Advance the cursor by the current rate (a-rate so CV reads sample-
      // accurate), scaled by bufferRate/contextRate so rate=1.0 plays at
      // the sample's captured pitch regardless of the AudioContext's
      // native rate. rate=0 freezes; rate<0 reverses.
      const rate = rateArr.length > 1 ? (rateArr[i] ?? 1) : (rateArr[0] ?? 1);
      this.cursor += rate * this.rateScale;

      // Handle window crossings. The branches below are organised by
      // direction (forward vs reverse) and mode (loop vs one-shot).
      if (this.cursor >= end) {
        if (mode === 1) {
          // Loop: wrap forward through the window. fmod-style so very
          // high rate doesn't take many trips around to settle.
          const winLen = end - start;
          this.cursor = start + ((this.cursor - start) % winLen);
        } else {
          // One-shot: stick at end, silence subsequent samples.
          this.cursor = end;
          this.active = false;
        }
      } else if (this.cursor < start) {
        // Reverse direction.
        if (mode === 1) {
          const winLen = end - start;
          // Mirror the wrap formula for negative excursion.
          const overshoot = start - this.cursor;
          this.cursor = end - (overshoot % winLen);
        } else {
          this.cursor = start;
          this.active = false;
        }
      }
    }
    return true;
  }
}

registerProcessor('samsloop', SamsloopProcessor);
