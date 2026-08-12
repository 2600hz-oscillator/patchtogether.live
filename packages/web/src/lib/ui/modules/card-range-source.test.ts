// packages/web/src/lib/ui/modules/card-range-source.test.ts
//
// THE SOURCE-LEVEL GUARD FOR "A CARD CAN SILENTLY DISAGREE WITH ITS DEF".
//
// The bug this exists for (backdraft, 2026-07-28): the def constrained
// `camTiltX/Y` to ±0.2 and `camPosX/Y` to ±0.5; the card passed literal
// `xMin={-1} xMax={1}` to both XyPads. The pads WROTE VALUES THE CONTRACT
// FORBIDS, the model silently clamped them, and most of the stick's travel did
// nothing. `contract-lock`, `module-docs-lint` and every range assertion in the
// suite passed — because all of them read the DEF, and none of them can see the
// card. A gate that reads one side of a two-sided contract proves nothing about
// the other side.
//
// There is no runtime gate that CAN see this (rendering a card and reading back
// its props would need a DOM harness per card, and the divergence is invisible
// in pixels), so the check is textual and lives here — the same shape as
// module-docs-lint's `controlFamilies` → card-testid grep, which exists for
// this same divergence class.
//
// NOT A SWEEP: 133 of the 215 card sources still re-type at least one range
// number, so this set names the cards that have been converted. Bring a card in
// when you touch it (boy-scout), by routing its range/curve/default props
// through the def — `paramSpec(def, id)` in card-kit, or the card's own
// `pmin/pmax/pdef` helpers.
//
// ⚠ STATED SCOPE, MEASURED 2026-08-10. This gate reads 13 of 215 card sources.
// The other 202 are NOT checked for def-binding at all. This paragraph is PROSE,
// not an assertion — the population is deliberately no longer counted anywhere
// (see the note on the floors below), so treat the figures as of their date and
// re-measure rather than trusting them.
//
// ⚠ THE TWO RATCHET FLOORS ARE GONE (2026-08-10). `RANGE_BOUND_FLOOR` and
// `MAPPING_BOUND_FLOOR` were hand-typed copies of `RANGE_BOUND_CARDS.length` /
// `MAPPING_BOUND_CARDS.length`, and they auto-merged WRONG in FIVE separate
// face merges — a full card of silent slack each time.
//
//   The fifth is the one that settles the argument, so it is recorded here
//   rather than left in the deleted block's history. cube and main BOTH read
//   `12 / 10` — cube's count correct for cube+clouds, main's correct for
//   clouds+cofefve — and because the two literals were IDENTICAL AS TEXT, git
//   presented them as already resolved. No conflict, no warning, and the true
//   union was THIRTEEN and ELEVEN.
//
//   That is the pure form: the previous four surfaced only because an adjacent
//   COMMENT happened to differ, which is luck, not a mechanism. And in the
//   fourth, clouds and cofefve had EACH counted correctly for their own tree
//   and each written `11 / 9` — two authors both obeying the rule, still
//   producing a wrong merged value. A number that is right when written and
//   wrong when merged, through nobody's error, cannot be fixed by discipline.
//
// They are replaced by an ARTIFACT ANCHOR
// ('every def-bound card is enrolled', below) that derives the same
// only-grows protection from the card sources themselves, so there is no
// literal for a merge to get right or wrong.
//   WHAT WAS LOST, precisely: a card can now be un-bound (re-type its ranges)
//   and dropped from these lists in one commit without a number going red. The
//   anchor catches the drop-only half — a card that still binds via paramSpec
//   and is not listed is RED — but not the deliberate regression. That is the
//   pre-authorised coverage loss of the kill-ratchets PR, recorded here rather
//   than in a commit message.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adsrDef } from '$lib/audio/modules/adsr';
import { backdraftDef } from '$lib/video/modules/backdraft';
import { chromaconsoleDef } from '$lib/audio/modules/chromaconsole';
import { cubeDef } from '$lib/audio/modules/cube';
import { cloudsDef } from '$lib/audio/modules/clouds';
import { cofefveDelayDef } from '$lib/audio/modules/cofefve';
import { delayDef } from '$lib/audio/modules/delay';
import { macrooscillatorDef } from '$lib/audio/modules/macrooscillator';
import { marblesDef } from '$lib/audio/modules/marbles';
import { noiseDef } from '$lib/audio/modules/noise';
import { filterDef } from '$lib/audio/modules/filter';
import { meowboxDef } from '$lib/audio/modules/meowbox';
import { resofilterDef } from '$lib/audio/modules/resofilter';
import { ringbackDef } from '$lib/audio/modules/ringback';
import { ringsDef } from '$lib/audio/modules/rings';
import { snaredrumDef } from '$lib/audio/modules/snaredrum';
import { vcaDef } from '$lib/audio/modules/vca';
import { warrensspectrumDef } from '$lib/audio/modules/warrensspectrum';
import type { ParamDef } from '$lib/graph/types';

