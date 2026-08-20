// packages/web/src/lib/ui/modules/one-knob-faces-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS behind the ONE-KNOB faceplates — audio
// utilities whose entire control surface is a single param.
//
// WHY ONE FILE. The reason to read these four together is a CONTRAST that no
// single-module file could state. `moog962` and `sampleHold` each have exactly
// one DISCRETE param, and only one of them gains a named picker:
//
//   · sampleHold's ten scale NAMES already existed — the legacy card renders
//     them in its own element above the knob — and the shell could not reach
//     them, so they are PROMOTED into `options`.
//   · moog962's STAGES has no names at all. Its values ARE their own labels
//     (2 stages; 3 stages), so declaring a roster would print under the control
//     the very number the control already is, and change the I/O contract to
//     do it.
//
// The rule the pair establishes — PROMOTE names that exist, never INVENT names
// to justify a nicer cell — is only visible when both are asserted in one
// place, and it is the rule most likely to be eroded by a later "consistency"
// pass that gives moog962 a roster because sampleHold has one.
//
// The same contrast runs through the glyphs: two of these modules take a live
// meter and two refuse one, for reasons that are properties of their PORTS.
//
// ⚠ THESE ARE MODEL ASSERTIONS, NOT PIXEL ONES. What renders is proven by the
// VRT scenes; what this file proves is that the declarations the renderer reads
// still say what these faces were built on.

import { describe, expect, it } from 'vitest';

import { moog903aDef } from '$lib/audio/modules/moog903a';
import { moog962Def } from '$lib/audio/modules/moog962';
import { sampleHoldDef } from '$lib/audio/modules/sample-hold';
import { scalerDef } from '$lib/audio/modules/scaler';
import {
  SAMPLE_HOLD_SCALES,
  SAMPLE_HOLD_MAX_SCALE,
} from '../../../../../dsp/src/lib/sample-hold-dsp';
import { dockFacePlan } from '$lib/ui/workflow/curated-face';
import { paramCellKind, SEGMENTED_MAX_OPTIONS } from '$lib/ui/workflow/shell-control-kind';
import { glyphBinding, primaryAudioOutPortId } from '$lib/ui/workflow/shell-glyph-live';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import type { ParamDef } from '$lib/graph/types';

const NO_MOMENTARY: ReadonlySet<string> = new Set();

/** ANCHORED TO THE ARTIFACT: each row carries the def itself, so a renamed or
 *  deleted module is a compile error, never a silently skipped row. */
const ONE_KNOB = [
  { type: 'moog903a', def: moog903aDef, only: 'level', glyph: 'meter' },
  { type: 'moog962', def: moog962Def, only: 'stages', glyph: 'none' },
  { type: 'sampleHold', def: sampleHoldDef, only: 'scale', glyph: 'none' },
  { type: 'scaler', def: scalerDef, only: 'amount', glyph: 'meter' },
] as const;

function param(def: { params: readonly ParamDef[] }, id: string): ParamDef {
  const p = def.params.find((q) => q.id === id);
  if (!p) throw new Error(`no param '${id}'`);
  return p;
}

