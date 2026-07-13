// packages/web/src/lib/audio/modules/tomtom.test.ts
//
// TOM DRUM module-def shape + worklet-wrapper behavior. The per-sample DSP
// math (bend/decay laws, frequency compensation, sonic-range proof) is
// pinned in packages/dsp/src/lib/tomtom-dsp.test.ts and the raw audio
// profile in art/scenarios/tomtom/profile.test.ts. This file enforces the
// FROZEN module-def contract (ports incl. edge semantics, all 9 params,
// mono out) and the wrapper behaviors: silence without a strike, the
// STRIKE-pad param OR path (fires once per press edge), the accent macro,
// the level stage, and the per-knob CV input routing.

import { describe, it, expect, beforeAll } from 'vitest';
import { tomtomDef } from './tomtom';

const SR = 48000;
beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

// Capture the Processor class via the registerProcessor shim (the
// kickdrum/sidecar loader pattern).
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
  await import('../../../../../dsp/src/tomtom');
  g.registerProcessor = prev;
  if (!registered) throw new Error('tomtom processor did not register');
  capturedProc = registered;
  return capturedProc;
}

// ───────────────────────────────────────────────────────────────────────
// Module-def shape (the frozen contract)
// ───────────────────────────────────────────────────────────────────────

describe('TOMTOM def — frozen contract', () => {
  it('identity: type/label/category/domain (label lowercase per the guard)', () => {
    expect(tomtomDef.type).toBe('tomtom');
    expect(tomtomDef.label).toBe('tom drum');
    expect(tomtomDef.label).toBe(tomtomDef.label.toLowerCase());
    expect(tomtomDef.domain).toBe('audio');
    expect(tomtomDef.category).toBe('sources');
  });

  it('ports: trigger (edge:trigger) + accent + per-knob CVs in, ONE mono audio out', () => {
    expect(tomtomDef.inputs.map((p) => p.id)).toEqual([
      'trigger_in', 'accent_in', 'pitch_cv', 'bend_cv', 'decay_cv', 'tone_cv', 'noise_cv',
      'tune_cv', 'bend_time_cv', 'drive_cv', 'level_cv',
    ]);
    const trig = tomtomDef.inputs.find((p) => p.id === 'trigger_in')!;
    expect(trig.type).toBe('gate');
    expect(trig.edge).toBe('trigger'); // ONE strike per rising edge, declared
    for (const id of [
      'accent_in', 'pitch_cv', 'bend_cv', 'decay_cv', 'tone_cv', 'noise_cv',
      'tune_cv', 'bend_time_cv', 'drive_cv', 'level_cv',
    ]) {
      expect(tomtomDef.inputs.find((p) => p.id === id)!.type).toBe('cv');
    }
    expect(tomtomDef.outputs).toEqual([{ id: 'audio_out', type: 'audio' }]);
  });

  it('params: the curated 8-knob set + the strike pad', () => {
    expect(tomtomDef.params.map((p) => p.id)).toEqual([
      'tune', 'bend_amt', 'bend_time', 'decay', 'tone', 'noise', 'drive', 'level', 'strike',
    ]);
    const byId = Object.fromEntries(tomtomDef.params.map((p) => [p.id, p]));
    expect(byId.tune).toMatchObject({ min: 60, max: 400, defaultValue: 110, units: 'Hz' });
    expect(byId.bend_amt).toMatchObject({ min: 0, max: 24, defaultValue: 7, units: 'st' });
    expect(byId.bend_time).toMatchObject({ min: 10, max: 300, defaultValue: 60, units: 'ms' });
    expect(byId.decay).toMatchObject({ min: 40, max: 1500, defaultValue: 350, units: 'ms' });
    expect(byId.level).toMatchObject({ min: -24, max: 12, defaultValue: 0, units: 'dB' });
    expect(byId.strike).toMatchObject({ min: 0, max: 1, defaultValue: 0, curve: 'discrete' });
  });

  it('ships co-located docs for every port + param (the STRICT_DOCS bar)', () => {
    const docs = tomtomDef.docs!;
    expect(docs.explanation!.length).toBeGreaterThan(200);
    for (const p of tomtomDef.inputs) expect(docs.inputs![p.id], p.id).toBeTruthy();
    for (const p of tomtomDef.outputs) expect(docs.outputs![p.id], p.id).toBeTruthy();
    for (const p of tomtomDef.params) expect(docs.controls![p.id], p.id).toBeTruthy();
  });
});

