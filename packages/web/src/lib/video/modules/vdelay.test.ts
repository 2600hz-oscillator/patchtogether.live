// packages/web/src/lib/video/modules/vdelay.test.ts
//
// Unit tests for VDELAY's pure ring-buffer math. The GL-side draw is
// covered by the e2e video-chain tests; here we verify just the index
// + per-frame value math the shader implements in fixed-point.

import { describe, it, expect } from 'vitest';
import {
  VDELAY_BUFFER_FRAMES,
  vdelayMix,
  vdelaySlotValue,
  vdelayTapIndex,
} from './vdelay';

describe('vdelayTapIndex', () => {
  it('reads the slot N frames behind head', () => {
    const size = VDELAY_BUFFER_FRAMES;
    expect(vdelayTapIndex(10, 1, size)).toBe(9);
    expect(vdelayTapIndex(10, 4, size)).toBe(6);
    expect(vdelayTapIndex(0, 1, size)).toBe(size - 1);
    expect(vdelayTapIndex(0, 4, size)).toBe(size - 4);
  });

  it('wraps modulo buffer size', () => {
    const size = 8;
    // head=2, dt=5 → (2 - 5 + 8) % 8 = 5
    expect(vdelayTapIndex(2, 5, size)).toBe(5);
  });

  it('clamps delay to [1, size-1] so the tap never aliases the head slot', () => {
    const size = 8;
    expect(vdelayTapIndex(3, 0, size)).toBe(2);   // floor to 1
    expect(vdelayTapIndex(3, 999, size)).toBe(((3 - 7) % 8 + 8) % 8); // = 4
  });
});

describe('vdelaySlotValue', () => {
  it('input passes through when feedback=0', () => {
    expect(vdelaySlotValue(0.5, 0.9, 0)).toBeCloseTo(0.5);
    expect(vdelaySlotValue(0.0, 0.9, 0)).toBeCloseTo(0.0);
  });

  it('echo decays with each generation at feedback < 1', () => {
    // Simulate 3 generations of echo with no fresh input.
    let slot = 0.8;
    const fb = 0.5;
    slot = vdelaySlotValue(0, slot, fb); // gen 1: 0.4
    slot = vdelaySlotValue(0, slot, fb); // gen 2: 0.2
    slot = vdelaySlotValue(0, slot, fb); // gen 3: 0.1
    expect(slot).toBeCloseTo(0.1);
  });

  it('caps feedback at 0.95 to prevent runaway', () => {
    // Even with an absurd fb arg, slot value stays bounded.
    const v = vdelaySlotValue(0.5, 0.9, 5);
    // fb is clamped to 0.95, so result = clamp(0.5 + 0.9 * 0.95, 0, 1)
    // = clamp(1.355, 0, 1) = 1.0
    expect(v).toBeCloseTo(1.0);
  });

  it('clamps slot value to [0, 1]', () => {
    expect(vdelaySlotValue(0.6, 0.9, 0.9)).toBeCloseTo(1.0); // saturates
    expect(vdelaySlotValue(0, 0, 0.5)).toBe(0);
  });
});

describe('vdelayMix', () => {
  it('mix=0 yields pure dry', () => {
    expect(vdelayMix(0.5, 0.9, 0)).toBeCloseTo(0.5);
  });

  it('mix=1 yields pure wet', () => {
    expect(vdelayMix(0.5, 0.9, 1)).toBeCloseTo(0.9);
  });

  it('mix=0.5 yields midpoint', () => {
    expect(vdelayMix(0.4, 0.8, 0.5)).toBeCloseTo(0.6);
  });

  it('clamps mix to [0,1]', () => {
    expect(vdelayMix(0.5, 0.9, -1)).toBeCloseTo(0.5);
    expect(vdelayMix(0.5, 0.9, 2)).toBeCloseTo(0.9);
  });
});

describe('vdelay end-to-end ring simulation', () => {
  it('input at frame N appears at the output exactly N frames later when feedback=0, mix=1', () => {
    // Pure-arithmetic simulation: ring of size 8, delayTime=4, feedback=0,
    // so each ring slot equals its frame's input. After 4 frames of cold
    // start, frame F's input should appear in the tap at frame F+4.
    const SIZE = 8;
    const DELAY = 4;
    const ring = new Array(SIZE).fill(0);
    let head = 0;
    const inputs = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    const outputs: number[] = [];

    for (let f = 0; f < inputs.length; f++) {
      const tapIdx = vdelayTapIndex(head, DELAY, SIZE);
      const tap = ring[tapIdx];
      // Write to head (feedback=0 → slot equals input).
      ring[head] = vdelaySlotValue(inputs[f]!, tap, 0);
      // Compose with mix=1 (pure wet).
      outputs.push(vdelayMix(inputs[f]!, tap, 1));
      head = (head + 1) % SIZE;
    }

    // First DELAY outputs are zero (buffer hasn't filled yet).
    for (let f = 0; f < DELAY; f++) expect(outputs[f]).toBe(0);
    // After cold start, output at frame F = input from frame F - DELAY.
    for (let f = DELAY; f < inputs.length; f++) {
      expect(outputs[f]).toBeCloseTo(inputs[f - DELAY]!);
    }
  });

  it('feedback echoes accumulate: with feedback=0.5, after 2N frames the echo is half the original', () => {
    const SIZE = 16;
    const DELAY = 4;
    const FB = 0.5;
    const ring = new Array(SIZE).fill(0);
    let head = 0;

    // One bright pulse on frame 0; zeros forever after.
    const inputs = [1.0, ...new Array(20).fill(0)];
    const tapValues: number[] = [];

    for (let f = 0; f < inputs.length; f++) {
      const tapIdx = vdelayTapIndex(head, DELAY, SIZE);
      const tap = ring[tapIdx];
      tapValues.push(tap);
      ring[head] = vdelaySlotValue(inputs[f]!, tap, FB);
      head = (head + 1) % SIZE;
    }

    // The pulse arrived at the tap at frame DELAY = 4 (value 1.0).
    expect(tapValues[DELAY]).toBeCloseTo(1.0);
    // Then the slot at the original head got input(0)=1 + tap(0)*0.5 = 1.0 (saturated).
    // Frame 0's slot value was actually 1.0 (input + 0).
    // 4 frames later (frame 4) we read that slot = 1.0 — matches above.
    // 8 frames later (frame 8) we read the slot written at frame 4, which
    // was input(0) + tap(0=1.0)*0.5 = 0 + 0.5 = 0.5 — first echo at half.
    expect(tapValues[2 * DELAY]).toBeCloseTo(0.5);
    // Frame 12: third generation, halved again.
    expect(tapValues[3 * DELAY]).toBeCloseTo(0.25);
  });
});
