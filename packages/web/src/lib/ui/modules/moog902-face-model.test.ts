// packages/web/src/lib/ui/modules/moog902-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for moog902's two derived readouts, plus the
// leg that stops the face model drifting from the DSP it describes.
//
// A derived readout earns its place only if it is checked against the input a
// KNOB READBACK WOULD BE BLIND TO — permanently, not once at authoring time
// (CLAUDE.md, "a wrong metric reads exactly like a finding"). This module's
// face rests on one measured fact:
//
//   THE RESPONSE SWITCH IS A LEVEL CONTROL. The LINEAR and EXPONENTIAL laws
//   coincide at ONLY two control voltages — 0 V and the 6 V anchor — so between
//   them, flipping the switch moves the output while the GAIN dial does not
//   move at all: −2.9841 dB at the shipped pot position and −5.4525 dB near the
//   bottom of the dial, at a pot readback of a constant 0.05 / 0.50.
//
// So `moog902-gain-db` MUST move when MODE moves, and `moog902-ceiling` MUST
// NOT move when GAIN moves — its reach is the switch and nothing else, which
// makes it this instrument's own negative control (the `clap-q` /
// `clap-bandwidth-hz` pattern: publishing a quantity that is INVARIANT to the
// input the other depends on is what makes every render a check). Both
// directions are asserted for both legs, because a probe that cannot move is
// indistinguishable from one reading the wrong thing.
//
// ⚠ WHAT THIS FILE COULD NOT SEE, AND NOW DOES. `moog902-face-model.ts`
// RE-STATES the worklet's gain law, because `packages/dsp/src/moog902.ts`
// top-level-exports nothing by design (a top-level export leaks into the
// bundled dist and breaks ART's classic-script eval), so the real law is
// unreachable from `$lib`. A closed form checked only against itself proves
// self-consistency and nothing else — which is precisely the #1913 finding
// about moog904a's ART scenario, whose hand-copied `DRIVE` expression can drift
// from the worklet silently. The `worklet agreement` block below therefore
// instantiates the SHIPPING processor class, drives it to steady state, and
// asserts the model reproduces what the amplifier actually delivers. A DSP edit
// that moves the law reddens THIS file, by name.

import { beforeAll, describe, expect, it } from 'vitest';
import { moog902Def } from '$lib/audio/modules/moog902';
import {
  MOOG902_GAIN_CEILING,
  MOOG902_GAIN_POT_VOLTS,
  moog902CeilingText,
  moog902CeilingVolts,
  moog902FaceParams,
  moog902Gain,
  moog902GainDbText,
  moog902GainMultiplier,
} from './moog902-face-model';

const SR = 48000;
const BLOCK = 128;

beforeAll(() => {
  (globalThis as unknown as { sampleRate: number }).sampleRate = SR;
});

/** A `read` closure over an explicit param map, defaulting like a live node. */
function reader(params: Record<string, number | undefined>) {
  return (id: string) => params[id];
}

/** The readout text for a given param map, through the REGISTERED entry. */
function gainDb(params: Record<string, number | undefined>): string {
  return faceReadoutValueFor('moog902-gain-db')!(reader(params));
}
function ceiling(params: Record<string, number | undefined>): string {
  return faceReadoutValueFor('moog902-ceiling')!(reader(params));
}

describe('moog902 face readouts — registration', () => {

  it('each registry entry wires THIS module\'s function, not merely SOME function', () => {
    // A registry that resolved `moog902-ceiling` to the gain formatter would
    // pass every "it resolves" check and print a plausible wrong string. The
    // whole test file reads through the registry, so this is the one leg that
    // pins registry ↔ implementation, in both directions.
    for (const params of [{}, { gain: 0.25, mode: 1 }, { gain: 1, mode: 0 }]) {
      expect(gainDb(params)).toBe(moog902GainDbText(moog902FaceParams(reader(params))));
      expect(ceiling(params)).toBe(moog902CeilingText(moog902FaceParams(reader(params))));
    }
    // ...and the two are not the same function wearing two ids.
    expect(gainDb({})).not.toBe(ceiling({}));
  });
});

