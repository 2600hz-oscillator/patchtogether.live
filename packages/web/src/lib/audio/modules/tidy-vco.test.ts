// packages/web/src/lib/audio/modules/tidy-vco.test.ts
//
// TIDY VCO module-def shape + worklet-wrapper behavior. The per-sample DSP
// math (diode-ladder tuning gate, RC-ADSR curves, OTA VCA bloom, the
// sonic-range proofs) is pinned in packages/dsp/src/lib/tidy-vco-dsp.test.ts
// + tidy-vco-dsp.sonic-range.test.ts, and the raw audio profile in
// art/scenarios/tidy-vco/profile.test.ts. This file enforces the FROZEN
// module-def contract (ports incl. edge semantics + the stereo pair, all
// 23 params, docs completeness) and the wrapper behaviors: silence without
// a gate, the mono gate path, the HOLD pad OR path, the poly bus driving
// voices at lane pitch, pitch-input V/oct tracking, and the level stage.

import { describe, it, expect, beforeAll } from 'vitest';
import { tidyVcoDef } from './tidy-vco';

const SR = 48000;
beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

// Capture the Processor class via the registerProcessor shim (the
// kickdrum/tomtom/clap loader pattern).
type Proc = {
  process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean;
};
type ProcCtor = (new () => Proc) & {
  parameterDescriptors: Array<{
    name: string;
    defaultValue: number;
    minValue: number;
    maxValue: number;
    automationRate: string;
  }>;
};
let capturedProc: ProcCtor | null = null;
async function loadProcessor(): Promise<ProcCtor> {
  if (capturedProc) return capturedProc;
  const g = globalThis as unknown as { registerProcessor?: (n: string, c: ProcCtor) => void };
  const prev = g.registerProcessor;
  let registered: ProcCtor | null = null;
  g.registerProcessor = (_n, ctor) => {
    registered = ctor;
  };
  await import('../../../../../dsp/src/tidy-vco');
  g.registerProcessor = prev;
  if (!registered) throw new Error('tidy-vco processor did not register');
  capturedProc = registered;
  return capturedProc;
}

// ───────────────────────────────────────────────────────────────────────
// Module-def shape (the frozen contract)
// ───────────────────────────────────────────────────────────────────────

describe('TIDY VCO def — frozen contract', () => {
  it('identity: type/label/category/domain (label lowercase per the guard)', () => {
    expect(tidyVcoDef.type).toBe('tidyVco');
    expect(tidyVcoDef.label).toBe('tidy vco');
    expect(tidyVcoDef.label).toBe(tidyVcoDef.label.toLowerCase());
    expect(tidyVcoDef.domain).toBe('audio');
    expect(tidyVcoDef.category).toBe('sources');
    expect(tidyVcoDef.size).toBe('3u'); // measured: ~527×720px natural box, 4 hp
  });

  it('ports: poly bus + mono pitch/gate (edge:gate) + per-knob worklet CVs in, stereo pair out', () => {
    expect(tidyVcoDef.inputs.map((p) => p.id)).toEqual([
      'poly', 'pitch', 'gate',
      'cutoff_cv', 'res_cv', 'pwm_cv', 'drive_cv', 'fold_cv', 'sym_cv',
      'shape1_cv', 'shape2_cv', 'detune_cv', 'oct2_cv', 'mix_cv', 'sub_cv', 'env_cv', 'track_cv',
      'fatk_cv', 'fdec_cv', 'fsus_cv', 'frel_cv', 'atk_cv', 'dec_cv', 'sus_cv', 'rel_cv',
      'width_cv', 'level_cv',
    ]);
    expect(tidyVcoDef.inputs.find((p) => p.id === 'poly')!.type).toBe('polyPitchGate');
    // No edge on the poly port (lane edges are consumed in the worklet).
    expect(tidyVcoDef.inputs.find((p) => p.id === 'poly')!.edge).toBeUndefined();
    const gate = tidyVcoDef.inputs.find((p) => p.id === 'gate')!;
    expect(gate.type).toBe('gate');
    expect(gate.edge).toBe('gate'); // level-sensitive — an ADSR sustain, declared
    expect(tidyVcoDef.inputs.find((p) => p.id === 'pitch')!.type).toBe('cv');
    for (const id of [
      'cutoff_cv', 'res_cv', 'pwm_cv', 'drive_cv', 'fold_cv', 'sym_cv',
      'shape1_cv', 'shape2_cv', 'detune_cv', 'oct2_cv', 'mix_cv', 'sub_cv', 'env_cv', 'track_cv',
      'fatk_cv', 'fdec_cv', 'fsus_cv', 'frel_cv', 'atk_cv', 'dec_cv', 'sus_cv', 'rel_cv',
      'width_cv', 'level_cv',
    ]) {
      expect(tidyVcoDef.inputs.find((p) => p.id === id)!.type).toBe('cv');
    }
    expect(tidyVcoDef.outputs).toEqual([
      { id: 'out_l', type: 'audio' },
      { id: 'out_r', type: 'audio' },
    ]);
    expect(tidyVcoDef.stereoPairs).toEqual([['out_l', 'out_r']]);
  });

  it('params: the 24-knob voice + the HOLD pad (incl. the FOLD/SYM wavefolder)', () => {
    expect(tidyVcoDef.params.map((p) => p.id)).toEqual([
      'shape1', 'shape2', 'pw', 'detune', 'oct2', 'mix', 'sub',
      'fold', 'sym',
      'cutoff', 'res', 'drive', 'env', 'track',
      'fatk', 'fdec', 'fsus', 'frel',
      'atk', 'dec', 'sus', 'rel',
      'width', 'level', 'hold',
    ]);
    const byId = Object.fromEntries(tidyVcoDef.params.map((p) => [p.id, p]));
    expect(byId.cutoff).toMatchObject({ min: 40, max: 14000, defaultValue: 900, curve: 'log', units: 'Hz' });
    expect(byId.fold).toMatchObject({ min: 0, max: 1, defaultValue: 0, curve: 'linear' });
    expect(byId.sym).toMatchObject({ min: -1, max: 1, defaultValue: 0, curve: 'linear' });
    expect(byId.detune).toMatchObject({ min: -50, max: 50, defaultValue: 6 });
    expect(byId.oct2).toMatchObject({ min: -1, max: 1, defaultValue: 0, curve: 'discrete' });
    expect(byId.env).toMatchObject({ min: -1, max: 1, defaultValue: 0.45 });
    expect(byId.level).toMatchObject({ min: -24, max: 12, defaultValue: 0, units: 'dB' });
    expect(byId.hold).toMatchObject({ min: 0, max: 1, defaultValue: 0, curve: 'discrete' });
    for (const id of ['fatk', 'fdec', 'frel', 'atk', 'dec', 'rel']) {
      expect(byId[id]!.curve, `${id} is a log time knob`).toBe('log');
      expect(byId[id]!.units).toBe('s');
    }
  });

  it('ships co-located docs for every port + param (the STRICT_DOCS bar)', () => {
    const docs = tidyVcoDef.docs!;
    expect(docs.explanation!.length).toBeGreaterThan(300);
    for (const p of tidyVcoDef.inputs) expect(docs.inputs![p.id], p.id).toBeTruthy();
    for (const p of tidyVcoDef.outputs) expect(docs.outputs![p.id], p.id).toBeTruthy();
    for (const p of tidyVcoDef.params) expect(docs.controls![p.id], p.id).toBeTruthy();
  });
});

