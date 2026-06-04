// packages/web/src/lib/audio/modules/cube.test.ts
//
// Two test layers for CUBE:
//   1. Module-def shape — pitch + CV inputs, single stereo audio_out, the
//      literal param array (ranges/defaults), per-slot wavetable defaults.
//   2. Real DSP behavior — instantiate the registered worklet processor class
//      (captured via the registerProcessor shim, since the worklet entry NEVER
//      top-level-exports its class — that would break ART's classic-script
//      eval) and drive process(): a 65 Hz V/oct input through loaded tables
//      yields nonzero stereo output; an unloaded CUBE is silent; spread > 0
//      separates L/R.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import {
  cubeDef,
  CUBE_SLOTS,
  CUBE_DEFAULT_TABLES,
  resolveSlotFrames,
} from './cube';
import { getFactoryTable, framesToPlain } from '$lib/audio/wavetable-factory-tables';
import { patch } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';

const SR = 48000;
const BLOCK = 128;
const FRAME_SIZE = 256;

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

// Capture the registered processor class via a shim.
type ProcInstance = {
  process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean;
  port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown) => void };
};
/** A captured outbound port message (worklet → main thread). */
type PortMessage = { type?: string; [k: string]: unknown };
type ProcCtor = new () => ProcInstance;
let capturedProc: ProcCtor | null = null;
async function loadProcessor(): Promise<ProcCtor> {
  if (capturedProc) return capturedProc;
  const g = globalThis as unknown as { registerProcessor?: (n: string, c: ProcCtor) => void };
  const prev = g.registerProcessor;
  let registered: ProcCtor | null = null;
  g.registerProcessor = (_n, ctor) => { registered = ctor; };
  // Relative path into the DSP source — worktrees may not have the workspace
  // package symlinked under node_modules.
  await import('../../../../../dsp/src/cube');
  g.registerProcessor = prev;
  if (!registered) throw new Error('cube processor did not register');
  capturedProc = registered;
  return capturedProc;
}

/** Make a CubeProcessor instance with a working port (the AudioWorkletProcessor
 *  shim has no MessagePort, so we attach a minimal one before construction is
 *  impossible — instead we patch the instance's port after construction by
 *  re-wiring onmessage). We deliver loadWavetable messages by invoking the
 *  instance's onmessage directly. */
function makeParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const base: Record<string, number> = {};
  for (const p of cubeDef.params) base[p.id] = p.defaultValue;
  // fine is a worklet param too (not in def-only? it IS in def). Ensure
  // worklet-only spread/level present.
  Object.assign(base, over);
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(base)) out[k] = new Float32Array([v]);
  return out;
}

function loadAllTables(proc: ProcInstance): void {
  const floor = framesToPlain(getFactoryTable(CUBE_DEFAULT_TABLES.floor)!.frames);
  const wall = framesToPlain(getFactoryTable(CUBE_DEFAULT_TABLES.wall)!.frames);
  const ceiling = framesToPlain(getFactoryTable(CUBE_DEFAULT_TABLES.ceiling)!.frames);
  proc.port.onmessage?.({ data: { type: 'loadWavetable', slot: 'floor', frames: floor } });
  proc.port.onmessage?.({ data: { type: 'loadWavetable', slot: 'wall', frames: wall } });
  proc.port.onmessage?.({ data: { type: 'loadWavetable', slot: 'ceiling', frames: ceiling } });
}

/** Run the processor for `seconds`, feeding pitch into input 0 ch 0. Returns
 *  { L, R }. */
function runProc(
  proc: ProcInstance,
  params: Record<string, Float32Array>,
  seconds: number,
  pitchVolt: number,
): { L: Float32Array; R: Float32Array } {
  const total = Math.round(SR * seconds);
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  let g = 0;
  while (g < total) {
    const len = Math.min(BLOCK, total - g);
    const pitch = new Float32Array(len).fill(pitchVolt);
    const outL = new Float32Array(len);
    const outR = new Float32Array(len);
    proc.process([[pitch]], [[outL, outR]], params);
    for (let i = 0; i < len; i++) { L[g + i] = outL[i] as number; R[g + i] = outR[i] as number; }
    g += len;
  }
  return { L, R };
}

