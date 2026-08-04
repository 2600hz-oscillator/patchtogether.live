// packages/dsp/src/lib/treeohvox-dsp.ts
//
// TREE.oh.VOX — TB-303 voice slice ported from Open303 (Robin Schmidt,
// MIT, https://github.com/RobinSchmidt/Open303). MIT → AGPL is a one-way
// compatible relicense.
//
// What's ported here (the VOICE only — sequencer / slide are the 404
// follow-up):
//
//   • TbVoxFilter          – the TB_303 mode of rosic::TeeBeeFilter
//                             (rosic_TeeBeeFilter.{h,cpp}, the diode-
//                             feedback ladder NOT a Moog ladder; see the
//                             `TB_303` branches in calculateCoefficients
//                             Approx4() + getSample()).
//   • TbVoxDecayEnv        – the single-decay filter envelope from
//                             rosic::DecayEnvelope (y *= c per sample).
//   • TbVoxAmpEnv          – an AR envelope, simplified port of
//                             rosic::AnalogEnvelope (RC-style, just
//                             attack + decay since the 303 has no
//                             sustain user-controllable).
//   • TbVoxFeedbackHp      – the 150 Hz highpass that sits in the
//                             filter's feedback path. Open303 uses
//                             rosic::OnePoleFilter::HIGHPASS at 150 Hz.
//   • PolyBlepBlendOsc     – Open303's BlendOscillator crossfades the SAW303 +
//                             SQR303 wavetables; we reproduce the morph with a
//                             single-phase polyBLEP saw↔square blend at audio
//                             rate (the `waveform` knob: 0 = saw, 1 = square).
//                             At blend 0 it is bit-identical to the prior
//                             polyBLEP saw, so saw patches + ART baselines stay
//                             unchanged. (The 303 character lives in the FILTER,
//                             so the audio-rate blep matches the wavetable with
//                             no audible cost — Robin S.'s own write-up note.)
//   • envModScalerOffset    – the "measured mapping" math from
//                             rosic::Open303::calculateEnvModScalerAndOffset()
//                             (the empirical c0..sHiC constants).
//   • voiceStep             – per-sample render that mirrors
//                             rosic::Open303::getSample() with sequencer
//                             + oversampling + post filters STRIPPED
//                             (we don't have them in the voice slice).
//
// What's deliberately OMITTED in this slice:
//   • 4× oversampling (Open303 runs the oscillator + main filter at
//     4× SR). At 48 kHz the audible aliasing from skipping that is
//     limited — polyBLEP catches most of it. The 404 follow-up CAN add
//     it back if listening tests demand.
//   • Post-filter chain (allpass → highpass2 → notch). These shape the
//     "wide" 303 character but are subtle; voice slice is filter-+-amp
//     only.
//   • Pre-filter highpass1 — same reasoning; subtle, post-MVP.
//   • Sequencer (AcidSequencer) — voice slice is unsequenced; 404 will
//     restore.
//   • Slide (pitchSlewLimiter) — voice slice doesn't expose a slide
//     control; pitch follows the input gate edges with zero glide.
//   • Note list / polyphony — voice slice is monophonic with no
//     legato handling; the gate edge always retriggers.
//
// Equations are kept algebraically identical to upstream where present,
// so a future "compile Open303 to WASM and diff" parity test has a
// matching reference. The constants block-by-block matches the C++
// constructor defaults.

// ---------------------------------------------------------------------------
// One-pole highpass — direct port of rosic::OnePoleFilter::HIGHPASS path.
// Upstream's coefficient calc: tan-prewarped, b0 = b1 = 0.5, a1 derived from
// the half-bandwidth. For the feedback HP we only need a single fixed
// cutoff (150 Hz) so we can store a1, b0=0.5 statically; recompute only
// when sampleRate changes (constructor + setSampleRate).
// ---------------------------------------------------------------------------
export class TbVoxFeedbackHp {
  private a1 = 0;
  private b0 = 0.5;
  private x1 = 0;
  private y1 = 0;

  constructor(sr: number, cutoffHz = 150) {
    this.setCutoff(cutoffHz, sr);
  }

  setCutoff(cutoffHz: number, sr: number): void {
    // Bilinear-transformed one-pole HP — same form rosic uses.
    // tan(pi * fc / sr) is the prewarp; for a HP, b0 = (1)/(1+t), a1 = -(1-t)/(1+t).
    const t = Math.tan((Math.PI * cutoffHz) / sr);
    const a = 1 / (1 + t);
    this.b0 = a;
    this.a1 = -a * (1 - t);
  }

  reset(): void {
    this.x1 = 0;
    this.y1 = 0;
  }

  step(x: number): number {
    // y[n] = b0 * (x[n] - x[n-1]) - a1 * y[n-1]
    const y = this.b0 * (x - this.x1) - this.a1 * this.y1;
    this.x1 = x;
    this.y1 = y;
    return y;
  }
}

