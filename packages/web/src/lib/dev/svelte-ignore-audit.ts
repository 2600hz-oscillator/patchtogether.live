// packages/web/src/lib/dev/svelte-ignore-audit.ts
//
// `svelte-check --fail-on-warnings` (packages/web/package.json `typecheck`) makes
// every compiler warning a hard failure, so `<!-- svelte-ignore … -->` is now the
// ONLY way a warning survives. That makes the comment an exemption record, and an
// exemption record has to be readable and has to actually work. This module is the
// predicate behind both halves of that.
//
// ── The runes trap ───────────────────────────────────────────────────────────
// In runes mode Svelte parses the code list as COMMA-SEPARATED and treats
// everything from the first code that is not followed by a comma onward as prose:
//
//     for (const match of text.slice(len).matchAll(/([\w$-]+)(,)?/gm)) {
//       …push code…
//       if (!match[2]) break;          // ← no comma: the rest is prose
//     }
//                        (svelte/src/compiler/utils/extract_svelte_ignore.js)
//
// So `<!-- svelte-ignore a b -->` suppresses `a` and SILENTLY DISCARDS `b`. That is
// not a hypothetical: it was true at 8 live sites in this repo, where the author had
// written the exact code for the warning that was still firing. `droppedCodes` below
// is what those sites look like from the outside.
//
// The upside of the same rule: the prose reason can live INSIDE the ignore comment,
// which is why this file can demand one without inventing a side-car ledger.
//
// ── What this predicate is structurally UNABLE to see ────────────────────────
//   • whether a `svelte-ignore` suppresses anything at all. A dead exemption reads
//     exactly like a live one from the source alone — deciding needs two compiler
//     runs (one with the comments neutralised), which is not a unit-test shape.
//   • how WIDE a suppression is. A comment above a wrapper element covers the whole
//     subtree; that needs the AST, not the comment text.
//   • whether a code is spelled correctly. That one is covered elsewhere, and better:
//     with the codes comma-separated, the compiler itself emits `unknown_code` /
//     `legacy_code`, and `--fail-on-warnings` turns that into a red gate.
//
// And what the GATE THIS SERVES cannot see: svelte-check runs the Svelte compiler
// on `.svelte` files only — a `.svelte.ts` runes module is type-checked as plain
// TS, so a compiler warning there (e.g. `state_referenced_locally` in
// lib/audio/shared-clock.svelte.ts) reaches the vite-plugin-svelte build log and,
// measured on 2026-08-13, NO gate: svelte-check reported 0 warnings over the same
// tree where the vite build printed that warning. That half of the stream is now
// gated by lib/dev/runes-module-warnings.test.ts (#1602), which compiles every
// `*.svelte.{ts,js}` with the real `compileModule` and fails on any warning. This
// audit walks `.svelte.ts` files too, so the ignore COMMENTS that gate honours
// stay honest exemption records here.

/** One `svelte-ignore` comment, parsed the way the Svelte compiler parses it. */
export interface ParsedIgnore {
  /** Codes the compiler will ACTUALLY honour. */
  codes: string[];
  /**
   * Code-shaped tokens the compiler DISCARDS because the preceding code carried no
   * comma. Non-empty means the comment lies about what it suppresses.
   */
  droppedCodes: string[];
  /** Everything after the honoured code list — the human reason. */
  reason: string;
}

export interface IgnoreSite extends ParsedIgnore {
  file: string;
  /** 1-indexed line the `svelte-ignore` token sits on. */
  line: number;
  /** The comment text, for assertion messages. */
  raw: string;
}

export type IgnoreProblem =
  | { kind: 'dropped-codes'; site: IgnoreSite }
  | { kind: 'missing-reason'; site: IgnoreSite };

/**
 * Minimum characters of prose. Not a population count: it is a prose-quality floor
 * of the same family as the `why.length` floors on the repo's named exemption lists.
 * Short enough that "double-click-only rename; #1572." passes, long enough that a
 * bare "wontfix" does not.
 */
export const MIN_REASON_CHARS = 25;

const CODE_SHAPED = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

/**
 * Parse the text that FOLLOWS `svelte-ignore` inside a comment, mirroring
 * `extract_svelte_ignore` in runes mode. Exported so the test can drive it directly.
 */
