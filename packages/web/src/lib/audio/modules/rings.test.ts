// packages/web/src/lib/audio/modules/rings.test.ts
//
// Unit tests for RINGS: module-def shape; pure-math engine sanity.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ringsDef, ringsMath, RINGS_MAX_MODEL, RINGS_MODEL_NAMES, type RingsParams } from './rings';

// ── The mirror-parity gate ────────────────────────────────────────────────
//
// EVERYTHING that renders RINGS in a test — this file and the ART scenario —
// drives `ringsMath`, the pure-math mirror in the WEB module. NOTHING drives
// `packages/dsp/src/rings.ts`, which is the code that actually runs in the
// AudioWorklet and is therefore the code the user hears: it registers itself
// via `registerProcessor` at module scope, so it cannot be imported into
// vitest at all. The two files carry the SAME algorithm by hand-copy.
//
// So the whole rings test suite is structurally blind to a divergence between
// them: the mirror could be fixed and the shipped worklet left broken, and
// every assertion above would stay green. This gate is the only thing that
// joins the two sides. It compares the algorithm bodies as source, modulo
// comments, `export`, and the mirror's leading-underscore class names.
const HERE = dirname(fileURLToPath(import.meta.url));
const DSP_RINGS = resolve(HERE, '../../../../../dsp/src/rings.ts');