describe('one-knob faces — promotion, ranking and the defaults they were built on', () => {
  it('each is PROMOTED and ranks exactly its one param, in exactly one band', () => {
    const problems: string[] = [];
    for (const { type, def, only } of ONE_KNOB) {
      if (!STRICT_FACES.has(type)) problems.push(`${type}: not in STRICT_FACES`);
      expect(def.face?.order, `${type} order`).toEqual([only]);
      // The band count the VRT roster copies as `pages`. Nothing else checks
      // that copy — `shell-faces-roster.test.ts` cross-checks only
      // `tabbedOptIn` — so a wrong number there fails as a Playwright timeout
      // on a capture job, the slowest possible place to learn it.
      const plan = dockFacePlan(def as never);
      expect(plan, `${type}: planned as UN-FACED — the legacy card would return`).not.toBeNull();
      expect(plan!.length, `${type}: dock band count (the roster's \`pages\`)`).toBe(1);
      // The face's completeness claim, both directions.
      expect(def.params.map((p) => p.id), `${type} param roster`).toEqual([only]);
    }
    expect(problems).toEqual([]);
  });

  it('the defaults these faces were authored against still ship', () => {
    expect(param(moog903aDef, 'level').defaultValue).toBe(0.8);
    expect(param(moog962Def, 'stages').defaultValue).toBe(3);
    expect(param(moog962Def, 'stages').min).toBe(2);
    expect(param(moog962Def, 'stages').max).toBe(3);
    expect(param(sampleHoldDef, 'scale').defaultValue).toBe(1); // Major
    expect(param(scalerDef, 'amount').defaultValue).toBe(1); // unity — a transparent patch
    expect(param(scalerDef, 'amount').curve).toBe('log');
  });

  it('NO face in this batch declares paramCells, momentary, pages, a hero or a title', () => {
    // The thin-face discipline, asserted rather than trusted. Every one of these
    // fields is a reason to be WIDER or to paint MORE TEXT, and none of these
    // modules has earned one. Note `sampleHold` in particular: its picker is
    // DERIVED from `options`, never declared as a cell.
    const problems: string[] = [];
    for (const { type, def } of ONE_KNOB) {
      const f = def.face as Record<string, unknown> | undefined;
      for (const field of ['paramCells', 'momentary', 'pages', 'hero', 'title', 'hint', 'xyPads', 'bareCells', 'extension', 'tabbed']) {
        if (f && f[field] !== undefined) problems.push(`${type}: declares face.${field}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('one-knob faces — PROMOTE names that exist, never INVENT them', () => {
  it('sampleHold: the scale roster is TOTAL and DERIVED from the quantiser table', () => {
    const opts = param(sampleHoldDef, 'scale').options;
    expect(opts, 'sampleHold must declare its scale names').toBeDefined();

    // TOTAL — one entry per reachable index. `param-vocabulary`'s stated reason:
    // a roster that skips a value leaves a state the dial can reach and the
    // picker cannot name. Asserted against the RANGE, never a typed count.
    const scale = param(sampleHoldDef, 'scale');
    expect(opts!.map((o) => o.value)).toEqual(
      Array.from({ length: scale.max - scale.min + 1 }, (_, i) => scale.min + i),
    );

    // DERIVED — the labels ARE the DSP table's names, in its order. If someone
    // re-types them, or the table gains a scale the roster does not, this fails.
    expect(opts!.map((o) => o.label)).toEqual(SAMPLE_HOLD_SCALES.map((s) => s.name));
    expect(scale.max).toBe(SAMPLE_HOLD_MAX_SCALE);
  });

  it('sampleHold: the roster RESOLVES to a named picker at the dock and a KNOB in the lane', () => {
    // The cell kind is derived from the roster, not declared — so this is the
    // clause that proves promoting the names actually changed what renders.
    const scale = param(sampleHoldDef, 'scale');
    expect(scale.options!.length).toBeGreaterThan(SEGMENTED_MAX_OPTIONS);
    expect(paramCellKind(scale, NO_MOMENTARY, 'dock')).toBe('selector');
    // The 192x180 lane tile has no room for a ten-row list, and the platform
    // knows it: every non-dock tier keeps the stepped dial the card draws.
    expect(paramCellKind(scale, NO_MOMENTARY, 'lane')).toBe('knob');
  });

  it('moog962: STAGES declares NO roster, and that ABSENCE is doing work', () => {
    const stages = param(moog962Def, 'stages');
    expect(stages.options, 'moog962 STAGES must NOT declare options').toBeUndefined();
    expect(paramCellKind(stages, NO_MOMENTARY, 'dock')).toBe('knob');

    // NEGATIVE CONTROL: the only thing separating this from sampleHold is the
    // roster. Add one and the dock cell changes kind — which is exactly why the
    // absence is a decision worth pinning rather than an oversight.
    const withRoster: ParamDef = {
      ...stages,
      options: [
        { value: 2, label: '2' },
        { value: 3, label: '3' },
      ],
    };
    expect(paramCellKind(withRoster, NO_MOMENTARY, 'dock')).toBe('segmented');
  });
});

describe('one-knob faces — the GLYPH decision, run through the real resolver', () => {
  it('each face resolves to the binding it declares', () => {
    for (const { type, def, glyph } of ONE_KNOB) {
      expect(def.face?.glyph, `${type} declared glyph`).toBe(glyph);
      const kind = glyphBinding(def as never).kind;
      expect(kind, `${type} glyph binding`).toBe(glyph === 'none' ? 'none' : 'live-audio');
    }
  });

  it('FORCED vs EARNED: the two refusals have no audio port, the two meters do', () => {
    // The distinction the declaration cannot carry — all four are one word.

    // FORCED — every output is `cv`, so any glyph resolves to the DEAD `static`
    // binding that shipped on marbles through three passes.
    for (const def of [moog962Def, sampleHoldDef]) {
      expect(primaryAudioOutPortId(def as never)).toBeNull();
      const withMeter = { ...def, face: { ...(def.face ?? { order: [] }), glyph: 'meter' } };
      expect(glyphBinding(withMeter as never).kind).toBe('static');
    }

    // EARNED — and for two different reasons.
    //
    // scaler's meter is TOTAL: `out` is its only audio output, so there is no
    // second signal path for the meter to misrepresent.
    expect(primaryAudioOutPortId(scalerDef as never)).toBe('out');
    expect(scalerDef.outputs.filter((o) => o.type === 'audio')).toHaveLength(1);

    // moog903a's meter reads ONE of two audio taps, and is still honest,
    // because white and pink are the SAME generator at different filter slopes
    // and BOTH are scaled by the single LEVEL knob. That is the property that
    // makes a one-port meter representative — and the property `moog994` lacks,
    // which is why that module refused a meter that would have bound live.
    expect(primaryAudioOutPortId(moog903aDef as never)).toBe('white');
    expect(moog903aDef.outputs.map((o) => o.id)).toEqual(['white', 'pink']);
    expect(moog903aDef.params.map((p) => p.id)).toEqual(['level']);
  });
});
