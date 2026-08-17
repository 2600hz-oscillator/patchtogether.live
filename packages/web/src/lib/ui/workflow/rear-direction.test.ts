// packages/web/src/lib/ui/workflow/rear-direction.test.ts
//
// THE GATE FOR "COLOUR MEANS CABLE DOMAIN, DIRECTION MEANS SOMETHING ELSE".
//
// #1800 unified the rear card's two rails onto one row grammar, and the shipped
// design had named the input/output SHAPE DIFFERENCE as one of its three
// direction cues. Unifying the shape spends that cue, so the redesign owes a
// replacement — and "we added a mirror" is a claim no other gate in the repo can
// check. `rear-card-model.test.ts` reads the MODEL, which has no geometry;
// `module-face-lint` reads DEFS; the VRT scenes are four PNGs that move for any
// reason at all. A direction channel could be deleted in a refactor and every
// one of them would stay green.
//
// So this file reads the COMPONENT SOURCE, in both directions:
//
//   1. ANCHORED — every channel declared in `rear-direction.ts` must still have
//      its selector/token in `RearCard.svelte`. A channel entry naming
//      something the component dropped is RED, so the declaration cannot
//      outlive the implementation and become documentation of a lie.
//   2. INVERTED — no direction-qualified rule may ASSIGN the domain hue or name
//      a domain token. That is the load-bearing half: it does not check that
//      direction has cues, it checks that direction has not STOLEN the one
//      channel that is already spoken for. A reviewer cannot eyeball this
//      across ~600 lines of CSS; a regex can.
//
// ⚠ WHAT THIS GATE STRUCTURALLY CANNOT SEE, and it is a lot:
//   • that a rule is REACHABLE, that the mirror is visible at the shipped
//     scale, or that any channel is perceptible to a human. It reads text.
//     The DOM/geometry half is `e2e/tests/workflow-rear-card.spec.ts`, which
//     measures the jack's real box on both rails; the "does it read" half is
//     the owner's eyes.
//   • ANY OTHER COMPONENT. It reads exactly one file. A second surface that
//     renders holes with its own CSS is outside this gate entirely.
//   • a channel that exists in the CSS but is not DECLARED — an undeclared cue
//     is invisible here by construction, which is why the declaration is the
//     deny-by-default list and not an inventory.
//
// Both halves carry a negative control that runs the SAME predicate against a
// mutated source, because a gate that has never been seen to fail is not a gate.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { REAR_DIRECTION_CHANNELS } from './rear-direction';

const CARD_PATH = fileURLToPath(new URL('./RearCard.svelte', import.meta.url));
const CARD_SRC = readFileSync(CARD_PATH, 'utf8');

/** The five RACKLINE domain hue tokens. Named here because a direction rule
 *  reaching for one of them by name is the bypass the `--rcd` check alone
 *  would miss. */
const DOMAIN_TOKENS = ['--rc-audio', '--rc-cv', '--rc-gate', '--rc-video', '--rc-poly'] as const;

/** One CSS rule: its selector list and its own declaration block (nested
 *  at-rule bodies are walked, so a rule inside `@media` is seen too). */
interface CssRule {
  selector: string;
  body: string;
}

/** The component's `<style>` contents. */
function styleBlock(src: string): string {
  const m = /<style>([\s\S]*)<\/style>/.exec(src);
  if (!m) throw new Error('RearCard.svelte has no <style> block — the gate reads nothing');
  return m[1]!;
}

/**
 * Flatten a CSS source into (selector, own-declarations) pairs.
 *
 * Brace-counting rather than a regex: `@media` / `@keyframes` nest, and a regex
 * that ignored nesting would attribute a nested rule's declarations to the
 * at-rule's "selector" and quietly stop seeing them.
 */
function cssRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  let head = 0;
  let j = 0;
  while (j < css.length) {
    if (css[j] !== '{') {
      j++;
      continue;
    }
    let depth = 1;
    let k = j + 1;
    while (k < css.length && depth > 0) {
      if (css[k] === '{') depth++;
      else if (css[k] === '}') depth--;
      k++;
    }
    const selector = css.slice(head, j).trim();
    const inner = css.slice(j + 1, k - 1);
    if (selector.startsWith('@')) rules.push(...cssRules(inner));
    else rules.push({ selector, body: inner });
    j = k;
    head = k;
  }
  return rules;
}

/** Does this selector single out ONE direction? `.in` / `.out` class tokens and
 *  any `[data-direction=…]` attribute match.
 *
 *  ⚠ The class token must be matched WHOLE (`\b` after it) and must follow a
 *  literal dot — that is what keeps `.inset`, `.outline` and `.dim` out while
 *  still catching the compound forms the card actually writes (`.rj.out`,
 *  `.rear-zone.in`, `.rj.out:hover`). An earlier draft also demanded a
 *  non-word char BEFORE the dot, which excluded every compound selector in the
 *  file — i.e. the check read green over a component it was not looking at. */
function isDirectionQualified(selector: string): boolean {
  return /\.(in|out)\b/.test(selector) || selector.includes('[data-direction=');
}

/** Declarations in `body` that ASSIGN a domain hue (`--rcd…: …`) or name a
 *  domain token anywhere. Reading `var(--rcd)` is fine and is the mechanism —
 *  it is how an output tile takes whatever hue its row already has. */
function domainAssignments(body: string): string[] {
  const hits: string[] = [];
  for (const decl of body.split(';')) {
    const d = decl.trim();
    if (!d) continue;
    if (/^--rcd(-\w+)?\s*:/.test(d)) hits.push(d);
    else if (DOMAIN_TOKENS.some((t) => d.includes(t))) hits.push(d);
  }
  return hits;
}

/** THE PREDICATE. Returns every offending (selector, declaration) pair. */
function directionColourOffenders(css: string): string[] {
  return cssRules(css)
    .filter((r) => isDirectionQualified(r.selector))
    .flatMap((r) => domainAssignments(r.body).map((d) => `${r.selector} { ${d} }`));
}

/** THE PREDICATE. Channels whose anchors are missing from `src`. */
function missingAnchors(src: string): string[] {
  return REAR_DIRECTION_CHANNELS.flatMap((c) =>
    c.anchors.filter((a) => !src.includes(a)).map((a) => `${c.id}: '${a}'`),
  );
}

describe('rear card — the DECLARED direction channels are the ones that ship', () => {
  it('every channel is anchored in RearCard.svelte (a channel cannot outlive its code)', () => {
    expect(
      missingAnchors(CARD_SRC).join('\n'),
      'a declared direction channel names something RearCard.svelte no longer has — ' +
        'either put the channel back or delete its entry, but do not leave the two disagreeing',
    ).toBe('');
  });

  it('NEGATIVE CONTROL: the anchor probe reports a channel whose code was removed', () => {
    // Same predicate, mutated source. Without this leg a probe that always
    // returned [] would read exactly like a healthy component.
    const mirror = REAR_DIRECTION_CHANNELS.find((c) => c.id === 'row-mirror')!;
    const anchor = mirror.anchors[0]!;
    const mutated = CARD_SRC.split(anchor).join('/* deleted */');
    expect(missingAnchors(mutated)).toContain(`row-mirror: '${anchor}'`);
    // …and it is specific: nothing else is reported by that one deletion.
    expect(missingAnchors(mutated)).toEqual([`row-mirror: '${anchor}'`]);
  });

  it('every channel states WHAT a reader sees and WHY it works without hue', () => {
    // Prose-quality floors, not a population count: they are thresholds on the
    // length of each entry's own text, and they do not encode how many channels
    // there are. A one-word `why` is how a channel becomes decoration.
    for (const c of REAR_DIRECTION_CHANNELS) {
      expect(c.what.length, `${c.id}: 'what' must describe the visible difference`).toBeGreaterThan(40);
      expect(c.why.length, `${c.id}: 'why' must argue the no-colour case`).toBeGreaterThan(60);
    }
    // Ids are unique — two entries under one id means one of them is unanchored
    // and nobody would notice.
    const ids = REAR_DIRECTION_CHANNELS.map((c) => c.id);
    expect(new Set(ids).size, `duplicate channel id: ${ids.join(', ')}`).toBe(ids.length);
  });

  it('at least one channel survives a SINGLE ROW seen in isolation', () => {
    // The specific property the unification spends and this redesign owes back.
    // ZONE and the section GLYPH both need their container in frame; a row
    // scrolled alone under the cursor has only its own geometry and chrome. So
    // the set must contain a per-row channel — asserted as a PROPERTY of the
    // declared kinds, never as "there are four".
    const perRow = REAR_DIRECTION_CHANNELS.filter(
      (c) => c.kind === 'geometry' || c.kind === 'chrome',
    );
    expect(
      perRow.map((c) => c.id),
      'every declared channel needs its container in frame — a row on its own would read as neither direction',
    ).not.toEqual([]);
  });
});