function algorithmBody(src: string): string {
  const start = src.search(/const _?MODAL_MAX_PARTIALS/);
  // End of the algorithm region, per side. The DSP file's region ends where
  // its worklet PROCESSOR class begins (the per-file `declare const
  // sampleRate` that used to sit there was deleted by #1604's shared worklet
  // ambient); the mirror's ends at its exported params interface.
  const endMarker = src.includes('class RingsProcessor')
    ? 'class RingsProcessor'
    : 'export interface RingsParams';
  const end = src.indexOf(endMarker);
  if (start < 0 || end < 0) throw new Error('rings mirror-parity: could not locate the algorithm region');
  return src
    .slice(start, end)
    .replace(/\/\*\*[\s\S]*?\*\//g, '')  // block comments
    .replace(/^[ \t]*\/\/.*$/gm, '')     // line comments
    .replace(/\bexport\s+/g, '')         // the DSP file exports its classes
    .replace(/\b_(?=[A-Z])/g, '')        // mirror uses _Biquad / _RingsModal / _KS_MAX_DELAY
    .replace(/\s+/g, ' ')
    .trim();
}

describe('ringsDef shape', () => {
  it(`model param: discrete 0..${RINGS_MAX_MODEL}`, () => {
    const p = ringsDef.params.find((p) => p.id === 'model')!;
    expect(p.curve).toBe('discrete');
    expect(p.min).toBe(0);
    expect(p.max).toBe(RINGS_MAX_MODEL);
    expect(RINGS_MAX_MODEL).toBe(1);
    const port = ringsDef.inputs.find((p) => p.id === 'model_cv')!;
    expect(port.cvScale).toEqual({ mode: 'discrete' });
  });

});

const SR = 48000;

function powerAt(buf: Float32Array, freq: number, sr: number): number {
  const w = (2 * Math.PI * freq) / sr;
  let re = 0;
  let im = 0;
  for (let i = 0; i < buf.length; i++) {
    re += buf[i]! * Math.cos(w * i);
    im += buf[i]! * Math.sin(w * i);
  }
  return Math.sqrt(re * re + im * im) / buf.length;
}

function makeNoiseBuf(n: number, seed = 0x12345): Float32Array {
  const out = new Float32Array(n);
  let s = seed | 0;
  for (let i = 0; i < n; i++) {
    s = (s * 16807) | 0;
    out[i] = ((s & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  }
  return out;
}

function makeBurstExciter(n: number, noiseLen: number, gain = 1.0): Float32Array {
  const noise = makeNoiseBuf(noiseLen);
  const out = new Float32Array(n);
  for (let i = 0; i < noiseLen; i++) out[i] = noise[i]! * gain;
  return out;
}

const baseParams: RingsParams = {
  model: 0, note: 0, structure: 0.0, brightness: 0.5,
  damping: 0.3, position: 0.5, level: 0.8,
};

describe('ringsMath — MODAL model', () => {
  it('produces non-silent, finite audio when excited with a noise burst at A4 pitch', () => {
    const exciter = makeBurstExciter(SR, 4800, 4.0);
    const { odd, even } = ringsMath.render(SR, SR, 0.75, {
      ...baseParams, structure: 0.3, position: 0.0,
    }, exciter);
    let peakOdd = 0;
    let peakEven = 0;
    for (let i = 0; i < odd.length; i++) {
      expect(Number.isFinite(odd[i]!)).toBe(true);
      expect(Number.isFinite(even[i]!)).toBe(true);
      const aO = Math.abs(odd[i]!);
      const aE = Math.abs(even[i]!);
      if (aO > peakOdd) peakOdd = aO;
      if (aE > peakEven) peakEven = aE;
    }
    expect(peakOdd).toBeGreaterThan(1e-6);
    expect(peakEven).toBeGreaterThan(1e-6);
  });

  it('carries strong energy at the fundamental (440Hz) when pitch=0.75 V/oct', () => {
    const exciter = makeBurstExciter(SR, 480);
    const { odd } = ringsMath.render(SR, SR, 0.75, baseParams, exciter);
    const tail = odd.slice(SR / 20);
    expect(powerAt(tail, 440, SR)).toBeGreaterThan(powerAt(tail, 1234, SR) * 3);
  });

  it('DAMPING low → long ring-out, DAMPING high → short ring-out', () => {
    const exciter = makeBurstExciter(SR, 480);
    const longRing = ringsMath.render(SR, SR, 0.75, { ...baseParams, damping: 0.05 }, exciter);
    const shortRing = ringsMath.render(SR, SR, 0.75, { ...baseParams, damping: 0.95 }, exciter);
    const tailStart = Math.floor(SR * 0.5);
    let longSum = 0;
    let shortSum = 0;
    for (let i = tailStart; i < SR; i++) {
      longSum  += longRing.odd[i]!  * longRing.odd[i]!;
      shortSum += shortRing.odd[i]! * shortRing.odd[i]!;
    }
    expect(Math.sqrt(longSum / (SR - tailStart))).toBeGreaterThan(Math.sqrt(shortSum / (SR - tailStart)) * 5);
  });
});

describe('ringsMath — SYMPATHETIC_STRING model', () => {
  const sympParams: RingsParams = { ...baseParams, model: 1 };

  it('produces audio when strummed with no audio exciter (KS burst self-excites)', () => {
    const { odd, even } = ringsMath.render(SR, SR, 0.75, sympParams, null, 0);
    let peak = 0;
    for (let i = 0; i < odd.length; i++) {
      expect(Number.isFinite(odd[i]!)).toBe(true);
      expect(Number.isFinite(even[i]!)).toBe(true);
      if (Math.abs(odd[i]!) > peak) peak = Math.abs(odd[i]!);
    }
    expect(peak).toBeGreaterThan(0.01);
  });

  it('carries energy at the fundamental pitch', () => {
    const { odd } = ringsMath.render(SR, SR, 0.75, sympParams, null, 0);
    const tail = odd.slice(SR / 10);
    expect(powerAt(tail, 440, SR)).toBeGreaterThan(powerAt(tail, 1100, SR) * 2);
  });

  it('DAMPING low → long ring-out, DAMPING high → short ring-out', () => {
    const longRing = ringsMath.render(SR, SR, 0.75, { ...sympParams, damping: 0.05 }, null, 0);
    const shortRing = ringsMath.render(SR, SR, 0.75, { ...sympParams, damping: 0.95 }, null, 0);
    const tailStart = Math.floor(SR * 0.5);
    let longSum = 0;
    let shortSum = 0;
    for (let i = tailStart; i < SR; i++) {
      longSum  += longRing.odd[i]!  * longRing.odd[i]!;
      shortSum += shortRing.odd[i]! * shortRing.odd[i]!;
    }
    expect(Math.sqrt(longSum / (SR - tailStart))).toBeGreaterThan(Math.sqrt(shortSum / (SR - tailStart)) * 5);
  });

  it('output stays soft-limited bounded (tanh)', () => {
    const hotExciter = makeNoiseBuf(SR, 0xdeadbeef);
    for (let i = 0; i < hotExciter.length; i++) hotExciter[i]! *= 10;
    const { odd, even } = ringsMath.render(SR, SR, 0.75, {
      ...sympParams, structure: 1.0, brightness: 1.0, damping: 0.1, level: 1.0,
    }, hotExciter, 0);
    let peakO = 0;
    let peakE = 0;
    for (let i = 0; i < odd.length; i++) {
      if (Math.abs(odd[i]!)  > peakO) peakO = Math.abs(odd[i]!);
      if (Math.abs(even[i]!) > peakE) peakE = Math.abs(even[i]!);
    }
    expect(peakO).toBeLessThanOrEqual(1.0);
    expect(peakE).toBeLessThanOrEqual(1.0);
  });
});

describe('ringsMath — STRUM self-excites both models', () => {
  it('STRUM with no external exciter + MODAL produces non-silent output', () => {
    const modalParams: RingsParams = {
      ...baseParams, model: 0, structure: 0.3, damping: 0.2, position: 0.0,
    };
    // Strum at sample 0, run ~50ms (longer than the 10ms burst so the resonator
    // has time to ring out). Pass null exciter so any output must come from the
    // self-excite burst.
    const n = Math.floor(SR * 0.05);
    const { odd, even } = ringsMath.render(n, SR, 0.75, modalParams, null, 0);
    let peakOdd = 0;
    let peakEven = 0;
    for (let i = 0; i < n; i++) {
      expect(Number.isFinite(odd[i]!)).toBe(true);
      expect(Number.isFinite(even[i]!)).toBe(true);
      if (Math.abs(odd[i]!)  > peakOdd)  peakOdd  = Math.abs(odd[i]!);
      if (Math.abs(even[i]!) > peakEven) peakEven = Math.abs(even[i]!);
    }
    // At least one channel must be audibly above the silence floor.
    expect(Math.max(peakOdd, peakEven)).toBeGreaterThan(0.01);
  });

  it('STRUM with no external exciter + SYMPATHETIC still works', () => {
    const sympParams: RingsParams = { ...baseParams, model: 1, damping: 0.1 };
    const n = Math.floor(SR * 0.05);
    const { odd, even } = ringsMath.render(n, SR, 0.75, sympParams, null, 0);
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.max(Math.abs(odd[i]!), Math.abs(even[i]!));
      if (a > peak) peak = a;
    }
    expect(peak).toBeGreaterThan(0.01);
  });

  it('no STRUM + MODAL + no exciter → silent (control)', () => {
    const modalParams: RingsParams = { ...baseParams, model: 0 };
    const n = Math.floor(SR * 0.05);
    const { odd, even } = ringsMath.render(n, SR, 0.75, modalParams, null, -1);
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.max(Math.abs(odd[i]!), Math.abs(even[i]!));
      if (a > peak) peak = a;
    }
    expect(peak).toBeLessThan(1e-6);
  });
});

// ── Regression battery for the three MEASURED defects (2026-08-03 audit) ──
//
// Every gate RINGS had read the CONTRACT: `contract-lock` pinned the params,
// `module-docs-lint` proved every port was documented, `per-module-per-port`
// proved the ODD jack materialises an edge. None of them rendered the module at
// its own spawn defaults and read a number off the output, so ODD being digital
// silence at the shipped POSITION was invisible to the entire gate set — and
// the unit test that DID render at POSITION 0.5 ('DAMPING low → long ring-out'
// above) was comparing two ~1e-17 numerical residues and passing on the ratio
// between them. These sweep the CONTROL TRAVEL and assert the number.

const peakOf = (b: Float32Array): number => {
  let p = 0;
  for (let i = 0; i < b.length; i++) { const a = Math.abs(b[i]!); if (a > p) p = a; }
  return p;
};
const rmsOf = (b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < b.length; i++) s += b[i]! * b[i]!;
  return Math.sqrt(s / b.length);
};
const maxAbsDiff = (a: Float32Array, b: Float32Array): number => {
  let d = 0;
  for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]! - b[i]!); if (v > d) d = v; }
  return d;
};
/** Milliseconds until the tail's last sample above (peak * 1e-3), i.e. -60 dB. */
const decay60Ms = (b: Float32Array, sr: number): number => {
  const p = peakOf(b);
  if (p <= 0) return 0;
  const th = p * 1e-3;
  for (let i = b.length - 1; i >= 0; i--) if (Math.abs(b[i]!) >= th) return (i / sr) * 1000;
  return 0;
};

