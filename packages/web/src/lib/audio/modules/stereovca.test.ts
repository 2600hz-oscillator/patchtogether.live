// packages/web/src/lib/audio/modules/stereovca.test.ts
//
// Unit tests for STEREOVCA's pure math + module-def shape. The worklet
// itself is exercised via the ART harness; here we pin the per-sample
// multiply, normalling rules, ring-mod sum/difference frequencies, and
// the def's port + param shape so a refactor that drifts any of these
// is caught at vitest time.

import { describe, expect, it } from 'vitest';
import { stereovcaDef, stereoVcaMath } from './stereovca';

const SR = 48000;

function sineBuffer(freqHz: number, frames: number, amp = 1.0, sr = SR): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    out[i] = Math.sin((2 * Math.PI * freqHz * i) / sr) * amp;
  }
  return out;
}

/** Naive DFT magnitude at one bin. Cheap when only a handful of bins
 *  matter — the wavefolder ART uses the same pattern. */
function dftMagAt(buf: Float32Array, k: number): number {
  let re = 0;
  let im = 0;
  const N = buf.length;
  for (let n = 0; n < N; n++) {
    const phi = (-2 * Math.PI * k * n) / N;
    re += (buf[n] ?? 0) * Math.cos(phi);
    im += (buf[n] ?? 0) * Math.sin(phi);
  }
  return Math.sqrt(re * re + im * im) / N;
}

describe('stereoVcaMath.sample: per-channel multiply', () => {
  it('strength=+1, offset=0, level=1 passes input through unchanged', () => {
    for (const x of [-0.9, -0.5, 0, 0.25, 0.7]) {
      expect(stereoVcaMath.sample(x, 1, 0, 1)).toBeCloseTo(x, 12);
    }
  });

  it('strength=0, offset=0 mutes', () => {
    expect(Math.abs(stereoVcaMath.sample(0.7, 0, 0, 1))).toBe(0);
    expect(Math.abs(stereoVcaMath.sample(-0.3, 0, 0, 1))).toBe(0);
  });

  it('strength=-1, offset=0 inverts (phase flip)', () => {
    expect(stereoVcaMath.sample(0.7, -1, 0, 1)).toBeCloseTo(-0.7, 12);
    expect(stereoVcaMath.sample(-0.3, -1, 0, 1)).toBeCloseTo(0.3, 12);
  });

  it('offset=+1 with strength=0 gives unity pass (strength rides on top of unity)', () => {
    expect(stereoVcaMath.sample(0.5, 0, 1, 1)).toBeCloseTo(0.5, 12);
    expect(stereoVcaMath.sample(-0.4, 0, 1, 1)).toBeCloseTo(-0.4, 12);
  });

  it('level scales the final output', () => {
    expect(stereoVcaMath.sample(1.0, 1, 0, 0.5)).toBeCloseTo(0.5, 12);
    expect(stereoVcaMath.sample(0.8, 1, 0, 0.25)).toBeCloseTo(0.2, 12);
  });
});

