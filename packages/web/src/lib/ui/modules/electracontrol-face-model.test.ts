// packages/web/src/lib/ui/modules/electracontrol-face-model.test.ts
//
// THE ELECTRA CONTROL FACE — its model, and the legs that are NOT vacuous on it.
//
// ⚠ READ THIS FIRST: THE SHARED FACE GATES ARE STRUCTURALLY VACUOUS ON THIS
// MODULE, AND A GREEN RUN OF THEM IS NOT EVIDENCE OF ANYTHING HERE.
// `module-face-lint`'s COMPLETENESS pass loops `def.params`, and this def's
// `params` is `[]` by construction (meta domain — no engine, no ports). So it
// iterates an empty list and passes. `faces-parity`'s exact-multiset assertion
// compares the dock's `control-*` testids against the def's param ids: also
// empty on both sides. That is precisely the blind-gate shape CLAUDE.md names —
// "would its green run look any different if the answer were 'everything'?" No.
//
// So the gates that actually carry this face are: `face-rack-status-source`
// (the body's declared ROLE, verified against its source), the ranked cell's
// audition probe with its permanent negative control
// (`electra-cell-actions.test.ts`), the drawer e2e, and THIS FILE — which pins
// the things a source-level gate cannot see and a param-driven one cannot reach.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { electraControlDef, ELECTRA_CONTROL_TYPE } from '$lib/meta/modules/electra-control';
import { STRICT_FACES, migrated } from '$lib/ui/workflow/strict-faces';
import { NON_SHELL_LANE_TYPES, laneRenderKind, dockRailRendersFace } from '$lib/ui/workflow/legacy-fallback';
import { shellCellFor } from '$lib/ui/workflow/shell-cells';
import { electraPosOf, ELECTRA_BANKS, ELECTRA_SLOT_COUNT } from '$lib/graph/electra-control';
import { slotPositionName, emptySlotName, boardName } from './electraControl/electra-board-model';

const HERE = dirname(fileURLToPath(import.meta.url));
const BODY = resolve(HERE, 'electraControl', 'ElectraGridBody.svelte');
const body = () => readFileSync(BODY, 'utf8');

describe('electraControl face — the promotion', () => {
  it('declares a face and is in STRICT_FACES', () => {
    expect(electraControlDef.face, 'the def declares a face').toBeTruthy();
    expect(STRICT_FACES.has(ELECTRA_CONTROL_TYPE)).toBe(true);
    expect(migrated(ELECTRA_CONTROL_TYPE)).toBe(true);
  });

  // ⚠ THE PRECONDITION, ASSERTED. `NON_SHELL_LANE_TYPES` short-circuits
  // `laneRenderKind` BEFORE `migrated` is read, so membership and promotion are
  // mutually exclusive by construction — a face on a carved-out type is
  // unreachable in the lane, has no `module-shell` for `bootWithFace` to wait
  // on, and therefore cannot have the VRT scenes `FACES` requires of every
  // STRICT_FACES member. Both directions, so re-adding the entry is RED.
  it('is NOT in NON_SHELL_LANE_TYPES — the carve-out and the promotion cannot coexist', () => {
    expect(NON_SHELL_LANE_TYPES.has(ELECTRA_CONTROL_TYPE)).toBe(false);
    expect(
      laneRenderKind({
        shellFaces: true,
        userDocked: false,
        type: ELECTRA_CONTROL_TYPE,
        hasCard: true,
        migrated: true,
      }),
      'the lane renders the shell, not the verbatim card',
    ).toBe('shell');
  });

  // ⚠ THE NEGATIVE CONTROL FOR THE LEG ABOVE: the same call with `hasCard:
  // false` — which is what `moduleSwapsToShell` returns for a carved-out type —
  // must still resolve 'legacy'. Without this, the assertion could not tell "the
  // carve-out is gone" from "the rule stopped consulting it".
  it('the rule still honours a carve-out for the types that keep one', () => {
    expect(
      laneRenderKind({
        shellFaces: true,
        userDocked: false,
        type: 'controlSurface',
        hasCard: false,
        migrated: false,
      }),
    ).toBe('legacy');
    expect(NON_SHELL_LANE_TYPES.has('controlSurface'), 'a real member remains').toBe(true);
  });

  // ⚠ THE SURFACE THAT ACTUALLY MATTERS. This module is the `E` of the M/E/C pin
  // trio with `surface: 'drawer'` and is canvas-hidden, so the bottom tray is the
  // ONLY surface its always-on instance has. Promotion is what flips that tray
  // from the legacy card to the faceplate; before it, `migrated` was false and
  // the drawer painted the card forever.
  it('the pinned DRAWER now renders the face — the whole point of the promotion', () => {
    expect(dockRailRendersFace({ shellFaces: true, pinned: true, migrated: migrated(ELECTRA_CONTROL_TYPE) })).toBe(true);
    // …and the `?shell=legacy` escape hatch still gets the verbatim card, which
    // is what keeps `electra-control.spec.ts` meaningful rather than merely
    // passing.
    expect(dockRailRendersFace({ shellFaces: false, pinned: true, migrated: true })).toBe(false);
  });
});

