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
// Reproduces the sequencer's internal-clock semantics EXACTLY (sequencer.ts
// emitStep + 714-755):
//   • step duration = 60/bpm/4  (a 16th-note step)
//   • swing: on-beat (even) steps lengthen ×(1 + swing/2), off-beat (odd) steps
//     shorten ×(1 - swing/2)  — pushes every off-beat later
//   • gate: high for stepDur × gateLength from the step's start, else low
//   • POLY pitch: each step's mono/maj/min chord → 5 V/oct lanes via
//     chordLanesVOct (seq-voicing.ts, the ported poly.ts voicing), octave folded in
//   • mono gate: high while ANY lane is gated (the sequencer's `gate` output)
//   • clock: a short pulse at every step boundary (the `clock` chain output)
//   • sample & hold: snh on (default) rewrites lane pitch only on a step that
//     FIRES (anyGate); snh off rewrites every step
//   • length: active steps clamped to [1, SEQ_MAX_STEPS]; index wraps at length
//
// PURE + deterministic (no RNG / wall-clock / Web Audio API) so vitest can pin
// every boundary. The worklet imports + runs THIS code — no mirror, no drift.

import {
  chordLanesVOct,
  midiToVOct,
  SEQ_POLY_LANES,
  type SeqChordQuality,
  type VoiceLaneVOct,
} from './seq-voicing';

export { SEQ_POLY_LANES, midiToVOct, type SeqChordQuality };

/** A single sequencer step. `chord` defaults to 'mono'. */
export interface SeqStep {
  on: boolean;
  midi: number | null;
  chord?: SeqChordQuality;
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
  /** 'internal' (default) → the engine advances on its own BPM phase.
   *  'external' → the engine holds phase and advances ONLY on externalTrigger()
   *  (one step per incoming clock edge). The gate width still derives from BPM. */
  clockMode: 'internal' | 'external';
}

/** What a block of process() / an external trigger advanced — so the host's
 *  shadow engine can mirror playhead + quicksave-on-wrap without re-deriving it. */
export interface SeqAdvance {
  /** Step boundaries crossed this block. */
  advances: number;
  /** Of those, how many wrapped the index back to 0 (sequence ends). */
  wraps: number;
}

/** The poly + gate + clock output buffers the engine fills each block. */
export interface SeqClockOut {
  /** Per-lane pitch (V/oct), length SEQ_POLY_LANES. */
  lanePitch: Float32Array[];
  /** Per-lane gate (0|1), length SEQ_POLY_LANES. */
  laneGate: Float32Array[];
  /** Mono gate: high while ANY lane is gated. */
  gate: Float32Array;
  /** Clock pulse: a short high pulse at each step boundary. */
  clock: Float32Array;
}

/** Hard cap on steps — MUST equal the sequencer's STEP_COUNT (8 pages × 16 = 128).
 *  clampLength() caps `length` at this, so a smaller value would silently
 *  TRUNCATE long patterns (a 32-step sequence would wrap at 16) once the worklet
 *  drives the audio. Guarded by the length-32 core test. */
export const SEQ_MAX_STEPS = 128;

/** MIDI note that maps to 0 V/oct (C4), the sequencer's pitch-CV reference. */
export const SEQ_C4_MIDI = 60;

/** Clock-pulse width in seconds (sequencer.ts emits clock 1 then 0 after 10 ms). */
export const SEQ_CLOCK_PULSE_S = 0.01;

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
  clockMode: 'internal',
};

/**
 * Sample-accurate POLY sequencer step engine. Drive it from an AudioWorklet's
 * `process()` (or a test loop) via `process(out, frames)`.
 */
export class SeqClockCore {
  readonly sampleRate: number;

  private cfg: SeqClockConfig = { ...DEFAULT_CONFIG };
  private stepIndex = 0;
  private tInStep = 0; // seconds elapsed within the current step
  private wasRunning = false;
  // External mode: true means "the next externalTrigger sounds the CURRENT index
  // (step 0) WITHOUT first advancing" — so the first incoming edge plays step 0,
  // the second plays step 1, … (matches the legacy external-clock emitStep order).
  private extArmed = true;

  // Per-lane HELD pitch (V/oct) — survives rests under S&H.
  private heldLanePitch = new Float32Array(SEQ_POLY_LANES);
  // Per-lane gate for the CURRENT step (the gate still closes on a rest).
  private curLaneGate = new Uint8Array(SEQ_POLY_LANES);

