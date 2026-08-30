// packages/web/src/lib/ui/controls/status-led-source.test.ts
//
// THE GATE THAT KEEPS `StatusLed` UNABLE TO PAINT A MEASUREMENT.
//
// ── WHY A SOURCE GATE AND NOT A RENDER TEST ────────────────────────────────
//
// The resting-text ruling has now been enforced three times by DELETING a
// mechanism, and each time the number reappeared wearing the next mechanism's
// clothes: `persistentReadout` → a sidebar `readouts` block → a hero readout
// row. `face-resting-text-source.test.ts` answered that by denying the SHAPE at
// the declaration surface. This file is the other end of the same argument: the
// one component a face may use for status is shaped so the refused form cannot
// be written, and this gate is what stops the shape being widened later.
//
// The widening is not hypothetical, it is a one-line temptation: add a `value`
// prop "just for the skip count", or interpolate `detail` into the caption
// "just so it is visible without hovering". Both are small, local, plausible
// edits that would pass every other gate in the repo — `face-readout-source`
// reads DEFS, `face-resting-text-source` reads the DECLARATION SURFACE and the
// SHELL, and neither one reads this component.
//
// ── ⚠ WHAT THIS GATE STRUCTURALLY CANNOT SEE ──────────────────────────────
//
//   * WHAT A CALLER PASSES. `caption={lit ? 'LATE 3' : 'OK'}` defeats the
//     invariance the model asserts, and it is written at the CALL SITE, not
//     here. The call-site half lives in `face-rack-status-source.test.ts`,
//     which requires a declaring body to pass a string LITERAL caption.
//   * WHETHER THE LAMP IS LEGIBLE. Only the dock VRT baseline can say whether a
//     7px dot reads as an indicator at all.
//   * ANY OTHER COMPONENT. This file is about ONE primitive. A module that
//     hand-rolls its own `<span>3 skipped</span>` is invisible here — that is
//     the extension-canvas blind spot, and the roster in
//     `face-rack-status-source.test.ts` is what names it.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LED = resolve(HERE, 'StatusLed.svelte');
const READOUT = resolve(HERE, 'Readout.svelte');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

/** The component's `<script>` block — where props are declared. */
function scriptOf(src: string): string {
  const m = /<script[^>]*>([\s\S]*?)<\/script>/.exec(src);
  return m ? m[1]! : '';
}

/** The component's MARKUP — everything outside `<script>` and `<style>`. This
 *  is the only region where a text node can exist. */
