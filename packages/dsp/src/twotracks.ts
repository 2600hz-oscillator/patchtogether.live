// packages/dsp/src/twotracks.ts
//
// TWOTRACKS — tape loop emulator AudioWorklet (reel A, phase 1).
//
// A single worklet handles both playback AND record for reel A. The internal
// ring buffer is two separate Float32Arrays (one per channel) so L and R are
// NOT interleaved — the worklet reads out[L] and out[R] from separate arrays,
// which avoids the stride arithmetic of an interleaved store and makes the
// linear-interp read simple.
//
// Buffer layout: two parallel arrays, `bufL[n]` and `bufR[n]`, each indexed
// by the fractional `cursor` (same value for both). When recording mono input
// (only L patched), R mirrors L.
//
// DSP state machine (transport axis 1 = write mode; axis 2 = play/stop):
//   play modes: idle, play, armed, rec, overdub
//   write modes: within rec/overdub the `overdubFlag` bool picks destructive
//   (rec) vs additive (overdub). Axes are orthogonal — loop vs one-shot is a
//   separate `mode` param (0 = one-shot, 1 = loop tape).
//
// Gate inputs (rising-edge detected):
//   rec_start_a → enter REC (destructive) or OVERDUB (additive) based on overdubFlag
//   rec_arm_a   → enter ARMED (waits for cursor to cross start before recording)
//   overdub_a   → TOGGLE the overdub flag; if currently in REC↔OVERDUB, swap.
//
// Overdub formula: buffer[n] = buffer[n] * decayFactor + input[n]
//   decayFactor = lerp(0.90, 0.50, decay_param) — 0.90 at decay=0, 0.50 at decay=1
//   Applied at the start of each new recording pass (crossing `start` in loop mode,
//   entering rec/overdub in one-shot mode) by setting a `pendingDecay` flag.
//
// Playhead reporting: the worklet posts `{ type: 'playhead', pos: 0..1 }` every
// ~128 samples so the card can animate the playhead line. The host writes the
// raw cursor / (end - start) normalized inside the window.
//
// One-shot mode stop: cursor reaching `end` stops recording → enters PLAY;
// cursor in PLAY reaching `end` → stops (IDLE). Loop tape wraps forever.
//
// Max buffer: TWOTRACKS_MAX_SAMPLES (≈ 30 s at 48 kHz). The host can resize
// the window with `start`/`end` normalized params.

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum tape length in samples (per channel). ~30 s at 48 kHz. */
const TWOTRACKS_MAX_SAMPLES = 1_440_000;

const TRIG_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Message types (host → worklet)
// ---------------------------------------------------------------------------

interface ResizeMessage {
  /** Resize the recording buffer (does NOT reset playback position). */
  type: 'resize';
  /** New length in samples (clamped to TWOTRACKS_MAX_SAMPLES). */
  length: number;
}

interface ResetMessage {
  /** Stop playback + reset cursor to start. */
  type: 'reset';
}

/** Explicit playhead seek. Host sends this on pointer-up after scrub. */
interface SeekMessage {
  /** Seek to a normalized position (0..1 within the current window). */
  type: 'seek';
  pos: number;
}

type TwoTracksMessage = ResizeMessage | ResetMessage | SeekMessage;

// ---------------------------------------------------------------------------
// Transport states
// ---------------------------------------------------------------------------

type TapeState = 'idle' | 'play' | 'armed' | 'rec' | 'overdub';

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

class TwoTracksProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // ---- Playback ----
      /** Varispeed rate. 1.0 = forward unity, -1 = reverse unity, 0 = frozen. */
      { name: 'rate', defaultValue: 1, minValue: -3, maxValue: 3, automationRate: 'a-rate' as const },
      /** 0 = one-shot (cursor stops at end), 1 = loop tape (wraps). */
      { name: 'mode', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      /** Normalized start of the window [0..1] relative to buffer length. */
      { name: 'start', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      /** Normalized end of the window [0..1] relative to buffer length. */
      { name: 'end', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      // ---- Record ----
      /** Overdub decay factor lerp control [0..1]. 0 → 0.90, 1 → 0.50. */
      { name: 'decay', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      // ---- Gate inputs (audio-rate rising-edge detected) ----
      /** Rising edge → enter REC or OVERDUB (based on overdubFlag). */
      { name: 'rec_start', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      /** Rising edge → enter ARMED. */
      { name: 'rec_arm', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      /** Rising edge → toggle overdub flag (and swap rec↔overdub if active). */
      { name: 'overdub_toggle', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
    ];
  }

  // ---- Ring buffers (stereo, separate L and R) ----
  private bufL: Float32Array = new Float32Array(TWOTRACKS_MAX_SAMPLES);
  private bufR: Float32Array = new Float32Array(TWOTRACKS_MAX_SAMPLES);
  /** Active recording length in samples. Grows from 0 to MAX. */
  private bufLen: number = 0;

  // ---- Playback cursor ----
  /** Fractional cursor in sample-frames within [windowStart, windowEnd]. */
  private cursor: number = 0;

  // ---- Transport state ----
  private state: TapeState = 'idle';
  /** When true, write mode is additive (overdub); when false, destructive (rec). */
  private overdubFlag: boolean = false;
  /** Set at the start of a new recording pass to apply decayFactor once. */
  private pendingDecay: boolean = false;

  // ---- Edge detection for gate params ----
  private lastRecStart: number = 0;
  private lastRecArm: number = 0;
  private lastOverdubToggle: number = 0;

  // ---- Playhead reporting ----
  /** Throttle: only post once per process() block. */
  private playheadFrameCount: number = 0;
  private readonly PLAYHEAD_INTERVAL = 4; // every 4 blocks ≈ 11 ms at 48 kHz

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.port.onmessage = (e: MessageEvent) => this.handleMessage(e.data as TwoTracksMessage);
  }

  private handleMessage(msg: TwoTracksMessage): void {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'resize') {
      const len = Math.max(1, Math.min(TWOTRACKS_MAX_SAMPLES, msg.length));
      this.bufLen = len;
    } else if (msg.type === 'reset') {
      this.cursor = 0;
      this.state = 'idle';
      this.pendingDecay = false;
    } else if (msg.type === 'seek') {
      // Clamp to [0, 1]
      const p = Math.max(0, Math.min(1, msg.pos));
      // Map into the current window
      const rawStart = this.bufLen > 0 ? 0 : 0; // will be resolved in process()
      // We store the raw cursor; window mapping is done in process()
      // For simplicity, store it as the normalized value and apply in the
      // next process() block — we don't have start/end params here.
      // Instead, post a seek that the next process() block applies.
      this._pendingSeek = p;
    }
  }

  private _pendingSeek: number | null = null;

  /** Linear interpolation read from a channel buffer. */
  private readChan(buf: Float32Array, pos: number): number {
    const len = buf.length;
    if (len === 0) return 0;
    if (pos < 0) return 0;
    if (pos >= len - 1) {
      if (pos < len) return buf[len - 1] ?? 0;
      return 0;
    }
    const i = Math.floor(pos);
    const f = pos - i;
    const a = buf[i] ?? 0;
    const b = buf[i + 1] ?? 0;
    return a + (b - a) * f;
  }

  /** Apply overdub decay to the entire active window. */
  private applyDecay(windowStart: number, windowEnd: number, decayFactor: number): void {
    const s = Math.floor(windowStart);
    const e = Math.min(Math.ceil(windowEnd), this.bufLen);
    for (let i = s; i < e; i++) {
      this.bufL[i]! *= decayFactor;
      this.bufR[i]! *= decayFactor;
    }
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const outL = outputs[0]?.[0];
    const outR = outputs[0]?.[1];

    // Always keep the node alive even if not producing output.
    if (!outL && !outR) return true;

    const rateArr  = parameters.rate!;
    const modeVal  = Math.round(parameters.mode![0] ?? 1); // 0=one-shot, 1=loop
    const startNorm = parameters.start![0] ?? 0;
    const endNorm   = parameters.end![0] ?? 1;
    const decayParam = parameters.decay![0] ?? 0;

    const recStartArr     = parameters.rec_start!;
    const recArmArr       = parameters.rec_arm!;
    const overdubTogArr   = parameters.overdub_toggle!;

    // Audio inputs: L on input[0][0], R on input[1][0].
    // R normalizes to L when unpatched (same stereovca / samsloop-tap pattern).
    const inL = inputs[0]?.[0];
    const inR = inputs[1]?.[0] ?? inL;

    // Compute absolute window in samples.
    const maxLen = this.bufLen > 0 ? this.bufLen : TWOTRACKS_MAX_SAMPLES;
    const windowStart = Math.max(0, Math.min(maxLen - 1, startNorm * maxLen));
    const windowEnd   = Math.max(windowStart + 1, Math.min(maxLen, endNorm * maxLen));
    const windowLen   = windowEnd - windowStart;

    // Decay factor for overdub (lerp 0.90..0.50 over decay param 0..1).
    const decayFactor = 0.90 - decayParam * 0.40;

    // Apply pending seek (from host pointer-up).
    if (this._pendingSeek !== null) {
      this.cursor = windowStart + this._pendingSeek * windowLen;
      this._pendingSeek = null;
    }

    // Ensure cursor is within the window after param changes.
    if (this.cursor < windowStart || this.cursor > windowEnd) {
      this.cursor = windowStart;
    }

    const blockLen = outL?.length ?? outR?.length ?? 128;

    for (let i = 0; i < blockLen; i++) {
      // ---- Gate edge detection ----
      const recStartVal   = recStartArr.length > 1 ? (recStartArr[i] ?? 0) : (recStartArr[0] ?? 0);
      const recArmVal     = recArmArr.length > 1   ? (recArmArr[i]   ?? 0) : (recArmArr[0]   ?? 0);
      const overdubTogVal = overdubTogArr.length > 1 ? (overdubTogArr[i] ?? 0) : (overdubTogArr[0] ?? 0);

      // rec_arm rising edge → ARMED
      if (this.lastRecArm < TRIG_THRESHOLD && recArmVal >= TRIG_THRESHOLD) {
        this.state = 'armed';
        this.pendingDecay = true; // apply decay at next pass-start
      }
      this.lastRecArm = recArmVal;

      // rec_start rising edge → REC or OVERDUB
      if (this.lastRecStart < TRIG_THRESHOLD && recStartVal >= TRIG_THRESHOLD) {
        if (this.state !== 'rec' && this.state !== 'overdub') {
          this.state = this.overdubFlag ? 'overdub' : 'rec';
          this.pendingDecay = true;
          // In one-shot mode, jump cursor to start immediately.
          if (modeVal === 0) {
            this.cursor = windowStart;
            if (this.pendingDecay) {
              this.applyDecay(windowStart, windowEnd, decayFactor);
              this.pendingDecay = false;
            }
          }
        }
      }
      this.lastRecStart = recStartVal;

      // overdub_toggle rising edge → flip overdub flag; swap rec↔overdub if active
      if (this.lastOverdubToggle < TRIG_THRESHOLD && overdubTogVal >= TRIG_THRESHOLD) {
        this.overdubFlag = !this.overdubFlag;
        if (this.state === 'rec') this.state = 'overdub';
        else if (this.state === 'overdub') this.state = 'rec';
      }
      this.lastOverdubToggle = overdubTogVal;

      // ---- ARMED: wait for cursor to cross windowStart ----
      if (this.state === 'armed') {
        // In loop mode, we wait until the cursor naturally reaches windowStart.
        // Trigger immediately in one-shot mode.
        const rate0 = rateArr.length > 1 ? (rateArr[i] ?? 1) : (rateArr[0] ?? 1);
        if (modeVal === 0 || Math.abs(this.cursor - windowStart) < Math.abs(rate0) + 1) {
          this.state = this.overdubFlag ? 'overdub' : 'rec';
          this.pendingDecay = true;
          if (modeVal === 0) {
            this.cursor = windowStart;
          }
        }
      }

      // ---- Decay application at start of recording pass ----
      if (this.pendingDecay && (this.state === 'rec' || this.state === 'overdub')) {
        if (this.state === 'overdub') {
          this.applyDecay(windowStart, windowEnd, decayFactor);
        }
        this.pendingDecay = false;
      }

      // ---- Read ----
      const sampleL = this.readChan(this.bufL, this.cursor);
      const sampleR = this.readChan(this.bufR, this.cursor);

      // ---- Write (record) ----
      if ((this.state === 'rec' || this.state === 'overdub') && this.cursor >= 0) {
        const ci = Math.floor(this.cursor);
        if (ci >= 0 && ci < TWOTRACKS_MAX_SAMPLES) {
          const srcL = inL ? (inL[i] ?? 0) : 0;
          const srcR = inR ? (inR[i] ?? 0) : srcL;

          if (this.state === 'overdub') {
            // Additive: blend. Decay already applied at pass start.
            this.bufL[ci]! += srcL;
            this.bufR[ci]! += srcR;
          } else {
            // Destructive: overwrite.
            this.bufL[ci] = srcL;
            this.bufR[ci] = srcR;
          }
          // Grow the active buffer length if recording beyond the current end.
          if (ci >= this.bufLen) {
            this.bufLen = ci + 1;
          }
        }
      }

      // ---- Output ----
      const isActive = this.state !== 'idle';
      if (outL) outL[i] = isActive ? sampleL : 0;
      if (outR) outR[i] = isActive ? sampleR : 0;

      // ---- Advance cursor ----
      const rate = rateArr.length > 1 ? (rateArr[i] ?? 1) : (rateArr[0] ?? 1);
      this.cursor += rate;

      // ---- Window boundary handling ----
      if (this.cursor >= windowEnd) {
        if (modeVal === 1) {
          // Loop: wrap.
          const ov = (this.cursor - windowStart) % windowLen;
          this.cursor = windowStart + ov;
          // At loop-wrap: if recording in overdub mode, apply decay for the new pass.
          if (this.state === 'overdub') {
            this.applyDecay(windowStart, windowEnd, decayFactor);
          }
        } else {
          // One-shot: cursor reached end.
          this.cursor = windowEnd;
          if (this.state === 'rec' || this.state === 'overdub') {
            // Recording pass done → play.
            this.state = 'play';
            this.cursor = windowStart;
          } else if (this.state === 'play') {
            // Playback done → idle.
            this.state = 'idle';
            this.cursor = windowStart;
          }
        }
      } else if (this.cursor < windowStart) {
        // Reverse direction.
        if (modeVal === 1) {
          const ov = (windowStart - this.cursor) % windowLen;
          this.cursor = windowEnd - ov;
        } else {
          this.cursor = windowStart;
          if (this.state === 'rec' || this.state === 'overdub') {
            this.state = 'play';
          } else if (this.state === 'play') {
            this.state = 'idle';
          }
        }
      }
    }

    // ---- Playhead reporting (throttled) ----
    this.playheadFrameCount++;
    if (this.playheadFrameCount >= this.PLAYHEAD_INTERVAL) {
      this.playheadFrameCount = 0;
      const normalized = windowLen > 0
        ? Math.max(0, Math.min(1, (this.cursor - windowStart) / windowLen))
        : 0;
      try {
        this.port.postMessage({ type: 'playhead', pos: normalized, state: this.state });
      } catch { /* worklet may be torn down */ }
    }

    return true;
  }
}

registerProcessor('twotracks', TwoTracksProcessor);
