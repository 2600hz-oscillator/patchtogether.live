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
import { stripSourceComments } from '$lib/source-guards/strip-source-comments';
import {
  LFO_DEPTH_GAIN,
  LFO_DEPTH_UNITY,
  LFO_SHAPE_LANDMARKS,
  lfoDepthGain,
  lfoDepthReadout,
  lfoGlyphAmp,
  lfoRateReadout,
} from './lfo-face-model';
import { lfoDepthGain as lfoStateDepthGain } from './lfo-state';
import { glyphBinding, waveMorphGlyphAmp } from '$lib/ui/workflow/shell-glyph-live';
import { lfoDef } from './lfo';

const param = (id: string) => lfoDef.params.find((p) => p.id === id)!;

const repoFile = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

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
    // ⚠ THIS IS *NOT* THE NEGATIVE CONTROL, whatever an earlier revision of
    // this comment claimed. Both sides move together under a change to
    // LFO_DEPTH_GAIN — `LFO_DEPTH_UNITY = 1/G` and `max(0,1/G)*G === 1` for
    // every non-zero G — so the block is TAUTOLOGICAL with respect to the very
    // perturbation it advertised. Verified: at G = 3 both lines still pass.
    // What it does guard is a DIFFERENT edit — someone re-typing `0.5` into the
    // def — and that is all it is kept for. The real control is the
    // cross-source block below, which reads the two files that CANNOT import
    // this constant.
    expect(param('depth').defaultValue).toBe(LFO_DEPTH_UNITY);
    expect(lfoDepthGain(param('depth').defaultValue)).toBe(1);
  });

  it('is the ONLY lfoDepthGain — lfo-state re-exports it rather than re-typing it', () => {
    // `lfo-state.ts` used to export a function with the SAME NAME, the same
    // signature and an identical `Math.max(0, depth) * 2` body, one file over.
    // Nothing connected them: at LFO_DEPTH_GAIN = 3 the face, the def default,
    // the glyph and contract-lock all moved and `lfo.test.ts`'s
    // `expect(lfoDepthGain(0.5)).toBe(1)` — importing the OTHER one — stayed
    // green. Identity, not equality: two agreeing implementations is the
    // failure mode.
    expect(lfoStateDepthGain).toBe(lfoDepthGain);
  });
});

