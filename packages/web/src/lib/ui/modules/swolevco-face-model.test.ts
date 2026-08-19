// packages/web/src/lib/ui/modules/swolevco-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for swolevco's three derived readouts.
//
// A derived readout earns its place only if it is checked against the input a
// KNOB READBACK WOULD BE BLIND TO — permanently, not once at authoring time
// (CLAUDE.md, "a wrong metric reads exactly like a finding"). swolevco's whole
// face rests on one measured fact, so that fact is what these tests hold:
//
//   AT THE SHIPPED DEFAULT `ratio = 1`, `mod_tune` AND `mod_fine` ARE
//   BIT-EXACTLY INERT. Measured against the real `swolevcoDef.factory` under
//   node-web-audio-api's OfflineAudioContext (48 kHz, 0.5 s): sweeping either
//   across its full declared range (±36 st, ±100 ¢) gives
//   `max|x − x_ref| = 0.000e+0` on ALL THREE audio outputs.
//
// So `mod` MUST be invariant to `mod_tune` while ratio > 0 and MUST move with
// it at ratio = 0; `lock` must never move with it at all; and `fold` — which
// moves the module's measured spectral centroid by 5.12× — must move NONE of
// the three. Each of those is a leg below, in BOTH directions, because a probe
// that cannot move is indistinguishable from one that reads the wrong thing.

import { describe, expect, it } from 'vitest';
import {
  swolevcoFaceParams,
  swolevcoLockText,
  swolevcoModHz,
  swolevcoModHzText,
  swolevcoShapeText,
} from './swolevco-face-model';
import { swolevcoDef } from '$lib/audio/modules/swolevco';
import { faceReadoutValueFor } from '$lib/ui/workflow/face-readout-values';

/** A reader over an explicit patch. Anything unset falls through to the def's
 *  own default, exactly like a fresh `node.params` overlay. */
function reader(patch: Record<string, number> = {}) {
  return (id: string): number | undefined => patch[id];
}
const P = (patch: Record<string, number> = {}) => swolevcoFaceParams(reader(patch));

describe('swolevco face model — defaults track the def', () => {
  it('every default the model assumes IS the def default (anchored, not copied)', () => {
    const p = P();
    for (const id of ['tune', 'fine', 'mod_tune', 'mod_fine', 'ratio', 'symmetry'] as const) {
      const declared = swolevcoDef.params.find((q) => q.id === id);
      expect(declared, `${id} must be a declared param of swolevcoDef`).toBeDefined();
      expect(p[id], `${id} default`).toBe(declared!.defaultValue);
    }
  });

  it('at the defaults the modulator is at C4, ratio-locked 1:1', () => {
    // The factory's own measured value: 261.62601 Hz by zero-crossing over a
    // 4 s render at ratio = 1.
    expect(swolevcoModHz(P())).toBeCloseTo(261.626, 3);
    expect(swolevcoModHzText(P())).toBe('261.6 Hz');
    expect(swolevcoLockText(P())).toBe('x1.00');
    expect(swolevcoShapeText(P())).toBe('triangle');
  });
});

describe('swolevco `mod` — NEGATIVE CONTROL on mod_tune, the mode-gated dial', () => {
  // THE POINT OF THE WHOLE FACE. A `paramId: 'mod_tune'` readout would print a
  // moving number in the state the rack spawns in, where the control reaches
  // nothing at all.
  it('is INVARIANT to mod_tune and mod_fine while ratio > 0 (matches Δ = 0.000e+0)', () => {
    const base = swolevcoModHz(P());
    for (const mod_tune of [-36, -18, 0, 18, 36]) {
      expect(swolevcoModHz(P({ mod_tune })), `mod_tune=${mod_tune}`).toBe(base);
    }
    for (const mod_fine of [-100, -50, 0, 50, 100]) {
      expect(swolevcoModHz(P({ mod_fine })), `mod_fine=${mod_fine}`).toBe(base);
    }
  });

  it('POSITIVE CONTROL — it DOES move with mod_tune at ratio = 0', () => {
    // The probe must not merely be silent; it must be able to speak. Measured
    // on the real factory: mod_out ran 33 Hz → 2093 Hz across this sweep.
    const seen = [-36, -18, 0, 18, 36].map((mod_tune) =>
      swolevcoModHz(P({ ratio: 0, mod_tune })),
    );
    expect(new Set(seen).size, 'every mod_tune must give a distinct frequency').toBe(5);
    expect(seen[0]).toBeCloseTo(32.703, 2);
    expect(seen[2]).toBeCloseTo(261.626, 2);
    expect(seen[4]).toBeCloseTo(2093.005, 2);
    // strictly increasing — the readout tracks the dial's direction
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
  });

  it('tracks the PRIMARY pitch while locked — the half a mod_tune readback also misses', () => {
    // At ratio = 1 the modulator follows tune/fine, which no modulator dial
    // shows. Verified against the factory at tune −12 / 0 / +12.
    expect(swolevcoModHz(P({ tune: -12 }))).toBeCloseTo(130.813, 3);
    expect(swolevcoModHz(P({ tune: 12 }))).toBeCloseTo(523.252, 3);
    // FINE alone moves it too, and a `tune` readback would not budge.
    expect(swolevcoModHz(P({ fine: 100 }))).toBeCloseTo(277.183, 3);
  });

  it('is exact against the factory at the ratios the LUT band does not blur', () => {
    // Measured by interpolated zero-crossing over a 4 s render:
    //   ratio 0.005 → 1.3082 Hz   (predicted 1.3081)
    //   ratio 0.01  → 2.6163      ratio 0.05 → 13.0814
    expect(swolevcoModHz(P({ ratio: 0.005 }))).toBeCloseTo(1.3081, 4);
    expect(swolevcoModHz(P({ ratio: 0.01 }))).toBeCloseTo(2.6163, 4);
    expect(swolevcoModHz(P({ ratio: 0.05 }))).toBeCloseTo(13.0813, 3);
    expect(swolevcoModHz(P({ ratio: 2 }))).toBeCloseTo(523.252, 3);
  });
});

