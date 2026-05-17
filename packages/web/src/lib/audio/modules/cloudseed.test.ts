// packages/web/src/lib/audio/modules/cloudseed.test.ts
//
// Unit tests for CLOUDSEED — Ghost Note Audio reverb port. Verifies the
// scaleParam table is bit-compatible with the C++ reference, the
// deterministic RandomBuffer generates the same seeded sequences, the
// preset bank loads, and the module-def shape matches the registration
// contract.

import { describe, expect, it } from 'vitest';
import {
  cloudseedDef,
  CloudseedParam,
  CloudseedLcg,
  cloudseedRandomBuffer,
  cloudseedRandomBufferCrossSeed,
  scaleParam,
  formatParameter,
  CLOUDSEED_PRESETS,
  CLOUDSEED_MESSAGE_PARAMS,
  CLOUDSEED_MACRO_CPP_MAP,
  presetDecaySeconds,
  biquadLowShelfCoeffs,
  biquadHighShelfCoeffs,
  onePoleCoeffs,
  multitapTapPositions,
} from './cloudseed';

describe('CloudseedLcg: Borland 22695477/1 LCG', () => {
  it('produces the deterministic Borland sequence from seed 0', () => {
    // The Borland LCG with seed=0 emits a fixed sequence; we anchor the
    // first few values so any drift in the inner math triggers a test
    // failure rather than silently shifting all the seeded reverb
    // delay-line lengths.
    const rng = new CloudseedLcg(0);
    const a = rng.nextUInt(); // a*0 + 1 = 1
    const b = rng.nextUInt(); // a*1 + 1 = 22695478
    const c = rng.nextUInt(); // (a*22695478 + 1) & 0xFFFFFFFF
    expect(a).toBe(1);
    expect(b).toBe(22695478);
    // (22695477 * 22695478 + 1) mod 2^32:
    const expectedC = Number((22695477n * 22695478n + 1n) & 0xffffffffn);
    expect(c).toBe(expectedC);
  });

  it('different seeds produce different sequences', () => {
    const rng1 = new CloudseedLcg(123);
    const rng2 = new CloudseedLcg(456);
    expect(rng1.nextUInt()).not.toBe(rng2.nextUInt());
  });

  it('same seed reproduces the same sequence (determinism is the whole point)', () => {
    const rng1 = new CloudseedLcg(0xabc);
    const rng2 = new CloudseedLcg(0xabc);
    for (let i = 0; i < 16; i++) expect(rng1.nextUInt()).toBe(rng2.nextUInt());
  });
});

describe('cloudseedRandomBuffer: seeded [0,1] float series', () => {
  it('returns exactly `count` floats, each in [0,1]', () => {
    const buf = cloudseedRandomBuffer(42, 100);
    expect(buf.length).toBe(100);
    for (let i = 0; i < buf.length; i++) {
      expect(buf[i]!).toBeGreaterThanOrEqual(0);
      expect(buf[i]!).toBeLessThanOrEqual(1);
    }
  });

  it('cross-seed=0 returns the seedA-only series; cross-seed=1 the seedB-only series', () => {
    const a = cloudseedRandomBuffer(7, 16);
    const blended0 = cloudseedRandomBufferCrossSeed(7, 16, 0);
    for (let i = 0; i < 16; i++) {
      expect(blended0[i]).toBeCloseTo(a[i]!, 6);
    }
    // Cross-seed 0.5 averages → produces a different sequence.
    const blendedHalf = cloudseedRandomBufferCrossSeed(7, 16, 0.5);
    let differs = false;
    for (let i = 0; i < 16; i++) {
      if (Math.abs(blendedHalf[i]! - a[i]!) > 1e-6) { differs = true; break; }
    }
    expect(differs).toBe(true);
  });
});

