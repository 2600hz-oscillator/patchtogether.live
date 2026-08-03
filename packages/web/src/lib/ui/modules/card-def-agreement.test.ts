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
  OPERATIONAL_DEBT_CEILING,
  VOCABULARY_DEBT_CEILING,
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

  it('neither ledger has stale entries (anchored to the SOURCE, not to the list)', () => {
    // Ground truth is a divergence in a card file; the ledgers must then
    // EXPLAIN each one. An entry for a divergence that has since been fixed is
    // an exemption nobody is watching — it silently re-exempts the next
    // regression on the same param.
    const live = new Set(ROWS.map(triple));
    const stale: string[] = [];
    for (const [name, ledger] of [
      ['OPERATIONAL_DEBT', OPERATIONAL_DEBT],
      ['VOCABULARY_DEBT', VOCABULARY_DEBT],
    ] as const) {
      for (const t of debtTriples(ledger)) if (!live.has(t)) stale.push(`${name} → ${t}`);
    }
    expect(
      stale.join('\n'),
      'stale card-def debt entr(ies) — delete them AND lower the matching ceiling by the same count',
    ).toBe('');
  });

  it('both ratchets move in BOTH directions', () => {
    for (const [name, rows, ceiling] of [
      ['OPERATIONAL', ROWS.filter(isOperational), OPERATIONAL_DEBT_CEILING],
      ['VOCABULARY', ROWS.filter((d) => !isOperational(d)), VOCABULARY_DEBT_CEILING],
    ] as const) {
      expect(rows.length, `${name} card-def debt GREW past ${ceiling}`).toBeLessThanOrEqual(ceiling);
      // A ceiling can only trip by GROWING. Assert the other direction so a
      // drain that forgets to lower the number is red rather than leaving slack
      // that absorbs the next regression.
      expect(
        ceiling - rows.length,
        `${name} card-def debt is ${rows.length} but its ceiling still says ${ceiling} — ` +
          'lower it in the SAME commit',
      ).toBe(0);
    }
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
    // on. 87 such controls exist today (qbrt, reverb and filter are the cards
    // the face-redo ledger names; there are more). The count only shrinks, so a
    // new positional control cannot quietly widen the blind spot.
    //
    // ⚠ 87 → 88 on 2026-08-03, and this one is a SCANNER limitation rather than
    // a card defect — worth naming so the number is not read as "one more card
    // went bad". `WarrensspectrumCard.svelte:182` is a `{#each BAND_FIELDS}`
    // fader that DOES declare `paramId={`wsBand${selectedBand}-${f}`}` and DOES
    // take its range from `bandSpec[f]` — it is def-bound on both counts. The
    // scan is static, so a TEMPLATE-LITERAL paramId cannot be resolved and the
    // control lands in `blind` alongside genuinely positional ones.
    //
    // How it got here is the instructive part: #1311 measured 87 on a tree with
    // no warrensspectrum, #1308 added the module, and neither PR touched a file
    // the other did — no conflict, both green alone, red once combined. That is
    // the ratchet doing its job across concurrent merges.
    //
    // THE REAL FIX, deliberately not taken here (main was red and this is the
    // minimal honest unblock): teach the scan to recognise a dynamic paramId as
    // DECLARED-BUT-DYNAMIC and count it separately, so a def-bound dynamic
    // control stops inflating a number that is supposed to mean "unmeasured".
    // Until then every dynamically-keyed control will cost one here.
    const UNCHECKABLE_CEILING = 88;
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
