// packages/web/src/lib/audio/modules/rings.ts
//
// RINGS — modal / sympathetic-string resonator (audio domain).
//
// Faithful TypeScript port of Émilie Gillet's Rings (Mutable Instruments).
// Source: eurorack/rings/ — Copyright 2015 Émilie Gillet, MIT-licensed per
// individual file headers. The eurorack repo's overall README states
// "Code (STM32F projects): MIT license" so we're compatible with patch-
// together.live's MIT license. See packages/dsp/src/rings.ts for the
// worklet DSP; the pure-math mirror in this file is what unit tests and
// the ART scenario exercise.
//
// Inputs:
//   in (audio): external excitation input (replaces internal exciter when patched).
//   pitch (pitch): V/oct (1 unit = 1 octave). Sums with note.
//   strum (gate): rising edge re-strums the resonator chord.
//   model_cv (cv, discrete, paramTarget=model): displaces the resonator-model selector.
//   note_cv (cv, linear, paramTarget=note): displaces the note offset (±60 st).
//   str_cv (cv, linear, paramTarget=structure): displaces STRUCTURE.
//   bright_cv (cv, linear, paramTarget=brightness): displaces BRIGHTNESS.
//   damp_cv (cv, linear, paramTarget=damping): displaces DAMPING.
//   pos_cv (cv, linear, paramTarget=position): displaces POSITION.
//   level_cv (cv, linear, paramTarget=level): displaces LEVEL.
//
// Outputs:
//   odd (audio): odd-mode resonator output.
//   even (audio): even-mode resonator output (parallel companion to ODD).
//
// Params:
//   model (discrete 0..RINGS_MAX_MODEL, default 0): resonator-model selector.
//   note (linear -60..60 st, default 0): semitone offset from pitch CV.
//   structure (linear 0..1, default 0.25): inharmonicity / structure macro.
//   brightness (linear 0..1, default 0.5): high-end character.
//   damping (linear 0..1, default 0.5): partial decay / damping.
//   position (linear 0..1, default 0.5): pickup position along the resonator.
//   level (linear 0..1, default 0.8): output level.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/rings.js?url';

const loadedContexts = new WeakSet<BaseAudioContext>();

const _MODAL_MAX_PARTIALS = 24;

// DAMPING → Q for the modal bank. Q is set PROPORTIONAL to each partial's
// frequency (reference resonator.cc:80-82 `set_f_q(f, 1 + f*q)`), which makes
// the decay TIME uniform across the bank: tau = q / (pi * sr). So MODAL_Q_BASE
// / MODAL_Q_DECADES are read directly as a ring-time range —
//   DAMPING 1 → q =     500 → tau = 3.3 ms
//   DAMPING 0 → q = 500_000 → tau = 3.3 s
// The reference spans FOUR decades (`lut_4_decades` = 10^4x, q up to 5e6);
// three is where the top of our knob stops being a ring and starts being a
// drone (4 decades puts -60 dB past 200 s).
const _MODAL_Q_BASE = 500;
const _MODAL_Q_DECADES = 3;
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
const _MODAL_Q_GAIN_EXP = 0.6;

