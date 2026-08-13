// scripts/game-asset-distribution.test.ts
//
// CONFORMANCE GATE for ADR-007 (docs/adr/007-game-asset-distribution.md):
// third-party game assets may only enter the tree by being NAMED in the ADR.
//
// Why this exists, measured 2026-08-13 (#1497): the repo carried FOUR
// descriptions of the Blood assets and they disagreed. `Taskfile.yml` said the
// data was "user-provided … .gitignored"; `.gitignore` un-ignored it file by
// file; `ci.yml` materialised it from LFS and failed the build without it; and
// `PHASE0-STATUS.md` §3 said "the project never ships or auto-fetches it". The
// contradiction had already propagated into FOUR e2e coverage exemptions that
// justified skipping BLOOD with "non-redistributable … gitignored, absent in
// CI" — every clause false. Prose cannot hold this line on its own; this test
// is what makes the ADR load-bearing.
//
// ANCHORED TO THE ARTIFACT, BOTH DIRECTIONS:
//   - a committed asset the ADR does not name          → RED
//   - an ADR row naming a file that no longer exists   → RED
// so neither side can drift. There is no count anywhere in this file: the
// assertions are set-equality and membership.
//
// THE INSTRUMENT IS `git ls-files`, NOT THE FILESYSTEM, and that is
// load-bearing. `task setup:blood` copies a developer's FULL-GAME data over
// `packages/web/static/blood/` at the same paths. A filesystem listing cannot
// tell that apart from the committed shareware — it would read green while
// looking at entirely different bytes. Only the index knows what is committed.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ADR_PATH = 'docs/adr/007-game-asset-distribution.md';
const RUNTIME_PATH = 'packages/web/src/lib/blood/blood-runtime.ts';

/** Where a game module's assets would land. Anything game-data-shaped under
 *  here must be accounted for by the ADR — including a directory the ADR does
 *  not govern yet (that is exactly the case we want to go red). */
const STATIC_ROOT = 'packages/web/static/';

/** Extensions that mean "third-party game data" in this repo's game modules
 *  (Blood/Build RFF+ART+DAT, DOOM/Quake WAD+PAK+PK3, Duke-family GRP). A file
 *  with one of these under STATIC_ROOT is data, not code, and needs a decision
 *  recorded in the ADR — not a reviewer noticing a big binary in a diff. */
const GAME_DATA_EXT = /\.(wad|iwad|rff|art|dat|pk3|ipk3|grp|pak|ken)$/i;

/** The classes ADR-007 defines. A row with any other class is a typo or a new
 *  category that needs the ADR's prose updated first. */
const CLASSES = new Set(['shareware-data', 'authored-data', 'engine', 'runtime', 'doc']);

interface AllowRow {
  path: string;
  cls: string;
  why: string;
}

// ── the instrument ─────────────────────────────────────────────────────────

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);
}

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

/** Text between two HTML-comment fences, or throw. Fail CLOSED: a renamed or
 *  deleted fence must break the gate loudly, never silently empty it. */
function between(text: string, name: string): string {
  const open = `<!-- ${name}:begin -->`;
  const close = `<!-- ${name}:end -->`;
  const a = text.indexOf(open);
  const b = text.indexOf(close);
  if (a < 0 || b < 0 || b < a) {
    throw new Error(
      `${ADR_PATH}: the '${name}' fence is missing or inverted. This test reads the ADR ` +
        `as its allowlist — restore the '${open}' / '${close}' markers.`,
    );
  }
  return text.slice(a + open.length, b);
}

// ── the ADR, parsed ────────────────────────────────────────────────────────

/** The path prefixes ADR-007 governs. */
export function parseScope(adr: string): string[] {
  const rows = between(adr, 'game-asset-scope')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('```'));
  if (rows.length === 0) throw new Error(`${ADR_PATH}: the scope block is empty`);
  return rows.sort();
}

