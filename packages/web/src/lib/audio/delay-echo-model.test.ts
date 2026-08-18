// packages/web/src/lib/audio/delay-echo-model.test.ts
//
// The delay's echo arithmetic, its three knob readouts, and the curated face
// that consumes them — pinned together on purpose: a formatter nothing imports
// proves nothing, and a rank nothing pins is one careless "tidy-up" away from
// silently reverting.
//
// FOUR KINDS OF ASSERTION, and they are deliberately different:
//
//  (a) `echoRepeats` is checked against a REAL RECIRCULATION SIMULATION, not
//      against a table of expected counts. The closed form and a table of the
//      closed form's outputs are the same claim written twice, and they pass
//      together when both are wrong. Multiplying `g` by itself until the tail
//      crosses the floor is an independent computation of the same quantity.
//
//  (b) the two numbers `delay.ts`'s own PROSE asserts are pinned to the
//      formatter's output — so the docs and the dial cannot drift apart, which
//      is exactly how the "about 8 audible repeats" sentence survived years
//      with nothing able to check it.
//
//  (c) every readout is bounded in CSS PIXELS over its param's WHOLE declared
//      range, with the range read off the DEF rather than re-typed here (a
//      widened `max` must redden this test, not silently escape the sweep).
//
//  (d) the tier ladder is DERIVED from `curatedFace` / `laneBodyPlan` rather
//      than restated — the face comment used to claim "all three survive to the
//      compact tile", which is false (the compact cap with a glyph is two), and
//      nothing could catch it because no test read the ladder.

import { describe, expect, it } from 'vitest';
import { curatedFace } from '$lib/ui/workflow/curated-face';
import {
  LANE_KCOL_MAX_PX,
  READOUT_MAX_CHARS,
  readoutFitsLane,
  readoutWidthPx,
} from '$lib/ui/workflow/lane-readout-fit';
import { laneBodyPlan } from '$lib/ui/workflow/module-shell-model';
import { delayDef } from './modules/delay';
import {
  ECHO_FLOOR_DB,
  echoRepeats,
  equalPowerBlend,
  formatDelayFeedback,
  formatDelayMix,
  formatDelayTime,
} from './delay-echo-model';

/** A declared param, by id — the ranges under test come from the CONTRACT. */
function param(id: string) {
  const p = delayDef.params.find((q) => q.id === id);
  if (!p) throw new Error(`delay has no param '${id}'`);
  return p;
}

const TIME = param('time');
const FEEDBACK = param('feedback');
const MIX = param('mix');

