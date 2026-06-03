// packages/web/src/lib/audio/modules/moog921a.test.ts
//
// Two test layers for the MOOG 921A Oscillator Driver (CV processor):
//   1. Module-def shape — pins the 921A's I/O surface. It is CV-ONLY: NO
//      audio inputs, NO audio outputs. Inputs are the summing freq_cv (pitch)
//      + width_cv CONTROL INPUTS; outputs are the freq_bus + width_bus CV
//      buses that drive N 921B's; params are frequency / freqRange / width.
//      This guards the headline "921A has NO audio ports" invariant.
//   2. Real DSP behavior — instantiate the registered worklet processor class
//      (captured via the registerProcessor shim, since the worklet entry NEVER
//      top-level-exports its class — that would break ART's classic-script
//      eval) and drive process(): the freq_bus encodes pitch (V/oct), the
//      freqRange switch widens the compass, and width passes through onto
//      width_bus.

import { describe, it, expect, beforeAll } from 'vitest';
import { moog921aDef } from './moog921a';

const SR = 48000;
const BLOCK = 128;

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

// ───────────────────── Layer 1: module-def shape ─────────────────────
describe('moog921aDef: module def shape', () => {
  it('declares type=moog921a, label="moogafakkin 921A Driver", category=modulation, schemaVersion=1', () => {
    expect(moog921aDef.type).toBe('moog921a');
    expect(moog921aDef.label).toBe('moogafakkin 921A Driver');
    expect(moog921aDef.category).toBe('modulation');
    expect(moog921aDef.schemaVersion).toBe(1);
  });

  it('is categorized under Clones → moogafakkin', () => {
    expect(moog921aDef.palette).toEqual({ top: 'Clones', sub: 'moogafakkin' });
  });

  it('exposes the 921A inputs: freq_cv (pitch) + width_cv (cv)', () => {
    const ids = moog921aDef.inputs.map((p) => p.id).sort();
    expect(ids).toEqual(['freq_cv', 'width_cv']);
  });

  it('HAS NO AUDIO PORTS — it is a CV-only driver (headline invariant)', () => {
    const inAudio = moog921aDef.inputs.filter((p) => p.type === 'audio');
    const outAudio = moog921aDef.outputs.filter((p) => p.type === 'audio');
    expect(inAudio, '921A has no audio inputs').toEqual([]);
    expect(outAudio, '921A has no audio outputs').toEqual([]);
    // and specifically no audio_l / audio_r
    const allIds = [...moog921aDef.inputs, ...moog921aDef.outputs].map((p) => p.id);
    expect(allIds).not.toContain('audio_l');
    expect(allIds).not.toContain('audio_r');
    expect(allIds).not.toContain('audio');
  });

  it('exposes the two CV bus outputs: freq_bus + width_bus (both cv)', () => {
    expect(moog921aDef.outputs.map((p) => p.id)).toEqual(['freq_bus', 'width_bus']);
    for (const o of moog921aDef.outputs) expect(o.type).toBe('cv');
  });

  it('freq_cv is a pitch cable; width_cv is a cv cable; both PASSTHROUGH (no cvScale)', () => {
    const freq = moog921aDef.inputs.find((p) => p.id === 'freq_cv')!;
    expect(freq.type).toBe('pitch');
    expect(freq.paramTarget).toBe('frequency');
    expect(freq.cvScale).toBeUndefined();
    const width = moog921aDef.inputs.find((p) => p.id === 'width_cv')!;
    expect(width.type).toBe('cv');
    expect(width.paramTarget).toBe('width');
    expect(width.cvScale).toBeUndefined();
  });

  it('exposes 3 params (frequency, freqRange, width)', () => {
    const ids = moog921aDef.params.map((p) => p.id).sort();
    expect(ids).toEqual(['freqRange', 'frequency', 'width']);
  });

  it('frequency is linear -1..1; freqRange is discrete 1..2; width is linear 0..1', () => {
    const freq = moog921aDef.params.find((p) => p.id === 'frequency')!;
    expect(freq.min).toBe(-1);
    expect(freq.max).toBe(1);
    expect(freq.curve).toBe('linear');

    const range = moog921aDef.params.find((p) => p.id === 'freqRange')!;
    expect(range.min).toBe(1);
    expect(range.max).toBe(2);
    expect(range.curve).toBe('discrete');
    expect(range.defaultValue).toBe(1);

    const width = moog921aDef.params.find((p) => p.id === 'width')!;
    expect(width.min).toBe(0);
    expect(width.max).toBe(1);
    expect(width.curve).toBe('linear');
    expect(width.defaultValue).toBe(0.5);
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
  await import('../../../../../dsp/src/moog921a');
  g.registerProcessor = prev;
  if (!registered) throw new Error('moog921a processor did not register');
  capturedProc = registered;
  return capturedProc;
}

/** Build a params map (a-rate single-value buffers) from defaults + overrides. */
function makeParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const base: Record<string, number> = {};
  for (const def of moog921aDef.params) base[def.id] = def.defaultValue;
  Object.assign(base, over);
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(base)) out[k] = new Float32Array([v]);
  return out;
}

/** Two CV bus outputs (freq_bus / width_bus), one block each. */
function makeOutputs(): Float32Array[][] {
  return [[new Float32Array(BLOCK)], [new Float32Array(BLOCK)]];
}

/** Inputs: freq_cv / width_cv. Optional constant fills. */
function makeInputs(freqCv = 0, widthCv = 0): Float32Array[][] {
  return [
    [new Float32Array(BLOCK).fill(freqCv)],
    [new Float32Array(BLOCK).fill(widthCv)],
  ];
}

/** Run several blocks (let the smoother settle) and return the last sample of
 *  each bus output. */
function settle(proc: ProcInstance, params: Record<string, number>, freqCv = 0, widthCv = 0) {
  const p = makeParams(params);
  let out = makeOutputs();
  for (let b = 0; b < 80; b++) {
    out = makeOutputs();
    proc.process(makeInputs(freqCv, widthCv), out, p);
  }
  const last = BLOCK - 1;
  return { freqBus: out[0][0][last], widthBus: out[1][0][last] };
}

describe('moog921a worklet DSP', () => {
  it('FREQUENCY pot at +1 in SEMITONE range puts ~+1 octave on the freq bus', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const { freqBus } = settle(proc, { frequency: 1, freqRange: 1, width: 0.5 });
    // SEMITONE compass = ±1 octave, so frequency=+1 → ~+1.0 V/oct.
    expect(freqBus).toBeGreaterThan(0.9);
    expect(freqBus).toBeLessThan(1.1);
  });

  it('OCTAVE range gives a much wider freq compass than SEMITONE at the same pot', async () => {
    const Proc = await loadProcessor();
    const semi = settle(new Proc(), { frequency: 1, freqRange: 1, width: 0.5 }).freqBus;
    const oct = settle(new Proc(), { frequency: 1, freqRange: 2, width: 0.5 }).freqBus;
    // OCTAVE compass (±6 oct) ≫ SEMITONE (±1 oct).
    expect(oct).toBeGreaterThan(semi * 4);
  });

  it('summing freq CONTROL INPUT adds 1:1 onto the freq bus (V/oct passthrough)', async () => {
    const Proc = await loadProcessor();
    const base = settle(new Proc(), { frequency: 0, freqRange: 1, width: 0.5 }, 0).freqBus;
    const plus2 = settle(new Proc(), { frequency: 0, freqRange: 1, width: 0.5 }, 2).freqBus;
    // freq_cv is already V/oct → it sums straight through.
    expect(plus2 - base).toBeCloseTo(2, 1);
  });

  it('WIDTH knob passes through onto the width bus (0..1)', async () => {
    const Proc = await loadProcessor();
    const narrow = settle(new Proc(), { frequency: 0, freqRange: 1, width: 0.2 }).widthBus;
    const wide = settle(new Proc(), { frequency: 0, freqRange: 1, width: 0.8 }).widthBus;
    expect(narrow).toBeCloseTo(0.2, 1);
    expect(wide).toBeCloseTo(0.8, 1);
  });

  it('width CONTROL INPUT sums onto the width bus, clamped to 0..1', async () => {
    const Proc = await loadProcessor();
    const { widthBus } = settle(new Proc(), { frequency: 0, freqRange: 1, width: 0.5 }, 0, 0.3);
    expect(widthBus).toBeCloseTo(0.8, 1);
    // Over-drive clamps at 1.
    const clamped = settle(new Proc(), { frequency: 0, freqRange: 1, width: 0.9 }, 0, 0.9).widthBus;
    expect(clamped).toBeLessThanOrEqual(1);
    expect(clamped).toBeGreaterThan(0.99);
  });

  it('produces no NaN / Inf on either bus', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const params = makeParams({ frequency: 0.5, freqRange: 2, width: 0.5 });
    for (let b = 0; b < 16; b++) {
      const out = makeOutputs();
      proc.process(makeInputs(1.5, 0.2), out, params);
      for (const ch of out) for (const v of ch[0]) expect(Number.isFinite(v)).toBe(true);
    }
  });
});
