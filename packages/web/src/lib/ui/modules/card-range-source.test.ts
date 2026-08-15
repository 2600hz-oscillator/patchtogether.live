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
// NOT A SWEEP: most card sources still re-type at least one range number, so
// this set names the cards that have been CONVERTED. Bring a card in when you
// touch it (boy-scout), by routing its range/curve/default props through the
// def — `paramSpec(def, id)` in card-kit, or the card's own `pmin/pmax/pdef`
// helpers.
//
// ⚠ STATED SCOPE: every card NOT in `RANGE_BOUND_CARDS` is unchecked for
// def-binding. That is the gate's blind spot and it is large. It is stated
// WITHOUT A NUMBER on purpose — an earlier revision of this paragraph carried
// "13 of 215" and was wrong within two merges, which is the same failure the
// deleted floors below had, just relocated into prose. Measure it against the
// tree when you need it:
//
//     ls packages/web/src/lib/ui/modules/*.svelte | wc -l      # the population
//     grep -c "Card.svelte':" <this file>                      # the covered set
//
// The two things that ARE asserted rather than described: no card may leave the
// covered set while its source still binds (the artifact anchor below), and a
// card's own COMMENTS cannot make it look unconverted (the comment-stripping
// legs at the bottom — which is how AnalogVcoCard and KarplusCard were found
// sitting outside the set while fully bound).
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
import { stripSourceComments } from '$lib/source-guards/strip-source-comments';
import { adsrDef } from '$lib/audio/modules/adsr';
import { attenumixDef } from '$lib/audio/modules/attenumix';
import { analogVcoDef } from '$lib/audio/modules/analog-vco';
import { backdraftDef } from '$lib/video/modules/backdraft';
import { bugglesDef } from '$lib/audio/modules/buggles';
import { chromaconsoleDef } from '$lib/audio/modules/chromaconsole';
import { cubeDef } from '$lib/audio/modules/cube';
import { cloudsDef } from '$lib/audio/modules/clouds';
import { cofefveDelayDef } from '$lib/audio/modules/cofefve';
import { delayDef } from '$lib/audio/modules/delay';
import { macrooscillatorDef } from '$lib/audio/modules/macrooscillator';
import { marblesDef } from '$lib/audio/modules/marbles';
import { ninelivesDef } from '$lib/audio/modules/ninelives';
import { noiseDef } from '$lib/audio/modules/noise';
import { warrensvisionsDef } from '$lib/video/modules/warrensvisions';
import { charlottesEchosDef } from '$lib/audio/modules/charlottes-echos';
import { filterDef } from '$lib/audio/modules/filter';
import { karplusDef } from '$lib/audio/modules/karplus';
import { meowboxDef } from '$lib/audio/modules/meowbox';
import { resofilterDef } from '$lib/audio/modules/resofilter';
import { ringbackDef } from '$lib/audio/modules/ringback';
import { ringsDef } from '$lib/audio/modules/rings';
import { sidecarDef } from '$lib/audio/modules/sidecar';
import { snaredrumDef } from '$lib/audio/modules/snaredrum';
import { vcaDef } from '$lib/audio/modules/vca';
import { warrensspectrumDef } from '$lib/audio/modules/warrensspectrum';
import { wavetableVcoDef } from '$lib/audio/modules/wavetable-vco';
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
  // Converted with its FACEPLATE (queue Q6), which is when the divergence would
  // have started to cost: a faced module renders the DOCK straight off the
  // ParamDef and the legacy card off whatever it typed, so the same knob would
  // have had two travels depending on which surface you reached it through.
  // Its channel strips are derived from the def's own `att\d+` params, so each
  // Fader carries its ParamDef and there is no per-channel literal at all.
  'AttenumixCard.svelte': attenumixDef,
  // ⚠ THESE TWO WERE FOUND BY THE COMMENT FIX, NOT ADDED ALONGSIDE IT. Both
  // were already fully def-bound in source; the artifact anchor could not
  // demand their enrolment because each card's own comment quotes the literals
  // it documents removing, so `literalCounts` read them as `range !== 0` and
  // the anchor concluded they were unconverted. That is the QUIET half of
  // comment blindness — no red run, just two cards silently outside the set
  // that certifies them, free to be delisted or to regress.
  //   AnalogVcoCard is range-bound only: it still hand-types `units="st"` /
  //   `curve="linear"`, so it stays out of MAPPING_BOUND_CARDS and is held to
  //   the value-wise curve-agreement clause instead.
  'AnalogVcoCard.svelte': analogVcoDef,
  'KarplusCard.svelte': karplusDef,
  'WarrensvisionsCard.svelte': warrensvisionsDef,
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
  // FACE BATCH 6. Nine hand-typed min/max pairs, all AGREEING with the def —
  // which is why binding them is a maintainability fix rather than a bug fix,
  // and why the card is enrolled here rather than left to the agreement clause
  // alone. `units` stays hand-typed (i.e. absent), so this is the AnalogVcoCard
  // shape: range-bound, out of MAPPING_BOUND_CARDS, held to the value-wise
  // curve-agreement clause below.
  'SidecarCard.svelte': sidecarDef,
  // FACE BATCH 6. Converted with its FACEPLATE, and the label half is the
  // reason: promotion makes the DEF's label the one a user reads at the dock,
  // and this card's `Feedback` / `Pitch` disagreed outright with the def's
  // `Fbk` / `Ptch` (both were in VOCABULARY_DEBT). Binding every prop —
  // min/max/defaultValue/label/units/curve — off `CHARLOTTES_ECHOS_RANGES`
  // paid that ledger rather than deferring it, and the def took the card's
  // wording so no pixels moved.
  'CharlottesEchosCard.svelte': charlottesEchosDef,
  'SnaredrumCard.svelte': snaredrumDef,
  'VcaCard.svelte': vcaDef,
  'WarrensspectrumCard.svelte': warrensspectrumDef,
  // THE FACEPLATE QUEUE · Q9. Enrolled while PAYING a live `OPERATIONAL_DEBT`
  // entry rather than while tidying: this card passed `min={0}` on `fmAmount`
  // and `pmAmount` against a def declaring `-1`, so binding it is a BUG FIX and
  // the enrolment is what stops the number from being re-typed at all. Range
  // AND mapping — every Fader reads `P.<id>.{min,max,defaultValue,label,units,
  // curve}` off `paramSpec(wavetableVcoDef, …)`, so it is in both lists.
  'WavetableVcoCard.svelte': wavetableVcoDef,
  // THE FACEPLATE QUEUE · Q11. Both faders re-typed numbers that AGREED with
  // the def, so this is a maintainability conversion rather than a bug fix —
  // but it is done WITH the promotion for the reason the agreement clause
  // cannot cover: a faced module renders the DOCK straight off the `ParamDef`
  // and the legacy card off whatever it typed, so from the moment `ninelives`
  // enters STRICT_FACES a divergence would give one param two travels
  // depending on which surface you reached it through. Range AND mapping —
  // `curve` and `units` come off `paramSpec(ninelivesDef, …)` too.
  'NinelivesCard.svelte': ninelivesDef,
  // THE FACEPLATE QUEUE · Q13. All five faders re-typed numbers that AGREED
  // with the def — the audit checked every one — so this is a maintainability
  // conversion rather than a bug fix, and it is exactly that agreement which
  // made it safe to do inside the faceplate PR: because the restated values
  // already matched, binding them is PIXEL-NEUTRAL, and `buggles` is in
  // `STRICT_VRT_MODULES` so a moved fader handle would have cost a card
  // re-capture (the WavetableVcoCard case above, where binding `min` moved the
  // handle from the bottom of its track to the middle). The card scene passed
  // unchanged in the same local VRT run that reported the two new face scenes
  // missing, which is the check.
  //
  // It is converted WITH the promotion for the reason the agreement clause
  // cannot cover: from the moment `buggles` enters STRICT_FACES the dock
  // renders straight off the `ParamDef` while the legacy card renders off
  // whatever it typed, so any future divergence would give one param two
  // travels depending on which surface you reached it through.
  //
  // The conversion also removed a SECOND hazard the range clause is blind to:
  // the defaults were read as `bugglesDef.params[0]!.defaultValue` — bound by
  // POSITION, not by id — so re-ordering `params`, which no gate forbids,
  // would have silently re-pointed all five.
  //
  // Range AND mapping: `curve` comes off `paramSpec(bugglesDef, …)`, and no
  // buggles param declares `units` at all, so there is nothing to paint and
  // nothing left to drift (the SidecarCard shape, without Sidecar's caveat —
  // its `inputLevel` DOES declare `units: '%'`, and none of these five do).
  'BugglesCard.svelte': bugglesDef,
};

