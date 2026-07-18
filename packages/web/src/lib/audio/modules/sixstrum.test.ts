// packages/web/src/lib/audio/modules/sixstrum.test.ts
//
// SIX STRUM module-def contract + worklet-wrapper WIRING. The per-sample DSP
// (strum/mute/poly/chord/body, decay, determinism) is pinned in
// packages/dsp/src/lib/sixstrum-dsp.test.ts and the raw audio profile in
// art/scenarios/sixstrum/profile.test.ts. THIS file enforces the frozen def
// (15 ports incl. edge semantics + the poly cable + 19 params, mono out) and
// the worklet's INPUT WIRING — the layer only an end-to-end wrapper test
// catches (the silent-poly / mis-indexed-input bug class, POLYHELM #674): a
// strum #1 rising edge barres audio out, and a poly note-on drives a voice.

import { describe, it, expect, beforeAll } from 'vitest';
import { sixstrumDef } from './sixstrum';
import { scaleCv } from '$lib/audio/cv-scale';
import type { CvScaleHint, ModuleNode } from '$lib/graph/types';

// The 7 per-knob CV modulators: [port id, target param id, cvScale mode]. Owner
// request "cv input for tone, grain, spread, body, strum roll, dir, chord" →
// pickTone/pickGrain/spread/body/strumSpread + the DISCRETE strumDir/quality.
const CV_PORTS: ReadonlyArray<readonly [string, string, CvScaleHint['mode']]> = [
  ['tone_cv', 'pickTone', 'linear'],
  ['grain_cv', 'pickGrain', 'log'],
  ['spread_cv', 'spread', 'linear'],
  ['body_cv', 'body', 'linear'],
  ['strum_cv', 'strumSpread', 'linear'],
  ['dir_cv', 'strumDir', 'discrete'],
  ['chord_cv', 'quality', 'discrete'],
];

const SR = 48000;
const N = 128;
beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

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
  await import('../../../../../dsp/src/sixstrum');
  g.registerProcessor = prev;
  if (!registered) throw new Error('sixstrum processor did not register');
  capturedProc = registered;
  return capturedProc;
}

const blk = (v: number) => new Float32Array(N).fill(v);
const kparams = () => {
  const p: Record<string, Float32Array> = {};
  for (const d of sixstrumDef.params) p[d.id] = new Float32Array([d.defaultValue]);
  return p;
};

/** Drive `blocks` process() calls with a fixed 15-input frame; return the full
 *  concatenated output. `inputs` is the reused Float32Array[][] (unpatched = []). */
function driveBuf(proc: InstanceType<ProcCtor>, inputs: Float32Array[][], params: Record<string, Float32Array>, blocks: number): Float32Array {
  const buf = new Float32Array(blocks * N);
  for (let b = 0; b < blocks; b++) {
    const out = [blk(0)];
    proc.process(inputs, [out], params);
    buf.set(out[0]!, b * N);
  }
  return buf;
}
const peakOf = (b: Float32Array) => { let p = 0; for (const v of b) p = Math.max(p, Math.abs(v)); return p; };
const rmsOf = (b: Float32Array) => { let x = 0; for (const v of b) x += v * v; return Math.sqrt(x / Math.max(1, b.length)); };
const drivePeak = (proc: InstanceType<ProcCtor>, inputs: Float32Array[][], params: Record<string, Float32Array>, blocks: number): number =>
  peakOf(driveBuf(proc, inputs, params, blocks));

/** 15 unpatched inputs. */
const empty15 = (): Float32Array[][] => Array.from({ length: 15 }, () => [] as Float32Array[]);

describe('SIX STRUM def — frozen contract', () => {
  it('declares poly + chord + 6 strum (trigger) + 6 mute (gate) + accent, mono out', () => {
    const inputs = new Map(sixstrumDef.inputs.map((p) => [p.id, p]));
    expect(inputs.get('poly')?.type).toBe('polyPitchGate');
    expect(inputs.get('chord')?.type).toBe('pitch');
    expect(inputs.get('accent')?.type).toBe('cv');
    for (let i = 1; i <= 6; i++) {
      expect(inputs.get(`strum${i}`)?.type).toBe('gate');
      expect(inputs.get(`strum${i}`)?.edge).toBe('trigger');
      expect(inputs.get(`mute${i}`)?.type).toBe('gate');
      expect(inputs.get(`mute${i}`)?.edge).toBe('gate');
    }
    // Per-knob CV modulators (Pattern A: paramTarget + cvScale onto the AudioParam).
    for (const [port, target, mode] of CV_PORTS) {
      expect(inputs.get(port)?.type).toBe('cv');
      expect(inputs.get(port)?.paramTarget).toBe(target);
      expect(inputs.get(port)?.cvScale?.mode).toBe(mode);
    }
    expect(sixstrumDef.inputs).toHaveLength(22); // 15 structural + 7 per-knob CV
    expect(sixstrumDef.outputs).toEqual([{ id: 'out', type: 'audio' }]);
  });

  it('label is lowercase; the 19-param set is the Luthier control scheme', () => {
    expect(sixstrumDef.label).toBe(sixstrumDef.label.toLowerCase());
    expect(sixstrumDef.params.map((p) => p.id)).toEqual([
      'register', 'ring', 'material', 'pickPos', 'stiffness', 'pickTone', 'pickGrain',
      'attack', 'envDecay', 'sustain', 'release', 'muteDepth', 'strumSpread', 'strumDir',
      'spread', 'body', 'level', 'tuning', 'quality',
    ]);
  });

  it('worklet parameterDescriptors match the def params exactly', async () => {
    const Proc = await loadProcessor();
    const descNames = (Proc.parameterDescriptors ?? []).map((d) => d.name).sort();
    const defNames = sixstrumDef.params.map((p) => p.id).sort();
    expect(descNames).toEqual(defNames);
    // defaults agree
    const byName = new Map((Proc.parameterDescriptors ?? []).map((d) => [d.name, d]));
    for (const p of sixstrumDef.params) {
      expect(byName.get(p.id)?.defaultValue).toBe(p.defaultValue);
    }
  });
});

