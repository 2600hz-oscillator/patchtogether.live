// packages/dsp/src/rings.ts
//
// RINGS — modal / sympathetic-string resonator (Mutable Instruments archetype).
//
// Faithful TypeScript port (algorithm-level, not bit-exact) of Émilie Gillet's
// Rings DSP from the open-source `eurorack/rings/` repository. The source is
// MIT-licensed per individual file headers (Copyright 2015 Émilie Gillet); we
// keep attribution here and in packages/web/src/lib/audio/modules/rings.ts.
// Reference files we mapped from:
//   eurorack/rings/dsp/resonator.{h,cc}  (modal resonator: parallel bandpass
//                                         bank with stiffness-stretched
//                                         partial spacing and damping)
//   eurorack/rings/dsp/string.{h,cc}     (Karplus-Strong delay line w/ damping
//                                         filter — used by sympathetic strings)
//   eurorack/rings/dsp/plucker.h         (Noise-burst exciter for KS triggers)
//   eurorack/rings/dsp/part.{h,cc}       (Top-level voice + model dispatch)
//
// First-slice scope (this PR):
//   MODEL 0 — MODAL: bank of N parallel resonant bandpass filters (RBJ
//             biquad). Partial frequencies are stretched harmonics. STRUCTURE
//             grows the stretch (0=harmonic, 1=bell-like). DAMPING sets Q over
//             four decades, proportional to partial frequency so decay TIME is
//             uniform across the bank. BRIGHTNESS biases high-partial
//             amplitudes. POSITION drives a cosine-weighted pickup tap
//             (weight of partial n = cos(2*PI*position*n), interleaved
//             Odd/Even sums — same trick as Rings' Resonator::Process).
//
//   MODEL 1 — SYMPATHETIC_STRING: 2 parallel Karplus-Strong delay lines, each
//             with a one-pole damping filter in the loop (DAMPING) and a
//             one-pole brightness shaper on the input. STRUCTURE detunes the
//             second string (0=unison, 1=~+19 semitones). POSITION biases the
//             burst formant on the exciter AND places the second (comb) pickup
//             tap that feeds EVEN.
//
// Mandatory I/O per the brief:
//   inputs:  audio exciter in, V/OCT pitch, strum gate, CV per knob
//   outputs: Odd, Even (stereo when both patched; mono when only Odd)
//
// Deferred to follow-up PRs:
//   - STRING + REVERB model
//   - Polyphony >1
//   - Strummer onset-detector auto-strum on note change

const MODAL_MAX_PARTIALS = 24;

// DAMPING → Q for the modal bank. Q is set PROPORTIONAL to each partial's
// frequency (reference resonator.cc:80-82 `set_f_q(f, 1 + f*q)`), which makes
// the decay TIME uniform across the bank: tau = q / (pi * sr). So MODAL_Q_BASE
// / MODAL_Q_DECADES are read directly as a ring-time range —
//   DAMPING 1 → q =     500 → tau = 3.3 ms
//   DAMPING 0 → q = 500_000 → tau = 3.3 s
// The reference spans FOUR decades (`lut_4_decades` = 10^4x, q up to 5e6);
// three is where the top of our knob stops being a ring and starts being a
// drone (4 decades puts -60 dB past 200 s).
const MODAL_Q_BASE = 500;
const MODAL_Q_DECADES = 3;
// The sample rate MODAL_Q_BASE / MODAL_Q_DECADES are quoted at, and the reason
// this constant has to exist at all.
//
// ⚠ RING TIME USED TO DEPEND ON THE INTERFACE SAMPLE RATE. Q is set
// proportional to partial frequency, `Q_i = 1 + (f_i/sr)*q`, so the decay
// constant is `tau = q/(pi*sr)` — and `q` came from the DAMPING knob alone,
// with nothing to cancel the `sr`. Measured T60 on the shipping worklet for
// ONE fixed pair of knob settings (MODAL, ODD tap, strum-excited):
//
//   damping 0.5, brightness 0.5    337 ms @ 44.1k    392 ms @ 48k   163 ms @ 96k
//   damping 0.5, brightness 1.0   3889 ms @ 44.1k   7420 ms @ 48k   476 ms @ 96k
//
// A 15.6x swing decided entirely by the audio interface. A rack saved at 48 k
// was a different instrument on someone else's hardware, which is a
// correctness bug in a shipped module, not a tuning preference.
//
// Scaling `q` by `sr / MODAL_Q_REFERENCE_SR` cancels the `sr` in `tau` exactly,
// so the ring time is now whatever the knobs say and nothing else. Anchoring
// the reference at 48000 makes the fix BIT-IDENTICAL at 48 kHz — the factor is
// exactly 1 there — so every existing 48 k measurement, unit test and ART
// assertion is untouched and only the other rates move, onto the 48 k answer.
const MODAL_Q_REFERENCE_SR = 48000;
// Peak gain of each partial's band-pass, as Q**MODAL_Q_GAIN_EXP. Bounded by
// two MEASURED constraints, both at the shipped defaults over a 2 s render:
//   exp 1.0 — the reference's SVF band-pass gain (peak gain = Q). Correct for
//     the reference's chain, which has a per-model gain AND a look-ahead
//     limiter; this port has neither, and it pins our tanh: peak 0.9997-1.0000
//     for DAMPING 0..0.75, i.e. hard-limiting across most of the knob.
//   exp 0.5 — energy-preserving (captured noise power ~ g^2 * f/Q, so
//     g = sqrt(Q) makes it Q-independent). Safe, but DAMPING then changes ring
//     LENGTH with no loudness change at all: RMS 6.78e-3 .. 6.31e-3, flat
//     within 0.7 dB across the whole sweep.
//   exp 0.6 — keeps the reference's DIRECTION (damp it up, it gets quieter:
//     RMS 1.71e-2 -> 8.01e-3, -6.5 dB across the sweep), stays out of the
//     limiter (peak <= 0.386), and holds the shipped default within 1 dB of
//     the level this module shipped with (RMS 1.165e-2 vs 1.286e-2).
// It is a VOICING choice between those two measured bounds, not a transcription
// of the reference — the numbers above are what it is accountable to.
const MODAL_Q_GAIN_EXP = 0.6;

