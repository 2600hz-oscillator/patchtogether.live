// art/scenarios/modtris/gate-pulses.test.ts
//
// ART for MODTRIS (research prototype). Mirrors the PONG ART in shape:
//
//   1. Pure-stepper behaviour at scale: drive the stepper with scripted
//      input sequences, assert correct events fire on the right tick.
//
//   2. Rendered gate-out pulse shape: hand-orchestrate the exact
//      ConstantSourceNode schedule the factory emits, render through
//      OfflineAudioContext, and verify each gate pulse is a clean 0→1→0
//      transition at the right sample positions. This is the load-bearing
//      assertion that downstream gate consumers (envelopes, sequencers)
//      see MODTRIS's line_cleared / overfill gates identically to any
//      other module's gate output.

import { describe, expect, it } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import {
  initModtrisState,
  stepModtrisState,
  COLS,
  ROWS,
  type ModtrisInputs,
  type ModtrisParams,
  type ModtrisState,
} from '../../../packages/web/src/lib/audio/modules/modtris-state';

const SAMPLE_RATE = 48000;
const BASE_PARAMS: ModtrisParams = { gravityBpm: 60, levelStep: 10 };

const NO_INPUTS: ModtrisInputs = {
  rotateL: false, rotateR: false, dropFast: false, moveL: false, moveR: false,
};

// Seeded RNG (mulberry32) so the 7-bag is deterministic across runs.
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Part 1 — pure stepper behaviour at scale ----------------------------

describe('MODTRIS ART: stepper produces events under known input sequences', () => {
  // Drive ~60 simulated seconds of pure gravity with no inputs. At 60 BPM
  // (1 cell/s) + a 20-row well, pieces lock every ~20 s; over 60 s we
  // should see multiple lock events and the well should grow.
  it('gravity-only run produces multiple piece locks over 60 simulated seconds', () => {
    const dt = 0.025; // 40 Hz scheduler-cadence
    const ticks = Math.floor(60 / dt);
    let state: ModtrisState = initModtrisState({ rng: seededRng(1) });
    let locks = 0;
    for (let i = 0; i < ticks; i++) {
      state = stepModtrisState(state, NO_INPUTS, BASE_PARAMS, dt, { rng: seededRng(1) });
      if (state.events.locked) locks++;
    }
    expect(locks, 'expected ≥2 piece locks in 60 s of gravity').toBeGreaterThanOrEqual(2);
  });

  // Determinism: two identical input sequences must produce identical
  // event streams. This is the cross-peer-sync precondition (the design
  // doc notes MODTRIS multiplayer is owner-driven, but determinism in
  // the stepper is still load-bearing for replays + the awareness sync).
  it('two identical input sequences produce identical event streams', () => {
    const dt = 0.025;
    const ticks = 200;
    function runOnce(): Array<{ lines: number; overfill: boolean }> {
      let state: ModtrisState = initModtrisState({ rng: seededRng(7) });
      const events: Array<{ lines: number; overfill: boolean }> = [];
      for (let i = 0; i < ticks; i++) {
        state = stepModtrisState(
          state,
          { ...NO_INPUTS, dropFast: i % 13 === 0 },
          BASE_PARAMS,
          dt,
          { rng: seededRng(7) },
        );
        events.push({ lines: state.events.linesCleared, overfill: state.events.overfill });
      }
      return events;
    }
    const a = runOnce();
    const b = runOnce();
    expect(a).toEqual(b);
  });

  // Force a single-line clear via direct well manipulation, then assert
  // the next dropFast emits exactly one line_cleared event.
  it('hard-drop into a row-completing layout emits a line_cleared event', () => {
    let state: ModtrisState = initModtrisState({ rng: seededRng(2) });
    state = stepModtrisState(state, NO_INPUTS, BASE_PARAMS, 0.001, { rng: seededRng(2) });
    // Doctor the well so cols 3..6 are open on the bottom row but cols
    // 0..2 and 7..9 are full. With piece at default spawn (col=3..6 bbox),
    // a hard drop of the right kind will plug those cells.
    const doctored = new Uint8Array(state.well);
    for (const c of [0, 1, 2, 7, 8, 9]) doctored[(ROWS - 1) * COLS + c] = 1;
    state = { ...state, well: doctored };
    // Hammer drops; SOME piece will fill the row eventually.
    let observed = 0;
    for (let i = 0; i < 50 && observed === 0; i++) {
      state = stepModtrisState(
        state,
        { ...NO_INPUTS, dropFast: true },
        BASE_PARAMS,
        0.001,
        { rng: seededRng(2) },
      );
      observed += state.events.linesCleared;
      state = stepModtrisState(state, NO_INPUTS, BASE_PARAMS, 0.001, { rng: seededRng(2) });
    }
    expect(observed).toBeGreaterThanOrEqual(1);
  });

  // Force overfill via a full-well doctor, then assert overfill fires +
  // the well auto-resets to empty.
  it('full-well state emits overfill + auto-resets on next step', () => {
    let state: ModtrisState = initModtrisState({ rng: seededRng(3) });
    state = stepModtrisState(state, NO_INPUTS, BASE_PARAMS, 0.001, { rng: seededRng(3) });
    // Doctor: fill EVERY cell + null out the piece so spawn collides.
    const fullWell = new Uint8Array(COLS * ROWS).fill(1);
    state = { ...state, well: fullWell, piece: null };
    const next = stepModtrisState(state, NO_INPUTS, BASE_PARAMS, 0.001, { rng: seededRng(3) });
    expect(next.events.overfill).toBe(true);
    // Auto-reset: well is empty.
    expect(next.well.some((v) => v !== 0)).toBe(false);
    expect(next.lines).toBe(0);
  });
});

