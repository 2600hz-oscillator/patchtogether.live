// scripts/attest-code-basis.ts
//
// THE ONE PLACE that decides "what part of a basis file is CODE" for every
// local-attestation content hash (webgl / collab / grand) and for the ART
// source pins. Shared so the three attests cannot drift apart — the asymmetry
// WAS the bug (webgl had a docs escape hatch, collab had none, so a two-line
// comment edit under packages/server/src forced a full relay re-attest, #1422).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
//
// An attest certifies that some SUBSTANCE still behaves correctly on real
// hardware: the GPU renders these shaders, the relay converges this sync layer,
// the clip math produces this audio. Its content hash exists to answer ONE
// question — "could this edit have changed that behaviour?"
//
// Comments and documentation prose CANNOT. So the hash must be blind to them BY
// CONSTRUCTION, not by an opt-in marker a human has to remember. The previous
// mechanism — an opt-in `docs-hash-ignore` comment marker, stripped by a regex
// in webgl-attest-lib — reached 85 marker pairs across 79 files plus a
// dedicated lint whose only job was catching a FORGOTTEN marker before it cost
// a ~10-min GPU re-attest. Every one of those is deleted by this module.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE MECHANISM — AST re-emit, not a regex
//
// A naive `//`-stripping regex is WRONG on real source: it eats the tail of
//   const u = 'https://x';            // `//` inside a string literal
//   const t = `a // b`;               // `//` inside a template literal
//   const re = /[//]/;                // `//` inside a regex character class
// The last one is the nastiest — even TypeScript's own SCANNER gets it wrong in
// a bare `scan()` loop, because `/` is only re-scanned as a RegularExpression-
// Literal when the PARSER asks it to. So we do not scan; we PARSE:
//
//   1. `ts.createSourceFile` — the real TypeScript parser. Every string,
//      template and regex literal is now a single token by construction.
//   2. `ts.transform` drops the nodes that are documentation, not code.
//   3. `ts.createPrinter({ removeComments: true }).printFile(...)` re-emits the
//      remaining AST. Comments are trivia; the printer never writes them back.
//
// String-safety is therefore a PROPERTY OF THE PARSER, not of a pattern we got
// right. `attest-code-basis.test.ts` feeds it all three hostile forms above and
// asserts they survive byte-for-byte.
//
// A useful side effect: the printer normalises formatting, so a pure re-indent
// or line-rewrap is hash-neutral too.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS TREATED AS DOCUMENTATION (removed from the hash)
//
//   * ALL comments — line, block, JSDoc, in every .ts/.js/.svelte<script>.
//   * The `docs` / `controlFamilies` / `face` properties of a MODULE-SCOPE
//     definition object literal (`export const fooDef: X = { … }`). These are
//     living-docs prose and UI curation; they reach no GPU / relay / audio code.
//     The module-scope restriction is deliberate — see HASH_TRANSPARENT_PROPS.
//   * Type-only import declarations (`import type { ModuleDocs } from …`).
//     Erased by the compiler, so provably runtime-neutral — and without this,
//     ADDING docs to a def that had none would still churn the hash via the
//     import line it needs.
//
// WHAT IS STILL HASHED (the scope this module does NOT cover — asserted, not
// merely documented, by `attest-code-basis.test.ts` §scope):
//
//   * `.toml` / `.sql` / `.snap` / any other extension → RAW BYTES. Their
//     comment syntaxes are not parsed here; over-invalidation is the safe
//     direction and these files essentially never churn.
//   * Svelte MARKUP comments (`<!-- … -->`). Only `<script>` bodies are
//     normalised. Raw markup keeps its bytes.
//   * TYPE declarations (`interface`, `type`, property signatures) other than
//     type-only imports. They are erased too, but they describe the contract
//     and we keep the hash conservative there.
//   * A file the parser reports syntax errors for → RAW BYTES (fail to the
//     conservative side rather than hash a half-parsed tree).

import ts from 'typescript';

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Object-literal properties that are DOCUMENTATION or UI CURATION, never
 * behaviour. Removed from the hash so authoring them is free.
 *
 * ⚠ Only stripped when the property is a DIRECT member of a MODULE-SCOPE
 * object literal (`export const fooDef = { … }`), which is the only shape a
 * module definition ever takes in this repo. `face` is why: a WebGL module may
 * legitimately carry a `face:` on a nested geometry/cube-side object, and
 * stripping THAT would be a missed re-attest — the unsafe direction. Restricting
 * to the def's own top level makes the collision impossible.
 * (`attest-code-basis.test.ts` negative-controls exactly this.)
 */
