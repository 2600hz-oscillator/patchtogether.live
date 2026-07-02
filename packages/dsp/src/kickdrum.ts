// packages/dsp/src/kickdrum.ts
//
// KICK DRUM — layered stereo kick-voice AudioWorkletProcessor.
//
// Build plan: .myrobots/plans/kick-drum-voice-2026-07-01.md. The per-sample
// DSP lives in ./lib/kickdrum-dsp.ts (the FULL Phases-1–5 chain: SUB +
// BODY + CLICK layers, the oversampled `hard`-switch DRIVE, the own-code
// RBJ EQ chain + TRANSLATE exciter, the DYNAMICS block, and the Phase-5
// stereo stage — mono-safe sub, `width` widening only the >120 Hz side,
// each channel independently true-peak-ceilinged). This file is the worklet
// wrapper that owns the frozen I/O surface: all 25 params + 4 inputs + the
// stereo output.
//
// IMPORTANT: this file does NOT `export` anything at the top level —
// top-level exports leak into the bundled dist/<name>.js + break the ART
// classic-script eval. The Processor class is registered via the
// `registerProcessor` side-effect. Tests capture the class through a
// registerProcessor shim before importing this module. (memory:
// dsp-worklet-no-top-level-export)
//
// Inputs (audio-rate node connections):
//   inputs[0] = trigger_in (edge:'trigger' — the STRIKE; per-sample rising
//               edge prev<0.5 && cur>=0.5 detected inside the core step)
//   inputs[1] = accent_in  (cv 0..1, LATCHED at the strike edge by the core)
//   inputs[2] = pitch_cv   (1V/oct; transposes the whole voice)
//   inputs[3] = choke_in   (edge:'gate' — damps WHILE high, short ramp;
//               reacts to BOTH edges. Phase-1 placeholder implementation
//               below; later phases fold it into the core's decay laws.)
//
// AudioParams: the full 25-param frozen contract (see the def). Continuous
// params are smoothed with WtParamSmoother (80 Hz one-pole, the chowkick
// pattern); `hard` is a discrete k-rate switch and is NOT smoothed.
//
// Output: outputs[0] = one STEREO (2-channel) output. The web factory fans
// it into separate audio_l / audio_r ports via a ChannelSplitter (the
// cube.ts stereo idiom). L/R come from the core's kickdrumStepStereo:
// mid ± width·side, where the side is >120 Hz decorrelated click content
// only — the sub stays phase-coherent mono and a mono fold-down never
// thins (width=0 → L == R exactly).
//
// Every time constant derives from the LIVE sampleRate (audit A2 — no
// 48 000 literals).

import {
  KICKDRUM_P1_DEFAULTS,
  kickdrumStepStereo,
  makeKickdrumState,
  decayCoeff,
  type KickdrumP1Params,
  type KickdrumState,
} from './lib/kickdrum-dsp';
import { clamp } from './lib/chowkick-dsp';
import { WtParamSmoother } from './lib/wavetable-osc';

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
declare function registerProcessor(
  name: string,
  ctor: typeof AudioWorkletProcessor,
): void;

// Shim worklet globals when running outside AudioWorkletGlobalScope (vitest
// captures the class via this shim — the chowkick.test.ts loader pattern).
const G = globalThis as unknown as {
  AudioWorkletProcessor?: unknown;
  registerProcessor?: unknown;
};
if (typeof G.AudioWorkletProcessor === 'undefined') {
  G.AudioWorkletProcessor = class {};
}
if (typeof G.registerProcessor === 'undefined') {
  G.registerProcessor = () => {};
}

