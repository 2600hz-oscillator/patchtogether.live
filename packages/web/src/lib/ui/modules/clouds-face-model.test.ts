// packages/web/src/lib/ui/modules/clouds-face-model.test.ts
//
// THE PERMANENT LEG behind the CLOUDS faceplate.
//
// Two kinds of assertion, and the file is worth reading for the split:
//
//   ORACLE — the claim re-derived from `cloudsMath`, the pure-math mirror of
//     the worklet, on every run. The face says "it is bit-silent for exactly
//     one grain length" and "no part of the SIZE dial is dead"; both are
//     re-measured here rather than remembered, so a DSP change turns a stale
//     sentence RED instead of leaving the faceplate insisting on it. This is
//     the macrooscillator discipline and it is what makes a defect claim
//     shippable — and it WORKED: the second of those claims used to assert the
//     defect (the top 19.5 % of SIZE was bit-identical to its maximum), it said
//     in as many words that a DSP fix must turn it red, and #1456 did.
//
//     ⚠ THE MIRROR IS THE INSTRUMENT HERE, AND IT IS ONLY AS GOOD AS ITS
//     PARITY WITH THE SHIPPING WORKLET. That parity is not assumed: it is
//     asserted sample-for-sample against the real `packages/dsp/src/clouds.ts`
//     processor in art/scenarios/clouds/size-travel.test.ts. Without that leg
//     every oracle in this file certifies a reimplementation.
//
//   NEGATIVE CONTROL — each readout perturbed on the input a knob readback
//     would be BLIND to, in BOTH directions: the input that must move it does,
//     and the inputs that must not, do not. A readout that is merely a knob
//     relabelled cannot pass both halves.
//
// ⚠ WHY THIS MODULE NEEDS IT MORE THAN MOST. clouds is the blind-metric trap in
// its purest form: POSITION moves the output waveform ENTIRELY while moving its
// RMS by 0.17 dB, so an RMS oracle would certify a broken POSITION as working.
// Every oracle below is chosen against that — the fill oracle reads the FIRST
// NON-ZERO SAMPLE (a time, not a level), the clamp oracle asserts BYTE
// IDENTITY, and the coherence oracle compares two levels against each other
// rather than either against a constant.

import { describe, expect, it } from 'vitest';
import {
  CLOUDS_BUFFER_SECONDS,
  CLOUDS_MAX_GRAINS,
  cloudsMath,
  type CloudsParams,
} from '$lib/audio/modules/clouds';
import {
  CLOUDS_COHERENCE_DROP_DB,
  CLOUDS_GRAIN_CEILING_MS,
  cloudsAxisCaption,
  cloudsCoherenceText,
  cloudsFaceParams,
  cloudsFullLevelS,
  cloudsFullLevelText,
  cloudsGrainCount,
  cloudsGrainCountText,
  cloudsGrainMs,
  cloudsGrainText,
  cloudsPoolFull,
  cloudsPoolFullAt,
  cloudsPositionReach,
  cloudsPositionSecondsBack,
  cloudsPositionText,
  cloudsRequestedGrainMs,
  cloudsRingPlan,
  cloudsSilenceMs,
  cloudsSilenceText,
  cloudsSourceGrainMs,
  cloudsSpawnHz,
  type CloudsFaceParams,
} from './clouds-face-model';

const SR = 48000;

/** The def's own defaults, as the readouts see them. */
const DEFAULTS: CloudsFaceParams = {
  position: 0.5,
  size: 0.5,
  pitch: 0,
  density: 0.5,
  texture: 0.5,
  blend: 0.5,
};
const at = (over: Partial<CloudsFaceParams>): CloudsFaceParams => ({ ...DEFAULTS, ...over });
const readerFor =
  (p: CloudsFaceParams) =>
  (id: string): number | undefined =>
    (p as unknown as Record<string, number>)[id];

// ── the ORACLE harness: the real mirror, driven offline ─────────────────────

/** Deterministic broadband noise. A SINE is a pathological granular source —
 *  every grain is coherent, so they beat — and a level read off one measures
 *  the beat pattern rather than the module. */
