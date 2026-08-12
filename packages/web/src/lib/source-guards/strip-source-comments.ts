// packages/web/src/lib/source-guards/strip-source-comments.ts
//
// ONE quote-aware comment stripper for every SOURCE-LEVEL gate in the repo.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// A source-level gate greps text. Its own subject matter — "this card must not
// re-type `xMin={-1}`" — is also the natural way to WRITE DOWN what the gate
// forbids, so the moment anyone explains a fix in a comment, a raw grep flags
// the explanation as the offence. That is not hypothetical: it has now happened
// three separate times in this tree, each time discovered on the guard's FIRST
// run and each time patched locally with a different one-off regex:
//
//   * lfo-face-model.test.ts:279 — "the card's own comment quotes the literals
//     it is documenting the removal of, so an un-stripped grep flags the
//     explanation as the offence (it did, first run)."
//   * mutate.guard.test.ts:102 — "this very file and `raw-write-ledger.ts`
//     quote `t.params.mode = m` in their headers to explain the bug, and a
//     comment-blind scan reported its own documentation as an offender."
//   * midi-input-ownership.test.ts:42 — "the sweep probe duly flagged the seam
//     itself on its first run."
//
// ⚠ AND THE FALSE-NEGATIVE IS THE DANGEROUS HALF, not the red run. A red gate
// gets noticed in ten seconds. But `card-range-source`'s artifact anchor
// (`allCardSources()` → `literalCounts()`) uses "this card contains zero
// literals" to decide a card is CONVERTED and must therefore stay enrolled. A
// genuinely-converted card whose comment quotes `xMin={-1}` reads as
// `range !== 0`, so the anchor silently STOPS demanding its enrolment and the
// card can be delisted with nothing going red. Comment blindness is not a
// cosmetic annoyance in an anchored gate; it is a hole in the anchor.
//
// ── WHY NOT A REGEX ────────────────────────────────────────────────────────
//
// The three one-off fixes above are all regexes and all of them are wrong on
// input that exists in this repo:
//
//   `src.replace(/\/\/[^\n]*/g, '')`        eats `'https://x'`
//   `src.replace(/^\s*\/\/.*$/gm, '')`      only strips FULL-LINE comments, so
//                                           `foo(); // xMin={-1}` survives
//   `src.replace(/(^|[^:])\/\/[^\n]*/g,'')` (webgl-attest-lib) still eats
//                                           `` `a // b` `` and `/[//]/`
//
// and a bare `ts.createScanner()` loop fails the last one too, because `/` is
// only re-scanned as a RegularExpressionLiteral when the PARSER asks it to
// (see the standing note in scripts/attest-code-basis.ts). `attest-code-basis`
// solves this properly with a real TypeScript parse — but it RE-EMITS
// normalized TS, drops `docs`/`face` def properties, and handles a `.svelte`
// file's `<script>` block ONLY. A card gate needs the MARKUP, comments removed,
// offsets intact. So: a character scanner, quote- AND regex-aware, that
// replaces comment bytes with spaces so line and column numbers do not move.
//
// ⚠ WHAT THIS IS AND IS NOT FOR. This is a GATE instrument, not a compiler
// front-end and not an attest normalizer. It must never be used to decide what
// bytes feed a hash — `scripts/attest-code-basis.ts` is the single authority
// there, and duplicating that decision here would be exactly the two-sources-
// of-truth defect these gates exist to catch. Its contract is narrower and
// checkable: text that is a COMMENT becomes whitespace; text that is not a
// comment survives byte-identically.

/** What `stripSourceComments` removed, for a gate that wants to say so. */
export interface StripReport {
  /** Bytes of `//` line-comment removed. */
  line: number;
  /** Bytes of block (`/* … *\/`) comment removed. */
  block: number;
  /** Bytes of HTML (`<!-- … -->`) comment removed. */
  html: number;
}

/** The characters after which a `/` opens a REGEX LITERAL rather than being a
 *  division operator. This is the standard lexer heuristic and it is what makes
 *  `/[//]/` survive: inside a regex literal the `//` is content, not a comment.
 *
 *  ⚠ It is a heuristic, and the direction of its error matters. If it wrongly
 *  decides a `/` opens a regex, the scanner keeps scanning for the closing `/`
 *  and could swallow real code — so the scan BAILS on a newline (a regex
 *  literal cannot span one) and treats the `/` as an operator after all. The
 *  failure mode is therefore "a comment survives", which reddens a gate, never
 *  "code disappears", which would blind one. */
const REGEX_PRECEDERS = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>',
]);

/**
 * Replace every comment in `src` with spaces (newlines preserved), leaving all
 * other bytes untouched.
 *
 * Handles, because all four occur in this tree's card + module sources:
 *   * `'…'` / `"…"` string literals, with backslash escapes;
 *   * `` `…${ … }…` `` template literals, INCLUDING nested strings and nested
 *     templates inside the `${}` substitutions;
 *   * `/…/flags` regex literals, including `/[//]/` and `/https?:\/\//`;
 *   * `<!-- … -->` markup comments (Svelte), which no TS-based tool strips.
 *
 * Offsets are preserved: `stripSourceComments(s).length === s.length`, and the
 * line count is unchanged, so a gate can still report `line.trim()` and have it
 * mean something.
 */
export function stripSourceComments(src: string): string {
  return stripSourceCommentsWithReport(src).text;
}

/** `stripSourceComments` plus a count of what it removed. Exported so a gate's
 *  negative control can assert the stripper DID something, rather than passing
 *  because the fixture happened to contain no comments at all. */