describe('rear card — COLOUR STAYS CABLE DOMAIN (direction never takes a hue)', () => {
  it('no direction-qualified rule assigns the domain hue or names a domain token', () => {
    expect(
      directionColourOffenders(styleBlock(CARD_SRC)).join('\n'),
      'a `.in` / `.out` / [data-direction] rule sets a domain colour. Colour on this card ' +
        'means CABLE DOMAIN and nothing else — the same port type must be the same hue on ' +
        'both rails. Carry the difference on geometry or chrome instead (rear-direction.ts).',
    ).toBe('');
  });

  it('the domain SETTERS are direction-free, so hue is a pure function of cable type', () => {
    // The other side of the same contract, stated positively: `--rcd` is
    // assigned only by domain classes, and none of those selectors mention a
    // direction. If one did, the same port type could resolve to two hues.
    const setters = cssRules(styleBlock(CARD_SRC)).filter((r) => /^--rcd\s*:/m.test(r.body.trim()) ||
      r.body.split(';').some((d) => /^\s*--rcd\s*:/.test(d)));
    expect(setters.length, '`--rcd` is assigned somewhere — otherwise this asserts nothing').toBeGreaterThan(0);
    for (const r of setters) {
      expect(isDirectionQualified(r.selector), `domain setter '${r.selector}' is direction-qualified`).toBe(false);
    }
  });

  it('NEGATIVE CONTROL: the predicate flags a direction rule that DOES take a hue', () => {
    // Both bypasses, so a fix to one cannot silently uncover the other.
    expect(directionColourOffenders('.rj.out { --rcd: hotpink; }')).toHaveLength(1);
    expect(directionColourOffenders('.rj.out .lab { color: var(--rc-gate); }')).toHaveLength(1);
    expect(directionColourOffenders('.rsec[data-direction="output"] { --rcd-wash: red; }')).toHaveLength(1);
    // …and it does NOT flag the legitimate shapes: reading the row's already
    // resolved hue, or a direction rule that touches no colour at all.
    expect(directionColourOffenders('.rj.out { background: var(--rcd-wash); }')).toEqual([]);
    expect(directionColourOffenders('.rj.out { flex-direction: row-reverse; }')).toEqual([]);
    // …nor a domain setter, which is direction-FREE and must stay legal.
    expect(directionColourOffenders('.rj.gate { --rcd: var(--rc-gate); }')).toEqual([]);
  });

  it('the rule walker sees inside @media (a nested bypass is not a hiding place)', () => {
    expect(
      directionColourOffenders('@media (prefers-reduced-motion: reduce) { .rj.out { --rcd: red; } }'),
    ).toHaveLength(1);
  });
});
