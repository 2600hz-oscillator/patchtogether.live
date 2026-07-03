// packages/dsp/src/lib/analog-delay-core.ts
//
// AnalogDelayCore — a from-scratch, OWN-CODE analog BBD/tape-style stereo
// delay engine for the COFEFVE DELAY module. Written clean-room from a fresh
// behavioral spec (see below); it is NOT a translation of any GPL delay
// source and copies no upstream algorithm structure. Every line here is
// derived from first-principles delay-line DSP (fractional ring buffer +
// modulated read pointer + damped feedback loop) — the same public-domain
// technique family the SpringReverb core in ./spring-reverb-dsp.ts is built
// from, just arranged for an echo instead of a reverb tank.
//
// ── BEHAVIORAL SPEC (the desired effect) ──────────────────────────────────
// A stereo echo that sounds like a bucket-brigade / tape delay:
//   1. TIME       — base echo length, free-running seconds OR a musical
//                   division of a beat (tempo sync).
//   2. FEEDBACK   — bipolar regeneration (−1..+1); negative inverts each
//                   repeat's polarity. Magnitude sets how many repeats ring.
//   3. WOW (LFO)  — a sine that slowly warps the read time → pitch wobble.
//   4. FLUTTER    — a slow random-walk DRIFT on the read time → the unstable
//                   "tape isn't quite in tune" wander (deterministic PRNG).
//   5. STEREO     — skews the L/R read times apart to widen the echo image.
//   6. TONE       — an in-loop multi-mode low-pass + high-pass so each repeat
//                   gets progressively darker/thinner (tape/BBD bandwidth loss).
//   7. DRIVE      — an in-loop saturator (gain/mix/post-cut, 1..16 iterations)
//                   that dirties the feedback the way an overdriven BBD does.
//   8. PAN        — STATIC rotation, PING-PONG channel-bounce, or CIRCULAR
//                   continuous rotation of the wet image.
//   9. DUCK       — sidechains the wet level down while dry signal is present
//                   (an envelope follower on the dry sum).
//  10. DRY / WET  — final output mix.
// The read pointer eases toward its target (≈ one-pole smoother) so TIME jumps
// glide (tape-like pitch slide) instead of clicking.
//
// ── SIGNAL FLOW (per sample, per channel c ∈ {L,R}) ───────────────────────
//   readDelay_c = smooth( baseDelay · (1 ± stereoOffset) · (1 + wow + flutter) )
//   tap_c       = cubicRead(buffer_c, now − readDelay_c)        // 4-pt Catmull
//   fb_c        = drive( tone( tap_c ) ) · feedback              // in-loop col.
//   write_c     = dry_c + (pingpong ? fb_(other) : fb_c)         // into buffer
//   wet_c       = pan( tap_L, tap_R )_c · duckGain               // post-loop
//   out_c       = dry_c · dryVolume + wet_c · wetVolume
//
// STABILITY: |feedback| is clamped < 1 and the in-loop low-pass removes energy
// on every pass, so the loop cannot grow unbounded; a NaN/Inf scrub on the
// write guards pathological states. The co-located test drives feedback 0.95
// for a full second and asserts a finite, bounded output.
//
// DETERMINISM: the DRIFT walk runs on a fixed-seed xorshift32 (never
// Math.random), so two renders with the same settings are bit-identical — the
// ART profile in art/scenarios/cofefve/ depends on this.
//
// `lib/` files MAY export freely (esbuild inlines them into the worklet
// bundle); the worklet ENTRY (../cofefve.ts) must NOT — see resofilter.ts.

/** Longest echo the tape buffer can hold (seconds). Covers the 2 s free-run
 *  TIME max and slow tempo-synced whole notes; effective delay is clamped into
 *  the buffer regardless. */
export const MAX_DELAY_S = 10;

/** Hard ceiling on |feedback| — keeps the echo loop stable at the knob
 *  extremes (the −1..+1 knob maps through this). */
export const FEEDBACK_MAX = 0.995;

