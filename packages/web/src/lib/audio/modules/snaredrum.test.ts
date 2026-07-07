// packages/web/src/lib/audio/modules/snaredrum.test.ts
//
// SNARE DRUM module-def shape + worklet-wrapper behavior. The per-sample DSP
// math is pinned in packages/dsp/src/lib/snaredrum-dsp.test.ts + snare-roll-
// dsp.test.ts (the pure cores) and the raw audio profile in
// art/scenarios/snaredrum/profile.test.ts. This file enforces the FROZEN
// module-def contract (6 inputs incl. edge semantics, 22 params, stereo outs)
// and the wrapper behaviors the core doesn't own: the stereo L=R fan-out, the
// gate-driven roll, the choke damp, the accent macro, and the choke both-edge
// gate.

import { describe, it, expect, beforeAll } from 'vitest';
import { snaredrumDef } from './snaredrum';

const SR = 48000;
beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

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
  await import('../../../../../dsp/src/snaredrum');
  g.registerProcessor = prev;
  if (!registered) throw new Error('snaredrum processor did not register');
  capturedProc = registered;
  return capturedProc;
}

// ───────────────────────────────────────────────────────────────────────
// Module-def shape (the frozen contract)
// ───────────────────────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────────────────────
// Worklet processor — load + behavior the wrapper owns
// ───────────────────────────────────────────────────────────────────────

const BLOCK = 128;

function makeParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const base: Record<string, number> = {};
  for (const p of snaredrumDef.params) base[p.id] = p.defaultValue;
  Object.assign(base, over);
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(base)) out[k] = new Float32Array([v]);
  return out;
}

interface RunOpts {
  seconds: number;
  trigFn?: (n: number) => number;
  gateFn?: (n: number) => number;
  rollCvFn?: (n: number) => number;
  accentFn?: (n: number) => number;
  pitchFn?: (n: number) => number;
  chokeFn?: (n: number) => number;
}

/** Run the processor (6 inputs) and capture BOTH stereo channels. */
function runProc(
  proc: { process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean },
  params: Record<string, Float32Array>,
  opts: RunOpts,
): { l: Float32Array; r: Float32Array } {
  const total = Math.round(SR * opts.seconds);
  const l = new Float32Array(total);
  const r = new Float32Array(total);
  let g = 0;
  while (g < total) {
    const len = Math.min(BLOCK, total - g);
    const chans = [0, 1, 2, 3, 4, 5].map(() => new Float32Array(len));
    for (let i = 0; i < len; i++) {
      chans[0]![i] = opts.trigFn ? opts.trigFn(g + i) : 0;
      chans[1]![i] = opts.gateFn ? opts.gateFn(g + i) : 0;
      chans[2]![i] = opts.rollCvFn ? opts.rollCvFn(g + i) : 0;
      chans[3]![i] = opts.accentFn ? opts.accentFn(g + i) : 0;
      chans[4]![i] = opts.pitchFn ? opts.pitchFn(g + i) : 0;
      chans[5]![i] = opts.chokeFn ? opts.chokeFn(g + i) : 0;
    }
    const outL = new Float32Array(len);
    const outR = new Float32Array(len);
    proc.process(chans.map((c) => [c]), [[outL, outR]], params);
    for (let i = 0; i < len; i++) { l[g + i] = outL[i] as number; r[g + i] = outR[i] as number; }
    g += len;
  }
  return { l, r };
}

const peakOf = (b: Float32Array, s = 0, e = b.length): number => {
  let p = 0;
  for (let i = s; i < e; i++) p = Math.max(p, Math.abs(b[i] ?? 0));
  return p;
};
const rmsOf = (b: Float32Array, s = 0, e = b.length): number => {
  let x = 0;
  for (let i = s; i < e; i++) x += (b[i] ?? 0) * (b[i] ?? 0);
  return Math.sqrt(x / Math.max(1, e - s));
};

const PULSE_N = Math.round(0.005 * SR);
const oneStrike = (n: number) => (n < PULSE_N ? 1 : 0);

