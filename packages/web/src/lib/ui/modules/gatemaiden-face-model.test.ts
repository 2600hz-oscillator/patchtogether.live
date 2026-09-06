// packages/web/src/lib/ui/modules/gatemaiden-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS behind the GATEMAIDEN faceplate.
//
// WHAT MAKES THIS FILE NECESSARY: this face exists because BOTH of its controls
// rendered wrong, and BOTH defects were invisible to every gate in the tree
// (#2025). Neither is a bug in a code path — each is the ABSENCE of one
// declaration on the def, which means the failure mode is silent, reversible by
// a one-line deletion, and produces a face that still looks complete:
//
//   · delete `trigShape.options` → `looksLikeToggle` takes over and the dock
//     paints an ANONYMOUS two-state switch. Nothing is red. The module's only
//     two state names simply stop existing anywhere a player can see.
//   · delete `face.paramCells.gateLen` → the shell substitutes a DIAL for the
//     throw the card has always drawn. Nothing is red; the value semantics are
//     identical.
//
// So every leg below is paired with a control that DELETES the declaration and
// asserts the defect comes back, calling the SAME resolver the shell renders
// from. A test that only asserted the good outcome would pass just as happily
// against a resolver that had stopped reading the declaration at all.
//
// ⚠ THESE ARE PARAM-SHAPE ASSERTIONS, NOT PIXEL ONES. What renders is proven by
// the VRT scenes; what this file proves is that the DECLARATIONS the renderer
// reads still say what the face was built on.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gatemaidenDef } from '$lib/audio/modules/gatemaiden';
import { paramCellKind, SEGMENTED_MAX_OPTIONS } from '$lib/ui/workflow/shell-control-kind';
import { primaryAudioOutPortId, glyphBinding } from '$lib/ui/workflow/shell-glyph-live';
import { paintsReadout, knobNameReadout } from '$lib/ui/controls/knob-vocabulary-model';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import type { ParamDef } from '$lib/graph/types';

const NONE: ReadonlySet<string> = new Set();

function param(id: string): ParamDef {
  const p = gatemaidenDef.params.find((q) => q.id === id);
  if (!p) throw new Error(`gatemaiden declares no param '${id}'`);
  return p;
}

/** The face's declared cells, in the shape `paramCellKind` consumes. */
function declaredCells(): ReadonlyMap<string, 'grid' | 'color' | 'hue' | 'fader'> {
  return new Map(Object.entries(gatemaidenDef.face?.paramCells ?? {}));
}

describe('gatemaiden face — the DEFAULTS the face was built on', () => {
  // Anchors every claim below to the artifact. A default change reddens here
  // first rather than silently invalidating the face's own comments — and the
  // rest state of a module is a property of its DEFAULTS, not of its code.
  it('the def still ships the defaults this face was authored against', () => {
    expect(param('gateLen').defaultValue).toBe(0.05);
    expect(param('gateLen').min).toBe(0.005);
    expect(param('gateLen').max).toBe(2);
    expect(param('gateLen').curve).toBe('log');
    expect(param('gateLen').units).toBe('s');

    expect(param('trigShape').defaultValue).toBe(0);
    expect(param('trigShape').curve).toBe('discrete');
    expect(param('trigShape').min).toBe(0);
    expect(param('trigShape').max).toBe(1);
  });

  it('the module BOOTS into a NAMED state, and that name is TRI', () => {
    // The face's whole argument for the roster is that a player can see which
    // of two behaviourally-different pulses is selected. That is only true if
    // the boot value resolves to a name at all.
    const p = param('trigShape');
    expect(knobNameReadout(p.defaultValue, p)).toBe('TRI');
  });

  it('is PROMOTED — an authored face outside STRICT_FACES ships as a no-op', () => {
    expect(STRICT_FACES.has('gatemaiden')).toBe(true);
  });
});