class Biquad {
  x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  b0 = 0; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  reset(): void { this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
  /** RBJ band-pass with peak gain Q**MODAL_Q_GAIN_EXP (the textbook forms are
   *  the exp-0 "constant 0 dB peak gain" and the exp-1 "constant skirt gain,
   *  peak gain = Q"; we sit between them — see MODAL_Q_GAIN_EXP). */
  setBandpass(freq: number, q: number, sr: number): void {
    const w0 = 2 * Math.PI * Math.min(freq, sr * 0.49) / sr;
    const cosW0 = Math.cos(w0);
    const sinW0 = Math.sin(w0);
    const qq = Math.max(0.5, q);
    const alpha = sinW0 / (2 * qq);
    const a0 = 1 + alpha;
    const b = alpha * Math.pow(qq, MODAL_Q_GAIN_EXP) / a0;
    this.b0 =  b;
    this.b1 = 0;
    this.b2 = -b;
    this.a1 = -2 * cosW0 / a0;
    this.a2 = (1 - alpha) / a0;
  }
  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2
              - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

export class RingsModal {
  filters: Biquad[] = [];
  position = 0.5;
  numModes = MODAL_MAX_PARTIALS;
  constructor() {
    for (let i = 0; i < MODAL_MAX_PARTIALS; i++) this.filters.push(new Biquad());
  }
  reset(): void {
    for (const f of this.filters) f.reset();
    this.position = 0.5;
  }
  configure(freq: number, structure: number, brightness: number, damping: number, sr: number): void {
    const stiffness = structure * 0.5;
    // DAMPING → Q. Reference resonator.cc:59-62 + :80-82:
    //     q = 500 * Interpolate(lut_4_decades, damping)   // lut_4_decades = 10^(4x)
    //     f_[i].set_f_q(f_norm, 1.0f + f_norm * q)        // Q ∝ PARTIAL FREQUENCY
    // Two things were missing here and both are audible:
    //   1. RANGE. The old `5 + (1-damping)^2 * 495` then scaled by 0.05 gave an
    //      EFFECTIVE Q of 0.5..25, so the WHOLE knob sweep was 12.8..46.6 ms of
    //      ring (measured, -60 dB, POSITION 0) while the docs promise "low
    //      DAMPING resonates long". It is now 23.4 ms .. seconds.
    //   2. Q PROPORTIONAL TO PARTIAL FREQUENCY. A constant Q makes the decay
    //      TIME collapse on the high partials (tau = Q/(pi*f)); Q ∝ f makes it
    //      uniform across the bank (tau = q/(pi*sr)), which is what lets a
    //      struck bar hang together instead of thinning out instantly.
    // The related defect — damping it UP got LOUDER (RMS 5.65e-3 @ DAMPING 0 vs
    // 1.65e-2 @ DAMPING 1) — is a consequence of the constant-0 dB-peak-gain
    // band-pass, not of the Q curve: a wide filter captures more of the strike.
    // It is fixed by the Q-dependent filter gain, see MODAL_Q_GAIN_EXP.
    //
    // DELIBERATE DEVIATION — knob polarity. The reference's control is
    // "more damping = LONGER decay". Ours is labelled and documented the other
    // way ("low DAMPING resonates long"), the SYMPATHETIC model already obeys
    // that polarity, and every saved rack stores a value under that meaning —
    // so we drive the SAME decade curve with (1 - damping) rather than silently
    // reversing every existing patch.
    const dClamped = Math.max(0, Math.min(1, damping));
    // The `sr / MODAL_Q_REFERENCE_SR` term is the sample-rate invariance fix —
    // see the constant. Without it `tau = q/(pi*sr)` and the ring time is a
    // property of the user's audio interface rather than of the DAMPING knob.
    const q =
      MODAL_Q_BASE *
      Math.pow(10, MODAL_Q_DECADES * (1 - dClamped)) *
      (sr / MODAL_Q_REFERENCE_SR);
    const bClamped = Math.max(0, Math.min(1, brightness));
    let qLoss = bClamped * (2 - bClamped) * 0.85 + 0.15;
    const qLossDampingRate = structure * (2 - structure) * 0.1;
    let stretch = 1;
    let qCurrent = q;
    let activeModes = 0;
    for (let i = 0; i < MODAL_MAX_PARTIALS; i++) {
      const partialFreq = freq * (i + 1) * stretch;
      if (partialFreq < sr * 0.49) activeModes = i + 1;
      const fNorm = Math.min(partialFreq, sr * 0.49) / sr;
      this.filters[i]!.setBandpass(partialFreq, 1 + fNorm * qCurrent, sr);
      stretch += stiffness;
      qLoss += qLossDampingRate * (1 - qLoss);
      qCurrent *= qLoss;
    }
    this.numModes = activeModes;
  }
  process(input: number): [number, number] {
    // POSITION → per-partial pickup weight. Reference resonator.cc:104-118 runs
    // a stmlib CosineOscillator initialised to `position` and pulls ONE value
    // per partial while the loop interleaves the odd/even accumulators, i.e.
    // the weight of partial n is cos(2*PI*position*n) (the oscillator emits
    // 0.5*cos(n*w); we drop the global 0.5 because this port carries neither
    // the reference's model_gain nor its limiter, so keeping it would be a flat
    // -6 dB on the whole model).
    //
    // This used to be cos(position*PI*(i+1)) — WRONG on both the frequency
    // (PI vs 2*PI) and the index base (i+1 vs i). At the SHIPPED DEFAULT
    // position 0.5 that evaluates to cos(PI/2 * (i+1)), which is EXACTLY ZERO
    // for every even i — and every even i is the ODD accumulator. So ODD, the
    // first-declared and docs-designated mono/primary output, was digital
    // silence at the default: measured peak 8.486e-16 at position 0.5 vs
    // 4.735e-1 at position 0.0, about -278 dB.
    const w0 = 2 * Math.PI * this.position;
    let odd = 0;
    let even = 0;
    for (let i = 0; i < this.numModes; i++) {
      const w = Math.cos(w0 * i);
      const y = this.filters[i]!.process(input * 0.125);
      if ((i & 1) === 0) odd += w * y;
      else even += w * y;
    }
    return [odd, even];
  }
  setPosition(p: number): void {
    this.position = Math.max(0, Math.min(1, p));
  }
}

const KS_MAX_DELAY = 4096;
const NUM_STRINGS = 2;

class KSString {
  buf = new Float32Array(KS_MAX_DELAY);
  writeIdx = 0;
  brightLpState = 0;
  dampLpState = 0;
  freq = 220;
  damping = 0.5;
  brightness = 0.5;
  reset(): void {
    for (let i = 0; i < KS_MAX_DELAY; i++) this.buf[i] = 0;
    this.writeIdx = 0;
    this.brightLpState = 0;
    this.dampLpState = 0;
  }
  configure(freq: number, damping: number, brightness: number): void {
    this.freq = freq;
    this.damping = damping;
    this.brightness = brightness;
  }
  /** Returns [bridge, pickup] — the two taps the reference String exposes.
   *  `bridge` is the sample written back into the loop (reference string.cc:207
   *  `out_sample_[0] = s`); `pickup` is a SECOND read further down the delay
   *  line (reference :208 `aux_sample_[0] = string_.Read(comb_delay)`, with
   *  `comb_delay = delay * (0.5 - 0.98*|position - 0.5|)`, :92 + :136). The
   *  pickup is where POSITION physically lives on a string. */
  process(input: number, sr: number, position: number): [number, number] {
    const delayLen = Math.max(2, Math.min(KS_MAX_DELAY - 1, Math.round(sr / this.freq)));
    const readIdx = (this.writeIdx - delayLen + KS_MAX_DELAY) % KS_MAX_DELAY;
    const delayed = this.buf[readIdx]!;
    const brightCutHz = 200 + this.brightness * 9800;
    const brightAlpha = 1 - Math.exp(-2 * Math.PI * brightCutHz / sr);
    this.brightLpState += brightAlpha * (input - this.brightLpState);
    const dampCutHz = 200 + (1 - this.damping) * 11800;
    const dampAlpha = 1 - Math.exp(-2 * Math.PI * dampCutHz / sr);
    const loopIn = delayed + this.brightLpState;
    this.dampLpState += dampAlpha * (loopIn - this.dampLpState);
    const loopGain = 0.998 - this.damping * 0.08;
    const looped = this.dampLpState * loopGain;
    this.buf[this.writeIdx] = looped;
    this.writeIdx = (this.writeIdx + 1) % KS_MAX_DELAY;
    const clampedPos = 0.5 - 0.98 * Math.abs(Math.max(0, Math.min(1, position)) - 0.5);
    const combDelay = Math.max(1, Math.min(KS_MAX_DELAY - 2, Math.round(delayLen * clampedPos)));
    const pickupIdx = (this.writeIdx - 1 - combDelay + KS_MAX_DELAY) % KS_MAX_DELAY;
    return [looped, this.buf[pickupIdx]!];
  }
}

class Plucker {
  remaining = 0;
  rngState = 0x12345678 | 0;
  trigger(durationSamples: number): void { this.remaining = durationSamples | 0; }
  next(): number {
    if (this.remaining <= 0) return 0;
    this.remaining--;
    this.rngState = (this.rngState * 16807) | 0;
    return ((this.rngState & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  }
}

export class RingsSympatheticStrings {
  strings: KSString[] = [];
  plucker = new Plucker();
  constructor() {
    for (let i = 0; i < NUM_STRINGS; i++) this.strings.push(new KSString());
  }
  reset(): void {
    for (const s of this.strings) s.reset();
    this.plucker.remaining = 0;
  }
  configure(freq: number, structure: number, brightness: number, damping: number, sr: number): void {
    const detuneSemi = structure * 19;
    const ratios = [1.0, Math.pow(2, detuneSemi / 12)];
    for (let i = 0; i < NUM_STRINGS; i++) {
      this.strings[i]!.configure(freq * ratios[i]!, damping, brightness);
    }
  }
  triggerStrum(sr: number): void {
    this.plucker.trigger(Math.floor(0.01 * sr));
  }
  process(externalExciter: number, position: number, sr: number): [number, number] {
    const burst = this.plucker.next();
    const burstA = burst * (1 - position * 0.4);
    const burstB = burst * (1 - (1 - position) * 0.4);
    const inputA = externalExciter + burstA;
    const inputB = externalExciter + burstB;
    const [bridgeA, pickupA] = this.strings[0]!.process(inputA, sr, position);
    const [bridgeB, pickupB] = this.strings[1]!.process(inputB, sr, position);
    // ODD / EVEN are the BRIDGE and PICKUP taps, both summed across the string
    // pair — the reference shape (part.cc:411-446: every string accumulates
    // into out_buffer_ AND aux_buffer_; string.cc:207-208 is what makes those
    // two buffers different signals).
    //
    // They used to be a POSITION crossfade of the two strings:
    //     odd  = yA*position + yB*(1-position)
    //     even = yA*(1-position) + yB*position
    // — a matrix that is RANK 1 at position 0.5, so at the shipped default both
    // outputs collapsed to the same 0.5*(yA+yB). Measured max|ODD-EVEN| over
    // 0.5 s: EXACTLY 0.000e+0 at position 0.5 (4.134e-1 at 0.25). `stereoPairs`
    // auto-wires odd/even as a stereo pair, so the default patch produced a
    // dual-mono "stereo" image. (That crossfade is a transcription of the
    // reference's STRING_AND_REVERB stereo widener at part.cc:550-551, which
    // operates on out/aux AFTER they already differ — it is a widener, never
    // the thing that separates them.)
    //
    // The 0.5 keeps ODD at exactly the level the old crossfade produced at
    // position 0.5, so the DEFAULT patch's primary output is bit-identical.
    const odd  = 0.5 * (bridgeA + bridgeB);
    const even = 0.5 * (pickupA + pickupB);
    return [odd, even];
  }
}

class RingsProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'model',      defaultValue: 0,    minValue: 0,   maxValue: 1,  automationRate: 'a-rate' as const },
      { name: 'note',       defaultValue: 0,    minValue: -60, maxValue: 60, automationRate: 'a-rate' as const },
      { name: 'structure',  defaultValue: 0.25, minValue: 0,   maxValue: 1,  automationRate: 'a-rate' as const },
      { name: 'brightness', defaultValue: 0.5,  minValue: 0,   maxValue: 1,  automationRate: 'a-rate' as const },
      { name: 'damping',    defaultValue: 0.5,  minValue: 0,   maxValue: 1,  automationRate: 'a-rate' as const },
      { name: 'position',   defaultValue: 0.5,  minValue: 0,   maxValue: 1,  automationRate: 'a-rate' as const },
      { name: 'level',      defaultValue: 0.8,  minValue: 0,   maxValue: 1,  automationRate: 'a-rate' as const },
    ];
  }

