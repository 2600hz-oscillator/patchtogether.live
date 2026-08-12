// packages/web/src/lib/ui/modules/card-def-agreement.test.ts
//
// THE TREE-WIDE, DENY-BY-DEFAULT half of "a card can silently disagree with
// its def". Rationale, tiering and the stated blind spots live in
// `card-def-agreement.ts`; the inherited backlog lives in `card-def-debt.ts`.
//
// ── The blind gate this replaces ────────────────────────────────────────────
// `card-range-source.test.ts` guards exactly this bug class and was **OPT-IN BY
// FILENAME**: `RANGE_BOUND_CARDS` named **7** of the repo's **193** cards, so a
// card only got range-checked if somebody remembered to list it. Nobody had
// listed `AnalogVcoCard`, whose `min={0}` on two params the def declares
// `-1..1` therefore sailed through the guard written for its exact failure.
//
// That guard is not wrong and it is not replaced — it asks the STRONGER
// question ("is the divergence unrepresentable?") and stays an opt-in ratchet
// because answering it means converting a card. This file asks the question
// every card can be held to today ("does the restated number AGREE?") and asks
// it of all of them.
//
// Registry-driven: the card for each def is resolved by the SAME rule the app
// uses (`def.card` override, else `PascalCase(type)Card`), so a new module
// auto-enrols with zero edits here.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';

import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';

import {
  scanCardDefDivergence,
  uncheckableControls,
  namesParamByExpression,
  cardBasename,
  controlTags,
  OPERATIONAL_FIELDS,
  type DefLike,
  type Divergence,
} from './card-def-agreement';
import {
  OPERATIONAL_DEBT,
  VOCABULARY_DEBT,
  debtTriples,
} from './card-def-debt';

const allDefs = (): DefLike[] =>
  [...listModuleDefs(), ...listVideoModuleDefs(), ...listMetaModuleDefs()] as unknown as DefLike[];

const readCard = (basename: string): string | null => {
  const p = fileURLToPath(new URL(`./${basename}`, import.meta.url));
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
};

const DEFS = allDefs();
const ROWS = scanCardDefDivergence(DEFS, readCard);
const isOperational = (d: Divergence) => (OPERATIONAL_FIELDS as readonly string[]).includes(d.field);

/** `card:param.field` — the key both ledgers use. */
const triple = (d: Divergence) => `${d.card}:${d.paramId}.${d.field}`;

function unledgered(rows: Divergence[], ledger: Readonly<Record<string, readonly string[]>>): string[] {
  const known = new Set(debtTriples(ledger));
  return rows
    .filter((d) => !known.has(triple(d)))
    .map((d) => `${d.card}:${d.line}  ${d.type}.${d.paramId} ${d.field}: card=${JSON.stringify(d.card_)} def=${JSON.stringify(d.def_)}`)
    .sort();
}