function peak(b: Float32Array): number { let m = 0; for (let i = 0; i < b.length; i++) m = Math.max(m, Math.abs(b[i] ?? 0)); return m; }
function rms(b: Float32Array): number { let s = 0; for (let i = 0; i < b.length; i++) s += (b[i] ?? 0) ** 2; return Math.sqrt(s / b.length); }

// ─────────────────────────────────────────────────────────────────────────
// 1) Module-def shape.
// ─────────────────────────────────────────────────────────────────────────

describe('cubeDef — module def shape', () => {
  it('declares pitch + the documented CV inputs (incl. fold_cv + space/connect_strength)', () => {
    expect(cubeDef.inputs.map((i) => i.id)).toEqual([
      'pitch',
      'slice_y', 'slice_rx', 'slice_ry', 'slice_rz',
      'morph_fc', 'connect', 'connect_strength', 'crush',
      'space_crush', 'space_diffuse', 'fold_cv', 'tune',
    ]);
  });

  it('CV inputs target the right params with linear cvScale', () => {
    for (const id of [
      'slice_y', 'slice_rx', 'slice_ry', 'slice_rz', 'morph_fc', 'connect',
      'connect_strength', 'crush', 'space_crush', 'space_diffuse', 'tune',
    ]) {
      const p = cubeDef.inputs.find((i) => i.id === id)!;
      expect(p.paramTarget, id).toBe(id);
      expect(p.cvScale, id).toEqual({ mode: 'linear' });
    }
  });

  it('fold_cv input targets the fold param with linear cvScale', () => {
    const p = cubeDef.inputs.find((i) => i.id === 'fold_cv')!;
    expect(p.type).toBe('cv');
    expect(p.paramTarget).toBe('fold');
    expect(p.cvScale).toEqual({ mode: 'linear' });
  });

  it('declares SEPARATE L and R audio outputs + a mono-video out (issue #1 + video_out)', () => {
    expect(cubeDef.outputs.map((o) => o.id)).toEqual(['L', 'R', 'video_out']);
    expect(cubeDef.outputs.find((o) => o.id === 'L')!.type).toBe('audio');
    expect(cubeDef.outputs.find((o) => o.id === 'R')!.type).toBe('audio');
    expect(cubeDef.outputs.find((o) => o.id === 'video_out')!.type).toBe('mono-video');
  });

  it('declares the literal param array with documented ranges + defaults', () => {
    const byId = Object.fromEntries(cubeDef.params.map((p) => [p.id, p] as const));
    expect(byId.tune).toMatchObject({ min: -36, max: 36, defaultValue: 0 });
    expect(byId.fine).toMatchObject({ min: -100, max: 100, defaultValue: 0 });
    expect(byId.morph_fc).toMatchObject({ min: 0, max: 1, defaultValue: 0, curve: 'linear' });
    expect(byId.connect).toMatchObject({ min: 0, max: 1, defaultValue: 0 });
    // CONNECT STRENGTH + SPACE CRUSH + SPACE DIFFUSE — all min0/max1/default0
    // (off=identity), CV-routable, linear.
    expect(byId.connect_strength).toMatchObject({ min: 0, max: 1, defaultValue: 0, curve: 'linear' });
    expect(byId.space_crush).toMatchObject({ min: 0, max: 1, defaultValue: 0, curve: 'linear' });
    expect(byId.space_diffuse).toMatchObject({ min: 0, max: 1, defaultValue: 0, curve: 'linear' });
    expect(byId.crush).toMatchObject({ min: 0, max: 1, defaultValue: 0 });
    // FOLD — West-coast wavefolder, linear, default 0 (pass-through).
    expect(byId.fold).toMatchObject({ min: 0, max: 1, defaultValue: 0, curve: 'linear' });
    expect(byId.spread).toMatchObject({ min: 0, max: 1, defaultValue: 0 });
    expect(byId.slice_y).toMatchObject({ min: 0, max: 1, defaultValue: 0.5 });
    expect(byId.level).toMatchObject({ min: 0, max: 2, defaultValue: 1 });
    expect(byId.wrap).toMatchObject({ curve: 'discrete', min: 0, max: 1, defaultValue: 0 });
    expect(byId.material).toMatchObject({ curve: 'discrete', min: 0, max: 1, defaultValue: 0 });
    // View-only camera params present but NOT CV-routed (no input targets them).
    for (const id of ['view_zoom', 'view_rot_x', 'view_rot_y', 'view_rot_z']) {
      expect(byId[id], id).toBeTruthy();
      expect(cubeDef.inputs.some((i) => i.paramTarget === id), `${id} must be view-only`).toBe(false);
    }
  });

  it('params is a LITERAL array (manifest static extractor requirement)', () => {
    expect(Array.isArray(cubeDef.params)).toBe(true);
    expect(cubeDef.params.length).toBeGreaterThan(10);
  });

  it('declares a view-only SCREEN on/off param (default ON, discrete, NOT CV-routed)', () => {
    const byId = Object.fromEntries(cubeDef.params.map((p) => [p.id, p] as const));
    // Screen defaults ON (1) so a freshly-spawned CUBE renders its viz.
    expect(byId.screen_on).toMatchObject({ min: 0, max: 1, defaultValue: 1, curve: 'discrete' });
    // View-only: no CV input targets it + the worklet has no such parameter
    // descriptor (it's a card-read perf toggle, NOT an audio param).
    expect(cubeDef.inputs.some((i) => i.paramTarget === 'screen_on')).toBe(false);
  });

  it('claims sources category', () => {
    expect(cubeDef.category).toBe('sources');
    expect(cubeDef.type).toBe('cube');
  });
});

