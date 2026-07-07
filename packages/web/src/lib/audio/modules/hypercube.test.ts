// packages/web/src/lib/audio/modules/hypercube.test.ts
//
// Two test layers for HYPERCUBE (the 4D tesseract sibling of CUBE):
//   1. Module-def shape — pitch + CV inputs (incl. the ALPHA CV), separate L/R
//      audio out + video_out, the literal param array (incl. ALPHA), the 4
//      per-slot wavetable defaults (incl. the HOLO slot).
//   2. Real DSP behavior — instantiate the registered worklet processor class
//      (captured via the registerProcessor shim) and drive process(): a 65 Hz
//      V/oct input through FOUR loaded tables yields nonzero stereo output; an
//      unloaded HYPERCUBE is silent; ALPHA changes the on-thread output.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import {
  hypercubeDef,
  HYPERCUBE_SLOTS,
  HYPERCUBE_DEFAULT_TABLES,
  resolveSlotFrames,
} from './hypercube';
import { getFactoryTable, framesToPlain } from '$lib/audio/wavetable-factory-tables';
import { patch } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';

const SR = 48000;
const BLOCK = 128;
const FRAME_SIZE = 256;

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

type ProcInstance = {
  process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean;
  port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown) => void };
};
type PortMessage = { type?: string; [k: string]: unknown };
type ProcCtor = new () => ProcInstance;
let capturedProc: ProcCtor | null = null;
async function loadProcessor(): Promise<ProcCtor> {
  if (capturedProc) return capturedProc;
  const g = globalThis as unknown as { registerProcessor?: (n: string, c: ProcCtor) => void };
  const prev = g.registerProcessor;
  let registered: ProcCtor | null = null;
  g.registerProcessor = (_n, ctor) => { registered = ctor; };
  await import('../../../../../dsp/src/hypercube');
  g.registerProcessor = prev;
  if (!registered) throw new Error('hypercube processor did not register');
  capturedProc = registered;
  return capturedProc;
}

function makeParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const base: Record<string, number> = {};
  for (const p of hypercubeDef.params) base[p.id] = p.defaultValue;
  Object.assign(base, over);
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(base)) out[k] = new Float32Array([v]);
  return out;
}

function loadAllTables(proc: ProcInstance): void {
  for (const slot of HYPERCUBE_SLOTS) {
    const frames = framesToPlain(getFactoryTable(HYPERCUBE_DEFAULT_TABLES[slot])!.frames);
    proc.port.onmessage?.({ data: { type: 'loadWavetable', slot, frames } });
  }
}

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

// ─────────────────────────────────────────────────────────────────────────
// 1) Module-def shape.
// ─────────────────────────────────────────────────────────────────────────

