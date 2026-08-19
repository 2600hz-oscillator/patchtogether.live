// packages/web/src/lib/ui/modules/fourplexer-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS under the 4PLEXER faceplate's three derived
// readouts, plus the two audit findings this face is built on.
//
// ⚠ THE CONTROL HERE IS A PERMUTATION, NOT A KNOB WIGGLE, and that is the whole
// reason this file is worth its lines. Every readout on this module moves when
// you turn a dial, so "does it move" proves nothing at all — a relabelled knob
// would pass it. What separates a JOIN over four selectors from four
// readbacks is that a permutation changes ALL FOUR DIALS and must leave both
// hazard readouts exactly where they were, because a permutation is still a
// bijection: it fans nothing and idles nothing.

import { describe, expect, it } from 'vitest';
import {
  FOURPLEXER_INPUT_OPTIONS,
  FOURPLEXER_INPUTS,
  FOURPLEXER_SELECTORS,
  fourplexerClampSelector,
} from '$lib/audio/fourplexer-select';
import { fourplexerDef } from '$lib/audio/modules/fourplexer';
import { glyphBinding, primaryAudioOutPortId } from '$lib/ui/workflow/shell-glyph-live';
import {
  fourplexerFanText,
  fourplexerFannedInputs,
  fourplexerIdleInputs,
  fourplexerIdleText,
  fourplexerInputLoad,
  fourplexerIsBijection,
  fourplexerMapText,
  fourplexerRouting,
} from './fourplexer-face-model';

/** The def's OWN spawn defaults — derived, never retyped. */
const DEFAULTS: Record<string, number> = Object.fromEntries(
  fourplexerDef.params.map((p) => [p.id, p.defaultValue]),
);
const SEL_IDS: readonly string[] = FOURPLEXER_SELECTORS.map((s) => s.id);

const reader = (over: Record<string, number> = {}) => (id: string): number | undefined => {
  const merged: Record<string, number> = { ...DEFAULTS, ...over };
  return id in merged ? merged[id] : undefined;
};
/** What the REGISTRY prints — the surface the faceplate renders. */
/** An overlay setting the four selectors to a given 0-based routing. */
const patch = (routing: readonly number[]): Record<string, number> =>
  Object.fromEntries(SEL_IDS.map((id, i) => [id, routing[i]!]));

describe('fourplexer — the two audit findings this face is built on', () => {
  it('FINDING 1: the selectors declare a NAMED roster, so a promoted face can say which input', () => {
    // The control loss promotion would otherwise have caused: `discrete` says
    // "N states", never what a state is called, and the legacy card wrote the
    // names in markup.
    for (const p of fourplexerDef.params) {
      expect(p.curve, `${p.id} curve`).toBe('discrete');
      expect(p.options, `${p.id} declares no option roster — the face cannot name its states`)
        .toBeDefined();
      expect(p.options!.length, `${p.id} roster size`).toBe(FOURPLEXER_INPUTS);
      // ANCHORED: every detent must be a reachable value of the param.
      for (const o of p.options!) {
        expect(o.value, `${p.id} detent ${o.label} is outside [min,max]`).toBeGreaterThanOrEqual(p.min);
        expect(o.value).toBeLessThanOrEqual(p.max);
      }
      // …and it is the SHARED roster, not a per-param copy that could drift.
      expect(p.options).toBe(FOURPLEXER_INPUT_OPTIONS);
    }
    // No `format` anywhere — a declared format DISQUALIFIES the painted name
    // (`paintsReadout`), which would silently undo the whole fix.
    for (const p of fourplexerDef.params) {
      expect((p as { format?: unknown }).format, `${p.id} declares a format`).toBeUndefined();
    }
  });

  it('FINDING 2: no glyph can bind — every output is `cv`, so `none` is FORCED', () => {
    expect(primaryAudioOutPortId(fourplexerDef as never), 'primary audio out').toBeNull();
    expect(fourplexerDef.face?.glyph, 'the declared glyph').toBe('none');
    expect(glyphBinding(fourplexerDef as never)).toEqual({ kind: 'none' });

    // ⚠ NEGATIVE CONTROL, and it has to override the glyph in BOTH mutants:
    // `glyphBinding` SHORT-CIRCUITS on the declared `'none'` literal before it
    // ever inspects a port, so a mutant that only adds an output still returns
    // `{kind:'none'}` — i.e. it would measure the literal rather than the port
    // roster it is trying to control for.
    const asMeter = { ...fourplexerDef, face: { ...fourplexerDef.face!, glyph: 'meter' as const } };
    expect(glyphBinding(asMeter as never).kind, 'a glyph here is DEAD — the #1692 shape').toBe(
      'static',
    );
    const withAudio = {
      ...asMeter,
      outputs: [...fourplexerDef.outputs, { id: 'probe', type: 'audio' as const }],
    };
    expect(glyphBinding(withAudio as never), 'and it binds the moment an audio out exists').toEqual({
      kind: 'live-audio',
      portId: 'probe',
    });
  });
});

describe('fourplexer face — the registry and the face agree, both directions', () => {

  it('the rank is the OUTPUT AXIS and covers every selector exactly once', () => {
    expect(fourplexerDef.face?.order).toEqual(SEL_IDS);
    expect(new Set(fourplexerDef.face?.order).size).toBe(SEL_IDS.length);
  });
});

describe('fourplexer readouts — a PERMUTATION is the negative control', () => {

  it('fan is ordered busiest-first, and load sums to the output count', () => {
    const routing = fourplexerRouting(reader(patch([0, 0, 0, 1])));
    expect(fourplexerFannedInputs(routing)).toEqual([{ input: 1, outputs: 3 }]);
    const load = fourplexerInputLoad(routing);
    expect(load.reduce((s, v) => s + v, 0), 'every output carries exactly one input').toBe(
      SEL_IDS.length,
    );
    expect(fourplexerIdleInputs(routing)).toEqual([3, 4]);
  });
});

describe('fourplexer readouts are TOTAL — they run on every render', () => {

  it('the text helpers never throw on an empty or oversized routing', () => {
    expect(() => fourplexerMapText([])).not.toThrow();
    expect(fourplexerFanText([])).toBe('none');
    expect(fourplexerIdleText([])).toBe(
      FOURPLEXER_INPUT_OPTIONS.map((o) => o.label).join(', '),
    );
  });
});