// ───────────────────────────────────────────────────────────────────────
// Worklet processor — load + wrapper behavior
// ───────────────────────────────────────────────────────────────────────

const BLOCK = 128;

function makeParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const base: Record<string, number> = {};
  for (const p of tomtomDef.params) base[p.id] = p.defaultValue;
  Object.assign(base, over);
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(base)) out[k] = new Float32Array([v]);
  return out;
}

interface RunOpts {
  seconds: number;
  trigFn?: (n: number) => number;
  accentFn?: (n: number) => number;
  pitchFn?: (n: number) => number;
  bendFn?: (n: number) => number;
  decayFn?: (n: number) => number;
  toneFn?: (n: number) => number;
  noiseFn?: (n: number) => number;
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
      mk(opts.trigFn), mk(opts.accentFn), mk(opts.pitchFn), mk(opts.bendFn),
      mk(opts.decayFn), mk(opts.toneFn), mk(opts.noiseFn),
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

/** Fundamental estimate via rising zero-crossings over [s, e). */
function estimateFreq(buf: Float32Array, s: number, e: number): number {
  let first = -1;
  let last = -1;
  let count = 0;
  for (let i = s + 1; i < e; i++) {
    if ((buf[i - 1] ?? 0) < 0 && (buf[i] ?? 0) >= 0) {
      const a = buf[i - 1] ?? 0;
      const b = buf[i] ?? 0;
      const t = i - 1 + a / (a - b);
      if (first < 0) first = t;
      last = t;
      count++;
    }
  }
  if (count < 2) return 0;
  return ((count - 1) * SR) / (last - first);
}

// A 5 ms trigger pulse at sample 0 (one clean rising edge).
const PULSE_N = Math.round(0.005 * SR);
const oneStrike = (n: number) => (n < PULSE_N ? 1 : 0);

describe('TOMTOM worklet — load + wrapper behavior', () => {
  it('Processor class registers without throwing', async () => {
    const Proc = await loadProcessor();
    expect(Proc).toBeTruthy();
    expect(() => new Proc()).not.toThrow();
  });

  it('no trigger → silent output (no spontaneous oscillation)', async () => {
    const Proc = await loadProcessor();
    const out = runProc(new Proc(), makeParams(), { seconds: 0.1 });
    expect(peakOf(out)).toBeLessThan(1e-6);
  });

  it('one strike → finite, audible, true-peak-bounded mono tom', async () => {
    const Proc = await loadProcessor();
    const out = runProc(new Proc(), makeParams(), { seconds: 0.5, trigFn: oneStrike });
    expect(out.every(Number.isFinite)).toBe(true);
    expect(peakOf(out)).toBeGreaterThan(0.15);
    expect(peakOf(out)).toBeLessThan(1); // the chain ends in tanh
  });

  it('STRIKE pad param fires once per press edge; holding does not retrigger', async () => {
    const Proc = await loadProcessor();
    // Pad pressed at 0 and HELD 300 ms with a short 100 ms decay: a level
    // (not edge) consumer would show late attack energy.
    const short = makeParams({ decay: 100, noise: 0, tone: 0 });
    const held = runProc(new Proc(), short, {
      seconds: 0.3,
      strikeFn: (n) => (n < Math.round(0.3 * SR) ? 1 : 0),
    });
    const early = peakOf(held, 0, Math.round(0.05 * SR));
    const late = peakOf(held, Math.round(0.25 * SR), held.length);
    expect(early).toBeGreaterThan(0.1);
    expect(late).toBeLessThan(early / 50); // no re-strike while held
    // Release + second press fires a SECOND hit.
    const rePress = runProc(new Proc(), makeParams({ decay: 100, noise: 0, tone: 0 }), {
      seconds: 0.5,
      strikeFn: (n) => {
        const t = n / SR;
        return (t < 0.05) || (t >= 0.3 && t < 0.35) ? 1 : 0;
      },
    });
    expect(peakOf(rePress, Math.round(0.3 * SR), Math.round(0.36 * SR))).toBeGreaterThan(0.1);
  });

  it('ACCENT latched at the strike lands a hotter hit', async () => {
    const Proc = await loadProcessor();
    const quiet = rmsOf(runProc(new Proc(), makeParams(), { seconds: 0.3, trigFn: oneStrike }));
    const hot = rmsOf(runProc(new Proc(), makeParams(), {
      seconds: 0.3,
      trigFn: oneStrike,
      accentFn: () => 1,
    }));
    expect(hot).toBeGreaterThan(quiet * 1.1);
  });

  it('LEVEL (dB stage) scales the output monotonically', async () => {
    const Proc = await loadProcessor();
    // Strike 50 ms in so the 80 Hz knob smoother settles on the non-default
    // level before the attack.
    const d = Math.round(0.05 * SR);
    const lateStrike = (n: number) => (n >= d && n < d + PULSE_N ? 1 : 0);
    const lo = rmsOf(runProc(new Proc(), makeParams({ level: -12 }), { seconds: 0.35, trigFn: lateStrike }));
    const unity = rmsOf(runProc(new Proc(), makeParams({ level: 0 }), { seconds: 0.35, trigFn: lateStrike }));
    const hi = rmsOf(runProc(new Proc(), makeParams({ level: 6 }), { seconds: 0.35, trigFn: lateStrike }));
    expect(lo).toBeLessThan(unity * 0.5);
    expect(hi).toBeGreaterThan(unity * 1.2);
  });

  it('pitch_cv input transposes the voice 1 V/oct', async () => {
    const Proc = await loadProcessor();
    const clean = makeParams({ bend_amt: 0, noise: 0, tone: 0, drive: 0, decay: 600 });
    const base = runProc(new Proc(), clean, { seconds: 0.4, trigFn: oneStrike });
    const up = runProc(new Proc(), makeParams({ bend_amt: 0, noise: 0, tone: 0, drive: 0, decay: 600 }), {
      seconds: 0.4,
      trigFn: oneStrike,
      pitchFn: () => 1,
    });
    const f0 = estimateFreq(base, Math.round(0.05 * SR), Math.round(0.2 * SR));
    const f1 = estimateFreq(up, Math.round(0.05 * SR), Math.round(0.2 * SR));
    expect(f0).toBeGreaterThan(0);
    expect(Math.abs(f1 / f0 - 2)).toBeLessThan(0.05); // one octave up
  });

  it('noise_cv input opens the breath layer', async () => {
    const Proc = await loadProcessor();
    // tune=200 puts the breath band-pass center at 500 Hz (2.5×), well
    // clear of the (bend-free) 200 Hz fundamental — probe that band.
    const base = { tune: 200, bend_amt: 0, noise: 0, tone: 0, drive: 0 };
    const dry = runProc(new Proc(), makeParams(base), { seconds: 0.2, trigFn: oneStrike });
    const breathy = runProc(new Proc(), makeParams(base), {
      seconds: 0.2,
      trigFn: oneStrike,
      noiseFn: () => 1,
    });
    const goertzel = (buf: Float32Array, hz: number, e: number): number => {
      const omega = (2 * Math.PI * hz) / SR;
      const coeff = 2 * Math.cos(omega);
      let q1 = 0;
      let q2 = 0;
      for (let i = 0; i < e; i++) {
        const win = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (e - 1)));
        const q0 = coeff * q1 - q2 + (buf[i] ?? 0) * win;
        q2 = q1;
        q1 = q0;
      }
      return q1 * q1 + q2 * q2 - q1 * q2 * coeff;
    };
    const w = Math.round(0.08 * SR);
    let eDry = 0;
    let eBreathy = 0;
    for (const hz of [420, 500, 560, 640]) {
      eDry += goertzel(dry, hz, w);
      eBreathy += goertzel(breathy, hz, w);
    }
    expect(eBreathy).toBeGreaterThan(3 * Math.max(eDry, 1e-12));
  });