class _Biquad {
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
    const b = alpha * Math.pow(qq, _MODAL_Q_GAIN_EXP) / a0;
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

class _RingsModal {
  filters: _Biquad[] = [];
  position = 0.5;
  numModes = _MODAL_MAX_PARTIALS;
  constructor() {
    for (let i = 0; i < _MODAL_MAX_PARTIALS; i++) this.filters.push(new _Biquad());
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
    const q = _MODAL_Q_BASE * Math.pow(10, _MODAL_Q_DECADES * (1 - dClamped));
    const bClamped = Math.max(0, Math.min(1, brightness));
    let qLoss = bClamped * (2 - bClamped) * 0.85 + 0.15;
    const qLossDampingRate = structure * (2 - structure) * 0.1;
    let stretch = 1;
    let qCurrent = q;
    let activeModes = 0;
    for (let i = 0; i < _MODAL_MAX_PARTIALS; i++) {
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
  setPosition(p: number): void { this.position = Math.max(0, Math.min(1, p)); }
}

const _KS_MAX_DELAY = 4096;
const _NUM_STRINGS = 2;

class _KSString {
  buf = new Float32Array(_KS_MAX_DELAY);
  writeIdx = 0;
  brightLpState = 0;
  dampLpState = 0;
  freq = 220;
  damping = 0.5;
  brightness = 0.5;
  reset(): void {
    for (let i = 0; i < _KS_MAX_DELAY; i++) this.buf[i] = 0;
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
    const delayLen = Math.max(2, Math.min(_KS_MAX_DELAY - 1, Math.round(sr / this.freq)));
    const readIdx = (this.writeIdx - delayLen + _KS_MAX_DELAY) % _KS_MAX_DELAY;
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
    this.writeIdx = (this.writeIdx + 1) % _KS_MAX_DELAY;
    const clampedPos = 0.5 - 0.98 * Math.abs(Math.max(0, Math.min(1, position)) - 0.5);
    const combDelay = Math.max(1, Math.min(_KS_MAX_DELAY - 2, Math.round(delayLen * clampedPos)));
    const pickupIdx = (this.writeIdx - 1 - combDelay + _KS_MAX_DELAY) % _KS_MAX_DELAY;
    return [looped, this.buf[pickupIdx]!];
  }
}

class _Plucker {
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

class _RingsSympatheticStrings {
  strings: _KSString[] = [];
  plucker = new _Plucker();
  constructor() {
    for (let i = 0; i < _NUM_STRINGS; i++) this.strings.push(new _KSString());
  }
  reset(): void {
    for (const s of this.strings) s.reset();
    this.plucker.remaining = 0;
  }
  configure(freq: number, structure: number, brightness: number, damping: number, sr: number): void {
    const detuneSemi = structure * 19;
    const ratios = [1.0, Math.pow(2, detuneSemi / 12)];
    for (let i = 0; i < _NUM_STRINGS; i++) {
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

export interface RingsParams {
  /** 0 = MODAL, 1 = SYMPATHETIC_STRING. Rounded in render. */
  model: number;
  note: number;
  structure: number;
  brightness: number;
  damping: number;
  position: number;
  level: number;
}

export const RINGS_MODEL_NAMES = ['MODAL', 'SYMPATHETIC'] as const;
export type RingsModelName = (typeof RINGS_MODEL_NAMES)[number];
export const RINGS_MAX_MODEL = RINGS_MODEL_NAMES.length - 1;

export const ringsMath = {
  render(
    n: number,
    sr: number,
    pitchV: number,
    params: RingsParams,
    exciter?: Float32Array | null,
    strumAt = -1,
  ): { odd: Float32Array; even: Float32Array } {
    const modal = new _RingsModal();
    const symp = new _RingsSympatheticStrings();
    const modalPlucker = new _Plucker();
    modal.reset();
    symp.reset();
    const odd = new Float32Array(n);
    const even = new Float32Array(n);

    const semitones = pitchV * 12 + params.note;
    let freq = 261.6256 * Math.pow(2, semitones / 12);
    if (freq < 8) freq = 8;
    else if (freq > sr * 0.45) freq = sr * 0.45;

    const modelIdx = Math.max(0, Math.min(RINGS_MAX_MODEL, Math.round(params.model)));
    const s = Math.max(0, Math.min(1, params.structure));
    const b = Math.max(0, Math.min(1, params.brightness));
    const d = Math.max(0, Math.min(1, params.damping));
    const p = Math.max(0, Math.min(1, params.position));
    const lvl = Math.max(0, Math.min(1, params.level));

    modal.configure(freq, s, b, d, sr);
    symp.configure(freq, s, b, d, sr);
    modal.setPosition(p);

    for (let i = 0; i < n; i++) {
      if (i === strumAt) {
        symp.triggerStrum(sr);
        // Self-excite MODAL too so STRUM produces sound without an external exciter.
        modalPlucker.trigger(Math.floor(0.01 * sr));
      }
      const exc = exciter ? (exciter[i] ?? 0) : 0;
      let o: number;
      let e: number;
      if (modelIdx === 0) {
        const burst = modalPlucker.next();
        [o, e] = modal.process(exc + burst);
      } else {
        [o, e] = symp.process(exc, p, sr);
      }
      odd[i]  = Math.tanh(o * lvl);
      even[i] = Math.tanh(e * lvl);
    }
    return { odd, even };
  },
};

export const ringsDef: AudioModuleDef = {
  type: 'rings',
  palette: { top: 'Audio modules', sub: 'Effects' },
  domain: 'audio',
  label: 'rings',
  category: 'sources',
  stereoPairs: [
    ['odd', 'even'],
  ],
  ossAttribution: { author: 'Émilie Gillet' },

  // Chain-role (Design-D): RINGS is genuinely a 'both' module — a self-
  // oscillating resonator VOICE (source, driven by clips via its pitch + strum)
  // OR a resonator that processes external audio through its `in` input (insert).
  // This pass DEFAULTS it to 'source' so it is head-eligible AND receives clip
  // note control (pitch/gate) — the primary "playable voice" use. As a declared
  // source its audio `in` is treated as modulation (excitation), so it is NOT
  // wired as a fed insert.
  // TODO(both): the "resonate external audio as an insert" mode needs the
  //   context-dependent 'both' switching described on isChainSource
  //   (patch-convenience.ts) — deferred to keep this pass correct, not half-
  //   working. Owner may flip this to role:'both' + inPorts:['in'] once that
  //   context threading lands.
  chainWiring: { role: 'source' },

  inputs: [
    { id: 'in',        type: 'audio' },
    { id: 'pitch',     type: 'pitch' },
    { id: 'strum',     type: 'gate' },
    { id: 'model_cv',  type: 'cv', paramTarget: 'model',      cvScale: { mode: 'discrete' } },
    { id: 'note_cv',   type: 'cv', paramTarget: 'note',       cvScale: { mode: 'linear' } },
    { id: 'str_cv',    type: 'cv', paramTarget: 'structure',  cvScale: { mode: 'linear' } },
    { id: 'bright_cv', type: 'cv', paramTarget: 'brightness', cvScale: { mode: 'linear' } },
    { id: 'damp_cv',   type: 'cv', paramTarget: 'damping',    cvScale: { mode: 'linear' } },
    { id: 'pos_cv',    type: 'cv', paramTarget: 'position',   cvScale: { mode: 'linear' } },
    { id: 'level_cv',  type: 'cv', paramTarget: 'level',      cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'odd',  type: 'audio' },
    { id: 'even', type: 'audio' },
  ],
  params: [
    { id: 'model',      label: 'Model',      defaultValue: 0,    min: 0,   max: RINGS_MAX_MODEL, curve: 'discrete' },
    { id: 'note',       label: 'Note',       defaultValue: 0,    min: -60, max: 60, curve: 'linear', units: 'st' },
    { id: 'structure',  label: 'Structure',  defaultValue: 0.25, min: 0,   max: 1,  curve: 'linear' },
    { id: 'brightness', label: 'Brightness', defaultValue: 0.5,  min: 0,   max: 1,  curve: 'linear' },
    { id: 'damping',    label: 'Damping',    defaultValue: 0.5,  min: 0,   max: 1,  curve: 'linear' },
    { id: 'position',   label: 'Position',   defaultValue: 0.5,  min: 0,   max: 1,  curve: 'linear' },
    { id: 'level',      label: 'Level',      defaultValue: 0.8,  min: 0,   max: 1,  curve: 'linear' },
  ],

  docs: {
    explanation:
      "A modal / string RESONATOR — a faithful port of Mutable Instruments Rings. It doesn't make a tone on its own: it RESONATES an exciter into pitched, decaying string and bell voices. Feed it an audio exciter on IN (a noise burst, a click, a drum, anything percussive works best) and it rings that energy out at the pitch set by PITCH; with nothing patched into IN, the STRUM input self-excites it with a short internal noise burst so it still sounds when you pluck it. MODEL switches the resonator type: MODAL is a bank of 24 stiffness-stretched resonant bandpass filters (harmonic at STRUCTURE 0, growing inharmonic and bell-like as STRUCTURE rises), and SYMPATHETIC is a pair of Karplus–Strong plucked strings whose detuning STRUCTURE sets. STRUCTURE/BRIGHTNESS/DAMPING/POSITION are the canonical Rings macros that sculpt the resonance — inharmonicity, high-end content, ring time, and pickup placement — and LEVEL is a soft-limited (tanh) output gain. The two outputs ODD and EVEN are complementary taps of the same resonator; patch both for a wide pseudo-stereo image, or just ODD for mono.",
    inputs: {
      in: "The audio EXCITER — the energy the resonator rings out. Patch a percussive, broadband signal here (a noise burst, an impulse/click, a drum hit, even another oscillator) and the body resonates it into pitched string/modal voices; sustained input keeps it continuously excited (a bowed/blown character). When nothing is patched here the resonator is silent until struck, so use STRUM (or an external exciter) to make it sound.",
      pitch: "1V/oct pitch. Sets the fundamental the resonator is tuned to (1 unit = 1 octave, 0 V = middle C); it sums with the NOTE offset before the body is configured. Sweeping it retunes every partial / both strings together.",
      strum: "A TRIGGER: each rising edge re-ignites the resonator with a short (~10 ms) internal noise burst, plucking/striking it once per pulse — like physically strumming the strings. It fires on the edge only and ignores how long the level stays high, so any clock, gate, or button pulse re-strikes it. STRUM works even with nothing patched into IN, making the module a self-contained plucked voice.",
      model_cv: "CV into the MODEL selector (discrete): it displaces the resonator-model choice, jumping between MODAL (0) and SYMPATHETIC (1) — e.g. a gate or step CV can switch resonator type mid-patch.",
      note_cv: "CV into the NOTE offset: it displaces the semitone offset that sums with PITCH (NOTE spans ±60 st), so an envelope or LFO here bends the tuning around the V/oct fundamental.",
      str_cv: "CV into STRUCTURE (0..1): it displaces the inharmonicity/structure macro — sweeping the modal partials from harmonic toward bell-like, or detuning the sympathetic string pair.",
      bright_cv: "CV into BRIGHTNESS (0..1): it displaces the high-end character of the resonance, opening or closing the brightness of the rung partials.",
      damp_cv: "CV into DAMPING (0..1): it displaces the ring time — low values resonate long, high values damp the partials quickly (a useful target for an envelope to shape per-note decay).",
      pos_cv: "CV into POSITION (0..1): it displaces the pickup position along the resonator, changing which partials are emphasized and shifting the ODD/EVEN balance.",
      level_cv: "CV into LEVEL (0..1): it displaces the soft-limited output gain, letting an envelope or LFO swell or duck the output.",
    },
    outputs: {
      odd: "One of the resonator's two complementary output taps (the cosine-weighted ODD-indexed partial sum in MODAL, the bridge tap of the string pair in SYMPATHETIC), passed through a tanh soft-limiter. Use it alone for a mono resonator output, or pair it with EVEN.",
      even: "The companion tap to ODD — the EVEN-indexed partial sum in MODAL, a second pickup read further along the string in SYMPATHETIC — also tanh soft-limited. ODD and EVEN carry different content from the same resonator, so patching both into a stereo bus gives a wide pseudo-stereo image; summing them back to mono recombines the body. In MODAL, POSITION 0.25 and 0.75 sit exactly on a pickup NODE for every odd-indexed partial, so EVEN falls silent there while ODD stays full — that null is real resonator behaviour (it is where the pickup lands on a mode's standing-wave zero), not a fault; nudge POSITION off the quarter-marks to bring EVEN back.",
    },
    controls: {
      model: "The resonator MODEL selector (the on-card button cycles it): MODAL (0) is a 24-partial stiffness-stretched resonant bandpass bank — a struck bar / bell / metal character — and SYMPATHETIC (1) is a pair of Karplus–Strong plucked strings detuned by STRUCTURE. The other macros mean the same thing in both models but the timbre changes substantially between them.",
      note: "A fixed semitone offset (-60..+60 st) added on top of the PITCH input, so you can tune the resonator without an external pitch source or transpose it relative to one. At 0 the resonator tracks PITCH (or middle C with PITCH unpatched).",
      structure: "The inharmonicity / structure macro (0..1): in MODAL it stretches the partial spacing from harmonic (0) toward bell-/metal-like (1); in SYMPATHETIC it detunes the second string from unison (0) up to about +19 semitones. The single biggest control over how 'tuned' versus 'clangy' the resonance sounds.",
      brightness: "Sculpts the high-frequency content of the resonance (0..1): low values are dark and muted, high values let the upper partials sing through. In SYMPATHETIC it also opens the brightness shaper on each string's input.",
      damping: "Sets the ring/decay time (0..1) across roughly three decades: low DAMPING resonates long (in MODAL a struck-bar tail measured in seconds; in SYMPATHETIC a near-lossless string loop), high DAMPING damps the energy quickly for a short, plucky decay of a few tens of milliseconds. In MODAL the partial Q is set proportional to partial frequency, so the whole bank decays together rather than the top of the spectrum dying first. A natural target for an envelope to vary decay per note.",
      position: "The pickup position along the resonator (0..1). In MODAL it is the classic Rings cosine pickup — partial n is weighted by cos(2*PI*POSITION*n) — so sweeping it moves a comb of emphasis and nulls across the bank and continuously rebalances ODD against EVEN (at 0.25 and 0.75 every odd-indexed partial sits on a node and EVEN goes silent, which is the pickup landing on a standing-wave zero). In SYMPATHETIC it places the second pickup along the string that feeds EVEN, and biases the strike formant of the internal pluck.",
      level: "Output gain (0..1) feeding a tanh soft-limiter, so pushing it adds gentle saturation rather than hard clipping. Sets the overall loudness of both ODD and EVEN.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'rings', {
      numberOfInputs: 3,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of ringsDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['in',        { node: workletNode, input: 0 }],
        ['pitch',     { node: workletNode, input: 1 }],
        ['strum',     { node: workletNode, input: 2 }],
        ['model_cv',  { node: workletNode, input: 0, param: params.get('model')! }],
        ['note_cv',   { node: workletNode, input: 0, param: params.get('note')! }],
        ['str_cv',    { node: workletNode, input: 0, param: params.get('structure')! }],
        ['bright_cv', { node: workletNode, input: 0, param: params.get('brightness')! }],
        ['damp_cv',   { node: workletNode, input: 0, param: params.get('damping')! }],
        ['pos_cv',    { node: workletNode, input: 0, param: params.get('position')! }],
        ['level_cv',  { node: workletNode, input: 0, param: params.get('level')! }],
      ]),
      outputs: new Map([
        ['odd',  { node: workletNode, output: 0 }],
        ['even', { node: workletNode, output: 1 }],
      ]),
      setParam(paramId, value) { params.get(paramId)?.setValueAtTime(value, ctx.currentTime); },
      readParam(paramId) { return params.get(paramId)?.value; },
      dispose() { try { workletNode.disconnect(); } catch { /* */ } },
    };
  },
};
