// packages/web/src/lib/audio/modules/moog904b.test.ts
//
// Two test layers for the MOOG 904B VCF (transistor-ladder HPF):
//   1. Module-def shape — pins the 904B's I/O surface (audio in + cutoff_cv
//      CONTROL INPUT, the single high-pass output, the param array: cutoff /
//      range). Unlike the 904A there is NO regeneration param — guard that.
//   2. Real DSP behavior — instantiate the registered worklet processor class
//      (captured via the registerProcessor shim, since the worklet entry NEVER
//      top-level-exports its class) and drive process(): the high-pass passes
//      a tone above cutoff + attenuates one below, the RANGE switch shifts the
//      cutoff up, and the 1 V/oct cutoff_cv sweeps it.

import { describe, it, expect, beforeAll } from 'vitest';
import { moog904bDef } from './moog904b';

const SR = 48000;
const BLOCK = 128;

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

// ───────────────────── Layer 1: module-def shape ─────────────────────
describe('moog904bDef: module def shape', () => {
  it('declares type=moog904b, label="moogafakkin 904B VCF", category=filters, schemaVersion=1', () => {
    expect(moog904bDef.type).toBe('moog904b');
    expect(moog904bDef.label).toBe('moogafakkin 904B VCF');
    expect(moog904bDef.category).toBe('filters');
    expect(moog904bDef.schemaVersion).toBe(1);
  });

  it('is categorized under Clones → moogafakkin and uses the Moog904bVcfCard', () => {
    expect(moog904bDef.palette).toEqual({ top: 'Clones', sub: 'moogafakkin' });
    expect(moog904bDef.card).toBe('Moog904bVcfCard');
  });

  it('exposes the 904B inputs: audio + cutoff_cv (NO reso_cv — no resonance)', () => {
    const ids = moog904bDef.inputs.map((p) => p.id).sort();
    expect(ids).toEqual(['audio', 'cutoff_cv']);
  });

  it('exposes a single high-pass audio output', () => {
    expect(moog904bDef.outputs.map((p) => p.id)).toEqual(['audio']);
  });

  it('exposes 2 params (cutoff, range) — NO regeneration (the 904B has no resonance pot)', () => {
    const ids = moog904bDef.params.map((p) => p.id).sort();
    expect(ids).toEqual(['cutoff', 'range']);
    expect(moog904bDef.params.find((p) => p.id === 'regeneration')).toBeUndefined();
  });

  it('cutoff_cv: cv input, paramTarget=cutoff, no cvScale (audio-rate sum, PASSTHROUGH)', () => {
    const port = moog904bDef.inputs.find((p) => p.id === 'cutoff_cv')!;
    expect(port.type).toBe('cv');
    expect(port.paramTarget).toBe('cutoff');
    expect(port.cvScale).toBeUndefined();
  });

  it('cutoff is a log knob 4..20000 Hz; range is discrete 1..2', () => {
    const cutoff = moog904bDef.params.find((p) => p.id === 'cutoff')!;
    expect(cutoff.min).toBe(4);
    expect(cutoff.max).toBe(20000);
    expect(cutoff.curve).toBe('log');
    expect(cutoff.units).toBe('Hz');

    const range = moog904bDef.params.find((p) => p.id === 'range')!;
    expect(range.min).toBe(1);
    expect(range.max).toBe(2);
    expect(range.curve).toBe('discrete');
    expect(range.defaultValue).toBe(1);
  });
});

// ───────────────────── Layer 2: real worklet DSP ─────────────────────
type ProcInstance = {
  process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean;
};
type ProcCtor = new () => ProcInstance;
let capturedProc: ProcCtor | null = null;

async function loadProcessor(): Promise<ProcCtor> {
  if (capturedProc) return capturedProc;
  const g = globalThis as unknown as { registerProcessor?: (n: string, c: ProcCtor) => void };
  const prev = g.registerProcessor;
  let registered: ProcCtor | null = null;
  g.registerProcessor = (_n, ctor) => { registered = ctor; };
  await import('../../../../../dsp/src/moog904b');
  g.registerProcessor = prev;
  if (!registered) throw new Error('moog904b processor did not register');
  capturedProc = registered;
  return capturedProc;
}

function makeParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const base: Record<string, number> = {};
  for (const def of moog904bDef.params) base[def.id] = def.defaultValue;
  Object.assign(base, over);
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(base)) out[k] = new Float32Array([v]);
  return out;
}

function makeOutput(): Float32Array[][] {
  return [[new Float32Array(BLOCK)]];
}

/** Inputs: audio / cutoff_cv. */
function makeInputs(audioFill?: Float32Array, cutoffCv?: Float32Array): Float32Array[][] {
  return [
    [audioFill ?? new Float32Array(BLOCK)],
    [cutoffCv ?? new Float32Array(BLOCK)],
  ];
}

