// packages/dsp/src/lib/seq-clock-core.ts
//
// SEQ-CLOCK CORE — the sequencer's INTERNAL-clock step engine, extracted as a
// pure, sample-accurate core so it can run inside an AudioWorklet (../seq-clock.ts)
// instead of a main-thread setTimeout/lookahead loop.
//
// WHY: the sequencer currently refills a 200 ms audio lookahead from a
// main-thread `tick()` (sequencer.ts). When a canvas drag pins the main thread
// for the whole gesture, the lookahead drains and steps are DROPPED → audible
// tempo freeze (see .myrobots/plans/clock-drag-jank-analysis-2026-06-29.md). An
// AudioWorklet runs on the audio thread, immune to main-thread jank, so a step
// engine that lives there can never be starved by a drag. AudioParam scheduling
// is main-thread-only, which is exactly why the engine must move INTO the worklet
// rather than just emitting ticks from a Worker.
//
// This core reproduces the sequencer's internal-clock musical semantics EXACTLY
// (sequencer.ts:714-755 + emitStep):
//   • step duration = 60/bpm/4  (a 16th-note step)
//   • swing: on-beat (even) steps lengthen ×(1 + swing/2), off-beat (odd) steps
//     shorten ×(1 - swing/2)  — pushes every off-beat later
//   • gate: high for stepDur × gateLength from the step's start, else low
//   • pitch: V/oct = (midi - 60)/12 + octave   (C4=60 ⇒ 0 V; +1 V per octave)
//   • sample & hold: snh on (default) rewrites pitch only on a step that FIRES a
//     note and holds it through rests; snh off lets a firing step rewrite it
//     (a rest carries no note value, so the held pitch is kept either way)
//   • length: active steps clamped to [1, SEQ_MAX_STEPS]; index wraps at length
//
// MONO pilot: this core emits the ROOT note + a single gate (the spine that makes
// timing immune to drag). Poly/chord lanes are layered on at wire-up time
// (PR-B), where ART pins the audio against the current sequencer output.
//
// PURE + deterministic (no RNG, no wall-clock, no Web Audio API) so vitest can
// pin every boundary. The worklet imports + runs THIS code — no mirror, no drift.

/** A single sequencer step: gated on/off + an optional MIDI note (null = rest). */
export interface SeqStep {
  on: boolean;
  midi: number | null;
}

/** Live config pushed to the engine on edit (NOT per audio block). */
export interface SeqClockConfig {
  bpm: number;
  length: number;
  steps: SeqStep[];
  gateLength: number;
  swing: number;
  octave: number;
  snh: boolean;
  running: boolean;
}

/** Hard cap on steps — mirrors the sequencer's STEP_COUNT. */
export const SEQ_MAX_STEPS = 16;

/** MIDI note that maps to 0 V/oct (C4), the sequencer's pitch-CV reference. */
export const SEQ_C4_MIDI = 60;

/** MIDI note → V/oct (1 V per octave; C4=60 ⇒ 0 V). */
export function midiToVoct(midi: number): number {
  return (midi - SEQ_C4_MIDI) / 12;
}

/** Seconds a given step lasts at `bpm`, with `swing` applied by step parity.
 *  16th-note base; even (on-beat) steps lengthen, odd (off-beat) steps shorten —
 *  identical to sequencer.ts:722-724. */
export function stepDurationSeconds(bpm: number, stepIndex: number, swing: number): number {
  const safeBpm = bpm > 0 ? bpm : 1;
  const base = 60 / safeBpm / 4;
  const sw = swing < 0 ? 0 : swing > 0.75 ? 0.75 : swing;
  const odd = (stepIndex & 1) === 1;
  return odd ? base * (1 - sw * 0.5) : base * (1 + sw * 0.5);
}

function clampLength(length: number, stepsLen: number): number {
  const cap = Math.min(SEQ_MAX_STEPS, stepsLen > 0 ? stepsLen : SEQ_MAX_STEPS);
  const n = Math.round(length);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n > cap ? cap : n;
}

const DEFAULT_CONFIG: SeqClockConfig = {
  bpm: 120,
  length: 16,
  steps: [],
  gateLength: 0.5,
  swing: 0,
  octave: 0,
  snh: true,
  running: false,
};

