// packages/web/src/lib/audio/modules/clipplayer.ts
//
// CLIP PLAYER — the dedicated clip-launcher module a monome grid drives (and
// that works standalone from the card). v1 clips are NOTE/PATTERN clips: the
// module is a sequencer whose pattern is the LAUNCHED clip, with quantized
// switching between a 64-slot "clip page". Audio-loop + snapshot clip kinds are
// later phases (see clip-types.ts + the plan §3.1).
//
// v1 scope: ONE active clip at a time (launching another quantize-switches to
// it — the proven queued-slot model generalized to 64 slots). Simultaneous
// multi-track playback is a documented follow-up. The active/queued clip syncs
// via node.data so collaborators (and >1 grid) see the same session (§5.2);
// LED/grid I/O is local and lives in lib/grid.
//
// Scheduling reuses the sequencer's two-clocks lookahead off the shared
// scheduler-clock; the patched `clock` input advances steps via the canonical
// windowed edge-counter (NOT a whole-buffer rescan — the double-count bug).
//
// Inputs:  clock (gate) — external clock; rising edges advance one step.
//          stop_all (gate) — rising edge stops the playing clip.
// Outputs: pitch (polyPitchGate) — launched clip's pitch (chords → lanes).
//          gate (gate) — high while a note sounds.
//          velocity (cv) — per-note velocity (0..1).
//          clip_gate (gate) — pulse when a clip actually STARTS (post-quantize).
// Params:  bpm, quantize (0 off / 1 loop-boundary), octave, gateLength.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import { createPolySender, POLY_CHANNEL_PAIRS } from '$lib/audio/poly';
import { getSchedulerClock } from '$lib/audio/scheduler-clock';
import { createEdgeCounter } from '$lib/audio/edge-detect';
import { isInputPortConnected } from './transport-helpers';
import { createPlayheadTracker } from './playhead-tracker';
import {
  readClip,
  lanesForStep,
  CLIP_COUNT,
  type ClipPlayerData,
  type NoteClipRecord,
} from './clip-types';

