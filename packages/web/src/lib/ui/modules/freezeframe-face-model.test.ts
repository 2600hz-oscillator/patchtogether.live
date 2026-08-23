// packages/web/src/lib/ui/modules/freezeframe-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for freezeframe's two derived readouts.
//
// freezeframe has TWO ENGINES that share one faceplate — a colour-depth
// posterizer and a phosphor decay — and each readout belongs to exactly one of
// them. So the controls write themselves and they run BOTH ways: `depth` must
// be blind to every decay param, `decay` must be blind to every quant param,
// and each must move for its own. A readout that drifted onto the other
// engine's params would look plausible and be wrong on every patch that uses
// only one of them.
//
// The load-bearing leg is `depth` vs `quant_luma`. That knob reaches the
// combined output through a DIFFERENT path from R/G/B (a hue-preserving luma
// ratio, not a per-channel posterize), so a readout assembled from R/G/B alone
// would be structurally blind to the widest-reaching control on the module —
// blind in exactly the place #1861's defect lived.

import { describe, expect, it } from 'vitest';
import {
  freezeframeDecayText,
  freezeframeDepthLevels,
  freezeframeDepthText,
  freezeframeFaceParams,
  freezeframeIsPassthrough,
} from './freezeframe-face-model';
import { QUANT_MAX_LEVELS, freezeframeDef, quantLevels } from '$lib/video/modules/freezeframe';
import { hasVideoSurface } from '$lib/ui/workflow/module-shell-model';

function reader(patch: Record<string, number> = {}) {
  return (id: string): number | undefined => patch[id];
}
const P = (patch: Record<string, number> = {}) => freezeframeFaceParams(reader(patch));

const QUANTS = ['quant_r', 'quant_g', 'quant_b', 'quant_luma'] as const;
const DECAYS = ['decay', 'decay_time', 'decay_invert'] as const;

describe('freezeframe face model — anchored to the def', () => {
  it('every default the model assumes IS the def default', () => {
    const p = P();
    for (const id of [...QUANTS, ...DECAYS] as const) {
      const declared = freezeframeDef.params.find((q) => q.id === id);
      expect(declared, `${id} must be a declared param`).toBeDefined();
      expect(p[id], `${id} default`).toBe(declared!.defaultValue);
    }
  });

  it('at the defaults the module is a PASSTHROUGH and both readouts say so', () => {
    expect(freezeframeIsPassthrough(P())).toBe(true);
    expect(freezeframeDepthLevels(P())).toBe(QUANT_MAX_LEVELS);
    expect(freezeframeDepthText(P())).toBe('off');
    expect(freezeframeDecayText(P())).toBe('off');
  });
});

describe('freezeframe `depth` — NEGATIVE CONTROL on the decay engine', () => {
  it('is INVARIANT to every decay param', () => {
    const base = freezeframeDepthText(P({ quant_g: 0.5 }));
    for (const decay of [0, 1]) {
      for (const decay_time of [0.05, 0.5, 2]) {
        for (const decay_invert of [0, 1]) {
          expect(
            freezeframeDepthText(P({ quant_g: 0.5, decay, decay_time, decay_invert })),
            `decay=${decay} time=${decay_time} invert=${decay_invert}`,
          ).toBe(base);
        }
      }
    }
  });

  it('POSITIVE CONTROL — it moves for EACH of the four quant knobs, ALONE', () => {
    // The one that matters: `quant_luma` on its own must move the number. An
    // R/G/B-only derivation would pass every other leg in this file.
    for (const id of QUANTS) {
      const moved = freezeframeDepthText(P({ [id]: 0.5 }));
      expect(moved, `${id} alone must move the depth readout`).not.toBe('off');
      expect(moved, `${id} alone`).toBe('32 lv');
    }
  });

  it('reports the COARSEST channel, which is what the banding follows', () => {
    // Two knobs at different depths: the readout follows the coarser one.
    expect(freezeframeDepthText(P({ quant_r: 0.5, quant_b: 1 }))).toBe('2 lv');
    expect(freezeframeDepthText(P({ quant_luma: 1, quant_r: 0.5 }))).toBe('2 lv');
    // …and the coarsest may be the luma knob, which R/G/B cannot see.
    expect(freezeframeDepthLevels(P({ quant_luma: 1 }))).toBe(quantLevels(1));
  });

  it('prints a NAME at the defaults, because the dials read 0.00 and mean FULL', () => {
    // The owner ruling's own test: a name is allowed where it disambiguates a
    // state a number gets backwards. Every QUANT dial resting at 0.00 means
    // 256 levels — the opposite of what "zero" suggests.
    expect(freezeframeDepthText(P())).toBe('off');
    expect(freezeframeDepthText(P({ quant_r: 1 }))).toBe('2 lv');
  });
});