describe('gatemaiden face — trigShape: a DECLARED roster, not an anonymous switch', () => {
  it('the roster names EVERY reachable state, and neither name is a number', () => {
    const p = param('trigShape');
    const opts = p.options ?? [];
    // Discrete 0..1 ⇒ exactly two reachable values, both named.
    expect(opts.map((o) => o.value)).toEqual([0, 1]);
    expect(opts.map((o) => o.label)).toEqual(['TRI', 'SQR']);
    // A label that reads as a number would be a value readout wearing a name,
    // which is the shape the resting-text ruling denies.
    for (const o of opts) expect(Number.isNaN(Number(o.label))).toBe(true);
  });

  it('the names are ASCII, so the face does not depend on an UNPINNED font', () => {
    // The card draws a leading △ / ▭ and still may; the ROSTER may not. The VRT
    // font pin (e2e/vrt/_fonts.ts) bundles ~230-codepoint Latin subsets of Inter
    // and JetBrains Mono, so a geometric-shape glyph resolves through whatever
    // fontconfig picks on the runner — the exact per-run nondeterminism that
    // file exists to remove. Baking one into this face's baselines would
    // reintroduce it.
    for (const o of param('trigShape').options ?? []) {
      expect(/^[\x20-\x7E]+$/.test(o.label), `option '${o.label}' is not ASCII`).toBe(true);
    }
  });

  it('resolves SEGMENTED at the dock and a NAME-PAINTING knob in the lane', () => {
    const p = param('trigShape');
    expect(paramCellKind(p, NONE, 'dock', declaredCells())).toBe('segmented');
    expect(paramCellKind(p, NONE, 'lane', declaredCells())).toBe('knob');
    // Two states is comfortably inside the button-row budget, which is WHY the
    // dock gets buttons rather than a portaled Selector.
    expect((p.options ?? []).length).toBeLessThanOrEqual(SEGMENTED_MAX_OPTIONS);
    // The lane column cannot hold a roster, so the dial has to say which state
    // it is in. That is the one painted string on this control.
    expect(paintsReadout(p)).toBe(true);
    expect(knobNameReadout(0, p)).toBe('TRI');
    expect(knobNameReadout(1, p)).toBe('SQR');
  });

  it('NEGATIVE CONTROL — without the roster it collapses to an ANONYMOUS toggle', () => {
    // The pre-#2025 state, reconstructed by deleting exactly the declaration
    // this face added, and run through the SAME resolver.
    const { options: _dropped, ...bare } = param('trigShape');
    const anonymous = bare as ParamDef;

    expect(paramCellKind(anonymous, NONE, 'dock', declaredCells())).toBe('toggle');
    expect(paramCellKind(anonymous, NONE, 'lane', declaredCells())).toBe('toggle');
    // And — the half that actually hurt — NOTHING names the two states.
    expect(paintsReadout(anonymous)).toBe(false);
    expect(knobNameReadout(0, anonymous)).toBeNull();
    expect(knobNameReadout(1, anonymous)).toBeNull();
  });
});

describe('gatemaiden face — gateLen: a THROW, declared because it cannot be inferred', () => {
  it('resolves a FADER at every tier', () => {
    const p = param('gateLen');
    expect(gatemaidenDef.face?.paramCells?.gateLen).toBe('fader');
    expect(paramCellKind(p, NONE, 'dock', declaredCells())).toBe('fader');
    expect(paramCellKind(p, NONE, 'lane', declaredCells())).toBe('fader');
  });

  it('paints NO resting text of its own — it declares no roster and no format', () => {
    const p = param('gateLen');
    expect(paintsReadout(p)).toBe(false);
    expect(knobNameReadout(p.defaultValue, p)).toBeNull();
  });

  it('NEGATIVE CONTROL — undeclared, the shell substitutes a DIAL', () => {
    // Nothing in the ParamDef separates "a level drawn as a throw" from any
    // other continuous scalar, so the substitution is silent and total.
    expect(paramCellKind(param('gateLen'), NONE, 'dock', new Map())).toBe('knob');
    expect(paramCellKind(param('gateLen'), NONE, 'lane', new Map())).toBe('knob');
  });

  it('is CONTINUOUS, which is what makes `fader` legal on it at all', () => {
    // module-face-lint refuses a fader over a discrete param; asserted here too
    // so the reason travels with the declaration.
    expect(param('gateLen').curve).not.toBe('discrete');
    expect(param('gateLen').options).toBeUndefined();
  });
});

describe('gatemaiden face — the glyph is FORCED to none by the PORT TYPES', () => {
  it('declares none, and every other kind would resolve a DEAD static glyph', () => {
    expect(gatemaidenDef.face?.glyph).toBe('none');

    // The reason, run rather than reasoned: `primaryAudioOutPortId` matches
    // `type === 'audio'` and BOTH of this module's outputs are `gate`. So
    // `domain: 'audio'` does NOT imply an audio glyph.
    expect(primaryAudioOutPortId(gatemaidenDef)).toBeNull();
    expect(gatemaidenDef.outputs.map((o) => o.type)).toEqual(['gate', 'gate']);

    for (const kind of ['meter', 'waveform', 'envelope', 'algorithm', 'scope'] as const) {
      expect(
        glyphBinding({ ...gatemaidenDef, face: { ...gatemaidenDef.face, glyph: kind } } as never)
          .kind,
        `glyph '${kind}' would resolve a dead static plate`,
      ).toBe('static');
    }
    expect(glyphBinding(gatemaidenDef as never).kind).toBe('none');
  });
});

