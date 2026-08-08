// packages/web/src/lib/devices/device-card-source.test.ts
//
// THE REPLACEMENT COVERAGE for what `card-def-agreement` structurally cannot
// see on a device card.
//
// That gate greps for `paramId="<literal>"` and compares any range props on the
// same tag against the def. A device card renders its controls inside an
// `{#each DEVICE_SLOT_IDS}`, so its `paramId` is a loop variable and the grep
// reads it as absent — the card lands in the gate's UNCHECKABLE bucket and its
// ranges go uninspected.
//
// Raising that ceiling without replacing the coverage would be exactly the
// move CLAUDE.md warns about: a gate whose green run looks identical whether it
// can see the subject or not. So this file asserts the property directly and at
// the SOURCE level, which is where it has to be checked — no runtime gate can
// see a card that re-types a range, which is the whole reason the backdraft
// XyPad bug survived every existing gate.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CARD = fileURLToPath(
  new URL('../ui/modules/ChromaconsoleCard.svelte', import.meta.url),
);

/** The card source with `<script>` blocks and HTML comments removed, so only
 *  the RENDERED template is inspected (mirrors card-def-agreement's own
 *  preprocessing — a range mentioned in a comment is not a range the user
 *  can touch). */
function template(): string {
  return readFileSync(CARD, 'utf8')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

/** Range-ish props any control primitive accepts. */
const RANGE_PROPS = ['min', 'max', 'defaultValue', 'xMin', 'xMax', 'yMin', 'yMax', 'valueMin', 'valueMax'];

describe('ChromaconsoleCard sources every range from the DEF', () => {
  it('the card file is readable and non-trivial (vacuity floor)', () => {
    // Without this, a renamed/moved card would make every assertion below pass
    // against an empty string.
    const src = template();
    expect(src.length, 'card template resolved').toBeGreaterThan(500);
    expect(src, 'the slot control is present').toMatch(/KnobConic/);
  });

  it('NO range prop is a numeric literal — every one reads the def via paramSpec', () => {
    const src = template();
    const offenders: string[] = [];
    for (const prop of RANGE_PROPS) {
      // `min={0}` / `min="0"` / `min={-1}` — a hardcoded bound.
      const literal = new RegExp(`\\b${prop}\\s*=\\s*(\\{\\s*-?[\\d.]+\\s*\\}|"-?[\\d.]+")`, 'g');
      for (const m of src.matchAll(literal)) offenders.push(`${prop}: ${m[0]}`);
    }
    expect(
      offenders,
      'a hardcoded range on a device card is the backdraft bug class: the control would ' +
        'write values the def forbids, the model would clamp them silently, and no runtime ' +
        'gate could see it. Read the bound from paramSpec(chromaconsoleDef, slotId) instead.\n  ' +
        offenders.join('\n  '),
    ).toEqual([]);
  });

  it('the slot control binds min/max/defaultValue/curve to the def spec', () => {
    const src = template();
    // Positive form: not merely "no literals" (which an empty card satisfies)
    // but "the def-sourced bindings are actually present".
    for (const binding of ['min={spec.min}', 'max={spec.max}', 'defaultValue={spec.defaultValue}', 'curve={spec.curve}']) {
      expect(src, `slot control binds ${binding}`).toContain(binding);
    }
  });

  it('NEGATIVE CONTROL: the literal-range scan really fires', () => {
    // Perturb the thing the instrument measures. If this regex stopped
    // matching, the test above would pass on a card full of hardcoded ranges.
    const bad = '<KnobConic min={-1} max={1} paramId={slotId} />';
    const hits: string[] = [];
    for (const prop of RANGE_PROPS) {
      const literal = new RegExp(`\\b${prop}\\s*=\\s*(\\{\\s*-?[\\d.]+\\s*\\}|"-?[\\d.]+")`, 'g');
      for (const m of bad.matchAll(literal)) hits.push(m[0]);
    }
    expect(hits.sort()).toEqual(['max={1}', 'min={-1}']);
  });

  it('NEGATIVE CONTROL: a def-sourced binding is NOT mistaken for a literal', () => {
    const good = '<KnobConic min={spec.min} max={spec.max} paramId={slotId} />';
    const hits: string[] = [];
    for (const prop of RANGE_PROPS) {
      const literal = new RegExp(`\\b${prop}\\s*=\\s*(\\{\\s*-?[\\d.]+\\s*\\}|"-?[\\d.]+")`, 'g');
      for (const m of good.matchAll(literal)) hits.push(m[0]);
    }
    expect(hits, 'the scan must not flag the CORRECT form').toEqual([]);
  });
});

describe('ChromaconsoleCard makes no claim about the device state', () => {
  it('renders no "synced"/"in sync" affordance', () => {
    // The device is receive-only. Any indicator implying the card mirrors the
    // pedal is false, and it is the single most misleading thing this card
    // could show.
    const src = template().toLowerCase();
    for (const banned of ['in sync', 'synced', 'up to date', 'matches device']) {
      expect(src, `card must not claim "${banned}"`).not.toContain(banned);
    }
  });

  it('states the send-only limitation in the rendered template', () => {
    expect(template()).toMatch(/send-only/i);
  });
});