describe('SIX STRUM worklet — input wiring', () => {
  it('a STRUM #1 rising edge (input 2) barres all six strings → audible out', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const inputs = empty15();
    inputs[2] = [blk(1)]; // strum1 held high (rising edge on the first sample)
    // ~0.12 s of blocks: the barre strikes (staggered) and rings.
    const peak = drivePeak(proc, inputs, kparams(), Math.ceil((0.12 * SR) / N));
    expect(peak).toBeGreaterThan(0.02);
  });

  it('a POLY note-on (input 0) drives a voice → audible out (no silent-poly bug)', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const inputs = empty15();
    // 12-channel poly cable: lane 0 pitch = 0 V/oct (C4), gate = 1.
    const poly = Array.from({ length: 12 }, () => blk(0));
    poly[1] = blk(1); // lane 0 gate high
    inputs[0] = poly;
    const params = kparams();
    const peak = drivePeak(proc, inputs, params, Math.ceil((0.1 * SR) / N));
    expect(peak).toBeGreaterThan(0.02);
  });

  it('nothing patched → silence (base_vol 0, no drone)', async () => {
    const Proc = await loadProcessor();
    const proc = new Proc();
    const peak = drivePeak(proc, empty15(), kparams(), Math.ceil((0.05 * SR) / N));
    expect(peak).toBeLessThan(1e-5);
  });

  it('holding MUTE #1 (input 8) chokes the strummed string (dead, not ringing)', async () => {
    const Proc = await loadProcessor();
    const params = kparams();
    params.muteDepth = new Float32Array([0.9]);
    const blocks = Math.ceil((0.4 * SR) / N);

    // strum #1 (input 2) barres; both runs strike, the muted run holds mute1
    // high so string 1's ring collapses. Compare TOTAL energy (the mute chokes
    // the sustained ring, not the initial pluck transient/peak).
    const open = new Proc();
    const inOpen = empty15();
    inOpen[2] = [blk(1)];
    const openRms = rmsOf(driveBuf(open, inOpen, params, blocks));

    const muted = new Proc();
    const inMuted = empty15();
    inMuted[2] = [blk(1)];
    inMuted[8] = [blk(1)]; // mute1 held → string 1 dead
    const mutedRms = rmsOf(driveBuf(muted, inMuted, params, blocks));

    expect(openRms).toBeGreaterThan(0.005);
    expect(mutedRms).toBeLessThan(openRms); // muting one of six strings lowers total energy
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Per-knob CV modulation (Pattern A). The engine's addEdge interposes a
// WaveShaper (buildCvCurve → scaleCv) between a `cv` source and the target
// AudioParam whenever the destination port declares cvScale + paramTarget —
// pinned generically in engine-cv-scale.test.ts. HERE we prove the SIX STRUM-
// specific contract: (1) each _cv port's cvScale+paramTarget makes a ±1 CV
// actually MOVE its target param across the natural range (the same scaleCv
// the WaveShaper bakes), with the two DISCRETE selectors quantizing to the
// right index range; and (2) the factory's inputsMap routes each _cv port onto
// the AudioParam its paramTarget names (no mis-wire). cv=0 is a no-op, so an
// UNPATCHED CV input never perturbs the default sound (transient, no Y.Doc).
// ─────────────────────────────────────────────────────────────────────────
describe('SIX STRUM per-knob CV — scaling actually moves the target param', () => {
  const paramById = new Map(sixstrumDef.params.map((p) => [p.id, p]));
  const portById = new Map(sixstrumDef.inputs.map((p) => [p.id, p]));

  it('each _cv port targets a real param whose curve matches the cvScale mode', () => {
    for (const [port, target, mode] of CV_PORTS) {
      const pd = paramById.get(target);
      expect(pd, `${port} → ${target} must be a real param`).toBeTruthy();
      // discrete cvScale ⟺ discrete-curve param; log ⟺ log; linear knobs are linear.
      if (mode === 'discrete') expect(pd!.curve).toBe('discrete');
      if (mode === 'log') expect(pd!.curve).toBe('log');
      if (mode === 'linear') expect(pd!.curve).toBe('linear');
    }
  });

  it('a ±1 CV sweeps each CONTINUOUS target across its full range, centred on the knob', () => {
    for (const [port, target, mode] of CV_PORTS) {
      if (mode === 'discrete') continue;
      const hint = portById.get(port)!.cvScale!;
      const pd = paramById.get(target)!;
      const knob = pd.defaultValue;
      const lo = scaleCv(-1, knob, pd.min, pd.max, hint);
      const mid = scaleCv(0, knob, pd.min, pd.max, hint);
      const hi = scaleCv(+1, knob, pd.min, pd.max, hint);
      // cv=0 → no modulation (delta 0): unpatched/idle CV never shifts the sound.
      expect(mid, `${port}: cv=0 must be a no-op`).toBeCloseTo(knob, 6);
      // ±1 MOVES the param monotonically and reaches well toward each edge.
      expect(hi, `${port}: +1 must raise`).toBeGreaterThan(mid);
      expect(lo, `${port}: -1 must lower`).toBeLessThan(mid);
      expect(hi).toBeGreaterThan(knob + (pd.max - knob) * 0.4);
      expect(lo).toBeLessThan(knob - (knob - pd.min) * 0.4);
    }
  });

  it('DISCRETE dir_cv quantizes a −1..+1 CV to the DIR index range 0..2', () => {
    const hint = portById.get('dir_cv')!.cvScale!;
    const pd = paramById.get('strumDir')!; // 0..2 (down/up/alternate)
    const q = (cv: number) => scaleCv(cv, pd.defaultValue, pd.min, pd.max, hint);
    expect(q(-1)).toBe(0); // DOWN
    expect(q(0)).toBe(1);  // UP
    expect(q(+1)).toBe(2); // ALTERNATE
    for (let k = 0; k <= 100; k++) {
      const v = q(-1 + k * 0.02);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(2);
    }
  });

  it('DISCRETE chord_cv quantizes a −1..+1 CV across the CHORD index range 0..7', () => {
    const hint = portById.get('chord_cv')!.cvScale!;
    const pd = paramById.get('quality')!; // 0..7 (maj..octaves)
    const q = (cv: number) => scaleCv(cv, pd.defaultValue, pd.min, pd.max, hint);
    expect(q(-1)).toBe(0); // maj
    expect(q(+1)).toBe(7); // octaves
    const seen = new Set<number>();
    for (let k = 0; k <= 100; k++) {
      const v = q(-1 + k * 0.02);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(7);
      seen.add(v);
    }
    expect(seen.size, 'the sweep reaches all 8 chord-quality indices').toBe(8);
  });
});

describe('SIX STRUM factory — CV inputsMap routes each port to the RIGHT AudioParam', () => {
  it('every _cv port connects to the AudioParam named by its paramTarget (no mis-wire)', async () => {
    // Fake AudioParams keyed by param id; params.get(id) in the factory returns
    // these, so we can assert the inputsMap `param` is the target param object.
    const paramMap = new Map<string, { value: number; setValueAtTime: (v: number, t: number) => void }>();
    for (const d of sixstrumDef.params) {
      paramMap.set(d.id, { value: d.defaultValue, setValueAtTime(v: number) { this.value = v; } });
    }
    const g = globalThis as unknown as { AudioWorkletNode?: unknown };
    const prevAwn = g.AudioWorkletNode;
    g.AudioWorkletNode = class {
      parameters = paramMap;
      connect(): void { /* */ }
      disconnect(): void { /* */ }
    };
    const ctx = {
      currentTime: 0,
      audioWorklet: { addModule: async () => {} },
      createConstantSource: () => ({
        offset: { value: 0 },
        start() {}, stop() {}, connect() {}, disconnect() {},
      }),
    } as unknown as BaseAudioContext;
    try {
      const node: ModuleNode = { id: 'n', type: 'sixstrum', domain: 'audio', position: { x: 0, y: 0 }, params: {} };
      const handle = await sixstrumDef.factory(ctx as unknown as AudioContext, node);
      for (const [port, target] of CV_PORTS) {
        expect(
          handle.inputs.get(port)?.param,
          `${port} must route onto the ${target} AudioParam`,
        ).toBe(paramMap.get(target));
      }
      // Structural inputs stay pure worklet inputs — no AudioParam routing.
      expect(handle.inputs.get('accent')?.param).toBeUndefined();
      expect(handle.inputs.get('poly')?.param).toBeUndefined();
      expect(handle.inputs.get('strum1')?.param).toBeUndefined();
      handle.dispose();
    } finally {
      g.AudioWorkletNode = prevAwn;
    }
  });
});
