// packages/dsp/src/moog911.ts
//
// MOOG 911 ENVELOPE GENERATOR — Moog System 55/35 contour generator
// AudioWorkletProcessor.
//
// Slice 3 of the Moog System 55 / 35 clone initiative (.myrobots/MOOG/),
// after the 921 VCO (slice 1). The 911 ships in both systems (S35 ×3,
// S55 ×6) so it's categorized under Moog → SYS55 (the shared bucket).
//
// This is NOT a literal A-D-S-R. The real 911 is a THREE-time-constant
// CONTOUR generator with a single sustain LEVEL:
//
//   T1   — ATTACK time: rise from 0 to the PEAK (1.0) on gate open.
//   T2   — INITIAL DECAY time: fall from the peak down to ESUS.
//   Esus — SUSTAIN LEVEL (0..1): held while the gate stays high.
//   T3   — FINAL DECAY time: fall from the current value back to 0 on
//          gate close. Trigger-close forces the T3 stage REGARDLESS of
//          which stage was active (so a short trigger that releases mid-
//          attack still decays over T3 from wherever it had risen to).
//
// Stage diagram (gate high ───, gate low ___):
//
//   1.0 ┤        ╭─╮
//       │       ╱   ╲___________            ← peak, then T2 decay to Esus
//  Esus ┤      ╱                ╲           ← held at Esus while gated
//       │     ╱  T1   T2         ╲  T3
//   0.0 ┤────╯────────────────────╲_____    ← T3 final decay on release
//       └────┬────────────────────┬─────
//          gate↑                 gate↓
//
// DSP is OWN CODE — a clean-room exponential-segment contour generator,
// NOT a port of any Moog schematic / copyleft source
// (.myrobots/MOOG/LICENSING.md: permissive / own-code only). It is loosely
// modelled on the repo's `adsr` scaffolding (gate-driven, unipolar 0..1,
// +inverted tap) but implements the 911's T1→peak / T2→Esus / T3 contour
// rather than the four-stage ADSR shape.
//
// IMPORTANT: this file does NOT `export` anything at the top level —
// top-level exports leak into the bundled dist/<name>.js + break the ART
// classic-script eval. The Processor class is registered via the
// `registerProcessor` side-effect; tests capture it through a
// registerProcessor shim before importing. (memory:
// dsp-worklet-no-top-level-export)
//
// Inputs (audio-rate node connections):
//   inputs[0] = gate  (S-trigger; >= 0.5 = gate high / contour running,
//                      < 0.5 = gate low / final decay)
//
// AudioParams (CV is summed in by the web factory as a-rate signals):
//   t1   (attack time, seconds — log range)
//   t2   (initial-decay time, seconds — log range)
//   esus (sustain level, 0..1 — linear)
//   t3   (final-decay time, seconds — log range)
//
// Outputs (each mono):
//   outputs[0] = env      (the contour, 0..1)
//   outputs[1] = env_inv  (1 - env — inverted tap for ducking / sidechain)

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
// captures the class via this shim — see moog911 DSP test loader).
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

// Contour stages.
const STAGE_IDLE = 0; // gate low, env at rest (0)
const STAGE_ATTACK = 1; // rising 0 → 1 over T1
const STAGE_DECAY = 2; // falling 1 → Esus over T2
const STAGE_SUSTAIN = 3; // holding Esus while gated
const STAGE_RELEASE = 4; // falling current → 0 over T3 (gate low)

// Gate is treated as high at >= 0.5 (S-trigger / unipolar gate convention,
// matching the rest of the registry's gate sources e.g. SEQUENCER.gate).
const GATE_THRESHOLD = 0.5;

// Exponential one-pole segment "tau scale": choosing the per-sample
// coefficient so the segment covers ~99% of its span in the configured
// time constant (5 time-constants of an RC ≈ 99.3%). This gives the
// classic Moog rounded-exponential contour rather than a linear ramp.
const TAU_DECADES = 5;

// Smallest meaningful stage time (seconds). Below this, snap instantly so a
// near-zero T-knob doesn't divide-by-zero or stall.
const MIN_TIME_S = 1e-4;

