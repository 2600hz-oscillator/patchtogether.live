// packages/dsp/src/sixstrum.ts
//
// SIX STRUM — 6-voice Karplus guitar/bass/harp AudioWorkletProcessor. The
// per-sample DSP lives in ./lib/sixstrum-dsp.ts (6 EKS string voices + per-voice
// ADSR + strum scheduler + resonant body); this file is the worklet wrapper that
// owns the frozen I/O surface: 19 params + 15 inputs + one mono output.
//
// IMPORTANT: no top-level `export` — top-level exports leak into the bundled
// dist and break the ART classic-script eval; the class is registered via the
// `registerProcessor` side-effect (tests capture it through the shim). (memory:
// dsp-worklet-no-top-level-export)
//
// Inputs (audio-rate node connections; an UNPATCHED input arrives as a
// zero-length outer array, which is how presence + strum normalling are
// detected — there are NO keep-alive sources, so this stays reliable):
//   inputs[0]      = poly   (polyPitchGate; lanes 0..5 → strings, ch 2i pitch /
//                            2i+1 gate). Present ⇒ poly drives pitch + pluck.
//   inputs[1]      = chord  (mono pitch CV, V/oct root). Present ⇒ its voiced
//                            chord sets the 6 string pitches.
//   inputs[2..7]   = strum1..6 (edge:'trigger'). NORMALLED low→high: an
//                            unpatched string follows the nearest patched strum
//                            at or below it (patch only #1 ⇒ barre all six).
//   inputs[8..13]  = mute1..6  (edge:'gate'; finger-on-string palm mute).
//   inputs[14]     = accent (cv 0..1 velocity; unpatched ⇒ a musical 0.6).
//
// AudioParams: the 19-param knob contract (k-rate; read once per block and fed
// to the block prep — knobs don't need audio-rate). Every time constant derives
// from the LIVE sampleRate.

import {
  SIXSTRUM_DEFAULTS,
  SS_STRINGS,
  type SixStrumParams,
  type SixStrumFrame,
  type SixStrumState,
  makeSixStrumState,
  prepSixStrumBlock,
  sixStrumStep,
} from './lib/sixstrum-dsp';

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

const G = globalThis as unknown as {
  AudioWorkletProcessor?: unknown;
  registerProcessor?: unknown;
};
if (typeof G.AudioWorkletProcessor === 'undefined') G.AudioWorkletProcessor = class {};
if (typeof G.registerProcessor === 'undefined') G.registerProcessor = () => {};

// Input index layout.
const IN_POLY = 0;
const IN_CHORD = 1;
const IN_STRUM0 = 2; // strum1..6 = inputs[2..7]
const IN_MUTE0 = 8; // mute1..6  = inputs[8..13]
const IN_ACCENT = 14;

// The frozen 19-param knob contract: [name, default, min, max]. Order is the
// contract — keep it in lockstep with the def's params.
const PARAM_TABLE: ReadonlyArray<readonly [keyof SixStrumParams, number, number, number]> = [
  ['register', 0, -24, 24],
  ['ring', 2.5, 0.1, 10],
  ['material', 0.55, 0, 1],
  ['pickPos', 0.17, 0.02, 0.5],
  ['stiffness', 0.06, 0, 1],
  ['pickTone', 0.6, 0, 1],
  ['pickGrain', 1, 0.1, 4],
  ['attack', 0.003, 0.0005, 5],
  ['envDecay', 0.12, 0.001, 5],
  ['sustain', 1, 0, 1],
  ['release', 0.35, 0.001, 5],
  ['muteDepth', 0.5, 0, 1],
  ['strumSpread', 0.28, 0, 1],
  ['strumDir', 0, 0, 2],
  ['spread', 0.25, 0, 1],
  ['body', 0.35, 0, 1],
  ['level', 0, -24, 12],
  ['tuning', 0, 0, 2],
  ['quality', 0, 0, 7],
];

class SixStrumProcessor extends AudioWorkletProcessor {
  private sr: number;
  private st: SixStrumState;
  private p: SixStrumParams;
  private frame: SixStrumFrame;
  private strumSrc: Int32Array; // per string, resolved input index (−1 = none)

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.sr = sampleRate;
    this.st = makeSixStrumState(this.sr);
    this.p = { ...SIXSTRUM_DEFAULTS };
    this.frame = {
      strum: new Float32Array(SS_STRINGS),
      mute: new Float32Array(SS_STRINGS),
      polyPitch: new Float32Array(SS_STRINGS),
      polyGate: new Float32Array(SS_STRINGS),
      accent: 0.6,
    };
    this.strumSrc = new Int32Array(SS_STRINGS);
  }

  static get parameterDescriptors() {
    return PARAM_TABLE.map(([name, def, min, max]) => ({
      name: name as string,
      defaultValue: def,
      minValue: min,
      maxValue: max,
      automationRate: 'k-rate' as const,
    }));
  }

  private k(parameters: Record<string, Float32Array>, name: string, fb: number): number {
    const a = parameters[name];
    return a && a.length > 0 ? (a[0] as number) : fb;
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]?.[0];
    if (!out) return true;
    const n = out.length;
    const p = this.p;
    const f = this.frame;

    // ── read the 19 k-rate knobs once per block ──
    for (const [name, def] of PARAM_TABLE) {
      (p as unknown as Record<string, number>)[name as string] = this.k(parameters, name as string, def);
    }

    // ── presence detection (unpatched input = zero-length outer array) ──
    const poly = (inputs[IN_POLY]?.length ?? 0) >= 2;
    const chordCh = inputs[IN_CHORD]?.[0];
    const chordPresent = !!chordCh && chordCh.length > 0;
    const accentCh = inputs[IN_ACCENT]?.[0];
    const accentPresent = !!accentCh && accentCh.length > 0;
    p.polyConnected = poly ? 1 : 0;
    p.chordConnected = chordPresent ? 1 : 0;

    // Strum normalling: low→high, each string follows the nearest patched strum
    // at or below it (patch only #1 ⇒ barre all six).
    let last = -1;
    for (let i = 0; i < SS_STRINGS; i++) {
      const ch = inputs[IN_STRUM0 + i]?.[0];
      if (ch && ch.length > 0) last = i;
      this.strumSrc[i] = last;
    }

    // ── per-block prep (chord voicing / body / spread) ──
    const chordRootMidi = chordPresent ? 60 + (chordCh![0] ?? 0) * 12 : 60;
    prepSixStrumBlock(p, chordRootMidi, this.sr, this.st);

    // ── sample loop ──
    for (let s = 0; s < n; s++) {
      for (let i = 0; i < SS_STRINGS; i++) {
        const src = this.strumSrc[i]!;
        f.strum[i] = src >= 0 ? (inputs[IN_STRUM0 + src]?.[0]?.[s] ?? 0) : 0;
        f.mute[i] = inputs[IN_MUTE0 + i]?.[0]?.[s] ?? 0;
        if (poly) {
          f.polyPitch[i] = inputs[IN_POLY]?.[2 * i]?.[s] ?? 0;
          f.polyGate[i] = inputs[IN_POLY]?.[2 * i + 1]?.[s] ?? 0;
        } else {
          f.polyPitch[i] = 0;
          f.polyGate[i] = 0;
        }
      }
      f.accent = accentPresent ? Math.max(0, Math.min(1, accentCh![s] ?? 0.6)) : 0.6;
      out[s] = sixStrumStep(f, p, this.sr, this.st);
    }

    return true;
  }
}

registerProcessor('sixstrum', SixStrumProcessor);
