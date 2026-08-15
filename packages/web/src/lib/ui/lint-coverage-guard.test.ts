// packages/web/src/lib/ui/lint-coverage-guard.test.ts
//
// THE LINT GATE READS EVERY TS-BEARING WORKSPACE — and the `--if-present`
// hole cannot reopen on `lint` (#1504, sibling of the typecheck guard #1499).
//
// ─────────────────────────────────────────────────────────────────────────
// THE BUG THIS EXISTS FOR
//
// Root package.json used to run `npm run lint --workspaces --if-present`.
// Not one workspace defined a `lint` script and no ESLint config existed
// anywhere in the tree, so the command printed nothing and exited 0. It was a
// total no-op, and there was no `lint` job in ci.yml either. Every green
// "lint" in this repo's history was a statement about a command that ran zero
// linters — the same `--if-present` hole that hid ~509 unchecked Playwright
// specs in #1499, on the other required script.
//
// The fix moved lint to a SINGLE ROOT CONFIG rather than per-workspace
// scripts, so the #1499 guard's shape ("every workspace defines the script")
// is the wrong question here. The right question is the one that hole was
// really about: IS ANY WORKSPACE SILENTLY UNREAD? That is what this asserts,
// against ESLint's own ignore resolution rather than a re-implementation of
// its glob semantics.
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT IT CHECKS (and what it structurally cannot see)
//
//   1. The workspace roster is DERIVED from root package.json — a new
//      workspace enrols itself the moment it is declared.
//   2. "TS-bearing" is DERIVED from the artifact: the workspace contains a
//      real .ts file. Nothing is declared by hand.
//   3. For each such workspace, a REAL file from it is put to
//      `ESLint.isPathIgnored`, so the answer comes from the same resolution
//      the gate itself uses. A workspace that ESLint ignores in full is a
//      silently unread workspace, which is exactly the #1499 failure.
//   4. The root `lint` script may not reintroduce `--workspaces --if-present`.
//
// ⚠ SCOPE — what a green run here does NOT prove: that the rules are strict,
// that findings block (scripts/lint/lint-policy.mjs decides that, and
// scripts/lint/eslint-gate.mjs enforces it), or that any individual file
// inside a workspace is linted — only that the workspace as a whole is not
// invisible. It also says nothing about the shell lane.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ESLint } from 'eslint';

function repoRoot(): string {
  return resolve(import.meta.dirname, '../../../../..');
}

interface PkgJson {
  workspaces?: string[];
  scripts?: Record<string, string>;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.svelte-kit', 'test-results']);

/** Artifact-derived: the first real .ts file in the workspace, or null. */
function sampleTypeScriptFile(dir: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const found = sampleTypeScriptFile(join(dir, entry.name));
      if (found) return found;
    } else if (/\.ts$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      return join(dir, entry.name);
    }
  }
  return null;
}

/** THE predicate the gate rests on — controlled in both directions below. */
function fansOutWithIfPresent(script: string | undefined): boolean {
  return typeof script === 'string' && script.includes('--if-present');
}

describe('lint coverage (#1504)', () => {
  const root = repoRoot();
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PkgJson;
  const workspaces = rootPkg.workspaces ?? [];

  it('root package.json declares workspaces (the roster this gate derives from)', () => {
    expect(
      workspaces.length,
      'root package.json `workspaces` is empty — the guard has no subject',
    ).toBeGreaterThan(0);
  });

  it('the root lint script does not fan out with --if-present', () => {
    expect(
      fansOutWithIfPresent(rootPkg.scripts?.lint),
      'root `lint` uses `--if-present` again. That is the #1504 no-op verbatim: a workspace ' +
        'without the script is skipped silently, and when NO workspace has it the whole gate ' +
        'passes having run nothing. Point `lint` at the gate scripts directly.',
    ).toBe(false);
  });

  it('the root lint script actually invokes both gates', () => {
    const lint = rootPkg.scripts?.lint ?? '';
    expect(lint, 'root `lint` script is missing').not.toBe('');
    // Resolved through the sub-scripts so a rename of either half reddens here
    // rather than silently halving the gate.
    const resolved = lint.replace(/npm run (lint:[a-z]+)/g, (_m, name: string) => rootPkg.scripts?.[name] ?? '');
    expect(resolved, 'root `lint` no longer reaches the ESLint gate').toContain('eslint-gate.mjs');
    expect(resolved, 'root `lint` no longer reaches the ShellCheck gate').toContain('shellcheck-gate.mjs');
  });

  it('ESLint reads every TS-bearing workspace — none is silently ignored', async () => {
    const eslint = new ESLint({ cwd: root });
    const unread: string[] = [];
    for (const ws of workspaces) {
      const sample = sampleTypeScriptFile(join(root, ws));
      if (!sample) continue; // not TS-bearing; nothing for ESLint to read
      if (await eslint.isPathIgnored(sample)) unread.push(`${ws} (sampled ${sample.replace(`${root}/`, '')})`);
    }
    expect(
      unread,
      'these workspaces contain TypeScript that ESLint ignores in full — the lint gate is blind ' +
        `to them exactly as \`--if-present\` was: ${unread.join(', ')}`,
    ).toEqual([]);
  });

  it('permanent controls: the ignore resolution and the predicate both move in both directions', async () => {
    const eslint = new ESLint({ cwd: root });

    // Negative control on the INSTRUMENT: a path that must be ignored. If this
    // reads as "not ignored", `isPathIgnored` is answering a different question
    // than the assertion above thinks, and that assertion is vacuous.
    expect(
      await eslint.isPathIgnored(join(root, 'node_modules/some-dep/index.ts')),
      'ESLint claims it would lint node_modules — the ignore resolution this gate reads is not working',
    ).toBe(true);

    // Positive control: a path that must NOT be ignored. Without this, an
    // ESLint that ignored EVERYTHING would satisfy the negative control and
    // make the workspace sweep above pass trivially.
    expect(
      await eslint.isPathIgnored(join(root, 'packages/web/src/lib/ui/lint-coverage-guard.test.ts')),
      'ESLint claims it would skip this very file — the sweep above would then prove nothing',
    ).toBe(false);

    expect(fansOutWithIfPresent('npm run lint --workspaces --if-present')).toBe(true);
    expect(fansOutWithIfPresent('node scripts/lint/eslint-gate.mjs')).toBe(false);
    expect(fansOutWithIfPresent(undefined)).toBe(false);
  });
});
