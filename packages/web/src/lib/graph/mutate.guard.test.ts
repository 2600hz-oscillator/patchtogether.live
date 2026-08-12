// Phase 5b — source-scan guard (the regression backstop for Phase 5a).
//
// Phase 5a routed every UI param write through the sanctioned mutation seam
// (setNodeParam / mutateNode in graph/mutate.ts) so edits ride the Y.Doc tagged
// LOCAL_ORIGIN and land on the undo stack. The ROOT CAUSE that motivated all of
// this was a fix that drifted to "applied in only some files." This test makes
// that drift impossible to merge: it source-scans every lib file and FAILS on a
// raw `node.params… = …` assignment outside the sanctioned helper.
//
// ── 2026-08-02: THE GUARD WAS BLIND IN THE DIRECTION PEOPLE WRITE CODE ──────
//
// `RAW_PARAM_WRITE` used to be `/\.params\[[^\]]+\]\s*=(?![=>])/` — BRACKET
// ONLY. `node.params.mode = m` — the ordinary spelling, and the one every card
// actually uses — did not match. Neither did any compound assignment.
//
// The self-test below was blind the SAME WAY: it asserted the regex matched
// `live.params[paramId] = value` and rejected `===` / `=>`, and never once fed
// it a dotted write. So the instrument and its own negative control shared a
// blind spot, and a green run read as "no raw writes exist" when what it
// actually proved was "no BRACKETED raw writes exist".
//
// MEASURED on widening: **3 bracketed writes seen, 96 dotted writes unseen.**
// The guard was covering ~3 % of its subject. Among the 96 was `FilterCard`'s
// `t.params.mode = m` — MODE was not undoable while cutoff and resonance beside
// it were, on a shipped card, for as long as the guard has existed
// (face-redo ledger defect #7: *"the guard and its self-test are blind in the
// same direction"*).
//
// ── DENY BY DEFAULT ────────────────────────────────────────────────────────
// A raw write now passes only if it is EXPLICITLY accounted for, two ways:
//   1. a trailing `// guard:allow-raw-write` comment on the line (the idiom for
//      a NEW per-frame / programmatic / bot / livecode write that must stay out
//      of the undo stack — it would storm ydoc.update, the #719 class); or
//   2. a `(file, param-key)` entry in `raw-write-ledger.ts`, CLASSIFIED
//      (`sanctioned` / `debt` / `not-a-node`) with a stated reason.
// Anything else is RED. The ledger's `debt` bucket is ratcheted in BOTH
// directions, and a ledger entry naming a write that no longer exists is also
// RED — a stale exemption is an exemption nobody is watching.
//
// SCOPE, stated so an unstated scope cannot read as full coverage: this guards
// ASSIGNMENTS to `.params[…]` / `.params.<id>` in `packages/web/src/lib/**`
// (TS + Svelte). It does NOT see `Object.assign(node.params, …)`, a whole-bag
// replacement (`node.params = {…}`), `delete node.params.x`, or a write through
// an aliased reference (`const p = node.params; p.x = 1`) — see the
// "shapes this guard still cannot see" test at the bottom, which pins those as
// KNOWN and fails if one ever appears.
//
// Idiom: Vite `import.meta.glob('?raw', eager)` — runs in vitest with no fs
// path juggling. Mirrors the "source-scanning vitest guard" the repo prefers
// over ESLint.

import { describe, it, expect } from 'vitest';
import {
  RAW_WRITE_LEDGER,
  WHOLE_BAG_WRITES,
  ledgerPairs,
} from './raw-write-ledger';

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

/**
 * A param assignment in EITHER spelling, plain or compound.
 *
 *   `.params[<anything>] =`   the original (bracket) form
 *   `.params.<identifier> =`  THE FORM THE GUARD COULD NOT SEE
 *
 * The optional operator group covers `+= -= *= /= %= **= ??= ||= &&= &= |= ^=
 * <<= >>= >>>=`, so `node.params.gain += 1` cannot slip past a pattern that
 * only knew about a bare `=`.
 *
 * The trailing `(?![=>])` still rejects `==`, `===` and `=>`; `!==` / `!=` are
 * rejected because `!` is not in the operator group, so the `=` can never be
 * reached.
 */
