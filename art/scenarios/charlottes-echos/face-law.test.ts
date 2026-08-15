// art/scenarios/charlottes-echos/face-law.test.ts
//
// THE FACEPLATE'S CLAIMS, RE-DERIVED FROM THE SHIPPING WORKLET ON EVERY RUN.
//
// `charlottes-echos-face-model.ts` RE-TYPES four constants from the DSP
// (`NUM_STAGES`, `FEEDBACK_MAX`, the `0.8` drive coefficient, the shifter's
// `1e-9` bypass) because a worklet ENTRY cannot export them — a top-level
// `export` survives esbuild into `dist/<name>.js`, which the ART harness evals
// as a classic script, and moving them into a new shared lib would change the
// entry's own bytes and re-pin all three ART baselines for a UI change.
//
// This file is what makes that copy safe, and it is a STRONGER check than an
// import would have been: an import proves the CONSTANTS match, a measurement
// proves the LAW does. A DSP change turns these red instead of leaving the
// faceplate insisting on the old arithmetic.
//
// ── THE INSTRUMENT, AND THE SPEC CLAIM IT REFUTED ──────────────────────────
//
// The batch-6 face spec bisected the stability boundary with a LEVEL threshold
// ("is the last 2 s of a 12 s render above −100 dBFS") and reported a boundary
// that MOVES with DELAY — 0.3184 of DECAY at 20 ms, 0.2977 at 150 ms, 0.2079 at
// 600 ms — and wrote a readout spec around interpolating that surface.
//
// It is an artifact of the metric. A level threshold at a FIXED wall-clock time
// cannot separate "does not decay" from "decays slowly", and a longer tape
// decays slower per second BY CONSTRUCTION: the round trip is DELAY/4, so a
// 600 ms tape gets 6.7 round trips a second where a 20 ms tape gets 200. Swept
// far enough the same instrument reports a boundary of ~0.0001 at DELAY 1.5 s,
// i.e. "any DECAY at all sustains", which is the tell.
//
// The delay-INVARIANT quantity is dB per ROUND TRIP, and under it the law is
// exact: at FEEDBACK 0.5 / DECAY 0.25 the loop loses 0.96 dB per round trip at
// 20 ms, at 150 ms and at 600 ms alike, which is what `ceLoopGain` predicts.
// Both instruments run below ON THE SAME RENDERS, so the difference is
// demonstrated rather than asserted — and the level instrument's own
// self-contradiction is a permanent leg, not a note.
//
// Nothing is pinned and every driver is deterministic, so this scenario needs no
// baseline and no `.sha`.

import { describe, expect, it } from 'vitest';
import { captureWorkletProcessor, renderWorklet } from '../../setup/worklet';
import {
  CE_GRAIN_LAG_MS,
  CE_SHIFTER_BYPASS_EPS,
  CE_STAGES,
  ceClimbRatio,
  ceLoopGain,
  ceRoundTripS,
  ceTailSeconds,
} from '../../../packages/web/src/lib/ui/modules/charlottes-echos-face-model';
import { charlottesEchosDef } from '../../../packages/web/src/lib/audio/modules/charlottes-echos';

const SR = 48000;
const C4_HZ = 261.6256;

async function fresh() {
  const Ctor = await captureWorkletProcessor(
    'charlottes-echos',
    () => import('../../../packages/dsp/src/charlottes-echos'),
    SR,
  );
  return new Ctor();
}

/** The def's own defaults, so every row reads as a deviation from spawn. */
function spawn(): Record<string, number> {
  const p: Record<string, number> = {};
  for (const d of charlottesEchosDef.params) p[d.id] = d.defaultValue;
  return p;
}

/** 60 ms C4 saw burst at −4.4 dBFS, then silence — the ART profile's driver
 *  shape, and a transient rather than a tone so the TAIL is the whole signal. */
