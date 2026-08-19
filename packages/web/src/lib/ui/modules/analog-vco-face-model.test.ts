// packages/web/src/lib/ui/modules/analog-vco-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS behind ANALOG VCO's derived readouts — the
// whole difference between this registry and four relabelled knobs.
//
// Plus a SOURCE-GREP PIN on the .dsp: the tap laws are RE-TYPED here because
// Faust cannot be imported, so this is the only thing standing between the
// mirror and drift.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  VCO_C4_HZ,
  vcoFaceParams,
  vcoFirstAliasedHarmonic,
  vcoFmSpanCents,
  vcoKnobHz,
  vcoPwAuthority,
  vcoTapSample,
  type VcoFaceParams,
} from './analog-vco-face-model';

const DEFAULTS: VcoFaceParams = vcoFaceParams(() => undefined);

function withParams(over: Partial<VcoFaceParams>): (id: string) => number | undefined {
  const p = { ...DEFAULTS, ...over };
  return (id) => (p as unknown as Record<string, number>)[id];
}

function readout(id: string, over: Partial<VcoFaceParams> = {}): string {
  const fn = faceReadoutValueFor(id);
  expect(fn, `${id} is not registered in face-readout-values.ts`).not.toBeNull();
  return fn!(withParams(over));
}

function dspSource(): string {
  return readFileSync(
    fileURLToPath(new URL('../../../../../dsp/src/analog-vco.dsp', import.meta.url)),
    'utf8',
  );
}

describe('analog vco face model — the .dsp source pin', () => {
  it('the four-term exponent and its clamp are still what the model mirrors', () => {
    const src = dspSource();
    expect(src).toContain('261.626 * pow(2.0, pitch + tune/12.0 + fine/1200.0 + fmAmount * fm)');
    expect(src).toContain('max(1.0)');
    expect(src).toContain('min(20000.0)');
    expect(VCO_C4_HZ).toBe(261.626);
  });

  it('the five tap laws are still what the model re-types', () => {
    const src = dspSource();
    expect(src).toContain('saw(p) = 2.0 * p - 1.0;');
    expect(src).toContain('sqr(p) = select2(p < pw, 1.0, -1.0);');
    // ⚠ TRIANGLE PEAKS AT p = 0 — polarity-inverted from the textbook shape.
    expect(src).toContain('tri(p) = (4.0 * abs(p - 0.5)) - 1.0;');
    expect(src).toContain('sn(p)  = sin(2.0 * ma.PI * p);');
    expect(src).toContain('lo = 2.0 * shape;');
    expect(src).toContain('hi = 2.0 * shape - 1.0;');
  });

  it('PM is still added at the READ while sync_out reads the RAW accumulator', () => {
    const src = dspSource();
    expect(src).toContain('syncPulse(pRaw) = (pRaw < pRaw\') * 1.0;');
    expect(src).toContain('p    = ma.frac(pRaw + pmAmount * pm);');
  });

  it('there is still NO band-limiting anywhere in the file', () => {
    const src = dspSource().toLowerCase();
    for (const bad of ['blep', 'oversampl', 'antialias', 'anti-alias']) {
      // The word may appear in a COMMENT; what must not exist is a definition.
      expect(src.includes(`${bad} =`), `a ${bad} stage appeared`).toBe(false);
    }
  });
});

describe('analog vco face model — the shipped defaults', () => {
  it('resolves the def defaults for an untouched node', () => {
    expect(DEFAULTS).toEqual({ tune: 0, fine: 0, fmAmount: 0, pw: 0.5, shape: 0 });
  });

  it('prints the face’s own figures', () => {
    expect(readout('analogvco-knob-hz')).toBe('261.6 Hz');
    expect(readout('analogvco-fm-span')).toBe('off');
    // THE HEADLINE: PW owns 0 % of the morph at the shipped defaults.
    expect(readout('analogvco-pw-authority')).toBe('0 %');
    expect(readout('analogvco-alias-harmonic')).toBe('h91');
  });
});