describe('resolveSlotFrames — FOUR per-slot wavetable defaults (incl. HOLO)', () => {
  it('exposes the HOLO slot alongside floor / wall / ceiling', () => {
    expect(HYPERCUBE_SLOTS).toEqual(['floor', 'wall', 'ceiling', 'holo']);
  });
  it('resolves each slot (incl. holo) to its default factory table when no data', () => {
    for (const slot of HYPERCUBE_SLOTS) {
      const r = resolveSlotFrames(slot, undefined);
      expect(r.frames.length).toBeGreaterThan(0);
      expect(r.frames[0]!.length).toBe(FRAME_SIZE);
      expect(r.signature).toBe(`factory:${HYPERCUBE_DEFAULT_TABLES[slot]}`);
    }
  });
  it('HOLO defaults to basic-shapes (same as floor/ceiling so off is doubly safe)', () => {
    expect(HYPERCUBE_DEFAULT_TABLES).toEqual({
      floor: 'basic-shapes', wall: 'harmonic-sweep', ceiling: 'basic-shapes', holo: 'basic-shapes',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2) Worklet DSP behavior.
// ─────────────────────────────────────────────────────────────────────────

describe('HYPERCUBE worklet — capture + audible output', () => {
  it('a 65 Hz input through FOUR loaded tables yields nonzero stereo output', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    loadAllTables(p);
    const voct = Math.log2(65.41 / 261.626);
    const { L, R } = runProc(p, makeParams({ level: 1, spread: 0 }), 0.25, voct);
    expect(peak(L)).toBeGreaterThan(1e-3);
    expect(peak(R)).toBeGreaterThan(1e-3);
    let maxDiff = 0;
    for (let i = 0; i < L.length; i++) maxDiff = Math.max(maxDiff, Math.abs(L[i]! - R[i]!));
    expect(maxDiff).toBeLessThan(1e-6);
    expect(L.findIndex((v) => !Number.isFinite(v))).toBe(-1);
  });

  it('is silent until all FOUR tables (incl. HOLO) are loaded', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    // Load floor + wall + ceiling but NOT holo.
    for (const slot of ['floor', 'wall', 'ceiling'] as const) {
      const frames = framesToPlain(getFactoryTable(HYPERCUBE_DEFAULT_TABLES[slot])!.frames);
      p.port.onmessage?.({ data: { type: 'loadWavetable', slot, frames } });
    }
    const voct = Math.log2(65.41 / 261.626);
    const { L } = runProc(p, makeParams(), 0.05, voct);
    expect(peak(L)).toBe(0);
  });

  it('the worklet declares an ALPHA audio parameter (a-rate, 0..1)', async () => {
    const Proc = await loadProcessor();
    const descriptors =
      (Proc as unknown as { parameterDescriptors?: Array<{ name: string; defaultValue: number; minValue: number; maxValue: number; automationRate: string }> }).parameterDescriptors ?? [];
    const alpha = descriptors.find((d) => d.name === 'alpha');
    expect(alpha, 'worklet must declare an alpha param').toBeTruthy();
    expect(alpha!.defaultValue).toBe(0);
    expect(alpha!.minValue).toBe(0);
    expect(alpha!.maxValue).toBe(1);
    expect(alpha!.automationRate).toBe('a-rate');
  });

  it('ALPHA changes the on-thread output with a non-trivial HOLO table (off=identity at 0)', async () => {
    const Proc = await loadProcessor();
    const voct = Math.log2(98 / 261.626);
    // A non-trivial HOLO table (two-cycle cosine) so ALPHA actually bites; the
    // base 3 tables are the factory defaults.
    function loadWith(proc: ProcInstance): void {
      for (const slot of ['floor', 'wall', 'ceiling'] as const) {
        const frames = framesToPlain(getFactoryTable(HYPERCUBE_DEFAULT_TABLES[slot])!.frames);
        proc.port.onmessage?.({ data: { type: 'loadWavetable', slot, frames } });
      }
      const holo: number[][] = [];
      for (let f = 0; f < 64; f++) {
        const row: number[] = [];
        for (let c = 0; c < FRAME_SIZE; c++) row.push(Math.cos((4 * Math.PI * c) / FRAME_SIZE));
        holo.push(row);
      }
      proc.port.onmessage?.({ data: { type: 'loadWavetable', slot: 'holo', frames: holo } });
    }
    const ps = makeParams({ morph_fc: 0.5, slice_rx: 0.5, level: 1 });

    const pA0 = new Proc(); loadWith(pA0);
    const a0 = runProc(pA0, { ...ps, alpha: new Float32Array([0]) }, 0.2, voct);

    const pA1 = new Proc(); loadWith(pA1);
    const a1 = runProc(pA1, { ...ps, alpha: new Float32Array([1]) }, 0.2, voct);

    let differs = false;
    for (let i = 0; i < a0.L.length; i++) {
      expect(Number.isFinite(a1.L[i]!)).toBe(true);
      if (Math.abs(a0.L[i]! - a1.L[i]!) > 1e-4) { differs = true; break; }
    }
    expect(differs, 'ALPHA at max must reshape the waveform').toBe(true);
  });

  it('off-thread mode posts paramsChanged carrying ALPHA', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    loadAllTables(p);
    p.port.onmessage?.({ data: { type: 'offThread' } });
    const voct = Math.log2(98 / 261.626);
    const captured: PortMessage[] = [];
    p.port.postMessage = (m: unknown) => { captured.push(m as PortMessage); };
    for (let b = 0; b < 4; b++) {
      const pitch = new Float32Array(BLOCK).fill(voct);
      p.process([[pitch]], [[new Float32Array(BLOCK), new Float32Array(BLOCK)]], makeParams({ slice_rx: 0.5, morph_fc: 0.5, alpha: 0.5 }));
    }
    const pc = captured.find((m) => m.type === 'paramsChanged');
    expect(pc, 'expected a paramsChanged message in off-thread mode').toBeTruthy();
    expect(typeof pc!.alpha).toBe('number');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3) Wavetable RELOAD — the HOLO slot re-posts on a table swap (mirrors CUBE).
// ─────────────────────────────────────────────────────────────────────────

interface HyperMockNode {
  __type: string;
  connect: (...a: unknown[]) => unknown;
  disconnect: (...a: unknown[]) => void;
  [k: string]: unknown;
}
type Posted = { type?: string; slot?: string; frames?: number[][]; [k: string]: unknown };

function makeMockEnv(): { ctx: unknown; posts: Posted[] } {
  const posts: Posted[] = [];
  function audioParam(initial = 0) {
    return { value: initial, setValueAtTime: vi.fn(function (this: { value: number }, v: number) { this.value = v; }) };
  }
  function makeNode(type: string, extra: Record<string, unknown> = {}): HyperMockNode {
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

function makeNode(id: string): ModuleNode {
  return { id, type: 'hypercube', domain: 'audio', position: { x: 0, y: 0 }, params: {}, data: {} } as unknown as ModuleNode;
}
function loadsFor(posts: Posted[], slot: string): Posted[] {
  return posts.filter((m) => m.type === 'loadWavetable' && m.slot === slot);
}

describe('hypercube factory: HOLO slot reload re-posts loadWavetable', () => {
  afterEach(() => {
    delete (globalThis as unknown as { AudioWorkletNode?: unknown }).AudioWorkletNode;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('spawns an initial HOLO loadWavetable + re-posts when switched to a different table', async () => {
    vi.useFakeTimers();
    const id = 'hypercube-reload-1';
    patch.nodes[id] = makeNode(id);
    const { ctx, posts } = makeMockEnv();
    const handle = await hypercubeDef.factory(ctx as never, patch.nodes[id] as never);

    const initialHolo = loadsFor(posts, 'holo');
    expect(initialHolo.length).toBeGreaterThan(0);
    const firstFrames = initialHolo.at(-1)!.frames;

    const altId = HYPERCUBE_DEFAULT_TABLES.holo === 'harmonic-sweep' ? 'basic-shapes' : 'harmonic-sweep';
    const t = patch.nodes[id]!;
    (t.data as Record<string, unknown>).holo = { source: `factory:${altId}` };

    await vi.advanceTimersByTimeAsync(250);

    const afterHolo = loadsFor(posts, 'holo');
    expect(afterHolo.length, 'a HOLO reload must re-post loadWavetable').toBeGreaterThan(initialHolo.length);
    expect(afterHolo.at(-1)!.frames).not.toEqual(firstFrames);

    handle.dispose?.();
    delete patch.nodes[id];
  });
});
