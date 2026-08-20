// packages/web/src/lib/ui/controls/xy-pad-readout-source.test.ts
//
// THE PAD half of the resting-text ruling, denied at the PRIMITIVE level.
//
// ── WHY A FIFTH GATE, AND WHY THIS SHAPE (#2038) ────────────────────────────
//
// The owner has ruled against resting derived text five times now, and each
// mechanism passed the gate written for the one before it: the decimal under a
// dial (`persistentReadout`), the dock sidebar, the hero readout strip, the
// redundant per-control caption — and then `XyPad` painted
// `Orbit 0.00 / Elev 0.55` under every pad and SHIPPED that way into
// mirrorpool's committed baseline.
//
// ⚠ THE EXISTING GATES WERE NOT WRONG; THEY WERE AIMED ELSEWHERE, and the
// difference is the whole reason this file exists:
//
//   * `face-resting-text-source.test.ts` denies `ModuleFace` FIELDS. It asks
//     "does this declaration have a permitted text role?" — a question about
//     the def. A pad's decimals are not declared by any def; they are painted
//     unconditionally by a PRIMITIVE, so there was no field to refuse and the
//     gate was green by construction. That gate's formulation is right for what
//     it guards; it simply cannot see a renderer.
//   * `face-readout-source.test.ts` DOES read primitive source — and names its
//     own blind spot exactly: "ANY OTHER PRIMITIVE. It reads exactly the two
//     files named in `PRIMITIVES` … invisible here until someone adds it."
//     XyPad is the module that fell through that named hole.
//
// So the deny here is at the RENDERER: a pad-shaped primitive may compute a
// formatted number, but it may not put one in its MARKUP.
//
// ── ⚠ DERIVED MEMBERSHIP, NOT A NAMED FILE ─────────────────────────────────
//
// The subject is "every control primitive that is a 2-D manipulation surface",
// resolved by scanning for `role="application"` rather than by listing
// `XyPad.svelte`. That matters: a SECOND pad primitive is the obvious way this
// class comes back, and a named list would greet it with a green run. Today the
// scan resolves exactly one file, and the roster assertion below fails if it
// ever resolves ZERO — which is what stops the sweep from passing vacuously if
// the attribute is renamed or the directory moves.
//
// ── ⚠ WHAT THIS GATE STRUCTURALLY CANNOT SEE ───────────────────────────────
//
//   * TEXT THAT IS NOT A FORMATTED NUMBER. It denies numeric formatting reaching
//     markup. A pad that painted a hand-built string (`${x}` with no formatter,
//     or a state WORD) would pass. The permitted-roles list in
//     `face-resting-text-source` is the gate that reasons about roles; this one
//     reasons about numbers, because numbers are what the ruling names.
//   * NON-PAD PRIMITIVES. A new value-painting primitive that is not
//     `role="application"` is outside this scan and outside
//     `face-readout-source`'s two files. That hole is the same one this gate was
//     written to close, one shape over — it is narrowed, not eliminated.
//   * LEGACY CARDS. Untouched by the ruling, which was about faceplates.
//   * PIXELS. It cannot tell whether the removal LOOKS right; only the dock VRT
//     baselines and a human reviewing them can.
//   * WHAT A CONSUMER DOES WITH THE VALUE. A card is free to render its own
//     decimals next to a pad, and does not become visible here by doing so.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripSourceComments } from '$lib/source-guards/strip-source-comments';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Every `.svelte` in this directory that declares a 2-D manipulation surface.
 *  DERIVED — see the membership note in the header. */
function padPrimitives(): string[] {
  return readdirSync(HERE)
    .filter((f) => f.endsWith('.svelte'))
    .filter((f) => readFileSync(resolve(HERE, f), 'utf8').includes('role="application"'))
    .sort();
}

/** The MARKUP half only. A primitive is expected to FORMAT values in its script
 *  (the accessible name needs them); the ruling is about what reaches the DOM. */
