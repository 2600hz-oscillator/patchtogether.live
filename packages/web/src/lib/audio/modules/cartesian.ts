// packages/web/src/lib/audio/modules/cartesian.ts
//
// 4×4 grid sequencer (Make Noise René-style). Two modes:
//   linear   : clock advances row-major through 16 steps.
//   cartesian: clock just emits gate; X/Y CV inputs select column/row.
//
// Cells live in node.data.cells (length 16, row-major). Reads X/Y CV via
// AnalyserNodes the same way Sequencer reads its clock_in.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import {
  coerceToNoteStep,
  migrateStepArrayV1ToV2,
  C4_MIDI,
} from '$lib/audio/note-entry';
import {
  type ChordQuality,
  POLY_CHANNEL_PAIRS,
  chordVoicing,
  createPolySender,
  voicingToVOct,
} from '$lib/audio/poly';

export interface Cell {
  on: boolean;
  /** MIDI int (a4 = 69) for this cell's pitch, or null = no note. v1 of this
   *  module used `pitch: <semitones from C4>`. */
  midi: number | null;
  /** Stage-1 polyphony (v3). Defaults to 'mono' = legacy single-note behavior. */
  chord?: ChordQuality;
}

/** Normalize an arbitrary cell-like object to a v3 Cell (with chord). */
export function coerceToCartesianCell(raw: unknown): Cell {
  const base = coerceToNoteStep(raw);
  let chord: ChordQuality = 'mono';
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (r.chord === 'maj' || r.chord === 'min' || r.chord === 'mono') {
      chord = r.chord;
    }
  }
  return { on: base.on, midi: base.midi, chord };
}

export const CELL_COUNT = 16;
export const GRID_DIM = 4;

export function defaultCells(): Cell[] {
  return Array.from({ length: CELL_COUNT }, () => ({ on: false, midi: C4_MIDI, chord: 'mono' }));
}

