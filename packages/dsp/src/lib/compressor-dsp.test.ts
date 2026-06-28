// packages/dsp/src/lib/compressor-dsp.test.ts
//
// Pure-DSP unit tests for the SIDECAR ducker core (GMR-2012 log-domain
// compressor: HPF detector → soft-knee gain computer → asymmetric att/rel
// smoother → linear duck). Extracted but untested. These pin the dynamics
// math a stub ART baseline never could:
//   • gain computer: no reduction below threshold, correct slope above, and
//     C0-continuity across the soft knee (quadratic meets the linear segments).
//   • asymmetric smoother: attack reaches its target far faster than release.
//   • HPF detector blocks DC.
//   • env_out is intentionally UN-clamped (can exceed 1 / go negative).
//   • full sidecarStep: silent main → SC passes; loud main → SC is ducked.

import { describe, it, expect } from 'vitest';
import {
  DB_PER_LOG2,
  ENV_SCALE_DB,
  makeHpfState,
  hpfCoef,
  hpfStep,
  computeGainDb,
  smootherCoef,
  smootherStep,
  makeSmootherState,
  makeParamSmoother,
  paramSmootherStep,
  envOut,
  envInvOut,
  makeSidecarState,
  sidecarStep,
  type SidecarParams,
} from './compressor-dsp';

const SR = 48000;
const db2log2 = (db: number) => db / DB_PER_LOG2;

describe('constants', () => {
  it('DB_PER_LOG2 = 20·log10(2); ENV_SCALE_DB = 24', () => {
    expect(DB_PER_LOG2).toBeCloseTo(6.0205999, 6);
    expect(ENV_SCALE_DB).toBe(24);
  });
});

describe('HPF detector', () => {
  it('coefficient stays in (0,1) and clamps fc', () => {
    expect(hpfCoef(20, SR)).toBeGreaterThan(0);
    expect(hpfCoef(20, SR)).toBeLessThan(1);
    expect(hpfCoef(0, SR)).toBeCloseTo(hpfCoef(0.1, SR), 9); // floored
    expect(Number.isFinite(hpfCoef(1e9, SR))).toBe(true); // capped near Nyquist
  });
  it('blocks DC (constant input decays to ~0)', () => {
    const st = makeHpfState();
    const a = hpfCoef(20, SR);
    let y = 0;
    for (let i = 0; i < SR; i++) y = hpfStep(1.0, a, st); // 1 s of DC
    expect(Math.abs(y)).toBeLessThan(1e-3);
  });
});

describe('computeGainDb (soft-knee gain computer)', () => {
  const tDb = -18;
  it('applies NO reduction below threshold', () => {
    expect(computeGainDb(db2log2(-30), tDb, 0, 4)).toBe(0);
    expect(computeGainDb(db2log2(-18), tDb, 0, 4)).toBe(0); // exactly at threshold
  });
  it('applies slope -(1-1/ratio) above threshold (hard knee)', () => {
    // ratio 4 → slope 0.75; 18 dB over → -13.5 dB.
    expect(computeGainDb(db2log2(0), tDb, 0, 4)).toBeCloseTo(-13.5, 6);
    // ratio 2 → slope 0.5; 18 dB over → -9 dB.
    expect(computeGainDb(db2log2(0), tDb, 0, 2)).toBeCloseTo(-9, 6);
  });
  it('ratio 1 = no compression anywhere', () => {
    expect(computeGainDb(db2log2(20), tDb, 12, 1)).toBeCloseTo(0, 10); // (-0 is fine)
  });
  it('is C0-continuous across the soft knee', () => {
    const kn = 12; // half-knee 6 → knee spans [-24, -12] dB
    // lower edge: quadratic → 0 (matches below-threshold region)
    expect(computeGainDb(db2log2(-24), tDb, kn, 4)).toBeCloseTo(0, 6);
    // upper edge: quadratic → full linear value (-0.75·6 = -4.5)
    expect(computeGainDb(db2log2(-12), tDb, kn, 4)).toBeCloseTo(-4.5, 6);
    // just inside the upper edge ≈ the value just outside it (no jump)
    const inside = computeGainDb(db2log2(-12.01), tDb, kn, 4);
    const outside = computeGainDb(db2log2(-11.99), tDb, kn, 4);
    expect(Math.abs(inside - outside)).toBeLessThan(0.02);
  });
  it('soft knee starts reduction earlier than a hard knee (gentler)', () => {
    // at threshold, the soft knee already pulls a little; hard knee pulls 0.
    expect(computeGainDb(db2log2(-18), tDb, 12, 4)).toBeLessThan(0);
    expect(computeGainDb(db2log2(-18), tDb, 0, 4)).toBe(0);
  });
});

