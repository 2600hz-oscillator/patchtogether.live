// packages/dsp/src/lib/treeohvox-dsp.ts
//
// TREE.oh.VOX — TB-303 voice slice ported from Open303 (Robin Schmidt,
// MIT, https://github.com/RobinSchmidt/Open303). MIT → AGPL is a one-way
// compatible relicense.
//
// What's ported here (the VOICE only — sequencer / slide / waveform mixer
// are the 404 follow-up):
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
//   • polyBlepSaw          – the BlendOscillator's SAW303 lookup is a
//                             wavetable in Open303; we use a polyBLEP saw
//                             at audio rate which produces a comparable
//                             anti-aliased ramp without the wavetable
//                             complexity (the 303 character lives in the
//                             FILTER, not the oscillator — Robin S. notes
//                             this in his own write-up).
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
  // Clamp cutoff to the same floor/ceiling rosic uses (TeeBeeFilter::setCutoff
  // lines 154-160 of the header). Below 200 Hz the polynomial approximation
  // diverges; above 20 kHz it's pointless at any consumer sample rate.
  let cutoff = cutoffHz;
  if (cutoff < 200) cutoff = 200;
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
// TbVoxAmpEnv — Attack-Decay envelope. This is a simplification of
// rosic::AnalogEnvelope (which is AHDSR-with-RC). The 303 voice doesn't
// expose A/H/D/S/R individually — it has a fast fixed attack
// (de-clicker), then a long decay to silence. We model it as:
//
//   - On trigger(false): y → 0, then exponentially approach `peak` with
//     `attackCoeff`. After `attackTimeMs` the target switches to 0 and
//     the rate switches to `decayCoeff`.
//   - On trigger(true): same shape but with `peak = 1 + accentGain` (an
//     "accented" note is louder).
//
// All four constants match the rosic per-sample form:
//
//     y[n+1] = y[n] + coeff * (target[n] - y[n])
// ---------------------------------------------------------------------------
export class TbVoxAmpEnv {
  private y = 0;
  private peak = 1;
  private attackCoeff = 0;
  private decayCoeff = 0;
  private inAttack = false;
  private samplesInPhase = 0;
  private attackSamples = 0;
  private active = false;
  private sr: number;

  constructor(sr: number, attackMs = 3, decayMs = 1230) {
    this.sr = sr;
    this.setAttack(attackMs);
    this.setDecay(decayMs);
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

  /** Trigger a new note. `peakLevel` is typically 1 for normal notes and
   *  >1 for accented notes (the amp boost on accent). */
  trigger(peakLevel = 1): void {
    this.peak = peakLevel;
    this.inAttack = true;
    this.samplesInPhase = 0;
    this.active = true;
    // We do NOT reset y to 0 — Open303's noteOn(startFromCurrentLevel=true)
    // glides from the current value, which keeps overlapping retriggers
    // click-free.
  }

  /** True iff the envelope is still meaningfully above 0. */
  isActive(): boolean {
    return this.active && this.y > 1e-6;
  }

  step(): number {
    if (this.inAttack) {
      this.y += this.attackCoeff * (this.peak - this.y);
      this.samplesInPhase++;
      if (this.samplesInPhase >= this.attackSamples) this.inAttack = false;
    } else {
      this.y += this.decayCoeff * (0 - this.y);
      if (this.y < 1e-6) {
        this.y = 0;
        this.active = false;
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
}

export interface NoteTrigger {
  /** V/oct value at the moment of gate rising edge. */
  pitchCv: number;
  /** True iff `accent_in` was high at the gate rising edge. */
  accented: boolean;
}

export class TreeohvoxVoice {
  private osc: PolyBlepSaw;
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
    this.osc = new PolyBlepSaw(sr);
    this.filter = new TbVoxFilter(sr);
    this.decayEnv = new TbVoxDecayEnv(sr, initial.decayMs);
    // 3 ms attack matches Open303's normalAttack default.
    this.ampEnv = new TbVoxAmpEnv(sr, 3, 1230);
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
    // Phase reset on note-on — this IS part of the 303 character
    // (rosic_Open303.cpp:218, only resets when idle, but for the voice
    // slice every gate edge is treated as a fresh trigger).
    this.osc.resetPhase();
    this.filter.reset();
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
    // Clamp to filter's stable range (TeeBeeFilter::setCutoff bounds).
    if (instCutoff < 200) instCutoff = 200;
    else if (instCutoff > 20000) instCutoff = 20000;
    this.filter.setCutoffRes(instCutoff, this.params.resonance);

    const oscOut = -this.osc.step(this.pitchHz); // Open303 inverts: `tmp = -oscillator.getSample()`
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
  let nextIdx = 0;
  for (let i = 0; i < totalSamples; i++) {
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
