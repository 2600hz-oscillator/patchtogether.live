// packages/web/src/lib/audio/modules/score.ts
//
// SCORE — sheet-music sequencer module. Reuses Sequencer's two-clocks
// scheduler at 16th-note resolution. Drives an inline ADSR Faust voice
// for the env CV output (gain-scaled by the current dynamic).
//
// Outputs:
//   pitch  — V/oct (mono)
//   gate   — 1 while a note is sounding, else 0
//   env    — ADSR × dynamic, smooth CV
//   clock  — 16th-rate pulse (chainable to other clocked modules)
//
// Inputs:
//   clock                — external 16th clock; when patched, advances on
//                          rising edges instead of internal BPM.
//   attack/decay/sustain/release — CV → AudioParam routing into the inline ADSR.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import { midiToVOct } from '$lib/audio/note-entry';
import {
  TICKS_PER_BAR,
  TOTAL_BARS,
  DYNAMIC_SCALE,
  dynamicAt,
  sortNotes,
  tickWidth,
  type ScoreData,
  type ScoreNote,
  type DynamicMarker,
  type Tie,
  type DynamicLevel,
} from '$lib/audio/score-data';
import wasmUrl from '@patchtogether.live/dsp/dist/adsr.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/adsr.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/adsr.worklet.js?url';

const ADSR_PREFIX = '/ADSR';

/** Read the ScoreData blob off a live patch node, with sensible defaults. */
export function readScoreData(nodeId: string): ScoreData {
  const live = livePatch.nodes[nodeId];
  const d = live?.data as Partial<ScoreData> | undefined;
  return {
    notes: Array.isArray(d?.notes) ? (d!.notes as ScoreNote[]) : [],
    dynamics: Array.isArray(d?.dynamics) ? (d!.dynamics as DynamicMarker[]) : [],
    ties: Array.isArray(d?.ties) ? (d!.ties as Tie[]) : [],
    keySignature: typeof d?.keySignature === 'number' ? d!.keySignature : 0,
  };
}

export const TOTAL_TICKS = TOTAL_BARS * TICKS_PER_BAR;