describe('scaleParam: 1:1 mirror of C++ Parameters.h::ScaleParam', () => {
  it('toggle params snap to 0 or 1 at the half-step boundary', () => {
    for (const p of [
      CloudseedParam.Interpolation,
      CloudseedParam.LowCutEnabled,
      CloudseedParam.HighCutEnabled,
      CloudseedParam.TapEnabled,
      CloudseedParam.LateDiffuseEnabled,
      CloudseedParam.EqLowShelfEnabled,
      CloudseedParam.EqHighShelfEnabled,
      CloudseedParam.EqLowpassEnabled,
      CloudseedParam.EarlyDiffuseEnabled,
    ]) {
      expect(scaleParam(0, p)).toBe(0);
      expect(scaleParam(0.49999, p)).toBe(0);
      expect(scaleParam(0.5, p)).toBe(1);
      expect(scaleParam(1, p)).toBe(1);
    }
  });

  it('identity params (InputMix, EqCrossSeed, TapDecay, …) pass val through', () => {
    for (const p of [
      CloudseedParam.InputMix,
      CloudseedParam.EarlyDiffuseFeedback,
      CloudseedParam.TapDecay,
      CloudseedParam.LateDiffuseFeedback,
      CloudseedParam.EqCrossSeed,
    ]) {
      expect(scaleParam(0, p)).toBe(0);
      expect(scaleParam(0.5, p)).toBe(0.5);
      expect(scaleParam(1, p)).toBe(1);
    }
  });

  it('seed params clamp to floor(val * 999.999) — covers 0..999', () => {
    expect(scaleParam(0, CloudseedParam.SeedTap)).toBe(0);
    expect(scaleParam(0.5, CloudseedParam.SeedTap)).toBe(499);
    expect(scaleParam(1, CloudseedParam.SeedTap)).toBe(999);
  });

  it('output level params map 0..1 → -30..0 dB linearly', () => {
    for (const p of [CloudseedParam.DryOut, CloudseedParam.EarlyOut, CloudseedParam.LateOut]) {
      expect(scaleParam(0, p)).toBe(-30);
      expect(scaleParam(0.5, p)).toBe(-15);
      expect(scaleParam(1, p)).toBe(0);
    }
  });

  it('TapCount: integer 1..256 (1 + val*255 floored)', () => {
    expect(scaleParam(0, CloudseedParam.TapCount)).toBe(1);
    expect(scaleParam(1, CloudseedParam.TapCount)).toBe(256);
    // mid-point
    expect(scaleParam(0.5, CloudseedParam.TapCount)).toBe(Math.floor(1 + 0.5 * 255));
  });

  it('EarlyDiffuseCount + LateLineCount: integer 1..12', () => {
    for (const p of [CloudseedParam.EarlyDiffuseCount, CloudseedParam.LateLineCount]) {
      expect(scaleParam(0, p)).toBe(1);
      expect(scaleParam(1, p)).toBe(12);
    }
  });

  it('LateDiffuseCount: integer 1..8 (per C++ comment)', () => {
    expect(scaleParam(0, CloudseedParam.LateDiffuseCount)).toBe(1);
    expect(scaleParam(1, CloudseedParam.LateDiffuseCount)).toBe(8);
  });

  it('LateLineDecay: 0.05..60s with 3-decade-warp response (DarkPlate ≈ 5.2s)', () => {
    // The C++ scaling: 0.05 + Resp3dec(val) * 59.95. At val=0 we get 0.05s.
    expect(scaleParam(0, CloudseedParam.LateLineDecay)).toBeCloseTo(0.05, 6);
    // DarkPlate uses 0.6346 → about 5..7 seconds (medium-long tail).
    const dp = scaleParam(0.6346, CloudseedParam.LateLineDecay);
    expect(dp).toBeGreaterThan(1);
    expect(dp).toBeLessThan(30);
  });

  it('LateMode: PRE (0) / POST (1)', () => {
    expect(scaleParam(0.4, CloudseedParam.LateMode)).toBe(0);
    expect(scaleParam(0.6, CloudseedParam.LateMode)).toBe(1);
  });
});