function sawBurst(total: number, burstS = 0.06, amp = 0.6026): Float32Array {
  const b = new Float32Array(total);
  const n = Math.min(total, Math.round(burstS * SR));
  let ph = 0;
  for (let i = 0; i < n; i++) {
    b[i] = (2 * ph - 1) * amp;
    ph += C4_HZ / SR;
    if (ph >= 1) ph -= 1;
  }
  return b;
}
function sineBurst(total: number, burstS = 0.3, hz = C4_HZ, amp = 0.6): Float32Array {
  const b = new Float32Array(total);
  const n = Math.min(total, Math.round(burstS * SR));
  for (let i = 0; i < n; i++) b[i] = Math.sin((2 * Math.PI * hz * i) / SR) * amp;
  return b;
}
function click(total: number): Float32Array {
  const b = new Float32Array(total);
  b[0] = 1;
  return b;
}

type Patch = Partial<Record<'delay' | 'feedback' | 'decay' | 'pitchUp' | 'mix', number>>;

async function render(p: Patch, totalS: number, drive: Float32Array): Promise<Float32Array> {
  const n = Math.round(totalS * SR);
  const out = renderWorklet(await fresh(), {
    totalSamples: n,
    inputs: [drive, null],
    params: { ...spawn(), ...p },
    outputs: ['L', 'R'],
  });
  return out.L!;
}

/** RMS over [a, b) in dBFS, floored at −320 — float32's own floor, past which
 *  "quieter" is not measurable and a RATE computed from it is meaningless. */
const FLOOR_DB = -320;
function rmsDb(x: Float32Array, aS: number, bS: number): number {
  const a = Math.round(aS * SR);
  const b = Math.round(bS * SR);
  let s = 0;
  for (let i = a; i < b; i++) s += x[i]! * x[i]!;
  const r = Math.sqrt(s / Math.max(1, b - a));
  return r > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(r)) : FLOOR_DB;
}
function peakAbs(x: Float32Array): number {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]!));
  return p;
}
function maxAbsDiff(x: Float32Array, y: Float32Array): number {
  let d = 0;
  for (let i = 0; i < x.length; i++) d = Math.max(d, Math.abs(x[i]! - y[i]!));
  return d;
}
/** First sample index whose |v| exceeds `eps`, or −1. */
function firstAbove(x: Float32Array, eps: number): number {
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]!) > eps) return i;
  return -1;
}
/**
 * Time from t = 0 until the output last exceeds −60 dB of its own WET peak.
 *
 * ⚠ THE PEAK IS MEASURED PAST THE BURST, AND THAT CLAUSE IS THE INSTRUMENT.
 * The output is `dry·(1−MIX) + wet·MIX`, so at a low MIX the loudest sample in
 * the whole render is the DRY HIT — a reference that shrinks as MIX rises and
 * makes the measured tail move with MIX for a reason that has nothing to do
 * with the loop. Measured with a whole-render peak the same patch reads 1.79 s
 * at MIX 0.25 and 1.91 s at MIX 1; with the peak taken after the burst it reads
 * the same tail at every MIX, which is the property `ce-tail` claims.
 */
const BURST_END_S = 0.1;
function tail60s(x: Float32Array): number {
  const from = Math.round(BURST_END_S * SR);
  let peak = 0;
  for (let i = from; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]!));
  const thr = peak * 1e-3;
  for (let i = x.length - 1; i >= 0; i--) if (Math.abs(x[i]!) > thr) return i / SR;
  return 0;
}
/** Goertzel magnitude at `hz` over [a, b) samples, normalised 2/N. */
function goertzel(x: Float32Array, hz: number, a: number, b: number): number {
  const n = b - a;
  const w = (2 * Math.PI * hz) / SR;
  const c = 2 * Math.cos(w);
  let q1 = 0;
  let q2 = 0;
  for (let i = a; i < b; i++) {
    const q0 = c * q1 - q2 + x[i]!;
    q2 = q1;
    q1 = q0;
  }
  const re = q1 - q2 * Math.cos(w);
  const im = q2 * Math.sin(w);
  return (2 / n) * Math.sqrt(re * re + im * im);
}