  // ── remaining CV input routing (2026-07-11 sonic audit): bend_cv /
  // decay_cv / tone_cv are worklet inputs 3 / 4 / 5 — each cable must reach
  // its core law (the laws themselves are gated in tomtom-dsp.sonic-range).

  it('bend_cv input (3) deepens the strike sweep', async () => {
    const Proc = await loadProcessor();
    const base = { bend_amt: 0, noise: 0, tone: 0, drive: 0 };
    const flat = runProc(new Proc(), makeParams(base), { seconds: 0.4, trigFn: oneStrike });
    const bent = runProc(new Proc(), makeParams(base), {
      seconds: 0.4,
      trigFn: oneStrike,
      bendFn: () => 0.5, // +12 st of bend depth
    });
    const atk = (b: Float32Array) => estimateFreq(b, Math.round(0.002 * SR), Math.round(0.02 * SR));
    const set = (b: Float32Array) => estimateFreq(b, Math.round(0.25 * SR), Math.round(0.38 * SR));
    expect(atk(flat) / set(flat)).toBeLessThan(1.1); // no sweep without CV
    expect(atk(bent) / set(bent)).toBeGreaterThan(1.25); // audible dive with CV
  });

  it('decay_cv input (4) stretches the ring time (+0.5 V ≈ ×2)', async () => {
    const Proc = await loadProcessor();
    const dry = runProc(new Proc(), makeParams(), { seconds: 1.2, trigFn: oneStrike });
    const long = runProc(new Proc(), makeParams(), {
      seconds: 1.2,
      trigFn: oneStrike,
      decayFn: () => 0.5,
    });
    // 350 ms default → ~700 ms at +0.5 V: the late window only rings with CV.
    const s = Math.round(0.45 * SR);
    const e = Math.round(0.65 * SR);
    expect(rmsOf(long, s, e)).toBeGreaterThan(rmsOf(dry, s, e) * 3);
  });

