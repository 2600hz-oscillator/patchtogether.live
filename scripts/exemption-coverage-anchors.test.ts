// scripts/exemption-coverage-anchors.test.ts
//
// EVERY COVERAGE EXEMPTION NAMES ITS REPLACEMENT — AND THE REPLACEMENT MUST EXIST.
//
// The 370 entries in Bucket 2 of the test ledger all make the same argument:
// "this module/port is opted out of a UNIVERSAL sweep because dedicated coverage
// lives over THERE." Every gate over those lists checks the argument's FORM —
// the key resolves to a registered module (vrt-meta.test.ts,
// test-reconciliation.test.ts), the reason is longer than N characters
// (vrt-meta.test.ts), the allowlist and the record agree in both directions
// (vrt-meta.test.ts's frozen-allowlist pair) — and NOT ONE of them reads the
// filesystem. So the "over THERE" half was unverified: a reason could name any
// file at all, including one that had never been written.
//
// It did. Measured on `main` @ 2bff2702 (#1524), by extracting every
// `*.test.ts` / `*.spec.ts` token out of the three exemption-list files and
// resolving each against the tree:
//
//   BEHAVIORAL_MODULE_EXEMPT['slewSwitch']  → slewswitch.spec.ts    NEVER EXISTED
//   BEHAVIORAL_SWEEP_EXEMPT['wavetableVco.fm' | '.fmAmount' | '.pmAmount']
//                                           → wavetable-vco.test.ts NEVER EXISTED
//   BEHAVIORAL_SWEEP_EXEMPT['analogVco.fm' | '.fmAmount' | '.pmAmount']
//                                           → analog-vco.test.ts    RENAMED AWAY
//   EXEMPT_FROM_VRT['audioIn']              → audioin.test.ts       NEVER EXISTED
//
// SLEWSWITCH had no test at ANY tier — no unit, no e2e, no ART — and its
// exemption's prose was the only thing standing between the module and zero
// coverage. Writing the test it named immediately found a live CV-range bug
// (#1651). wavetableVco's FM and PM paths were likewise asserted nowhere.
//
// THE SHAPE OF THE GATE. Deny by default, anchored to the ARTIFACT: a name that
// no longer resolves is RED. No ceiling, no allowlist of "known-stale" names, no
// count of anything — an unconditional `expect(unresolved).toEqual([])`, which
// is the only form that cannot go stale (a ceiling of 0 measures nothing; a
// ceiling above 0 is a licence).
//
// WHAT THIS GATE CANNOT SEE, stated inside the gate (blind-gates rule):
//   * That the named file COVERS what the reason claims. It proves the artifact
//     exists, not that it asserts anything — `analog-vco-modulation.test.ts` had
//     to be read by a human to confirm it really does cover FM/PM depth. A test
//     file that is renamed to a real-but-unrelated name still passes here.
//   * Coverage claimed in PROSE without a filename ("covered by VRT specs",
//     "unit + E2E provide coverage"). Those are outside this gate's reach by
//     construction; it can only anchor a claim that names something.
//   * Files outside the three list files below. A fourth exemption list added
//     elsewhere is invisible until it is added to EXEMPTION_SOURCES — which is
//     why that array is asserted non-empty and every entry is asserted to exist.
//   * A GLOB. `per-module-per-port-*.spec.ts` forms no token this extractor
//     matches, so a claim written that way escapes the anchor. Name the file.
//
// ⚠ ONE CONSEQUENCE THAT SURPRISES PEOPLE: you cannot write a nonexistent
// filename even to say it does not exist. The four notes this sweep left behind
// ("this reason used to name X, which never existed") had to be rephrased to
// describe the name rather than spell it. That is the gate working — a reader
// grepping for a filename should never land on a note that manufactures a hit.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The files that hold Bucket-2 coverage-exemption lists. This is the gate's
 * SCOPE, and it is deliberately whole-FILE rather than per-record: a coverage
 * claim in a `//` comment above an entry ("Covered by analog-vco.test.ts") is
 * read by exactly the same human, for exactly the same decision, as the claim
 * inside the reason string — and one of the eight stale references found was in
 * a comment. Narrowing to reason strings would have missed it.
 */
const EXEMPTION_SOURCES = [
  'e2e/vrt/vrt-exemptions.ts',
  'e2e/tests/per-module-per-port-behavioral.spec.ts',
  'e2e/tests/_per-module-per-port-shared.ts',
] as const;

