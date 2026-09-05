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

import { chromaconsoleDef } from '$lib/audio/modules/chromaconsole';
import { shellCellFor } from '$lib/ui/workflow/shell-cells';

// ⚠ THIS FILE READ `ChromaconsoleCard.svelte`'s RENDERED TEMPLATE, and both of
// its subjects moved when the surface did.
//
//   1. "NO range prop is a numeric literal — every one reads the def via
//      paramSpec". The card was the only place a bound could be re-typed; the
//      shell resolves a cell's range from the `ParamDef` itself, so the
//      divergence is unspellable rather than untested. NAMED COVERAGE LOSS: the
//      card-scoped range grep, which is the same disposition
//      `card-range-source` gets.
//   2. "makes no claim about the device state". THAT one has a successor and it
//      is a better one. The device is RECEIVE-ONLY, so any affordance implying
//      the surface mirrors the pedal is false — the single most misleading
//      thing this module could show. What a player reads now is the cell TITLES
//      and the def's own docs, both of which are checked below on the live
//      declarations rather than on markup.

/** The words that would claim the pedal reports its state back. */
const FORBIDDEN_CLAIMS = ['in sync', 'synced', 'up to date', 'matches device'];

/** Every string a player can read on this module's faceplate: the cell labels
 *  and titles the shell renders, plus the def's authored docs. */
function playerFacingText(): string {
  const parts: string[] = [];
  for (const f of chromaconsoleDef.controlFamilies ?? []) {
    const cell = shellCellFor('chromaconsole', { kind: 'family', key: `${f.id}-{n}` } as never) as
      { label?: string; title?: string } | null;
    expect(cell, `${f.id} has no shell cell`).toBeTruthy();
    parts.push(cell?.label ?? '', cell?.title ?? '');
  }
  const docs = chromaconsoleDef.docs;
  parts.push(docs?.explanation ?? '');
  for (const v of Object.values(docs?.controls ?? {})) parts.push(String(v));
  return parts.join('\n');
}

describe('chromaconsole makes no claim about the device state', () => {
  it('the player-facing text is non-trivial (vacuity floor)', () => {
    // Without this, a resolver that returned nothing would make every denial
    // below pass against an empty string — the shape the card version guarded
    // with its own "card template resolved" floor.
    const text = playerFacingText();
    expect(text.length, 'the faceplate text resolved').toBeGreaterThan(500);
  });

  it('claims no "synced"/"in sync" state anywhere a player reads', () => {
    const text = playerFacingText().toLowerCase();
    for (const banned of FORBIDDEN_CLAIMS) {
      expect(text, `The faceplate must not claim "${banned}"`).not.toContain(banned);
    }
  });

  it('states the receive-only limitation where a player will meet it', () => {
    // The card said "send-only" in its template; the def says "receive-only"
    // in the explanation AND in the PUSH ALL control's own blob, which is the
    // place the limitation actually bites.
    expect(playerFacingText()).toMatch(/receive-only/i);
  });
});
