// packages/web/src/lib/audio/modules/clap.test.ts
//
// CLAP module-def shape + worklet-wrapper behavior. The per-sample DSP
// math (burst scheduler, control laws, the sonic-range proofs) is pinned
// in packages/dsp/src/lib/clap-dsp.test.ts and the raw audio profile in
// art/scenarios/clap/profile.test.ts. This file enforces the FROZEN
// module-def contract (ports incl. edge semantics, all 10 params, mono
// out) and the wrapper behaviors: silence without a strike, the CLAP-pad
// param OR path (fires once per press edge), the accent macro, the level
// stage, and the per-knob CV input routing.

import { describe, it, expect, beforeAll } from 'vitest';
import { clapDef } from './clap';

const SR = 48000;
beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

// Capture the Processor class via the registerProcessor shim (the
// kickdrum/tomtom loader pattern).
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
  await import('../../../../../dsp/src/clap');
  g.registerProcessor = prev;
  if (!registered) throw new Error('clap processor did not register');
  capturedProc = registered;
  return capturedProc;
}

// ───────────────────────────────────────────────────────────────────────
// Module-def shape (the frozen contract)
// ───────────────────────────────────────────────────────────────────────

describe('CLAP def — frozen contract', () => {
  it('identity: type/label/category/domain (label lowercase per the guard)', () => {
    expect(clapDef.type).toBe('clap');
    expect(clapDef.label).toBe('clap');
    expect(clapDef.label).toBe(clapDef.label.toLowerCase());
    expect(clapDef.domain).toBe('audio');
    expect(clapDef.category).toBe('sources');
  });

  it('ports: trigger (edge:trigger) + accent + 3 CVs in, ONE mono audio out', () => {
    expect(clapDef.inputs.map((p) => p.id)).toEqual([
      'trigger_in', 'accent_in', 'tone_cv', 'tail_cv', 'spread_cv',
    ]);
    const trig = clapDef.inputs.find((p) => p.id === 'trigger_in')!;
    expect(trig.type).toBe('gate');
    expect(trig.edge).toBe('trigger'); // ONE clap per rising edge, declared
    for (const id of ['accent_in', 'tone_cv', 'tail_cv', 'spread_cv']) {
      expect(clapDef.inputs.find((p) => p.id === id)!.type).toBe('cv');
    }
    expect(clapDef.outputs).toEqual([{ id: 'audio_out', type: 'audio' }]);
  });

  it('params: the curated 9-knob set + the clap pad', () => {
    expect(clapDef.params.map((p) => p.id)).toEqual([
      'pulses', 'spread', 'tone', 'width', 'tail', 'color', 'snap', 'drive', 'level', 'strike',
    ]);
    const byId = Object.fromEntries(clapDef.params.map((p) => [p.id, p]));
    expect(byId.pulses).toMatchObject({ min: 2, max: 5, defaultValue: 3, curve: 'discrete' });
    expect(byId.spread).toMatchObject({ min: 4, max: 25, defaultValue: 10, units: 'ms' });
    expect(byId.tone).toMatchObject({ min: 400, max: 3000, defaultValue: 1000, units: 'Hz' });
    expect(byId.tail).toMatchObject({ min: 30, max: 800, defaultValue: 150, units: 'ms' });
    expect(byId.level).toMatchObject({ min: -24, max: 12, defaultValue: 0, units: 'dB' });
    expect(byId.strike).toMatchObject({ min: 0, max: 1, defaultValue: 0, curve: 'discrete' });
  });

  it('ships co-located docs for every port + param (the STRICT_DOCS bar)', () => {
    const docs = clapDef.docs!;
    expect(docs.explanation!.length).toBeGreaterThan(200);
    for (const p of clapDef.inputs) expect(docs.inputs![p.id], p.id).toBeTruthy();
    for (const p of clapDef.outputs) expect(docs.outputs![p.id], p.id).toBeTruthy();
    for (const p of clapDef.params) expect(docs.controls![p.id], p.id).toBeTruthy();
  });
});

// ───────────────────────────────────────────────────────────────────────
// Worklet processor — load + wrapper behavior
// ───────────────────────────────────────────────────────────────────────

const BLOCK = 128;

function makeParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const base: Record<string, number> = {};
  for (const p of clapDef.params) base[p.id] = p.defaultValue;
  Object.assign(base, over);
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(base)) out[k] = new Float32Array([v]);
  return out;
}

interface RunOpts {
  seconds: number;
  trigFn?: (n: number) => number;
  accentFn?: (n: number) => number;
  toneFn?: (n: number) => number;
  tailFn?: (n: number) => number;
  spreadFn?: (n: number) => number;
  /** Per-block strike-param value (the pad is k-rate). */
  strikeFn?: (n: number) => number;
}

/** Run the processor and capture the mono output. */
function runProc(
  proc: { process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean },
  params: Record<string, Float32Array>,
  opts: RunOpts,
): Float32Array {
  const total = Math.round(SR * opts.seconds);
  const out = new Float32Array(total);
  let g = 0;
  while (g < total) {
    const len = Math.min(BLOCK, total - g);
    const mk = (fn?: (n: number) => number) => {
      const b = new Float32Array(len);
      if (fn) for (let i = 0; i < len; i++) b[i] = fn(g + i);
      return b;
    };
    const ins = [
      mk(opts.trigFn), mk(opts.accentFn), mk(opts.toneFn), mk(opts.tailFn), mk(opts.spreadFn),
    ].map((b) => [b]);
    if (opts.strikeFn) params.strike = new Float32Array([opts.strikeFn(g)]);
    const o = new Float32Array(len);
    proc.process(ins, [[o]], params);
    for (let i = 0; i < len; i++) out[g + i] = o[i] as number;
    g += len;
  }
  return out;
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

/** Spectral centroid (Hz) as the RMS frequency (the clap-dsp.test helper). */
function centroidHz(buf: Float32Array, s: number, e: number): number {
  let dd = 0;
  let xx = 0;
  for (let i = s + 1; i < e; i++) {
    const d = (buf[i] ?? 0) - (buf[i - 1] ?? 0);
    dd += d * d;
    xx += (buf[i] ?? 0) * (buf[i] ?? 0);
  }
  if (xx <= 0) return 0;
  return (SR / (2 * Math.PI)) * 2 * Math.asin(Math.min(1, 0.5 * Math.sqrt(dd / xx)));
}

// A 5 ms trigger pulse at sample 0 (one clean rising edge).
const PULSE_N = Math.round(0.005 * SR);
const oneStrike = (n: number) => (n < PULSE_N ? 1 : 0);

describe('CLAP worklet — load + wrapper behavior', () => {
  it('Processor class registers without throwing', async () => {
    const Proc = await loadProcessor();
    expect(Proc).toBeTruthy();
    expect(() => new Proc()).not.toThrow();
  });

  it('no trigger → silent output (no spontaneous noise)', async () => {
    const Proc = await loadProcessor();
    const out = runProc(new Proc(), makeParams(), { seconds: 0.1 });
    expect(peakOf(out)).toBeLessThan(1e-6);
  });

  it('one strike → finite, audible, true-peak-bounded mono clap', async () => {
    const Proc = await loadProcessor();
    const out = runProc(new Proc(), makeParams(), { seconds: 0.5, trigFn: oneStrike });
    expect(out.every(Number.isFinite)).toBe(true);
    expect(peakOf(out)).toBeGreaterThan(0.15);
    expect(peakOf(out)).toBeLessThan(1); // the chain ends in tanh
  });

  it('CLAP pad param fires once per press edge; holding does not retrigger', async () => {
    const Proc = await loadProcessor();
    // Pad pressed at 0 and HELD 400 ms with a short 60 ms tail: a level
    // (not edge) consumer would show late attack energy.
    const short = makeParams({ tail: 60, snap: 0.5 });
    const held = runProc(new Proc(), short, {
      seconds: 0.4,
      strikeFn: (n) => (n < Math.round(0.4 * SR) ? 1 : 0),
    });
    const early = peakOf(held, 0, Math.round(0.08 * SR));
    const late = peakOf(held, Math.round(0.3 * SR), held.length);
    expect(early).toBeGreaterThan(0.1);
    expect(late).toBeLessThan(early / 50); // no re-strike while held
    // Release + second press fires a SECOND clap.
    const rePress = runProc(new Proc(), makeParams({ tail: 60 }), {
      seconds: 0.6,
      strikeFn: (n) => {
        const t = n / SR;
        return (t < 0.05) || (t >= 0.35 && t < 0.4) ? 1 : 0;
      },
    });
    expect(peakOf(rePress, Math.round(0.35 * SR), Math.round(0.42 * SR))).toBeGreaterThan(0.1);
  });

  it('ACCENT latched at the strike lands a hotter hit', async () => {
    const Proc = await loadProcessor();
    const quiet = rmsOf(runProc(new Proc(), makeParams(), { seconds: 0.4, trigFn: oneStrike }));
    const hot = rmsOf(runProc(new Proc(), makeParams(), {
      seconds: 0.4,
      trigFn: oneStrike,
      accentFn: () => 1,
    }));
    expect(hot).toBeGreaterThan(quiet * 1.15);
  });

  it('LEVEL (dB stage) scales the output monotonically', async () => {
    const Proc = await loadProcessor();
    // Strike 50 ms in so the 80 Hz knob smoother settles on the non-default
    // level before the attack.
    const d = Math.round(0.05 * SR);
    const lateStrike = (n: number) => (n >= d && n < d + PULSE_N ? 1 : 0);
    const lo = rmsOf(runProc(new Proc(), makeParams({ level: -12 }), { seconds: 0.4, trigFn: lateStrike }));
    const unity = rmsOf(runProc(new Proc(), makeParams({ level: 0 }), { seconds: 0.4, trigFn: lateStrike }));
    const hi = rmsOf(runProc(new Proc(), makeParams({ level: 6 }), { seconds: 0.4, trigFn: lateStrike }));
    expect(lo).toBeLessThan(unity * 0.5);
    expect(hi).toBeGreaterThan(unity * 1.2);
  });

  it('tone_cv input shifts the rendered spectrum (±1.5 oct/V)', async () => {
    const Proc = await loadProcessor();
    // Room-only render (snap 0, long tail) = a sustained band to measure.
    const base = { snap: 0, tail: 400, color: 0, width: 0.3 };
    const w = Math.round(0.25 * SR);
    const down = runProc(new Proc(), makeParams(base), {
      seconds: 0.25, trigFn: oneStrike, toneFn: () => -1,
    });
    const up = runProc(new Proc(), makeParams(base), {
      seconds: 0.25, trigFn: oneStrike, toneFn: () => 1,
    });
    expect(centroidHz(up, 0, w)).toBeGreaterThan(2 * centroidHz(down, 0, w));
  });

  it('tail_cv input stretches the room ring (+1 V ≈ ×4 time)', async () => {
    const Proc = await loadProcessor();
    const base = { snap: 0, tail: 150 };
    const lateWin = (b: Float32Array) => rmsOf(b, Math.round(0.4 * SR), Math.round(0.6 * SR));
    const flat = runProc(new Proc(), makeParams(base), { seconds: 0.6, trigFn: oneStrike });
    const long = runProc(new Proc(), makeParams(base), {
      seconds: 0.6, trigFn: oneStrike, tailFn: () => 1,
    });
    // At 150 ms the 400-600 ms window is −60 dB-dead; at ×4 (600 ms) it rings.
    expect(lateWin(long)).toBeGreaterThan(10 * Math.max(lateWin(flat), 1e-9));
  });

  it('spread_cv input stretches the burst grid (latched at the strike)', async () => {
    const Proc = await loadProcessor();
    const base = { snap: 1, pulses: 3, spread: 10, drive: 0 };
    const flat = runProc(new Proc(), makeParams(base), { seconds: 0.2, trigFn: oneStrike });
    const wide = runProc(new Proc(), makeParams(base), {
      seconds: 0.2, trigFn: oneStrike, spreadFn: () => 1,
    });
    // Flat: last onset at 20 ms, burst dead well before 40 ms.
    // +1 V: spacing 24.6 ms → the LAST pulse fires at ~49 ms and rings past it.
    const lateBurst = (b: Float32Array) => rmsOf(b, Math.round(0.048 * SR), Math.round(0.08 * SR));
    expect(lateBurst(wide)).toBeGreaterThan(5 * Math.max(lateBurst(flat), 1e-9));
  });
});
