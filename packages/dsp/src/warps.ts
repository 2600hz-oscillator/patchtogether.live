// packages/dsp/src/warps.ts
//
// WARPS — meta-modulator / signal masher worklet processor.
//
// Clean-room TypeScript port of the Mutable Instruments Warps "Modulator"
// algorithm family. Original C++ Copyright 2014 Emilie Gillet
// (https://github.com/pichenettes/eurorack/tree/master/warps), MIT-licensed.
// Algorithms reimplemented from the published source; this is not a
// transpiled emscripten port (see PR #27 closed for that direction across
// the project).
//
// v1 scope (mandatory algorithms from the brief):
//   0  XFADE     — equal-power crossfade between carrier and modulator.
//                  TIMBRE selects mix position (parameter 0..1; 0 = carrier,
//                  1 = modulator). Replaces Warps' lookup-table xfade with
//                  a sin/cos pair so the constant-power surface is exact.
//   1  RING-MOD  — digital ring modulation. 4 * x1 * x2 * (1 + parameter*8),
//                  softclipped (x / (1 + |x|)). Same math as Warps'
//                  DIGITAL_RING_MODULATION.
//   2  XOR       — 16-bit XOR bit-mash of the two streams, then crossfaded
//                  against the raw 0.7 * (x1 + x2) sum by parameter. Same
//                  math as Warps' ALGORITHM_XOR.
//   3  COMPARATOR — Warps' ALGORITHM_COMPARATOR. Four discrete sub-modes
//                   (direct / threshold / window / window2) interpolated
//                   by parameter * 2.995. See Modulator::Xmod<COMPARATOR>
//                   in modulator.cc.
// Internal carrier oscillator (when carrier_in is unpatched, the carrier
// signal is generated internally so the module is useful with a single
// input or with no inputs at all). CARRIER_SHAPE knob (0..1):
//   0..0.25 sine, 0.25..0.5 triangle, 0.5..0.75 saw, 0.75..1 square.
// V/oct pitch input drives the internal oscillator; NOTE-style scaling is
// summed into the oscillator's phase increment (1 unit = 1 octave).
//
// Stretch (deferred to follow-up): FOLD (Warps' wavefolder), ANALOG-RING
// (diode ring), FREQUENCY-SHIFTER, DOPPLER, VOCODER. Listed in PR body.
//
// Inputs (audio-rate connections):
//   inputs[0] = carrier_in     audio carrier (if patched, replaces internal osc)
//   inputs[1] = modulator_in   audio modulator
//   inputs[2] = pitch          V/oct for internal carrier (1 unit = 1 oct)
// Outputs:
//   outputs[0] = main          stereo-summed mono output (this v1 ships mono;
//                              card declares one output port to match)
//
// AudioParams:
//   algorithm        0..3      Which Xmod to run (rounded to nearest int).
//   carrier_shape    0..1      Internal oscillator waveform selector.
//   timbre           0..1      Per-algorithm intensity / mix.
//   level_1          0..1      Carrier input gain (and crossfade weight for XFADE).
//   level_2          0..1      Modulator input gain.
//   note             -60..60   Semitone offset summed with the pitch V/oct.

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

// Soft-limit / x/(1+|x|) — matches Warps' SoftLimit-flavoured outputs on
// the ring-mod path and serves as a final guard against runaway gain.
function softLimit(x: number): number {
  return x / (1 + Math.abs(x));
}

// Internal oscillator. Phase accumulator 0..1, four waveforms blendable by
// the carrier_shape selector.
class InternalOsc {
  phase = 0;

  tick(freq: number, shape: number, sr: number): number {
    const dt = freq / sr;
    this.phase += dt;
    if (this.phase >= 1) this.phase -= 1;
    const t = this.phase;
    // shape: 0..0.25 sine, 0.25..0.5 tri, 0.5..0.75 saw, 0.75..1 square.
    // Hard switch; no morph between bands so the user gets clean stable
    // shapes at each detent (matches Warps' five-position OscillatorShape
    // enum without the FOLD/NOISE entries that we're not shipping).
    const s = Math.max(0, Math.min(1, shape));
    if (s < 0.25) return Math.sin(2 * Math.PI * t);
    if (s < 0.5)  return 1 - 4 * Math.abs(t - 0.5);
    if (s < 0.75) return 2 * t - 1;
    return t < 0.5 ? 1 : -1;
  }

  reset(): void {
    this.phase = 0;
  }
}

// Algorithm primitives — one-sample functions used by the per-sample loop.
// Mirrored exactly in packages/web/src/lib/audio/modules/warps.ts so the
// unit-test math matches the worklet bit-for-bit.

function xmodXfade(carrier: number, modulator: number, parameter: number): number {
  // Equal-power crossfade. parameter=0 → carrier only, parameter=1 → mod only.
  const p = Math.max(0, Math.min(1, parameter));
  const g1 = Math.cos(p * Math.PI * 0.5);
  const g2 = Math.sin(p * Math.PI * 0.5);
  return carrier * g1 + modulator * g2;
}

function xmodRingMod(x1: number, x2: number, parameter: number): number {
  const ring = 4 * x1 * x2 * (1 + parameter * 8);
  return ring / (1 + Math.abs(ring));
}

