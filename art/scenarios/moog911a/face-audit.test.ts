// art/scenarios/moog911a/face-audit.test.ts
//
// THE ADVERSARIAL AUDIT FOR MOOG911A, and the permanent anchor under its
// faceplate (queue Q35, #1886).
//
// Everything here is measured against the REAL worklet — the shipping
// `Moog911aProcessor` captured through the shared `registerProcessor` shim and
// pumped through `process()` in 128-sample blocks at 48 kHz, the same path
// `profile.test.ts` renders the pinned `.f32` through.
//
// WHAT THIS FILE IS FOR, beyond regression. `moog911a-face-model.ts` is two
// closed forms, and a unit test over closed forms can only prove they are
// self-consistent. Three of the claims underneath them are about a TIMER:
//
//   1. THERE IS NO TRIGGER QUEUE, so `1/delay` is a CLIFF and not a rolloff.
//      That is the whole merit argument of the face, and `max rate` is that
//      number — asserted here against edge counts on the real output, with the
//      minimum-delay positive control that separates "the delay is the limit"
//      from "the clock is too fast for the module".
//   2. THE MODE SWITCH TURNS AN INPUT JACK ON AND OFF, which is the face's
//      rank-2 argument and the reason `last out` is not a relabelled knob.
//   3. THE MODE BOUNDARIES ARE `Math.round`, NOT the pure core's clamp — the
//      model mirrors the WORKLET deliberately, and this is where that mirror is
//      checked against the thing it mirrors.
//
// ⚠ It also pins the two facts the DOCS now state and nothing else could check:
// the fixed 1.0000 ms pulse width that is on no dial, and the SERIES total
// being delay1 + delay2 plus exactly ONE SAMPLE.

import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE } from '../../setup/capture';
import { captureWorkletProcessor, renderWorklet } from '../../setup/worklet';
import {
  moog911aLastOutMs,
  moog911aMaxRateHz,
  moog911aModeName,
} from '$lib/ui/modules/moog911a-face-model';
import { moog911aDef, MOOG911A_MODE_NAMES } from '$lib/audio/modules/moog911a';

const SR = SAMPLE_RATE;
/** The def's shipped spawn defaults. DERIVED — no param table here. */
const D: Record<string, number> = Object.fromEntries(
  moog911aDef.params.map((p) => [p.id, p.defaultValue]),
);
const OUT_IDS: readonly string[] = moog911aDef.outputs.map((o) => o.id);

interface Patch {
  delay1?: number;
  delay2?: number;
  mode?: number;
}

async function render(
  seconds: number,
  patch: Patch,
  trig1: (i: number) => boolean,
  trig2: (i: number) => boolean = () => false,
): Promise<Record<string, Float32Array>> {
  const Proc = await captureWorkletProcessor(
    'moog911a',
    () => import('../../../packages/dsp/src/moog911a'),
    SR,
  );
  const n = Math.round(seconds * SR);
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    a[i] = trig1(i) ? 1 : 0;
    b[i] = trig2(i) ? 1 : 0;
  }
  return renderWorklet(new Proc(), {
    totalSamples: n,
    inputs: [a, b],
    params: { delay1: D.delay1!, delay2: D.delay2!, mode: D.mode!, ...patch },
    outputs: OUT_IDS,
  });
}

/** Rising edges at the canonical 0.5 gate threshold. */
function risingEdges(a: Float32Array): number {
  let n = 0;
  let prev = false;
  for (let i = 0; i < a.length; i++) {
    const hi = a[i]! >= 0.5;
    if (hi && !prev) n++;
    prev = hi;
  }
  return n;
}
function firstEdge(a: Float32Array, from = 0): number {
  let prev = from > 0 ? a[from - 1]! >= 0.5 : false;
  for (let i = from; i < a.length; i++) {
    const hi = a[i]! >= 0.5;
    if (hi && !prev) return i;
    prev = hi;
  }
  return -1;
}
function pulseWidth(a: Float32Array, at: number): number {
  let n = 0;
  for (let i = at; i < a.length && a[i]! >= 0.5; i++) n++;
  return n;
}
const bytes = (a: Float32Array) =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');

/** One 1-sample trigger at index k. */
const at = (k: number) => (i: number) => i === k;
/** A 1-sample-wide clock at `hz`. */
const clock = (hz: number) => {
  const per = Math.round(SR / hz);
  return (i: number) => i % per === 0;
};
const NONE = () => false;