describe('stereoVcaMath.render: normalling rules', () => {
  it('both audio + both strength patched: per-channel independent math', () => {
    const N = 32;
    const inL = new Float32Array(N).fill(0.5);
    const inR = new Float32Array(N).fill(0.25);
    const sL  = new Float32Array(N).fill(1.0);
    const sR  = new Float32Array(N).fill(-1.0);
    const { outL, outR } = stereoVcaMath.render(inL, inR, sL, sR, 0, 1, N);
    expect(outL[0]).toBeCloseTo(0.5 * 1.0, 12);
    expect(outR[0]).toBeCloseTo(0.25 * -1.0, 12);
    // The two channels really are independent — outL ≠ outR sample-wise.
    expect(outL[0]).not.toBeCloseTo(outR[0] ?? 0, 6);
  });

  it('in_r unpatched: out_r uses in_l (mono → stereo)', () => {
    const N = 32;
    const inL = new Float32Array(N).fill(0.5);
    const sL  = new Float32Array(N).fill(1.0);
    const sR  = new Float32Array(N).fill(1.0);
    const { outL, outR } = stereoVcaMath.render(inL, null, sL, sR, 0, 1, N);
    // outR sees the same audio source as outL.
    expect(outR[0]).toBeCloseTo(outL[0] ?? 0, 12);
    expect(outR[0]).toBeCloseTo(0.5, 12);
  });

  it('strength_r unpatched: out_r uses strength_l (single strength both VCAs)', () => {
    const N = 32;
    const inL = new Float32Array(N).fill(0.5);
    const inR = new Float32Array(N).fill(0.25);
    const sL  = new Float32Array(N).fill(0.5);
    const { outL, outR } = stereoVcaMath.render(inL, inR, sL, null, 0, 1, N);
    expect(outL[0]).toBeCloseTo(0.5 * 0.5, 12);
    // strength_r normalled to strength_l, so outR = inR * strength_l.
    expect(outR[0]).toBeCloseTo(0.25 * 0.5, 12);
  });

  it('both unpatched: silence on both outputs', () => {
    const N = 32;
    const { outL, outR } = stereoVcaMath.render(null, null, null, null, 0, 1, N);
    for (let i = 0; i < N; i++) {
      expect(outL[i]).toBe(0);
      expect(outR[i]).toBe(0);
    }
  });

  it('normallings are INDEPENDENT: stereo audio + mono strength still drives both VCAs', () => {
    // Audio: true stereo (different inL / inR). Strength: only strength_l
    // patched. Both VCAs should multiply their distinct audio by the
    // shared strength → outL uses inL, outR uses inR, both × strength_l.
    // Float32Array storage truncates to single-precision so we use
    // float-tolerant precision (6 digits ≈ 1e-6) rather than the
    // double-precision 1e-12 used in pure-double math tests.
    const N = 32;
    const inL = new Float32Array(N).fill(0.4);
    const inR = new Float32Array(N).fill(-0.2);
    const sL  = new Float32Array(N).fill(0.75);
    const { outL, outR } = stereoVcaMath.render(inL, inR, sL, null, 0, 1, N);
    expect(outL[0]).toBeCloseTo(0.4 * 0.75, 6);
    expect(outR[0]).toBeCloseTo(-0.2 * 0.75, 6);
  });

  it('normallings are INDEPENDENT: mono audio + stereo strength gives per-side VCA gain', () => {
    // Audio: only inL patched. Strength: independent strength_l + strength_r.
    // outL uses inL × strength_l; outR uses inL (normalled) × strength_r.
    const N = 32;
    const inL = new Float32Array(N).fill(0.5);
    const sL  = new Float32Array(N).fill(1.0);
    const sR  = new Float32Array(N).fill(0.25);
    const { outL, outR } = stereoVcaMath.render(inL, null, sL, sR, 0, 1, N);
    expect(outL[0]).toBeCloseTo(0.5 * 1.0, 12);
    expect(outR[0]).toBeCloseTo(0.5 * 0.25, 12);
  });

  it('offset shifts strength: with offset=+1, strength=0 passes audio at unity', () => {
    const N = 32;
    const inL = new Float32Array(N).fill(0.6);
    const sL  = new Float32Array(N).fill(0);
    const { outL } = stereoVcaMath.render(inL, null, sL, null, 1, 1, N);
    expect(outL[0]).toBeCloseTo(0.6, 6);
  });
});

