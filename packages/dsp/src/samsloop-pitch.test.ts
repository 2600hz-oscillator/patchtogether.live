// SAMSLOOP pitch_cv — the 1V/oct multiply, driven through the REAL processor.
//
// The worklet is the only place the law `step = rate × 2^V × rateScale` lives
// (packages/web cannot import this file and the dsp package cannot import
// packages/web, so a web-side "mirror" would be a second copy of the law that
// nothing keeps in step — the audio-runtime skill's "a mirror is not a
// control"). So the processor class itself is instantiated here via the
// registerProcessor shim (the clip-recorder.test.ts shape) and its OUTPUT is
// measured: a loaded sine's zero-crossing period is the observable, and the
// ratio of periods between two volts IS 2^ΔV.
//
// What each leg pins, and why it is there:
//   (a) ABSENT input vs a connected 0 V input → BYTE-IDENTICAL output. The
//       saved-rack guarantee: every existing samsloop patch has no pitch_cv
//       cable, and the reconciler will add one carrying 0 V for a clip note at
//       C4 — neither may change a single sample.
//   (b) +1 V → the period HALVES (2×).      (c) −1 V → it DOUBLES (0.5×).
//   (d) +7/12 V → 2^(7/12) within 1 % — the exp-vs-linear discriminator: an
//       additive (knob + V) path would read 1.583×, 5.5 % out.
//   (e) rate −1 + V=+1 → REVERSE at 2×: direction is the knob's, the volt
//       only scales |step|.
//   (f) a block of NaN then 0 V → output finite and non-zero afterwards (the
//       `Number.isFinite` guard; Math.max/min propagate NaN into the cursor).
//   (g) V = +20 → the ±PITCH_OCTAVE_GUARD clamp keeps the output finite.

import { beforeAll, describe, expect, it } from 'vitest';

const SR = 48_000;
const BLOCK = 128;

