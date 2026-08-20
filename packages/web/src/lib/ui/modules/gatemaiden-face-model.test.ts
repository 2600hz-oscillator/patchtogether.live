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
import { readFileSync } from 'node:fs';
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

describe('gatemaiden face — the CARD no longer owns anything the face needs', () => {
  const rawCardSrc = readFileSync(
    join(import.meta.dirname, 'GatemaidenCard.svelte'),
    'utf-8',
  );
  const cardSrc = stripComments(rawCardSrc);

  // ── THE INSTRUMENT'S OWN NEGATIVE CONTROLS, both directions, permanent ────
  it('INSTRUMENT — the stripper removes COMMENTS and keeps CODE', () => {
    // Direction 1: prose that would trip the denies is removed. Asserted
    // against the REAL card, so this leg dies the day the comments do — which
    // is the honest anchor, since that is also the day the strip stops being
    // load-bearing.
    expect(rawCardSrc).toMatch(/shapeLabels\s*=/); // …in a comment
    expect(rawCardSrc).toMatch(/\.params\.trigShape\s*=/); // …in a comment
    expect(stripComments(rawCardSrc)).not.toMatch(/shapeLabels\s*=/);

    // Direction 2: it does NOT eat real code. Without this, a stripper that
    // returned '' would pass every deny below and certify anything.
    expect(cardSrc).toMatch(/<NeonFader/);
    expect(cardSrc).toMatch(/function cycleShape/);
    expect(cardSrc.length).toBeGreaterThan(rawCardSrc.length / 4);

    // Direction 2b: the synthetic case, so the guarantee does not depend on
    // what this particular card happens to contain.
    expect(stripComments("const a = 1; // note\nconst b = 'https://x/y';")).toContain(
      "'https://x/y'",
    );
    expect(stripComments('code(); /* gone */ more();')).toBe('code();  more();');
  });

  it('the card does NOT re-declare the state names (ONE roster, on the def)', () => {
    // The defect was a card-local `const shapeLabels = ['△ TRI', '▭ SQR']`.
    // Deleting it is not enough on its own — the point is that the names now
    // have ONE home, so a rename cannot leave two surfaces disagreeing.
    expect(cardSrc).not.toMatch(/shapeLabels\s*=/);
    expect(cardSrc).toMatch(/paramSpec\(gatemaidenDef,\s*'trigShape'\)\.options/);
    // Both names must be absent as card literals. (The decorative glyphs may
    // stay; the NAMES may not.)
    expect(cardSrc).not.toMatch(/'△ TRI'/);
    expect(cardSrc).not.toMatch(/'▭ SQR'/);
  });

  it('the shape button writes through the TRACKED path, not the store', () => {
    // The paid `raw-write-ledger` debt. Anchored to the card SOURCE because the
    // ledger's own stale-entry check is: an entry naming a write that no longer
    // exists is RED, and the converse — a write that came BACK while the entry
    // stayed deleted — is what this leg holds.
    expect(cardSrc).not.toMatch(/\.params\.trigShape\s*=/);
    expect(cardSrc).not.toMatch(/\bpatch\.nodes\[/);
    expect(cardSrc).toMatch(/set\('trigShape'\)/);
  });
});
