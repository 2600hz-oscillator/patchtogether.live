// packages/web/src/lib/audio/modules/drumseqz.ts
//
// 4-channel x 16-step drum sequencer with per-track Euclidean-fill slider +
// per-track quantized CV. Sister module to RIOTGIRLS — the canonical pairing
// is "DRUMSEQZ feeds RIOTGIRLS' four voice triggers + per-voice pitch CV".
//
// No Faust, no AudioWorklet — clones the existing Sequencer's setTimeout
// lookahead scheduler. Eight ConstantSource outputs (4 gate + 4 pitch) plus
// a chained clock-out.
//
// Per-track state in node.data.tracks[t].cells: 16 entries of
// `{ on: boolean, midi: number | null }`. midi === null means use track root.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import {
  coerceToNoteStep,
  midiToVOct,
  C3_MIDI,
  type NoteStep,
} from '$lib/audio/note-entry';
import { bjorklund } from '$lib/audio/euclidean';

export const TRACK_COUNT = 4;
export const STEP_COUNT = 16;

export type DrumCell = NoteStep;

export interface DrumTrack {
  cells: DrumCell[];
}

export interface DrumseqzData {
  tracks: DrumTrack[];
}

export function defaultCells(): DrumCell[] {
  return Array.from({ length: STEP_COUNT }, () => ({ on: false, midi: null }));
}

export function defaultTracks(): DrumTrack[] {
  return Array.from({ length: TRACK_COUNT }, () => ({ cells: defaultCells() }));
}

export function coerceToDrumCell(raw: unknown): DrumCell {
  return coerceToNoteStep(raw);
}

export function coerceToDrumTrack(raw: unknown): DrumTrack {
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (Array.isArray(r.cells)) {
      const cells = (r.cells as unknown[]).slice(0, STEP_COUNT).map(coerceToDrumCell);
      while (cells.length < STEP_COUNT) cells.push({ on: false, midi: null });
      return { cells };
    }
  }
  return { cells: defaultCells() };
}

export function coerceToDrumseqzTracks(raw: unknown): DrumTrack[] {
  if (Array.isArray(raw)) {
    const tracks = (raw as unknown[]).slice(0, TRACK_COUNT).map(coerceToDrumTrack);
    while (tracks.length < TRACK_COUNT) tracks.push({ cells: defaultCells() });
    return tracks;
  }
  return defaultTracks();
}

export const DEFAULT_TRACK_ROOT = [
  C3_MIDI,      // track 1: C3 (kick)
  C3_MIDI + 5,  // track 2: F3 (snare)
  C3_MIDI + 7,  // track 3: G3 (hat)
  C3_MIDI + 12, // track 4: C4 (perc)
];

/**
 * Apply the Euclidean fill policy: REWRITES the track's `on` flags to match
 * Bjorklund's distribution of `k` pulses across `n` steps. Per-cell pitch
 * (midi) is preserved — only the gate flag changes. Cells beyond n stay
 * untouched. Returns a NEW array; never mutates input.
 *
 * Pamela's-Workout convention: the slider is the source of truth for "what
 * does Euclidean want"; manual hand-toggling AFTER the slider move is the
 * override, until the next slider move rewrites again.
 */
export function applyEuclidean(cells: DrumCell[], k: number): DrumCell[] {
  const n = STEP_COUNT;
  const pattern = bjorklund(k, n);
  const out: DrumCell[] = [];
  for (let i = 0; i < n; i++) {
    const cur = cells[i] ?? { on: false, midi: null };
    out.push({ on: pattern[i] === 1, midi: cur.midi });
  }
  return out;
}

/**
 * Compute the V/oct a track will emit for a given cell. Pure function used
 * by both the runtime scheduler and unit tests (per-track pitch fall-through
 * math).
 *
 *   - cell.on must be true; otherwise returns null (silent).
 *   - cell.midi !== null  -> per-step pitch override
 *   - cell.midi === null  -> fall through to the track's `root` param
 *
 * Final V/oct = midiToVOct(midi) + trkOctave + globalOctave.
 */
export function cellVOct(
  cell: DrumCell,
  trackRoot: number,
  trackOctave: number,
  globalOctave: number,
): number | null {
  if (!cell.on) return null;
  const midi = cell.midi !== null ? cell.midi : trackRoot;
  return midiToVOct(midi) + trackOctave + globalOctave;
}