/**
 * Cards whose control RANGES are bound to the def, and the def each one reads.
 * ONLY GROWS.
 *  - BackdraftCard: the named regression above (binds via pmin/pmax/pdef).
 *  - AdsrCard: converted with the adsr face rework (binds via paramSpec).
 *  - VcaCard: converted with the vca face rework (binds via paramSpec). Its
 *    `base` knob is the format case in miniature — the def declares
 *    `formatVcaBase`, so the face prints `CLOSED` / `-12 dB` / `UNITY`, and
 *    before the conversion the card's value tag on the same param printed
 *    `0.25`. One param, two laws, and no def-reading gate could see it.
 *  - DelayCard: converted with the delay face rework (binds via paramSpec).
 *    It is the first entry here whose re-typing had ALREADY DIVERGED rather
 *    than merely being able to: the middle fader was captioned `Fb` while the
 *    def declares `Feedback`, so one control carried two names depending on
 *    which surface you read. The nine range literals beside it all still
 *    agreed — which is exactly how this class hides.
 *  - FilterCard: converted with the filter face re-do (binds via paramSpec).
 *    It carried a FOURTH divergence shape none of the clauses below can see on
 *    its own: a private `const MODES = ['LP','HP','BP']` beside a def that
 *    declares the identical roster in `params.mode.options`. That is a second
 *    source of truth for a VOCABULARY rather than for a range — the dock's
 *    Segmented reads the def, the card read its own array, and the day the two
 *    disagree the same control names three states two ways. The card now maps
 *    the def's `options`. Its positional `filterDef.params[0]!` indexing went
 *    with it: a `params` reorder would have silently rebound two defaults.
 *  - RingbackCard: converted with the ringback face promotion. It is the first
 *    KNOB-based card in this set, which is why `Knob.svelte` had to grow the
 *    `formatValue` prop `Fader.svelte` already had — the format clause below
 *    is unsatisfiable for a Knob card without it. It also carried a THIRD
 *    divergence neither grep can see: its caption said `FB` where the def says
 *    `Feedback`, so the card, the rear jack and the doc page named one control
 *    three ways. Labels are now bound too.
 *  - SnaredrumCard: converted with the snaredrum face rework (binds via
 *    paramSpec). The biggest single conversion so far — 21 continuous params,
 *    every one of which re-typed min/max/curve/units. All 21 AGREED with the
 *    def, so nothing was broken; the LABELS did not — the same
 *    two-sided-contract hole one field over that RingbackCard's `FB` is an
 *    instance of, and here it bit three times at once: the card painted the
 *    literal string 'Tone' on `tone`, `wire_tone` AND `crack_tone` (the def
 *    declares 'Tone' / 'W Tone' / 'Ck Tone'), plus 'Wire' where the def says
 *    'Wires'. TWO cards in one day, found independently — the label half of
 *    this contract is worth its own grep.
 *  - WarrensspectrumCard: BORN bound (2026-08-02) rather than converted —
 *    the first card in this set that never re-typed anything, because the
 *    module shipped after this guard existed. 11 params × 5 props is 55
 *    numbers/strings that now cannot disagree with the def by construction.
 *    Its `engineFreeze` is the format case again: the def declares a
 *    LIVE/FREEZE formatter, and an unbound card would print `0.00`/`1.00`
 *    on a control whose whole job is to say which state you are in.
 *  - MacrooscillatorCard: converted with the macrooscillator face promotion
 *    (binds via paramSpec). Six params × five props, all of which AGREED with
 *    the def — the card even imported the def and carried its own
 *    `defaultFor()` helper while re-typing all thirty numbers beside it. The
 *    interesting half is the `model` fader: it re-typed `max` from a LOCAL
 *    `MODEL_NAMES.length - 1`, so "how many engines are there" had a second
 *    answer living in the card, and adding a fifteenth engine to the def would
 *    have left this fader unable to select it. The array is gone (see
 *    macro-engine-roster) and `max` now comes from the def like everything
 *    else.
 *  - MeowboxCard: converted with the meowbox face (2026-08-08). Range- but NOT
 *    mapping-bound, and the split is deliberate rather than half-done. Its 12
 *    range numbers and 4 curves are bound; its `units` are NOT, because the def
 *    says `semi` where the card paints `st` and the def says `Ptch`/`Dcy`/`Lvl`
 *    where the card paints `Pitch`/`Decay`/`Level` — four real divergences,
 *    already named in `card-def-debt.ts`. Binding them REPAINTS a card in
 *    `STRICT_VRT_MODULES`, i.e. the required `vrt-strict` gate on both
 *    platforms, so that vocabulary fix gets its own PR instead of riding a face.
 *    The clause below keeps the unbound half honest in the meantime.
 *  - CubeCard: converted with the cube face (2026-08-10), range AND mapping in
 *    one step. It was HALF bound already, and the half it was missing is the
 *    instructive one: it resolved `min`/`max`/`defaultValue` through local
 *    `minFor()`/`maxFor()`/`defaultFor()` helpers that read the def — genuinely
 *    correct — and then re-typed `label`, `units` and `curve` beside them in
 *    three private arrays (`KNOBS`, `VIEW_KNOBS`, `ADSR_KNOBS`), including a
 *    `curve={k.pid === 'view_zoom' ? 'log' : 'linear'}` TERNARY reproducing the
 *    def's own curve assignment as a card-side rule. All 23 controls agreed, so
 *    nothing was broken — but "the ranges come from the def, the mapping comes
 *    from a ternary" is a card one def edit away from disagreeing with itself,
 *    with no gate able to see it. The three arrays are now id lists resolved
 *    through `paramSpec`.
 *  - CloudsCard: converted with the clouds face promotion (2026-08-10; binds
 *    via paramSpec). Range AND mapping bound — the card's six faders re-typed
 *    30 numbers plus six `curve`s and one `units`, all of which AGREED, and it
 *    is the `units` that makes the conversion worth more than tidiness: the def
 *    declares `units: 'st'` on `pitch` ALONE, so five of the six faders were
 *    hand-typing "no units" by omission. An omitted prop and a bound `undefined`
 *    read identically today and diverge the day any of those five gains a unit
 *    on the def — the omission is invisible to both greps, which only ever see
 *    what a card DOES write.
 *  - MarblesCard: converted with the marbles face promotion (2026-08-11). It
 *    carried NINE literal min/max pairs, the most of any card left unbound in
 *    its batch, and gained the two params it had never had a control for
 *    (`pw_mean`, `x_deja_vu`) in the same commit.
 *  - NoiseCard: converted with the noise face promotion (2026-08-10; binds via
 *    paramSpec). Range AND mapping bound, and it is the SMALLEST instance of
 *    the class — ONE fader re-typing four numbers (`min` `max` `defaultValue`
 *    `curve`) that its own def already declares, on the same screen as a line
 *    that correctly read `noiseDef.params[0]!.defaultValue`. Half the card was
 *    already bound; the divergence hazard lived entirely in the other half.
 *  - CofefveCard: converted with the cofefve face promotion (2026-08-10), and
 *    the largest re-typing this set has absorbed — 34 literal range props over
 *    19 controls, including a `curve="log"` on a `0.001..2 s` TIME knob where a
 *    mistyped `linear` would have moved the dial's midpoint by three orders of
 *    magnitude. All 34 AGREED with the def; the point is that nothing could
 *    have told you if they had not. Its `driveIterations` slider is a NATIVE
 *    `<input type=range>`, whose `min="1" max="16"` STRING attributes the
 *    `min={…}` grep is structurally unable to see — bound anyway, because a
 *    gate's blind spot is not a licence to leave a second copy of a number.
 *  - ResofilterCard: converted with the resofilter face promotion (2026-08-11;
 *    binds via paramSpec). Range AND mapping bound — and it is the entry that
 *    shows why the two halves cannot be separated even when you want them to
 *    be. The conversion was FIRST attempted as range-only, on the reasoning
 *    that its MODE knob passes `curve="linear"` where the def says `discrete`
 *    and `Knob.svelte` branches on `log`/`exp` alone, so binding the prop makes
 *    a gate green and moves no pixel — CLAUDE.md's "check the consumer reads
 *    it", and this is one of the four cards that warning names. The
 *    curve-AGREEMENT clause below caught that immediately and correctly: a
 *    range-bound card is certified def-bound, and "the disagreement is
 *    currently harmless" is exactly the argument that lets one become harmful.
 *    So all four `curve`s and the one `units` are bound, three of them
 *    meaningfully and MODE's not at all, with the no-op stated on the card
 *    rather than left for someone to rediscover. What the binding does NOT do
 *    is make MODE detented; that needs the primitive, and the five-state
 *    Segmented the def now declares `options` for moves this card's pixels
 *    (#1213 measured 865 px for the same swap on filter — UNDER
 *    `DOCK_MAX_DIFF`, so invisible to the VRT gate AND unrepinnable by
 *    `--update-snapshots`). Its own PR, with an owner preview and a `git rm`.
 *  - ChromaconsoleCard: NOT converted — found ALREADY BOUND and simply never
 *    enrolled (2026-08-10). It reads every slot bound off
 *    `paramSpec(chromaconsoleDef, slotId)` and re-types nothing, so it has been
 *    passing all three clauses for free while sitting outside the set that
 *    certifies them. That gap is exactly what the artifact anchor below now
 *    forbids: a card the SOURCE says is def-bound must be enrolled, so
 *    "converted but unlisted" cannot happen again and delisting one is RED.
 */