  private modal = new RingsModal();
  private symp = new RingsSympatheticStrings();
  private modalPlucker = new Plucker();
  private lastStrum = 0;
  private cfgCounter = 0;

  constructor(options?: { processorOptions?: unknown }) { super(options); }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const outOdd  = outputs[0]?.[0];
    const outEven = outputs[1]?.[0];
    if (!outOdd || !outEven) return true;

    const exciterIn = inputs[0]?.[0];
    const pitchIn   = inputs[1]?.[0];
    const strumIn   = inputs[2]?.[0];

    const modelArr      = parameters.model;
    const noteArr       = parameters.note;
    const structureArr  = parameters.structure;
    const brightnessArr = parameters.brightness;
    const dampingArr    = parameters.damping;
    const positionArr   = parameters.position;
    const levelArr      = parameters.level;

    const sr = sampleRate;

    for (let i = 0; i < outOdd.length; i++) {
      const model      = modelArr.length      > 1 ? modelArr[i]!      : modelArr[0]!;
      const note       = noteArr.length       > 1 ? noteArr[i]!       : noteArr[0]!;
      const structure  = structureArr.length  > 1 ? structureArr[i]!  : structureArr[0]!;
      const brightness = brightnessArr.length > 1 ? brightnessArr[i]! : brightnessArr[0]!;
      const damping    = dampingArr.length    > 1 ? dampingArr[i]!    : dampingArr[0]!;
      const position   = positionArr.length   > 1 ? positionArr[i]!   : positionArr[0]!;
      const level      = levelArr.length      > 1 ? levelArr[i]!      : levelArr[0]!;

      const pitchV = pitchIn ? pitchIn[i]! : 0;
      const strum  = strumIn ? strumIn[i]! : 0;
      const exc    = exciterIn ? exciterIn[i]! : 0;

      const semitones = pitchV * 12 + note;
      let freq = 261.6256 * Math.pow(2, semitones / 12);
      if (freq < 8) freq = 8;
      else if (freq > sr * 0.45) freq = sr * 0.45;

      const modelIdx = Math.max(0, Math.min(1, Math.round(model)));
      const sClamp = Math.max(0, Math.min(1, structure));
      const bClamp = Math.max(0, Math.min(1, brightness));
      const dClamp = Math.max(0, Math.min(1, damping));
      const pClamp = Math.max(0, Math.min(1, position));

      if (this.cfgCounter === 0) {
        this.modal.configure(freq, sClamp, bClamp, dClamp, sr);
        this.symp.configure(freq, sClamp, bClamp, dClamp, sr);
      }
      this.cfgCounter = (this.cfgCounter + 1) & 31;

      this.modal.setPosition(pClamp);

      const risingEdge = strum >= 0.5 && this.lastStrum < 0.5;
      if (risingEdge) {
        this.symp.triggerStrum(sr);
        // Self-excite MODAL too: a short noise burst (~10ms) so STRUM produces
        // sound regardless of whether an external exciter is patched.
        this.modalPlucker.trigger(Math.floor(0.01 * sr));
      }
      this.lastStrum = strum;

      let odd: number;
      let even: number;
      if (modelIdx === 0) {
        const burst = this.modalPlucker.next();
        [odd, even] = this.modal.process(exc + burst);
      } else {
        [odd, even] = this.symp.process(exc, pClamp, sr);
      }

      outOdd[i]  = Math.tanh(odd  * level);
      outEven[i] = Math.tanh(even * level);
    }

    return true;
  }
}

registerProcessor('rings', RingsProcessor);