// ---------------------------------------------------------------------------
// TbVoxFilter — verbatim port of rosic::TeeBeeFilter in TB_303 mode.
// The maths come straight from rosic_TeeBeeFilter.{h,cpp}:
//
//   In calculateCoefficientsApprox4() (the fast-path used at run time),
//   when mode == TB_303 the coefficients are computed as:
//
//     fx = wc * ONE_OVER_SQRT2 / (2*PI)
//     b0 = (0.00045522346 + 6.1922189*fx) / (1 + 12.358354*fx + 4.4156345*fx²)
//     k  = polynomial in fx (6th-order Horner)
//     g  = k / 17
//     g  = (g - 1)*r + 1
//     g  = g * (1 + r)
//     k  = k * r
//
//   In getSample() with mode == TB_303 the diode-feedback ladder is:
//
//     y0  = in - feedbackHp(k * y4)
//     y1 += 2*b0*(y0 - y1 + y2)
//     y2 +=   b0*(y1 - 2*y2 + y3)
//     y3 +=   b0*(y2 - 2*y3 + y4)
//     y4 +=   b0*(y3 - 2*y4)
//     out = 2 * g * y4
//
// `r` (resonanceSkewed) maps from the user-facing 0..1 raw resonance via:
//     resonanceSkewed = (1 - exp(-3*resRaw)) / (1 - exp(-3))
// which is the same exponential skew rosic uses in setResonance().
// ---------------------------------------------------------------------------

const SKEW_DENOM = 1 - Math.exp(-3); // matches rosic literal

// ---------------------------------------------------------------------------
// THE CUTOFF RANGE LIVES HERE, ONCE.
//
// `treeohvoxDef.params.cutoff` (min/max) and the `cutoff` AudioParam descriptor
// in packages/dsp/src/treeohvox.ts BOTH have to agree with the value the ladder
// actually clamps to — a card/def that offers travel the DSP floors away is a
// dead control, and that is exactly the defect this pair of constants closes
// (the def offered 40 Hz; the filter clamped at 200; the bottom ~25 % of the
// knob was bit-exactly dead). `treeohvox-range-source.test.ts` asserts the def
// and the descriptor still match these — the numbers are never re-typed.
// ---------------------------------------------------------------------------
/** Lowest cutoff the TB_303 ladder will honour (Hz). Also the def's knob min. */
export const TB303_CUTOFF_FLOOR_HZ = 40;
/** Highest cutoff the def exposes (Hz). The ladder itself runs to 20 kHz; the
 *  303's dark voice deliberately tops out far below that. */
export const TB303_CUTOFF_CEILING_HZ = 6000;

export function resonanceSkew(resRaw01: number): number {
  const r = resRaw01 < 0 ? 0 : resRaw01 > 1 ? 1 : resRaw01;
  return (1 - Math.exp(-3 * r)) / SKEW_DENOM;
}

export interface Tb303Coeffs {
  b0: number;
  g: number;
  k: number;
}

/**
 * Compute the TB_303 b0/g/k coefficients for the given cutoff (Hz),
 * skewed resonance (0..1), and sample rate. Mirrors the TB_303 branch of
 * rosic::TeeBeeFilter::calculateCoefficientsApprox4().
 *
 * The 6th-order Horner polynomial for k is literally copied from
 * rosic_TeeBeeFilter.h line 260 — DO NOT round-trip these constants; even
 * a single-precision rounding would shift the resonance curve audibly.
 */
export function tb303Coeffs(cutoffHz: number, resSkewed: number, sr: number): Tb303Coeffs {
  // Clamp cutoff to the filter's supported range. Upstream rosic clamps at
  // 200 Hz (TeeBeeFilter::setCutoff) because that is the bottom of a real
  // 303's CUTOFF knob — NOT because the approximation breaks there. We expose
  // the knob from TB303_CUTOFF_FLOOR_HZ, so clamping at 200 made the bottom
  // quarter of our own knob BIT-EXACTLY dead (measured: at ENVELOPE 0 every
  // setting from 40 Hz to 139.5 Hz rendered byte-identical output). Both
  // polynomials are well-conditioned below 200 Hz — fx is simply smaller, so
  // b0 → 4.1e-3 and k → 17.13 monotonically — so the floor is the KNOB's, and
  // it lives in ONE place (see TB303_CUTOFF_FLOOR_HZ).
  let cutoff = cutoffHz;
  if (cutoff < TB303_CUTOFF_FLOOR_HZ) cutoff = TB303_CUTOFF_FLOOR_HZ;
  else if (cutoff > 20000) cutoff = 20000;

  const ONE_OVER_SQRT2 = 1 / Math.SQRT2;
  const wc = (2 * Math.PI * cutoff) / sr;
  const fx = (wc * ONE_OVER_SQRT2) / (2 * Math.PI);

  // b0 — verbatim from upstream.
  const b0 = (0.00045522346 + 6.1922189 * fx) / (1.0 + 12.358354 * fx + 4.4156345 * fx * fx);

  // k — 6th-order Horner. Upstream uses these exact literals; matching them
  // bit-for-bit is what gives us the 303 self-oscillation shape.
  let k = fx * (fx * (fx * (fx * (fx * (fx + 7198.6997) - 5837.7917) - 476.47308) + 614.95611) + 213.87126) + 16.998792;

  // g = k / 17 (upstream comments "17 reciprocal", but the constant they
  // multiply by is 1/17 to 18 decimal places — we use exact 1/17).
  let g = k / 17.0;

  const r = resSkewed < 0 ? 0 : resSkewed > 1 ? 1 : resSkewed;
  g = (g - 1.0) * r + 1.0;
  g = g * (1.0 + r);
  k = k * r;

  return { b0, g, k };
}

