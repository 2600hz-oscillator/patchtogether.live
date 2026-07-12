// packages/web/src/lib/audio/modules/karplus.test.ts
//
// KARPLUS module-def shape + worklet-wrapper behavior. The per-sample DSP
// math (tuning < 3 cents, ρ-compensated decay, stability at the extremes)
// is pinned in packages/dsp/src/lib/karplus-dsp.test.ts and the raw audio
// profile in art/scenarios/karplus/profile.test.ts. This file enforces the
// FROZEN module-def contract (ports incl. edge semantics + the 1 V/oct
// pitch cable, all 8 params, mono out, per-param CV routing) and the
// wrapper behaviors: param-table ↔ def agreement, strike → audible ring,
// pitch input transposition, DAMP gating and the dB level stage.

import { describe, it, expect, beforeAll } from 'vitest';
import { karplusDef } from './karplus';

const SR = 48000;
beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

// Capture the Processor class via the registerProcessor shim (the
// kickdrum.test.ts loader pattern).
type ProcCtor = (new () => {
  process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean;
}) & {
  parameterDescriptors?: ReadonlyArray<{ name: string; defaultValue: number; minValue: number; maxValue: number }>;
};
let capturedProc: ProcCtor | null = null;
async function loadProcessor(): Promise<ProcCtor> {
  if (capturedProc) return capturedProc;
  const g = globalThis as unknown as { registerProcessor?: (n: string, c: ProcCtor) => void };
  const prev = g.registerProcessor;
  let registered: ProcCtor | null = null;
  g.registerProcessor = (_n, ctor) => { registered = ctor; };
  await import('../../../../../dsp/src/karplus');
  g.registerProcessor = prev;
  if (!registered) throw new Error('karplus processor did not register');
  capturedProc = registered;
  return capturedProc;
}

// ───────────────────────────────────────────────────────────────────────
// Module-def shape (the frozen contract)
// ───────────────────────────────────────────────────────────────────────

describe('KARPLUS def — frozen contract', () => {
  it('declares the voice I/O: trigger strike, 1V/oct pitch, damp gate, CV set, mono out', () => {
    const inputs = new Map(karplusDef.inputs.map((p) => [p.id, p]));
    expect(inputs.get('trigger_in')?.type).toBe('gate');
    expect(inputs.get('trigger_in')?.edge).toBe('trigger');
    expect(inputs.get('pitch')?.type).toBe('pitch');
    expect(inputs.get('accent_in')?.type).toBe('cv');
    expect(inputs.get('damp_in')?.type).toBe('gate');
    expect(inputs.get('damp_in')?.edge).toBe('gate');
    // Per-param CV inputs route to their AudioParams (cofefve convention).
    for (const [port, target] of [
      ['decay_cv', 'decay'],
      ['bright_cv', 'brightness'],
      ['position_cv', 'position'],
      ['stiff_cv', 'stiffness'],
      ['color_cv', 'color'],
    ] as const) {
      expect(inputs.get(port)?.type).toBe('cv');
      expect(inputs.get(port)?.paramTarget).toBe(target);
      expect(inputs.get(port)?.cvScale).toBeTruthy();
    }
    expect(karplusDef.inputs).toHaveLength(9);
    expect(karplusDef.outputs).toEqual([{ id: 'out', type: 'audio' }]);
  });

  it('label is lowercase and the 8-param set matches the curated control design', () => {
    expect(karplusDef.label).toBe(karplusDef.label.toLowerCase());
    expect(karplusDef.params.map((p) => p.id)).toEqual([
      'tune', 'decay', 'brightness', 'position', 'stiffness', 'color', 'burst', 'level',
    ]);
  });

  it('worklet parameterDescriptors mirror the def params 1:1 (name/default/range)', async () => {
    const Proc = await loadProcessor();
    const desc = Proc.parameterDescriptors;
    expect(desc).toBeTruthy();
    const byName = new Map(desc!.map((d) => [d.name, d]));
    for (const p of karplusDef.params) {
      const d = byName.get(p.id);
      expect(d, `worklet param ${p.id}`).toBeTruthy();
      expect(d!.defaultValue).toBe(p.defaultValue);
      expect(d!.minValue).toBe(p.min);
      expect(d!.maxValue).toBe(p.max);
    }
    expect(desc!.length).toBe(karplusDef.params.length);
  });

  it('ships complete co-located docs (explanation + every port + every control)', () => {
    const docs = karplusDef.docs!;
    expect(docs.explanation?.length ?? 0).toBeGreaterThan(200);
    for (const p of karplusDef.inputs) expect(docs.inputs?.[p.id], `docs.inputs.${p.id}`).toBeTruthy();
    for (const p of karplusDef.outputs) expect(docs.outputs?.[p.id], `docs.outputs.${p.id}`).toBeTruthy();
    for (const p of karplusDef.params) expect(docs.controls?.[p.id], `docs.controls.${p.id}`).toBeTruthy();
  });
});

// ───────────────────────────────────────────────────────────────────────
// Worklet processor — load + behavior the wrapper owns
// ───────────────────────────────────────────────────────────────────────