describe('analog vco face model — NEGATIVE CONTROLS', () => {
  // (a) `knob pitch` is TWO params. A `tune` readback is blind to FINE.
  it('FINE alone moves the pitch 261.6 → 263.1 Hz while TUNE sits at 0', () => {
    expect(readout('analogvco-knob-hz', { fine: 10 })).toBe('263.1 Hz');
    expect(DEFAULTS.tune).toBe(0);
  });

  it('the ONE-DECIMAL formatter is load-bearing at this pitch', () => {
    // `kickdrum-format`'s fmtHz rounds to INTEGER Hz. At C4 one cent is 0.15 Hz,
    // so an integer readout collapses a real detune to nothing — which is why
    // this model ships its own `fmtVcoHz`. (At +10 ¢ integer rounding happens
    // to survive, 262 → 263; at +1 ¢ it does not, and both are the same bug.)
    expect(Math.round(vcoKnobHz(DEFAULTS))).toBe(Math.round(vcoKnobHz({ ...DEFAULTS, fine: 1 })));
    expect(readout('analogvco-knob-hz', { fine: 1 })).not.toBe(readout('analogvco-knob-hz'));
  });

  // (b) `fm span` is invariant to the DIAL's SIGN and NOT invariant to TUNE.
  it('flipping fmAmount’s SIGN leaves the span BYTE-IDENTICAL', () => {
    // analog-vco.dsp:10-12 — a negative fmAmount INVERTS THE MODULATOR (a 180°
    // flip); it does not reverse the sweep direction. A derivation wrong in
    // that direction is what this leg catches.
    expect(readout('analogvco-fm-span', { fmAmount: -0.5 })).toBe(
      readout('analogvco-fm-span', { fmAmount: 0.5 }),
    );
    expect(vcoFmSpanCents({ ...DEFAULTS, fmAmount: 0.5 })).toBeCloseTo(600, 6);
  });

  it('TUNE scales the Hz deviation while the FM dial does not twitch', () => {
    const c4 = readout('analogvco-fm-span', { fmAmount: 0.5 });
    const c5 = readout('analogvco-fm-span', { fmAmount: 0.5, tune: 12 });
    expect(c4).toContain('+108.4 Hz');
    expect(c4).toContain('76.6 Hz');
    expect(c5).toContain('+216.7 Hz');
    expect(c5).toContain('153.3 Hz');
    expect(c5).not.toBe(c4);
    // …and the CENT span is TUNE-invariant, which is the other half.
    expect(vcoFmSpanCents({ ...DEFAULTS, fmAmount: 0.5, tune: 12 })).toBeCloseTo(600, 6);
  });

  // (c) `pw on morph` is a function of SHAPE and nothing else.
  it('SHAPE 0 → 1 walks PW’s morph authority 0 % → 100 % with PW frozen', () => {
    expect(readout('analogvco-pw-authority', { shape: 0 })).toBe('0 %');
    expect(readout('analogvco-pw-authority', { shape: 0.5 })).toBe('0 %');
    expect(readout('analogvco-pw-authority', { shape: 0.75 })).toBe('50 %');
    expect(readout('analogvco-pw-authority', { shape: 1 })).toBe('100 %');
    // …and PW itself never moves the number.
    expect(readout('analogvco-pw-authority', { shape: 0.75, pw: 0.05 })).toBe(
      readout('analogvco-pw-authority', { shape: 0.75, pw: 0.95 }),
    );
  });

  it('the dead zone matches analog-vco-morph.test.ts’s own assertion exactly', () => {
    // That spec pins rms < 1e-9 for shape ∈ {0, 0.1, 0.25, 0.4} — i.e. PW is
    // inaudible on the morph tap there. This readout must print the SAME fact.
    for (const shape of [0, 0.1, 0.25, 0.4]) {
      expect(vcoPwAuthority({ ...DEFAULTS, shape }), `shape ${shape}`).toBe(0);
    }
  });

  // (d) `first aliased harmonic` halves per octave.
  it('TUNE up an octave halves the first aliased harmonic', () => {
    expect(vcoFirstAliasedHarmonic(DEFAULTS)).toBe(91);
    expect(vcoFirstAliasedHarmonic({ ...DEFAULTS, tune: 12 })).toBe(45);
    expect(vcoFirstAliasedHarmonic({ ...DEFAULTS, tune: 36 })).toBe(11);
  });
});

describe('analog vco face model — the tap laws', () => {
  it('MORPH at shape 0 is BIT-IDENTICAL to SAW, for every PW', () => {
    // The back-compat identity the .dsp guarantees (:74-77): wiring morph in
    // place of saw with the knob at 0 reproduces the bare saw.
    for (const pw of [0.05, 0.2, 0.5, 0.8, 0.95]) {
      for (let i = 0; i <= 64; i++) {
        const ph = i / 64;
        expect(vcoTapSample('morph', ph, 0, pw), `pw ${pw} phase ${ph}`).toBe(
          vcoTapSample('saw', ph, 0, pw),
        );
      }
    }
  });

  it('MORPH at shape 0.5 is the SINE, and at 1 the SQUARE', () => {
    for (let i = 1; i < 64; i++) {
      const ph = i / 64;
      expect(vcoTapSample('morph', ph, 0.5, 0.5)).toBeCloseTo(vcoTapSample('sine', ph, 0, 0.5), 12);
      expect(vcoTapSample('morph', ph, 1, 0.3)).toBeCloseTo(vcoTapSample('square', ph, 0, 0.3), 12);
    }
  });

  it('the TRIANGLE peaks at phase 0 — polarity-inverted from the textbook', () => {
    expect(vcoTapSample('triangle', 0, 0, 0.5)).toBeCloseTo(1, 12);
    expect(vcoTapSample('triangle', 0.5, 0, 0.5)).toBeCloseTo(-1, 12);
  });

  it('PW moves the SQUARE tap from spawn — SHAPE is not involved', () => {
    // The half of the story the one-line summary got wrong: `sqr(p)` IS output
    // 2, so PW is live there at the shipped shape of 0.
    expect(vcoTapSample('square', 0.3, 0, 0.5)).toBe(1);
    expect(vcoTapSample('square', 0.3, 0, 0.2)).toBe(-1);
  });
});
