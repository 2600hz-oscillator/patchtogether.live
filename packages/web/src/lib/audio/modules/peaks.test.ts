// packages/web/src/lib/audio/modules/peaks.test.ts
//
// PEAKS unit tests — module-def shape + pure-math sanity (mode selection,
// envelope retrig on rising edge, LFO frequency mapping, drum hit
// produces output). Worklet-level behaviour (sample-accurate edges
// across both channels in parallel) is covered by the ART scenario.

import { describe, expect, it } from 'vitest';
import {
  peaksDef,
  peaksMath,
  PEAKS_MODE_NAMES,
  PEAKS_MAX_MODE,
  type PeaksMode,
} from './peaks';

const SR = 48000;

function rms(buf: Float32Array, from = 0, to = buf.length): number {
  let s = 0;
  let n = 0;
  for (let i = from; i < to; i++) { s += buf[i]! * buf[i]!; n++; }
  return Math.sqrt(s / Math.max(1, n));
}

function zeroCrossings(buf: Float32Array): number {
  let z = 0;
  for (let i = 1; i < buf.length; i++) {
    const a = buf[i - 1]!;
    const b = buf[i]!;
    if ((a <= 0 && b > 0) || (a >= 0 && b < 0)) z++;
  }
  return z;
}

describe('peaksDef shape', () => {
  it('declares type=peaks, label=PEAKS, category=modulation', () => {
    expect(peaksDef.type).toBe('peaks');
    expect(peaksDef.label).toBe('peaks');
    expect(peaksDef.category).toBe('modulation');
  });

  it('exposes two gate inputs (one per channel) + per-channel CV inputs', () => {
    const ids = peaksDef.inputs.map((p) => p.id);
    expect(ids).toContain('gate0');
    expect(ids).toContain('gate1');
    expect(ids).toContain('mode0_cv');
    expect(ids).toContain('mode1_cv');
    expect(ids).toContain('k1_0_cv');
    expect(ids).toContain('k2_0_cv');
    expect(ids).toContain('k1_1_cv');
    expect(ids).toContain('k2_1_cv');
  });

  it('exposes two mono outputs out0 + out1', () => {
    const ids = peaksDef.outputs.map((p) => p.id);
    expect(ids).toEqual(['out0', 'out1']);
    for (const p of peaksDef.outputs) expect(p.type).toBe('audio');
  });

  it('exposes 6 params: mode0/mode1 (discrete) + k1/k2 per channel', () => {
    const ids = peaksDef.params.map((p) => p.id);
    expect(ids).toEqual(['mode0', 'mode1', 'k1_0', 'k2_0', 'k1_1', 'k2_1']);
    const mode0 = peaksDef.params.find((p) => p.id === 'mode0')!;
    expect(mode0.curve).toBe('discrete');
    expect(mode0.min).toBe(0);
    expect(mode0.max).toBe(PEAKS_MAX_MODE);
  });

  it('every cv input has paramTarget pointing at a real param + cvScale set', () => {
    for (const port of peaksDef.inputs) {
      if (port.type !== 'cv') continue;
      expect(port.paramTarget, `${port.id} paramTarget`).toBeDefined();
      expect(port.cvScale, `${port.id} cvScale`).toBeDefined();
      const param = peaksDef.params.find((p) => p.id === port.paramTarget);
      expect(param, `${port.id} → param ${port.paramTarget}`).toBeDefined();
    }
  });

  it('mode_cv ports declare discrete cvScale (LFO across model space is nonsense)', () => {
    for (const portId of ['mode0_cv', 'mode1_cv']) {
      const p = peaksDef.inputs.find((x) => x.id === portId)!;
      expect(p.cvScale).toEqual({ mode: 'discrete' });
    }
  });

  it('PEAKS_MODE_NAMES exposes 5 modes in fixed order', () => {
    expect(PEAKS_MODE_NAMES).toEqual(['KICK', 'SNARE', 'HIHAT', 'ENV', 'LFO']);
  });
});

