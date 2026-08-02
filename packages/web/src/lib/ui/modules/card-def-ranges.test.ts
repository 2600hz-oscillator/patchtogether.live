// packages/web/src/lib/ui/modules/card-def-ranges.test.ts
//
// SOURCE-LEVEL GUARD: a legacy card may not RE-TYPE anything its def declares
// about a param — not the RANGE, and not the VOCABULARY (label / curve / units
// / options).
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
// ── WHAT IT SEES, AND WHAT IT DOES NOT ──────────────────────────────────────
//
// The first draft matched only a BRACED NUMERIC bound to min/max/default. That
// is one of the four ways a card can disagree with its def, and the header
// claimed all of them. A card could still ship `curve="exp"` against a `linear`
// def (the whole knob taper wrong) or `label="CV Amt"` against `'CV amt'` — the
// exact drift this very PR removed — and stay on the allowlist. Two matchers
// now, and the SECOND is scoped to tags that bind a param:
//
//   A. RANGE (file-wide): a numeric literal on min / max / defaultValue /
//      default, braced OR quoted (`min={0}`, `min="0"`, `xMin={-0.2}`).
//   B. VOCABULARY (scoped to a tag carrying `paramId`): a literal on label /
//      curve / units / options. Tag-scoped because `label="RESET"` on a plain
//      Button, or `defaultLabel="VCA"` on ModuleTitle, is NOT a def claim —
//      only a control bound to a param id is making one.
//
// STILL OUT OF SCOPE, stated rather than implied:
//   * a control that binds a param through a variable the file computes
//     elsewhere (`const c = 'exp'; <Knob curve={c} …>`) — an expression is a
//     read, and this gate cannot tell a read of the def from a read of a lie;
//   * an INLINE FORMATTER (`format={(v) => …}`) shadowing a `ParamDef.format`.
//     B's shapes are all literals, and a function body is not one;
//   * `step`, `trackHeight`, `size`, and every other purely-presentational
//     prop — `ParamDef` does not declare them, so there is nothing to disagree
//     WITH;
//   * a card that OMITS a prop the def declares (a def with `units: 'Hz'` and a
//     card that never passes units). ⚠ THIS GATE IS STRUCTURALLY BLIND TO IT
//     and cannot be fixed here: a card that spreads `paramProps(def, id)` and a
//     card that spreads an object missing half the def's vocabulary are
//     TEXTUALLY IDENTICAL. "`paramProps` closes it by construction" was the
//     round-1 claim and it was a comment, not a gate — nothing asserted the
//     function forwarded anything, so deleting `units: p.units` from it would
//     have kept every check in this repo green. The omission half now lives in
//     `card-kit.test.ts`, which pins what `paramProps` must forward and makes
//     the roster derive from `ParamDef`'s own field list. Re-typing and
//     dropping are opposite halves of one contract; each needs its own gate.
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
// MATCHER A IS DELIBERATELY BLUNT: it matches the literal anywhere in the file,
// COMMENTS INCLUDED. That is not laziness — a comment restating a range is a
// second copy of the contract with nothing keeping it honest, and it rots
// exactly like the prop did. (Found the hard way: the first draft of VcaCard's
// own explanatory comment quoted the literals it had just removed, and this
// test caught it.)
//
// Pure fs + regex, no DOM, no registry — `unit` lane, ~0 added CI wall-time.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Cards PROVEN free of re-typed def claims. RATCHET RULE: this list only grows.
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
 * MATCHER A — a NUMERIC LITERAL bound to a range prop. Matches `min={0}`,
 * `max={-1}`, `defaultValue={1.0}`, `xMin={-0.2}`, and the quoted-attribute
 * form `min="0"` … and deliberately NOT `min={p.min}` or `min={baseProps.min}`:
 * an expression is a read from somewhere, and only a literal is a second copy
 * of the contract.
 */
const RETYPED_RANGE =
  /\b(?:x|y)?(?:min|max|defaultValue|default)\s*=\s*(?:\{\s*-?\d+(?:\.\d+)?\s*\}|"\s*-?\d+(?:\.\d+)?\s*"|'\s*-?\d+(?:\.\d+)?\s*')/gi;

/**
 * MATCHER B — a LITERAL bound to a def-owned VOCABULARY prop. `label`, `curve`
 * and `units` as a quoted attribute or a braced string literal; `options` as a
 * braced array literal. Applied only INSIDE a tag that carries `paramId` (see
 * `paramBoundTags`), so a non-param control's own label is not a false hit.
 *
 * `\blabel` will not fire on `defaultLabel=` — there is no word boundary
 * between `t` and `L` — which is the ModuleTitle case in VcaCard.
 */
const RETYPED_VOCAB =
  /\b(?:label|curve|units|options)\s*=\s*(?:"[^"]*"|'[^']*'|\{\s*(?:"[^"]*"|'[^']*'|`[^`]*`)\s*\}|\{\s*\[)/gi;

/**
 * Every `<Tag …>` in the source that binds a param id — i.e. every control
 * whose props are CLAIMS ABOUT A DEF PARAM. Returns the raw tag text so
 * MATCHER B can be scoped to it.
 */
