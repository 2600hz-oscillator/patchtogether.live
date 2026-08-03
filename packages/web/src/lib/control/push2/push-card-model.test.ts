// packages/web/src/lib/control/push2/push-card-model.test.ts
//
// THE BAR IS THE THING MOST LIKELY TO SILENTLY LIE, so most of this file is
// about the bar. A non-linear param drawn with a linear map LOOKS FINE at both
// endpoints and is wrong everywhere between — a screenshot, a VRT baseline and
// a "0 ≤ frac ≤ 1" assertion all pass happily. So every curve is pinned at its
// MIDPOINT, in both directions:
//
//   · the value at arc-centre  (what sits at 50 % of the bar), and
//   · the arc position of the range's arithmetic centre.
//
// Each pair carries an explicit "and a linear map would have said X" so the
// assertion cannot pass vacuously if the curve is ever ignored: the two numbers
// are far apart by construction.

import { describe, it, expect } from 'vitest';

import '$lib/audio/modules';
import { listModuleDefs } from '$lib/audio/module-registry';
import type { ModuleNode, ParamDef } from '$lib/graph/types';

import { resolvePushCardControls, type PushCardDefLike } from './push-card-schema';
import {
  CELL_MAX_STEPS,
  discreteSteps,
  emptyStrip,
  paramValue,
  pushCardView,
  pushStrip,
} from './push-card-model';

function defByType(type: string): PushCardDefLike & { label?: string; category?: string } {
  const def = (listModuleDefs() as unknown as PushCardDefLike[]).find((d) => d.type === type);
  if (!def) throw new Error(`no such module type: ${type}`);
  return def;
}

function paramOf(type: string, id: string): ParamDef {
  const p = (defByType(type).params ?? []).find((q) => q.id === id);
  if (!p) throw new Error(`${type} has no param ${id}`);
  return p;
}

function node(type: string, params: Record<string, number> = {}, data: Record<string, unknown> = {}): ModuleNode {
  return { id: `${type}-1`, type, domain: 'audio', position: { x: 0, y: 0 }, params, data } as ModuleNode;
}

function p(over: Partial<ParamDef> & { id: string }): ParamDef {
  return { label: over.id, defaultValue: 0, min: 0, max: 1, curve: 'linear', ...over };
}

/** What a naive `(v - min) / (max - min)` would have returned. Used only to
 *  prove each curve assertion is NOT satisfiable by a linear map. */
function linearFrac(v: number, min: number, max: number): number {
  return (v - min) / (max - min);
}

// ---------------------------------------------------------------------------
// The bar position, per curve
// ---------------------------------------------------------------------------

describe('the bar honours the LOG curve', () => {
  // filter.cutoff — log 20..20000 Hz. The real workhorse case.
  const cutoff = paramOf('filter', 'cutoff');

  it('is 0 and 1 at the endpoints (where a linear map would also be right)', () => {
    expect(pushStrip(cutoff, 20, 1).frac).toBeCloseTo(0, 9);
    expect(pushStrip(cutoff, 20000, 1).frac).toBeCloseTo(1, 9);
  });

  it('puts the GEOMETRIC mean at arc-centre — a linear map would say 3 %', () => {
    const geo = Math.sqrt(20 * 20000); // 632.45 Hz
    expect(pushStrip(cutoff, geo, 1).frac).toBeCloseTo(0.5, 6);
    // The negative control, stated inline: a linear bar is nowhere near.
    expect(linearFrac(geo, 20, 20000)).toBeCloseTo(0.0307, 3);
  });

  it('puts the ARITHMETIC mean at 90 % — a linear map would say 50 %', () => {
    const mid = (20 + 20000) / 2; // 10010 Hz
    expect(pushStrip(cutoff, mid, 1).frac).toBeCloseTo(0.8998, 3);
    expect(linearFrac(mid, 20, 20000)).toBeCloseTo(0.5, 9);
  });

  it('holds for the other real log params in the authored windows', () => {
    // kickdrum.sub_decay 50..800 ms, tomtom.tune 60..400 Hz, adsr.attack .001..10 s
    for (const [type, id] of [['kickdrum', 'sub_decay'], ['tomtom', 'tune'], ['adsr', 'attack']] as const) {
      const param = paramOf(type, id);
      const geo = Math.sqrt(param.min * param.max);
      expect(pushStrip(param, geo, 1).frac, `${type}.${id}`).toBeCloseTo(0.5, 6);
      // …and the linear answer is genuinely different, so this is not vacuous.
      expect(Math.abs(linearFrac(geo, param.min, param.max) - 0.5), `${type}.${id}`).toBeGreaterThan(0.1);
    }
  });
});

