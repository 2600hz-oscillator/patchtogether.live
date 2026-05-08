// packages/web/src/lib/audio/modules/score.ts
//
// SCORE — sheet-music sequencer module. Renders 2 rows × 4 bars (8 bars total,
// 4/4 fixed) as SVG and emits pitch / gate / env / clock CV. Internal ADSR
// (Faust adsr.wasm worklet) shapes the env output, scaled by the dynamic
// marker active at each tick (forward-fill: mf default, levels pp..ff).
//
// Scheduler model is the same two-clocks lookahead the Sequencer + Cartesian
// modules use: a setTimeout at TICK_MS reads node.params/data live, advances
// a 16th-rate tickIndex, and schedules pitch / gate / env events on the audio
// thread up to LOOKAHEAD_S ahead. External `clock` input overrides the
// internal BPM (rising-edge advance).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import { midiToVOct } from '$lib/audio/note-entry';
import wasmUrl from '@patchtogether.live/dsp/dist/adsr.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/adsr.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/adsr.worklet.js?url';
import {
  DYNAMIC_SCALE,
  TICKS_PER_BAR,
  TOTAL_BARS,
  TOTAL_TICKS,
  dynamicAt,
  emptyScoreData,
  tickWidth,
  type ScoreData,
  type ScoreNote,
  type DynamicMarker,
  type Tie,
} from './score-data';

const ADSR_PREFIX = '/ADSR';

function readScoreData(nodeId: string): ScoreData {
  const live = livePatch.nodes[nodeId];
  const raw = live?.data as Record<string, unknown> | undefined;
  if (!raw) return emptyScoreData();
  const notes = Array.isArray(raw.notes) ? (raw.notes as ScoreNote[]) : [];
  const dynamics = Array.isArray(raw.dynamics) ? (raw.dynamics as DynamicMarker[]) : [];
  const ties = Array.isArray(raw.ties) ? (raw.ties as Tie[]) : [];
  const ks = typeof raw.keySignature === 'number' ? (raw.keySignature as number) : 0;
  return { notes, dynamics, ties, keySignature: ks };
}

