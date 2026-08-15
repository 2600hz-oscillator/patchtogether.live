// packages/web/src/lib/audio/modules/buggles.test.ts
//
// Unit tests for BUGGLES: module-def shape + pure helpers
// (rate mapping, stepped walk, period jitter, burst probability).
// Live AudioContext behavior is covered by the ART scenario.

import { describe, expect, it } from 'vitest';
import { createEdgeCounter } from '$lib/audio/edge-detect';
import {
  BUGGLES_EXT_ASSERT_SAMPLE_RATE,
  BUGGLES_EXT_FFT_SIZE,
  BUGGLES_EXT_POLL_MS,
  bugglesMath,
  bugglesPrng,
} from './buggles';

describe('bugglesMath: rate knob → Hz', () => {
  it('knob=0 → 0.1 Hz (lowest rate)', () => {
    expect(bugglesMath.rateKnobToHz(0)).toBeCloseTo(0.1, 6);
  });

  it('knob=1 → 50 Hz (highest rate)', () => {
    expect(bugglesMath.rateKnobToHz(1)).toBeCloseTo(50, 6);
  });

  it('knob=0.5 sits at the log midpoint (≈ sqrt(0.1 × 50) = 2.236 Hz)', () => {
    expect(bugglesMath.rateKnobToHz(0.5)).toBeCloseTo(Math.sqrt(0.1 * 50), 4);
  });

  it('clamps out-of-range inputs', () => {
    expect(bugglesMath.rateKnobToHz(-0.5)).toBeCloseTo(0.1, 6);
    expect(bugglesMath.rateKnobToHz(1.5)).toBeCloseTo(50, 6);
  });
});

describe('bugglesMath: nextStepped (chaos-controlled walk)', () => {
  // Deterministic PRNG so the walk is reproducible.
  const makeRand = () => bugglesPrng(123);

  it('chaos=0 produces a small perturbation of previous (correlated walk)', () => {
    const rand = makeRand();
    let prev = 0.5;
    let maxStep = 0;
    for (let i = 0; i < 200; i++) {
      const next = bugglesMath.nextStepped(prev, 0, rand);
      const step = Math.abs(next - prev);
      if (step > maxStep) maxStep = step;
      prev = next;
    }
    // walk = prev + 0.2 * fresh; fresh ∈ [-1, +1]; max step ≤ 0.2.
    expect(maxStep, `max step (chaos=0) = ${maxStep}`).toBeLessThan(0.21);
  });

  it('chaos=1 produces large jumps (independent uniform pulls)', () => {
    const rand = makeRand();
    let prev = 0;
    let bigJumps = 0;
    for (let i = 0; i < 200; i++) {
      const next = bugglesMath.nextStepped(prev, 1, rand);
      if (Math.abs(next - prev) > 0.5) bigJumps++;
      prev = next;
    }
    // With independent uniform pulls in [-1, +1], expect roughly 50%
    // of consecutive pairs to differ by more than 0.5.
    expect(bigJumps, `chaos=1 big jumps = ${bigJumps}/200`).toBeGreaterThan(50);
  });

  it('output stays within [-1, +1]', () => {
    const rand = makeRand();
    let prev = 0;
    for (let i = 0; i < 1000; i++) {
      prev = bugglesMath.nextStepped(prev, 0.5, rand);
      expect(prev).toBeGreaterThanOrEqual(-1);
      expect(prev).toBeLessThanOrEqual(1);
    }
  });
});

describe('bugglesMath: nextPeriodS (chaos-controlled jitter)', () => {
  it('chaos=0 gives exact 1/rate period', () => {
    const rand = bugglesPrng(7);
    for (let i = 0; i < 10; i++) {
      const p = bugglesMath.nextPeriodS(2, 0, rand);
      expect(p).toBeCloseTo(0.5, 6);
    }
  });

  it('chaos=1 jitters within ±50% of base period', () => {
    const rand = bugglesPrng(7);
    let minP = Infinity, maxP = -Infinity;
    for (let i = 0; i < 200; i++) {
      const p = bugglesMath.nextPeriodS(2, 1, rand);
      if (p < minP) minP = p;
      if (p > maxP) maxP = p;
    }
    // Base = 0.5s; jitter ±50% → range [0.25, 0.75].
    expect(minP).toBeGreaterThanOrEqual(0.25);
    expect(maxP).toBeLessThanOrEqual(0.75);
    // Sanity: with 200 samples we should see a wide spread.
    expect(maxP - minP, `period range = ${(maxP - minP).toFixed(3)}`).toBeGreaterThan(0.2);
  });
});