export const HASH_TRANSPARENT_PROPS: readonly string[] = ['docs', 'controlFamilies', 'face'];

/**
 * package.json fields that cannot change ANY attested behaviour: npm-script
 * strings and package prose. Everything else (dependencies, devDependencies,
 * overrides, engines, exports, workspaces, …) stays in the hash.
 *
 * This is a DENY-list on purpose. The collab/grand attests narrow their
 * package.json pins with an ALLOW-list of relevant dep names, which risks a
 * missed re-attest from a dep nobody listed; a deny-list of prose fields cannot.
 * It fixes the measured #1425 incident: a one-word edit to an `e2e/package.json`
 * npm script moved the WebGL hash `620fa1b3…` → `ad300c3e…` and demanded a
 * trusted-machine GPU re-attest for a CLI flag.
 */
export const NON_CODE_PACKAGE_JSON_FIELDS: readonly string[] = [
  'scripts',
  'name',
  'version',
  'description',
  'keywords',
  'author',
  'contributors',
  'license',
  'homepage',
  'repository',
  'bugs',
];

/** How a given basis file's bytes are reduced to "the code". */
export type NormalizeMode = 'typescript' | 'svelte' | 'package-json' | 'raw';

const TS_LIKE = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx)$/;

/** The normalisation mode for a repo-relative basis path. Pure — no I/O. */
export function normalizeModeFor(relPath: string): NormalizeMode {
  if (relPath.endsWith('/package.json') || relPath === 'package.json') return 'package-json';
  if (relPath.endsWith('.svelte')) return 'svelte';
  if (TS_LIKE.test(relPath)) return 'typescript';
  return 'raw';
}

