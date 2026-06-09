// Phase 5b — source-scan guard (the regression backstop for Phase 5a).
//
// Phase 5a routed every UI param write through the sanctioned mutation seam
// (setNodeParam / mutateNode in graph/mutate.ts) so edits ride the Y.Doc tagged
// LOCAL_ORIGIN and land on the undo stack. The ROOT CAUSE that motivated all of
// this was a fix that drifted to "applied in only some files." This test makes
// that drift impossible to merge: it source-scans every lib file and FAILS on a
// raw `node.params[..] = …` assignment outside the sanctioned helper.
//
// Per-frame / programmatic / bot / livecode writes that must NOT become tracked
// (undoable) writes — they'd storm ydoc.update + pollute undo (the #719 class) —
// opt out with a trailing `// guard:allow-raw-write` comment on the line.
//
// SCOPE: this guards `.params[idx] = value` assignments (the Phase-5a target).
// The companion `ydoc.transact(` origin guard is deferred (Phase 5b.2): there
// are ~20 legitimate non-undoable transacts (persistence/bot/session) that need
// per-site classification first.
//
// Idiom: Vite `import.meta.glob('?raw', eager)` — runs in vitest with no fs
// path juggling. Mirrors the "source-scanning vitest guard" the repo prefers
// over ESLint.

import { describe, it, expect } from 'vitest';

// Every TS + Svelte source under lib/, as raw text. (Glob is relative to THIS
// file: ../ == lib/.) Tests are excluded by the filter below.
const FILES = import.meta.glob('../**/*.{ts,svelte}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

// The glob is rooted at THIS file's dir (graph/), so keys are relative to it:
// a file IN graph/ comes back as `./mutate.ts`, anything else as `../<sub>/…`.
// Normalize every key to a stable lib-relative path (`graph/mutate.ts`,
// `ui/modules/Foo.svelte`, …) so the SANCTIONED match + the offender display
// below don't depend on that prefix quirk. (Before this, `./mutate.ts` slipped
// past `/\/graph\/mutate\.ts$/` and the seam flagged ITSELF.)
const libRel = (path: string): string =>
  path.replace(/^\.\//, 'graph/').replace(/^\.\.\//, '');

/** Files allowed to do raw param writes (the sanctioned mutation seam itself). */
const SANCTIONED = [/^graph\/mutate\.ts$/];

/** Indexed param assignment: `.params[ … ] =` but NOT `==`, `===`, `=>`. */
const RAW_PARAM_WRITE = /\.params\[[^\]]+\]\s*=(?![=>])/;

const ALLOW = 'guard:allow-raw-write';

describe('Phase 5b guard: no raw node.params[..] writes outside the mutation seam', () => {
  it('every param write goes through setNodeParam/mutateNode (or is explicitly guard-allowed)', () => {
    const violations: string[] = [];

    for (const [path, src] of Object.entries(FILES)) {
      const rel = libRel(path);
      if (/\.test\.ts$/.test(rel)) continue; // tests may construct raw fixtures
      if (SANCTIONED.some((re) => re.test(rel))) continue;

      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!RAW_PARAM_WRITE.test(line)) continue;
        if (line.includes(ALLOW)) continue; // explicit, intentional opt-out
        violations.push(`src/lib/${rel}:${i + 1}  ${line.trim()}`);
      }
    }

    expect(
      violations,
      `Raw \`node.params[..] = …\` write(s) found outside graph/mutate.ts.\n` +
        `Route UI edits through setNodeParam()/mutateNode() (undoable, synced), OR — for a\n` +
        `per-frame / programmatic / bot / livecode write that must stay OUT of the undo stack —\n` +
        `add a trailing \`// ${ALLOW}\` comment. Offenders:\n  ` +
        violations.join('\n  '),
    ).toEqual([]);
  });

  it('the guard actually matches a raw write (self-test, so it can never silently pass)', () => {
    expect(RAW_PARAM_WRITE.test('live.params[paramId] = value;')).toBe(true);
    expect(RAW_PARAM_WRITE.test('if (node.params[k] === 1) {}')).toBe(false);
    expect(RAW_PARAM_WRITE.test('arr.map((p) => p.params[k])')).toBe(false);
    // an allow-annotated line is matched by the regex but exempted by the scan
    expect('t.params[k] = 1; // guard:allow-raw-write'.includes(ALLOW)).toBe(true);
  });
});