describe('the CROSS-SOURCE control — the two copies that cannot import a constant', () => {
  // The single-source claim only reaches files that can `import`. The worklet
  // is another package and the authored docs are PROSE, so both necessarily
  // re-state the number. They are therefore GATED here instead: change
  // LFO_DEPTH_GAIN and these go red, which is the difference between "the docs
  // are now wrong" and "nobody finds out the docs are now wrong".

  it("the WORKLET's depth default is still the unity point this face derives", () => {
    const dspSrc = repoFile('../../../../../dsp/src/lfo.ts');
    const m = dspSrc.match(/name:\s*'depth',\s*defaultValue:\s*([-\d.]+)/);
    expect(m, "packages/dsp/src/lfo.ts no longer declares a `depth` defaultValue — re-anchor this gate").toBeTruthy();
    expect(Number(m![1])).toBe(LFO_DEPTH_UNITY);
  });

  it("the WORKLET's depth→gain multiplier is still LFO_DEPTH_GAIN", () => {
    const dspSrc = repoFile('../../../../../dsp/src/lfo.ts');
    const m = dspSrc.match(/const gain = Math\.max\(0, depthRaw\) \* ([\d.]+)/);
    expect(m, 'the worklet gain line moved — re-anchor this gate on the real expression').toBeTruthy();
    expect(Number(m![1])).toBe(LFO_DEPTH_GAIN);
  });

  it("the def's AUTHORED PROSE still states the multiplier and the unity swing", () => {
    // Three sentences in lfo.ts restate the law in words. Prose can't import,
    // so it is asserted to contain the current numbers verbatim.
    const depthDoc = lfoDef.docs!.controls!.depth!;
    expect(depthDoc).toContain(`gain = depth × ${LFO_DEPTH_GAIN}`);
    expect(depthDoc).toContain(`${LFO_DEPTH_UNITY} = unity ±1`);
    expect(lfoDef.docs!.explanation).toContain(`${LFO_DEPTH_UNITY} = unity ±1`);
    expect(lfoDef.docs!.outputs!.phase0).toContain(`${LFO_DEPTH_UNITY} = unity ±1`);
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

  it('is the amplitude the SHELL ACTUALLY RENDERS — not an orphan beside it', () => {
    // ⚠ THE ASSERTION THAT MAKES THE TWO ABOVE MEAN ANYTHING. `lfoGlyphAmp` had
    // no caller: ModuleShell re-implemented the clamp inline, so deleting
    // `Math.min(1, …)` from the render path drew a different picture with all
    // four saturation assertions green (and both VRT scenes green too — they
    // capture the DEFAULT depth, where clamped and unclamped are identical).
    // Both now resolve through `waveMorphGlyphAmp`; this pins the wiring.
    expect(lfoGlyphAmp(1)).toBe(waveMorphGlyphAmp(1, LFO_DEPTH_GAIN));
    const shellSrc = repoFile('../../ui/modules/ModuleShell.svelte');
    expect(
      shellSrc,
      'the wave-morph branch must call waveMorphGlyphAmp, not re-implement the clamp',
    ).toContain('waveMorphGlyphAmp(liveParam(b.depthParamId), b.depthGain)');
    expect(
      /Math\.min\(1,\s*b\.depthGain/.test(shellSrc),
      'an inline clamp in ModuleShell is the second copy this fix removed',
    ).toBe(false);
  });
});

describe('the glyph multiplier is the MODULE’s, not the resolver’s', () => {
  it('lfo carries its own ×2 on the face and the binding reads it from there', () => {
    expect(lfoDef.face!.glyphDepthGain).toBe(LFO_DEPTH_GAIN);
    const b = glyphBinding(lfoDef);
    expect(b.kind).toBe('wave-morph');
    expect((b as { depthGain: number }).depthGain).toBe(LFO_DEPTH_GAIN);
  });

  it('a DIFFERENT module with the same glyph shape gets ITS law, not the lfo’s', () => {
    // The hole this closes: `glyphBinding` fires for ANY def with
    // `glyph:'waveform'` + a 0..2 `shape` + a `depth`, and it used to hardcode
    // `depthGain: LFO_DEPTH_GAIN`. A second such module silently inherited the
    // lfo's ×2 — and a test asserting `depthGain: LFO_DEPTH_GAIN` on BOTH rows
    // would pass whatever the number was. Neither row is the lfo here.
    const mk = (glyphDepthGain?: number) => ({
      face: { order: ['shape'], glyph: 'waveform' as const, glyphDepthGain },
      outputs: [{ id: 'cv_out', type: 'cv' }],
      params: [
        { id: 'shape', min: 0, max: 2 },
        { id: 'depth', min: 0, max: 1 },
      ],
    });
    expect((glyphBinding(mk(1)) as { depthGain: number }).depthGain).toBe(1);
    // Undeclared ⇒ 1 ("depth IS the amplitude"), the only law a generic
    // resolver can assume — NOT some other module's worklet constant.
    expect((glyphBinding(mk()) as { depthGain: number }).depthGain).toBe(1);
    expect((glyphBinding(mk()) as { depthGain: number }).depthGain).not.toBe(LFO_DEPTH_GAIN);
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

describe('the shape LANDMARKS are the one roster, and the def reads them', () => {
  // ⚠ A CARD-SOURCE GUARD STOOD HERE AND IT WAS FOUR LEGS LONG. Its subject was
  // `LfoCard.svelte`, and the rule was the CLAUDE.md backdraft one at the only
  // altitude that could see it: every runtime gate reads the DEF, so a CARD
  // passing its own literals to a control is invisible to all of them —
  // BackdraftCard shipped ±1 XyPads into a ±0.2 contract with every def-reading
  // assertion green. LfoCard used to hand-type all three ranges AND its own
  // three-entry shape-glyph roster.
  //
  // Three of the four legs are unspellable once the fleet goes:
  //
  //   * "passes NO hand-typed range / mapping literal" — the shell resolves a
  //     cell's range and curve from the `ParamDef` itself, so there is no second
  //     source of truth to catch. NAMED COVERAGE LOSS, the same disposition
  //     `card-range-source` and `card-control-ranges` get.
  //   * "no silent `GLYPH_FOR[…] ?? 'sine'` fallback" — the wrong-picture-by-
  //     default class. The lookup lived in the card; the surviving renderer is
  //     the shell's fader track, which takes its landmarks from the def.
  //   * "no longer carries its own SHAPE_GLYPHS roster" — same subject.
  //
  // What survives is the half that made all three checkable in the first place:
  // the roster is DEF-DECLARED and gate-visible, and every landmark it declares
  // is a real, reachable position. Asserted here so that moving the anchors
  // back into a surface would have to delete this, rather than quietly pass.

  it('every shape landmark is a reachable value of the shape param', () => {
    const shape = lfoDef.params.find((p) => p.id === 'shape')!;
    expect(LFO_SHAPE_LANDMARKS.length, 'the roster is non-empty').toBeGreaterThan(0);
    for (const l of LFO_SHAPE_LANDMARKS) {
      expect(l.value, `${l.label} >= min`).toBeGreaterThanOrEqual(shape.min);
      expect(l.value, `${l.label} <= max`).toBeLessThanOrEqual(shape.max);
      expect(l.label.length, 'a landmark must be named').toBeGreaterThan(0);
    }
    // …and the names are distinct, so a renamed anchor cannot collide with an
    // existing one and silently take its glyph.
    const labels = LFO_SHAPE_LANDMARKS.map((l) => l.label);
    expect(new Set(labels).size, 'no two landmarks share a name').toBe(labels.length);
  });

  it('the def imports the depth law rather than restating it', () => {
    const defSrc = readFileSync(fileURLToPath(new URL('./lfo.ts', import.meta.url)), 'utf8');
    expect(defSrc).toContain("from './lfo-face-model'");
    expect(defSrc).toContain('LFO_DEPTH_UNITY');
  });
});