/** The def's OWN spawn defaults, read off the def so a default change can never
 *  drift this battery away from what the module actually spawns with. */
const spawnParams = (): RingsParams => {
  const v = (id: string): number => ringsDef.params.find((p) => p.id === id)!.defaultValue;
  return {
    model: v('model'), note: v('note'), structure: v('structure'),
    brightness: v('brightness'), damping: v('damping'),
    position: v('position'), level: v('level'),
  };
};

describe('rings POSITION — the ODD tap must never null (defect 1)', () => {
  // Weight of partial n is cos(2*PI*position*n) (reference resonator.cc:104-118
  // via stmlib's CosineOscillator). The shipped code had cos(PI*position*(i+1)),
  // which is EXACTLY 0 for every even i at position 0.5 — and every even i is
  // the ODD accumulator. ODD is the first-declared output, the one `docs.outputs`
  // designates "use it alone for a mono resonator output", and the head of the
  // `stereoPairs` entry, so the module's PRIMARY output was digital silence at
  // the value it spawns with.
  //
  // BEFORE: oddPeak 8.486e-16 @ POSITION 0.5 vs 4.735e-1 @ 0.0  (~ -278 dB)
  // AFTER:  oddPeak 3.391e-1  @ POSITION 0.5 vs 3.391e-1 @ 0.0

  it('ODD is audible at EVERY position over the whole travel, at the spawn defaults', () => {
    const n = Math.floor(SR * 0.5);
    const worst: { pos: number; peak: number } = { pos: -1, peak: Infinity };
    for (let pos = 0; pos <= 1.0001; pos += 0.025) {
      const p = Math.min(1, pos);
      const { odd } = ringsMath.render(n, SR, 0, { ...spawnParams(), position: p }, null, 0);
      const peak = peakOf(odd);
      if (peak < worst.peak) { worst.pos = p; worst.peak = peak; }
    }
    // 1e-3 linear = -60 dBFS. The defect read 8.5e-16; the fix's worst point
    // over the whole travel measures 2.24e-1.
    expect(
      worst.peak,
      `quietest ODD over the POSITION travel was ${worst.peak.toExponential(3)} (linear peak) at position ${worst.pos.toFixed(3)}`,
    ).toBeGreaterThan(1e-3);
  });

  it('the spawn default specifically: ODD within 6 dB of ODD at POSITION 0', () => {
    const n = Math.floor(SR * 0.5);
    const atDefault = ringsMath.render(n, SR, 0, spawnParams(), null, 0);
    const atZero = ringsMath.render(n, SR, 0, { ...spawnParams(), position: 0 }, null, 0);
    const ratio = peakOf(atDefault.odd) / peakOf(atZero.odd);
    expect(
      ratio,
      `ODD peak ratio default/pos0 = ${ratio.toExponential(3)} (defect measured 1.79e-15)`,
    ).toBeGreaterThan(0.5);
  });

  // NEGATIVE CONTROL ON THE INSTRUMENT, run on every pass. The peak metric above
  // is only meaningful if it can actually READ a null. POSITION 0.25 puts every
  // ODD-indexed partial on a pickup node — cos(2*PI*0.25*(2k+1)) = 0 — so the
  // EVEN tap there is a genuine, reference-faithful silence (stmlib's
  // CosineOscillator at frequency 0.25 emits 0.5, 0, -0.5, 0, ...). If this
  // ever stops reading ~0, the sweep above has gone blind and its green is
  // worthless.
  it('NEGATIVE CONTROL: the same metric reads ~0 on a real pickup node (EVEN @ 0.25)', () => {
    const n = Math.floor(SR * 0.5);
    const { even, odd } = ringsMath.render(n, SR, 0, { ...spawnParams(), position: 0.25 }, null, 0);
    expect(peakOf(even), 'EVEN at the 0.25 pickup node (linear peak)').toBeLessThan(1e-9);
    expect(peakOf(odd), 'ODD at the 0.25 pickup node (linear peak)').toBeGreaterThan(1e-3);
  });
});

