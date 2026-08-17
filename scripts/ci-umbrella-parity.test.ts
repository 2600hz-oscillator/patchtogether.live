// scripts/ci-umbrella-parity.test.ts
//
// THE UMBRELLA'S `needs:` AND ITS FAILING `if` MUST NAME THE SAME JOBS (#1505).
//
// The `ci` job is what branch protection requires. It is `if: always()`, so it
// runs even when a dependency fails and decides purely from its aggregate
// `env:` + the failing `if [[ ]]` test. That makes two divergences possible,
// and BOTH are invisible by inspection in a 3000-line workflow:
//
//   · in `needs:` but NOT in the `if` — the umbrella WAITS on a job whose
//     result it never reads. Pure merge latency asserting nothing. This is the
//     state that shipped (and that ended in both jobs being deleted on
//     2026-08-17): collab-attest and grand-attest sat in `needs:` on
//     every PR while the failing test named neither.
//   · in the `if` but NOT in `needs:` — worse and silent: `needs.<job>.result`
//     for an undeclared job expands to the EMPTY STRING, so `"" != "success"`
//     is TRUE and the umbrella fails permanently... or, if the var is simply
//     absent from `env:`, the clause reads an unset variable and the gate is
//     dead. Either way the check no longer means what it says.
//
// So this parses the workflow itself and asserts the two lists are IDENTICAL.
// Derived from the artifact in both directions — there is no hand-typed list of
// job names here to drift (the repo's population-count rule).
//
// ── WHAT THIS CANNOT SEE ────────────────────────────────────────────────────
//   · Whether a gating job's own steps actually assert anything (a job can be
//     green and vacuous — that is each lane's own negative-control problem).
//   · Whether branch protection actually REQUIRES the umbrella's context. That
//     lives in a GitHub ruleset, not in this file.
//   · Other jobs' `needs:`. Only the umbrella is checked — another job may
//     legitimately depend on a lane in order to look PAST its failure. (The
//     example this note used to give, `behavioral-watchdog` needing
//     `collab-attest`, is gone: both jobs were deleted 2026-08-17.)
//   · `if:` conditions on the dependency jobs themselves — a job that skips
//     reports `skipped`, which these clauses treat as failure, by design.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CI_YML = join(REPO_ROOT, '.github/workflows/ci.yml');

/** The `ci` job's block, from its key to the next top-level job key. */
function umbrellaBlock(src: string): string {
  const start = src.indexOf('\n  ci:\n');
  expect(start, 'the `ci` umbrella job must exist in ci.yml').toBeGreaterThan(-1);
  const rest = src.slice(start + 1);
  // Next line that starts a sibling job: two spaces, a name, a colon, EOL.
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Job ids in `needs: [...]`. */
function needsJobs(block: string): string[] {
  const m = /needs:\s*\[([^\]]+)\]/.exec(block);
  expect(m, 'the umbrella must declare `needs: [...]`').not.toBeNull();
  return m![1].split(',').map((s) => s.trim()).filter(Boolean);
}

/** Env var name → job id, read off the aggregate `env:` mapping, e.g.
 *  `WEBGL_ATTEST: ${{ needs.webgl-attest.result }}`. */
function envVarToJob(block: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^\s*([A-Z][A-Z0-9_]*):\s*\$\{\{\s*needs\.([a-z0-9-]+)\.result\s*\}\}/gm;
  for (const m of block.matchAll(re)) out.set(m[1], m[2]);
  return out;
}

/** Env vars tested by the failing `if [[ ... ]]` condition. */
function gatedVars(block: string): string[] {
  const start = block.indexOf('if [[ "$');
  expect(start, 'the umbrella must contain the failing `if [[ ]]` test').toBeGreaterThan(-1);
  const end = block.indexOf(']]; then', start);
  const cond = block.slice(start, end);
  return [...cond.matchAll(/"\$([A-Z][A-Z0-9_]*)"\s*!=\s*"success"/g)].map((m) => m[1]);
}

