// packages/web/src/lib/audio/modules/moog904a.test.ts
//
// Two test layers for the MOOG 904A VCF (transistor-ladder LPF):
//   1. Module-def shape — pins the 904A's I/O surface (audio in + cutoff_cv +
//      reso_cv CONTROL INPUTS, the single low-pass output, the literal param
//      array: cutoff / range / regeneration) so a refactor that silently
//      drops a port fails loudly (the per-module-per-port regression class).
//   2. Real DSP behavior — instantiate the registered worklet processor class
//      (captured via the registerProcessor shim, since the worklet entry NEVER
//      top-level-exports its class — that would break ART's classic-script
//      eval) and drive process(): the low-pass attenuates a tone above cutoff,
//      regeneration sharpens the resonance, and the filter self-oscillates at
//      regeneration=1 with NO input (becomes a VC sine generator).

import { describe, it, expect, beforeAll } from 'vitest';
import { moog904aDef } from './moog904a';

const SR = 48000;
const BLOCK = 128;

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

// ───────────────────── Layer 1: module-def shape ─────────────────────
describe('moog904aDef: module def shape', () => {
  it('declares type=moog904a, label="moogafakkin 904A VCF", category=filters, schemaVersion=1', () => {
    expect(moog904aDef.type).toBe('moog904a');
    expect(moog904aDef.label).toBe('moogafakkin 904A VCF');
    expect(moog904aDef.category).toBe('filters');
    expect(moog904aDef.schemaVersion).toBe(1);
  });

  it('exposes the 904A inputs: audio + cutoff_cv + reso_cv', () => {
    const ids = moog904aDef.inputs.map((p) => p.id).sort();
    expect(ids).toEqual(['audio', 'cutoff_cv', 'reso_cv']);
  });

  it('exposes a single low-pass audio output', () => {
    const ids = moog904aDef.outputs.map((p) => p.id);
    expect(ids).toEqual(['audio']);
  });

  it('exposes 3 params (cutoff, range, regeneration)', () => {
    const ids = moog904aDef.params.map((p) => p.id).sort();
    expect(ids).toEqual(['cutoff', 'range', 'regeneration']);
  });

  it('audio input is an audio cable', () => {
    expect(moog904aDef.inputs.find((p) => p.id === 'audio')!.type).toBe('audio');
  });

  it('cutoff_cv: cv input, paramTarget=cutoff, no cvScale (audio-rate sum, PASSTHROUGH)', () => {
    const port = moog904aDef.inputs.find((p) => p.id === 'cutoff_cv')!;
    expect(port.type).toBe('cv');
    expect(port.paramTarget).toBe('cutoff');
    expect(port.cvScale).toBeUndefined();
  });

  it('reso_cv: cv input, paramTarget=regeneration, no cvScale (audio-rate sum, PASSTHROUGH)', () => {
    const port = moog904aDef.inputs.find((p) => p.id === 'reso_cv')!;
    expect(port.type).toBe('cv');
    expect(port.paramTarget).toBe('regeneration');
    expect(port.cvScale).toBeUndefined();
  });

  it('cutoff is a log knob spanning 20..20000 Hz; range is discrete 1..3; regeneration linear 0..1', () => {
    const cutoff = moog904aDef.params.find((p) => p.id === 'cutoff')!;
    expect(cutoff.min).toBe(20);
    expect(cutoff.max).toBe(20000);
    expect(cutoff.curve).toBe('log');
    expect(cutoff.units).toBe('Hz');

    const range = moog904aDef.params.find((p) => p.id === 'range')!;
    expect(range.min).toBe(1);
    expect(range.max).toBe(3);
    expect(range.curve).toBe('discrete');
    expect(range.defaultValue).toBe(2);

    const regen = moog904aDef.params.find((p) => p.id === 'regeneration')!;
    expect(regen.min).toBe(0);
    expect(regen.max).toBe(1);
    expect(regen.curve).toBe('linear');
    expect(regen.defaultValue).toBe(0);
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
  await import('../../../../../dsp/src/moog904a');
  g.registerProcessor = prev;
  if (!registered) throw new Error('moog904a processor did not register');
  capturedProc = registered;
  return capturedProc;
}

/** Build a params map (a-rate single-value buffers) from defaults + overrides. */
function makeParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const base: Record<string, number> = {};
  for (const def of moog904aDef.params) base[def.id] = def.defaultValue;
  Object.assign(base, over);
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(base)) out[k] = new Float32Array([v]);
  return out;
}

/** One mono output block. */
function makeOutput(): Float32Array[][] {
  return [[new Float32Array(BLOCK)]];
}

/** Inputs: audio / cutoff_cv / reso_cv. `audioFill` supplies the audio block. */
function makeInputs(audioFill?: Float32Array): Float32Array[][] {
  return [
    [audioFill ?? new Float32Array(BLOCK)],
    [new Float32Array(BLOCK)],
    [new Float32Array(BLOCK)],
  ];
}

/** Run a sine of `freq` Hz through the filter and return the steady-state
 *  RMS gain (measured after the filter transient settles). */
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
  const totalBlocks = 100; // ~0.27 s
  for (let b = 0; b < totalBlocks; b++) {
    const inBlk = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      inBlk[i] = 0.3 * Math.sin(phase);
      phase += inc;
    }
    const out = makeOutput();
    proc.process(makeInputs(inBlk), out, p);
    // Measure only the second half (settled).
    if (b >= totalBlocks / 2) {
      for (let i = 0; i < BLOCK; i++) {
        inSumSq += inBlk[i] * inBlk[i];
        outSumSq += out[0][0][i] * out[0][0][i];
        n++;
      }
    }
  }
  const inRms = Math.sqrt(inSumSq / n);
  const outRms = Math.sqrt(outSumSq / n);
  return outRms / inRms;
}

