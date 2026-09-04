// scripts/package-workspace-membership.test.ts
//
// DENY BY DEFAULT: every package.json in the tree is either an npm WORKSPACE,
// or a NAMED independent package that states WHY it is not one *and* names the
// lane file that runs its tests. A package can be outside the workspace graph.
// It cannot be outside both the workspace graph and CI.
//
// Why this gate exists, measured (#1496, on main @ b9d5e247):
// `packages/present-shell/` was in the repo and in no gate. Root `workspaces`
// lists the five web packages explicitly, so present-shell was absent from the
// workspace graph; `npm test --workspaces` therefore never reached it; and
// `git grep -l present-shell` matched ZERO files under `.github/`,
// `Taskfile.yml` or root `package.json`. Its `parse-features.test.cjs` — five
// real assertions on the code that places every projector window — had not run
// once in CI since the package landed on 2026-06-27 (2a93e1cfb).
//
// ⚠ THE FIX IS NOT "MAKE IT A WORKSPACE", AND THIS GATE DELIBERATELY DOES NOT
// DEMAND THAT. present-shell's exclusion is correct and stays: its `electron`
// devDependency postinstalls a platform binary — measured for the pinned
// 32.3.3 on the platform CI runs, `electron-v32.3.3-linux-x64.zip` =
// 107,429,238 bytes — which ci.yml's `~/.npm` + `~/.cache/ms-playwright` cache
// does not cover, and root install runs in every CI job. Workspace membership
// would charge every job in the repo for a package nothing imports. What was
// wrong was that "not a workspace" silently also meant "not tested". So the
// gate asserts the DELIBERATE choice plus its consequence, not the choice.
//
// ── WHAT THIS GATE CANNOT SEE (stated, per the blind-gates rule) ────────────
//  · Only TRACKED package.json files (`git ls-files`). An untracked one is
//    invisible here — and equally invisible to CI, which builds from a fresh
//    checkout of tracked paths only. That is the intended scope, not a hole.
//  · It reads the WIRING, not a run: `testsWiredIn` proves the lane file still
//    names the package's test entry point and that the entry point is still a
//    tracked file. It cannot prove the lane was green. (The lane that runs THIS
//    file is the same `task test` that runs that entry point, so a wiring that
//    stops executing surfaces as a failing/absent test, not as a silent skip.)
//  · It says nothing about whether a WORKSPACE package's tests are any good —
//    membership only means `npm test --workspaces` would reach it.
//  · It reads the ROOT `workspaces` field only. A nested workspace root inside
//    a package would be missed; there is none, and `every root workspace
//    pattern still matches a tracked package` below would not notice one.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A package that is in the repo but NOT an npm workspace, on purpose. */
export interface IndependentPackage {
  /** Repo-relative directory holding the package.json. */
  readonly dir: string;
  /** REQUIRED BY THE TYPE — `tsc` refuses an entry without one, before any test
   *  runs. Why this package is not a workspace member. */
  readonly why: string;
  /** The wiring that keeps the package inside a lane that actually runs:
   *  a repo-relative lane file, and the test entry point it must still name.
   *  Both sides are checked against the tree, so a rename on either side
   *  reddens instead of silently un-testing the package. */
  readonly testsWiredIn: {
    readonly laneFile: string;
    readonly namesTestEntry: string;
  };
}

/** NAMED, per-instance exemptions. Not a filename pattern and not a count — one
 *  entry per package, each carrying its own reason and its own wiring, so a
 *  SECOND orphan package appearing under `packages/` still reddens this gate
 *  even though a sibling directory is already listed. */