describe('moog902-gain-db — the RESPONSE switch a knob readback cannot see', () => {
  it('prints unity at the shipped defaults, where the GAIN dial reads 0.50', () => {
    expect(gainDb({})).toBe('0.0 dB');
    // The dial's own readback is the same number in both modes — that is the
    // blindness this readout exists to cover.
    expect(moog902FaceParams(reader({})).gain).toBe(0.5);
  });

  it('MOVES on MODE alone: 0.0 dB → −3.0 dB with the pot untouched', () => {
    const lin = gainDb({ gain: 0.5, mode: 0 });
    const exp = gainDb({ gain: 0.5, mode: 1 });
    expect(lin).toBe('0.0 dB');
    expect(exp).toBe('-3.0 dB');
    expect(exp).not.toBe(lin);
    // ⚠ the pot is bit-identical across that change.
    expect(moog902FaceParams(reader({ gain: 0.5, mode: 0 })).gain).toBe(
      moog902FaceParams(reader({ gain: 0.5, mode: 1 })).gain,
    );
  });

  it('the mode delta WIDENS toward the bottom of the pot and VANISHES at the anchor', () => {
    // Measured on the shipping worklet (see the `worklet agreement` block):
    //   pot 0.05 → −5.4525 dB · 0.25 → −4.3812 · 0.50 → −2.9841 · 0.75 → −1.5232
    //   pot 1.00 → 0.0000 (the two laws share the 6 V anchor exactly)
    const deltaAt = (pot: number) => {
      const l = 20 * Math.log10(moog902GainMultiplier({ gain: pot, cvAmount: 1, mode: 0 }));
      const e = 20 * Math.log10(moog902GainMultiplier({ gain: pot, cvAmount: 1, mode: 1 }));
      return e - l;
    };
    expect(deltaAt(0.05)).toBeCloseTo(-5.4525, 3);
    expect(deltaAt(0.25)).toBeCloseTo(-4.3812, 3);
    expect(deltaAt(0.5)).toBeCloseTo(-2.9841, 3);
    expect(deltaAt(0.75)).toBeCloseTo(-1.5232, 3);
    // THE ANCHOR — the one position where the switch is genuinely level-matched.
    expect(deltaAt(1)).toBeCloseTo(0, 9);
    // And the deltas are strictly ordered, so "it moves" is not a coincidence
    // of one sampled point.
    expect(deltaAt(0.05)).toBeLessThan(deltaAt(0.25));
    expect(deltaAt(0.25)).toBeLessThan(deltaAt(0.5));
    expect(deltaAt(0.5)).toBeLessThan(deltaAt(0.75));
    expect(deltaAt(0.75)).toBeLessThan(deltaAt(1));
  });

  it('also moves on GAIN — so it is not secretly a mode label', () => {
    expect(gainDb({ gain: 0.25 })).toBe('-6.0 dB');
    expect(gainDb({ gain: 0.75 })).toBe('+3.5 dB');
    expect(gainDb({ gain: 1 })).toBe('+6.0 dB');
  });

  it('is INVARIANT to cvAmount, which is bit-exactly inert with cv unpatched', () => {
    // 41 of 41 sampled positions render bit-identically on the real worklet with
    // nothing patched to `cv`; the readout is a function of the same param set,
    // so it must not pretend otherwise.
    const base = gainDb({ gain: 0.5, cvAmount: 1 });
    for (let i = 0; i <= 40; i++) {
      expect(gainDb({ gain: 0.5, cvAmount: -1 + i / 20 })).toBe(base);
    }
  });
});