const RAW_PARAM_WRITE =
  /\.params(?:\[[^\]]+\]|\.[A-Za-z_$][\w$]*)\s*(?:\*\*|\?\?|\|\||&&|<<|>>>?|[-+*/%|&^])?=(?![=>])/;

/** Same, with a capture group for the PARAM KEY (dotted form only — a bracket
 *  write's key is an expression, so those are matched by line, not by key). */
const RAW_PARAM_WRITE_KEY =
  /\.params\.([A-Za-z_$][\w$]*)\s*(?:\*\*|\?\?|\|\||&&|<<|>>>?|[-+*/%|&^])?=(?![=>])/;

const ALLOW = 'guard:allow-raw-write';

/**
 * A WHOLE-BAG REPLACEMENT (`x.params = …`) — the form `RAW_PARAM_WRITE` is
 * structurally unable to see, since it matches an assignment INTO a bag and
 * never a replacement OF one. Module scope on purpose: the scan and its
 * permanent negative control must call the SAME constant. A re-typed copy in
 * the self-test is how this file's previous guard went blind.
 */
const WHOLE_BAG = /(?:^|[^A-Za-z0-9_$.])[A-Za-z_$][\w$]*\.params\s*=\s*[^=]/;

/** A line that is PROSE, not code. Needed the moment the guard learned the
 *  dotted form: this very file and `raw-write-ledger.ts` quote `t.params.mode =
 *  m` in their headers to explain the bug, and a comment-blind scan reported
 *  its own documentation as an offender. Comments are skipped for the write
 *  scan only — never for anything that reads real code. */
const isComment = (line: string): boolean => /^\s*(?:\/\/|\/?\*|<!--)/.test(line);

interface Hit {
  rel: string;
  line: number;
  key: string | null;
  text: string;
  annotated: boolean;
}

/** Every raw param write in lib/, annotated or not. The ONE scan every clause
 *  below reads, so they cannot disagree about what the tree contains. */
function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const [path, src] of Object.entries(FILES)) {
    const rel = libRel(path);
    if (/\.test\.ts$/.test(rel)) continue; // tests may construct raw fixtures
    if (SANCTIONED.some((re) => re.test(rel))) continue;
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (isComment(line)) continue;
      if (!RAW_PARAM_WRITE.test(line)) continue;
      hits.push({
        rel,
        line: i + 1,
        key: RAW_PARAM_WRITE_KEY.exec(line)?.[1] ?? null,
        text: line.trim(),
        annotated: line.includes(ALLOW),
      });
    }
  }
  return hits;
}

const HITS = scan();