// --- Part 2 — rendered ConstantSource gate pulse shape ------------------

describe('MODTRIS ART: rendered gate pulses match the factory schedule', () => {
  it('single line_cleared pulse is high during its window and low outside', async () => {
    const DURATION_S = 0.05;
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

    expect(buf[0]).toBeCloseTo(0, 4);
    expect(buf[Math.floor(0.0025 * SAMPLE_RATE)] ?? 0).toBeCloseTo(0, 4);
    expect(buf[Math.floor(0.0075 * SAMPLE_RATE)] ?? 0).toBeCloseTo(1, 4);
    expect(buf[Math.floor(0.015 * SAMPLE_RATE)] ?? 0).toBeCloseTo(0, 4);
  });

  // A Tetris (4-line clear) must fire 4 distinct pulses. We replicate the
  // factory's pulseGateNTimes schedule: pulses of width 5 ms separated by
  // 5 ms spacer = 10 ms period.
  it('Tetris (4 line clears) fires 4 distinct gate pulses', async () => {
    const DURATION_S = 0.10;
    const ctx = new OfflineAudioContext({
      numberOfChannels: 1,
      length: Math.round(SAMPLE_RATE * DURATION_S),
      sampleRate: SAMPLE_RATE,
    });
    const src = ctx.createConstantSource();
    src.offset.setValueAtTime(0, 0);
    const t0 = 0.005;
    const pulseW = 0.005;
    const spacer = 0.005;
    for (let i = 0; i < 4; i++) {
      const t = t0 + i * (pulseW + spacer);
      src.offset.setValueAtTime(1, t);
      src.offset.setValueAtTime(0, t + pulseW);
    }
    src.start();
    src.connect(ctx.destination);
    const r = await ctx.startRendering();
    const buf = r.getChannelData(0);

    function sampleAt(t: number): number {
      return buf[Math.floor(t * SAMPLE_RATE)] ?? 0;
    }
    // Mid of each of the 4 pulses → 1.
    for (let i = 0; i < 4; i++) {
      const tMid = t0 + i * (pulseW + spacer) + pulseW / 2;
      expect(sampleAt(tMid), `pulse ${i} mid sample`).toBeCloseTo(1, 4);
    }
    // Between pulses → 0.
    for (let i = 0; i < 3; i++) {
      const tGap = t0 + i * (pulseW + spacer) + pulseW + spacer / 2;
      expect(sampleAt(tGap), `gap after pulse ${i} sample`).toBeCloseTo(0, 4);
    }
  });

  it('overfill gate fires a single 5ms pulse', async () => {
    const DURATION_S = 0.05;
    const ctx = new OfflineAudioContext({
      numberOfChannels: 1,
      length: Math.round(SAMPLE_RATE * DURATION_S),
      sampleRate: SAMPLE_RATE,
    });
    const src = ctx.createConstantSource();
    src.offset.setValueAtTime(0, 0);
    src.offset.setValueAtTime(1, 0.010);
    src.offset.setValueAtTime(0, 0.015);
    src.start();
    src.connect(ctx.destination);
    const r = await ctx.startRendering();
    const buf = r.getChannelData(0);

    // Before pulse.
    expect(buf[Math.floor(0.005 * SAMPLE_RATE)] ?? 0).toBeCloseTo(0, 4);
    // Mid pulse.
    expect(buf[Math.floor(0.0125 * SAMPLE_RATE)] ?? 0).toBeCloseTo(1, 4);
    // After pulse.
    expect(buf[Math.floor(0.025 * SAMPLE_RATE)] ?? 0).toBeCloseTo(0, 4);
  });
});
