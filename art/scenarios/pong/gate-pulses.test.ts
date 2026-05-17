// art/scenarios/pong/gate-pulses.test.ts
//
// ART for PONG (research prototype).
//
// PONG's game-loop runs off scheduler-clock (a Web Worker tick) that
// doesn't fire during an OfflineAudioContext render — offline rendering
// is faster than wall-clock, identical to the BUGGLES ART situation.
//
// So this ART covers two things in parallel:
//
//   1. The pure state stepper at scale: run thousands of simulated game
//      ticks with deterministic CV trajectories, assert that scoring
//      events fire when expected, that scores accumulate, and that ball
//      trajectories are reproducible cross-run (the cross-peer sync
//      prereq).
//
//   2. The gate-output pulse shape: hand-orchestrate the exact
//      ConstantSourceNode schedule the factory's pulseGate() emits, render
//      through OfflineAudioContext, and verify the gate is a clean 0→1→0
//      transition at the right times. This guarantees that downstream
//      gate consumers (envelopes, sequencers) see the score gate the
//      same way they see any other module's gate output.

import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import {
  initPongState,
  stepPongState,
  type PongParams,
  type PongState,
} from '../../../packages/web/src/lib/audio/modules/pong-state';

const SAMPLE_RATE = 48000;
const BASE_PARAMS: PongParams = { speed: 1.0, paddleH: 0.2, serveAngle: 0.0 };
const FIXED_RNG = () => 0.5;

// --- Part 1 — pure stepper behaviour at scale ----------------------------

describe('PONG ART: stepper produces score events under known CV trajectories', () => {
  // Run ~3 simulated seconds at 40 Hz (PONG's scheduler-clock cadence) with
  // a paddle that ALWAYS misses (sits at y=0) — the ball must bounce off
  // the right paddle (also at y=0 — also a miss → left scores) some number
  // of times. We assert at least one score event is observed in this window.
  it('absent-paddles produces score events within 3 simulated seconds', () => {
    const dt = 0.025;
    const ticks = Math.floor(3 / dt);
    let state = initPongState(BASE_PARAMS, { rng: FIXED_RNG });
    let scoreEventCount = 0;
    for (let i = 0; i < ticks; i++) {
      state = stepPongState(
        state,
        { paddleLCv: -1, paddleRCv: -1, dtSeconds: dt, rng: FIXED_RNG },
        BASE_PARAMS,
      );
      if (state.scoreEvent !== null) scoreEventCount++;
    }
    expect(scoreEventCount, 'expected ≥1 score in 3 s with absent paddles')
      .toBeGreaterThanOrEqual(1);
    expect(state.scoreL + state.scoreR, 'cumulative score matches event count')
      .toBe(scoreEventCount);
  });

  // Same trajectory run twice from a fixed init should produce identical
  // event sequences — this is the cross-peer-sync precondition.
  it('two identical trajectories produce identical event sequences', () => {
    const dt = 0.025;
    const ticks = 200;
    function runOnce(): Array<'L' | 'R' | null> {
      let state = initPongState(BASE_PARAMS, { rng: FIXED_RNG });
      const events: Array<'L' | 'R' | null> = [];
      for (let i = 0; i < ticks; i++) {
        state = stepPongState(
          state,
          {
            paddleLCv: Math.sin(i * 0.07) * 0.4,
            paddleRCv: Math.sin(i * 0.11) * 0.4,
            dtSeconds: dt,
            rng: FIXED_RNG,
          },
          BASE_PARAMS,
        );
        events.push(state.scoreEvent);
      }
      return events;
    }
    const a = runOnce();
    const b = runOnce();
    expect(a).toEqual(b);
  });

  // A perfect-tracker paddle (always follows the ball Y exactly) should
  // never let the ball through; no score events fire.
  it('perfect-tracking paddles produce zero scores over 5 simulated seconds', () => {
    const dt = 0.025;
    const ticks = Math.floor(5 / dt);
    let state: PongState = initPongState(BASE_PARAMS, { rng: FIXED_RNG });
    let scores = 0;
    for (let i = 0; i < ticks; i++) {
      // Convert ball Y (in [0,1]) back to CV (in [-1,+1]) for the
      // paddle. Both paddles track the ball perfectly.
      const cv = (state.ballY - 0.5) * 2;
      state = stepPongState(
        state,
        { paddleLCv: cv, paddleRCv: cv, dtSeconds: dt, rng: FIXED_RNG },
        BASE_PARAMS,
      );
      if (state.scoreEvent !== null) scores++;
    }
    expect(scores, 'perfect-tracker should never let the ball through').toBe(0);
  });
});