/**
 * Strip comments so a source-level deny cannot be tripped by PROSE.
 *
 * ⚠ THIS FUNCTION EXISTS BECAUSE IT CAUGHT ME. The two legs below deny
 * `shapeLabels =` and `.params.trigShape =` on the card. Both went red on first
 * run — not because the card still does either, but because the card's own
 * comments EXPLAIN that it used to, quoting the code they document removing.
 * That is the same comment-blindness that once left AnalogVcoCard and
 * KarplusCard sitting outside `RANGE_BOUND_CARDS` while fully bound, and
 * CLAUDE.md names the general form: the gate greps source, so it cannot tell
 * code from comment.
 *
 * The alternative fix — rewording the comments until the regex stops matching —
 * was rejected: it leaves the instrument blind and silently forbids the next
 * author from writing down what changed.
 *
 * ⚠ `//` IS ONLY STRIPPED WHEN NOT PRECEDED BY `:`, so a `'https://…'` inside a
 * string survives. A naive stripper eats the rest of that line, which is the
 * documented way this class of helper goes wrong.
 */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('gatemaiden — the SHAPE roster has exactly ONE home', () => {
  // ⚠ THIS DESCRIBE USED TO READ `GatemaidenCard.svelte` AND HELD THREE CLAIMS.
  // Two of them are now unspellable rather than untested, and the third — the
  // one that actually protected the player — is asserted at its real source.
  //
  //   1. "the stripper removes COMMENTS and keeps CODE". An instrument control
  //      on a comment-stripper that existed only to read the card safely. With
  //      no card source to read, the stripper has no caller and goes with it.
  //   2. "the shape button writes through the TRACKED path, not the store". A
  //      card-source deny (`.params.trigShape =`, `patch.nodes[`) anchoring a
  //      paid `raw-write-ledger` debt. The surviving surface writes every param
  //      through `shellParamWrite`, and `mutate.guard.test.ts` holds the
  //      raw-write rule across the whole tree, so the untracked write has no
  //      module-local place left to come back to. NAMED: the card-scoped
  //      converse ("a write that came BACK while the ledger entry stayed
  //      deleted") loses its module-local witness here.
  //   3. "the card does NOT re-declare the state names" — kept, and re-pointed
  //      below. The defect was a card-local
  //      `const shapeLabels = ['\u25b3 TRI', '\u25ad SQR']`, and the fix was ONE
  //      home for the names. That fix is checkable without a card: the def owns
  //      the roster, and no other source may re-type it.

  it('the DEF owns the roster, and the names are not re-typed on any surface', () => {
    const options = param('trigShape').options ?? [];
    expect(options.length, 'the def declares the two shape states').toBe(2);

    // \u26a0 THE SCAN LOOKS FOR THE RETIRED SPELLING, NOT THE DEF'S OWN LABELS, and
    // that is a deliberate narrowing rather than a weaker check. The def's names
    // are `TRI` and `SQR` \u2014 three-letter tokens that occur inside `TRIG`,
    // `TRIGGER` and `SQRT` all over the tree, so grepping for them reports 39
    // surfaces that have nothing to do with this roster. The card-local array
    // this leg exists for carried DECORATIVE GLYPHS the def deliberately does
    // not (`\u25b3 TRI`, `\u25ad SQR`), and that exact spelling is what a second, prettier
    // copy of the roster would be written as.
    const RETIRED = ['\u25b3 TRI', '\u25ad SQR'];

    // …and NOWHERE ELSE writes them. The scan is over every module-owned
    // surface — flat, plus one level of module subdirectory, the depth the
    // shell-extension glob loads a body from — so a re-typed roster in a face
    // body reddens exactly as a re-typed roster in a card used to.
    //
    // ⚠ COMMENTS ARE STRIPPED FIRST, for the reason the old card-scoped legs
    // stripped them: the surfaces around this module EXPLAIN the deleted
    // `shapeLabels` array in prose, quoting both names, and a raw grep cannot
    // tell the quotation from the defect. That is exactly the pressure that gets
    // explanations deleted to keep a regex green.
    const dir = import.meta.dirname;
    const offenders: string[] = [];
    const visit = (rel: string, abs: string): void => {
      const src = stripComments(readFileSync(abs, 'utf8'));
      for (const label of RETIRED) {
        if (src.includes(label)) offenders.push(`${rel} re-types the state name ${label}`);
      }
      if (/shapeLabels\s*=/.test(src)) offenders.push(`${rel} declares its own shapeLabels`);
    };
    let scanned = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        for (const inner of readdirSync(join(dir, entry.name))) {
          if (!inner.endsWith('.svelte')) continue;
          scanned++;
          visit(`${entry.name}/${inner}`, join(dir, entry.name, inner));
        }
        continue;
      }
      if (!entry.name.endsWith('.svelte')) continue;
      scanned++;
      visit(entry.name, join(dir, entry.name));
    }
    // A walk that resolved nothing would report an empty offender list too.
    expect(scanned, 'the surface walk resolved no .svelte files').toBeGreaterThan(0);
    expect(offenders, 'the state names must have exactly one home — the def').toEqual([]);
  });
});
