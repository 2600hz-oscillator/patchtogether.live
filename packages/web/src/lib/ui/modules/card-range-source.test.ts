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

/**
 * Cards whose control RANGES are bound to the def. ONLY GROWS.
 *  - BackdraftCard: the named regression above (binds via pmin/pmax/pdef).
 *  - AdsrCard: converted with the adsr face rework (binds via paramSpec).
 */
const RANGE_BOUND_CARDS: readonly string[] = ['AdsrCard.svelte', 'BackdraftCard.svelte'];

/** The ratchet floor — lower it and this test is the thing that says no. */
const RANGE_BOUND_FLOOR = 2;

/**
 * A range-ish prop bound to a NUMERIC LITERAL. Covers the plain
 * `min/max/defaultValue` trio every Fader/Knob takes plus the axis-prefixed
 * form an XyPad takes (`xMin`/`yMax` — the exact props backdraft got wrong).
 * A leading `-` is included: `xMin={-1}` was half the original bug.
 */
const LITERAL_RANGE = /(?:^|[^A-Za-z])((?:[xy])?(?:[Mm]in|[Mm]ax)|defaultValue)=\{\s*-?[0-9]/g;

function cardSource(file: string): string {
  return readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8');
}

describe('card ranges come from the DEF, not from re-typed numbers', () => {
  it.each(RANGE_BOUND_CARDS)('%s binds every range prop to the def', (file) => {
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

  it('the converted-card set only grows', () => {
    expect(RANGE_BOUND_CARDS.length).toBeGreaterThanOrEqual(RANGE_BOUND_FLOOR);
    expect(new Set(RANGE_BOUND_CARDS).size, 'no duplicate entries').toBe(RANGE_BOUND_CARDS.length);
  });

  it('the grep can actually FAIL (negative control on the instrument)', () => {
    // A textual gate that matches nothing looks exactly like a clean codebase.
    // Prove the pattern fires on the real backdraft bug text before trusting a
    // green run on the real files.
    const bugLine = '<XyPad xMin={-1} xMax={1} yMin={-1} yMax={1} />';
    expect([...bugLine.matchAll(LITERAL_RANGE)].map((m) => m[1])).toEqual([
      'xMin',
      'xMax',
      'yMin',
      'yMax',
    ]);
    // …and does NOT fire on a def-bound binding or an unrelated numeric prop.
    const ok = '<Fader min={pAttack.min} max={pAttack.max} width={204} trackHeight={80} />';
    expect([...ok.matchAll(LITERAL_RANGE)]).toEqual([]);
  });
});
