// packages/dsp/src/cloudseed-early-mod.test.ts
//
// EARLY-DIFFUSION MOD AMOUNT: the enable gate and the depth must read the SAME
// UNIT.
//
// THE BUG THIS PINS. `ReverbChannel.setParameter` handled
// `Param.EarlyDiffuseModAmount` as:
//
//     this.diffuser.setModulationEnabled(scaled > 0.5);      // MILLISECONDS
//     this.diffuser.setModAmount(this.ms2Samples(scaled));   // SAMPLES
//
// — a millisecond threshold guarding a samples payload. `scaled` for this param
// is `val * 2.5`, i.e. 0..2.5 ms, so `> 0.5 ms` means `val > 0.2`: THE WHOLE
// BOTTOM 20 % OF THE KNOB stored a depth and then switched modulation off.
// Measured before the fix, at 48 kHz:
//
//     val     scaled     depth        modulationEnabled
//     0.0500  0.1250 ms   6.00 smp    false
//     0.1400  0.3500 ms  16.80 smp    false   ← THE DEF DEFAULT
//     0.1439  0.3598 ms  17.27 smp    false   ← the DIVINE INSPIRATION preset
//     0.2000  0.5000 ms  24.00 smp    false
//     0.2100  0.5250 ms  25.20 smp    true
//
// and the rendered early-diffusion output was BIT-IDENTICAL to val=0 for every
// value up to 0.20, then jumped straight to a full-strength 1.35e-1 RMS delta.
// Not a soft knee — a dead fifth of the control ending in a cliff, with the
// shipped default sitting inside the dead part.
//
// WHY THE LATE SIBLING IS THE ORACLE. `DelayLine.setDiffuserModAmount` is the
// same operation on the late lines and has always gated on the SAMPLES value
// (`a > 0`). `Param.EarlyDiffuseModAmount` and `Param.LateDiffuseModAmount`
// scale IDENTICALLY (`val * 2.5`), so for one normalized value the two paths
// compute the same millisecond figure and the same sample depth — and therefore
// MUST reach the same enable state. They did not. That parity is the assertion
// that cannot drift with a threshold constant, so it is the primary leg here.
//
// THE INSTRUMENT IS NEGATIVE-CONTROLLED IN BOTH DIRECTIONS on every run: a
// non-zero depth must be enabled AND audibly change the output, and a depth of
// EXACTLY ZERO must still be disabled and still render bit-identically. Without
// the second leg, "modulation always on" would pass the first.

import { describe, it, expect, beforeAll } from 'vitest';
import type { Param as ParamT, ReverbChannel as ReverbChannelT } from './cloudseed';

const SR = 48000;
const BLOCK = 128;

let Param: typeof ParamT;
let ReverbChannel: typeof ReverbChannelT;

beforeAll(async () => {
  const g = globalThis as unknown as {
    sampleRate?: number;
    AudioWorkletProcessor?: unknown;
    registerProcessor?: (n: string, c: unknown) => void;
  };
  g.sampleRate = SR;
  // Port-having stub base — the dsp suite runs single-fork and cloudseed's
  // processor ctor sets `this.port.onmessage` (same note as cloudseed-seed).
  g.AudioWorkletProcessor = class {
    port = { onmessage: null as unknown, postMessage: (): void => {} };
  };
  g.registerProcessor = (): void => {};
  const mod = await import('./cloudseed');
  Param = mod.Param;
  ReverbChannel = mod.ReverbChannel;
});

/** The def default for `early_diffuse_mod_amt` (packages/web .../cloudseed.ts). */
const DEF_DEFAULT = 0.14;
/** The `[FX] DIVINE INSPIRATION` preset's value for the same param. */
const PRESET_VALUE = 0.1439;
/** `scaleParam` for both EarlyDiffuseModAmount and LateDiffuseModAmount. */
const toMs = (val: number): number => val * 2.5;
const msToSamples = (ms: number): number => (ms / 1000) * SR;

/** Reach the private early diffuser's per-stage allpass filters. */
function earlyFilters(
  ch: ReverbChannelT,
): { modulationEnabled: boolean; modAmount: number }[] {
  return (
    ch as unknown as {
      diffuser: { filters: { modulationEnabled: boolean; modAmount: number }[] };
    }
  ).diffuser.filters;
}

/** Reach a late line's own diffuser filters — the sibling path. */
function lateFilters(
  ch: ReverbChannelT,
  line = 0,
): { modulationEnabled: boolean; modAmount: number }[] {
  return (
    ch as unknown as {
      lines: {
        diffuser: { filters: { modulationEnabled: boolean; modAmount: number }[] };
      }[];
    }
  ).lines[line]!.diffuser.filters;
}

function freshChannel(): ReverbChannelT {
  const ch = new ReverbChannel(SR, 'L');
  // Give the late lines a sane geometry so `updateLines` has real numbers to
  // work with when the sibling param is pushed (size / decay feed its feedback
  // computation). Irrelevant to the early diffuser, required for the parity leg.
  ch.setParameter(Param.LateLineSize, 100);
  ch.setParameter(Param.LateLineDecay, 2);
  return ch;
}

