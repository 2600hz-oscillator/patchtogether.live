// packages/web/src/lib/audio/modules/polyseqz.ts
//
// POLYSEQZ — polyphonic chord sequencer. Same step model as the Sequencer
// (32 steps, internal BPM or external clock) but every step holds a chord
// (root + quality + inversion + voicing) and the pitch output is a
// polyPitchGate cable carrying the full 5-voice chord per step.
//
// Why a separate module instead of expanding Sequencer? Sequencer's chord
// surface is intentionally minimal (mono | maj | min) so it stays a "pitch
// box" first. POLYSEQZ is built around chord-first thinking — the per-step UI
// shows note name + quality together, not as an afterthought. Persisted data
// shape is incompatible (chord lives at top of step, plus inversion + voicing)
// so a separate module + def avoids muddying the Sequencer's migration path.
//
// Output cable: polyPitchGate (5 lanes = root + 3rd + 5th + (octave or 7th) +
// (octave or 5th doubling)). Wires directly into RIOTGIRLS, DX7 (when it
// lands), or any module that consumes polyPitchGate. Backward-compat with
// mono pitch sinks: lane 0 (the root) is auto-routed by resolveConnection().
//
// HUMANIZE: each step's per-voice gate-on time gets a small random delay.
// Magnitude + distribution shape are functions of the humanize amount —
// pure math lives in $lib/audio/humanize.ts so the unit tests can exercise
// the distribution without spinning up an AudioContext.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import {
  coerceToNoteStep,
  C3_MIDI,
  midiToVOct,
} from '$lib/audio/note-entry';
import {
  POLY_CHANNEL_PAIRS,
  createPolySender,
} from '$lib/audio/poly';
import {
  type ChordQualityName,
  type ChordInversion,
  type ChordVoicingName,
  CHORD_QUALITY_NAMES,
  CHORD_VOICING_NAMES,
  chordToVoices,
  VOICE_LANES,
} from '$lib/audio/chord-tables';
import { sampleHumanizeOffsets } from '$lib/audio/humanize';

// ---------------- Step schema ----------------

export interface ChordStep {
  on: boolean;
  /** Root MIDI int (a4=69, c3=48). null = empty step. */
  root: number | null;
  /** Chord quality (default 'maj'). */
  quality: ChordQualityName;
  /** Inversion 0|1|2 (default 0). */
  inversion: ChordInversion;
  /** Voicing strategy (default 'closed'). */
  voicing: ChordVoicingName;
}

export const STEP_COUNT = 32;

export function defaultChordSteps(): ChordStep[] {
  return Array.from({ length: STEP_COUNT }, () => ({
    on: false,
    root: C3_MIDI,
    quality: 'maj' as ChordQualityName,
    inversion: 0 as ChordInversion,
    voicing: 'closed' as ChordVoicingName,
  }));
}

/** Coerce an arbitrary step-shape blob into a ChordStep. Used by the live
 *  reader (so half-typed Yjs writes don't crash the tick) and by the def
 *  migration. */
export function coerceToChordStep(raw: unknown): ChordStep {
  const base = coerceToNoteStep(raw); // gives us {on, midi}
  let quality: ChordQualityName = 'maj';
  let inversion: ChordInversion = 0;
  let voicing: ChordVoicingName = 'closed';
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (typeof r.quality === 'string' && (CHORD_QUALITY_NAMES as readonly string[]).includes(r.quality)) {
      quality = r.quality as ChordQualityName;
    }
    if (typeof r.inversion === 'number' && [0, 1, 2].includes(r.inversion)) {
      inversion = r.inversion as ChordInversion;
    }
    if (typeof r.voicing === 'string' && (CHORD_VOICING_NAMES as readonly string[]).includes(r.voicing)) {
      voicing = r.voicing as ChordVoicingName;
    }
    // POLYSEQZ persists `root` rather than `midi`; accept either for
    // forward-compat with possible re-uses.
    if (typeof r.root === 'number' || r.root === null) {
      // root is already canonical; keep base.midi as fallback.
    }
  }
  let root: number | null = base.midi;
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (typeof r.root === 'number' && Number.isFinite(r.root)) {
      root = Math.round(r.root as number);
    } else if (r.root === null) {
      root = null;
    }
  }
  return { on: base.on, root, quality, inversion, voicing };
}

// ---------------- Module def ----------------