describe('moog902-ceiling — INVARIANT to the pot, and it is the #1912 number', () => {
  it('names the mode-dependent ceiling: 9.0 V LINEAR, 7.5 V EXPONENTIAL', () => {
    expect(ceiling({ mode: 0 })).toBe('9.0 V');
    expect(ceiling({ mode: 1 })).toBe('7.5 V');
    // LINEAR is the SHIPPED DEFAULT — the mode the wrong "~7.5 V" prose was
    // most wrong about.
    expect(ceiling({})).toBe('9.0 V');
  });

  it('DOES NOT MOVE across the entire GAIN pot — the permanent negative control', () => {
    // If this ever starts tracking the pot, the readout has stopped being the
    // law's property and become a second opinion on the dial.
    for (const mode of [0, 1]) {
      const at0 = ceiling({ gain: 0, mode });
      for (let i = 0; i <= 40; i++) {
        expect(ceiling({ gain: i / 40, mode })).toBe(at0);
      }
    }
    // ...and it is not merely constant: the two modes disagree.
    expect(ceiling({ gain: 0.3, mode: 0 })).not.toBe(ceiling({ gain: 0.3, mode: 1 }));
  });

  it('the ceiling voltage is the true inverse of the gain law, in BOTH arms', () => {
    for (const exp of [false, true]) {
      const v = moog902CeilingVolts(exp);
      // AT the ceiling voltage the law delivers exactly ×3...
      expect(moog902Gain(v, exp)).toBeCloseTo(MOOG902_GAIN_CEILING, 9);
      // ...and a hair BELOW it, strictly less (so it is the FIRST such voltage,
      // not merely some voltage in the clamped region).
      expect(moog902Gain(v * 0.999, exp)).toBeLessThan(MOOG902_GAIN_CEILING);
    }
    expect(moog902CeilingVolts(false)).toBeCloseTo(9, 9);
    expect(moog902CeilingVolts(true)).toBeCloseTo(7.5, 4);
    // THE DEFECT, stated as an assertion: 7.5 V is NOT the linear ceiling.
    expect(moog902Gain(7.5, false)).toBeCloseTo(2.5, 9);
  });

  it('reads the mode threshold the WORKLET uses (>= 0.5), not a rounding of it', () => {
    expect(ceiling({ mode: 0.49 })).toBe('9.0 V');
    expect(ceiling({ mode: 0.5 })).toBe('7.5 V');
  });
});

describe('moog902 readouts — TOTALITY (they run on every render)', () => {
  // A throw here takes the faceplate down mid-drag, so the hostile inputs are
  // a permanent leg rather than an authoring-time spot check.
  const hostile: Array<[string, Record<string, number | undefined>]> = [
    ['a fresh node (nothing touched)', {}],
    ['undefined everywhere', { gain: undefined, cvAmount: undefined, mode: undefined }],
    ['NaN', { gain: NaN, cvAmount: NaN, mode: NaN }],
    ['+Infinity', { gain: Infinity, cvAmount: Infinity, mode: Infinity }],
    ['-Infinity', { gain: -Infinity, cvAmount: -Infinity, mode: -Infinity }],
    ['out of range low', { gain: -5, mode: -3 }],
    ['out of range high', { gain: 99, mode: 99 }],
  ];
  for (const [name, params] of hostile) {
    it(`survives ${name} and prints a finite string`, () => {
      const a = gainDb(params);
      const b = ceiling(params);
      for (const s of [a, b]) {
        expect(typeof s).toBe('string');
        expect(s.length).toBeGreaterThan(0);
        expect(s).not.toMatch(/NaN|Infinity|undefined/);
      }
    });
  }

  it('a fully closed pot prints `mute`, not `-Infinity dB`', () => {
    // gain = 0 is TRUE silence on this module: the worklet reaches bit-exact
    // zero 10375 samples (216.146 ms) after spawn, so the readout must name
    // that state rather than print a divergent logarithm.
    expect(gainDb({ gain: 0 })).toBe('mute');
    expect(gainDb({ gain: 0, mode: 1 })).toBe('mute');
  });

  it('never prints a signed zero', () => {
    // `(-0.04).toFixed(1)` is "-0.0"; a faceplate that prints "-0.0 dB" at unity
    // looks like a bug even though the arithmetic is right.
    for (let i = 0; i <= 200; i++) {
      expect(gainDb({ gain: 0.49 + i / 20000 })).not.toBe('-0.0 dB');
    }
  });
});

// ─────────────────── the ANTI-DRIFT leg: the SHIPPING worklet ───────────────
type ProcInstance = {
  process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean;
};
type ProcCtor = new () => ProcInstance;
let capturedProc: ProcCtor | null = null;

