// packages/web/src/lib/audio/modules/resofilter.test.ts
//
// Two test layers:
//   1. Module-def shape (3 inputs / 2 outputs / 4 params, CV targets,
//      stereo pair, RESOFILTER_MODE_NAMES length matches mode range).
//   2. Real DSP behavior — instantiate the worklet processor class directly
//      and drive process() to assert each mode's spectral character (LP
//      attenuates highs, HP attenuates lows, BP peaks at cutoff, notch
//      dips at cutoff, allpass leaves magnitude broadly intact), plus
//      ladder-style self-oscillation at high resonance and cutoff-smoothing
//      against click on sample-jump CV ramps.

import { describe, it, expect, beforeAll } from 'vitest';
import {
  resofilterDef,
  RESOFILTER_MODE_NAMES,
  RESOFILTER_MAX_MODE,
  RESOFILTER_MODE_COUNT,
} from './resofilter';

const SR = 48000;

// The worklet reads bare global `sampleRate` in its constructor; set it
// BEFORE we trigger the dynamic import below.
beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

// Capture the registered processor class via a shim (mirrors the harness
// pattern documented in dsp-worklet-no-top-level-export.md). We can't
// `import { ResofilterProcessor }` because the worklet entry NEVER exports
// its class at the top level — that would break ART's classic-script eval.
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
  // Relative path into the DSP source — worktrees may not have the
  // workspace package symlinked under node_modules.
  await import('../../../../../dsp/src/resofilter');
  g.registerProcessor = prev;
  if (!registered) throw new Error('resofilter processor did not register');
  capturedProc = registered;
  return capturedProc;
}

const BLOCK = 128;

/** Build a parameters record. Single-element Float32Array tells aval/kval
 *  to treat as constant. */
function makeParams(over: Record<string, number> = {}): Record<string, Float32Array> {
  const base: Record<string, number> = {};
  for (const p of resofilterDef.params) base[p.id] = p.defaultValue;
  Object.assign(base, over);
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(base)) out[k] = new Float32Array([v]);
  return out;
}

/** Run a processor for `seconds`, feeding inputFn into both audio channels.
 *  Returns the mono-L output (R tracks L for these probes). */
function runProc(
  proc: { process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean },
  params: Record<string, Float32Array>,
  seconds: number,
  inputFn: (n: number) => number,
): Float32Array {
  const total = Math.round(SR * seconds);
  const L = new Float32Array(total);
  let g = 0;
  while (g < total) {
    const len = Math.min(BLOCK, total - g);
    const inL = new Float32Array(len);
    const inR = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const v = inputFn(g + i);
      inL[i] = v;
      inR[i] = v;
    }
    const outL = new Float32Array(len);
    const outR = new Float32Array(len);
    // Inputs: one input port, two channels.
    proc.process([[inL, inR]], [[outL], [outR]], params);
    for (let i = 0; i < len; i++) L[g + i] = outL[i] as number;
    g += len;
  }
  return L;
}

/** Goertzel-style narrow-band magnitude at `freqHz`. Skips a settling
 *  prefix so we read the steady-state tail (where the filter has converged). */
function bandAmp(buf: Float32Array, freqHz: number, sr: number, skipFrames: number): number {
  const w = 2 * Math.PI * freqHz / sr;
  let re = 0; let im = 0;
  const n = buf.length - skipFrames;
  for (let i = skipFrames; i < buf.length; i++) {
    re += (buf[i] ?? 0) * Math.cos(w * (i - skipFrames));
    im += (buf[i] ?? 0) * Math.sin(w * (i - skipFrames));
  }
  return 2 * Math.sqrt(re * re + im * im) / n;
}

/** RMS over a window. */
function rms(buf: Float32Array, start = 0, end = buf.length): number {
  let s = 0; const n = end - start;
  for (let i = start; i < end; i++) s += (buf[i] ?? 0) * (buf[i] ?? 0);
  return Math.sqrt(s / n);
}

// ────────────────────────────────────────────────────────────────────────────
// 1) Module-def shape.
// ────────────────────────────────────────────────────────────────────────────