describe('moog904a worklet DSP', () => {
  it('low-passes: attenuates a tone well above cutoff, passes one below', async () => {
    const Proc = await loadProcessor();
    // range=1 (×1) so cutoff knob ≈ actual cutoff in Hz.
    const below = await sineGain(Proc, 200, { cutoff: 1000, range: 1, regeneration: 0 });
    const above = await sineGain(Proc, 6000, { cutoff: 1000, range: 1, regeneration: 0 });
    expect(below).toBeGreaterThan(0.7); // passband ~unity
    expect(above).toBeLessThan(0.1); // deep stopband
    expect(below).toBeGreaterThan(above * 5);
  });

  it('RANGE switch shifts the cutoff up (range=3 passes more highs than range=1)', async () => {
    const Proc = await loadProcessor();
    // A 3 kHz tone is in the stopband at range=1 (×1 → 1 kHz cutoff) but in
    // the passband at range=3 (×16 → 16 kHz cutoff).
    const lowRange = await sineGain(Proc, 3000, { cutoff: 1000, range: 1, regeneration: 0 });
    const hiRange = await sineGain(Proc, 3000, { cutoff: 1000, range: 3, regeneration: 0 });
    expect(hiRange).toBeGreaterThan(lowRange * 2);
  });

  it('regeneration sharpens the resonant peak (gain at cutoff rises with regen)', async () => {
    const Proc = await loadProcessor();
    const g0 = await sineGain(Proc, 1000, { cutoff: 1000, range: 1, regeneration: 0 });
    const g85 = await sineGain(Proc, 1000, { cutoff: 1000, range: 1, regeneration: 0.85 });
    expect(g85).toBeGreaterThan(g0 * 2);
  });

  it('self-oscillates into a sustained tone at regeneration=1 with NO input', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const params = makeParams({ cutoff: 1000, range: 1, regeneration: 1 });
    // PURE SILENCE input — the worklet's tiny thermal-noise dither (scaled
    // by regeneration^4) bootstraps the resonance into a sustained sine, the
    // way a real transistor ladder self-oscillates off circuit noise. No
    // impulse kick: this is exactly the e2e per-port scenario (regen=1, no
    // upstream) where the `audio` out must be a driven signal.
    let out = makeOutput();
    // Run ~0.5 s of silent input to let the oscillation build + measure the
    // final block.
    for (let b = 0; b < 190; b++) {
      out = makeOutput();
      proc.process(makeInputs(), out, params);
    }
    let peak = 0;
    for (const v of out[0][0]) peak = Math.max(peak, Math.abs(v));
    expect(peak, 'self-oscillation should sustain a tone').toBeGreaterThan(0.02);
  });

  it('does NOT self-oscillate at regeneration=0 (rings out to silence)', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const params = makeParams({ cutoff: 1000, range: 1, regeneration: 0 });
    const kick = new Float32Array(BLOCK);
    kick[0] = 1;
    let out = makeOutput();
    proc.process(makeInputs(kick), out, params);
    for (let b = 0; b < 80; b++) {
      out = makeOutput();
      proc.process(makeInputs(), out, params);
    }
    let peak = 0;
    for (const v of out[0][0]) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThan(1e-3);
  });

  it('stays finite (no NaN/Inf) under an audio-rate cutoff_cv sweep', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const params = makeParams({ cutoff: 1000, range: 2, regeneration: 0.8 });
    let phase = 0;
    const inc = (2 * Math.PI * 220) / SR;
    for (let b = 0; b < 50; b++) {
      const audio = new Float32Array(BLOCK);
      const cutoffCv = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        audio[i] = Math.sin(phase);
        phase += inc;
        // ±3 octaves of audio-rate cutoff modulation (1 V/oct exponential).
        cutoffCv[i] = 3 * Math.sin((2 * Math.PI * 2000 * (b * BLOCK + i)) / SR);
      }
      const out = makeOutput();
      proc.process([[audio], [cutoffCv], [new Float32Array(BLOCK)]], out, params);
      for (const v of out[0][0]) expect(Number.isFinite(v)).toBe(true);
    }
  });
});
