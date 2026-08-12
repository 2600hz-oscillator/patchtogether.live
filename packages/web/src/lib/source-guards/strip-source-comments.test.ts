// packages/web/src/lib/source-guards/strip-source-comments.test.ts
//
// The stripper's own gate. Every claim in strip-source-comments.ts is asserted
// here in BOTH directions, because a stripper that returned '' for everything
// would silence every source gate in the repo while turning each of them green.
//
// The hostile forms are the same set scripts/attest-code-basis.test.ts keeps as
// its permanent leg (`'https://x'`, a template literal spanning a `${}`, the
// `/[//]/` character class, `'/**/*.ts'`) — deliberately, because those are the
// four shapes that break the four different one-off regexes this module
// replaces, and because a re-typed copy of a predicate is how the LAST
// self-test went blind. Where that file proves it of a TypeScript re-emitter,
// this proves it of a byte-preserving markup-aware scanner.

import { describe, it, expect } from 'vitest';
import {
  stripSourceComments,
  stripSourceCommentsWithReport,
} from './strip-source-comments';

/** The predicate the real gates apply, called through the real stripper — not
 *  a paraphrase of it. Used by the "documented vs real" pairs below so this
 *  file cannot drift from the thing it certifies. */
const LITERAL_RANGE = /(?:^|[^A-Za-z0-9_])([A-Za-z]*(?:[Mm]in|[Mm]ax)|defaultValue|step)=\{\s*-?[0-9]/g;
const hasLiteralRange = (src: string): boolean => {
  LITERAL_RANGE.lastIndex = 0;
  return LITERAL_RANGE.test(stripSourceComments(src));
};

describe('stripSourceComments — comments become whitespace, code does not', () => {
  it('strips the three comment syntaxes a .svelte card can carry', () => {
    const src = [
      '<!-- xMin={-1} in a MARKUP comment -->',
      '<script>',
      '  // xMin={-1} in a line comment',
      '  /* xMin={-1} in a block comment */',
      '  const real = 1;',
      '</script>',
    ].join('\n');
    const { text, report } = stripSourceCommentsWithReport(src);

    expect(text).toContain('const real = 1;');
    expect(text).not.toContain('xMin');
    // ANCHORED: assert each KIND was actually exercised, so a fixture that
    // silently stopped containing (say) an HTML comment cannot let this pass
    // while the html branch rots.
    expect(report.html, 'markup comment bytes removed').toBeGreaterThan(0);
    expect(report.line, 'line comment bytes removed').toBeGreaterThan(0);
    expect(report.block, 'block comment bytes removed').toBeGreaterThan(0);
  });

  it('preserves byte offsets and line count, so a gate can still report line numbers', () => {
    const src = 'a\n// comment\nb\n/* two\nlines */\nc\n';
    const text = stripSourceComments(src);
    expect(text.length, 'byte length is preserved').toBe(src.length);
    expect(text.split('\n').length, 'line count is preserved').toBe(src.split('\n').length);
    expect(text.split('\n')[2], 'a non-comment line is byte-identical').toBe('b');
  });

  // ── THE HOSTILE FORMS — a `//` or `/*` that is NOT a comment ──────────────
  //
  // Each of these breaks at least one of the four regexes this module replaces.
  // Kept as a permanent leg, not a one-time authoring check.
  it.each([
    ["a URL in a string literal", `const u = 'https://example.com//deep';`],
    ["a URL in a double-quoted string", `const u = "https://example.com//deep";`],
    ['a template literal with `//` around a substitution', 'const t = `a // b ${base} c // d`;'],
    ['a regex character class containing slashes', 'const re = /[//]/g;'],
    ['a regex with escaped slashes', 'const proto = /https?:\\/\\//;'],
    ['a glob that looks like a block comment', `const glob = '/**/*.spec.ts';`],
    ['a mid-line `//` inside an attribute value', `<Knob label="a // b" />`],
  ])('leaves %s byte-identical', (_what, src) => {
    expect(stripSourceComments(src)).toBe(src);
  });

  it('a regex literal does not swallow the code after it', () => {
    // The specific failure a naive scanner produces: `/[//]/` opens, the `//`
    // inside the class is read as a line comment, and everything to end-of-line
    // vanishes — including the assertion the gate was about to make.
    const src = 'const re = /[//]/g;\nconst after = 42;';
    const text = stripSourceComments(src);
    expect(text).toBe(src);
    expect(text).toContain('const after = 42;');
  });

  it('DOES strip a comment that appears after code on the same line', () => {
    // The `^\s*//` form used in lfo-face-model.test.ts cannot see this one, and
    // it is the shape a card actually writes: an inline note beside the prop.
    const src = 'const x = 1; // xMin={-1} was here';
    expect(hasLiteralRange(src), 'a trailing comment is not code').toBe(false);
    expect(stripSourceComments(src)).toContain('const x = 1;');
  });

  it('strips a comment INSIDE a template substitution but not the chunks around it', () => {
    const src = 'const t = `head ${ /* xMin={-1} */ value } tail`;';
    const text = stripSourceComments(src);
    expect(text).toContain('`head ${');
    expect(text).toContain('value } tail`');
    expect(text).not.toContain('xMin');
  });
});

// ── THE NEGATIVE CONTROL, IN BOTH DIRECTIONS, ON THE SAME PREDICATE ─────────
//
// `hasLiteralRange` is the real gate's regex applied to the real stripper's
// output. Feeding it the SAME text twice — once as prose, once as code — is the
// only pairing that can tell "the stripper works" from "the stripper deleted
// everything". A stripper returning '' passes the first leg of every pair and
// fails the second; a stripper returning its input unchanged does the reverse.
describe('NEGATIVE CONTROL — a documented literal is not a literal, a real one is', () => {
  it.each([
    ['a markup comment', '<!-- xMin={-1} -->', '<XyPad xMin={-1} />'],
    ['a line comment', '// xMin={-1}', '<XyPad xMin={-1} />'],
    ['a block comment', '/* xMin={-1} */', '<XyPad xMin={-1} />'],
    ['a JSDoc block', '/** was `step={0.01}` */', '<Fader step={0.01} />'],
    ['a trailing comment', 'const a = 1; // valueMax={12}', '<Knob valueMax={12} />'],
  ])('%s is ignored; the same text as CODE is caught', (_what, documented, real) => {
    expect(hasLiteralRange(documented), `${_what}: an illustration in prose`).toBe(false);
    expect(hasLiteralRange(real), `${_what}: the same text as CODE`).toBe(true);
  });

  it('the stripper is not a no-op and not an eraser', () => {
    // Two bounds that a degenerate implementation cannot satisfy together.
    const src = '// gone\nconst kept = 1;\n';
    const { text, report } = stripSourceCommentsWithReport(src);
    expect(report.line, 'it removed SOMETHING (not a no-op)').toBeGreaterThan(0);
    expect(text, 'it kept the code (not an eraser)').toContain('const kept = 1;');
    expect(
      stripSourceComments('const only = 1;'),
      'comment-free source is returned byte-identically',
    ).toBe('const only = 1;');
  });
});

// ── STATED SCOPE: what this stripper still cannot see ───────────────────────
//
// Asserted rather than left to prose, so a future change that silently starts
// handling one of these shows up as a red test asking for the note to be
// updated (the same discipline the VRT fold scene applies to its own scope).
describe('SCOPE — the shapes this scanner deliberately does not resolve', () => {
  it('does not evaluate conditional compilation or dead code — a commented-OUT block that is CODE stays code', () => {
    // `if (false) { … }` is not a comment; the gate will see the literal. That
    // is correct: dead code is still code a reader can re-enable.
    expect(hasLiteralRange('if (false) { const a = `<XyPad xMin={-1} />`; }')).toBe(true);
  });

  it('an UNTERMINATED block comment consumes to end of file, as the language does', () => {
    const text = stripSourceComments('code;\n/* never closed\nxMin={-1}\n');
    expect(text).toContain('code;');
    expect(text).not.toContain('xMin');
  });

  it('a division that LOOKS like a regex opener does not eat the line', () => {
    // `a / b // c` — the `/` follows an identifier, which is not in
    // REGEX_PRECEDERS, so it stays a division and the `//` is a real comment.
    const text = stripSourceComments('const q = a / b; // xMin={-1}');
    expect(text).toContain('const q = a / b;');
    expect(text).not.toContain('xMin');
  });
});