function xmodXor(x1: number, x2: number, parameter: number): number {
  // 16-bit XOR mash. Faithful to Warps' ALGORITHM_XOR: clip the two streams
  // to short-int range, XOR, normalize back to float, then crossfade vs a
  // 0.7 * (x1 + x2) sum by parameter.
  const x1s = Math.max(-32768, Math.min(32767, Math.round(x1 * 32768))) | 0;
  const x2s = Math.max(-32768, Math.min(32767, Math.round(x2 * 32768))) | 0;
  const mod = (x1s ^ x2s) / 32768;
  const sum = (x1 + x2) * 0.7;
  return sum + (mod - sum) * parameter;
}

function xmodComparator(modulator: number, carrier: number, parameter: number): number {
  // Direct port of Warps' ALGORITHM_COMPARATOR. parameter * 2.995 selects
  // between 4 sub-modes via linear interpolation between adjacent entries.
  const x = Math.max(0, Math.min(2.995, parameter * 2.995));
  const xInt = Math.floor(x);
  const xFrac = x - xInt;
  const direct = modulator < carrier ? modulator : carrier;
  const window = Math.abs(modulator) > Math.abs(carrier) ? modulator : carrier;
  const window2 = Math.abs(modulator) > Math.abs(carrier)
    ? Math.abs(modulator) : -Math.abs(carrier);
  const threshold = carrier > 0.05 ? carrier : modulator;
  const sequence = [direct, threshold, window, window2];
  const a = sequence[xInt]!;
  const b = sequence[xInt + 1] ?? sequence[xInt]!;
  return a + (b - a) * xFrac;
}

function applyAlgorithm(
  algorithm: number,
  carrier: number,
  modulator: number,
  parameter: number,
): number {
  switch (algorithm) {
    case 0: return xmodXfade(carrier, modulator, parameter);
    case 1: return xmodRingMod(carrier, modulator, parameter);
    case 2: return xmodXor(carrier, modulator, parameter);
    case 3: return xmodComparator(modulator, carrier, parameter);
    default: return xmodXfade(carrier, modulator, parameter);
  }
}

class WarpsProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'algorithm',     defaultValue: 0,   minValue:   0, maxValue:  3, automationRate: 'k-rate' as const },
      { name: 'carrier_shape', defaultValue: 0,   minValue:   0, maxValue:  1, automationRate: 'a-rate' as const },
      { name: 'timbre',        defaultValue: 0.5, minValue:   0, maxValue:  1, automationRate: 'a-rate' as const },
      { name: 'level_1',       defaultValue: 1,   minValue:   0, maxValue:  1, automationRate: 'a-rate' as const },
      { name: 'level_2',       defaultValue: 1,   minValue:   0, maxValue:  1, automationRate: 'a-rate' as const },
      { name: 'note',          defaultValue: 0,   minValue: -60, maxValue: 60, automationRate: 'a-rate' as const },
    ];
  }

  osc = new InternalOsc();

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const carrierIn   = inputs[0]?.[0];
    const modulatorIn = inputs[1]?.[0];
    const pitchIn     = inputs[2]?.[0];
    const out         = outputs[0]?.[0];

    const algorithm    = parameters.algorithm;
    const carrierShape = parameters.carrier_shape;
    const timbre       = parameters.timbre;
    const level1       = parameters.level_1;
    const level2       = parameters.level_2;
    const note         = parameters.note;

    const algoIdx = Math.max(0, Math.min(3, Math.round(algorithm[0] ?? 0)));

    const frames = out?.length ?? 0;
    for (let i = 0; i < frames; i++) {
      const cs   = carrierShape.length > 1 ? (carrierShape[i] ?? carrierShape[0]) : carrierShape[0];
      const t    = timbre.length       > 1 ? (timbre[i]       ?? timbre[0])       : timbre[0];
      const l1   = level1.length       > 1 ? (level1[i]       ?? level1[0])       : level1[0];
      const l2   = level2.length       > 1 ? (level2[i]       ?? level2[0])       : level2[0];
      const nv   = note.length         > 1 ? (note[i]         ?? note[0])         : note[0];

      const pitchV = pitchIn ? (pitchIn[i] ?? 0) : 0;
      const semis = pitchV * 12 + (nv ?? 0);
      let freq = 261.6256 * Math.pow(2, semis / 12);
      if (freq < 1) freq = 1; else if (freq > 20000) freq = 20000;

      // Internal carrier from the on-board oscillator. If carrier_in is
      // patched, the user's audio replaces the internal osc; otherwise the
      // internal source drives everything (lets you use WARPS with just a
      // modulator + the internal carrier, the canonical ring-mod patch).
      const internal = this.osc.tick(freq, cs ?? 0, sampleRate);
      const carrier = carrierIn ? (carrierIn[i] ?? 0) : internal;
      const modulator = modulatorIn ? (modulatorIn[i] ?? 0) : 0;

      const cScaled = carrier * (l1 ?? 1);
      const mScaled = modulator * (l2 ?? 1);

      const y = applyAlgorithm(algoIdx, cScaled, mScaled, t ?? 0.5);
      if (out) out[i] = softLimit(y);
    }
    return true;
  }
}

registerProcessor('warps', WarpsProcessor);