export const scoreDef: AudioModuleDef = {
  type: 'score',
  domain: 'audio',
  label: 'Score',
  category: 'modulation',
  schemaVersion: 1,
  inputs: [
    { id: 'clock', type: 'gate' },
    { id: 'attack', type: 'cv', paramTarget: 'attack' },
    { id: 'decay', type: 'cv', paramTarget: 'decay' },
    { id: 'sustain', type: 'cv', paramTarget: 'sustain' },
    { id: 'release', type: 'cv', paramTarget: 'release' },
  ],
  outputs: [
    { id: 'pitch', type: 'pitch' },
    { id: 'gate', type: 'gate' },
    { id: 'env', type: 'cv' },
    { id: 'clock', type: 'gate' },
  ],
  params: [
    { id: 'bpm', label: 'BPM', defaultValue: 120, min: 30, max: 300, curve: 'linear' },
    { id: 'attack', label: 'A', defaultValue: 0.005, min: 0.001, max: 10, curve: 'log', units: 's' },
    { id: 'decay', label: 'D', defaultValue: 0.1, min: 0.001, max: 10, curve: 'log', units: 's' },
    { id: 'sustain', label: 'S', defaultValue: 0.7, min: 0, max: 1, curve: 'linear' },
    { id: 'release', label: 'R', defaultValue: 0.3, min: 0.001, max: 10, curve: 'log', units: 's' },
    { id: 'isPlaying', label: 'Play', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const nodeId = node.id;

    // Internal ADSR worklet. Its gate input is driven by gateSrc; its output
    // is multiplied by dynGain to produce the final env CV.
    const adsr = await instantiateFaustModule(ctx, { name: 'adsr', wasmUrl, metaUrl, workletUrl });
    const adsrParams = adsr.parameters as unknown as Map<string, AudioParam>;
    function setAdsrParam(id: string, v: number) {
      adsrParams.get(`${ADSR_PREFIX}/${id}`)?.setValueAtTime(v, ctx.currentTime);
    }
    // Apply initial param values from the node.
    for (const def of scoreDef.params) {
      if (def.id === 'bpm' || def.id === 'isPlaying') continue;
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      setAdsrParam(def.id, v);
    }

    const pitchSrc = ctx.createConstantSource();
    const gateSrc = ctx.createConstantSource();
    const clockOutSrc = ctx.createConstantSource();
    pitchSrc.offset.value = 0;
    gateSrc.offset.value = 0;
    clockOutSrc.offset.value = 0;
    pitchSrc.start();
    gateSrc.start();
    clockOutSrc.start();

    // Wire gateSrc into the ADSR's gate input (input 0).
    gateSrc.connect(adsr);

    // ADSR -> dynGain -> env output port.
    const dynGain = ctx.createGain();
    dynGain.gain.value = DYNAMIC_SCALE.mf;
    adsr.connect(dynGain);

    // External clock input: AnalyserNode taps to detect rising edges.
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

    function emitClockPulse(atTime: number) {
      clockOutSrc.offset.setValueAtTime(1, atTime);
      clockOutSrc.offset.setValueAtTime(0, atTime + 0.01);
    }

    // ---- Tick loop ----
    // The score timeline is `TOTAL_TICKS` 16th-note slots (8 bars × 16 = 128
    // 16ths, expressed as 8 bars × 48 ticks-per-bar = 384 grid ticks; one
    // 16th = 3 grid ticks). We advance by 16th-note increments — each
    // advance moves `tickIndex` by 3.
    let tickIndex = 0;
    let nextStepTime = ctx.currentTime + 0.05;
    let prevPlaying = false;
    let alive = true;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const TICK_MS = 25;
    const LOOKAHEAD_S = 0.1;

    let currentNoteId: string | null = null;
    let lastEmittedVOct = 0;
    let lastEmittedGate = 0;
    let lastDynamicScale = DYNAMIC_SCALE.mf;
    let totalAdvances = 0;

    /** Look up a note that starts exactly at this absolute grid position. */
    function noteStartingAt(absTick: number, notes: ScoreNote[]): ScoreNote | null {
      const bar = Math.floor(absTick / TICKS_PER_BAR);
      const tick = absTick - bar * TICKS_PER_BAR;
      for (const n of notes) {
        if (n.bar === bar && n.tick === tick) return n;
      }
      return null;
    }

    /** Schedule the start (and gate-off) of one 16th-note slot's note (if
     *  any). `slotDurForGate` is how long the gate would stay on if the note
     *  ran exactly one 16th — we extend per the note's actual duration. */
    function emitTick(absTick: number, atTime: number, slotDur: number) {
      emitClockPulse(atTime);
      const data = readScoreData(nodeId);
      const note = noteStartingAt(absTick, data.notes);
      if (!note) {
        // No note starts here. We do NOT preemptively close the gate — the
        // previous note's scheduled gate-off handles that. Just advance.
        return;
      }
      // Forward-fill dynamic.
      const lvl = dynamicAt(note.bar, note.tick, data.dynamics);
      const dynScale = DYNAMIC_SCALE[lvl];
      lastDynamicScale = dynScale;
      try {
        dynGain.gain.setValueAtTime(dynScale, atTime);
      } catch { /* time may be in the past on audio thread; ignore */ }

      // Pitch as V/oct.
      const vOct = midiToVOct(note.midi);
      lastEmittedVOct = vOct;
      pitchSrc.offset.setValueAtTime(vOct, atTime);

      // Gate timing: held for the note's actual duration in seconds.
      // slotDur = duration of one 16th in seconds; one 16th = 3 grid ticks.
      const noteSec = (tickWidth(note.duration) / 3) * slotDur;
      gateSrc.offset.setValueAtTime(1, atTime);
      gateSrc.offset.setValueAtTime(0, atTime + noteSec * 0.95);
      lastEmittedGate = 1;
      currentNoteId = note.id;
    }

    function tick() {
      if (!alive) return;
      try {
        const isPlaying = readParam('isPlaying', 0) >= 0.5;
        const externalClock = isClockInConnected();

        if (isPlaying && !prevPlaying) {
          tickIndex = 0;
          nextStepTime = ctx.currentTime + 0.05;
          gateSrc.offset.cancelScheduledValues(ctx.currentTime);
          gateSrc.offset.setValueAtTime(0, ctx.currentTime);
          lastClockSample = 0;
          lastClockSampleTime = ctx.currentTime;
        } else if (!isPlaying && prevPlaying) {
          gateSrc.offset.cancelScheduledValues(ctx.currentTime);
          gateSrc.offset.setValueAtTime(0, ctx.currentTime);
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
          const slotDur = 60 / Math.max(1, bpm) / 4;
          for (let i = start; i < clockInBuffer.length; i++) {
            const cur = clockInBuffer[i] ?? 0;
            if (lastClockSample < CLOCK_THRESHOLD && cur >= CLOCK_THRESHOLD) {
              emitTick(tickIndex * 3, nowAt + 0.005, slotDur);
              tickIndex = (tickIndex + 1) % (TOTAL_TICKS / 3);
              totalAdvances++;
            }
            lastClockSample = cur;
          }
          lastClockSampleTime = nowAt;
        } else {
          while (nextStepTime < ctx.currentTime + LOOKAHEAD_S) {
            const bpm = readParam('bpm', 120);
            const slotDur = 60 / bpm / 4;
            emitTick(tickIndex * 3, nextStepTime, slotDur);
            nextStepTime += slotDur;
            tickIndex = (tickIndex + 1) % (TOTAL_TICKS / 3);
            totalAdvances++;
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
        ['clock', { node: clockInGain, input: 0 }],
        ['attack', { node: adsr, input: 0, param: adsrParams.get(`${ADSR_PREFIX}/attack`)! }],
        ['decay', { node: adsr, input: 0, param: adsrParams.get(`${ADSR_PREFIX}/decay`)! }],
        ['sustain', { node: adsr, input: 0, param: adsrParams.get(`${ADSR_PREFIX}/sustain`)! }],
        ['release', { node: adsr, input: 0, param: adsrParams.get(`${ADSR_PREFIX}/release`)! }],
      ]),
      outputs: new Map([
        ['pitch', { node: pitchSrc, output: 0 }],
        ['gate', { node: gateSrc, output: 0 }],
        ['env', { node: dynGain, output: 0 }],
        ['clock', { node: clockOutSrc, output: 0 }],
      ]),
      setParam(paramId, value) {
        if (paramId === 'bpm' || paramId === 'isPlaying') return;
        setAdsrParam(paramId, value);
      },
      readParam(paramId) {
        if (paramId === 'bpm' || paramId === 'isPlaying') {
          return readParam(paramId, 0);
        }
        return adsrParams.get(`${ADSR_PREFIX}/${paramId}`)?.value;
      },
      read(key) {
        if (key === 'currentNoteId') return currentNoteId;
        if (key === 'totalAdvances') return totalAdvances;
        if (key === 'pitchVOct') return lastEmittedVOct;
        if (key === 'gateValue') return lastEmittedGate;
        if (key === 'dynamicScale') return lastDynamicScale;
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
        clockInGain.disconnect();
        clockInAnalyser.disconnect();
        clockInSilence.disconnect();
        dynGain.disconnect();
        adsr.disconnect();
      },
    };
  },
};
