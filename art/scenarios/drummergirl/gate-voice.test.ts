// art/scenarios/drummergirl/gate-voice.test.ts
//
// DRUMMERGIRL — the gated drum voice, measured on the SHIPPED wasm.
//
// One of three Faust modules that had NO ART scenario (found by sweeping every
// .dsp against the scenarios that render it). `process(gate) = mixed(gate) *
// env(gate) * volumeKnob` — a single gate input drives a VCO+noise blend
// through an ADSR, with `shape` morphing 16 percussion presets.
//
// ⚠ Every knob is `: si.smoo` starting from ZERO, so a measurement taken from
// t=0 reads the ramp, not the setting. The gate here fires AFTER the knobs
// settle for exactly that reason.

import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE } from '../../setup/capture';
import { renderFaustOffline } from '../../setup/faust-offline';

const SR = SAMPLE_RATE;
const N = Math.round(SR * 1.0);
/** Knobs settle (~100 ms), THEN the gate fires. */
const GATE_AT = Math.round(SR * 0.2);
const GATE_LEN = Math.round(SR * 0.02);

const rms = (b: Float32Array, s: number, e: number): number => {
  let a = 0;
  for (let i = s; i < Math.min(e, b.length); i++) a += b[i]! * b[i]!;
  return Math.sqrt(a / Math.max(1, Math.min(e, b.length) - s));
};

async function strike(params: Record<string, number> = {}) {
  const gate = new Float32Array(N);
  for (let i = GATE_AT; i < GATE_AT + GATE_LEN; i++) gate[i] = 1;
  const r = await renderFaustOffline({
    name: 'drummergirl',
    totalSamples: N,
    inputs: [gate],
    params,
    outputs: ['out'],
  });
  return r.out!;
}

describe('drummergirl — gated drum voice on the shipped wasm', () => {
  it('is SILENT before the gate and VOICED after it', async () => {
    const out = await strike();
    const before = rms(out, Math.round(SR * 0.05), GATE_AT - 1);
    const after = rms(out, GATE_AT, GATE_AT + Math.round(SR * 0.05));
    expect(before, `leaked ${before.toExponential(2)} before the gate`).toBeLessThan(1e-4);
    expect(after, 'no voice after the gate').toBeGreaterThan(1e-3);
  });

  it('DECAYS — a drum is a transient, not a drone', async () => {
    const out = await strike({ decay: 0.15 });
    const head = rms(out, GATE_AT, GATE_AT + Math.round(SR * 0.02));
    const tail = rms(out, GATE_AT + Math.round(SR * 0.5), N);
    expect(
      20 * Math.log10(head / Math.max(tail, 1e-12)),
      `head ${head.toExponential(2)} vs tail ${tail.toExponential(2)} — it should decay`,
    ).toBeGreaterThan(30);
  });

  it('DECAY knob lengthens the tail', async () => {
    // WINDOW CHOSEN FROM MEASUREMENT, not guessed. Per-10 ms rms after the gate:
    //   decay=0.01  2.9e-1 1.2e-2 4.0e-3 2.6e-3 1.4e-3 2.5e-4 0 0 0 0
    //   decay=0.15  4.3e-1 4.2e-1 3.5e-1 2.3e-1 1.2e-1 2.2e-2 0 0 0 0
    //   decay=0.50  4.4e-1 4.5e-1 3.8e-1 2.5e-1 1.4e-1 2.4e-2 0 0 0 0
    // A first draft measured t+100..200 ms and read 0 for BOTH — the voice is
    // fully decayed by ~60 ms at every setting, so that window could not see the
    // knob at all. 10-50 ms is where the difference actually lives.
    const short = await strike({ decay: 0.01 });
    const long = await strike({ decay: 0.15 });
    const win = (b: Float32Array) =>
      rms(b, GATE_AT + Math.round(SR * 0.01), GATE_AT + Math.round(SR * 0.05));
    expect(
      win(long),
      `decay 0.15 sustained ${win(long).toExponential(2)} vs 0.01's ${win(short).toExponential(2)} ` +
        'over t+10..50 ms — the DECAY knob is dead',
    ).toBeGreaterThan(win(short) * 5);
  });

  it('⚠ RECORDS a measured oddity: DECAY appears to saturate well below its max', async () => {
    // NOT asserted as a defect — recorded so it is visible rather than lost.
    // The knob's declared range is 0.001..0.5, but 0.15 and 0.5 render almost
    // identically (per-10 ms rms above: 4.3/4.2/3.5/2.3/1.2 vs 4.4/4.5/3.8/2.5/
    // 1.4 e-1), and BOTH hit exactly zero at ~60 ms. Whether the top half of the
    // range is genuinely dead, or simply not observable with this 20 ms gate,
    // needs the envelope's own shape examined — so this test pins only what was
    // measured: the two settings are close, and neither rings past ~60 ms.
    const mid = await strike({ decay: 0.15 });
    const max = await strike({ decay: 0.5 });
    const win = (b: Float32Array) =>
      rms(b, GATE_AT + Math.round(SR * 0.01), GATE_AT + Math.round(SR * 0.05));
    const ratio = win(max) / Math.max(win(mid), 1e-12);
    expect(ratio, `decay 0.5 vs 0.15 measured x${ratio.toFixed(2)}`).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1.5);
    // Both are silent well before 200 ms — pinning the voice as a transient.
    for (const b of [mid, max]) {
      expect(rms(b, GATE_AT + Math.round(SR * 0.2), N)).toBeLessThan(1e-5);
    }
  });

  it('SHAPE morphs the timbre (16 percussion presets) — a dead knob FAILS', async () => {
    const a = await strike({ shape: 0.05 });
    const b = await strike({ shape: 0.95 });
    let diff = 0;
    const s = GATE_AT;
    const e = GATE_AT + Math.round(SR * 0.1);
    for (let i = s; i < e; i++) diff += (a[i]! - b[i]!) ** 2;
    const dRms = Math.sqrt(diff / (e - s));
    expect(dRms, 'shape 0.05 vs 0.95 produced the same sound — the knob is dead').toBeGreaterThan(1e-3);
  });

  it('VOLUME scales the output (and its 0..2 range reaches above unity)', async () => {
    const half = await strike({ volume: 0.5 });
    const full = await strike({ volume: 1.0 });
    const win = (b: Float32Array) => rms(b, GATE_AT, GATE_AT + Math.round(SR * 0.05));
    const ratio = win(full) / Math.max(win(half), 1e-12);
    expect(ratio, `volume 1.0 / 0.5 measured ${ratio.toFixed(2)}, expected ~2`).toBeGreaterThan(1.6);
  });

  it('never produces NaN/Inf, even at the extremes of every knob', async () => {
    for (const p of [
      { shape: 0, tone: 0, decay: 0.001, pitch: -36, volume: 2 },
      { shape: 1, tone: 1, decay: 0.5, pitch: 36, volume: 2 },
    ]) {
      const out = await strike(p);
      expect(out.some((v) => !Number.isFinite(v)), `NaN/Inf at ${JSON.stringify(p)}`).toBe(false);
    }
  });
});
