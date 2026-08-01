// packages/web/src/lib/audio/modules/lfo-face-model.test.ts
//
// The LFO face's arithmetic, pinned. Three jobs, in order of how much they
// would cost to get wrong:
//
//  1. THE DEPTH LAW IS THE DSP'S LAW. `lfoDepthGain` is asserted against the
//     worklet's own `gain = Math.max(0, depth) * 2` at the values the def
//     documents (0 → still, 0.5 → unity, 1 → ±2), and the def's `depth`
//     defaultValue is asserted to BE the unity point rather than merely to
//     equal 0.5. That second assertion is the one that catches a DSP change
//     landing without the face following it.
//
//  2. THE GLYPH CLAMPS, AND THE CLAMP IS THE RANKING ARGUMENT. `lfoGlyphAmp`
//     saturating at unity is why DEPTH outranks SHAPE in `face.order` — the
//     picture stops reporting depth halfway up the knob. If that ever stopped
//     being true the ranking's stated reason would be false, so it is pinned.
//
//  3. THE READOUTS SAY WHAT THE NUMBER MEANS. The rate readout's Hz↔period
//     crossover and the depth readout's STILL case are the two places the
//     dial's raw value is actively misleading.
//
// Pure: no DOM, no engine, no registry beyond the def itself.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  LFO_DEPTH_UNITY,
  LFO_SHAPE_LANDMARKS,
  lfoDepthGain,
  lfoDepthReadout,
  lfoGlyphAmp,
  lfoRateReadout,
} from './lfo-face-model';
import { lfoDef } from './lfo';

const param = (id: string) => lfoDef.params.find((p) => p.id === id)!;

describe('lfo depth law — the DSP number, once', () => {
  it('reproduces the worklet gain at every documented waypoint', () => {
    // packages/dsp/src/lfo.ts: `const gain = Math.max(0, depthRaw) * 2`.
    expect(lfoDepthGain(0)).toBe(0); // still — a flat line at 0
    expect(lfoDepthGain(LFO_DEPTH_UNITY)).toBe(1); // unity ±1 (legacy swing)
    expect(lfoDepthGain(1)).toBe(2); // ±2, deliberately past normal CV range
  });

  it('clamps NEGATIVE depth to silence, exactly as Math.max(0, …) does', () => {
    expect(lfoDepthGain(-1)).toBe(0);
    expect(lfoDepthGain(-0.001)).toBe(0);
  });

  it("the def's depth default IS the unity point — not a literal that happens to match", () => {
    // The negative control for the whole single-source claim: change
    // LFO_DEPTH_GAIN and this fails, because LFO_DEPTH_UNITY moves with it and
    // the def imports the constant instead of typing 0.5.
    expect(param('depth').defaultValue).toBe(LFO_DEPTH_UNITY);
    expect(lfoDepthGain(param('depth').defaultValue)).toBe(1);
  });
});

describe('lfo glyph amplitude — why DEPTH outranks SHAPE', () => {
  it('tracks the gain up to unity', () => {
    expect(lfoGlyphAmp(0)).toBe(0);
    expect(lfoGlyphAmp(0.25)).toBeCloseTo(0.5, 12);
    expect(lfoGlyphAmp(LFO_DEPTH_UNITY)).toBe(1);
  });

  it('SATURATES above unity — the top half of the knob draws identically', () => {
    // The stated ranking argument, asserted rather than claimed: the glyph
    // cannot buy DEPTH's rank because it stops reporting it here.
    expect(lfoGlyphAmp(0.75)).toBe(1);
    expect(lfoGlyphAmp(1)).toBe(1);
    expect(lfoGlyphAmp(0.5)).toBe(lfoGlyphAmp(1));
  });
});

describe('lfo shape landmarks — the morph anchors', () => {
  it('names the three DSP anchors at their own values', () => {
    expect(LFO_SHAPE_LANDMARKS.map((l) => [l.value, l.label])).toEqual([
      [0, 'sine'],
      [1, 'saw'],
      [2, 'square'],
    ]);
  });

  it('every anchor lies inside the def range, and the range ends are anchored', () => {
    const p = param('shape');
    for (const l of LFO_SHAPE_LANDMARKS) {
      expect(l.value, `${l.label} within [${p.min},${p.max}]`).toBeGreaterThanOrEqual(p.min);
      expect(l.value).toBeLessThanOrEqual(p.max);
    }
    // Both ends of the morph are NAMED — a landmark roster that stopped short
    // would leave the dial's extremes reading as the nearest interior name.
    expect(LFO_SHAPE_LANDMARKS.some((l) => l.value === p.min)).toBe(true);
    expect(LFO_SHAPE_LANDMARKS.some((l) => l.value === p.max)).toBe(true);
  });

  it('is the roster the def actually ships (the face reads THIS array)', () => {
    expect(param('shape').landmarks).toBe(LFO_SHAPE_LANDMARKS);
  });
});