/** The allowlist table rows: | `path` | class | why | */
export function parseAllowlist(adr: string): AllowRow[] {
  const rows: AllowRow[] = [];
  for (const line of between(adr, 'game-asset-allowlist').split('\n')) {
    const m = /^\|\s*`([^`]+)`\s*\|\s*([a-z-]+)\s*\|\s*(.+?)\s*\|\s*$/.exec(line.trim());
    if (m) rows.push({ path: m[1]!, cls: m[2]!, why: m[3]! });
  }
  if (rows.length === 0) throw new Error(`${ADR_PATH}: the allowlist table parsed to nothing`);
  return rows;
}

/** BLOOD_BUNDLED_FILES as the RUNTIME declares it — the list the card actually
 *  fetches. Parsed from source so the ADR cannot drift from the code. */
export function parseBundledFiles(src: string): string[] {
  const m = /export const BLOOD_BUNDLED_FILES = \[([^\]]*)\]/.exec(src);
  if (!m) {
    throw new Error(
      `${RUNTIME_PATH}: could not find 'export const BLOOD_BUNDLED_FILES = [ … ]'. ` +
        `If it was renamed, update this test — do not delete the cross-check.`,
    );
  }
  const names = [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
  if (names.length === 0) throw new Error(`${RUNTIME_PATH}: BLOOD_BUNDLED_FILES parsed to nothing`);
  return names.sort();
}

// ── the predicates the checks AND the negative controls both call ──────────

/** Committed paths that sit under one of the governed prefixes. */
export function underScope(tracked: readonly string[], scope: readonly string[]): string[] {
  return tracked.filter((f) => scope.some((p) => f.startsWith(p))).sort();
}

/** Committed game-data files that no ADR row names — including ones outside
 *  the governed prefixes entirely (a brand-new `static/<game>/` directory). */
export function unaccountedGameData(
  tracked: readonly string[],
  allowed: ReadonlySet<string>,
): string[] {
  return tracked
    .filter((f) => f.startsWith(STATIC_ROOT) && GAME_DATA_EXT.test(f) && !allowed.has(f))
    .sort();
}

// ── the gate ───────────────────────────────────────────────────────────────

describe('ADR-007: committed game assets match the ADR allowlist', () => {
  const adr = read(ADR_PATH);
  const scope = parseScope(adr);
  const allow = parseAllowlist(adr);
  const allowPaths = allow.map((r) => r.path).sort();
  const tracked = trackedFiles();

  it('the instrument read a real tree', () => {
    // Guard the measurement itself: an empty/failed `git ls-files` would make
    // every set-equality below vacuously green. Anchor on a file that exists by
    // definition in this repo rather than on how many were returned.
    expect(tracked).toContain('Taskfile.yml');
  });

  it('the ADR is committed, not merely present in the working tree', () => {
    // The allowlist is read from the working-tree ADR (so a pending amendment
    // is what you are checked against), but an ADR that never gets committed
    // would leave the assets on main with no record naming them.
    expect(tracked).toContain(ADR_PATH);
  });

  it('every committed file under the governed prefixes is named in the ADR, and vice versa', () => {
    const committed = underScope(tracked, scope);
    expect(
      committed,
      `The committed contents of ${scope.join(', ')} disagree with the allowlist in ${ADR_PATH}.\n` +
        `  Committed but NOT in the ADR: ${committed.filter((f) => !allowPaths.includes(f)).join(', ') || '(none)'}\n` +
        `  In the ADR but NOT committed: ${allowPaths.filter((f) => !committed.includes(f)).join(', ') || '(none)'}\n` +
        `Adding a game asset is an ADR amendment, not a file drop — and a row for a deleted ` +
        `file is a stale record. Fix whichever side is wrong.`,
    ).toEqual(allowPaths);
  });

  it('no game-data file anywhere under static/ escapes the ADR', () => {
    // Deny by default, beyond the governed prefixes: a NEW game module dropping
    // `static/<game>/BASE.GRP` is caught even though its directory is not in
    // the scope block yet — which is precisely when a decision is needed.
    const orphans = unaccountedGameData(tracked, new Set(allowPaths));
    expect(
      orphans,
      `Committed game-data file(s) that ${ADR_PATH} does not name:\n    ${orphans.join('\n    ')}\n` +
        `Add a row (path, class, why) and a scope prefix if it is a new game — or do not commit it.`,
    ).toEqual([]);
  });

  it('every allowlist row declares a known class and a real reason', () => {
    const bad = allow.filter((r) => !CLASSES.has(r.cls) || r.why.length < 20);
    expect(
      bad.map((r) => `${r.path} (class='${r.cls}', why=${r.why.length} chars)`),
      `Allowlist rows must carry a class from {${[...CLASSES].join(', ')}} and a reason that ` +
        `says why the file is in the tree — "asset" is not a reason.`,
    ).toEqual([]);
  });

  it("the ADR's bundled Blood data matches what the runtime actually fetches", () => {
    // DERIVED MEMBERSHIP: the ADR's data rows and the runtime's fetch list are
    // two views of one truth. If a file is added to the bundle but not to
    // BLOOD_BUNDLED_FILES it is dead weight in the repo; if it is added to
    // BLOOD_BUNDLED_FILES but not committed the card 404s on it at boot.
    const adrData = allow
      .filter(
        (r) =>
          r.path.startsWith('packages/web/static/blood/') &&
          (r.cls === 'shareware-data' || r.cls === 'authored-data'),
      )
      .map((r) => r.path.slice('packages/web/static/blood/'.length))
      .sort();
    expect(
      adrData,
      `${ADR_PATH}'s bundled-data rows and BLOOD_BUNDLED_FILES in ${RUNTIME_PATH} have drifted. ` +
        `Every bundled data file must be both committed AND fetched at boot.`,
    ).toEqual(parseBundledFiles(read(RUNTIME_PATH)));
  });
});

