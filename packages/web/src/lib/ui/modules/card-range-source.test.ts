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
// RATCHET, not a sweep: 144 of the ~150 cards still re-type their ranges, so
// this set names the cards that have been converted and only ever GROWS. Bring
// a card in when you touch it (boy-scout), by routing its range/curve/default
// props through the def — `paramSpec(def, id)` in card-kit, or the card's own
// `pmin/pmax/pdef` helpers.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { adsrDef } from '$lib/audio/modules/adsr';
import { backdraftDef } from '$lib/video/modules/backdraft';
import { delayDef } from '$lib/audio/modules/delay';
import { filterDef } from '$lib/audio/modules/filter';
import { ringbackDef } from '$lib/audio/modules/ringback';
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
 */
const RANGE_BOUND_CARDS: Readonly<Record<string, { params: readonly ParamDef[] }>> = {
  'AdsrCard.svelte': adsrDef,
  'BackdraftCard.svelte': backdraftDef,
  'DelayCard.svelte': delayDef,
  'FilterCard.svelte': filterDef,
  'RingbackCard.svelte': ringbackDef,
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
  'DelayCard.svelte',
  'FilterCard.svelte',
  'RingbackCard.svelte',
  'SnaredrumCard.svelte',
  'VcaCard.svelte',
  'WarrensspectrumCard.svelte',
];

/** The ratchet floors — lower either and this test is the thing that says no. */
// ⚠ A MERGE CANNOT COMPUTE THESE, AND THAT IS A SILENT HAZARD. Four cards were
// converted the same day off a shared 3/2 base — delay, ringback, snaredrum,
// each PR raising the floor by ONE to 5/4 (range/mapping). Git then merges the
// LISTS cleanly (different lines) and sees NO CONFLICT on the floors, because
// every branch wrote the identical literal. The merged truth is the UNION —
// 6 range-bound / 5 mapping-bound — so the inherited 5/4 passes with a full
// card of slack in each, and the next card to fall back out of the set is
// absorbed in silence rather than reddening this test. Whenever this file
// merges, RE-DERIVE the floors from the lists; never inherit the literal.
const RANGE_BOUND_FLOOR = 8;
const MAPPING_BOUND_FLOOR = 7;

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

  it('the converted-card sets only grow', () => {
    const range = Object.keys(RANGE_BOUND_CARDS);
    expect(range.length).toBeGreaterThanOrEqual(RANGE_BOUND_FLOOR);
    expect(MAPPING_BOUND_CARDS.length).toBeGreaterThanOrEqual(MAPPING_BOUND_FLOOR);
    expect(new Set(MAPPING_BOUND_CARDS).size, 'no duplicate entries').toBe(MAPPING_BOUND_CARDS.length);
    // Mapping-bound is a SUBSET of range-bound: binding a curve without binding
    // the range it maps onto is not a state this ratchet has a meaning for.
    for (const f of MAPPING_BOUND_CARDS) expect(range, `${f} must also be range-bound`).toContain(f);
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