/** Every `*.test.ts` / `*.spec.ts` basename anywhere in the repo. */
function indexTestFiles(): Set<string> {
  const names = new Set<string>();
  const SKIP = new Set(['node_modules', '.git', '.svelte-kit', 'dist', 'build', '.claude', 'test-results', 'playwright-report']);
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(test|spec)\.ts$/.test(e.name)) names.add(e.name);
    }
  };
  walk(ROOT);
  return names;
}

/** Basename tokens that look like a test artifact, in source order. */
function namedTestArtifacts(src: string): string[] {
  return [...src.matchAll(/\b([A-Za-z0-9_.\-]+\.(?:test|spec)\.ts)\b/g)].map((m) => m[1]!);
}

/**
 * THE PREDICATE. Both the check and its negative control call this — never two
 * parallel implementations, which is how a control comes to pass against code
 * the check does not run.
 */
export function unresolvedCoverageAnchors(
  sources: readonly { file: string; src: string }[],
  known: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const { file, src } of sources) {
    for (const name of namedTestArtifacts(src)) {
      if (!known.has(name)) out.push(`${file} → ${name}`);
    }
  }
  return [...new Set(out)].sort();
}

const KNOWN = indexTestFiles();
const SOURCES = EXEMPTION_SOURCES.map((file) => ({
  file,
  src: readFileSync(join(ROOT, file), 'utf8'),
}));

describe('coverage exemptions are anchored to REAL test artifacts', () => {
  it('the gate has a non-empty scope and every scoped file exists', () => {
    // A scope that silently shrank to nothing would make every assertion below
    // vacuously green — the exact failure this repo calls a blind gate.
    expect(EXEMPTION_SOURCES.length).toBeGreaterThan(0);
    for (const f of EXEMPTION_SOURCES) {
      expect(existsSync(join(ROOT, f)), `${f} (EXEMPTION_SOURCES entry) must exist`).toBe(true);
      expect(statSync(join(ROOT, f)).size, `${f} must be non-empty`).toBeGreaterThan(0);
    }
    expect(KNOWN.size, 'test/spec files indexed across the repo').toBeGreaterThan(100);
  });

  it('every exemption list names at least one test artifact (the gate has a subject)', () => {
    for (const { file, src } of SOURCES) {
      expect(
        namedTestArtifacts(src).length,
        `${file} names no *.test.ts / *.spec.ts at all — either the list stopped ` +
          'citing its replacement coverage, or the extractor stopped matching',
      ).toBeGreaterThan(0);
    }
  });

  it('NO exemption names a test file that does not exist', () => {
    expect(
      unresolvedCoverageAnchors(SOURCES, KNOWN),
      'A coverage exemption cites a test artifact that is not in the tree. Either the ' +
        'file was renamed (repoint the reason at the real name) or the coverage was ' +
        'never written (write it, or delete the exemption and let the sweep run). ' +
        'Do NOT satisfy this by deleting the filename from the prose: an exemption ' +
        'that names nothing is weaker than one that names something wrong.',
    ).toEqual([]);
  });

  // ── PERMANENT NEGATIVE CONTROLS — both directions, on the SAME predicate ──
  //
  // A control that only proves the probe CAN move proves nothing about what it
  // reads, so both legs are pinned: a fabricated name must be caught, and a real
  // name must not be.

  it('negative control: a fabricated filename IS caught', () => {
    const planted = [
      { file: 'synthetic', src: "foo: 'covered by a-file-nobody-wrote.test.ts'" },
    ];
    expect(unresolvedCoverageAnchors(planted, KNOWN)).toEqual([
      'synthetic → a-file-nobody-wrote.test.ts',
    ]);
  });

  it('negative control: a REAL filename is NOT caught', () => {
    // Chosen off the live index rather than typed, so this leg cannot rot when
    // the file it names is renamed.
    const real = [...KNOWN].sort()[0]!;
    const planted = [{ file: 'synthetic', src: `foo: 'covered by ${real}'` }];
    expect(unresolvedCoverageAnchors(planted, KNOWN)).toEqual([]);
  });

  it('negative control: the two legs disagree, so the predicate is not constant', () => {
    const real = [...KNOWN].sort()[0]!;
    const caught = unresolvedCoverageAnchors(
      [{ file: 's', src: 'x: nope-not-real.test.ts' }],
      KNOWN,
    );
    const clean = unresolvedCoverageAnchors([{ file: 's', src: `x: ${real}` }], KNOWN);
    expect(caught).not.toEqual(clean);
  });
});
