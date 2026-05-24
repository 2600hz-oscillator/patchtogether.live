// packages/web/static/doom/doom-pcm-worklet.js
//
// AudioWorkletProcessor for the DOOM module's PCM output.
//
// The doomgeneric WASM lives on the main thread (Emscripten's default
// single-threaded build) so we can't pull samples directly from the
// audio thread. Instead, the DOOM module's main-thread tick loop:
//
//   1. Pumps the WASM mixer (I_UpdateSound via dgpt_tick).
//   2. Drains the WASM ring buffer via dg_get_pcm_buffer (int16 mono).
//   3. Converts s16 → f32 and postMessage's a chunk to this worklet.
//
// This processor maintains its own f32 ring queue + drains it into
// the per-callback output[0] (mono, duplicated by Web Audio to L+R
// when the downstream sink is stereo). Underrun = silence; overrun =
// drop oldest (the audio thread always wins).
//
// Message protocol (postMessage from main thread → this worklet):
//   { type: 'pcm', samples: Float32Array }   — enqueue
//   { type: 'reset' }                         — clear the queue
//
// No dependency on `currentTime` or `sampleRate` — we just drain at
// audio-callback cadence, which the context already enforces.
//
// Note: Web Audio destinations want sample rate to match the context's
// sampleRate. We let the main thread handle rate conversion; the WASM
// outputs at 44100 (see DG_OUTPUT_RATE in i_pcmgen.c), and the audio
// context defaults to 44100 in every supported browser. If a future
// user spawns the module under a non-default sampleRate context we'll
// pitch-shift gracefully (chipmunk DOOM); a proper resampler is a
// follow-up.

class DoomPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Ring buffer sized for ~1 second of audio at 44100 Hz. Way more
    // than we need — the main thread tops up every video frame
    // (16 ms = 705 samples). Plenty of headroom to ride out a long
    // render frame without underrunning.
    this._ringSize = 44100;
    this._ring = new Float32Array(this._ringSize);
    this._read = 0;
    this._write = 0;
    this._gain = 1.0;

    this.port.onmessage = (ev) => {
      const data = ev.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'pcm' && data.samples instanceof Float32Array) {
        this._enqueue(data.samples);
      } else if (data.type === 'reset') {
        this._read = 0;
        this._write = 0;
        this._ring.fill(0);
      } else if (data.type === 'gain' && typeof data.value === 'number') {
        this._gain = Math.max(0, Math.min(4, data.value));
      }
    };
  }

  _enqueue(samples) {
    // Append samples to the ring; on overrun, advance read pointer to
    // make room (drop oldest).
    for (let i = 0; i < samples.length; i++) {
      const next = (this._write + 1) % this._ringSize;
      if (next === this._read) {
        // Full — drop oldest.
        this._read = (this._read + 1) % this._ringSize;
      }
      this._ring[this._write] = samples[i];
      this._write = next;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    // Mono mix gets duplicated into every output channel — the DOOM
    // module routes the workletNode through a ChannelSplitter so
    // audio_l + audio_r can be patched to different downstream sinks
    // without one going silent. (i_pcmgen mixes mono today; if/when we
    // upgrade to real stereo we'd write distinct ring buffers per
    // channel here.)
    const ch0 = out[0];
    for (let i = 0; i < ch0.length; i++) {
      if (this._read === this._write) {
        ch0[i] = 0;
      } else {
        ch0[i] = this._ring[this._read] * this._gain;
        this._read = (this._read + 1) % this._ringSize;
      }
    }
    for (let c = 1; c < out.length; c++) {
      out[c].set(ch0);
    }
    return true;
  }
}

registerProcessor('doom-pcm', DoomPcmProcessor);
