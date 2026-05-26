// art/scenarios/elements/modal-character.test.ts
//
// Audio Regression Test scenarios for ELEMENTS — longer renders that pin
// perceptually-meaningful character of the modal voice:
//   - a strike-excited resonator rings audibly and tracks pitch (fundamental
//     energy at A4 drops when pitched up an octave);
//   - DAMPING governs ring-out length (late-tail RMS vs early-tail RMS);
//   - GEOMETRY (stiffness) bends upper partials off the integer harmonic grid.
//
// All scenarios render through the same pure-math mirror the unit tests use
// (elementsMath.render — algorithm-equivalent to packages/dsp/src/elements.ts;
// the worklet adds the bowed band-waveguide + full reverb, which we omit from
// the mirror for determinism, as documented in the module source).

import { describe, expect, it } from 'vitest';
import { elementsMath, type ElementsParams } from '../../../packages/web/src/lib/audio/modules/elements';

const SR = 32000;

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

function rms(buf: Float32Array, start: number, end: number): number {
  let s = 0;
  for (let i = start; i < end; i++) s += buf[i]! * buf[i]!;
  return Math.sqrt(s / (end - start));
}

const base: ElementsParams = {
  note: 0,
  envShape: 1,
  bowLevel: 0,
  bowTimbre: 0.5,
  blowLevel: 0,
  blowMeta: 0.5,
  blowTimbre: 0.5,
  strikeLevel: 0.8,
  strikeMeta: 0,
  strikeTimbre: 0.6,
  geometry: 0.2,
  brightness: 0.5,
  damping: 0.3,
  position: 0.3,
  space: 0,
  strength: 0.8,
};

describe('ART elements / strike-excited modal voice', () => {
  it('a mallet strike at A4 rings audibly in the attack window', () => {
    const { main, aux } = elementsMath.render(SR, SR, 0, base, 0, -1);
    expect(rms(main, 0, Math.floor(SR * 0.05))).toBeGreaterThan(1e-4);
    expect(rms(aux, 0, Math.floor(SR * 0.05))).toBeGreaterThan(1e-4);
  });

  it('pitch tracks 1 V/oct — A4 carries more 440Hz energy than A5 (bowed sustain)', () => {
    const bowed = { ...base, strikeLevel: 0, bowLevel: 0.9, damping: 0.5 };
    const a4 = elementsMath.render(SR, SR, 0, bowed, 0, -1).main.slice(Math.floor(SR / 4), Math.floor(SR / 2));
    const a5 = elementsMath.render(SR, SR, 1, bowed, 0, -1).main.slice(Math.floor(SR / 4), Math.floor(SR / 2));
    expect(powerAt(a4, 440, SR)).toBeGreaterThan(powerAt(a5, 440, SR) * 1.5);
  });
});

describe('ART elements / DAMPING ring-out length', () => {
  it('low DAMPING rings markedly longer than high DAMPING', () => {
    const longRing = elementsMath.render(SR, SR, 0, { ...base, damping: 0.05 }, 0, 1);
    const shortRing = elementsMath.render(SR, SR, 0, { ...base, damping: 0.9 }, 0, 1);
    const tailStart = Math.floor(SR * 0.3);
    const longRms = rms(longRing.main, tailStart, SR);
    const shortRms = rms(shortRing.main, tailStart, SR);
    expect(longRms).toBeGreaterThan(shortRms * 3);
  });
});

describe('ART elements / GEOMETRY inharmonicity', () => {
  it('high GEOMETRY bends the 3rd partial off the integer harmonic grid', () => {
    // Compare H3/fundamental energy ratio at the integer-harmonic bin (1320Hz)
    // between near-harmonic geometry and a strongly inharmonic (bell) geometry.
    // Stretching the partials moves the 3rd mode away from 3·f0, lowering the
    // measured energy at the integer-multiple bin.
    const bowed = { ...base, strikeLevel: 0, bowLevel: 0.9, damping: 0.4 };
    const harmonic = elementsMath.render(SR, SR, 0, { ...bowed, geometry: 0.28 }, 0, -1).main.slice(Math.floor(SR / 4), Math.floor(SR / 2));
    const bell = elementsMath.render(SR, SR, 0, { ...bowed, geometry: 1.0 }, 0, -1).main.slice(Math.floor(SR / 4), Math.floor(SR / 2));
    const fund = 440;
    const h3 = 1320;
    const harmRatio = powerAt(harmonic, h3, SR) / Math.max(1e-12, powerAt(harmonic, fund, SR));
    const bellRatio = powerAt(bell, h3, SR) / Math.max(1e-12, powerAt(bell, fund, SR));
    expect(harmRatio).toBeGreaterThan(bellRatio);
  });
});