/**
 * Tempo-sync beat multipliers, in BEATS where a quarter note = 1 beat.
 * Index 0 is unused (0 = "Off" → free-running TIME). Indices 1..19 line up
 * 1:1 with the module's sync dropdown labels (1, 1/2D, 1/2, 1/2T, 1/4D, 1/4,
 * 1/4T, 1/8D, … 1/64T): a "1" (whole note) is 4 beats, a dotted value is ×1.5,
 * a triplet value is ×2/3.
 */
export const SYNC_BEATS: readonly number[] = [
  0, // 0 = Off (sentinel)
  4, // 1     whole
  3, // 1/2D  dotted half
  2, // 1/2   half
  4 / 3, // 1/2T  half triplet
  1.5, // 1/4D  dotted quarter
  1, // 1/4   quarter  (== 1 beat)
  2 / 3, // 1/4T  quarter triplet
  0.75, // 1/8D  dotted eighth
  0.5, // 1/8   eighth
  1 / 3, // 1/8T  eighth triplet
  0.375, // 1/16D
  0.25, // 1/16
  1 / 6, // 1/16T
  0.1875, // 1/32D
  0.125, // 1/32
  1 / 12, // 1/32T
  0.09375, // 1/64D
  0.0625, // 1/64
  1 / 24, // 1/64T
];

/** Per-sample settings — one flat object the worklet mutates + hands in each
 *  sample. Ranges mirror the COFEFVE module def (the UX contract). */
export interface AnalogDelaySettings {
  /** Base delay in seconds (the TIME knob, free-running). */
  delayTime: number;
  /** 0 = Off (use delayTime); else an index into SYNC_BEATS. */
  tempoSync: number;
  /** Resolved seconds-per-beat (measured clock pulse period, else the bridged
   *  System/MIDI period). 0 = none → sync falls back to delayTime. */
  beatPeriodS: number;
  /** LFO depth on read time, 0..0.5 (fraction of the base delay). */
  lfoAmount: number;
  /** LFO rate in Hz. */
  lfoFrequency: number;
  /** Random-drift depth on read time, 0..0.05 (fraction of the base delay). */
  driftAmount: number;
  /** Drift walk rate (roughly Hz of new random targets). */
  driftSpeed: number;
  /** Bipolar feedback, −1..+1. */
  feedback: number;
  /** L/R read-time skew, −0.5..+0.5 (0 = both channels identical). */
  stereoOffset: number;
  /** Pan angle in radians. */
  pan: number;
  /** 0 = static, 1 = ping-pong, 2 = circular. */
  panMode: number;
  /** Wet ducking depth, 0..10. */
  duckAmount: number;
  /** Ducking attack in ms. */
  duckAttack: number;
  /** Ducking release in ms. */
  duckRelease: number;
  /** In-loop filter topology: 0 = 1-pole, 1 = 2-pole, 2 = 4-pole, 3 = SVF. */
  filterMode: number;
  /** In-loop low-pass cutoff, 0.01..1 normalized (1 ≈ open). */
  lowCut: number;
  /** In-loop high-pass cutoff, 0.001..0.99 normalized (0.001 ≈ off). */
  highCut: number;
  /** In-loop saturation drive, 0..10 (0 = drive bypassed). */
  driveGain: number;
  /** Saturator wet/dry blend, 0..1. */
  driveMix: number;
  /** Post-saturator low-pass cutoff, 0.01..1 normalized. */
  driveCutoff: number;
  /** Saturate→filter iteration count, 1..16. */
  driveIterations: number;
  /** Dry output level, 0..2. */
  dryVolume: number;
  /** Wet output level, 0..2. */
  wetVolume: number;
}

const TWO_PI = Math.PI * 2;

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/** Map a 0..1 normalized cutoff to a one-pole smoothing coefficient. The
 *  normalized value is treated as an exponential sweep 20 Hz → ~Nyquist so the
 *  low end of the knob is usefully dark and 1.0 is wide open. Returns the
 *  one-pole `a` in y += a·(x − y). */
function normCutoffCoeff(norm: number, sampleRate: number): number {
  const n = clamp(norm, 0.0001, 1);
  const nyq = sampleRate * 0.5;
  const hz = Math.min(nyq * 0.999, 20 * Math.pow((nyq * 0.999) / 20, n));
  const a = 1 - Math.exp((-TWO_PI * hz) / sampleRate);
  return clamp(a, 0, 1);
}