/** Steady-state RMS gain of a `freq` Hz sine through the filter. */
async function sineGain(
  Proc: ProcCtor,
  freq: number,
  params: Record<string, number>,
): Promise<number> {
  const proc = new Proc();
  const p = makeParams(params);
  let phase = 0;
  const inc = (2 * Math.PI * freq) / SR;
  let inSumSq = 0;
  let outSumSq = 0;
  let n = 0;
  const totalBlocks = 100;
  for (let b = 0; b < totalBlocks; b++) {
    const inBlk = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      inBlk[i] = 0.3 * Math.sin(phase);
      phase += inc;
    }
    const out = makeOutput();
    proc.process(makeInputs(inBlk), out, p);
    if (b >= totalBlocks / 2) {
      for (let i = 0; i < BLOCK; i++) {
        inSumSq += inBlk[i] * inBlk[i];
        outSumSq += out[0][0][i] * out[0][0][i];
        n++;
      }
    }
  }
  return Math.sqrt(outSumSq / n) / Math.sqrt(inSumSq / n);
}

describe('moog904b worklet DSP', () => {
  it('high-passes: passes a tone well above cutoff, attenuates one below', async () => {
    const Proc = await loadProcessor();
    const above = await sineGain(Proc, 6000, { cutoff: 1000, range: 1 });
    const below = await sineGain(Proc, 100, { cutoff: 1000, range: 1 });
    expect(above).toBeGreaterThan(0.7); // passband ~unity
    expect(below).toBeLessThan(0.2); // attenuated below cutoff
    expect(above).toBeGreaterThan(below * 4);
  });

  it('RANGE=HIGH shifts the cutoff up (a mid tone passes LESS than at LOW)', async () => {
    const Proc = await loadProcessor();
    // A 2 kHz tone sits near/above the 1 kHz cutoff at LOW (mostly passed) but
    // the HIGH range pushes the corner up (×2.83 → ~2.83 kHz) so the same tone
    // is now nearer the stopband → attenuated more.
    const low = await sineGain(Proc, 2000, { cutoff: 1000, range: 1 });
    const high = await sineGain(Proc, 2000, { cutoff: 1000, range: 2 });
    expect(low).toBeGreaterThan(high);
  });

  it('1 V/oct cutoff_cv raises the corner (a mid tone is attenuated more with +CV)', async () => {
    const Proc = await loadProcessor();
    function gainWithCv(cv: number): Promise<number> {
      // constant cutoff_cv across the block
      return (async () => {
        const proc = new Proc();
        const p = makeParams({ cutoff: 500, range: 1 });
        let phase = 0;
        const inc = (2 * Math.PI * 1000) / SR;
        let inSumSq = 0;
        let outSumSq = 0;
        let n = 0;
        const cutoffCv = new Float32Array(BLOCK).fill(cv);
        for (let b = 0; b < 100; b++) {
          const inBlk = new Float32Array(BLOCK);
          for (let i = 0; i < BLOCK; i++) {
            inBlk[i] = 0.3 * Math.sin(phase);
            phase += inc;
          }
          const out = makeOutput();
          proc.process(makeInputs(inBlk, cutoffCv), out, p);
          if (b >= 50) {
            for (let i = 0; i < BLOCK; i++) {
              inSumSq += inBlk[i] * inBlk[i];
              outSumSq += out[0][0][i] * out[0][0][i];
              n++;
            }
          }
        }
        return Math.sqrt(outSumSq / n) / Math.sqrt(inSumSq / n);
      })();
    }
    // cutoff_cv = +3 V → +3 octaves → corner from 500 Hz to 4 kHz, so the
    // 1 kHz tone moves from passband-ish into the stopband → attenuated more.
    const noCv = await gainWithCv(0);
    const hiCv = await gainWithCv(3);
    expect(hiCv).toBeLessThan(noCv);
  });

  it('does NOT self-oscillate — silence in stays silence out (no resonance)', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const params = makeParams({ cutoff: 1000, range: 1 });
    let out = makeOutput();
    for (let b = 0; b < 80; b++) {
      out = makeOutput();
      proc.process(makeInputs(), out, params);
    }
    let peak = 0;
    for (const v of out[0][0]) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThan(1e-6);
  });

  it('stays finite (no NaN/Inf) under an audio-rate cutoff_cv sweep', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const params = makeParams({ cutoff: 1000, range: 2 });
    let phase = 0;
    const inc = (2 * Math.PI * 220) / SR;
    for (let b = 0; b < 50; b++) {
      const audio = new Float32Array(BLOCK);
      const cutoffCv = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        audio[i] = Math.sin(phase);
        phase += inc;
        cutoffCv[i] = 3 * Math.sin((2 * Math.PI * 2000 * (b * BLOCK + i)) / SR);
      }
      const out = makeOutput();
      proc.process([[audio], [cutoffCv]], out, params);
      for (const v of out[0][0]) expect(Number.isFinite(v)).toBe(true);
    }
  });
});