function noise(n: number, seed = 12345): { L: Float32Array; R: Float32Array } {
  let st = seed | 0;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    st = Math.imul(st, 1103515245) + 12345;
    L[i] = ((((st >>> 16) & 0x7fff) / 0x7fff) * 2 - 1) * 0.5;
    R[i] = L[i]!;
  }
  return { L, R };
}

function render(over: Partial<CloudsParams>, seconds: number, src?: { L: Float32Array; R: Float32Array }) {
  const n = Math.floor(SR * seconds);
  const s = src ?? noise(n);
  const params: CloudsParams = {
    position: 0.5,
    size: 0.5,
    pitch: 0,
    density: 0.5,
    texture: 0.5,
    // ⚠ blend 1, ALWAYS, in every oracle here. At the def default of 0.5 the
    // dry path is half the output, and the dry path is bit-exact — so a silence
    // oracle at blend 0.5 would measure the INPUT, never the grain engine, and
    // would pass on a module whose wet path was entirely dead.
    blend: 1,
    ...over,
  };
  return cloudsMath.render(s.L.subarray(0, n), s.R.subarray(0, n), SR, 0, params);
}

function firstNonZeroSample(b: Float32Array): number {
  for (let i = 0; i < b.length; i++) if (b[i] !== 0) return i;
  return -1;
}
function rmsDb(b: Float32Array, fromS: number, toS: number): number {
  const from = Math.floor(fromS * SR);
  const to = Math.min(b.length, Math.floor(toS * SR));
  let s = 0;
  for (let i = from; i < to; i++) s += b[i]! * b[i]!;
  return 20 * Math.log10(Math.max(1e-12, Math.sqrt(s / (to - from))));
}
function bitIdentical(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// ORACLES — every face claim, re-derived from the DSP mirror on every run
// ═══════════════════════════════════════════════════════════════════════════

describe('clouds face model — ORACLE: the silence at spawn is EXACTLY one grain', () => {
  // ⚠ THE FACE SPEC AUTHORED AGAINST `main` SAID "the first quarter second is
  // bit-zero", which was an artifact of its own 0.25 s measurement grid. The
  // real quantity is a GRAIN LENGTH and it moves across a 13× range, so
  // "0.25 s" is wrong at every size except by luck near the default. This is
  // the assertion that would have caught it, and it is a TIME oracle rather
  // than a level one on purpose (an RMS bucket cannot resolve a 60 ms window).
  it.each([0, 0.25, 0.5, 0.75, 0.9, 1])(
    'size %s: the first non-zero output sample lands at the grain length',
    (size) => {
      const out = render({ size }, 2.0);
      const firstMs = (firstNonZeroSample(out.outL) / SR) * 1000;
      expect(firstMs, `size ${size}: silence must equal the grain length`).toBeCloseTo(
        cloudsGrainMs(size),
        0,
      );
      expect(cloudsSilenceMs(at({ size })), 'the readout prints that same number').toBeCloseTo(
        firstMs,
        0,
      );
    },
  );

  it('POSITION does not move it — the silence is a grain length and nothing else', () => {
    // The DSP's `readPos = (1 − position)·(fillLevel − safeLen)` is negative
    // for EVERY position until `fillLevel` reaches `safeLen`, so this is a
    // structural claim, not a coincidence at the default.
    //
    // ⚠ ONE SAMPLE OF SLOP, AND IT IS A REAL ASYMMETRY RATHER THAN NOISE.
    // `availableHistory = max(safeLen + 1, min(fillLevel, bufLen))`, so at
    // position 1 the offset is `safeLen + 1` while the buffer is still filling
    // and the first audible sample lands at 14401 instead of 14400. Asserted as
    // a bound so the clause stays honest about it: 1 sample at 48 kHz is 21 µs
    // against a 300 ms window, and pretending it is exact would be the kind of
    // rounded-off claim that hides the next real one.
    const firsts = [0, 0.25, 0.5, 0.75, 1].map(
      (position) => firstNonZeroSample(render({ position }, 1.0).outL),
    );
    const span = Math.max(...firsts) - Math.min(...firsts);
    expect(span, `position must not move the silence by more than a sample (got ${firsts})`).toBeLessThanOrEqual(1);
    expect((firsts[0]! / SR) * 1000).toBeCloseTo(cloudsGrainMs(0.5), 0);
  });

  it('full level lands one grain AFTER the ring fills, not at the ring fill', () => {
    // ⚠ THE SPEC SAID "the step lands at t = 2.000 s to the sample". It does
    // not: at 2.00 s the output is still ~12 dB down and the climb completes
    // around 2.3 s, because a grain spawned an instant before the fill reads
    // partly-unwritten tape for its whole life. Asserted as a SHAPE (still down
    // at the fill, up by the model's answer) so it cannot pass on a flat run.
    const out = render({}, 4.0);
    const steady = rmsDb(out.outL, 3.0, 4.0);
    const atFill = rmsDb(out.outL, CLOUDS_BUFFER_SECONDS - 0.05, CLOUDS_BUFFER_SECONDS);
    const predicted = cloudsFullLevelS(DEFAULTS);
    const afterPredicted = rmsDb(out.outL, predicted + 0.05, predicted + 0.35);

    expect(predicted, 'the readout predicts 2.0 s + one grain').toBeCloseTo(2.3, 2);
    expect(
      steady - atFill,
      `at the 2.0 s ring fill the output is still well down (${atFill.toFixed(1)} vs steady ${steady.toFixed(1)})`,
    ).toBeGreaterThan(6);
    expect(
      Math.abs(steady - afterPredicted),
      `by ${predicted.toFixed(2)} s it has arrived (${afterPredicted.toFixed(1)} vs ${steady.toFixed(1)})`,
    ).toBeLessThan(1.5);
  });
});

describe('clouds face model — ORACLE: the WHOLE of SIZE is alive (the #1456 fix, pinned)', () => {
  // ⚠ THIS BLOCK ASSERTED THE EXACT OPPOSITE UNTIL #1456, AND THE INVERSION IS
  // THE POINT. `safeLen = min(lengthSamples, floor(bufLen · 0.4))` capped the
  // grain at 800 ms against a law that asked for 1500, so SIZE 0.805 / 0.85 /
  // 0.9 / 1.0 rendered BIT-IDENTICAL samples — 19.50 % of the dial, measured.
  // The face printed `CLAMPED` there rather than painting a dead dial as a
  // working one, and said in as many words that a DSP fix must turn this red.
  // It did. The ceiling is now DERIVED from the law, so the clamp cannot bind,
  // and what is pinned here is the fix rather than the defect.
  //
  // ⚠ AND "ALL DIFFERENT" IS NOT SELF-VALIDATING. A detector that reported
  // "different" unconditionally would pass the first leg on the BROKEN module,
  // so the second leg feeds the same detector the OLD ceiling (by pre-clamping
  // the size it renders at, which reproduces the old arithmetic exactly) and
  // requires it to find the plateau again. Both directions, every run.
  const SECONDS = 3;
  const src = noise(SR * SECONDS);
  /** The ladder that used to be one flat plateau. Steps of 0.02–0.05 are 3–4
   *  orders of magnitude above the `Math.floor(ms/1000·sr)` quantisation floor
   *  (measured Δsize ≈ 6e-6…2.7e-5 across the travel), so "these render
   *  differently" is a claim about the CONTROL and not about float resolution. */
  const TOP_LADDER = [0.79, 0.8, 0.804, 0.81, 0.85, 0.9, 0.95, 1] as const;
  /** Where the old 800 ms ceiling started binding: log(800/60)/log(25). */
  const OLD_CLAMP_SIZE = Math.log(800 / 60) / Math.log(1500 / 60);

  it('every step of the top fifth renders DIFFERENT samples, and the clamp never binds', () => {
    expect(CLOUDS_GRAIN_CEILING_MS, 'the ceiling is the law’s own top now').toBe(1500);
    // The clamp is a safety net that must never fire anywhere on the dial —
    // stated as an identity rather than as a comment, so a future
    // BUFFER_SECONDS / cap-fraction edit that re-introduces a dead top is red.
    for (const size of [0, 0.25, 0.5, 0.75, 0.9, 1]) {
      expect(cloudsGrainMs(size), `size ${size}: the ceiling must not bind`).toBeCloseTo(
        cloudsRequestedGrainMs(size),
        9,
      );
    }
    expect(cloudsGrainMs(1)).toBeCloseTo(1500, 6);

    const rendered = TOP_LADDER.map((size) => render({ size }, SECONDS, src).outL);
    for (let i = 0; i < TOP_LADDER.length; i++) {
      for (let j = i + 1; j < TOP_LADDER.length; j++) {
        expect(
          bitIdentical(rendered[i]!, rendered[j]!),
          `size ${TOP_LADDER[i]} and size ${TOP_LADDER[j]} must render DIFFERENTLY — this ` +
            `is the fifth of the dial that was one bit-identical plateau before #1456`,
        ).toBe(false);
      }
    }
  });

  it('NEGATIVE CONTROL: the same detector, fed the OLD ceiling, still finds the plateau', () => {
    // Pre-clamping the SIZE the mirror renders at reproduces the pre-#1456
    // arithmetic EXACTLY (`lengthSamples(0.804744) === floor(0.4·bufLen)` at any
    // integer sample rate), so this is the old module through the new code — and
    // it must come back dead. Without this leg the clause above cannot tell
    // "the knob works" from "the comparison always says different".
    const oldWay = (size: number): Float32Array =>
      render({ size: Math.min(size, OLD_CLAMP_SIZE) }, SECONDS, src).outL;
    const top = oldWay(1);
    for (const size of [0.81, 0.85, 0.9, 0.95, 1]) {
      expect(
        bitIdentical(oldWay(size), top),
        `at the OLD 800 ms ceiling, size ${size} was bit-identical to maximum — if this is ` +
          `false the plateau detector is broken, not the DSP`,
      ).toBe(true);
    }
    // …and the SAME detector separates two sizes below the old ceiling, so it
    // is not simply answering "identical" to everything either.
    expect(bitIdentical(oldWay(0.5), oldWay(0.75))).toBe(false);
  });

  it('the readout prints the law’s real top, and says CLAMPED nowhere', () => {
    expect(cloudsGrainText(at({ size: 0.5 }))).toBe('300 ms out');
    expect(cloudsGrainText(at({ size: 0.9 }))).toBe('1087 ms out');
    expect(cloudsGrainText(at({ size: 1 }))).toBe('1500 ms out');
    for (let size = 0; size <= 1.0001; size += 0.02) {
      expect(cloudsGrainText(at({ size })), `size ${size.toFixed(2)}`).not.toContain('CLAMPED');
    }
  });
});

describe('clouds face model — ORACLE: PITCH 0 is a THRESHOLD, and the drop is real', () => {
  // Two claims the faceplate makes about pitch, both re-derived here:
  //   1. leaving zero costs ≈ CLOUDS_COHERENCE_DROP_DB at the shipped defaults;
  //   2. it is a THRESHOLD — ±0.5 st already costs essentially all of it — so a
  //      semitone readback (`0.50 st`) is the wrong instrument for it.
  const SECONDS = 6;
  const src = noise(SR * SECONDS);
  const level = (pitch: number): number => rmsDb(render({ pitch }, SECONDS, src).outL, 2.5, 6);

  it('the constant the sidebar prints is within 1 dB of the measured step', () => {
    const drop = level(0) - level(12);
    expect(
      Math.abs(drop - CLOUDS_COHERENCE_DROP_DB),
      `measured ${drop.toFixed(2)} dB vs the printed ${CLOUDS_COHERENCE_DROP_DB} dB — re-measure ` +
        `the constant (or recognise a DSP change)`,
    ).toBeLessThan(1);
  });

  it('±0.5 st costs the same as ±24 st — a threshold, not a slope', () => {
    const zero = level(0);
    const tiny = level(0.5);
    const far = level(24);
    expect(zero - tiny, 'half a semitone already costs the whole step').toBeGreaterThan(
      CLOUDS_COHERENCE_DROP_DB - 1,
    );
    expect(
      Math.abs(tiny - far),
      `±0.5 st (${tiny.toFixed(2)}) and ±24 st (${far.toFixed(2)}) must be within 2 dB — if they ` +
        `are not, coherence is a slope and the readout is wrong to call it a detent`,
    ).toBeLessThan(2);
  });

  it('the readout flips at EXACTLY zero, which a semitone readback cannot express', () => {
    expect(cloudsCoherenceText(at({ pitch: 0 }))).toBe('COHERENT · 24 grains in phase');
    expect(cloudsCoherenceText(at({ pitch: 0.5 }))).toBe('spread · 24 grains in power');
    expect(cloudsCoherenceText(at({ pitch: -0.5 }))).toBe('spread · 24 grains in power');
  });
});

describe('clouds face model — ORACLE: the grain POOL, and why DENSITY goes flat', () => {
  const SECONDS = 6;
  const src = noise(SR * SECONDS);
  const level = (density: number): number => rmsDb(render({ density }, SECONDS, src).outL, 2.5, 6);

  it('the level stops moving exactly where the model says the pool fills', () => {
    const full = cloudsPoolFullAt(0.5);
    expect(full, 'the pool fills within the DENSITY travel at the shipped SIZE').not.toBeNull();
    expect(full!).toBeCloseTo(0.489, 2);

    // BELOW the saturation point the knob is worth many dB…
    expect(level(full!) - level(0), 'density is a real control below saturation').toBeGreaterThan(6);
    // …and ABOVE it the level is flat, which is the measurement that reads like
    // a dead control and is not one (max|Δ| 0.73–0.96 across the same span).
    const above = [0.6, 0.75, 0.9, 1].map(level);
    const spread = Math.max(...above) - Math.min(...above);
    expect(
      spread,
      `above saturation the LEVEL must be flat (got ${spread.toFixed(2)} dB across ${above.map((d) => d.toFixed(2)).join('/')})`,
    ).toBeLessThan(1);
  });

  it('…but the SOUND still changes above saturation — the flat level is not inertness', () => {
    // ⚠ THE NEGATIVE CONTROL ON THE INSTRUMENT ITSELF. Without this leg the
    // clause above is indistinguishable from "DENSITY's top half does nothing",
    // which is the false conclusion an RMS sweep reaches. A difference metric
    // says otherwise.
    const base = render({ density: 0.5 }, SECONDS, src).outL;
    const deltas: string[] = [];
    for (const density of [0.6, 0.75, 0.9, 1]) {
      const other = render({ density }, SECONDS, src).outL;
      let maxD = 0;
      for (let i = SR * 2; i < base.length; i++) maxD = Math.max(maxD, Math.abs(base[i]! - other[i]!));
      deltas.push(`${density}:${maxD.toFixed(3)}`);
      // The bar is HALF of full scale on a signal whose own peak is ~0.99 —
      // measured 0.73–0.96 across these four, so there is ample margin and it
      // cannot pass on the ±0.07 dB of level movement the clause above found.
      expect(maxD, `density ${density} must change the WAVEFORM (max|Δ| ${deltas.join(' ')})`).toBeGreaterThan(0.5);
    }
  });
});

describe('clouds face model — ORACLE: POSITION is total, and invisible to a level', () => {
  // The claim the whole hero picture exists for. A marked source (a 4 Hz click
  // train) is used because POSITION selects MATERIAL: against broadband, where
  // every window sounds the same, even a difference metric under-reports.
  const SECONDS = 5;
  function clicks(n: number): { L: Float32Array; R: Float32Array } {
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    const period = SR / 4;
    for (let i = 0; i < n; i++) {
      const p = i % period;
      L[i] = p < 24 ? 1 - p / 24 : 0;
      R[i] = L[i]!;
    }
    return { L, R };
  }
  const src = clicks(SR * SECONDS);

  it('0.2 dB of level, and an entirely different waveform', () => {
    const levels = [0, 0.25, 0.5, 0.75, 1].map((position) =>
      rmsDb(render({ position }, SECONDS, src).outL, 2.5, 5),
    );
    const span = Math.max(...levels) - Math.min(...levels);
    expect(
      span,
      `POSITION's LEVEL span must stay tiny (${span.toFixed(2)} dB) — this is the leg that makes ` +
        `"an RMS sweep would not notice POSITION breaking" a measurement rather than a claim`,
    ).toBeLessThan(1.5);

    const base = render({ position: 0.5 }, SECONDS, src).outL;
    for (const position of [0, 0.25, 0.75, 1]) {
      const other = render({ position }, SECONDS, src).outL;
      let maxD = 0;
      for (let i = SR * 2.5; i < base.length; i++) maxD = Math.max(maxD, Math.abs(base[i]! - other[i]!));
      expect(maxD, `position ${position}: a different waveform, not a different level`).toBeGreaterThan(0.5);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// NEGATIVE CONTROLS — each readout, in both directions
// ═══════════════════════════════════════════════════════════════════════════

/** Perturb every macro EXCEPT the named ones and require the value not to move;
 *  then perturb each named one and require that it does. The shape that a knob
 *  relabelled cannot satisfy. */
function bothDirections(
  label: string,
  value: (p: CloudsFaceParams) => string | number | boolean,
  movers: readonly (keyof CloudsFaceParams)[],
  base: CloudsFaceParams = DEFAULTS,
): void {
  const PERTURB: Record<keyof CloudsFaceParams, number[]> = {
    position: [0, 1],
    size: [0.1, 0.95],
    pitch: [-12, 7],
    density: [0.1, 1],
    texture: [0, 1],
    blend: [0, 1],
  };
  const ref = value(base);
  for (const key of Object.keys(PERTURB) as (keyof CloudsFaceParams)[]) {
    const moved = PERTURB[key].map((v) => value({ ...base, [key]: v }));
    if (movers.includes(key)) {
      expect(
        moved.some((m) => m !== ref),
        `${label}: ${key} MUST move it (stuck at ${String(ref)})`,
      ).toBe(true);
    } else {
      expect(moved, `${label}: ${key} must NOT move it`).toEqual([ref, ref]);
    }
  }
}

describe('clouds face model — NEGATIVE CONTROLS (both directions, every readout)', () => {
  it('`reads` (position) moves with POSITION and SIZE, and with nothing else', () => {
    // ⚠ SIZE IS THE HALF A KNOB READBACK IS BLIND TO. `paramId: 'position'`
    // prints 0.50 at every size while the reachable span shrinks from 1.94 s to
    // 0.50 s and the read point moves 1.03 s → 1.75 s.
    bothDirections('clouds-position-reach', cloudsPositionText, ['position', 'size']);
    expect(cloudsPositionText(DEFAULTS)).toBe('1.15 s back · of 0.30–2.00 s');
    expect(cloudsPositionSecondsBack(at({ size: 0 }))).toBeCloseTo(1.03, 2);
    expect(cloudsPositionSecondsBack(at({ size: 1 }))).toBeCloseTo(1.75, 2);
    const near = cloudsPositionReach(at({ size: 1 })).near;
    expect(near, 'the near edge is one grain, so it moves with SIZE').toBeCloseTo(1.5, 3);
  });

  it('`grain` moves with SIZE and PITCH, and with nothing else', () => {
    // DENSITY is the control that must NOT move it: grain LENGTH is invariant
    // to how many are firing, while §4-D shows DENSITY moving the output 8.8 dB.
    bothDirections('clouds-grain-ms', cloudsGrainText, ['size', 'pitch']);
    expect(cloudsGrainText(DEFAULTS)).toBe('300 ms out');
    expect(cloudsGrainText(at({ pitch: 12 }))).toBe('300 ms out · 600 ms of buffer');
    expect(cloudsGrainText(at({ pitch: -12 }))).toBe('300 ms out · 150 ms of buffer');
    expect(cloudsSourceGrainMs(at({ pitch: 12 }))).toBeCloseTo(600, 6);
  });

  it('`pitch` (coherence) moves with PITCH, and its grain count with DENSITY/SIZE', () => {
    bothDirections('clouds-coherence', cloudsCoherenceText, ['pitch', 'density', 'size']);
    // The state half is a pure function of pitch and NOTHING else — asserted
    // separately, because the grain-count suffix would otherwise let a broken
    // coherence test pass on a density change.
    bothDirections('clouds-coherence(state)', (p) => cloudsCoherenceText(p).startsWith('COHERENT'), [
      'pitch',
    ]);
  });

  it('`grain pool` moves with DENSITY and SIZE, and with nothing else', () => {
    bothDirections('clouds-grain-count', cloudsGrainCountText, ['density', 'size']);
    expect(cloudsGrainCountText(DEFAULTS)).toBe('24 of 24 · POOL FULL');
    expect(cloudsGrainCountText(at({ density: 0.25 }))).toBe('6.8 of 24');
    expect(cloudsPoolFull(at({ density: 0.25 }))).toBe(false);
    expect(cloudsGrainCount(at({ density: 1 }))).toBe(CLOUDS_MAX_GRAINS);
    expect(cloudsSpawnHz(0)).toBeCloseTo(6, 6);
    expect(cloudsSpawnHz(1)).toBeCloseTo(1200, 6);
  });

  it('`silent for` / `full level at` move with SIZE, and with nothing else', () => {
    // ⚠ INCLUDING POSITION, which is the one a reader would expect to matter —
    // the oracle above proves at the sample level that it does not.
    bothDirections('clouds-silence', cloudsSilenceText, ['size']);
    bothDirections('clouds-full-level', cloudsFullLevelText, ['size']);
    expect(cloudsSilenceText(DEFAULTS)).toBe('300 ms');
    expect(cloudsSilenceText(at({ size: 0 }))).toBe('60 ms');
    expect(cloudsFullLevelText(DEFAULTS)).toBe('2.30 s');
    expect(cloudsFullLevelText(at({ size: 0 }))).toBe('2.06 s');
  });
});

describe('clouds face model — the hero PANEL is a pure function, and its probe cannot go vacuous', () => {
  it('the ring plan is deterministic: same params in, identical plan out', () => {
    // The whole argument for a clockless hero. If this could ever differ, the
    // VRT baseline would be a race against boot latency.
    expect(cloudsRingPlan(DEFAULTS)).toEqual(cloudsRingPlan(DEFAULTS));
    expect(JSON.stringify(cloudsRingPlan(at({ position: 0.2, size: 0.7 })))).toBe(
      JSON.stringify(cloudsRingPlan(at({ position: 0.2, size: 0.7 }))),
    );
  });

  it('the read window sits where POSITION puts it, in ring fractions', () => {
    const plan = cloudsRingPlan(DEFAULTS);
    expect(plan.readTo).toBeCloseTo(1.15 / CLOUDS_BUFFER_SECONDS, 6);
    expect(plan.readFrom).toBeCloseTo((1.15 - 0.3) / CLOUDS_BUFFER_SECONDS, 6);
    expect(plan.deadNoseTo, 'the never-read nose is exactly one grain').toBeCloseTo(0.15, 6);
    // At POSITION 0 the window ends flush with the write head — the newest
    // grain-length IS reachable, it just cannot be a read START.
    expect(cloudsRingPlan(at({ position: 0 })).readFrom).toBeCloseTo(0, 6);
    // At POSITION 1 it starts at the far end of the tape.
    expect(cloudsRingPlan(at({ position: 1 })).readTo).toBeCloseTo(1, 6);
  });

  it('the AXIS MODES can never render the same caption — at ANY size', () => {
    // ⚠ THE PANEL'S faces-parity PROBE IS A `text` ASSERTION THAT THIS ROW
    // CHANGED. A tick that read identically in both modes would weaken it, and
    // the naive forms are both "0" at t = 0. Asserted across the whole SIZE
    // travel rather than at the default alone, because a probe that is only
    // non-vacuous at one setting is a probe waiting to go quiet.
    for (const size of [0, 0.2, 0.4, 0.5, 0.6, 0.8, 0.9, 1]) {
      const p = at({ size });
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const a = cloudsAxisCaption(t, p, 'time');
        const b = cloudsAxisCaption(t, p, 'grains');
        expect(a, `size ${size} tick ${t}: the two labellings must differ`).not.toBe(b);
      }
    }
    expect(cloudsAxisCaption(0.5, DEFAULTS, 'time')).toBe('1.00 s');
    expect(cloudsAxisCaption(0.5, DEFAULTS, 'grains')).toBe('3.3 ×');
  });

  it('at PITCH 0 every grain bar is IDENTICAL — the picture IS the coherence', () => {
    // ⚠ THE CENTRAL CLAIM OF THE PICTURE, and the one a plausible-looking
    // stagger gets exactly backwards. In the "seconds behind the write head"
    // frame a grain drifts by `age·(1 − ratio)`, which is ZERO at pitch 0 — so
    // all N are reading THE SAME SAMPLE at the same moment, which is the
    // ~10.6 dB the level readout talks about. Aligned stack ⇒ coherent.
    const bars = cloudsRingPlan(DEFAULTS).grains;
    expect(bars.length).toBeGreaterThan(1);
    for (const b of bars) expect(b).toEqual(bars[0]);

    // …and transposed in EITHER direction they fan out over ~one grain. Both
    // signs, because the drift term changes sign at ratio 1 and a one-sided
    // check would pass on a model that only fanned upward.
    for (const pitch of [12, -12]) {
      const fanned = cloudsRingPlan(at({ pitch })).grains;
      const spread = Math.max(...fanned.map((b) => b.to)) - Math.min(...fanned.map((b) => b.to));
      expect(
        spread,
        `pitch ${pitch}: the grains must spread across a meaningful slice of the ring`,
      ).toBeGreaterThan(0.05);
      expect(new Set(fanned.map((b) => b.to)).size, `pitch ${pitch}: distinct read points`).toBe(
        fanned.length,
      );
    }
  });

  it('the plan draws at most 12 grain bars and never fewer than one', () => {
    // The floor matters: at the sparsest corner the scheduler averages 0.36
    // concurrent grains, and a picture with NO bars would read as "the module
    // is off" rather than "the grains are far apart".
    expect(cloudsGrainCount(at({ density: 0, size: 0 }))).toBeLessThan(1);
    expect(cloudsRingPlan(at({ density: 0, size: 0 })).grains.length).toBe(1);
    expect(cloudsRingPlan(at({ density: 0 })).grains.length).toBe(2); // 1.8 concurrent
    expect(cloudsRingPlan(at({ density: 1 })).grains.length).toBe(12);
  });
});

describe('clouds face model — the reader is TOTAL', () => {
  it('a reader that answers nothing yields the def defaults, never NaN', () => {
    const p = cloudsFaceParams(() => undefined);
    expect(p).toEqual(DEFAULTS);
    for (const fn of [
      cloudsPositionText,
      cloudsGrainText,
      cloudsCoherenceText,
      cloudsGrainCountText,
      cloudsSilenceText,
      cloudsFullLevelText,
    ]) {
      expect(fn(p)).not.toContain('NaN');
    }
  });

  it('a reader answering NaN falls back too (a mid-drag transient must not kill the faceplate)', () => {
    const p = cloudsFaceParams(() => Number.NaN);
    expect(p).toEqual(DEFAULTS);
    expect(cloudsPositionText(cloudsFaceParams(readerFor(DEFAULTS)))).toBe(
      '1.15 s back · of 0.30–2.00 s',
    );
  });
});
