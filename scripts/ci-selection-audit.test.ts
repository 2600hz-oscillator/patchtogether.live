// scripts/ci-selection-audit.test.ts
//
// Every e2e spec must actually EXECUTE in some CI lane.
//
// Measured 2026-08-12 (#1501): three specs — audio-gate, rack-restoring-status,
// unsaved-guard — ran in NO lane at all, and had not for as long as they existed.
// Two independent conditions have to line up for that, which is why nothing
// noticed:
//
//   SELECTION   the shard lane's `--grep-invert "@collab|@capacity|…"` SELECTED
//               them (their tags were @audio-gate / @rack-status / @unsaved-guard,
//               none of which match), while the collab lane's `--grep
//               "@collab|@capacity"` did NOT — so the only lane that took them was
//               the one that could not run them.
//   REACHABILITY each carried `test.skip(!!process.env.CI && !process.env.COLLAB_JOB)`,
//               so in the lane that DID select them they skipped on every run.
//
// Selected-but-always-skipped reports exactly like a passing suite. A guard that
// only checked selection would have called those three covered.
//
// So this asserts BOTH, and it uses Playwright's OWN discovery to do it — one
// `--list` per lane with that lane's real flags — rather than re-implementing
// grep semantics. Re-implementing the filter is how a selection audit ends up
// agreeing with itself instead of with CI.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..');
const E2E_DIR = join(REPO_ROOT, 'e2e');
const CI_YML = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

/**
 * The general-coverage lanes, as CI actually invokes them.
 *
 * `flags` are passed to Playwright verbatim; `env` is what that job exports, and
 * is what decides whether an env-guarded spec can run there. Asserted against
 * ci.yml below so this cannot drift into describing a CI that no longer exists.
 */
const LANES = [
  {
    name: 'e2e shard matrix',
    flags: ['--grep-invert', '@collab|@capacity|BEHAVIORAL input coverage'],
    env: { CI: '1' },
  },
  {
    name: 'collab (@collab multi-context)',
    flags: ['--grep', '@collab|@capacity'],
    env: { CI: '1', COLLAB_JOB: '1' },
  },
] as const;

/** Specs run by name in a dedicated lane rather than by grep. */
const EXPLICIT_FILE_LANES = ['per-module-per-port-behavioral.spec.ts', '-render-smoke.spec.ts'];

function listSpecs(flags: readonly string[] = []): Set<string> {
  const out = execFileSync(
    'npx',
    ['--workspace', 'e2e', 'playwright', 'test', '--list', '--reporter=json', ...flags],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const report = JSON.parse(out);
  const files = new Set<string>();
  const walk = (suites: Array<Record<string, unknown>> = []) => {
    for (const s of suites) {
      if (typeof s.file === 'string') files.add(s.file);
      walk((s.suites as Array<Record<string, unknown>>) ?? []);
    }
  };
  walk(report.suites ?? []);
  return files;
}

/**
 * File-level `test.skip(<cond>)` guards that reference process.env, i.e. guards
 * evaluated once per FILE — the shape that silently disables a whole spec in a
 * lane. In-test guards are a different thing (per-case capability probes) and
 * are out of scope here.
 */
function envGuardVars(specPath: string): string[] {
  const text = readFileSync(join(E2E_DIR, 'tests', specPath), 'utf8');
  const vars: string[] = [];
  // Only top-level calls: an indented one is inside a describe/test body.
  for (const [, cond] of text.matchAll(/^test\.skip\(\s*([\s\S]*?)\);/gm)) {
    for (const [, name] of cond.matchAll(/!process\.env\.([A-Z_][A-Z0-9_]*)/g)) vars.push(name);
  }
  return [...new Set(vars)];
}

describe('every e2e spec executes in some CI lane', () => {
  const allSpecs = listSpecs();

  it('discovers the spec corpus (guard is not vacuous)', () => {
    // Anchored to a NAME the corpus must contain, never to a count.
    expect(allSpecs.size).toBeGreaterThan(0);
    expect([...allSpecs].some((f) => f.includes('awareness.spec.ts'))).toBe(true);
  });

  it('the modelled lanes match what ci.yml actually runs', () => {
    const yml = readFileSync(CI_YML, 'utf8');
    // If a lane's flags change in CI and not here, this guard would be auditing a
    // fiction — the same drift class the docs-only-gate path-list test exists for.
    for (const lane of LANES) {
      const pattern = lane.flags[1];
      expect(yml, `ci.yml no longer contains lane '${lane.name}' flags`).toContain(pattern);
    }
  });

  it('no spec is selected by ZERO lanes', () => {
    const selected = new Set<string>();
    for (const lane of LANES) for (const f of listSpecs(lane.flags)) selected.add(f);

    const orphans = [...allSpecs]
      .filter((f) => !selected.has(f))
      .filter((f) => !EXPLICIT_FILE_LANES.some((n) => f.includes(n)));

    expect(
      orphans.sort(),
      'these specs match no lane grep — they exist but CI never runs them',
    ).toEqual([]);
  });

  it('no spec is selected only by lanes whose env guarantees it skips', () => {
    // The second half of the 2026-08-12 bug: selection is necessary, not sufficient.
    const unreachable: string[] = [];

    for (const spec of allSpecs) {
      if (EXPLICIT_FILE_LANES.some((n) => spec.includes(n))) continue;
      const required = envGuardVars(spec);
      if (required.length === 0) continue;

      const runnableSomewhere = LANES.some((lane) => {
        const selectedHere = listSpecs(lane.flags).has(spec);
        const envSatisfied = required.every((v) => (lane.env as Record<string, string>)[v]);
        return selectedHere && envSatisfied;
      });
      if (!runnableSomewhere) unreachable.push(`${spec} (needs ${required.join(', ')})`);
    }

    expect(
      unreachable.sort(),
      'selected by a lane, but that lane never sets the env it requires — it skips on every run',
    ).toEqual([]);
  });
});
