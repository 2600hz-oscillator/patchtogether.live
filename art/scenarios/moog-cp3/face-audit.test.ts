// art/scenarios/moog-cp3/face-audit.test.ts
//
// THE ADVERSARIAL AUDIT FOR MOOG CP3, and the permanent anchor under its
// faceplate (queue Q36, #1893).
//
// Everything here is measured against the REAL worklet — the shipping
// `MoogCp3Processor` captured through the shared `registerProcessor` shim and
// pumped through `process()` in 128-sample blocks at 48 kHz.
//
// WHAT THIS FILE IS FOR, beyond regression. `moogcp3-face-model.ts` is one
// closed form, and a unit test over it can only prove it is self-consistent.
// Four claims underneath it are about the MIX:
//
//   1. UNITY IS AT THE DIAL'S MIDPOINT (`knob·2`), so the shipped all-max
//      defaults are +18 dB over full scale with NO clamp anywhere. That is the
//      whole reason this module has a face.
//   2. THE DERIVED BUS FIGURE MATCHES THE MEASURED PEAK, at five settings.
//   3. FIVE OF THE SEVEN JACKS ARE NOT THE KNOBS' BUSINESS, bit-exactly — which
//      is what the authored rear-card grouping is for.
//   4. CH 4 AND ATT 4 ARE BIT-EXACTLY INTERCHANGEABLE. ⚠ This one CANNOT be
//      made in the unit tier: the face model's bus figure is a SUM over
//      channels, so it is symmetric under a CH 1 / CH 4 swap too. Only a render
//      with DIFFERENT SIGNALS on the two jacks can tell "the same control
//      twice" from "a sum I cannot see into", and that render lives here with
//      a non-interchangeable pair as its negative control.
//
// ⚠ THE INSTRUMENT IS CONTROLLED FIRST, in both directions: a known 0.5-
// amplitude sine must read 0.500000 at its own bin and 0.000000 at a bin it is
// not in. A single-bin DFT with the wrong window or the wrong normalisation
// reads plausible-but-wrong numbers, and every gain figure below depends on it.

import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE } from '../../setup/capture';
import { captureWorkletProcessor, renderWorklet } from '../../setup/worklet';
import { moogCp3BusGain } from '$lib/ui/modules/moogcp3-face-model';
import { moogCp3Def } from '$lib/audio/modules/moog-cp3';

const SR = SAMPLE_RATE;
const D: Record<string, number> = Object.fromEntries(
  moogCp3Def.params.map((p) => [p.id, p.defaultValue]),
);
const OUT_IDS: readonly string[] = moogCp3Def.outputs.map((o) => o.id);
const IN_COUNT = moogCp3Def.inputs.length;

const N = SR; // 1 s
const TAIL = Math.round(0.5 * SR); // past the 80 Hz knob smoother

type Patch = Partial<Record<'ch1' | 'ch2' | 'ch3' | 'ch4' | 'attenuator4', number>>;

function sine(hz: number, amp = 1): Float32Array {
  const b = new Float32Array(N);
  for (let i = 0; i < N; i++) b[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
  return b;
}

async function render(
  ins: ReadonlyArray<Float32Array | null>,
  patch: Patch = {},
): Promise<Record<string, Float32Array>> {
  const Proc = await captureWorkletProcessor(
    'moog-cp3',
    () => import('../../../packages/dsp/src/moog-cp3'),
    SR,
  );
  const inputs = Array.from({ length: IN_COUNT }, (_, k) => ins[k] ?? null);
  return renderWorklet(new Proc(), {
    totalSamples: N,
    inputs,
    params: { ...D, ...patch },
    outputs: OUT_IDS,
  });
}

/** Hann-windowed single-bin DFT amplitude at `hz`, over the settled tail. */
function binAmp(buf: Float32Array, hz: number): number {
  const n = buf.length - TAIL;
  let re = 0;
  let im = 0;
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    const ph = (2 * Math.PI * hz * i) / SR;
    re += buf[TAIL + i]! * w * Math.cos(ph);
    im -= buf[TAIL + i]! * w * Math.sin(ph);
    wsum += w;
  }
  return (2 * Math.sqrt(re * re + im * im)) / wsum;
}
function peak(buf: Float32Array): number {
  let m = 0;
  for (let i = TAIL; i < buf.length; i++) {
    const v = Math.abs(buf[i]!);
    if (v > m) m = v;
  }
  return m;
}
function maxDiff(a: Float32Array, b: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    if (d > m) m = d;
  }
  return m;
}
const bytes = (a: Float32Array) =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');

describe('ART moog-cp3 / face audit — THE INSTRUMENT, before any finding', () => {
  it('⚠ a known 0.5 sine reads 0.500000 at its bin and 0.000000 at a wrong one', async () => {
    // Channel 1 at the MIDPOINT is unity, so the output should BE the input.
    const r = await render([sine(1000, 0.5)], { ch1: 0.5 });
    expect(binAmp(r.out_positive!, 1000)).toBeCloseTo(0.5, 4);
    expect(binAmp(r.out_positive!, 1700)).toBeCloseTo(0, 4);
  });
});

