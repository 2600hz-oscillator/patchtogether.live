// packages/dsp/src/samsloop.ts
//
// SAMSLOOP — loop-based sample player AudioWorklet.
//
// User uploads a .wav (≤2 MB), AudioContext.decodeAudioData turns it into
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
//   - trig  (audio-rate input, rising edge STARTS playback per the current
//           mode and resets the read-cursor to the window edge — start (or
//           end-1 if rate is negative). A gate can start/retrigger the
//           sample without uploading it again.).
//
// IDLE-BY-DEFAULT (no autoplay): the worklet keeps a private `playing`
// boolean that defaults to FALSE. While !playing the output is silence. A
// rising edge on `trig` OR a `{ type: 'trigger' }` port message (the on-card
// TRIGGER button) sets playing=true and resets the cursor to the window
// edge. Playback is MODE-AWARE: in one-shot (mode=0) the cursor running off
// the end of the window sets playing=false (stop, silent); in loop (mode=1)
// it wraps and stays playing. `loadSample` does NOT auto-start — a freshly
// loaded (or rehydrated) sample sits idle until triggered, so a patch load
// never spontaneously plays.
//
// Output is mono. The audio graph's stereo handling (StereoVCA, mixmstrs)
// can convert this to stereo downstream — matching other one-shot sources
// in the codebase (noise, analog-vco, macrooscillator's `out`).

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
/** Manual trigger from the on-card TRIGGER button. Equivalent to a `trig`
 *  gate rising edge: starts playback per the current mode and resets the
 *  cursor to the window edge. Works whether or not a cable is patched into
 *  the `trig` input. */
interface TriggerMessage {
  type: 'trigger';
}
type SamsloopMessage = LoadSampleMessage | ResetMessage | TriggerMessage;

const TRIG_THRESHOLD = 0.5;

/** How often the playhead is published to the main thread, in Hz.
 *
 *  ⚠ MATCHED TO THE RECORDER'S EXISTING CADENCE, not chosen fresh.
 *  `node-samsloop-registry` already publishes its live peak bar at 20 Hz and
 *  the waveform surface already re-reads on that beat, so a playhead on the
 *  same clock costs the consumer nothing extra. It is expressed in HZ and
 *  converted against the live `sampleRate` below — never in blocks, which
 *  would be a different wall-clock rate at every buffer size. */
const PLAYHEAD_HZ = 20;

/** A single read cursor. Mono runs exactly one of these; poly runs up to
 *  `maxVoices` and steals the oldest when they are all busy. */