const INDEPENDENT_PACKAGES: readonly IndependentPackage[] = [
  {
    dir: 'packages/present-shell',
    why:
      'Electron kiosk shell for multi-projector venues. It LOADS the hosted web app (no runtime ' +
      'bridge, no forked logic) and ships nothing into it, so no web build, deploy or bundle ' +
      'depends on it. Its `electron` devDependency postinstalls a ~107 MB platform binary that ' +
      "ci.yml's ~/.npm cache does not cover and root install runs in every CI job, so workspace " +
      'membership would charge the whole repo for a package nothing imports. Its own tests are ' +
      'pure node:test against a dependency-free .cjs module, so they run in the required unit ' +
      'lane with nothing installed — see testsWiredIn.',
    testsWiredIn: {
      laneFile: 'Taskfile.yml',
      namesTestEntry: 'packages/present-shell/parse-features.test.cjs',
    },
  },
  {
    dir: 'apps/desktop',
    why:
      'Electron native shell (main + preload + loopback server) for the native-shell program. ' +
      'Nothing in the web graph imports it and no web build/deploy depends on it; its `electron` ' +
      'devDependency postinstalls a ~100 MB platform binary and it carries its own @playwright/test, ' +
      "neither of which ci.yml's ~/.npm cache covers — workspace membership would charge every CI " +
      'job in the repo for a package only the desktop lane uses (the packages/present-shell ' +
      'precedent, one entry up). Its tests are the Playwright boot/supervision harness run by ' +
      '`task desktop:e2e` (local lane today; the CI job lands later with its own owner sign-off ' +
      'checkpoint per the 2026-09-03 GATING-light answer) — see testsWiredIn.',
    testsWiredIn: {
      laneFile: 'Taskfile.yml',
      namesTestEntry: 'apps/desktop/e2e/boot.spec.ts',
    },
  },
];

/** Every tracked package.json, as the directory that holds it, EXCLUDING the
 *  workspace root itself. Anchored to `git ls-files`, so a package added
 *  anywhere in the tree — at any depth, under any directory — is seen. */
function trackedPackageDirs(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', '*package.json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  })
    .split('\0')
    .filter(Boolean)
    .filter((p) => p !== 'package.json')
    .map((p) => dirname(p));
}

/** Does an npm `workspaces` pattern cover this directory? npm patterns are
 *  paths with optional `*` (one segment) / `**` (any depth) globs — the repo
 *  uses plain paths today, but a future `packages/*` must classify correctly.
 *
 *  Exported so the controls exercise THIS matcher rather than a re-typed copy;
 *  a re-typed copy in a self-test is how gates in this repo went blind before. */
export function matchesWorkspacePattern(pattern: string, dir: string): boolean {
  const source = pattern
    .split('/')
    .map((seg) =>
      seg === '**' ? '.*' : seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'),
    )
    .join('/');
  return new RegExp(`^${source}$`).test(dir);
}

/** THE classification this gate is about. Every package directory is a
 *  workspace, a named independent package, both (a contradiction — the
 *  exemption is lying), or NEITHER (an orphan: in the repo, in no lane). */
export function classifyPackageDirs(
  packageDirs: readonly string[],
  workspacePatterns: readonly string[],
  independent: readonly Pick<IndependentPackage, 'dir'>[],
): { orphans: string[]; doubleListed: string[] } {
  const named = new Set(independent.map((e) => e.dir));
  const orphans: string[] = [];
  const doubleListed: string[] = [];
  for (const dir of packageDirs) {
    const isWorkspace = workspacePatterns.some((p) => matchesWorkspacePattern(p, dir));
    const isNamed = named.has(dir);
    if (!isWorkspace && !isNamed) orphans.push(dir);
    if (isWorkspace && isNamed) doubleListed.push(dir);
  }
  return { orphans, doubleListed };
}

/** Check one exemption's test wiring against the tree. Returns the problems
 *  found (empty = wired). Both lookups are injected so the controls can drive
 *  the SAME function with a synthetic tree. */
export function wiringProblems(
  entry: IndependentPackage,
  readText: (rel: string) => string | null,
  isTrackedFile: (rel: string) => boolean,
): string[] {
  const problems: string[] = [];
  const { laneFile, namesTestEntry } = entry.testsWiredIn;
  const lane = readText(laneFile);
  if (lane === null) {
    problems.push(`${entry.dir}: lane file '${laneFile}' does not exist`);
  } else if (!lane.includes(namesTestEntry)) {
    problems.push(`${entry.dir}: lane file '${laneFile}' no longer names '${namesTestEntry}'`);
  }
  if (!isTrackedFile(namesTestEntry)) {
    problems.push(`${entry.dir}: test entry '${namesTestEntry}' is not a tracked file`);
  }
  if (!namesTestEntry.startsWith(`${entry.dir}/`)) {
    problems.push(`${entry.dir}: test entry '${namesTestEntry}' is outside the package it claims to test`);
  }
  return problems;
}

