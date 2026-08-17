// scripts/attest-code-basis.test.ts
//
// THE PROOF that the attest hashes are docs-blind BY DESIGN — and that they are
// still blind to NOTHING ELSE. Runs in the required `unit` lane (`task test` →
// `task test:scripts`); pure node, no GPU, no browser, no DB, cannot skip-pass.
//
// A hash change is only safe if you can show it ignores exactly what it should.
// So every claim here is asserted in BOTH directions:
//
//   * §string-safety  — the forms a naive `//`-stripper eats survive byte-exact.
//                       These are NOT the easy cases; they are precisely the
//                       ones the old regex would have broken on. (CLAUDE.md
//                       blind-gates: "the stripDocsForHash self-test was blind
//                       the same way its subject was" — the raw-write self-test
//                       only ever fed itself the bracket form.)
//   * §documentation  — comments / docs / controlFamilies / face / type-only
//                       imports are removed …
//   * §negative       — … and a REAL code edit is NOT. Every "is ignored"
//                       assertion is paired with an "is not ignored" twin, so a
//                       normalizer that returned the empty string for every
//                       input could not pass this file.
//   * §per-attest     — the same both-direction proof against the REAL
//                       computeWebglHash over the REAL basis, via an injected
//                       reader that perturbs one file. Not a re-implementation.
//                       (It ran over three attests until 2026-08-17; collab and
//                       grand were deleted with their non-gating CI jobs, so
//                       webgl is the only attest left.)
//   * §scope          — what the normalizer still cannot see, stated as an
//                       assertion with a named list, so a new raw-hashed file
//                       type shows up as a red test instead of silent coverage.
//   * §ceremony       — the `docs-hash-ignore` markers are GONE from source and
//                       cannot come back.
//
// NEGATIVE-CONTROLLED AT AUTHORING (2026-08-09) — the gate was broken four ways
// and confirmed to go RED each time, because a green gate that cannot fail is
// decoration:
//
//   perturbation applied to attest-code-basis.ts        | tests that reddened
//   ----------------------------------------------------|--------------------
//   printer `removeComments: true` → `false`             | 8
//   `HASH_TRANSPARENT_PROPS` → `[]`                      | 6
//   type-only-import removal disabled                    | 2
//   `isModuleScopeDefObject` → always true (over-broad)   | 2
//
// The last one is the one to keep: it is the UNSAFE direction (stripping a
// nested `face:` that is real geometry code = a MISSED re-attest), and only the
// §negative block sees it.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import tsc from 'typescript';

import {
  HASH_TRANSPARENT_PROPS,
  NON_CODE_PACKAGE_JSON_FIELDS,
  normalizeForHash,
  normalizeForHashWithReport,
  normalizeModeFor,
  type BasisReader,
} from './attest-code-basis';
import {
  REPO_ROOT,
  computeWebglHash,
  resolveWebglBasis,
  readBasisFile,
} from './webgl-attest-lib';

const ts = (src: string) => normalizeForHash('fixture.ts', src);

// ---------------------------------------------------------------------------
// §string-safety — the cases that break a regex, kept as a permanent leg
// ---------------------------------------------------------------------------

