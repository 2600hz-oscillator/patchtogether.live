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
//             grows the stretch (0=harmonic, 1=bell-like). DAMPING sets Q.
//             BRIGHTNESS biases high-partial amplitudes. POSITION drives a
//             cosine-weighted pickup tap (interleaved Odd/Even sums — same
//             trick as Rings' Resonator::Process).
//
//   MODEL 1 — SYMPATHETIC_STRING: 2 parallel Karplus-Strong delay lines, each
//             with a one-pole damping filter in the loop (DAMPING) and a
//             one-pole brightness shaper on the input. STRUCTURE detunes the
//             second string (0=unison, 1=~+19 semitones). POSITION biases the
//             burst formant on the exciter.
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

class Biquad {
  x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  b0 = 0; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  reset(): void { this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
  setBandpass(freq: number, q: number, sr: number): void {
    const w0 = 2 * Math.PI * Math.min(freq, sr * 0.49) / sr;
    const cosW0 = Math.cos(w0);
    const sinW0 = Math.sin(w0);
    const alpha = sinW0 / (2 * Math.max(0.5, q));
    const a0 = 1 + alpha;
    this.b0 =  alpha / a0;
    this.b1 = 0;
    this.b2 = -alpha / a0;
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
    const q = 5 + Math.pow(1 - damping, 2) * 495;
    const bClamped = Math.max(0, Math.min(1, brightness));
    let qLoss = bClamped * (2 - bClamped) * 0.85 + 0.15;
    const qLossDampingRate = structure * (2 - structure) * 0.1;
    let stretch = 1;
    let qCurrent = q;
    let activeModes = 0;
    for (let i = 0; i < MODAL_MAX_PARTIALS; i++) {
      const partialFreq = freq * (i + 1) * stretch;
      if (partialFreq < sr * 0.49) activeModes = i + 1;
      this.filters[i]!.setBandpass(partialFreq, qCurrent * 0.05, sr);
      stretch += stiffness;
      qLoss += qLossDampingRate * (1 - qLoss);
      qCurrent *= qLoss;
    }
    this.numModes = activeModes;
  }
  process(input: number): [number, number] {
    const p = this.position * Math.PI;
    let odd = 0;
    let even = 0;
    for (let i = 0; i < this.numModes; i++) {
      const w = Math.cos(p * (i + 1));
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
  process(input: number, sr: number): number {
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
    return looped;
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
    const yA = this.strings[0]!.process(inputA, sr);
    const yB = this.strings[1]!.process(inputB, sr);
    const odd  = yA * position + yB * (1 - position);
    const even = yA * (1 - position) + yB * position;
    return [odd, even];
  }
}

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  constructor(options?: unknown);
  readonly port: MessagePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}
declare function registerProcessor(name: string, ctor: new (options?: unknown) => AudioWorkletProcessor): void;

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

  constructor(options?: unknown) { super(options); }

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