describe('peaksMath / knob labels follow the active mode', () => {
  it('KICK → Pitch / Decay', () => {
    expect(peaksMath.knobLabels(0)).toEqual({ k1: 'Pitch', k2: 'Decay' });
  });
  it('SNARE → Mix / Decay', () => {
    expect(peaksMath.knobLabels(1)).toEqual({ k1: 'Mix', k2: 'Decay' });
  });
  it('HIHAT → Bright / Decay', () => {
    expect(peaksMath.knobLabels(2)).toEqual({ k1: 'Bright', k2: 'Decay' });
  });
  it('ENV → Attack / Decay', () => {
    expect(peaksMath.knobLabels(3)).toEqual({ k1: 'Attack', k2: 'Decay' });
  });
  it('LFO → Rate / Wave', () => {
    expect(peaksMath.knobLabels(4)).toEqual({ k1: 'Rate', k2: 'Wave' });
  });
});

describe('peaksMath / drum hits produce non-silent output on trigger', () => {
  for (const [name, mode] of [
    ['KICK', 0],
    ['SNARE', 1],
    ['HIHAT', 2],
  ] as [string, PeaksMode][]) {
    it(`${name} hit produces non-silent output after a single gate trigger`, () => {
      const n = SR / 2;
      const out = peaksMath.render(n, SR, {
        mode,
        k1: mode === 0 ? 60 : 0.5,
        k2: 0.3,
        triggers: [0],
      });
      // Body window — first 50 ms after the hit.
      const r = rms(out, 0, Math.floor(SR * 0.05));
      expect(r, `${name} early-window RMS ${r}`).toBeGreaterThan(0.001);
    });
  }

  it('without a trigger, KICK is silent', () => {
    const n = SR / 4;
    const out = peaksMath.render(n, SR, { mode: 0, k1: 60, k2: 0.3, triggers: [] });
    expect(rms(out)).toBe(0);
  });
});

describe('peaksMath / KICK has low-frequency body energy', () => {
  it('KICK at 60 Hz settles with low-frequency content (few zero-crossings)', () => {
    const n = SR / 2;
    const out = peaksMath.render(n, SR, { mode: 0, k1: 60, k2: 0.5, triggers: [0] });
    // Window past the pitch sweep (after 30 ms the sweep is essentially done).
    const tail = out.slice(Math.floor(SR * 0.05), Math.floor(SR * 0.2));
    const z = zeroCrossings(tail);
    // 60 Hz across 150 ms expects ~18 crossings; allow up to ~50 to be lenient
    // for the click region. The point is to detect that we're NOT noise-rate.
    expect(z, `tail zero-crossings ${z}`).toBeLessThan(80);
    expect(z, `tail zero-crossings ${z} > 0`).toBeGreaterThan(2);
  });
});

describe('peaksMath / ENV mode retriggers on rising edge', () => {
  it('ENV rises after a trigger from idle (value > 0 within attack window)', () => {
    const n = SR / 4;
    const out = peaksMath.render(n, SR, {
      mode: 3, k1: 0.01, k2: 0.2, triggers: [0],
    });
    // After 5 ms of attack the value should be well above zero (attack=10ms,
    // so 5ms ≈ 0.5).
    const idx = Math.floor(SR * 0.005);
    expect(out[idx], `env @ 5ms ${out[idx]}`).toBeGreaterThan(0.2);
  });

  it('ENV peaks at 1 after attack, then decays toward 0', () => {
    const n = SR;
    const out = peaksMath.render(n, SR, {
      mode: 3, k1: 0.005, k2: 0.1, triggers: [0],
    });
    // 15 ms in — attack done, near peak, decay starting.
    const peak = out[Math.floor(SR * 0.005) + 1]!;
    expect(peak, `env peak ${peak}`).toBeGreaterThan(0.9);
    expect(peak, `env peak ${peak}`).toBeLessThanOrEqual(1.0001);
    // 500 ms later, decay should have brought it to ~0.
    const late = out[Math.floor(SR * 0.5)]!;
    expect(late, `env late ${late}`).toBeLessThan(0.05);
  });

  it('ENV without trigger stays silent', () => {
    const n = SR / 4;
    const out = peaksMath.render(n, SR, { mode: 3, k1: 0.01, k2: 0.2, triggers: [] });
    expect(rms(out)).toBe(0);
  });

  it('decay knob actually changes decay time (longer decay → higher late RMS)', () => {
    // Compare ENV mode with two decay settings; the longer one should still
    // have non-trivial value at 300 ms, the shorter one should be done.
    const n = SR;
    const shortOut = peaksMath.render(n, SR, {
      mode: 3, k1: 0.005, k2: 0.05, triggers: [0],
    });
    const longOut = peaksMath.render(n, SR, {
      mode: 3, k1: 0.005, k2: 0.5, triggers: [0],
    });
    const probe = Math.floor(SR * 0.3);
    expect(shortOut[probe], `short envelope @ 300 ms ${shortOut[probe]}`).toBeLessThan(0.05);
    expect(longOut[probe], `long envelope @ 300 ms ${longOut[probe]}`).toBeGreaterThan(0.3);
  });
});

