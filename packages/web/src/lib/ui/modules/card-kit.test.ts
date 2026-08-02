// packages/web/src/lib/ui/modules/card-kit.test.ts
//
// THE OTHER HALF OF "a card sources its param claims from ONE place".
//
// `card-def-ranges.test.ts` is a source-level matcher: it forbids a promoted
// card from RE-TYPING anything its def declares (a range, a label, a curve,
// units, options). That is one side of a two-sided contract, and CLAUDE.md's
// own rule about this shape — "a gate that reads only one side of a two-sided
// contract proves nothing about the other side" — applies to the gate itself:
//
//     the matcher cannot see a claim being DROPPED.
//
// A card that spreads `paramProps(def, id)` and a card that spreads an object
// missing half the def's vocabulary are TEXTUALLY IDENTICAL. So every prop
// `paramProps` forgets to forward is invisible to the matcher, invisible to
// `contract-lock` and `module-docs-lint` (both read only the DEF), and
// invisible to VRT for anything drawn on hover. `units` was exactly that: it
// was added to `paramProps` with the note "just as def-owned, just as capable
// of drifting" and NOTHING asserted it — deleting `units: p.units` again would
// have kept every gate in the repo green, and neither VCA param declares units,
// so it was not even exercised by the card that motivated it.
//
// This file closes that half. Three tiers:
//
//   1. VALUE tier — `paramProps` returns the DEF's numbers/strings, verbatim.
//      Every fixture value is deliberately un-default-like (min 3, curve 'exp',
//      units 'kHz'), so a stub returning plausible defaults cannot pass.
//   2. STRUCTURAL tier — the roster. `ParamDef`'s field list is parsed out of
//      `$lib/graph/types.ts` and every field must be either FORWARDED or in
//      `NOT_FORWARDED` with a written reason. Adding a def-owned prop to
//      `ParamDef` then fails HERE until someone decides whether a promoted card
//      gets it. That is what makes "it returns every def-owned prop" a checked
//      claim instead of a comment.
//   3. The parser's own negative control — a field list that can't see a new
//      field would make tier 2 vacuously green (CLAUDE.md: validate the
//      instrument, not just the code).
//
// Pure fs + regex + a plain function call: no DOM, no registry, no browser.
// `unit` lane, ~0 added CI wall-time.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ParamDef } from '$lib/graph/types';
import { paramProps } from './card-kit';

/**
 * `ParamDef` fields `paramProps` deliberately does NOT forward, each with the
 * reason it is excluded. This is an ARGUED roster, not an allowlist to grow
 * when a test goes red: a field lands here only when a promoted card genuinely
 * must not receive it.
 */
const NOT_FORWARDED: Readonly<Record<string, string>> = {
  id: 'the lookup KEY, not a prop — it is the argument, and the card passes it as `paramId` itself',
  options:
    'discrete detent TICKS in PARAM space, modelled only by KnobConic. `Fader.ticks` is a DIFFERENT shape (a label at a normalized fraction of the TRACK), so forwarding this would hand a Fader a prop it cannot honour. A card that binds a discrete param to a Fader is not promotable yet — the ratchet edge, stated.',
  landmarks: 'continuous waypoint TICKS — same PARAM-space vs TRACK-space argument as `options`.',
};

/** Every field `paramProps` is required to carry across. */
const FORWARDED = ['min', 'max', 'defaultValue', 'label', 'curve', 'units', 'format'] as const;

/**
 * The declared field names of an interface, read out of TypeScript SOURCE.
 *
 * COMMENTS ARE STRIPPED FIRST and that is load-bearing: `ParamDef`'s own JSDoc
 * contains the prose "PURE and total: it is called on every animation frame",
 * whose `total:` matches a field-declaration regex exactly. A parser that
 * skipped this step would invent a `total` field and the roster gate would go
 * red on a phantom.
 */
export function interfaceFields(source: string, name: string): string[] {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const open = stripped.indexOf(`interface ${name} {`);
  if (open < 0) throw new Error(`interfaceFields: no \`interface ${name}\` in this source`);
  const body = stripped.slice(open);
  const close = body.indexOf('\n}');
  if (close < 0) throw new Error(`interfaceFields: \`interface ${name}\` is not closed`);
  return [...body.slice(0, close).matchAll(/^\s*(\w+)\??\s*:/gm)].map((m) => m[1] as string);
}

function typesSource(): string {
  return readFileSync(
    fileURLToPath(new URL('../../graph/types.ts', import.meta.url)),
    'utf8',
  );
}