export class TbVoxFilter {
  private y1 = 0;
  private y2 = 0;
  private y3 = 0;
  private y4 = 0;
  // Cached coefficients — recomputed each time cutoff or resonance changes.
  // tbStep() reads these per sample so the cost is amortised against the
  // ladder math which is already 4 multiplies + 8 adds per sample.
  private b0 = 0;
  private g = 1;
  private k = 0;
  private feedbackHp: TbVoxFeedbackHp;

  constructor(private sr: number, feedbackHpCutoff = 150) {
    this.feedbackHp = new TbVoxFeedbackHp(sr, feedbackHpCutoff);
  }

  reset(): void {
    this.y1 = this.y2 = this.y3 = this.y4 = 0;
    this.feedbackHp.reset();
  }

  /** Update cutoff (Hz) + resonance (0..1 raw → skewed internally). */
  setCutoffRes(cutoffHz: number, resRaw01: number): void {
    const r = resonanceSkew(resRaw01);
    const { b0, g, k } = tb303Coeffs(cutoffHz, r, this.sr);
    this.b0 = b0;
    this.g = g;
    this.k = k;
  }

  /**
   * Per-sample step. The y1..y4 update is the TB_303 branch of
   * rosic::TeeBeeFilter::getSample() — note the asymmetric first-stage
   * scaling (`2*b0`) and the y2/y3/y4 cross-terms that produce the
   * diode-feedback character.
   */
  step(input: number): number {
    const y0 = input - this.feedbackHp.step(this.k * this.y4);
    this.y1 += 2 * this.b0 * (y0 - this.y1 + this.y2);
    this.y2 += this.b0 * (this.y1 - 2 * this.y2 + this.y3);
    this.y3 += this.b0 * (this.y2 - 2 * this.y3 + this.y4);
    this.y4 += this.b0 * (this.y3 - 2 * this.y4);
    return 2 * this.g * this.y4;
  }
}

// ---------------------------------------------------------------------------
// TbVoxDecayEnv — single-decay envelope on the filter cutoff.
// Direct port of rosic::DecayEnvelope: the entire per-sample step is
//     y *= c
// where c = exp(-1000 / (tau_ms * sr)) is the time-constant coefficient
// that decays to 1/e in tau_ms milliseconds (the standard rosic
// LeakyIntegrator convention). trigger() resets y to 1.0, so the next
// step() returns c (or 1.0 if you read state before stepping — we do
// neither, the canonical use is trigger → step → step → ...).
// ---------------------------------------------------------------------------
export class TbVoxDecayEnv {
  private y = 0;
  private c = 0;
  private sr: number;

  constructor(sr: number, decayMs = 600) {
    this.sr = sr;
    this.setDecay(decayMs);
  }

  setDecay(decayMs: number): void {
    // tau in samples. Floor at 0.1 ms to avoid NaN at zero / near-zero decay.
    const tauSamples = Math.max(0.1, decayMs) * 1e-3 * this.sr;
    this.c = Math.exp(-1 / tauSamples);
  }

  trigger(): void {
    this.y = 1.0;
  }

  /** Read the current value WITHOUT advancing — used by the voice loop
   *  when it wants to peek the envelope shape (the parity test uses this
   *  to measure shape independently of the filter). */
  peek(): number {
    return this.y;
  }

  step(): number {
    const out = this.y;
    this.y *= this.c;
    return out;
  }
}