const BLOCK = 128;

function makeParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const base: Record<string, number> = {};
  for (const p of karplusDef.params) base[p.id] = p.defaultValue;
  Object.assign(base, over);
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(base)) out[k] = new Float32Array([v]);
  return out;
}

interface RunOpts {
  seconds: number;
  trigFn?: (n: number) => number;
  pitchFn?: (n: number) => number;
  accentFn?: (n: number) => number;
  dampFn?: (n: number) => number;
}

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
    const inTrig = new Float32Array(len);
    const inPitch = new Float32Array(len);
    const inAccent = new Float32Array(len);
    const inDamp = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      inTrig[i] = opts.trigFn ? opts.trigFn(g + i) : 0;
      inPitch[i] = opts.pitchFn ? opts.pitchFn(g + i) : 0;
      inAccent[i] = opts.accentFn ? opts.accentFn(g + i) : 0;
      inDamp[i] = opts.dampFn ? opts.dampFn(g + i) : 0;
    }
    const blockOut = new Float32Array(len);
    proc.process([[inTrig], [inPitch], [inAccent], [inDamp]], [[blockOut]], params);
    out.set(blockOut, g);
    g += len;
  }
  return out;
}

const rmsOf = (b: Float32Array, s = 0, e = b.length): number => {
  let x = 0;
  for (let i = s; i < e; i++) x += (b[i] ?? 0) * (b[i] ?? 0);
  return Math.sqrt(x / Math.max(1, e - s));
};

/** Dominant period (samples) via a normalized autocorrelation scan. */
function dominantPeriod(b: Float32Array, from: number, to: number, lagLo: number, lagHi: number): number {
  let bestLag = lagLo;
  let best = -Infinity;
  for (let lag = lagLo; lag <= lagHi; lag++) {
    let acc = 0;
    for (let i = from; i < to - lag; i++) acc += b[i]! * b[i + lag]!;
    if (acc > best) { best = acc; bestLag = lag; }
  }
  return bestLag;
}

// A 5 ms trigger pulse at sample 0 (one clean GATE_HI crossing).
const PULSE_N = Math.round(0.005 * SR);
const oneStrike = (n: number) => (n < PULSE_N ? 1 : 0);