describe('echoRepeats — the count the feedback ratio actually buys', () => {
  /**
   * THE INDEPENDENT ORACLE: multiply `g` by itself and COUNT, rather than
   * restate the closed form. Parameterised by the floor so the real assertion
   * and its negative control run the SAME code path — a negative control that
   * exercises a different helper proves nothing about the helper in use.
   *
   * Returns every (ratio, closed, simulated) triple where the two disagree,
   * over every thousandth of the declared range.
   */
  const sweepDisagreements = (floorDb: number): string[] => {
    const floorLin = 10 ** (floorDb / 20);
    const simulate = (g: number): number => {
      let amp = 1;
      let n = 0;
      // Strictly BELOW the floor, and bounded: at the 0.95 ceiling this
      // terminates at 135.
      while (amp >= floorLin && n < 100_000) {
        amp *= g;
        n++;
      }
      return Math.max(1, n);
    };
    const out: string[] = [];
    for (let i = 1; i <= 950; i++) {
      const g = i / 1000; // 0.001 … 0.950
      const closed = echoRepeats(g);
      const sim = simulate(g);
      if (closed !== sim) out.push(`feedback=${g}: closed=${closed} simulated=${sim}`);
    }
    return out;
  };

  it('agrees with a real recirculation simulation, across the whole range', () => {
    // If the log arithmetic is wrong in any way — a sign, 20 vs 10, ceil vs
    // floor+1 — the two computations part company. This is what caught the
    // `ceil` under-count at the two exact-tie ratios (0.1 and 0.001); a
    // spot-check at the defaults agreed with the wrong version.
    const bad = sweepDisagreements(ECHO_FLOOR_DB);
    expect(
      bad.slice(0, 10).join('\n'),
      `${bad.length} of 950 ratios disagree — the closed form and counting the ` +
        `recirculations are computing different quantities; one of them is wrong`,
    ).toBe('');
  });

  it('NEGATIVE CONTROL: the sweep CAN fail (it is not comparing a thing to itself)', () => {
    // Without this, the sweep above is indistinguishable from `expect(x).toBe(x)`.
    // Perturb the quantity it claims to measure — move the floor by one dB —
    // and the SAME comparison must light up. A metric blind to the dimension
    // under test returns a clean number regardless of the code (CLAUDE.md).
    const perturbed = sweepDisagreements(ECHO_FLOOR_DB - 1);
    expect(
      perturbed.length,
      'a 1 dB floor shift changed no repeat count anywhere in the range — the ' +
        'comparison is not reading the floor at all',
    ).toBeGreaterThan(0);
  });

  it('floors at ONE echo, because the line emits before it recirculates', () => {
    // feedback = 0 has zero RECIRCULATIONS but still produces one echo (the
    // delayed signal reaches the wet leg before it reaches the feedback gain).
    // The ART profile asserts exactly this shape — three decaying echoes at the
    // 0.4 default — so the floor is a fact about the graph, not a guard.
    expect(echoRepeats(0)).toBe(1);
    expect(echoRepeats(FEEDBACK.min)).toBe(1);
  });

  it('THE TIE: a ratio landing exactly ON the floor needs one MORE repeat', () => {
    // The two points in the declared range where `g^n` is exactly 10^(-60/20),
    // and the reason the closed form is `floor(x) + 1` rather than `ceil(x)`.
    // 0.001^1 and 0.1^3 both equal the floor, which is not yet BELOW it.
    expect(echoRepeats(0.001)).toBe(2);
    expect(echoRepeats(0.1)).toBe(4);
    // …and one thousandth either side is untouched, so this is a boundary
    // definition rather than an off-by-one smeared across the range.
    expect(echoRepeats(0.101)).toBe(4);
    expect(echoRepeats(0.099)).toBe(3);
  });

  it('is total for values a live dial can hand it', () => {
    // `format` is called every animation frame on a LIVE value, so it must never
    // throw and never emit `NaN`/`Infinity` text.
    for (const v of [NaN, Infinity, -Infinity, -1, 2]) {
      expect(() => formatDelayFeedback(v), `feedback=${v}`).not.toThrow();
      expect(formatDelayFeedback(v), `feedback=${v}`).not.toMatch(/NaN|undefined/);
    }
  });
});

describe('equalPowerBlend — the law the FACTORY applies', () => {
  it('is the √ crossfade the factory sets on dry/wet, and holds power constant', () => {
    // The oracle for the readout's named ends: `DRY` must be the setting where
    // the wet leg is actually silent, not merely where the number is 0.
    expect(equalPowerBlend(0)).toEqual({ dry: 1, wet: 0 });
    expect(equalPowerBlend(1)).toEqual({ dry: 0, wet: 1 });
    for (let i = 0; i <= 100; i++) {
      const { dry, wet } = equalPowerBlend(i / 100);
      expect(dry * dry + wet * wet, `mix=${i / 100}: power is not unity`).toBeCloseTo(1, 12);
    }
  });

  it('the readout NAMES exactly the two settings the law makes special', () => {
    expect(formatDelayMix(0)).toBe('DRY');
    expect(equalPowerBlend(0).wet).toBe(0); // …and DRY really is wet-silent
    expect(formatDelayMix(1)).toBe('WET');
    expect(equalPowerBlend(1).dry).toBe(0); // …and WET really is dry-silent
  });
});

describe('the three readouts, at every value the dial can reach', () => {
  it('time switches unit at one second, on the ROUNDED milliseconds', () => {
    expect(formatDelayTime(TIME.min)).toBe('1 MS');
    expect(formatDelayTime(TIME.defaultValue)).toBe('250 MS');
    expect(formatDelayTime(0.999)).toBe('999 MS');
    // 0.9996 s rounds to 1000 ms — a raw `< 1` comparison would print `1000 MS`
    // (7 glyphs and the wrong unit); the switch is decided after rounding.
    expect(formatDelayTime(0.9996)).toBe('1.00 S');
    expect(formatDelayTime(1.2)).toBe('1.20 S');
    expect(formatDelayTime(TIME.max)).toBe('2.00 S');
  });

  it('feedback prints the repeat count, not the ratio', () => {
    expect(formatDelayFeedback(FEEDBACK.min)).toBe('1 REP');
    expect(formatDelayFeedback(FEEDBACK.defaultValue)).toBe('8 REP');
    expect(formatDelayFeedback(FEEDBACK.max)).toBe('135 REP');
  });

  it('mix names the ends and prints the wet share between them', () => {
    expect(formatDelayMix(MIX.min)).toBe('DRY');
    expect(formatDelayMix(MIX.defaultValue)).toBe('35% WET');
    expect(formatDelayMix(0.5)).toBe('50% WET');
    // 0.996 must not print `100% WET` — both 8 glyphs and a lie about the
    // remaining dry. The ends are decided on the rounded percentage.
    expect(formatDelayMix(0.996)).toBe('WET');
    expect(formatDelayMix(0.004)).toBe('DRY');
    expect(formatDelayMix(MIX.max)).toBe('WET');
  });
});