const trackedFiles = new Set(
  execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\0')
    .filter(Boolean),
);
const packageDirs = trackedPackageDirs();
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  workspaces?: string[];
};
const WORKSPACES: string[] = rootPkg.workspaces ?? [];

const readRepoText = (rel: string): string | null => {
  const abs = join(ROOT, rel);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
};

describe('no package is outside both the workspace graph and CI', () => {
  it('every tracked package.json is a workspace or a NAMED independent package', () => {
    const { orphans, doubleListed } = classifyPackageDirs(packageDirs, WORKSPACES, INDEPENDENT_PACKAGES);

    expect(
      orphans,
      'These packages are in the repo but in NO lane: absent from root `workspaces` (so ' +
        '`npm test --workspaces` never reaches them) and absent from INDEPENDENT_PACKAGES. ' +
        'Either add the directory to root `workspaces`, or add an INDEPENDENT_PACKAGES entry ' +
        'here saying why it is independent AND naming the lane file that runs its tests. ' +
        '"It has no tests" is not a third option — a package with no gate is how ' +
        'packages/present-shell went 6 weeks untested (#1496).',
    ).toEqual([]);

    expect(
      doubleListed,
      'These packages are BOTH in root `workspaces` and in INDEPENDENT_PACKAGES. The exemption ' +
        'is stating a reason that is no longer true — delete the entry.',
    ).toEqual([]);
  });

  it('the enumeration is not vacuous — it reaches the packages we know exist', () => {
    // ⚠ A BARE GREEN ABOVE WOULD BE INDISTINGUISHABLE FROM AN ENUMERATION OF
    // ZERO PACKAGES. Anchored to named directories rather than to a count: a
    // count would be correct when typed and wrong the moment a sibling branch
    // merged, and would not tell us WHICH packages were seen. Deliberately
    // spans a workspace under packages/, a workspace at the top level, and the
    // independent package — so the anchor also proves the enumeration is not
    // silently confined to one subtree.
    const mustFind = ['packages/web', 'e2e', 'packages/present-shell'];
    const missing = mustFind.filter((d) => !packageDirs.includes(d));
    expect(missing, 'the tracked package.json enumeration no longer reaches these — it broke').toEqual([]);
    // The workspace ROOT is not a member of itself; if it leaked in, every
    // assertion here would be classifying the wrong subject.
    expect(packageDirs, 'the repo root leaked into the package enumeration').not.toContain('.');
  });

  it('every INDEPENDENT_PACKAGES entry still resolves to a real package', () => {
    // Anchor the ledger to the ARTIFACT: an exemption naming something that no
    // longer exists is RED, not quietly inert.
    const stale = INDEPENDENT_PACKAGES.filter((e) => !packageDirs.includes(e.dir)).map(
      (e) => `${e.dir} (${e.why.slice(0, 60)}…)`,
    );
    expect(
      stale,
      'INDEPENDENT_PACKAGES names a package directory with no tracked package.json — ' +
        'the package was deleted or moved; delete the entry.',
    ).toEqual([]);
  });

  it('every root workspace pattern still matches a tracked package', () => {
    // The other direction: a `workspaces` entry pointing at nothing means npm
    // is silently resolving a graph nobody has checked since the rename.
    const unmatched = WORKSPACES.filter((p) => !packageDirs.some((d) => matchesWorkspacePattern(p, d)));
    expect(unmatched, 'root package.json `workspaces` names a path with no tracked package.json').toEqual([]);
    expect(WORKSPACES.length, 'root package.json has no `workspaces` field — this gate read nothing').toBeGreaterThan(
      0,
    );
  });

  it("each independent package's tests are wired into a lane file that still names them", () => {
    const problems = INDEPENDENT_PACKAGES.flatMap((e) =>
      wiringProblems(e, readRepoText, (rel) => trackedFiles.has(rel)),
    );
    expect(
      problems,
      'An independent package claims a test wiring that no longer holds. This is the exact ' +
        'state #1496 was filed for: the package exists, the test file exists, and nothing runs ' +
        'it. Fix the lane file (or the entry), do not delete the assertion.',
    ).toEqual([]);
  });

  it('each independent package explains itself in prose, not a shrug', () => {
    const thin = INDEPENDENT_PACKAGES.filter((e) => e.why.trim().length < 40).map((e) => e.dir);
    expect(thin, 'an INDEPENDENT_PACKAGES `why` is too short to be a reason').toEqual([]);
  });

  it('NEGATIVE CONTROL: the classifier flags an orphan, a double-listing, and neither otherwise', () => {
    // Drives the SAME classifyPackageDirs the real assertion calls, with a
    // synthetic tree — so a classifier that silently stopped classifying (an
    // empty input, a matcher that matches everything) cannot pass the assertion
    // above by returning an empty list.
    const synthetic = ['packages/web', 'packages/present-shell', 'tools/orphan-spike'];
    const named = [{ dir: 'packages/present-shell' }];

    const real = classifyPackageDirs(synthetic, WORKSPACES, named);
    expect(real.orphans, 'an unlisted package must be reported as an orphan').toEqual(['tools/orphan-spike']);
    expect(real.doubleListed).toEqual([]);

    // …and the inverse direction: listing a workspace as independent is a
    // contradiction, and must not read as "fine".
    const contradiction = classifyPackageDirs(synthetic, WORKSPACES, [{ dir: 'packages/web' }, ...named]);
    expect(contradiction.doubleListed).toEqual(['packages/web']);

    // A classifier that flagged everything would also pass the two lines above,
    // so assert the clean case is genuinely clean.
    const clean = classifyPackageDirs(['packages/web'], WORKSPACES, []);
    expect(clean).toEqual({ orphans: [], doubleListed: [] });
  });

  it('NEGATIVE CONTROL: the workspace matcher respects segment boundaries', () => {
    expect(matchesWorkspacePattern('packages/*', 'packages/web')).toBe(true);
    expect(matchesWorkspacePattern('packages/*', 'packages/web/nested')).toBe(false);
    expect(matchesWorkspacePattern('packages/**', 'packages/web/nested')).toBe(true);
    expect(matchesWorkspacePattern('packages/web', 'packages/website')).toBe(false);
    // A literal dot in a pattern must not behave as regex "any character" —
    // otherwise a pattern would silently cover a directory it does not name and
    // an orphan package would classify as a workspace.
    expect(matchesWorkspacePattern('packages/a.b', 'packages/axb')).toBe(false);
    expect(matchesWorkspacePattern('packages/a.b', 'packages/a.b')).toBe(true);
  });

  it('NEGATIVE CONTROL: the wiring check fails on a lane that dropped the test', () => {
    // Same wiringProblems() the real assertion calls, against synthetic lookups.
    const entry = INDEPENDENT_PACKAGES[0];
    const { laneFile, namesTestEntry } = entry.testsWiredIn;

    // Positive leg first: with the REAL tree it is clean — proving the
    // synthetic failures below are caused by the perturbation and not by a
    // predicate that always complains.
    expect(wiringProblems(entry, readRepoText, (rel) => trackedFiles.has(rel))).toEqual([]);

    // Lane file exists but no longer names the test entry (the regression this
    // gate exists to catch: someone deletes the task line).
    const laneWithoutIt = readRepoText(laneFile)!.split(namesTestEntry).join('# removed');
    expect(
      wiringProblems(entry, (rel) => (rel === laneFile ? laneWithoutIt : readRepoText(rel)), (rel) =>
        trackedFiles.has(rel),
      ),
    ).toEqual([`${entry.dir}: lane file '${laneFile}' no longer names '${namesTestEntry}'`]);

    // Lane file gone entirely.
    expect(wiringProblems(entry, () => null, (rel) => trackedFiles.has(rel))).toEqual([
      `${entry.dir}: lane file '${laneFile}' does not exist`,
    ]);

    // Test entry no longer tracked (renamed/deleted test file).
    expect(wiringProblems(entry, readRepoText, () => false)).toEqual([
      `${entry.dir}: test entry '${namesTestEntry}' is not a tracked file`,
    ]);

    // A wiring that points at some OTHER package's test would otherwise satisfy
    // every check above while testing nothing of this package.
    expect(
      wiringProblems(
        { ...entry, testsWiredIn: { laneFile, namesTestEntry: 'packages/web/vitest.config.ts' } },
        readRepoText,
        (rel) => trackedFiles.has(rel),
      ),
    ).toContain(
      `${entry.dir}: test entry 'packages/web/vitest.config.ts' is outside the package it claims to test`,
    );
  });
});