describe('ART moog911a / face audit — THE DELAY IS EXACT, AND THE PULSE IS FIXED', () => {
  it('every declared delay lands to the SAMPLE, and the pulse is 1.0000 ms on no dial', async () => {
    for (const d of [0.002, 0.01, 0.1, 0.5, 1]) {
      const { out1 } = await render(d + 0.1, { delay1: d }, at(1000));
      const fired = firstEdge(out1!, 1001);
      expect(fired, `delay1=${d}s: fired at sample ${fired}`).toBe(1000 + Math.round(d * SR));
      // The width is a CONSTANT the module never exposes: half the period at the
      // 2 ms minimum, a hundredth of a percent at the 10 s maximum.
      expect(pulseWidth(out1!, fired), `delay1=${d}s pulse width (samples)`).toBe(48);
    }
  });

  it('SERIES lands at delay1 + delay2 plus EXACTLY ONE SAMPLE (the docs correction)', async () => {
    for (const [d1, d2] of [
      [0.1, 0.1],
      [0.002, 0.002],
      [0.25, 0.5],
    ]) {
      const { out2 } = await render(d1! + d2! + 0.1, { mode: 2, delay1: d1, delay2: d2 }, at(1000));
      const fired = firstEdge(out2!, 1001);
      const exact = 1000 + Math.round(d1! * SR) + Math.round(d2! * SR);
      // Causality: the chain reads OUT 1 from the PREVIOUS sample. One sample,
      // never two — pinned so it cannot grow unnoticed.
      expect(fired - exact, `d1=${d1} d2=${d2}: residual in samples`).toBe(1);
    }
  });
});

describe('ART moog911a / face audit — #1886: NO QUEUE, so 1/delay is a CLIFF', () => {
  it('the `max rate` readout IS the rate above which OUT 1 goes silent', async () => {
    const SECONDS = 3;
    const rate = moog911aMaxRateHz({ delay1: D.delay1!, delay2: D.delay2!, mode: 0 });
    expect(rate).toBeCloseTo(10, 9);

    // Below the readout: everything (or all but one) gets through.
    for (const hz of [4, 8]) {
      const { out1 } = await render(SECONDS, {}, clock(hz));
      const expected = Math.ceil((SECONDS * SR) / Math.round(SR / hz));
      expect(risingEdges(out1!), `${hz} Hz in/out`).toBe(expected);
    }
    // Just under it: still emitting.
    const near = await render(SECONDS, {}, clock(9.9));
    expect(risingEdges(near.out1!), '9.9 Hz must still emit').toBeGreaterThan(25);

    // AT and above it: NOTHING. Not fewer — none.
    for (const hz of [10, 16, 32]) {
      const { out1 } = await render(SECONDS, {}, clock(hz));
      expect(risingEdges(out1!), `${hz} Hz must emit NOTHING at a 0.1 s delay`).toBe(0);
    }

    // ⚠ POSITIVE CONTROL: the same clocks at the 0.002 s MINIMUM pass every
    // trigger. Without this, "0 out" is indistinguishable from a module that
    // cannot follow a fast clock at all.
    for (const hz of [16, 32]) {
      const { out1 } = await render(SECONDS, { delay1: 0.002 }, clock(hz));
      const expected = Math.ceil((SECONDS * SR) / Math.round(SR / hz));
      expect(risingEdges(out1!), `${hz} Hz at the minimum delay`).toBe(expected);
    }
  });

  it('the cliff MOVES with the delay dial, exactly as 1/delay predicts', async () => {
    // Two delays, two predicted ceilings, each checked on both sides. This is
    // what makes `max rate` a law rather than one lucky number.
    for (const delay1 of [0.05, 0.2]) {
      const predicted = moog911aMaxRateHz({ delay1, delay2: D.delay2!, mode: 0 });
      const below = await render(3, { delay1 }, clock(predicted * 0.8));
      const above = await render(3, { delay1 }, clock(predicted * 1.2));
      expect(risingEdges(below.out1!), `delay1=${delay1}: 0.8x the predicted ceiling`).toBeGreaterThan(0);
      expect(risingEdges(above.out1!), `delay1=${delay1}: 1.2x the predicted ceiling`).toBe(0);
    }
  });
});

describe('ART moog911a / face audit — MODE TURNS AN INPUT JACK ON AND OFF', () => {
  it('TRIG 2 alone fires OUT 2 in OFF and in NEITHER other mode (the rank-2 argument)', async () => {
    for (const mode of [0, 1, 2]) {
      const { out1, out2 } = await render(1, { mode }, NONE, at(100));
      expect(risingEdges(out2!), `${moog911aModeName(mode)}: TRIG 2 -> OUT 2`).toBe(
        mode === 0 ? 1 : 0,
      );
      expect(risingEdges(out1!), `${moog911aModeName(mode)}: TRIG 2 must never reach OUT 1`).toBe(0);
    }
    // The control: TRIG 1 reaches OUT 1 in ALL THREE modes — that asymmetry is
    // the whole reason DELAY 1 outranks MODE and MODE outranks DELAY 2.
    for (const mode of [0, 1, 2]) {
      const { out1, out2 } = await render(1, { mode }, at(100));
      expect(risingEdges(out1!), `${moog911aModeName(mode)}: TRIG 1 -> OUT 1`).toBe(1);
      expect(risingEdges(out2!), `${moog911aModeName(mode)}: TRIG 1 -> OUT 2`).toBe(
        mode === 0 ? 0 : 1,
      );
    }
  });

  it('the `last out` readout matches WHEN the last output actually fires', async () => {
    // THE ANCHOR for the second readout, across all three modes with the two
    // delays deliberately unequal so max() and sum() are distinguishable.
    const delay1 = 0.1;
    const delay2 = 0.4;
    for (const mode of [0, 1, 2]) {
      const { out1, out2 } = await render(1.2, { mode, delay1, delay2 }, at(1000));
      const e1 = firstEdge(out1!, 1001);
      const e2 = firstEdge(out2!, 1001);
      const lastSample = Math.max(e1, e2); // -1 when a channel never fires
      const measuredMs = ((lastSample - 1000) / SR) * 1000;
      const model = moog911aLastOutMs({ delay1, delay2, mode });
      expect(Math.abs(measuredMs - model), `${moog911aModeName(mode)}: model ${model} ms vs measured ${measuredMs} ms`)
        .toBeLessThanOrEqual((2 / SR) * 1000);
    }
  });

  it('⚠ in OFF, OUT 2 does not fire from TRIG 1 at all — so `last out` must ignore delay2 there', async () => {
    for (const delay2 of [0.002, 10]) {
      const { out2 } = await render(1, { mode: 0, delay2 }, at(100));
      expect(risingEdges(out2!), `OFF, delay2=${delay2}: OUT 2 from TRIG 1`).toBe(0);
    }
  });
});

