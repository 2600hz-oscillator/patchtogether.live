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

import { describe, it, expect, beforeAll } from 'vitest';
import {
  cubeDef,
  CUBE_SLOTS,
  CUBE_DEFAULT_TABLES,
  resolveSlotFrames,
} from './cube';
import { getFactoryTable, framesToPlain } from '$lib/audio/wavetable-factory-tables';

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
  it('declares pitch + the documented CV inputs', () => {
    expect(cubeDef.inputs.map((i) => i.id)).toEqual([
      'pitch',
      'slice_y', 'slice_rx', 'slice_ry', 'slice_rz',
      'morph_fc', 'connect', 'crush', 'tune',
    ]);
  });

  it('CV inputs target the right params with linear cvScale', () => {
    for (const id of ['slice_y', 'slice_rx', 'slice_ry', 'slice_rz', 'morph_fc', 'connect', 'crush', 'tune']) {
      const p = cubeDef.inputs.find((i) => i.id === id)!;
      expect(p.paramTarget, id).toBe(id);
      expect(p.cvScale, id).toEqual({ mode: 'linear' });
    }
  });

  it('declares SEPARATE L and R audio outputs (issue #1: spread survives mono inputs)', () => {
    expect(cubeDef.outputs.map((o) => o.id)).toEqual(['L', 'R']);
    expect(cubeDef.outputs.every((o) => o.type === 'audio')).toBe(true);
  });

  it('declares the literal param array with documented ranges + defaults', () => {
    const byId = Object.fromEntries(cubeDef.params.map((p) => [p.id, p] as const));
    expect(byId.tune).toMatchObject({ min: -36, max: 36, defaultValue: 0 });
    expect(byId.fine).toMatchObject({ min: -100, max: 100, defaultValue: 0 });
    expect(byId.morph_fc).toMatchObject({ min: 0, max: 1, defaultValue: 0, curve: 'linear' });
    expect(byId.connect).toMatchObject({ min: 0, max: 1, defaultValue: 0 });
    expect(byId.crush).toMatchObject({ min: 0, max: 1, defaultValue: 0 });
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
});
