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
    // ⚠ THE UNCHECKABLE SET IS RATCHETED, NOT ASSERTED TO ZERO — and naming it
    // is the point. A control addressed POSITIONALLY (`def.params[3]`) carries
    // no `paramId` for this scan to key on, so it is not "clean", it is
    // UNMEASURED — the same distinction the `if (!p.edge) continue` hole turned
    // on. 88 such controls exist today (qbrt, reverb and filter are the cards
    // the face-redo ledger names; there are more). The count only shrinks, so a
    // new positional control cannot quietly widen the blind spot.
    //
    // 87 → 88 (2026-08-02): NOT a new blind spot, a MERGE-ORDER correction. This
    // ceiling was calibrated on this gate's own merge base (ef946a3c), where the
    // count measures exactly 87. `b4a7cb95` (warrens-spectrum phase 2, #1308)
    // landed BETWEEN that base and this gate reaching main, adding
    // `WarrensspectrumCard.svelte:182` — so both PRs were green on their own
    // bases and `main` went red on the merge. A COUNT ratchet has no textual
    // conflict, so the post-merge conflict sweep is structurally unable to see
    // this; measuring the base is the only way to tell "stale ceiling" from
    // "real regression", and it was measured (87 at ef946a3c, 88 from b4a7cb95
    // onward, byte-identical to main's own red: defs 194 | cards 193 | 649).
    //
    // That entry is genuinely UNCHECKABLE rather than lazily unlabelled: it is
    // the per-band `<Fader>` whose id is a TEMPLATE (`wsBand${selectedBand}-${f}`,
    // which `controlTags` only reads as a literal) and whose bands live in node
    // DATA (`wsBands`), not `params` — so there is no def param to compare it
    // against, and its min/max already come from ONE place (`bandSpec`), which
    // is what the divergence class this gate guards actually asks for.
    // 89 from the CHROMACONSOLE device card — the SAME class as the wavesculpt
    // entry above, for the same reason. Its slot control is rendered inside an
    // `{#each DEVICE_SLOT_IDS}`, so its `paramId={slotId}` is a loop variable
    // and `controlTags` (which reads only a double-quoted literal) cannot see
    // it. Unrolling the loop into eight literal blocks would duplicate the
    // knob-vs-segmented conditional eight times to satisfy a source grep.
    //
    // It is UNCHECKABLE, not unguarded: every range prop on it comes from
    // `paramSpec(chromaconsoleDef, slotId)` — the def itself — so the card
    // cannot contradict the def by construction, which is precisely what this
    // gate's divergence class asks for. The coverage the grep cannot give is
    // replaced by a direct source assertion in
    // `src/lib/devices/device-card-source.test.ts`, which fails if that card
    // ever hardcodes a numeric range instead of reading the def.
    // 89→87 (2026-08-10): HypercubeCard.svelte was DELETED with the module,
    // taking its 2 uncheckable controls. Read off the ratchet's own report.
    const UNCHECKABLE_CEILING = 87;
    expect(
      blind.length,
      `UNCHECKABLE controls grew — a control with range props but no paramId cannot be ` +
        `compared with its def. Add paramId="<id>". ${summary}\n  ` +
        blind.map((b) => `${b.card}:${b.line}`).join('\n  '),
    ).toBeLessThanOrEqual(UNCHECKABLE_CEILING);
    expect(
      UNCHECKABLE_CEILING - blind.length,
      `uncheckable controls are down to ${blind.length} — lower UNCHECKABLE_CEILING to match`,
    ).toBe(0);
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