/**
 * The in-loop tone stage for ONE channel: a high-pass (thins the fed-back
 * lows) followed by a cascade of 1/2/4 one-pole low-pass sections OR a
 * 2-pole state-variable low-pass (mode 3). Own implementation — a plain
 * cascade of the y += a·(x−y) one-pole, plus a textbook Chamberlin SVF for the
 * resonant mode.
 */
class ToneFilter {
  private hpState = 0;
  private lp = [0, 0, 0, 0];
  // Chamberlin SVF state (mode 3).
  private svfLow = 0;
  private svfBand = 0;

  reset(): void {
    this.hpState = 0;
    this.lp[0] = this.lp[1] = this.lp[2] = this.lp[3] = 0;
    this.svfLow = 0;
    this.svfBand = 0;
  }

  step(x: number, s: AnalogDelaySettings, sampleRate: number): number {
    // High-pass = input − low-passed(input).
    const hpA = normCutoffCoeff(s.highCut, sampleRate);
    this.hpState += hpA * (x - this.hpState);
    let y = x - this.hpState;

    const mode = Math.round(clamp(s.filterMode, 0, 3));
    if (mode === 3) {
      // Chamberlin state-variable low-pass with mild fixed resonance.
      const hz = 20 * Math.pow((sampleRate * 0.45) / 20, clamp(s.lowCut, 0.0001, 1));
      const f = clamp(2 * Math.sin((Math.PI * hz) / sampleRate), 0, 1.4);
      const q = 0.9; // damping (higher = less resonance)
      const high = y - this.svfLow - q * this.svfBand;
      this.svfBand += f * high;
      this.svfLow += f * this.svfBand;
      y = this.svfLow;
    } else {
      const poles = mode === 0 ? 1 : mode === 1 ? 2 : 4;
      const a = normCutoffCoeff(s.lowCut, sampleRate);
      for (let i = 0; i < poles; i++) {
        this.lp[i]! += a * (y - this.lp[i]!);
        y = this.lp[i]!;
      }
    }
    return y;
  }
}

/**
 * The in-loop DRIVE for ONE channel: a stateful tanh saturator with a
 * post-saturation one-pole low-pass, optionally iterated. Own implementation:
 * tanh soft-clip (the canonical analog-ish waveshaper) driven by (1 + gain),
 * blended by MIX, then rolled off by driveCutoff; the low-pass state carries
 * across samples so the character is dynamic ("analog"), not memoryless.
 * gain ≤ 0 is an exact bypass (so DRIVE OFF leaves the loop clean).
 */
class DriveStage {
  private lpState = 0;

  reset(): void {
    this.lpState = 0;
  }

  step(x: number, s: AnalogDelaySettings, sampleRate: number): number {
    if (s.driveGain <= 0) return x;
    const drive = 1 + s.driveGain;
    const mix = clamp(s.driveMix, 0, 1);
    const a = normCutoffCoeff(s.driveCutoff, sampleRate);
    const iters = Math.max(1, Math.min(16, Math.round(s.driveIterations)));
    let y = x;
    for (let i = 0; i < iters; i++) {
      const sat = Math.tanh(y * drive);
      const mixed = y + (sat - y) * mix;
      this.lpState += a * (mixed - this.lpState);
      y = this.lpState;
    }
    return y;
  }
}

/** One channel's fractional delay line with a 4-point (Catmull-Rom) cubic read
 *  and a one-pole eased read pointer. */
class DelayChannel {
  private buf: Float32Array;
  private size: number;
  private writeIdx = 0;
  private smoothedDelay = -1; // −1 = uninitialised (seed to first target)
  readonly tone = new ToneFilter();
  readonly drive = new DriveStage();

  constructor(sizeSamples: number) {
    this.size = Math.max(8, sizeSamples);
    this.buf = new Float32Array(this.size);
  }

  reset(): void {
    this.buf.fill(0);
    this.writeIdx = 0;
    this.smoothedDelay = -1;
    this.tone.reset();
    this.drive.reset();
  }