/** A def whose every field is deliberately UNLIKE a plausible default. */
const FIXTURE: ParamDef = {
  id: 'cutoff',
  label: 'Cutoff',
  defaultValue: 7,
  min: 3,
  max: 11,
  curve: 'exp',
  units: 'kHz',
  format: (v) => `${v} sizzle`,
};

const DEF = { params: [FIXTURE, { ...FIXTURE, id: 'bare', units: undefined, format: undefined }] };

describe('paramProps — the def→control seam carries EVERY def-owned prop', () => {
  it('forwards the RANGE verbatim, not a plausible default', () => {
    const p = paramProps(DEF, 'cutoff');
    expect({ min: p.min, max: p.max, defaultValue: p.defaultValue }).toEqual({
      min: 3,
      max: 11,
      defaultValue: 7,
    });
  });

  it('forwards the VOCABULARY — label, curve, units, format', () => {
    const p = paramProps(DEF, 'cutoff');
    expect(p.label).toBe('Cutoff');
    expect(p.curve).toBe('exp');
    // `units` is the field this whole file exists for: it was added to
    // paramProps with no assertion anywhere, so deleting it was a no-op to
    // every gate in the repo.
    expect(p.units, 'ParamDef.units must reach the control').toBe('kHz');
    // `format` is the same argument one field over: a def can declare the
    // readout vocabulary (vca prints CLOSED / -12 dB / UNITY) and the curated
    // face renders it, while the CARD's value tag on the same param printed the
    // raw number — two vocabularies for one param, and the matcher forbids the
    // card from fixing it locally.
    expect(p.format, 'ParamDef.format must reach the control').toBeTypeOf('function');
    expect(p.format?.(2)).toBe('2 sizzle');
  });

  it('leaves an OPTIONAL prop undefined when the def omits it', () => {
    // …rather than substituting `''` / a pass-through formatter, either of
    // which would make "the def declared nothing here" indistinguishable from
    // "the def declared the empty string" at the primitive.
    const p = paramProps(DEF, 'bare');
    expect(p.units).toBeUndefined();
    expect(p.format).toBeUndefined();
  });

  it('THROWS on an unknown id instead of inventing a 0..1 range', () => {
    expect(() => paramProps(DEF, 'nope')).toThrow(/no param 'nope'/);
  });

  it('THE ROSTER: every ParamDef field is either forwarded or argued', () => {
    const fields = interfaceFields(typesSource(), 'ParamDef');
    const unclassified = fields.filter(
      (f) => !(FORWARDED as readonly string[]).includes(f) && !(f in NOT_FORWARDED),
    );
    expect(
      unclassified,
      `ParamDef declares field(s) that paramProps neither forwards nor argues about. A ` +
        `def-owned prop that never reaches the control is invisible to every gate we have — ` +
        `card-def-ranges only forbids a card from RE-TYPING a claim, and it cannot tell a ` +
        `card that spreads everything from one that spreads half. Either add the field to ` +
        `paramProps (and to FORWARDED), or put it in NOT_FORWARDED with the reason a ` +
        `promoted card must not receive it.`,
    ).toEqual([]);

    // …and the roster may not name a field that no longer exists, so it cannot
    // rot into a list of excuses for a contract that moved on.
    const orphaned = Object.keys(NOT_FORWARDED).filter((f) => !fields.includes(f));
    expect(orphaned, 'NOT_FORWARDED names a field ParamDef no longer declares').toEqual([]);
    expect(
      FORWARDED.filter((f) => !fields.includes(f)),
      'FORWARDED names a field ParamDef no longer declares',
    ).toEqual([]);

    // Every forwarded name is really a key of the returned object — the roster
    // is checked against the FUNCTION, not just against a list beside it.
    const returned = Object.keys(paramProps(DEF, 'cutoff'));
    expect(returned.sort()).toEqual([...FORWARDED].sort());
  });

  it('NEGATIVE CONTROL: the field parser SEES a new field, and ignores prose', () => {
    // Without this, the roster gate could be green because the parser returns
    // nothing at all — the exact "a metric blind to the dimension under test
    // returns a clean number" trap.
    const src = `
export interface Thing {
  id: string;
  /** A doc comment whose prose says PURE and total: it must not be a field. */
  units?: string;
  // A line comment: neither is this.
  brandNewProp?: (v: number) => string;
}
`;
    expect(interfaceFields(src, 'Thing')).toEqual(['id', 'units', 'brandNewProp']);
    // …and the real one is not empty, or the classification above compares two
    // empty sets and always passes.
    expect(interfaceFields(typesSource(), 'ParamDef').length).toBeGreaterThan(
      FORWARDED.length,
    );
    expect(interfaceFields(typesSource(), 'ParamDef')).toContain('units');
  });
});
