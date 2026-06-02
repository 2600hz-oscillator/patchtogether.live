// packages/web/static/snes9x/snes9x-pcm-worklet.js
//
// AudioWorkletProcessor for the SNES9X module's STEREO PCM output.
//
// The snes9x2005 WASM core runs on the main thread; the SNES9X module's
// frame loop drains the core's per-frame interleaved S16 stereo audio,
// converts to f32, and postMessages it here. Unlike the DOOM mono worklet,
// SNES audio is true stereo, so we keep TWO ring buffers (L + R) and emit
// distinct channels — the module routes this node through a ChannelSplitter
// so audio_l + audio_r are independently patchable.
//
// The SNES core outputs at 32 kHz (SNES_AUDIO_SAMPLE_RATE); the AudioContext
// usually runs at 44.1/48 kHz. We linearly resample from the source rate to
// the context rate so playback is correct-pitch. The source rate is sent in
// the 'config' message; if absent we assume the context rate (no resample).
//
// Message protocol (postMessage from main thread → this worklet):
//   { type: 'config', srcRate }                 — set source sample rate
//   { type: 'pcm', left: Float32Array, right }  — enqueue a stereo chunk
//   { type: 'reset' }                           — clear the queues
//   { type: 'gain', value }                     — output gain (0..4)
//
// Underrun = silence; overrun = drop oldest (the audio thread always wins).
// Registered via registerProcessor (static classic-script worklet — NOT a
// DSP-build ESM worklet, so no top-level export concerns apply).

class Snes9xPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ringSize = 32000; // ~1 s headroom at the SNES rate
    this._ringL = new Float32Array(this._ringSize);
    this._ringR = new Float32Array(this._ringSize);
    this._read = 0;
    this._write = 0;
    this._gain = 1.0;
    this._srcRate = sampleRate; // default: no resample
    // Fractional read position for linear resampling.
    this._frac = 0;

    this.port.onmessage = (ev) => {
      const d = ev.data;
      if (!d || typeof d !== 'object') return;
      if (d.type === 'config' && typeof d.srcRate === 'number' && d.srcRate > 0) {
        this._srcRate = d.srcRate;
      } else if (
        d.type === 'pcm' &&
        d.left instanceof Float32Array &&
        d.right instanceof Float32Array
      ) {
        this._enqueue(d.left, d.right);
      } else if (d.type === 'reset') {
        this._read = 0;
        this._write = 0;
        this._frac = 0;
        this._ringL.fill(0);
        this._ringR.fill(0);
      } else if (d.type === 'gain' && typeof d.value === 'number') {
        this._gain = Math.max(0, Math.min(4, d.value));
      }
    };
  }

  _avail() {
    return (this._write - this._read + this._ringSize) % this._ringSize;
  }

  _enqueue(left, right) {
    const n = Math.min(left.length, right.length);
    for (let i = 0; i < n; i++) {
      const next = (this._write + 1) % this._ringSize;
      if (next === this._read) {
        // Full — drop oldest stereo frame.
        this._read = (this._read + 1) % this._ringSize;
      }
      this._ringL[this._write] = left[i];
      this._ringR[this._write] = right[i];
      this._write = next;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const outL = out[0];
    const outR = out.length > 1 ? out[1] : out[0];
    const ratio = this._srcRate / sampleRate; // src frames consumed per out frame

    for (let i = 0; i < outL.length; i++) {
      if (this._avail() < 2) {
        outL[i] = 0;
        if (out.length > 1) outR[i] = 0;
        continue;
      }
      // Linear interpolation between the current + next source frame.
      const i0 = this._read;
      const i1 = (this._read + 1) % this._ringSize;
      const f = this._frac;
      const l = this._ringL[i0] * (1 - f) + this._ringL[i1] * f;
      const r = this._ringR[i0] * (1 - f) + this._ringR[i1] * f;
      outL[i] = l * this._gain;
      if (out.length > 1) outR[i] = r * this._gain;
      // Advance the fractional read pointer.
      this._frac += ratio;
      while (this._frac >= 1) {
        this._frac -= 1;
        this._read = (this._read + 1) % this._ringSize;
        if (this._avail() < 1) break;
      }
    }
    return true;
  }
}

registerProcessor('snes9x-pcm', Snes9xPcmProcessor);
