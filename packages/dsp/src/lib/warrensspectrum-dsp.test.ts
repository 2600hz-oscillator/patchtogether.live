// packages/dsp/src/lib/warrensspectrum-dsp.test.ts
//
// Unit gates for the WARREN'S SPECTRUM spectral-resynth engine.
//
// Two of these are load-bearing beyond ordinary regression cover:
//
//   * `SLICE — the CORRECTED range` is the MANDATORY, PERMANENT negative
//     control for the one deliberate divergence from the VST. It sweeps
//     SLICE across its FULL declared 2..200 ms and proves the output
//     actually moves — INCLUDING above 21.33 ms, which is exactly where the
//     VST's `setSliceMs` clamp silently stops responding. A test confined to
//     2..21 ms would pass against the broken behaviour and prove nothing.
//
//   * `RESIDUAL — the SMS stochastic half` is the phase-1 acceptance
//     criterion: the one identifiable respect in which this IS the VST.
//     Sibilant energy is present at RESIDUAL 2 and gone at RESIDUAL 0.
//
// Every metric here is negative-controlled in BOTH directions — a
// difference metric that cannot return ~0 is measuring noise, and one that
// cannot return large is measuring nothing.

import { describe, expect, it } from 'vitest';
import {
  WarrensSpectrumEngine,
  WS_FFT_SIZE,
  WS_MAX_TRACKS,
  WS_SLICE_MAX_MS,
  WS_SLICE_MIN_MS,
  wsPeakSalience,
  wsVoiceWaveform,
} from './warrensspectrum-dsp';

const SR = 48000;

// ---------------------------------------------------------------------------
// Test signal generators + measurement helpers
// ---------------------------------------------------------------------------

/** A tone whose frequency STEPS every `stepMs` — the analysis RATE is what
 *  decides how faithfully the bank follows it, so it is the right probe for
 *  SLICE. A steady tone would be nearly SLICE-invariant by construction. */
function steppedTone(durationS: number, stepMs: number, hzA: number, hzB: number): Float32Array {
  const n = Math.round(durationS * SR);
  const buf = new Float32Array(n);
  const stepSamples = Math.round((stepMs * 0.001 * SR));
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const hz = Math.floor(i / stepSamples) % 2 === 0 ? hzA : hzB;
    phase += hz / SR;
    if (phase >= 1) phase -= 1;
    buf[i] = 0.5 * Math.sin(2 * Math.PI * phase);
  }
  return buf;
}

/** Deterministic white noise (xorshift32) so every render is reproducible. */
function seededNoise(n: number, seed = 0x1234abcd): Float32Array {
  const buf = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    buf[i] = (s / 4294967295) * 2 - 1;
  }
  return buf;
}

/** One RBJ biquad. Cascaded ×2 below for a 24 dB/oct measurement filter. */
function biquad(x: Float32Array, b0: number, b1: number, b2: number, a1: number, a2: number): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i]!;
    const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    y[i] = yi;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi;
  }
  return y;
}

function highpassCoefs(fc: number, q: number) {
  const w = (2 * Math.PI * fc) / SR;
  const alpha = Math.sin(w) / (2 * q);
  const cosw = Math.cos(w);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cosw) / 2) / a0,
    b1: (-(1 + cosw)) / a0,
    b2: ((1 + cosw) / 2) / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** RMS of `x` above `fc`, through a 4-pole Butterworth high-pass. */
function highBandRms(x: Float32Array, fc: number): number {
  const c1 = highpassCoefs(fc, 0.5412);
  const c2 = highpassCoefs(fc, 1.3066);
  const y = biquad(biquad(x, c1.b0, c1.b1, c1.b2, c1.a1, c1.a2), c2.b0, c2.b1, c2.b2, c2.a1, c2.a2);
  return rms(y);
}

function rms(x: Float32Array, from = 0): number {
  let s = 0;
  for (let i = from; i < x.length; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, x.length - from));
}

/** Normalised difference between two renders: 0 = identical, ~1.4 = unrelated
 *  signals of equal power. The SLICE sweep's metric. */
function relDiff(a: Float32Array, b: Float32Array): number {
  const denom = Math.max(rms(a), rms(b), 1e-12);
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    s += d * d;
  }
  return Math.sqrt(s / a.length) / denom;
}

interface EngineOpts {
  partials?: number;
  floorDb?: number;
  stability?: number;
  lock?: number;
  residual?: number;
  shape?: number;
  slewSec?: number;
  sliceMs?: number;
  centerCents?: number;
}