interface Voice {
  /** Fractional read-cursor in sample-frames within `buffer`. */
  cursor: number;
  /** Emitting audio? Idle voices are skipped and are the free pool. */
  playing: boolean;
  /** Monotonic allocation stamp — the steal victim is the SMALLEST. */
  age: number;
}

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
      // ⚠ THE WINDOW IS A FRACTION OF THE SAMPLE (0..1), not a frame index.
      // The host param carries the knob PLUS any summed window CV, so these
      // arrive already modulated and the range must admit the overshoot a
      // full-depth CV produces — hence ±2 bounds on a 0..1 quantity, with the
      // real clamping done below in a DEFINED ORDER.
      { name: 'start', defaultValue: 0, minValue: -2, maxValue: 2, automationRate: 'k-rate' as const },
      { name: 'end',   defaultValue: 1, minValue: -2, maxValue: 2, automationRate: 'k-rate' as const },
      // 0 = mono (a re-trigger restarts the single cursor), 1 = poly (each
      // edge takes its own cursor and overlapping strikes layer).
      { name: 'poly',  defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
    ];
  }

  /** The decoded sample. Empty Float32Array until `loadSample` arrives. */
  private buffer: Float32Array = new Float32Array(0);
  /**
   * The voice pool. IDLE-BY-DEFAULT: every voice starts `playing: false` (no
   * autoplay). A trig rising edge / manual trigger starts one; in one-shot a
   * cursor running off the window stops that voice; in loop it wraps and stays.
   * `loadSample` never starts a voice — a rehydrated sample sits idle.
   *
   * ⚠ ALLOCATED ONCE, AT CONSTRUCTION. `process` runs on the audio thread, so
   * growing an array there would allocate in the render quantum. Mono simply
   * uses index 0 and leaves the rest idle.
   */
  private voices: Voice[] = [];
  /** Monotonic allocation counter feeding `Voice.age`. */
  private ageCounter = 0;
  /** How many voices poly mode may run. From `processorOptions.maxVoices`, so
   *  the number lives in ONE place (`midi-lane.ts`'s `MAX_POLY_VOICES`) rather
   *  than being re-typed across the package boundary — `packages/dsp` cannot
   *  import from `packages/web`. */
  private maxVoices = 1;
  /** A `{ type: 'trigger' }` port message arrived between process() blocks;
   *  honored at the top of the next block (same effect as a trig rising
   *  edge). Consumed (reset to false) once applied. */
  private pendingTrigger = false;
  /** Trigger edge detection. */
  private lastTrig = 0;
  /** Samples remaining until the next playhead publish. Counted DOWN per block
   *  against the block size, so the cadence is wall-clock stable regardless of
   *  how many render quanta the host chooses to run. */
  private playheadCountdown = 0;
  /** Was the last playhead publish an IDLE one? Lets the idle state be sent
   *  exactly once instead of twenty times a second forever. */
  private playheadWasIdle = false;
  /** Cursor scale = bufferSampleRate / contextSampleRate. At scale=1 the
   *  cursor advances one buffer-sample per output sample (legacy behavior:
   *  the buffer plays at the context's rate, NOT its captured rate, which
   *  is wrong when bufferRate ≠ contextRate). Set on `loadSample`; defaults
   *  to 1 so a stale buffer from before the host started passing
   *  sampleRate still plays. */
  private rateScale = 1;

  constructor(options?: { processorOptions?: { maxVoices?: number } }) {
    super(options);
    const requested = options?.processorOptions?.maxVoices;
    // Deny-by-default: an absent or nonsense option yields MONO (1 voice),
    // which is the historical behaviour — never a guessed poly width.
    this.maxVoices =
      typeof requested === 'number' && Number.isFinite(requested) && requested >= 1
        ? Math.floor(requested)
        : 1;
    for (let i = 0; i < this.maxVoices; i++) {
      this.voices.push({ cursor: 0, playing: false, age: 0 });
    }
    this.port.onmessage = (e: MessageEvent) => this.handleMessage(e.data as SamsloopMessage);
  }

  /** Silence every voice and rewind. */
  private stopAll(): void {
    for (const v of this.voices) {
      v.cursor = 0;
      v.playing = false;
    }
  }

  /**
   * Start a voice at `pos`.
   *
   * MONO (`poly` false) always drives voice 0 — a re-trigger RESTARTS it, which
   * is what a looper does and what this module has always done. POLY takes the
   * first idle voice, and STEALS THE OLDEST when they are all busy: the
   * same steal-oldest rule `midi-lane` applies under key pressure, so the two
   * ends of a real MIDI chain agree about which note dies.
   */
  private startVoice(pos: number, poly: boolean): void {
    if (!poly) {
      const v = this.voices[0]!;
      v.cursor = pos;
      v.playing = true;
      v.age = ++this.ageCounter;
      return;
    }
    let victim: Voice | undefined;
    for (const v of this.voices) {
      if (!v.playing) { victim = v; break; }
      if (!victim || v.age < victim.age) victim = v;
    }
    if (!victim) return;
    victim.cursor = pos;
    victim.playing = true;
    victim.age = ++this.ageCounter;
  }

  private handleMessage(msg: SamsloopMessage): void {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'loadSample') {
      if (!(msg.samples instanceof ArrayBuffer)) return;
      this.buffer = new Float32Array(msg.samples);
      // IDLE-BY-DEFAULT: loading a sample does NOT start playback. The
      // sample sits silent until a trig edge / manual trigger fires.
      this.stopAll();
      this.pendingTrigger = false;
      // Update the cursor scale. If the host omitted sampleRate we default
      // to the context rate so the cursor advances 1 sample per output
      // frame (the legacy behavior — keeps old saved patches sounding the
      // same as they did before the rate-mapping rework).
      const bufRate = typeof msg.sampleRate === 'number' && msg.sampleRate > 0
        ? msg.sampleRate
        : sampleRate;
      this.rateScale = bufRate / sampleRate;
    } else if (msg.type === 'trigger') {
      // Manual trigger (the on-card TRIGGER button). Same effect as a trig
      // gate rising edge — deferred to the top of the next process() block
      // so the cursor resets relative to the live start/end window there.
      this.pendingTrigger = true;
    } else if (msg.type === 'reset') {
      // Stop + rewind. Stays idle (silent) until the next trigger.
      this.stopAll();
      this.pendingTrigger = false;
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
    const polyArr = parameters.poly!;
    const trigIn = inputs[0]?.[0];

    // k-rate params: read once per block.
    const mode = Math.round(modeArr[0] ?? 1); // 0=one-shot, 1=loop
    const poly = Math.round(polyArr[0] ?? 0) === 1;
    const len = this.buffer.length;

    // ⚠ MONO RETIRES THE EXTRA VOICES, and leaving this out was a real defect
    // rather than untidiness. The render loop below only walks voice 0 when
    // `poly` is false, so voices started in POLY and still `playing` when the
    // switch flips are neither rendered NOR advanced — they freeze. Two things
    // then go wrong, and neither is silent:
    //
    //   * the PLAYHEAD publish walks the whole pool, so a frozen voice is still
    //     counted and can WIN the newest-age lead — the faceplate draws a
    //     stationary playhead that never moves again;
    //   * flipping back to POLY resurrects them from their frozen cursors, so
    //     stale voices burst back in mid-sample.
    //
    // Stopping them here is idempotent and costs one boolean check per voice
    // per BLOCK (not per sample), which is nothing against the per-sample loop.
    if (!poly) {
      for (let v = 1; v < this.voices.length; v++) {
        const extra = this.voices[v]!;
        if (extra.playing) {
          extra.playing = false;
          extra.cursor = 0;
        }
      }
    }

    // ── THE WINDOW, RESOLVED IN A DEFINED ORDER ────────────────────────────
    //
    // These params arrive as FRACTIONS of the sample carrying the knob PLUS any
    // summed window CV, so both can be driven outside [0,1] at once.
    //
    // ⚠ THE ORDER IS LOAD-BEARING AND IT IS *END FIRST*. The natural statement
    // of the rule — "start is bounded by end, end is bounded by start" — is
    // MUTUALLY RECURSIVE and has no defined answer when both cables move
    // together. Resolving END against the sample and then START against the
    // resolved END breaks the cycle in the direction the controls are actually
    // used: END says how much of the sample is in play, START says where inside
    // it to begin. It reproduces both anchors exactly — at the defaults a full
    // +CV on START walks it to the far end, and a full −CV on END walks the
    // window back to the beginning.
    const endFrac = Math.max(0, Math.min(1, endArr[0] ?? 1));
    const startFrac = Math.max(0, Math.min(endFrac, startArr[0] ?? 0));

    // Fraction → frames, then the defensive floor that guarantees a window at
    // least one frame wide (a zero-width window would divide by zero in the
    // loop wrap below).
    const start = Math.max(0, Math.min(len - 1, Math.floor(startFrac * len)));
    const end = Math.max(start + 1, Math.min(len, Math.ceil(endFrac * len)));

    // Apply a pending manual trigger (from the on-card TRIGGER button) at
    // the top of the block — same effect as a trig gate rising edge, but
    // resolved against the live start/end window here. Direction follows
    // the block's leading rate sample.
    if (this.pendingTrigger) {
      const rate0 = rateArr[0] ?? 1;
      this.startVoice(rate0 >= 0 ? start : end - 1, poly);
      this.pendingTrigger = false;
    }

    const winLen = end - start;

    for (let i = 0; i < out.length; i++) {
      // Trigger rising-edge → START sample playback from the window edge
      // (start if playing forward, end-1 if playing reverse). Detect the edge
      // before sample emission so the very first sample of the new burst lands
      // in this same frame. From idle this is what begins playback (no
      // autoplay); in MONO an edge while already playing RESTARTS the single
      // cursor, in POLY it takes another one.
      if (trigIn) {
        const t = trigIn[i] ?? 0;
        if (this.lastTrig < TRIG_THRESHOLD && t >= TRIG_THRESHOLD) {
          const rate0 = rateArr.length > 1 ? (rateArr[i] ?? 1) : (rateArr[0] ?? 1);
          this.startVoice(rate0 >= 0 ? start : end - 1, poly);
        }
        this.lastTrig = t;
      }

      const rate = rateArr.length > 1 ? (rateArr[i] ?? 1) : (rateArr[0] ?? 1);
      const step = rate * this.rateScale;

      // ⚠ VOICES SUM, THEY DO NOT AVERAGE. Dividing by the active count would
      // make every voice quieter the moment a second one starts — a duck on
      // every overlap, which is not what layering a looper sounds like. Mono is
      // bit-identical to the single-cursor behaviour this replaced, because
      // exactly one voice is ever active.
      let acc = 0;
      // Mono only ever runs voice 0; skipping the rest keeps the per-sample
      // cost identical to the pre-poly loop rather than paying for 16 idle
      // checks on every frame of every mono samsloop in the rack.
      const active = poly ? this.voices.length : 1;
      for (let v = 0; v < active; v++) {
        const voice = this.voices[v]!;
        if (!voice.playing) continue;

        // Read the fractional sample at this voice's cursor.
        acc += this.read(voice.cursor);

        // Advance by the current rate (a-rate so CV reads sample-accurate),
        // scaled by bufferRate/contextRate so rate=1.0 plays at the sample's
        // captured pitch regardless of the AudioContext's native rate.
        // rate=0 freezes; rate<0 reverses.
        voice.cursor += step;

        // Handle window crossings, by direction (forward/reverse) and mode.
        if (voice.cursor >= end) {
          if (mode === 1) {
            // Loop: wrap forward through the window. fmod-style so a very high
            // rate doesn't take many trips around to settle.
            voice.cursor = start + ((voice.cursor - start) % winLen);
          } else {
            // One-shot: the pass is complete — stop this voice.
            voice.cursor = end;
            voice.playing = false;
          }
        } else if (voice.cursor < start) {
          if (mode === 1) {
            // Mirror the wrap formula for negative excursion.
            const overshoot = start - voice.cursor;
            voice.cursor = end - (overshoot % winLen);
          } else {
            voice.cursor = start;
            voice.playing = false;
          }
        }
      }
      out[i] = acc;
    }

    // ── PLAYHEAD PUBLISH ───────────────────────────────────────────────────
    //
    // ⚠ ONE MESSAGE PER ~20 Hz, NOT PER BLOCK. At 128 frames and 48 kHz a
    // per-block post is 375 messages a second per samsloop in the rack, all
    // landing on the main thread that is also drawing the waveform. The
    // countdown is in SAMPLES so the cadence is wall-clock stable whatever
    // render-quantum size the host picks.
    //
    // ⚠ AND IT IS A FRACTION, NOT A FRAME INDEX — same reason the window is:
    // the consumer draws into a canvas of its own width and would otherwise
    // need the buffer length to mean anything by the number. `-1` means "no
    // voice is sounding", which a fraction cannot otherwise express.
    this.playheadCountdown -= out.length;
    if (this.playheadCountdown <= 0) {
      this.playheadCountdown = Math.max(1, Math.floor(sampleRate / PLAYHEAD_HZ));
      let lead = -1;
      let leadAge = -1;
      let voicesPlaying = 0;
      for (const v of this.voices) {
        if (!v.playing) continue;
        voicesPlaying++;
        // The NEWEST voice is the one a player is watching — it is the one
        // their last strike started.
        if (v.age > leadAge) {
          leadAge = v.age;
          lead = len > 0 ? v.cursor / len : -1;
        }
      }
      // ⚠ AN IDLE MODULE GOES QUIET, rather than repeating "-1" twenty times a
      // second for as long as the rack is open. The FIRST idle publish still
      // goes out — that is the edge the consumer needs to clear its playhead —
      // and only the repeats are suppressed.
      if (voicesPlaying > 0 || !this.playheadWasIdle) {
        this.port.postMessage({ type: 'playhead', position: lead, voices: voicesPlaying });
      }
      this.playheadWasIdle = voicesPlaying === 0;
    }
    return true;
  }
}

registerProcessor('samsloop', SamsloopProcessor);