// ---------------------------------------------------------------------------
// TbVoxAmpEnv — Attack-Decay-Release envelope. This is a simplification of
// rosic::AnalogEnvelope (which is AHDSR-with-RC). The 303 voice doesn't
// expose A/H/D/S/R individually — it has a fast fixed attack
// (de-clicker), a long decay toward silence, and a very fast RELEASE that the
// note-off (gate falling edge) switches into. We model it as:
//
//   - On trigger(false): y → 0, then exponentially approach `peak` with
//     `attackCoeff`. After `attackTimeMs` the target switches to 0 and
//     the rate switches to `decayCoeff`.
//   - On trigger(true): same shape but with `peak = 1 + accentGain` (an
//     "accented" note is louder).
//   - On noteOff(): the target stays 0 but the rate switches to
//     `releaseCoeff` — upstream's `ampEnv.setRelease(1.0)`. THIS is what makes
//     GATE LENGTH the note length, exactly like Open303::releaseNote().
//
// All the constants match the rosic per-sample form:
//
//     y[n+1] = y[n] + coeff * (target[n] - y[n])
// ---------------------------------------------------------------------------

/** Upstream's `ampEnv.setRelease(1.0)` — the 303's note-off is near-instant
 *  but still an exponential, so it de-clicks. rosic::Open303 constructor. */
export const TBVOX_AMP_RELEASE_MS = 1;
/** Upstream's `ampEnv.setDecay(1230.0)`. The VCA envelope decays even while
 *  the gate is HELD (upstream's sustain level is 0); the DECAY knob drives the
 *  FILTER envelope only, which is what a real 303's DECAY knob does. */
export const TBVOX_AMP_DECAY_MS = 1230;
/** Upstream's `normalAttack` — the VCA de-clicker. */
export const TBVOX_AMP_ATTACK_MS = 3;

export class TbVoxAmpEnv {
  private y = 0;
  private peak = 1;
  private attackCoeff = 0;
  private decayCoeff = 0;
  private releaseCoeff = 0;
  private inAttack = false;
  private inRelease = false;
  private samplesInPhase = 0;
  private attackSamples = 0;
  private active = false;
  private sr: number;

  constructor(
    sr: number,
    attackMs = TBVOX_AMP_ATTACK_MS,
    decayMs = TBVOX_AMP_DECAY_MS,
    releaseMs = TBVOX_AMP_RELEASE_MS,
  ) {
    this.sr = sr;
    this.setAttack(attackMs);
    this.setDecay(decayMs);
    this.setRelease(releaseMs);
  }

  setAttack(attackMs: number): void {
    const tau = Math.max(0.1, attackMs) * 1e-3 * this.sr;
    this.attackCoeff = 1 - Math.exp(-1 / tau);
    this.attackSamples = Math.max(1, Math.round(this.sr * Math.max(0.1, attackMs) * 1e-3));
  }

  setDecay(decayMs: number): void {
    const tau = Math.max(0.1, decayMs) * 1e-3 * this.sr;
    this.decayCoeff = 1 - Math.exp(-1 / tau);
  }

  setRelease(releaseMs: number): void {
    const tau = Math.max(0.1, releaseMs) * 1e-3 * this.sr;
    this.releaseCoeff = 1 - Math.exp(-1 / tau);
  }

  /** Trigger a new note. `peakLevel` is typically 1 for normal notes and
   *  >1 for accented notes (the amp boost on accent). */
  trigger(peakLevel = 1): void {
    this.peak = peakLevel;
    this.inAttack = true;
    this.inRelease = false;
    this.samplesInPhase = 0;
    this.active = true;
    // We do NOT reset y to 0 — Open303's noteOn(startFromCurrentLevel=true)
    // glides from the current value, which keeps overlapping retriggers
    // click-free.
  }

  /** NOTE OFF — the gate's FALLING edge. Mirrors Open303::releaseNote():
   *  the target is already 0, only the RATE changes (decay → release), so the
   *  envelope value is continuous across the switch and cannot click. An
   *  already-idle envelope is untouched, so a stray falling edge on an unpatched
   *  gate is a no-op. */
  noteOff(): void {
    if (!this.active) return;
    this.inAttack = false;
    this.inRelease = true;
  }

  /** True iff the envelope is still meaningfully above 0. */
  isActive(): boolean {
    return this.active && this.y > 1e-6;
  }

  /** Which phase the envelope is in — used by the note-off/retrigger tests so
   *  they assert the STATE MACHINE, not just a sampled level. */
  phase(): 'idle' | 'attack' | 'decay' | 'release' {
    if (!this.active) return 'idle';
    if (this.inAttack) return 'attack';
    return this.inRelease ? 'release' : 'decay';
  }

  step(): number {
    if (this.inAttack) {
      this.y += this.attackCoeff * (this.peak - this.y);
      this.samplesInPhase++;
      if (this.samplesInPhase >= this.attackSamples) this.inAttack = false;
    } else {
      // Same target (0), different rate. Release is the note-off rate.
      this.y += (this.inRelease ? this.releaseCoeff : this.decayCoeff) * (0 - this.y);
      if (this.y < 1e-6) {
        this.y = 0;
        this.active = false;
        this.inRelease = false;
      }
    }
    return this.y;
  }
}

