// packages/web/src/lib/doom/cheat-sequence.test.ts
//
// Unit coverage for the DOOM cheat-injection helpers. Both pieces are pure +
// deterministic so we test them in isolation: no WASM shim, no AudioContext,
// no timers.

import { describe, it, expect } from 'vitest';
import {
  CHEAT_CHAR_INTERVAL_MS,
  CHEAT_KEY_DOWN_MS,
  RISING_EDGE_THRESHOLD,
  cheatCodeSequence,
  detectRisingEdge,
  makeRisingEdgeState,
} from './cheat-sequence';

describe('cheatCodeSequence — lowercase ASCII byte stream for DOOM cheats', () => {
  it('IDDQD (god mode) returns the canonical 5-char sequence', () => {
    expect(cheatCodeSequence('iddqd')).toEqual(['i', 'd', 'd', 'q', 'd']);
    // Every char is lowercase + ASCII (event_t.data2 path expects no shift).
    for (const c of cheatCodeSequence('iddqd')) {
      expect(c).toMatch(/^[a-z]$/);
      expect(c.charCodeAt(0)).toBeLessThan(0x80);
    }
  });

  it('IDKFA (all keys + weapons + full ammo) returns the canonical 5-char sequence', () => {
    expect(cheatCodeSequence('idkfa')).toEqual(['i', 'd', 'k', 'f', 'a']);
    for (const c of cheatCodeSequence('idkfa')) {
      expect(c).toMatch(/^[a-z]$/);
      expect(c.charCodeAt(0)).toBeLessThan(0x80);
    }
  });
});

describe('detectRisingEdge — one-shot trigger on LOW→HIGH; held HIGH does NOT re-fire', () => {
  it('fires exactly once on the LOW→HIGH transition', () => {
    const s = makeRisingEdgeState();
    expect(detectRisingEdge(s, 0)).toBe(false);
    expect(detectRisingEdge(s, 0.2)).toBe(false); // below threshold
    expect(detectRisingEdge(s, 1)).toBe(true);    // crossed UP — fires
    expect(s.high).toBe(true);
  });

  it('does NOT re-fire while held HIGH', () => {
    const s = makeRisingEdgeState();
    expect(detectRisingEdge(s, 1)).toBe(true);
    // Hundreds of consecutive HIGH samples must not produce a second trigger.
    for (let i = 0; i < 200; i++) {
      expect(detectRisingEdge(s, 1)).toBe(false);
      expect(detectRisingEdge(s, 0.7)).toBe(false); // still above threshold
    }
    expect(s.high).toBe(true);
  });

  it('re-arms after the gate falls back below the threshold + re-fires on the next rise', () => {
    const s = makeRisingEdgeState();
    expect(detectRisingEdge(s, 1)).toBe(true);
    expect(detectRisingEdge(s, 1)).toBe(false);   // held — no re-fire
    expect(detectRisingEdge(s, 0)).toBe(false);   // falling edge — no trigger, but re-arms
    expect(s.high).toBe(false);
    expect(detectRisingEdge(s, 1)).toBe(true);    // next rise — fires again
  });

  it('uses the default threshold of 0.5', () => {
    expect(RISING_EDGE_THRESHOLD).toBe(0.5);
    const s = makeRisingEdgeState();
    expect(detectRisingEdge(s, 0.49)).toBe(false); // below default threshold
    expect(detectRisingEdge(s, 0.5)).toBe(true);   // exactly at threshold counts as HIGH
  });

  it('accepts a custom threshold', () => {
    const s = makeRisingEdgeState();
    expect(detectRisingEdge(s, 0.6, 0.9)).toBe(false); // below 0.9
    expect(detectRisingEdge(s, 0.95, 0.9)).toBe(true);
    expect(detectRisingEdge(s, 0.95, 0.9)).toBe(false); // held
  });
});

describe('Injection timing constants — shipped values', () => {
  it('inter-character delay is 50 ms (≈ 1.75 DOOM tics)', () => {
    expect(CHEAT_CHAR_INTERVAL_MS).toBe(50);
  });

  it('key-down hold is 10 ms (≥ one tic for the I_GetEvent drain to see the down + up)', () => {
    expect(CHEAT_KEY_DOWN_MS).toBe(10);
    // Gap between consecutive characters is the difference: 40 ms.
    expect(CHEAT_CHAR_INTERVAL_MS - CHEAT_KEY_DOWN_MS).toBeGreaterThan(0);
  });
});
