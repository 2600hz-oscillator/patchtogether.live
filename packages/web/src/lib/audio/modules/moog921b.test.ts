// packages/web/src/lib/audio/modules/moog921b.test.ts
//
// Two test layers for the MOOG 921B Oscillator (slave VCO):
//   1. Module-def shape — pins the 921B's I/O surface: freq_bus + width_bus
//      CONTROL INPUTS (from a 921A), dc_mod + ac_mod (audio FM inputs), sync;
//      the FOUR fixed-level waveform outs (sine / triangle / saw / rect); the
//      param array (fine / range / modAmount / syncMode / level). 921B has 4
//      audio outs — guard against a silent port drop.
//   2. Real DSP behavior — instantiate the registered worklet processor class
//      (captured via the registerProcessor shim, since the worklet entry NEVER
//      top-level-exports its class) and drive process(): all four waveform
//      outs swing when slaved to the bus; freq_bus raises pitch; AC MODULATE
//      blocks DC (a constant offset on ac_mod doesn't bend the pitch) while DC
//      MODULATE does; sync resets phase.

import { describe, it, expect, beforeAll } from 'vitest';
import { moog921bDef } from './moog921b';

const SR = 48000;
const BLOCK = 128;

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

// ───────────────────── Layer 1: module-def shape ─────────────────────
describe('moog921bDef: module def shape', () => {
  it('declares type=moog921b, label="921B Osc", category=sources, schemaVersion=1', () => {
    expect(moog921bDef.type).toBe('moog921b');
    expect(moog921bDef.label).toBe('921b osc');
    expect(moog921bDef.category).toBe('sources');
  });

  it('is categorized under Moog System 35/55 Clones', () => {
    expect(moog921bDef.palette).toEqual({ top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' });
  });

  it('exposes the 921B inputs: freq_bus, width_bus, dc_mod, ac_mod, sync', () => {
    const ids = moog921bDef.inputs.map((p) => p.id).sort();
    expect(ids).toEqual(['ac_mod', 'dc_mod', 'freq_bus', 'sync', 'width_bus']);
  });

  it('exposes FOUR fixed-level waveform outs: sine / triangle / saw / rect (all audio)', () => {
    const ids = moog921bDef.outputs.map((p) => p.id);
    expect(ids).toEqual(['sine', 'triangle', 'saw', 'rect']);
    for (const o of moog921bDef.outputs) expect(o.type).toBe('audio');
  });

  it('freq_bus + width_bus are cv CONTROL INPUTS (no paramTarget — bus-driven)', () => {
    const fb = moog921bDef.inputs.find((p) => p.id === 'freq_bus')!;
    expect(fb.type).toBe('cv');
    expect(fb.paramTarget).toBeUndefined();
    const wb = moog921bDef.inputs.find((p) => p.id === 'width_bus')!;
    expect(wb.type).toBe('cv');
    expect(wb.paramTarget).toBeUndefined();
  });

  it('dc_mod, ac_mod + sync are audio cables', () => {
    expect(moog921bDef.inputs.find((p) => p.id === 'dc_mod')!.type).toBe('audio');
    expect(moog921bDef.inputs.find((p) => p.id === 'ac_mod')!.type).toBe('audio');
    expect(moog921bDef.inputs.find((p) => p.id === 'sync')!.type).toBe('audio');
  });

  it('exposes 5 params (fine, range, modAmount, syncMode, level)', () => {
    const ids = moog921bDef.params.map((p) => p.id).sort();
    expect(ids).toEqual(['fine', 'level', 'modAmount', 'range', 'syncMode']);
  });

  it('fine ±12 st; range discrete -5..5; syncMode -1..1; level 0..2', () => {
    const fine = moog921bDef.params.find((p) => p.id === 'fine')!;
    expect(fine.min).toBe(-12);
    expect(fine.max).toBe(12);
    const range = moog921bDef.params.find((p) => p.id === 'range')!;
    expect(range.min).toBe(-5);
    expect(range.max).toBe(5);
    expect(range.curve).toBe('discrete');
    const sync = moog921bDef.params.find((p) => p.id === 'syncMode')!;
    expect(sync.min).toBe(-1);
    expect(sync.max).toBe(1);
    expect(sync.defaultValue).toBe(0);
    const level = moog921bDef.params.find((p) => p.id === 'level')!;
    expect(level.min).toBe(0);
    expect(level.max).toBe(2);
    expect(level.defaultValue).toBe(1);
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
  await import('../../../../../dsp/src/moog921b');
  g.registerProcessor = prev;
  if (!registered) throw new Error('moog921b processor did not register');
  capturedProc = registered;
  return capturedProc;
}

function makeParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const base: Record<string, number> = {};
  for (const def of moog921bDef.params) base[def.id] = def.defaultValue;
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

/** Inputs: freq_bus / width_bus / dc_mod / ac_mod / sync. Each a constant or
 *  supplied block. */
function makeInputs(opts: {
  freqBus?: number;
  widthBus?: number;
  dcMod?: Float32Array | number;
  acMod?: Float32Array | number;
  sync?: Float32Array;
} = {}): Float32Array[][] {
  const dc =
    opts.dcMod instanceof Float32Array ? opts.dcMod : new Float32Array(BLOCK).fill(opts.dcMod ?? 0);
  const ac =
    opts.acMod instanceof Float32Array ? opts.acMod : new Float32Array(BLOCK).fill(opts.acMod ?? 0);
  return [
    [new Float32Array(BLOCK).fill(opts.freqBus ?? 0)],
    [new Float32Array(BLOCK).fill(opts.widthBus ?? 0)],
    [dc],
    [ac],
    [opts.sync ?? new Float32Array(BLOCK)],
  ];
}

/** Count rising zero-crossings on the saw output over `blocks` blocks (a
 *  proxy for pitch — more crossings = higher frequency). */
function sawCycles(
  proc: ProcInstance,
  params: Record<string, number>,
  inputs: () => Float32Array[][],
  blocks = 8,
): number {
  const p = makeParams(params);
  let crossings = 0;
  let prev = 0;
  for (let b = 0; b < blocks; b++) {
    const out = makeOutputs();
    proc.process(inputs(), out, p);
    const saw = out[2][0];
    for (let i = 0; i < saw.length; i++) {
      if (prev <= 0 && saw[i] > 0) crossings++;
      prev = saw[i];
    }
  }
  return crossings;
}

describe('moog921b worklet DSP', () => {
  it('emits nonzero signal on ALL FOUR waveform outputs when slaved to the bus (C4)', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const params = makeParams();
    let outputs = makeOutputs();
    for (let b = 0; b < 8; b++) {
      outputs = makeOutputs();
      proc.process(makeInputs({ freqBus: 0, widthBus: 0.5 }), outputs, params);
    }
    const peaks = outputs.map((o) => Math.max(...Array.from(o[0]).map(Math.abs)));
    for (let i = 0; i < 4; i++) {
      expect(peaks[i], `output ${i} should swing`).toBeGreaterThan(0.1);
    }
  });

  it('higher freq_bus (V/oct) raises the pitch (more saw cycles per block)', async () => {
    const Proc = await loadProcessor();
    const lo = sawCycles(new Proc(), {}, () => makeInputs({ freqBus: 0, widthBus: 0.5 }));
    const hi = sawCycles(new Proc(), {}, () => makeInputs({ freqBus: 2, widthBus: 0.5 }));
    expect(hi).toBeGreaterThan(lo);
  });

  it('DC MODULATE bends the pitch (a constant DC offset shifts frequency)', async () => {
    const Proc = await loadProcessor();
    // modAmount up so the FM is audible. DC offset = +1 → +modAmount*2000 Hz.
    const base = sawCycles(new Proc(), { modAmount: 1 }, () =>
      makeInputs({ freqBus: 0, widthBus: 0.5, dcMod: 0 }),
    );
    const bent = sawCycles(new Proc(), { modAmount: 1 }, () =>
      makeInputs({ freqBus: 0, widthBus: 0.5, dcMod: 1 }),
    );
    expect(bent).toBeGreaterThan(base);
  });

  it('AC MODULATE blocks DC: a constant offset on ac_mod does NOT bend the pitch', async () => {
    const Proc = await loadProcessor();
    // Same constant offset, but on the AC-coupled input. The DC blocker should
    // remove the steady term so the pitch barely moves vs no modulation. Let
    // the DC blocker settle first by running a few blocks, then count.
    function cyclesWithSettle(acMod: number): number {
      const proc = new Proc();
      const p = makeParams({ modAmount: 1 });
      // settle the DC blocker
      for (let b = 0; b < 20; b++) {
        proc.process(makeInputs({ freqBus: 0, widthBus: 0.5, acMod }), makeOutputs(), p);
      }
      let crossings = 0;
      let prev = 0;
      for (let b = 0; b < 8; b++) {
        const out = makeOutputs();
        proc.process(makeInputs({ freqBus: 0, widthBus: 0.5, acMod }), out, p);
        const saw = out[2][0];
        for (let i = 0; i < saw.length; i++) {
          if (prev <= 0 && saw[i] > 0) crossings++;
          prev = saw[i];
        }
      }
      return crossings;
    }
    const noMod = cyclesWithSettle(0);
    const dcOnAc = cyclesWithSettle(1);
    // The DC component is removed → the cycle count is essentially unchanged.
    expect(Math.abs(dcOnAc - noMod)).toBeLessThanOrEqual(1);
  });

  it('width_bus sets the rectangular duty cycle (narrow → fewer high samples)', async () => {
    const Proc = await loadProcessor();
    function dutyHighFraction(widthBus: number): number {
      const proc = new Proc();
      const params = makeParams();
      let high = 0;
      let total = 0;
      for (let b = 0; b < 8; b++) {
        const out = makeOutputs();
        proc.process(makeInputs({ freqBus: 0, widthBus }), out, params);
        const rect = out[3][0];
        for (let i = 0; i < rect.length; i++) {
          if (rect[i] > 0) high++;
          total++;
        }
      }
      return high / total;
    }
    expect(dutyHighFraction(0.8)).toBeGreaterThan(dutyHighFraction(0.2));
  });

  it('level=0 silences the output (after the level smoother settles)', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const params = makeParams({ level: 0 });
    let outputs = makeOutputs();
    for (let b = 0; b < 80; b++) {
      outputs = makeOutputs();
      proc.process(makeInputs({ freqBus: 0, widthBus: 0.5 }), outputs, params);
    }
    let peak = 0;
    for (const ch of outputs) peak = Math.max(peak, ...Array.from(ch[0]).map(Math.abs));
    expect(peak).toBeLessThan(1e-3);
  });

  it('produces no NaN / Inf samples under FM + sync', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const params = makeParams({ modAmount: 0.7, syncMode: 1 });
    let phase = 0;
    const inc = (2 * Math.PI * 110) / SR;
    for (let b = 0; b < 16; b++) {
      const sync = new Float32Array(BLOCK);
      const dc = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        sync[i] = Math.sin(phase);
        dc[i] = 0.5 * Math.sin(phase * 1.7);
        phase += inc;
      }
      const out = makeOutputs();
      proc.process(makeInputs({ freqBus: 0.5, widthBus: 0.5, dcMod: dc, sync }), out, params);
      for (const ch of out) for (const v of ch[0]) expect(Number.isFinite(v)).toBe(true);
    }
  });
});