// ---------------------------------------------------------------------------
// polyBlepSaw — per-sample anti-aliased saw oscillator. Open303 uses a
// mip-mapped wavetable (BlendOscillator + MipMappedWaveTable::SAW303), but
// for the voice slice an audio-rate polyBLEP saw produces an indistinguish-
// able-by-ear result through the 303 filter (the filter dominates the
// spectrum anyway; the osc's own harmonics above ~5 kHz get crushed). We
// reuse the same polyBLEP routine the rest of the rack (CALLSINE / WAVECEL)
// uses, kept here as a local copy so this lib has no inbound deps.
//
// State is a single phase accumulator in [0, 1). step() advances it by
// freqHz / sr and returns the corrected saw value in [-1, 1).
// ---------------------------------------------------------------------------
export class PolyBlepSaw {
  private phase = 0;
  private sr: number;

  constructor(sr: number) {
    this.sr = sr;
  }

  resetPhase(): void {
    this.phase = 0;
  }

  step(freqHz: number): number {
    const dt = freqHz / this.sr;
    const t = this.phase;
    // Naive saw: -1 → +1 over [0, 1).
    let s = 2 * t - 1;
    // polyBLEP correction near the rising discontinuity at t=0 (and its
    // periodic image at t=1).
    if (t < dt) {
      const x = t / dt;
      s -= x + x - x * x - 1;
    } else if (t > 1 - dt) {
      const x = (t - 1) / dt;
      s -= x * x + x + x + 1;
    }
    let next = t + dt;
    if (next >= 1) next -= 1;
    this.phase = next;
    return s;
  }
}

// ---------------------------------------------------------------------------
// PolyBlepBlendOsc — saw↔square morph oscillator (Open303 BlendOscillator
// archetype: BlendOscillator crossfades the SAW303 + SQR303 wavetables via a
// "waveform" control). One shared phase accumulator; `blend` morphs saw (0) →
// square (1). Both edges are polyBLEP-corrected so the morph stays anti-
// aliased at any blend. At blend == 0 the output is BIT-IDENTICAL to
// PolyBlepSaw (same naive ramp + same correction + same phase advance), so the
// existing saw-only voice behaviour — and its ART baselines — are preserved.
//
// ⚠ THE SQUARE TAP SHARES THE SAW'S POLARITY — it is sign(saw), i.e. −1 for
// the first half-cycle and +1 for the second. This is load-bearing, not a
// stylistic choice. A saw ramp `2t−1` has Fourier series −(2/π)Σ sin(2πkt)/k;
// an OPPOSITELY-signed square `t<0.5 ? +1 : −1` has +(4/π)Σ_odd sin(2πkt)/k.
// Crossfading those two gives odd-harmonic amplitude
//
//     (2/(πk)) · (3w − 1)      (k odd)
//
// which is EXACTLY ZERO at w = 1/3 for EVERY odd harmonic at once — the
// fundamental included. That was the shipped behaviour: at one third of the
// WAVE knob's travel the note lost its fundamental, jumped an octave (only
// even harmonics survive) and dropped 8.7 dB, and blend 0.5 was provably
// `0.5 × saw(φ+180°)`. Measured DFT at 100 Hz, blend 1/3: h1 = 0.00000 AND
// h3 = 0.00000. With the polarities aligned the odd amplitude is
// (2/(πk))·(1 + w), monotone over the whole travel, and nothing cancels.
// ---------------------------------------------------------------------------
export class PolyBlepBlendOsc {
  private phase = 0;
  constructor(private sr: number) {}

  resetPhase(): void {
    this.phase = 0;
  }

  step(freqHz: number, blend: number): number {
    const dt = freqHz / this.sr;
    const t = this.phase;

    // --- saw tap (identical to PolyBlepSaw) ---
    let saw = 2 * t - 1;
    if (t < dt) {
      const x = t / dt;
      saw -= x + x - x * x - 1;
    } else if (t > 1 - dt) {
      const x = (t - 1) / dt;
      saw -= x * x + x + x + 1;
    }

    const w = blend < 0 ? 0 : blend > 1 ? 1 : blend;
    let out = saw;
    if (w > 0) {
      // --- square tap = sign(saw) (50% duty): -2 falling edge at t=0 (the SAME
      //     discontinuity the saw has), +2 rising edge at t=0.5 ---
      let sq = t < 0.5 ? -1 : 1;
      // Falling edge at 0: SAME sign as the saw's drop → SUBTRACT the blep,
      // exactly as the saw tap above does.
      if (t < dt) {
        const x = t / dt;
        sq -= x + x - x * x - 1;
      } else if (t > 1 - dt) {
        const x = (t - 1) / dt;
        sq -= x * x + x + x + 1;
      }
      // Rising edge at 0.5: shift phase so the 0.5 boundary maps to 0/1, then
      // ADD (opposite sign to a downward step).
      const tt = t < 0.5 ? t + 0.5 : t - 0.5;
      if (tt < dt) {
        const x = tt / dt;
        sq += x + x - x * x - 1;
      } else if (tt > 1 - dt) {
        const x = (tt - 1) / dt;
        sq += x * x + x + x + 1;
      }
      out = (1 - w) * saw + w * sq;
    }

    let next = t + dt;
    if (next >= 1) next -= 1;
    this.phase = next;
    return out;
  }
}

