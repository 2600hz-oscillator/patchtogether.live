// packages/web/src/lib/audio/wavecel-factory-tables.ts
//
// Bundled factory wavetables for WAVECEL. Synthesized in code so the
// module is usable out-of-the-box without requiring the user to upload a
// WAV. The card UI also accepts E352-format WAV files (Synthesis
// Technology Cloud Terrarium / MakeNoise QPAS / etc.) at runtime via
// the wavetable-parser.
//
// Two tables, each 64 frames × 256 samples (the canonical E352 size):
//   1. BASIC SHAPES — saw → square → triangle → sine sweep. The classic
//      "starter" wavetable; lets users hear the morph param before
//      loading anything fancier.
//   2. HARMONIC SWEEP — additive harmonic stack: frame f gets harmonics
//      1..f+1 with falling amplitudes. Goes from a pure sine at frame 0
//      to a bright stack at frame 63.

import { WAVECEL_FRAME_SIZE } from './wavecel-math';

const FRAME_COUNT = 64;

export interface FactoryTable {
  id: string;
  label: string;
  frames: Float32Array[];
  source: string;
}

function makeBasicShapesTable(): Float32Array[] {
  const frames: Float32Array[] = [];
  for (let f = 0; f < FRAME_COUNT; f++) {
    const t = f / (FRAME_COUNT - 1);
    const arr = new Float32Array(WAVECEL_FRAME_SIZE);
    for (let s = 0; s < WAVECEL_FRAME_SIZE; s++) {
      const ph = s / WAVECEL_FRAME_SIZE;
      let v: number;
      if (t < 1 / 3) {
        const m = t * 3;
        const saw = ph < 0.5 ? 2 * ph : 2 * ph - 2;
        const sq = ph < 0.5 ? 1 : -1;
        v = saw * (1 - m) + sq * m;
      } else if (t < 2 / 3) {
        const m = (t - 1 / 3) * 3;
        const sq = ph < 0.5 ? 1 : -1;
        const tri =
          ph < 0.25 ? 4 * ph :
          ph < 0.75 ? 2 - 4 * ph :
          -4 + 4 * ph;
        v = sq * (1 - m) + tri * m;
      } else {
        const m = (t - 2 / 3) * 3;
        const tri =
          ph < 0.25 ? 4 * ph :
          ph < 0.75 ? 2 - 4 * ph :
          -4 + 4 * ph;
        const sn = Math.sin(2 * Math.PI * ph);
        v = tri * (1 - m) + sn * m;
      }
      arr[s] = v;
    }
    frames.push(arr);
  }
  return frames;
}

function makeHarmonicSweepTable(): Float32Array[] {
  const frames: Float32Array[] = [];
  for (let f = 0; f < FRAME_COUNT; f++) {
    const arr = new Float32Array(WAVECEL_FRAME_SIZE);
    const harmonics = f + 1;
    for (let s = 0; s < WAVECEL_FRAME_SIZE; s++) {
      const ph = s / WAVECEL_FRAME_SIZE;
      let v = 0;
      for (let h = 1; h <= harmonics; h++) {
        v += Math.sin(2 * Math.PI * ph * h) / h;
      }
      arr[s] = v;
    }
    let peak = 0;
    for (let s = 0; s < WAVECEL_FRAME_SIZE; s++) {
      const a = Math.abs(arr[s]!);
      if (a > peak) peak = a;
    }
    if (peak > 0) {
      const inv = 1 / peak;
      for (let s = 0; s < WAVECEL_FRAME_SIZE; s++) arr[s]! *= inv;
    }
    frames.push(arr);
  }
  return frames;
}

let _cache: FactoryTable[] | null = null;

export function getFactoryTables(): FactoryTable[] {
  if (_cache) return _cache;
  _cache = [
    {
      id: 'basic-shapes',
      label: 'BASIC SHAPES',
      frames: makeBasicShapesTable(),
      source: 'synthesized: saw → square → triangle → sine',
    },
    {
      id: 'harmonic-sweep',
      label: 'HARMONIC SWEEP',
      frames: makeHarmonicSweepTable(),
      source: 'synthesized: additive sine harmonics 1..N',
    },
  ];
  return _cache;
}

export function getFactoryTable(id: string): FactoryTable | undefined {
  return getFactoryTables().find((t) => t.id === id);
}

/** Convert frames to a plain JS array (Yjs-friendly transfer over postMessage,
 *  recall the DX7 SYX proxy bug from PR-94 where Yjs proxies failed
 *  structuredClone). */
export function framesToPlain(frames: Float32Array[]): number[][] {
  return frames.map((f) => Array.from(f));
}

export function framesFromPlain(plain: number[][]): Float32Array[] {
  return plain.map((arr) => Float32Array.from(arr));
}

export const DEFAULT_FACTORY_TABLE_ID = 'basic-shapes';