describe('freezeframe `decay` — NEGATIVE CONTROL on the quant engine', () => {
  it('is INVARIANT to every quant param', () => {
    const base = freezeframeDecayText(P({ decay: 1 }));
    for (const id of QUANTS) {
      for (const v of [0, 0.5, 1]) {
        expect(freezeframeDecayText(P({ decay: 1, [id]: v })), `${id}=${v}`).toBe(base);
      }
    }
  });

  it('THE TRAP — `decay_time` alone must NOT make it look live', () => {
    // A `paramId: 'decay_time'` readout prints `0.50 s` with the switch OFF.
    // This is the whole reason the value is derived.
    for (const decay_time of [0.05, 0.25, 1, 2]) {
      expect(freezeframeDecayText(P({ decay_time })), `time=${decay_time}, switch off`).toBe('off');
    }
  });

  it('POSITIVE CONTROL — with the switch ON it tracks time AND target', () => {
    expect(freezeframeDecayText(P({ decay: 1 }))).toBe('0.50 s black');
    expect(freezeframeDecayText(P({ decay: 1, decay_invert: 1 }))).toBe('0.50 s white');
    expect(freezeframeDecayText(P({ decay: 1, decay_time: 2 }))).toBe('2.0 s black');
    expect(freezeframeDecayText(P({ decay: 1, decay_time: 0.05 }))).toBe('0.05 s black');
    // all three of its params are live, and each alone changes the string
    const seen = new Set([
      freezeframeDecayText(P({ decay: 1 })),
      freezeframeDecayText(P({ decay: 1, decay_time: 2 })),
      freezeframeDecayText(P({ decay: 1, decay_invert: 1 })),
    ]);
    expect(seen.size).toBe(3);
  });

  it('uses the repo switch reading — high at the midpoint, not at 1', () => {
    expect(freezeframeDecayText(P({ decay: 0.49 }))).toBe('off');
    expect(freezeframeDecayText(P({ decay: 0.5 }))).not.toBe('off');
  });
});

describe('freezeframe readouts — TOTALITY (they run on every render)', () => {
  const HOSTILE: Record<string, number>[] = [
    {},
    { quant_r: NaN, quant_g: NaN, quant_b: NaN, quant_luma: NaN, decay: NaN, decay_time: NaN },
    { quant_luma: Infinity, decay: Infinity, decay_time: Infinity },
    { quant_luma: -Infinity, decay: -Infinity, decay_time: -Infinity },
    { quant_r: -5, quant_g: 5, decay: 1, decay_time: -1 },
    { quant_b: 1e9, decay: 1, decay_time: 1e9, decay_invert: 1 },
  ];

  it('never throw, always return a non-empty string, never print NaN', () => {
    for (const patch of HOSTILE) {
      for (const fn of [freezeframeDepthText, freezeframeDecayText]) {
        const out = fn(P(patch));
        expect(typeof out, JSON.stringify(patch)).toBe('string');
        expect(out.length, JSON.stringify(patch)).toBeGreaterThan(0);
        expect(out, JSON.stringify(patch)).not.toMatch(/NaN|Infinity|undefined/);
      }
    }
  });

  it('the decay time is CLAMPED to the def\'s declared range', () => {
    // A saved patch from an older build, or a hand-edited file, must not print
    // a duration the module cannot produce.
    const t = freezeframeDef.params.find((q) => q.id === 'decay_time')!;
    expect(freezeframeDecayText(P({ decay: 1, decay_time: 1e9 }))).toBe(`${t.max!.toFixed(1)} s black`);
    expect(freezeframeDecayText(P({ decay: 1, decay_time: -1 }))).toBe(`${t.min!.toFixed(2)} s black`);
  });
});

describe('freezeframe face — the VIDEO declarations, asserted not assumed', () => {
  it('glyph is `none` AND the tile still gets a picture from the video seam', () => {
    // ⚠ `'none' + blank tile` and `'none' + live thumb` are indistinguishable
    // from the declaration alone (module-faceplates.md): the picture arrives
    // through `hasVideoSurface`'s OR, not through `face.glyph`. So assert the
    // seam, not the word.
    expect(freezeframeDef.face?.glyph).toBe('none');
    expect(hasVideoSurface(freezeframeDef), 'the shell must mount a video surface').toBe(true);
  });

  it('`gateLevel` is DECLARED as having no user control, and is not ranked', () => {
    const entry = freezeframeDef.noUserControl?.find((n) => n.param === 'gateLevel');
    expect(entry, 'gateLevel must carry a noUserControl declaration').toBeDefined();
    expect(entry!.writer).toBe('cv-port');
    // anchored in both directions: a port really does target it
    const port = freezeframeDef.inputs.find((i) => i.paramTarget === 'gateLevel');
    expect(port, "the 'cv-port' claim must name a real port").toBeDefined();
    expect(freezeframeDef.face?.order).not.toContain('gateLevel');
  });

  it('every OTHER param is ranked exactly once', () => {
    const order = freezeframeDef.face?.order ?? [];
    const declared = freezeframeDef.params
      .map((p) => p.id)
      .filter((id) => !freezeframeDef.noUserControl?.some((n) => n.param === id));
    expect([...order].sort()).toEqual([...declared].sort());
    expect(new Set(order).size, 'no key ranked twice').toBe(order.length);
  });
});