// ---------------------------------------------------------------------------
// envModScalerOffset — verbatim port of Open303's
// rosic::Open303::calculateEnvModScalerAndOffset() with
// `useMeasuredMapping == true` (which is the only branch ever taken in
// upstream's hot path; the boolean is a compile-time toggle for the
// "measurement mode" the author used to derive the constants).
//
// The constants c0..sHiC are from Robin's hardware measurements; they map
// (cutoff, envMod%) → (scaler, offset) such that
//     instCutoff = cutoff * pow(2, scaler*(mainEnvOut - offset))
// gives a credible match to a hardware 303's filter sweep range.
// ---------------------------------------------------------------------------
export interface EnvModMap {
  scaler: number;
  offset: number;
}

const ENV_MOD_C0   = 3.138152786059267e+002;
const ENV_MOD_C1   = 2.394411986817546e+003;
const ENV_MOD_OF   = 0.048292930943553;
const ENV_MOD_OC   = 0.294391201442418;
const ENV_MOD_SLOF = 3.773996325111173;
const ENV_MOD_SLOC = 0.736965594166206;
const ENV_MOD_SHIF = 4.194548788411135;
const ENV_MOD_SHIC = 0.864344900642434;

/** Map cutoff (Hz) + envMod (0..100 percent — same as Open303) to the
 *  scaler/offset pair that the per-sample voice loop uses to modulate
 *  the filter cutoff with the decay envelope.
 *
 *  See rosic::Open303::calculateEnvModScalerAndOffset() in
 *  rosic_Open303.cpp lines 291-323. */
export function envModScalerOffset(cutoffHz: number, envModPercent: number): EnvModMap {
  // linToLin(envMod, 0, 100, 0, 1)
  const e = envModPercent / 100;
  // expToLin(cutoff, c0, c1, 0, 1)
  const c = Math.log(cutoffHz / ENV_MOD_C0) / Math.log(ENV_MOD_C1 / ENV_MOD_C0);
  const cClamped = c < 0 ? 0 : c > 1 ? 1 : c;
  const sLo = ENV_MOD_SLOF * e + ENV_MOD_SLOC;
  const sHi = ENV_MOD_SHIF * e + ENV_MOD_SHIC;
  return {
    scaler: (1 - cClamped) * sLo + cClamped * sHi,
    offset: ENV_MOD_OF * cClamped + ENV_MOD_OC,
  };
}

// ---------------------------------------------------------------------------
// pitchCvToFreq — convert a V/oct CV value to Hz. The rack convention is
// 0 V = C4 (261.626 Hz). The voice's TUNE knob (in semitones) is summed
// on top of the V/oct CV before the conversion. This matches how
// analog-vco.dsp and macrooscillator.ts do it.
// ---------------------------------------------------------------------------
export const C4_HZ = 261.6255653005986;

export function pitchCvToFreq(voltCv: number, tuneSemitones: number): number {
  return C4_HZ * Math.pow(2, voltCv + tuneSemitones / 12);
}

// ---------------------------------------------------------------------------
// TreeohvoxVoice — the assembled voice. Mirrors the structure of
// rosic::Open303 minus the things listed in the file-header OMITTED block.
// One-shot constructor + per-sample step(); the worklet and the
// reference renderer both consume this class so any algorithm change here
// is a single source of truth.
// ---------------------------------------------------------------------------

export interface VoiceParams {
  /** TUNE knob — semitones offset from V/oct input. */
  tuneSemitones: number;
  /** CUTOFF knob — Hz (40..6000). */
  cutoffHz: number;
  /** RESONANCE knob — 0..1 (raw, will be skewed inside the filter). */
  resonance: number;
  /** ENVELOPE knob — 0..1, mapped to envMod 0..100 percent like Open303. */
  envAmount01: number;
  /** DECAY knob — ms (200..2000). */
  decayMs: number;
  /** ACCENT knob — 0..1, scales the accent contribution to amp + filter. */
  accentAmount01: number;
  /** WAVEFORM knob — 0 = saw, 1 = square; morphs the BlendOscillator. Optional
   *  (defaults to 0 = pure saw) so existing callers + ART baselines are
   *  unaffected. */
  waveform?: number;
}

export interface NoteTrigger {
  /** V/oct value at the moment of gate rising edge. */
  pitchCv: number;
  /** True iff `accent_in` was high at the gate rising edge. */
  accented: boolean;
}