describe('the DOCS and the DIAL cannot drift apart', () => {
  // The "about 8 audible repeats" / "roughly 135 repeats" sentences lived in
  // `delay.ts`'s prose for the module's whole life with nothing able to check
  // them — which is the failure this model exists to end. Pin the prose to the
  // formatter, both directions: a re-worded doc or a re-tuned format reddens.
  const controls = delayDef.docs?.controls ?? {};

  it.each([
    ['time', formatDelayTime(TIME.defaultValue)],
    ['feedback', formatDelayFeedback(FEEDBACK.defaultValue)],
    ['mix', formatDelayMix(MIX.defaultValue)],
  ])('docs.controls.%s quotes the readout the dial actually paints (%s)', (id, readout) => {
    expect(
      controls[id] ?? '',
      `delay's docs for '${id}' must quote ${JSON.stringify(readout)} — the string the ` +
        `curated face prints at the default. If the format changed, re-author the prose.`,
    ).toContain(readout);
  });

  it('the feedback doc quotes BOTH ends of the count, including the ceiling', () => {
    expect(controls.feedback ?? '').toContain(formatDelayFeedback(FEEDBACK.min));
    expect(controls.feedback ?? '').toContain(formatDelayFeedback(FEEDBACK.max));
  });
});

describe('every readout FITS the 46 CSS-px lane column — in PIXELS, not glyphs', () => {
  // The unit is the whole assertion (the vca lesson): a budget stated in glyphs
  // and checked in pixels is a different assertion, and at 5.97 px/glyph the
  // difference is exactly the 8th character — the one that escapes the column.
  // `.knob-wrap` is uncapped, so the CSS ellipsis never engages and the text
  // SPILLS into the next cell (measured; lane-readout-fit.ts).
  const widest = (fmt: (v: number) => string, min: number, max: number): string => {
    let worst = '';
    for (let i = 0; i <= 20000; i++) {
      const s = fmt(min + ((max - min) * i) / 20000);
      if (s.length > worst.length) worst = s;
    }
    return worst;
  };

  it.each([
    ['time', formatDelayTime, TIME],
    ['feedback', formatDelayFeedback, FEEDBACK],
    ['mix', formatDelayMix, MIX],
  ] as const)('%s never escapes the column', (id, fmt, range) => {
    const worst = widest(fmt, range.min, range.max);
    expect(
      readoutWidthPx(worst),
      `${id}: widest readout ${JSON.stringify(worst)} is ${worst.length} glyphs = ` +
        `${readoutWidthPx(worst).toFixed(2)} CSS px, and the lane knob column caps at ` +
        `${LANE_KCOL_MAX_PX} CSS px (--kcol-max). This string ESCAPES that column in the ` +
        `lane — it does NOT ellipsize (lane-readout-fit.ts) — so shorten the format.`,
    ).toBeLessThanOrEqual(LANE_KCOL_MAX_PX);
  });

  it('NEGATIVE CONTROL: the px budget refuses the strings this format was shortened FROM', () => {
    // Without this, a fit check is indistinguishable from `expect(true)`. The
    // plural the `REP` singular exists to avoid, and the `100% WET` the mix
    // rounding exists to avoid, must both be REFUSED — so the gate is proven to
    // bite in the right place rather than merely to bite.
    expect(readoutFitsLane('135 REPS'), '8 glyphs = 47.76 px > 46 px').toBe(false);
    expect(readoutFitsLane('100% WET'), '8 glyphs = 47.76 px > 46 px').toBe(false);
    expect(readoutFitsLane('135 REP'), '7 glyphs = 41.79 px ≤ 46 px').toBe(true);
    expect(READOUT_MAX_CHARS, 'the column holds 7 glyphs, not 8').toBe(7);
  });
});