// ───────────────────────────────────────────────────────────────────────
// Worklet processor — load + wrapper behavior
// ───────────────────────────────────────────────────────────────────────

const BLOCK = 128;

function makeParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const base: Record<string, number> = {};
  for (const p of tidyVcoDef.params) base[p.id] = p.defaultValue;
  Object.assign(base, over);
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(base)) out[k] = new Float32Array([v]);
  return out;
}

interface RunOpts {
  seconds: number;
  /** Poly lane snapshot applied every block (length 10). */
  poly?: number[];
  pitch?: number;
  gateFn?: (n: number) => number;
}

/** Run the processor and capture the stereo output. */
function runProc(
  proc: Proc,
  params: Record<string, Float32Array>,
  opts: RunOpts,
): { l: Float32Array; r: Float32Array } {
  const total = Math.round(SR * opts.seconds);
  const l = new Float32Array(total);
  const r = new Float32Array(total);
  const polyCh: Float32Array[] = [];
  for (let c = 0; c < 10; c++) {
    polyCh.push(new Float32Array(BLOCK).fill(opts.poly?.[c] ?? 0));
  }
  const pitchCh = new Float32Array(BLOCK).fill(opts.pitch ?? 0);
  const gateCh = new Float32Array(BLOCK);
  const zero = new Float32Array(BLOCK);
  for (let n = 0; n + BLOCK <= total; n += BLOCK) {
    gateCh.fill(opts.gateFn ? opts.gateFn(n) : 0);
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    proc.process(
      [polyCh, [pitchCh], [gateCh], [zero], [zero], [zero], [zero], [zero], [zero]],
      [[outL], [outR]],
      params,
    );
    l.set(outL, n);
    r.set(outR, n);
  }
  return { l, r };
}

function rms(buf: Float32Array, s0: number, s1: number): number {
  let s = 0;
  for (let i = s0; i < s1; i++) s += (buf[i] ?? 0) ** 2;
  return Math.sqrt(s / Math.max(1, s1 - s0));
}

function goertzel(buf: Float32Array, hz: number, s0: number, s1: number): number {
  const n = s1 - s0;
  const w = (2 * Math.PI * hz) / SR;
  const c = 2 * Math.cos(w);
  let q1 = 0;
  let q2 = 0;
  for (let i = s0; i < s1; i++) {
    const wnd = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i - s0)) / n);
    const q0 = c * q1 - q2 + (buf[i] ?? 0) * wnd;
    q2 = q1;
    q1 = q0;
  }
  return Math.sqrt(Math.max(0, q1 * q1 + q2 * q2 - c * q1 * q2)) / n;
}