  /** Ease the read delay toward `targetSamples` (≈ 10 ms one-pole), seeding on
   *  the first call so a fresh line reads at the target immediately (no ramp
   *  from zero). Returns the eased delay in samples. */
  private easeDelay(targetSamples: number, easeCoeff: number): number {
    if (this.smoothedDelay < 0) this.smoothedDelay = targetSamples;
    else this.smoothedDelay += easeCoeff * (targetSamples - this.smoothedDelay);
    return this.smoothedDelay;
  }

  /** Read the tap at `targetSamples` behind the write head (cubic interp). */
  readTap(targetSamples: number, easeCoeff: number): number {
    const d = clamp(this.easeDelay(targetSamples, easeCoeff), 1, this.size - 3);
    // Fractional read position behind the write head.
    let readPos = this.writeIdx - d;
    while (readPos < 0) readPos += this.size;
    const i1 = Math.floor(readPos);
    const frac = readPos - i1;
    const i1w = i1 % this.size;
    const i0 = (i1 - 1 + this.size) % this.size;
    const i2 = (i1 + 1) % this.size;
    const i3 = (i1 + 2) % this.size;
    const y0 = this.buf[i0]!;
    const y1 = this.buf[i1w]!;
    const y2 = this.buf[i2]!;
    const y3 = this.buf[i3]!;
    // Catmull-Rom cubic interpolation.
    const c0 = y1;
    const c1 = 0.5 * (y2 - y0);
    const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * frac + c2) * frac + c1) * frac + c0;
  }

  /** Write the new sample and advance the head. */
  write(x: number): void {
    let v = x;
    if (!Number.isFinite(v)) v = 0;
    this.buf[this.writeIdx] = v;
    this.writeIdx++;
    if (this.writeIdx >= this.size) this.writeIdx -= this.size;
  }
}

/**
 * Stereo analog-delay engine. Call `processSample` once per sample with the
 * live settings + the dry L/R input; read `outL`/`outR` after.
 */
export class AnalogDelayCore {
  outL = 0;
  outR = 0;

  private sampleRate: number;
  private L: DelayChannel;
  private R: DelayChannel;

  // Shared modulation (shared so stereoOffset = 0 keeps L and R identical —
  // the bus-duplicate invariant the ART profile relies on).
  private lfoPhase = 0;
  private drift = 0;
  private driftTarget = 0;
  private driftPhase = 0;
  private circPhase = 0;
  private rngState: number;

  // Ducking envelope follower (on the dry sum).
  private duckEnv = 0;

  constructor(sampleRate: number, maxDelayS = MAX_DELAY_S, driftSeed = 0x1a2b3c4d) {
    this.sampleRate = sampleRate > 0 ? sampleRate : 48000;
    // +8 samples headroom above the max delay so the cubic read never wraps
    // past the write head.
    const sizeSamples = Math.ceil(maxDelayS * this.sampleRate) + 8;
    this.L = new DelayChannel(sizeSamples);
    this.R = new DelayChannel(sizeSamples);
    this.rngState = (driftSeed >>> 0) || 1;
  }

  reset(): void {
    this.L.reset();
    this.R.reset();
    this.lfoPhase = 0;
    this.drift = 0;
    this.driftTarget = 0;
    this.driftPhase = 0;
    this.circPhase = 0;
    this.duckEnv = 0;
  }

  /** Deterministic xorshift32 in [−1, 1). */
  private rand(): number {
    let x = this.rngState;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.rngState = x;
    return x / 0x80000000 - 1;
  }

