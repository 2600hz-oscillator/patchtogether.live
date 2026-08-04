// art/scenarios/equal-power-pan/pan-law.test.ts
//
// EQUAL-POWER PAN — the pan law, measured on the SHIPPED wasm.
//
// This module had NO ART scenario at all: one of three Faust modules with zero
// audio coverage (found by sweeping every .dsp against the scenarios that
// render it). The offline harness makes real-wasm coverage cheap, so the gap
// closes without a hand-port — the mirror class that #1376/#1377 had to undo.
//
// `process(audio, panCv) = audio * gainL, audio * gainR`. The DEFINING property
// is in the name: equal POWER, i.e. L² + R² is constant across the sweep, with
// the centre at −3 dB rather than unity. A linear (equal-amplitude) pan law
// would instead dip ~3 dB in the middle — that is the regression this catches.
//
// ⚠ The `pan` knob is `: si.smoo`, and Faust's smoother starts at ZERO, not at
// the slider default (measured on analog-vco: ~100 ms to settle, see
// art/scenarios/analog-vco/vco-mirror.ts). Every measurement here is taken from
// the SETTLED region for that reason; measuring from t=0 would read the ramp.

import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE } from '../../setup/capture';
import { renderFaustOffline } from '../../setup/faust-offline';

const SR = SAMPLE_RATE;
const N = Math.round(SR * 0.5);
/** Skip the si.smoo ramp — knobs settle in ~100 ms. */
const SETTLED = Math.round(SR * 0.25);

const rms = (b: Float32Array, s = SETTLED, e = b.length): number => {
  let a = 0;
  for (let i = s; i < e; i++) a += b[i]! * b[i]!;
  return Math.sqrt(a / (e - s));
};
const db = (x: number): number => 20 * Math.log10(Math.max(x, 1e-12));

/** A steady full-scale C4 sine into `audio`, pan set by knob. */
async function renderPan(pan: number) {
  const audio = new Float32Array(N);
  for (let i = 0; i < N; i++) audio[i] = Math.sin((2 * Math.PI * 261.626 * i) / SR);
  return renderFaustOffline({
    name: 'equal-power-pan',
    totalSamples: N,
    inputs: [audio, null],
    params: { pan },
    outputs: ['L', 'R'],
  });
}

describe('equal-power-pan — the pan law on the shipped wasm', () => {
  it('CENTRE is −3 dB on both legs (equal POWER, not equal amplitude)', async () => {
    const r = await renderPan(0);
    const l = rms(r.L!);
    const rr = rms(r.R!);
    // A full-scale sine has rms 1/√2; equal-power centre scales it by 1/√2again.
    const expected = (1 / Math.sqrt(2)) * (1 / Math.sqrt(2));
    expect(db(l) - db(expected), `L centre was ${db(l).toFixed(2)} dB`).toBeCloseTo(0, 0);
    expect(db(rr) - db(expected), `R centre was ${db(rr).toFixed(2)} dB`).toBeCloseTo(0, 0);
    expect(Math.abs(db(l) - db(rr)), 'centre must be symmetric').toBeLessThan(0.2);
  });

  it('HARD LEFT sends the signal to L and silences R (and vice versa)', async () => {
    const left = await renderPan(-1);
    const right = await renderPan(1);
    expect(db(rms(left.L!)) - db(rms(left.R!)), 'pan −1 must favour L').toBeGreaterThan(40);
    expect(db(rms(right.R!)) - db(rms(right.L!)), 'pan +1 must favour R').toBeGreaterThan(40);
  });

  it('TOTAL POWER is constant across the sweep — the defining invariant', async () => {
    // The regression this catches: a LINEAR pan law dips ~3 dB at centre.
    const powers: Array<{ pan: number; p: number }> = [];
    for (const pan of [-1, -0.5, 0, 0.5, 1]) {
      const r = await renderPan(pan);
      const l = rms(r.L!);
      const rr = rms(r.R!);
      powers.push({ pan, p: l * l + rr * rr });
    }
    const vals = powers.map((x) => x.p);
    const spreadDb = 10 * Math.log10(Math.max(...vals) / Math.min(...vals));
    expect(
      spreadDb,
      'L²+R² must stay constant across the pan sweep (equal POWER). Measured: ' +
        powers.map((x) => `pan ${x.pan}: ${(10 * Math.log10(x.p)).toFixed(2)} dB`).join(', '),
    ).toBeLessThan(1.0);
  });

  it('the render is finite and non-silent — no vacuous pass', async () => {
    const r = await renderPan(0);
    for (const ch of ['L', 'R'] as const) {
      expect(r[ch]!.some((v) => !Number.isFinite(v)), `${ch} NaN/Inf`).toBe(false);
      expect(rms(r[ch]!), `${ch} silent`).toBeGreaterThan(1e-3);
    }
  });
});
