// packages/web/static/blood/blood-pcm-worklet.js
//
// AudioWorkletProcessor for the BLOOD module's PCM output.
//
// The NBlood (Build-engine) WASM lives on the main thread (Emscripten's
// single-threaded ASYNCIFY build) so we can't pull samples from the audio
// thread. Instead the BLOOD module's main-thread pump loop:
//
//   1. Drives MultiVoc's mixer (bpt_pump_audio -> driver_sdl fillData ->
//      MV_ServiceVoc), which renders SFX *and* the OPL3 music synth into
//      interleaved 16-bit stereo pages.
//   2. Drains those pages via bpt_get_pcm_buffer (int16 L,R,L,R...).
//   3. Converts s16 -> f32 and postMessage's an INTERLEAVED chunk here.
//
// This processor keeps a per-channel f32 ring (de-interleaved on enqueue) and
// drains it into the per-callback stereo output. Underrun = silence; overrun =
// drop oldest frame (the audio thread always wins). No dependency on
// `currentTime` / `sampleRate` — we drain at audio-callback cadence.
//
// Unlike DOOM (mono i_pcmgen, duplicated to both channels), MultiVoc mixes REAL
// STEREO, so we keep distinct L/R rings and write out[0]=L, out[1]=R. The
// module routes this node through a ChannelSplitter so audio_l + audio_r can be
// patched to different downstream sinks.
//
// ⚠ RATE, AND THE OLD VERSION OF THIS PARAGRAPH WAS WRONG ABOUT ITS OWN APP.
// It said MultiVoc's 44100 (Blood config.cpp MixRate) "matches the AudioContext
// default in every supported browser", with the mismatch case as a hypothetical
// follow-up. It is not hypothetical here: `Canvas.svelte` PINS the context to
// 48 000 Hz on purpose (every ART baseline and worklet time-constant is
// calibrated at one rate), so Blood has always played ~8.8 % sharp. That pitch
// shift is real, is unchanged by this file, and still wants a resampler.
//
// What it is NOT is the reason the module went silent — the two are independent.
// Pitch is samples-per-second on the way OUT; the silence was how many samples
// the main thread ever handed IN (see the ring comment below).
//
// LOUDNESS: MultiVoc already mixes at proper levels and clamps to int16, so the
// /32768 conversion lands near unity for a loud SFX (no DOOM-style -42 dB makeup
// needed). MAKEUP is a small fixed trim; the user's `audioGain` (this._gain) is
// applied on top, and a tanh soft-limiter keeps a summed firefight from
// hard-clipping (transparent at normal levels).
const MAKEUP = 1.0;

class BloodPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // ⚠ THE OLD SIZE WAS 44100 AND ITS COMMENT WAS FALSE, WHICH IS WHY THIS ONE
    // CITES A MEASUREMENT. It said "the main thread tops up every ~16 ms (~735
    // frames), so this is generous headroom to ride out a long render frame". The
    // headroom did not exist: 735 frames per tick is a 44.1 kHz budget, the
    // context is pinned to 48 kHz, and the tick only fires when the Build engine
    // leaves the main thread free — measured at 24.8 ms on an IDLE 10-core box,
    // i.e. 29 846 frames/s produced against 48 000 drained. A ring whose producer
    // never once outruns its consumer cannot hold ANY cushion, so its size was
    // irrelevant and 38 % of every output sample was a hard zero.
    //
    // `$lib/blood/blood-pcm-schedule.ts` fixed the producer; this is the ring that
    // now has something to hold. 2 s at 48 kHz: the scheduler's MAX_CUSHION_S is
    // 1 s and one catch-up tick may add up to MAX_PER_TICK_S (1.25 s) on top, so
    // the ring must exceed their sum or the overrun path would eat a catch-up.
    this._ringFrames = 96000;
    this._ringL = new Float32Array(this._ringFrames);
    this._ringR = new Float32Array(this._ringFrames);
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
        this._ringL.fill(0);
        this._ringR.fill(0);
      } else if (data.type === 'gain' && typeof data.value === 'number') {
        this._gain = Math.max(0, Math.min(4, data.value));
      }
    };
  }

  // `inter` is interleaved L,R,L,R... (length = frames * 2). De-interleave into
  // the per-channel rings; on overrun advance read (drop oldest frame).
  _enqueue(inter) {
    const frames = inter.length >> 1;
    for (let i = 0; i < frames; i++) {
      const next = (this._write + 1) % this._ringFrames;
      if (next === this._read) {
        this._read = (this._read + 1) % this._ringFrames; // full — drop oldest
      }
      this._ringL[this._write] = inter[2 * i];
      this._ringR[this._write] = inter[2 * i + 1];
      this._write = next;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const l = out[0];
    const r = out.length > 1 ? out[1] : null;
    const g = this._gain * MAKEUP;
    for (let i = 0; i < l.length; i++) {
      if (this._read === this._write) {
        l[i] = 0;
        if (r) r[i] = 0;
      } else {
        // tanh soft-saturation: ~linear at normal levels, smoothly rolling
        // toward +/-1 for a loud firefight so makeup never hard-clips.
        l[i] = Math.tanh(this._ringL[this._read] * g);
        const rr = Math.tanh(this._ringR[this._read] * g);
        if (r) r[i] = rr;
        this._read = (this._read + 1) % this._ringFrames;
      }
    }
    // Any channels beyond stereo stay silent (we only fill 0/1).
    for (let c = 2; c < out.length; c++) out[c].fill(0);
    return true;
  }
}

registerProcessor('blood-pcm', BloodPcmProcessor);
