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
// It is a pure string function on purpose. The fixtures that negative-control
// it — including the exact one-liner that evaded the old regex, and the
// out-of-directory helper below — live in the guard that consumes it,
// `packages/web/src/lib/ui/vrt-live-surfaces.test.ts`
// (`describe('the mask detector itself')`). There is no `vrt-mask-scan.test.ts`:
// the web package's vitest `include` is `src/**/*.test.ts`, so a test file
// under e2e/ would never be collected by any lane — a test nobody runs is
// worse than a corrected pointer.
//
// ─────────────────────────────────────────────────────────────────────────
// THE SECOND HOLE: THE DETECTOR WAS RIGHT AND THE SCAN SET WAS TOO SMALL.
//
// Catching every spelling of `mask` is only half a gate. The guard fed this
// function `readdirSync(e2e/vrt)` — so a mask built in a helper module ONE
// DIRECTORY OVER was invisible, no matter how well this scanner worked:
//
//     // e2e/tests/_shot-opts.ts          ← never scanned
//     export const shotOpts = { mask: [/* … */] };
//
//     // e2e/vrt/whatever.spec.ts
//     import { shotOpts } from '../tests/_shot-opts';
//     await expect(card).toHaveScreenshot('x.png', shotOpts);   // ← invisible
//
// An adversarial verifier proved it with exactly that file while the guard's
// own comment claimed the hole was closed ("specs AND helpers, because a spec
// that calls `liveTextMasks(page)` from a helper module would otherwise move
// the mask out of the scanned file") — true only for helpers that happen to
// sit inside e2e/vrt/.
//
// The fix is to stop scanning a DIRECTORY and start scanning the IMPORT
// GRAPH: a mask can only reach a `toHaveScreenshot` in the VRT lane if the
// file defining it is reachable from a VRT spec. `collectMaskScanTargets`
// below walks that graph from the e2e/vrt entry files and follows every
// RELATIVE import wherever it leads. That is closed by construction rather
// than by a directory list somebody has to remember to widen, and it cannot
// false-positive on unrelated e2e specs (e2e/tests/toybox-node-batch.spec.ts
// has a legitimate `params: { op: 0, mask: 170 }` and is not reachable from
// any VRT spec, so it is never scanned).

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

// ───────────────────────────────────────────────────────────────────────────
// THE IMPORT-GRAPH WALK — what makes the scan set right, not just the detector.

/** Relative (`./` or `../`) module specifiers imported by `src`.
 *
 *  Deliberately scans the RAW source rather than the comment-stripped one:
 *  `stripNonCode` blanks string literals, and the specifier IS a string
 *  literal. Over-inclusion is safe here and under-inclusion is not — a
 *  commented-out import resolves to a real file that then gets scanned for
 *  masks (harmless), whereas a missed import re-opens the hole. */
export function parseLocalImports(src: string): string[] {
  const out: string[] = [];
  const patterns = [
    // `import x from './y'` / `export { x } from '../y'` / `export * from './y'`
    /\bfrom\s*['"](\.[^'"\n]+)['"]/g,
    // `import './side-effect'`
    /\bimport\s*['"](\.[^'"\n]+)['"]/g,
    // `await import('./y')` / `require('../y')`
    /\b(?:import|require)\s*\(\s*['"](\.[^'"\n]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) out.push(m[1]!);
  }
  return [...new Set(out)];
}

/** The filesystem operations the walk needs. Injected so the collector can be
 *  exercised against a synthetic tree in the guard's fixtures — the walk is
 *  itself an instrument, and an instrument nobody negative-controls is how
 *  this file got its first hole. */
export interface ScanFs {
  exists(path: string): boolean;
  read(path: string): string;
  /** POSIX-style path join/normalise. `node:path`'s `resolve` satisfies it. */
  resolve(...parts: string[]): string;
  /** Directory of a path. `node:path`'s `dirname` satisfies it. */
  dirname(path: string): string;
}

/** Resolve one relative specifier to a real file, trying the extensions a
 *  TS/ESM import may omit. Returns null when nothing resolves (a bare package,
 *  a `?url` asset, a directory with no index). */
function resolveSpecifier(fromFile: string, spec: string, fs: ScanFs): string | null {
  const base = fs.resolve(fs.dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.mts`,
    `${base}.js`,
    // `./foo.js` in TS ESM means `./foo.ts` on disk.
    base.endsWith('.js') ? `${base.slice(0, -3)}.ts` : `${base}.tsx`,
    fs.resolve(base, 'index.ts'),
    fs.resolve(base, 'index.js'),
  ];
  for (const c of candidates) {
    if (c.endsWith('.ts') || c.endsWith('.mts') || c.endsWith('.tsx') || c.endsWith('.js')) {
      if (fs.exists(c)) return c;
    }
  }
  return null;
}

/**
 * Every file a mask could hide in: the entry files, plus everything they
 * import transitively by RELATIVE specifier, wherever it lives.
 *
 * Returns absolute paths, entries first, each exactly once. A cycle is fine
 * (the visited set closes it) and an unresolvable specifier is skipped.
 */
export function collectMaskScanTargets(args: { entries: string[]; fs: ScanFs }): string[] {
  const { entries, fs } = args;
  const seen = new Set<string>();
  const order: string[] = [];
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    order.push(file);
    if (!fs.exists(file)) continue;
    for (const spec of parseLocalImports(fs.read(file))) {
      const resolved = resolveSpecifier(file, spec, fs);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return order;
}