describe('ADR-007 gate: negative controls (permanent — same predicates as above)', () => {
  // These call the SAME functions the checks call. Without them, a predicate
  // that quietly stopped matching would keep this file green forever on a tree
  // that happens to be clean.

  it('a new game asset in an ungoverned directory is caught', () => {
    const synthetic = [
      'packages/web/static/quake/PAK0.PAK',
      'packages/web/static/duke3d/DUKE3D.GRP',
      'packages/web/static/doom/DOOM1.WAD',
    ];
    for (const f of synthetic) {
      expect(
        unaccountedGameData([f], new Set<string>()),
        `the game-data sweep failed to flag ${f}`,
      ).toEqual([f]);
    }
  });

  it('ordinary committed files are NOT flagged as game data', () => {
    // The other direction: a sweep that flagged everything would also be green
    // on the real tree only by accident, and would block unrelated work.
    for (const f of [
      'packages/web/static/blood/blood.js',
      'packages/web/static/favicon.png',
      'packages/web/src/lib/video/modules/blood.ts',
      'art/baselines/moog911.f32',
    ]) {
      expect(unaccountedGameData([f], new Set<string>()), `${f} was wrongly flagged`).toEqual([]);
    }
  });

  it('an unlisted committed asset and a stale ADR row both move the comparison', () => {
    const scope = ['packages/web/static/blood/'];
    const base = ['packages/web/static/blood/BLOOD.RFF'];
    // extra file on disk, ADR unchanged → the sets differ
    expect(underScope([...base, 'packages/web/static/blood/EXTRA.RFF'], scope)).not.toEqual(base);
    // ADR row for a file that is gone → the sets differ the other way
    expect(underScope([], scope)).not.toEqual(base);
    // and they agree when the tree matches
    expect(underScope([...base, 'README.md'], scope)).toEqual(base);
  });

  it('a truncated ADR fence fails loudly instead of emptying the allowlist', () => {
    expect(() => parseAllowlist('no fences here')).toThrow(/fence is missing/);
    expect(() =>
      parseAllowlist('<!-- game-asset-allowlist:begin --><!-- game-asset-allowlist:end -->'),
    ).toThrow(/parsed to nothing/);
    expect(() => parseBundledFiles('const SOMETHING_ELSE = [];')).toThrow(/BLOOD_BUNDLED_FILES/);
  });
});
