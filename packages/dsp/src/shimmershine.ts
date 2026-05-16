// packages/dsp/src/shimmershine.ts
//
// SHIMMERSHINE — pure-TS stereo shimmer reverb.
//
// Architecture (single worklet, no Faust):
//   stereo in → Schroeder tank (4 parallel comb filters → 2 series allpasses)
//             → tank out (wet)
//                  ↓
//                  → +12 semitone pitch shifter (granular-fade dual-head)
//                  → feedback gain → summed back at tank input
//   dry+wet mix at output
//
// Why pure TS:
//   The pitch-shifted feedback loop needs sample-accurate state shared with
//   the tank's write index. Splitting tank ↔ pitch-shifter across Faust + a
//   second worklet would require either inter-worklet messaging (latency)
//   or an audio-rate ScriptProcessor bridge (deprecated). A single
//   AudioWorkletProcessor keeps the entire signal path on one tick of
//   process().
//
// Pitch shifter (granular fade):
//   Two read heads chase the write head, each reading at 2x output sample
//   rate for +12 semitones up. When a head approaches the write index it
//   wraps backward by HALF the window length; a cosine-window crossfade
//   between the two heads masks the discontinuity. Window length is chosen
//   so the crossfade period (~25 ms) is short enough to hide the wrap but
//   long enough that the discontinuity itself isn't audible as a click.
//
// Feedback runaway prevention:
//   Tank decay × shimmer × pitch-shifter can pile up. We:
//     - clamp shimmer effective amount at 0.55 in the feedback path
//     - hard-tanh saturate at the feedback summer
//   Internal tank comb feedback also self-caps at 0.92.

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

// ---------- Schroeder reverb tank ----------
// Four parallel comb filters with hand-picked prime-ish lengths (Freeverb's
// canonical numbers, normalized to 44.1 kHz then scaled to live sampleRate).
const COMB_LENGTHS_44 = [1116, 1188, 1277, 1356];
// Two series allpasses for diffusion.
const ALLPASS_LENGTHS_44 = [556, 441];

/** One comb filter with low-pass damping in its feedback loop. */
class CombLP {
  buf: Float32Array;
  idx = 0;
  fbStore = 0;
  constructor(len: number) {
    this.buf = new Float32Array(len);
  }
  /** input → output, with feedback gain fb (0..<1) and damp (0..1). */
  tick(x: number, fb: number, damp: number): number {
    const y = this.buf[this.idx]!;
    // Simple 1-pole LP in feedback: state = state * damp + y * (1 - damp).
    this.fbStore = this.fbStore * damp + y * (1 - damp);
    this.buf[this.idx] = x + this.fbStore * fb;
    this.idx = (this.idx + 1) % this.buf.length;
    return y;
  }
}

/** Schroeder allpass — diffuses without coloring. */
class Allpass {
  buf: Float32Array;
  idx = 0;
  constructor(len: number) {
    this.buf = new Float32Array(len);
  }
  tick(x: number): number {
    const stored = this.buf[this.idx]!;
    // Feedback gain 0.5 is the classic Schroeder allpass coefficient.
    const out = -x + stored;
    this.buf[this.idx] = x + stored * 0.5;
    this.idx = (this.idx + 1) % this.buf.length;
    return out;
  }
}

class SchroederTank {
  combs: CombLP[];
  allpasses: Allpass[];
  constructor(sr: number) {
    const scale = sr / 44100;
    this.combs = COMB_LENGTHS_44.map((n) => new CombLP(Math.max(8, Math.round(n * scale))));
    this.allpasses = ALLPASS_LENGTHS_44.map(
      (n) => new Allpass(Math.max(8, Math.round(n * scale))),
    );
  }
  /** size ∈ [0..1] → comb feedback in [0.70..0.88]. damp ∈ [0..1] direct.
   *  fb capped at 0.88 (not 0.92) so the worst-case combination
   *  (size=1, damp=0, decay=1) is still stable when summed across 4
   *  parallel combs + a shimmer feedback loop. */
  tick(x: number, size: number, damp: number): number {
    const fb = 0.70 + 0.18 * size;
    let y = 0;
    for (const c of this.combs) y += c.tick(x, fb, damp);
    y *= 0.25; // sum of 4 combs → average
    for (const a of this.allpasses) y = a.tick(y);
    return y;
  }
}