describe('asymmetric smoother (attack vs release)', () => {
  it('coefficient in (0,1), faster time → smaller coef', () => {
    expect(smootherCoef(1, SR)).toBeGreaterThan(0);
    expect(smootherCoef(1, SR)).toBeLessThan(1);
    expect(smootherCoef(1, SR)).toBeLessThan(smootherCoef(100, SR));
  });
  it('attack reaches its target far faster than release', () => {
    const aAtt = smootherCoef(1, SR); // 1 ms — fast
    const aRel = smootherCoef(100, SR); // 100 ms — slow
    // ATTACK: 0 → -12 (target below y → uses aAtt)
    const att = makeSmootherState();
    let ya = 0;
    for (let i = 0; i < 480; i++) ya = smootherStep(-12, aAtt, aRel, att); // 10 ms
    expect(ya).toBeLessThan(-11); // nearly all the way to -12
    // RELEASE: -12 → 0 (target above y → uses aRel)
    const rel = makeSmootherState();
    rel.y = -12;
    let yr = -12;
    for (let i = 0; i < 480; i++) yr = smootherStep(0, aAtt, aRel, rel); // 10 ms
    expect(yr).toBeLessThan(-10); // barely moved off -12 (slow release)
    expect(yr).toBeGreaterThan(-12);
  });
});

describe('param smoother', () => {
  it('converges to its target', () => {
    const s = makeParamSmoother(0, SR);
    let v = 0;
    for (let i = 0; i < SR; i++) v = paramSmootherStep(5, s);
    expect(v).toBeCloseTo(5, 2);
  });
});

describe('env_out / env_inv_out (no clamp by design)', () => {
  it('saturates to 1.0 at 24 dB reduction with envMag=1', () => {
    expect(envOut(-ENV_SCALE_DB, 1)).toBeCloseTo(1, 9);
    expect(envInvOut(1)).toBeCloseTo(0, 9);
  });
  it('overshoots past 1 (and inv goes negative) when envMag>1', () => {
    const eo = envOut(-ENV_SCALE_DB, 2); // → 2.0
    expect(eo).toBeCloseTo(2, 9);
    expect(envInvOut(eo)).toBeCloseTo(-1, 9); // un-clamped
  });
  it('is 0 with no reduction', () => {
    expect(envOut(0, 1)).toBeCloseTo(0, 10); // (-0 is fine)
    expect(envInvOut(0)).toBe(1);
  });
});

describe('sidecarStep — full ducker pipeline', () => {
  function params(over: Partial<SidecarParams> = {}): SidecarParams {
    return {
      threshold: -30,
      ratio: 8,
      knee: 0,
      envMag: 1,
      makeup: 0,
      inputLevel: 1,
      aAtt: smootherCoef(1, SR),
      aRel: smootherCoef(50, SR),
      hpfA: hpfCoef(20, SR),
      ...over,
    };
  }

  it('silent main → sidechain passes through at full level', () => {
    const st = makeSidecarState(SR, -30);
    let out = { outL: 0, outR: 0, envOut: 0, envInvOut: 0, gainDb: 0 };
    for (let i = 0; i < 4800; i++) out = sidecarStep(0, 0, 0.5, 0.5, params(), st); // settle
    expect(out.outL).toBeCloseTo(0.5, 2); // 0 (main) + 0.5·1·1·1 (sc)
    expect(out.gainDb).toBeCloseTo(0, 1); // no ducking
  });

  it('loud main ducks the sidechain (SC contribution drops vs silent)', () => {
    // Silent-main reference: SC contribution == output (main = 0).
    const refSt = makeSidecarState(SR, -30);
    let refSc = 0;
    for (let i = 0; i < 9600; i++) {
      const o = sidecarStep(0, 0, 0.5, 0.5, params(), refSt);
      if (i >= 6000) refSc += Math.abs(o.outL); // tail average
    }
    refSc /= 3600;

    // Loud-main: subtract the known main passthrough to isolate the ducked SC.
    const st = makeSidecarState(SR, -30);
    let duckedSc = 0;
    let minGain = 0;
    for (let i = 0; i < 9600; i++) {
      const main = Math.sin((2 * Math.PI * 200 * i) / SR); // loud AC trigger
      const o = sidecarStep(main, main, 0.5, 0.5, params(), st);
      if (i >= 6000) duckedSc += Math.abs(o.outL - main); // out − main = ducked SC
      minGain = Math.min(minGain, o.gainDb);
    }
    duckedSc /= 3600;

    expect(minGain).toBeLessThan(-3); // real gain reduction occurred
    expect(duckedSc).toBeLessThan(0.7 * refSc); // SC clearly pulled down
  });

  it('inputLevel scales the sidechain (silent main)', () => {
    const st = makeSidecarState(SR, -30);
    let out = { outL: 0, outR: 0, envOut: 0, envInvOut: 0, gainDb: 0 };
    for (let i = 0; i < 4800; i++) out = sidecarStep(0, 0, 0.5, 0.5, params({ inputLevel: 2 }), st);
    expect(out.outL).toBeCloseTo(1.0, 1); // 0.5 · inputLevel(2)
  });

  it('never produces NaN/Inf under a hard mixed-signal stress', () => {
    const st = makeSidecarState(SR);
    for (let i = 0; i < 8000; i++) {
      const main = Math.sin((2 * Math.PI * 110 * i) / SR) * (i % 1000 < 500 ? 1 : 0);
      const sc = Math.sin((2 * Math.PI * 55 * i) / SR) * 0.8;
      const o = sidecarStep(main, main * 0.9, sc, sc, params({ ratio: 20, knee: 18 }), st);
      expect(Number.isFinite(o.outL)).toBe(true);
      expect(Number.isFinite(o.outR)).toBe(true);
      expect(Number.isFinite(o.envOut)).toBe(true);
    }
  });
});