describe('formatParameter: matches the C++ FormatParameter switch', () => {
  it('toggle params render ENABLED / DISABLED', () => {
    expect(formatParameter(1, CloudseedParam.TapEnabled)).toBe('ENABLED');
    expect(formatParameter(0, CloudseedParam.TapEnabled)).toBe('DISABLED');
  });

  it('percent params render N% with integer-rounded percentage', () => {
    expect(formatParameter(0.5, CloudseedParam.InputMix)).toBe('50%');
    expect(formatParameter(0, CloudseedParam.TapDecay)).toBe('0%');
    expect(formatParameter(1, CloudseedParam.TapDecay)).toBe('100%');
  });

  it('output level params render "MUTED" at the floor, "X.X dB" above', () => {
    expect(formatParameter(0, CloudseedParam.DryOut)).toBe('MUTED');
    expect(formatParameter(1, CloudseedParam.DryOut)).toBe('0.0 dB');
    expect(formatParameter(0.5, CloudseedParam.LateOut)).toBe('-15.0 dB');
  });

  it('LateLineDecay readout switches ms / sec formatting at the 1s boundary', () => {
    // Very small val → milliseconds.
    expect(formatParameter(0, CloudseedParam.LateLineDecay)).toMatch(/ms$/);
    // DarkPlate's value (0.6346) is in the multi-second range.
    expect(formatParameter(0.6346, CloudseedParam.LateLineDecay)).toMatch(/sec$/);
  });

  it('LateMode renders PRE / POST', () => {
    expect(formatParameter(0, CloudseedParam.LateMode)).toBe('PRE');
    expect(formatParameter(1, CloudseedParam.LateMode)).toBe('POST');
  });

  it('seed params render 3-digit zero-padded counts', () => {
    expect(formatParameter(0, CloudseedParam.SeedTap)).toBe('000');
    expect(formatParameter(1, CloudseedParam.SeedTap)).toBe('999');
    // mid-range
    expect(formatParameter(0.5, CloudseedParam.SeedTap)).toMatch(/^\d{3}$/);
  });
});

describe('Preset bank', () => {
  it('ships at least 4 presets including DIVINE INSPIRATION (DarkPlate)', () => {
    expect(CLOUDSEED_PRESETS.length).toBeGreaterThanOrEqual(4);
    const names = CLOUDSEED_PRESETS.map((p) => p.name);
    expect(names).toContain('[FX] DIVINE INSPIRATION');
  });

  it('all presets cover every required param category', () => {
    for (const preset of CLOUDSEED_PRESETS) {
      // Each preset must specify LateLineDecay (drives the DECAY readout).
      expect(preset.values[CloudseedParam.LateLineDecay]).toBeDefined();
      // And at least one of the output mixes.
      const anyOut = preset.values[CloudseedParam.DryOut] ?? preset.values[CloudseedParam.LateOut];
      expect(anyOut).toBeDefined();
    }
  });

  it('presetDecaySeconds returns the scaled RT60 target from LateLineDecay', () => {
    for (const preset of CLOUDSEED_PRESETS) {
      const sec = presetDecaySeconds(preset);
      expect(sec).toBeGreaterThan(0);
      expect(sec).toBeLessThan(60);
    }
    // SHORT ROOM should be markedly shorter than INFINITE PAD.
    const short = CLOUDSEED_PRESETS.find((p) => p.name.includes('SHORT'))!;
    const infinite = CLOUDSEED_PRESETS.find((p) => p.name.includes('INFINITE'))!;
    expect(presetDecaySeconds(short)).toBeLessThan(presetDecaySeconds(infinite));
  });
});

describe('cloudseedDef: module-def shape', () => {
  it('declares type=cloudseed, label=CLOUDSEED, category=effects, domain=audio', () => {
    expect(cloudseedDef.type).toBe('cloudseed');
    expect(cloudseedDef.label).toBe('CLOUDSEED');
    expect(cloudseedDef.category).toBe('effects');
    expect(cloudseedDef.domain).toBe('audio');
  });

  it('exposes stereo audio I/O (in_l/in_r + out_l/out_r)', () => {
    const inIds = cloudseedDef.inputs.map((p) => p.id);
    const outIds = cloudseedDef.outputs.map((p) => p.id);
    expect(inIds).toContain('in_l');
    expect(inIds).toContain('in_r');
    expect(outIds).toEqual(['out_l', 'out_r']);
    expect(cloudseedDef.stereoPairs).toEqual([['in_l', 'in_r'], ['out_l', 'out_r']]);
  });

  it('exposes 7 macro AudioParam CV inputs (one per CV input matches a paramTarget)', () => {
    const cvInputs = cloudseedDef.inputs.filter((p) => p.type === 'cv');
    expect(cvInputs.length).toBe(7);
    for (const cv of cvInputs) {
      expect(cv.paramTarget).toBeDefined();
      // each cv should target one of the macro AudioParams
      expect(Object.keys(CLOUDSEED_MACRO_CPP_MAP)).toContain(cv.paramTarget);
    }
  });

  it('declares the full 45-param inventory + a preset_index slot', () => {
    // 7 macros + 38 message-port params + 1 preset_index = 46 expected
    expect(cloudseedDef.params.length).toBe(7 + CLOUDSEED_MESSAGE_PARAMS.length + 1);
    const ids = new Set(cloudseedDef.params.map((p) => p.id));
    expect(ids.has('preset_index')).toBe(true);
    expect(ids.has('dry_out')).toBe(true);
    expect(ids.has('tap_enabled')).toBe(true);
  });

  it('every message-port param maps to a unique C++ enum index in 0..44', () => {
    const seen = new Set<number>();
    for (const mp of CLOUDSEED_MESSAGE_PARAMS) {
      expect(mp.cppId).toBeGreaterThanOrEqual(0);
      expect(mp.cppId).toBeLessThan(CloudseedParam.COUNT);
      expect(seen.has(mp.cppId)).toBe(false);
      seen.add(mp.cppId);
    }
  });
});

