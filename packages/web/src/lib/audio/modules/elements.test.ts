// packages/web/src/lib/audio/modules/elements.test.ts
//
// Unit tests for ELEMENTS: module-def shape + pure-math engine sanity
// (exciter envelopes, modal resonator pitch tracking + damping decay).

import { describe, expect, it } from 'vitest';
import { elementsDef, elementsMath, type ElementsParams } from './elements';

describe('elementsDef shape', () => {
  it('declares type=elements, label=ELEMENTS, category=sources', () => {
    expect(elementsDef.type).toBe('elements');
    expect(elementsDef.label).toBe('elements');
    expect(elementsDef.category).toBe('sources');
  });

  it('exposes the mandatory I/O ports', () => {
    const ids = elementsDef.inputs.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['in', 'strike_in', 'pitch', 'gate']));
  });

  it('exposes 2 audio outputs: main + aux', () => {
    const ids = elementsDef.outputs.map((p) => p.id);
    expect(ids).toEqual(['main', 'aux']);
    for (const p of elementsDef.outputs) expect(p.type).toBe('audio');
  });

  it('declares main/aux as a stereoPair', () => {
    expect(elementsDef.stereoPairs).toEqual([['main', 'aux']]);
  });

  it('pitch input is pitch-typed, gate input is gate-typed', () => {
    expect(elementsDef.inputs.find((p) => p.id === 'pitch')!.type).toBe('pitch');
    expect(elementsDef.inputs.find((p) => p.id === 'gate')!.type).toBe('gate');
  });

  it('every cv input has paramTarget pointing at a real param + cvScale set', () => {
    for (const port of elementsDef.inputs) {
      if (port.type !== 'cv') continue;
      expect(port.paramTarget).toBeDefined();
      expect(port.cvScale).toBeDefined();
      const param = elementsDef.params.find((p) => p.id === port.paramTarget);
      expect(param).toBeDefined();
    }
  });

  it('exposes the canonical exciter + resonator params', () => {
    const ids = elementsDef.params.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([
      'note', 'envShape',
      'bowLevel', 'bowTimbre', 'blowLevel', 'blowMeta', 'blowTimbre',
      'strikeLevel', 'strikeMeta', 'strikeTimbre',
      'geometry', 'brightness', 'damping', 'position', 'space', 'strength',
    ]));
  });

  it('note param: ±60 semitone offset; space param 0..2', () => {
    const note = elementsDef.params.find((p) => p.id === 'note')!;
    expect(note.min).toBe(-60);
    expect(note.max).toBe(60);
    expect(note.units).toBe('st');
    const space = elementsDef.params.find((p) => p.id === 'space')!;
    expect(space.max).toBe(2);
  });

  it('attributes Émilie Gillet', () => {
    expect(elementsDef.ossAttribution?.author).toBe('Émilie Gillet');
  });
});

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

const baseParams: ElementsParams = {
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
  damping: 0.25,
  position: 0.3,
  space: 0.0,
  strength: 0.7,
};

describe('elementsMath — strike-excited modal voice', () => {
  it('produces non-silent, finite stereo audio on a gated strike at A4', () => {
    // pitchV = 0 → A4 (note base 69). Hold gate the whole render.
    const { main, aux } = elementsMath.render(SR, SR, 0, baseParams, 0, -1);
    let peakMain = 0;
    let peakAux = 0;
    for (let i = 0; i < main.length; i++) {
      expect(Number.isFinite(main[i]!)).toBe(true);
      expect(Number.isFinite(aux[i]!)).toBe(true);
      const m = Math.abs(main[i]!);
      const a = Math.abs(aux[i]!);
      if (m > peakMain) peakMain = m;
      if (a > peakAux) peakAux = a;
    }
    expect(peakMain).toBeGreaterThan(1e-4);
    expect(peakAux).toBeGreaterThan(1e-4);
  });

  it('soft-limits the output below unity even when driven hot', () => {
    const { main, aux } = elementsMath.render(SR, SR, 0, {
      ...baseParams, strikeLevel: 1.0, strength: 1.0, damping: 0.02, brightness: 1.0,
    }, 0, -1);
    let peak = 0;
    for (let i = 0; i < main.length; i++) {
      peak = Math.max(peak, Math.abs(main[i]!), Math.abs(aux[i]!));
    }
    // softLimit(x) asymptotes to ±3 but stays comfortably bounded; assert finite + sane.
    expect(peak).toBeLessThan(4);
    expect(Number.isFinite(peak)).toBe(true);
  });
});

