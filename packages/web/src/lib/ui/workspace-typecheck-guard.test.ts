// packages/web/src/lib/ui/workspace-typecheck-guard.test.ts
//
// EVERY TS-BEARING WORKSPACE DEFINES `typecheck` — the --if-present hole
// cannot silently reopen (#1499).
//
// ─────────────────────────────────────────────────────────────────────────
// THE BUG THIS EXISTS FOR
//
// Root `package.json` runs `npm run typecheck --workspaces --if-present`.
// `--if-present` means a workspace WITHOUT a `typecheck` script is skipped
// with no output and no failure — so for as long as the e2e workspace had no
// script, ~509 Playwright spec files, every fixture and every config were
// typechecked by NOTHING. The cost was real: an invalid `timeout` key inside
// `toHaveScreenshot` options sat silently ignored (vrt-config-budget.test.ts
// tells that story), and `use.reducedMotion` at the top level of both VRT
// configs was a knob Playwright 1.59 never read. Excess-property checking
// would have rejected both on sight — had anything compiled the files.
//
// This guard makes the hole structural: a NEW workspace (or a removed
// script) reddens here, not six weeks later at runtime.
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT IT CHECKS (and what it structurally cannot see)
//
//   1. The workspace list is read off root package.json — DERIVED, never a
//      hand-typed roster, so a new workspace is enrolled the moment it is
//      declared.
//   2. A workspace is "TS-bearing" when it CONTAINS a .ts/.tsx/.svelte.ts
//      file (artifact-derived, not declared).
//   3. Every TS-bearing workspace defines `scripts.typecheck`, unless it has
//      a NAMED exemption below carrying a why.
//   4. Exemptions are ANCHORED: one naming a workspace that no longer
//      exists, is no longer TS-bearing, or that now HAS a typecheck script
//      is itself a failure — a stale entry cannot linger.
//
// ⚠ SCOPE — what a green run here does NOT prove: that any workspace's
// typecheck script actually covers all of that workspace's files (an
// `include` hole in a tsconfig is invisible from here), nor that the script
// is wired into CI (that is root package.json's `typecheck` + task
// typecheck). This gate proves exactly one thing: the `--if-present` skip
// cannot silently swallow a TS-bearing workspace.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

function repoRoot(): string {
  return resolve(import.meta.dirname, '../../../../..');
}

/** Named deny-by-default exemptions. The `why` is load-bearing prose — it
 *  must say what blocks coverage, not that it is blocked. EMPTY since #1604
 *  paid the last entry (dsp, then art): every TS-bearing workspace defines
 *  `typecheck`. The type and the anchoring test below stay — the next entry
 *  must arrive with a why, and a stale one still reddens. */
const EXEMPT: ReadonlyArray<{ workspace: string; why: string }> = [];

interface PkgJson {
  workspaces?: string[];
  scripts?: Record<string, string>;
}

function readPkg(dir: string): PkgJson {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PkgJson;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.svelte-kit', 'test-results']);

/** Artifact-derived: does the workspace contain any TypeScript source? */
function hasTypeScript(dir: string): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      if (hasTypeScript(join(dir, entry.name))) return true;
    } else if (/\.tsx?$/.test(entry.name)) {
      return true;
    }
  }
  return false;
}

/** THE predicate the gate rests on — also negative/positive-controlled below. */
function definesTypecheck(pkg: PkgJson): boolean {
  return typeof pkg.scripts?.typecheck === 'string' && pkg.scripts.typecheck.trim().length > 0;
}

describe('workspace typecheck coverage (#1499)', () => {
  const root = repoRoot();
  const rootPkg = readPkg(root);
  const workspaces = rootPkg.workspaces ?? [];

  it('root package.json declares workspaces (the roster this gate derives from)', () => {
    expect(workspaces.length, 'root package.json `workspaces` is empty — the guard has no subject').toBeGreaterThan(0);
  });

  it('every TS-bearing workspace defines a typecheck script, or carries a NAMED exemption', () => {
    const exemptNames = new Set(EXEMPT.map((e) => e.workspace));
    const offenders: string[] = [];
    for (const ws of workspaces) {
      const dir = join(root, ws);
      expect(existsSync(join(dir, 'package.json')), `workspace '${ws}' is declared but has no package.json`).toBe(true);
      if (!hasTypeScript(dir)) continue;
      if (definesTypecheck(readPkg(dir))) continue;
      if (exemptNames.has(ws)) continue;
      offenders.push(ws);
    }
    expect(
      offenders,
      `these TS-bearing workspaces define NO typecheck script and have NO named exemption — ` +
        `npm run typecheck --workspaces --if-present silently skips them (the #1499 hole): ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('every exemption is anchored: names a live, TS-bearing, still-uncovered workspace', () => {
    for (const ex of EXEMPT) {
      expect(
        workspaces.includes(ex.workspace),
        `exemption '${ex.workspace}' names a workspace that is not in root package.json — delete the entry`,
      ).toBe(true);
      const dir = join(root, ex.workspace);
      expect(
        hasTypeScript(dir),
        `exemption '${ex.workspace}' names a workspace with no TypeScript — the exemption is dead, delete it`,
      ).toBe(true);
      expect(
        definesTypecheck(readPkg(dir)),
        `exemption '${ex.workspace}' names a workspace that NOW DEFINES typecheck — the debt is paid, delete the entry`,
      ).toBe(false);
      expect(
        ex.why.length,
        `exemption '${ex.workspace}' needs a real why (what blocks coverage), not a placeholder`,
      ).toBeGreaterThan(40);
    }
  });

  it('the e2e workspace is covered for real: script present AND tsconfig present', () => {
    // The headline of #1499 — asserted directly so a revert of either half
    // (script or tsconfig) reddens with a message naming the issue.
    const e2eDir = join(root, 'e2e');
    expect(definesTypecheck(readPkg(e2eDir)), 'e2e/package.json lost its typecheck script (#1499)').toBe(true);
    expect(existsSync(join(e2eDir, 'tsconfig.json')), 'e2e/tsconfig.json is gone (#1499)').toBe(true);
  });

  it('permanent controls: the predicate the gate calls can move in both directions', () => {
    // Negative control: a script-less package must read as uncovered.
    expect(definesTypecheck({})).toBe(false);
    expect(definesTypecheck({ scripts: {} })).toBe(false);
    expect(definesTypecheck({ scripts: { typecheck: '  ' } })).toBe(false);
    // Positive control: a defined script must read as covered.
    expect(definesTypecheck({ scripts: { typecheck: 'tsc -p tsconfig.json --noEmit' } })).toBe(true);
  });
});