// ── EXTERNAL CLOCK: the detector's window must cover the gaps between polls ──
//
// ⚠ THE DEFECT THIS EXISTS FOR (2026-08-15). `external_clock` is detected on the
// MAIN THREAD by a `setInterval` that reads the tap's AnalyserNode ring. The
// shipped construction was `fftSize = 32` — 0.667 ms of audio at 48 kHz —
// against a 33 ms poll, so the detector inspected 2.0 % of the timeline and SLEPT
// THROUGH the rest. Measured below: **16.7 % of rising edges captured, flat
// across every clock rate**, because the answer is geometric rather than
// rate-dependent: (pulseWidth + bufferWidth) / pollInterval = (5+0.667)/33.
// Five of every six pulses a player sent were dropped, at every tempo.
//
// ⚠ WHY EVERY GATE WAS BLIND, and why this file is where the fix is pinned.
// `per-module-per-port` exempts `buggles.clock`/`burst` as OUTPUTS and asserts an
// edge MATERIALISES, never that an input pulse is CONSUMED. The behavioral sweep
// quarantines the module whole and its written reason records that external_clock
// "gives a clean delta (Δμrms≈0.14)" — true, and blind to the miss rate, since a
// 1-in-6 capture still moves an RMS. `e2e/tests/buggles.spec.ts` never patches
// `external_clock` at all. And the ART cannot reach it: the real factory is
// bit-exactly silent under an offline render (art/scenarios/buggles, the
// `real-factory-silence` legs), so the scheduler never runs there. Nothing in
// the tree measured capture fidelity. This does.
describe('BUGGLES external clock: the poll/ring relation', () => {
  it('the analyser ring is LONGER than the gap between polls — the relation, not two settings', () => {
    // The load-bearing assertion, and the one that FAILS ON THE OLD CODE: the
    // shipped pair was 32 vs 1584. It is a relation between two live constants,
    // so raising the poll interval past the ring is red without anyone
    // remembering the rule.
    const samplesPerPoll = Math.ceil(
      (BUGGLES_EXT_POLL_MS / 1000) * BUGGLES_EXT_ASSERT_SAMPLE_RATE,
    );
    expect(
      BUGGLES_EXT_FFT_SIZE,
      `ring ${BUGGLES_EXT_FFT_SIZE} samples must cover a ${BUGGLES_EXT_POLL_MS} ms poll ` +
        `= ${samplesPerPoll} samples at ${BUGGLES_EXT_ASSERT_SAMPLE_RATE} Hz (units: samples)`,
    ).toBeGreaterThanOrEqual(samplesPerPoll);
  });

  it('DECLARES the coalescing ceiling rather than leaving it to be discovered', () => {
    // One poll fires at most one woggle event, so an external clock faster than
    // 1/POLL_MS collapses. Stated as a number so a future poll-interval change
    // has to restate it: every clock source in this rack is far below it (a
    // sequencer at 240 bpm is 4 Hz).
    const ceilingHz = 1000 / BUGGLES_EXT_POLL_MS;
    expect(ceilingHz, 'units: Hz — external clocks above this coalesce').toBeCloseTo(30.3, 1);
  });
});