/** The two late windows every rate below is read from, in seconds. */
const W1_S = 3;
const W2_S = 8;
const WIN_S = 2;
const RENDER_S = 10;

/**
 * THE DELAY-INVARIANT METRIC: dB lost per ROUND TRIP of one stage.
 *
 * Returns `null` when either window sits on the float32 floor — "already
 * silent" and "not decaying" both read as 0 otherwise, and they are opposite
 * answers. A null is never silently skipped by a caller below.
 */
function dbPerRoundTrip(
  x: Float32Array,
  p: Patch,
): { perRt: number; perS: number; w1: number; w2: number } | null {
  const w1 = rmsDb(x, W1_S, W1_S + WIN_S);
  const w2 = rmsDb(x, W2_S, W2_S + WIN_S);
  if (w1 <= FLOOR_DB + 1 || w2 <= FLOOR_DB + 1) return null;
  const perS = (w2 - w1) / (W2_S - W1_S);
  return { perRt: perS * ceRoundTripS(p as never), perS, w1, w2 };
}

/** The law's own prediction, in dB per round trip. */
const predictedPerRt = (p: Patch) => 20 * Math.log10(ceLoopGain(p as never));

const TIMEOUT_MS = 600_000;
const fmt = (v: number) => (v === 0 ? '0.0000e+0' : v.toExponential(4));