describe('electraControl face — the ONE ranked cell', () => {
  const KEY = 'electra-connect-button-{n}';

  it('ranks exactly the declared family, and the family is declared', () => {
    expect(electraControlDef.face!.order).toEqual([KEY]);
    expect(electraControlDef.controlFamilies?.map((f) => f.id)).toEqual(['electra-connect-button']);
  });

  // ⚠ `order: []` WOULD HAVE BEEN LEGAL AND WOULD HAVE PAINTED A BLANK TILE —
  // the matrixMix lesson, restated in midiLane's promotion. A meta def has
  // `params: []`, so a family is the ONLY thing that can be ranked; this leg is
  // what stops a future edit quietly emptying the face.
  it('the ranked key RESOLVES to a live action cell — not an inert one', () => {
    const cell = shellCellFor(ELECTRA_CONTROL_TYPE, { kind: 'family', key: KEY } as never);
    expect(cell, 'the ranked key resolves a cell').toBeTruthy();
    expect(cell!.kind).toBe('action');
    expect(electraControlDef.face!.order.length, 'a face that ranks nothing is a blank tile').toBeGreaterThan(0);
  });

  it('has no pages, no rear groups, and a glyph of none', () => {
    // One ranked cell is one band; a header over it would say the same word
    // twice. `inputs`/`outputs` are empty, so a rear group would resolve to no
    // port and module-face-lint refuses that.
    expect(electraControlDef.face!.pages).toBeUndefined();
    expect(electraControlDef.face!.rear).toBeUndefined();
    expect(electraControlDef.face!.glyph).toBe('none');
    expect(electraControlDef.inputs).toEqual([]);
    expect(electraControlDef.outputs).toEqual([]);
    expect(electraControlDef.params).toEqual([]);
  });

  // The def is the ONE place the testid lives; module-docs-lint asserts the
  // prefix appears in real UI source, so a rename on either surface is red.
  it('the family testidPrefix is the literal the button emits', () => {
    expect(electraControlDef.controlFamilies![0]!.testidPrefix).toBe('electra-connect-button');
  });
});