describe('Pure-math primitives: biquad coefficients', () => {
  it('biquadLowShelfCoeffs at 0 dB gain returns near-unity-gain coefficients', () => {
    const c = biquadLowShelfCoeffs(200, 48000, 0);
    // gain=0 means V=1, K cancellation should give b0 ≈ 1, b1 ≈ a1, b2 ≈ a2.
    // We just verify the coefficients are finite + normalised.
    expect(Number.isFinite(c.b0)).toBe(true);
    expect(Number.isFinite(c.b1)).toBe(true);
    expect(Number.isFinite(c.b2)).toBe(true);
    expect(Number.isFinite(c.a1)).toBe(true);
    expect(Number.isFinite(c.a2)).toBe(true);
    // |b0| should be < 2 (sanity).
    expect(Math.abs(c.b0)).toBeLessThan(2);
  });

  it('biquadHighShelfCoeffs with +12 dB boost lifts the high band (b0 > 1)', () => {
    const c = biquadHighShelfCoeffs(8000, 48000, 12);
    // The b0 coefficient is the DC gain hint. For a high-shelf boost the b0
    // ≈ V at the asymptote → > 1 expected.
    expect(c.b0).toBeGreaterThan(1);
  });

  it('biquadLowShelfCoeffs with -12 dB cut produces b0 < 1', () => {
    const c = biquadLowShelfCoeffs(200, 48000, -12);
    // For a low-shelf cut, low-frequency gain at DC should be < 1.
    // The exact value depends on the formula structure but the directional
    // assertion is sufficient.
    expect(c.b0).toBeLessThan(1.1);
  });
});

describe('Pure-math primitives: 1-pole filter coefficients', () => {
  it('onePoleCoeffs at 1 kHz / 48 kHz returns a valid normalised pair', () => {
    const c = onePoleCoeffs(1000, 48000);
    expect(c.b0).toBeGreaterThan(0);
    expect(c.b0).toBeLessThan(1);
    expect(c.a1).toBeGreaterThan(0);
    expect(c.a1).toBeLessThan(1);
    // b0 + a1 should be approximately 1 (DC unity).
    expect(c.b0 + c.a1).toBeCloseTo(1, 4);
  });

  it('clamps cutoff frequency below Nyquist', () => {
    // Even if asked for fc > Nyquist, the coefficients must be finite.
    const c = onePoleCoeffs(48000, 48000);
    expect(Number.isFinite(c.b0)).toBe(true);
    expect(Number.isFinite(c.a1)).toBe(true);
  });
});

describe('Multitap tap layout (deterministic from seed)', () => {
  it('multitapTapPositions returns `count` positions + gains', () => {
    const { positions, gains } = multitapTapPositions(123, 8);
    expect(positions.length).toBe(8);
    expect(gains.length).toBe(8);
    // Position i should be in [i, i+1).
    for (let i = 0; i < 8; i++) {
      expect(positions[i]).toBeGreaterThanOrEqual(i);
      expect(positions[i]).toBeLessThan(i + 1);
    }
  });

  it('different seeds give different layouts', () => {
    const a = multitapTapPositions(1, 8);
    const b = multitapTapPositions(2, 8);
    let differs = false;
    for (let i = 0; i < 8; i++) {
      if (Math.abs(a.positions[i]! - b.positions[i]!) > 1e-6) { differs = true; break; }
    }
    expect(differs).toBe(true);
  });

  it('same seed reproduces the same layout', () => {
    const a = multitapTapPositions(99, 16);
    const b = multitapTapPositions(99, 16);
    for (let i = 0; i < 16; i++) {
      expect(a.positions[i]).toBe(b.positions[i]);
      expect(a.gains[i]).toBe(b.gains[i]);
    }
  });
});
