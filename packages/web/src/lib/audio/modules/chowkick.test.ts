// packages/web/src/lib/audio/modules/chowkick.test.ts
//
// CHOWKICK module-def shape + worklet behavior. We don't drive the worklet
// via the live AudioContext here — the per-sample math is already pinned
// in packages/dsp/src/lib/chowkick-dsp.test.ts. This file enforces the
// module-def contract: ports, params, ranges, defaults, attribution, and
// the worklet-Processor class registers without throwing.

import { describe, it, expect, beforeAll } from 'vitest';
import { chowkickDef } from './chowkick';

const SR = 48000;
beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

// Use the same registerProcessor-shim trick SIDECAR uses — capture the
// Processor class on import without an actual AudioWorkletGlobalScope.
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
  await import('../../../../../dsp/src/chowkick');
  g.registerProcessor = prev;
  if (!registered) throw new Error('chowkick processor did not register');
  capturedProc = registered;
  return capturedProc;
}

// ───────────────────────────────────────────────────────────────────────
// Module-def shape
// ───────────────────────────────────────────────────────────────────────

describe('chowkickDef — module def shape', () => {
  it('module id is "chowkick" + label "CHOWKICK"', () => {
    expect(chowkickDef.type).toBe('chowkick');
    expect(chowkickDef.label).toBe('chowkick');
  });

  it('declares gate_in + pitch_cv + 15 per-knob CV inputs (17 total)', () => {
    const ids = chowkickDef.inputs.map((i) => i.id);
    expect(ids).toEqual([
      'gate_in', 'pitch_cv',
      'width_cv', 'amplitude_cv', 'decay_cv', 'sustain_cv',
      'noise_amount_cv', 'noise_decay_cv', 'noise_cutoff_cv',
      'freq_cv', 'q_cv', 'damping_cv', 'tight_cv', 'bounce_cv',
      'tone_cv', 'portamento_cv', 'level_cv',
    ]);
    expect(ids).toHaveLength(17);
  });

  it('declares a single audio_out output', () => {
    expect(chowkickDef.outputs.map((o) => o.id)).toEqual(['audio_out']);
    expect(chowkickDef.outputs[0]!.type).toBe('audio');
  });

  it('gate_in is gate, pitch_cv is cv with no paramTarget (1V/oct routed in the worklet)', () => {
    const gate = chowkickDef.inputs.find((p) => p.id === 'gate_in')!;
    expect(gate.type).toBe('gate');
    const pitch = chowkickDef.inputs.find((p) => p.id === 'pitch_cv')!;
    expect(pitch.type).toBe('cv');
    // pitch_cv intentionally has no paramTarget — the worklet applies it
    // as a multiplier on the freq AudioParam (freq *= 2^pitch_cv).
    expect(pitch.paramTarget).toBeUndefined();
  });

  it('per-knob CV inputs all have paramTarget pointing at the matching param', () => {
    const pairs: Array<[string, string]> = [
      ['width_cv',        'width'],
      ['amplitude_cv',    'amplitude'],
      ['decay_cv',        'decay'],
      ['sustain_cv',      'sustain'],
      ['noise_amount_cv', 'noise_amount'],
      ['noise_decay_cv',  'noise_decay'],
      ['noise_cutoff_cv', 'noise_cutoff'],
      ['freq_cv',         'freq'],
      ['q_cv',            'q'],
      ['damping_cv',      'damping'],
      ['tight_cv',        'tight'],
      ['bounce_cv',       'bounce'],
      ['tone_cv',         'tone'],
      ['portamento_cv',   'portamento'],
      ['level_cv',        'level'],
    ];
    for (const [portId, paramId] of pairs) {
      const port = chowkickDef.inputs.find((p) => p.id === portId);
      expect(port, `missing port ${portId}`).toBeTruthy();
      expect(port!.paramTarget, `${portId}.paramTarget`).toBe(paramId);
      expect(port!.cvScale).toBeTruthy();
    }
  });

  it('declares all 17 params with the spec\'s ranges + defaults + curves', () => {
    const byId = Object.fromEntries(chowkickDef.params.map((p) => [p.id, p] as const));
    expect(byId.width).toMatchObject({         min: 0.1, max: 50,   curve: 'log',      defaultValue: 1 });
    expect(byId.amplitude).toMatchObject({     min: 0,   max: 2,    curve: 'linear',   defaultValue: 1 });
    expect(byId.decay).toMatchObject({         min: 0,   max: 1,    curve: 'linear',   defaultValue: 1 });
    expect(byId.sustain).toMatchObject({       min: 0,   max: 1,    curve: 'linear',   defaultValue: 0.5 });
    expect(byId.noise_amount).toMatchObject({  min: 0,   max: 1,    curve: 'linear',   defaultValue: 0 });
    expect(byId.noise_decay).toMatchObject({   min: 0,   max: 1,    curve: 'linear',   defaultValue: 0.5 });
    expect(byId.noise_cutoff).toMatchObject({  min: 20,  max: 5000, curve: 'log',      defaultValue: 500 });
    expect(byId.noise_type).toMatchObject({    min: 0,   max: 3,    curve: 'discrete', defaultValue: 0 });
    expect(byId.freq).toMatchObject({          min: 20,  max: 500,  curve: 'log',      defaultValue: 80 });
    expect(byId.q).toMatchObject({             min: 0.1, max: 10,   curve: 'log',      defaultValue: 0.5 });
    expect(byId.damping).toMatchObject({       min: 0,   max: 1,    curve: 'linear',   defaultValue: 0.5 });
    expect(byId.tight).toMatchObject({         min: 0,   max: 1,    curve: 'linear',   defaultValue: 0.5 });
    expect(byId.bounce).toMatchObject({        min: 0,   max: 1,    curve: 'linear',   defaultValue: 0 });
    expect(byId.tone).toMatchObject({          min: 50,  max: 2000, curve: 'log',      defaultValue: 800 });
    expect(byId.portamento).toMatchObject({    min: 0,   max: 100,  curve: 'log',      defaultValue: 0.5 });
    expect(byId.level).toMatchObject({         min: -60, max: 0,    curve: 'linear',   defaultValue: 0 });
    expect(byId.link).toMatchObject({          min: 0,   max: 1,    curve: 'discrete', defaultValue: 0 });
    expect(Object.keys(byId)).toHaveLength(17);
  });

  it('claims BSD-3-Clause ChowKick attribution', () => {
    expect(chowkickDef.ossAttribution?.author).toMatch(/ChowKick/);
    expect(chowkickDef.ossAttribution?.author).toMatch(/BSD-3-Clause/);
    expect(chowkickDef.ossAttribution?.author).toMatch(/Jatin Chowdhury|chowdsp/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Worklet processor — load + smoke-render
// ───────────────────────────────────────────────────────────────────────

const BLOCK = 128;

function makeParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const base: Record<string, number> = {};
  for (const p of chowkickDef.params) base[p.id] = p.defaultValue;
  Object.assign(base, over);
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(base)) out[k] = new Float32Array([v]);
  return out;
}

/** Run the processor for `seconds`, with optional gate driver. */
function runProc(
  proc: { process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean },
  params: Record<string, Float32Array>,
  seconds: number,
  gateFn?: (n: number) => number,
): Float32Array {
  const total = Math.round(SR * seconds);
  const audioOut = new Float32Array(total);
  let g = 0;
  while (g < total) {
    const len = Math.min(BLOCK, total - g);
    const inGate = new Float32Array(len);
    const inPitch = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      inGate[i] = gateFn ? gateFn(g + i) : 0;
    }
    const out = new Float32Array(len);
    proc.process([[inGate], [inPitch]], [[out]], params);
    for (let i = 0; i < len; i++) audioOut[g + i] = out[i] as number;
    g += len;
  }
  return audioOut;
}

describe('CHOWKICK worklet — load + smoke', () => {
  it('Processor class registers without throwing', async () => {
    const Proc = await loadProcessor();
    expect(Proc).toBeTruthy();
    expect(() => new Proc()).not.toThrow();
  });

  it('no gate → silent output (no spontaneous oscillation)', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    const audio = runProc(p, makeParams(), 0.05);
    let max = 0;
    for (let i = 0; i < audio.length; i++) max = Math.max(max, Math.abs(audio[i] ?? 0));
    expect(max).toBeLessThan(1e-6);
  });

  it('one gate pulse → finite, non-silent audio with peak > 0.001', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    // Gate pulse: 5 ms high at sample 100.
    const audio = runProc(p, makeParams({ freq: 80, q: 1, level: 0 }), 0.2,
      (n) => (n >= 100 && n < 100 + Math.round(0.005 * SR)) ? 1 : 0);
    let peak = 0; let bad = -1;
    for (let i = 0; i < audio.length; i++) {
      const v = audio[i] ?? 0;
      if (!Number.isFinite(v)) bad = i;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    expect(bad, `non-finite sample at ${bad}`).toBe(-1);
    expect(peak).toBeGreaterThan(0.001);
  });

  it('changing noise_type by parameter does not blow up the worklet', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();
    // Cycle through all 4 noise types over consecutive blocks.
    for (let type = 0; type < 4; type++) {
      const audio = runProc(p,
        makeParams({ noise_amount: 1, noise_decay: 1, noise_cutoff: 2000, noise_type: type, level: 0 }),
        0.05,
        (n) => n === 0 ? 1 : 0);
      for (let i = 0; i < audio.length; i++) {
        expect(Number.isFinite(audio[i]!)).toBe(true);
      }
    }
  });
});
