// packages/web/src/lib/ui/modules/card-def-ranges.test.ts
//
// SOURCE-LEVEL GUARD: a legacy card may not RE-TYPE a range its def declares.
//
// This is the one gate shape that can see the failure CLAUDE.md calls out by
// name — "A CARD can silently disagree with its DEF, and every def-reading gate
// is blind to it". BACKDRAFT shipped `<XyPad xMin={-1} xMax={1}>` against a def
// that clamps ±0.2: the pads wrote values the contract forbids, the model
// silently clamped them, most of the stick's travel did nothing, and
// contract-lock / module-docs-lint / every range assertion stayed green,
// because all of them read only the DEF. There is no runtime observation that
// catches it — the card and the def are two sides of a contract and the gates
// only ever read one side. So the check has to be textual, and it has to run
// against the card SOURCE.
//
// A RATCHET, not a sweep. ~70 legacy cards hand-type their ranges today, so a
// repo-wide assertion would be a 70-file migration wearing a test's clothes.
// `CARD_RANGE_CLEAN` is an opt-in allowlist with a frozen floor, exactly like
// STRICT_DOCS / STRICT_FACES / STRICT_VRT_MODULES: promote a card when you
// touch it (the boy-scout rule the living-docs ratchet already runs on), and
// the set can only grow.
//
// THE FIX a promotion requires is `paramProps(def, id)` from card-kit — spread
// it into the control instead of restating the numbers, and the divergence
// stops being detectable because it stops being expressible.
//
// DELIBERATELY BLUNT: it matches the literal anywhere in the file, COMMENTS
// INCLUDED. That is not laziness — a comment restating a range is a second copy
// of the contract with nothing keeping it honest, and it rots exactly like the
// prop did. (Found the hard way: the first draft of VcaCard's own explanatory
// comment quoted the literals it had just removed, and this test caught it.)
//
// Pure fs + regex, no DOM, no registry — `unit` lane, ~0 added CI wall-time.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Cards PROVEN free of re-typed ranges. RATCHET RULE: this list only grows.
 * Raise the floor below when you add one; only lower it for a real, argued
 * un-promotion — never to make a red gate green.
 */
export const CARD_RANGE_CLEAN: readonly string[] = [
  // Batch B face rework: the two Faders now spread `paramProps(vcaDef, …)`.
  'VcaCard',
];

/** Frozen floor for the ratchet (see the rule above). */
const CARD_RANGE_CLEAN_FLOOR = 1;

/**
 * A NUMERIC LITERAL bound to a range prop. Matches `min={0}`, `max={-1}`,
 * `defaultValue={1.0}`, `xMin={-0.2}` … and deliberately NOT `min={p.min}` or
 * `min={baseProps.min}`: an expression is a read from somewhere, and only a
 * literal is a second copy of the contract.
 */
const RETYPED_RANGE =
  /\b(?:x|y)?(?:min|max|defaultValue|default)\s*=\s*\{\s*-?\d+(?:\.\d+)?\s*\}/gi;

function cardSource(basename: string): string {
  return readFileSync(fileURLToPath(new URL(`./${basename}.svelte`, import.meta.url)), 'utf8');
}

describe('card ↔ def ranges — no re-typed numbers in a promoted card', () => {
  it('NEGATIVE CONTROL: the matcher fires on the shape it is meant to catch', () => {
    // Without this the whole suite could be green because the regex matches
    // nothing at all — the "validate the instrument" rule. Both the BACKDRAFT
    // literal form and the plain one must be seen…
    const bad = '<XyPad xMin={-1} xMax={1} /> <Fader min={0} max={1} defaultValue={0} />';
    expect(bad.match(RETYPED_RANGE)).toEqual([
      'xMin={-1}',
      'xMax={1}',
      'min={0}',
      'max={1}',
      'defaultValue={0}',
    ]);
    // …and the def-sourced forms must NOT be, or the gate would forbid the fix
    // it exists to demand.
    const good = '<Fader {...paramProps(vcaDef, \'base\')} /> <Knob min={p.min} max={P.base.max} />';
    expect(good.match(RETYPED_RANGE)).toBeNull();
  });

  for (const card of CARD_RANGE_CLEAN) {
    it(`${card} sources every range from its def`, () => {
      const hits = cardSource(card).match(RETYPED_RANGE) ?? [];
      expect(
        hits,
        `${card}.svelte re-types a range the def already declares. Spread ` +
          `paramProps(def, '<paramId>') from card-kit instead — no gate in this ` +
          `repo can see a card that disagrees with its def, so the numbers have ` +
          `to live in one place by construction.`,
      ).toEqual([]);
    });
  }

  it('CARD_RANGE_CLEAN never shrinks below its frozen floor', () => {
    expect(CARD_RANGE_CLEAN.length).toBeGreaterThanOrEqual(CARD_RANGE_CLEAN_FLOOR);
    expect(new Set(CARD_RANGE_CLEAN).size).toBe(CARD_RANGE_CLEAN.length);
  });
});
