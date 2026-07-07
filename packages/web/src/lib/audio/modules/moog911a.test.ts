// packages/web/src/lib/audio/modules/moog911a.test.ts
//
// Two test layers for the MOOG 911A DUAL TRIGGER DELAY:
//   1. Module-def shape — pins the I/O surface (trig1/trig2 gate inputs,
//      out1/out2 gate outputs, the delay1/delay2/mode param array) so a
//      refactor that silently drops a port / param fails loudly (the
//      per-module-per-port regression-net class of bug).
//   2. Real DSP behavior — instantiate the worklet processor class directly
//      (captured via a registerProcessor shim, since the worklet NEVER
//      top-level-exports its class) and drive process() to assert the
//      delay→pulse timing converts seconds→samples correctly and the OFF /
//      PARALLEL / SERIES coupling routes the right channels.
//
// The pure timing state machine has its own exhaustive suite in
// packages/dsp/src/lib/trigger-delay-dsp.test.ts; this layer proves the
// worklet WIRING (param→samples conversion, input/output channel mapping).

import { describe, it, expect, beforeAll } from 'vitest';
import {
  moog911aDef,
  MOOG911A_MODE_NAMES,
  MOOG911A_MAX_MODE,
  MOOG911A_MODE_COUNT,
} from './moog911a';

const SR = 48000;

// The worklet reads bare global `sampleRate` in its constructor; set it
// BEFORE we trigger the dynamic import below.
beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

// ────────────────────────────────────────────────────────────────────────────
// 1) Module-def shape.
// ────────────────────────────────────────────────────────────────────────────

describe('moog911aDef — module def shape', () => {
  it('exposes 3 params: delay1/delay2 (log s, 0.002..10, default 0.1) + mode (discrete 0..2)', () => {
    const byId = Object.fromEntries(moog911aDef.params.map((p) => [p.id, p] as const));
    expect(moog911aDef.params.map((p) => p.id)).toEqual(['delay1', 'delay2', 'mode']);
    for (const id of ['delay1', 'delay2']) {
      expect(byId[id]).toMatchObject({ min: 0.002, max: 10, curve: 'log', defaultValue: 0.1 });
    }
    expect(byId.mode).toMatchObject({ min: 0, max: MOOG911A_MAX_MODE, curve: 'discrete', defaultValue: 0 });
  });

  it('MODE_NAMES length matches the mode param discrete range (OFF/PARALLEL/SERIES)', () => {
    const modeParam = moog911aDef.params.find((p) => p.id === 'mode')!;
    expect(MOOG911A_MODE_NAMES.length).toBe(modeParam.max - modeParam.min + 1);
    expect(MOOG911A_MODE_COUNT).toBe(3);
    expect(MOOG911A_MODE_NAMES).toEqual(['OFF', 'PARALLEL', 'SERIES']);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2) Worklet DSP behavior — drive the processor directly.
// ────────────────────────────────────────────────────────────────────────────

// Capture the registered processor class via a shim (the worklet entry NEVER
// exports its class — see dsp-worklet-no-top-level-export.md).
type ProcCtor = new () => {
  process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean;
};
let capturedProc: ProcCtor | null = null;
async function loadProcessor(): Promise<ProcCtor> {
  if (capturedProc) return capturedProc;
  const g = globalThis as unknown as { registerProcessor?: (n: string, c: ProcCtor) => void };
  const prev = g.registerProcessor;
  let registered: ProcCtor | null = null;
  g.registerProcessor = (_n, ctor) => { registered = ctor; };
  // Relative path into the DSP source — worktrees may not have the workspace
  // package symlinked under node_modules.
  await import('../../../../../dsp/src/moog911a');
  g.registerProcessor = prev;
  if (!registered) throw new Error('moog911a processor did not register');
  capturedProc = registered;
  return capturedProc;
}

const BLOCK = 128;

/** Build a single-element-Float32Array params record (constant per block). */
function makeParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const base: Record<string, number> = {};
  for (const p of moog911aDef.params) base[p.id] = p.defaultValue;
  Object.assign(base, over);
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(base)) out[k] = new Float32Array([v]);
  return out;
}

/** Run the processor for `total` samples. trig1Fn/trig2Fn return the per-
 *  sample gate level. Returns the two output buffers. */
function runProc(
  proc: { process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean },
  params: Record<string, Float32Array>,
  total: number,
  trig1Fn: (n: number) => number,
  trig2Fn: (n: number) => number,
): { o1: Float32Array; o2: Float32Array } {
  const o1 = new Float32Array(total);
  const o2 = new Float32Array(total);
  let g = 0;
  while (g < total) {
    const len = Math.min(BLOCK, total - g);
    const t1 = new Float32Array(len);
    const t2 = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      t1[i] = trig1Fn(g + i);
      t2[i] = trig2Fn(g + i);
    }
    const out1 = new Float32Array(len);
    const out2 = new Float32Array(len);
    proc.process([[t1], [t2]], [[out1], [out2]], params);
    for (let i = 0; i < len; i++) {
      o1[g + i] = out1[i] as number;
      o2[g + i] = out2[i] as number;
    }
    g += len;
  }
  return { o1, o2 };
}

