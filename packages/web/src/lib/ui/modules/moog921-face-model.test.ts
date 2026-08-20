// packages/web/src/lib/ui/modules/moog921-face-model.test.ts
//
// THE PERMANENT GATE BEHIND BOTH MOOG 921 FACEPLATES.
//
// It does three jobs, and the first is the one that makes the other two worth
// anything:
//
//   1. VALIDATES THE MODEL AGAINST THE SHIPPING WORKLETS. Every mirrored
//      constant in `moog921-face-model.ts` lives inside a worklet ENTRY file
//      that by design exports nothing (a top-level export leaks into the
//      bundled `dist/<name>.js` and breaks the ART classic-script eval), so it
//      had to be re-typed. Here each one is MEASURED off the real processor —
//      instantiated through the same registerProcessor shim the DSP unit tests
//      use — and asserted equal to the mirror. A mirrored constant nobody
//      measures is a second copy of a number; this is what makes it not one.
//      The headline leg chains the REAL 921A into the REAL 921B and asserts the
//      pitch the pair sings is the number the driver's faceplate prints.
//
//   2. NEGATIVE-CONTROLS EVERY READOUT, PERMANENTLY, on the input a knob
//      readback would be blind to. The eight readouts have DISJOINT reach by
//      design, so the whole matrix is asserted in both directions: each one
//      moves on its own inputs and is EXACTLY invariant to every other param.
//      That is what separates a derived readout from a knob relabelled.
//
//   3. PINS THE GLYPH RESOLUTION FOR BOTH HALVES, which differ — `none` on the
//      CV-only driver, `live-audio` on `sine` for the slave — with a negative
//      control on each.
//
// ⚠ AND IT RECORDS A LIVE DEFECT AS A MEASUREMENT (#1791, filed not fixed): the
// 921A's declared MINIMUM width produces the MIDPOINT duty. That is asserted
// against the real chain here so the day someone fixes the DSP, this file is
// what tells them the faceplate readout has to change with it.

import { describe, it, expect, beforeAll } from 'vitest';
import { moog921aDef, MOOG921A_RANGE_OPTIONS } from '$lib/audio/modules/moog921a';
import { moog921bDef, MOOG921B_SYNC_OPTIONS } from '$lib/audio/modules/moog921b';
import { moog921VcoDef, MOOG921VCO_SYNC_OPTIONS } from '$lib/audio/modules/moog921-vco';
import { glyphBinding } from '$lib/ui/workflow/shell-glyph-live';
import {
  MOOG921A_OCT_OCT_SPAN,
  MOOG921A_SEMI_OCT_SPAN,
  MOOG921B_LIN_FM_FULL_HZ,
  MOOG921B_PW_MAX,
  MOOG921B_PW_MIN,
  MOOG921B_WIDTH_NORMAL,
  MOOG921B_WIDTH_NORMAL_BELOW,
  MOOG921_MODEL_SR,
  busCompassHz,
  busCompassText,
  busPitchHz,
  busPitchHzAtSpan,
  busVolts,
  busVoltsText,
  moog921aFaceParams,
  moog921bFaceParams,
  rangeOctSpan,
  slaveDuty,
  slaveDutyText,
  slaveFmSpanHz,
  slaveFmText,
  slaveOffsetOct,
  slaveOffsetText,
  slaveOutDb,
  slaveOutText,
  slavePitchHz,
  slavePitchText,
  slaveSyncText,
  MOOG921VCO_LIN_FM_FULL_HZ,
  moog921VcoFaceParams,
  vcoCompassHz,
  vcoFmText,
  vcoOutDb,
  vcoOutText,
  vcoPitchHz,
  vcoPitchText,
  vcoSyncMode,
  vcoSyncText,
} from './moog921-face-model';

const SR = MOOG921_MODEL_SR;
const BLOCK = 128;
/** Blocks rendered per measurement. The 80 Hz one-pole knob smoothers in both
 *  worklets need ~50 ms; the first half of the run is discarded so every figure
 *  below is a STEADY-STATE reading rather than a transient. */
const BLOCKS = 400;
const SETTLE_BLOCKS = 200;

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

// ── the real worklets ───────────────────────────────────────────────────────

type ProcInstance = {
  process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean;
};
type ProcCtor = new () => ProcInstance;

const captured = new Map<string, ProcCtor>();

/** Capture a worklet's Processor class through the registerProcessor shim — the
 *  only way in, since the entry files top-level-export nothing on purpose. */
async function loadProcessor(name: 'moog921a' | 'moog921b' | 'moog921Vco'): Promise<ProcCtor> {
  const hit = captured.get(name);
  if (hit) return hit;
  const g = globalThis as unknown as { registerProcessor?: (n: string, c: ProcCtor) => void };
  const prev = g.registerProcessor;
  let registered: ProcCtor | null = null;
  g.registerProcessor = (_n, ctor) => { registered = ctor; };
  if (name === 'moog921a') await import('../../../../../dsp/src/moog921a');
  else if (name === 'moog921b') await import('../../../../../dsp/src/moog921b');
  else await import('../../../../../dsp/src/moog921-vco');
  g.registerProcessor = prev;
  if (!registered) throw new Error(`${name} processor did not register`);
  captured.set(name, registered);
  return registered;
}

function paramBlock(
  def: { params: readonly { id: string; defaultValue: number }[] },
  over: Record<string, number> = {},
): Record<string, Float32Array> {
  const out: Record<string, Float32Array> = {};
  for (const p of def.params) out[p.id] = new Float32Array([over[p.id] ?? p.defaultValue]);
  return out;
}

const zeros = (): Float32Array => new Float32Array(BLOCK);

/** Run the REAL 921A alone and return its two bus outputs' steady-state value. */
async function runDriver(over: Record<string, number>): Promise<{ freqBus: number; widthBus: number }> {
  const A = await loadProcessor('moog921a');
  const a = new A();
  const p = paramBlock(moog921aDef, over);
  let freqBus = 0;
  let widthBus = 0;
  for (let b = 0; b < BLOCKS; b++) {
    const out: Float32Array[][] = [[zeros()], [zeros()]];
    a.process([[zeros()], [zeros()]], out, p);
    freqBus = out[0]![0]![BLOCK - 1]!;
    widthBus = out[1]![0]![BLOCK - 1]!;
  }
  return { freqBus, widthBus };
}