// The frozen 25-param contract: [name, default, min, max]. Single source for
// parameterDescriptors + the smoother priming below. `hard` is discrete.
const PARAM_TABLE: ReadonlyArray<readonly [string, number, number, number]> = [
  ['tune',        50,   20,  120],
  ['pitch_amt',   24,   0,   48],
  ['pitch_time',  30,   5,   120],
  ['tension',     0,    0,   0.6],
  ['sub_decay',   450,  50,  800],
  ['body_decay',  120,  20,  400],
  ['click_len',   12,   2,   60],
  ['sub_level',   0.9,  0,   1],
  ['body_level',  0.7,  0,   1],
  ['click_level', 0.4,  0,   1],
  ['body_shape',  0.3,  0,   1],
  ['click_tone',  2800, 500, 6000],
  ['drive',       0.4,  0,   1],
  ['hard',        0,    0,   1],
  ['translate',   0.3,  0,   1],
  ['sub_eq',      0,   -12,  12],
  ['body_eq',     3,   -12,  12],
  ['attack_eq',   2,   -12,  12],
  ['tilt',        0,   -1,   1],
  ['attack',      0.2, -1,   1],
  ['sustain',     0,   -1,   1],
  ['glue',        0.3,  0,   1],
  ['ceiling',     0.5,  0,   1],
  ['width',       0.2,  0,   1],
  ['level',       0,   -24,  12],
];

/** Choke damp: while choke_in is high the output is multiplied by a factor
 *  decaying to −60 dB in ~30 ms (the "short ramp" of the plan's graft #2.2);
 *  on the falling edge it RECOVERS through a ~10 ms one-pole so the release
 *  is click-free. Both-edge (level-sensitive) behavior by construction. */
const CHOKE_FALL_MS = 30;
const CHOKE_RISE_HZ = 15; // one-pole corner ≈ 10 ms recovery

const FLUSH = 1e-20;

// Not `export`ed at the top level by design — see the file-header note.
class KickdrumProcessor extends AudioWorkletProcessor {
  private sr: number;
  private st: KickdrumState;

  // Reused per-sample param object for the core (no per-sample GC).
  private p1: KickdrumP1Params;

  // One smoother per continuous param (the chowkick 80 Hz one-pole pattern);
  // `hard` (discrete) reads k-rate + unsmoothed.
  private sm: Record<string, WtParamSmoother> = {};

  private chokeDamp = 1;
  private chokeFall: number;
  private chokeRise: number;