function makeEngine(o: EngineOpts = {}): WarrensSpectrumEngine {
  const e = new WarrensSpectrumEngine(SR);
  e.setPartials(o.partials ?? 64);
  e.setFloorDb(o.floorDb ?? -42);
  e.setStabilityFrames(o.stability ?? 3);
  e.setLock(o.lock ?? 0.75);
  e.setResidual(o.residual ?? 0.5);
  e.setShape(o.shape ?? 0);
  e.setSlewSeconds(o.slewSec ?? 0.6);
  e.setSliceMs(o.sliceMs ?? 10);
  e.setCenterCents(o.centerCents ?? 0);
  return e;
}

function render(input: Float32Array, o: EngineOpts = {}): Float32Array {
  return makeEngine(o).processBlock(input);
}

// ---------------------------------------------------------------------------

describe('warrensspectrum engine — basics', () => {
  it('resynthesises a steady tone as a tracked partial near its own frequency', () => {
    const n = Math.round(1.0 * SR);
    const input = new Float32Array(n);
    for (let i = 0; i < n; i++) input[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
    const e = makeEngine({ residual: 0, slewSec: 0.05 });
    const out = e.processBlock(input);
    // Audible.
    expect(rms(out, Math.round(0.3 * SR))).toBeGreaterThan(0.01);
    // And the tracker is holding ~440 Hz.
    const tracks = e.snapshotTracks();
    expect(tracks.length).toBeGreaterThan(0);
    const nearest = tracks.reduce((best, t) =>
      Math.abs(t.freqHz - 440) < Math.abs(best.freqHz - 440) ? t : best,
    );
    expect(
      Math.abs(nearest.freqHz - 440),
      `nearest tracked partial ${nearest.freqHz.toFixed(1)} Hz (want ~440 Hz); tracks=${tracks.length}`,
    ).toBeLessThan(15);
  });

  it('is BYTE-REPRODUCIBLE — the precondition for an ART golden', () => {
    // Includes the residual, whose xorshift32 is seeded to a constant on
    // purpose. If this ever goes red the ART baseline is unpinnable.
    const input = steppedTone(0.5, 40, 300, 900);
    const a = render(input, { residual: 1.5 });
    const b = render(input, { residual: 1.5 });
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        throw new Error(`non-deterministic at sample ${i}: ${a[i]} !== ${b[i]}`);
      }
    }
    expect(relDiff(a, b)).toBe(0);
  });

  it('produces bounded, finite output on noise', () => {
    const out = render(seededNoise(Math.round(0.5 * SR)), { residual: 2, partials: 128 });
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i]!), `sample ${i} = ${out[i]}`).toBe(true);
      expect(Math.abs(out[i]!)).toBeLessThan(50);
    }
  });
});

// ---------------------------------------------------------------------------
// THE SLICE NEGATIVE CONTROL — mandatory + permanent.
// ---------------------------------------------------------------------------

