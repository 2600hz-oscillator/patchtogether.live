// art/scenarios/fourplexer/profile.test.ts
//
// AUDIO PROFILE for 4PLEXER (4-in/4-out discrete router) (backfill batch 4 —
// spec §4.1/§4.3, .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md),
// through the shared capture harness (capture.ts + drivers.ts + worklet.ts).
//
// Category: clocked ROUTER utility — out1's gate is driven by the canonical
// 240 BPM CLOCK (spec §4.2: clockTrain, epoch pinned to sample 0), and the
// four signal inputs carry four spectrally DISTINCT sources so every
// selector hop is visible in the profile's spectrogram:
//   in1 = C4 sine   in2 = C4 saw   in3 = 1 kHz sine   in4 = seeded noise
//
// The first rising edge lands on sample 0 and advances out1's selector
// immediately (default sel1 = 0, so the walk starts on in2), giving four
// 250 ms segments: saw → 1 kHz → noise → sine (the 3→0 wrap), each hop
// declicked by the worklet's ~4 ms linear crossfade (part of the shipping
// sound, kept in the profile).
//
// Patch: sel1..sel4 at their shipping defaults (0/1/2/3). gates 2..4
// unpatched, so out2/out3/out4 stay pinned to their default selections —
// they are EXACT passthroughs of in2/in3/in4 (proven below, not pinned;
// out1 alone carries the module's routing signature).
//
// Rendering path: the REAL worklet processor class via the shared shim
// loader — fourplexer.ts is fully self-contained pure math, no RNG. One test
// seam: a gate-advance calls this.port.postMessage() (the selector-persist
// announce); the shim base class has no MessagePort, so the scenario installs
// a no-op port before rendering (the message payload is host-side state
// persistence, not audio).
//
// The .sha pins the (self-contained) worklet entry.

import { describe, expect, it } from 'vitest';
import { dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { C4_HZ, clockTrain, seededNoise, vcoTestSignal } from '../../setup/drivers';
import { captureWorkletProcessor, renderWorklet } from '../../setup/worklet';

const SR = SAMPLE_RATE;
const DURATION_S = 1.0;
const SEGMENT_S = 0.25; // 240 BPM clock period
const IN3_HZ = 1000;
const NOISE_AMP = 0.5;

const in1 = vcoTestSignal({ totalS: DURATION_S, shape: 'sine' });
const in2 = vcoTestSignal({ totalS: DURATION_S, shape: 'saw' });
const in3 = vcoTestSignal({ totalS: DURATION_S, shape: 'sine', freqHz: IN3_HZ });
const in4 = (() => {
  const raw = seededNoise(DURATION_S);
  const scaled = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) scaled[i] = Math.fround(raw[i]! * NOISE_AMP);
  return scaled;
})();

async function renderProfile(): Promise<Record<string, Float32Array>> {
  const Proc = await captureWorkletProcessor(
    'fourplexer',
    () => import('../../../packages/dsp/src/fourplexer'),
    SR,
  );
  const proc = new Proc();
  // Test seam: the shim base class has no MessagePort; announce() is a no-op.
  (proc as unknown as { port: { postMessage: (m: unknown) => void } }).port = {
    postMessage: () => {},
  };
  const n = Math.round(SR * DURATION_S);
  return renderWorklet(proc, {
    totalSamples: n,
    // inputs[0..3] = in1..in4 (signal), inputs[4..7] = gate1..gate4.
    inputs: [in1, in2, in3, in4, clockTrain(DURATION_S), null, null, null],
    params: { sel1: 0, sel2: 1, sel3: 2, sel4: 3 },
    outputs: ['out1', 'out2', 'out3', 'out4'],
  });
}

/** Goertzel magnitude (normalized 2/N) of freqHz over buf[s, e). */
function goertzel(buf: Float32Array, s: number, e: number, freqHz: number): number {
  const N = e - s;
  const w = (2 * Math.PI * freqHz) / SR;
  const coeff = 2 * Math.cos(w);
  let q1 = 0;
  let q2 = 0;
  for (let i = s; i < e; i++) {
    const q0 = coeff * q1 - q2 + buf[i]!;
    q2 = q1;
    q1 = q0;
  }
  const re = q1 - q2 * Math.cos(w);
  const im = q2 * Math.sin(w);
  return (2 / N) * Math.sqrt(re * re + im * im);
}

function rms(b: Float32Array, s: number, e: number): number {
  let x = 0;
  for (let i = s; i < e; i++) x += b[i]! * b[i]!;
  return Math.sqrt(x / Math.max(1, e - s));
}

// Probe window inside segment k, trimmed 20 ms off each edge so the ~4 ms
// declick crossfades (and Goertzel edge leakage) stay out of the window.
const seg = (k: number): [number, number] => [
  Math.round((k * SEGMENT_S + 0.02) * SR),
  Math.round(((k + 1) * SEGMENT_S - 0.02) * SR),
];

describe('ART fourplexer / audio profile (240 BPM gate walks out1: saw → 1 kHz → noise → sine)', () => {
  it('routes exactly one input per gate segment on out1; out2..4 hold their defaults', async () => {
    const bufs = await renderProfile();
    const out1 = bufs.out1!;
    const n = Math.round(SR * DURATION_S);
    expect(out1.length).toBe(n);
    expect(out1.every(Number.isFinite)).toBe(true);

    const SAW_H2 = C4_HZ * 2; // the saw's 2nd harmonic — absent from both sines
    // Segment 0 (edge at sample 0 advances 0→1): in2, the C4 saw.
    let [s, e] = seg(0);
    expect(goertzel(out1, s, e, SAW_H2)).toBeGreaterThan(0.05);
    expect(goertzel(out1, s, e, IN3_HZ)).toBeLessThan(0.01);
    // Segment 1: in3, the 1 kHz sine.
    [s, e] = seg(1);
    expect(goertzel(out1, s, e, IN3_HZ)).toBeGreaterThan(0.3);
    expect(goertzel(out1, s, e, SAW_H2)).toBeLessThan(0.01);
    // Segment 2: in4, the seeded noise — broadband energy, no tonal peaks.
    [s, e] = seg(2);
    expect(rms(out1, s, e)).toBeGreaterThan(0.2);
    expect(goertzel(out1, s, e, C4_HZ)).toBeLessThan(0.05);
    expect(goertzel(out1, s, e, IN3_HZ)).toBeLessThan(0.05);
    // Segment 3 (wrap 3→0): in1, the pure C4 sine.
    [s, e] = seg(3);
    expect(goertzel(out1, s, e, C4_HZ)).toBeGreaterThan(0.3);
    expect(goertzel(out1, s, e, SAW_H2)).toBeLessThan(0.01);

    // out2/out3/out4: static default selections with no gate — EXACT
    // passthroughs of in2/in3/in4 (why only out1 is pinned).
    for (const [name, src] of [
      ['out2', in2],
      ['out3', in3],
      ['out4', in4],
    ] as const) {
      const out = bufs[name]!;
      let d = 0;
      for (let i = 0; i < n; i++) d = Math.max(d, Math.abs(out[i]! - src[i]!));
      expect(d, `${name} must be the unaltered passthrough of its default input`).toBe(0);
    }

    // Deterministic re-render is bit-identical (fresh processor instance).
    const again = (await renderProfile()).out1!;
    let diff = 0;
    for (let i = 0; i < n; i++) diff = Math.max(diff, Math.abs(out1[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the out1 profile baseline (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('fourplexer.ts');
    const bufs = await renderProfile();
    await pinAll('fourplexer', srcSha, { out1: bufs.out1! });
  });
});