const RANGE_BOUND_CARDS: Readonly<Record<string, { params: readonly ParamDef[] }>> = {
  'AdsrCard.svelte': adsrDef,
  'BackdraftCard.svelte': backdraftDef,
  'ChromaconsoleCard.svelte': chromaconsoleDef,
  'CubeCard.svelte': cubeDef,
  'CloudsCard.svelte': cloudsDef,
  'CofefveCard.svelte': cofefveDelayDef,
  'DelayCard.svelte': delayDef,
  'MacrooscillatorCard.svelte': macrooscillatorDef,
  'FilterCard.svelte': filterDef,
  'MeowboxCard.svelte': meowboxDef,
  'MarblesCard.svelte': marblesDef,
  'NoiseCard.svelte': noiseDef,
  'ResofilterCard.svelte': resofilterDef,
  'RingbackCard.svelte': ringbackDef,
  'RingsCard.svelte': ringsDef,
  'SnaredrumCard.svelte': snaredrumDef,
  'VcaCard.svelte': vcaDef,
  'WarrensspectrumCard.svelte': warrensspectrumDef,
};

/**
 * Cards whose MAPPING props (`curve`, `units`) are ALSO def-bound. A strict
 * subset of the above, and a separate ratchet on purpose — see the
 * curve-agreement test below for why the two halves cannot be one list yet.
 */