describe('rings SYMPATHETIC — ODD and EVEN must be separable (defect 2)', () => {
  // `stereoPairs: [['odd','even']]` auto-wires these two as a stereo pair, so a
  // rank-deficient odd/even matrix ships a dual-mono "stereo" image. The old
  // matrix was [[p, 1-p], [1-p, p]] over the two strings — RANK 1 at p = 0.5,
  // the shipped default.
  //
  // BEFORE: max|ODD-EVEN| over 0.5 s = EXACTLY 0.000e+0 @ POSITION 0.5
  // AFTER:  6.102e-1, and >= 3.2e-1 everywhere on the travel

  const sympAt = (position: number) => {
    const n = Math.floor(SR * 0.5);
    return ringsMath.render(n, SR, 0, { ...spawnParams(), model: 1, position }, null, 0);
  };

  it('the two taps differ at EVERY position, including the spawn default', () => {
    const worst: { pos: number; diff: number } = { pos: -1, diff: Infinity };
    for (const pos of [0, 0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1.0]) {
      const { odd, even } = sympAt(pos);
      const d = maxAbsDiff(odd, even);
      if (d < worst.diff) { worst.pos = pos; worst.diff = d; }
    }
    expect(
      worst.diff,
      `smallest max|ODD-EVEN| over the POSITION travel was ${worst.diff.toExponential(3)} (linear) at position ${worst.pos}`,
    ).toBeGreaterThan(0.1);
  });

  it('the spawn default is not dual mono', () => {
    const { odd, even } = sympAt(ringsDef.params.find((p) => p.id === 'position')!.defaultValue);
    const d = maxAbsDiff(odd, even);
    expect(d, `max|ODD-EVEN| at the spawn default (defect measured exactly 0)`).toBeGreaterThan(0.1);
    // ...and both taps carry real signal — "they differ" must not be satisfiable
    // by one of them going silent (the shape snaredrum's stereo assertions had).
    expect(peakOf(odd), 'ODD peak at the spawn default').toBeGreaterThan(0.05);
    expect(peakOf(even), 'EVEN peak at the spawn default').toBeGreaterThan(0.05);
  });

  // NEGATIVE CONTROL ON THE INSTRUMENT. maxAbsDiff is the metric the two
  // assertions above rest on; feed it the SAME render twice and it must read
  // exactly 0. If it can't see identity it can't have seen the defect.
  it('NEGATIVE CONTROL: maxAbsDiff reads exactly 0 on a buffer against itself', () => {
    const { odd } = sympAt(0.5);
    expect(maxAbsDiff(odd, odd)).toBe(0);
  });
});