interface ProcInstance {
  port: { onmessage: unknown };
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
type ProcCtor = new (o?: { processorOptions?: { maxVoices?: number } }) => ProcInstance;

let Samsloop: ProcCtor | null = null;
let registeredName = '';

beforeAll(async () => {
  const g = globalThis as unknown as {
    sampleRate?: number;
    AudioWorkletProcessor?: unknown;
    registerProcessor?: (n: string, c: ProcCtor) => void;
  };
  g.sampleRate = SR;
  // ALWAYS install a port-having stub base (never `if undefined`): the dsp
  // suite runs single-fork, so another worklet test may already have installed
  // a port-less stub.
  g.AudioWorkletProcessor = class {
    port = { onmessage: null as unknown, postMessage: (): void => {} };
  };
  g.registerProcessor = (n, ctor) => {
    registeredName = n;
    Samsloop = ctor;
  };
  // @ts-expect-error import-less worklet has no module shape; side-effect import only (registerProcessor captures the class)
  await import('./samsloop');
  if (!Samsloop) throw new Error('samsloop did not registerProcessor');
});

/** A 200 Hz sine, 480 frames — EXACTLY two cycles, so the loop wrap is
 *  seamless and every zero-crossing in the output belongs to the sine, not to
 *  the seam (a 2.2-cycle buffer put a spurious crossing at each wrap and
 *  skewed the mean period by ~1 %). */
const SINE_HZ = 200;
const SINE_FRAMES = 480;
function sine(): Float32Array {
  const b = new Float32Array(SINE_FRAMES);
  for (let i = 0; i < SINE_FRAMES; i++) b[i] = Math.sin((2 * Math.PI * SINE_HZ * i) / SR);
  return b;
}

function params(rate = 1): Record<string, Float32Array> {
  return {
    rate: Float32Array.of(rate),
    mode: Float32Array.of(1), // loop — the cursor never stops
    start: Float32Array.of(0),
    end: Float32Array.of(1),
    poly: Float32Array.of(0),
  };
}

interface Rig {
  proc: ProcInstance;
  /** Run one quantum with the given pitch_cv lane (`undefined` = input 1
   *  ABSENT, as a node with nothing patched delivers it). */
  run(pitch: Float32Array | undefined, rate?: number): Float32Array;
}

function rig(): Rig {
  const proc = new Samsloop!({ processorOptions: { maxVoices: 1 } });
  const buf = sine();
  (proc.port.onmessage as (e: { data: unknown }) => void)({
    data: { type: 'loadSample', samples: buf.buffer, sampleRate: SR },
  });
  (proc.port.onmessage as (e: { data: unknown }) => void)({ data: { type: 'trigger' } });
  return {
    proc,
    run(pitch, rate = 1) {
      const out = new Float32Array(BLOCK);
      const trig = new Float32Array(BLOCK); // held low — the manual trigger started it
      const inputs: Float32Array[][] = pitch === undefined ? [[trig]] : [[trig], [pitch]];
      proc.process(inputs, [[out]], params(rate));
      return out;
    },
  };
}

const volts = (v: number): Float32Array => new Float32Array(BLOCK).fill(v);

/** Render `blocks` quanta at a constant volt and return the mean distance
 *  between successive upward zero-crossings, in output frames. */
function periodAt(v: number | undefined, blocks: number, rate = 1): number {
  const r = rig();
  const all: number[] = [];
  for (let b = 0; b < blocks; b++) all.push(...r.run(v === undefined ? undefined : volts(v), rate));
  // Sub-frame crossing times (linear interpolation across the sign change),
  // so the ±1-frame quantisation of an integer index does not bound the
  // precision of a ratio the assertion holds to 1 %.
  const ups: number[] = [];
  for (let i = 1; i < all.length; i++) {
    const a = all[i - 1]!;
    const b = all[i]!;
    if (a <= 0 && b > 0) ups.push(i - 1 + (0 - a) / (b - a));
  }
  if (ups.length < 3) throw new Error(`too few crossings to measure a period (${ups.length})`);
  let sum = 0;
  for (let i = 1; i < ups.length; i++) sum += ups[i]! - ups[i - 1]!;
  return sum / (ups.length - 1);
}

/** ≥ 20 blocks = 2560 frames ≈ 11 cycles at unity — enough crossings that the
 *  ±1-frame quantisation of each one averages below the 1 % bound. */
const BLOCKS = 40;

describe('samsloop pitch_cv — rate × 2^V through the real processor', () => {
  it('registers as `samsloop`', () => {
    expect(registeredName).toBe('samsloop');
  });

  it('(a) ABSENT input 1 and a connected 0 V lane render BYTE-IDENTICAL output (saved-rack guarantee)', () => {
    const a = rig();
    const b = rig();
    for (let k = 0; k < BLOCKS; k++) {
      const outA = a.run(undefined);
      const outB = b.run(volts(0));
      expect(Array.from(outB)).toEqual(Array.from(outA));
    }
    // And it really rendered something — the sine is playing.
    const peak = Math.max(...Array.from(a.run(undefined)).map(Math.abs));
    expect(peak).toBeGreaterThan(0.5);
  });

  it('(b) +1 V HALVES the period — one octave up = 2× playback', () => {
    const p0 = periodAt(0, BLOCKS);
    const p1 = periodAt(1, BLOCKS);
    expect(p0 / p1).toBeCloseTo(2, 1);
    expect(Math.abs(p0 / p1 / 2 - 1)).toBeLessThan(0.01);
  });

  it('(c) −1 V DOUBLES the period — one octave down = 0.5× playback', () => {
    const p0 = periodAt(0, BLOCKS);
    const pm = periodAt(-1, BLOCKS);
    expect(Math.abs(pm / p0 / 2 - 1)).toBeLessThan(0.01);
  });

  it('(d) +7/12 V → 2^(7/12) within 1 % — exponential, NOT additive', () => {
    const p0 = periodAt(0, BLOCKS);
    const p7 = periodAt(7 / 12, BLOCKS);
    const ratio = p0 / p7;
    const fifth = Math.pow(2, 7 / 12); // 1.4983
    expect(Math.abs(ratio / fifth - 1)).toBeLessThan(0.01);
    // NEGATIVE CONTROL on the law itself: the additive reading (knob 1 + V
    // = 1.583) is 5.7 % away and MUST NOT satisfy the same bound.
    const additive = 1 + 7 / 12;
    expect(Math.abs(ratio / additive - 1)).toBeGreaterThan(0.01);
  });

  it('(e) rate −1 with +1 V plays in REVERSE at 2× — direction is the knob\'s', () => {
    // Period halves against the same reversed run at 0 V…
    const pRev0 = periodAt(0, BLOCKS, -1);
    const pRev1 = periodAt(1, BLOCKS, -1);
    expect(Math.abs(pRev0 / pRev1 / 2 - 1)).toBeLessThan(0.01);
    // …and the cursor really walks BACKWARDS: the reversed run's first block
    // is the sine read from the window's END, i.e. the time-reverse of the
    // forward run's first block, not a copy of it.
    const fwd = Array.from(rig().run(volts(1), 1));
    const rev = Array.from(rig().run(volts(1), -1));
    expect(rev).not.toEqual(fwd);
    // Forward starts at cursor 0 (sin 0 = 0, rising); reverse starts at
    // end − 1 and descends.
    expect(fwd[1]!).toBeGreaterThan(0);
    expect(rev[0]).not.toBe(fwd[0]);
  });

  it('(f) a block of NaN then 0 V leaves the output FINITE and NON-ZERO (the isFinite guard)', () => {
    const r = rig();
    const nan = new Float32Array(BLOCK).fill(Number.NaN);
    const during = r.run(nan);
    expect(during.every((x) => Number.isFinite(x))).toBe(true);
    let peak = 0;
    for (let k = 0; k < 4; k++) {
      const out = r.run(volts(0));
      expect(out.every((x) => Number.isFinite(x))).toBe(true);
      for (const x of out) peak = Math.max(peak, Math.abs(x));
    }
    expect(peak).toBeGreaterThan(0.5);
  });

  it('(g) +20 V is clamped by PITCH_OCTAVE_GUARD — output stays finite', () => {
    const r = rig();
    for (let k = 0; k < 8; k++) {
      const out = r.run(volts(20));
      expect(out.every((x) => Number.isFinite(x))).toBe(true);
    }
  });
});