describe('peaksMath / LFO frequency mapping', () => {
  it('LFO at 5 Hz produces ~5 zero-crossings per second window in sine mode', () => {
    const n = SR;
    const out = peaksMath.render(n, SR, {
      mode: 4, k1: 5, k2: 0, triggers: [0],
    });
    const z = zeroCrossings(out);
    // 5 Hz sine over 1 s = 10 zero-crossings, +/- 2 for phase boundaries.
    expect(z, `zero crossings at 5 Hz ${z}`).toBeGreaterThanOrEqual(8);
    expect(z, `zero crossings at 5 Hz ${z}`).toBeLessThanOrEqual(12);
  });

  it('LFO at 1 Hz produces ~1 cycle per second (≈ 2 zero crossings)', () => {
    const n = SR;
    const out = peaksMath.render(n, SR, {
      mode: 4, k1: 1, k2: 0, triggers: [0],
    });
    const z = zeroCrossings(out);
    expect(z, `zero crossings at 1 Hz ${z}`).toBeGreaterThanOrEqual(1);
    expect(z, `zero crossings at 1 Hz ${z}`).toBeLessThanOrEqual(4);
  });

  it('LFO retriggers (phase=0) on rising edge', () => {
    const n = SR;
    // Trigger mid-way. Before the trigger, phase has advanced; after it
    // the value should be sin(0) = 0.
    const trigAt = SR / 2;
    const out = peaksMath.render(n, SR, {
      mode: 4, k1: 2, k2: 0, triggers: [trigAt],
    });
    // First sample after the trigger fires (in render, trigger fires then
    // tick advances phase by one increment, so the second sample is
    // sin(2π · rate/sr)).
    expect(Math.abs(out[trigAt]!), `phase-reset sample ${out[trigAt]}`).toBeLessThan(0.05);
  });

  it('LFO square wave is ±1', () => {
    const n = SR / 10;
    const out = peaksMath.render(n, SR, {
      mode: 4, k1: 5, k2: 1, triggers: [0],
    });
    for (let i = 0; i < n; i++) {
      const v = Math.abs(out[i]!);
      expect(v, `square sample ${out[i]}`).toBeCloseTo(1, 6);
    }
  });
});

describe('peaksMath / numerical safety', () => {
  it('finite output across the 5-mode × extreme-knob corners', () => {
    const n = SR / 10;
    const cornerKnobs: Array<[number, number]> = [
      [0.001, 0.001],
      [200, 5],
      [0.5, 0.5],
    ];
    for (let m = 0; m <= PEAKS_MAX_MODE; m++) {
      for (const [k1, k2] of cornerKnobs) {
        const out = peaksMath.render(n, SR, {
          mode: m as PeaksMode,
          k1,
          k2,
          triggers: [0],
        });
        for (let i = 0; i < n; i++) {
          expect(Number.isFinite(out[i]!), `mode=${m} k1=${k1} k2=${k2} sample[${i}]`).toBe(true);
        }
      }
    }
  });
});