  // Latched state for the CURRENT step (recomputed on each step boundary +
  // whenever config changes, so live bpm/swing/gate edits take effect smoothly).
  private curStepDur = stepDurationSeconds(120, 0, 0);
  private curAnyGate = false;
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
    this.extArmed = true;
    // External mode: hold step 0 SILENT (gate + clock low, pitch held) until the
    // first incoming clock edge. Park the phase past the gate/clock envelope.
    if (this.cfg.clockMode === 'external') this.tInStep = this.curStepDur;
  }

  /** External clock edge: sound the next step (the first edge after a reset
   *  sounds step 0). Restarts the gate/clock envelope for the sounded step.
   *  Returns whether the index wrapped back to 0 (a sequence end). */
  externalTrigger(): { wrapped: boolean } {
    let wrapped = false;
    if (this.extArmed) {
      this.extArmed = false; // first edge sounds the current index (step 0)
    } else {
      const len = clampLength(this.cfg.length, this.cfg.steps.length);
      this.stepIndex = (this.stepIndex + 1) % len;
      wrapped = this.stepIndex === 0;
    }
    this.tInStep = 0;
    this.latchStep();
    return { wrapped };
  }

  get currentStep(): number {
    return this.stepIndex;
  }
  /** Held V/oct for a given lane (0..SEQ_POLY_LANES-1) — for tests + host reads. */
  lanePitch(lane: number): number {
    return this.heldLanePitch[lane] ?? 0;
  }
  /** Step-level: is ANY lane gated on the current step? (Mirrors the legacy
   *  read('gateValue') = lastEmittedGate, which is step-level not instantaneous.) */
  currentGated(): boolean {
    return this.curAnyGate;
  }
  /** Step-level gate for one lane (mirrors read('gateLane:i')). */
  currentLaneGated(lane: number): boolean {
    return this.curLaneGate[lane] === 1;
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
  // new held lane pitches. Called on every step boundary + on reset.
  private latchStep(): void {
    const { steps, snh, octave } = this.cfg;
    const step = steps[this.stepIndex];
    const hasNote = !!step && step.on && step.midi !== null;
    const quality: SeqChordQuality = step?.chord ?? 'mono';
    const lanes: VoiceLaneVOct[] = chordLanesVOct(hasNote ? (step!.midi as number) : null, quality, octave);
    const anyGate = lanes.some((l) => l.gate === 1);
    // shouldWritePitch: snh ON → only on a firing step; snh OFF → every step.
    const writePitch = snh ? anyGate : true;
    for (let l = 0; l < SEQ_POLY_LANES; l++) {
      const lane = lanes[l] ?? { pitch: 0, gate: 0 };
      this.curLaneGate[l] = lane.gate;
      if (writePitch) this.heldLanePitch[l] = lane.pitch;
    }
    this.curAnyGate = anyGate;
    this.relatch();
  }

  /** Render `frames` samples of poly pitch + per-lane gate + mono gate + clock.
   *  Returns how many step boundaries (and wraps) were crossed — internal mode
   *  only; external mode advances via externalTrigger() and returns zeros. */
  process(out: SeqClockOut, frames: number): SeqAdvance {
    // Transport edge: a fresh start restarts from step 0.
    if (this.cfg.running && !this.wasRunning) this.reset();
    this.wasRunning = this.cfg.running;

    const { lanePitch, laneGate, gate, clock } = out;
    const n = Math.min(frames, gate.length, clock.length);

    if (!this.cfg.running) {
      // Stopped: hold lane pitches, all gates + clock low, phase frozen.
      for (let i = 0; i < n; i++) {
        for (let l = 0; l < SEQ_POLY_LANES; l++) {
          lanePitch[l]![i] = this.heldLanePitch[l]!;
          laneGate[l]![i] = 0;
        }
        gate[i] = 0;
        clock[i] = 0;
      }
      return { advances: 0, wraps: 0 };
    }

    const external = this.cfg.clockMode === 'external';
    const dt = 1 / this.sampleRate;
    let advances = 0;
    let wraps = 0;
    for (let i = 0; i < n; i++) {
      const gateHi = this.tInStep < this.curGateOff;
      for (let l = 0; l < SEQ_POLY_LANES; l++) {
        lanePitch[l]![i] = this.heldLanePitch[l]!;
        laneGate[l]![i] = this.curLaneGate[l] && gateHi ? 1 : 0;
      }
      gate[i] = this.curAnyGate && gateHi ? 1 : 0;
      clock[i] = this.tInStep < SEQ_CLOCK_PULSE_S ? 1 : 0;

      this.tInStep += dt;
      // EXTERNAL mode: phase only plays out the current step's envelope; the
      // index advances solely on externalTrigger(), never on a phase boundary.
      if (external) continue;
      // Advance across as many step boundaries as this sample crossed (guards a
      // degenerate near-zero stepDur from a runaway bpm so we can't infinite-loop).
      let guard = 0;
      while (this.tInStep >= this.curStepDur && guard < SEQ_MAX_STEPS + 1) {
        this.tInStep -= this.curStepDur;
        const len = clampLength(this.cfg.length, this.cfg.steps.length);
        this.stepIndex = (this.stepIndex + 1) % len;
        if (this.stepIndex === 0) wraps++;
        this.latchStep();
        advances++;
        guard++;
      }
    }
    return { advances, wraps };
  }
}