describe('KARPLUS worklet — load + wrapper behavior', () => {
  it('Processor class registers without throwing', async () => {
    const Proc = await loadProcessor();
    expect(Proc).toBeTruthy();
    expect(() => new Proc()).not.toThrow();
  });

  it('no trigger → silent output (no spontaneous oscillation)', async () => {
    const Proc = await loadProcessor();
    const out = runProc(new Proc(), makeParams(), { seconds: 0.2 });
    expect(rmsOf(out)).toBe(0);
  });

  it('a strike rings audibly and decays; render is finite', async () => {
    const Proc = await loadProcessor();
    const out = runProc(new Proc(), makeParams(), { seconds: 1.0, trigFn: oneStrike });
    expect(out.every(Number.isFinite)).toBe(true);
    expect(rmsOf(out, 0, Math.round(0.3 * SR))).toBeGreaterThan(0.01);
    // decay=2s default: the late window is quieter than the attack window.
    expect(rmsOf(out, Math.round(0.7 * SR), out.length)).toBeLessThan(
      rmsOf(out, 0, Math.round(0.3 * SR)),
    );
  });

  it('the pitch input transposes at 1 V/oct (period halves at +1 V)', async () => {
    const Proc = await loadProcessor();
    const base = runProc(new Proc(), makeParams({ tune: 220 }), { seconds: 0.6, trigFn: oneStrike });
    const up = runProc(new Proc(), makeParams({ tune: 220 }), {
      seconds: 0.6,
      trigFn: oneStrike,
      pitchFn: () => 1,
    });
    const from = Math.round(0.25 * SR);
    const to = Math.round(0.55 * SR);
    const p0 = dominantPeriod(base, from, to, 150, 300); // ≈ 218 @ 220 Hz
    const p1 = dominantPeriod(up, from, to, 75, 150); // ≈ 109 @ 440 Hz
    expect(Math.abs(p0 / p1 - 2)).toBeLessThan(0.05);
  });

  it('DAMP input chokes the ring WHILE high (level-sensitive gate)', async () => {
    const Proc = await loadProcessor();
    const free = runProc(new Proc(), makeParams(), { seconds: 0.8, trigFn: oneStrike });
    const damped = runProc(new Proc(), makeParams(), {
      seconds: 0.8,
      trigFn: oneStrike,
      dampFn: (n) => (n >= Math.round(0.3 * SR) ? 1 : 0),
    });
    const s = Math.round(0.5 * SR);
    const e = Math.round(0.7 * SR);
    expect(rmsOf(damped, s, e)).toBeLessThan(rmsOf(free, s, e) * 0.05);
  });

  it('LEVEL is a dB stage (−12 dB ≈ ×0.25 in power)', async () => {
    const Proc = await loadProcessor();
    const unity = runProc(new Proc(), makeParams({ level: 0 }), { seconds: 0.5, trigFn: oneStrike });
    const quiet = runProc(new Proc(), makeParams({ level: -12 }), { seconds: 0.5, trigFn: oneStrike });
    const ratio = rmsOf(quiet, Math.round(0.2 * SR)) / rmsOf(unity, Math.round(0.2 * SR));
    expect(ratio).toBeGreaterThan(0.22);
    expect(ratio).toBeLessThan(0.29);
  });

  it('renders are deterministic (seeded burst — bit-identical re-run)', async () => {
    const Proc = await loadProcessor();
    const a = runProc(new Proc(), makeParams(), { seconds: 0.5, trigFn: oneStrike });
    const b = runProc(new Proc(), makeParams(), { seconds: 0.5, trigFn: oneStrike });
    let maxDiff = 0;
    for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i]! - b[i]!));
    expect(maxDiff).toBe(0);
  });

  // ── CV plumbing (2026-07-11 sonic audit): the five *_cv ports modulate
  // through AudioParams, so the wrapper must (1) declare every param a-rate
  // and (2) actually read the PER-SAMPLE parameter array — a k-rate-style
  // arr[0] read would silently freeze CV modulation at the block edge. ──

  it('every param is a-rate (per-sample CV modulation reaches the DSP)', async () => {
    const Proc = await loadProcessor();
    const desc = Proc.parameterDescriptors as ReadonlyArray<{ name: string; automationRate?: string }>;
    for (const d of desc) {
      expect(d.automationRate, `param ${d.name}`).toBe('a-rate');
    }
  });

  it('an a-rate brightness array modulates hits within one render (bright_cv path)', async () => {
    const Proc = await loadProcessor();
    // One render, two strikes: the brightness parameter is a PER-SAMPLE
    // array (what an AudioParam carries under CV modulation) that sits dark
    // for hit 1 and steps bright before hit 2 — the step lands mid-block.
    // (A brightness step mid-RING is nearly inert — a dark string holds only
    // its fundamental by then, verified at the core — so the audible seam is
    // per-hit, matching the bright_cv doc.)
    const seconds = 0.8;
    const strike2 = Math.round(0.4 * SR);
    const stepAt = Math.round(0.33 * SR);
    const pulse = Math.round(0.005 * SR);
    const renderWith = (brightFn: ((n: number) => number) | null): Float32Array => {
      const proc = new Proc();
      const params = makeParams({ brightness: 0.1 });
      const total = Math.round(SR * seconds);
      const out = new Float32Array(total);
      let g = 0;
      while (g < total) {
        const len = Math.min(BLOCK, total - g);
        const inTrig = new Float32Array(len);
        for (let i = 0; i < len; i++) {
          const n = g + i;
          inTrig[i] = n < pulse || (n >= strike2 && n < strike2 + pulse) ? 1 : 0;
        }
        if (brightFn) {
          const arr = new Float32Array(len);
          for (let i = 0; i < len; i++) arr[i] = brightFn(g + i);
          params['brightness'] = arr;
        }
        const blockOut = new Float32Array(len);
        proc.process(
          [[inTrig], [new Float32Array(len)], [new Float32Array(len)], [new Float32Array(len)]],
          [[blockOut]],
          params,
        );
        out.set(blockOut, g);
        g += len;
      }
      return out;
    };
    const darkRef = renderWith(null);
    const modulated = renderWith((n) => (n < stepAt ? 0.1 : 0.95));
    const zcr = (b: Float32Array, sS: number, eS: number): number => {
      const s = Math.round(sS * SR);
      const e = Math.round(eS * SR);
      let c = 0;
      for (let i = s + 1; i < e; i++) if (b[i - 1]! < 0 !== b[i]! < 0) c++;
      return c;
    };
    // Hit 2 in the modulated render rings brighter + louder than (a) hit 1
    // of the SAME render and (b) hit 2 of the constant-dark reference.
    expect(rmsOf(modulated, strike2, Math.round(0.7 * SR))).toBeGreaterThan(
      rmsOf(modulated, 0, Math.round(0.3 * SR)) * 1.5,
    );
    expect(rmsOf(modulated, strike2, Math.round(0.7 * SR))).toBeGreaterThan(
      rmsOf(darkRef, strike2, Math.round(0.7 * SR)) * 1.5,
    );
    expect(zcr(modulated, 0.45, 0.7)).toBeGreaterThan(zcr(darkRef, 0.45, 0.7) * 1.3);
  });

  it('accent_in (input 2) latched at the strike lands a hotter hit', async () => {
    const Proc = await loadProcessor();
    const soft = runProc(new Proc(), makeParams(), { seconds: 0.4, trigFn: oneStrike });
    const hard = runProc(new Proc(), makeParams(), {
      seconds: 0.4,
      trigFn: oneStrike,
      accentFn: () => 1,
    });
    expect(rmsOf(hard, 0, Math.round(0.3 * SR))).toBeGreaterThan(
      rmsOf(soft, 0, Math.round(0.3 * SR)) * 1.3,
    );
  });
});