describe('attest-code-basis §string-safety: `//` that is NOT a comment survives', () => {
  it('keeps `//` inside a plain string literal', () => {
    const out = ts(`const u = 'https://example.com//deep';\n`);
    expect(out).toContain(`'https://example.com//deep'`);
  });

  it('keeps `//` inside a TEMPLATE literal, including across a substitution', () => {
    const out = ts('const base = "x";\nconst t = `a // b ${base} c // d`;\n');
    expect(out).toContain('`a // b ${base} c // d`');
  });

  it('keeps `//` inside a REGEX literal — the case a bare TS scanner also gets wrong', () => {
    // `/[//]/` is a character class containing two slashes. A `scan()` loop
    // returns SlashToken here (the parser must call reScanSlashToken), so the
    // `//` reads as a line comment and swallows the rest of the line. Parsing
    // is what makes this safe, and this test is why we parse.
    const out = ts('const re = /[//]/g;\nconst after = 42;\n');
    expect(out).toContain('/[//]/g');
    expect(out).toContain('const after = 42');
  });

  it('keeps an escaped-slash regex and a following statement', () => {
    const out = ts('const proto = /https?:\\/\\//;\nexport const keep = 1;\n');
    expect(out).toContain('/https?:\\/\\//');
    expect(out).toContain('export const keep = 1');
  });

  it('keeps `/* */` sequences inside strings', () => {
    const out = ts(`const glob = '/**/*.spec.ts';\nconst n = 1;\n`);
    expect(out).toContain(`'/**/*.spec.ts'`);
    expect(out).toContain('const n = 1');
  });

  it('a WHOLE hostile file is byte-identical with and without added comments', () => {
    const hostile = [
      `const u = 'https://x//y';`,
      'const t = `t // t`;',
      'const re = /[//]/;',
      `const glob = '/**/*.ts';`,
      'export const answer = 42;',
    ].join('\n');
    const commented = [
      '// leading comment',
      `const u = 'https://x//y'; // trailing`,
      '/** jsdoc */',
      'const t = `t // t`;',
      '/* block */ const re = /[//]/;',
      `const glob = '/**/*.ts';`,
      '// another',
      'export const answer = 42;',
    ].join('\n');
    expect(ts(commented)).toBe(ts(hostile));
  });
});

// ---------------------------------------------------------------------------
// §documentation — what is removed, paired with §negative below
// ---------------------------------------------------------------------------

const DEF_WITHOUT_DOCS = [
  `export const fooDef = {`,
  `    id: 'foo',`,
  `    params: [{ id: 'gain', min: 0, max: 1 }],`,
  `};`,
  '',
].join('\n');

function defWith(extra: string): string {
  return [
    `export const fooDef = {`,
    `  id: 'foo',`,
    extra,
    `  params: [{ id: 'gain', min: 0, max: 1 }],`,
    `};`,
    '',
  ].join('\n');
}

describe('attest-code-basis §documentation: prose is removed from the basis', () => {
  it('drops every comment form', () => {
    const src = [
      '// line',
      '/* block */',
      '/** jsdoc',
      ' *  more',
      ' */',
      'export const x = 1;',
    ].join('\n');
    expect(ts(src)).toBe('export const x = 1;\n');
  });

  it.each(HASH_TRANSPARENT_PROPS)('drops the `%s` property of a module-scope def', (prop) => {
    expect(ts(defWith(`  ${prop}: { a: 'prose with } and { braces', b: "and // slashes" },`))).toBe(
      DEF_WITHOUT_DOCS,
    );
  });

  it('drops a `docs` whose value is a computed IIFE (the wavesculpt shape)', () => {
    const iife = [
      '  docs: (() => {',
      "    const rows = ['a', 'b'];",
      '    return { explanation: rows.join(), inputs: {} };',
      '  })(),',
    ].join('\n');
    expect(ts(defWith(iife))).toBe(DEF_WITHOUT_DOCS);
  });

  it('drops a type-only import — so ADDING docs to a def that had none is free', () => {
    const before = `export const x = 1;\n`;
    const after = `import type { ModuleDocs } from '$lib/graph/types';\nexport const x = 1;\n`;
    expect(ts(after)).toBe(ts(before));
  });

  it('a def gaining docs + controlFamilies + face at once is a byte-for-byte no-op', () => {
    const authored = [
      `import type { ModuleDocs } from '$lib/graph/types';`,
      `/** Newly written module doc. */`,
      `export const fooDef = {`,
      `  id: 'foo',`,
      `  docs: { explanation: 'what it does' },`,
      `  controlFamilies: [{ id: 'step', label: 'Step' }],`,
      `  face: { order: ['gain'] },`,
      `  params: [{ id: 'gain', min: 0, max: 1 }],`,
      `};`,
      '',
    ].join('\n');
    expect(ts(authored)).toBe(DEF_WITHOUT_DOCS);
  });

  it('is insensitive to pure RE-INDENTATION (the printer normalises indent width)', () => {
    const a = `export const x = {\n  a: 1,\n  b: 2,\n};\n`;
    const b = `export const x = {\n      a: 1,\n\tb: 2,\n};\n`;
    expect(ts(a)).toBe(ts(b));
  });

  it('⚠ but NOT to a re-LINEBREAK — the printer preserves line structure (stated scope)', () => {
    // Collapsing an object onto one line still moves the hash. Conservative, so
    // it is the safe direction; recorded here so nobody reads "formatting is
    // free" more broadly than it is.
    expect(ts(`export const x = {\n  a: 1,\n};\n`)).not.toBe(ts(`export const x = { a: 1 };\n`));
  });
});

