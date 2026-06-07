// packages/dsp/src/polyhelm.ts
//
// POLYHELM — HELM with a polyphonic (poly bus) input.
//
// POLYHELM is the HELM polyphonic subtractive synth (algorithm port of Matt
// Tytel's Helm, GPL-3.0; this port AGPL-3.0-or-later) that ALSO accepts the
// project's 10-channel `polyPitchGate` poly bus (5 lanes of pitch+gate) from
// MIDI LANE / POLYSEQZ / a chord sequencer, feeding HELM's existing voice
// allocator. This is the DX7 pattern (dx7.ts): per-lane gate-edge detection
// drives note-on/note-off into the allocator at the lane's pitch, and the
// lane's pitch is tracked while the gate stays high.
//
// The full HELM synth engine (oscillators / SVF filter / 3 ADSRs / 2 LFOs /
// step sequencer / voice allocator) lives in lib/helm-engine.ts — shared so we
// don't duplicate ~500 LOC. helm.ts stays untouched + byte-identical (its own
// inline engine), the same way lib/adsr-env.ts is a verbatim copy of helm's
// Envelope used by the newer poly modules.
//
// GPL-3.0 lineage NOTE: see lib/helm-engine.ts header — relevant to a native
// port's GPL firewall.
//
// Inputs (numberOfInputs = 5):
//   0  poly       — 10-channel polyPitchGate (lane i → ch 2i pitch, ch 2i+1 gate).
//                   PREFERRED polyphonic input. Each lane drives one voice via
//                   the allocator; held-pitch-through-release is correct because
//                   a released voice keeps its stored v.midi (DX7 pattern).
//   1  pitch_cv   — mono V/oct fallback (single-voice, lane-0 semantics).
//   2  gate       — mono gate fallback.
//   3  midi_in    — no-op marker port (MIDI flows via the Web MIDI API + the
//                   message port, not a cable — same as helm.ts).
//   4  seq_reset  — rising edge resets the internal step sequencer.
//
// Outputs (numberOfOutputs = 1, 2 channels):
//   out_l / out_r — stereo mixed voices.
//
// MIDI (message port, same protocol as helm.ts): note-on / note-off / all-off
// from the main-thread Web MIDI handler, plus set-steps / set-seq-on / seq-reset
// for the card's sequencer transport. MIDI notes use the laneOwner=-1 (non-poly)
// allocator path so MIDI + a poly cable can coexist.

import {
  HelmEngine,
  helmParameterDescriptors,
  readHelmParams,
} from './lib/helm-engine';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  process?(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}
declare function registerProcessor(
  name: string,
  ctor: typeof AudioWorkletProcessor
): void;

const POLY_LANES = 5;

// ---------------- Message protocol (host → worklet) — mirrors helm.ts ----------------

interface NoteOnMsg { type: 'note-on'; note: number; velocity: number; channel?: number; }
interface NoteOffMsg { type: 'note-off'; note: number; channel?: number; }
interface AllOffMsg { type: 'all-off'; }
interface SetStepsMsg { type: 'set-steps'; steps: number[]; }
interface SetSeqOnMsg { type: 'set-seq-on'; on: boolean; }
interface SeqResetMsg { type: 'seq-reset'; }
type HostMsg = NoteOnMsg | NoteOffMsg | AllOffMsg | SetStepsMsg | SetSeqOnMsg | SeqResetMsg;

class PolyHelmProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return helmParameterDescriptors();
  }

  private engine = new HelmEngine();

  /** Per-lane gate edge state for the poly bus (rising/falling detection). */
  private laneGatePrev = new Float32Array(POLY_LANES);
  /** Mono CV-fallback gate edge state + last-pitch (lane-0 semantics). */
  private monoGateHigh = false;
  private monoPitchVOct = 0;
  /** Last posted step (so we only emit step-tick on change). */
  private lastPostedStep = -2;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.port.onmessage = (e: MessageEvent<HostMsg>) => {
      const m = e.data;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'note-on') this.engine.handleNoteOn(m.note, m.velocity, m.channel ?? 0);
      else if (m.type === 'note-off') this.engine.handleNoteOff(m.note);
      else if (m.type === 'all-off') this.engine.allOff();
      else if (m.type === 'set-steps') this.engine.setSteps(m.steps);
      else if (m.type === 'set-seq-on') { this.engine.setSeqOn(m.on); this.postStepTick(true); }
      else if (m.type === 'seq-reset') { this.engine.resetSeq(); this.postStepTick(true); }
    };
  }

  private postStepTick(force: boolean): void {
    const step = this.engine.seq.currentStep;
    if (!force && this.lastPostedStep === step) return;
    this.lastPostedStep = step;
    try {
      this.port.postMessage({ type: 'step-tick', step });
    } catch {
      // Port may have closed during dispose — swallow.
    }
  }

  /** V/oct (0V = C4 = MIDI 60) → MIDI note number (rounded). */
  private static voctToMidi(voct: number): number {
    return Math.round(60 + voct * 12);
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const outL = outputs[0]?.[0];
    const outR = outputs[0]?.[1] ?? outL;
    if (!outL || !outR) return true;

    const sr = sampleRate;
    const p = readHelmParams(parameters);

    // ---------------- Inputs ----------------
    const polyIn = inputs[0];          // 10ch: (p0,g0, p1,g1, ..., p4,g4)
    const pitchIn = inputs[1]?.[0];    // mono V/oct fallback
    const gateIn = inputs[2]?.[0];     // mono gate fallback
    // inputs[3] is midi_in (no-op marker — see header).
    const seqResetIn = inputs[4]?.[0]; // dedicated seq_reset

    // ---------------- Poly bus: per-lane gate-edge detection ----------------
    //
    // Block-rate decision (first sample of the block) — matches DX7 + the
    // project's sequencer semantics (setValueAtTime writes at block
    // boundaries, so per-block sampling is exact for the sequencer case).
    if (polyIn) {
      for (let lane = 0; lane < POLY_LANES; lane++) {
        const pitchCh = polyIn[lane * 2];
        const gateCh = polyIn[lane * 2 + 1];
        const pitchVOct = pitchCh?.[0] ?? 0;
        const gateVal = gateCh?.[0] ?? 0;
        const midi = PolyHelmProcessor.voctToMidi(pitchVOct);

        const wasGate = this.laneGatePrev[lane]! > 0.5;
        const isGate = gateVal > 0.5;
        if (isGate && !wasGate) {
          // Rising edge — note-on at the lane's pitch (velocity full).
          this.engine.noteOnLane(lane, midi, 1.0);
        } else if (!isGate && wasGate) {
          // Falling edge — note-off (release; v.midi preserved → held-pitch
          // through the release tail, the DX7 pattern).
          this.engine.noteOffLane(lane);
        } else if (isGate) {
          // Gate held — track live pitch (pitch glide / bend while held).
          this.engine.updateLanePitch(lane, midi);
        }
        this.laneGatePrev[lane] = gateVal;
      }
    }

    // ---------------- Mono CV/gate fallback (lane-0 semantics) ----------------
    //
    // Only honored if a mono gate cable is connected. Uses the non-poly
    // (laneOwner=-1) allocator path so it coexists with MIDI + the poly bus.
    if (gateIn) {
      const gateHigh = (gateIn[0] ?? 0) > 0.5;
      const pitchV = pitchIn?.[0] ?? 0;
      if (gateHigh && !this.monoGateHigh) {
        this.engine.handleNoteOn(PolyHelmProcessor.voctToMidi(pitchV), 100, 0);
        this.monoPitchVOct = pitchV;
      } else if (!gateHigh && this.monoGateHigh) {
        this.engine.handleNoteOff(PolyHelmProcessor.voctToMidi(this.monoPitchVOct));
      }
      this.monoGateHigh = gateHigh;
    }

    // ---------------- Sequencer edges ----------------
    const cvGateHigh = gateIn ? (gateIn[0] ?? 0) > 0.5 : false;
    const seqResetHigh = seqResetIn ? (seqResetIn[0] ?? 0) > 0.5 : false;
    this.engine.tickSequencerEdges(cvGateHigh, seqResetHigh, p.stepNumSteps);
    this.postStepTick(false);

    // ---------------- Render ----------------
    return this.engine.renderBlock(outL, outR, p, sr);
  }
}

registerProcessor('polyhelm', PolyHelmProcessor);