export const cartesianDef: AudioModuleDef = {
  type: 'cartesian',
  domain: 'audio',
  label: 'Cartesian',
  category: 'modulation',
  // v2: per-cell pitch encoding changed from `pitch: semitones` to `midi: int|null`.
  //     See sequencer.ts for the matching change.
  // v3: per-cell optional `chord: 'mono' | 'maj' | 'min'` for Stage-1 polyphony.
  //     Pitch output port type changed to `polyPitchGate`. Backward-compat
  //     resolved by engine.addEdge → resolveConnection().
  schemaVersion: 3,
  migrate(data, fromVersion) {
    let migrated: Record<string, unknown> | undefined;
    if (fromVersion < 2) {
      migrated = migrateStepArrayV1ToV2(data, 'cells');
    } else if (data && typeof data === 'object') {
      migrated = { ...(data as Record<string, unknown>) };
    } else {
      migrated = undefined;
    }
    if (migrated && Array.isArray(migrated.cells)) {
      migrated.cells = (migrated.cells as unknown[]).map((c) => {
        const ns = coerceToCartesianCell(c);
        return { on: ns.on, midi: ns.midi, chord: ns.chord ?? 'mono' };
      });
    }
    return migrated;
  },

  inputs: [
    { id: 'clock', type: 'gate' },
    { id: 'x_cv', type: 'cv' },
    { id: 'y_cv', type: 'cv' },
  ],
  outputs: [
    { id: 'pitch', type: 'polyPitchGate' },
    { id: 'gate',  type: 'gate' },
    { id: 'clock', type: 'gate' },
  ],
  params: [
    { id: 'mode',       label: 'Mode', defaultValue: 0,   min: 0,   max: 1,    curve: 'discrete' },
    { id: 'octave',     label: 'Oct',  defaultValue: 0,   min: -2,  max: 2,    curve: 'discrete' },
    { id: 'gateLength', label: 'Gate', defaultValue: 0.5, min: 0.1, max: 0.95, curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // Stage-1 polyphony: pitch port is polyPitchGate (5 voice pairs).
    const polyPitch = createPolySender(ctx);
    const gateSrc      = ctx.createConstantSource();
    const clockOutSrc  = ctx.createConstantSource();
    gateSrc.offset.value = 0;
    clockOutSrc.offset.value = 0;
    gateSrc.start();
    clockOutSrc.start();

    function makeAnalyserPort() {
      const gain = ctx.createGain();
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      gain.connect(an);
      const buf = new Float32Array(an.fftSize);
      const sil = ctx.createConstantSource();
      sil.offset.value = 0;
      sil.start();
      sil.connect(gain);
      return { gain, an, buf, sil };
    }

    const clockIn = makeAnalyserPort();
    const xIn     = makeAnalyserPort();
    const yIn     = makeAnalyserPort();

    const nodeId = node.id;
    let lastClockSample = 0;
    let lastClockSampleTime = ctx.currentTime;
    const CLOCK_THRESHOLD = 0.5;

    let stepIndex = 0;
    let alive = true;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const TICK_MS = 25;

    function readCells(): Cell[] {
      const live = livePatch.nodes[nodeId];
      const cells = (live?.data as Record<string, unknown> | undefined)?.cells;
      if (Array.isArray(cells)) {
        return (cells as unknown[]).map(coerceToCartesianCell);
      }
      return defaultCells();
    }
    function readParam(id: string, fallback: number): number {
      const live = livePatch.nodes[nodeId];
      const v = live?.params?.[id];
      return typeof v === 'number' ? v : fallback;
    }

    function readMostRecent(buf: Float32Array): number {
      return buf[buf.length - 1] ?? 0;
    }

    function emitClockPulse(atTime: number) {
      clockOutSrc.offset.setValueAtTime(1, atTime);
      clockOutSrc.offset.setValueAtTime(0, atTime + 0.01);
    }

    let lastEmittedVOct = 0;
    let lastEmittedGate = 0;
    const lastEmittedLaneVOct = new Array<number>(POLY_CHANNEL_PAIRS).fill(0);
    const lastEmittedLaneGate = new Array<number>(POLY_CHANNEL_PAIRS).fill(0);

    function emitStep(idx: number, atTime: number, gateDur: number) {
      const octave = readParam('octave', 0);
      const gateLengthFrac = readParam('gateLength', 0.5);
      const cells = readCells();
      const cell = cells[idx];
      emitClockPulse(atTime);

      const baseMidi = cell && cell.on && cell.midi !== null ? cell.midi : null;
      const quality: ChordQuality = cell?.chord ?? 'mono';
      const voicing = chordVoicing(baseMidi, quality);
      const lanes = voicingToVOct(voicing).map((l) =>
        l.gate === 1 ? { pitch: l.pitch + octave, gate: 1 as const } : l,
      );
      const gateOff = gateDur * gateLengthFrac;
      polyPitch.scheduleStep(atTime, lanes, gateOff);

      for (let i = 0; i < POLY_CHANNEL_PAIRS; i++) {
        const l = lanes[i] ?? { pitch: 0, gate: 0 };
        lastEmittedLaneVOct[i] = l.pitch;
        lastEmittedLaneGate[i] = l.gate;
      }
      const anyGate = lanes.some((l) => l.gate === 1);
      if (anyGate) {
        gateSrc.offset.setValueAtTime(1, atTime);
        gateSrc.offset.setValueAtTime(0, atTime + gateOff);
        lastEmittedVOct = lanes[0]?.pitch ?? 0;
        lastEmittedGate = 1;
      } else {
        lastEmittedGate = 0;
      }
    }

    function tick() {
      if (!alive) return;
      try {
        clockIn.an.getFloatTimeDomainData(clockIn.buf);
        xIn.an.getFloatTimeDomainData(xIn.buf);
        yIn.an.getFloatTimeDomainData(yIn.buf);

        const mode = readParam('mode', 0) >= 0.5 ? 'cartesian' : 'linear';
        const nowAt = ctx.currentTime;
        const elapsed = nowAt - lastClockSampleTime;
        const newSamples = Math.min(
          clockIn.buf.length,
          Math.max(1, Math.ceil(elapsed * ctx.sampleRate)),
        );
        const start = clockIn.buf.length - newSamples;
        const gateDur = Math.max(0.01, elapsed);

        for (let i = start; i < clockIn.buf.length; i++) {
          const cur = clockIn.buf[i] ?? 0;
          if (lastClockSample < CLOCK_THRESHOLD && cur >= CLOCK_THRESHOLD) {
            let idx: number;
            if (mode === 'cartesian') {
              const x = readMostRecent(xIn.buf);
              const y = readMostRecent(yIn.buf);
              const col = Math.max(0, Math.min(GRID_DIM - 1, Math.floor((x + 1) / 2 * GRID_DIM)));
              const row = Math.max(0, Math.min(GRID_DIM - 1, Math.floor((y + 1) / 2 * GRID_DIM)));
              idx = row * GRID_DIM + col;
              currentStep = idx;
            } else {
              idx = stepIndex;
              stepIndex = (stepIndex + 1) % CELL_COUNT;
              currentStep = idx;
            }
            emitStep(idx, nowAt + 0.005, gateDur);
            totalAdvances++;
          }
          lastClockSample = cur;
        }
        lastClockSampleTime = nowAt;
      } catch (err) {
        console.error('[cartesian] tick error', err);
      }
      if (alive) timeoutId = setTimeout(tick, TICK_MS);
    }

    let currentStep = 0;
    let totalAdvances = 0;
    timeoutId = setTimeout(tick, TICK_MS);

    return {
      domain: 'audio',
      inputs: new Map([
        ['clock', { node: clockIn.gain, input: 0 }],
        ['x_cv',  { node: xIn.gain,     input: 0 }],
        ['y_cv',  { node: yIn.gain,     input: 0 }],
      ]),
      outputs: new Map([
        ['pitch', { node: polyPitch.output, output: 0 }],
        ['gate',  { node: gateSrc,  output: 0 }],
        ['clock', { node: clockOutSrc, output: 0 }],
      ]),
      setParam(_paramId, _value) {
        // Live-read from node.params each tick.
      },
      readParam(paramId) {
        const live = livePatch.nodes[nodeId];
        const v = live?.params?.[paramId];
        return typeof v === 'number' ? v : undefined;
      },
      read(key) {
        if (key === 'currentStep')   return currentStep;
        if (key === 'totalAdvances') return totalAdvances;
        if (key === 'pitchVOct')     return lastEmittedVOct;
        if (key === 'gateValue')     return lastEmittedGate;
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
        return undefined;
      },
      dispose() {
        alive = false;
        if (timeoutId !== null) clearTimeout(timeoutId);
        try { gateSrc.stop(); } catch { /* */ }
        try { clockOutSrc.stop(); } catch { /* */ }
        try { clockIn.sil.stop(); } catch { /* */ }
        try { xIn.sil.stop(); } catch { /* */ }
        try { yIn.sil.stop(); } catch { /* */ }
        polyPitch.dispose();
        gateSrc.disconnect();
        clockOutSrc.disconnect();
        clockIn.sil.disconnect();   clockIn.gain.disconnect(); clockIn.an.disconnect();
        xIn.sil.disconnect();       xIn.gain.disconnect();     xIn.an.disconnect();
        yIn.sil.disconnect();       yIn.gain.disconnect();     yIn.an.disconnect();
      },
    };
  },
};