export const clipplayerDef: AudioModuleDef = {
  type: 'clipplayer',
  palette: { top: 'Audio modules', sub: 'sequencers' },
  domain: 'audio',
  label: 'clip player',
  category: 'modulation',
  schemaVersion: 1,
  // Big card: 8×8 clip grid + a Deluge-style note editor.
  size: '3u',
  hp: 4,

  inputs: [
    { id: 'clock', type: 'gate' },
    { id: 'stop_all', type: 'gate' },
  ],
  outputs: [
    { id: 'pitch', type: 'polyPitchGate' },
    { id: 'gate', type: 'gate' },
    { id: 'velocity', type: 'cv' },
    { id: 'clip_gate', type: 'gate' },
  ],
  params: [
    { id: 'bpm', label: 'BPM', defaultValue: 120, min: 30, max: 300, curve: 'linear' },
    // 0 = off (launch immediately), 1 = quantize to the active clip's loop boundary.
    { id: 'quantize', label: 'Qnt', defaultValue: 1, min: 0, max: 1, curve: 'discrete' },
    { id: 'octave', label: 'Oct', defaultValue: 0, min: -2, max: 2, curve: 'discrete' },
    { id: 'gateLength', label: 'Gate', defaultValue: 0.9, min: 0.1, max: 1, curve: 'linear' },
  ],

  // The full clip page is atomically exposable to a containing Instrument.
  exposesSequence: true,

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const nodeId = node.id;

    const polyPitch = createPolySender(ctx);
    const gateSrc = ctx.createConstantSource();
    const velSrc = ctx.createConstantSource();
    const clipGateSrc = ctx.createConstantSource();
    gateSrc.offset.value = 0;
    velSrc.offset.value = 0;
    clipGateSrc.offset.value = 0;
    gateSrc.start();
    velSrc.start();
    clipGateSrc.start();

    // --- clock input (windowed edge counter — never a whole-buffer rescan) ---
    const clockInGain = ctx.createGain();
    const clockInAnalyser = ctx.createAnalyser();
    clockInAnalyser.fftSize = 2048;
    clockInGain.connect(clockInAnalyser);
    const clockInSilence = ctx.createConstantSource();
    clockInSilence.offset.value = 0;
    clockInSilence.start();
    clockInSilence.connect(clockInGain);
    const clockCounter = createEdgeCounter({ ctx, analyser: clockInAnalyser });

    // --- stop_all input ---
    const stopGain = ctx.createGain();
    const stopAnalyser = ctx.createAnalyser();
    stopAnalyser.fftSize = 2048;
    stopGain.connect(stopAnalyser);
    const stopSilence = ctx.createConstantSource();
    stopSilence.offset.value = 0;
    stopSilence.start();
    stopSilence.connect(stopGain);
    const stopCounter = createEdgeCounter({ ctx, analyser: stopAnalyser });

    const playhead = createPlayheadTracker();

    let alive = true;
    let unsubscribeTick: (() => void) | null = null;
    let stepIndex = 0;
    let nextStepTime = ctx.currentTime + 0.05;
    /** Index (as string) of the clip currently playing, or null = stopped.
     *  Mirrors node.data.playing (the SYNCED playing-set). */
    let activeClip: string | null = null;
    const LOOKAHEAD_S = 0.2;

    // Test/UI mirrors.
    let totalLoops = 0;
    let lastEmittedVOct = 0;
    let lastEmittedGate = 0;
    let lastEmittedVel = 0;
    const lastLaneVOct = new Array<number>(POLY_CHANNEL_PAIRS).fill(0);
    const lastLaneGate = new Array<number>(POLY_CHANNEL_PAIRS).fill(0);

    function liveData(): ClipPlayerData | undefined {
      return livePatch.nodes[nodeId]?.data as ClipPlayerData | undefined;
    }
    function readParam(id: string, fallback: number): number {
      const v = livePatch.nodes[nodeId]?.params?.[id];
      return typeof v === 'number' ? v : fallback;
    }
    function writeData(mut: (d: ClipPlayerData) => void): void {
      const live = livePatch.nodes[nodeId];
      if (!live) return;
      if (!live.data) live.data = {};
      mut(live.data as ClipPlayerData);
    }
    function isClockConnected(): boolean {
      return isInputPortConnected(Object.values(livePatch.edges), nodeId, 'clock');
    }

    function emitClipGate(at: number): void {
      clipGateSrc.offset.setValueAtTime(1, at);
      clipGateSrc.offset.setValueAtTime(0, at + 0.01);
    }

    function silenceOutputs(at: number): void {
      gateSrc.offset.cancelScheduledValues(at);
      gateSrc.offset.setValueAtTime(0, at);
      velSrc.offset.cancelScheduledValues(at);
      velSrc.offset.setValueAtTime(0, at);
      polyPitch.silence(at);
      lastEmittedGate = 0;
      lastEmittedVel = 0;
    }

    /** Switch the active clip (or stop with null). Resets position + syncs the
     *  playing-set, and pulses clip_gate on a real start. */
    function setActive(idx: string | null): void {
      activeClip = idx;
      stepIndex = 0;
      playhead.reset();
      nextStepTime = ctx.currentTime + 0.01;
      writeData((d) => {
        d.playing = idx;
      });
      if (idx === null) silenceOutputs(ctx.currentTime);
      else emitClipGate(ctx.currentTime);
    }

    /** Apply a queued launch/stop (consuming node.data.queued). Returns true if
     *  it changed the active clip. */
    function applyQueued(): boolean {
      const d = liveData();
      const q = d?.queued;
      if (q === undefined || q === null) return false;
      writeData((dd) => {
        dd.queued = null;
      });
      if (q === 'stop') {
        if (activeClip === null) return false;
        setActive(null);
        return true;
      }
      const next = String(q);
      if (next === activeClip) return false;
      setActive(next);
      return true;
    }

    function emitStep(clip: NoteClipRecord, idx: number, atTime: number, stepDur: number): void {
      const r = lanesForStep(clip, idx);
      const octave = readParam('octave', 0);
      const gateFrac = readParam('gateLength', 0.9);
      const gateOff = Math.max(0.001, r.gateSteps * stepDur * gateFrac);
      const lanes = r.lanes.map((l) => ({ pitch: l.pitch + octave, gate: l.gate }));
      polyPitch.scheduleStep(atTime, lanes, gateOff);
      for (let i = 0; i < POLY_CHANNEL_PAIRS; i++) {
        const l = lanes[i] ?? { pitch: 0, gate: 0 as const };
        lastLaneVOct[i] = l.pitch;
        lastLaneGate[i] = l.gate;
      }
      playhead.schedule(idx, atTime);
      if (r.any) {
        gateSrc.offset.setValueAtTime(1, atTime);
        gateSrc.offset.setValueAtTime(0, atTime + gateOff);
        velSrc.offset.setValueAtTime(r.velocity, atTime);
        lastEmittedVOct = lanes[0]?.pitch ?? 0;
        lastEmittedGate = 1;
        lastEmittedVel = r.velocity;
      } else {
        // Silent step — leave pitch held, gate low.
        lastEmittedGate = 0;
      }
    }

    function tick(): void {
      if (!alive) return;
      try {
        // Adopt a peer-driven playing change (synced playing-set). When a
        // collaborator launches a clip, node.data.playing diverges from our
        // local activeClip with no local queue pending — follow it.
        const d0 = liveData();
        const syncedPlaying = d0?.playing ?? null;
        if (syncedPlaying !== activeClip && (d0?.queued ?? null) === null) {
          activeClip = syncedPlaying;
          stepIndex = 0;
          playhead.reset();
          nextStepTime = ctx.currentTime + 0.01;
          if (activeClip === null) silenceOutputs(ctx.currentTime);
        }

        // stop_all gate — immediate.
        if (stopCounter.poll(ctx.currentTime) > 0 && activeClip !== null) {
          setActive(null);
        }

        const quantize = readParam('quantize', 1) >= 0.5;
        // Immediate-launch cases: quantize off, or nothing currently playing.
        if (!quantize || activeClip === null) applyQueued();

        if (activeClip === null) {
          nextStepTime = ctx.currentTime + 0.05;
          return;
        }

        const externalClock = isClockConnected();
        const bpm = readParam('bpm', 120);
        const stepDur = 60 / Math.max(1, bpm) / 4;

        if (externalClock) {
          const edges = clockCounter.poll(ctx.currentTime);
          for (let e = 0; e < edges; e++) {
            const clip = readClip(liveData(), activeClip);
            if (!clip || clip.kind !== 'note') break;
            const length = Math.max(1, clip.lengthSteps);
            emitStep(clip, stepIndex, ctx.currentTime + 0.005, stepDur);
            const nextIdx = (stepIndex + 1) % length;
            if (nextIdx === 0) {
              totalLoops++;
              emitClipGate(ctx.currentTime + 0.005); // clip downbeat
              if (quantize && applyQueued()) continue; // switched clip → fresh step 0
              if (activeClip === null) break;
            }
            stepIndex = nextIdx;
          }
        } else {
          while (nextStepTime < ctx.currentTime + LOOKAHEAD_S) {
            const clip = readClip(liveData(), activeClip);
            if (!clip || clip.kind !== 'note') break;
            const length = Math.max(1, clip.lengthSteps);
            emitStep(clip, stepIndex, nextStepTime, stepDur);
            const nextIdx = (stepIndex + 1) % length;
            const nextStart = nextStepTime + stepDur;
            if (nextIdx === 0) {
              totalLoops++;
              emitClipGate(nextStart); // clip downbeat (start + each loop)
              if (quantize && applyQueued()) {
                // Re-anchor the new clip's step 0 to this natural boundary.
                nextStepTime = nextStart;
                continue;
              }
              if (activeClip === null) break;
            }
            nextStepTime = nextStart;
            stepIndex = nextIdx;
          }
        }
      } catch (err) {
        console.error('[clipplayer] tick error', err);
      }
    }

    unsubscribeTick = getSchedulerClock().subscribe(tick);

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number }>([
        ['clock', { node: clockInGain, input: 0 }],
        ['stop_all', { node: stopGain, input: 0 }],
      ]),
      outputs: new Map([
        ['pitch', { node: polyPitch.output, output: 0 }],
        ['gate', { node: gateSrc, output: 0 }],
        ['velocity', { node: velSrc, output: 0 }],
        ['clip_gate', { node: clipGateSrc, output: 0 }],
      ]),
      setParam() {
        /* tick reads node.params live each iteration */
      },
      readParam(paramId) {
        const v = livePatch.nodes[nodeId]?.params?.[paramId];
        return typeof v === 'number' ? v : undefined;
      },
      read(key) {
        if (key === 'currentStep') return playhead.currentAt(ctx.currentTime);
        if (key === 'totalLoops') return totalLoops;
        if (key === 'activeClip') return activeClip === null ? -1 : Number(activeClip);
        if (key === 'pitchVOct') return lastEmittedVOct;
        if (key === 'gateValue') return lastEmittedGate;
        if (key === 'velocityValue') return lastEmittedVel;
        if (typeof key === 'string' && key.startsWith('pitchVOctLane:')) {
          const i = Number.parseInt(key.slice('pitchVOctLane:'.length), 10);
          return Number.isFinite(i) && i >= 0 && i < POLY_CHANNEL_PAIRS ? lastLaneVOct[i] : undefined;
        }
        if (typeof key === 'string' && key.startsWith('gateLane:')) {
          const i = Number.parseInt(key.slice('gateLane:'.length), 10);
          return Number.isFinite(i) && i >= 0 && i < POLY_CHANNEL_PAIRS ? lastLaneGate[i] : undefined;
        }
        return undefined;
      },
      dispose() {
        alive = false;
        if (unsubscribeTick) {
          unsubscribeTick();
          unsubscribeTick = null;
        }
        try { gateSrc.stop(); } catch { /* */ }
        try { velSrc.stop(); } catch { /* */ }
        try { clipGateSrc.stop(); } catch { /* */ }
        try { clockInSilence.stop(); } catch { /* */ }
        try { stopSilence.stop(); } catch { /* */ }
        polyPitch.dispose();
        gateSrc.disconnect();
        velSrc.disconnect();
        clipGateSrc.disconnect();
        clockInSilence.disconnect();
        clockInGain.disconnect();
        clockInAnalyser.disconnect();
        stopSilence.disconnect();
        stopGain.disconnect();
        stopAnalyser.disconnect();
      },
    };
  },
};

/** Exposed for tests/UI: total clip slots. */
export { CLIP_COUNT };
