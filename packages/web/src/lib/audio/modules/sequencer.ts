// packages/web/src/lib/audio/modules/sequencer.ts
//
// 32-step sequencer. Plain JS — internal clock + ConstantSourceNodes for
// pitch/gate outputs. The "two clocks" lookahead scheduler runs in setTimeout
// at ~25 ms intervals and queues sample-accurate AudioParam writes ~100 ms
// ahead.
//
// Per-step state lives in node.data.steps as an array of {on, pitch}. Knob
// params live in node.params.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';

export interface Step {
  on: boolean;
  pitch: number; // semitones from root
}

export interface SequencerData {
  steps: Step[]; // length 32
}

export const STEP_COUNT = 32;

export function defaultSteps(): Step[] {
  return Array.from({ length: STEP_COUNT }, () => ({ on: false, pitch: 0 }));
}

export const sequencerDef: AudioModuleDef = {
  type: 'sequencer',
  domain: 'audio',
  label: 'Sequencer',
  category: 'modulation',
  schemaVersion: 1,

  inputs: [
    // External clock: when patched, the sequencer advances on incoming rising
    // edges instead of its internal BPM. Disconnect to fall back to BPM.
    { id: 'clock', type: 'gate' },
  ],
  outputs: [
    { id: 'pitch', type: 'pitch' },
    { id: 'gate', type: 'gate' },
    // Clock pulse per step advance (10 ms high). Fires on every advance,
    // regardless of step on/off — it's the "I just stepped" signal. Patch
    // into another sequencer's clock_in to chain.
    { id: 'clock', type: 'gate' },
  ],
  params: [
    { id: 'bpm',        label: 'BPM',  defaultValue: 120, min: 30,  max: 300,  curve: 'linear' },
    { id: 'length',     label: 'Len',  defaultValue: 16,  min: 1,   max: 32,   curve: 'discrete' },
    { id: 'octave',     label: 'Oct',  defaultValue: 0,   min: -2,  max: 2,    curve: 'discrete' },
    { id: 'gateLength', label: 'Gate', defaultValue: 0.5, min: 0.1, max: 0.95, curve: 'linear' },
    { id: 'swing',      label: 'Sw',   defaultValue: 0,   min: 0,   max: 0.75, curve: 'linear' },
    // 0 = stopped, 1 = playing. Default stopped — explicit play.
    { id: 'isPlaying',  label: 'Play', defaultValue: 0,   min: 0,   max: 1,    curve: 'discrete' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // Output ConstantSources: pitch (V/oct), gate (0/1), clock pulse (0/1).
    const pitchSrc = ctx.createConstantSource();
    const gateSrc = ctx.createConstantSource();
    const clockOutSrc = ctx.createConstantSource();
    pitchSrc.offset.value = 0;
    gateSrc.offset.value = 0;
    clockOutSrc.offset.value = 0;
    pitchSrc.start();
    gateSrc.start();
    clockOutSrc.start();

    // Clock input: a GainNode acts as the patch port. Anything routed in flows
    // through to an AnalyserNode that the tick polls for rising edges.
    // Latency budget: ~TICK_MS (25 ms) from upstream pulse to step advance.
    const clockInGain = ctx.createGain();
    const clockInAnalyser = ctx.createAnalyser();
    clockInAnalyser.fftSize = 2048; // ~42 ms at 48 kHz — must exceed TICK_MS
    clockInGain.connect(clockInAnalyser);
    const clockInBuffer = new Float32Array(clockInAnalyser.fftSize);

    // Silence keeps the gain + analyser in the active graph even with nothing
    // patched in (same trick the Faust modules use for their merger inputs).
    const clockInSilence = ctx.createConstantSource();
    clockInSilence.offset.value = 0;
    clockInSilence.start();
    clockInSilence.connect(clockInGain);

    let lastClockSample = 0;
    let lastClockSampleTime = ctx.currentTime;
    const CLOCK_THRESHOLD = 0.5;

    function emitClockPulse(atTime: number) {
      clockOutSrc.offset.setValueAtTime(1, atTime);
      clockOutSrc.offset.setValueAtTime(0, atTime + 0.01);
    }

    function isClockInConnected(): boolean {
      for (const edge of Object.values(livePatch.edges)) {
        if (!edge) continue;
        if (edge.target.nodeId === nodeId && edge.target.portId === 'clock') {
          return true;
        }
      }
      return false;
    }

    // The reconciler passes a snapshot of the node, but the Sequencer needs
    // LIVE access to per-tick state (steps + params change while running).
    // Read from the live patch by node id; if the node has been deleted,
    // the dispose() path will set alive=false and the tick stops.
    const nodeId = node.id;

    // Live state read from node.params + node.data each tick.
    let stepIndex = 0;
    let nextStepTime = ctx.currentTime + 0.05;
    let prevPlaying = false;
    let alive = true;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const LOOKAHEAD_S = 0.1;
    const TICK_MS = 25;

    function readSteps(): Step[] {
      const live = livePatch.nodes[nodeId];
      const steps = (live?.data as Record<string, unknown> | undefined)?.steps;
      if (Array.isArray(steps)) return steps as Step[];
      return defaultSteps();
    }
    function readParam(id: string, fallback: number): number {
      const live = livePatch.nodes[nodeId];
      const v = live?.params?.[id];
      return typeof v === 'number' ? v : fallback;
    }

    /** Schedule one step's pitch + gate + clock-out events at the given audio
     * time. Used by both the internal-BPM scheduler and the external-clock
     * advance path. `stepDurForGate` is how long the gate stays high relative
     * to the step (passed as duration so external-clock mode can derive it
     * from observed inter-pulse spacing instead of from BPM). */
    function emitStep(idx: number, atTime: number, stepDurForGate: number) {
      const octave = readParam('octave', 0);
      const gateLengthFrac = readParam('gateLength', 0.5);
      const steps = readSteps();
      const step = steps[idx];
      // Always emit a clock pulse on advance — that's the chain-out signal
      // and it fires regardless of step on/off.
      emitClockPulse(atTime);
      if (step && step.on) {
        const semitones = step.pitch + octave * 12;
        const vOct = semitones / 12;
        pitchSrc.offset.setValueAtTime(vOct, atTime);
        gateSrc.offset.setValueAtTime(1, atTime);
        gateSrc.offset.setValueAtTime(0, atTime + stepDurForGate * gateLengthFrac);
      }
    }

    function tick() {
      if (!alive) return;
      try {
        const isPlaying = readParam('isPlaying', 0) >= 0.5;
        const externalClock = isClockInConnected();

        if (isPlaying && !prevPlaying) {
          // Transitioned to playing: reset position + cancel any stale future events
          stepIndex = 0;
          currentStep = 0;
          nextStepTime = ctx.currentTime + 0.05;
          gateSrc.offset.cancelScheduledValues(ctx.currentTime);
          gateSrc.offset.setValueAtTime(0, ctx.currentTime);
          // Reset clock-in detector so the first observed pulse counts.
          lastClockSample = 0;
          lastClockSampleTime = ctx.currentTime;
        } else if (!isPlaying && prevPlaying) {
          // Transitioned to stopped: cancel pending events, force gate low
          gateSrc.offset.cancelScheduledValues(ctx.currentTime);
          gateSrc.offset.setValueAtTime(0, ctx.currentTime);
        }
        prevPlaying = isPlaying;

        if (!isPlaying) {
          timeoutId = setTimeout(tick, TICK_MS);
          return;
        }

        if (externalClock) {
          // External-clock mode: advance one step per rising edge observed in
          // the analyser's recent samples. We only inspect samples that arrived
          // SINCE the last tick to avoid double-counting the overlap window.
          clockInAnalyser.getFloatTimeDomainData(clockInBuffer);
          const nowAt = ctx.currentTime;
          const elapsed = nowAt - lastClockSampleTime;
          const newSamples = Math.min(
            clockInBuffer.length,
            Math.max(1, Math.ceil(elapsed * ctx.sampleRate)),
          );
          const start = clockInBuffer.length - newSamples;
          // Estimate inter-step duration from BPM (used only for gate length).
          const bpm = readParam('bpm', 120);
          const length = Math.max(1, Math.round(readParam('length', 16)));
          const stepDurForGate = 60 / Math.max(1, bpm) / 4;
          for (let i = start; i < clockInBuffer.length; i++) {
            const cur = clockInBuffer[i] ?? 0;
            if (lastClockSample < CLOCK_THRESHOLD && cur >= CLOCK_THRESHOLD) {
              // Rising edge — schedule the step a hair in the future to give
              // the audio thread a render quantum of headroom.
              emitStep(stepIndex, nowAt + 0.005, stepDurForGate);
              stepIndex = (stepIndex + 1) % length;
              currentStep = stepIndex;
              totalAdvances++;
            }
            lastClockSample = cur;
          }
          lastClockSampleTime = nowAt;
        } else {
          // Internal-BPM mode: classic two-clocks lookahead scheduler.
          while (nextStepTime < ctx.currentTime + LOOKAHEAD_S) {
            const bpm = readParam('bpm', 120);
            const length = Math.max(1, Math.round(readParam('length', 16)));
            const swing = readParam('swing', 0);

            const stepDurBase = 60 / bpm / 4; // 16th-note step
            const isOddStep = stepIndex % 2 === 1;
            const stepDur = isOddStep ? stepDurBase * (1 - swing * 0.5) : stepDurBase * (1 + swing * 0.5);

            emitStep(stepIndex, nextStepTime, stepDur);

            nextStepTime += stepDur;
            stepIndex = (stepIndex + 1) % length;
            currentStep = stepIndex;
            totalAdvances++;
          }
        }
      } catch (err) {
        console.error('[sequencer] tick error', err);
      }
      if (alive) timeoutId = setTimeout(tick, TICK_MS);
    }

    let currentStep = 0;
    let totalAdvances = 0; // monotonic — useful for tests asserting "did we step N times"
    timeoutId = setTimeout(tick, TICK_MS);

    return {
      domain: 'audio',
      inputs: new Map([['clock', { node: clockInGain, input: 0 }]]),
      outputs: new Map([
        ['pitch', { node: pitchSrc, output: 0 }],
        ['gate', { node: gateSrc, output: 0 }],
        ['clock', { node: clockOutSrc, output: 0 }],
      ]),
      setParam(_paramId, _value) {
        // No AudioParam to write — the tick reads node.params each iteration.
        // Keeps the sequencer reactive to fader changes in real time.
      },
      readParam(paramId) {
        const live = livePatch.nodes[nodeId];
        const v = live?.params?.[paramId];
        return typeof v === 'number' ? v : undefined;
      },
      read(key) {
        if (key === 'currentStep') return currentStep;
        if (key === 'totalAdvances') return totalAdvances;
        return undefined;
      },
      dispose() {
        alive = false;
        if (timeoutId !== null) clearTimeout(timeoutId);
        try { pitchSrc.stop(); } catch { /* already stopped */ }
        try { gateSrc.stop(); } catch { /* already stopped */ }
        try { clockOutSrc.stop(); } catch { /* already stopped */ }
        try { clockInSilence.stop(); } catch { /* already stopped */ }
        pitchSrc.disconnect();
        gateSrc.disconnect();
        clockOutSrc.disconnect();
        clockInSilence.disconnect();
        clockInGain.disconnect();
        clockInAnalyser.disconnect();
      },
    };
  },
};
