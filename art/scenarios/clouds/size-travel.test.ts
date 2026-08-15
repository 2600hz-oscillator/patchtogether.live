// art/scenarios/clouds/size-travel.test.ts
//
// THE SIZE DIAL, MEASURED THROUGH THE SHIPPING WORKLET.
//
// `packages/dsp/src/clouds.ts` is captured via the `registerProcessor` shim and
// pumped through `process()` in 128-sample blocks — the real cadence, the real
// class, zero reimplementation (art/setup/worklet.ts). Two separate jobs:
//
//   1 · THE DEFECT #1456 FIXED. The grain-length law asked for up to 1500 ms
//       while `safeLen = min(lengthSamples, floor(bufLen · 0.4))` allowed 800,
//       so every SIZE above log(800/60)/log(25) = 0.804744 produced the same
//       800 ms grain: MEASURED, the top 19.50 % of the dial rendered
//       BIT-IDENTICAL output. The ceiling is now derived from the law. This
//       file pins the fix AND keeps the old arithmetic alive as the negative
//       control, so "the dial is alive" can never degrade into "the comparison
//       always says different".
//
//   2 · THE MIRROR IS HONEST. `cloudsMath` (packages/web/.../clouds.ts) is a
//       hand-kept copy of this algorithm, and EVERY faceplate oracle in
//       clouds-face-model.test.ts measures against it rather than against the
//       worklet. Nothing gated that copy — the two files just say "keep these
//       numerically identical" in a comment, which is the one-side-of-a-
//       two-sided-contract shape CLAUDE.md is about. Asserted here, sample for
//       sample, so a mirror that drifts reddens instead of quietly turning
//       eight face claims into claims about a reimplementation.
//       ⚠ SCOPE, STATED: the parity leg covers the UNFROZEN path only. The two
//       expose freeze through different interfaces (the worklet toggles a latch
//       on a rising gate edge; the mirror takes a sample index), so there is no
//       common input to drive — freeze parity is not claimed here and is not
//       covered anywhere else either.

import { beforeAll, describe, expect, it } from 'vitest';
import {
  captureWorkletProcessor,
  renderWorklet,
  type WorkletProcessorCtor,
} from '../../setup/worklet';
import {
  CLOUDS_GRAIN_MAX_MS,
  CLOUDS_GRAIN_MIN_MS,
  cloudsMath,
  type CloudsParams,
} from '../../../packages/web/src/lib/audio/modules/clouds';

const SR = 48000;

let Ctor: WorkletProcessorCtor;
beforeAll(async () => {
  Ctor = await captureWorkletProcessor(
    'clouds',
    // @ts-expect-error TS2306 — import-less worklet entry has no module shape; side-effect
    // import only, ctor captured via the registerProcessor shim. `export {}` would leak into
    // dist and break ART's classic-script eval (memory: dsp-worklet-no-top-level-export).
    () => import('../../../packages/dsp/src/clouds'),
    SR,
  );
});

/** Deterministic broadband noise. A sine is a pathological granular source —
 *  every grain is coherent, so they beat — and a plateau scan on one would be
 *  reading the beat pattern. */
function noise(n: number, seed = 12345): { L: Float32Array; R: Float32Array } {
  let st = seed | 0;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    st = Math.imul(st, 1103515245) + 12345;
    L[i] = ((((st >>> 16) & 0x7fff) / 0x7fff) * 2 - 1) * 0.5;
    R[i] = L[i]!;
  }
  return { L, R };
}

/** ⚠ `blend: 1` IN EVERY RENDER HERE. At the def default of 0.5 half the output
 *  is the bit-exact dry path, so a SIZE probe would partly be measuring its own
 *  input and would keep passing on a module whose grain engine was dead. */
const DEFAULTS: CloudsParams & { blend: number } = {
  position: 0.5,
  size: 0.5,
  pitch: 0,
  density: 0.5,
  texture: 0.5,
  blend: 1,
};

type Src = { L: Float32Array; R: Float32Array };

/** The SHIPPING worklet, one fresh processor per render. */
function worklet(over: Partial<CloudsParams>, src: Src): Float32Array {
  const p = { ...DEFAULTS, ...over };
  return renderWorklet(new Ctor() as never, {
    totalSamples: src.L.length,
    inputs: [src.L, src.R, null, null],
    params: { ...p, freeze: 0 },
    outputs: ['out_l', 'out_r'],
  }).out_l!;
}

/** The pure-math mirror the faceplate oracles measure against. */
function mirror(over: Partial<CloudsParams>, src: Src): Float32Array {
  return cloudsMath.render(src.L, src.R, SR, 0, { ...DEFAULTS, ...over }).outL;
}