function markupOf(file: string): string {
  const src = stripSourceComments(readFileSync(resolve(HERE, file), 'utf8'));
  const end = src.lastIndexOf('</script>');
  return end === -1 ? src : src.slice(end);
}

/**
 * Does this markup put a FORMATTED NUMBER into VISIBLE TEXT?
 *
 * ⚠ ATTRIBUTES ARE EXCLUDED BY REMOVING THE TAGS THAT CONTAIN THEM, and that
 * detail is load-bearing: `aria-label={`… ${fmt(x)} …`}` is the REQUIRED
 * destination for the value, so a gate that refused it would push the next
 * author back toward painting the number. Stripping `<…>` spans deletes every
 * attribute wholesale and leaves only text content, which is exactly the
 * population the ruling is about.
 *
 * ⚠ THE FIRST DRAFT TRIED TO DO THIS WITH A LOOKBEHIND ON `=` AND WAS WRONG —
 * the `{` in `${fmt(x)}` is preceded by `$`, not `=`, so an attribute holding a
 * template literal matched and the gate refused its own fix. The negative
 * control below is what caught it, which is why both directions are permanent
 * legs rather than a one-time check.
 */
function paintsNumber(markup: string): boolean {
  const textOnly = markup.replace(/<[^>]*>/g, '\n');
  return /\{[^}]*\b(?:fmt|toFixed)\s*\(/.test(textOnly);
}

describe('#2038 — a pad-shaped primitive paints NO resting decimal', () => {
  it('resolves a non-empty roster (the scan cannot pass vacuously)', () => {
    // ANCHORED TO THE ARTIFACT: if `role="application"` is renamed, or this
    // directory stops holding the primitives, the sweep below would sweep
    // nothing and report success. This is the leg that refuses that.
    expect(padPrimitives().length).toBeGreaterThan(0);
  });

  it('no pad primitive renders a formatted number in its MARKUP', () => {
    const offenders = padPrimitives().filter((f) => paintsNumber(markupOf(f)));
    expect(
      offenders,
      'a pad primitive paints a resting decimal. The value belongs in the pad\'s ' +
        'aria-label (role="application" has no aria-valuetext), and the row must be ' +
        'DELETED rather than hidden behind a prop — a `showReadout` flag is the ' +
        '`persistentReadout` mistake repeated (#2038).',
    ).toEqual([]);
  });

  it('POSITIVE CONTROL: the values still reach the accessibility tree', () => {
    // ⚠ WITHOUT THIS LEG THE GATE REWARDS DELETING THE DATA. "No painted
    // number" is satisfied perfectly by a pad that computes nothing at all, and
    // the ruling is that the value MOVES, not that it disappears. So each pad
    // must still format both axes into its accessible name.
    for (const f of padPrimitives()) {
      const src = stripSourceComments(readFileSync(resolve(HERE, f), 'utf8'));
      expect(src, `${f}: the pad must expose an aria-label`).toMatch(/aria-label=/);
      expect(
        /aria-label|ariaLabel/.test(src) && /\bfmt\s*\(|toFixed\s*\(/.test(src),
        `${f}: the axis values must still be FORMATTED into the accessible name — ` +
          'the ruling moves the number, it does not delete it',
      ).toBe(true);
    }
  });

  it('NEGATIVE CONTROL: the predicate fires on the shape that shipped', () => {
    // The literal markup #2038 removed. Without this, a predicate that matched
    // nothing would look identical to a clean tree.
    const shipped = `
      <div class="xy-readout">
        <span>{xLabel} <strong>{fmt(dispX)}</strong></span>
      </div>`;
    expect(paintsNumber(shipped)).toBe(true);
  });

  it('NEGATIVE CONTROL: the predicate does NOT fire on the required destination', () => {
    // The other direction, and the one that makes the gate usable: moving the
    // number into `aria-label` is the FIX, so a gate that refused it would push
    // the next author back toward painting it.
    expect(paintsNumber('<div aria-label={`x ${fmt(dispX)}`}></div>')).toBe(false);
  });
});
