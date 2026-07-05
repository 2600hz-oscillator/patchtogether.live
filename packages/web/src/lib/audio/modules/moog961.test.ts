// packages/web/src/lib/audio/modules/moog961.test.ts
//
// Two test layers for the MOOG 961 INTERFACE (moogafakkin System 55 clone, batch 5):
//   1. Module-def shape — pins the 961's I/O surface (audio_in + 3 gate inputs,
//      4 gate outputs, the sensitivity / switchOnTime param array) so a
//      refactor that silently drops a port / param fails loudly (the
//      per-module-per-port regression-net class of bug).
//   2. Real DSP behaviour — instantiate the worklet processor class directly
//      (captured via a registerProcessor shim, since the entry NEVER exports
//      its class) and drive process() to assert: the audio→trigger threshold
//      fires v_out1 + v_out2, s_in passes through to the V outs, v_in_a is
//      width-matched onto s_out_a, and v_in_b emits a FIXED-WIDTH one-shot on
//      s_out_b sized by switchOnTime.

import { describe, it, expect, beforeAll } from 'vitest';
import { moog961Def } from './moog961';

const SR = 48000;

// The worklet reads bare global `sampleRate` in its constructor; set it BEFORE
// we trigger the dynamic import below.
beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

// Capture the registered processor class via a shim (mirrors the harness
// pattern documented in dsp-worklet-no-top-level-export.md). We can't
// `import { Moog961Processor }` because the worklet entry NEVER exports its
// class at the top level — that would break ART's classic-script eval.
type ProcCtor = new () => {
  process: (
    i: Float32Array[][],
    o: Float32Array[][],
    p: Record<string, Float32Array>,
  ) => boolean;
};
let capturedProc: ProcCtor | null = null;
async function loadProcessor(): Promise<ProcCtor> {
  if (capturedProc) return capturedProc;
  const g = globalThis as unknown as {
    registerProcessor?: (n: string, c: ProcCtor) => void;
  };
  const prev = g.registerProcessor;
  let registered: ProcCtor | null = null;
  g.registerProcessor = (_n, ctor) => {
    registered = ctor;
  };
  // Relative path into the DSP source — worktrees may not have the workspace
  // package symlinked under node_modules.
  await import('../../../../../dsp/src/moog961');
  g.registerProcessor = prev;
  if (!registered) throw new Error('moog961 processor did not register');
  capturedProc = registered;
  return capturedProc;
}

const BLOCK = 128;

/** Build a single-element-Float32Array parameters record (k-rate constants). */
function makeParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const base: Record<string, number> = {};
  for (const p of moog961Def.params) base[p.id] = p.defaultValue;
  Object.assign(base, over);
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(base)) out[k] = new Float32Array([v]);
  return out;
}

interface RunResult {
  vOut1: Float32Array;
  vOut2: Float32Array;
  sOutA: Float32Array;
  sOutB: Float32Array;
}

/** Drive the processor for `total` samples; the four input functions supply
 *  audio_in / s_in / v_in_a / v_in_b per sample. Returns the four output
 *  channels concatenated across blocks. */
function runProc(
  proc: {
    process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean;
  },
  params: Record<string, Float32Array>,
  total: number,
  audioFn: (n: number) => number,
  sFn: (n: number) => number,
  vaFn: (n: number) => number,
  vbFn: (n: number) => number,
): RunResult {
  const vOut1 = new Float32Array(total);
  const vOut2 = new Float32Array(total);
  const sOutA = new Float32Array(total);
  const sOutB = new Float32Array(total);
  let g = 0;
  while (g < total) {
    const len = Math.min(BLOCK, total - g);
    const audio = new Float32Array(len);
    const sIn = new Float32Array(len);
    const va = new Float32Array(len);
    const vb = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      audio[i] = audioFn(g + i);
      sIn[i] = sFn(g + i);
      va[i] = vaFn(g + i);
      vb[i] = vbFn(g + i);
    }
    const o1 = new Float32Array(len);
    const o2 = new Float32Array(len);
    const oa = new Float32Array(len);
    const ob = new Float32Array(len);
    proc.process(
      [[audio], [sIn], [va], [vb]],
      [[o1], [o2], [oa], [ob]],
      params,
    );
    for (let i = 0; i < len; i++) {
      vOut1[g + i] = o1[i] as number;
      vOut2[g + i] = o2[i] as number;
      sOutA[g + i] = oa[i] as number;
      sOutB[g + i] = ob[i] as number;
    }
    g += len;
  }
  return { vOut1, vOut2, sOutA, sOutB };
}