const MAPPING_BOUND_CARDS: readonly string[] = [
  'AdsrCard.svelte',
  'ChromaconsoleCard.svelte',
  'CubeCard.svelte',
  'CloudsCard.svelte',
  'CofefveCard.svelte',
  'DelayCard.svelte',
  'MacrooscillatorCard.svelte',
  'FilterCard.svelte',
  'MarblesCard.svelte',
  'NoiseCard.svelte',
  'ResofilterCard.svelte',
  'RingbackCard.svelte',
  'RingsCard.svelte',
  'SnaredrumCard.svelte',
  'VcaCard.svelte',
  'WarrensspectrumCard.svelte',
];

/**
 * THE ARTIFACT ANCHOR that replaced the two hand-typed floors.
 *
 * The floors were `RANGE_BOUND_CARDS.length` / `MAPPING_BOUND_CARDS.length`
 * retyped as literals, and they were wrong three times in three face waves —
 * always the same way, always from a CLEAN merge. Sibling branches each add a
 * different card (the lists merge fine, different lines) and each writes the
 * identical `n+1` on the same line (the literal merges fine, no conflict), so
 * the merged floor is one short of the merged list and the slack is invisible.
 * Counting the list instead would make the ratchet vacuous. Neither branch of
 * that dilemma is worth having, so the literal is gone.
 *
 * What replaces it derives the only-grows property from the CARD SOURCES, which
 * no merge can round down: a card that calls `paramSpec(` and contains ZERO
 * literal range props IS def-bound, whatever the list says — so it must be
 * enrolled. Delist one and the anchor reddens naming it.
 *
 * The predicate is deliberately conservative (`paramSpec(` + clean). Cards that
 * bind through a bespoke helper — BackdraftCard's `pmin/pmax/pdef` — are still
 * enrolled by hand; the anchor does not demand them, it only refuses to let the
 * ones it CAN recognise leave.
 */