export function paramBoundTags(source: string): string[] {
  return (source.match(/<[A-Za-z][^<>]*>/g) ?? []).filter((tag) => /\bparamId\s*=/.test(tag));
}

function cardSource(basename: string): string {
  return readFileSync(fileURLToPath(new URL(`./${basename}.svelte`, import.meta.url)), 'utf8');
}

describe('card ↔ def — no re-typed def claims in a promoted card', () => {
  it('NEGATIVE CONTROL: matcher A fires on every RANGE shape it claims', () => {
    // Without this the whole suite could be green because the regex matches
    // nothing at all — the "validate the instrument" rule. Both the BACKDRAFT
    // literal form, the plain one, and the quoted-attribute form must be seen…
    const bad =
      '<XyPad xMin={-1} xMax={1} /> <Fader min={0} max={1} defaultValue={0} /> <Knob min="0" max=\'2.5\' />';
    expect(bad.match(RETYPED_RANGE)).toEqual([
      'xMin={-1}',
      'xMax={1}',
      'min={0}',
      'max={1}',
      'defaultValue={0}',
      'min="0"',
      "max='2.5'",
    ]);
    // …and the def-sourced forms must NOT be, or the gate would forbid the fix
    // it exists to demand.
    const good = '<Fader {...paramProps(vcaDef, \'base\')} /> <Knob min={p.min} max={P.base.max} />';
    expect(good.match(RETYPED_RANGE)).toBeNull();
  });

  it('NEGATIVE CONTROL: matcher B fires on every VOCABULARY shape it claims', () => {
    // The four ways a card lies about a param WITHOUT touching a number. Each
    // one is a real, shipped-elsewhere shape: a curve makes the whole taper
    // wrong, a label is the `CV Amt` / `CV amt` drift this PR removed.
    const bad =
      '<Knob paramId="cutoff" label="CV Amt" curve="exp" units=\'Hz\' options={[{v:0}]} step={0.01} />';
    const hits = paramBoundTags(bad).flatMap((t) => t.match(RETYPED_VOCAB) ?? []);
    expect(hits).toEqual(['label="CV Amt"', 'curve="exp"', "units='Hz'", 'options={[']);

    // Def-sourced + spread forms stay clean.
    const good = '<Knob paramId="cutoff" {...paramProps(def, \'cutoff\')} label={p.label} />';
    expect(paramBoundTags(good).flatMap((t) => t.match(RETYPED_VOCAB) ?? [])).toEqual([]);
  });

  it('NEGATIVE CONTROL: matcher B is SCOPED — a non-param label is not a def claim', () => {
    // The scope is the whole reason B can include `label` at all. A Button that
    // is not a param, and ModuleTitle's `defaultLabel`, must not be hits — else
    // the gate would block promotions for cards that are perfectly honest.
    const honest =
      '<ModuleTitle {id} defaultLabel="VCA" /> <Button label="RESET" /> <Fader paramId="base" {...baseProps} />';
    expect(paramBoundTags(honest)).toEqual(['<Fader paramId="base" {...baseProps} />']);
    expect(paramBoundTags(honest).flatMap((t) => t.match(RETYPED_VOCAB) ?? [])).toEqual([]);
    // …and the un-scoped matcher WOULD have flagged them, which is what makes
    // the scoping load-bearing rather than decorative.
    expect(honest.match(RETYPED_VOCAB)).toEqual(['label="RESET"']);
  });

  for (const card of CARD_RANGE_CLEAN) {
    it(`${card} sources every RANGE from its def`, () => {
      const hits = cardSource(card).match(RETYPED_RANGE) ?? [];
      expect(
        hits,
        `${card}.svelte re-types a range the def already declares. Spread ` +
          `paramProps(def, '<paramId>') from card-kit instead — no gate in this ` +
          `repo can see a card that disagrees with its def, so the numbers have ` +
          `to live in one place by construction.`,
      ).toEqual([]);
    });

    it(`${card} sources every param LABEL / CURVE / UNITS / OPTIONS from its def`, () => {
      const tags = paramBoundTags(cardSource(card));
      expect(tags.length, `${card}.svelte binds at least one param control`).toBeGreaterThan(0);
      const hits = tags.flatMap((t) => t.match(RETYPED_VOCAB) ?? []);
      expect(
        hits,
        `${card}.svelte re-types param VOCABULARY the def already declares. A ` +
          `curve makes the taper disagree with the contract and a label makes ` +
          `the card and the docs print different words for the same knob — both ` +
          `invisible to every def-reading gate. Spread paramProps(def, '<id>').`,
      ).toEqual([]);
    });
  }

  it('CARD_RANGE_CLEAN never shrinks below its frozen floor', () => {
    expect(CARD_RANGE_CLEAN.length).toBeGreaterThanOrEqual(CARD_RANGE_CLEAN_FLOOR);
    expect(new Set(CARD_RANGE_CLEAN).size).toBe(CARD_RANGE_CLEAN.length);
  });
});
