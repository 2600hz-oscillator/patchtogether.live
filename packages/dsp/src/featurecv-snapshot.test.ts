// packages/dsp/src/featurecv-snapshot.test.ts
//
// THE SNAPSHOT PIPE — the worklet→host display channel behind FEATURECV's card
// meters and its ONSET LED, and the gate for #1744.
//
// THE DEFECT, and why nothing could see it. `snapOnset` was written EVERY
// render quantum (`this.snapOnset = onsetSeen`) and READ every SIXTEENTH, while
// a trigger pulse is `TRIGGER_PULSE_S` = 5 ms = 240 samples ≈ 1.9 quanta. So a
// pulse only reached the host when it happened to straddle a quantum whose
// index was ≡ 0 (mod 16); the rest were overwritten before anyone looked.
// Measured against the shipping core at four hit rates: 18.8–25.0 % of the
// pulses the ONSET JACK emitted. Four hits in five never lit the LED.
//
// It is the `buggles` #1703 / `backdraft` #1725 shape — a consumer silently
// dropping input, with a FLAT FRACTION below 100 % as the tell — arrived at
// from the other side: those two dropped EDGES because a main-thread poller
// rescanned a ring buffer; this one drops them because two cadences inside one
// processor were never lined up.
//
// ⚠ WHY NO EXISTING GATE COULD SEE IT:
//   * `featurecv-dsp.test.ts` and the ART scenario drive the PURE CORE, which
//     has no port and no post cadence at all — the snapshot does not exist
//     there.
//   * `art/scenarios/featurecv/analysis.test.ts` renders through the real
//     factory but reads the OUTPUT BUFFERS. The snapshot is a `postMessage`,
//     not a signal, and an OfflineAudioContext render never delivers it.
//   * the card's own e2e drives a real chain and asserts CV movement; the LED
//     is a CSS opacity on a decaying glow, i.e. exactly the kind of observable
//     a dropped blink is invisible in.
//
// So the gate has to be HERE, on the processor itself, captured through the
// registerProcessor shim (the dx7-messages / cloudseed-seed pattern) — the
// worklet entry never top-level-exports its class, because that would break the
// ART harness's classic-script eval.

import { describe, it, expect, beforeAll } from 'vitest';
import { TRIGGER_PULSE_S } from './lib/featurecv-dsp';

const SR = 48000;
const BLOCK = 128;
/** The processor's own post cadence: one message per 16 quanta. Read off the
 *  behaviour below rather than typed as an expectation — the assertion is that
 *  the pipe DELIVERS, not that it delivers at a particular rate. */
const POSTS_PER = 16;

interface Snapshot {
  type: string;
  loud: number;
  bright: number;
  punch: number;
  onset: number;
}
interface ProcInstance {
  port: { onmessage: unknown; postMessage: (m: unknown) => void };
  process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean;
}
type ProcCtor = new (options?: { processorOptions?: unknown }) => ProcInstance;

let FeaturecvProcessor: ProcCtor | null = null;
/** Every posted snapshot, in order, for the instance under test. */
let posted: Snapshot[] = [];

beforeAll(async () => {
  const g = globalThis as unknown as {
    sampleRate?: number;
    AudioWorkletProcessor?: unknown;
    registerProcessor?: (n: string, c: ProcCtor) => void;
  };
  g.sampleRate = SR;
  // ALWAYS install a port-having stub base (never `if undefined`): the dsp
  // suite runs single-fork, so another worklet test may already have installed
  // a PORT-LESS stub.
  g.AudioWorkletProcessor = class {
    port = {
      onmessage: null as unknown,
      postMessage: (m: unknown): void => {
        posted.push(m as Snapshot);
      },
    };
  };
  g.registerProcessor = (_n, ctor) => {
    FeaturecvProcessor = ctor;
  };
  await import('./featurecv');
  if (!FeaturecvProcessor) throw new Error('featurecv processor did not register');
});

/** A k-rate parameter block. */
const kParams = (over: Record<string, number> = {}): Record<string, Float32Array> =>
  Object.fromEntries(
    Object.entries({
      attack: 10,
      release: 100,
      bipolar: 1,
      onset_sens: 0.5,
      onset_debounce: 80,
      ...over,
    }).map(([k, v]) => [k, Float32Array.of(v)]),
  );