export function parseIgnoreBody(body: string): ParsedIgnore {
  const codes: string[] = [];
  let consumedTo = 0;
  for (const m of body.matchAll(/([\w$-]+)(,)?/gm)) {
    codes.push(m[1]);
    consumedTo = (m.index ?? 0) + m[0].length;
    if (!m[2]) break;
  }
  const rest = body.slice(consumedTo);
  // Code-shaped tokens sitting at the FRONT of the prose are the discarded ones:
  // the author meant them as codes and the compiler read them as words.
  const dropped: string[] = [];
  let scan = rest;
  for (;;) {
    const m = scan.match(/^[\s,]*([\w$-]+)/);
    if (!m || !CODE_SHAPED.test(m[1])) break;
    dropped.push(m[1]);
    scan = scan.slice(m[0].length);
  }
  return {
    codes,
    droppedCodes: dropped,
    reason: scan
      .replace(/-->\s*$/, '')
      .replace(/\*\/\s*$/, '')
      .replace(/^[\s—–:-]+/, '')
      .replace(/\s+/g, ' ')
      .trim(),
  };
}

/**
 * Find every `svelte-ignore` comment in one file's source. Anchors on the literal
 * token and then expands to the enclosing comment, so a `//` inside a string
 * (`'https://…'`) can never be mistaken for a comment — the token has to be there
 * first. Handles `<!-- … -->`, `// …` and block comments.
 */
export function findIgnoreSites(file: string, source: string): IgnoreSite[] {
  const out: IgnoreSite[] = [];
  const token = /svelte-ignore\s/g;
  for (let m = token.exec(source); m; m = token.exec(source)) {
    const at = m.index;
    // A sentinel keeps `^` out of the line-comment test when the lookback window
    // was clipped, so the "what precedes the //" check always has a character to
    // look at. That check is the whole reason `'https://svelte-ignore …'` inside a
    // string is not read as a comment — the `//` of a URL is preceded by `:`.
    const before = (at >= 40 ? '' : '\n') + source.slice(Math.max(0, at - 40), at);
    let end: number;
    if (/<!--\s*$/.test(before)) {
      const close = source.indexOf('-->', at);
      end = close === -1 ? source.length : close;
    } else if (/\/\*\s*$/.test(before)) {
      const close = source.indexOf('*/', at);
      end = close === -1 ? source.length : close;
    } else if (/[\s{;>)]\/\/\s*$/.test(before)) {
      const nl = source.indexOf('\n', at);
      end = nl === -1 ? source.length : nl;
    } else {
      continue; // `svelte-ignore` in a string or in prose — not a suppression
    }
    const body = source.slice(at + m[0].length, end);
    out.push({
      file,
      line: source.slice(0, at).split('\n').length,
      raw: source.slice(at, end).replace(/\s+/g, ' ').trim(),
      ...parseIgnoreBody(body),
    });
  }
  return out;
}

/** Deny by default: every site must honour every code it names, and say why. */
export function auditIgnoreSites(sites: readonly IgnoreSite[]): IgnoreProblem[] {
  const problems: IgnoreProblem[] = [];
  for (const site of sites) {
    if (site.droppedCodes.length > 0) problems.push({ kind: 'dropped-codes', site });
    if (site.reason.length < MIN_REASON_CHARS) problems.push({ kind: 'missing-reason', site });
  }
  return problems;
}

export function describeProblem(p: IgnoreProblem): string {
  const where = `${p.site.file}:${p.site.line}`;
  if (p.kind === 'dropped-codes') {
    return (
      `${where}: svelte-ignore SILENTLY DISCARDS [${p.site.droppedCodes.join(', ')}] — ` +
      `in runes mode the codes must be comma-separated, so only [${p.site.codes.join(', ')}] ` +
      `is honoured. Write "svelte-ignore ${[...p.site.codes, ...p.site.droppedCodes].join(', ')} — <why>". ` +
      `Got: ${p.site.raw}`
    );
  }
  return (
    `${where}: svelte-ignore [${p.site.codes.join(', ')}] carries no reason ` +
    `(needs ≥${MIN_REASON_CHARS} chars of prose after the codes; got ${p.site.reason.length}). ` +
    `A suppression is an exemption record — say what makes this site correct, or what ` +
    `issue tracks fixing it. Got: ${p.site.raw}`
  );
}