function markupOf(src: string): string {
  return src
    .replace(/<script[^>]*>[\s\S]*?<\/script>/g, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
}

/**
 * The TEXT the markup paints — the markup with every TAG removed, so what is
 * left is exactly the character data a user reads.
 *
 * ⚠ TAGS ARE STRIPPED WHOLE, deliberately. An earlier draft looked for
 * mustaches "not preceded by `=`" and mis-flagged Svelte's SHORTHAND ATTRIBUTE
 * form — `<span {title}>` is an attribute, not a text node, and a gate that
 * cannot tell those apart would push authors to write the longhand for no
 * reason. Anything inside `<...>` is markup; anything outside it is painted.
 */
function textOf(src: string): string {
  return markupOf(src).replace(/<[^>]*>/g, '');
}

/**
 * Props whose presence would re-open the deleted shape. Each is a real
 * spelling that has been used for "print this number" in this repo.
 */
const REFUSED_PROPS: readonly { prop: string; why: string }[] = [
  { prop: 'value', why: 'the readout shape by name — `Readout.svelte` takes exactly this' },
  { prop: 'units', why: 'only a printed quantity needs units' },
  { prop: 'precision', why: 'only a printed number needs decimals' },
  { prop: 'format', why: 'a formatter exists to turn a measurement into display text' },
  { prop: 'text', why: 'free display text is the sentence the ruling denies' },
  { prop: 'readLive', why: 'the rAF value-poller — a motorized number, the deleted decimal' },
];

describe('StatusLed — the refused shapes are UNREPRESENTABLE', () => {
  it('declares NO value-bearing prop', () => {
    const script = scriptOf(read(LED));
    const found = REFUSED_PROPS.filter((r) =>
      new RegExp(`^\\s*${r.prop}\\??\\s*:`, 'm').test(script),
    ).map((r) => `${r.prop} — ${r.why}`);
    expect(
      found,
      'StatusLed grew a prop that can carry a measurement into the component. The whole point of '
        + 'this primitive is that a face CANNOT paint a derived value through it: a caption is a '
        + 'static name, the state is a boolean rendered as a lamp, and the number goes to '
        + '`aria-label`/`title` via `detail`. If a number genuinely must be visible at rest, that '
        + 'is an owner decision about the ruling, not a prop.',
    ).toEqual([]);
  });

  it('⚠ NEGATIVE CONTROL: the same probe FINDS those props on `Readout.svelte`', () => {
    // Absence checks are the easiest thing in this repo to green by accident —
    // a renamed file, a changed prop syntax, a regex that matches nothing.
    // `Readout.svelte` is the shape being refused, preserved next door, so it
    // is the perfect positive control: the identical predicate must fire on it.
    const script = scriptOf(read(READOUT));
    const found = REFUSED_PROPS.filter((r) =>
      new RegExp(`^\\s*${r.prop}\\??\\s*:`, 'm').test(script),
    ).map((r) => r.prop);
    expect(
      found,
      'the probe no longer finds value props on Readout.svelte, so its ABSENCE on StatusLed '
        + 'proves nothing. Fix the probe, not the expectation.',
    ).toContain('value');
    expect(found).toContain('units');
    expect(found).toContain('readLive');
  });

  it('`detail` NEVER reaches a text node — attributes only', () => {
    // Every `{...}` left after the TAGS are stripped is character data the
    // component paints. The component has exactly one (`{caption}`).
    const painted = [...textOf(read(LED)).matchAll(/\{([^}]*)\}/g)].map((m) => m[1]!.trim());
    const offenders = painted.filter((e) => /detail|label|title/.test(e));
    expect(
      offenders,
      'a derived string is being painted as TEXT by StatusLed. `detail` is the measurement, and '
        + 'its home is `aria-label` + `title` — speakable, hoverable, assertable, unpainted. '
        + 'Putting it in a text node makes this primitive the fourth mechanism the resting-text '
        + 'gate was written to prevent.',
    ).toEqual([]);
  });

  it('the ONE text node is the caption, and the caption is announced', () => {
    // POSITIVE CONTROL for the leg above: if the component painted nothing at
    // all, the "no derived text" check would pass vacuously. Pinned as an
    // EXACT multiset, so a second painted expression of any kind reddens here.
    const painted = [...textOf(read(LED)).matchAll(/\{([^}]*)\}/g)].map((m) => m[1]!.trim());
    expect(painted, 'the component paints exactly one expression: its caption').toEqual([
      'caption',
    ]);
    const markup = markupOf(read(LED));
    expect(markup, 'the caption must still paint — a lamp with no name is decoration').toContain(
      '>{caption}<',
    );
    expect(markup, 'the measurement must still be announced').toMatch(/aria-label=\{/);
    expect(markup, 'and hoverable').toMatch(/\{title\}|title=\{/);
  });

  it('the state reaches the DOM as a class/attribute, never as a word', () => {
    const markup = markupOf(read(LED));
    // A lamp is a picture. `data-lit` is for specs (a spec asserting on a
    // colour would be asserting on a stylesheet), and it is a flag rather than
    // a rendering of the count.
    expect(markup).toMatch(/class:lit/);
    expect(markup).toMatch(/data-lit=/);
    const painted = [...textOf(read(LED)).matchAll(/\{([^}]*)\}/g)].map((m) => m[1]!.trim());
    expect(
      painted.filter((e) => /\blit\b/.test(e)),
      'the boolean is being printed as text somewhere in the markup — the state is a LAMP',
    ).toEqual([]);
  });
});
