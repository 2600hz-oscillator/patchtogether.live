// packages/web/src/lib/audio/modules/moog921-vco.test.ts
//
// Two test layers for the MOOG 921 VCO:
//   1. Module-def shape — pins the 921's I/O surface (pitch + lin-FM + sync
//      + width-CV inputs, the four simultaneous waveform outputs, the literal
//      param array) so a refactor that silently drops a port fails loudly
//      (the per-module-per-port regression-net class of bug).
//   2. Real DSP behavior — instantiate the registered worklet processor class
//      (captured via the registerProcessor shim, since the worklet entry NEVER
//      top-level-exports its class — that would break ART's classic-script
//      eval) and drive process(): a C4 V/oct input yields nonzero output on
//      all four waveform jacks; width changes the rectangular duty cycle.

import { describe, it, expect, beforeAll } from 'vitest';
import { moog921VcoDef } from './moog921-vco';

const SR = 48000;
const BLOCK = 128;

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

// ───────────────────── Layer 1: module-def shape ─────────────────────
describe('moog921VcoDef: module def shape', () => {
  it('declares type=moog921Vco, label="921 VCO", category=sources, schemaVersion=1', () => {
    expect(moog921VcoDef.type).toBe('moog921Vco');
    expect(moog921VcoDef.label).toBe('921 VCO');
    expect(moog921VcoDef.category).toBe('sources');
    expect(moog921VcoDef.schemaVersion).toBe(1);
  });

  it('exposes the 921 inputs: pitch, lin_fm, sync, width_cv + octave/tune/linFmAmount/level CV', () => {
    const ids = moog921VcoDef.inputs.map((p) => p.id).sort();
    expect(ids).toEqual([
      'level', 'linFmAmount', 'lin_fm', 'octave', 'pitch', 'sync', 'tune', 'width_cv',
    ]);
  });

  it('exposes the four simultaneous 921 waveform outputs', () => {
    const ids = moog921VcoDef.outputs.map((p) => p.id);
    expect(ids).toEqual(['sine', 'triangle', 'sawtooth', 'rectangular']);
  });

  it('exposes 6 params (octave, tune, width, linFmAmount, sync, level)', () => {
    const ids = moog921VcoDef.params.map((p) => p.id).sort();
    expect(ids).toEqual(['level', 'linFmAmount', 'octave', 'sync', 'tune', 'width']);
  });

  it('pitch input is a 1V/oct pitch cable; lin_fm + sync are audio cables', () => {
    expect(moog921VcoDef.inputs.find((p) => p.id === 'pitch')!.type).toBe('pitch');
    expect(moog921VcoDef.inputs.find((p) => p.id === 'lin_fm')!.type).toBe('audio');
    expect(moog921VcoDef.inputs.find((p) => p.id === 'sync')!.type).toBe('audio');
  });

  it('width_cv: cv input, paramTarget=width, no cvScale (audio-rate sum, PASSTHROUGH)', () => {
    const port = moog921VcoDef.inputs.find((p) => p.id === 'width_cv')!;
    expect(port.type).toBe('cv');
    expect(port.paramTarget).toBe('width');
    expect(port.cvScale).toBeUndefined();
  });

  it('octave / tune / linFmAmount / level: cv inputs with linear cvScale to their params', () => {
    for (const id of ['octave', 'tune', 'linFmAmount', 'level']) {
      const port = moog921VcoDef.inputs.find((p) => p.id === id)!;
      expect(port.type).toBe('cv');
      expect(port.paramTarget).toBe(id);
      expect(port.cvScale).toEqual({ mode: 'linear' });
    }
  });

  it('octave param spans ±5 octaves; tune ±12 semitones; width is bounded 0.02..0.98', () => {
    const octave = moog921VcoDef.params.find((p) => p.id === 'octave')!;
    expect(octave.min).toBe(-5);
    expect(octave.max).toBe(5);
    const tune = moog921VcoDef.params.find((p) => p.id === 'tune')!;
    expect(tune.min).toBe(-12);
    expect(tune.max).toBe(12);
    const width = moog921VcoDef.params.find((p) => p.id === 'width')!;
    expect(width.min).toBe(0.02);
    expect(width.max).toBe(0.98);
    expect(width.defaultValue).toBe(0.5);
  });

  it('sync param spans the -1/0/+1 three-way switch (soft / off / hard)', () => {
    const sync = moog921VcoDef.params.find((p) => p.id === 'sync')!;
    expect(sync.min).toBe(-1);
    expect(sync.max).toBe(1);
    expect(sync.defaultValue).toBe(0);
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
  // Relative path into the DSP source — worktrees may not have the workspace
  // package symlinked under node_modules.
  await import('../../../../../dsp/src/moog921-vco');
  g.registerProcessor = prev;
  if (!registered) throw new Error('moog921-vco processor did not register');
  capturedProc = registered;
  return capturedProc;
}

/** Build a params map (a-rate single-value buffers) from defaults + overrides. */
function makeParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const base: Record<string, number> = {};
  for (const def of moog921VcoDef.params) base[def.id] = def.defaultValue;
  Object.assign(base, over);
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(base)) out[k] = new Float32Array([v]);
  return out;
}

/** Four mono outputs (sine/tri/saw/rect), one block each. */
function makeOutputs(): Float32Array[][] {
  return [
    [new Float32Array(BLOCK)],
    [new Float32Array(BLOCK)],
    [new Float32Array(BLOCK)],
    [new Float32Array(BLOCK)],
  ];
}

/** Inputs: pitch / lin_fm / sync / width_cv. pitch is a constant V/oct value. */
function makeInputs(voct = 0): Float32Array[][] {
  return [
    [new Float32Array(BLOCK).fill(voct)],
    [new Float32Array(BLOCK)],
    [new Float32Array(BLOCK)],
    [new Float32Array(BLOCK)],
  ];
}

describe('moog921-vco worklet DSP', () => {
  it('emits nonzero signal on ALL FOUR waveform outputs at C4', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const inputs = makeInputs(0);
    const params = makeParams();
    // Run several blocks so the phase moves through a full cycle.
    let outputs = makeOutputs();
    for (let b = 0; b < 8; b++) {
      outputs = makeOutputs();
      proc.process(inputs, outputs, params);
    }
    const peaks = outputs.map((o) => Math.max(...Array.from(o[0]).map(Math.abs)));
    // sine / triangle / sawtooth / rectangular all swing.
    for (let i = 0; i < 4; i++) {
      expect(peaks[i], `output ${i} should swing`).toBeGreaterThan(0.1);
    }
  });

  it('higher pitch CV makes the sawtooth complete more cycles per block', async () => {
    const Proc = await loadProcessor();
    function cycles(voct: number): number {
      const proc = new Proc();
      const params = makeParams();
      let crossings = 0;
      let prev = 0;
      for (let b = 0; b < 4; b++) {
        const outputs = makeOutputs();
        proc.process(makeInputs(voct), outputs, params);
        const saw = outputs[2][0];
        for (let i = 0; i < saw.length; i++) {
          if (prev <= 0 && saw[i] > 0) crossings++;
          prev = saw[i];
        }
      }
      return crossings;
    }
    expect(cycles(2)).toBeGreaterThan(cycles(0));
  });

  it('pulse width sets the rectangular duty cycle (narrow width → fewer high samples)', async () => {
    const Proc = await loadProcessor();
    function dutyHighFraction(width: number): number {
      const proc = new Proc();
      const params = makeParams({ width });
      let high = 0;
      let total = 0;
      for (let b = 0; b < 8; b++) {
        const outputs = makeOutputs();
        proc.process(makeInputs(0), outputs, params);
        const rect = outputs[3][0];
        for (let i = 0; i < rect.length; i++) {
          if (rect[i] > 0) high++;
          total++;
        }
      }
      return high / total;
    }
    const narrow = dutyHighFraction(0.2);
    const wide = dutyHighFraction(0.8);
    expect(wide).toBeGreaterThan(narrow);
  });

  it('level=0 silences the output (after the level smoother settles)', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const params = makeParams({ level: 0 });
    // The output level is one-pole smoothed (~80 Hz) from its primed default
    // of 1 down to 0, so the first few ms still ring. Run ~0.2 s of blocks to
    // let the smoother settle, then measure only the final block's peak.
    let outputs = makeOutputs();
    for (let b = 0; b < 80; b++) {
      outputs = makeOutputs();
      proc.process(makeInputs(0), outputs, params);
    }
    let peak = 0;
    for (const ch of outputs) peak = Math.max(peak, ...Array.from(ch[0]).map(Math.abs));
    expect(peak).toBeLessThan(1e-3);
  });

  it('produces no NaN / Inf samples', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const params = makeParams();
    for (let b = 0; b < 16; b++) {
      const outputs = makeOutputs();
      proc.process(makeInputs(0.5), outputs, params);
      for (const ch of outputs) {
        for (const v of ch[0]) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });
});
