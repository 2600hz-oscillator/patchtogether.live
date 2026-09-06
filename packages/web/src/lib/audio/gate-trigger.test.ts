// packages/web/src/lib/audio/gate-trigger.test.ts
//
// Pins the canonical trigger/gate constants + the emitted waveform shapes
// (short triangle trigger / held square gate) used across the app.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GATE_HI,
  GATE_LO,
  TRIGGER_PULSE_S,
  DEFAULT_GATE_LEN_S,
  fireTrigger,
  openGate,
  closeGate,
  pulseTriggerNow,
} from './gate-trigger';

interface SchedCall {
  method: 'setValueAtTime' | 'linearRampToValueAtTime';
  value: number;
  time: number;
}

function fakeCs(): { cs: ConstantSourceNode; calls: SchedCall[] } {
  const calls: SchedCall[] = [];
  const offset = {
    setValueAtTime(value: number, time: number) {
      calls.push({ method: 'setValueAtTime', value, time });
      return this;
    },
    linearRampToValueAtTime(value: number, time: number) {
      calls.push({ method: 'linearRampToValueAtTime', value, time });
      return this;
    },
  };
  return { cs: { offset } as unknown as ConstantSourceNode, calls };
}

describe('gate-trigger constants', () => {
  it('match the historical detector thresholds + hardware-grounded widths', () => {
    expect(GATE_HI).toBe(0.5);
    expect(GATE_LO).toBe(0.5); // single-threshold (windowing-only) for now
    expect(TRIGGER_PULSE_S).toBeCloseTo(0.005, 6); // 5 ms — within 1–5 ms band
    expect(DEFAULT_GATE_LEN_S).toBeCloseTo(0.05, 6); // 50 ms min derived gate
  });
});

describe('fireTrigger — short pulse', () => {
  it('triangle: 0 → peak(1) at mid → 0 at end, one clean GATE_HI crossing', () => {
    const { cs, calls } = fakeCs();
    fireTrigger(cs, 2.0); // default width + triangle
    expect(calls).toEqual([
      { method: 'setValueAtTime', value: 0, time: 2.0 },
      { method: 'linearRampToValueAtTime', value: 1, time: 2.0 + TRIGGER_PULSE_S / 2 },
      { method: 'linearRampToValueAtTime', value: 0, time: 2.0 + TRIGGER_PULSE_S },
    ]);
    // The peak (1) clears GATE_HI, so a downstream edge detector sees one rise.
    expect(calls[1]!.value).toBeGreaterThan(GATE_HI);
  });

  it('square: flat-topped pulse of the requested width', () => {
    const { cs, calls } = fakeCs();
    fireTrigger(cs, 1.0, 0.01, 'square');
    expect(calls).toEqual([
      { method: 'setValueAtTime', value: 0, time: 1.0 },
      { method: 'setValueAtTime', value: 1, time: 1.0 },
      { method: 'setValueAtTime', value: 0, time: 1.01 },
    ]);
  });
});

describe('openGate / closeGate — held level', () => {
  it('open holds high, close drops to 0', () => {
    const { cs, calls } = fakeCs();
    openGate(cs, 3.0);
    closeGate(cs, 3.5);
    expect(calls).toEqual([
      { method: 'setValueAtTime', value: 1, time: 3.0 },
      { method: 'setValueAtTime', value: 0, time: 3.5 },
    ]);
  });
});

// ── pulseTriggerNow — the render-robust NOW pulse ───────────────────────────
//
// The claims under test mirror the mechanism note on the implementation:
//   1. the RISE is a direct value write (the only form measured to always
//      render), applied synchronously;
//   2. the FALL waits for RENDERED AUDIO progress (currentTime advance), not
//      wall clock — a starved context keeps the line high (pulse widens,
//      never vanishes);
//   3. a retrigger while high extends rather than stacking a second fall;
//   4. the wall-clock BACKSTOP bounds the failure if the context clock stops.
describe('pulseTriggerNow — render-robust immediate pulse', () => {
  interface FakeNowCs {
    cs: ConstantSourceNode;
    offset: { value: number; cancelScheduledValues: ReturnType<typeof vi.fn> };
    clock: { t: number };
  }
  function fakeNowCs(): FakeNowCs {
    const clock = { t: 1.0 };
    const offset = { value: 0, cancelScheduledValues: vi.fn() };
    const cs = {
      offset,
      context: { get currentTime() { return clock.t; } },
    } as unknown as ConstantSourceNode;
    return { cs, offset, clock };
  }

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers(); });

  it('rises synchronously via a direct value write (and clears stale automation)', () => {
    const { cs, offset } = fakeNowCs();
    pulseTriggerNow(cs, 0.01);
    expect(offset.value).toBe(1);
    expect(offset.cancelScheduledValues).toHaveBeenCalled();
  });

  it('holds high while NO audio has rendered — wall time alone never drops it', () => {
    const { cs, offset } = fakeNowCs();
    pulseTriggerNow(cs, 0.01);
    vi.advanceTimersByTime(500); // clock.t untouched: zero rendered audio
    expect(offset.value).toBe(1);
  });

  it('falls only after ≥ width of RENDERED audio', () => {
    const { cs, offset, clock } = fakeNowCs();
    pulseTriggerNow(cs, 0.01);
    clock.t += 0.005; // less than width
    vi.advanceTimersByTime(20);
    expect(offset.value).toBe(1);
    clock.t += 0.02; // now well past width + slack
    vi.advanceTimersByTime(20);
    expect(offset.value).toBe(0);
  });

  it('a retrigger while high EXTENDS the pulse from the fresh rise', () => {
    const { cs, offset, clock } = fakeNowCs();
    pulseTriggerNow(cs, 0.01);
    clock.t += 0.01; // almost due to fall
    pulseTriggerNow(cs, 0.01); // retrigger — restarts the width window
    vi.advanceTimersByTime(20);
    expect(offset.value).toBe(1); // old window elapsed, new one governs
    clock.t += 0.02;
    vi.advanceTimersByTime(20);
    expect(offset.value).toBe(0);
  });

  it('wall-clock backstop drops a pulse whose context clock stopped', () => {
    const { cs, offset } = fakeNowCs();
    pulseTriggerNow(cs, 0.01);
    vi.advanceTimersByTime(2100); // > PULSE_FALL_BACKSTOP_MS, zero rendered audio
    expect(offset.value).toBe(0);
  });
});