describe('warrensspectrum SLICE — the CORRECTED range (VST divergence gate)', () => {
  // The VST's own clamp, for reference. `setSliceMs` (SpectralResynth.cpp:
  // 362-373) clamps the hop to fftSize*0.5 = 1024 samples with fftOrder
  // hardcoded to 11, so its reachable ceiling is 1024/48000 = 21.33 ms.
  const VST_CEILING_MS = (WS_FFT_SIZE * 0.5 * 1000) / SR; // 21.333…

  it('the reference VST clamp really does saturate at 21.33 ms (instrument check)', () => {
    // Negative-control the CONTROL: if this helper did not saturate, the
    // "we exceed the VST" assertions below would be vacuous.
    expect(WarrensSpectrumEngine.vstClampedSliceMs(2, SR)).toBeCloseTo(2, 3);
    expect(WarrensSpectrumEngine.vstClampedSliceMs(20, SR)).toBeCloseTo(20, 3);
    expect(WarrensSpectrumEngine.vstClampedSliceMs(40, SR)).toBeCloseTo(VST_CEILING_MS, 3);
    expect(WarrensSpectrumEngine.vstClampedSliceMs(200, SR)).toBeCloseTo(VST_CEILING_MS, 3);
  });

  it('the FULL declared 2..200 ms range is realised EXACTLY — no dead zone, no steps', () => {
    // ⚠ THE SWEEP DELIBERATELY INCLUDES AWKWARD VALUES (12, 15, 33, 77).
    // An earlier draft expressed long slices as a COMMIT DECIMATION over a
    // fixed N/4 hop, which quantises the realised period to multiples of
    // 10.67 ms — 12 and 15 both collapse onto 10.67. A sweep of round
    // numbers (2/5/10/21/40/80/140/200) happens to land on distinct
    // multiples and passes against that defect, which is exactly how a
    // stepped control hides. These four values are here to make it visible.
    const sweep = [2, 5, 10, 12, 15, 21, 33, 40, 77, 80, 140, 200];
    const realised = sweep.map((ms) => {
      const e = makeEngine({ sliceMs: ms });
      return { ms, eff: e.effectiveSliceMs, hop: e.analysisHop };
    });
    const table = realised.map((r) => `${r.ms}→${r.eff.toFixed(3)}ms (hop ${r.hop})`).join(', ');
    for (const r of realised) {
      // Exact to within the one-sample rounding the hop is quantised by.
      expect(
        Math.abs(r.eff - r.ms),
        `SLICE ${r.ms} ms must be REALISED as ${r.ms} ms, not snapped to a hop ` +
          `multiple (units: ms). Realised: ${table}`,
      ).toBeLessThan(1000 / SR + 1e-9);
    }
    for (let i = 1; i < realised.length; i++) {
      expect(
        realised[i]!.eff,
        `effective slice must STRICTLY increase with SLICE — units are ms. ${table}`,
      ).toBeGreaterThan(realised[i - 1]!.eff);
    }
    expect(realised[0]!.eff).toBeCloseTo(WS_SLICE_MIN_MS, 3);
    expect(realised[realised.length - 1]!.eff).toBeCloseTo(WS_SLICE_MAX_MS, 3);
    // The ANALYSIS WINDOW is a separate constant and never moves: a long
    // SLICE takes a 2048-sample SNAPSHOT less often, it does not widen the
    // window (which is what growing the FFT would have done, and what would
    // have destroyed the transient resolution SLICE exists to control).
    expect(WS_FFT_SIZE).toBe(2048);
  });

  it('the DEFAULT (10 ms) is under the VST clamp and therefore bit-identical to it', () => {
    // 10 ms = 480 samples < the VST's 1024-sample ceiling, so the shipped
    // default is UNCLAMPED upstream. Removing the ceiling must not perturb
    // it — this is what lets the ART goldens (all rendered at the default)
    // stay comparable to the plugin.
    const e = makeEngine({ sliceMs: 10 });
    expect(e.analysisHop).toBe(480);
    expect(e.effectiveSliceMs).toBeCloseTo(10, 9);
    expect(WarrensSpectrumEngine.vstClampedSliceMs(10, SR)).toBeCloseTo(10, 9);
  });

  it('ABOVE the VST ceiling, SLICE still moves the analysis rate (the VST is flat here)', () => {
    for (const ms of [40, 80, 140, 200]) {
      const eff = makeEngine({ sliceMs: ms }).effectiveSliceMs;
      const vst = WarrensSpectrumEngine.vstClampedSliceMs(ms, SR);
      expect(
        eff,
        `SLICE ${ms}ms: ours=${eff.toFixed(2)}ms vs the VST's clamped ${vst.toFixed(2)}ms — ` +
          'if these are equal the clamp was ported and the range is dead again (units: ms)',
      ).toBeGreaterThan(vst * 1.5);
    }
  });

  it('THE OUTPUT ACTUALLY CHANGES across the whole sweep — including above 21.33 ms', () => {
    // A steady tone would be almost SLICE-invariant; a STEPPING tone makes
    // the analysis rate audible, which is the property under test.
    const input = steppedTone(1.2, 45, 300, 900);
    const sweep = [2, 5, 10, 21, 40, 80, 140, 200];
    const renders = sweep.map((ms) => render(input, { sliceMs: ms, residual: 0, slewSec: 0.05 }));

    // (a) INSTRUMENT NEGATIVE CONTROL, permanently in the test: the SAME
    //     slice twice must be exactly 0. If the metric cannot return 0 it
    //     is measuring noise and every number below it is meaningless.
    expect(relDiff(renders[3]!, render(input, { sliceMs: 21, residual: 0, slewSec: 0.05 }))).toBe(0);

    // (b) every adjacent pair differs.
    const MIN = 0.02;
    for (let i = 1; i < sweep.length; i++) {
      const d = relDiff(renders[i - 1]!, renders[i]!);
      expect(
        d,
        `SLICE ${sweep[i - 1]}ms vs ${sweep[i]}ms: relative RMS difference ${d.toFixed(4)} ` +
          `(dimensionless, 0 = identical) must exceed ${MIN}`,
      ).toBeGreaterThan(MIN);
    }

    // (c) THE LEG THAT MATTERS. Every pair drawn from ABOVE the VST's
    //     21.33 ms ceiling must differ. Under the VST's clamp all four of
    //     these render identically, so a test that omitted this block would
    //     pass against the broken behaviour.
    const aboveCeiling = sweep
      .map((ms, i) => ({ ms, buf: renders[i]! }))
      .filter((r) => r.ms > VST_CEILING_MS);
    expect(aboveCeiling.length).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < aboveCeiling.length; i++) {
      for (let j = i + 1; j < aboveCeiling.length; j++) {
        const d = relDiff(aboveCeiling[i]!.buf, aboveCeiling[j]!.buf);
        expect(
          d,
          `SLICE ${aboveCeiling[i]!.ms}ms vs ${aboveCeiling[j]!.ms}ms — BOTH above the VST's ` +
            `${VST_CEILING_MS.toFixed(2)}ms clamp, where the plugin is flat. relDiff=${d.toFixed(4)}`,
        ).toBeGreaterThan(MIN);
      }
    }
  });

  it('committed analysis frames fall as SLICE rises', () => {
    const input = steppedTone(1.0, 45, 300, 900);
    let prev = Infinity;
    for (const ms of [2, 5, 10, 21, 40, 80, 140, 200]) {
      const e = makeEngine({ sliceMs: ms, residual: 0 });
      e.processBlock(input);
      expect(
        e.frameCount,
        `SLICE ${ms}ms committed ${e.frameCount} frames in 1.0 s (unit: frames); ` +
          `previous slice committed ${prev}`,
      ).toBeLessThan(prev);
      prev = e.frameCount;
    }
    expect(prev).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// HOST-SYNCED COMMIT BOUNDARIES — the per-block, timeline-derived semantic.
// ---------------------------------------------------------------------------

describe('warrensspectrum SYNC — the boundary is RE-DERIVED per block, not configured once', () => {
  /** 1/16 at 120 BPM, 48 kHz = (60/120)·48000·(4/16) = 6000 samples. */
  const GRID = 6000;
  const BLOCK_SIZES = [128, 512, 1024, 2048, 4096] as const;

  /**
   * Drive `totalS` seconds in blocks of `block` samples, calling
   * `setSyncedHop` at the top of EVERY block with a freshly-derived
   * `samplesUntilNext` — exactly what PluginProcessor.cpp:175 does — and
   * return the ABSOLUTE sample index of every committed analysis frame.
   *
   * `hopOverride` exists so the same harness can simulate the VST's CLAMPED
   * period, which is the negative control: it proves the harness can SEE an
   * off-grid fire, so a green on-grid result is not the harness agreeing
   * with itself.
   */
  function fireIndices(block: number, totalS: number, hopOverride?: number): number[] {
    const total = Math.round(totalS * SR);
    const e = makeEngine({ residual: 0, partials: 8 });
    const input = steppedTone(totalS, 45, 300, 900);
    const fires: number[] = [];
    let t = 0;
    let seen = 0;
    while (t < total) {
      const n = Math.min(block, total - t);
      const untilNext = (GRID - (t % GRID)) % GRID;
      e.setSyncedHop(hopOverride ?? GRID, untilNext);
      for (let i = 0; i < n; i++) {
        e.processSample(input[t + i]!);
        if (e.frameCount > seen) {
          seen = e.frameCount;
          fires.push(t + i);
        }
      }
      t += n;
    }
    return fires;
  }

  it.each(BLOCK_SIZES)(
    'block %i: EVERY commit lands exactly on the grid (the VST drifts at >= 2048)',
    (block) => {
      const fires = fireIndices(block, 4);
      const offGrid = fires.filter((f) => f % GRID !== 0);
      expect(
        offGrid.length,
        `block=${block} samples, grid=${GRID} samples (1/16 @ 120 BPM). ` +
          `${fires.length} commits, ${offGrid.length} off-grid: ${offGrid.slice(0, 6).join(', ')}. ` +
          'The VST clamps its synced period to fftSize-1 = 2047, so at this block ' +
          'size only the re-primed first fire per block is on-grid and the rest ' +
          'free-run; removing the ceiling is what fixes it.',
      ).toBe(0);
      // …and it really did fire: 4 s at a 6000-sample grid = 32 boundaries.
      expect(fires.length).toBe(Math.floor((4 * SR) / GRID));
    },
  );

  it('NEGATIVE CONTROL: the VST\'s clamped period DOES go off-grid at block 4096', () => {
    // If this stayed green the harness could not distinguish on- from
    // off-grid and every assertion above would be decoration.
    const fires = fireIndices(4096, 4, WS_FFT_SIZE - 1);
    const offGrid = fires.filter((f) => f % GRID !== 0);
    expect(
      offGrid.length,
      `simulating the VST's clamp (period ${WS_FFT_SIZE - 1} instead of ${GRID}): ` +
        `${fires.length} commits, ${offGrid.length} off-grid. If this is 0 the ` +
        'harness cannot see the failure it exists to detect.',
    ).toBeGreaterThan(0);
  });

  it('NEGATIVE CONTROL: configuring the period ONCE (no re-priming) drifts', () => {
    // The failure mode the correction warns about, made visible: prime at
    // block 0 only and let the counter free-run. It stays on-grid here ONLY
    // because the period happens to be exact — so the assertion is on the
    // MECHANISM: a one-shot setup with a period that is off by a single
    // sample accumulates error, while per-block re-priming absorbs it.
    const total = 4 * SR;
    const drift = (perBlock: boolean): number[] => {
      const e = makeEngine({ residual: 0, partials: 8 });
      const input = steppedTone(4, 45, 300, 900);
      const fires: number[] = [];
      let seen = 0;
      const block = 512;
      for (let t = 0; t < total; t += block) {
        if (perBlock || t === 0) {
          e.setSyncedHop(GRID + 1, (GRID - (t % GRID)) % GRID); // a 1-sample-wrong period
        }
        for (let i = 0; i < Math.min(block, total - t); i++) {
          e.processSample(input[t + i]!);
          if (e.frameCount > seen) {
            seen = e.frameCount;
            fires.push(t + i);
          }
        }
      }
      return fires;
    };
    const reprimed = drift(true).filter((f) => f % GRID !== 0).length;
    const onceOnly = drift(false).filter((f) => f % GRID !== 0).length;
    expect(
      onceOnly,
      'configured once, a 1-sample period error walks the analyser off the grid',
    ).toBeGreaterThan(0);
    expect(
      reprimed,
      `re-primed every block, the SAME wrong period stays on-grid ` +
        `(re-primed off-grid=${reprimed}, configured-once off-grid=${onceOnly}) — ` +
        'this is why setSyncedHop must be called per render quantum',
    ).toBe(0);
  });

  it('setSliceMs takes the boundary back off the grid (FREE mode wins)', () => {
    const e = makeEngine();
    e.setSyncedHop(GRID, 0);
    expect(e.isSynced).toBe(true);
    expect(e.analysisHop).toBe(GRID);
    e.setSliceMs(10);
    expect(e.isSynced).toBe(false);
    expect(e.analysisHop).toBe(480);
  });
});

// ---------------------------------------------------------------------------
// THE PHASE-1 ACCEPTANCE CRITERION — the SMS residual.
// ---------------------------------------------------------------------------

describe("warrensspectrum RESIDUAL — the SMS stochastic half (phase-1 VST criterion)", () => {
  /**
   * A 10-harmonic 220 Hz tone (everything under 2.2 kHz) PLUS a >5 kHz band
   * of noise — the "sibilant". With PARTIALS=8 the sinusoidal tracker spends
   * its whole budget on the harmonics (salience gives a k·F0 peak up to a 4×
   * bonus, so a noise bin never outranks one), and the sibilant is exactly
   * the energy it discards. That separation is what makes the measurement
   * unambiguous: HF in the output can ONLY have come from the residual.
   */
  function voiceWithSibilant(durationS: number): Float32Array {
    const n = Math.round(durationS * SR);
    const noise = seededNoise(n, 0x5eed1234);
    const c = highpassCoefs(5000, 0.7071);
    let banded = noise;
    for (let pass = 0; pass < 3; pass++) banded = biquad(banded, c.b0, c.b1, c.b2, c.a1, c.a2);
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let tone = 0;
      for (let k = 1; k <= 10; k++) tone += (1 / k) * Math.sin((2 * Math.PI * 220 * k * i) / SR);
      buf[i] = 0.35 * tone + 0.5 * banded[i]!;
    }
    return buf;
  }

  const OPTS = { partials: 8, slewSec: 0.05, sliceMs: 10, lock: 0.75 } as const;

  it('sibilant energy is PRESENT at RESIDUAL 2 and GONE at RESIDUAL 0', () => {
    const input = voiceWithSibilant(1.5);
    const dry = render(input, { ...OPTS, residual: 0 });
    const wet = render(input, { ...OPTS, residual: 2 });

    const skip = Math.round(0.5 * SR); // let the bank + band envelopes settle
    const hiDry = highBandRms(dry.subarray(skip) as Float32Array, 4000);
    const hiWet = highBandRms(wet.subarray(skip) as Float32Array, 4000);

    // The tone survives either way — this is not a "did anything come out"
    // test, it is specifically about the HIGH band.
    expect(rms(dry, skip), 'the tracked tone must still be audible at RESIDUAL 0').toBeGreaterThan(0.05);
    expect(rms(wet, skip)).toBeGreaterThan(0.05);
    expect(
      hiWet / Math.max(hiDry, 1e-9),
      `>4 kHz RMS (linear amplitude): RESIDUAL 2 = ${hiWet.toExponential(3)}, ` +
        `RESIDUAL 0 = ${hiDry.toExponential(3)}. The plugin's own header calls RESIDUAL ` +
        `"the #1 fix for the vocoder/robot vibe" — if this ratio collapses toward 1 the SMS ` +
        'residual is not running and phase 1 has no claim to be the VST.',
    ).toBeGreaterThan(10);
  });

  it('RESIDUAL scales monotonically, and is CUBE-ROOT-scaled by PARTIALS', () => {
    const input = voiceWithSibilant(1.0);
    const skip = Math.round(0.5 * SR);
    const hiAt = (residual: number, partials: number) =>
      highBandRms(
        render(input, { ...OPTS, residual, partials }).subarray(skip) as Float32Array,
        4000,
      );
    const r05 = hiAt(0.5, 8);
    const r10 = hiAt(1.0, 8);
    const r20 = hiAt(2.0, 8);
    expect(r10).toBeGreaterThan(r05);
    expect(r20).toBeGreaterThan(r10);
    // cbrt((n-1)/47): at PARTIALS=1 the scale is exactly 0 — "clean F0 tone,
    // no broadband mush" (SpectralResynth.cpp:898-907).
    expect(
      hiAt(2.0, 1),
      'PARTIALS=1 must zero the residual entirely (cbrt(0) = 0)',
    ).toBeLessThan(r20 * 0.2);
  });
});

// ---------------------------------------------------------------------------
// The remaining spectral controls — each with its own negative control.
// ---------------------------------------------------------------------------

describe('warrensspectrum FREEZE', () => {
  it('holds the spectrum: the frozen tail ignores a changed input', () => {
    const n = Math.round(1.4 * SR);
    const input = new Float32Array(n);
    const half = Math.round(0.7 * SR);
    for (let i = 0; i < n; i++) {
      const hz = i < half ? 440 : 1500;
      input[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / SR);
    }
    const thawed = makeEngine({ residual: 0, slewSec: 0.05 });
    const frozen = makeEngine({ residual: 0, slewSec: 0.05 });
    const outThawed = new Float32Array(n);
    const outFrozen = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      outThawed[i] = thawed.processSample(input[i]!);
      if (i === half) frozen.setFrozen(true);
      outFrozen[i] = frozen.processSample(input[i]!);
    }
    // The frozen bank keeps the 440 Hz partial; the thawed one moves to 1500.
    const fTracks = frozen.snapshotTracks();
    const tTracks = thawed.snapshotTracks();
    expect(fTracks.length).toBeGreaterThan(0);
    expect(tTracks.length).toBeGreaterThan(0);
    const nearest = (ts: typeof fTracks, hz: number) =>
      ts.reduce((b, t) => (Math.abs(t.freqHz - hz) < Math.abs(b.freqHz - hz) ? t : b)).freqHz;
    expect(Math.abs(nearest(fTracks, 440) - 440), 'frozen bank must still hold 440 Hz').toBeLessThan(20);
    expect(Math.abs(nearest(tTracks, 1500) - 1500), 'thawed bank must have moved to 1500 Hz').toBeLessThan(40);
    // NEGATIVE CONTROL: without the freeze the two are the same engine, so
    // the divergence above must be caused by FREEZE and nothing else.
    expect(relDiff(outThawed.subarray(0, half) as Float32Array, outFrozen.subarray(0, half) as Float32Array)).toBe(0);
    expect(relDiff(outThawed.subarray(half) as Float32Array, outFrozen.subarray(half) as Float32Array)).toBeGreaterThan(0.1);
  });

  it('FREEZE commits no analysis frames while engaged', () => {
    const input = steppedTone(0.6, 40, 300, 900);
    const e = makeEngine({ sliceMs: 10 });
    e.processBlock(input.subarray(0, Math.round(0.3 * SR)) as Float32Array);
    const before = e.frameCount;
    e.setFrozen(true);
    e.processBlock(input.subarray(Math.round(0.3 * SR)) as Float32Array);
    expect(e.frameCount, 'frames committed while frozen (unit: frames)').toBe(before);
  });
});

describe('warrensspectrum PARTIALS / STABILITY / FLOOR / LOCK / SHAPE / CENTER', () => {
  const harmonicInput = (() => {
    const n = Math.round(1.0 * SR);
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = 1; k <= 12; k++) s += (1 / k) * Math.sin((2 * Math.PI * 220 * k * i) / SR);
      buf[i] = 0.25 * s;
    }
    return buf;
  })();

  it('PARTIALS bounds the live track count and is monotone', () => {
    let prev = 0;
    for (const p of [1, 4, 12, 32]) {
      const e = makeEngine({ partials: p, residual: 0 });
      e.processBlock(harmonicInput);
      const live = e.liveTrackCount;
      expect(live, `PARTIALS=${p} produced ${live} live tracks`).toBeLessThanOrEqual(p);
      expect(live).toBeGreaterThanOrEqual(prev);
      prev = live;
    }
    expect(prev).toBeGreaterThan(1);
    expect(WS_MAX_TRACKS).toBe(256);
  });

  it('FLOOR (stricter) admits fewer peaks', () => {
    const noisy = new Float32Array(harmonicInput.length);
    const nz = seededNoise(noisy.length, 0xabcd0001);
    for (let i = 0; i < noisy.length; i++) noisy[i] = harmonicInput[i]! + 0.02 * nz[i]!;
    const permissive = makeEngine({ floorDb: -90, partials: 256, residual: 0 });
    const strict = makeEngine({ floorDb: -20, partials: 256, residual: 0 });
    permissive.processBlock(noisy);
    strict.processBlock(noisy);
    expect(
      strict.liveTrackCount,
      `FLOOR -20 dB kept ${strict.liveTrackCount} tracks, FLOOR -90 dB kept ${permissive.liveTrackCount}`,
    ).toBeLessThan(permissive.liveTrackCount);
  });

  it('LOCK snaps tracked partials onto the harmonic comb of the detected F0', () => {
    // A slightly STRETCHED harmonic series: partials sit ~2.5 % sharp of
    // k·F0, inside LOCK's 6 % relative window, so LOCK has something to do.
    const n = Math.round(1.0 * SR);
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = 1; k <= 8; k++) {
        const hz = 220 * k * (k === 1 ? 1 : 1.025);
        s += (1 / k) * Math.sin((2 * Math.PI * hz * i) / SR);
      }
      buf[i] = 0.25 * s;
    }
    const err = (lock: number) => {
      const e = makeEngine({ lock, partials: 16, residual: 0, slewSec: 0.05 });
      e.processBlock(buf);
      const f0 = e.detectedF0Hz;
      expect(f0, 'F0 detector must lock onto ~220 Hz for this probe').toBeGreaterThan(200);
      let worst = 0;
      for (const t of e.snapshotTracks()) {
        if (t.freqHz < f0 * 1.5) continue; // the fundamental itself is exact
        const k = Math.round(t.freqHz / f0);
        if (k < 2) continue;
        worst = Math.max(worst, Math.abs(1200 * Math.log2(t.freqHz / (k * f0))));
      }
      return worst;
    };
    const off = err(0);
    const on = err(1);
    expect(
      on,
      `worst harmonic deviation in CENTS: LOCK 1 = ${on.toFixed(1)}, LOCK 0 = ${off.toFixed(1)}`,
    ).toBeLessThan(off);
    expect(on).toBeLessThan(20);
  });

  it('SHAPE morphs the voice sine → saw → square (pure-function check)', () => {
    const dt = 1 / 200;
    const sineAt = (p: number) => Math.sin(2 * Math.PI * p);
    for (const p of [0.1, 0.3, 0.62, 0.88]) {
      expect(wsVoiceWaveform(p, dt, 0)).toBeCloseTo(sineAt(p), 6);
    }
    // At full SHAPE the waveform is a square: |value| ~ 1 away from the edges.
    expect(Math.abs(wsVoiceWaveform(0.25, dt, 1))).toBeCloseTo(1, 3);
    expect(Math.abs(wsVoiceWaveform(0.75, dt, 1))).toBeCloseTo(1, 3);
    // …and half-way it is a saw: monotone rising across the cycle body.
    const saw = [0.2, 0.4, 0.6].map((p) => wsVoiceWaveform(p, dt, 0.5));
    expect(saw[1]!).toBeGreaterThan(saw[0]!);
    expect(saw[2]!).toBeGreaterThan(saw[1]!);
    // NEGATIVE CONTROL: SHAPE genuinely changes the rendered output.
    const input = harmonicInput;
    expect(relDiff(render(input, { shape: 0, residual: 0 }), render(input, { shape: 1, residual: 0 })))
      .toBeGreaterThan(0.1);
  });

  it('CENTER transposes the bank by cents, post-analysis', () => {
    const e = makeEngine({ centerCents: 1200, residual: 0, slewSec: 0.05 });
    const n = Math.round(1.0 * SR);
    const input = new Float32Array(n);
    for (let i = 0; i < n; i++) input[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
    e.processBlock(input);
    // The ANALYSIS is untouched — the tracker still reports ~440 Hz…
    const tracks = e.snapshotTracks();
    const nearest = tracks.reduce((b, t) => (Math.abs(t.freqHz - 440) < Math.abs(b.freqHz - 440) ? t : b));
    expect(Math.abs(nearest.freqHz - 440)).toBeLessThan(15);
    // …and the RENDER is an octave up, which we prove by zero-crossing rate.
    const out = e.processBlock(input);
    const zc = (x: Float32Array) => {
      let c = 0;
      for (let i = 1; i < x.length; i++) if ((x[i - 1]! < 0) !== (x[i]! < 0)) c++;
      return c;
    };
    const flat = makeEngine({ centerCents: 0, residual: 0, slewSec: 0.05 });
    flat.processBlock(input);
    const outFlat = flat.processBlock(input);
    expect(
      zc(out) / Math.max(1, zc(outFlat)),
      `zero-crossings/second ratio for +1200 cents (want ~2×): ${zc(out)} vs ${zc(outFlat)}`,
    ).toBeGreaterThan(1.7);
  });

  it('STABILITY gates young tracks — higher STABILITY = quieter onsets', () => {
    // A rapidly-stepping tone is nothing but births; STABILITY's ramp-in is
    // exactly what should attenuate it.
    const input = steppedTone(1.0, 12, 300, 1700);
    const loud = rms(render(input, { stability: 1, residual: 0, slewSec: 0.02 }));
    const gated = rms(render(input, { stability: 16, residual: 0, slewSec: 0.02 }));
    expect(
      gated,
      `output RMS (linear): STABILITY 16 = ${gated.toExponential(3)}, STABILITY 1 = ${loud.toExponential(3)}`,
    ).toBeLessThan(loud);
  });
});