describe('electraControl body — what a source gate cannot see', () => {
  // ⚠ THE PRUNE EFFECT. When a bound source module disappears the slot stops
  // RENDERING but the binding lingers in `node.data`, so the next flash would
  // emit a dead control. The card dropped those on every ydoc tick; the pure
  // function is exhaustively unit-tested and the fact that ANYTHING CALLS IT was
  // not. Porting the board into a body is exactly the moment that call could
  // vanish — a body without it looks identical at rest and diverges only on a
  // rack somebody edited.
  it('the body still calls pruneElectraDangling on every ydoc tick', () => {
    const src = body();
    expect(src, 'the prune is imported').toMatch(/pruneElectraDangling/);
    expect(
      src.replace(/\s+/g, ' '),
      'the prune runs inside an $effect keyed on the version pump, not once at mount',
    ).toMatch(/\$effect\(\(\) => \{ void cardVersion; pruneElectraDangling\(nodeId\); \}\)/);
  });

  // ⚠ THE SHIPPED CRASH. `$lib/graph/electra-control` mutates `data.slots` IN
  // PLACE inside one transact, because "once integrated, spreading it into a
  // fresh object re-integrates already-integrated Y types and Yjs throws 'Type
  // already integrated'" — the trap that broke the second send-to-surface. A body
  // that rebuilt the map would be a crash on the second rename.
  it('the body never rebuilds the slot map — it writes through the shared mutator', () => {
    const src = body();
    expect(src, 'renames go through the one writer').toMatch(/setSlotName\(nodeId, editing, editValue\)/);
    expect(src, 'no spread of the live Y map').not.toMatch(/\.\.\.\s*(electraData\.slots|d\.slots|data\.slots)/);
  });

  // ⚠ THE ENUMERATION IS THE MODULE. All thirty-six cells are built from
  // `(row, knob)` and never from the data, which is what makes an EMPTY slot a
  // visible PLACE rather than an absence — the property a player's hands rely on.
  it('the board is enumerated from the geometry, not from the data', () => {
    const src = body();
    expect(src).toMatch(/ELECTRA_BANKS\.map/);
    expect(src).toMatch(/for \(let knob = 1; knob <= ELECTRA_KNOBS; knob\+\+\)/);
    // Derived, so a geometry change moves the board rather than desynchronising it.
    expect(ELECTRA_BANKS.flatMap((b) => b.rows)).toHaveLength(6);
    expect(ELECTRA_SLOT_COUNT).toBe(36);
  });

  // The shared name expression the Push 2's ElectraControl mode also renders.
  // Three renderers draw this grid; re-typing the rule is how they disagree.
  it('the body imports the shared slot-label expression rather than re-typing it', () => {
    expect(body()).toMatch(/electraSlotLabel/);
  });

  // ⚠ THE RESTING-TEXT RULING, at the one place a source gate is blind: an
  // extension body can paint anything. The board's visible text is exhaustively
  // the three BANK LABELS and each knob's own caption (a `label` PROP consumed by
  // Knob.svelte, never a text node here). This leg denies the shape that would
  // creep back — a bare value mustache.
  it('paints no derived value: the only text nodes are the bank labels', () => {
    // MARKUP ONLY. The `<script>` block is full of `=>` arrows, and a bare
    // `>\s*\{` scan reads every one of them as a painted mustache — an
    // instrument that would have reported this body painting eleven values it
    // does not paint. Slice the template first.
    const src = body();
    const markup = src.slice(src.indexOf('</script>')).split('<style>')[0]!;
    expect(markup, 'the slice found a template').toMatch(/electra-control-grid/);
    const mustaches = [...markup.matchAll(/>\s*\{([^}]+)\}/g)]
      .map((m) => m[1]!.trim())
      // Svelte BLOCK tags (`{#each …}`, `{:else}`, `{/if}`) also follow a `>`.
      // They are control flow, not painted text.
      .filter((e) => !/^[#/:]/.test(e));
    expect(mustaches, 'the board paints exactly one text expression').toEqual(['bank.label']);
  });

  // ⚠ THE `control-grid` ROLE'S PREDICATE, asserted HERE TOO rather than only in
  // the roster gate — because that gate checks the DECLARED role, and a body that
  // grew a drawing surface would flip roles silently if nobody re-declared. The
  // tag is built from fragments so this assertion does not itself trip the
  // raw-source grep it mirrors.
  it('mounts no drawing surface, and carries the accessible names the role requires', () => {
    const src = body();
    expect(src, 'a drawn body would enrol a meta module in the GPU attest').not.toMatch(
      new RegExp('<' + 'canvas'),
    );
    expect(src).toMatch(/aria-label=/);
  });
});

describe('electraControl board model — the names, against the firmware geometry', () => {
  // ⚠ PINNED AGAINST THE SAME ANCHORS `graph/electra-control.test.ts` USES, so
  // the spoken coordinate and the preset generator cannot drift. The storage
  // order is row-major but the firmware's walk is NOT — odd rows are pots 1-6,
  // even rows are pots 7-12 of the SAME control set — which is exactly the thing
  // a hand-written name would get wrong.
  it('Row2 knob2 speaks control set 1 pot 8', () => {
    expect(electraPosOf(2, 2)).toEqual({ controlSetId: 1, potId: 8 });
    expect(slotPositionName(2, 2)).toBe('Row 2 knob 2, control set 1 pot 8');
  });

  it('Row6 knob6 speaks control set 3 pot 12', () => {
    expect(electraPosOf(6, 6)).toEqual({ controlSetId: 3, potId: 12 });
    expect(slotPositionName(6, 6)).toBe('Row 6 knob 6, control set 3 pot 12');
  });

  // ⚠ THE ONE BEHAVIOUR THIS PORT DELIBERATELY CHANGES. The card marked every
  // empty cell `aria-hidden="true"`, so on a fresh board THIRTY-SIX of thirty-six
  // places were unspeakable — on a surface whose entire design premise is that an
  // empty slot is a visible place. This is not keyboard a11y (ruled out by the
  // owner); it is the accessible NAME of an element already rendered.
  //
  // ⚠ AND THE EXAMPLE IS CHOSEN TO PROVE THE ODD/EVEN SPLIT, because the first
  // draft of this leg asserted `Row 3 knob 4 → pot 10` and was WRONG: row 3 is
  // ODD, so it is the TOP sub-row of control set 2 and its pots are 1-6. That is
  // the exact mistake `graph/electra-control.ts` warns about in its header ("Do
  // NOT derive (controlSetId, potId) from a naive floor(slot/12)+1"), reproduced
  // by a human writing the number by hand — which is why the model derives it
  // from `electraPosOf` instead of formatting one itself. Both parities are
  // pinned here so a regression cannot pass by getting one of them right.
  it('an EMPTY slot is a named place, not an absence', () => {
    // ODD row → the bank's TOP sub-row, pots 1-6.
    expect(electraPosOf(3, 4)).toEqual({ controlSetId: 2, potId: 4 });
    expect(emptySlotName(3, 4)).toBe('Row 3 knob 4, control set 2 pot 4 — empty');
    // EVEN row → the SAME control set, pots 7-12.
    expect(electraPosOf(4, 4)).toEqual({ controlSetId: 2, potId: 10 });
    expect(emptySlotName(4, 4)).toBe('Row 4 knob 4, control set 2 pot 10 — empty');
  });

  // The count is DERIVED from the live slot map by the caller and permitted only
  // because it lives in an accessible name and is never painted.
  it('the board name carries a derived count and no measurement', () => {
    expect(boardName(0)).toBe('Electra One board — 6 rows of 6, 0 assigned');
    expect(boardName(4)).toBe('Electra One board — 6 rows of 6, 4 assigned');
  });

  // ⚠ NEGATIVE CONTROL FOR THIS WHOLE BLOCK: the names must be a FUNCTION of the
  // coordinate, not a constant that happens to read correctly for two anchors.
  it('every one of the thirty-six places gets a distinct name', () => {
    const names = new Set<string>();
    for (const bank of ELECTRA_BANKS) {
      for (const row of bank.rows) {
        for (let knob = 1; knob <= 6; knob++) names.add(slotPositionName(row, knob));
      }
    }
    expect(names.size).toBe(ELECTRA_SLOT_COUNT);
  });
});