// ---------------------------------------------------------------------------
// §negative — the instrument must MOVE when the thing it measures moves
// ---------------------------------------------------------------------------

describe('attest-code-basis §negative: real code is NOT ignored', () => {
  it('a param RANGE change moves the output', () => {
    expect(ts(defWith(`  docs: { a: 'x' },`))).not.toBe(
      ts(
        [
          `export const fooDef = {`,
          `  id: 'foo',`,
          `  docs: { a: 'x' },`,
          `  params: [{ id: 'gain', min: 0, max: 2 }],`,
          `};`,
          '',
        ].join('\n'),
      ),
    );
  });

  it('a PORT ID change moves the output', () => {
    const a = `export const d = { inputs: [{ id: 'audio' }] };\n`;
    const b = `export const d = { inputs: [{ id: 'cv' }] };\n`;
    expect(ts(a)).not.toBe(ts(b));
  });

  it('a SHADER LINE change moves the output (shader source is a string literal)', () => {
    const a = 'export const frag = `void main(){ gl_FragColor = vec4(1.0); }`;\n';
    const b = 'export const frag = `void main(){ gl_FragColor = vec4(0.5); }`;\n';
    expect(ts(a)).not.toBe(ts(b));
  });

  it('a RELAY BRANCH change moves the output', () => {
    const a = 'export function auth(u) { if (u.role === "owner") return true; return false; }\n';
    const b = 'export function auth(u) { if (u.role === "member") return true; return false; }\n';
    expect(ts(a)).not.toBe(ts(b));
  });

  it('⚠ a NESTED `face` is real code and is KEPT — only a def-level one is prose', () => {
    // A WebGL module may carry `face:` on a geometry/cube-side object. Stripping
    // THAT would be a MISSED re-attest — the unsafe direction. The module-scope
    // restriction in isModuleScopeDefObject exists for exactly this.
    const a = `export const geo = { sides: [{ face: 0, uv: [0, 0] }] };\n`;
    const b = `export const geo = { sides: [{ face: 3, uv: [0, 0] }] };\n`;
    expect(ts(a)).toContain('face: 0');
    expect(ts(a)).not.toBe(ts(b));
  });

  it('⚠ a `docs` inside a FUNCTION BODY is kept (not a def property)', () => {
    const a = `export function f() { return { docs: 1 }; }\n`;
    const b = `export function f() { return { docs: 2 }; }\n`;
    expect(ts(a)).not.toBe(ts(b));
  });

  it('a VALUE import is kept (only `import type` is erased)', () => {
    const a = `import { engine } from './engine';\nexport const x = engine;\n`;
    const b = `import { engine } from './other-engine';\nexport const x = engine;\n`;
    expect(ts(a)).toContain('./engine');
    expect(ts(a)).not.toBe(ts(b));
  });

  it('falls back to RAW bytes when the file does not parse (over-invalidate, never guess)', () => {
    const broken = 'export const x = {  // deliberately unbalanced\n';
    const { text, report } = normalizeForHashWithReport('broken.ts', broken);
    expect(report.parseFallback).toBe(true);
    expect(text).toBe(broken);
  });
});

// ---------------------------------------------------------------------------
// §svelte + §package.json
// ---------------------------------------------------------------------------

describe('attest-code-basis §svelte: script bodies normalise, markup does not', () => {
  const card = (script: string, markup: string) =>
    normalizeForHash('Card.svelte', `<script lang="ts">\n${script}\n</script>\n\n${markup}\n`);

  it('drops comments inside <script> but keeps the markup verbatim', () => {
    const withComment = card('// explain\nlet n = 1;', '<div>{n}</div>');
    const without = card('let n = 1;', '<div>{n}</div>');
    expect(withComment).toBe(without);
    expect(withComment).toContain('<div>{n}</div>');
  });

  it('a real script change still moves it', () => {
    expect(card('let n = 1;', '<div/>')).not.toBe(card('let n = 2;', '<div/>'));
  });

  it('a markup change still moves it (markup is raw — stated scope)', () => {
    expect(card('let n = 1;', '<div/>')).not.toBe(card('let n = 1;', '<span/>'));
  });

  it('an attribute value containing `>` cannot truncate the open tag', () => {
    const src = `<script lang="ts" generics="T extends A<B>">\n// c\nlet n = 1;\n</script>\n<i/>\n`;
    const out = normalizeForHash('G.svelte', src);
    expect(out).not.toContain('// c');
    expect(out).toContain('let n = 1');
    expect(out).toContain('<i/>');
  });
});