describe('ART moog911a / face audit — THE MODE BOUNDARIES ARE Math.round', () => {
  it('the model\'s names match the SHIPPING behaviour at every sampled dial position', async () => {
    // ⚠ The pure core clamps `mode <= 0 … >= 2`, which would make PARALLEL the
    // answer across the whole open interval. The WORKLET rounds first. This
    // sweep is what says which of the two the shipping module obeys — measured
    // through behaviour (does TRIG 2 reach OUT 2?) rather than by reading the
    // param back.
    const disagreements: string[] = [];
    for (let i = 0; i <= 20; i++) {
      const v = (i / 20) * 2;
      const name = moog911aModeName(v);
      const { out2 } = await render(0.5, { mode: v }, NONE, at(100));
      const trig2Live = risingEdges(out2!) > 0;
      const expectLive = name === 'OFF';
      if (trig2Live !== expectLive) {
        disagreements.push(`mode=${v.toFixed(3)} model says ${name} but TRIG 2 ${trig2Live ? 'IS' : 'is NOT'} live`);
      }
    }
    expect(disagreements, 'the model mirrors the worklet, not the core').toEqual([]);
  });

  it('every declared option value resolves to its own label', () => {
    const options = moog911aDef.params.find((p) => p.id === 'mode')!.options ?? [];
    expect(options.length).toBe(MOOG911A_MODE_NAMES.length);
    for (const o of options) {
      expect(moog911aModeName(o.value), `option ${o.value}`).toBe(o.label);
    }
  });
});

describe('ART moog911a / face audit — SPAWN', () => {
  it('⚠ ALL THREE PARAMS ARE BIT-EXACTLY INERT with both TRIG jacks unpatched', async () => {
    const ref = await render(1, {}, NONE);
    const refBytes = OUT_IDS.map((id) => bytes(ref[id]!));
    const sweeps: readonly Patch[] = [
      { delay1: 0.002 }, { delay1: 10 },
      { delay2: 0.002 }, { delay2: 10 },
      { mode: 1 }, { mode: 2 },
    ];
    for (const patch of sweeps) {
      const r = await render(1, patch, NONE);
      OUT_IDS.forEach((id, k) => {
        expect(bytes(r[id]!), `${id} with ${JSON.stringify(patch)}`).toBe(refBytes[k]);
      });
    }
    // POSITIVE CONTROL: one trigger on TRIG 1 and the same sweep is NOT inert.
    const a = await render(1, { delay1: 0.1 }, at(100));
    const b = await render(1, { delay1: 0.5 }, at(100));
    expect(bytes(a.out1!)).not.toBe(bytes(b.out1!));
  });

  it('the delay is read ONLY at the triggering edge', async () => {
    // Armed at 0.1 s; the knob is irrelevant afterwards. Rendered as an a-rate
    // schedule so the param genuinely moves mid-countdown.
    const Proc = await captureWorkletProcessor(
      'moog911a',
      () => import('../../../packages/dsp/src/moog911a'),
      SR,
    );
    const n = Math.round(1.5 * SR);
    const trig = new Float32Array(n);
    trig[100] = 1;
    const sched = new Float32Array(n);
    const yankAt = 100 + Math.round(0.04 * SR);
    for (let i = 0; i < n; i++) sched[i] = i < yankAt ? 0.1 : 2.0;
    const bufs = renderWorklet(new Proc(), {
      totalSamples: n,
      inputs: [trig, null],
      params: { delay1: sched, delay2: D.delay2!, mode: D.mode! },
      outputs: OUT_IDS,
    });
    const fired = firstEdge(bufs.out1!, 101);
    expect(fired - 100, 'armed at 0.1 s and yanked to 2.0 s mid-countdown').toBe(
      Math.round(0.1 * SR),
    );
  });
});