describe('TIDY VCO worklet wrapper', () => {
  it('parameterDescriptors match the def params 1:1 (ids, defaults, ranges)', async () => {
    const Ctor = await loadProcessor();
    const desc = Ctor.parameterDescriptors;
    expect(desc.map((d) => d.name)).toEqual(tidyVcoDef.params.map((p) => p.id));
    for (const p of tidyVcoDef.params) {
      const d = desc.find((x) => x.name === p.id)!;
      expect(d.defaultValue, p.id).toBe(p.defaultValue);
      expect(d.minValue, p.id).toBe(p.min);
      expect(d.maxValue, p.id).toBe(p.max);
      // Discrete switch/pad → k-rate, continuous knobs → a-rate.
      expect(d.automationRate, p.id).toBe(p.id === 'oct2' || p.id === 'hold' ? 'k-rate' : 'a-rate');
    }
  });

  it('stays silent with no gate anywhere', async () => {
    const Ctor = await loadProcessor();
    const { l, r } = runProc(new Ctor(), makeParams(), { seconds: 0.4 });
    expect(rms(l, 0, l.length)).toBeLessThan(1e-6);
    expect(rms(r, 0, r.length)).toBeLessThan(1e-6);
  });

  it('the mono gate input opens the voice on BOTH outputs', async () => {
    const Ctor = await loadProcessor();
    const { l, r } = runProc(new Ctor(), makeParams(), { seconds: 0.6, gateFn: () => 1 });
    expect(rms(l, SR / 4, l.length)).toBeGreaterThan(0.02);
    expect(rms(r, SR / 4, r.length)).toBeGreaterThan(0.02);
  });

  it('the HOLD pad drones the voice with nothing patched (OR path)', async () => {
    const Ctor = await loadProcessor();
    const { l } = runProc(new Ctor(), makeParams({ hold: 1 }), { seconds: 0.6 });
    expect(rms(l, SR / 4, l.length)).toBeGreaterThan(0.02);
  });

  it('a poly lane plays its OWN pitch (lane 2 at +7 st → G4 fundamental)', async () => {
    const Ctor = await loadProcessor();
    const poly = new Array(10).fill(0);
    poly[4] = 7 / 12; // lane 2 pitch
    poly[5] = 1; // lane 2 gate
    const params = makeParams({ detune: 0, sub: 0, mix: 0, width: 0, res: 0.2, cutoff: 6000, env: 0 });
    const { l } = runProc(new Ctor(), params, { seconds: 0.8, poly });
    const g4 = goertzel(l, 392.0, SR / 4, l.length);
    const c4 = goertzel(l, 261.63, SR / 4, l.length);
    expect(g4).toBeGreaterThan(0.003);
    expect(g4 / Math.max(c4, 1e-9)).toBeGreaterThan(4);
  });

  it('the pitch input tracks V/oct (+1 V doubles the fundamental)', async () => {
    const Ctor = await loadProcessor();
    const params = makeParams({ detune: 0, sub: 0, mix: 0, width: 0, res: 0.2, cutoff: 6000, env: 0 });
    const at = (pitch: number, hz: number): number => {
      const { l } = runProc(new Ctor(), params, { seconds: 0.7, pitch, gateFn: () => 1 });
      return goertzel(l, hz, SR / 4, l.length);
    };
    // At +1 V the fundamental sits at C5 with NOTHING below it (a saw has
    // no subharmonics); at 0 V the C4 fundamental is present. (Comparing
    // C5 energy across the two runs would be confounded — C5 is exactly
    // the C4 saw's 2nd harmonic.)
    expect(at(1, 523.25)).toBeGreaterThan(0.003); // C5 fundamental at +1 V
    expect(at(1, 523.25) / Math.max(at(1, 261.63), 1e-9)).toBeGreaterThan(6);
    expect(at(0, 261.63)).toBeGreaterThan(0.003); // C4 fundamental at 0 V
  });

  it('the LEVEL stage is a real dB gain (−24 dB ≈ 1/16 of RMS)', async () => {
    const Ctor = await loadProcessor();
    const base = { detune: 0, width: 0, res: 0.2, env: 0, sus: 1 };
    const loud = runProc(new Ctor(), makeParams(base), { seconds: 0.7, gateFn: () => 1 });
    const quiet = runProc(new Ctor(), makeParams({ ...base, level: -24 }), {
      seconds: 0.7,
      gateFn: () => 1,
    });
    const ratio = rms(loud.l, SR / 2, loud.l.length) / rms(quiet.l, SR / 2, quiet.l.length);
    expect(ratio).toBeGreaterThan(10);
    expect(ratio).toBeLessThan(25);
  });
});