describe('rings MODAL DAMPING — range and direction (defect 3)', () => {
  // BEFORE: the ENTIRE knob was 46.6 ms (DAMPING 0) .. 12.8 ms (DAMPING 1) of
  //   ring while the docs promise "low DAMPING resonates long" — and RMS went
  //   UP as you damped (5.65e-3 -> 1.65e-2), because the constant-0 dB-peak-gain
  //   band-pass gets WIDER as Q drops and so passes more of the strike straight
  //   through. A resonator whose most-resonant setting is its quietest.
  // AFTER: 23.4 ms .. beyond a 2 s render, and RMS 1.706e-2 -> 8.013e-3.
  const modalAt = (damping: number, seconds = 2) =>
    ringsMath.render(Math.floor(SR * seconds), SR, 0, { ...spawnParams(), damping }, null, 0).odd;

  it('the knob spans more than a decade of ring time, in the documented direction', () => {
    const longRing = decay60Ms(modalAt(0), SR);
    const shortRing = decay60Ms(modalAt(1), SR);
    expect(shortRing, `-60 dB length at DAMPING 1 (ms)`).toBeLessThan(80);
    expect(longRing, `-60 dB length at DAMPING 0 (ms)`).toBeGreaterThan(800);
    expect(
      longRing / shortRing,
      `ring-time ratio DAMPING 0 : DAMPING 1 = ${(longRing / shortRing).toFixed(1)}x (defect measured 3.6x)`,
    ).toBeGreaterThan(10);
  });

  it('damping it UP never makes it LOUDER — monotone non-increasing RMS', () => {
    const rows = [0, 0.25, 0.5, 0.75, 1].map((d) => ({ d, rms: rmsOf(modalAt(d)) }));
    const label = rows.map((r) => `${r.d}:${r.rms.toExponential(3)}`).join(' ');
    for (let i = 1; i < rows.length; i++) {
      expect(
        rows[i]!.rms,
        `RMS must not rise with DAMPING — sweep was ${label} (defect rose 5.65e-3 -> 1.65e-2)`,
      ).toBeLessThanOrEqual(rows[i - 1]!.rms);
    }
    // ...and it must actually MOVE, or "non-increasing" is satisfied by a dead knob.
    expect(rows[0]!.rms / rows[rows.length - 1]!.rms).toBeGreaterThan(1.5);
  });

  // NEGATIVE CONTROL ON THE INSTRUMENT: decay60Ms must distinguish a long tail
  // from a short one on synthetic input, or the range assertion above proves
  // nothing about ring TIME.
  it('NEGATIVE CONTROL: decay60Ms separates a 10 ms tail from a 1 s tail', () => {
    const mk = (tauS: number): Float32Array => {
      const b = new Float32Array(SR);
      for (let i = 0; i < b.length; i++) b[i] = Math.exp(-i / (tauS * SR)) * Math.sin(i * 0.1);
      return b;
    };
    expect(decay60Ms(mk(0.0015), SR)).toBeLessThan(20);
    expect(decay60Ms(mk(0.15), SR)).toBeGreaterThan(800);
  });
});