export const drumseqzDef: AudioModuleDef = {
  type: 'drumseqz',
  domain: 'audio',
  label: 'DRUMSEQZ',
  category: 'modulation',
  schemaVersion: 1,

  inputs: [
    { id: 'clock', type: 'gate' },
  ],
  outputs: [
    { id: 'gate1',  type: 'gate' },
    { id: 'pitch1', type: 'pitch' },
    { id: 'gate2',  type: 'gate' },
    { id: 'pitch2', type: 'pitch' },
    { id: 'gate3',  type: 'gate' },
    { id: 'pitch3', type: 'pitch' },
    { id: 'gate4',  type: 'gate' },
    { id: 'pitch4', type: 'pitch' },
    { id: 'clock',  type: 'gate' },
  ],
  params: [
    { id: 'bpm',        label: 'BPM',  defaultValue: 120, min: 30,  max: 300,  curve: 'linear' },
    { id: 'length',     label: 'Len',  defaultValue: 16,  min: 1,   max: 16,   curve: 'discrete' },
    { id: 'octave',     label: 'Oct',  defaultValue: 0,   min: -2,  max: 2,    curve: 'discrete' },
    { id: 'gateLength', label: 'Gate', defaultValue: 0.5, min: 0.1, max: 0.95, curve: 'linear' },
    { id: 'swing',      label: 'Sw',   defaultValue: 0,   min: 0,   max: 0.75, curve: 'linear' },
    { id: 'isPlaying',  label: 'Play', defaultValue: 0,   min: 0,   max: 1,    curve: 'discrete' },
    // Per-track Eucl pulse-count slider. 0 = off (all cells cleared).
    // The slider rewrites the track's cells via Bjorklund's algorithm; a
    // user can hand-toggle additional steps until the next slider move.
    { id: 'trk1_euclid', label: 'E1',  defaultValue: 0,    min: 0,    max: 16,  curve: 'discrete' },
    { id: 'trk2_euclid', label: 'E2',  defaultValue: 0,    min: 0,    max: 16,  curve: 'discrete' },
    { id: 'trk3_euclid', label: 'E3',  defaultValue: 0,    min: 0,    max: 16,  curve: 'discrete' },
    { id: 'trk4_euclid', label: 'E4',  defaultValue: 0,    min: 0,    max: 16,  curve: 'discrete' },
    // Per-track root (MIDI int) and octave shift.
    { id: 'trk1_root',   label: 'R1',  defaultValue: DEFAULT_TRACK_ROOT[0], min: 33,  max: 114, curve: 'discrete' },
    { id: 'trk2_root',   label: 'R2',  defaultValue: DEFAULT_TRACK_ROOT[1], min: 33,  max: 114, curve: 'discrete' },
    { id: 'trk3_root',   label: 'R3',  defaultValue: DEFAULT_TRACK_ROOT[2], min: 33,  max: 114, curve: 'discrete' },
    { id: 'trk4_root',   label: 'R4',  defaultValue: DEFAULT_TRACK_ROOT[3], min: 33,  max: 114, curve: 'discrete' },
    { id: 'trk1_octave', label: 'O1',  defaultValue: 0,    min: -2,   max: 2,   curve: 'discrete' },
    { id: 'trk2_octave', label: 'O2',  defaultValue: 0,    min: -2,   max: 2,   curve: 'discrete' },
    { id: 'trk3_octave', label: 'O3',  defaultValue: 0,    min: -2,   max: 2,   curve: 'discrete' },
    { id: 'trk4_octave', label: 'O4',  defaultValue: 0,    min: -2,   max: 2,   curve: 'discrete' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const nodeId = node.id;

    // Per-track gate + pitch ConstantSources.
    const gateSrcs: ConstantSourceNode[] = [];
    const pitchSrcs: ConstantSourceNode[] = [];
    for (let t = 0; t < TRACK_COUNT; t++) {
      const g = ctx.createConstantSource();
      g.offset.value = 0;
      g.start();
      gateSrcs.push(g);
      const p = ctx.createConstantSource();
      p.offset.value = 0;
      p.start();
      pitchSrcs.push(p);
    }
    const clockOutSrc = ctx.createConstantSource();
    clockOutSrc.offset.value = 0;
    clockOutSrc.start();

    // Clock input — same gate-detect rig as Sequencer.
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

    function readTracks(): DrumTrack[] {
      const live = livePatch.nodes[nodeId];
      const raw = (live?.data as Record<string, unknown> | undefined)?.tracks;
      return coerceToDrumseqzTracks(raw);
    }
    function readParam(id: string, fallback: number): number {
      const live = livePatch.nodes[nodeId];
      const v = live?.params?.[id];
      return typeof v === 'number' ? v : fallback;
    }

    let stepIndex = 0;
    let nextStepTime = ctx.currentTime + 0.05;
    let prevPlaying = false;
    let alive = true;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const LOOKAHEAD_S = 0.1;
    const TICK_MS = 25;

    // Per-track mirrors of last-emitted V/oct + gate (for tests + introspection).
    const lastEmittedVOct = new Array<number>(TRACK_COUNT).fill(0);
    const lastEmittedGate = new Array<number>(TRACK_COUNT).fill(0);

    function emitStep(idx: number, atTime: number, stepDurForGate: number) {
      const globalOctave = readParam('octave', 0);
      const gateLengthFrac = readParam('gateLength', 0.5);
      const tracks = readTracks();
      emitClockPulse(atTime);

      for (let t = 0; t < TRACK_COUNT; t++) {
        const track = tracks[t] ?? { cells: defaultCells() };
        const cell = track.cells[idx] ?? { on: false, midi: null };
        const root = readParam(`trk${t + 1}_root`, DEFAULT_TRACK_ROOT[t] ?? C3_MIDI);
        const trkOct = readParam(`trk${t + 1}_octave`, 0);
        const vOct = cellVOct(cell, root, trkOct, globalOctave);
        if (vOct !== null) {
          pitchSrcs[t]!.offset.setValueAtTime(vOct, atTime);
          gateSrcs[t]!.offset.setValueAtTime(1, atTime);
          gateSrcs[t]!.offset.setValueAtTime(0, atTime + stepDurForGate * gateLengthFrac);
          lastEmittedVOct[t] = vOct;
          lastEmittedGate[t] = 1;
        } else {
          // Hold-on-off-gate: pitch retains last value; gate reflects suppressed.
          lastEmittedGate[t] = 0;
        }
      }
    }

    function tick() {
      if (!alive) return;
      try {
        const isPlaying = readParam('isPlaying', 0) >= 0.5;
        const externalClock = isClockInConnected();

        if (isPlaying && !prevPlaying) {
          stepIndex = 0;
          currentStep = 0;
          nextStepTime = ctx.currentTime + 0.05;
          for (let t = 0; t < TRACK_COUNT; t++) {
            gateSrcs[t]!.offset.cancelScheduledValues(ctx.currentTime);
            gateSrcs[t]!.offset.setValueAtTime(0, ctx.currentTime);
            lastEmittedGate[t] = 0;
          }
          lastClockSample = 0;
          lastClockSampleTime = ctx.currentTime;
        } else if (!isPlaying && prevPlaying) {
          for (let t = 0; t < TRACK_COUNT; t++) {
            gateSrcs[t]!.offset.cancelScheduledValues(ctx.currentTime);
            gateSrcs[t]!.offset.setValueAtTime(0, ctx.currentTime);
            lastEmittedGate[t] = 0;
          }
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
          const length = Math.max(1, Math.round(readParam('length', 16)));
          const stepDurForGate = 60 / Math.max(1, bpm) / 4;
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
            const bpm = readParam('bpm', 120);
            const length = Math.max(1, Math.round(readParam('length', 16)));
            const swing = readParam('swing', 0);

            const stepDurBase = 60 / bpm / 4;
            const isOddStep = stepIndex % 2 === 1;
            const stepDur = isOddStep
              ? stepDurBase * (1 - swing * 0.5)
              : stepDurBase * (1 + swing * 0.5);

            emitStep(stepIndex, nextStepTime, stepDur);

            nextStepTime += stepDur;
            stepIndex = (stepIndex + 1) % length;
            currentStep = stepIndex;
            totalAdvances++;
          }
        }
      } catch (err) {
        console.error('[drumseqz] tick error', err);
      }
      if (alive) timeoutId = setTimeout(tick, TICK_MS);
    }

    let currentStep = 0;
    let totalAdvances = 0;
    timeoutId = setTimeout(tick, TICK_MS);

    const inputs = new Map<string, { node: AudioNode; input: number }>();
    inputs.set('clock', { node: clockInGain, input: 0 });

    const outputs = new Map<string, { node: AudioNode; output: number }>();
    for (let t = 0; t < TRACK_COUNT; t++) {
      outputs.set(`gate${t + 1}`,  { node: gateSrcs[t]!,  output: 0 });
      outputs.set(`pitch${t + 1}`, { node: pitchSrcs[t]!, output: 0 });
    }
    outputs.set('clock', { node: clockOutSrc, output: 0 });

    return {
      domain: 'audio',
      inputs,
      outputs,
      setParam(_paramId, _value) {
        // No AudioParam writes — tick reads node.params each iteration.
      },
      readParam(paramId) {
        const live = livePatch.nodes[nodeId];
        const v = live?.params?.[paramId];
        return typeof v === 'number' ? v : undefined;
      },
      read(key) {
        if (key === 'currentStep')   return currentStep;
        if (key === 'totalAdvances') return totalAdvances;
        if (typeof key === 'string' && key.startsWith('pitchVOct:')) {
          const t = Number.parseInt(key.slice('pitchVOct:'.length), 10);
          return Number.isFinite(t) && t >= 0 && t < TRACK_COUNT
            ? lastEmittedVOct[t]
            : undefined;
        }
        if (typeof key === 'string' && key.startsWith('gateValue:')) {
          const t = Number.parseInt(key.slice('gateValue:'.length), 10);
          return Number.isFinite(t) && t >= 0 && t < TRACK_COUNT
            ? lastEmittedGate[t]
            : undefined;
        }
        return undefined;
      },
      dispose() {
        alive = false;
        if (timeoutId !== null) clearTimeout(timeoutId);
        for (const g of gateSrcs)  { try { g.stop(); } catch { /* ok */ } g.disconnect(); }
        for (const p of pitchSrcs) { try { p.stop(); } catch { /* ok */ } p.disconnect(); }
        try { clockOutSrc.stop(); } catch { /* ok */ }
        try { clockInSilence.stop(); } catch { /* ok */ }
        clockOutSrc.disconnect();
        clockInSilence.disconnect();
        clockInGain.disconnect();
        clockInAnalyser.disconnect();
      },
    };
  },
};