describe('cloudseed EARLY DIFFUSION MOD AMT — the gate reads the depth’s unit', () => {
  it('the shipped DEF DEFAULT modulates at all', () => {
    const ch = freshChannel();
    const ms = toMs(DEF_DEFAULT);
    ch.setParameter(Param.EarlyDiffuseModAmount, ms);
    const f0 = earlyFilters(ch)[0]!;
    expect(ms, 'the def default in ms').toBeCloseTo(0.35, 6);
    expect(msToSamples(ms), 'the def default in samples').toBeCloseTo(16.8, 6);
    expect(
      f0.modulationEnabled,
      `def default val=${DEF_DEFAULT} → ${ms} ms → ${msToSamples(ms)} samples of ` +
        'depth: modulation must be ENABLED (the ms-vs-samples bug left it off)',
    ).toBe(true);
    expect(f0.modAmount).toBeGreaterThan(0);
  });

  it('the DIVINE INSPIRATION preset value modulates at all', () => {
    const ch = freshChannel();
    ch.setParameter(Param.EarlyDiffuseModAmount, toMs(PRESET_VALUE));
    expect(earlyFilters(ch)[0]!.modulationEnabled).toBe(true);
  });

  // ── THE PRIMARY LEG: parity with the late-line sibling ────────────────────
  it('EVERY normalized value agrees with the LATE-line diffuser’s enable state', () => {
    // Both params scale as val*2.5, so for one `val` the two paths see the same
    // ms and the same sample depth. Any disagreement is a unit mismatch.
    for (const val of [0, 0.01, 0.05, 0.1, DEF_DEFAULT, PRESET_VALUE, 0.19, 0.2, 0.21, 0.5, 1]) {
      const ms = toMs(val);
      const ch = freshChannel();
      ch.setParameter(Param.EarlyDiffuseModAmount, ms);
      ch.setParameter(Param.LateDiffuseModAmount, ms);
      const early = earlyFilters(ch)[0]!.modulationEnabled;
      const late = lateFilters(ch)[0]!.modulationEnabled;
      expect(
        early,
        `val=${val} (${ms} ms, ${msToSamples(ms).toFixed(2)} samples): early ` +
          `diffuser modulationEnabled=${early} but the late sibling says ${late}`,
      ).toBe(late);
    }
  });

  it('a depth of EXACTLY ZERO is still disabled (the guard still guards)', () => {
    const ch = freshChannel();
    ch.setParameter(Param.EarlyDiffuseModAmount, 0);
    expect(earlyFilters(ch)[0]!.modulationEnabled).toBe(false);
    expect(lateFilters(ch)[0]!.modulationEnabled).toBe(false);
  });
});

// ── The audible leg ─────────────────────────────────────────────────────────
describe('cloudseed EARLY DIFFUSION MOD AMT — it is audible across the old dead zone', () => {
  /** Render the early diffuser alone with a fixed noise burst. */
  function renderEarly(val: number): Float32Array {
    const origRandom = Math.random;
    // ModulatedAllpass seeds its mod phase from Math.random when no worklet
    // seed seam is installed; pin it so two renders are comparable.
    Math.random = () => 0.5;
    try {
      let seed = 12345;
      const rnd = (): number => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      const n = SR / 2; // 0.5 s
      const input = new Float32Array(n);
      for (let i = 0; i < 2048; i++) input[i] = rnd() * 2 - 1;

      const ch = new ReverbChannel(SR, 'L');
      ch.setParameter(Param.EarlyDiffuseEnabled, 1);
      ch.setParameter(Param.EarlyDiffuseCount, 8);
      ch.setParameter(Param.EarlyDiffuseDelay, 30);
      ch.setParameter(Param.EarlyDiffuseFeedback, 0.7);
      ch.setParameter(Param.EarlyDiffuseModRate, 0.5);
      ch.setParameter(Param.EarlyDiffuseModAmount, toMs(val));
      ch.dryOut = 0;
      ch.earlyOut = 1; // early diffusion only — no dry, no late lines
      ch.lineOut = 0;

      const out = new Float32Array(n);
      const inBlk = new Float32Array(BLOCK);
      const outBlk = new Float32Array(BLOCK);
      for (let b = 0; b + BLOCK <= n; b += BLOCK) {
        inBlk.set(input.subarray(b, b + BLOCK));
        ch.process(inBlk, outBlk, BLOCK);
        out.set(outBlk, b);
      }
      return out;
    } finally {
      Math.random = origRandom;
    }
  }

  function rmsDiff(a: Float32Array, b: Float32Array): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) {
      const d = a[i]! - b[i]!;
      s += d * d;
    }
    return Math.sqrt(s / a.length);
  }

  it('every value across the OLD DEAD ZONE changes the output', () => {
    const ref = renderEarly(0);
    // Sanity: the reference is a real signal, not silence — otherwise every
    // "differs from the reference" claim below would be vacuous.
    expect(rmsDiff(ref, new Float32Array(ref.length))).toBeGreaterThan(1e-3);
    // 0.05 … 0.20 was bit-identical to val=0 before the fix.
    for (const val of [0.05, 0.1, DEF_DEFAULT, PRESET_VALUE, 0.19, 0.2]) {
      expect(
        rmsDiff(renderEarly(val), ref),
        `val=${val} (${toMs(val)} ms) was BIT-IDENTICAL to val=0 before the fix`,
      ).toBeGreaterThan(1e-3);
    }
  });

  it('NEGATIVE CONTROL: val=0 renders bit-identically to itself', () => {
    // Pins that the comparison is deterministic, so a non-zero diff above is a
    // real behavioural difference and not render-to-render noise.
    expect(rmsDiff(renderEarly(0), renderEarly(0))).toBe(0);
  });
});