const ZERO = () => 0;

function countHigh(buf: Float32Array): number {
  let n = 0;
  for (let i = 0; i < buf.length; i++) if ((buf[i] ?? 0) > 0.5) n++;
  return n;
}

// ────────────────────────────────────────────────────────────────────────────
// 1) Module-def shape.
// ────────────────────────────────────────────────────────────────────────────

describe('moog961Def — module def shape', () => {
  it('declares type=moog961, label, category=utilities, schemaVersion=1', () => {
    expect(moog961Def.type).toBe('moog961');
    expect(moog961Def.label).toBe('961 interface');
    expect(moog961Def.category).toBe('utilities');
  });

  it('lives in the Moog System 35/55 Clones palette bucket and uses the Moog961Card', () => {
    expect(moog961Def.palette).toEqual({ top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' });
    expect(moog961Def.card).toBe('Moog961Card');
    expect(moog961Def.domain).toBe('audio');
  });

  it('exposes audio_in (audio) + three gate inputs (s_in, v_in_a, v_in_b)', () => {
    expect(moog961Def.inputs.map((p) => p.id)).toEqual([
      'audio_in',
      's_in',
      'v_in_a',
      'v_in_b',
    ]);
    const byId = Object.fromEntries(moog961Def.inputs.map((p) => [p.id, p]));
    expect(byId.audio_in.type).toBe('audio');
    for (const id of ['s_in', 'v_in_a', 'v_in_b']) {
      expect(byId[id].type).toBe('gate');
      // The gate inputs are signals being converted, not knob modulators.
      expect(byId[id].cvScale).toBeUndefined();
      expect(byId[id].paramTarget).toBeUndefined();
    }
  });

  it('exposes four gate outputs (v_out1, v_out2, s_out_a, s_out_b)', () => {
    expect(moog961Def.outputs.map((p) => p.id)).toEqual([
      'v_out1',
      'v_out2',
      's_out_a',
      's_out_b',
    ]);
    expect(moog961Def.outputs.every((o) => o.type === 'gate')).toBe(true);
  });

  it('exposes 2 params with the documented ranges + curves', () => {
    const byId = Object.fromEntries(moog961Def.params.map((p) => [p.id, p]));
    expect(Object.keys(byId).sort()).toEqual(['sensitivity', 'switchOnTime']);
    expect(byId.sensitivity).toMatchObject({ min: 0, max: 1, curve: 'linear', defaultValue: 0.5 });
    expect(byId.switchOnTime).toMatchObject({ min: 0.04, max: 4, curve: 'log', defaultValue: 0.2 });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2) DSP behaviour — drive the worklet processor directly.
// ────────────────────────────────────────────────────────────────────────────

describe('MOOG 961 worklet — audio→trigger sensitivity', () => {
  it('fires v_out1 AND v_out2 on a rising rectified crossing of the threshold', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    // Audio: low for a stretch, then a single high sample (one rising edge).
    const total = 256;
    const out = runProc(
      p,
      makeParams({ sensitivity: 0.5 }),
      total,
      (n) => (n === 100 ? 0.9 : 0), // single high sample
      ZERO,
      ZERO,
      ZERO,
    );
    // Exactly one edge → one high sample on each V out (audio is a 1-sample tick).
    expect(countHigh(out.vOut1)).toBe(1);
    expect(countHigh(out.vOut2)).toBe(1);
    expect(out.vOut1[100]).toBe(1);
    expect(out.vOut2[100]).toBe(1);
  });

  it('a higher sensitivity requires a louder signal to fire', async () => {
    const Proc = await loadProcessor();
    // sensitivity 0.9 + a 0.6 pulse → below threshold, no fire.
    const quiet = runProc(
      new Proc(),
      makeParams({ sensitivity: 0.9 }),
      64,
      (n) => (n === 10 ? 0.6 : 0),
      ZERO, ZERO, ZERO,
    );
    expect(countHigh(quiet.vOut1)).toBe(0);
    // sensitivity 0.3 + the same 0.6 pulse → above threshold, fires.
    const sensitive = runProc(
      new Proc(),
      makeParams({ sensitivity: 0.3 }),
      64,
      (n) => (n === 10 ? 0.6 : 0),
      ZERO, ZERO, ZERO,
    );
    expect(countHigh(sensitive.vOut1)).toBe(1);
  });
});

describe('MOOG 961 worklet — s_in format passthrough', () => {
  it('passes s_in through to v_out1 AND v_out2 for its full width', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    const total = 256;
    // s_in held high samples [50, 80).
    const sHigh = (n: number) => (n >= 50 && n < 80 ? 1 : 0);
    const out = runProc(p, makeParams(), total, ZERO, sHigh, ZERO, ZERO);
    expect(countHigh(out.vOut1)).toBe(30);
    expect(countHigh(out.vOut2)).toBe(30);
    expect(out.vOut1[50]).toBe(1);
    expect(out.vOut1[79]).toBe(1);
    expect(out.vOut1[80]).toBe(0);
  });
});

describe('MOOG 961 worklet — column A width-matched passthrough', () => {
  it('passes v_in_a → s_out_a with the input gate width', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    const total = 256;
    const vaHigh = (n: number) => (n >= 20 && n < 60 ? 1 : 0); // 40 samples
    const out = runProc(p, makeParams(), total, ZERO, ZERO, vaHigh, ZERO);
    expect(countHigh(out.sOutA)).toBe(40);
    // v_in_a does NOT touch the V outs or s_out_b.
    expect(countHigh(out.vOut1)).toBe(0);
    expect(countHigh(out.sOutB)).toBe(0);
  });
});

describe('MOOG 961 worklet — column B fixed-width one-shot', () => {
  it('emits a fixed ~switchOnTime pulse on s_out_b regardless of input width', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    const switchOnTime = 0.05; // 2400 samples at 48k
    const expected = Math.round(switchOnTime * SR);
    // Hold v_in_b high far LONGER than the pulse — the one-shot must still end
    // at the fixed width (proves it's not a passthrough).
    const holdSamples = expected * 2;
    const total = expected * 3;
    const out = runProc(
      p,
      makeParams({ switchOnTime }),
      total,
      ZERO, ZERO, ZERO,
      (n) => (n < holdSamples ? 1 : 0),
    );
    expect(countHigh(out.sOutB)).toBe(expected);
    // The pulse starts on the rising edge (sample 0) and is contiguous.
    expect(out.sOutB[0]).toBe(1);
    expect(out.sOutB[expected - 1]).toBe(1);
    expect(out.sOutB[expected]).toBe(0);
  });

  it('v_in_b does NOT drive the V outs (it only feeds s_out_b)', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    const out = runProc(
      p,
      makeParams({ switchOnTime: 0.05 }),
      512,
      ZERO, ZERO, ZERO,
      (n) => (n < 100 ? 1 : 0),
    );
    expect(countHigh(out.vOut1)).toBe(0);
    expect(countHigh(out.vOut2)).toBe(0);
    expect(countHigh(out.sOutB)).toBeGreaterThan(0);
  });
});
