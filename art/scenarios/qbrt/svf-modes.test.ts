// art/scenarios/qbrt/svf-modes.test.ts
//
// QBRT — the stereo pingable state-variable filter, measured on the SHIPPED
// wasm. The last of three Faust modules that had NO ART scenario (found by
// sweeping every .dsp against the scenarios that render it).
//
// `process(l, r, ping)` → (L, R). MODE crossfades LP→BP→HP→Notch over 0..1,
// and `ping` excites the filter with no audio input at all.
//
// ⚠ Every knob is `: si.smoo` from ZERO, so a measurement from t=0 reads the
// ramp — cutoff would sweep up from 20 Hz rather than sit at its setting.
// Everything here is measured from the settled region.

import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE } from '../../setup/capture';
import { renderFaustOffline } from '../../setup/faust-offline';

const SR = SAMPLE_RATE;
const N = Math.round(SR * 0.6);
const SETTLED = Math.round(SR * 0.3);
const CUTOFF = 1000;

/** Goertzel magnitude at `hz` over the settled region. */
function mag(b: Float32Array, hz: number, s = SETTLED, e = b.length): number {
  const w = (2 * Math.PI * hz) / SR;
  const c = 2 * Math.cos(w);
  let q1 = 0;
  let q2 = 0;
  for (let i = s; i < e; i++) {
    const q0 = c * q1 - q2 + b[i]!;
    q2 = q1;
    q1 = q0;
  }
  return (2 * Math.sqrt(q1 * q1 + q2 * q2 - q1 * q2 * c)) / (e - s);
}
const rms = (b: Float32Array, s = SETTLED, e = b.length): number => {
  let a = 0;
  for (let i = s; i < e; i++) a += b[i]! * b[i]!;
  return Math.sqrt(a / (e - s));
};
const db = (x: number): number => 20 * Math.log10(Math.max(x, 1e-12));

const tone = (hz: number): Float32Array => {
  const b = new Float32Array(N);
  for (let i = 0; i < N; i++) b[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / SR);
  return b;
};

async function filterTone(hz: number, params: Record<string, number>) {
  const t = tone(hz);
  return renderFaustOffline({
    name: 'qbrt',
    totalSamples: N,
    inputs: [t, t, null],
    params: { cutoff: CUTOFF, resonance: 0.7, ...params },
    outputs: ['L', 'R'],
  });
}

describe('qbrt — SVF mode crossfade on the shipped wasm', () => {
  it('MODE 0 (low-pass) passes a tone BELOW cutoff and rejects one above', async () => {
    const low = await filterTone(200, { mode: 0 });
    const high = await filterTone(8000, { mode: 0 });
    const passed = db(mag(low.L!, 200));
    const rejected = db(mag(high.L!, 8000));
    expect(
      passed - rejected,
      `LP: 200 Hz at ${passed.toFixed(1)} dB vs 8 kHz at ${rejected.toFixed(1)} dB — ` +
        'a low-pass must reject the high tone',
    ).toBeGreaterThan(20);
  });

  it('MODE 1 (the far end) treats the SAME two tones differently from mode 0', async () => {
    // The defining property of the crossfade: the mode dial must actually
    // change the response, not just exist. Compared as a RATIO so absolute
    // gain differences between modes cannot mask a dead dial.
    const lpLow = db(mag((await filterTone(200, { mode: 0 })).L!, 200));
    const lpHigh = db(mag((await filterTone(8000, { mode: 0 })).L!, 8000));
    const m1Low = db(mag((await filterTone(200, { mode: 1 })).L!, 200));
    const m1High = db(mag((await filterTone(8000, { mode: 1 })).L!, 8000));
    const lpTilt = lpLow - lpHigh;
    const m1Tilt = m1Low - m1High;
    expect(
      Math.abs(lpTilt - m1Tilt),
      `mode 0 tilt ${lpTilt.toFixed(1)} dB vs mode 1 tilt ${m1Tilt.toFixed(1)} dB — ` +
        'the MODE dial is dead',
    ).toBeGreaterThan(10);
  });

  it('PING excites the filter with NO audio input — the defining feature', async () => {
    const ping = new Float32Array(N);
    ping[Math.round(SR * 0.05)] = 1;
    const r = await renderFaustOffline({
      name: 'qbrt',
      totalSamples: N,
      inputs: [null, null, ping],
      params: { cutoff: CUTOFF, resonance: 0.9, mode: 0, pingDecay: 0.3 },
      outputs: ['L', 'R'],
    });
    const after = rms(r.L!, Math.round(SR * 0.05), Math.round(SR * 0.15));
    expect(after, 'a ping with no audio in must still produce sound').toBeGreaterThan(1e-4);
    // ...and it must RING at the cutoff, not be broadband noise.
    const atCutoff = mag(r.L!, CUTOFF, Math.round(SR * 0.05), Math.round(SR * 0.15));
    const offCutoff = mag(r.L!, CUTOFF * 4, Math.round(SR * 0.05), Math.round(SR * 0.15));
    expect(
      db(atCutoff) - db(offCutoff),
      'the ping must ring AT the cutoff (resonant), not broadband',
    ).toBeGreaterThan(12);
  });

  it('PING DECAY controls the ring length', async () => {
    const render = async (pingDecay: number) => {
      const ping = new Float32Array(N);
      ping[Math.round(SR * 0.05)] = 1;
      const r = await renderFaustOffline({
        name: 'qbrt',
        totalSamples: N,
        inputs: [null, null, ping],
        params: { cutoff: CUTOFF, resonance: 0.9, mode: 0, pingDecay },
        outputs: ['L', 'R'],
      });
      return rms(r.L!, Math.round(SR * 0.15), Math.round(SR * 0.3));
    };
    const short = await render(0.005);
    const long = await render(0.5);
    expect(long, `pingDecay 0.5 (${long.toExponential(2)}) must outlast 0.005 (${short.toExponential(2)})`)
      .toBeGreaterThan(short);
  });

  it('is STEREO — both legs are driven and finite', async () => {
    const r = await filterTone(500, { mode: 0 });
    for (const ch of ['L', 'R'] as const) {
      expect(r[ch]!.some((v) => !Number.isFinite(v)), `${ch} NaN/Inf`).toBe(false);
      expect(rms(r[ch]!), `${ch} silent`).toBeGreaterThan(1e-4);
    }
  });

  it('stays finite at the extremes of every knob', async () => {
    for (const p of [
      { cutoff: 20, resonance: 0.99, mode: 0, pingDecay: 0.5 },
      { cutoff: 20000, resonance: 0, mode: 1, pingDecay: 0.005 },
    ]) {
      const r = await filterTone(1000, p);
      expect(r.L!.some((v) => !Number.isFinite(v)), `NaN/Inf at ${JSON.stringify(p)}`).toBe(false);
    }
  });
});