describe('stereoVcaMath.render: ring modulation produces sum + difference frequencies', () => {
  it('200Hz audio × 50Hz strength (offset=0) yields 150Hz + 250Hz components, low fundamental energy', () => {
    // Classical ring-mod identity: sin(2πfA t) * sin(2πfM t)
    //   = 0.5 * (cos(2π(fA-fM)t) - cos(2π(fA+fM)t))
    // With fA=200, fM=50 we expect peaks at 150 Hz and 250 Hz; the
    // 200 Hz fundamental should be near the noise floor.
    const N = 8192; // ~0.17s at 48k — > 1 cycle of every relevant freq.
    const audio = sineBuffer(200, N);
    const strength = sineBuffer(50, N);
    const { outL } = stereoVcaMath.render(audio, null, strength, null, 0, 1, N);

    // Bin index for freq f given N samples at SR: k ≈ f * N / SR.
    const k150 = Math.round((150 * N) / SR);
    const k200 = Math.round((200 * N) / SR);
    const k250 = Math.round((250 * N) / SR);
    const m150 = dftMagAt(outL, k150);
    const m200 = dftMagAt(outL, k200);
    const m250 = dftMagAt(outL, k250);

    // Sum + diff bands should both carry real energy.
    expect(m150, 'difference band 150Hz present').toBeGreaterThan(0.1);
    expect(m250, 'sum band 250Hz present').toBeGreaterThan(0.1);
    // 200Hz (the carrier itself) should be at least an order of
    // magnitude quieter than either sideband — ring-mod's defining
    // property is carrier suppression.
    expect(m200 / m150, '200Hz fundamental << 150Hz sideband').toBeLessThan(0.1);
    expect(m200 / m250, '200Hz fundamental << 250Hz sideband').toBeLessThan(0.1);
    // Sum + diff bands should be roughly balanced (mod-rate amplitude
    // identity above predicts equal magnitudes; tolerate ±20%).
    expect(Math.abs(m150 - m250) / Math.max(m150, m250)).toBeLessThan(0.2);
  });

  it('with offset=1 (carrier-pass mode), 200Hz fundamental survives + sidebands still present', () => {
    // Replacing strength with (strength + 1) is equivalent to ring-mod
    // PLUS audio passthrough at unity. The 200Hz fundamental now
    // carries the un-modulated audio; sidebands at 150/250Hz from the
    // ring component remain.
    const N = 8192;
    const audio = sineBuffer(200, N);
    const strength = sineBuffer(50, N);
    const { outL } = stereoVcaMath.render(audio, null, strength, null, 1, 1, N);

    const k150 = Math.round((150 * N) / SR);
    const k200 = Math.round((200 * N) / SR);
    const k250 = Math.round((250 * N) / SR);
    const m150 = dftMagAt(outL, k150);
    const m200 = dftMagAt(outL, k200);
    const m250 = dftMagAt(outL, k250);

    expect(m200, '200Hz carrier passes with offset=1').toBeGreaterThan(0.1);
    expect(m150, '150Hz sideband still present').toBeGreaterThan(0.05);
    expect(m250, '250Hz sideband still present').toBeGreaterThan(0.05);
  });
});

describe('stereovcaDef: module-def shape', () => {
  it('declares type=stereovca, label=STEREOVCA, category=utilities, domain=audio', () => {
    expect(stereovcaDef.type).toBe('stereovca');
    expect(stereovcaDef.label).toBe('stereovca');
    expect(stereovcaDef.category).toBe('utilities');
    expect(stereovcaDef.domain).toBe('audio');
  });

  it('exposes 4 inputs: in_l/in_r (audio) + strength_l/strength_r (cv)', () => {
    const ids = stereovcaDef.inputs.map((p) => p.id).sort();
    expect(ids).toEqual(['in_l', 'in_r', 'strength_l', 'strength_r']);
    const byId = Object.fromEntries(stereovcaDef.inputs.map((p) => [p.id, p]));
    // Audio carriers stay `audio` so an oscillator → in_l works as same-type.
    expect(byId.in_l!.type).toBe('audio');
    expect(byId.in_r!.type).toBe('audio');
    // Strength inputs are `cv` so LFOs / ADSRs land without a cross-type cast;
    // PASSTHROUGH_BY_DESIGN in cv-scale-registry.test.ts justifies omitting cvScale
    // (the worklet treats strength as a raw bipolar carrier in the per-sample multiply).
    expect(byId.strength_l!.type).toBe('cv');
    expect(byId.strength_r!.type).toBe('cv');
    for (const p of stereovcaDef.inputs) {
      // No paramTarget — these are audio-rate node inputs, not CV→param.
      expect(p.paramTarget, `${p.id} paramTarget`).toBeUndefined();
      expect(p.cvScale, `${p.id} cvScale`).toBeUndefined();
    }
  });

  it('exposes 2 audio outputs (out_l, out_r)', () => {
    const ids = stereovcaDef.outputs.map((p) => p.id).sort();
    expect(ids).toEqual(['out_l', 'out_r']);
    for (const p of stereovcaDef.outputs) {
      expect(p.type).toBe('audio');
    }
  });

  it('exposes 2 params: level (0..1, default 1) and offset (-1..+1, default 0)', () => {
    const ids = stereovcaDef.params.map((p) => p.id).sort();
    expect(ids).toEqual(['level', 'offset']);

    const level = stereovcaDef.params.find((p) => p.id === 'level');
    expect(level?.min).toBe(0);
    expect(level?.max).toBe(1);
    expect(level?.defaultValue).toBe(1);

    const offset = stereovcaDef.params.find((p) => p.id === 'offset');
    expect(offset?.min).toBe(-1);
    expect(offset?.max).toBe(1);
    expect(offset?.defaultValue).toBe(0);
  });

  it('has handle count 6 (4 inputs + 2 outputs)', () => {
    const total = stereovcaDef.inputs.length + stereovcaDef.outputs.length;
    expect(total).toBe(6);
  });
});