function scriptKindFor(relPath: string): ts.ScriptKind {
  if (relPath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (relPath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(relPath)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

// ---------------------------------------------------------------------------
// TypeScript: parse → drop documentation nodes → re-emit without comments
// ---------------------------------------------------------------------------

function propertyName(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

/**
 * True iff `obj` is the initializer of a MODULE-SCOPE variable declaration —
 * `export const fooDef: X = { … }`, optionally wrapped in `as`/`satisfies`/
 * parentheses. Anything nested inside a function, a class, another object or an
 * array returns false.
 */
function isModuleScopeDefObject(obj: ts.ObjectLiteralExpression): boolean {
  let node: ts.Node = obj;
  for (;;) {
    const parent: ts.Node | undefined = node.parent;
    if (!parent) return false;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isTypeAssertionExpression(parent)
    ) {
      node = parent;
      continue;
    }
    if (!ts.isVariableDeclaration(parent) || parent.initializer !== node) return false;
    // VariableDeclaration → VariableDeclarationList → VariableStatement → SourceFile
    const list = parent.parent;
    const stmt = list?.parent;
    return !!stmt && ts.isVariableStatement(stmt) && !!stmt.parent && ts.isSourceFile(stmt.parent);
  }
}

/** What a normalisation actually did — for the scope/measurement gates. */
export interface NormalizeReport {
  mode: NormalizeMode;
  /** Names of the hash-transparent properties removed (with duplicates). */
  strippedProps: string[];
  /** Type-only `import type …` declarations removed. */
  strippedTypeImports: number;
  /** True when the parser reported syntax errors and we fell back to raw bytes. */
  parseFallback: boolean;
}

function emptyReport(mode: NormalizeMode): NormalizeReport {
  return { mode, strippedProps: [], strippedTypeImports: 0, parseFallback: false };
}

function normalizeTs(text: string, fileName: string, report: NormalizeReport): string {
  const sf = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(fileName),
  );
  // `parseDiagnostics` is internal but stable, and it is the only way to learn
  // that the tree we are about to hash is a guess. A guessed tree must not
  // silently become the basis — fall back to the raw bytes (over-invalidate).
  const diagnostics = (sf as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics;
  if (diagnostics && diagnostics.length > 0) {
    report.parseFallback = true;
    return text;
  }

  // Pre-pass over the ORIGINAL tree (parents intact) to pick the nodes to drop.
  const doomed = new Set<ts.Node>();
  const collect = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node) && isModuleScopeDefObject(node)) {
      for (const member of node.properties) {
        const name = propertyName(member.name);
        if (name && HASH_TRANSPARENT_PROPS.includes(name)) {
          doomed.add(member);
          report.strippedProps.push(name);
        }
      }
    }
    if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) {
      doomed.add(node);
      report.strippedTypeImports += 1;
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  const transformer: ts.TransformerFactory<ts.SourceFile> = (ctx) => (root) => {
    const visit: ts.Visitor = (node) =>
      doomed.has(node) ? undefined : ts.visitEachChild(node, visit, ctx);
    return ts.visitNode(root, visit) as ts.SourceFile;
  };

  const result = ts.transform(sf, [transformer]);
  try {
    const printer = ts.createPrinter({
      removeComments: true,
      newLine: ts.NewLineKind.LineFeed,
      omitTrailingSemicolon: false,
    });
    return printer.printFile(result.transformed[0] as ts.SourceFile);
  } finally {
    result.dispose();
  }
}

// ---------------------------------------------------------------------------
// Svelte: normalise <script> bodies, keep markup verbatim
// ---------------------------------------------------------------------------

/**
 * Find `<script …>` … `</script>` spans.
 *
 * This is NOT a heuristic HTML parse. `<script>` is a RAW TEXT element: by the
 * HTML tokenizer's own rule its content ends at the first `</script`, and a
 * literal `</script>` therefore cannot appear inside a string in the script —
 * it must be escaped. So "the first `</script>` wins" IS the language rule.
 * The opening tag's end is found with a quote-aware scan so an attribute value
 * containing `>` (Svelte's `generics="T extends A<B>"`) cannot truncate it.
 */
export function svelteScriptSpans(text: string): { openEnd: number; bodyEnd: number }[] {
  const spans: { openEnd: number; bodyEnd: number }[] = [];
  const open = /<script\b/gi;
  let m: RegExpExecArray | null;
  while ((m = open.exec(text))) {
    let i = m.index + m[0].length;
    let quote: string | null = null;
    for (; i < text.length; i++) {
      const c = text[i]!;
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
    }
    if (i >= text.length) break; // unterminated open tag — leave the rest raw
    const openEnd = i + 1;
    const close = text.toLowerCase().indexOf('</script', openEnd);
    if (close < 0) break;
    spans.push({ openEnd, bodyEnd: close });
    open.lastIndex = close;
  }
  return spans;
}

function normalizeSvelte(text: string, fileName: string, report: NormalizeReport): string {
  const spans = svelteScriptSpans(text);
  if (spans.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const { openEnd, bodyEnd } of spans) {
    out += text.slice(cursor, openEnd);
    out += '\n' + normalizeTs(text.slice(openEnd, bodyEnd), fileName + '.script.ts', report) + '\n';
    cursor = bodyEnd;
  }
  out += text.slice(cursor);
  return out;
}

// ---------------------------------------------------------------------------
// package.json: keep the dependency/config surface, drop scripts + prose
// ---------------------------------------------------------------------------

/** Stable JSON: keys sorted at every level, so a pure reordering is neutral. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(obj)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]))
      .join(',') +
    '}'
  );
}

/**
 * A package.json reduced to the fields that can change attested behaviour.
 * Falls back to the raw text if the JSON does not parse (the safe direction).
 */
export function packageJsonCodeDigest(text: string, report?: NormalizeReport): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (report) report.parseFallback = true;
    return text;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return text;
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (NON_CODE_PACKAGE_JSON_FIELDS.includes(k)) continue;
    kept[k] = v;
  }
  return stableStringify(kept);
}

// ---------------------------------------------------------------------------
// The entry points
// ---------------------------------------------------------------------------

/**
 * THE function every attest hash feeds its bytes through. Returns the CODE of
 * `text` — comments, living-docs properties and type-only imports removed —
 * for a basis file at repo-relative `relPath`.
 *
 * Deterministic: same (path, bytes) → same output, on every platform.
 */
export function normalizeForHash(relPath: string, text: string): string {
  return normalizeForHashWithReport(relPath, text).text;
}

/**
 * How an attest hash reads a basis file. Defaults to the real filesystem; the
 * blindness gates inject a reader that perturbs ONE file so they can prove both
 * directions (comment/docs edit → identical hash; code edit → different hash)
 * against the REAL `compute*Hash` functions instead of a re-implementation.
 */
export type BasisReader = (relPath: string) => string;

/** `normalizeForHash` plus what it did — for the scope + measurement gates. */
export function normalizeForHashWithReport(
  relPath: string,
  text: string,
): { text: string; report: NormalizeReport } {
  const mode = normalizeModeFor(relPath);
  const report = emptyReport(mode);
  switch (mode) {
    case 'typescript':
      return { text: normalizeTs(text, relPath, report), report };
    case 'svelte':
      return { text: normalizeSvelte(text, relPath, report), report };
    case 'package-json':
      return { text: packageJsonCodeDigest(text, report), report };
    case 'raw':
      return { text, report };
  }
}