function bitIdentical(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function firstNonZeroMs(b: Float32Array): number {
  for (let i = 0; i < b.length; i++) if (b[i] !== 0) return (i / SR) * 1000;
  return -1;
}
function rmsDb(b: Float32Array, fromS: number, toS: number): number {
  const from = Math.floor(fromS * SR);
  const to = Math.min(b.length, Math.floor(toS * SR));
  let s = 0;
  for (let i = from; i < to; i++) s += b[i]! * b[i]!;
  return 20 * Math.log10(Math.max(1e-12, Math.sqrt(s / (to - from))));
}
/** The law, as the def declares it — re-stated from the exported constants so
 *  this file cannot pin a number the module has stopped using. */
const grainMs = (size: number): number =>
  CLOUDS_GRAIN_MIN_MS * Math.pow(CLOUDS_GRAIN_MAX_MS / CLOUDS_GRAIN_MIN_MS, size);

const SECONDS = 3;

describe('ART clouds / the instrument itself', () => {
  const src = noise(SR * SECONDS);

  it('DETERMINISM CONTROL: two identical worklet renders are bit-equal', () => {
    // Everything below reads a DIFFERENCE between two renders. If the engine
    // had any unseeded state (its LCG is fixed-seed, and this proves it) every
    // other assertion in this file would be measuring noise.
    expect(bitIdentical(worklet({}, src), worklet({}, src))).toBe(true);
  });

  it('MIRROR PARITY: cloudsMath renders the shipping worklet sample for sample', () => {
    const settings: Array<Partial<CloudsParams>> = [
      {},
      { size: 0 },
      { size: 0.9 },
      { size: 1 },
      { pitch: 7 },
      { pitch: -24 },
      { position: 0 },
      { position: 1 },
      { density: 0.2 },
      { texture: 0 },
      { blend: 0.5 },
    ];
    for (const over of settings) {
      const w = worklet(over, src);
      const m = mirror(over, src);
      let maxD = 0;
      let firstDiff = -1;
      for (let i = 0; i < w.length; i++) {
        const d = Math.abs(w[i]! - m[i]!);
        if (d > maxD) maxD = d;
        if (d !== 0 && firstDiff < 0) firstDiff = i;
      }
      expect(
        maxD,
        `${JSON.stringify(over)}: the mirror must be BIT-IDENTICAL to the worklet ` +
          `(max|Δ| ${maxD.toExponential(3)}, first differing sample ${firstDiff}) — every ` +
          `clouds faceplate oracle measures the mirror, so drift here silently invalidates them`,
      ).toBe(0);
    }
  });

  it('…and the parity comparison can FAIL — it is not asserting 0 against itself', () => {
    // A `maxD === 0` that could never be non-zero would pass against a mirror
    // that had drifted arbitrarily far. Mismatch the two deliberately.
    const w = worklet({ size: 0.5 }, src);
    const m = mirror({ size: 0.6 }, src);
    expect(bitIdentical(w, m)).toBe(false);
  });
});

describe('ART clouds / SIZE has no dead zone (the #1456 fix, pinned to the worklet)', () => {
  const src = noise(SR * SECONDS);
  /** Steps of 0.01–0.05 across the region that used to be one flat plateau.
   *  MEASURED quantisation floor elsewhere on the dial: two sizes render
   *  identically only within Δsize ≈ 6e-6…2.7e-5 (`Math.floor(ms/1000·sr)`), so
   *  these steps are 3–4 orders of magnitude clear of it and "different" is a
   *  statement about the CONTROL rather than about float resolution. */
  const TOP_LADDER = [0.79, 0.8, 0.804, 0.81, 0.85, 0.9, 0.95, 1] as const;
  /** Where the old 800 ms ceiling started binding. */
  const OLD_CLAMP_SIZE = Math.log(800 / 60) / Math.log(1500 / 60);

  it('every step of the old plateau now renders different samples', () => {
    const rendered = TOP_LADDER.map((size) => worklet({ size }, src));
    for (let i = 0; i < TOP_LADDER.length; i++) {
      for (let j = i + 1; j < TOP_LADDER.length; j++) {
        expect(
          bitIdentical(rendered[i]!, rendered[j]!),
          `SIZE ${TOP_LADDER[i]} vs ${TOP_LADDER[j]}: identical samples. Before #1456 the ` +
            `whole 0.8047..1 band was ONE render (19.50 % of the dial); if this is back, the ` +
            `grain ceiling is contradicting the SIZE law again`,
        ).toBe(false);
      }
    }
  });

  it('NEGATIVE CONTROL: the same detector, at the OLD ceiling, still reports the plateau', () => {
    // Pre-clamping the SIZE fed to the worklet reproduces the pre-#1456
    // arithmetic exactly — `lengthSamples(0.804744) === floor(0.4·bufLen)` at
    // any integer sample rate — so this renders the OLD module through the NEW
    // code and must come back dead. This is the leg that makes the clause above
    // a measurement: without it, a comparison stuck at "different" would pass
    // on a module whose SIZE knob was entirely disconnected.
    const oldWay = (size: number): Float32Array =>
      worklet({ size: Math.min(size, OLD_CLAMP_SIZE) }, src);
    const top = oldWay(1);
    for (const size of [0.81, 0.85, 0.9, 0.95, 1]) {
      expect(
        bitIdentical(oldWay(size), top),
        `at the OLD 800 ms ceiling SIZE ${size} was bit-identical to maximum — a false here ` +
          `means the plateau detector is broken, not that the DSP improved`,
      ).toBe(true);
    }
    expect(
      bitIdentical(oldWay(0.5), oldWay(0.75)),
      'and it still separates two sizes BELOW the old ceiling, so it is not answering ' +
        '"identical" to everything',
    ).toBe(false);
  });

  it('the grain length the DSP actually uses IS the declared law, to the sample', () => {
    // ⚠ READ AS A TIME, NOT A LEVEL. The wet path is bit-zero for exactly one
    // grain length after a spawn (a grain starts at least `safeLen` behind the
    // write head and the ring is still empty there), so the FIRST NON-ZERO
    // SAMPLE is a direct, white-box-free read of the grain length. An RMS
    // bucket cannot resolve the 60 ms end of this at all — which is precisely
    // how the face spec measured "bit-zero for the first 0.25 s" and got a
    // number that is wrong at every SIZE.
    const long = noise(SR * 2);
    for (const size of [0, 0.25, 0.5, 0.75, 0.9, 1]) {
      const measured = firstNonZeroMs(worklet({ size }, long));
      expect(
        measured,
        `SIZE ${size}: the DSP's grain is ${measured.toFixed(1)} ms, the law says ` +
          `${grainMs(size).toFixed(1)} ms. A shortfall at the top means the ceiling is binding.`,
      ).toBeCloseTo(grainMs(size), 0);
    }
    // The top of the dial reaches the law's declared maximum — the clamp is a
    // guard, not a limit.
    expect(firstNonZeroMs(worklet({ size: 1 }, long))).toBeCloseTo(CLOUDS_GRAIN_MAX_MS, 0);
  });

  it('POSITION does not move the silence — it is a grain length and nothing else', () => {
    // The other half of the "0.25 s" correction: the quantity is SIZE-dependent
    // and POSITION-invariant, which is the opposite of what a reader expects.
    const src1 = noise(SR);
    const firsts = [0, 0.25, 0.5, 0.75, 1].map((position) =>
      Math.round((firstNonZeroMs(worklet({ position }, src1)) * SR) / 1000),
    );
    const span = Math.max(...firsts) - Math.min(...firsts);
    // ONE sample of slop, and it is a real asymmetry rather than noise:
    // `availableHistory = max(safeLen + 1, …)` puts position 1 one sample late
    // while the ring is still filling. Bounded rather than rounded away.
    expect(span, `POSITION moved the silence by ${span} samples (${firsts})`).toBeLessThanOrEqual(1);
  });
});

describe('ART clouds / full level lands one grain AFTER the ring fills', () => {
  it('at the 2.0 s ring fill the output is still ~12 dB down; the climb ends ≈2.3 s', () => {
    // ⚠ THE SPEC SAID "the step lands at t = 2.000 s, to the sample". It does
    // not. 2.0 s is when the RING fills; a grain spawned an instant before that
    // reads partly-unwritten tape for its whole life, so the level ramps for one
    // more grain. MEASURED here on the shipping worklet, 50 ms buckets relative
    // to steady state: 2.00 → −12.7 dB, 2.05 → −10.2, 2.10 → −5.7, 2.15 → −2.6,
    // 2.20 → −1.2, 2.30 → −0.7, 2.35 → −0.3. Asserted as a SHAPE (down at the
    // fill, arrived by the prediction) so it cannot pass on a flat render.
    const out = worklet({}, noise(SR * 4));
    const steady = rmsDb(out, 3.0, 4.0);
    const atFill = rmsDb(out, 1.95, 2.0);
    const predicted = 2.0 + grainMs(0.5) / 1000; // 2.30 s — what the face prints
    const after = rmsDb(out, predicted + 0.05, predicted + 0.35);
    expect(
      steady - atFill,
      `still well down at the 2.0 s fill (${atFill.toFixed(1)} vs steady ${steady.toFixed(1)})`,
    ).toBeGreaterThan(6);
    expect(
      Math.abs(steady - after),
      `arrived by ${predicted.toFixed(2)} s (${after.toFixed(1)} vs ${steady.toFixed(1)})`,
    ).toBeLessThan(1.5);
  });
});