export class TreeohvoxVoice {
  private osc: PolyBlepBlendOsc;
  private filter: TbVoxFilter;
  private decayEnv: TbVoxDecayEnv;
  private ampEnv: TbVoxAmpEnv;
  private pitchHz = C4_HZ;
  private params: VoiceParams;
  // Bookkeeping for the accent-boost on the amp envelope. Mirrors
  // Open303's accentGain (the per-trigger flag that scales the third
  // amp-envelope contribution).
  private accentGain = 0;
  private hadAccentLast = false;

  constructor(private sr: number, initial: VoiceParams) {
    this.osc = new PolyBlepBlendOsc(sr);
    this.filter = new TbVoxFilter(sr);
    this.decayEnv = new TbVoxDecayEnv(sr, initial.decayMs);
    // 3 ms attack / 1230 ms decay / 1 ms release — all three are Open303's
    // ampEnv constructor values. The DECAY knob drives the FILTER envelope, as
    // it does on the hardware; the VCA envelope is fixed and the NOTE LENGTH
    // is the gate's.
    this.ampEnv = new TbVoxAmpEnv(sr, TBVOX_AMP_ATTACK_MS, TBVOX_AMP_DECAY_MS, TBVOX_AMP_RELEASE_MS);
    this.params = { ...initial };
    this.filter.setCutoffRes(initial.cutoffHz, initial.resonance);
  }

  /** Update all knob values. Called per sample from the worklet so the
   *  WtParamSmoother-smoothed values can take effect immediately; the
   *  filter coefficient recompute is the expensive part (~10 mul, 1 div)
   *  but on a single voice that's well within budget. */
  setParams(p: VoiceParams): void {
    this.params = p;
    this.filter.setCutoffRes(p.cutoffHz, p.resonance);
    this.decayEnv.setDecay(p.decayMs);
  }

  /** Trigger a note. Equivalent to Open303::triggerNote() with the
   *  sequencer + slide branches removed. */
  trigger(trig: NoteTrigger): void {
    this.pitchHz = pitchCvToFreq(trig.pitchCv, this.params.tuneSemitones);
    // Phase + filter reset on note-on — this IS part of the 303 character, but
    // ONLY WHEN THE VOICE IS IDLE (rosic_Open303.cpp:218). Resetting on every
    // gate edge forced sample 0 of every retrigger to exactly 0.0 — a hard step
    // on top of a still-ringing note (measured: 0.06633 → 0.00000, a jump 3.8×
    // the largest sample-to-sample delta anywhere else in the render). It was
    // also self-inconsistent: TbVoxAmpEnv.trigger deliberately does NOT reset
    // its own state for exactly this reason ("keeps overlapping retriggers
    // click-free"). Now the two agree — a fresh note starts from zero state, an
    // overlapping retrigger glides.
    if (!this.ampEnv.isActive()) {
      this.osc.resetPhase();
      this.filter.reset();
    }
    this.decayEnv.trigger();
    // Accent: peakLevel jumps from 1 to (1 + accent) on accented notes.
    // accentGain controls how much extra the filter envelope opens (it's
    // mixed in on top of the normal decay-env contribution).
    if (trig.accented) {
      this.ampEnv.trigger(1 + this.params.accentAmount01);
      this.accentGain = this.params.accentAmount01;
    } else {
      this.ampEnv.trigger(1);
      this.accentGain = 0;
    }
    this.hadAccentLast = trig.accented;
  }

  /** NOTE OFF — the gate's FALLING edge (Open303::releaseNote). Without this
   *  the gate's LENGTH was ignored entirely: a 10 ms gate and a 1 s gate
   *  produced byte-identical output (measured maxAbsDiff 0.0000e+0 over 3 s),
   *  and every note rang for seconds off the fixed 1230 ms VCA decay. The
   *  FILTER envelope is deliberately NOT released — on a 303 the filter sweep
   *  keeps running under the note's own tail, which is where the squelch
   *  comes from. */
  release(): void {
    this.ampEnv.noteOff();
  }

  /**
   * Per-sample voice render. Returns the audio output sample.
   *
   * Cutoff modulation formula:
   *     instCutoff = cutoff * pow(2, scaler * (env - offset) + accentBoost)
   * where (scaler, offset) come from envModScalerOffset() and accentBoost
   * is a second envelope contribution gated on accentGain (matches the
   * `tmp2 = accentGain * tmp2` line in Open303::getSample).
   */
  step(): number {
    const env = this.decayEnv.step();
    const map = envModScalerOffset(this.params.cutoffHz, this.params.envAmount01 * 100);
    // Normal env contribution + accent contribution. The accent term is
    // weighted at ~4× the normal contribution like Open303's `4.0` constant
    // on the amp-env path (we use 1× on the cutoff path to keep the
    // brightness boost tasteful; users can dial harder via the ACCENT
    // knob).
    const cutoffMod = map.scaler * (env - map.offset) + this.accentGain * env;
    let instCutoff = this.params.cutoffHz * Math.pow(2, cutoffMod);
    // Clamp to the filter's supported range — the SAME floor the coefficient
    // helper uses (one constant, see TB303_CUTOFF_FLOOR_HZ).
    if (instCutoff < TB303_CUTOFF_FLOOR_HZ) instCutoff = TB303_CUTOFF_FLOOR_HZ;
    else if (instCutoff > 20000) instCutoff = 20000;
    this.filter.setCutoffRes(instCutoff, this.params.resonance);

    const oscOut = -this.osc.step(this.pitchHz, this.params.waveform ?? 0); // Open303 inverts: `tmp = -oscillator.getSample()`
    const filtered = this.filter.step(oscOut);
    const amp = this.ampEnv.step();
    return filtered * amp;
  }