describe('rings worklet ↔ pure-math mirror parity', () => {
  it('packages/dsp/src/rings.ts and ringsMath carry the SAME algorithm', () => {
    const dsp = algorithmBody(readFileSync(DSP_RINGS, 'utf8'));
    const web = algorithmBody(readFileSync(resolve(HERE, 'rings.ts'), 'utf8'));
    expect(
      web,
      'the WEB mirror (what every rings test renders) has drifted from the DSP worklet (what the user hears) — fix BOTH or neither',
    ).toBe(dsp);
  });

  // NEGATIVE CONTROL, every run: prove the comparison can actually SEE a
  // one-character algorithm change. A normaliser that strips too much would
  // make the assertion above vacuous, and it would look exactly as green.
  it('NEGATIVE CONTROL: a single flipped coefficient makes the parity check fail', () => {
    const dsp = readFileSync(DSP_RINGS, 'utf8');
    const tampered = dsp.replace('const w0 = 2 * Math.PI * this.position;', 'const w0 = 1 * Math.PI * this.position;');
    expect(tampered, 'the tamper target must still exist in the DSP source').not.toBe(dsp);
    expect(algorithmBody(tampered)).not.toBe(algorithmBody(dsp));
  });
});

describe('RINGS model name table', () => {
  it('lists MODAL then SYMPATHETIC', () => {
    expect(RINGS_MODEL_NAMES[0]).toBe('MODAL');
    expect(RINGS_MODEL_NAMES[1]).toBe('SYMPATHETIC');
  });

  it('cycling logic wraps 0 → 1 → 0', () => {
    // Mirrors the cycleModel() function in RingsCard.svelte.
    const MAX = RINGS_MAX_MODEL;
    const next = (v: number): number => (v + 1) % (MAX + 1);
    expect(next(0)).toBe(1);
    expect(next(1)).toBe(0);
  });
});

describe('ringsMath — V/oct mapping', () => {
  it('1 V/oct shifts fundamental up an octave', () => {
    const exciter = makeBurstExciter(SR, 480);
    const a4 = ringsMath.render(SR, SR, 0.75, baseParams, exciter);
    const a5 = ringsMath.render(SR, SR, 1.75, baseParams, exciter);
    const a4Tail = a4.odd.slice(SR / 20);
    const a5Tail = a5.odd.slice(SR / 20);
    expect(powerAt(a4Tail, 440, SR)).toBeGreaterThan(powerAt(a4Tail, 880, SR) * 0.5);
    expect(powerAt(a5Tail, 880, SR)).toBeGreaterThan(powerAt(a5Tail, 440, SR) * 2);
  });

  it('NOTE param adds semitones on top of pitch (note=12 → octave up)', () => {
    const sympParams: RingsParams = {
      ...baseParams, model: 1, structure: 0, brightness: 0.0, damping: 0.0,
    };
    const at0  = ringsMath.render(SR, SR, 0.75, sympParams,                  null, 0);
    const at12 = ringsMath.render(SR, SR, 0.75, { ...sympParams, note: 12 }, null, 0);
    const t0  = at0.odd.slice(SR / 10);
    const t12 = at12.odd.slice(SR / 10);
    expect(powerAt(t0, 440, SR)).toBeGreaterThan(powerAt(t12, 440, SR) * 2);
  });
});