describe("ART charlotte's echos / the faceplate's LAW, measured on the shipping worklet", () => {
  it('THE BOUNDARY IS LOOP GAIN 1, AT EVERY DELAY — and the level instrument the spec used says otherwise on the SAME renders', async () => {
    // Three DELAYs spanning 30× — the SAME three the spec's own bisection table
    // used (0.02 / 0.15 / 0.6 s), so the refutation lands on its own rows. Two
    // DECAYs straddling loop gain 1 at the shipped FEEDBACK. Six renders, and
    // both instruments read off all six.
    const BELOW = 0.25; // loop gain 0.8955  → −0.959 dB per round trip
    const ABOVE = 0.35; // loop gain 1.0547  → the law says it never decays
    const DELAYS = [0.02, 0.15, 0.6];

    const rows: Array<{
      delay: number;
      decay: number;
      perRt: number | null;
      perS: number | null;
      lastDb: number;
    }> = [];
    for (const delay of DELAYS) {
      for (const decay of [BELOW, ABOVE]) {
        const p: Patch = { feedback: 0.5, decay, delay, mix: 1 };
        const x = await render(p, RENDER_S, sawBurst(RENDER_S * SR));
        const m = dbPerRoundTrip(x, p);
        rows.push({
          delay,
          decay,
          perRt: m?.perRt ?? null,
          perS: m?.perS ?? null,
          // The SPEC's instrument, on the same render: "is the last 2 s above
          // −100 dBFS?"
          lastDb: rmsDb(x, RENDER_S - 2, RENDER_S),
        });
      }
    }
    const table = rows
      .map(
        (r) =>
          `d=${r.delay} decay=${r.decay} ${r.perRt === null ? 'already silent' : `${r.perRt.toFixed(3)} dB/rt (${r.perS!.toFixed(2)} dB/s)`}` +
          ` last2s=${r.lastDb.toFixed(1)} dBFS`,
      )
      .join(' | ');

    // ── 1. BELOW the boundary: the SAME loss per round trip at every delay ──
    const belowRows = rows.filter((r) => r.decay === BELOW);
    const pred = predictedPerRt({ feedback: 0.5, decay: BELOW });
    const measurable = belowRows.filter((r) => r.perRt !== null);
    // ⚠ A row can floor out legitimately — at 20 ms the round trip is 5 ms, so
    // −0.96 dB/rt is −192 dB/s and the tail is on the float32 floor long before
    // the first window. That is DECAYED, i.e. it satisfies the clause; it is
    // named here rather than filtered silently, and the population that CAN be
    // compared is asserted non-trivial.
    expect(
      measurable.length,
      `at least two delays must stay measurable for the invariance to mean anything. ${table}`,
    ).toBeGreaterThan(1);
    for (const r of measurable) {
      expect(
        Math.abs(r.perRt! - pred),
        `delay=${r.delay}: dB per ROUND TRIP must match the law (predicted ${pred.toFixed(3)}) ` +
          `regardless of DELAY. ${table}`,
      ).toBeLessThan(0.25);
    }
    for (const r of belowRows) {
      expect(
        r.perRt === null || r.perRt < -0.5,
        `delay=${r.delay}: BELOW the boundary the tail must be falling (or already gone). ${table}`,
      ).toBe(true);
    }

    // ── 2. ABOVE the boundary: it does not decay, at every delay ────────────
    for (const r of rows.filter((x) => x.decay === ABOVE)) {
      expect(r.perRt, `delay=${r.delay}: a sustaining tail cannot be on the floor. ${table}`)
        .not.toBeNull();
      expect(
        Math.abs(r.perRt!),
        `delay=${r.delay}: ABOVE the boundary the loss per ROUND TRIP must be ≈ 0. ${table}`,
      ).toBeLessThan(0.35);
    }

    // ── 3. THE NEGATIVE CONTROL ON THE INSTRUMENT ITSELF ────────────────────
    // One patch, one loop gain, three delays: the round-trip metric says
    // "decaying" at all three (clause 1) while the spec's level threshold
    // disagrees with ITSELF across the same three renders. That disagreement is
    // the whole reason the boundary is a closed form on this faceplate rather
    // than an interpolated surface.
    const levelVerdicts = new Set(belowRows.map((r) => r.lastDb > -100));
    expect(
      levelVerdicts.size,
      'the LEVEL instrument must return BOTH verdicts across DELAY at one fixed loop ' +
        `gain — that self-contradiction is what disqualifies it. ${table}`,
    ).toBe(2);
  }, TIMEOUT_MS);

  it("the face model's TAIL agrees with the measured −60 dB tail, and the law with the measured rate", async () => {
    // Rows at three different loop gains, so the tail comparison is not one
    // point repeated. Each render feeds BOTH the tail check and a second
    // dB-per-round-trip reading at a gain the boundary test does not cover.
    const rows: Array<Patch & { feedback: number; decay: number; delay: number }> = [
      { feedback: 0.25, decay: 0.2, delay: 0.15, mix: 1 },
      { feedback: 0.5, decay: 0.2, delay: 0.15, mix: 1 },
      { feedback: 0.6, decay: 0.2, delay: 0.15, mix: 1 },
    ];
    const table: string[] = [];
    for (const p of rows) {
      const x = await render(p, RENDER_S, sawBurst(RENDER_S * SR));
      const meas = tail60s(x);
      const model = ceTailSeconds(p as never);
      const rate = dbPerRoundTrip(x, p);
      table.push(
        `fb=${p.feedback} dc=${p.decay} d=${p.delay} g=${ceLoopGain(p as never).toFixed(4)} ` +
          `tail meas=${meas.toFixed(2)}s model=${model.toFixed(2)}s ratio=${(meas / model).toFixed(3)}` +
          (rate ? ` rate=${rate.perRt.toFixed(3)} dB/rt pred=${predictedPerRt(p).toFixed(3)}` : ' rate=floored'),
      );
      expect(meas, `units: seconds. the row must produce a real tail. ${table.join(' | ')}`)
        .toBeGreaterThan(0.05);
      expect(
        meas,
        `the render must not TRUNCATE the tail it measures — a truncated row would ` +
          `read as agreement with any model that also ran long. ${table.join(' | ')}`,
      ).toBeLessThan(RENDER_S - 0.5);
      // ⚠ ±40 %, AND THE WIDTH IS ITSELF THE FINDING — the third row is what
      // sets the lower edge. The model is the LINEARISED four-stage cascade: it
      // ignores the in-loop tanh's LARGE-signal compression, so it runs LONG as
      // the loop gain approaches 1 (at g = 0.979 it says 13.6 s where the
      // worklet rings 8.8 s), and it ignores the tone filter's in-band loss, so
      // it runs SHORT at very low gain. Measured 2026-08-15 over ten patches the
      // ratio sits in 0.64–1.33. That is why the readout prints the LOOP GAIN
      // beside the tail rather than the tail alone.
      expect(meas / model, `tail model vs measurement. ${table.join(' | ')}`).toBeGreaterThan(0.6);
      expect(meas / model, `tail model vs measurement. ${table.join(' | ')}`).toBeLessThan(1.4);
      if (rate) {
        expect(
          rate.perRt / predictedPerRt(p),
          `measured/predicted dB per round trip. ${table.join(' | ')}`,
        ).toBeGreaterThan(0.6);
        expect(
          rate.perRt / predictedPerRt(p),
          `measured/predicted dB per round trip. ${table.join(' | ')}`,
        ).toBeLessThan(1.5);
      }
    }
  }, TIMEOUT_MS);

  it('MIX is outside every loop: it moves the LEVEL and not the TAIL', async () => {
    // The permanent audio anchor for `ce-tail`'s negative control. A tail
    // readout derived from level would track the first column; this one must
    // track the second, and the second must be FLAT.
    const rows: Array<{ mix: number; rms: number; tail: number }> = [];
    for (const mix of [0.25, 0.5, 1]) {
      const x = await render({ feedback: 0.5, decay: 0.2, delay: 0.15, mix }, 6, sawBurst(6 * SR));
      rows.push({ mix, rms: rmsDb(x, 0, 2), tail: tail60s(x) });
    }
    const spread = Math.max(...rows.map((r) => r.rms)) - Math.min(...rows.map((r) => r.rms));
    const tailSpread = Math.max(...rows.map((r) => r.tail)) - Math.min(...rows.map((r) => r.tail));
    const desc = rows
      .map((r) => `mix=${r.mix} rms=${r.rms.toFixed(2)} dB tail=${r.tail.toFixed(2)} s`)
      .join(' | ');
    expect(spread, `units: dB of LEVEL that MIX moves. ${desc}`).toBeGreaterThan(5);
    // ONE ROUND TRIP of slack and no more: the −60 dB point is quantised to a
    // tap (DELAY/CE_STAGES = 37.5 ms here), and the wet path scales EXACTLY with
    // MIX once the dry burst is out of the reference peak (see `tail60s`). A
    // budget larger than a tap would admit a real dependence.
    expect(tailSpread, `units: SECONDS of tail that MIX moves. ${desc}`)
      .toBeLessThanOrEqual(0.15 / CE_STAGES);
  }, TIMEOUT_MS);

  it('PITCH is DISCONTINUOUS at zero: an exact bypass below 1e-9, +45.000 ms at it', async () => {
    // The audio anchor for `ce-spacing`'s refusal to print a total, and for
    // CE_GRAIN_LAG_MS. `CE_STAGES − 1` shifters engage (stage 0 always runs at
    // rate 1) and each seeds its read lag at half of a 30 ms grain window.
    const T = 0.6;
    const n = Math.round(T * SR);
    const base = await render({ pitchUp: 0, delay: 0.15, mix: 1 }, T, click(n));
    const i0 = firstAbove(base, 1e-6);
    expect(i0 / SR, 'units: seconds to the first wet sample at PITCH 0').toBeCloseTo(0.15, 3);

    for (const p of [CE_SHIFTER_BYPASS_EPS / 1000, CE_SHIFTER_BYPASS_EPS / 10]) {
      const x = await render({ pitchUp: p, delay: 0.15, mix: 1 }, T, click(n));
      expect(
        maxAbsDiff(base, x),
        `pitchUp=${p} is below the shifter's own bypass threshold and must be BIT-EXACT: ` +
          `${fmt(maxAbsDiff(base, x))}`,
      ).toBe(0);
    }
    const x = await render({ pitchUp: CE_SHIFTER_BYPASS_EPS, delay: 0.15, mix: 1 }, T, click(n));
    expect(
      maxAbsDiff(base, x),
      'POSITIVE CONTROL on the same metric: AT the threshold the render must move',
    ).toBeGreaterThan(0);
    const shiftMs = ((firstAbove(x, 1e-6) - i0) / SR) * 1000;
    expect(
      shiftMs,
      `units: ms of grain lag inserted at pitchUp = ${CE_SHIFTER_BYPASS_EPS}; the face model ` +
        `predicts (CE_STAGES−1) × CE_GRAIN_LAG_MS = ${(CE_STAGES - 1) * CE_GRAIN_LAG_MS} ms`,
    ).toBeCloseTo((CE_STAGES - 1) * CE_GRAIN_LAG_MS, 2);
  }, TIMEOUT_MS);

  it('the CLIMB the face prints is where the tail energy actually is', async () => {
    // The audio anchor for `ce-climb`: content that traversed stages 1..S−1 sits
    // at (1+p)^CE_CLIMB_EXPONENT, so the tail's energy THERE must beat what is
    // left at the ORIGINAL pitch by a wide margin.
    const T = 3;
    const n = T * SR;
    for (const p of [0.05, 0.1]) {
      const x = await render({ pitchUp: p, delay: 0.15, feedback: 0.7, mix: 1 }, T, sineBurst(n));
      const a = Math.round(1.0 * SR);
      const b = Math.round(2.0 * SR);
      const hz = C4_HZ * ceClimbRatio({ pitchUp: p } as never);
      const climbed = goertzel(x, hz, a, b);
      const original = goertzel(x, C4_HZ, a, b);
      expect(
        climbed / original,
        `pitchUp=${p}: energy at the climbed partial (${hz.toFixed(1)} Hz, ` +
          `${climbed.toExponential(3)}) vs what is left at the original C4 ` +
          `(${original.toExponential(3)}) — units: Goertzel magnitude, linear`,
      ).toBeGreaterThan(5);
    }
  }, TIMEOUT_MS);

  it('the bottom of the DELAY dial is a FLOOR — and the metric is not blind', async () => {
    // The audio anchor for the `delay` doc's floor sentence. Each stage clamps at
    // 0.5 ms and the cascade runs each at DELAY/CE_STAGES, so nothing below 2 ms
    // moves. Both numbers are given because neither means anything alone.
    const T = 0.3;
    const n = Math.round(T * SR);
    const dialMin = charlottesEchosDef.params.find((p) => p.id === 'delay')!.min;
    const floorS = 0.0005 * CE_STAGES;
    const base = await render({ delay: dialMin, mix: 1 }, T, click(n));
    for (const d of [dialMin * 1.5, floorS * 0.9999]) {
      const x = await render({ delay: d, mix: 1 }, T, click(n));
      expect(
        maxAbsDiff(base, x),
        `delay=${d} s is inside the ${floorS} s cascade floor and must be bit-identical ` +
          `to the dial minimum (${dialMin} s)`,
      ).toBe(0);
    }
    const above = await render({ delay: floorS * 1.25, mix: 1 }, T, click(n));
    expect(
      maxAbsDiff(base, above),
      'POSITIVE CONTROL on the same metric: just above the floor it MUST move',
    ).toBeGreaterThan(0);
    // …and a control in the OTHER dimension, so a metric that returns zero for
    // everything at this delay is caught too.
    const fb = await render({ delay: dialMin, feedback: 0.9, mix: 1 }, T, click(n));
    expect(
      maxAbsDiff(base, fb),
      'POSITIVE CONTROL: at the same (floored) delay the render still moves when FEEDBACK does',
    ).toBeGreaterThan(0);
  }, TIMEOUT_MS);
});