async function loadProcessor(): Promise<ProcCtor> {
  if (capturedProc) return capturedProc;
  const g = globalThis as unknown as { registerProcessor?: (n: string, c: ProcCtor) => void };
  const prev = g.registerProcessor;
  let registered: ProcCtor | null = null;
  g.registerProcessor = (_n, ctor) => { registered = ctor; };
  // Relative path into the DSP source — worktrees may not have the workspace
  // package symlinked under node_modules.
  await import('../../../../../dsp/src/moog902');
  g.registerProcessor = prev;
  if (!registered) throw new Error('moog902 processor did not register');
  capturedProc = registered;
  return capturedProc;
}

/**
 * Steady-state multiplier for one (gain, mode) setting, off the REAL processor.
 *
 * ⚠ CHANNEL-AWARE BY CONSTRUCTION, and that is not incidental. The first probe
 * written against this worklet passed one `input(ch, i)` closure that IGNORED
 * `ch`, feeding the test tone into `cv` and `fcv` as well as `audio` — i.e.
 * measuring a PATCHED module while believing it was measuring a bare one. It
 * reported four internally-consistent wrong numbers. Each input index gets its
 * own buffer here, and `cv`/`fcv` are held at 0 V.
 */
function settledGain(Proc: ProcCtor, gain: number, mode: number): number {
  const proc = new Proc();
  const params: Record<string, Float32Array> = {
    gain: new Float32Array([gain]),
    cvAmount: new Float32Array([1]),
    mode: new Float32Array([mode]),
  };
  const inputs: Float32Array[][] = [
    [new Float32Array(BLOCK).fill(1)], // audio: DC 1 → output IS the multiplier
    [new Float32Array(BLOCK)], // cv:  0 V
    [new Float32Array(BLOCK)], // fcv: 0 V
  ];
  let outputs: Float32Array[][] = [];
  for (let b = 0; b < 400; b++) {
    outputs = [[new Float32Array(BLOCK)], [new Float32Array(BLOCK)]];
    proc.process(inputs, outputs, params);
  }
  return outputs[0][0][BLOCK - 1];
}

describe('moog902 face model — WORKLET AGREEMENT (the model does not drift)', () => {
  it('reproduces the SHIPPING processor across the whole pot, in both modes', async () => {
    const Proc = await loadProcessor();
    const mismatches: string[] = [];
    for (const mode of [0, 1]) {
      for (let i = 0; i <= 20; i++) {
        const pot = i / 20;
        const delivered = settledGain(Proc, pot, mode);
        const modelled = moog902Gain(pot * MOOG902_GAIN_POT_VOLTS, mode >= 0.5);
        // float32 accumulation through a one-pole smoother; 1e-6 is ~4 orders
        // tighter than the 1e-2 the delta table is quoted to.
        if (Math.abs(delivered - modelled) > 1e-6) {
          mismatches.push(
            `mode=${mode} pot=${pot}: worklet delivered x${delivered.toFixed(9)}, ` +
              `model says x${modelled.toFixed(9)} (units: amplitude multiplier)`,
          );
        }
      }
    }
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });

  it('POSITIVE CONTROL: the comparison can FAIL — a perturbed model is caught', async () => {
    // Without this leg, an agreement test that accidentally compared a value to
    // itself would look exactly like a passing one.
    const Proc = await loadProcessor();
    const delivered = settledGain(Proc, 0.5, 0);
    const perturbed = moog902Gain(0.5 * MOOG902_GAIN_POT_VOLTS * 1.001, false);
    expect(Math.abs(delivered - perturbed)).toBeGreaterThan(1e-6);
  });

  it('the two headline numbers the face prints are the worklet\'s own', async () => {
    const Proc = await loadProcessor();
    // Unity at the shipped defaults...
    expect(settledGain(Proc, 0.5, 0)).toBeCloseTo(1, 9);
    // ...and −2.9841 dB on a mode flip with the pot untouched.
    const exp = settledGain(Proc, 0.5, 1);
    expect(20 * Math.log10(exp / settledGain(Proc, 0.5, 0))).toBeCloseTo(-2.9841, 3);
  });
});
