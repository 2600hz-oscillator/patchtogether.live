// packages/web/src/lib/audio/modules/wavecel.test.ts
//
// Tests for WAVECEL:
//   1. Module-def shape (stereo outs, cross-domain video outs, the `poly`
//      input added in feat/poly-in-wavcel-cube).
//   2. Real worklet DSP behavior — instantiate the registered processor class
//      (captured via the registerProcessor shim, since the worklet entry NEVER
//      top-level-exports its class) and drive process(): mono pitch sounds; a
//      gated poly lane sounds; a chord (>1 lane) differs from one lane; mono
//      render is BYTE-IDENTICAL with vs without a present-but-silent poly bus.

import { describe, expect, it, beforeAll } from 'vitest';
import { wavecelDef } from './wavecel';
import { getFactoryTable, getFactoryTables, framesToPlain } from '$lib/audio/wavetable-factory-tables';

const SR = 48000;
const BLOCK = 128;
const POLY_CH = 10;

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

describe('WAVECEL module def shape', () => {
  it('keeps the legacy stereo audio outputs', () => {
    const ids = wavecelDef.outputs.map((p) => p.id);
    expect(ids).toContain('out_l');
    expect(ids).toContain('out_r');
    expect(wavecelDef.outputs.find((p) => p.id === 'out_l')?.type).toBe('audio');
    expect(wavecelDef.outputs.find((p) => p.id === 'out_r')?.type).toBe('audio');
  });

  it('exposes scope_out as mono-video (single-color trace)', () => {
    const p = wavecelDef.outputs.find((o) => o.id === 'scope_out');
    expect(p, 'scope_out declared').toBeDefined();
    expect(p?.type).toBe('mono-video');
  });

  it('exposes wave3d_out as video (RGB so orange + white survive)', () => {
    const p = wavecelDef.outputs.find((o) => o.id === 'wave3d_out');
    expect(p, 'wave3d_out declared').toBeDefined();
    expect(p?.type).toBe('video');
  });

  it('has 7 inputs (pitch, fm, 3×cv, poly, trigger) + 4 outputs', () => {
    expect(wavecelDef.inputs.length).toBe(7);
    expect(wavecelDef.outputs.length).toBe(4);
  });

  it('declares a poly input (polyPitchGate, 5-voice chord bus) — still at index 5', () => {
    const poly = wavecelDef.inputs.find((i) => i.id === 'poly');
    expect(poly, 'WAVECEL must expose a `poly` input port').toBeTruthy();
    expect(poly!.type).toBe('polyPitchGate');
    // Node connection (no paramTarget — it carries audio-rate pitch+gate).
    expect(poly!.paramTarget).toBeUndefined();
    // Poly STAYS at input index 5 (the new trigger is APPENDED at 6).
    expect(wavecelDef.inputs.findIndex((i) => i.id === 'poly')).toBe(5);
  });

  it('declares a mono trigger gate input (per-voice ADSR) appended at index 6', () => {
    const trig = wavecelDef.inputs.find((i) => i.id === 'trigger');
    expect(trig, 'WAVECEL must expose a `trigger` input port').toBeTruthy();
    expect(trig!.type).toBe('gate');
    expect(trig!.paramTarget).toBeUndefined();
    expect(wavecelDef.inputs.findIndex((i) => i.id === 'trigger')).toBe(6);
  });

  it('declares the 4 per-voice ADSR params (attack/decay/sustain/release)', () => {
    const byId = Object.fromEntries(wavecelDef.params.map((p) => [p.id, p] as const));
    expect(byId.attack).toMatchObject({ min: 0.001, max: 5, defaultValue: 0.001, curve: 'log' });
    expect(byId.decay).toMatchObject({ min: 0.001, max: 5, defaultValue: 0.1, curve: 'log' });
    expect(byId.sustain).toMatchObject({ min: 0, max: 1, defaultValue: 1, curve: 'linear' });
    expect(byId.release).toMatchObject({ min: 0.001, max: 5, defaultValue: 0.005, curve: 'log' });
  });

  it('preserves the stereoPairs metadata for the audio outs', () => {
    expect(wavecelDef.stereoPairs).toEqual([['out_l', 'out_r']]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Worklet DSP behavior — capture the processor + drive process().
// ─────────────────────────────────────────────────────────────────────────

type ProcInstance = {
  process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean;
  port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown) => void };
};
type ProcCtor = new () => ProcInstance;
let capturedProc: ProcCtor | null = null;
async function loadProcessor(): Promise<ProcCtor> {
  if (capturedProc) return capturedProc;
  const g = globalThis as unknown as { registerProcessor?: (n: string, c: ProcCtor) => void };
  const prev = g.registerProcessor;
  let registered: ProcCtor | null = null;
  g.registerProcessor = (_n, ctor) => { registered = ctor; };
  // Relative path into the DSP source — worktrees may not symlink the package.
  await import('../../../../../dsp/src/wavecel');
  g.registerProcessor = prev;
  if (!registered) throw new Error('wavecel processor did not register');
  capturedProc = registered;
  return capturedProc;
}

function makeParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const base: Record<string, number> = {};
  for (const p of wavecelDef.params) base[p.id] = p.defaultValue;
  Object.assign(base, over);
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(base)) out[k] = new Float32Array([v]);
  return out;
}

function loadTable(proc: ProcInstance): void {
  const t = getFactoryTable('basic-shapes') ?? getFactoryTables()[0]!;
  proc.port.onmessage?.({ data: { type: 'loadWavetable', frames: framesToPlain(t.frames) } });
}

function peak(b: Float32Array): number { let m = 0; for (let i = 0; i < b.length; i++) m = Math.max(m, Math.abs(b[i] ?? 0)); return m; }

/** Run with a mono pitch on inputs[0]. inputs 1..4 absent (mono path). */
function runMono(proc: ProcInstance, params: Record<string, Float32Array>, seconds: number, voct: number): { L: Float32Array; R: Float32Array } {
  const total = Math.round(SR * seconds);
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  let g = 0;
  while (g < total) {
    const len = Math.min(BLOCK, total - g);
    const pitch = new Float32Array(len).fill(voct);
    const outL = new Float32Array(len);
    const outR = new Float32Array(len);
    proc.process([[pitch]], [[outL], [outR]], params);
    for (let i = 0; i < len; i++) { L[g + i] = outL[i] as number; R[g + i] = outR[i] as number; }
    g += len;
  }
  return { L, R };
}

/** Build a 10-channel poly bus block (ch 2i = lane-i pitch, ch 2i+1 = gate). */
function makePoly(len: number, lanes: Array<{ voct: number; gate: 0 | 1 } | undefined>): Float32Array[] {
  const ch: Float32Array[] = [];
  for (let lane = 0; lane < 5; lane++) {
    const l = lanes[lane];
    ch.push(new Float32Array(len).fill(l ? l.voct : 0)); // pitch
    ch.push(new Float32Array(len).fill(l ? l.gate : 0));  // gate
  }
  return ch;
}

/** Run with a poly bus on inputs[5] (mono pitch on inputs[0] is silent). */
function runPoly(proc: ProcInstance, params: Record<string, Float32Array>, seconds: number, lanes: Array<{ voct: number; gate: 0 | 1 } | undefined>): { L: Float32Array; R: Float32Array } {
  const total = Math.round(SR * seconds);
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  let g = 0;
  while (g < total) {
    const len = Math.min(BLOCK, total - g);
    const pitch = new Float32Array(len); // silent mono
    const poly = makePoly(len, lanes);
    const outL = new Float32Array(len);
    const outR = new Float32Array(len);
    // inputs: [pitch], [fm], [morphCv], [spreadCv], [foldCv], poly(10ch)
    proc.process([[pitch], [], [], [], [], poly], [[outL], [outR]], params);
    for (let i = 0; i < len; i++) { L[g + i] = outL[i] as number; R[g + i] = outR[i] as number; }
    g += len;
  }
  return { L, R };
}

describe('WAVECEL worklet — capture + mono output', () => {
  it('a 65 Hz mono pitch through a loaded table yields nonzero output', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    loadTable(p);
    const voct = Math.log2(65.41 / 261.626); // C2
    const { L } = runMono(p, makeParams({ spread: 1 }), 0.25, voct);
    expect(peak(L)).toBeGreaterThan(1e-3);
    expect(L.findIndex((v) => !Number.isFinite(v))).toBe(-1);
  });

  it('is silent until a table is loaded', async () => {
    const Proc = await loadProcessor();
    const p = new Proc(); // no loadTable
    const voct = Math.log2(65.41 / 261.626);
    const { L } = runMono(p, makeParams(), 0.05, voct);
    expect(peak(L)).toBe(0);
  });
});