  // Reused per-sample stereo frame for kickdrumStepStereo (no per-sample GC).
  private lr = new Float32Array(2);

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.sr = sampleRate;
    this.st = makeKickdrumState();
    this.p1 = { ...KICKDRUM_P1_DEFAULTS };
    for (const [name, def] of PARAM_TABLE) {
      if (name === 'hard') continue; // discrete switch — never smoothed
      const s = new WtParamSmoother(this.sr);
      // Prime to the default so first-sample reads aren't a ramp from 0.
      s.prime(def);
      this.sm[name] = s;
    }
    this.chokeFall = decayCoeff(CHOKE_FALL_MS, this.sr);
    this.chokeRise = 1 - Math.exp((-2 * Math.PI * CHOKE_RISE_HZ) / this.sr);
  }

  static get parameterDescriptors() {
    return PARAM_TABLE.map(([name, def, min, max]) => ({
      name,
      defaultValue: def,
      minValue: min,
      maxValue: max,
      // `hard` is a discrete 0/1 switch → k-rate; everything else a-rate so
      // future per-sample automation reaches the DSP.
      automationRate: (name === 'hard' ? 'k-rate' : 'a-rate') as 'a-rate' | 'k-rate',
    }));
  }

  private aval(p: Record<string, Float32Array>, name: string, s: number, fallback: number): number {
    const arr = p[name];
    if (!arr || arr.length === 0) return fallback;
    return (arr.length > 1 ? arr[s] : arr[0]) as number;
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const inTrig = inputs[0]?.[0];
    const inAccent = inputs[1]?.[0];
    const inPitch = inputs[2]?.[0];
    const inChoke = inputs[3]?.[0];
    const outL = outputs[0]?.[0];
    const outR = outputs[0]?.[1];
    if (!outL) return true;
    const n = outL.length;

    // Discrete k-rate switch (the owner's single drive-character switch:
    // 0 = clean tanh @2×, 1 = wavefold+asym @4×). Never smoothed.
    const hard = this.aval(parameters, 'hard', 0, 0) >= 0.5 ? 1 : 0;

    const p1 = this.p1;
    p1.hard = hard;

    for (let s = 0; s < n; s++) {
      // ── smoothed per-sample params ──
      const sm = this.sm;
      const rd = (name: string, fb: number) =>
        sm[name]!.step(this.aval(parameters, name, s, fb));

      p1.tune       = rd('tune', 50);
      p1.pitchAmt   = rd('pitch_amt', 24);
      p1.pitchTime  = rd('pitch_time', 30);
      p1.tension    = rd('tension', 0);
      p1.subDecay   = rd('sub_decay', 450);
      p1.bodyDecay  = rd('body_decay', 120);
      p1.subLevel   = rd('sub_level', 0.9);
      p1.bodyLevel  = rd('body_level', 0.7);
      p1.bodyShape  = rd('body_shape', 0.3);
      p1.clickLen   = rd('click_len', 12);
      p1.clickLevel = rd('click_level', 0.4);
      p1.clickTone  = rd('click_tone', 2800);
      p1.translate  = rd('translate', 0.3);
      p1.subEq      = rd('sub_eq', 0);
      p1.bodyEq     = rd('body_eq', 3);
      p1.attackEq   = rd('attack_eq', 2);
      p1.tilt       = rd('tilt', 0);
      p1.attack     = rd('attack', 0.2);
      p1.sustain    = rd('sustain', 0);
      p1.glue       = rd('glue', 0.3);
      p1.ceiling    = rd('ceiling', 0.5);
      p1.width      = rd('width', 0.2);
      p1.pitchCv    = inPitch ? (inPitch[s] ?? 0) : 0;

      const driveRaw = rd('drive', 0.4);
      const levelDb = clamp(rd('level', 0), -24, 12);

      // ── ACCENT macro, drive + level components (plan §2: accent scales
      // pitch-env depth [inside the core, via the latched accent] + drive +
      // level together). Applied as PRE-core param modulation so the boost
      // leans into the ceiling clip and the output stays true-peak bounded.
      // Uses the latch from the previous sample — a 1-sample lag on the
      // strike sample itself, where the voice is still at phase 0 ≈ silent. ──
      const acc = this.st.accentLatch;
      p1.drive = clamp(driveRaw * (1 + 0.3 * acc), 0, 1);
      p1.level = clamp(levelDb + 4 * acc, -24, 12);

      // ── the stereo voice (strike edge-detect + accent latch inside the
      // core; mid ± width·side, per-channel true-peak ceiling) ──
      const trig = inTrig ? (inTrig[s] ?? 0) : 0;
      const accent = inAccent ? (inAccent[s] ?? 0) : 0;
      kickdrumStepStereo(trig, accent, p1, this.sr, this.st, this.lr);

      // ── CHOKE (edge:'gate' placeholder): damp WHILE high via a fast
      // multiplicative ramp; recover through a short one-pole on release.
      // Both edges observed per-sample — level-sensitive by construction.
      // Applied post-ceiling to BOTH channels: damp × bounded stays bounded. ──
      const choke = inChoke ? (inChoke[s] ?? 0) : 0;
      if (choke >= 0.5) {
        this.chokeDamp *= this.chokeFall;
        if (this.chokeDamp < FLUSH) this.chokeDamp = 0;
      } else {
        this.chokeDamp += (1 - this.chokeDamp) * this.chokeRise;
      }
      outL[s] = (this.lr[0] as number) * this.chokeDamp;
      if (outR) outR[s] = (this.lr[1] as number) * this.chokeDamp;
    }

    return true;
  }
}

registerProcessor('kickdrum', KickdrumProcessor);