/**
 * Sample-accurate sequencer step engine. Drive it from an AudioWorklet's
 * `process()` (or a test loop) via `process(pitchOut, gateOut, frames)`.
 *
 * Output per sample: pitch (V/oct, held) on `pitchOut`, gate (0|1) on `gateOut`.
 */
export class SeqClockCore {
  readonly sampleRate: number;

  private cfg: SeqClockConfig = { ...DEFAULT_CONFIG };
  private stepIndex = 0;
  private tInStep = 0; // seconds elapsed within the current step
  private heldPitch = 0; // last written V/oct
  private wasRunning = false;

  // Latched state for the CURRENT step (recomputed on each step boundary +
  // whenever config changes, so live bpm/swing/gate edits take effect smoothly).
  private curStepDur = stepDurationSeconds(120, 0, 0);
  private curGateActive = false;
  private curGateOff = this.curStepDur * 0.5;

  constructor(sampleRate: number, cfg?: Partial<SeqClockConfig>) {
    this.sampleRate = sampleRate > 0 ? sampleRate : 48000;
    if (cfg) this.setConfig(cfg);
    this.latchStep();
  }

  /** Push new live config. Re-derives the current step's duration/gate so a live
   *  bpm/swing/gateLength edit applies immediately; clamps the index into the
   *  (possibly changed) active length. */
  setConfig(cfg: Partial<SeqClockConfig>): void {
    this.cfg = { ...this.cfg, ...cfg };
    const len = clampLength(this.cfg.length, this.cfg.steps.length);
    if (this.stepIndex >= len) this.stepIndex = this.stepIndex % len;
    this.relatch();
  }

  /** Restart from step 0 (transport start / pattern restart). */
  reset(): void {
    this.stepIndex = 0;
    this.tInStep = 0;
    this.latchStep();
  }

  get currentStep(): number {
    return this.stepIndex;
  }
  get currentPitch(): number {
    return this.heldPitch;
  }

  // Recompute the latched dur/gate for the current step WITHOUT re-evaluating the
  // note/pitch (used on a live config change mid-step).
  private relatch(): void {
    this.curStepDur = stepDurationSeconds(this.cfg.bpm, this.stepIndex, this.cfg.swing);
    const gl = this.cfg.gateLength;
    const glClamped = gl < 0.01 ? 0.01 : gl > 0.99 ? 0.99 : gl;
    this.curGateOff = this.curStepDur * glClamped;
  }

  // Evaluate the current step: latch its duration/gate AND (per S&H) maybe write
  // a new held pitch. Called on every step boundary + on reset.
  private latchStep(): void {
    const { steps, snh, octave } = this.cfg;
    const step = steps[this.stepIndex];
    const hasNote = !!step && step.on && step.midi !== null;
    // shouldWritePitch: snh ON → only on a firing step; snh OFF → every step.
    const writePitch = snh ? hasNote : true;
    if (writePitch && hasNote && step) {
      this.heldPitch = midiToVoct(step.midi as number) + octave;
    }
    this.curGateActive = hasNote;
    this.relatch();
  }

  /** Render `frames` samples of pitch (V/oct) + gate (0|1). */
  process(pitchOut: Float32Array, gateOut: Float32Array, frames: number): void {
    // Transport edge: a fresh start restarts from step 0.
    if (this.cfg.running && !this.wasRunning) this.reset();
    this.wasRunning = this.cfg.running;

    const n = Math.min(frames, pitchOut.length, gateOut.length);

    if (!this.cfg.running) {
      // Stopped: hold the last pitch, gate closed, phase frozen.
      for (let i = 0; i < n; i++) {
        pitchOut[i] = this.heldPitch;
        gateOut[i] = 0;
      }
      return;
    }

    const dt = 1 / this.sampleRate;
    for (let i = 0; i < n; i++) {
      gateOut[i] = this.curGateActive && this.tInStep < this.curGateOff ? 1 : 0;
      pitchOut[i] = this.heldPitch;

      this.tInStep += dt;
      // Advance across as many step boundaries as this sample crossed (guards a
      // degenerate near-zero stepDur from a runaway bpm so we can't infinite-loop).
      let guard = 0;
      while (this.tInStep >= this.curStepDur && guard < SEQ_MAX_STEPS + 1) {
        this.tInStep -= this.curStepDur;
        const len = clampLength(this.cfg.length, this.cfg.steps.length);
        this.stepIndex = (this.stepIndex + 1) % len;
        this.latchStep();
        guard++;
      }
    }
  }
}
