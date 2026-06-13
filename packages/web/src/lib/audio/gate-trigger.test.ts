// packages/web/src/lib/audio/gate-trigger.test.ts
//
// Pins the canonical trigger/gate constants + the emitted waveform shapes
// (short triangle trigger / held square gate) used across the app.

import { describe, it, expect } from 'vitest';
import {
  GATE_HI,
  GATE_LO,
  TRIGGER_PULSE_S,
  DEFAULT_GATE_LEN_S,
  fireTrigger,
  openGate,
  closeGate,
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
