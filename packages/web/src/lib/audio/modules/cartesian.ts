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

export interface Cell {
  on: boolean;
  pitch: number; // semitones from root
}

export const CELL_COUNT = 16;
export const GRID_DIM = 4;

export function defaultCells(): Cell[] {
  return Array.from({ length: CELL_COUNT }, () => ({ on: false, pitch: 0 }));
}

export const cartesianDef: AudioModuleDef = {
  type: 'cartesian',
  domain: 'audio',
  label: 'Cartesian',
  category: 'modulation',
  schemaVersion: 1,

  inputs: [
    { id: 'clock', type: 'gate' },
    { id: 'x_cv', type: 'cv' },
    { id: 'y_cv', type: 'cv' },
  ],
  outputs: [
    { id: 'pitch', type: 'pitch' },
    { id: 'gate',  type: 'gate' },
    { id: 'clock', type: 'gate' },
  ],
  params: [
    { id: 'mode',       label: 'Mode', defaultValue: 0,   min: 0,   max: 1,    curve: 'discrete' },
    { id: 'octave',     label: 'Oct',  defaultValue: 0,   min: -2,  max: 2,    curve: 'discrete' },
    { id: 'gateLength', label: 'Gate', defaultValue: 0.5, min: 0.1, max: 0.95, curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const pitchSrc     = ctx.createConstantSource();
    const gateSrc      = ctx.createConstantSource();
    const clockOutSrc  = ctx.createConstantSource();
    pitchSrc.offset.value = 0;
    gateSrc.offset.value = 0;
    clockOutSrc.offset.value = 0;
    pitchSrc.start();
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
      if (Array.isArray(cells)) return cells as Cell[];
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

    function emitStep(idx: number, atTime: number, gateDur: number) {
      const octave = readParam('octave', 0);
      const gateLengthFrac = readParam('gateLength', 0.5);
      const cells = readCells();
      const cell = cells[idx];
      emitClockPulse(atTime);
      if (cell && cell.on) {
        const semitones = cell.pitch + octave * 12;
        const vOct = semitones / 12;
        pitchSrc.offset.setValueAtTime(vOct, atTime);
        gateSrc.offset.setValueAtTime(1, atTime);
        gateSrc.offset.setValueAtTime(0, atTime + gateDur * gateLengthFrac);
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
        ['pitch', { node: pitchSrc, output: 0 }],
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
        return undefined;
      },
      dispose() {
        alive = false;
        if (timeoutId !== null) clearTimeout(timeoutId);
        try { pitchSrc.stop(); } catch { /* */ }
        try { gateSrc.stop(); } catch { /* */ }
        try { clockOutSrc.stop(); } catch { /* */ }
        try { clockIn.sil.stop(); } catch { /* */ }
        try { xIn.sil.stop(); } catch { /* */ }
        try { yIn.sil.stop(); } catch { /* */ }
        pitchSrc.disconnect();
        gateSrc.disconnect();
        clockOutSrc.disconnect();
        clockIn.sil.disconnect();   clockIn.gain.disconnect(); clockIn.an.disconnect();
        xIn.sil.disconnect();       xIn.gain.disconnect();     xIn.an.disconnect();
        yIn.sil.disconnect();       yIn.gain.disconnect();     yIn.an.disconnect();
      },
    };
  },
};