describe('Phase 5b guard: no raw node.params writes outside the mutation seam', () => {
  it('every param write is annotated, ledgered, or routed through setNodeParam/mutateNode', () => {
    const violations: string[] = [];
    for (const h of HITS) {
      if (h.annotated) continue;
      const entry = RAW_WRITE_LEDGER[h.rel];
      if (entry && h.key && entry.keys.includes(h.key)) continue;
      violations.push(`src/lib/${h.rel}:${h.line}  ${h.text}`);
    }

    expect(
      violations,
      `Raw \`node.params… = …\` write(s) found outside graph/mutate.ts, with no ` +
        `annotation and no ledger entry.\n` +
        `Route UI edits through setNodeParam()/mutateNode() (undoable, synced), OR — for a\n` +
        `per-frame / programmatic / bot / livecode write that must stay OUT of the undo stack —\n` +
        `add a trailing \`// ${ALLOW}\` comment, OR classify it in\n` +
        `packages/web/src/lib/graph/raw-write-ledger.ts with a stated reason. Offenders:\n  ` +
        violations.join('\n  '),
    ).toEqual([]);
  });

  it('the LEDGER has no stale entries (anchored to the source, not to the list)', () => {
    // ⚠ THE METRIC IS ANCHORED TO THE ARTIFACT. Ground truth is a raw write in
    // the tree; the ledger must then EXPLAIN each one. An entry naming a write
    // that has since been fixed (or renamed) is an exemption nobody is
    // watching, and it silently absorbs the next regression on that key.
    const real = new Set(HITS.filter((h) => h.key).map((h) => `${h.rel}:${h.key}`));
    const stale: string[] = [];
    for (const [file, e] of Object.entries(RAW_WRITE_LEDGER)) {
      for (const k of e.keys) {
        if (!real.has(`${file}:${k}`)) stale.push(`${file}:${k} (${e.kind})`);
      }
    }
    expect(
      stale.join('\n'),
      'ledger entr(ies) naming a raw write that is no longer in the tree — delete them ' +
        '(there is no number to lower: RAW_WRITE_DEBT_CEILING was removed 2026-08-12)',
    ).toBe('');
  });

  it('every DEBT entry names a write that is still there and still owed', () => {
    // ⚠ `RAW_WRITE_DEBT_CEILING` (51) IS GONE (2026-08-12, the no-ratchets
    // sweep) — see the trace where it stood in raw-write-ledger.ts for what the
    // `<=` half protected and why the named entry carries it instead.
    //
    // What survives here is the part that was never arithmetic: a `debt` row is
    // a promise that a specific `(file, key)` still needs routing through the
    // seam, so every one of them must still resolve to a real, un-annotated
    // write. (The stale check above covers the whole ledger; this one is
    // scoped to `debt` and states the bucket in its own message, so a `debt`
    // row silently reclassified to `sanctioned` is still visible as a diff on
    // a line this test names.)
    const real = new Set(HITS.filter((h) => h.key).map((h) => `${h.rel}:${h.key}`));
    const ghosts = ledgerPairs('debt').filter((p) => !real.has(p));
    expect(
      ghosts,
      'raw-write DEBT entr(ies) naming a write that is no longer in the tree — delete the row',
    ).toEqual([]);
  });

  it('the guard sees BOTH spellings and every assignment operator (permanent negative control)', () => {
    // ⚠ THIS IS THE CLAUSE THAT WAS MISSING. The old self-test only ever fed
    // the regex the bracket form, so the pattern's blindness to `.params.x =`
    // was invisible to the very test written to prove it worked. Both
    // directions are asserted, permanently, on every run.
    //
    // MUST MATCH — the shapes that were silently passing:
    for (const s of [
      'live.params[paramId] = value;',
      'const t = patch.nodes[id]; if (t) t.params.mode = m;', // FilterCard, verbatim
      'live.params.isPlaying = isPlaying ? 1 : 0;',
      'target.params.tintR = r;',
      'node.params.gain += 1;',
      'node.params.gain ??= 0.5;',
      'node.params.gain **= 2;',
      'node.params.gain >>>= 1;',
      'n.params._reset = prev + 1;',
    ]) {
      expect(RAW_PARAM_WRITE.test(s), `guard must MATCH: ${s}`).toBe(true);
    }
    // MUST NOT MATCH — comparisons, arrows and reads.
    for (const s of [
      'if (node.params[k] === 1) {}',
      'if (node.params.mode === 1) {}',
      'if (node.params.mode !== 1) {}',
      'if (node.params.mode == 1) {}',
      'arr.map((p) => p.params[k])',
      'def.params.find((q) => q.id === pid)',
      'const n = spec.params.length;',
      'for (const p of def.params.slice(0, 3)) {}',
    ]) {
      expect(RAW_PARAM_WRITE.test(s), `guard must NOT match: ${s}`).toBe(false);
    }
    // The key extractor names the right param (that is what the ledger keys on).
    expect(RAW_PARAM_WRITE_KEY.exec('if (t) t.params.mode = m;')?.[1]).toBe('mode');
    expect(RAW_PARAM_WRITE_KEY.exec('t.params.pos_x = clampJoy(x);')?.[1]).toBe('pos_x');
    // an allow-annotated line is matched by the regex but exempted by the scan
    expect('t.params.k = 1; // guard:allow-raw-write'.includes(ALLOW)).toBe(true);

    // ── THE FIXTURE THAT KEEPS THE FINDING ALIVE ──
    // The pattern this guard shipped with, verbatim. It is asserted to MISS the
    // dotted form, permanently — so anyone who narrows RAW_PARAM_WRITE back
    // towards it sees, in one line, exactly what that costs. This is the
    // negative control on the INSTRUMENT rather than on the code.
    const OLD_BRACKET_ONLY = /\.params\[[^\]]+\]\s*=(?![=>])/;
    expect(OLD_BRACKET_ONLY.test('if (t) t.params.mode = m;'), 'the OLD pattern was blind here').toBe(
      false,
    );
    expect(OLD_BRACKET_ONLY.test('live.params.isPlaying = 1;'), 'the OLD pattern was blind here').toBe(
      false,
    );
    expect(OLD_BRACKET_ONLY.test('live.params[paramId] = value;'), 'the OLD pattern saw only this').toBe(
      true,
    );
  });

  it('the scan is not vacuous — it really reads the tree', () => {
    // The failure mode a green run cannot distinguish from a clean tree: a glob
    // that resolved to nothing. Pin a floor on both the file count and the hit
    // count, so a broken import.meta.glob is RED rather than a silent pass.
    expect(Object.keys(FILES).length, 'the ?raw glob resolved no files').toBeGreaterThan(500);
    expect(HITS.length, 'the widened pattern found no raw writes AT ALL — suspect the regex').toBeGreaterThan(
      50,
    );
    // …and it really does see the dotted form in the real tree, not just in the
    // synthetic strings above.
    expect(HITS.some((h) => h.key !== null), 'no DOTTED write found in the tree').toBe(true);
  });

  it('the shapes this guard STILL cannot see are ABSENT or COUNTED (stated scope, enforced)', () => {
    // ⚠ AN UNSTATED SCOPE READS AS FULL COVERAGE. These three write forms reach
    // a `params` bag without ever matching an assignment to
    // `.params[…]`/`.params.x`, so they are structurally invisible to
    // everything above. Rather than leave that as a prose caveat — which is how
    // the bracket-only hole survived — each is scanned here.
    //
    // `Object.assign` and `delete` are held at ZERO: neither exists today, and
    // either would be a genuinely new way to edit a param bag.
    //
    // WHOLE-BAG REPLACEMENT is DECLARED, not counted. `WHOLE_BAG_CEILING = 16`
    // is gone (2026-08-12, the no-ratchets sweep); the sites are named one by
    // one in `WHOLE_BAG_WRITES` with the shape each one is, because they are
    // not one thing: `if (!n.params) n.params = {}` is bag INITIALISATION,
    // `prev.params = { ...node.params }` is a reconciler SNAPSHOT, and
    // `this.params = p` is an engine class that merely has a field called
    // `params`. The list is strictly stronger than the number was — it still
    // makes a 17th site red, and it additionally reddens on a STALE entry,
    // which a ceiling cannot do (it just keeps the slack).
    const ZERO: [string, RegExp][] = [
      ['Object.assign into a params bag', /Object\.assign\(\s*[A-Za-z_$][\w$.]*\.params\b/],
      ['delete of a param key', /\bdelete\s+[A-Za-z_$][\w$.]*\.params[.[]/],
    ];
    // (WHOLE_BAG is module-scope, above, so the negative control below cannot
    //  drift from the regex the scan actually runs.)

    const zeroHits: string[] = [];
    /** `<file> <verbatim trimmed line>` — the key WHOLE_BAG_WRITES declares. */
    const bagKeys = new Set<string>();
    const bagSites: string[] = [];
    // The ledger anchors each site by its VERBATIM source line, so the ledger
    // module quotes every one of them as a `code: '…'` property and the scan
    // would report its own declarations. `isComment` cannot help — those are
    // code. They are skipped by SHAPE (a `code:` property), never by filename,
    // and the leg below asserts that shape is the ONLY reason a line in that
    // file was skipped — so a REAL whole-bag write there is still RED.
    const LEDGER = 'graph/raw-write-ledger.ts';
    const IS_ANCHOR = /^\s*code:\s*'/;
    const ledgerSkipped: string[] = [];
    for (const [path, src] of Object.entries(FILES)) {
      const rel = libRel(path);
      if (/\.test\.ts$/.test(rel)) continue;
      if (SANCTIONED.some((re) => re.test(rel))) continue;
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (isComment(line) || line.includes(ALLOW)) continue;
        for (const [name, re] of ZERO) {
          if (re.test(line)) zeroHits.push(`src/lib/${rel}:${i + 1} [${name}]  ${line.trim()}`);
        }
        if (!WHOLE_BAG.test(line)) continue;
        if (rel === LEDGER && IS_ANCHOR.test(line)) {
          ledgerSkipped.push(line.trim());
          continue;
        }
        bagKeys.add(`${rel} ${line.trim()}`);
        bagSites.push(`src/lib/${rel}:${i + 1}  ${line.trim()}`);
      }
    }

    expect(
      zeroHits.join('\n'),
      'a param write in a form this guard cannot see — teach RAW_PARAM_WRITE about it ' +
        '(do not just annotate the line)',
    ).toBe('');

    // DENY BY DEFAULT — an undeclared whole-bag replacement is RED.
    const declared = new Set(WHOLE_BAG_WRITES.map((e) => `${e.file} ${e.code}`));
    expect(
      [...bagKeys].filter((k) => !declared.has(k)).map((k) => k.replace(' ', '  ')).sort(),
      'whole-bag `x.params = …` replacement(s) with no entry in WHOLE_BAG_WRITES. This form is ' +
        'INVISIBLE to RAW_PARAM_WRITE, so declare it there (file + the VERBATIM line + kind + ' +
        `why) or route the write through the seam. All sites:\n  ${bagSites.join('\n  ')}`,
    ).toEqual([]);

    // ANCHORED TO THE ARTIFACT — a declaration matching nothing is RED. This is
    // the half a ceiling structurally cannot do: a drained site just widens the
    // slack under a `<=`, silently.
    expect(
      [...declared].filter((k) => !bagKeys.has(k)).map((k) => k.replace(' ', '  ')).sort(),
      'WHOLE_BAG_WRITES entr(ies) matching no line in the tree — the code moved or was fixed, ' +
        'so delete the entry (or update `code` to the new verbatim line)',
    ).toEqual([]);

    // The declarations are only skipped in the LEDGER FILE and only in the
    // `code:` shape — assert that, derived from the list itself, so the skip
    // cannot quietly start swallowing a real write there.
    expect(
      [...ledgerSkipped].sort(),
      "the ledger's skipped lines must be EXACTLY its own `code:` anchors",
    ).toEqual(WHOLE_BAG_WRITES.map((e) => `code: '${e.code}',`).sort());

    // The list is non-vacuous only if the scan is: a WHOLE_BAG that matched
    // nothing would satisfy both assertions above by emptying both sets.
    expect(bagKeys.size, 'the whole-bag scan resolved no sites at all').toBeGreaterThan(0);
  });

  it('NEGATIVE CONTROL: the whole-bag probe separates a REPLACEMENT from a write INTO the bag', () => {
    // The assertions above are set comparisons, so a WHOLE_BAG that matched
    // everything or nothing would look identical in the output to a clean tree.
    // This calls the SAME module-scope constant the check calls — a re-typed
    // copy in the self-test is how the previous one went blind.
    for (const s of [
      'if (!n.params) n.params = {};',
      'prev.params = { ...node.params };',
      'this.params = p;',
    ]) {
      expect(WHOLE_BAG.test(s), `whole-bag probe must MATCH: ${s}`).toBe(true);
    }
    for (const s of [
      'live.params[paramId] = value;',
      'node.params.mode = m;',
      'if (a.params === b.params) return;',
      'const p = node.params;',
    ]) {
      expect(WHOLE_BAG.test(s), `whole-bag probe must NOT match: ${s}`).toBe(false);
    }
  });
});