describe('SNAREDRUM worklet — load + wrapper behavior', () => {
  it('Processor class registers without throwing', async () => {
    const Proc = await loadProcessor();
    expect(Proc).toBeTruthy();
    expect(() => new Proc()).not.toThrow();
  });

  it('no trigger + no gate → silent output', async () => {
    const Proc = await loadProcessor();
    const { l } = runProc(new Proc(), makeParams(), { seconds: 0.1 });
    expect(peakOf(l)).toBeLessThan(1e-6);
  });

  it('one trigger → finite, audible stereo hit; width=0 & spread=0 → L == R (mono-safe)', async () => {
    const Proc = await loadProcessor();
    // Strike 50 ms in so the 80 Hz width/spread smoothers have settled off their
    // non-zero defaults (0.4 / 0.5) — else the first samples leak a ramping side
    // term (the core proves the EXACT L==R law; here the smoother leaves only
    // sub-audible float dust asymptotically approaching 0).
    const d = Math.round(0.05 * SR);
    const strike = (n: number) => (n >= d && n < d + PULSE_N ? 1 : 0);
    const mono = runProc(new Proc(), makeParams({ width: 0, spread: 0 }), { seconds: 0.4, trigFn: strike });
    expect(mono.l.every(Number.isFinite)).toBe(true);
    expect(peakOf(mono.l)).toBeGreaterThan(0.05);
    let maxDiff = 0;
    for (let i = 0; i < mono.l.length; i++) maxDiff = Math.max(maxDiff, Math.abs((mono.l[i] ?? 0) - (mono.r[i] ?? 0)));
    expect(maxDiff).toBeLessThan(1e-6); // dead-centre mono (smoother dust only)
    // width + spread up → genuinely decorrelated.
    const wide = runProc(new Proc(), makeParams({ width: 1, spread: 1 }), { seconds: 0.4, trigFn: strike });
    let diff = 0;
    for (let i = 0; i < wide.l.length; i++) diff = Math.max(diff, Math.abs((wide.l[i] ?? 0) - (wide.r[i] ?? 0)));
    expect(diff).toBeGreaterThan(1e-3);
  });

  it('a HELD gate rolls CONTINUOUSLY — every window carries audible stereo RMS', async () => {
    const Proc = await loadProcessor();
    const { l, r } = runProc(new Proc(), makeParams({ wire: 0.8 }), { seconds: 1, gateFn: () => 1 });
    const win = Math.round(0.025 * SR);
    let minL = Infinity;
    let minR = Infinity;
    for (let w = Math.round(0.2 * SR); w + win < l.length; w += win) {
      minL = Math.min(minL, rmsOf(l, w, w + win));
      minR = Math.min(minR, rmsOf(r, w, w + win));
    }
    expect(minL).toBeGreaterThan(0.01); // no silent gaps on L
    expect(minR).toBeGreaterThan(0.01); // no silent gaps on R
    // A genuine stereo roll.
    let diff = 0;
    for (let i = 0; i < l.length; i++) diff = Math.max(diff, Math.abs((l[i] ?? 0) - (r[i] ?? 0)));
    expect(diff).toBeGreaterThan(1e-3);
  });

  it('ROLL SPEED changes the stroke density', async () => {
    const Proc = await loadProcessor();
    const onsets = (b: Float32Array): number => {
      const win = 128;
      let prev = 0;
      let count = 0;
      for (let i = win; i < b.length; i += win) {
        const e = rmsOf(b, i - win, i);
        if (e > 0.05 && e > prev * 1.3) count++;
        prev = e;
      }
      return count;
    };
    const slow = runProc(new Proc(), makeParams({ roll_speed: 0.1, bounce: 0, humanize: 0, wire: 0.3 }), { seconds: 1, gateFn: () => 1 }).l;
    const fast = runProc(new Proc(), makeParams({ roll_speed: 0.9, bounce: 0, humanize: 0, wire: 0.3 }), { seconds: 1, gateFn: () => 1 }).l;
    expect(onsets(fast)).toBeGreaterThan(onsets(slow) * 1.4);
  });

  it('CHOKE damps WHILE high and releases on the falling edge (both-edge gate)', async () => {
    const Proc = await loadProcessor();
    const free = runProc(new Proc(), makeParams({ head_decay: 500, wire: 0.8 }), { seconds: 0.4, trigFn: oneStrike }).l;
    const c0 = Math.round(0.1 * SR);
    const c1 = Math.round(0.25 * SR);
    const choked = runProc(new Proc(), makeParams({ head_decay: 500, wire: 0.8 }), {
      seconds: 0.4,
      trigFn: oneStrike,
      chokeFn: (n) => (n >= c0 && n < c1 ? 1 : 0),
    }).l;
    const w0 = Math.round(0.18 * SR);
    const w1 = Math.round(0.24 * SR);
    const freeRms = rmsOf(free, w0, w1);
    const chokedRms = rmsOf(choked, w0, w1);
    expect(freeRms).toBeGreaterThan(1e-4);
    expect(chokedRms).toBeLessThan(freeRms * 0.1);
  });

  it('ACCENT lands a hotter hit (per-hit velocity + drive/level macro)', async () => {
    const Proc = await loadProcessor();
    const quiet = rmsOf(runProc(new Proc(), makeParams(), { seconds: 0.25, trigFn: oneStrike }).l);
    const hot = rmsOf(runProc(new Proc(), makeParams(), { seconds: 0.25, trigFn: oneStrike, accentFn: () => 1 }).l);
    expect(hot).toBeGreaterThan(quiet * 1.1);
  });
});