describe('lfoRateReadout — frequency above 1 Hz, PERIOD below it', () => {
  it('prints Hz at and above the crossover', () => {
    expect(lfoRateReadout(1)).toBe('1.00 Hz');
    expect(lfoRateReadout(2.5)).toBe('2.50 Hz');
    expect(lfoRateReadout(12.34)).toBe('12.3 Hz');
    expect(lfoRateReadout(100)).toBe('100 Hz');
  });

  it('prints SECONDS below the crossover — the dial’s whole bottom two thirds', () => {
    expect(lfoRateReadout(0.5)).toBe('2.00 s'); // one sweep every 2 s
    expect(lfoRateReadout(0.1)).toBe('10.0 s');
    expect(lfoRateReadout(0.01)).toBe('100 s'); // the def's floor
  });

  it('is continuous ACROSS the crossover (1 Hz reads the same both ways)', () => {
    // 1 Hz is the only rate where frequency and period are the same number, so
    // the switch is invisible: 1.00 Hz on one side, 1.00 s a hair below it.
    expect(lfoRateReadout(1)).toBe('1.00 Hz');
    expect(lfoRateReadout(0.9999)).toBe('1.00 s');
  });

  it('covers the def’s full declared range without printing garbage', () => {
    const p = param('rate');
    for (const v of [p.min, p.defaultValue, p.max]) {
      expect(lfoRateReadout(v)).toMatch(/^\d[\d.]* (Hz|s)$/);
    }
  });

  it('is TOTAL — a non-finite or non-positive rate prints a dash, never Infinity', () => {
    expect(lfoRateReadout(0)).toBe('—');
    expect(lfoRateReadout(-1)).toBe('—');
    expect(lfoRateReadout(Number.NaN)).toBe('—');
    expect(lfoRateReadout(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('is the formatter the def actually ships', () => {
    expect(param('rate').format?.(0.01)).toBe('100 s');
  });
});

describe('lfoDepthReadout — the SWING, not the knob position', () => {
  it('prints the bipolar swing the module emits', () => {
    expect(lfoDepthReadout(LFO_DEPTH_UNITY)).toBe('±1.00');
    expect(lfoDepthReadout(1)).toBe('±2.00');
    expect(lfoDepthReadout(0.25)).toBe('±0.50');
  });

  it('prints STILL at zero — a flat line is a mode, not a level', () => {
    expect(lfoDepthReadout(0)).toBe('still');
    expect(lfoDepthReadout(-1)).toBe('still'); // clamped, same flat line
  });

  it('is TOTAL on a non-finite value', () => {
    expect(lfoDepthReadout(Number.NaN)).toBe('—');
  });

  it('is the formatter the def actually ships', () => {
    expect(param('depth').format?.(0.5)).toBe('±1.00');
  });
});

describe('SOURCE guard — the card cannot re-type a range the def declares', () => {
  // The CLAUDE.md backdraft rule, applied at the only altitude that can see it.
  // Every runtime gate here reads the DEF; a CARD passing its own literals to a
  // control is invisible to all of them (BackdraftCard shipped ±1 XyPads into a
  // ±0.2 contract and every def-reading assertion stayed green). LfoCard used
  // to hand-type all three ranges AND its own three-entry shape-glyph roster;
  // both now come from the def/model, and this is what keeps them there.
  const cardSrc = readFileSync(
    fileURLToPath(new URL('../../ui/modules/LfoCard.svelte', import.meta.url)),
    'utf8',
  );
  /** Comments are PROSE, not markup — and the card's own comment quotes the
   *  literals it is documenting the removal of, so an un-stripped grep flags
   *  the explanation as the offence (it did, first run). Strip `//`, block and
   *  HTML comments before matching. */
  const cardCode = cardSrc
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('LfoCard passes NO hand-typed min / max / defaultValue to any control', () => {
    const literals = [...cardCode.matchAll(/\b(min|max|defaultValue)=\{[^}]*\}/g)].map((m) => m[0]);
    expect(
      literals.filter((s) => /\{\s*-?\d/.test(s)),
      'a numeric range literal in the card is a second source of truth for a number ' +
        'the def already declares — read it from lfoDef.params instead',
    ).toEqual([]);
  });

  it('LfoCard no longer carries its own shape-anchor roster', () => {
    expect(
      /SHAPE_GLYPHS/.test(cardCode),
      'the shape anchors live in LFO_SHAPE_LANDMARKS (def-declared, gate-visible)',
    ).toBe(false);
  });

  it('the def imports the depth law rather than restating it', () => {
    const defSrc = readFileSync(fileURLToPath(new URL('./lfo.ts', import.meta.url)), 'utf8');
    expect(defSrc).toContain("from './lfo-face-model'");
    expect(defSrc).toContain('LFO_DEPTH_UNITY');
  });
});
