// packages/web/src/lib/doom/cv-gate-edge.test.ts
//
// Edge-detector hysteresis. Pure function, easy to test.

import { describe, it, expect } from 'vitest';
import { detectEdge, makeEdgeState, DEFAULT_FALL, DEFAULT_RISE } from './cv-gate-edge';

describe('detectEdge — hysteresis CV → key-event', () => {
  it('emits key-down when sample crosses the rise threshold from below', () => {
    const s = makeEdgeState();
    expect(detectEdge(s, 0.1)).toBeNull();
    expect(s.pressed).toBe(false);
    expect(detectEdge(s, 0.5)).toBeNull();      // dead-band
    expect(s.pressed).toBe(false);
    expect(detectEdge(s, 0.61)).toEqual({ pressed: true });
    expect(s.pressed).toBe(true);
  });

  it('emits key-up when sample crosses the fall threshold from above', () => {
    const s = makeEdgeState();
    s.pressed = true;
    expect(detectEdge(s, 0.5)).toBeNull();      // dead-band
    expect(s.pressed).toBe(true);
    expect(detectEdge(s, 0.39)).toEqual({ pressed: false });
    expect(s.pressed).toBe(false);
  });

  it('does NOT re-fire when sample stays above rise threshold (sticky)', () => {
    const s = makeEdgeState();
    expect(detectEdge(s, 0.7)).toEqual({ pressed: true });
    // 100 more samples all above rise — no event.
    for (let i = 0; i < 100; i++) {
      expect(detectEdge(s, 0.65 + Math.random() * 0.3)).toBeNull();
    }
  });

  it('chatter around 0.5 does NOT emit events (hysteresis absorbs)', () => {
    const s = makeEdgeState();
    // Hover in the dead band (0.4 < x < 0.6) → no event.
    for (let i = 0; i < 100; i++) {
      const sample = 0.4 + Math.random() * 0.2;  // 0.4..0.6
      expect(detectEdge(s, sample)).toBeNull();
    }
    expect(s.pressed).toBe(false);
  });

  it('one rise-fall cycle emits exactly one key-down then one key-up', () => {
    const s = makeEdgeState();
    const events: Array<{ pressed: boolean } | null> = [];
    for (const sample of [0.0, 0.3, 0.5, 0.61, 0.8, 0.7, 0.45, 0.38, 0.1, 0.0]) {
      events.push(detectEdge(s, sample));
    }
    const filtered = events.filter((e) => e !== null);
    expect(filtered).toEqual([
      { pressed: true },
      { pressed: false },
    ]);
  });

  it('custom thresholds widen / narrow the dead band', () => {
    const s = makeEdgeState();
    // Tight dead band at [0.49, 0.51].
    expect(detectEdge(s, 0.52, 0.51, 0.49)).toEqual({ pressed: true });
    expect(detectEdge(s, 0.50, 0.51, 0.49)).toBeNull();
    expect(detectEdge(s, 0.48, 0.51, 0.49)).toEqual({ pressed: false });
  });

  it('defaults match the project rise=0.6 / fall=0.4 contract', () => {
    expect(DEFAULT_RISE).toBe(0.6);
    expect(DEFAULT_FALL).toBe(0.4);
  });

  // --- Bipolar / gamepad-shaped sources (the DOOM movement-input case) ---
  // The bridge passes a gate-style cv through RAW (see cv-bridge-map.ts), so
  // the detector sees the source's native range. A bipolar LFO swings -1..+1
  // and a gamepad axis/button reads ±1; a FULL swing must press AND release.

  it('a bipolar ±1 LFO swing presses on the up-half and releases on the down-half', () => {
    const s = makeEdgeState();
    const events: Array<{ pressed: boolean } | null> = [];
    // One LFO cycle sampled: rises through +1, falls through -1, back up.
    for (const sample of [0.0, 0.5, 0.9, 1.0, 0.5, -0.5, -1.0, -0.5, 0.0]) {
      events.push(detectEdge(s, sample));
    }
    const filtered = events.filter((e) => e !== null);
    expect(filtered).toEqual([
      { pressed: true },   // crossed +0.6 going up
      { pressed: false },  // crossed +0.4 going down (into negative territory)
    ]);
  });

  it('a gamepad-shaped step from -1 (rest) to +1 (held) to -1 (released) toggles once each way', () => {
    const s = makeEdgeState();
    // Gamepad axes/buttons jump rather than ramp; the detector still works.
    expect(detectEdge(s, -1)).toBeNull();              // at rest
    expect(detectEdge(s, 1)).toEqual({ pressed: true }); // pressed
    expect(detectEdge(s, 1)).toBeNull();                // held, no re-fire
    expect(detectEdge(s, -1)).toEqual({ pressed: false }); // released
    expect(detectEdge(s, -1)).toBeNull();               // stays released
  });

  it('a unipolar 0/1 gate (gamepad button → ConstantSource) presses and releases', () => {
    const s = makeEdgeState();
    expect(detectEdge(s, 0)).toBeNull();
    expect(detectEdge(s, 1)).toEqual({ pressed: true });
    expect(detectEdge(s, 0)).toEqual({ pressed: false });
  });
});