describe('the bar honours the EXP curve', () => {
  // ⚠ ZERO shipped params declare `curve: 'exp'` today (verified across every
  // audio + video def), so this is a hand-built fixture on purpose rather than
  // a hunt for a real module. knobValueToFrac's exp branch squares the linear
  // fraction, and a card that ignored it would be wrong for every non-endpoint.
  const boost = p({ id: 'boost', min: 0, max: 100, curve: 'exp' });

  it('squares the linear fraction — the range midpoint sits at 25 %, not 50 %', () => {
    expect(pushStrip(boost, 50, 1).frac).toBeCloseTo(0.25, 9);
    expect(linearFrac(50, 0, 100)).toBeCloseTo(0.5, 9);
  });

  it('still pins the endpoints', () => {
    expect(pushStrip(boost, 0, 1).frac).toBe(0);
    expect(pushStrip(boost, 100, 1).frac).toBeCloseTo(1, 9);
  });
});

describe('the bar honours the DISCRETE curve — cells, not a sweep', () => {
  it('draws one cell per state for a small roster', () => {
    const mode = paramOf('filter', 'mode'); // 0..2 discrete, 3 named options
    const s = pushStrip(mode, 1, 1);
    expect(s.cells).toBe(3);
    expect(s.cellIndex).toBe(1);
    // A named roster is a STATE, so one cell lights, not "2 of 3 filled".
    expect(s.cellStyle).toBe('select');
  });

  it('reads a small INTEGER quantity as a fill, not a selection', () => {
    const feedback = paramOf('dx7', 'feedback'); // 0..7 discrete, no options
    const s = pushStrip(feedback, 4, 1);
    expect(s.cells).toBe(8);
    expect(s.cellIndex).toBe(4);
    expect(s.cellStyle).toBe('fill');
  });

  it('falls back to a continuous fill past CELL_MAX_STEPS', () => {
    const algorithm = paramOf('dx7', 'algorithm'); // 1..32 → ~3 px cells
    expect(algorithm.max - algorithm.min + 1).toBeGreaterThan(CELL_MAX_STEPS);
    expect(pushStrip(algorithm, 16, 1).cells).toBeNull();
  });

  it('indexes the lit cell by ARC POSITION, so a BIPOLAR discrete centres', () => {
    const oct2 = paramOf('tidyVco', 'oct2'); // -1..1 discrete → 3 cells
    expect(pushStrip(oct2, -1, 1).cellIndex).toBe(0);
    expect(pushStrip(oct2, 0, 1).cellIndex).toBe(1);
    expect(pushStrip(oct2, 1, 1).cellIndex).toBe(2);
    // Centred range ⇒ 'select': "2 of 3 lit" would read as a maximum.
    expect(pushStrip(oct2, 0, 1).cellStyle).toBe('select');
  });

  it('lights the cell of the option the READOUT names, for a SPARSE roster', () => {
    // The case that separates the two plausible rules. States at 0 / 4 / 9 of a
    // 0..9 range: indexing by (value - min) or by arc position both put value 4
    // in the WRONG cell, so the screen would light cell 2 while spelling out
    // the name of cell 1. Indexing through the same `nearestByValue` the
    // readout uses makes that disagreement unrepresentable.
    const sparse = p({
      id: 'shape', curve: 'discrete', min: 0, max: 9,
      options: [
        { value: 0, label: 'SINE' },
        { value: 4, label: 'TRI' },
        { value: 9, label: 'SAW' },
      ],
    });
    const s = pushStrip(sparse, 4, 1);
    expect(s.cells).toBe(3);
    expect(s.valueText).toBe('TRI');
    expect(s.cellIndex).toBe(1);
    // Indexing by (value - min) would say cell 4 → clamped to 2 = 'SAW'.
    expect(Math.round(4 - sparse.min)).toBe(4);

    // An OFF-DETENT saved value is where the arc rule diverges too. 6.6 is
    // nearer 9 than 4, so the readout says SAW — and the lit cell must follow
    // the readout, not the arc (which rounds to cell 1, 'TRI').
    const off = pushStrip(sparse, 6.6, 1);
    expect(off.valueText).toBe('SAW');
    expect(off.cellIndex).toBe(2);
    expect(Math.round(off.frac * (3 - 1))).toBe(1); // the arc rule's answer
  });

  it('discreteSteps: options roster wins over the integer span', () => {
    expect(discreteSteps(p({ id: 'a', curve: 'discrete', min: 0, max: 2 }))).toBe(3);
    expect(
      discreteSteps(
        p({
          id: 'b', curve: 'discrete', min: 0, max: 9,
          options: [{ value: 0, label: 'x' }, { value: 9, label: 'y' }],
        }),
      ),
    ).toBe(2);
    expect(discreteSteps(p({ id: 'c', curve: 'linear', min: 0, max: 2 }))).toBeNull();
    expect(discreteSteps(p({ id: 'd', curve: 'discrete', min: 0, max: 99 }))).toBeNull();
    // An EMPTY roster falls back to the integer span rather than collapsing
    // the param into a continuous sweep.
    expect(discreteSteps(p({ id: 'e', curve: 'discrete', min: 0, max: 2, options: [] }))).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// The bipolar anchor
// ---------------------------------------------------------------------------

describe('a BIPOLAR param anchors its bar at ZERO, not at the left edge', () => {
  it('vca.cvAmount at rest draws from the centre', () => {
    const cv = paramOf('vca', 'cvAmount'); // -1..1
    const s = pushStrip(cv, 0, 1);
    expect(s.bipolar).toBe(true);
    expect(s.zeroFrac).toBeCloseTo(0.5, 9);
    expect(s.frac).toBeCloseTo(0.5, 9);
    // Fill width = |frac - zeroFrac|: an attenuverter at rest draws NOTHING,
    // instead of the half-full bar a left-anchored map would draw.
    expect(Math.abs(s.frac - s.zeroFrac)).toBeCloseTo(0, 9);
  });

  it('a negative value fills LEFT of the anchor and a positive one RIGHT', () => {
    const detune = paramOf('tidyVco', 'detune'); // -50..50 cents
    const lo = pushStrip(detune, -25, 1);
    const hi = pushStrip(detune, 25, 1);
    expect(lo.zeroFrac).toBeCloseTo(0.5, 9);
    expect(lo.frac).toBeLessThan(lo.zeroFrac);
    expect(hi.frac).toBeGreaterThan(hi.zeroFrac);
    expect(lo.zeroFrac - lo.frac).toBeCloseTo(hi.frac - hi.zeroFrac, 9);
  });

  it('an OFF-CENTRE bipolar range anchors where zero actually is', () => {
    // -24..12 dB (karplus/kickdrum/tomtom `level`): zero is at 2/3, not 1/2.
    const level = paramOf('kickdrum', 'level');
    const s = pushStrip(level, 0, 1);
    expect(s.bipolar).toBe(true);
    expect(s.zeroFrac).toBeCloseTo(24 / 36, 9);
  });

  it('a UNIPOLAR param anchors at the left edge', () => {
    const mix = paramOf('reverb', 'mix'); // 0..1
    const s = pushStrip(mix, 0.3, 1);
    expect(s.bipolar).toBe(false);
    expect(s.zeroFrac).toBe(0);
  });

  it('a range that only TOUCHES zero is not bipolar', () => {
    expect(pushStrip(p({ id: 'a', min: 0, max: 1 }), 0.5, 1).bipolar).toBe(false);
    expect(pushStrip(p({ id: 'b', min: -1, max: 0 }), -0.5, 1).bipolar).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The readout text + detents
// ---------------------------------------------------------------------------

describe('the readout says exactly what the on-screen dial says', () => {
  it('prints a declared OPTION name, never the raw number', () => {
    const mode = paramOf('filter', 'mode');
    const label = mode.options?.[2]?.label ?? '';
    expect(label).not.toBe('');
    expect(pushStrip(mode, 2, 1).valueText).toBe(label);
  });

  it('falls back to the shared number ladder with units', () => {
    expect(pushStrip(paramOf('filter', 'cutoff'), 1000, 1).valueText).toBe('1.00k Hz');
    expect(pushStrip(paramOf('reverb', 'mix'), 0.3, 1).valueText).toBe('0.30');
    // A dB param with NO declared formatter still gets the shared ladder.
    // (kickdrum's `level` used to be this example and no longer is — it now
    // declares one. See the next case, which is the point of that change.)
    expect(pushStrip(paramOf('karplus', 'level'), -6, 1).valueText).toBe('-6.00 dB');
  });

  it('a DECLARED ParamDef.format wins — the hardware screen and the dial agree', () => {
    // param-format.ts exists because the readout ladder was copy-pasted three
    // times and the Push card is its fourth consumer; the SAME argument applies
    // to a bespoke `format`. kickdrum declares `+3.0 dB` / `2.8 kHz` / `450 ms`
    // for its own units, and the hardware must print those, not `-6.00 dB` and
    // `2.80k Hz`, or the two surfaces drift digit by digit with no gate able to
    // see it (the exact divergence class CLAUDE.md names).
    expect(pushStrip(paramOf('kickdrum', 'level'), -6, 1).valueText).toBe('-6.0 dB');
    expect(pushStrip(paramOf('kickdrum', 'click_tone'), 2800, 1).valueText).toBe('2.8 kHz');
    expect(pushStrip(paramOf('kickdrum', 'sub_decay'), 450, 1).valueText).toBe('450 ms');
  });

  it('UPPERCASES the label for the hardware screen', () => {
    expect(pushStrip(paramOf('filter', 'cutoff'), 1000, 1).label).toBe(
      paramOf('filter', 'cutoff').label.toUpperCase(),
    );
  });

  it('emits detent pips at the OPTION positions, under the curve', () => {
    const mode = paramOf('filter', 'mode');
    expect(pushStrip(mode, 0, 1).pips).toEqual([0, 0.5, 1]);
    // A param with no declared vocabulary gets no pips.
    expect(pushStrip(paramOf('reverb', 'mix'), 0.5, 1).pips).toEqual([]);
  });

  it('CLAMPS the bar but NOT the readout — the dial does exactly this', () => {
    const mix = paramOf('reverb', 'mix'); // 0..1
    const s = pushStrip(mix, 1.7, 1);
    expect(s.frac).toBe(1); // the bar pins at the end
    expect(s.value).toBe(1.7); // the number still tells you what is stored
    expect(s.valueText).toBe('1.70');
  });
});

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

describe('pushCardView', () => {
  it('renders the AUTHORED dx7 card: 8 strips, encoders 1..8, live values', () => {
    const def = defByType('dx7');
    const spec = resolvePushCardControls(def);
    const view = pushCardView(spec, node('dx7', { feedback: 7, level: 1 }), def);

    expect(view.strips).toHaveLength(8);
    expect(view.strips.map((s) => s.encoder)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(view.strips.map((s) => s.paramId)).toEqual([
      'feedback', 'algorithm', 'level', 'transpose', 'attack', 'decay', 'sustain', 'release',
    ]);
    expect(view.strips[0]?.value).toBe(7);
    expect(view.strips[0]?.frac).toBeCloseTo(1, 9);
    // An unset param reads its DEF DEFAULT, not 0 — dx7's algorithm rests at 5.
    expect(view.strips[1]?.value).toBe(paramOf('dx7', 'algorithm').defaultValue);
    expect(view.source).toBe('override');
    expect(view.empty).toBeNull();
  });

  it('pads a short card with EMPTY strips that still carry their encoder', () => {
    const def = defByType('vca');
    const view = pushCardView(resolvePushCardControls(def), node('vca'), def);
    expect(view.strips.filter((s) => s.kind === 'param')).toHaveLength(2);
    const blank = view.strips[7];
    expect(blank?.kind).toBe('empty');
    expect(blank?.encoder).toBe(8);
    expect(blank?.label).toBe('');
    expect(blank?.valueText).toBe('');
    expect(view.empty).toBeNull(); // 2 controls is a card, not an empty state
  });

  it('reports no-controls for a module with nothing turnable', () => {
    const def = { type: 'flipper', domain: 'audio', label: 'flipper', category: 'utility', params: [] };
    const view = pushCardView(resolvePushCardControls(def, {}), node('flipper'), def);
    expect(view.empty).toBe('no-controls');
    expect(view.strips.every((s) => s.kind === 'empty')).toBe(true);
  });

  it('titles the card with the USER-SET name when there is one', () => {
    const def = defByType('dx7');
    const spec = resolvePushCardControls(def);
    expect(pushCardView(spec, node('dx7'), def).title).toBe(def.label);
    expect(pushCardView(spec, node('dx7', {}, { name: 'LeadBass' }), def).title).toBe('LeadBass');
  });

  it('carries the domain + category for the header, and lane context when given', () => {
    const def = defByType('lfo');
    const spec = resolvePushCardControls(def);
    const bare = pushCardView(spec, node('lfo'), def);
    expect(bare.domain).toBe('audio');
    expect(bare.subtitle).toBe(def.category);
    expect([bare.lane, bare.laneHex, bare.index, bare.count]).toEqual([null, null, null, null]);

    const laned = pushCardView(spec, node('lfo'), def, {
      lane: 3, laneHex: '#ff8800', index: 2, count: 4,
    });
    expect([laned.lane, laned.laneHex, laned.index, laned.count]).toEqual([3, '#ff8800', 2, 4]);
  });
});

describe('paramValue / emptyStrip', () => {
  it('prefers the stored value, falls back to the def default', () => {
    const cutoff = paramOf('filter', 'cutoff');
    expect(paramValue({ params: { cutoff: 440 } }, cutoff)).toBe(440);
    expect(paramValue({ params: {} }, cutoff)).toBe(cutoff.defaultValue);
    expect(paramValue({ params: { cutoff: NaN } }, cutoff)).toBe(cutoff.defaultValue);
  });

  it('an empty strip is inert in every field', () => {
    const s = emptyStrip(5);
    expect(s).toMatchObject({
      kind: 'empty', encoder: 5, paramId: '', label: '', valueText: '',
      frac: 0, zeroFrac: 0, bipolar: false, cells: null, pips: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Sweep: every authored + curated card, every strip, on its defaults
// ---------------------------------------------------------------------------

describe('every shipped module renders a coherent card at its defaults', () => {
  it('frac and zeroFrac stay inside the bar for every strip of every module', () => {
    for (const def of listModuleDefs() as unknown as (PushCardDefLike & { label?: string; category?: string })[]) {
      const spec = resolvePushCardControls(def);
      const view = pushCardView(spec, node(def.type), def);
      for (const s of view.strips) {
        expect(s.frac, `${def.type}.${s.paramId}`).toBeGreaterThanOrEqual(0);
        expect(s.frac, `${def.type}.${s.paramId}`).toBeLessThanOrEqual(1);
        expect(s.zeroFrac, `${def.type}.${s.paramId}`).toBeGreaterThanOrEqual(0);
        expect(s.zeroFrac, `${def.type}.${s.paramId}`).toBeLessThanOrEqual(1);
        if (s.cells !== null) {
          expect(s.cellIndex, `${def.type}.${s.paramId}`).toBeGreaterThanOrEqual(0);
          expect(s.cellIndex, `${def.type}.${s.paramId}`).toBeLessThan(s.cells);
        }
        if (s.kind === 'param') expect(s.valueText, `${def.type}.${s.paramId}`).not.toBe('');
      }
    }
  });

  it('a bipolar strip resting at its ZERO draws no fill on any module', () => {
    // The sweep-level statement of the attenuverter bug: if the anchor were
    // dropped, every one of these would draw a half-full bar at rest.
    let checked = 0;
    for (const def of listModuleDefs() as unknown as (PushCardDefLike & { label?: string })[]) {
      const spec = resolvePushCardControls(def);
      for (const slot of spec.slots) {
        if (slot.kind !== 'param') continue;
        const { param } = slot;
        if (!(param.min < 0 && param.max > 0)) continue;
        const s = pushStrip(param, 0, 1);
        expect(Math.abs(s.frac - s.zeroFrac), `${def.type}.${param.id}`).toBeCloseTo(0, 9);
        expect(s.zeroFrac, `${def.type}.${param.id}`).toBeGreaterThan(0);
        checked++;
      }
    }
    // Guard the guard: if a refactor stopped selecting bipolar params, this
    // sweep would pass with zero iterations and prove nothing.
    expect(checked, 'expected real bipolar params in the shipped cards').toBeGreaterThan(5);
  });
});