// Not `export`ed at the top level by design — see the file-header note.
class Moog911Processor extends AudioWorkletProcessor {
  private sr: number;
  private stage: number;
  private level: number; // current envelope value (0..1)
  private prevGate: boolean;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.sr = sampleRate;
    this.stage = STAGE_IDLE;
    this.level = 0;
    this.prevGate = false;
  }

  static get parameterDescriptors() {
    return [
      // T1 — ATTACK time. Up to 10 s per the 911 spec.
      { name: 't1', defaultValue: 0.01, minValue: MIN_TIME_S, maxValue: 10, automationRate: 'a-rate' as const },
      // T2 — INITIAL DECAY time. ~2 ms minimum .. 10 s.
      { name: 't2', defaultValue: 0.2, minValue: MIN_TIME_S, maxValue: 10, automationRate: 'a-rate' as const },
      // Esus — SUSTAIN LEVEL (0..1).
      { name: 'esus', defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      // T3 — FINAL DECAY time. Up to 10 s.
      { name: 't3', defaultValue: 0.4, minValue: MIN_TIME_S, maxValue: 10, automationRate: 'a-rate' as const },
    ];
  }

  /**
   * Per-sample coefficient for an exponential approach toward a target over
   * `timeS` seconds (covers ~99% of the span within timeS). Clamped so a
   * near-zero time snaps instantly (coeff → 1).
   */
  private coeff(timeS: number): number {
    if (timeS <= MIN_TIME_S) return 1;
    const samples = timeS * this.sr;
    // exp(-decades / samples): after `samples` steps, residual ≈ e^-5 ≈ 0.7%.
    return 1 - Math.exp(-TAU_DECADES / samples);
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const envOut = outputs[0]?.[0];
    const invOut = outputs[1]?.[0];
    // No output buffers wired this block — nothing to do, but keep alive.
    if (!envOut && !invOut) return true;

    const gateIn = inputs[0]?.[0];

    const t1Arr = parameters.t1;
    const t2Arr = parameters.t2;
    const esusArr = parameters.esus;
    const t3Arr = parameters.t3;

    const blockLen = (envOut ?? invOut)!.length;

    for (let i = 0; i < blockLen; i++) {
      const t1 = t1Arr.length > 1 ? t1Arr[i] : t1Arr[0];
      const t2 = t2Arr.length > 1 ? t2Arr[i] : t2Arr[0];
      let esus = esusArr.length > 1 ? esusArr[i] : esusArr[0];
      const t3 = t3Arr.length > 1 ? t3Arr[i] : t3Arr[0];
      if (esus < 0) esus = 0;
      else if (esus > 1) esus = 1;

      const gate = (gateIn ? gateIn[i] : 0) >= GATE_THRESHOLD;

      // ── Edge detection ──
      if (gate && !this.prevGate) {
        // Rising edge → (re)start the contour at ATTACK.
        this.stage = STAGE_ATTACK;
      } else if (!gate && this.prevGate) {
        // Falling edge → force FINAL DECAY (T3) regardless of stage.
        this.stage = STAGE_RELEASE;
      }
      this.prevGate = gate;

      // ── Stage advance ──
      switch (this.stage) {
        case STAGE_ATTACK: {
          const c = this.coeff(t1);
          // Approach a slight overshoot target so we actually REACH 1.0
          // within T1 rather than asymptoting just under it.
          this.level += (1.0 - this.level) * c;
          if (this.level >= 0.999) {
            this.level = 1.0;
            this.stage = STAGE_DECAY;
          }
          break;
        }
        case STAGE_DECAY: {
          const c = this.coeff(t2);
          this.level += (esus - this.level) * c;
          if (Math.abs(this.level - esus) <= 1e-3) {
            this.level = esus;
            this.stage = STAGE_SUSTAIN;
          }
          break;
        }
        case STAGE_SUSTAIN:
          // Hold at Esus while the gate is high. Track Esus if the knob /
          // CV moves under us.
          this.level = esus;
          break;
        case STAGE_RELEASE: {
          const c = this.coeff(t3);
          this.level += (0 - this.level) * c;
          if (this.level <= 1e-4) {
            this.level = 0;
            this.stage = STAGE_IDLE;
          }
          break;
        }
        case STAGE_IDLE:
        default:
          this.level = 0;
          break;
      }

      if (envOut) envOut[i] = this.level;
      // Inverted tap: 1 - env (ducking / sidechain semantic, matching ADSR).
      if (invOut) invOut[i] = 1 - this.level;
    }

    return true;
  }
}

registerProcessor('moog911', Moog911Processor);
