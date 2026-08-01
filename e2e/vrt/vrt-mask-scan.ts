// e2e/vrt/vrt-mask-scan.ts
//
// THE MASK DETECTOR behind the anti-vacuity guard.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS AT ALL: the first version of the guard was EVADABLE.
//
// It grepped the VRT specs with `/^\s*mask:/m` — `mask:` had to be the first
// non-space token ON ITS OWN LINE. That is the PRETTIER-FORMATTED shape:
//
//     await expect(card).toHaveScreenshot('x.png', {
//       mask: [card.locator('canvas')],      // ← caught
//     });
//
// but it is NOT the only shape, and it is not even the shape this repo writes
// most often. A one-liner slips straight past:
//
//     await expect(card).toHaveScreenshot('x.png', { mask: [c] });   // ← MISSED
//
// An adversarial verifier injected exactly that into vrt-aspect-16x9.spec.ts
// and the guard stayed GREEN. A gate that only catches the tidy spelling of
// the thing it forbids is decoration — CLAUDE.md, "ask of any new gate: what
// is it structurally unable to see?".
//
// So the detector here is written the other way round: it deletes everything
// that CANNOT be code (comments, string and template literals), then looks for
// the `mask` PROPERTY in any position, on any line, in any of its spellings —
// `mask:`, `mask :`, `'mask':`, `"mask":`, and the object shorthand `{ mask }`.
//
// It is a pure string function on purpose. `vrt-mask-scan.test.ts` runs it
// against FIXTURES — including the exact one-liner that evaded the old regex —
// so the instrument is negative-controlled instead of trusted.

/** One hand-rolled mask occurrence. `line` is 1-indexed into the ORIGINAL
 *  source (comment/string blanking preserves newlines so it stays true). */
export interface MaskHit {
  line: number;
  /** The source line, trimmed — printed by the guard so the failure is
   *  actionable without opening the file. */
  text: string;
}

/**
 * Blank out every region of a TS/JS source that cannot contain executable
 * code: `//` line comments, block comments, and single / double / backtick
 * string literals. Blanked characters become spaces; NEWLINES ARE PRESERVED so
 * line numbers survive the transform.
 *
 * Deliberately a small hand-written scanner rather than a regex: nested
 * quoting ("a // b", `${'x'}`) is not regular, and a regex that gets it wrong
 * fails OPEN — it would blank real code and hide a mask, which is the exact
 * failure mode this whole file exists to close.
 */
export function stripNonCode(src: string): string {
  const out = new Array<string>(src.length);
  let i = 0;
  const keep = (n = 1): void => {
    for (let k = 0; k < n; k++) out[i + k] = src[i + k]!;
    i += n;
  };
  const blank = (n = 1): void => {
    for (let k = 0; k < n; k++) out[i + k] = src[i + k] === '\n' ? '\n' : ' ';
    i += n;
  };
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') blank();
      continue;
    }
    if (c === '/' && next === '*') {
      blank(2);
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) blank();
      if (i < src.length) blank(2);
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      blank(); // opening quote
      while (i < src.length) {
        if (src[i] === '\\') {
          blank(2);
          continue;
        }
        if (src[i] === quote) {
          blank(); // closing quote
          break;
        }
        blank();
      }
      continue;
    }
    keep();
  }
  return out.join('');
}

/** `mask:` / `mask :` as an object property, anywhere on a line. The leading
 *  class rejects identifiers that merely END in "mask" (`unmask:`, `myMask:`)
 *  and property access (`o.mask:` is not a thing, but `.mask` guards intent).
 *  `maskColor:` cannot match: after `mask` the next char is `C`, not `:`. */
const MASK_PROP = /(^|[^A-Za-z0-9_$.])mask\s*:/;

/** Object shorthand — `toHaveScreenshot(name, { mask })` — which passes a
 *  `mask` variable with no colon at all and would otherwise be invisible. */
const MASK_SHORTHAND = /(^|[^A-Za-z0-9_$.])mask\s*[,}]/;

/** QUOTED / COMPUTED property key — `{ 'mask': [x] }`, `{ ["mask"]: [x] }`.
 *  Matched against the RAW line, because `stripNonCode` (correctly) blanks the
 *  quoted key along with every other string literal. The trailing `:` OUTSIDE
 *  the quotes is what makes this a property and not prose: a string that merely
 *  CONTAINS the text (`'mask: [x]'`) keeps its colon inside the quotes and does
 *  not match. */
const MASK_QUOTED_KEY = /(['"])mask\1\s*\]?\s*:/;

/**
 * Every hand-rolled mask in `src`. Empty array = this file masks nothing
 * outside the shared capture seam.
 *
 * NOTE the scan is per-LINE only for REPORTING; detection itself runs on the
 * comment/string-stripped text, so a mask hidden mid-line, mid-expression, or
 * inside a nested object literal is still found.
 */
export function findHandRolledMasks(src: string): MaskHit[] {
  const stripped = stripNonCode(src);
  const strippedLines = stripped.split('\n');
  const rawLines = src.split('\n');
  const hits: MaskHit[] = [];
  for (let n = 0; n < strippedLines.length; n++) {
    const line = strippedLines[n]!;
    const raw = rawLines[n] ?? '';
    if (MASK_PROP.test(line) || MASK_SHORTHAND.test(line) || MASK_QUOTED_KEY.test(raw)) {
      hits.push({ line: n + 1, text: raw.trim() });
    }
  }
  return hits;
}