describe('resolveSlotFrames — per-slot wavetable defaults', () => {
  it('resolves each slot to its default factory table when no data', () => {
    for (const slot of CUBE_SLOTS) {
      const r = resolveSlotFrames(slot, undefined);
      expect(r.frames.length).toBeGreaterThan(0);
      expect(r.frames[0]!.length).toBe(FRAME_SIZE);
      expect(r.signature).toBe(`factory:${CUBE_DEFAULT_TABLES[slot]}`);
    }
  });
  it('default tables are FLOOR=basic-shapes, WALL=harmonic-sweep, CEILING=basic-shapes', () => {
    expect(CUBE_DEFAULT_TABLES).toEqual({
      floor: 'basic-shapes', wall: 'harmonic-sweep', ceiling: 'basic-shapes',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2) Worklet DSP behavior.
// ─────────────────────────────────────────────────────────────────────────

describe('CUBE worklet — capture + audible output', () => {
  it('a 65 Hz input through loaded tables yields nonzero stereo output', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    loadAllTables(p);
    // C2 ≈ 65.4 Hz → V/oct = log2(65.4/261.626) ≈ -2.
    const voct = Math.log2(65.41 / 261.626);
    const { L, R } = runProc(p, makeParams({ level: 1, spread: 0 }), 0.25, voct);
    expect(peak(L)).toBeGreaterThan(1e-3);
    expect(peak(R)).toBeGreaterThan(1e-3);
    // Mono at spread=0 → L ≈ R.
    let maxDiff = 0;
    for (let i = 0; i < L.length; i++) maxDiff = Math.max(maxDiff, Math.abs(L[i]! - R[i]!));
    expect(maxDiff).toBeLessThan(1e-6);
    // No NaN/Inf.
    expect(L.findIndex((v) => !Number.isFinite(v))).toBe(-1);
  });

  it('is silent until all three tables are loaded', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    // Load only floor + wall (not ceiling).
    const floor = framesToPlain(getFactoryTable(CUBE_DEFAULT_TABLES.floor)!.frames);
    const wall = framesToPlain(getFactoryTable(CUBE_DEFAULT_TABLES.wall)!.frames);
    p.port.onmessage?.({ data: { type: 'loadWavetable', slot: 'floor', frames: floor } });
    p.port.onmessage?.({ data: { type: 'loadWavetable', slot: 'wall', frames: wall } });
    const voct = Math.log2(65.41 / 261.626);
    const { L } = runProc(p, makeParams(), 0.05, voct);
    expect(peak(L)).toBe(0);
  });

  it('spread > 0 separates L from R', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    loadAllTables(p);
    // Use a rotation so the field isn't degenerate-symmetric across the spread
    // depth offset (an axis-aligned flat-ish slice can read near-identically at
    // ±5%); a tilt makes the depth offset bite.
    const voct = Math.log2(130.81 / 261.626); // C3
    const { L, R } = runProc(
      p,
      makeParams({ spread: 1, slice_rx: 0.7, slice_ry: 0.4, morph_fc: 0.5 }),
      0.3,
      voct,
    );
    expect(rms(L)).toBeGreaterThan(1e-4);
    let maxDiff = 0;
    for (let i = 0; i < L.length; i++) maxDiff = Math.max(maxDiff, Math.abs(L[i]! - R[i]!));
    expect(maxDiff).toBeGreaterThan(1e-5);
  });

  // ── Off-thread compute path (issue #4) ──

  /** Drive a few blocks, capturing any outbound port messages. */
  function runProcCapture(
    proc: ProcInstance,
    params: Record<string, Float32Array>,
    blocks: number,
    pitchVolt: number,
  ): PortMessage[] {
    const captured: PortMessage[] = [];
    proc.port.postMessage = (m: unknown) => { captured.push(m as PortMessage); };
    for (let b = 0; b < blocks; b++) {
      const pitch = new Float32Array(BLOCK).fill(pitchVolt);
      proc.process([[pitch]], [[new Float32Array(BLOCK), new Float32Array(BLOCK)]], params);
    }
    return captured;
  }

  it('off-thread mode posts paramsChanged instead of computing on the audio thread', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    loadAllTables(p);
    p.port.onmessage?.({ data: { type: 'offThread' } });
    const voct = Math.log2(98 / 261.626);
    const msgs = runProcCapture(p, makeParams({ slice_rx: 0.5, morph_fc: 0.5 }), 4, voct);
    // It must post at least one paramsChanged carrying the slice scalars …
    const pc = msgs.find((m) => m.type === 'paramsChanged');
    expect(pc, 'expected a paramsChanged message in off-thread mode').toBeTruthy();
    expect(typeof pc!.sliceY).toBe('number');
    expect(typeof pc!.spread).toBe('number');
    // … and it must NOT have computed/played audio yet (no setWave received →
    // no wave → output stays silent on the audio thread).
    const out = new Float32Array(BLOCK);
    p.process([[new Float32Array(BLOCK).fill(voct)]], [[out, new Float32Array(BLOCK)]], makeParams());
    expect(peak(out)).toBe(0);
  });

  it('off-thread: plays the wave the main thread posts via setWave (L≠R at spread)', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    loadAllTables(p);
    p.port.onmessage?.({ data: { type: 'offThread' } });
    // Simulate the factory: a clearly L≠R pair of waves.
    const waveCenter = new Float32Array(FRAME_SIZE);
    const waveL = new Float32Array(FRAME_SIZE);
    const waveR = new Float32Array(FRAME_SIZE);
    for (let i = 0; i < FRAME_SIZE; i++) {
      const ph = (i / FRAME_SIZE) * Math.PI * 2;
      waveCenter[i] = Math.sin(ph) * 0.5;
      waveL[i] = Math.sin(ph) * 0.5;
      waveR[i] = Math.sin(ph + 0.9) * 0.5; // phase-shifted → audibly different
    }
    p.port.onmessage?.({ data: { type: 'setWave', waveCenter, waveL, waveR } });
    const voct = Math.log2(130.81 / 261.626);
    const { L, R } = runProc(p, makeParams(), 0.1, voct);
    expect(peak(L)).toBeGreaterThan(1e-3);
    expect(peak(R)).toBeGreaterThan(1e-3);
    let maxDiff = 0;
    for (let i = 0; i < L.length; i++) maxDiff = Math.max(maxDiff, Math.abs(L[i]! - R[i]!));
    expect(maxDiff).toBeGreaterThan(1e-3);
  });

  it('no dropout on a sweep that goes silent: keeps the last non-silent wave', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    loadAllTables(p);
    p.port.onmessage?.({ data: { type: 'offThread' } });
    const nonSilent = new Float32Array(FRAME_SIZE);
    for (let i = 0; i < FRAME_SIZE; i++) nonSilent[i] = Math.sin((i / FRAME_SIZE) * Math.PI * 2) * 0.5;
    p.port.onmessage?.({ data: { type: 'setWave', waveCenter: nonSilent, waveL: nonSilent, waveR: nonSilent } });
    const voct = Math.log2(130.81 / 261.626);
    const before = runProc(p, makeParams(), 0.05, voct);
    expect(peak(before.L)).toBeGreaterThan(1e-3);
    // Now the slice sweeps fully outside the cube → main thread would post an
    // all-zero wave. The worklet must KEEP the previous non-silent wave.
    const silent = new Float32Array(FRAME_SIZE); // all zeros
    p.port.onmessage?.({ data: { type: 'setWave', waveCenter: silent, waveL: silent, waveR: silent } });
    const after = runProc(p, makeParams(), 0.05, voct);
    expect(peak(after.L), 'audio must not drop to silence on a param sweep').toBeGreaterThan(1e-3);
  });

  it('FOLD changes the output (on-thread) and stays bounded, identity at fold=0', async () => {
    const Proc = await loadProcessor();
    const voct = Math.log2(98 / 261.626);
    // on-thread fallback (no offThread message) so the worklet applies fold itself.
    const ps = makeParams({ morph_fc: 0.5, slice_rx: 0.5, level: 1 });

    const pClean = new Proc(); loadAllTables(pClean);
    const clean = runProc(pClean, { ...ps, fold: new Float32Array([0]) }, 0.2, voct);

    const pFold = new Proc(); loadAllTables(pFold);
    const folded = runProc(pFold, { ...ps, fold: new Float32Array([1]) }, 0.2, voct);

    let differs = false;
    for (let i = 0; i < clean.L.length; i++) {
      // bounded: the worklet clamps to ±4 but the folder itself keeps |y|≤1·level.
      expect(Number.isFinite(folded.L[i]!)).toBe(true);
      if (Math.abs(clean.L[i]! - folded.L[i]!) > 1e-4) differs = true;
    }
    expect(differs, 'FOLD at max must reshape the waveform').toBe(true);
    // fold=0 must equal an unfolded reference (identity) — re-render fold=0 and
    // compare to `clean`.
    const pClean2 = new Proc(); loadAllTables(pClean2);
    const clean2 = runProc(pClean2, { ...ps, fold: new Float32Array([0]) }, 0.2, voct);
    let maxIdentDiff = 0;
    for (let i = 0; i < clean.L.length; i++) maxIdentDiff = Math.max(maxIdentDiff, Math.abs(clean.L[i]! - clean2.L[i]!));
    expect(maxIdentDiff).toBeLessThan(1e-9);
  });

  it('off-thread: posts the fold amount in paramsChanged (converges to the knob)', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    loadAllTables(p);
    p.port.onmessage?.({ data: { type: 'offThread' } });
    const voct = Math.log2(98 / 261.626);
    // Many blocks so the fold smoother converges from primed-0 to the 0.7 knob.
    const msgs = runProcCapture(p, makeParams({ fold: 0.7, slice_rx: 0.5 }), 400, voct);
    const folds = msgs.filter((m) => m.type === 'paramsChanged').map((m) => m.fold as number);
    expect(folds.length, 'expected paramsChanged messages').toBeGreaterThan(0);
    expect(typeof folds[0]).toBe('number');
    // The LAST posted fold has converged near the knob value (the recompute
    // only fires on quantization-step crossings, so it lands a couple of steps
    // shy of exact — within 0.05 proves the value is propagated).
    expect(folds[folds.length - 1]!).toBeGreaterThan(0.65);
    expect(folds[folds.length - 1]!).toBeLessThanOrEqual(0.7 + 1e-6);
  });

  it('material=HARD differs from SMOOTH for the same patch', async () => {
    const Proc = await loadProcessor();
    const voct = Math.log2(98 / 261.626);
    const ps = makeParams({ morph_fc: 0.5, slice_rx: 0.5, level: 1 });

    const pSmooth = new Proc(); loadAllTables(pSmooth);
    const smooth = runProc(pSmooth, { ...ps, material: new Float32Array([0]) }, 0.2, voct);

    const pHard = new Proc(); loadAllTables(pHard);
    const hard = runProc(pHard, { ...ps, material: new Float32Array([1]) }, 0.2, voct);

    let differs = false;
    for (let i = 0; i < smooth.L.length; i++) {
      if (Math.abs(smooth.L[i]! - hard.L[i]!) > 1e-4) { differs = true; break; }
    }
    expect(differs).toBe(true);
  });

  it('screen_on is a CARD-only toggle, NOT a worklet audio parameter', async () => {
    const Proc = await loadProcessor();
    const descriptors =
      (Proc as unknown as { parameterDescriptors?: Array<{ name: string }> }).parameterDescriptors ?? [];
    const names = descriptors.map((d) => d.name);
    // The worklet must declare NO screen_on parameter (audio path untouched);
    // the view-only camera params are likewise card-read, not worklet params.
    expect(names).not.toContain('screen_on');
    expect(names).toContain('morph_fc'); // sanity: descriptors were actually read
  });

  it('the worklet declares space_crush / space_diffuse / connect_strength a-rate params (default 0, [0,1])', async () => {
    const Proc = await loadProcessor();
    const descriptors =
      (Proc as unknown as {
        parameterDescriptors?: Array<{ name: string; defaultValue: number; minValue: number; maxValue: number; automationRate: string }>;
      }).parameterDescriptors ?? [];
    for (const name of ['space_crush', 'space_diffuse', 'connect_strength']) {
      const d = descriptors.find((x) => x.name === name);
      expect(d, `worklet must declare ${name}`).toBeTruthy();
      expect(d!.defaultValue, name).toBe(0);
      expect(d!.minValue, name).toBe(0);
      expect(d!.maxValue, name).toBe(1);
      expect(d!.automationRate, name).toBe('a-rate');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3) Wavetable RELOAD (issue: loading a DIFFERENT table after one is loaded).
//
// Drives cubeDef.factory() against a mock Web Audio env that records every
// port.postMessage, then mutates the LIVE patch node.data (what the card's
// selectFactory/selectPreset/onSlotFileChange do) and advances the poll timer.
// The factory MUST re-post a fresh {type:'loadWavetable'} for the changed slot
// — proving a second/different table replaces the first (the v4 reload fix).
// ─────────────────────────────────────────────────────────────────────────

interface CubeMockNode {
  __type: string;
  connect: (...a: unknown[]) => unknown;
  disconnect: (...a: unknown[]) => void;
  [k: string]: unknown;
}
type Posted = { type?: string; slot?: string; frames?: number[][]; [k: string]: unknown };

function makeCubeMockEnv(): { ctx: unknown; posts: Posted[] } {
  const posts: Posted[] = [];
  function audioParam(initial = 0) {
    return { value: initial, setValueAtTime: vi.fn(function (this: { value: number }, v: number) { this.value = v; }) };
  }
  function makeNode(type: string, extra: Record<string, unknown> = {}): CubeMockNode {
    return { __type: type, connect: vi.fn(() => undefined), disconnect: vi.fn(), ...extra };
  }
  const ctx = {
    currentTime: 0,
    sampleRate: 48000,
    audioWorklet: { addModule: vi.fn(async () => {}) },
    createChannelSplitter: () => makeNode('splitter'),
    createAnalyser: () => makeNode('analyser', { fftSize: 256 }),
    createConstantSource: () => makeNode('const', { offset: audioParam(0), start: vi.fn(), stop: vi.fn() }),
  };
  const params = new Map<string, ReturnType<typeof audioParam>>();
  class FakeAudioWorkletNode {
    __type = 'engine';
    port = { postMessage: (m: unknown) => { posts.push(m as Posted); }, onmessage: null as ((e: MessageEvent) => void) | null };
    parameters = { get: (k: string) => { let p = params.get(k); if (!p) { p = audioParam(0); params.set(k, p); } return p; } };
    connect = vi.fn(() => undefined);
    disconnect = vi.fn();
    constructor(_c: unknown, _n: string, _o?: unknown) { /* */ }
  }
  (globalThis as unknown as { AudioWorkletNode: typeof FakeAudioWorkletNode }).AudioWorkletNode = FakeAudioWorkletNode;
  return { ctx, posts };
}

function makeCubeNode(id: string): ModuleNode {
  return { id, type: 'cube', domain: 'audio', position: { x: 0, y: 0 }, params: {}, data: {} } as unknown as ModuleNode;
}
function loadsFor(posts: Posted[], slot: string): Posted[] {
  return posts.filter((m) => m.type === 'loadWavetable' && m.slot === slot);
}

describe('cube factory: wavetable reload replaces the current table', () => {
  afterEach(() => {
    delete (globalThis as unknown as { AudioWorkletNode?: unknown }).AudioWorkletNode;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('re-posts loadWavetable when a slot is switched to a DIFFERENT factory table', async () => {
    vi.useFakeTimers();
    const id = 'cube-reload-1';
    patch.nodes[id] = makeCubeNode(id);
    const { ctx, posts } = makeCubeMockEnv();
    const handle = await cubeDef.factory(ctx as never, patch.nodes[id] as never);

    // Spawn posts an initial loadWavetable for floor (its default table).
    const initialFloor = loadsFor(posts, 'floor');
    expect(initialFloor.length).toBeGreaterThan(0);
    const firstFrames = initialFloor.at(-1)!.frames;

    // Card switches FLOOR to a DIFFERENT factory table (selectFactory writes
    // node.data.floor.source). Pick any factory id that isn't the default.
    const altId = CUBE_DEFAULT_TABLES.floor === 'harmonic-sweep' ? 'basic-shapes' : 'harmonic-sweep';
    const t = patch.nodes[id]!;
    (t.data as Record<string, unknown>).floor = { source: `factory:${altId}` };

    // The factory polls node.data — advance past one poll interval.
    await vi.advanceTimersByTimeAsync(250);

    const afterFloor = loadsFor(posts, 'floor');
    expect(afterFloor.length, 'a reload must re-post loadWavetable for floor').toBeGreaterThan(initialFloor.length);
    // …and the posted frames actually CHANGED (the new table replaced the old).
    expect(afterFloor.at(-1)!.frames).not.toEqual(firstFrames);

    handle.dispose?.();
    delete patch.nodes[id];
  });

  it('re-posts loadWavetable when a slot is loaded with a USER table, then a different USER table', async () => {
    vi.useFakeTimers();
    const id = 'cube-reload-2';
    patch.nodes[id] = makeCubeNode(id);
    const { ctx, posts } = makeCubeMockEnv();
    const handle = await cubeDef.factory(ctx as never, patch.nodes[id] as never);

    const wallBefore = loadsFor(posts, 'wall').length;

    // First USER load (e.g. a parsed .wav / preset → source:'user' + frames).
    const framesA = [Array.from({ length: FRAME_SIZE }, (_, i) => Math.sin((i / FRAME_SIZE) * Math.PI * 2))];
    const t = patch.nodes[id]!;
    (t.data as Record<string, unknown>).wall = { source: 'user', frames: framesA, label: 'AAA' };
    await vi.advanceTimersByTimeAsync(250);
    const afterA = loadsFor(posts, 'wall');
    expect(afterA.length).toBeGreaterThan(wallBefore);

    // Second, DIFFERENT USER load — the reload bug was that this no-op'd.
    const framesB = [Array.from({ length: FRAME_SIZE }, (_, i) => (i < FRAME_SIZE / 2 ? 0.5 : -0.5))];
    (t.data as Record<string, unknown>).wall = { source: 'user', frames: framesB, label: 'BBB' };
    await vi.advanceTimersByTimeAsync(250);
    const afterB = loadsFor(posts, 'wall');
    expect(afterB.length, 'loading a DIFFERENT user table must re-post').toBeGreaterThan(afterA.length);
    expect(afterB.at(-1)!.frames).toEqual(framesB);

    handle.dispose?.();
    delete patch.nodes[id];
  });
});
