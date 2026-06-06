// packages/dsp/src/lfo.ts
//
// Clockable LFO. Outputs four phases (0°, 90°, 180°, 270°) of a single
// underlying oscillator. Shape morphs continuously sine → saw → square via
// the `shape` AudioParam (0=sine, 1=saw, 2=square).
//
// Phase 1 of the shared-state-sync plan: phase is anchored to a shared
// timeline (epoch). Two clients with the same epoch + same `rate` arrive
// at the same phase sample-for-sample. The host sends `init` once on
// construction and `resync` every 5 s with the latest shared-time origin;
// the worklet smooths phase corrections over 200 ms (linear ramp) so a
// sub-millisecond clock-drift doesn't click.
//
// External clock pulses on input 0 still reset phase to zero on each
// rising edge — useful for tempo-synced modulation off a shared sequencer.
//
// Sample-and-hold of the audio CV input for `rate` happens at the start
// of each block (see RATE_SAMPLE_HOLD below) — avoids audio-rate skew
// between clients whose CV inputs trail by sub-block latency differences.

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  process?(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}
declare function registerProcessor(
  name: string,
  ctor: typeof AudioWorkletProcessor
): void;

const TWO_PI = Math.PI * 2;
const CLOCK_THRESHOLD = 0.5;
const RESYNC_SMOOTH_SAMPLES_DEFAULT = 0; // updated when init message arrives

interface InitMessage {
  type: 'init';
  epoch_ms: number;
  audioOrigin_s: number;
  smoothing_ms?: number;
}
interface ResyncMessage {
  type: 'resync';
  epoch_ms: number;
  audioOrigin_s: number;
  smoothing_ms?: number;
}
interface ResetMessage {
  type: 'reset';
}
type LfoMessage = InitMessage | ResyncMessage | ResetMessage;

class LfoProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // 0.01 Hz (one cycle per ~100s) up to 100 Hz (audio-rate-ish for FM uses).
      { name: 'rate',  defaultValue: 1, minValue: 0.01, maxValue: 100, automationRate: 'a-rate' as const },
      // 0=pure sine, 1=pure saw, 2=pure square. Linear interpolation between
      // the adjacent shapes for in-between values (e.g. 0.5 = sine ⇄ saw mix).
      { name: 'shape', defaultValue: 0, minValue: 0,    maxValue: 2,   automationRate: 'a-rate' as const },
      // Output amplitude / depth. The emitted value is scaled by
      // (depth * 2): depth=0 → still (flat at the resting/centre value),
      // depth=0.5 → unity (legacy behaviour), depth=1 → 2× (deliberately
      // out of the normal [-1,1] range, NOT clamped). depth_cv sums into
      // this param at the engine layer like the other CV inputs.
      { name: 'depth', defaultValue: 0.5, minValue: 0,  maxValue: 1,   automationRate: 'a-rate' as const },
    ];
  }

  private phase = 0;
  private lastClockSample = 0;

  // Shared-clock anchoring. epochMs + audioOriginS describe the mapping
  // ctx.currentTime → shared-time-ms. While unset (pre-init) the LFO
  // free-runs from phase=0 (legacy behavior).
  private epochMs: number | null = null;
  private audioOriginS: number = 0;

  // Phase-correction smoothing: when a resync arrives we measure the
  // expected vs. actual phase at the next block boundary, then ramp the
  // delta to zero over `smoothSamplesTotal` samples.
  private smoothDelta = 0;
  private smoothSamplesRemaining = 0;
  private smoothSamplesTotal = RESYNC_SMOOTH_SAMPLES_DEFAULT;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => this.handleMessage(e.data as LfoMessage);
  }

  private handleMessage(msg: LfoMessage): void {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'init') {
      this.epochMs = msg.epoch_ms;
      this.audioOriginS = msg.audioOrigin_s;
      const sm = msg.smoothing_ms ?? 0;
      this.smoothSamplesTotal = Math.max(0, Math.round((sm * sampleRate) / 1000));
      // Snap immediately on init — there's no audio history to protect.
      this.phase = 0;
      this.smoothDelta = 0;
      this.smoothSamplesRemaining = 0;
    } else if (msg.type === 'resync') {
      this.epochMs = msg.epoch_ms;
      this.audioOriginS = msg.audioOrigin_s;
      const sm = msg.smoothing_ms ?? 200;
      this.smoothSamplesTotal = Math.max(1, Math.round((sm * sampleRate) / 1000));
      // Don't snap — handle in process() so the smoothing applies.
    } else if (msg.type === 'reset') {
      this.phase = 0;
      this.smoothDelta = 0;
      this.smoothSamplesRemaining = 0;
    }
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const out0 = outputs[0]?.[0];
    const out90 = outputs[1]?.[0];
    const out180 = outputs[2]?.[0];
    const out270 = outputs[3]?.[0];
    if (!out0 || !out90 || !out180 || !out270) return true;

    const clockIn = inputs[0]?.[0];
    const rateArr = parameters.rate;
    const shapeArr = parameters.shape;
    const depthArr = parameters.depth;

    const blockLen = out0.length;
    const sr = sampleRate;

    // Sample-and-hold the rate at the start of each block (decision: avoid
    // audio-rate skew between clients on the rate input). Shape stays
    // a-rate because morphing audibly improves with smooth interpolation.
    const rateHeld = rateArr.length > 1 ? (rateArr[0] ?? 0) : (rateArr[0] ?? 0);

    // If we have a shared-clock anchor and the worklet is mid-resync, the
    // smoothing target is the phase we'd compute purely from epoch + rate.
    // Pre-resync we just free-run. Compute smoothing setup once per block.
    if (this.epochMs !== null && this.smoothSamplesRemaining === 0 && this.smoothSamplesTotal > 0) {
      // Only schedule a smooth correction when the host signals via the
      // resync message; the message handler set smoothSamplesRemaining
      // back to 0 indirectly by leaving smoothDelta untouched. We
      // detect a pending resync by checking if our local phase diverges
      // from the shared-derived one beyond an epsilon.
      const sharedPhaseTarget = this.sharedDerivedPhase(rateHeld);
      const delta = wrappedPhaseDelta(this.phase, sharedPhaseTarget);
      if (Math.abs(delta) > 1e-7) {
        this.smoothDelta = delta;
        this.smoothSamplesRemaining = this.smoothSamplesTotal;
      }
    }

    for (let i = 0; i < blockLen; i++) {
      const rate = rateHeld;
      const shape = shapeArr.length > 1 ? (shapeArr[i] ?? 0) : (shapeArr[0] ?? 0);
      // depth → amplitude gain. Resting/centre value of every shape is 0,
      // so scaling the bipolar output by (depth*2) gives "still" at depth=0,
      // unity at depth=0.5, and 2× swing at depth=1. Orthogonal to shape;
      // do NOT clamp the result (out-of-range at depth=1 is intentional).
      const depthRaw = depthArr.length > 1 ? (depthArr[i] ?? 0.5) : (depthArr[0] ?? 0.5);
      const gain = Math.max(0, depthRaw) * 2;

      // External clock: rising edge resets phase to 0 (sync). Bypass
      // smoothing — a hard sync edge is intentional and clicks are a
      // documented characteristic of the sync mode.
      if (clockIn) {
        const c = clockIn[i] ?? 0;
        if (this.lastClockSample < CLOCK_THRESHOLD && c >= CLOCK_THRESHOLD) {
          this.phase = 0;
          this.smoothDelta = 0;
          this.smoothSamplesRemaining = 0;
        }
        this.lastClockSample = c;
      }

      // Advance phase by free-running rate.
      this.phase += Math.max(0, rate) / sr;

      // Apply per-sample slice of the smoothed correction, if any.
      if (this.smoothSamplesRemaining > 0) {
        const step = this.smoothDelta / this.smoothSamplesTotal;
        this.phase += step;
        this.smoothSamplesRemaining -= 1;
        if (this.smoothSamplesRemaining === 0) {
          this.smoothDelta = 0;
        }
      }

      while (this.phase >= 1) this.phase -= 1;
      while (this.phase < 0) this.phase += 1;

      // Compute the four phase-shifted outputs at this sample.
      const p0 = this.phase;
      const p90 = (this.phase + 0.25) % 1;
      const p180 = (this.phase + 0.5) % 1;
      const p270 = (this.phase + 0.75) % 1;

      out0[i] = morph(p0, shape) * gain;
      out90[i] = morph(p90, shape) * gain;
      out180[i] = morph(p180, shape) * gain;
      out270[i] = morph(p270, shape) * gain;
    }
    return true;
  }

  /** Phase that the LFO should be at *right now* if it had been free-
   *  running deterministically off the shared clock. Used as the
   *  smoothing target during resync. */
  private sharedDerivedPhase(rateHz: number): number {
    if (this.epochMs === null) return this.phase;
    // currentTime is sample-accurate; convert to shared-time ms via the
    // origin-s ↔ epoch-ms mapping the host gave us.
    // ctx.currentTime is in seconds; subtract origin and add epoch.
    // sampleRate is set in worklet scope but we don't have currentTime
    // directly — derive it from currentFrame / sampleRate.
    const t = (currentFrame / sampleRate) - this.audioOriginS;
    const sharedSec = t + this.epochMs / 1000;
    return ((sharedSec * rateHz) % 1 + 1) % 1;
  }
}

declare const currentFrame: number;

/** Morph between sine, saw, and square for the given normalized phase [0,1). */
function morph(phase: number, shape: number): number {
  const s = Math.max(0, Math.min(2, shape));
  const sine = Math.sin(TWO_PI * phase);
  const saw = phase * 2 - 1;
  const sq = phase < 0.5 ? 1 : -1;
  if (s < 1) {
    const m = s;
    return sine * (1 - m) + saw * m;
  }
  const m = s - 1;
  return saw * (1 - m) + sq * m;
}

/** Smallest signed [-0.5, +0.5) wrapped delta from `from` to `to`. */
function wrappedPhaseDelta(from: number, to: number): number {
  let d = to - from;
  while (d > 0.5) d -= 1;
  while (d < -0.5) d += 1;
  return d;
}

registerProcessor('lfo', LfoProcessor);