/** First index where a buffer goes high (>=0.5), or -1. */
function firstHigh(buf: Float32Array): number {
  for (let i = 0; i < buf.length; i++) if ((buf[i] ?? 0) >= 0.5) return i;
  return -1;
}

describe('MOOG 911A worklet — delay timing (seconds → samples)', () => {
  it('OFF: out1 fires ~delay1 seconds after a trig1 edge', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    const DELAY = 0.01; // 10 ms → 480 samples @ 48k
    const expected = Math.round(DELAY * SR);
    const params = makeParams({ delay1: DELAY, delay2: DELAY, mode: 0 });
    // Edge at sample 0.
    const { o1, o2 } = runProc(p, params, expected + 600, (n) => (n === 0 ? 1 : 0), () => 0);
    const start = firstHigh(o1);
    // Allow a couple samples of off-by-one slack from the per-sample machine.
    expect(Math.abs(start - expected)).toBeLessThanOrEqual(2);
    // trig2 silent → out2 never fires in OFF mode.
    expect(firstHigh(o2)).toBe(-1);
  });

  it('OFF: trig2 drives out2 independently of trig1', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    const D1 = 0.005; // 5 ms
    const D2 = 0.02;  // 20 ms
    const e1 = Math.round(D1 * SR);
    const e2 = Math.round(D2 * SR);
    const params = makeParams({ delay1: D1, delay2: D2, mode: 0 });
    const { o1, o2 } = runProc(
      p, params, e2 + 600,
      (n) => (n === 0 ? 1 : 0),
      (n) => (n === 0 ? 1 : 0),
    );
    expect(Math.abs(firstHigh(o1) - e1)).toBeLessThanOrEqual(2);
    expect(Math.abs(firstHigh(o2) - e2)).toBeLessThanOrEqual(2);
  });

  it('emits a pulse of roughly ~1ms width, not a single sample', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    const params = makeParams({ delay1: 0.005, mode: 0 });
    const { o1 } = runProc(p, params, Math.round(0.005 * SR) + 600, (n) => (n === 0 ? 1 : 0), () => 0);
    const start = firstHigh(o1);
    let width = 0;
    for (let i = start; i < o1.length && (o1[i] ?? 0) >= 0.5; i++) width++;
    // ~1 ms at 48k ≈ 48 samples. Allow a generous band.
    expect(width).toBeGreaterThanOrEqual(20);
    expect(width).toBeLessThanOrEqual(120);
  });
});

describe('MOOG 911A worklet — coupling modes', () => {
  it('PARALLEL: a single trig1 edge fires BOTH outputs (trig2 ignored)', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    const D1 = 0.004;
    const D2 = 0.012;
    const e1 = Math.round(D1 * SR);
    const e2 = Math.round(D2 * SR);
    const params = makeParams({ delay1: D1, delay2: D2, mode: 1 });
    const { o1, o2 } = runProc(
      p, params, e2 + 600,
      (n) => (n === 0 ? 1 : 0),
      (n) => (n === 5 ? 1 : 0), // should be ignored in PARALLEL
    );
    expect(Math.abs(firstHigh(o1) - e1)).toBeLessThanOrEqual(2);
    expect(Math.abs(firstHigh(o2) - e2)).toBeLessThanOrEqual(2);
    // out2's only pulse is the one from trig1 (the trig2@5 edge is ignored):
    // its first high is at ~e2, not ~e2+5.
    expect(firstHigh(o2)).toBeLessThan(e2 + 4);
  });

  it('SERIES: out2 fires delay2 after out1 (chain), trig2 ignored', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    const D1 = 0.004;
    const D2 = 0.006;
    const e1 = Math.round(D1 * SR);
    const e2 = Math.round(D2 * SR);
    const params = makeParams({ delay1: D1, delay2: D2, mode: 2 });
    const { o1, o2 } = runProc(p, params, e1 + e2 + 600, (n) => (n === 0 ? 1 : 0), () => 0);
    const s1 = firstHigh(o1);
    const s2 = firstHigh(o2);
    expect(Math.abs(s1 - e1)).toBeLessThanOrEqual(2);
    // out2 fires ~delay2 after out1's rising edge (chained, +1 sample for the
    // causal previous-sample feed).
    expect(Math.abs(s2 - (s1 + e2))).toBeLessThanOrEqual(3);
  });

  it('SERIES: trig2 alone produces no output', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    const params = makeParams({ delay1: 0.004, delay2: 0.004, mode: 2 });
    const { o1, o2 } = runProc(p, params, 2000, () => 0, (n) => (n === 0 ? 1 : 0));
    expect(firstHigh(o1)).toBe(-1);
    expect(firstHigh(o2)).toBe(-1);
  });
});
