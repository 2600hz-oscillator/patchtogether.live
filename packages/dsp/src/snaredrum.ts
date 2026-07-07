// packages/dsp/src/snaredrum.ts
//
// SNARE DRUM — deep stereo snare VOICE with a polyphonic two-hand DRUMROLL
// AudioWorkletProcessor. The per-sample DSP lives in ./lib/snaredrum-dsp.ts
// (HEAD modal bank + BODY noise + CRACK per-voice, the SHARED re-excitable
// wire-buzz bed, the shared oversampled-drive/DC/ceiling bus, the mono-safe
// M/S stereo stage) and ./lib/snare-roll-dsp.ts (the two-hand scheduler +
// bounce structure + lowest-energy voice pool). Design + build spec:
// .myrobots/snare-drum-module-design.md.
//
// IMPORTANT: this file does NOT `export` anything at the top level — top-level
// exports leak into the bundled dist/snaredrum.js + break the ART classic-script
// eval. The Processor class is registered via the registerProcessor side-effect;
// tests capture it through a registerProcessor shim before importing this module.
// (memory: dsp-worklet-no-top-level-export)
//
// Inputs (audio-rate node connections; design §5):
//   inputs[0] = trigger_in    (edge:'trigger' — one snare HIT per rising edge)
//   inputs[1] = gate_in       (edge:'gate' — DRUMROLL while the level is high)
//   inputs[2] = roll_speed_cv (1 V/oct multiply on roll_speed)
//   inputs[3] = accent_in     (cv 0..1 — per-hit velocity + drive/level macro)
//   inputs[4] = pitch_cv      (1 V/oct transpose of the whole voice)
//   inputs[5] = choke_in      (edge:'gate' — hand-on-head mute while high)
//
// Output: outputs[0] = one STEREO (2-channel) output. The web factory fans it
// into separate audio_l / audio_r ports via a ChannelSplitter (the cube.ts /
// kickdrum idiom). width=0 AND spread=0 → L == R exactly (mono-safe).
//
// Every time constant derives from the LIVE sampleRate. Continuous params are
// smoothed with WtParamSmoother (80 Hz one-pole, the kickdrum pattern);
// `hard` is a discrete k-rate switch and is NOT smoothed.

import {
  SNAREDRUM_DEFAULTS,
  decayCoeff,
  makeSnaredrumState,
  snaredrumStepStereo,
  type SnaredrumParams,
  type SnaredrumState,
} from './lib/snaredrum-dsp';
import { clamp } from './lib/dsp-utils';
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
declare function registerProcessor(name: string, ctor: typeof AudioWorkletProcessor): void;

// Shim worklet globals when running outside AudioWorkletGlobalScope (vitest
// captures the class via this shim — the kickdrum loader pattern).
const G = globalThis as unknown as { AudioWorkletProcessor?: unknown; registerProcessor?: unknown };
if (typeof G.AudioWorkletProcessor === 'undefined') G.AudioWorkletProcessor = class {};
if (typeof G.registerProcessor === 'undefined') G.registerProcessor = () => {};

// The frozen 22-param contract: [name, default, min, max]. Single source for
// parameterDescriptors + the smoother priming below. `hard` is discrete.
const PARAM_TABLE: ReadonlyArray<readonly [string, number, number, number]> = [
  ['tune',        180,  90,   400],
  ['tone',        0.5,  0,    1],
  ['damping',     0.4,  0,    1],
  ['head_decay',  180,  30,   600],
  ['body_decay',  110,  20,   300],
  ['pitch_amt',   3,    0,    12],
  ['pitch_time',  18,   3,    80],
  ['wire',        0.7,  0,    1],
  ['wire_tone',   4500, 1500, 9000],
  ['wire_decay',  260,  40,   700],
  ['crack',       0.4,  0,    1],
  ['crack_tone',  3200, 800,  7000],
  ['damp',        0.2,  0,    1],
  ['roll_speed',  0.5,  0,    1],
  ['bounce',      0.35, 0,    1],
  ['humanize',    0.2,  0,    1],
  ['spread',      0.5,  0,    1],
  ['drive',       0.2,  0,    1],
  ['hard',        0,    0,    1],
  ['ceiling',     0.5,  0,    1],
  ['width',       0.4,  0,    1],
  ['level',       0,   -24,   12],
];