describe('card ↔ def AGREEMENT (deny-by-default across every registered card)', () => {
  it('no card contradicts its def on an OPERATIONAL field (min/max/defaultValue/curve)', () => {
    // These four decide what values a control CAN WRITE and how its travel
    // MAPS. A disagreement is the backdraft bug in one direction (the pad wrote
    // values the contract forbids) or in the other (the def declares travel the
    // knob cannot reach — analogVco's bipolar FM index, unreachable from the
    // card while the def-driven dock face had all of it).
    expect(
      unledgered(ROWS.filter(isOperational), OPERATIONAL_DEBT).join('\n'),
      'a card control disagrees with its def about what it can WRITE or how it MAPS. ' +
        "Bind the prop to the def — paramSpec(def, '<id>').min etc. — never re-type it. " +
        'If the fix is a behaviour change that needs its own PR, add the exact ' +
        '`<param>.<field>` to OPERATIONAL_DEBT in card-def-debt.ts WITH A REASON.',
    ).toBe('');
  });

  it('no card contradicts its def on a VOCABULARY field (label/units)', () => {
    // The ringback `FB`-vs-`Feedback` / snaredrum `Tone`-×3 class: one control
    // named differently by the card, the rear jack and the doc page. Not
    // audible, but a two-sided contract all the same — and the reason every
    // fix here is deferred is that each one repaints a card and moves a VRT
    // baseline, not that it does not matter.
    expect(
      unledgered(ROWS.filter((d) => !isOperational(d)), VOCABULARY_DEBT).join('\n'),
      'a card control names itself differently from its def. Bind it — ' +
        "paramSpec(def, '<id>').label / .units — or add the exact `<param>.<field>` to " +
        'VOCABULARY_DEBT in card-def-debt.ts.',
    ).toBe('');
  });

  it('the ledgers and the SOURCE are the SAME SET — anchored both ways, and counted neither way', () => {
    // Ground truth is a divergence in a card file; the ledgers must then
    // EXPLAIN each one, and an entry for a divergence that has since been fixed
    // is an exemption nobody is watching — it silently re-exempts the next
    // regression on the same param.
    //
    // ⚠ THIS ABSORBED "both ratchets move in BOTH directions" (2026-08-11).
    // That test asserted `actual <= CEILING` and `CEILING - actual === 0`
    // against two hand-typed literals in `card-def-debt.ts`; both constants are
    // deleted under CLAUDE.md's standing "NEVER hand-type a population count"
    // directive, which names this file's ledger in the surviving legacy tail
    // and says to remove the counter when you touch it. The trace of what each
    // number protected is kept where the constants stood, per the #1458 rule.
    //
    // Nothing is lost, and the reason is that the count was never the check:
    // GROWTH is already red on its own terms in the two deny-by-default clauses
    // above (an unledgered divergence fails there, with the card, line, param
    // and both values in the message — strictly more than "6 became 7"), and a
    // forgotten DRAIN is the stale half below. What the two numbers were
    // standing in for is one property, stated here with no arithmetic: the set
    // of live divergences and the set of ledger entries are THE SAME SET.
    const live = new Set(ROWS.map(triple));
    const ledgers = [
      ['OPERATIONAL_DEBT', OPERATIONAL_DEBT],
      ['VOCABULARY_DEBT', VOCABULARY_DEBT],
    ] as const;
    const ledgered = new Map<string, string>();
    for (const [name, l] of ledgers) for (const t of debtTriples(l)) ledgered.set(t, name);

    expect(
      [...live].filter((t) => !ledgered.has(t)).sort(),
      'card↔def divergence with NO ledger entry — bind the prop to the def, or add the exact ' +
        '`<param>.<field>` to card-def-debt.ts WITH THE REASON it cannot be bound yet',
    ).toEqual([]);
    expect(
      [...ledgered].filter(([t]) => !live.has(t)).map(([t, n]) => `${n} → ${t}`).sort(),
      'stale card-def debt entr(ies) — the divergence is gone, so delete the entry. ' +
        '(There is no longer a ceiling to lower with it.)',
    ).toEqual([]);
  });

  it('COVERAGE is reported, not assumed — and the scan is not vacuous', () => {
    // ⚠ A BARE GREEN IS WHAT LET THE OPT-IN VERSION HIDE. Print what was
    // actually looked at, and floor it: a scan that resolved no cards, or found
    // no control tags, is INDISTINGUISHABLE from a clean tree otherwise.
    const resolved = DEFS.filter((d) => readCard(cardBasename(d)) !== null);
    let checkedControls = 0;
    for (const def of resolved) {
      const src = readCard(cardBasename(def))!;
      for (const t of controlTags(src)) {
        if (t.paramId && def.params?.some((p) => p.id === t.paramId)) checkedControls++;
      }
    }
    const blind = uncheckableControls(resolved, readCard);
    const summary =
      `defs ${DEFS.length} | cards resolved ${resolved.length} | ` +
      `def-backed control tags checked ${checkedControls} | ` +
      `controls with NO paramId (positional indexing — uncheckable) ${blind.length}`;

    expect(resolved.length, `card resolution collapsed. ${summary}`).toBeGreaterThan(150);
    expect(checkedControls, `no def-backed control tag found at all. ${summary}`).toBeGreaterThan(500);
    // ⚠ THE UNCHECKABLE SET IS SPLIT BY CAUSE AND THE REAL DEFECT IS HELD AT
    // ZERO. It used to be a `UNCHECKABLE_CEILING = 87` ratcheted from both
    // sides; that literal is gone (2026-08-12, the no-ratchets sweep). Naming
    // the set is still the point — an unmeasured control must not read as a
    // clean one — but the number was the wrong instrument, and measurement is
    // what showed why.
    //
    // MEASURED, on the tree the day the ceiling was deleted: all 87 blind
    // controls carry `paramId={expression}`. NOT ONE is positionally indexed.
    // So the ceiling was capping a population of controls that DO name their
    // param — a loop variable (`ch${ch}_volume`) or a template
    // (`wsBand${b}-${f}`) that `controlTags` cannot resolve because it reads
    // only a double-quoted literal — while the defect it was written for, a
    // control that names its param NOWHERE, has a population of zero.
    //
    // A zero is assertable. So it is asserted, unconditionally, below.
    //
    // WHAT THE OLD CEILING ALSO DID AND THIS DOES NOT: cap growth in the
    // EXPRESSION-BOUND population. That protection is dropped deliberately and
    // named in the sweep PR's body. It was worth little and cost a lot: the
    // ceiling had already gone red once on `main` through nobody's error — two
    // PRs green on their own bases, 87 at one merge-base and 88 after a sibling
    // landed, with no textual conflict for the post-merge sweep to see (the
    // note that used to live here recorded exactly that). And it was never the
    // real guard for these controls anyway: 61 of the 87 hardcode a numeric
    // range, which is `card-range-source`'s subject and is being drained there
    // through `RANGE_BOUND_CARDS` — a NAMED, artifact-anchored campaign that
    // this count was silently substituting for.
    const positional = blind.filter((b) => !namesParamByExpression(b.props));
    expect(
      positional.map((b) => `${b.card}:${b.line}`),
      `control(s) with range props that name their param NOWHERE — positional ` +
        `indexing (\`def.params[3]\`). Nothing can compare these with the def. Give each ` +
        `a \`paramId\` (a literal if you can, an expression if it is a loop/template). ` +
        `${summary}`,
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL: the paramId-shape predicate separates the two causes', () => {
    // The assertion above is `toEqual([])` over a filtered set, so a predicate
    // that returned "expression-bound" for EVERYTHING would be permanently,
    // silently green — the exact failure this file's sibling guards had. It
    // calls the SAME exported predicate the check calls.
    expect(
      namesParamByExpression('paramId={`ch${ch}_volume`} min={0} max={1}'),
      'a template-bound paramId is EXPRESSION-bound',
    ).toBe(true);
    expect(
      namesParamByExpression('paramId={pid} value={v}'),
      'a loop-variable paramId is EXPRESSION-bound',
    ).toBe(true);
    expect(
      namesParamByExpression('min={0} max={1} value={v} onchange={set(3)}'),
      'a control with NO paramId at all is POSITIONAL — it must not read as excused',
    ).toBe(false);
    expect(
      namesParamByExpression('paramId="gain" min={0} max={1}'),
      'a LITERAL paramId is neither — controlTags resolves it, so it never reaches this set',
    ).toBe(false);
  });

  it('NEGATIVE CONTROL: the comparison fires on each field, and not otherwise', () => {
    // ⚠ Perturb the thing the instrument claims to measure and confirm the
    // number MOVES — permanently, on every run, in BOTH directions. A textual
    // comparison that silently stopped matching would look exactly like a
    // codebase with no divergences.
    const def: DefLike = {
      type: 'probe',
      card: 'ProbeCard',
      params: [
        { id: 'a', label: 'Amount', min: -1, max: 1, defaultValue: 0, curve: 'log', units: 's' },
      ],
    };
    const scan = (markup: string) =>
      scanCardDefDivergence([def], () => markup).map((d) => d.field).sort();

    // (a) EVERY field disagreeing → every field reported. This is the backdraft
    //     shape (`min={0}` against a def of −1) plus its four siblings.
    expect(
      scan('<Fader paramId="a" min={0} max={2} defaultValue={0.5} curve="linear" units="ms" label="Amt" />'),
    ).toEqual(['curve', 'defaultValue', 'label', 'max', 'min', 'units']);

    // (b) The SAME markup with every value agreeing → silent. (If this ever
    //     started reporting, the gate would be crying wolf and would be turned
    //     off — which is how a gate dies.)
    expect(
      scan('<Fader paramId="a" min={-1} max={1} defaultValue={0} curve="log" units="s" label="Amount" />'),
    ).toEqual([]);

    // (c) A DEF-BOUND card — the state this gate is steering toward — is
    //     silent because there is no literal to compare, not because the scan
    //     broke.
    expect(scan('<Fader paramId="a" min={p.min} max={p.max} curve={p.curve} label={p.label} />')).toEqual([]);

    // (d) The PREFIXED forms. `xMin`/`valueMax` mean the same thing to the
    //     control underneath; a pattern that only knew `min`/`max` is how a
    //     source-level guard quietly stops guarding (the exact narrowing that
    //     card-range-source.test.ts's own header warns about).
    expect(scan('<XyPad paramId="a" xMin={0} yMax={2} />').sort()).toEqual(['max', 'min']);

    // (e) NO paramId → nothing is checked at all. This is the stated blind
    //     spot, asserted rather than described, so it cannot quietly widen.
    expect(scan('<Fader min={0} max={2} curve="linear" />')).toEqual([]);

    // (f) An UNDECLARED def curve is `linear`, so a card saying so agrees.
    const noCurve: DefLike = { type: 'p2', card: 'P2Card', params: [{ id: 'a', min: 0, max: 1 }] };
    expect(scanCardDefDivergence([noCurve], () => '<Fader paramId="a" curve="linear" />')).toEqual([]);
    expect(
      scanCardDefDivergence([noCurve], () => '<Fader paramId="a" curve="log" />').map((d) => d.field),
    ).toEqual(['curve']);
  });

  it('NEGATIVE CONTROL: the REAL analogVco regression is caught if it comes back', () => {
    // The instrument is negative-controlled against the ACTUAL def in the
    // registry, not a synthetic one — so a def-side change that made the bug
    // un-reintroducible would show up here as a failure to reproduce it.
    const analogVco = DEFS.find((d) => d.type === 'analogVco');
    expect(analogVco, 'analogVco is registered').toBeTruthy();
    const rows = scanCardDefDivergence(
      [analogVco!],
      () => '<Fader paramId="fmAmount" min={0} max={1} />', // the shipped bug, verbatim
    );
    expect(
      rows.map((r) => `${r.field}:${r.card_}→${r.def_}`),
      'the card said min=0 where the def says min=-1 — this must be caught',
    ).toEqual(['min:0→-1']);
    // …and the card as it stands today is clean on that param.
    expect(
      ROWS.filter((d) => d.card === 'AnalogVcoCard.svelte' && isOperational(d)),
      'AnalogVcoCard has no operational divergence left',
    ).toEqual([]);
  });
});