describe('the def wires the model in (a model nothing imports proves nothing)', () => {
  it('all three params carry their model formatter', () => {
    expect(TIME.format?.(TIME.defaultValue)).toBe('250 MS');
    expect(FEEDBACK.format?.(FEEDBACK.defaultValue)).toBe('8 REP');
    expect(MIX.format?.(MIX.defaultValue)).toBe('35% WET');
  });

  it('no param declares `options` or `landmarks` (nothing here is discrete)', () => {
    // A deliberate non-choice, recorded so it reads as decided rather than
    // forgotten: `format` outranks `landmarks` in `knobReadout`, so a roster
    // here would paint arc TICKS only — and the boundaries worth ticking on a
    // delay (comb→slapback→rhythmic) are perceptual bands, not detents.
    for (const p of delayDef.params) {
      expect(p.options, `${p.id} declares options`).toBeUndefined();
      expect(p.landmarks, `${p.id} declares landmarks`).toBeUndefined();
    }
  });
});

describe('the curated face — the ladder, DERIVED', () => {
  const face = (tier: Parameters<typeof curatedFace>[1]) => {
    const f = curatedFace(delayDef, tier);
    if (!f) throw new Error(`delay has no curated face at tier '${tier}' — it was un-migrated`);
    return f;
  };

  it('THE RANK: mini shows time; compact drops mix; full and dock show all three', () => {
    // This is the ENTIRE consequence of `face.order` on this module, and it
    // corrects the def's previous comment ("all three survive to the compact
    // tile") — the compact cap with a glyph is TWO.
    expect(
      Object.fromEntries(
        (['mini', 'compact', 'full', 'dock'] as const).map((t) => [
          t,
          face(t).controls.map((c) => c.key),
        ]),
      ),
    ).toEqual({
      mini: ['time'],
      compact: ['time', 'feedback'],
      full: ['time', 'feedback', 'mix'],
      dock: ['time', 'feedback', 'mix'],
    });
  });

  it('THE PRICED TRADE: three controls KEEP the in-lane glyph, a fourth would kill it', () => {
    // The reason `time_cv_amt` is not on this face, asserted rather than
    // commented. `laneBodyPlan` drops the glyph as soon as the plate needs two
    // rows, and 4 controls is `ceil(4/3) = 2`.
    const hasGlyph = delayDef.face?.glyph !== 'none' && delayDef.face?.glyph !== undefined;
    expect(hasGlyph).toBe(true);
    const three = laneBodyPlan(3, 'trace', 'full');
    expect(three, 'three cells fit ONE plate row, so the glyph strip still fits').toMatchObject({
      layout: 'plate',
      cellCount: 3,
      glyph: true,
    });
    const four = laneBodyPlan(4, 'trace', 'full');
    expect(four, 'a fourth cell forces a second row and the glyph is dropped').toMatchObject({
      cellCount: 4,
      glyph: false,
    });
    // …and the face really is at three, so the assertion above is about THIS
    // module rather than about arithmetic in the abstract.
    expect(delayDef.face?.order).toHaveLength(3);
  });

  it('ONE page, holding all three controls in signal order', () => {
    const dock = face('dock');
    expect(dock.pages?.map((p) => p.id)).toEqual(['echo']);
    expect(dock.pages?.[0]?.controls.map((c) => c.key)).toEqual(['time', 'feedback', 'mix']);
    // The band header is the module's topology, and it is the thing the old
    // `output blend` band was only implying.
    expect(dock.pages?.[0]?.label).toContain('outside the loop');
  });

  it('the rear group ids are the SANCTIONED pair: the leading slot + the page id', () => {
    // Both halves are load-bearing and each is one edit away from a different
    // bug, so pin them together.
    //
    //  * `signal` claims the LEADING slot. It must NOT also be a page id — that
    //    is the dx7 double-render scar (the leading band is pushed before the
    //    page loop, so a matching page pushes a second band with the same id).
    //  * `echo` IS the page id, and that is required rather than tolerated: a
    //    curated group naming no page appends as a STRAY band, which
    //    module-face-lint refuses because the totality gate counts holes and
    //    not their order. The round-2 spec proposed exactly that stray append.
    const groupIds = (delayDef.face?.rear?.groups ?? []).map((g) => g.id);
    const pageIds = (delayDef.face?.pages ?? []).map((p) => p.id);
    expect(groupIds).toEqual(['signal', 'echo']);
    expect(pageIds).toEqual(['echo']);
    expect(pageIds, 'a page named `signal` would render the leading band twice').not.toContain(
      'signal',
    );
    for (const id of groupIds.slice(1)) {
      expect(pageIds, `rear group '${id}' names no page — it would append as a stray band`).toContain(
        id,
      );
    }
  });
});