export const polyseqzDef: AudioModuleDef = {
  type: 'polyseqz',
  domain: 'audio',
  label: 'POLYSEQZ',
  category: 'modulation',
  schemaVersion: 1,

  inputs: [
    // External clock (optional). When patched, advances on rising edges.
    { id: 'clock', type: 'gate' },
    // CV-controllable transport — drive isPlaying via a CV/gate signal.
    { id: 'play_cv',  type: 'cv', paramTarget: 'isPlaying' },
    // Reset CV: rising edge resets stepIndex to 0 next tick.
    { id: 'reset_cv', type: 'gate' },
    // CV → humanize amount (0..1).
    { id: 'humanize_cv', type: 'cv', paramTarget: 'humanize' },
  ],
  outputs: [
    { id: 'poly',  type: 'polyPitchGate' },
    // Convenience mono gate (high while ANY voice's gate is high). Lets
    // POLYSEQZ trigger per-step ADSR / scope-trigger / etc. without
    // unwrapping the polyPitchGate cable.
    { id: 'gate',  type: 'gate' },
    // Per-step clock pulse (10ms high) emitted on every advance.
    { id: 'clock', type: 'gate' },
  ],

  params: [
    { id: 'bpm',        label: 'BPM',  defaultValue: 90,  min: 30,  max: 300,  curve: 'linear' },
    { id: 'length',     label: 'Len',  defaultValue: 8,   min: 1,   max: 32,   curve: 'discrete' },
    { id: 'octave',     label: 'Oct',  defaultValue: 0,   min: -2,  max: 2,    curve: 'discrete' },
    { id: 'gateLength', label: 'Gate', defaultValue: 0.6, min: 0.1, max: 0.95, curve: 'linear' },
    { id: 'humanize',   label: 'Hum',  defaultValue: 0,   min: 0,   max: 1,    curve: 'linear' },
    { id: 'isPlaying',  label: 'Play', defaultValue: 0,   min: 0,   max: 1,    curve: 'discrete' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const polyPitch = createPolySender(ctx);
    const gateSrc = ctx.createConstantSource();
    const clockOutSrc = ctx.createConstantSource();
    gateSrc.offset.value = 0;
    clockOutSrc.offset.value = 0;
    gateSrc.start();
    clockOutSrc.start();

    // External-clock input.
    const clockInGain = ctx.createGain();
    const clockInAnalyser = ctx.createAnalyser();
    clockInAnalyser.fftSize = 2048;
    clockInGain.connect(clockInAnalyser);
    const clockInBuffer = new Float32Array(clockInAnalyser.fftSize);
    const clockInSilence = ctx.createConstantSource();
    clockInSilence.offset.value = 0;
    clockInSilence.start();
    clockInSilence.connect(clockInGain);

    // Reset-CV input — same analyser pattern as clock.
    const resetInGain = ctx.createGain();
    const resetInAnalyser = ctx.createAnalyser();
    resetInAnalyser.fftSize = 2048;
    resetInGain.connect(resetInAnalyser);
    const resetInBuffer = new Float32Array(resetInAnalyser.fftSize);
    const resetInSilence = ctx.createConstantSource();
    resetInSilence.offset.value = 0;
    resetInSilence.start();
    resetInSilence.connect(resetInGain);

    // play_cv + humanize_cv: declared as paramTarget inputs. The engine
    // connects an external CV signal into the AudioParam target. We back the
    // target with an internal ConstantSource — its offset receives the CV
    // sum and the tick polls the offset value via an analyser tap each
    // iteration. (We don't have a real AudioParam for `isPlaying`/`humanize`
    // because the param store is JS-side; this constant-source-as-AudioParam
    // gives the engine something to connect to and lets us read the live CV
    // value with an AnalyserNode.)
    function makeParamCV(initial: number): {
      param: AudioParam;
      pollValue: () => number;
      dispose: () => void;
    } {
      const target = ctx.createConstantSource();
      target.offset.value = initial;
      target.start();
      const ana = ctx.createAnalyser();
      ana.fftSize = 256;
      target.connect(ana);
      const buf = new Float32Array(ana.fftSize);
      return {
        param: target.offset,
        pollValue() {
          ana.getFloatTimeDomainData(buf);
          // Average the most recent samples for a stable read — anything
          // higher-rate happens at audio thread anyway, and downstream uses
          // (humanize amount, isPlaying threshold) are coarse-grained.
          let sum = 0;
          const N = Math.min(buf.length, 64);
          for (let i = buf.length - N; i < buf.length; i++) sum += buf[i] ?? 0;
          return sum / N;
        },
        dispose() {
          try { target.stop(); } catch { /* */ }
          try { target.disconnect(); } catch { /* */ }
          try { ana.disconnect(); } catch { /* */ }
        },
      };
    }
    const playCV = makeParamCV(0);
    const humanizeCV = makeParamCV(0);

    let lastClockSample = 0;
    let lastClockSampleTime = ctx.currentTime;
    let lastResetSample = 0;
    const CLOCK_THRESHOLD = 0.5;

    const nodeId = node.id;

    function emitClockPulse(atTime: number) {
      clockOutSrc.offset.setValueAtTime(1, atTime);
      clockOutSrc.offset.setValueAtTime(0, atTime + 0.01);
    }

    function isClockInConnected(): boolean {
      for (const edge of Object.values(livePatch.edges)) {
        if (!edge) continue;
        if (edge.target.nodeId === nodeId && edge.target.portId === 'clock') return true;
      }
      return false;
    }

    function readSteps(): ChordStep[] {
      const live = livePatch.nodes[nodeId];
      const steps = (live?.data as Record<string, unknown> | undefined)?.steps;
      if (Array.isArray(steps)) {
        return (steps as unknown[]).map(coerceToChordStep);
      }
      return defaultChordSteps();
    }
    function readParam(id: string, fallback: number): number {
      const live = livePatch.nodes[nodeId];
      const v = live?.params?.[id];
      const base = typeof v === 'number' ? v : fallback;
      // Fold in CV-modulated params: if a connection is driving humanize_cv
      // or play_cv, the constant-source offset's signal sums on top of the
      // base value. We only fold on params we actually publish as
      // paramTargets — everything else returns `base` verbatim.
      if (id === 'humanize') {
        const cv = humanizeCV.pollValue();
        const sum = base + cv;
        return sum < 0 ? 0 : sum > 1 ? 1 : sum;
      }
      if (id === 'isPlaying') {
        const cv = playCV.pollValue();
        return base + cv;
      }
      return base;
    }

    // Live state
    let stepIndex = 0;
    let nextStepTime = ctx.currentTime + 0.05;
    let prevPlaying = false;
    let alive = true;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const LOOKAHEAD_S = 0.1;
    const TICK_MS = 25;

    // Tracking for tests / introspection.
    let lastEmittedVOct = 0;
    let lastEmittedGate = 0;
    const lastEmittedLaneVOct = new Array<number>(POLY_CHANNEL_PAIRS).fill(0);
    const lastEmittedLaneGate = new Array<number>(POLY_CHANNEL_PAIRS).fill(0);
    const lastHumanizeOffsets = new Array<number>(POLY_CHANNEL_PAIRS).fill(0);
    let currentStep = 0;
    let totalAdvances = 0;

    /** Schedule one step's chord at the given audio time. Per-voice gate-on
     *  is offset by an independent random sample from the humanize
     *  distribution (clamped so it never tries to schedule in the past). */
    function emitStep(idx: number, atTime: number, stepDurForGate: number) {
      const octave = readParam('octave', 0);
      const gateLengthFrac = readParam('gateLength', 0.5);
      const humanize = readParam('humanize', 0);
      const steps = readSteps();
      const step = steps[idx];
      // Step clock pulse (chain-out signal) always fires on advance.
      emitClockPulse(atTime);

      const root = step && step.on && step.root !== null ? step.root : null;
      const voices = chordToVoices(
        root,
        step?.quality ?? 'maj',
        step?.inversion ?? 0,
        step?.voicing ?? 'closed',
      );

      const gateOffWindow = stepDurForGate * gateLengthFrac;

      const offsets = sampleHumanizeOffsets(humanize, POLY_CHANNEL_PAIRS);
      // Mirror for tests/UI.
      for (let i = 0; i < POLY_CHANNEL_PAIRS; i++) {
        lastHumanizeOffsets[i] = offsets[i] ?? 0;
      }

      let anyGate = false;
      for (let i = 0; i < POLY_CHANNEL_PAIRS; i++) {
        const lane = voices[i] ?? { midi: null, gate: 0 as 0 | 1 };
        const polyVoice = polyPitch.voices[i]!;
        if (lane.gate === 1 && lane.midi !== null) {
          // Apply octave param after chord math.
          const vOct = midiToVOct(lane.midi) + octave;
          // Clamp the per-voice fire time to "now or future" — Web Audio
          // accepts setValueAtTime in the near past silently but anything
          // earlier than ctx.currentTime - 0.1s can drop the event.
          const offset = offsets[i] ?? 0;
          const fireAt = Math.max(ctx.currentTime + 0.001, atTime + offset);
          // Set pitch slightly BEFORE the gate-on so the receiver sees a
          // stable V/oct at the moment the gate rises — matters for
          // single-cycle envelope triggers.
          polyVoice.pitchSrc.offset.setValueAtTime(vOct, fireAt - 0.001 < ctx.currentTime ? ctx.currentTime : fireAt - 0.001);
          polyVoice.gateSrc.offset.setValueAtTime(1, fireAt);
          polyVoice.gateSrc.offset.setValueAtTime(0, fireAt + gateOffWindow);
          lastEmittedLaneVOct[i] = vOct;
          lastEmittedLaneGate[i] = 1;
          anyGate = true;
          if (i === 0) lastEmittedVOct = vOct;
        } else {
          // Hold the lane silent. We do NOT touch pitchSrc — the previous
          // step's pitch lingers harmlessly behind a closed gate.
          polyVoice.gateSrc.offset.setValueAtTime(0, atTime);
          lastEmittedLaneGate[i] = 0;
        }
      }

      if (anyGate) {
        gateSrc.offset.setValueAtTime(1, atTime);
        gateSrc.offset.setValueAtTime(0, atTime + gateOffWindow);
        lastEmittedGate = 1;
      } else {
        // Empty step — leave gates low.
        lastEmittedGate = 0;
      }
    }

    function checkResetEdge(nowAt: number) {
      // Read the reset-CV analyser and bump stepIndex back to 0 on a rising
      // edge. We only inspect samples since last poll.
      resetInAnalyser.getFloatTimeDomainData(resetInBuffer);
      const elapsed = nowAt - lastClockSampleTime; // share the timing window
      const newSamples = Math.min(
        resetInBuffer.length,
        Math.max(1, Math.ceil(elapsed * ctx.sampleRate)),
      );
      const start = resetInBuffer.length - newSamples;
      let triggered = false;
      for (let i = start; i < resetInBuffer.length; i++) {
        const cur = resetInBuffer[i] ?? 0;
        if (lastResetSample < CLOCK_THRESHOLD && cur >= CLOCK_THRESHOLD) {
          triggered = true;
        }
        lastResetSample = cur;
      }
      if (triggered) {
        stepIndex = 0;
        currentStep = 0;
        nextStepTime = ctx.currentTime + 0.005;
      }
    }

    function tick() {
      if (!alive) return;
      try {
        const isPlaying = readParam('isPlaying', 0) >= 0.5;
        const externalClock = isClockInConnected();
        const nowAt = ctx.currentTime;

        if (isPlaying && !prevPlaying) {
          stepIndex = 0;
          currentStep = 0;
          nextStepTime = ctx.currentTime + 0.05;
          gateSrc.offset.cancelScheduledValues(ctx.currentTime);
          gateSrc.offset.setValueAtTime(0, ctx.currentTime);
          polyPitch.silence(ctx.currentTime);
          lastClockSample = 0;
          lastResetSample = 0;
          lastClockSampleTime = ctx.currentTime;
        } else if (!isPlaying && prevPlaying) {
          gateSrc.offset.cancelScheduledValues(ctx.currentTime);
          gateSrc.offset.setValueAtTime(0, ctx.currentTime);
          polyPitch.silence(ctx.currentTime);
        }
        prevPlaying = isPlaying;

        // Reset CV is honored even when stopped (debounce-style).
        checkResetEdge(nowAt);

        if (!isPlaying) {
          timeoutId = setTimeout(tick, TICK_MS);
          return;
        }

        if (externalClock) {
          clockInAnalyser.getFloatTimeDomainData(clockInBuffer);
          const elapsed = nowAt - lastClockSampleTime;
          const newSamples = Math.min(
            clockInBuffer.length,
            Math.max(1, Math.ceil(elapsed * ctx.sampleRate)),
          );
          const start = clockInBuffer.length - newSamples;
          const bpm = readParam('bpm', 90);
          const length = Math.max(1, Math.round(readParam('length', 8)));
          const stepDurForGate = 60 / Math.max(1, bpm) / 2; // 8th-note feel
          for (let i = start; i < clockInBuffer.length; i++) {
            const cur = clockInBuffer[i] ?? 0;
            if (lastClockSample < CLOCK_THRESHOLD && cur >= CLOCK_THRESHOLD) {
              emitStep(stepIndex, nowAt + 0.005, stepDurForGate);
              stepIndex = (stepIndex + 1) % length;
              currentStep = stepIndex;
              totalAdvances++;
            }
            lastClockSample = cur;
          }
          lastClockSampleTime = nowAt;
        } else {
          while (nextStepTime < ctx.currentTime + LOOKAHEAD_S) {
            const bpm = readParam('bpm', 90);
            const length = Math.max(1, Math.round(readParam('length', 8)));
            // POLYSEQZ defaults to 8th-note step grid — chords feel slower
            // than the Sequencer's 16th default, which is more musically
            // appropriate for chord changes.
            const stepDur = 60 / bpm / 2;
            emitStep(stepIndex, nextStepTime, stepDur);
            nextStepTime += stepDur;
            stepIndex = (stepIndex + 1) % length;
            currentStep = stepIndex;
            totalAdvances++;
          }
          lastClockSampleTime = nowAt;
        }
      } catch (err) {
        console.error('[polyseqz] tick error', err);
      }
      if (alive) timeoutId = setTimeout(tick, TICK_MS);
    }

    timeoutId = setTimeout(tick, TICK_MS);

    return {
      domain: 'audio',
      inputs: new Map([
        ['clock',       { node: clockInGain, input: 0 }],
        ['reset_cv',    { node: resetInGain, input: 0 }],
        // paramTarget inputs route CV directly to an AudioParam. We back
        // play_cv / humanize_cv with internal ConstantSource.offset targets
        // (the .node field is unused when .param is set; we point at the
        // closest in-graph node to keep the type happy).
        ['play_cv',     { node: clockInGain, input: 0, param: playCV.param }],
        ['humanize_cv', { node: clockInGain, input: 0, param: humanizeCV.param }],
      ]),
      outputs: new Map([
        ['poly',  { node: polyPitch.output, output: 0 }],
        ['gate',  { node: gateSrc, output: 0 }],
        ['clock', { node: clockOutSrc, output: 0 }],
      ]),
      setParam(_paramId, _value) {
        // No AudioParam to write — the tick reads node.params each iteration.
      },
      readParam(paramId) {
        const live = livePatch.nodes[nodeId];
        const v = live?.params?.[paramId];
        return typeof v === 'number' ? v : undefined;
      },
      read(key) {
        if (key === 'currentStep') return currentStep;
        if (key === 'totalAdvances') return totalAdvances;
        if (key === 'pitchVOct')  return lastEmittedVOct;
        if (key === 'gateValue')  return lastEmittedGate;
        if (typeof key === 'string' && key.startsWith('pitchVOctLane:')) {
          const i = Number.parseInt(key.slice('pitchVOctLane:'.length), 10);
          return Number.isFinite(i) && i >= 0 && i < POLY_CHANNEL_PAIRS
            ? lastEmittedLaneVOct[i]
            : undefined;
        }
        if (typeof key === 'string' && key.startsWith('gateLane:')) {
          const i = Number.parseInt(key.slice('gateLane:'.length), 10);
          return Number.isFinite(i) && i >= 0 && i < POLY_CHANNEL_PAIRS
            ? lastEmittedLaneGate[i]
            : undefined;
        }
        if (typeof key === 'string' && key.startsWith('humanizeOffset:')) {
          const i = Number.parseInt(key.slice('humanizeOffset:'.length), 10);
          return Number.isFinite(i) && i >= 0 && i < POLY_CHANNEL_PAIRS
            ? lastHumanizeOffsets[i]
            : undefined;
        }
        return undefined;
      },
      dispose() {
        alive = false;
        if (timeoutId !== null) clearTimeout(timeoutId);
        try { gateSrc.stop(); } catch { /* */ }
        try { clockOutSrc.stop(); } catch { /* */ }
        try { clockInSilence.stop(); } catch { /* */ }
        try { resetInSilence.stop(); } catch { /* */ }
        polyPitch.dispose();
        gateSrc.disconnect();
        clockOutSrc.disconnect();
        clockInSilence.disconnect();
        clockInGain.disconnect();
        clockInAnalyser.disconnect();
        resetInSilence.disconnect();
        resetInGain.disconnect();
        resetInAnalyser.disconnect();
        playCV.dispose();
        humanizeCV.dispose();
      },
    };
  },
};

// Re-export the lane count so tests / UI stay in sync without duplicating it.
export { VOICE_LANES as POLYSEQZ_VOICE_LANES };