// ---------- Granular-fade pitch shifter ----------
// Two read heads chase the write head at `rate` (2.0 for +12 semis). When a
// head is within `windowSamples / 2` of the write head, it wraps back by
// `windowSamples`. The two heads are offset by half a window so one wraps
// while the other is mid-window — a cosine crossfade between them masks each
// wrap's discontinuity.
class GranularPitchShifter {
  buf: Float32Array;
  writeIdx = 0;
  // Read positions are fractional samples behind writeIdx.
  // headOffsetA starts at windowSamples; headOffsetB at windowSamples*1.5.
  headOffsetA: number;
  headOffsetB: number;
  windowSamples: number;
  rate: number;
  constructor(sr: number, rate: number, windowMs: number) {
    // Buffer length: 4x window so the pitch shifter can read up to one
    // window behind even at extreme rates without aliasing read-vs-write.
    this.windowSamples = Math.max(64, Math.round((windowMs / 1000) * sr));
    this.rate = rate;
    this.buf = new Float32Array(this.windowSamples * 4);
    // headOffsetA starts at W (full window behind write — phase 0 in the
    // window, zero crossfade gain at startup so silence comes out cleanly).
    // headOffsetB starts at W/2 (mid-window, peak gain) so it carries the
    // signal while A is at the window edge.
    this.headOffsetA = this.windowSamples;
    this.headOffsetB = this.windowSamples * 0.5;
  }
  /** Cosine window — equal-power crossfade between the two heads.
   *  phase ∈ [0..1]; returns the gain envelope for head A. Head B uses
   *  cosWindow(1 - phase). 0.5 * (1 - cos(2πphase)) is the Hann window:
   *  A + B amplitudes sum to a flat unity envelope when paired with the
   *  half-window-offset partner head. */
  private cosWindow(phase: number): number {
    return 0.5 * (1 - Math.cos(2 * Math.PI * phase));
  }
  /** Linear-interp read from the ring buffer at a position. */
  private readAt(pos: number): number {
    const len = this.buf.length;
    let p = pos % len;
    if (p < 0) p += len;
    const i0 = Math.floor(p);
    const i1 = (i0 + 1) % len;
    const frac = p - i0;
    return this.buf[i0]! * (1 - frac) + this.buf[i1]! * frac;
  }
  tick(x: number): number {
    // Write current sample.
    this.buf[this.writeIdx] = x;

    const W = this.windowSamples;
    // For pitch UP (rate > 1) the read heads must walk forward faster than
    // the write head — they approach the write head over time, so the
    // headOffset (distance behind write) SHRINKS by (rate - 1) per tick.
    // When the read head catches up (headOffset crosses 0) we wrap it back
    // by W samples; the partner head, offset by W/2, covers the wrap with
    // its mid-window crossfade gain.
    const a = this.readAt(this.writeIdx - this.headOffsetA);
    const b = this.readAt(this.writeIdx - this.headOffsetB);
    // Phase = (W - headOffset) / W within the [0..W] envelope window.
    const phaseA = 1 - this.headOffsetA / W;
    const phaseB = 1 - this.headOffsetB / W;
    const gA = this.cosWindow(phaseA);
    const gB = this.cosWindow(phaseB);
    const out = a * gA + b * gB;

    const delta = this.rate - 1;
    this.headOffsetA -= delta;
    this.headOffsetB -= delta;
    // Wrap: when offset drops below 0 (caught up to write), jump back W.
    if (this.headOffsetA <= 0) this.headOffsetA += W;
    if (this.headOffsetB <= 0) this.headOffsetB += W;

    this.writeIdx = (this.writeIdx + 1) % this.buf.length;
    return out;
  }
}

class ShimmershineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'decay',   defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'shimmer', defaultValue: 0.4, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'size',    defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'damp',    defaultValue: 0.4, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'mix',     defaultValue: 0.4, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
    ];
  }

  // Two tanks for stereo width. Decorrelation comes from the two pitch
  // shifters running on different sample streams.
  private tankL: SchroederTank;
  private tankR: SchroederTank;
  private shifterL: GranularPitchShifter;
  private shifterR: GranularPitchShifter;
  // Last wet samples — feed back into the input of the next tick after
  // pitch-shift + gain scaling.
  private fbL = 0;
  private fbR = 0;

  // Cap on the effective feedback-loop gain so decay × shimmer can never
  // drive the tank into self-oscillation. 0.55 leaves audible shimmer at
  // shimmer=1 while preventing runaway with decay=1, damp=0.
  private readonly FB_CAP = 0.55;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.tankL = new SchroederTank(sampleRate);
    this.tankR = new SchroederTank(sampleRate);
    // 25 ms window — short enough that octave-shifted transients land
    // intact, long enough that the wrap discontinuity sits below audibility.
    this.shifterL = new GranularPitchShifter(sampleRate, 2.0, 25);
    this.shifterR = new GranularPitchShifter(sampleRate, 2.0, 25);
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const inL = inputs[0]?.[0] ?? null;
    const inR = inputs[1]?.[0] ?? inputs[0]?.[0] ?? null;
    const outL = outputs[0]?.[0];
    const outR = outputs[1]?.[0];
    if (!outL || !outR) return true;

    const decay = Math.max(0, Math.min(1, parameters.decay[0] ?? 0.6));
    const shimmer = Math.max(0, Math.min(1, parameters.shimmer[0] ?? 0.4));
    const size = Math.max(0, Math.min(1, parameters.size[0] ?? 0.6));
    const damp = Math.max(0, Math.min(1, parameters.damp[0] ?? 0.4));
    const mix = Math.max(0, Math.min(1, parameters.mix[0] ?? 0.4));

    // Decay shapes the tank comb feedback further (multiplies size).
    // size=1, decay=1 → comb fb ≈ 0.92 (the hard cap inside SchroederTank).
    const effSize = size * (0.5 + 0.5 * decay);
    // Feedback gain into the pitch shifter, hard-capped.
    const fbGain = shimmer * this.FB_CAP;

    for (let i = 0; i < outL.length; i++) {
      const dryL = inL?.[i] ?? 0;
      const dryR = inR?.[i] ?? 0;

      // Sum dry input with last cycle's pitch-shifted feedback.
      const tankInL = dryL + this.fbL;
      const tankInR = dryR + this.fbR;

      // Through the tank, then tanh-limit so even with damp=0 + size=1 +
      // ongoing input the recirculating energy can't blow past ±1.
      const wetL = Math.tanh(this.tankL.tick(tankInL, effSize, damp));
      const wetR = Math.tanh(this.tankR.tick(tankInR, effSize, damp));

      // Pitch shift the wet output for next-cycle feedback.
      const shiftedL = this.shifterL.tick(wetL);
      const shiftedR = this.shifterR.tick(wetR);
      // tanh soft-limit again on the feedback — guarantees |fb| < 1 even
      // at decay=shimmer=1.
      this.fbL = Math.tanh(shiftedL * fbGain);
      this.fbR = Math.tanh(shiftedR * fbGain);

      outL[i] = dryL * (1 - mix) + wetL * mix;
      outR[i] = dryR * (1 - mix) + wetR * mix;
    }

    return true;
  }
}

registerProcessor('shimmershine', ShimmershineProcessor);

// Pure-math copies of the tank + pitch-shifter used by unit tests + ART
// scenarios live in packages/web/src/lib/audio/modules/shimmershine.ts. Any
// algorithmic change here MUST be mirrored there.