describe('attest-code-basis §package.json: deps in, npm scripts out', () => {
  const pkg = (scripts: string, dep: string) =>
    normalizeForHash(
      'e2e/package.json',
      JSON.stringify({
        name: 'e2e',
        version: '1.0.0',
        scripts: { test: scripts },
        devDependencies: { '@playwright/test': dep },
      }),
    );

  it('an npm-SCRIPT edit is a no-op (the #1425 incident: a CLI flag demanded a GPU re-attest)', () => {
    expect(pkg('playwright test', '1.59.0')).toBe(
      pkg('playwright test --update-snapshots=changed', '1.59.0'),
    );
  });

  it('a DEPENDENCY bump still moves it', () => {
    expect(pkg('playwright test', '1.59.0')).not.toBe(pkg('playwright test', '1.60.0'));
  });

  it('key ORDER does not matter but key CONTENT does', () => {
    const a = normalizeForHash('p/package.json', '{"dependencies":{"a":"1","b":"2"}}');
    const b = normalizeForHash('p/package.json', '{"dependencies":{"b":"2","a":"1"}}');
    const c = normalizeForHash('p/package.json', '{"dependencies":{"a":"9","b":"2"}}');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('every denied field is prose or a script — never a dependency map', () => {
    for (const f of NON_CODE_PACKAGE_JSON_FIELDS) {
      expect(f, `${f} looks like a dependency field and must not be ignored`).not.toMatch(
        /[Dd]ependencies|overrides|resolutions|engines|workspaces|exports/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// §per-attest — both directions against the REAL hash over the REAL basis
// ---------------------------------------------------------------------------

/** A reader that serves the real tree except for one file, which is replaced. */
function readerWith(rel: string, text: string): BasisReader {
  return (p) => (p === rel ? text : readBasisFile(p));
}

/** A representative .ts file from a basis: prefers one that carries a `docs:`
 *  def property so the docs leg is not vacuous. */
function pickTsFile(basis: string[], preferDocs: boolean): string {
  const tsFiles = basis.filter((f) => f.endsWith('.ts'));
  if (preferDocs) {
    const withDocs = tsFiles.find(
      (f) => normalizeForHashWithReport(f, readBasisFile(f)).report.strippedProps.length > 0,
    );
    if (withDocs) return withDocs;
  }
  return tsFiles[0]!;
}

// One entry since 2026-08-17 (was three). `describe.each` is KEPT rather than
// inlined: webgl is not special here — the proof is a property of the
// normalizer, and the next attest to land should be one line, not a rewrite.
const ATTESTS = [
  { name: 'webgl', hash: computeWebglHash, basis: resolveWebglBasis },
] as const;

describe.each(ATTESTS)('$name attest: docs-blind, code-sensitive (both directions)', (attest) => {
  const basis = attest.basis();
  const baseline = attest.hash();

  it('the basis is non-trivial (a zero-file basis would pass everything below)', () => {
    expect(basis.length).toBeGreaterThan(10);
  });

  it('is deterministic across calls', () => {
    expect(attest.hash()).toBe(baseline);
  });

  it('a COMMENT-ONLY edit leaves the hash byte-identical', () => {
    const target = pickTsFile(basis, false);
    const src = readBasisFile(target);
    const commented =
      '// a new comment added by the attest blindness gate\n' +
      src +
      '\n/* and a trailing block comment */\n';
    expect(attest.hash(readerWith(target, commented)), `via ${target}`).toBe(baseline);
  });

  it('a DOCS-ONLY edit leaves the hash byte-identical', () => {
    const target = pickTsFile(basis, true);
    const src = readBasisFile(target);
    const authored =
      src +
      `\nexport const blindnessProbeDef = {\n` +
      `  id: 'blindness-probe',\n` +
      `  docs: { explanation: 'pure prose', inputs: {} },\n` +
      `  controlFamilies: [{ id: 'probe', label: 'Probe' }],\n` +
      `  face: { order: ['probe'] },\n` +
      `};\n`;
    // Same def WITHOUT the three documentation properties.
    const bare =
      src + `\nexport const blindnessProbeDef = {\n` + `  id: 'blindness-probe',\n` + `};\n`;
    expect(attest.hash(readerWith(target, authored)), `via ${target}`).toBe(
      attest.hash(readerWith(target, bare)),
    );
  });

  it('a REAL CODE edit CHANGES the hash (the negative control)', () => {
    const target = pickTsFile(basis, false);
    const src = readBasisFile(target);
    const edited = src + `\nexport const attestBlindnessNegativeControl = 1;\n`;
    expect(attest.hash(readerWith(target, edited)), `via ${target}`).not.toBe(baseline);
  });

  it('the injected reader is itself sound (an UNCHANGED override reproduces the hash)', () => {
    // Without this, every "identical" assertion above could be passing because
    // the reader is never consulted.
    const target = pickTsFile(basis, false);
    expect(attest.hash(readerWith(target, readBasisFile(target)))).toBe(baseline);
  });
});

// ---------------------------------------------------------------------------
// §scope — what the normalizer still CANNOT see, named and ratcheted
// ---------------------------------------------------------------------------

/**
 * Basis files hashed by RAW BYTES: their comment syntax is outside the
 * normalizer. A comment-only edit to one of these STILL forces a re-attest.
 * That is the conservative direction and these files essentially never churn —
 * but it must be stated, not assumed, or an unstated scope reads as full
 * coverage (CLAUDE.md: "state a gate's directory scope in the gate").
 */
/** Top-level `export`ed variable / function / class names in a source file. */
function exportedNames(fileName: string, text: string): string[] {
  const sf = tsc.createSourceFile(fileName, text, tsc.ScriptTarget.Latest, false, tsc.ScriptKind.TS);
  const names: string[] = [];
  for (const st of sf.statements) {
    const mods = tsc.canHaveModifiers(st) ? tsc.getModifiers(st) : undefined;
    if (!mods?.some((m) => m.kind === tsc.SyntaxKind.ExportKeyword)) continue;
    if (tsc.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (tsc.isIdentifier(d.name)) names.push(d.name.text);
      }
    } else if ((tsc.isFunctionDeclaration(st) || tsc.isClassDeclaration(st)) && st.name) {
      names.push(st.name.text);
    }
  }
  return names;
}

// ⚠ SHRANK 2026-08-17, and the two entries that left were NOT waived — they
// stopped existing. `db/schema/001_init.sql` and `db/schema/003_saved_groups.sql`
// were in the COLLAB basis only, and collab-attest was deleted with the rest of
// the non-gating CI jobs. An entry naming a file that is in no basis is RED here
// by construction (the assertion is `toEqual`, both directions), which is
// exactly how this list is supposed to behave when the artifact moves.
const EXPECTED_RAW_BASIS_FILES = [
  '.flox/env/manifest.toml',
  'packages/web/src/lib/video/vfpga/__snapshots__/bitstream.test.ts.snap',
] as const;

describe('attest-code-basis §scope: the normalizer states what it cannot see', () => {
  const allBasis = [...new Set(resolveWebglBasis())].sort();

  it('every basis file is accounted for by exactly one mode', () => {
    const byMode: Record<string, string[]> = {};
    for (const rel of allBasis) (byMode[normalizeModeFor(rel)] ??= []).push(rel);
    expect(Object.keys(byMode).sort()).toEqual(['package-json', 'raw', 'svelte', 'typescript']);
    // Anchored to a NAME, never to a population size. This was
    // `byMode.typescript!.length > 250`, calibrated when three attest bases were
    // unioned here; deleting two took the real number to ~207 and the floor
    // would have gone red for a reason that has nothing to do with what it
    // claims to measure — which is that the classifier is not degenerate (e.g.
    // returning 'raw' for everything). A named .ts file that MUST classify as
    // typescript says that directly and cannot drift with the basis size.
    expect(
      byMode.typescript,
      'a .ts basis file is not being classified as typescript — the mode classifier is degenerate',
    ).toContain('e2e/playwright.config.ts');
  });

  it('the RAW (still comment-sensitive) set is exactly the declared list', () => {
    const raw = allBasis.filter((f) => normalizeModeFor(f) === 'raw');
    expect(
      raw,
      'a basis file is hashed by raw bytes without being declared here — either ' +
        'teach the normalizer its comment syntax, or add it to EXPECTED_RAW_BASIS_FILES ' +
        'with a reason',
    ).toEqual([...EXPECTED_RAW_BASIS_FILES]);
  });

  it('every declared raw file still EXISTS (anchor the list to the artifact)', () => {
    for (const rel of EXPECTED_RAW_BASIS_FILES) {
      expect(allBasis, `${rel} is declared raw but is no longer in any basis`).toContain(rel);
    }
  });

  // The re-emit must be LOSSLESS for code. A printer that silently dropped a
  // statement would UNDER-hash — the unsafe direction, and invisible from a
  // green run. Two independent probes over every TypeScript basis file:
  const tsBasis = allBasis.filter((rel) => normalizeModeFor(rel) === 'typescript');

  it('normalisation is IDEMPOTENT on every basis file', () => {
    const unstable = tsBasis.filter((rel) => {
      const once = normalizeForHash(rel, readBasisFile(rel));
      return normalizeForHash(rel, once) !== once;
    });
    expect(unstable, 'normalize(normalize(x)) !== normalize(x) — the re-emit is not a fixed point')
      .toEqual([]);
  });

  it('no top-level EXPORTED name is lost from any basis file', () => {
    const lost: string[] = [];
    for (const rel of tsBasis) {
      const src = readBasisFile(rel);
      const before = exportedNames(rel, src);
      if (before.length === 0) continue;
      const after = new Set(exportedNames(rel, normalizeForHash(rel, src)));
      const missing = before.filter((n) => !after.has(n));
      if (missing.length) lost.push(`${rel}: ${missing.join(', ')}`);
    }
    expect(lost, 'the AST re-emit dropped exported declarations — it is LOSSY').toEqual([]);
  });

  it('NO basis file falls back to raw bytes for a PARSE ERROR', () => {
    const broken = allBasis.filter(
      (rel) =>
        normalizeModeFor(rel) !== 'raw' &&
        normalizeForHashWithReport(rel, readBasisFile(rel)).report.parseFallback,
    );
    expect(broken, 'these basis files do not parse, so they are hashed by raw bytes').toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §ceremony — the marker is gone and cannot come back
// ---------------------------------------------------------------------------

describe('attest-code-basis §ceremony: the docs-hash-ignore marker is retired', () => {
  it('no source file carries a docs-hash-ignore marker', () => {
    // `git grep` over tracked files only — no node_modules, no build output.
    let hits: string[] = [];
    try {
      hits = execFileSync(
        'git',
        ['grep', '-l', '-e', 'docs-hash-ignore:start', '--', 'packages', 'e2e', 'art', 'scripts'],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      )
        .trim()
        .split('\n')
        .filter(Boolean);
    } catch {
      hits = []; // git grep exits 1 when nothing matches — the good case.
    }
    // This test file is allowed to NAME the marker; nothing may USE it.
    expect(
      hits.filter((f) => f !== 'scripts/attest-code-basis.test.ts'),
      'the marker ceremony was deleted on 2026-08-09 — the hash is docs-blind by ' +
        'design now, so a marker is dead text that hides nothing',
    ).toEqual([]);
  });

  it('the module-scope def restriction is documented on the policy constant', () => {
    const lib = readFileSync(join(REPO_ROOT, 'scripts/attest-code-basis.ts'), 'utf8');
    expect(lib).toContain('MODULE-SCOPE');
    // The list is pinned so that WIDENING it is a deliberate, reviewed edit —
    // every name added here is a name the hash stops seeing, and the unsafe
    // direction (stripping something that IS behaviour) has no other guard.
    // Each entry must carry its argument on the constant itself.
    expect(HASH_TRANSPARENT_PROPS).toEqual([
      'docs',
      'controlFamilies',
      'face',
      'noUserControl',
    ]);
  });
});