describe('warrensspectrum salience ranking (SpectralResynth.cpp:110-137)', () => {
  it('rewards a peak sitting within 25 cents of k·F0, and only then', () => {
    // On the comb: bonus applies.
    const onComb = wsPeakSalience(440, 0.1, 220, 2.0, 1.0);
    // 60 cents sharp: outside the 25-cent window, no bonus.
    const offComb = wsPeakSalience(440 * Math.pow(2, 60 / 1200), 0.1, 220, 2.0, 1.0);
    expect(onComb).toBeGreaterThan(offComb);
    expect(offComb).toBeCloseTo(0.1, 6);
    // LOCK 0 disables the bonus entirely — the negative control on the knob.
    expect(wsPeakSalience(440, 0.1, 220, 2.0, 0)).toBeCloseTo(0.1, 6);
    // Low confidence disables it too (unpitched material self-disengages).
    expect(wsPeakSalience(440, 0.1, 220, 0.9, 1.0)).toBeCloseTo(0.1, 6);
    // 1/sqrt(k) decay: the fundamental outranks the 4th harmonic.
    expect(wsPeakSalience(220, 0.1, 220, 2.0, 1.0)).toBeGreaterThan(
      wsPeakSalience(880, 0.1, 220, 2.0, 1.0),
    );
  });
});