describe('ART moog-cp3 / face audit — UNITY IS AT THE MIDPOINT, AND THE DEFAULTS ARE +18 dB', () => {
  it('the channel law is knob x2 across the whole dial', async () => {
    const expected: readonly (readonly [number, number])[] = [
      [0, 0],
      [0.25, 0.5],
      [0.5, 1],
      [0.75, 1.5],
      [1, 2],
    ];
    for (const [knob, amp] of expected) {
      const r = await render([sine(1000)], { ch1: knob });
      expect(binAmp(r.out_positive!, 1000), `ch1=${knob}`).toBeCloseTo(amp, 4);
    }
  });

  it('⚠ every knob SHIPS AT MAX, so four correlated unity inputs peak at 8.0000', async () => {
    for (const q of moogCp3Def.params) {
      expect(q.defaultValue, `${q.id} ships at its own max`).toBe(q.max);
    }
    const four = await render([sine(1000), sine(1000), sine(1000), sine(1000)]);
    expect(peak(four.out_positive!)).toBeCloseTo(8, 3);
    // …and with EXT 4 patched as well.
    const five = await render([sine(1000), sine(1000), sine(1000), sine(1000), sine(1000)]);
    expect(peak(five.out_positive!)).toBeCloseTo(10, 3);
    // ⚠ THERE IS NO CLAMP OR SATURATOR ANYWHERE IN THE PATH. Asserted rather
    // than described: the bus really does leave the module above full scale.
    expect(peak(four.out_positive!)).toBeGreaterThan(1);
  });

  it('the FACE MODEL\'s bus figure matches the measured peak at five settings', async () => {
    // THE ANCHOR for the readout. Four correlated unity inputs, so the derived
    // worst case IS the observable peak.
    const cases: readonly Patch[] = [
      {},
      { ch1: 0.5, ch2: 0.5, ch3: 0.5, ch4: 0.5 },
      { ch1: 0.25, ch2: 0.25, ch3: 0.25, ch4: 0.25 },
      { attenuator4: 0 },
      { ch2: 0, ch3: 0, attenuator4: 0.5 },
    ];
    for (const patch of cases) {
      const p = { ch1: D.ch1!, ch2: D.ch2!, ch3: D.ch3!, ch4: D.ch4!, attenuator4: D.attenuator4!, ...patch };
      const r = await render([sine(1000), sine(1000), sine(1000), sine(1000)], patch);
      expect(peak(r.out_positive!), `${JSON.stringify(patch)}`).toBeCloseTo(moogCp3BusGain(p), 2);
    }
  });

  it('out_negative is the EXACT phase inverse of out_positive', async () => {
    const r = await render([sine(1000), sine(500), sine(300), sine(700)]);
    let m = 0;
    for (let i = 0; i < N; i++) {
      const d = Math.abs(r.out_positive![i]! + r.out_negative![i]!);
      if (d > m) m = d;
    }
    expect(m).toBe(0);
  });
});

describe('ART moog-cp3 / face audit — FIVE OF THE SEVEN JACKS IGNORE EVERY KNOB', () => {
  it('sweeping any knob 1.0 → 0.0 leaves the multiples and the references BIT-IDENTICAL', async () => {
    // This is what the authored rear-card grouping is FOR: of seven jacks, two
    // carry the mix, three are one passthrough copied three times, and two are
    // constants. A rail grouped by cable domain would hide that.
    const ins = [sine(1000), sine(500), sine(300), sine(700)];
    const ref = await render(ins);
    const untouched = ['multiple_one', 'multiple_two', 'multiple_three', 'plus_twelve', 'minus_six'];
    for (const knob of ['ch1', 'ch2', 'ch3', 'ch4', 'attenuator4'] as const) {
      const r = await render(ins, { [knob]: 0 });
      for (const id of untouched) {
        expect(bytes(r[id]!), `${knob} → 0 moved ${id}`).toBe(bytes(ref[id]!));
      }
      // …and the BUS did move, so the sweep is not a dead probe.
      expect(bytes(r.out_positive!), `${knob} → 0 must move the bus`).not.toBe(
        bytes(ref.out_positive!),
      );
    }
  });

  it('the three multiples are one passthrough of IN 1, and the references are constants', async () => {
    const in1 = sine(1000);
    const r = await render([in1, sine(500), sine(300), sine(700)]);
    expect(bytes(r.multiple_one!)).toBe(bytes(r.multiple_two!));
    expect(bytes(r.multiple_two!)).toBe(bytes(r.multiple_three!));
    expect(maxDiff(r.multiple_one!, in1)).toBe(0);
    // +2.4 and −1.2: 240 % and 120 % of the rack's own ±1 CV convention, on no
    // dial, in an exact −2 ratio.
    expect(r.plus_twelve![100]).toBeCloseTo(2.4, 6);
    expect(r.minus_six![100]).toBeCloseTo(-1.2, 6);
    expect(r.plus_twelve![100]! / r.minus_six![100]!).toBeCloseTo(-2, 9);
  });
});

describe('ART moog-cp3 / face audit — CH 4 AND ATT 4 ARE THE SAME CONTROL TWICE', () => {
  it('swapping them is BIT-IDENTICAL with different signals on the two jacks', async () => {
    // ⚠ The signals must DIFFER, or the test cannot distinguish "one control
    // twice" from "a sum". 300 Hz on IN 4, 700 Hz on EXT 4.
    const ins = [null, null, null, sine(300), sine(700)];
    for (const [a, b] of [
      [0.5, 1],
      [0.25, 0.8],
      [0.2, 0.9],
      [0, 1],
    ]) {
      const x = await render(ins, { ch4: a, attenuator4: b });
      const y = await render(ins, { ch4: b, attenuator4: a });
      expect(maxDiff(x.out_positive!, y.out_positive!), `(ch4,att4)=(${a},${b})`).toBe(0);
    }
  });

  it('⚠ NEGATIVE CONTROL: a genuinely different pair of controls does NOT swap', async () => {
    // CH 1 against CH 4, with different signals on their jacks. If this were
    // also bit-identical the probe would be measuring nothing.
    const ins = [sine(300), null, null, sine(700)];
    const x = await render(ins, { ch1: 0.25, ch4: 0.8 });
    const y = await render(ins, { ch1: 0.8, ch4: 0.25 });
    expect(maxDiff(x.out_positive!, y.out_positive!)).toBeGreaterThan(1);
  });
});
