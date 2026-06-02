// packages/web/src/lib/audio/modules/moog902.test.ts
//
// Two test layers for the MOOG 902 VCA (Moog System 55/35 clone, slice 3):
//   1. Module-def shape — pins the 902's I/O surface (the SIGNAL `audio`
//      input + the summing `cv` / `fcv` CONTROL INPUTS, the differential
//      output pair `audio` + `audio_inv`, the literal param array) so a
//      refactor that silently drops a port fails loudly.
//   2. Real DSP behavior — instantiate the registered worklet processor class
//      (captured via the registerProcessor shim, since the worklet entry NEVER
//      top-level-exports its class — that would break ART's classic-script
//      eval) and drive process(): the LINEAR vs EXPONENTIAL gain law, the ×2
//      anchor at pot-max / CV=6 V, the ×3 ceiling, CV summing, and the
//      sample-accurate inverted (differential −) output.

import { describe, it, expect, beforeAll } from 'vitest';
import { moog902Def } from './moog902';

const SR = 48000;
const BLOCK = 128;

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

// ───────────────────── Layer 1: module-def shape ─────────────────────
describe('moog902Def: module def shape', () => {
  it('declares type=moog902, label="Moog 902 VCA", category=utilities, schemaVersion=1', () => {
    expect(moog902Def.type).toBe('moog902');
    expect(moog902Def.label).toBe('Moog 902 VCA');
    expect(moog902Def.category).toBe('utilities');
    expect(moog902Def.schemaVersion).toBe(1);
  });

  it('exposes the 902 inputs: audio (SIGNAL) + cv + fcv summing CONTROL INPUTS', () => {
    const ids = moog902Def.inputs.map((p) => p.id).sort();
    expect(ids).toEqual(['audio', 'cv', 'fcv']);
  });

  it('exposes the differential output pair: audio (OUT) + audio_inv (OUT−)', () => {
    const ids = moog902Def.outputs.map((p) => p.id);
    expect(ids).toEqual(['audio', 'audio_inv']);
  });

  it('exposes 3 params (gain, cvAmount, mode)', () => {
    const ids = moog902Def.params.map((p) => p.id).sort();
    expect(ids).toEqual(['cvAmount', 'gain', 'mode']);
  });

  it('audio is an audio cable; cv + fcv are cv cables', () => {
    expect(moog902Def.inputs.find((p) => p.id === 'audio')!.type).toBe('audio');
    expect(moog902Def.inputs.find((p) => p.id === 'cv')!.type).toBe('cv');
    expect(moog902Def.inputs.find((p) => p.id === 'fcv')!.type).toBe('cv');
  });

  it('cv + fcv: cv inputs, paramTarget=gain, no cvScale (audio-rate sum, PASSTHROUGH)', () => {
    for (const id of ['cv', 'fcv']) {
      const port = moog902Def.inputs.find((p) => p.id === id)!;
      expect(port.type).toBe('cv');
      expect(port.paramTarget).toBe('gain');
      expect(port.cvScale).toBeUndefined();
    }
  });

  it('both outputs are audio cables (the differential pair)', () => {
    for (const id of ['audio', 'audio_inv']) {
      expect(moog902Def.outputs.find((p) => p.id === id)!.type).toBe('audio');
    }
  });

  it('gain spans 0..1 (default 0.5); cvAmount ±1; mode is a discrete 0/1 switch', () => {
    const gain = moog902Def.params.find((p) => p.id === 'gain')!;
    expect(gain.min).toBe(0);
    expect(gain.max).toBe(1);
    expect(gain.defaultValue).toBe(0.5);
    const cvAmount = moog902Def.params.find((p) => p.id === 'cvAmount')!;
    expect(cvAmount.min).toBe(-1);
    expect(cvAmount.max).toBe(1);
    expect(cvAmount.defaultValue).toBe(1);
    const mode = moog902Def.params.find((p) => p.id === 'mode')!;
    expect(mode.min).toBe(0);
    expect(mode.max).toBe(1);
    expect(mode.defaultValue).toBe(0);
    expect(mode.curve).toBe('discrete');
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
  await import('../../../../../dsp/src/moog902');
  g.registerProcessor = prev;
  if (!registered) throw new Error('moog902 processor did not register');
  capturedProc = registered;
  return capturedProc;
}

/** Build a params map (a-rate single-value buffers) from defaults + overrides. */
function makeParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const base: Record<string, number> = {};
  for (const def of moog902Def.params) base[def.id] = def.defaultValue;
  Object.assign(base, over);
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(base)) out[k] = new Float32Array([v]);
  return out;
}

/** Two mono outputs (audio + audio_inv), one block each. */
function makeOutputs(): Float32Array[][] {
  return [[new Float32Array(BLOCK)], [new Float32Array(BLOCK)]];
}

/**
 * Inputs: audio (constant DC), cv (constant volts), fcv (constant volts).
 * A constant DC signal lets us read the steady-state gain directly off the
 * output once the gain smoother settles.
 */
function makeInputs(audioDc = 1, cv = 0, fcv = 0): Float32Array[][] {
  return [
    [new Float32Array(BLOCK).fill(audioDc)],
    [new Float32Array(BLOCK).fill(cv)],
    [new Float32Array(BLOCK).fill(fcv)],
  ];
}

/**
 * Run enough blocks for the internal one-pole smoothers to settle, then
 * return the steady-state value of the main output's last sample. With a
 * constant DC input of 1, output ≈ gain multiplier.
 */
function settledGain(
  Proc: ProcCtor,
  params: Record<string, number>,
  inputs: { audioDc?: number; cv?: number; fcv?: number } = {},
): number {
  const proc = new Proc();
  const p = makeParams(params);
  const inp = makeInputs(inputs.audioDc ?? 1, inputs.cv ?? 0, inputs.fcv ?? 0);
  let outputs = makeOutputs();
  // ~0.2 s of blocks settles the 80 Hz smoothers well within 1e-3.
  for (let b = 0; b < 80; b++) {
    outputs = makeOutputs();
    proc.process(inp, outputs, p);
  }
  return outputs[0][0][BLOCK - 1];
}

describe('moog902 worklet DSP — gain law', () => {
  it('LINEAR: GAIN pot at max (gain=1 → 6 V control) yields ×2 (+6 dB)', async () => {
    const Proc = await loadProcessor();
    const g = settledGain(Proc, { gain: 1, mode: 0 }, { audioDc: 1 });
    expect(g).toBeCloseTo(2, 2);
  });

  it('LINEAR: CV = 6 V alone (gain pot=0) yields ×2 (the shared +6 dB anchor)', async () => {
    const Proc = await loadProcessor();
    // gain=0 → 0 V pot; cv=6, cvAmount=1 → 6 V control → ×2.
    const g = settledGain(Proc, { gain: 0, cvAmount: 1, mode: 0 }, { cv: 6 });
    expect(g).toBeCloseTo(2, 2);
  });

  it('LINEAR: a 0 V control sum (gain pot=0, no CV) is silent', async () => {
    const Proc = await loadProcessor();
    const g = settledGain(Proc, { gain: 0, cvAmount: 1, mode: 0 }, { cv: 0, fcv: 0 });
    expect(Math.abs(g)).toBeLessThan(1e-3);
  });

  it('LINEAR: gain rises linearly with control (3 V → ×1.0; half of the 6 V ×2 anchor)', async () => {
    const Proc = await loadProcessor();
    // gain=0.5 → 3 V → ×1.0 (unity).
    const g = settledGain(Proc, { gain: 0.5, mode: 0 }, { audioDc: 1 });
    expect(g).toBeCloseTo(1, 2);
  });

  it('EXPONENTIAL: passes through the SAME ×2 anchor at 6 V (gain=1)', async () => {
    const Proc = await loadProcessor();
    const g = settledGain(Proc, { gain: 1, mode: 1 }, { audioDc: 1 });
    expect(g).toBeCloseTo(2, 2);
  });

  it('EXP differs from LIN below the anchor (exp is lower at the same mid control)', async () => {
    const Proc = await loadProcessor();
    // At 3 V control: LINEAR → ×1.0; EXPONENTIAL → EXP_A*(e^(3/τ)-1) ≈ 0.709
    // (the exp curve fitted to ×2@6V + ×3@7.5V, τ ≈ 5.0102).
    const lin = settledGain(Proc, { gain: 0.5, mode: 0 }, { audioDc: 1 });
    const exp = settledGain(Proc, { gain: 0.5, mode: 1 }, { audioDc: 1 });
    expect(exp).toBeLessThan(lin);
    const tau = 5.0102;
    const a = 2 / (Math.exp(6 / tau) - 1);
    expect(exp).toBeCloseTo(a * (Math.exp(3 / tau) - 1), 2);
  });

  it('gain saturates at the ×3 ceiling for a large control sum (≥ ~9 V)', async () => {
    const Proc = await loadProcessor();
    // Pot max (6 V) + 6 V of CV = 12 V control → clamped to ×3 in both modes.
    const lin = settledGain(Proc, { gain: 1, cvAmount: 1, mode: 0 }, { cv: 6 });
    const exp = settledGain(Proc, { gain: 1, cvAmount: 1, mode: 1 }, { cv: 6 });
    expect(lin).toBeCloseTo(3, 2);
    expect(exp).toBeCloseTo(3, 2);
  });

  it('EXP reaches the ×3 ceiling at the ~7.5 V control-sum anchor', async () => {
    const Proc = await loadProcessor();
    // fcv biases the control sum directly. The EXP curve is fitted so 7.5 V
    // lands exactly on the ×3 ceiling.
    const exp = settledGain(Proc, { gain: 0, cvAmount: 1, mode: 1 }, { cv: 0, fcv: 7.5 });
    expect(exp).toBeCloseTo(3, 2);
  });
});

describe('moog902 worklet DSP — CV summing', () => {
  it('cvAmount scales the cv CONTROL INPUT (cvAmount=0.5 halves its volts)', async () => {
    const Proc = await loadProcessor();
    // gain=0 pot; cv=6, cvAmount=0.5 → 3 V control → ×1.0 (LINEAR).
    const g = settledGain(Proc, { gain: 0, cvAmount: 0.5, mode: 0 }, { cv: 6 });
    expect(g).toBeCloseTo(1, 2);
  });

  it('negative cvAmount subtracts the cv CONTROL INPUT from the control sum', async () => {
    const Proc = await loadProcessor();
    // gain=1 (6 V pot) + cv=3, cvAmount=-1 → 6 - 3 = 3 V → ×1.0 (LINEAR).
    const g = settledGain(Proc, { gain: 1, cvAmount: -1, mode: 0 }, { cv: 3 });
    expect(g).toBeCloseTo(1, 2);
  });

  it('the fcv bias sums onto the control alongside the gain pot + cv', async () => {
    const Proc = await loadProcessor();
    // gain=0 pot; fcv=6 V alone → ×2 (LINEAR), same as a 6 V cv.
    const g = settledGain(Proc, { gain: 0, cvAmount: 1, mode: 0 }, { fcv: 6 });
    expect(g).toBeCloseTo(2, 2);
  });

  it('gain pot + cv + fcv all sum into one control voltage', async () => {
    const Proc = await loadProcessor();
    // 1.5 V pot (gain=0.25) + 1.5 V fcv + 3 V cv (cvAmount=1) = 6 V → ×2.
    const g = settledGain(Proc, { gain: 0.25, cvAmount: 1, mode: 0 }, { cv: 3, fcv: 1.5 });
    expect(g).toBeCloseTo(2, 2);
  });
});

describe('moog902 worklet DSP — differential (inverted) output', () => {
  it('audio_inv (OUT−) is the sample-accurate phase-inverted twin of audio (OUT)', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    // A time-varying signal so the inversion is meaningful per-sample.
    const params = makeParams({ gain: 1, mode: 0 });
    const audio = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) audio[i] = Math.sin((2 * Math.PI * 440 * i) / SR);
    const inputs: Float32Array[][] = [[audio], [new Float32Array(BLOCK)], [new Float32Array(BLOCK)]];
    let outputs = makeOutputs();
    // Settle the gain smoother first, then capture one block.
    for (let b = 0; b < 80; b++) {
      outputs = makeOutputs();
      proc.process(inputs, outputs, params);
    }
    const out = outputs[0][0];
    const inv = outputs[1][0];
    for (let i = 0; i < BLOCK; i++) {
      expect(inv[i]).toBeCloseTo(-out[i], 6);
    }
    // And the inverted output is actually swinging (not all-zero).
    const peak = Math.max(...Array.from(inv).map(Math.abs));
    expect(peak).toBeGreaterThan(0.1);
  });
});

describe('moog902 worklet DSP — numeric hygiene', () => {
  it('produces no NaN / Inf samples on either output', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const params = makeParams({ gain: 1, cvAmount: 1, mode: 1 });
    for (let b = 0; b < 16; b++) {
      const outputs = makeOutputs();
      proc.process(makeInputs(1, 6, 6), outputs, params);
      for (const ch of outputs) {
        for (const v of ch[0]) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });
});
