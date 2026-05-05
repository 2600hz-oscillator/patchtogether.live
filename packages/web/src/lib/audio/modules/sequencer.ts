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

  inputs: [],
  outputs: [
    { id: 'pitch', type: 'pitch' },
    { id: 'gate', type: 'gate' },
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
    // Two-source output: pitch (V/oct) + gate (0/1).
    const pitchSrc = ctx.createConstantSource();
    const gateSrc = ctx.createConstantSource();
    pitchSrc.offset.value = 0;
    gateSrc.offset.value = 0;
    pitchSrc.start();
    gateSrc.start();

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

    function tick() {
      if (!alive) return;
      try {
        const isPlaying = readParam('isPlaying', 0) >= 0.5;

        if (isPlaying && !prevPlaying) {
          // Transitioned to playing: reset position + cancel any stale future events
          stepIndex = 0;
          currentStep = 0;
          nextStepTime = ctx.currentTime + 0.05;
          gateSrc.offset.cancelScheduledValues(ctx.currentTime);
          gateSrc.offset.setValueAtTime(0, ctx.currentTime);
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

        while (nextStepTime < ctx.currentTime + LOOKAHEAD_S) {
          const bpm = readParam('bpm', 120);
          const length = Math.max(1, Math.round(readParam('length', 16)));
          const octave = readParam('octave', 0);
          const gateLengthFrac = readParam('gateLength', 0.5);
          const swing = readParam('swing', 0);

          const stepDurBase = 60 / bpm / 4; // 16th-note step
          const isOddStep = stepIndex % 2 === 1;
          const stepDur = isOddStep ? stepDurBase * (1 - swing * 0.5) : stepDurBase * (1 + swing * 0.5);

          const steps = readSteps();
          const step = steps[stepIndex];

          if (step && step.on) {
            const semitones = step.pitch + octave * 12;
            const vOct = semitones / 12;
            pitchSrc.offset.setValueAtTime(vOct, nextStepTime);
            gateSrc.offset.setValueAtTime(1, nextStepTime);
            gateSrc.offset.setValueAtTime(0, nextStepTime + stepDur * gateLengthFrac);
          }
          // Step off: leave pitch at its previous value, gate stays low.

          nextStepTime += stepDur;
          stepIndex = (stepIndex + 1) % length;
          currentStep = stepIndex;
        }
      } catch (err) {
        console.error('[sequencer] tick error', err);
      }
      if (alive) timeoutId = setTimeout(tick, TICK_MS);
    }

    let currentStep = 0;
    timeoutId = setTimeout(tick, TICK_MS);

    return {
      domain: 'audio',
      inputs: new Map(),
      outputs: new Map([
        ['pitch', { node: pitchSrc, output: 0 }],
        ['gate', { node: gateSrc, output: 0 }],
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
        return undefined;
      },
      dispose() {
        alive = false;
        if (timeoutId !== null) clearTimeout(timeoutId);
        try { pitchSrc.stop(); } catch { /* already stopped */ }
        try { gateSrc.stop(); } catch { /* already stopped */ }
        pitchSrc.disconnect();
        gateSrc.disconnect();
      },
    };
  },
};