  /** Returns true while either the amp env is still audible. The worklet
   *  uses this to decide whether to keep emitting silence frames once
   *  the gate falls — saves CPU on big patches with many idle voices. */
  isActive(): boolean {
    return this.ampEnv.isActive();
  }

  /** Get the last accent-flag, for debugging / parity tests. */
  getDebugAccented(): boolean {
    return this.hadAccentLast;
  }
}

// ---------------------------------------------------------------------------
// renderVoiceSequence — offline render helper. Used by ART scenarios and
// by the parity test. Given a sequence of notes (each { atSample,
// pitchCv, accented, gateDurationSamples }), render `totalSamples` of
// audio with the given params held constant. NOT used at runtime — the
// worklet has its own loop with per-sample param smoothing.
// ---------------------------------------------------------------------------

export interface ScheduledNote {
  atSample: number;
  pitchCv: number;
  accented: boolean;
  /** GATE LENGTH in samples. The note ends here — `renderVoiceSequence` calls
   *  `voice.release()` at `atSample + gateDurationSamples`, exactly as the
   *  worklet does on the gate's falling edge. (It used to be DECLARED AND
   *  UNREAD: every scenario passed a length and every note rang on regardless,
   *  which is why nothing in ART could see the missing note-off.) */
  gateDurationSamples: number;
}

export function renderVoiceSequence(
  params: VoiceParams,
  sr: number,
  totalSamples: number,
  notes: ScheduledNote[],
): Float32Array {
  const out = new Float32Array(totalSamples);
  const voice = new TreeohvoxVoice(sr, params);
  // Sort defensively — the ART scenarios construct notes in order, but
  // it's cheap insurance.
  const sorted = [...notes].sort((a, b) => a.atSample - b.atSample);
  // Gate-OFF schedule, in ascending sample order. A note whose gate length is
  // <= 0 (or non-finite) is treated as "no note-off" — a held gate.
  const offs = sorted
    .filter((n) => Number.isFinite(n.gateDurationSamples) && n.gateDurationSamples > 0)
    .map((n) => n.atSample + n.gateDurationSamples)
    .sort((a, b) => a - b);
  let nextIdx = 0;
  let nextOff = 0;
  for (let i = 0; i < totalSamples; i++) {
    // Note-OFF first, so a gate that ends on the same sample the next note
    // starts does not release the note that just began (back-to-back steps).
    while (nextOff < offs.length && offs[nextOff]! === i) {
      voice.release();
      nextOff++;
    }
    while (nextIdx < sorted.length && sorted[nextIdx]!.atSample === i) {
      voice.trigger(sorted[nextIdx]!);
      nextIdx++;
    }
    out[i] = voice.step();
  }
  return out;
}

// ---------------------------------------------------------------------------
// crossCorrelation — Pearson correlation between two equal-length signals.
// Used by the parity test to compare TREE.oh.VOX output against a
// reference. Returns a value in [-1, 1] (1 = identical shape).
// ---------------------------------------------------------------------------
export function crossCorrelation(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`crossCorrelation: length mismatch ${a.length} vs ${b.length}`);
  }
  const n = a.length;
  if (n === 0) return 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i] ?? 0;
    sb += b[i] ?? 0;
  }
  const ma = sa / n;
  const mb = sb / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = (a[i] ?? 0) - ma;
    const y = (b[i] ?? 0) - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const denom = Math.sqrt(da * db);
  if (denom < 1e-20) return 0;
  return num / denom;
}

// ---------------------------------------------------------------------------
// rmsWindow — windowed RMS for envelope-shape comparison. Used by the
// parity test to compare amplitude trajectories independently of phase.
// ---------------------------------------------------------------------------
export function rmsWindow(buf: Float32Array, windowSamples: number): Float32Array {
  const n = buf.length;
  const w = Math.max(1, windowSamples);
  const out = new Float32Array(n);
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const v = buf[i] ?? 0;
    sumSq += v * v;
    if (i >= w) {
      const old = buf[i - w] ?? 0;
      sumSq -= old * old;
    }
    const denom = Math.min(i + 1, w);
    out[i] = Math.sqrt(sumSq / denom);
  }
  return out;
}
