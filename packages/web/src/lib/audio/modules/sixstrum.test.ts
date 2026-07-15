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
    expect(sixstrumDef.inputs).toHaveLength(15);
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