/** Run `input` through a fresh processor a quantum at a time, returning both
 *  what the ONSET OUTPUT emitted and what the SNAPSHOT PIPE reported. The two
 *  are counted with the SAME predicate, which is the whole point — a drop is a
 *  difference between two numbers in one unit, not a feeling about a blink. */
function run(input: Float32Array, over: Record<string, number> = {}): { jack: number; led: number } {
  posted = [];
  const proc = new FeaturecvProcessor!();
  const params = kParams(over);
  let jack = 0;
  let prev = 0;
  for (let q = 0; q * BLOCK < input.length; q++) {
    const inBuf = new Float32Array(BLOCK);
    inBuf.set(input.subarray(q * BLOCK, Math.min(input.length, (q + 1) * BLOCK)));
    const outs = [0, 1, 2, 3].map(() => [new Float32Array(BLOCK)]);
    proc.process([[inBuf]], outs, params);
    const onset = outs[3]![0]!;
    for (let i = 0; i < BLOCK; i++) {
      if (onset[i]! >= 0.5 && prev < 0.5) jack++;
      prev = onset[i]!;
    }
  }
  // A "blink" is a posted snapshot whose onset flag is HIGH after one that was
  // not — the same rising-edge predicate applied to the display channel.
  let led = 0;
  let prevPost = 0;
  for (const m of posted) {
    if (m.type !== 'snapshot') continue;
    if (m.onset > 0.5 && prevPost <= 0.5) led++;
    prevPost = m.onset;
  }
  return { jack, led };
}

/** A train of short decaying tone bursts, offset past the first quantum. */
function hitTrain(hz: number, secs: number, decayS = 0.01, freq = 1200): Float32Array {
  const lead = Math.round(0.1 * SR);
  const n = lead + Math.round(secs * SR);
  const out = new Float32Array(n);
  const period = Math.round(SR / hz);
  const tail = Math.round(decayS * 6 * SR);
  for (let h = 0; h * period + lead < n; h++) {
    const start = lead + h * period;
    for (let i = start; i < Math.min(n, start + tail); i++) {
      out[i] += Math.exp(-(i - start) / (decayS * SR)) * Math.sin((2 * Math.PI * freq * i) / SR);
    }
  }
  return out;
}

