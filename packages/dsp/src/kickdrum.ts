// packages/dsp/src/kickdrum.ts
//
// KICK DRUM — layered stereo kick-voice AudioWorkletProcessor.
//
// Build plan: .myrobots/plans/kick-drum-voice-2026-07-01.md. The per-sample
// DSP lives in ./lib/kickdrum-dsp.ts (Phase 1 today: SUB + BODY layers +
// strike machinery). This file is the worklet wrapper that owns the FULL
// frozen I/O surface — all 25 params + 4 inputs + the stereo output — so the
// def/card/contract never change as the later DSP phases (CLICK, oversampled
// DRIVE, EQ, TRANSLATE, DYNAMICS, stereo crossover) land inside the core.
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
//               edge prev<0.5 && cur>=0.5 detected inside kickdrumP1Step)
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
// cube.ts stereo idiom). Phase 1 writes L = R (the stereo crossover + width
// land in a later phase); the port surface is already stereo so patches
// survive the upgrade unchanged.
//
// Every time constant derives from the LIVE sampleRate (audit A2 — no
// 48 000 literals).

import {
  kickdrumP1Step,
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

  // Reused per-sample param object for the Phase-1 core (no per-sample GC).
  private p1: KickdrumP1Params;

  // Phase-2+ options object: ALL not-yet-consumed params, smoothed and
  // refreshed per sample. Later phases pass this straight into the grown
  // core step, so landing them is a worklet-internal change only.
  private phaseOpts: Record<string, number> = {};

  // One smoother per continuous param (the chowkick 80 Hz one-pole pattern);
  // `hard` (discrete) reads k-rate + unsmoothed.
  private sm: Record<string, WtParamSmoother> = {};

  private chokeDamp = 1;
  private chokeFall: number;
  private chokeRise: number;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.sr = sampleRate;
    this.st = makeKickdrumState();
    this.p1 = {
      tune: 50,
      pitchAmt: 24,
      pitchTime: 30,
      tension: 0,
      subDecay: 450,
      bodyDecay: 120,
      subLevel: 0.9,
      bodyLevel: 0.7,
      bodyShape: 0.3,
      pitchCv: 0,
    };
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

    // Discrete k-rate switch (Phase-2 drive character; plumbed now).
    const hard = this.aval(parameters, 'hard', 0, 0) >= 0.5 ? 1 : 0;

    const p1 = this.p1;
    const o = this.phaseOpts;

    for (let s = 0; s < n; s++) {
      // ── smoothed per-sample params ──
      const sm = this.sm;
      const rd = (name: string, fb: number) =>
        sm[name]!.step(this.aval(parameters, name, s, fb));

      // Phase-1 core params.
      p1.tune      = rd('tune', 50);
      p1.pitchAmt  = rd('pitch_amt', 24);
      p1.pitchTime = rd('pitch_time', 30);
      p1.tension   = rd('tension', 0);
      p1.subDecay  = rd('sub_decay', 450);
      p1.bodyDecay = rd('body_decay', 120);
      p1.subLevel  = rd('sub_level', 0.9);
      p1.bodyLevel = rd('body_level', 0.7);
      p1.bodyShape = rd('body_shape', 0.3);
      p1.pitchCv   = inPitch ? (inPitch[s] ?? 0) : 0;

      // Phase-2+ params: smoothed + collected so the contract is already
      // live; the core grows into consuming this object phase by phase.
      o.clickLen   = rd('click_len', 12);
      o.clickLevel = rd('click_level', 0.4);
      o.clickTone  = rd('click_tone', 2800);
      o.drive      = rd('drive', 0.4);
      o.hard       = hard;
      o.translate  = rd('translate', 0.3);
      o.subEq      = rd('sub_eq', 0);
      o.bodyEq     = rd('body_eq', 3);
      o.attackEq   = rd('attack_eq', 2);
      o.tilt       = rd('tilt', 0);
      o.attack     = rd('attack', 0.2);
      o.sustain    = rd('sustain', 0);
      o.glue       = rd('glue', 0.3);
      o.ceiling    = rd('ceiling', 0.5);
      o.width      = rd('width', 0.2);
      const levelDb = clamp(rd('level', 0), -24, 12);

      // ── the Phase-1 voice (strike edge-detect + accent latch inside) ──
      const trig = inTrig ? (inTrig[s] ?? 0) : 0;
      const accent = inAccent ? (inAccent[s] ?? 0) : 0;
      let v = kickdrumP1Step(trig, accent, p1, this.sr, this.st);

      // ── ACCENT macro, level component (plan §2: accent scales pitch-env
      // depth [in the core] + level [here] together). Latched per hit, so an
      // accented strike lands up to +50 % hotter. Phase-4 dynamics will fold
      // this into the core; the audible contract is already live. ──
      v *= 1 + 0.5 * this.st.accentLatch;

      // ── CHOKE (edge:'gate' placeholder): damp WHILE high via a fast
      // multiplicative ramp; recover through a short one-pole on release.
      // Both edges observed per-sample — level-sensitive by construction. ──
      const choke = inChoke ? (inChoke[s] ?? 0) : 0;
      if (choke >= 0.5) {
        this.chokeDamp *= this.chokeFall;
        if (this.chokeDamp < FLUSH) this.chokeDamp = 0;
      } else {
        this.chokeDamp += (1 - this.chokeDamp) * this.chokeRise;
      }
      v *= this.chokeDamp;

      // ── output level (dB, −24..+12; the headroom fix vs chowkick's
      // −60..0 — guarded by the Phase-4 ceiling clip when it lands) ──
      v *= Math.pow(10, levelDb / 20);

      // Phase 1 is mono-summed: L = R (the <120 Hz band is ALWAYS mono by
      // design; width only ever affects the upper band, in a later phase).
      outL[s] = v;
      if (outR) outR[s] = v;
    }

    return true;
  }
}

registerProcessor('kickdrum', KickdrumProcessor);