describe('swolevco `lock` — the mode word, and its own negative control', () => {
  it('NEVER moves with mod_tune or mod_fine, in EITHER mode', () => {
    // `lock` is a function of ratio alone. Publishing it beside `mod` is the
    // pair's own instrument check: at ratio = 0, mod_tune moves `mod` and must
    // leave `lock` alone — one readout moving where the other cannot is what
    // makes both legible.
    for (const ratio of [0, 0.5, 1, 8]) {
      const base = swolevcoLockText(P({ ratio }));
      for (const mod_tune of [-36, 0, 36]) {
        for (const mod_fine of [-100, 0, 100]) {
          expect(swolevcoLockText(P({ ratio, mod_tune, mod_fine }))).toBe(base);
        }
      }
    }
  });

  it('changes CLASS exactly at ratio = 0, matching the factory branch', () => {
    // The factory gates on `ratio > 0` (strict). The readout must break at the
    // same place, or it would smooth over the mode switch.
    expect(swolevcoLockText(P({ ratio: 0 }))).toBe('free-run');
    expect(swolevcoLockText(P({ ratio: -1 }))).toBe('free-run');
    expect(swolevcoLockText(P({ ratio: 1 }))).not.toBe('free-run');
    expect(swolevcoLockText(P({ ratio: 1 }))).toBe('x1.00');
    expect(swolevcoLockText(P({ ratio: 2 }))).toBe('x2.00');
  });

  it('names the SUB-AUDIO band, where a locked modulator is no longer a pitch', () => {
    // At ratio 0.05 the modulator is 13.08 Hz — measured, full scale, and
    // inaudible as pitch. This is the honest replacement for a claim this
    // module was once thought to have (a DC rail at low ratio): measured over
    // a window LONGER than the period it is a 1.3082 Hz sine at peak 1.0000,
    // not DC.
    expect(swolevcoLockText(P({ ratio: 0.05 }))).toBe('x0.05 sub-audio');
    expect(swolevcoLockText(P({ ratio: 0.5 }))).toBe('x0.50');
    // …and it follows the PRIMARY pitch, not just the ratio dial: the same
    // ratio three octaves up is back above hearing.
    expect(swolevcoLockText(P({ ratio: 0.05, tune: 36 }))).toBe('x0.05');
  });
});

describe('swolevco `shape` — NEGATIVE CONTROL on fold, the 5.12x brightness dial', () => {
  it('is INVARIANT to fold, which moves the measured centroid 637 -> 3264 Hz', () => {
    // The folder sits AFTER the crossfade, so a readout that tracked
    // "brightness" would move with both controls and disambiguate neither.
    for (const symmetry of [0, 0.25, 0.5, 0.75, 1]) {
      const base = swolevcoShapeText(P({ symmetry }));
      for (const fold of [0, 0.25, 0.5, 0.75, 1]) {
        expect(swolevcoShapeText(P({ symmetry, fold })), `sym=${symmetry} fold=${fold}`).toBe(base);
      }
    }
  });

  it('is INVARIANT to tune, timbre and ratio', () => {
    const base = swolevcoShapeText(P());
    expect(swolevcoShapeText(P({ tune: 36 }))).toBe(base);
    expect(swolevcoShapeText(P({ timbre: 1 }))).toBe(base);
    expect(swolevcoShapeText(P({ ratio: 0 }))).toBe(base);
  });

  it('POSITIVE CONTROL — it names the endpoints and the midpoint distinctly', () => {
    expect(swolevcoShapeText(P({ symmetry: 0 }))).toBe('saw');
    expect(swolevcoShapeText(P({ symmetry: 0.5 }))).toBe('triangle');
    expect(swolevcoShapeText(P({ symmetry: 1 }))).toBe('square');
  });

  it('names the BLEND in signal order with weights — the detent a fader does not give', () => {
    // Measured centroid says TRIANGLE IS A POINT: 637 Hz at exactly 0.5, but
    // 1986 Hz at 0.4 and 1925 Hz at 0.6. The caption has to distinguish those
    // three positions or it is not doing the job the measurement asked for.
    expect(swolevcoShapeText(P({ symmetry: 0.4 }))).toBe('saw+tri 20/80');
    expect(swolevcoShapeText(P({ symmetry: 0.6 }))).toBe('tri+sqr 80/20');
    expect(swolevcoShapeText(P({ symmetry: 0.25 }))).toBe('saw+tri 50/50');
    expect(swolevcoShapeText(P({ symmetry: 0.75 }))).toBe('tri+sqr 50/50');
    // the three positions the centroid measurement separates are three strings
    expect(
      new Set([0.4, 0.5, 0.6].map((symmetry) => swolevcoShapeText(P({ symmetry })))).size,
    ).toBe(3);
  });

  it('the pair name never swaps ends as the fader crosses a midpoint', () => {
    // Dominance order would print `tri+saw` below 0.25 and `saw+tri` above it.
    for (const symmetry of [0.05, 0.2, 0.25, 0.3, 0.45]) {
      expect(swolevcoShapeText(P({ symmetry })), `sym=${symmetry}`).toMatch(/^saw\+tri /);
    }
    for (const symmetry of [0.55, 0.7, 0.75, 0.8, 0.95]) {
      expect(swolevcoShapeText(P({ symmetry })), `sym=${symmetry}`).toMatch(/^tri\+sqr /);
    }
  });
});