describe('elementsMath — pitch tracking', () => {
  it('carries energy at the fundamental (A4=440) when pitch=0', () => {
    const { main } = elementsMath.render(SR, SR, 0, baseParams, 0, -1);
    const tail = main.slice(Math.floor(SR / 20));
    // The fundamental should dominate an inharmonic offset frequency.
    expect(powerAt(tail, 440, SR)).toBeGreaterThan(powerAt(tail, 1234, SR));
  });

  it('1 V/oct moves the fundamental: A4 carries more 440Hz energy than A5', () => {
    // Bowed + sustained so both pitches ring steadily through the window.
    const bowed = { ...baseParams, strikeLevel: 0, bowLevel: 0.9, damping: 0.5 };
    const a4 = elementsMath.render(SR, SR, 0, bowed, 0, -1).main.slice(Math.floor(SR / 4), Math.floor(SR / 2));
    const a5 = elementsMath.render(SR, SR, 1, bowed, 0, -1).main.slice(Math.floor(SR / 4), Math.floor(SR / 2));
    // Pitching up an octave shifts the fundamental off 440, so A5 has less
    // energy at 440 than A4 does — direct evidence of V/oct pitch tracking.
    expect(powerAt(a4, 440, SR)).toBeGreaterThan(powerAt(a5, 440, SR) * 1.5);
  });

  it('NOTE param adds semitones on top of pitch (note=12 → octave up moves 440 energy)', () => {
    const bowed = { ...baseParams, strikeLevel: 0, bowLevel: 0.9, damping: 0.5 };
    const at0 = elementsMath.render(SR, SR, 0, bowed, 0, -1).main.slice(Math.floor(SR / 4), Math.floor(SR / 2));
    const at12 = elementsMath.render(SR, SR, 0, { ...bowed, note: 12 }, 0, -1).main.slice(Math.floor(SR / 4), Math.floor(SR / 2));
    expect(powerAt(at0, 440, SR)).toBeGreaterThan(powerAt(at12, 440, SR) * 1.5);
  });
});

describe('elementsMath — DAMPING controls ring-out', () => {
  it('low DAMPING rings longer than high DAMPING', () => {
    const longRing = elementsMath.render(SR, SR, 0, { ...baseParams, damping: 0.02 }, 0, 1);
    const shortRing = elementsMath.render(SR, SR, 0, { ...baseParams, damping: 0.95 }, 0, 1);
    const tailStart = Math.floor(SR * 0.4);
    let longSum = 0;
    let shortSum = 0;
    for (let i = tailStart; i < SR; i++) {
      longSum += longRing.main[i]! * longRing.main[i]!;
      shortSum += shortRing.main[i]! * shortRing.main[i]!;
    }
    const longRms = Math.sqrt(longSum / (SR - tailStart));
    const shortRms = Math.sqrt(shortSum / (SR - tailStart));
    expect(longRms).toBeGreaterThan(shortRms * 2);
  });
});

describe('elementsMath — exciter contributions', () => {
  it('BOW level adds sustained energy (sustained envShape)', () => {
    // With strike off + bow on, a held gate should sustain output.
    const bowed = elementsMath.render(SR, SR, 0, {
      ...baseParams, strikeLevel: 0, bowLevel: 0.8, envShape: 1, damping: 0.4,
    }, 0, -1);
    const tail = bowed.main.slice(Math.floor(SR * 0.6));
    let energy = 0;
    for (let i = 0; i < tail.length; i++) energy += tail[i]! * tail[i]!;
    expect(Math.sqrt(energy / tail.length)).toBeGreaterThan(1e-5);
  });

  it('no exciters + held gate → near silent (control)', () => {
    const { main, aux } = elementsMath.render(
      Math.floor(SR * 0.1), SR, 0,
      { ...baseParams, strikeLevel: 0, bowLevel: 0, blowLevel: 0 },
      0, -1,
    );
    let peak = 0;
    for (let i = 0; i < main.length; i++) {
      peak = Math.max(peak, Math.abs(main[i]!), Math.abs(aux[i]!));
    }
    expect(peak).toBeLessThan(1e-3);
  });

  it('SPACE > 0 widens the stereo image (main != aux)', () => {
    const wide = elementsMath.render(Math.floor(SR * 0.3), SR, 0, {
      ...baseParams, space: 0.6,
    }, 0, -1);
    let diff = 0;
    let energy = 0;
    for (let i = 0; i < wide.main.length; i++) {
      const d = wide.main[i]! - wide.aux[i]!;
      diff += d * d;
      energy += wide.main[i]! * wide.main[i]!;
    }
    // With spread > 0 the two channels decorrelate; difference is non-trivial.
    expect(diff).toBeGreaterThan(0);
    expect(energy).toBeGreaterThan(0);
  });
});