  processSample(s: AnalogDelaySettings, inL: number, inR: number): void {
    const sr = this.sampleRate;

    // ── Effective base delay (free-running TIME or a synced division) ──────
    let baseDelayS = clamp(s.delayTime, 0.0005, MAX_DELAY_S);
    const syncIdx = Math.round(clamp(s.tempoSync, 0, SYNC_BEATS.length - 1));
    if (syncIdx > 0 && s.beatPeriodS > 0) {
      baseDelayS = clamp(s.beatPeriodS * SYNC_BEATS[syncIdx]!, 0.0005, MAX_DELAY_S);
    }
    const baseSamples = baseDelayS * sr;

    // ── Shared time modulation (wow + flutter) ─────────────────────────────
    this.lfoPhase += (TWO_PI * Math.max(0, s.lfoFrequency)) / sr;
    if (this.lfoPhase >= TWO_PI) this.lfoPhase -= TWO_PI;
    const wow = clamp(s.lfoAmount, 0, 0.5) * Math.sin(this.lfoPhase);

    // Drift: pick a fresh random target at driftSpeed, ease toward it.
    this.driftPhase += Math.max(0, s.driftSpeed) / sr;
    if (this.driftPhase >= 1) {
      this.driftPhase -= 1;
      this.driftTarget = this.rand();
    }
    // ~30 ms smoothing on the walk so flutter wanders, never steps.
    this.drift += (this.driftTarget - this.drift) * (1 - Math.exp(-1 / (0.03 * sr)));
    const flutter = clamp(s.driftAmount, 0, 0.5) * this.drift;

    const modScale = 1 + wow + flutter;
    const skew = clamp(s.stereoOffset, -0.5, 0.5);
    const targetL = baseSamples * (1 - skew) * modScale;
    const targetR = baseSamples * (1 + skew) * modScale;

    // ~10 ms read-pointer easing → TIME jumps glide (tape pitch slide).
    const easeCoeff = 1 - Math.exp(-1 / (0.01 * sr));

    // ── Read the taps ──────────────────────────────────────────────────────
    const tapL = this.L.readTap(targetL, easeCoeff);
    const tapR = this.R.readTap(targetR, easeCoeff);

    // ── In-loop colouration + feedback ─────────────────────────────────────
    const fbGain = clamp(s.feedback, -1, 1) * FEEDBACK_MAX;
    let fbL = this.L.drive.step(this.L.tone.step(tapL, s, sr), s, sr) * fbGain;
    let fbR = this.R.drive.step(this.R.tone.step(tapR, s, sr), s, sr) * fbGain;

    // PING-PONG: cross the feedback so repeats bounce L↔R.
    const mode = Math.round(clamp(s.panMode, 0, 2));
    if (mode === 1) {
      const t = fbL;
      fbL = fbR;
      fbR = t;
    }

    this.L.write(inL + fbL);
    this.R.write(inR + fbR);

    // ── Ducking (envelope follower on the dry sum) ─────────────────────────
    const dryMag = Math.abs(inL) + Math.abs(inR);
    const atkMs = clamp(s.duckAttack, 0.05, 1000);
    const relMs = clamp(s.duckRelease, 0.05, 1000);
    const coeff =
      dryMag > this.duckEnv
        ? 1 - Math.exp(-1 / ((atkMs / 1000) * sr))
        : 1 - Math.exp(-1 / ((relMs / 1000) * sr));
    this.duckEnv += coeff * (dryMag - this.duckEnv);
    const duckGain = 1 / (1 + clamp(s.duckAmount, 0, 10) * this.duckEnv);

    // ── Pan the wet image ──────────────────────────────────────────────────
    let wetL = tapL;
    let wetR = tapR;
    if (mode === 0 || mode === 2) {
      let angle = s.pan;
      if (mode === 2) {
        // CIRCULAR: continuously rotate, scaled by |pan|.
        this.circPhase += (TWO_PI * 0.5 * Math.abs(s.pan)) / sr;
        if (this.circPhase >= TWO_PI) this.circPhase -= TWO_PI;
        angle = s.pan + this.circPhase;
      }
      const cs = Math.cos(angle);
      const sn = Math.sin(angle);
      wetL = tapL * cs - tapR * sn;
      wetR = tapL * sn + tapR * cs;
    }
    wetL *= duckGain;
    wetR *= duckGain;

    // ── Output mix ─────────────────────────────────────────────────────────
    const dryV = s.dryVolume;
    const wetV = s.wetVolume;
    this.outL = inL * dryV + wetL * wetV;
    this.outR = inR * dryV + wetR * wetV;
    if (!Number.isFinite(this.outL)) this.outL = 0;
    if (!Number.isFinite(this.outR)) this.outR = 0;
  }
}