describe('featurecv snapshot pipe (#1744) — the display channel must not drop what the jack emits', () => {
  it('the pulse really IS shorter than the post interval — the premise, stated as a measurement', () => {
    // Without this row the census below reads as a coincidence. The two
    // cadences are 240 samples against 2048; nothing lines them up, which is
    // why the OVERWRITE form dropped four hits in five rather than none or all.
    const pulseSamples = Math.round(TRIGGER_PULSE_S * SR);
    const postSamples = POSTS_PER * BLOCK;
    expect(
      pulseSamples,
      `a ${pulseSamples}-sample pulse against a ${postSamples}-sample post interval`,
    ).toBeLessThan(postSamples);
  });

  it('EVERY onset the jack emits reaches the host, at four hit rates', () => {
    const rows: string[] = [];
    for (const hz of [1, 2, 4, 8]) {
      const { jack, led } = run(hitTrain(hz, 8));
      rows.push(`${hz} Hz: jack ${jack} → led ${led}`);
      // The drive must have produced hits at all — otherwise 0 === 0 passes.
      expect(jack, `no onsets at ${hz} Hz: ${rows.join(' · ')}`).toBeGreaterThan(hz * 4);
      expect(led, `snapshot capture (rising edges, both channels): ${rows.join(' · ')}`).toBe(jack);
    }
  });

  it('NEGATIVE CONTROL ON THE COUNTER: a silent input reports nothing on either channel', () => {
    // "delivers everything" and "reports a blink every window" are the same
    // output on the census above unless silence is asserted too.
    const { jack, led } = run(new Float32Array(SR * 2));
    expect(jack).toBe(0);
    expect(led).toBe(0);
    // …and the pipe was posting the whole time, so `led === 0` is a real
    // measurement rather than a dead port.
    expect(posted.filter((m) => m.type === 'snapshot').length).toBeGreaterThan(10);
  });

  it('NEGATIVE CONTROL ON THE FIX: the OVERWRITE form drops most of them', () => {
    // The pre-fix arithmetic, replayed against the SAME onset stream this
    // processor produced, so the two numbers are directly comparable and the
    // fix is measured rather than asserted. Reproducing the defect here is what
    // stops a future "simplification" back to `snapOnset = onsetSeen` from
    // looking like a no-op.
    posted = [];
    const proc = new FeaturecvProcessor!();
    const params = kParams();
    const input = hitTrain(4, 8);
    let jack = 0;
    let prev = 0;
    let overwriteLed = 0;
    let overwritePrev = 0;
    let frame = 0;
    for (let q = 0; q * BLOCK < input.length; q++) {
      const inBuf = new Float32Array(BLOCK);
      inBuf.set(input.subarray(q * BLOCK, Math.min(input.length, (q + 1) * BLOCK)));
      const outs = [0, 1, 2, 3].map(() => [new Float32Array(BLOCK)]);
      proc.process([[inBuf]], outs, params);
      const onset = outs[3]![0]!;
      let seen = 0;
      for (let i = 0; i < BLOCK; i++) {
        if (onset[i]! >= 0.5 && prev < 0.5) jack++;
        if (onset[i]! > seen) seen = onset[i]!;
        prev = onset[i]!;
      }
      // THE OLD LINE: overwrite every quantum, read every sixteenth.
      const snapOnset = seen;
      if ((frame++ % POSTS_PER) === 0) {
        if (snapOnset > 0.5 && overwritePrev <= 0.5) overwriteLed++;
        overwritePrev = snapOnset;
      }
    }
    const fixedLed = posted.filter((m) => m.type === 'snapshot' && m.onset > 0.5).length > 0
      ? (() => {
          let n = 0;
          let p = 0;
          for (const m of posted) {
            if (m.type !== 'snapshot') continue;
            if (m.onset > 0.5 && p <= 0.5) n++;
            p = m.onset;
          }
          return n;
        })()
      : 0;
    expect(jack).toBeGreaterThan(20);
    expect(fixedLed, 'the SHIPPING pipe delivers every onset').toBe(jack);
    expect(
      overwriteLed,
      `the OVERWRITE form delivered ${overwriteLed} of ${jack} (${((overwriteLed / jack) * 100).toFixed(1)} %) — this leg must stay RED-worthy`,
    ).toBeLessThan(jack * 0.5);
  });

  it('the LED does not STICK: the latch is consumed at each post', () => {
    // The other failure the latch could have introduced. A latch that is never
    // cleared reports `onset: 1` forever after the first hit, which is a
    // different lie in the same channel and would pass every capture assertion
    // above.
    const input = new Float32Array(SR * 3);
    // ONE hit, early.
    const start = Math.round(0.2 * SR);
    for (let i = start; i < start + Math.round(0.06 * SR); i++) {
      input[i] = Math.exp(-(i - start) / (0.01 * SR)) * Math.sin((2 * Math.PI * 1200 * i) / SR);
    }
    const { jack, led } = run(input);
    expect(jack).toBe(1);
    expect(led).toBe(1);
    const high = posted.filter((m) => m.type === 'snapshot' && m.onset > 0.5).length;
    const total = posted.filter((m) => m.type === 'snapshot').length;
    expect(total).toBeGreaterThan(30);
    expect(high, `one hit lit ${high} of ${total} posted windows — the latch is not being consumed`).toBe(1);
  });

  it('the three feature LEVELS are posted UNIPOLAR regardless of POLARITY, which is the pipe\'s stated contract', () => {
    // Not a defect — `FeaturecvSnapshot` documents it — but it is the reason
    // the FACEPLATE does not reproduce these bars: they are a different number
    // from the jack, and at the shipped BIPOLAR default they differ in SIGN.
    const input = hitTrain(4, 3);
    run(input, { bipolar: 1 });
    const bi = posted.filter((m) => m.type === 'snapshot').at(-1)!;
    run(input, { bipolar: 0 });
    const uni = posted.filter((m) => m.type === 'snapshot').at(-1)!;
    for (const k of ['loud', 'bright', 'punch'] as const) {
      expect(bi[k], `'${k}' snapshot must be polarity-invariant`).toBe(uni[k]);
      expect(bi[k]).toBeGreaterThanOrEqual(0);
      expect(bi[k]).toBeLessThanOrEqual(1);
    }
  });
});