describe('WAVECEL worklet — poly input (polyPitchGate)', () => {
  const C2 = Math.log2(65.41 / 261.626);
  const E2 = Math.log2(82.41 / 261.626);
  const G2 = Math.log2(98.0 / 261.626);

  it('a gated poly lane produces audible output (mono pitch input silent)', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    loadTable(p);
    const { L } = runPoly(p, makeParams({ spread: 1 }), 0.25, [{ voct: C2, gate: 1 }]);
    expect(peak(L)).toBeGreaterThan(1e-3);
    expect(L.findIndex((v) => !Number.isFinite(v))).toBe(-1);
  });

  it('a 3-note chord (3 gated lanes) differs from a single gated lane', async () => {
    const Proc = await loadProcessor();
    const ps = makeParams({ spread: 1, morph: 0.3 });

    const pOne = new Proc(); loadTable(pOne);
    const one = runPoly(pOne, ps, 0.3, [{ voct: C2, gate: 1 }]);

    const pChord = new Proc(); loadTable(pChord);
    const chord = runPoly(pChord, ps, 0.3, [
      { voct: C2, gate: 1 }, { voct: E2, gate: 1 }, { voct: G2, gate: 1 },
    ]);

    expect(peak(chord.L)).toBeGreaterThan(1e-3);
    let differs = false;
    for (let i = 0; i < one.L.length; i++) {
      if (Math.abs(one.L[i]! - chord.L[i]!) > 1e-4) { differs = true; break; }
    }
    expect(differs, 'a 3-note chord must differ from one note').toBe(true);
  });

  it('all poly gates closed → render equals the pure mono path (no extra voice)', async () => {
    const Proc = await loadProcessor();
    const ps = makeParams({ spread: 1 });

    // Poly bus present but all gate=0, mono pitch silent (0 V = C4).
    const pPoly = new Proc(); loadTable(pPoly);
    const allClosed = runPoly(pPoly, ps, 0.1, [{ voct: C2, gate: 0 }, { voct: E2, gate: 0 }]);

    // Pure mono render at 0 V (no poly bus).
    const pMono = new Proc(); loadTable(pMono);
    const mono = runMono(pMono, ps, 0.1, 0);

    let maxDiff = 0;
    for (let i = 0; i < mono.L.length; i++) maxDiff = Math.max(maxDiff, Math.abs(mono.L[i]! - allClosed.L[i]!));
    expect(maxDiff, 'all-gates-closed must equal the pure mono render').toBe(0);
  });

  it('BACKWARDS-COMPAT: mono render byte-identical with vs without a present (all-zero) poly bus', async () => {
    const Proc = await loadProcessor();
    const voct = Math.log2(98 / 261.626); // G2
    const ps = makeParams({ morph: 0.5, spread: 2, fold: 0.3 });

    const pNoPoly = new Proc(); loadTable(pNoPoly);
    const noPoly = runMono(pNoPoly, ps, 0.2, voct);

    // Present-but-all-zero poly bus alongside the SAME mono pitch.
    const pZero = new Proc(); loadTable(pZero);
    const zero = (() => {
      const total = Math.round(SR * 0.2);
      const L = new Float32Array(total);
      const R = new Float32Array(total);
      let g = 0;
      while (g < total) {
        const len = Math.min(BLOCK, total - g);
        const pitch = new Float32Array(len).fill(voct);
        const poly: Float32Array[] = [];
        for (let c = 0; c < POLY_CH; c++) poly.push(new Float32Array(len)); // all zero
        const outL = new Float32Array(len);
        const outR = new Float32Array(len);
        pZero.process([[pitch], [], [], [], [], poly], [[outL], [outR]], ps);
        for (let i = 0; i < len; i++) { L[g + i] = outL[i] as number; R[g + i] = outR[i] as number; }
        g += len;
      }
      return { L, R };
    })();

    let maxDiff = 0;
    for (let i = 0; i < noPoly.L.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(noPoly.L[i]! - zero.L[i]!), Math.abs(noPoly.R[i]! - zero.R[i]!));
    }
    expect(maxDiff, 'a present-but-silent poly bus changed the mono render').toBe(0);
  });
});
