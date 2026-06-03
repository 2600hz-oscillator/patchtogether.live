// packages/dsp/src/lib/spring-reverb-dsp.ts
//
// SpringReverb — an in-house, from-scratch spring-reverb-tank model for the
// MOOG 905 SPRING REVERBERATION module. ORIGINAL CODE — no GPL / CC-BY-SA
// reverb source was copied. The *technique* (a cascade of dispersive
// all-pass sections feeding a damped, modulated feedback delay line) is the
// well-known dispersive-allpass spring approximation (Parker, Bilbao, Abel et
// al.); only the algorithm idea is borrowed — every line here is written from
// first principles.
//
// Why this topology models a spring tank:
//   • A real reverb spring is DISPERSIVE: high frequencies travel faster than
//     low ones, so an impulse smears into the characteristic upward "chirp" /
//     "boing". A first-order Schroeder all-pass has frequency-dependent group
//     delay; CASCADING many of them accumulates that group-delay curve into a
//     audible dispersion — the chirp — without changing magnitude (all-pass).
//   • The metallic, repeating "sproing" tail is a DELAY LINE with FEEDBACK —
//     the wave bouncing back and forth along the spring's length. A one-pole
//     low-pass inside the loop rolls off the highs on each pass (real springs
//     are lossy up top) for the metallic-but-dark decay.
//   • A slow LFO wobbles the delay length a hair for the shimmery, slightly
//     detuned character of a physical spring vibrating.
//
// Signal flow (per sample):
//   x ──► [allpass cascade ×N] ──► (+) ──► [delay buffer] ──► tap ──► wet
//                                   ▲                          │
//                                   └── [one-pole LP] ◄── gain ┘  (feedback)
//
// STABILITY: the feedback gain is clamped strictly below 1 (see
// FEEDBACK_MAX); combined with the in-loop low-pass the loop can never grow
// unbounded. The unit test drives decay=1 + size extremes for thousands of
// samples and asserts no NaN/Inf and a bounded magnitude.
//
// `lib/` files MAY export freely (esbuild inlines them into the worklet
// bundle); the worklet ENTRY (../moog905.ts) must NOT — see resofilter.ts.

/** Hard ceiling on the feedback gain — keeps the spring loop stable no matter
 *  how the `decay` knob is driven (decay=1 maps here, not to 1.0). */
export const FEEDBACK_MAX = 0.92;

/** Number of all-pass sections in the dispersion cascade. ~12 gives a clearly
 *  smeared (chirped) impulse response without the cascade ringing into a comb
 *  of its own. `size` scales how many are effectively engaged. */
export const ALLPASS_COUNT = 12;

/** All-pass coefficient (magnitude). Higher = more group-delay dispersion /
 *  longer chirp. Bounded < 1 for a stable, well-defined all-pass. */
const ALLPASS_G = 0.62;

/** Per-section base delay in samples at 48 kHz, scaled to the actual sample
 *  rate. Short, mutually-prime-ish lengths so the cascade disperses rather
 *  than forms a single resonant comb. `size` scales these. */
const ALLPASS_BASE_DELAYS_48K = [
  17, 23, 31, 41, 53, 67, 79, 97, 113, 131, 151, 173,
];

/** Round-trip delay-line length (seconds) at size=0 and size=1. A real 905
 *  tank's two springs sit roughly in this round-trip range. */
const DELAY_MIN_S = 0.018;
const DELAY_MAX_S = 0.055;

/** In-loop low-pass damping cutoff (Hz). The metallic high-rolloff: each pass
 *  round the spring loses the top end. */
const DAMP_CUTOFF_HZ = 3200;

/** Slow shimmer LFO. Small depth so it adds life, not vibrato. */
const LFO_RATE_HZ = 0.7;
const LFO_DEPTH_SAMPLES_48K = 2.2;

/** One first-order Schroeder all-pass section:
 *     y[n] = -g·x[n] + d[n-M] + g·y[n-M]      (transposed form)
 *  where d is the delayed feed-forward state. This is the standard
 *  Schroeder/Moorer all-pass: unity magnitude, frequency-dependent phase
 *  (hence group delay → dispersion). */
class AllpassSection {
  private buf: Float32Array;
  private idx = 0;
  private len: number;
  private g: number;

  constructor(maxLen: number, g: number) {
    // +1 guard so a read at the write index is always valid.
    this.buf = new Float32Array(Math.max(2, maxLen + 1));
    this.len = Math.max(1, maxLen);
    this.g = g;
  }

  setLength(len: number): void {
    // Clamp into the allocated buffer (never read past it).
    const max = this.buf.length - 1;
    this.len = Math.max(1, Math.min(max, len | 0));
  }

  reset(): void {
    this.buf.fill(0);
    this.idx = 0;
  }

  step(x: number): number {
    const size = this.buf.length;
    let readIdx = this.idx - this.len;
    if (readIdx < 0) readIdx += size;
    const delayed = this.buf[readIdx]!;
    // Schroeder all-pass: v is the feed-forward sum stored into the delay.
    const v = x + this.g * delayed;
    const y = -this.g * v + delayed;
    this.buf[this.idx] = v;
    this.idx++;
    if (this.idx >= size) this.idx -= size;
    return y;
  }
}

/** One-pole low-pass for the in-loop damping. y += a·(x − y). */
class OnePoleLP {
  private y = 0;
  private a: number;
  constructor(cutoffHz: number, sampleRate: number) {
    // Bilinear-ish one-pole coefficient; clamp into (0,1].
    const x = Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
    this.a = 1 - Math.max(0, Math.min(0.9999, x));
  }
  reset(): void {
    this.y = 0;
  }
  step(x: number): number {
    this.y += this.a * (x - this.y);
    return this.y;
  }
}