interface SlaveReading {
  /** Fundamental in Hz, from rising zero-crossings on the SINE tap. */
  readonly hz: number;
  /** Fraction of RECT samples above zero, i.e. the duty cycle. */
  readonly duty: number;
  /** Peak |sample| on the SINE tap. */
  readonly peak: number;
}

/**
 * Run the REAL 921B and read its sine + rect taps.
 *
 * `driver` optionally chains the REAL 921A in front of it, block by block, so
 * the freq/width buses carry exactly what the driver emits — the shipping
 * signal path, not a synthesised stand-in.
 */
async function runSlave(opts: {
  bParams?: Record<string, number>;
  driverParams?: Record<string, number>;
  freqBus?: number;
  widthBus?: number;
  dcMod?: number;
}): Promise<SlaveReading> {
  const B = await loadProcessor('moog921b');
  const b = new B();
  const pb = paramBlock(moog921bDef, opts.bParams ?? {});

  const A = opts.driverParams ? await loadProcessor('moog921a') : null;
  const a = A ? new A() : null;
  const pa = opts.driverParams ? paramBlock(moog921aDef, opts.driverParams) : null;

  let crossings = 0;
  let prev = 0;
  let high = 0;
  let total = 0;
  let peak = 0;

  for (let blk = 0; blk < BLOCKS; blk++) {
    let freqBus: Float32Array;
    let widthBus: Float32Array;
    if (a && pa) {
      const aOut: Float32Array[][] = [[zeros()], [zeros()]];
      a.process([[zeros()], [zeros()]], aOut, pa);
      freqBus = aOut[0]![0]!;
      widthBus = aOut[1]![0]!;
    } else {
      freqBus = new Float32Array(BLOCK).fill(opts.freqBus ?? 0);
      widthBus = new Float32Array(BLOCK).fill(opts.widthBus ?? 0.5);
    }
    const bOut: Float32Array[][] = [[zeros()], [zeros()], [zeros()], [zeros()]];
    b.process(
      [
        [freqBus],
        [widthBus],
        [new Float32Array(BLOCK).fill(opts.dcMod ?? 0)],
        [zeros()],
        [zeros()],
      ],
      bOut,
      pb,
    );
    if (blk < SETTLE_BLOCKS) {
      prev = bOut[0]![0]![BLOCK - 1]!;
      continue;
    }
    const sine = bOut[0]![0]!;
    const rect = bOut[3]![0]!;
    for (let i = 0; i < sine.length; i++) {
      const v = sine[i]!;
      if (prev <= 0 && v > 0) crossings++;
      prev = v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    for (let i = 0; i < rect.length; i++) {
      if (rect[i]! > 0) high++;
      total++;
    }
  }
  const seconds = ((BLOCKS - SETTLE_BLOCKS) * BLOCK) / SR;
  return { hz: crossings / seconds, duty: high / total, peak };
}

/**
 * The zero-crossing census resolves to ±1 cycle over the measured window, so
 * every Hz comparison below is stated against THIS tolerance rather than a
 * guessed one. Window = 200 blocks × 128 samples ÷ 48 kHz = 0.5333 s ⇒ ±1.875 Hz.
 * Printed in the assertion messages, in Hz, per CLAUDE.md's units rule.
 */
const HZ_TOLERANCE = SR / ((BLOCKS - SETTLE_BLOCKS) * BLOCK);

// ── param readers ───────────────────────────────────────────────────────────

const aParams = (over: Partial<Record<string, number>> = {}) =>
  moog921aFaceParams((id) => over[id]);
const bParams = (over: Partial<Record<string, number>> = {}) =>
  moog921bFaceParams((id) => over[id]);

describe('moog921 face model — the MIRRORS are measured off the real worklets', () => {
  it('the FREQUENCY pot spans exactly 1 octave in SEMI and 6 in OCT (the 6:1 that IS the readout)', async () => {
    // The whole merit argument of this pair is that one dial position means two
    // pitches. That claim rests on these two numbers, which live in
    // `packages/dsp/src/moog921a.ts` and cannot be imported — so they are read
    // off the emitted bus instead of trusted.
    const semi = await runDriver({ frequency: 1, freqRange: 1 });
    const oct = await runDriver({ frequency: 1, freqRange: 2 });
    expect(semi.freqBus, 'freq_bus volts at frequency=+1, RANGE=SEMI').toBeCloseTo(
      MOOG921A_SEMI_OCT_SPAN,
      4,
    );
    expect(oct.freqBus, 'freq_bus volts at frequency=+1, RANGE=OCT').toBeCloseTo(
      MOOG921A_OCT_OCT_SPAN,
      4,
    );
    // …and the model agrees with the worklet at every declared corner.
    for (const frequency of [-1, -0.5, 0, 0.5, 1]) {
      for (const freqRange of [1, 2]) {
        const measured = await runDriver({ frequency, freqRange });
        expect(
          measured.freqBus,
          `busVolts model vs worklet at frequency=${frequency} freqRange=${freqRange} (volts)`,
        ).toBeCloseTo(busVolts(aParams({ frequency, freqRange })), 4);
      }
    }
  });

  it('NEGATIVE CONTROL: the RANGE switch is BIT-EXACTLY INERT at the shipped dial', async () => {
    // This is the measured reason RANGE ranks 2 and not 1 — `frequency`
    // defaults to 0 and the worklet computes `frequency × octSpan`, so both
    // positions put the same 0 V on the bus. A rank argument that would be
    // wrong for a different module.
    const semi = await runDriver({ frequency: 0, freqRange: 1 });
    const oct = await runDriver({ frequency: 0, freqRange: 2 });
    expect(semi.freqBus, 'freq_bus volts, RANGE=SEMI at the shipped frequency').toBe(0);
    expect(oct.freqBus, 'freq_bus volts, RANGE=OCT at the shipped frequency').toBe(0);
    expect(busVolts(aParams({ freqRange: 1 }))).toBe(busVolts(aParams({ freqRange: 2 })));
    // …and the instrument is not simply blind: one notch off centre, it moves.
    expect(busVolts(aParams({ frequency: 0.5, freqRange: 1 }))).not.toBe(
      busVolts(aParams({ frequency: 0.5, freqRange: 2 })),
    );
  });

  it('THE HEADLINE: the same dial position sings F#4 or C7 — measured through the REAL pair', async () => {
    // The 921A chained into the 921B, both real, at the 921B's own defaults.
    // This is the number no surface in the shipped UI prints, and the `bus` +
    // `span` readouts exist because of it.
    const semi = await runSlave({ driverParams: { frequency: 0.5, freqRange: 1 } });
    const oct = await runSlave({ driverParams: { frequency: 0.5, freqRange: 2 } });

    // ⚠ COMPARED AGAINST THE CENSUS RESOLUTION, NOT AGAINST A ROUND NUMBER OF
    // DECIMALS. A rising-zero-crossing count over a fixed window resolves to ±1
    // cycle, i.e. ±HZ_TOLERANCE — measured 369.375 Hz against a true 369.994 Hz
    // — so a `toBeCloseTo(…, 0)` here would be asserting a precision the
    // instrument does not have and would redden on window length alone.
    expect(
      Math.abs(semi.hz - 369.994),
      `SEMI at frequency=+0.50 (Hz; census resolution ±${HZ_TOLERANCE.toFixed(2)} Hz)`,
    ).toBeLessThan(2 * HZ_TOLERANCE);
    expect(
      Math.abs(oct.hz - 2093.005),
      `OCT at frequency=+0.50 (Hz; census resolution ±${HZ_TOLERANCE.toFixed(2)} Hz)`,
    ).toBeLessThan(2 * HZ_TOLERANCE);
    // 2^2.5 = 5.657. Stated as the RATIO because that is the fact the faceplate
    // is for, and a ratio survives any future re-tuning of the C4 reference.
    expect(oct.hz / semi.hz, 'OCT ÷ SEMI at one dial position').toBeCloseTo(Math.pow(2, 2.5), 1);

    // …and the model predicts both, so the `bus`/`span` readouts are pinned to
    // the shipping chain rather than to their own arithmetic.
    expect(
      Math.abs(busPitchHz(aParams({ frequency: 0.5, freqRange: 1 })) - semi.hz),
      `model vs measured, SEMI (Hz; census resolution ±${HZ_TOLERANCE.toFixed(2)} Hz)`,
    ).toBeLessThan(2 * HZ_TOLERANCE);
    expect(
      Math.abs(busPitchHz(aParams({ frequency: 0.5, freqRange: 2 })) - oct.hz),
      `model vs measured, OCT (Hz; census resolution ±${HZ_TOLERANCE.toFixed(2)} Hz)`,
    ).toBeLessThan(3 * HZ_TOLERANCE);
  });

  it('the 921B pitch model matches the real worklet at every RANGE / FREQ corner', async () => {
    for (const [range, fine] of [
      [0, 0],
      [1, 0],
      [-1, 0],
      [0, 12],
      [0, -12],
      [2, 7],
    ] as const) {
      const measured = await runSlave({ bParams: { range, fine } });
      expect(
        Math.abs(measured.hz - slavePitchHz(bParams({ range, fine }))),
        `slavePitchHz vs worklet at range=${range} fine=${fine} (Hz; census ±${HZ_TOLERANCE.toFixed(2)} Hz)`,
      ).toBeLessThan(3 * HZ_TOLERANCE);
    }
  });

  it('LIN_FM_FULL_HZ is 2000 Hz, measured off the worklet rather than trusted', async () => {
    // `modAmount = 1` against a steady +1 on the DC-coupled FM input is exactly
    // full-scale linear FM, so the pitch shift IS the constant.
    const base = await runSlave({ bParams: { modAmount: 1 }, dcMod: 0 });
    const bent = await runSlave({ bParams: { modAmount: 1 }, dcMod: 1 });
    const measured = bent.hz - base.hz;
    expect(
      Math.abs(measured - MOOG921B_LIN_FM_FULL_HZ),
      `mirrored LIN_FM_FULL_HZ vs measured full-scale FM swing (Hz; census ±${HZ_TOLERANCE.toFixed(2)} Hz)`,
    ).toBeLessThan(4 * HZ_TOLERANCE);
    expect(slaveFmSpanHz(bParams({ modAmount: 1 })), 'the readout, Hz').toBeCloseTo(measured, -1);
  });

  it('the SYNC roster names exactly the states the DSP comparator has', () => {
    // The roster is a UI vocabulary over a DSP law; if they disagree the face
    // paints a state the worklet cannot be in.
    expect(MOOG921B_SYNC_OPTIONS.map((o) => o.value).sort((x, y) => x - y)).toEqual([-1, 0, 1]);
    expect(slaveSyncText(bParams({ syncMode: -1 }))).toBe('soft');
    expect(slaveSyncText(bParams({ syncMode: 0 }))).toBe('off');
    expect(slaveSyncText(bParams({ syncMode: 1 }))).toBe('hard');
    // ⚠ AND HALF THE DECLARED TRAVEL IS ONE FLAT STATE, which is why the curve
    // is `discrete` and the roster exists: without it the face painted a
    // continuous rotary printing `0.00` over a three-position switch.
    for (const v of [-0.49, -0.2, 0, 0.2, 0.49]) {
      expect(slaveSyncText(bParams({ syncMode: v })), `syncMode=${v}`).toBe('off');
    }
  });
});

describe('moog921 face model — the #1791 WIDTH cliff, measured (filed, not fixed)', () => {
  it('the DECLARED MINIMUM width produces the MIDPOINT duty, and the model says `norm`', async () => {
    const widthMin = moog921aDef.params.find((p) => p.id === 'width')!.min;
    expect(widthMin, 'the declared minimum this test is sampling AT').toBe(0);
    const measured = await runSlave({ driverParams: { width: widthMin } });
    expect(
      measured.duty,
      'duty at the DECLARED MINIMUM width, through the real 921A→921B chain (fraction)',
    ).toBeCloseTo(0.5, 2);
    // The model reproduces it AND flags that the bus is being ignored — a bare
    // `50 %` here would read like the dial working.
    expect(slaveDuty(widthMin).normalled).toBe(true);
    expect(slaveDutyText(widthMin)).toBe('norm 50 %');
  });

  it('the model tracks the real chain across the whole declared width range, cliff included', async () => {
    // Sampled AT the declared values and AT the threshold (#1758), not around
    // them. The `0.02` row is the subtle one: the bus is a Float32Array and
    // `Math.fround(0.02) < 0.02`, so the worklet's own comparison puts the
    // threshold itself on the NORMAL side.
    for (const width of [0, 0.0199, 0.02, 0.0201, 0.05, 0.25, 0.5, 0.9, 0.98, 1]) {
      const measured = await runSlave({ driverParams: { width } });
      const model = slaveDuty(width);
      expect(
        measured.duty,
        `duty at 921A width=${width} — model says ${(model.duty * 100).toFixed(0)} % ` +
          `(normalled=${model.normalled}); measured is a fraction of rect samples > 0`,
      ).toBeCloseTo(model.duty, 2);
    }
  });

  it('the cliff is REAL: one float32 step across the threshold moves the duty by 48 points', async () => {
    const below = await runSlave({ driverParams: { width: 0.02 } });
    const above = await runSlave({ driverParams: { width: 0.0201 } });
    expect(below.duty - above.duty, 'the discontinuity, in duty fraction').toBeGreaterThan(0.45);
    expect(slaveDuty(0.02).normalled, 'AT the declared threshold the normal fires').toBe(true);
    expect(slaveDuty(0.0201).normalled, 'one step above it does not').toBe(false);
  });

  it('the top of the travel is DEAD from the clamp upward', async () => {
    for (const width of [MOOG921B_PW_MAX, 0.99, 1]) {
      expect(slaveDuty(width).duty, `duty at width=${width}`).toBeCloseTo(MOOG921B_PW_MAX, 6);
    }
    const top = await runSlave({ driverParams: { width: 1 } });
    expect(top.duty, 'duty at the DECLARED MAXIMUM width (fraction)').toBeCloseTo(
      MOOG921B_PW_MAX,
      2,
    );
  });

  it('the clamp constants are the DSP’s, both ends', () => {
    expect(slaveDuty(MOOG921B_WIDTH_NORMAL_BELOW).duty).toBe(MOOG921B_WIDTH_NORMAL);
    expect(slaveDuty(0.5).duty).toBe(0.5);
    expect(slaveDuty(0.01 + MOOG921B_PW_MIN).duty).toBeCloseTo(0.03, 6);
    expect(slaveDuty(2).duty, 'above the 0..1 bus clamp').toBeCloseTo(MOOG921B_PW_MAX, 6);
  });
});

describe('moog921 face model — the READOUT REACH MATRIX (each is the others’ control)', () => {
  const A_PARAMS = moog921aDef.params.map((p) => p.id);
  const B_PARAMS = moog921bDef.params.map((p) => p.id);

  /** A perturbation that is IN RANGE and genuinely different from the default,
   *  derived from the def rather than typed, so a re-declared range cannot
   *  quietly turn a leg vacuous. */
  function perturb(def: { params: readonly { id: string; min: number; max: number; defaultValue: number }[] }, id: string): number {
    const p = def.params.find((q) => q.id === id)!;
    const v = p.defaultValue === p.max ? p.min : p.max;
    expect(v, `${id}: the perturbation must differ from the default`).not.toBe(p.defaultValue);
    return v;
  }

  it('the reach sets are EXACTLY as declared on the face — moved by these, invariant to the rest', () => {
    const reach: Record<string, { readonly ids: readonly string[]; readonly of: (over: Record<string, number>) => string }> = {
      'moog921a-bus': { ids: ['frequency', 'freqRange'], of: (o) => busVoltsText(aParams(o)) },
      'moog921a-span': { ids: ['freqRange'], of: (o) => busCompassText(aParams(o)) },
      'moog921a-duty': { ids: ['width'], of: (o) => slaveDutyText(aParams(o).width) },
    };
    for (const [id, spec] of Object.entries(reach)) {
      const base = spec.of({});
      for (const pid of A_PARAMS) {
        // `bus` needs frequency off centre before RANGE can reach it — that
        // inertness is asserted as its own leg above, so hold FREQ off centre
        // here to test REACH rather than re-test the cliff.
        const held: Record<string, number> = id === 'moog921a-bus' ? { frequency: 0.5 } : {};
        const moved = spec.of({ ...held, [pid]: perturb(moog921aDef, pid) });
        const reachedBase = spec.of(held);
        if (spec.ids.includes(pid)) {
          expect(moved, `${id} must MOVE on ${pid}`).not.toBe(reachedBase);
        } else {
          expect(moved, `${id} must be INVARIANT to ${pid}`).toBe(reachedBase);
        }
      }
    }
  });

  it('the 921B reach sets are EXACTLY as declared too', () => {
    const reach: Record<string, { readonly ids: readonly string[]; readonly of: (over: Record<string, number>) => string }> = {
      'moog921b-pitch': { ids: ['range', 'fine'], of: (o) => slavePitchText(bParams(o)) },
      'moog921b-offset': { ids: ['range', 'fine'], of: (o) => slaveOffsetText(bParams(o)) },
      'moog921b-out': { ids: ['level'], of: (o) => slaveOutText(bParams(o)) },
      'moog921b-fm': { ids: ['modAmount'], of: (o) => slaveFmText(bParams(o)) },
      'moog921b-sync': { ids: ['syncMode'], of: (o) => slaveSyncText(bParams(o)) },
    };
    for (const [id, spec] of Object.entries(reach)) {
      const base = spec.of({});
      for (const pid of B_PARAMS) {
        const moved = spec.of({ [pid]: perturb(moog921bDef, pid) });
        if (spec.ids.includes(pid)) {
          expect(moved, `${id} must MOVE on ${pid}`).not.toBe(base);
        } else {
          expect(moved, `${id} must be INVARIANT to ${pid}`).toBe(base);
        }
      }
    }
  });

  it('`span` reads the ENDPOINTS, so it is the permanent control for `bus`', () => {
    // The pair moog914 gets from peak/notch vs tilt: one number joins two
    // params, the other is invariant to one of them BY CONSTRUCTION.
    const a = busCompassHz(aParams({ frequency: -1 }));
    const b = busCompassHz(aParams({ frequency: 1 }));
    expect(a.lo, 'compass lo, Hz — invariant to the dial').toBe(b.lo);
    expect(a.hi, 'compass hi, Hz — invariant to the dial').toBe(b.hi);
    // …and it is not simply constant: the switch moves it by 2^5 at each end.
    const semi = busCompassHz(aParams({ freqRange: 1 }));
    const oct = busCompassHz(aParams({ freqRange: 2 }));
    expect(oct.hi / semi.hi, 'OCT hi ÷ SEMI hi').toBeCloseTo(Math.pow(2, 5), 3);
    expect(semi.lo / oct.lo, 'SEMI lo ÷ OCT lo').toBeCloseTo(Math.pow(2, 5), 3);
  });

  it('`offset` and `bus` are in units that ADD — which is the whole pairing claim', async () => {
    // The 921A publishes volts, the 921B publishes octaves, and the played
    // pitch is 261.626 · 2^(sum). Neither face can print the sum; this asserts
    // that composing the two published terms DOES land on the real pitch.
    const driverParams = { frequency: 0.5, freqRange: 2 };
    const bOver = { range: -1, fine: 12 };
    const measured = await runSlave({ driverParams, bParams: bOver });
    const composed =
      261.626 * Math.pow(2, busVolts(aParams(driverParams)) + slaveOffsetOct(bParams(bOver)));
    expect(
      Math.abs(measured.hz - composed),
      `composed(bus volts + offset oct) vs the real chain (Hz; census ±${HZ_TOLERANCE.toFixed(2)} Hz)`,
    ).toBeLessThan(3 * HZ_TOLERANCE);
  });

  it('`out` is the dB a LINEAR level dial cannot print, and it tracks the real output', async () => {
    expect(slaveOutDb(bParams({ level: 1 })), 'dB at unity').toBeCloseTo(0, 6);
    expect(slaveOutDb(bParams({ level: 2 })), 'dB at the declared max').toBeCloseTo(6.0206, 3);
    expect(slaveOutText(bParams({ level: 0 }))).toBe('silent');
    // The dial reads 1.00 and 2.00; the readout reads 0.0 dB and +6.0 dB.
    expect(slaveOutText(bParams({ level: 1 }))).toBe('+0.0 dB');
    expect(slaveOutText(bParams({ level: 2 }))).toBe('+6.0 dB');
    // …measured: doubling `level` doubles the peak on the real tap.
    const unity = await runSlave({ bParams: { level: 1 } });
    const doubled = await runSlave({ bParams: { level: 2 } });
    expect(doubled.peak / unity.peak, 'peak ratio at level 2 ÷ level 1').toBeCloseTo(2, 2);
  });

  it('`fm` prints `off` at the shipped depth, and the FM jacks really ARE silent there', async () => {
    expect(slaveFmText(bParams({}))).toBe('off');
    const quiet = await runSlave({ bParams: {}, dcMod: 1 });
    const base = await runSlave({ bParams: {}, dcMod: 0 });
    expect(
      Math.abs(quiet.hz - base.hz),
      `a full-scale DC modulator at the shipped FM depth (Hz; census ±${HZ_TOLERANCE.toFixed(2)} Hz)`,
    ).toBeLessThan(HZ_TOLERANCE);
  });
});

describe('moog921 face model — the two GLYPHS differ, and both are resolved not assumed', () => {
  it('the CV-only driver declares `none`, because nothing else could resolve', () => {
    expect(moog921aDef.outputs.every((o) => o.type === 'cv'), 'both driver outputs are cv').toBe(true);
    expect(moog921aDef.face?.glyph).toBe('none');
    expect(glyphBinding(moog921aDef).kind).toBe('none');
    // NEGATIVE CONTROL: any other literal on this def collapses to the dead
    // `{kind:'static'}` binding — #1692's twelve-segments-that-never-light.
    expect(
      glyphBinding({ ...moog921aDef, face: { ...moog921aDef.face!, glyph: 'meter' } }).kind,
      'a meter on a CV-only def is the DEAD shape',
    ).toBe('static');
  });

  it('the slave binds LIVE, to `sine` — one tap of four, named', () => {
    expect(moog921bDef.outputs.map((o) => o.id)).toEqual(['sine', 'triangle', 'saw', 'rect']);
    expect(moog921bDef.outputs.every((o) => o.type === 'audio')).toBe(true);
    expect(glyphBinding(moog921bDef)).toEqual({ kind: 'live-audio', portId: 'sine' });
    // …and the docs SAY it is the sine, which is the half a def-reading gate
    // cannot check on its own (the #1692 sibling failure: a glyph that resolves
    // to the WRONG thing passes every resolver assertion).
    expect(moog921bDef.docs?.outputs?.sine ?? '').toMatch(/glyph/i);
    // NEGATIVE CONTROL: strip the audio outputs and the same declaration dies.
    expect(
      glyphBinding({ ...moog921bDef, outputs: moog921bDef.outputs.map((o) => ({ ...o, type: 'cv' as const })) }).kind,
    ).toBe('static');
  });
});

describe('moog921 face model — TOTALITY (a readout runs on every render)', () => {
  const IDS = [
    'moog921a-bus',
    'moog921a-span',
    'moog921a-duty',
    ...MOOG921A_RANGE_OPTIONS.map((o) => `moog921a-pitch-${o.value}`),
    'moog921b-pitch',
    'moog921b-offset',
    'moog921b-out',
    'moog921b-fm',
    'moog921b-sync',
  ];

  it('the SPAWN-DEFAULT strings are pinned — they are what the dock VRT baselines capture', () => {
    // Every readout on both faces is a pure function of `node.params`, so all
    // eight print at the spawn defaults and are IN the dock image. Pinned here
    // rather than described in the VRT roster comment, so a formatter change
    // reddens a unit test before it reddens a baseline.
    expect(busVoltsText(aParams({}))).toBe('+0.00 V');
    expect(busCompassText(aParams({}))).toBe('130.8 Hz … 523.3 Hz');
    expect(slaveDutyText(aParams({}).width)).toBe('50 %');
    // ⚠ BOTH SIDEBAR ROWS READ THE SAME NUMBER AT SPAWN, and that is the face's
    // own rank argument rendered rather than asserted: at `frequency = 0` the
    // RANGE switch is inert, so SEMI and OCT genuinely are the same pitch.
    expect(busPitchHzAtSpan(aParams({}), rangeOctSpan(1))).toBeCloseTo(261.626, 3);
    expect(busPitchHzAtSpan(aParams({}), rangeOctSpan(2))).toBeCloseTo(261.626, 3);
    expect(slavePitchText(bParams({}))).toBe('261.6 Hz');
    expect(slaveOffsetText(bParams({}))).toBe('+0.00 oct');
    expect(slaveOutText(bParams({}))).toBe('+0.0 dB');
    expect(slaveFmText(bParams({}))).toBe('off');
    expect(slaveSyncText(bParams({}))).toBe('off');
  });

  it('the 44.1 kHz delta is a MEASURED number, not a shrug', () => {
    // `MOOG921_MODEL_SR` is a stated physical constant (the readout cannot ask
    // the live context for its rate). The only place the rate reaches the
    // answer is `moogFreqHz`'s Nyquist clamp, so the size of the approximation
    // is exactly "where does the top of the OCT compass get cut".
    const at48k = busCompassHz(aParams({ frequency: 1, freqRange: 2 })).hi;
    expect(at48k, 'the top of the OCT compass at 48 kHz, Hz').toBeCloseTo(16744.06, 1);
    // 16.74 kHz is under BOTH clamps (48 kHz × 0.49 = 23 520; 44.1 kHz × 0.49 =
    // 21 609), so the printed compass is rate-INDEPENDENT everywhere the dial
    // can reach. The constant only matters if the C4 reference or the span ever
    // grows.
    expect(at48k, 'the compass top must sit under the 44.1 kHz Nyquist clamp too').toBeLessThan(
      44100 * 0.49,
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE MONOLITH — moog921Vco, the family's third member.
//
// Same three jobs as above, against a DIFFERENT worklet: validate the mirrored
// constant, negative-control every readout permanently, pin the glyph. Plus one
// this face needs and the pair did not — the two controls whose rank argument is
// "bit-exactly dead at spawn" are ASSERTED dead, with positive controls, because
// a rank defended by a measurement should redden when the measurement stops
// being true.
//
// ⚠ EVERY SYNC / LIN-FM COMPARISON BELOW REPORTS THE **LAST DIVERGENT SAMPLE**,
// never a windowed RMS. That is the spec's own recorded adversarial attack
// (window sensitivity): a window can only ever say "not much happened HERE", and
// two renders that converge after 5 ms look identical to one that never diverged
// if you average over 2 s. The last index at which two renders differ is
// window-independent by construction — the whole buffer IS the window.
// ════════════════════════════════════════════════════════════════════════════

/** Render the REAL 921 VCO. Returns every tap SETTLED, plus the raw unsettled
 *  buffers the bit-comparisons need — a settle window would hide an early
 *  divergence, which is exactly what the last-divergent-sample form exists to
 *  prevent. */
async function runVco(opts: {
  params?: Record<string, number>;
  linFm?: (n: number) => number;
  sync?: (n: number) => number;
}): Promise<{ raw: Record<string, Float32Array>; settled: Record<string, Float32Array> }> {
  const V = await loadProcessor('moog921Vco');
  const v = new V();
  const p = paramBlock(moog921VcoDef, opts.params ?? {});
  const taps = ['sine', 'triangle', 'sawtooth', 'rectangular'] as const;
  const raw: Record<string, Float32Array> = {};
  const settled: Record<string, Float32Array> = {};
  for (const t of taps) {
    raw[t] = new Float32Array(BLOCKS * BLOCK);
    settled[t] = new Float32Array((BLOCKS - SETTLE_BLOCKS) * BLOCK);
  }
  for (let blk = 0; blk < BLOCKS; blk++) {
    const base = blk * BLOCK;
    const linBuf = zeros();
    const syncBuf = zeros();
    for (let i = 0; i < BLOCK; i++) {
      const n = base + i;
      if (opts.linFm) linBuf[i] = opts.linFm(n);
      if (opts.sync) syncBuf[i] = opts.sync(n);
    }
    const out: Float32Array[][] = [[zeros()], [zeros()], [zeros()], [zeros()]];
    v.process([[zeros()], [linBuf], [syncBuf], [zeros()]], out, p);
    for (let t = 0; t < taps.length; t++) {
      raw[taps[t]!]!.set(out[t]![0]!, base);
      if (blk >= SETTLE_BLOCKS) settled[taps[t]!]!.set(out[t]![0]!, (blk - SETTLE_BLOCKS) * BLOCK);
    }
  }
  return { raw, settled };
}

/** The LAST index at which two renders differ; -1 when they are bit-identical
 *  everywhere. THE window-independent question — see the block comment above. */
function lastDivergentSample(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error('lastDivergentSample: length mismatch');
  for (let i = a.length - 1; i >= 0; i--) if (a[i] !== b[i]) return i;
  return -1;
}

function rmsOf(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * a[i]!;
  return Math.sqrt(s / a.length);
}

/** Fundamental in Hz from a rising zero-crossing census on a settled tap. */
function hzOf(tap: Float32Array): number {
  let crossings = 0;
  let prev = 0;
  for (let i = 0; i < tap.length; i++) {
    const x = tap[i]!;
    if (prev <= 0 && x > 0) crossings++;
    prev = x;
  }
  return crossings / (tap.length / SR);
}

/** A 200 Hz full-scale sine — the master this module is asked to sync to, and
 *  the modulator its LIN FM jack is asked to track. */
const master200 = (n: number) => Math.sin((2 * Math.PI * 200 * n) / SR);

const vParams = (over: Partial<Record<string, number>> = {}) =>
  moog921VcoFaceParams((id) => over[id]);

describe('moog921Vco face model — the MIRROR is measured off the real worklet', () => {
  it('LIN_FM_FULL_HZ is 2000 Hz on THIS worklet, measured rather than inherited from the 921B', async () => {
    // A DC offset of +1 on lin_fm at full depth shifts the pitch by the full
    // span. Read by zero-crossing census, stated against the window's own
    // resolution rather than a guessed tolerance.
    const { settled } = await runVco({ params: { linFmAmount: 1 }, linFm: () => 1 });
    const hz = hzOf(settled.sine!);
    // The base is the MODEL's own C4 rather than a literal, so this leg chains
    // the thing under test instead of restating a number beside it.
    const expected = vcoPitchHz(vParams()) + MOOG921VCO_LIN_FM_FULL_HZ;
    expect(
      Math.abs(hz - expected),
      `measured ${hz.toFixed(2)} Hz vs mirrored C4+${MOOG921VCO_LIN_FM_FULL_HZ} = ${expected.toFixed(2)} Hz, tolerance ${(HZ_TOLERANCE * 2).toFixed(3)} Hz`,
    ).toBeLessThan(HZ_TOLERANCE * 2);
  });

  it('THE HEADLINE: RANGE + FREQ span exactly 12 octaves, and the endpoints come off the DEF', () => {
    const c = vcoCompassHz();
    expect(c.lo, 'the bottom of the compass, Hz').toBeCloseTo(4.0879, 3);
    expect(c.hi, 'the top of the compass, Hz').toBeCloseTo(16744.06, 1);
    expect(
      Math.log2(c.hi / c.lo),
      `octaves between the two dial extremes (${c.lo.toFixed(4)} Hz … ${c.hi.toFixed(2)} Hz)`,
    ).toBeCloseTo(12, 6);
    // NEITHER DIAL PRINTS IT: both default to zero, which is the entire reason
    // the `pitch` readout exists.
    const oct = moog921VcoDef.params.find((p) => p.id === 'octave')!;
    const tune = moog921VcoDef.params.find((p) => p.id === 'tune')!;
    expect([oct.defaultValue, tune.defaultValue], 'both pitch dials read 0 at spawn').toEqual([0, 0]);
    expect(vcoPitchHz(vParams()), 'and the answer there is C4, in Hz').toBeCloseTo(261.626, 3);
    // The compass is DERIVED from the def's own bounds — widening the def
    // widens the readout's claim with no edit here.
    expect([oct.min, oct.max, tune.min, tune.max]).toEqual([-5, 5, -12, 12]);
  });

  it('the pitch model matches the REAL worklet at every RANGE / FREQ corner', async () => {
    for (const [octave, tune] of [[0, 0], [1, 0], [-1, 0], [0, 12], [0, -12], [2, 7]] as const) {
      const { settled } = await runVco({ params: { octave, tune } });
      const measured = hzOf(settled.sine!);
      const model = vcoPitchHz(vParams({ octave, tune }));
      expect(
        Math.abs(measured - model),
        `octave=${octave} tune=${tune}: worklet ${measured.toFixed(2)} Hz vs model ${model.toFixed(2)} Hz, tolerance ${(HZ_TOLERANCE * 2).toFixed(3)} Hz`,
      ).toBeLessThan(HZ_TOLERANCE * 2);
    }
  });

  it('the SYNC roster names exactly the states the DSP comparator has, at the DSP’s own thresholds', () => {
    const sync = moog921VcoDef.params.find((p) => p.id === 'sync')!;
    expect(sync.curve, 'a roster is only legal on a discrete curve').toBe('discrete');
    expect(sync.options?.map((o) => o.value), 'the roster values').toEqual([-1, 0, 1]);
    expect(sync.options?.map((o) => o.label), 'this module’s OWN vocabulary, not the 921B’s').toEqual([
      'SOFT', 'OFF', 'HARD',
    ]);
    // Every declared detent resolves to a DISTINCT comparator state, and the
    // roster is exhaustive over them.
    const states = MOOG921VCO_SYNC_OPTIONS.map((o) => vcoSyncMode(vParams({ sync: o.value })));
    expect(states).toEqual(['soft', 'off', 'hard']);
    expect(new Set(states).size, 'no two detents mean the same thing').toBe(states.length);
  });
});

describe('moog921Vco face model — the RANK ARGUMENT is a measurement (last divergent sample)', () => {
  it('LIN FM: the jack is BIT-EXACTLY dead at the shipped depth, and the control proves the probe can see', async () => {
    const unpatched = await runVco({});
    const patched = await runVco({ linFm: master200 });
    expect(
      lastDivergentSample(unpatched.raw.sine!, patched.raw.sine!),
      'a 200 Hz sine on lin_fm at the shipped linFmAmount=0: last divergent sample (-1 = bit-identical)',
    ).toBe(-1);

    // POSITIVE CONTROL — and a SMALL one, so this asserts "a ±20 Hz span
    // registers", not the much weaker "any change at all registers".
    const open = await runVco({ linFm: master200, params: { linFmAmount: 0.01 } });
    expect(
      lastDivergentSample(unpatched.raw.sine!, open.raw.sine!),
      'linFmAmount=0.01 (a ±20 Hz span) must diverge, and through the END of the render',
    ).toBe(unpatched.raw.sine!.length - 1);
  });

  it('SYNC: the jack is BIT-EXACTLY dead at OFF, including everywhere in the dead zone (#1887)', async () => {
    const unpatched = await runVco({});
    const off = await runVco({ sync: master200 });
    expect(
      lastDivergentSample(unpatched.raw.sine!, off.raw.sine!),
      'a 200 Hz sine on the sync jack at the shipped sync=0 (OFF): last divergent sample',
    ).toBe(-1);

    // ⚠ THE DEAD ZONE, WHICH IS WHY #1887 WAS A DEFECT AND NOT A COSMETIC. The
    // card's three buttons cannot produce 0.3, but a Push 2 encoder maps through
    // `knobFracToValue(frac, min, max, curve)` and could land here. Now that the
    // curve is discrete both the faceplate and the encoder step to the detents —
    // this leg pins what the value MEANT while it was reachable, so a revert to
    // `linear` reddens with the reason attached.
    const dead = await runVco({ sync: master200, params: { sync: 0.3 } });
    expect(
      lastDivergentSample(unpatched.raw.sine!, dead.raw.sine!),
      'sync=0.3 is a SILENT OFF — bit-identical to an unpatched sync jack',
    ).toBe(-1);

    // POSITIVE CONTROL, both live detents.
    for (const v of [1, -1]) {
      const live = await runVco({ sync: master200, params: { sync: v } });
      expect(
        lastDivergentSample(unpatched.raw.sine!, live.raw.sine!),
        `sync=${v} (${vcoSyncMode(vParams({ sync: v }))}) must diverge through the END of the render`,
      ).toBe(unpatched.raw.sine!.length - 1);
    }
  });

  it('the four taps are NOT level-matched, which is what the docs now say and the glyph cannot show', async () => {
    const { settled } = await runVco({});
    const dbOf = (x: number) => 20 * Math.log10(x);
    const levels = {
      rectangular: dbOf(rmsOf(settled.rectangular!)),
      sine: dbOf(rmsOf(settled.sine!)),
      triangle: dbOf(rmsOf(settled.triangle!)),
      sawtooth: dbOf(rmsOf(settled.sawtooth!)),
    };
    // The ORDER is the claim; the dB are pinned to one decimal because polyBLEP
    // residuals move them in the third.
    expect(levels.rectangular, 'rect is the loudest tap, dB').toBeCloseTo(-0.044, 1);
    expect(levels.sine, 'sine, dB').toBeCloseTo(-3.011, 1);
    expect(levels.triangle, 'triangle, dB').toBeCloseTo(-4.771, 1);
    expect(levels.sawtooth, 'saw is the quietest tap, dB').toBeCloseTo(-4.834, 1);
    const spread = Math.max(...Object.values(levels)) - Math.min(...Object.values(levels));
    expect(
      spread,
      `dB between the loudest and quietest jack at ONE level setting (${JSON.stringify(levels)})`,
    ).toBeCloseTo(4.789, 1);
    // AND THE GLYPH DRAWS THE MIDDLE OF IT — stated so the picture is never read
    // as a proxy for what the patch hears.
    expect(levels.sine).toBeLessThan(levels.rectangular);
    expect(levels.sine).toBeGreaterThan(levels.sawtooth);
  });

  it('WIDTH is a pure TIMBRE control: the rect tap’s level does not move across the whole span', async () => {
    const at = async (width: number) => rmsOf((await runVco({ params: { width } })).settled.rectangular!);
    const dbOf = (x: number) => 20 * Math.log10(x);
    const lo = dbOf(await at(0.02));
    const mid = dbOf(await at(0.5));
    const hi = dbOf(await at(0.98));
    expect(
      Math.abs(lo - hi),
      `dB between a 2% sliver and a 98% pulse (${lo.toFixed(3)} vs ${hi.toFixed(3)})`,
    ).toBeLessThan(0.01);
    expect(Math.abs(mid - lo), `and against the 50% square (${mid.toFixed(3)})`).toBeLessThan(0.01);
  });
});

describe('moog921Vco face model — the READOUT REACH MATRIX (width is the fifth leg)', () => {
  const IDS = ['moog921vco-pitch', 'moog921vco-out', 'moog921vco-fm', 'moog921vco-sync'] as const;
  /** The params each readout is DECLARED to move on. Everything not listed must
   *  leave it EXACTLY unchanged — asserted in both directions below. */
  const REACH: Record<string, readonly string[]> = {
    'moog921vco-pitch': ['octave', 'tune'],
    'moog921vco-out': ['level'],
    'moog921vco-fm': ['linFmAmount'],
    'moog921vco-sync': ['sync'],
  };
  /** A value for each param DIFFERENT from its default — the perturbation. */
  const PERTURB: Record<string, number> = {
    octave: 2, tune: 7, width: 0.2, linFmAmount: 0.5, sync: 1, level: 0.5,
  };

  it('`out` is the dB a LINEAR level dial cannot print, and it tracks the real output', async () => {
    expect(vcoOutText(vParams()), 'the shipped level of 1.00 IS 0 dB').toBe('+0.0 dB');
    expect(vcoOutText(vParams({ level: 2 }))).toBe('+6.0 dB');
    expect(vcoOutText(vParams({ level: 0 })), 'and zero is silent, not "-Inf dB"').toBe('silent');
    // Against the instrument: the model's dB delta must equal the worklet's.
    const unity = rmsOf((await runVco({})).settled.sine!);
    const half = rmsOf((await runVco({ params: { level: 0.5 } })).settled.sine!);
    const measured = 20 * Math.log10(half / unity);
    const modelled = vcoOutDb(vParams({ level: 0.5 })) - vcoOutDb(vParams());
    expect(measured, `worklet ${measured.toFixed(3)} dB vs model ${modelled.toFixed(3)} dB`).toBeCloseTo(modelled, 2);
    // ⚠ AND ZERO REALLY IS BIT-EXACT SILENCE at steady state. A whole-render RMS
    // reads the 80 Hz smoother's ramp down from unity instead and says about
    // −30 dB — that was a real instrument fault during this audit, so the
    // settled window is a load-bearing part of the measurement, not hygiene.
    const silent = await runVco({ params: { level: 0 } });
    expect(rmsOf(silent.settled.sine!), 'settled RMS at level=0').toBe(0);
  });

  it('`fm` prints `off` at the shipped depth, and `sync` prints the comparator’s own state', () => {
    expect(vcoFmText(vParams()), 'the shipped depth').toBe('off');
    expect(vcoFmText(vParams({ linFmAmount: 1 }))).toBe('± 2.00k');
    expect(vcoFmText(vParams({ linFmAmount: -1 })), 'depth is a MAGNITUDE here').toBe('± 2.00k');
    expect(vcoSyncText(vParams()), 'the shipped switch position').toBe('off');
    expect(vcoSyncText(vParams({ sync: 1 }))).toBe('hard');
    expect(vcoSyncText(vParams({ sync: -1 }))).toBe('soft');
    // The comparator's thresholds, sampled AT the boundary rather than around it.
    expect(vcoSyncText(vParams({ sync: 0.5 })), '+0.5 is INSIDE hard').toBe('hard');
    expect(vcoSyncText(vParams({ sync: 0.4999 })), 'and one step below is off').toBe('off');
    expect(vcoSyncText(vParams({ sync: -0.5 })), '−0.5 is INSIDE soft').toBe('soft');
  });
});

describe('moog921Vco face model — the glyph, and TOTALITY', () => {
  it('the glyph binds LIVE, to `sine` — one tap of four, named', () => {
    expect(glyphBinding(moog921VcoDef), 'four audio outputs, so it resolves').toEqual({
      kind: 'live-audio',
      portId: 'sine',
    });
    // NEGATIVE CONTROL: it is the FIRST DECLARED audio output that wins, not a
    // preference for sines — reverse the order and the trace follows.
    const swapped = {
      ...moog921VcoDef,
      outputs: [...moog921VcoDef.outputs].reverse(),
    } as typeof moog921VcoDef;
    expect(glyphBinding(swapped), 'the binding follows declaration order').toEqual({
      kind: 'live-audio',
      portId: 'rectangular',
    });
  });

  it('the SPAWN-DEFAULT strings are pinned — they are what the dock VRT baseline captures', () => {
    expect([
      vcoPitchText(vParams()),
      vcoOutText(vParams()),
      vcoFmText(vParams()),
      vcoSyncText(vParams()),
    ]).toEqual(['261.6 Hz', '+0.0 dB', 'off', 'off']);
  });
});