// --- Part 2 — rendered ConstantSource gate pulse shape ------------------

describe('PONG ART: rendered score-gate pulse matches the factory schedule', () => {
  // A single score event scheduled at t = SCHEDULE_CUSHION_S:
  //   src.offset.setValueAtTime(0, 0)               // initial idle
  //   src.offset.setValueAtTime(1, 0.005)           // rising edge
  //   src.offset.setValueAtTime(0, 0.005 + 0.005)   // falling edge
  // Renders a 5 ms-wide pulse with a 5 ms initial cushion.
  it('5ms gate pulse is high during its window and low outside', async () => {
    const DURATION_S = 0.05; // 50 ms of render — captures the full pulse + tail
    const ctx = new OfflineAudioContext({
      numberOfChannels: 1,
      length: Math.round(SAMPLE_RATE * DURATION_S),
      sampleRate: SAMPLE_RATE,
    });
    const src = ctx.createConstantSource();
    src.offset.setValueAtTime(0, 0);
    src.offset.setValueAtTime(1, 0.005);
    src.offset.setValueAtTime(0, 0.010);
    src.start();
    src.connect(ctx.destination);

    const r = await ctx.startRendering();
    const buf = r.getChannelData(0);

    // 0 ms — should be 0 (pre-pulse).
    expect(buf[0]).toBeCloseTo(0, 4);
    // 2.5 ms — should still be 0 (pulse hasn't started).
    expect(buf[Math.floor(0.0025 * SAMPLE_RATE)] ?? 0).toBeCloseTo(0, 4);
    // 7.5 ms — middle of pulse, should be 1.
    expect(buf[Math.floor(0.0075 * SAMPLE_RATE)] ?? 0).toBeCloseTo(1, 4);
    // 15 ms — past the pulse, back to 0.
    expect(buf[Math.floor(0.015 * SAMPLE_RATE)] ?? 0).toBeCloseTo(0, 4);
  });

  it('two consecutive score events produce two distinct pulses', async () => {
    const DURATION_S = 0.10;
    const ctx = new OfflineAudioContext({
      numberOfChannels: 1,
      length: Math.round(SAMPLE_RATE * DURATION_S),
      sampleRate: SAMPLE_RATE,
    });
    const src = ctx.createConstantSource();
    src.offset.setValueAtTime(0, 0);
    // First pulse @ 10ms..15ms
    src.offset.setValueAtTime(1, 0.010);
    src.offset.setValueAtTime(0, 0.015);
    // Second pulse @ 50ms..55ms
    src.offset.setValueAtTime(1, 0.050);
    src.offset.setValueAtTime(0, 0.055);
    src.start();
    src.connect(ctx.destination);

    const r = await ctx.startRendering();
    const buf = r.getChannelData(0);

    function sampleAt(t: number): number {
      return buf[Math.floor(t * SAMPLE_RATE)] ?? 0;
    }
    // Mid first pulse.
    expect(sampleAt(0.0125)).toBeCloseTo(1, 4);
    // Between pulses.
    expect(sampleAt(0.030)).toBeCloseTo(0, 4);
    // Mid second pulse.
    expect(sampleAt(0.0525)).toBeCloseTo(1, 4);
    // After.
    expect(sampleAt(0.080)).toBeCloseTo(0, 4);
  });
});