const CARD_DIR = dirname(fileURLToPath(import.meta.url));

/** Every `*.svelte` in the card directory, as (file, source) pairs. */
function allCardSources(): { file: string; src: string }[] {
  return readdirSync(CARD_DIR)
    .filter((f) => f.endsWith('.svelte'))
    .sort()
    .map((file) => ({ file, src: readFileSync(resolve(CARD_DIR, file), 'utf8') }));
}

/** Counts of each literal shape in one source — the anchor's own instrument. */
function literalCounts(src: string): { range: number; mapping: number } {
  let range = 0;
  let mapping = 0;
  for (const line of src.split('\n')) {
    range += [...line.matchAll(LITERAL_RANGE)].length;
    mapping += [...line.matchAll(LITERAL_MAPPING)].length;
  }
  return { range, mapping };
}

/**
 * A range-ish prop bound to a NUMERIC LITERAL. Covers `min/max/defaultValue`
 * and `step`, under ANY prefix — `xMin`/`yMax` (XyPad, the exact props
 * backdraft got wrong), `valueMin`, or a bare `min`. A leading `-` is included:
 * `xMin={-1}` was half the original bug.
 *
 * ⚠ THE PREFIX IS `[A-Za-z]*`, NOT `[xy]?`, AND THAT MATTERS. The narrow form
 * only ever anticipated the two prefixes already known to have failed, which is
 * how a source-level guard quietly stops guarding: a `valueMin={0}` or a
 * `startMin={…}` on the next primitive reads as clean. Measured on the shapes
 * this file cites: `[xy]?` catches `xMin`/`yMin` but not `valueMin` or `step`.
 */