  it('tone_cv input (5) brings the 1.593× overtone up', async () => {
    const Proc = await loadProcessor();
    const base = { tune: 110, bend_amt: 0, noise: 0, tone: 0, drive: 0 };
    const pure = runProc(new Proc(), makeParams(base), { seconds: 0.25, trigFn: oneStrike });
    const struck = runProc(new Proc(), makeParams(base), {
      seconds: 0.25,
      trigFn: oneStrike,
      toneFn: () => 0.7,
    });
    const goertzel = (buf: Float32Array, hz: number): number => {
      const e = Math.round(0.2 * SR);
      const omega = (2 * Math.PI * hz) / SR;
      const coeff = 2 * Math.cos(omega);
      let q1 = 0;
      let q2 = 0;
      for (let i = 0; i < e; i++) {
        const win = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (e - 1)));
        const q0 = coeff * q1 - q2 + (buf[i] ?? 0) * win;
        q2 = q1;
        q1 = q0;
      }
      return q1 * q1 + q2 * q2 - q1 * q2 * coeff;
    };
    const ot = 110 * 1.593;
    const ratioPure = goertzel(pure, ot) / Math.max(goertzel(pure, 110), 1e-12);
    const ratioStruck = goertzel(struck, ot) / Math.max(goertzel(struck, 110), 1e-12);
    expect(ratioStruck).toBeGreaterThan(ratioPure * 5 + 0.01);
  });
});