/** Choke damp: while choke_in is high, multiply the output down to −60 dB in
 *  ~30 ms; on the falling edge it RECOVERS through a ~10 ms one-pole. Both-edge
 *  (level-sensitive) behavior by construction (the kickdrum choke pattern). */
const CHOKE_FALL_MS = 30;
const CHOKE_RISE_HZ = 15;
const FLUSH = 1e-20;

// Not `export`ed at the top level by design — see the file-header note.
class SnaredrumProcessor extends AudioWorkletProcessor {
  private sr: number;
  private st: SnaredrumState;
  private p: SnaredrumParams;
  private sm: Record<string, WtParamSmoother> = {};
  private chokeDamp = 1;
  private chokeFall: number;
  private chokeRise: number;
  private lr = new Float32Array(2);

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.sr = sampleRate;
    this.st = makeSnaredrumState();
    this.p = { ...SNAREDRUM_DEFAULTS };
    for (const [name, def] of PARAM_TABLE) {
      if (name === 'hard') continue; // discrete switch — never smoothed
      const s = new WtParamSmoother(this.sr);
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
    const inGate = inputs[1]?.[0];
    const inRollCv = inputs[2]?.[0];
    const inAccent = inputs[3]?.[0];
    const inPitch = inputs[4]?.[0];
    const inChoke = inputs[5]?.[0];
    const outL = outputs[0]?.[0];
    const outR = outputs[0]?.[1];
    if (!outL) return true;
    const n = outL.length;

    // Discrete k-rate drive-character switch (never smoothed).
    const hard = this.aval(parameters, 'hard', 0, 0) >= 0.5 ? 1 : 0;
    const p = this.p;
    p.hard = hard;

    for (let s = 0; s < n; s++) {
      const sm = this.sm;
      const rd = (name: string, fb: number) => sm[name]!.step(this.aval(parameters, name, s, fb));

      p.tune = rd('tune', 180);
      p.tone = rd('tone', 0.5);
      p.damping = rd('damping', 0.4);
      p.headDecay = rd('head_decay', 180);
      p.bodyDecay = rd('body_decay', 110);
      p.pitchAmt = rd('pitch_amt', 3);
      p.pitchTime = rd('pitch_time', 18);
      p.wire = rd('wire', 0.7);
      p.wireTone = rd('wire_tone', 4500);
      p.wireDecay = rd('wire_decay', 260);
      p.crack = rd('crack', 0.4);
      p.crackTone = rd('crack_tone', 3200);
      p.damp = rd('damp', 0.2);
      p.rollSpeed = rd('roll_speed', 0.5);
      p.bounce = rd('bounce', 0.35);
      p.humanize = rd('humanize', 0.2);
      p.spread = rd('spread', 0.5);
      p.ceiling = rd('ceiling', 0.5);
      p.width = rd('width', 0.4);
      p.pitchCv = inPitch ? (inPitch[s] ?? 0) : 0;
      p.rollSpeedCv = inRollCv ? (inRollCv[s] ?? 0) : 0;

      const driveRaw = rd('drive', 0.2);
      const levelDb = clamp(rd('level', 0), -24, 12);

      // ACCENT macro (design §5, KICK parity): the latched-per-strike vel scale
      // is applied inside the core (accent arg); here accent also lifts drive +
      // level PRE-core so an accented hit leans into the ceiling clip.
      const accent = inAccent ? clamp(inAccent[s] ?? 0, 0, 1) : 0;
      p.drive = clamp(driveRaw * (1 + 0.3 * accent), 0, 1);
      p.level = clamp(levelDb + 4 * accent, -24, 12);

      const trig = inTrig ? (inTrig[s] ?? 0) : 0;
      const gate = inGate ? (inGate[s] ?? 0) : 0;
      snaredrumStepStereo(trig, gate, accent, p, this.sr, this.st, this.lr);

      // CHOKE (edge:'gate'): damp WHILE high; recover on release. Applied
      // post-ceiling to BOTH channels — damp × bounded stays bounded.
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

registerProcessor('snaredrum', SnaredrumProcessor);