/**
 * Cards whose MAPPING props (`curve`, `units`) are ALSO def-bound. A strict
 * subset of the above, and a separate ratchet on purpose — see the
 * curve-agreement test below for why the two halves cannot be one list yet.
 */
const MAPPING_BOUND_CARDS: readonly string[] = [
  'AdsrCard.svelte',
  // Range AND mapping: every Fader reads min/max/defaultValue/label/curve off
  // the ParamDef it was derived from, so nothing is restated.
  'AttenumixCard.svelte',
  // Range AND mapping: every Fader reads `P.<id>.{min,max,curve,units}` off
  // `paramSpec(karplusDef, …)`. See the note in RANGE_BOUND_CARDS for why it
  // was not enrolled until the comment stripper landed.
  'KarplusCard.svelte',
  'WarrensvisionsCard.svelte',
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
  // FACE BATCH 6. It re-types no `curve` and no `units` — `curve` is bound off
  // `paramSpec`, and this card has never passed `units` at all, which the
  // anchor reads (correctly) as "nothing left to drift". ⚠ THAT IS NOT THE SAME
  // AS PAINTING THE UNITS: `inputLevel` declares `units: '%'` on a 0..2 gain,
  // so a card that started passing units would print `1.00 %`. The def now
  // carries the `format` that fixes it; wiring units onto these nine faders is
  // a visible card change and wants its own owner preview.
  'SidecarCard.svelte',
  // FACE BATCH 6. Range AND mapping AND vocabulary: all five Knobs read
  // `min`/`max`/`defaultValue`/`label`/`units`/`curve` off
  // `CHARLOTTES_ECHOS_RANGES`, which is the def's own ParamDef objects by
  // identity (asserted in art/scenarios/charlottes-echos/cv-path.test.ts), so
  // there is no second copy of any number or name to drift.
  'CharlottesEchosCard.svelte',
  'SnaredrumCard.svelte',
  'VcaCard.svelte',
  'WarrensspectrumCard.svelte',
  // THE FACEPLATE QUEUE · Q9. `units` is bound too, not merely absent: `tune`
  // declares `st` and `fine` declares `¢`, and both now come off the ParamDef
  // rather than being hand-typed beside a `min` that disagreed with it.
  'WavetableVcoCard.svelte',
  // THE FACEPLATE QUEUE · Q11. `units` is bound rather than merely absent —
  // `rate` declares `Hz` and it now comes off the ParamDef; `shape` declares
  // none and the card passes none, which is the same fact stated by omission.
  'NinelivesCard.svelte',
  // THE FACEPLATE QUEUE · Q13. `curve` is bound off `paramSpec`; `units` is
  // ABSENT ON BOTH SIDES — no buggles param declares one and the card passes
  // none — which the anchor reads as "nothing left to drift", correctly and
  // for the strongest available reason. ⚠ Sidecar's caveat is what makes that
  // worth stating: it is enrolled on an absent `units` too, but its
  // `inputLevel` DECLARES `units: '%'` on a 0..2 gain, so a card that started
  // passing units would print `1.00 %`. Checked here rather than assumed —
  // the only `units` in `buggles.ts` is the word inside a comment.
  'BugglesCard.svelte',
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

/**
 * ⚠ COMMENTS ARE PROSE, NOT MARKUP — AND BOTH DIRECTIONS OF THAT MATTER HERE.
 *
 * This gate forbids `xMin={-1}` in a card, and "we removed the `xMin={-1}`
 * literals" is the natural way to WRITE DOWN that a card was converted. A raw
 * grep therefore flags the explanation as the offence. That is the loud half,
 * and the sibling guard at `lfo-face-model.test.ts:279` hit it on its first run.
 *
 * The QUIET half is worse and is specific to this file. The artifact anchor
 * below ("EVERY def-bound card is enrolled") decides a card is CONVERTED — and
 * must therefore stay enrolled — from `literalCounts(src).range === 0`. A
 * genuinely-converted card whose comment quotes `xMin={-1}` reads as
 * `range !== 0`, so the anchor STOPS DEMANDING ITS ENROLMENT and the card can
 * be delisted with nothing going red. Comment blindness is a hole in the
 * anchor, not a cosmetic annoyance.
 *
 * So every read of a card goes through the SHARED quote-aware stripper
 * (`$lib/source-guards/strip-source-comments`), which preserves byte offsets so
 * the line-by-line reporting below still points at the right line. It is shared
 * rather than re-typed here because a re-typed copy of a predicate is precisely
 * how the previous self-test went blind; its hostile-form legs (`'https://x'`,
 * `` `a // b` ``, `/[//]/`, `'/**\/*.ts'`) live with it and run on every unit
 * sweep. The pairing that proves it for THIS gate — the same text as prose and
 * as code, through the same `cardCode`+`LITERAL_RANGE` path the sweep uses — is
 * the permanent leg at the bottom of this file.
 */
function cardCode(src: string): string {
  return stripSourceComments(src);
}

/** Every `*.svelte` in the card directory, as (file, source) pairs. `src` is
 *  COMMENT-STRIPPED — see `cardCode`. */
function allCardSources(): { file: string; src: string }[] {
  return readdirSync(CARD_DIR)
    .filter((f) => f.endsWith('.svelte'))
    .sort()
    .map((file) => ({ file, src: cardCode(readFileSync(resolve(CARD_DIR, file), 'utf8')) }));
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

/** One card's source, COMMENT-STRIPPED — see `cardCode`. */
function cardSource(file: string): string {
  return cardCode(readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8'));
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

  // ── COMMENT STRIPPING: THE PERMANENT LEG, BOTH DIRECTIONS ────────────────
  //
  // The pair is the whole point. A stripper that returned '' would silence this
  // entire gate and pass every "documented" leg; a stripper that returned its
  // input unchanged would pass every "code" leg. Only asserting BOTH halves of
  // the SAME text, through the SAME `cardCode` + `LITERAL_RANGE` /
  // `LITERAL_MAPPING` path the sweep above uses, can tell those apart.
  //
  // ⚠ These call `cardCode`, NOT a re-typed copy of the stripper. Re-typing the
  // predicate into the self-test is exactly how the previous generation of
  // guards in this repo went blind (the raw-write self-test only ever fed
  // itself the bracket form), so the only way for this leg to pass while the
  // sweep is broken is for them to stop being the same function.
  const scanRange = (src: string): string[] =>
    [...cardCode(src).matchAll(LITERAL_RANGE)].map((m) => m[1]!);
  const scanMapping = (src: string): string[] =>
    [...cardCode(src).matchAll(LITERAL_MAPPING)].map((m) => m[1]!);

  it.each([
    // The shape a converted card actually writes: prose naming what it removed.
    ['a markup comment', '<!-- was: <XyPad xMin={-1} xMax={1} /> -->'],
    ['a line comment', '// ranges used to be hand-typed: xMin={-1}'],
    ['a block comment', '/* xMin={-1} xMax={1} — now paramSpec(def, "camTiltX") */'],
    ['a trailing comment', 'const p = paramSpec(def, "x"); // replaces step={0.01}'],
    ['a JSDoc block', '/** @see the old `valueMax={12}` */'],
  ])('a range literal quoted inside %s is NOT an offence', (_what, src) => {
    expect(scanRange(src), `${_what}: an illustration in prose is not a re-typed range`).toEqual([]);
  });

  it.each([
    ['a markup comment', '<!-- was: <Fader curve="log" /> -->'],
    ['a line comment', '// curve="linear" was wrong here'],
  ])('a mapping literal quoted inside %s is NOT an offence', (_what, src) => {
    expect(scanMapping(src), `${_what}: prose is not a re-typed mapping`).toEqual([]);
  });

  it('…and the SAME text as CODE still is (the stripper is not an eraser)', () => {
    expect(scanRange('<XyPad xMin={-1} xMax={1} />')).toEqual(['xMin', 'xMax']);
    expect(scanRange('const p = paramSpec(def, "x"); <Fader step={0.01} />')).toEqual(['step']);
    expect(scanMapping('<Fader curve="log" />')).toEqual(['curve']);
  });

  it('a `//` that is NOT a comment survives — the four shapes a regex stripper eats', () => {
    // Each of these appears in real card/module source in this tree, and each
    // breaks at least one of the one-off `//`-stripping regexes this gate used
    // to be one line away from growing. If any were eaten, the code AFTER it on
    // the line would vanish and a genuine `xMin={-1}` could hide behind a URL.
    for (const [what, src] of [
      ['a URL in a string', `<a href="https://x//y">z</a> <XyPad xMin={-1} />`],
      ['a template literal', 'const t = `a // b`; <XyPad xMin={-1} />'],
      ['a regex character class', 'const re = /[//]/g; <XyPad xMin={-1} />'],
      ['a glob string', `const g = '/**/*.svelte'; <XyPad xMin={-1} />`],
    ] as const) {
      expect(scanRange(src), `${what}: the literal after it must still be caught`).toEqual(['xMin']);
    }
  });

  it('the ANCHOR sees through comments too — a bound card documenting its old literals stays enrolled', () => {
    // THE QUIET FAILURE, made executable. `literalCounts` is what the artifact
    // anchor uses to decide "this card is converted, so it must stay enrolled".
    // Un-stripped, the comment below reads as `range = 2`, the anchor concludes
    // the card is NOT converted, and it silently stops demanding enrolment —
    // green, with the protection gone. This is the leg that would have caught
    // that, and it calls `literalCounts` rather than restating it.
    const documented = [
      '<script>',
      '  // converted 2026-08-12: was `<XyPad xMin={-1} xMax={1} />`',
      '  const p = paramSpec(def, "camTiltX");',
      '</script>',
      '<XyPad xMin={p.min} xMax={p.max} />',
    ].join('\n');
    expect(
      literalCounts(cardCode(documented)),
      'a card that DOCUMENTS the literals it removed is still range-clean',
    ).toEqual({ range: 0, mapping: 0 });
    // …and the same card with the literals genuinely back is not.
    const regressed = documented.replace('<XyPad xMin={p.min} xMax={p.max} />', '<XyPad xMin={-1} xMax={1} />');
    expect(literalCounts(cardCode(regressed)).range, 'a real regression still counts').toBe(2);
  });
});