export interface SpringReverbParams {
  /** Tail length / feedback amount, 0..1. Maps to feedback gain (clamped
   *  < FEEDBACK_MAX). */
  decay: number;
  /** Spring length / dispersion character, 0..1. Scales the delay-line length
   *  + the all-pass cascade delays (more size = longer, lower "boing"). */
  size: number;
}

/**
 * The full 905 spring tank for ONE channel. Returns the pure WET sample from
 * `step`; the dry/wet `mix` is applied by the worklet (the web factory's
 * choice — keeps the lib output unambiguous + easy to test).
 */
export class SpringReverb {
  private sampleRate: number;
  private allpasses: AllpassSection[];

  // Feedback delay line (the spring round-trip).
  private delayBuf: Float32Array;
  private delayMax: number;
  private writeIdx = 0;
  private delaySamples: number;

  private damp: OnePoleLP;
  private feedbackGain = 0;
  private lfoPhase = 0;
  private lfoInc: number;
  private lfoDepth: number;

  private sizeNorm = 0.5;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate > 0 ? sampleRate : 48000;
    const srScale = this.sampleRate / 48000;

    // Allpass cascade. Allocate each section at its MAX (size=1) length so
    // setLength never needs to reallocate.
    this.allpasses = ALLPASS_BASE_DELAYS_48K.map((d) => {
      const maxLen = Math.max(2, Math.round(d * srScale * 2)); // ×2 = size headroom
      return new AllpassSection(maxLen, ALLPASS_G);
    });

    // Feedback delay buffer sized for the max delay + LFO depth headroom.
    this.delayMax = Math.max(
      4,
      Math.ceil(DELAY_MAX_S * this.sampleRate + LFO_DEPTH_SAMPLES_48K * srScale + 4),
    );
    this.delayBuf = new Float32Array(this.delayMax);
    this.delaySamples = this.delayMax * 0.5;

    this.damp = new OnePoleLP(DAMP_CUTOFF_HZ, this.sampleRate);

    this.lfoInc = (2 * Math.PI * LFO_RATE_HZ) / this.sampleRate;
    this.lfoDepth = LFO_DEPTH_SAMPLES_48K * srScale;

    this.setParams({ decay: 0.6, size: 0.5 });
  }

  setParams(p: SpringReverbParams): void {
    const decay = clamp01(p.decay);
    const size = clamp01(p.size);
    this.sizeNorm = size;

    // Feedback gain: decay 0..1 → 0..FEEDBACK_MAX. Strictly clamped so the
    // loop can never reach unity (stability invariant).
    this.feedbackGain = Math.min(FEEDBACK_MAX, decay * FEEDBACK_MAX);

    // Delay-line length scales with size (longer spring = lower, slower
    // "boing"). Stay within the allocated buffer minus LFO headroom.
    const targetS = DELAY_MIN_S + (DELAY_MAX_S - DELAY_MIN_S) * size;
    const targetSamples = targetS * this.sampleRate;
    this.delaySamples = Math.max(
      4,
      Math.min(this.delayMax - this.lfoDepth - 2, targetSamples),
    );

    // All-pass section lengths scale with size too — bigger spring disperses
    // over a longer span (more pronounced chirp). 0.5..1.0 of their max.
    const apScale = 0.5 + 0.5 * size;
    for (let i = 0; i < this.allpasses.length; i++) {
      const base = ALLPASS_BASE_DELAYS_48K[i]! * (this.sampleRate / 48000);
      this.allpasses[i]!.setLength(Math.round(base * apScale));
    }
  }

  reset(): void {
    for (const ap of this.allpasses) ap.reset();
    this.delayBuf.fill(0);
    this.writeIdx = 0;
    this.damp.reset();
    this.lfoPhase = 0;
  }

  /** Advance one sample. Returns the WET (reverb-only) output. */
  step(x: number): number {
    // 1) Dispersion: push the input through the all-pass cascade. This smears
    //    the transient into the spring "chirp" before it enters the tank.
    let disp = x;
    for (let i = 0; i < this.allpasses.length; i++) {
      disp = this.allpasses[i]!.step(disp);
    }

    // 2) Read the feedback delay line at a fractionally-modulated tap (LFO
    //    shimmer), linearly interpolated.
    this.lfoPhase += this.lfoInc;
    if (this.lfoPhase > 2 * Math.PI) this.lfoPhase -= 2 * Math.PI;
    const mod = this.lfoDepth * Math.sin(this.lfoPhase);
    let readPos = this.writeIdx - this.delaySamples + mod;
    // Wrap into [0, delayMax).
    while (readPos < 0) readPos += this.delayMax;
    while (readPos >= this.delayMax) readPos -= this.delayMax;
    const i0 = readPos | 0;
    const frac = readPos - i0;
    let i1 = i0 + 1;
    if (i1 >= this.delayMax) i1 -= this.delayMax;
    const tap = this.delayBuf[i0]! * (1 - frac) + this.delayBuf[i1]! * frac;

    // 3) Damp the fed-back tail (metallic high rolloff) and write the new
    //    sample = dispersed input + damped feedback.
    const damped = this.damp.step(tap);
    let write = disp + damped * this.feedbackGain;
    // Denormal / NaN scrub — defends the loop against pathological states.
    if (!Number.isFinite(write)) write = 0;
    this.delayBuf[this.writeIdx] = write;
    this.writeIdx++;
    if (this.writeIdx >= this.delayMax) this.writeIdx -= this.delayMax;

    // The wet output is the delay-line tap — the spring's reflected sound.
    return tap;
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