describe('the ci umbrella: `needs:` ≡ the failing `if` (#1505)', () => {
  const src = readFileSync(CI_YML, 'utf8');
  const block = umbrellaBlock(src);
  const needs = needsJobs(block);
  const envMap = envVarToJob(block);
  const gated = gatedVars(block);
  const gatedJobs = gated.map((v) => envMap.get(v) ?? `<no env mapping for $${v}>`);

  it('every job the umbrella WAITS on is a job it can FAIL on', () => {
    const waitedNotGated = needs.filter((j) => !gatedJobs.includes(j));
    expect(
      waitedNotGated,
      `these jobs are in the umbrella's \`needs:\` but their results are never tested by the ` +
        `failing \`if\`. The umbrella waits on them on every PR and asserts nothing about them — ` +
        `either add them to the aggregate env: + the failing if (arm them), or remove them from ` +
        `needs: (leave them informational, reporting their own check context). [#1505]`,
    ).toEqual([]);
  });

  it('every job the umbrella FAILS on is a job it declared as a dependency', () => {
    const gatedNotWaited = gatedJobs.filter((j) => !needs.includes(j));
    expect(
      gatedNotWaited,
      `these jobs are tested by the failing \`if\` but are NOT in \`needs:\`. ` +
        `\`needs.<job>.result\` for an undeclared dependency expands to the EMPTY STRING, so the ` +
        `clause is permanently true and the umbrella can never pass. [#1505]`,
    ).toEqual([]);
  });

  it('every gated env var actually maps to a job (no clause reading an unset variable)', () => {
    const unmapped = gated.filter((v) => !envMap.has(v));
    expect(
      unmapped,
      `these variables are tested by the failing \`if\` but are not defined in the aggregate ` +
        `env: block, so the test reads an unset variable — a dead clause that looks like a gate.`,
    ).toEqual([]);
  });

  // NEGATIVE CONTROLS — the three assertions above can only ever produce []
  // from a healthy file, so each is proven able to fire, on the SAME predicates,
  // against a perturbed copy of the real block.
  describe('the parity checks can actually fail', () => {
    it('detects a job added to needs: but not to the if', () => {
      const perturbed = block.replace(
        /needs:\s*\[([^\]]+)\]/,
        (_all, list: string) => `needs: [${list}, some-informational-job]`,
      );
      const waitedNotGated = needsJobs(perturbed).filter((j) => !gatedJobs.includes(j));
      expect(waitedNotGated).toEqual(['some-informational-job']);
    });

    it('detects a clause whose job was dropped from needs:', () => {
      const victim = needs.find((j) => gatedJobs.includes(j));
      expect(victim, 'fixture requires at least one gated job').toBeTruthy();
      const perturbed = block.replace(`, ${victim}`, '').replace(`[${victim}, `, '[');
      const gatedNotWaited = gatedJobs.filter((j) => !needsJobs(perturbed).includes(j));
      expect(gatedNotWaited).toEqual([victim]);
    });

    it('detects a gated variable with no env mapping', () => {
      const perturbed = block.replace('if [[ "$', 'if [[ "$NOT_MAPPED" != "success" \\\n             || "$');
      const unmapped = gatedVars(perturbed).filter((v) => !envMap.has(v));
      expect(unmapped).toEqual(['NOT_MAPPED']);
    });
  });

  // The parser is the other thing that can silently pass: if a regex stopped
  // matching, every list above would be empty and all three checks would go
  // green on any file at all.
  it('the parser found a non-trivial umbrella (vacuity guard)', () => {
    expect(needs.length, 'needs: parsed as empty — the parser broke, not the file').toBeGreaterThan(5);
    expect(gated.length, 'the failing if parsed as empty — the parser broke').toBeGreaterThan(5);
    expect(envMap.size, 'no env→job mappings parsed — the parser broke').toBeGreaterThan(5);
    // And the specific job this issue is about must still be gating.
    expect(gatedJobs, 'webgl-attest must remain a gating job').toContain('webgl-attest');
  });
});