export const scoreDef: AudioModuleDef = {
  type: 'score',
  domain: 'audio',
  label: 'Score',
  category: 'modulation',
  schemaVersion: 1,
  inputs: [
    { id: 'clock',   type: 'gate' },
    { id: 'attack',  type: 'cv',   paramTarget: 'attack' },
    { id: 'decay',   type: 'cv',   paramTarget: 'decay' },
    { id: 'sustain', type: 'cv',   paramTarget: 'sustain' },
    { id: 'release', type: 'cv',   paramTarget: 'release' },
  ],
  outputs: [
    { id: 'pitch', type: 'pitch' },
    { id: 'gate',  type: 'gate' },
    { id: 'env',   type: 'cv' },
    { id: 'clock', type: 'gate' },
  ],
  params: [
    { id: 'bpm',       label: 'BPM',  defaultValue: 120,   min: 30,    max: 300, curve: 'linear' },
    { id: 'attack',    label: 'A',    defaultValue: 0.005, min: 0.001, max: 10,  curve: 'log',    units: 's' },
    { id: 'decay',     label: 'D',    defaultValue: 0.1,   min: 0.001, max: 10,  curve: 'log',    units: 's' },
    { id: 'sustain',   label: 'S',    defaultValue: 0.7,   min: 0,     max: 1,   curve: 'linear' },
    { id: 'release',   label: 'R',    defaultValue: 0.3,   min: 0.001, max: 10,  curve: 'log',    units: 's' },
    { id: 'isPlaying', label: 'Play', defaultValue: 0,     min: 0,     max: 1,   curve: 'discrete' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const nodeId = node.id;
    const adsr = await instantiateFaustModule(ctx, {
      name: 'adsr', wasmUrl, metaUrl, workletUrl,
    });
    const adsrParams = adsr.parameters as unknown as Map<string, AudioParam>;
    for (const def of scoreDef.params) {
      if (def.id === 'bpm' || def.id === 'isPlaying') continue;
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      adsrParams.get(`${ADSR_PREFIX}/${def.id}`)?.setValueAtTime(v, ctx.currentTime);
    }
    const pAttack  = adsrParams.get(`${ADSR_PREFIX}/attack`);
    const pDecay   = adsrParams.get(`${ADSR_PREFIX}/decay`);
    const pSustain = adsrParams.get(`${ADSR_PREFIX}/sustain`);
    const pRelease = adsrParams.get(`${ADSR_PREFIX}/release`);

    // Internal gate source drives both the gate output AND the ADSR's gate.
    const gateSrc = ctx.createConstantSource();
    gateSrc.offset.value = 0;
    gateSrc.start();
    gateSrc.connect(adsr, 0, 0);

    // Pitch output as a ConstantSource (V/oct).
    const pitchSrc = ctx.createConstantSource();
    pitchSrc.offset.value = 0;
    pitchSrc.start();

    // Clock output ConstantSource — pulses high for 10 ms on each tick advance.
    const clockOutSrc = ctx.createConstantSource();
    clockOutSrc.offset.value = 0;
    clockOutSrc.start();

    // ADSR audio output → dynGain (gain set by current dynamic) → env output.
    const dynGain = ctx.createGain();
    dynGain.gain.value = DYNAMIC_SCALE.mf;
    adsr.connect(dynGain);

    // Clock input GainNode + AnalyserNode (same trick as Sequencer).
    const clockInGain = ctx.createGain();
    const clockInAnalyser = ctx.createAnalyser();
    clockInAnalyser.fftSize = 2048;
    clockInGain.connect(clockInAnalyser);
    const clockInBuffer = new Float32Array(clockInAnalyser.fftSize);
    const clockInSilence = ctx.createConstantSource();
    clockInSilence.offset.value = 0;
    clockInSilence.start();
    clockInSilence.connect(clockInGain);

    let lastClockSample = 0;
    let lastClockSampleTime = ctx.currentTime;
    const CLOCK_THRESHOLD = 0.5;

    function isClockInConnected(): boolean {
      for (const edge of Object.values(livePatch.edges)) {
        if (!edge) continue;
        if (edge.target.nodeId === nodeId && edge.target.portId === 'clock') return true;
      }
      return false;
    }

    function readParam(id: string, fallback: number): number {
      const live = livePatch.nodes[nodeId];
      const v = live?.params?.[id];
      return typeof v === 'number' ? v : fallback;
    }

    let absoluteTick = 0;
    let nextStepTime = ctx.currentTime + 0.05;
    let prevPlaying = false;
    let alive = true;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let activeNoteId: string | null = null;
    let activeNoteEndAbs = -1;
    let lastPlayedDynamic: DynamicLevel = 'mf';
    let totalAdvances = 0;
    const LOOKAHEAD_S = 0.1;
    const TICK_MS = 25;

    function emitClockPulse(at: number) {
      clockOutSrc.offset.setValueAtTime(1, at);
      clockOutSrc.offset.setValueAtTime(0, at + 0.01);
    }

    /** Write the pitch port's V/oct, schedule the gate envelope edges, and
     *  set the dynamic gain. Called on every note-START tick. */
    function startNote(n: ScoreNote, at: number, oneTickSec: number, dyn: DynamicLevel) {
      const vOct = midiToVOct(n.midi);
      pitchSrc.offset.setValueAtTime(vOct, at);
      gateSrc.offset.setValueAtTime(1, at);
      const dur = tickWidth(n.duration) * oneTickSec;
      // Gate stays high for ~95% of notated duration so consecutive notes
      // re-trigger the ADSR cleanly even when notated end-to-end.
      const gateOff = at + dur * 0.95;
      gateSrc.offset.setValueAtTime(0, gateOff);
      const scale = DYNAMIC_SCALE[dyn];
      dynGain.gain.setValueAtTime(scale, at);
      activeNoteId = n.id;
      activeNoteEndAbs = absoluteTick + tickWidth(n.duration);
      lastPlayedDynamic = dyn;
    }

    /** Advance one 16th. Schedules any note that starts at this tick;
     *  emits a clock pulse; updates the active-note tracker. */
    function advanceOneTick(at: number, oneTickSec: number) {
      emitClockPulse(at);
      const data = readScoreData(nodeId);
      const sorted = sortNotes(data.notes);
      const bar = Math.floor(absoluteTick / TICKS_PER_BAR);
      const tickInBar = absoluteTick % TICKS_PER_BAR;
      const noteHere = sorted.find((n) => n.bar === bar && n.tick === tickInBar);
      if (noteHere) {
        const dyn = dynamicAt(bar, tickInBar, data.dynamics);
        startNote(noteHere, at, oneTickSec, dyn);
      } else if (activeNoteId !== null && absoluteTick >= activeNoteEndAbs) {
        activeNoteId = null;
      }
      absoluteTick = (absoluteTick + 1) % TOTAL_TICKS;
      totalAdvances++;
    }

    function tick() {
      if (!alive) return;
      try {
        const isPlaying = readParam('isPlaying', 0) >= 0.5;
        const externalClock = isClockInConnected();

        if (isPlaying && !prevPlaying) {
          absoluteTick = 0;
          nextStepTime = ctx.currentTime + 0.05;
          gateSrc.offset.cancelScheduledValues(ctx.currentTime);
          gateSrc.offset.setValueAtTime(0, ctx.currentTime);
          activeNoteId = null;
          activeNoteEndAbs = -1;
          lastClockSample = 0;
          lastClockSampleTime = ctx.currentTime;
        } else if (!isPlaying && prevPlaying) {
          gateSrc.offset.cancelScheduledValues(ctx.currentTime);
          gateSrc.offset.setValueAtTime(0, ctx.currentTime);
          activeNoteId = null;
        }
        prevPlaying = isPlaying;

        if (!isPlaying) {
          timeoutId = setTimeout(tick, TICK_MS);
          return;
        }

        if (externalClock) {
          clockInAnalyser.getFloatTimeDomainData(clockInBuffer);
          const nowAt = ctx.currentTime;
          const elapsed = nowAt - lastClockSampleTime;
          const newSamples = Math.min(
            clockInBuffer.length,
            Math.max(1, Math.ceil(elapsed * ctx.sampleRate)),
          );
          const start = clockInBuffer.length - newSamples;
          const bpm = readParam('bpm', 120);
          const oneTickSec = 60 / Math.max(1, bpm) / 4;
          for (let i = start; i < clockInBuffer.length; i++) {
            const cur = clockInBuffer[i] ?? 0;
            if (lastClockSample < CLOCK_THRESHOLD && cur >= CLOCK_THRESHOLD) {
              advanceOneTick(nowAt + 0.005, oneTickSec);
            }
            lastClockSample = cur;
          }
          lastClockSampleTime = nowAt;
        } else {
          while (nextStepTime < ctx.currentTime + LOOKAHEAD_S) {
            const bpm = readParam('bpm', 120);
            const oneTickSec = 60 / Math.max(1, bpm) / 4;
            advanceOneTick(nextStepTime, oneTickSec);
            nextStepTime += oneTickSec;
          }
        }
      } catch (err) {
        console.error('[score] tick error', err);
      }
      if (alive) timeoutId = setTimeout(tick, TICK_MS);
    }
    timeoutId = setTimeout(tick, TICK_MS);

    return {
      domain: 'audio',
      inputs: new Map([
        ['clock',   { node: clockInGain, input: 0 }],
        ['attack',  { node: adsr, input: 0, param: pAttack! }],
        ['decay',   { node: adsr, input: 0, param: pDecay! }],
        ['sustain', { node: adsr, input: 0, param: pSustain! }],
        ['release', { node: adsr, input: 0, param: pRelease! }],
      ]),
      outputs: new Map([
        ['pitch', { node: pitchSrc, output: 0 }],
        ['gate',  { node: gateSrc,  output: 0 }],
        ['env',   { node: dynGain,  output: 0 }],
        ['clock', { node: clockOutSrc, output: 0 }],
      ]),
      setParam(paramId, value) {
        if (paramId === 'attack' || paramId === 'decay' || paramId === 'sustain' || paramId === 'release') {
          adsrParams.get(`${ADSR_PREFIX}/${paramId}`)?.setValueAtTime(value, ctx.currentTime);
        }
      },
      readParam(paramId) {
        if (paramId === 'attack' || paramId === 'decay' || paramId === 'sustain' || paramId === 'release') {
          return adsrParams.get(`${ADSR_PREFIX}/${paramId}`)?.value;
        }
        const live = livePatch.nodes[nodeId];
        const v = live?.params?.[paramId];
        return typeof v === 'number' ? v : undefined;
      },
      read(key) {
        if (key === 'currentNoteId')  return activeNoteId;
        if (key === 'absoluteTick')   return absoluteTick;
        if (key === 'totalAdvances')  return totalAdvances;
        if (key === 'lastDynamic')    return lastPlayedDynamic;
        if (key === 'lastDynamicScale') return DYNAMIC_SCALE[lastPlayedDynamic];
        return undefined;
      },
      dispose() {
        alive = false;
        if (timeoutId !== null) clearTimeout(timeoutId);
        try { gateSrc.stop(); } catch { /* */ }
        try { pitchSrc.stop(); } catch { /* */ }
        try { clockOutSrc.stop(); } catch { /* */ }
        try { clockInSilence.stop(); } catch { /* */ }
        gateSrc.disconnect();
        pitchSrc.disconnect();
        clockOutSrc.disconnect();
        clockInSilence.disconnect();
        clockInGain.disconnect();
        clockInAnalyser.disconnect();
        adsr.disconnect();
        dynGain.disconnect();
      },
    };
  },
};