describe('resofilterDef — module def shape', () => {
  it('declares 3 inputs (audio, cutoff_cv, reso_cv)', () => {
    expect(resofilterDef.inputs.map((i) => i.id)).toEqual([
      'audio',
      'cutoff_cv',
      'reso_cv',
    ]);
  });

  it('declares 2 audio outputs in a stereo pair', () => {
    expect(resofilterDef.outputs.map((o) => o.id)).toEqual(['out_l', 'out_r']);
    expect(resofilterDef.outputs.every((o) => o.type === 'audio')).toBe(true);
    expect(resofilterDef.stereoPairs).toEqual([['out_l', 'out_r']]);
  });

  it('declares 4 params with the documented ranges + defaults', () => {
    const byId = Object.fromEntries(resofilterDef.params.map((p) => [p.id, p] as const));
    expect(Object.keys(byId).sort()).toEqual(['cutoff', 'mix', 'mode', 'resonance']);

    expect(byId.cutoff).toMatchObject({ min: 20, max: 20000, curve: 'log', defaultValue: 1000 });
    expect(byId.resonance).toMatchObject({ min: 0, max: 1, curve: 'linear', defaultValue: 0.3 });
    expect(byId.mode).toMatchObject({ min: 0, max: RESOFILTER_MAX_MODE, curve: 'discrete', defaultValue: 0 });
    expect(byId.mix).toMatchObject({ min: 0, max: 1, curve: 'linear', defaultValue: 1 });
  });

  it('CV inputs target the right params with linear cvScale', () => {
    const cutoffCv = resofilterDef.inputs.find((p) => p.id === 'cutoff_cv')!;
    expect(cutoffCv.paramTarget).toBe('cutoff');
    expect(cutoffCv.cvScale).toEqual({ mode: 'linear' });

    const resoCv = resofilterDef.inputs.find((p) => p.id === 'reso_cv')!;
    expect(resoCv.paramTarget).toBe('resonance');
    expect(resoCv.cvScale).toEqual({ mode: 'linear' });
  });

  it('MODE_NAMES length matches the mode param discrete range', () => {
    const modeParam = resofilterDef.params.find((p) => p.id === 'mode')!;
    expect(RESOFILTER_MODE_NAMES.length).toBe(modeParam.max - modeParam.min + 1);
    expect(RESOFILTER_MODE_COUNT).toBe(5);
  });

  it('claims processors category + Resonarium attribution', () => {
    expect(resofilterDef.category).toBe('processors');
    expect(resofilterDef.ossAttribution?.author).toMatch(/Resonarium/i);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2) DSP behavior — drive the worklet processor directly.
// ────────────────────────────────────────────────────────────────────────────

describe('RESOFILTER worklet — per-mode spectral character', () => {
  const FC = 1000; // cutoff for these tests
  const LOW_FREQ = 100;   // well below cutoff
  const HIGH_FREQ = 8000; // well above cutoff
  const RES = 0.2;
  const RENDER_S = 0.25;
  const SKIP = Math.round(0.1 * SR); // skip ~100ms to let the filter settle

  async function probeAt(modeIdx: number, freq: number, fc = FC): Promise<number> {
    const Proc = await loadProcessor();
    const p = new Proc();
    const params = makeParams({ cutoff: fc, resonance: RES, mode: modeIdx, mix: 1 });
    const out = runProc(p, params, RENDER_S, (n) => Math.sin(2 * Math.PI * freq * n / SR));
    return bandAmp(out, freq, SR, SKIP);
  }

  it('LP (mode 0) passes low frequencies more than high frequencies', async () => {
    const lpLow = await probeAt(0, LOW_FREQ);
    const lpHigh = await probeAt(0, HIGH_FREQ);
    // 1 kHz LP at 1 kHz cutoff: 100 Hz should pass near-unity; 8 kHz should
    // be heavily attenuated. Use a coarse ratio so FFT-bin slop doesn't
    // matter — the qualitative shape is what we pin.
    expect(lpLow).toBeGreaterThan(0.3);
    expect(lpHigh).toBeLessThan(lpLow * 0.5);
  });

  it('HP (mode 1) passes high frequencies more than low frequencies', async () => {
    const hpLow = await probeAt(1, LOW_FREQ);
    const hpHigh = await probeAt(1, HIGH_FREQ);
    expect(hpHigh).toBeGreaterThan(0.3);
    expect(hpLow).toBeLessThan(hpHigh * 0.5);
  });

  it('BP (mode 2) peaks at cutoff; tails fall off either side', async () => {
    const bpLow = await probeAt(2, LOW_FREQ);
    const bpAtFc = await probeAt(2, FC);
    const bpHigh = await probeAt(2, HIGH_FREQ);
    expect(bpAtFc).toBeGreaterThan(bpLow);
    expect(bpAtFc).toBeGreaterThan(bpHigh);
  });

  it('Notch (mode 3) dips at cutoff; passes either side', async () => {
    // Notch: the bp tap is subtracted out, so a tone AT fc is attenuated
    // while tones far from fc pass through ~unchanged. Use coarse bands.
    const notchAtFc = await probeAt(3, FC);
    const notchLow = await probeAt(3, LOW_FREQ);
    const notchHigh = await probeAt(3, HIGH_FREQ);
    // At fc the notch should attenuate; far-from-fc tones should not be
    // attenuated heavily relative to the notch dip.
    expect(notchLow).toBeGreaterThan(notchAtFc);
    expect(notchHigh).toBeGreaterThan(notchAtFc);
  });

  it('Allpass (mode 4) preserves magnitude across the band (rough equality)', async () => {
    // Allpass should pass ~unity-magnitude at all probe frequencies; phase
    // is what changes. Use a coarse equality window — TPT allpass at the
    // edges of [LOW_FREQ, HIGH_FREQ] won't be exactly 1.0, but should not
    // drop dramatically the way LP/HP/BP do.
    const lo = await probeAt(4, LOW_FREQ);
    const mid = await probeAt(4, FC);
    const hi = await probeAt(4, HIGH_FREQ);
    // None of the probes should be silenced; ratios stay within a coarse
    // window.
    expect(lo).toBeGreaterThan(0.1);
    expect(mid).toBeGreaterThan(0.1);
    expect(hi).toBeGreaterThan(0.1);
    // Magnitude should not vary by more than a factor of ~4 across the
    // band (notch / LP / HP fail this easily; allpass passes).
    const maxAmp = Math.max(lo, mid, hi);
    const minAmp = Math.min(lo, mid, hi);
    expect(maxAmp / minAmp).toBeLessThan(4);
  });
});

describe('RESOFILTER worklet — high-resonance ringing', () => {
  it('BP tail energy at res=0.99 dominates res=0 by >100x after a 10ms noise burst', async () => {
    // Upstream's MultiFilter is biquad-based and does NOT self-oscillate
    // (a Moog ladder would; the brief's "Ladder mode self-oscillates" note
    // doesn't apply to this 5-mode-biquad port). Instead, high resonance
    // produces a much longer ringing tail — the energy-ratio test pins
    // that the Q-vs-decay relationship is intact.
    const Proc = await loadProcessor();
    const drivenSamples = Math.round(0.01 * SR);
    // Deterministic LCG so the two runs see identical input.
    let lcgSeed = 1;
    const lcg = (): number => {
      lcgSeed = (lcgSeed * 1103515245 + 12345) & 0x7fffffff;
      return ((lcgSeed >> 8) & 0xff) / 255 - 0.5;
    };
    function tailEnergy(b: Float32Array): number {
      let s = 0;
      const tailStart = Math.round(0.05 * SR);
      for (let i = tailStart; i < b.length; i++) s += (b[i] ?? 0) * (b[i] ?? 0);
      return s;
    }

    lcgSeed = 1;
    const pLow = new Proc();
    const outLow = runProc(pLow, makeParams({ cutoff: 800, resonance: 0.0, mode: 2, mix: 1 }),
      0.4, (n) => n < drivenSamples ? lcg() : 0);

    lcgSeed = 1;
    const pHi = new Proc();
    const outHi = runProc(pHi, makeParams({ cutoff: 800, resonance: 0.99, mode: 2, mix: 1 }),
      0.4, (n) => n < drivenSamples ? lcg() : 0);

    expect(tailEnergy(outHi)).toBeGreaterThan(tailEnergy(outLow) * 100);
  });
});

describe('RESOFILTER worklet — cutoff smoothing prevents clicks', () => {
  it('Sudden 100 Hz → 5 kHz cutoff step does not produce a sample-to-sample click', async () => {
    const Proc = await loadProcessor();
    const p = new Proc();

    // Build a per-sample a-rate cutoff arr: 100 Hz for the first half,
    // jumps to 5 kHz on a single sample, holds.
    const seconds = 0.2;
    const total = Math.round(SR * seconds);
    const cutoffArr = new Float32Array(total);
    const switchAt = Math.round(0.1 * SR);
    for (let i = 0; i < total; i++) cutoffArr[i] = i < switchAt ? 100 : 5000;

    // We need the worklet to receive an a-rate Float32Array for `cutoff`.
    // aval() handles length>1 already; build a per-block param record.
    let g = 0;
    const outLfull = new Float32Array(total);
    while (g < total) {
      const len = Math.min(BLOCK, total - g);
      const inL = new Float32Array(len);
      const inR = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        // Steady sine input so the filter is doing real work; the cutoff
        // step is what we're testing for clicks.
        const v = 0.5 * Math.sin(2 * Math.PI * 440 * (g + i) / SR);
        inL[i] = v;
        inR[i] = v;
      }
      const params = makeParams({ resonance: 0.2, mode: 0, mix: 1 });
      // Replace cutoff with the per-sample slice.
      params.cutoff = cutoffArr.slice(g, g + len);
      const outL = new Float32Array(len);
      const outR = new Float32Array(len);
      p.process([[inL, inR]], [[outL], [outR]], params);
      for (let i = 0; i < len; i++) outLfull[g + i] = outL[i] as number;
      g += len;
    }

    // Find the sample-to-sample delta around the switch + assert it stays
    // bounded. Without smoothing a 50× cutoff jump on a TPT SVF can
    // produce a delta several times the steady-state sample level
    // (the new `g` recomputes the integrator pole instantly). With
    // 50 Hz smoothing the change reaches the SVF over ~10ms instead,
    // and per-sample deltas stay close to the steady-state envelope.
    let maxDelta = 0;
    const window = 64;
    for (let i = switchAt - window; i < switchAt + window; i++) {
      const d = Math.abs((outLfull[i] ?? 0) - (outLfull[i - 1] ?? 0));
      if (d > maxDelta) maxDelta = d;
    }
    // Steady-state peak |out| is roughly the input amplitude × LP
    // attenuation, bounded by 1; per-sample delta of a 440 Hz sine at
    // 48 kHz is sin-derivative-bounded ≈ 2π · 440 / 48000 ≈ 0.057. A
    // click would be order-of-magnitude bigger. 0.5 is a comfortable
    // upper bound that still catches gross click regressions.
    expect(maxDelta).toBeLessThan(0.5);
  });
});