export function stripSourceCommentsWithReport(src: string): {
  text: string;
  report: StripReport;
} {
  const out: string[] = [];
  const report: StripReport = { line: 0, block: 0, html: 0 };
  // Template-literal nesting: each entry is the depth of `{` seen inside the
  // current `${ … }` substitution. Empty = not inside a template substitution.
  const templateStack: number[] = [];
  let i = 0;
  const n = src.length;

  /** Emit `count` blanks, preserving any newlines in the consumed span. */
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) out.push(src[k] === '\n' ? '\n' : ' ');
  };

  /** The last non-whitespace character already emitted as CODE — decides
   *  whether a `/` opens a regex literal. */
  const lastCodeChar = (): string => {
    for (let k = out.length - 1; k >= 0; k--) {
      const c = out[k]!;
      if (c !== ' ' && c !== '\n' && c !== '\t' && c !== '\r') return c;
    }
    return '';
  };

  while (i < n) {
    const c = src[i]!;
    const next = src[i + 1];

    // ── HTML comment ────────────────────────────────────────────────────
    if (c === '<' && src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      const stop = end === -1 ? n : end + 3;
      report.html += stop - i;
      blank(i, stop);
      i = stop;
      continue;
    }

    // ── line comment ────────────────────────────────────────────────────
    if (c === '/' && next === '/') {
      let stop = src.indexOf('\n', i);
      if (stop === -1) stop = n;
      report.line += stop - i;
      blank(i, stop);
      i = stop;
      continue;
    }

    // ── block comment ───────────────────────────────────────────────────
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      report.block += stop - i;
      blank(i, stop);
      i = stop;
      continue;
    }

    // ── regex literal ───────────────────────────────────────────────────
    // Only where a regex can legally start, and only if it CLOSES on this
    // line (a regex literal cannot span a newline). If it does not close, we
    // fall through and treat the `/` as an ordinary operator character — the
    // safe direction, per the note on REGEX_PRECEDERS.
    if (c === '/' && (out.length === 0 || REGEX_PRECEDERS.has(lastCodeChar()))) {
      const close = scanRegex(src, i);
      if (close !== -1) {
        out.push(src.slice(i, close));
        i = close;
        continue;
      }
    }

    // ── string literal ──────────────────────────────────────────────────
    if (c === "'" || c === '"') {
      const close = scanQuoted(src, i, c);
      out.push(src.slice(i, close));
      i = close;
      continue;
    }

    // ── template literal ────────────────────────────────────────────────
    if (c === '`') {
      out.push(c);
      i++;
      templateStack.push(0);
      // Consume template CHUNKS here; `${` hands control back to the main
      // loop (so a comment inside a substitution IS stripped), and the
      // matching `}` re-enters the chunk scanner via the stack.
      i = consumeTemplateChunk(src, i, out, templateStack);
      continue;
    }

    // ── back into a template chunk after a `${ … }` substitution ────────
    if (c === '}' && templateStack.length > 0) {
      const depth = templateStack[templateStack.length - 1]!;
      if (depth === 0) {
        out.push(c);
        i++;
        i = consumeTemplateChunk(src, i, out, templateStack);
        continue;
      }
      templateStack[templateStack.length - 1] = depth - 1;
      out.push(c);
      i++;
      continue;
    }
    if (c === '{' && templateStack.length > 0) {
      templateStack[templateStack.length - 1] = templateStack[templateStack.length - 1]! + 1;
      out.push(c);
      i++;
      continue;
    }

    out.push(c);
    i++;
  }

  return { text: out.join(''), report };
}

/** Index just past the closing quote of the `'`/`"` literal starting at `i`. */
function scanQuoted(src: string, i: number, quote: string): number {
  let k = i + 1;
  while (k < src.length) {
    const c = src[k]!;
    if (c === '\\') {
      k += 2;
      continue;
    }
    if (c === quote) return k + 1;
    // An unterminated string cannot cross a newline in any language we scan;
    // bail so a stray apostrophe in prose cannot swallow the rest of the file.
    if (c === '\n') return k;
    k++;
  }
  return k;
}

/** Index just past the closing `/` + flags of the regex literal starting at
 *  `i`, or -1 if it does not close before the end of the line. Character
 *  classes are tracked so `/[//]/` and `/[/]/` scan correctly. */
function scanRegex(src: string, i: number): number {
  let k = i + 1;
  let inClass = false;
  // An empty regex `//` is a line comment, never a regex — the caller has
  // already handled that case, but guard so we can't return a bogus span.
  if (src[k] === '/' || src[k] === '*') return -1;
  while (k < src.length) {
    const c = src[k]!;
    if (c === '\\') {
      k += 2;
      continue;
    }
    if (c === '\n') return -1;
    if (inClass) {
      if (c === ']') inClass = false;
    } else if (c === '[') {
      inClass = true;
    } else if (c === '/') {
      k++;
      while (k < src.length && /[a-z]/.test(src[k]!)) k++;
      return k;
    }
    k++;
  }
  return -1;
}

/** Consume template-literal CHUNK bytes from `i` until either the closing
 *  backtick (pops the stack) or a `${` substitution (returns, leaving the main
 *  loop to scan the expression — which is what strips comments inside it). */
function consumeTemplateChunk(
  src: string,
  i: number,
  out: string[],
  templateStack: number[],
): number {
  let k = i;
  while (k < src.length) {
    const c = src[k]!;
    if (c === '\\') {
      out.push(src.slice(k, k + 2));
      k += 2;
      continue;
    }
    if (c === '`') {
      out.push(c);
      templateStack.pop();
      return k + 1;
    }
    if (c === '$' && src[k + 1] === '{') {
      out.push('${');
      return k + 2;
    }
    out.push(c);
    k++;
  }
  return k;
}