describe('swolevco readouts — TOTALITY (they run on every render)', () => {
  // `face-readout-values.ts` calls these on every frame while a value moves, so
  // a throw takes the faceplate down mid-drag.
  const HOSTILE: Record<string, number>[] = [
    {},
    { ratio: NaN, symmetry: NaN, tune: NaN, fine: NaN, mod_tune: NaN, mod_fine: NaN },
    { ratio: Infinity, symmetry: Infinity, tune: Infinity },
    { ratio: -Infinity, symmetry: -Infinity, tune: -Infinity },
    { ratio: 0, symmetry: -5, tune: 1e6, fine: 1e6 },
    { ratio: 1e12, symmetry: 5, mod_tune: 1e9 },
  ];

  it('never throws and always returns a non-empty string', () => {
    for (const patch of HOSTILE) {
      for (const fn of [swolevcoModHzText, swolevcoLockText, swolevcoShapeText]) {
        const out = fn(P(patch));
        expect(typeof out, JSON.stringify(patch)).toBe('string');
        expect(out.length, JSON.stringify(patch)).toBeGreaterThan(0);
      }
    }
  });

  it('a non-finite param falls back to the def default rather than printing NaN', () => {
    for (const patch of HOSTILE) {
      for (const fn of [swolevcoModHzText, swolevcoLockText, swolevcoShapeText]) {
        expect(fn(P(patch)), JSON.stringify(patch)).not.toMatch(/NaN|Infinity|undefined/);
      }
    }
  });
});

describe('swolevco readouts — REGISTERED, and reached through the shell seam', () => {
  // ANCHORED TO THE ARTIFACT: the face declares these three ids, so a rename on
  // either side is RED rather than a silently blank readout.
  const DECLARED = ['swolevco-mod-hz', 'swolevco-mod-lock', 'swolevco-shape'] as const;

  it('the ids the face declares are exactly the ids registered for it', () => {
    const onFace = (swolevcoDef.face?.hero?.readouts ?? [])
      .map((r) => r.valueId)
      .filter((v): v is string => typeof v === 'string')
      .sort();
    expect(onFace).toEqual([...DECLARED].sort());
  });

  it('each resolves through face-readout-values and returns the model\'s own answer', () => {
    for (const id of DECLARED) {
      const fn = faceReadoutValueFor(id);
      expect(fn, `${id} must be registered`).toBeTruthy();
    }
    expect(faceReadoutValueFor('swolevco-mod-hz')!(reader())).toBe(swolevcoModHzText(P()));
    expect(faceReadoutValueFor('swolevco-mod-lock')!(reader())).toBe(swolevcoLockText(P()));
    expect(faceReadoutValueFor('swolevco-shape')!(reader())).toBe(swolevcoShapeText(P()));
  });

  it('the seam is LIVE — a param change reaches the registered function', () => {
    // Negative control on the REGISTRY, not just the model: if the registry
    // entry were wired to a constant, the two legs above would still pass.
    const at = (patch: Record<string, number>, id: (typeof DECLARED)[number]) =>
      faceReadoutValueFor(id)!(reader(patch));
    expect(at({ ratio: 0 }, 'swolevco-mod-lock')).toBe('free-run');
    expect(at({ ratio: 2 }, 'swolevco-mod-lock')).toBe('x2.00');
    expect(at({ symmetry: 0 }, 'swolevco-shape')).toBe('saw');
    expect(at({ ratio: 0, mod_tune: 36 }, 'swolevco-mod-hz')).toBe('2.09 kHz');
  });
});