const LITERAL_RANGE = /(?:^|[^A-Za-z0-9_])([A-Za-z]*(?:[Mm]in|[Mm]ax)|defaultValue|step)=\{\s*-?[0-9]/g;

/**
 * A MAPPING prop bound to a string literal. `curve` is the field the range
 * guard was structurally blind to and the one that changes how a control's
 * travel maps onto its range: a card passing `curve="linear"` against a def
 * declaring `curve: 'log'` puts the fader's midpoint at ~5.0 s where the def
 * puts ~0.1 s — "most of the travel does nothing", the backdraft shape exactly,
 * with every def-reading gate green.
 */
const LITERAL_MAPPING = /(?:^|[^A-Za-z0-9_])(curve|units)=(["'])([^"']*)\2/g;

function cardSource(file: string): string {
  return readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8');
}

/** Every `<Control … />` tag in a card, as (paramId, props) pairs. */
function controlTags(src: string): { paramId?: string; props: string }[] {
  return [...src.matchAll(/<[A-Z][A-Za-z]*\b([^>]*?)\/>/gs)].map((m) => ({
    paramId: /paramId="([^"]+)"/.exec(m[1] ?? '')?.[1],
    props: m[1] ?? '',
  }));
}

describe('card ranges come from the DEF, not from re-typed numbers', () => {
  it.each(Object.keys(RANGE_BOUND_CARDS))('%s binds every range prop to the def', (file) => {
    const src = cardSource(file);
    const offenders: string[] = [];
    for (const line of src.split('\n')) {
      LITERAL_RANGE.lastIndex = 0;
      for (const m of line.matchAll(LITERAL_RANGE)) {
        offenders.push(`${m[1]}={…} literal — ${line.trim().slice(0, 120)}`);
      }
    }
    expect(
      offenders.join('\n'),
      `${file} re-types a control range the def already declares. A card that ` +
        `restates its def's numbers can disagree with it, and NO gate we own can ` +
        `see that (they all read the def). Bind it: paramSpec(def, '<id>').min etc.`,
    ).toBe('');
  });

  it.each(MAPPING_BOUND_CARDS)('%s binds curve / units to the def too', (file) => {
    const src = cardSource(file);
    const offenders: string[] = [];
    for (const line of src.split('\n')) {
      LITERAL_MAPPING.lastIndex = 0;
      for (const m of line.matchAll(LITERAL_MAPPING)) {
        offenders.push(`${m[1]}="${m[3]}" literal — ${line.trim().slice(0, 120)}`);
      }
    }
    expect(
      offenders.join('\n'),
      `${file} hand-types a control MAPPING the def declares. curve is not ` +
        `cosmetic: a "linear" card against a "log" def moves the fader's ` +
        `midpoint by a decade. Bind it: paramSpec(def, '<id>').curve.`,
    ).toBe('');
  });

  it.each(MAPPING_BOUND_CARDS)('%s renders a def-declared `format`, not the primitive fallback', (file) => {
    // ⚠ THE READOUT IS A TWO-SIDED CONTRACT TOO. A `ParamDef.format` the card
    // never passes on is not a downgrade, it is a DISAGREEMENT: `Fader.svelte`
    // falls back to its own magnitude ladder (`abs < 10 → toFixed(2)`), so the
    // legacy card printed the adsr attack default as `0.01 s` and flattened the
    // entire 1–9 ms decade onto `0.00 s`/`0.01 s` while the dock — reading the
    // same param — printed `5 MS`. Every def-reading gate stayed green, because
    // the def was right; only the card was wrong.
    const def = RANGE_BOUND_CARDS[file]!;
    const missing: string[] = [];
    for (const { paramId, props } of controlTags(cardSource(file))) {
      if (!paramId) continue;
      const p = def.params.find((q) => q.id === paramId);
      if (!p?.format) continue;
      if (!/formatValue=\{/.test(props)) missing.push(`${file}.${paramId}`);
    }
    expect(
      missing.join('\n'),
      'a control whose param declares `format` must pass formatValue={p.format} — ' +
        'otherwise the card prints one law and the dock prints another',
    ).toBe('');
  });

  it('a range-bound card that still hand-types `curve` must at least AGREE with its def', () => {
    // ⚠ THE HOLE THIS CLOSES IS IN THIS FILE'S OWN CERTIFIED SET.
    // BackdraftCard — the card this guard was written FOR — is range-bound but
    // still passes 20 literal `curve="linear"` props, so the set the header
    // certifies as "def-bound" contains a card re-typing a def-declared field.
    // Converting all 20 is a follow-up; leaving it as a PROSE caveat is how the
    // divergence class comes back. Until each card joins MAPPING_BOUND_CARDS,
    // its hand-typed curve is checked against the def VALUE-WISE, so a def-side
    // curve change reddens here instead of silently re-mapping a control.
    const bad: string[] = [];
    for (const [file, def] of Object.entries(RANGE_BOUND_CARDS)) {
      if (MAPPING_BOUND_CARDS.includes(file)) continue;
      for (const { paramId, props } of controlTags(cardSource(file))) {
        const literal = /(?:^|[^A-Za-z0-9_])curve=(["'])([^"']*)\1/.exec(props)?.[2];
        if (!literal) continue;
        if (!paramId) {
          bad.push(`${file}: curve="${literal}" on a control with no paramId — uncheckable`);
          continue;
        }
        const declared = def.params.find((p) => p.id === paramId)?.curve ?? 'linear';
        if (declared !== literal) {
          bad.push(`${file}.${paramId}: card curve="${literal}" but the def declares '${declared}'`);
        }
      }
    }
    expect(bad.join('\n'), 'a card curve that disagrees with its def re-maps the control').toEqual('');
  });

  it('the two sets are well-formed (no dupes, mapping ⊆ range, no ghosts)', () => {
    const range = Object.keys(RANGE_BOUND_CARDS);
    expect(new Set(MAPPING_BOUND_CARDS).size, 'no duplicate entries').toBe(MAPPING_BOUND_CARDS.length);
    // Mapping-bound is a SUBSET of range-bound: binding a curve without binding
    // the range it maps onto is not a state these lists have a meaning for.
    for (const f of MAPPING_BOUND_CARDS) expect(range, `${f} must also be range-bound`).toContain(f);
    // …and anchored to the artifact in the other direction: an entry naming a
    // card file that no longer exists is a licence nobody is watching.
    const present = new Set(allCardSources().map((c) => c.file));
    expect(
      range.filter((f) => !present.has(f)),
      'these entries name card files that do not exist (renamed? deleted?)',
    ).toEqual([]);
  });

  it('EVERY def-bound card is enrolled (the artifact anchor that replaced the floors)', () => {
    // Ground truth is the CARD SOURCE, not the list: `paramSpec(` + zero literal
    // range props means the card is already def-bound, so leaving it out of
    // RANGE_BOUND_CARDS is coverage that exists and is not being claimed —
    // which is how ChromaconsoleCard sat bound-but-unlisted until 2026-08-10.
    // It is also the only-grows protection the deleted floors were for: a card
    // cannot be quietly delisted while its source still binds.
    const missingRange: string[] = [];
    const missingMapping: string[] = [];
    for (const { file, src } of allCardSources()) {
      if (!src.includes('paramSpec(')) continue;
      const { range, mapping } = literalCounts(src);
      if (range === 0 && !(file in RANGE_BOUND_CARDS)) missingRange.push(file);
      // Mapping enrolment is only demanded of cards that are ALSO range-clean —
      // the subset rule above makes a mapping-only entry meaningless.
      if (range === 0 && mapping === 0 && !MAPPING_BOUND_CARDS.includes(file)) {
        missingMapping.push(file);
      }
    }
    expect(
      missingRange,
      'these cards bind via paramSpec and re-type NO range literal, so they are ' +
        'def-bound in fact but not in this file. Add `<Card>.svelte: <def>` to ' +
        'RANGE_BOUND_CARDS — an unlisted bound card is coverage nobody is claiming, ' +
        'and delisting one is how the deleted floors used to be needed.',
    ).toEqual([]);
    expect(
      missingMapping,
      'these cards re-type no `curve`/`units` literal either — add them to ' +
        'MAPPING_BOUND_CARDS so the format clause runs on them too.',
    ).toEqual([]);
  });

  it('...and that anchor can SEE a delisted card (negative control on the same predicate)', () => {
    // A `toEqual([])` over a scan that matched nothing reads identically green.
    // Re-run the anchor's own predicate against a set with one real entry
    // removed, and require it to name exactly that card.
    const enrolled = { ...RANGE_BOUND_CARDS } as Record<string, unknown>;
    delete enrolled['AdsrCard.svelte'];
    const flagged = allCardSources()
      .filter(({ src }) => src.includes('paramSpec('))
      .filter(({ src }) => literalCounts(src).range === 0)
      .map(({ file }) => file)
      .filter((f) => !(f in enrolled));
    expect(flagged, 'the anchor must name the card that was removed').toEqual(['AdsrCard.svelte']);
    // …and the instrument must not be matching everything either: a card that
    // does NOT call paramSpec is outside the anchor's subject by construction.
    const sources = allCardSources();
    expect(sources.length, 'the card scan found no sources at all').toBeGreaterThan(100);
    expect(
      sources.filter(({ src }) => !src.includes('paramSpec(')).length,
      'the anchor demands enrolment only of paramSpec cards — most cards are not',
    ).toBeGreaterThan(100);
  });

  it('the greps can actually FAIL (negative control on the instrument)', () => {
    // A textual gate that matches nothing looks exactly like a clean codebase.
    // Prove the patterns fire on the real bug shapes before trusting a green
    // run on the real files.
    const bugLine = '<XyPad xMin={-1} xMax={1} yMin={-1} yMax={1} />';
    expect([...bugLine.matchAll(LITERAL_RANGE)].map((m) => m[1])).toEqual([
      'xMin',
      'xMax',
      'yMin',
      'yMax',
    ]);
    // The forms the OLD `((?:[xy])?(?:[Mm]in|[Mm]ax)|defaultValue)` pattern
    // could not see. Each of these was a silent pass.
    for (const s of ['<Fader valueMin={0} />', '<Fader step={0.01} />', '<Knob startMax={12} />']) {
      expect([...s.matchAll(LITERAL_RANGE)].length, `range guard must catch: ${s}`).toBeGreaterThan(0);
    }
    for (const s of ['<Fader curve="log" />', "<Fader units='s' />"]) {
      expect([...s.matchAll(LITERAL_MAPPING)].length, `mapping guard must catch: ${s}`).toBeGreaterThan(0);
    }
    // …and neither fires on a def-bound binding or an unrelated numeric prop.
    const ok =
      '<Fader min={pAttack.min} max={pAttack.max} curve={pAttack.curve} units={pAttack.units} width={204} trackHeight={80} />';
    expect([...ok.matchAll(LITERAL_RANGE)]).toEqual([]);
    expect([...ok.matchAll(LITERAL_MAPPING)]).toEqual([]);
  });
});