describe('BUGGLES external clock: rising-edge CAPTURE, and both ways to get it wrong', () => {
  const SR = BUGGLES_EXT_ASSERT_SAMPLE_RATE;
  const PULSE_MS = 5; // the width every gate source in this rack emits
  const DUR_S = 6;

  /** A gate train at `hz`, `PULSE_MS` wide, as the raw sample stream the tap
   *  carries. The instrument's subject — built once per rate and shared by all
   *  three legs, so they cannot disagree about what arrived. */
  function gateTrain(hz: number): { wave: Float32Array; edges: number } {
    const n = Math.round(SR * DUR_S);
    const wave = new Float32Array(n);
    const period = SR / hz;
    const width = Math.round((PULSE_MS / 1000) * SR);
    let edges = 0;
    for (let e = 0; ; e++) {
      const start = Math.round(0.02 * SR + e * period);
      if (start + width >= n) break;
      edges++;
      for (let i = start; i < start + width; i++) wave[i] = 1;
    }
    return { wave, edges };
  }

  /** A stub AnalyserNode over `wave`: `getFloatTimeDomainData` returns the most
   *  recent `fftSize` samples as of `now`, exactly like the real ring. */
  function stubRing(wave: Float32Array, fftSize: number) {
    const state = { now: 0 };
    const analyser = {
      fftSize,
      getFloatTimeDomainData(buf: Float32Array) {
        const end = Math.round(state.now * SR);
        for (let i = 0; i < buf.length; i++) {
          const idx = end - buf.length + i;
          buf[i] = idx >= 0 && idx < wave.length ? wave[idx]! : 0;
        }
      },
    };
    return { state, analyser };
  }

  /** THE SHIPPED PRODUCT PATH: the real `createEdgeCounter`, driven by the
   *  module's own two constants. Nothing is mirrored here. */
  function captureViaEdgeCounter(wave: Float32Array): number {
    const { state, analyser } = stubRing(wave, BUGGLES_EXT_FFT_SIZE);
    const ctx = { get currentTime() { return state.now; }, sampleRate: SR };
    const counter = createEdgeCounter({
      ctx: ctx as unknown as BaseAudioContext,
      analyser: analyser as unknown as AnalyserNode,
    });
    let total = 0;
    const step = BUGGLES_EXT_POLL_MS / 1000;
    for (let t = step; t < DUR_S; t += step) {
      state.now = t;
      total += counter.poll(t);
    }
    return total;
  }

  /** NEGATIVE CONTROL A — the algorithm this module shipped: rescan the WHOLE
   *  ring every poll, with the ring smaller than the poll gap. */
  function captureWholeBuffer(wave: Float32Array, fftSize: number): number {
    const { state, analyser } = stubRing(wave, fftSize);
    const buf = new Float32Array(fftSize);
    let last = 0;
    let total = 0;
    const step = BUGGLES_EXT_POLL_MS / 1000;
    for (let t = step; t < DUR_S; t += step) {
      state.now = t;
      analyser.getFloatTimeDomainData(buf);
      for (let i = 0; i < buf.length; i++) {
        const s = buf[i]!;
        if (last < 0.5 && s >= 0.5) total++;
        last = s;
      }
    }
    return total;
  }

  const RATES_HZ = [1, 2, 4, 8, 16];

  it('the SHIPPED path captures EVERY rising edge, at every clock rate', () => {
    for (const hz of RATES_HZ) {
      const { wave, edges } = gateTrain(hz);
      const got = captureViaEdgeCounter(wave);
      expect(
        got,
        `${hz} Hz clock: captured ${got} of ${edges} rising edges (units: edges)`,
      ).toBe(edges);
    }
  });

  it('NEGATIVE CONTROL A — the OLD 32-sample whole-buffer scan drops 5 in 6', () => {
    // The defect, reproduced. Without this leg the green above could be a
    // property of a stub that hands out edges rather than of the fix.
    for (const hz of RATES_HZ) {
      const { wave, edges } = gateTrain(hz);
      const got = captureWholeBuffer(wave, 32);
      const ratio = got / edges;
      expect(
        ratio,
        `${hz} Hz clock, OLD algorithm: ${got}/${edges} = ${(ratio * 100).toFixed(1)}% ` +
          `(geometric prediction (${PULSE_MS}+0.667)/${BUGGLES_EXT_POLL_MS} ≈ 17.2%)`,
      ).toBeLessThan(0.25);
      expect(ratio, `${hz} Hz clock, OLD algorithm must not be zero either`).toBeGreaterThan(0.05);
    }
  });

  it('NEGATIVE CONTROL B — a BIGGER ring alone OVER-counts: the fix is the WINDOW', () => {
    // The tempting non-fix. Rescanning a 2048-sample ring against a 33 ms poll
    // re-presents the ~9.7 ms overlap on two consecutive polls, so one pulse
    // advances the state twice — the NUMPAD+/ATLANTIS-CATALYST class that
    // `createEdgeCounter`'s windowing exists to prevent. Asserting BOTH failure
    // modes is what makes "use the shared seam" the conclusion rather than
    // "make fftSize bigger".
    for (const hz of RATES_HZ) {
      const { wave, edges } = gateTrain(hz);
      const got = captureWholeBuffer(wave, BUGGLES_EXT_FFT_SIZE);
      expect(
        got,
        `${hz} Hz clock, big-ring whole-buffer rescan: ${got} counted for ${edges} real edges`,
      ).toBeGreaterThan(edges);
    }
  });
});

describe('bugglesMath: rollBurst', () => {
  it('probability=0 never fires', () => {
    const rand = bugglesPrng(3);
    for (let i = 0; i < 100; i++) {
      expect(bugglesMath.rollBurst(0, rand)).toBe(0);
    }
  });

  it('probability=1 always fires (burst length 3..7)', () => {
    const rand = bugglesPrng(3);
    for (let i = 0; i < 100; i++) {
      const len = bugglesMath.rollBurst(1, rand);
      expect(len).toBeGreaterThanOrEqual(3);
      expect(len).toBeLessThanOrEqual(7);
    }
  });

  it('probability=0.5 fires roughly half the time', () => {
    const rand = bugglesPrng(11);
    let fired = 0;
    for (let i = 0; i < 1000; i++) {
      if (bugglesMath.rollBurst(0.5, rand) > 0) fired++;
    }
    // Wide tolerance — PRNG variance at 1000 trials.
    expect(fired, `fired ${fired}/1000 at p=0.5`).toBeGreaterThan(420);
    expect(fired, `fired ${fired}/1000 at p=0.5`).toBeLessThan(580);
  });
});
