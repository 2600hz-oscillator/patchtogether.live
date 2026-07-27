// scripts/docs-only-gate.test.ts
//
// Gate for the DOCS-ONLY BYPASS (.github/workflows/docs-only-gate.yml +
// scripts/docs-only-gate.mjs). Pure-unit, zero-flake, runs in the `unit` lane
// via `task test` → `task test:scripts`.
//
// The bypass posts the two REQUIRED status contexts for a prose-only PR so it
// isn't blocked forever by a path-skipped ci.yml (the #1184 deadlock). That is
// only safe while three things hold, so all three are asserted here and the
// build goes red the moment any of them drifts:
//
//   1. COMPLEMENT — the bypass's `paths:` list is byte-identical to ci.yml's
//      `paths-ignore:` list on BOTH triggers. Path filters are per-file
//      ANY-match, so with the same list P exactly one workflow fires for a
//      homogeneous changeset, and BOTH fire for a mixed one. Drift here would
//      open a window where NEITHER fires (deadlock returns) or where the bypass
//      fires for a file class the real CI also skips silently.
//
//   2. CONTEXT IDENTITY — the strings the bypass posts are byte-identical to
//      the `name:` of ci.yml's `ci` and `vrt-strict` jobs (which is what ruleset
//      16042163 requires; GitHub matches contexts literally, em-dash included).
//      A rename on one side only would either re-deadlock docs PRs or leave a
//      stale context lying around.
//
//   3. NEGATIVE CONTROL — a changeset containing ANY real source file, or any
//      SHA for which GitHub started a real ci.yml run, can NEVER be bypassed.
//      This is the "prove it cannot green-light a code change" requirement, and
//      it is proven at the decision function rather than by CI experiment.

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as gate from './docs-only-gate.mjs';

const {
  DOCS_PATTERNS,
  REQUIRED_CONTEXTS,
  matchesGlob,
  isDocsOnly,
  nonDocFiles,
  decideBypass,
  inputFromEnv,
} = gate as unknown as {
  DOCS_PATTERNS: string[];
  REQUIRED_CONTEXTS: string[];
  matchesGlob: (file: string, pattern: string) => boolean;
  isDocsOnly: (files: string[], patterns?: string[]) => boolean;
  nonDocFiles: (files: string[], patterns?: string[]) => string[];
  decideBypass: (i: {
    changedFiles: string[];
    ciRunExists: boolean;
    sameRepo: boolean;
  }) => { post: boolean; reason: string };
  inputFromEnv: (env: Record<string, string | undefined>) => {
    changedFiles: string[];
    ciRunExists: boolean;
    sameRepo: boolean;
  };
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CI_YML = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
const BYPASS_YML = readFileSync(join(ROOT, '.github/workflows/docs-only-gate.yml'), 'utf8');

/** Every single-quoted YAML list that immediately follows a `<key>:` line. */
function listsAfterKey(src: string, key: string): string[][] {
  const lines = src.split('\n');
  const found: string[][] = [];
  const header = new RegExp(`^\\s*${key}:\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    if (!header.test(lines[i])) continue;
    const items: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const m = lines[j].match(/^\s*-\s*'([^']*)'\s*$/);
      if (!m) break;
      items.push(m[1]);
    }
    found.push(items);
  }
  return found;
}

/** The `name:` of a top-level job, read out of the raw workflow text. */
function jobName(src: string, jobId: string): string | undefined {
  const lines = src.split('\n');
  const start = lines.indexOf(`  ${jobId}:`);
  if (start < 0) return undefined;
  for (let j = start + 1; j < lines.length; j++) {
    if (/^ {2}\S/.test(lines[j])) break; // next top-level job
    const m = lines[j].match(/^ {4}name:\s*(.+?)\s*$/);
    if (m) return m[1];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 1. COMPLEMENT — the two workflows must filter on the SAME path list.
// ---------------------------------------------------------------------------

describe('docs-only bypass: the path filters are exact complements', () => {
  it('ci.yml declares paths-ignore on BOTH triggers, identical to DOCS_PATTERNS', () => {
    const ignores = listsAfterKey(CI_YML, 'paths-ignore');
    // push + pull_request
    expect(ignores).toHaveLength(2);
    for (const list of ignores) {
      expect(list).toEqual(DOCS_PATTERNS);
    }
  });

  it('docs-only-gate.yml filters on the SAME list via `paths:` (the inverse filter)', () => {
    const paths = listsAfterKey(BYPASS_YML, 'paths');
    expect(paths).toHaveLength(1);
    expect(paths[0]).toEqual(DOCS_PATTERNS);
  });

  it('the bypass workflow never uses paths-ignore (that would break the complement)', () => {
    expect(BYPASS_YML).not.toMatch(/^\s*paths-ignore:/m);
  });

  it('ci.yml is NOT modified to always-run — the wall-time optimisation is intact', () => {
    // If someone "fixes" the deadlock by deleting paths-ignore instead, this
    // bypass becomes dead weight that must be deleted with it.
    expect(CI_YML).toMatch(/paths-ignore:/);
  });
});

// ---------------------------------------------------------------------------
// 2. CONTEXT IDENTITY — what we post === what the ruleset requires.
// ---------------------------------------------------------------------------

describe('docs-only bypass: the posted contexts match the required checks', () => {
  it('posts exactly the two contexts ruleset 16042163 requires', () => {
    expect(REQUIRED_CONTEXTS).toHaveLength(2);
  });

  it('context 1 is byte-identical to the ci.yml `ci` umbrella job name', () => {
    expect(jobName(CI_YML, 'ci')).toBe(REQUIRED_CONTEXTS[0]);
    expect(REQUIRED_CONTEXTS[0]).toBe('typecheck + unit + ART + E2E');
  });

  it('context 2 is byte-identical to the ci.yml `vrt-strict` job name (em-dash included)', () => {
    expect(jobName(CI_YML, 'vrt-strict')).toBe(REQUIRED_CONTEXTS[1]);
    // U+2014 EM DASH — the ruleset stores it literally; an en-dash would make
    // the posted context a different check and re-deadlock every docs PR.
    expect(REQUIRED_CONTEXTS[1]).toContain('—');
    expect(REQUIRED_CONTEXTS[1]).toBe('vrt-strict (visual regression — strict subset)');
  });

  it('the bypass workflow declares no JOB named after a required context', () => {
    // A job named after a required context creates a check run the moment it
    // starts and cannot withdraw it — and a job-level `if:` skip reports as
    // SUCCESS to branch protection, which would satisfy the gate on exactly the
    // mixed docs+code PRs where it must not. Contexts must only ever come from
    // the explicitly guarded statuses API call.
    for (const ctx of REQUIRED_CONTEXTS) {
      expect(BYPASS_YML).not.toContain(`name: ${ctx}`);
    }
  });

  it('the bypass never impersonates the CI workflow itself', () => {
    // daily-prod-deploy.yml's find-green scan looks up
    // actions/workflows/ci.yml/runs?head_sha=… — a docs-only commit must stay
    // invisible to it, so this must never become a second `name: CI` workflow.
    expect(BYPASS_YML).not.toMatch(/^name:\s*CI\s*$/m);
    expect(BYPASS_YML).toMatch(/^name:\s*Docs-only gate\s*$/m);
  });

  it('the status-posting step is guarded on the decision output', () => {
    expect(BYPASS_YML).toMatch(/if:\s*steps\.decide\.outputs\.post == 'true'/);
    // ...and the statuses permission exists, or the post would 403.
    expect(BYPASS_YML).toMatch(/statuses:\s*write/);
  });

  it('the posting step takes its contexts from the decide step, not a dynamic import', () => {
    // github-script evaluates `script:` inside a `new AsyncFunction(...)` body,
    // where dynamic `import()` has no reliable module referrer. The contexts
    // therefore travel as a step output — docs-only-gate.mjs stays the single
    // source of truth (pinned to ci.yml's job names by the tests above) without
    // that fragile ESM-in-vm dependency.
    expect(BYPASS_YML).toMatch(/CONTEXTS: \$\{\{ steps\.decide\.outputs\.contexts \}\}/);
    expect(BYPASS_YML).toContain('JSON.parse(process.env.CONTEXTS)');
    expect(BYPASS_YML).not.toMatch(/await import\(/);
  });
});

// ---------------------------------------------------------------------------
// The CLI seam the workflow actually invokes — run it for real.
// ---------------------------------------------------------------------------

describe('docs-only bypass: the `decide` CLI writes the outputs the workflow reads', () => {
  function runDecide(env: Record<string, string>) {
    const out = join(mkdtempSync(join(tmpdir(), 'docs-only-gate-')), 'GITHUB_OUTPUT');
    writeFileSync(out, '');
    execFileSync(process.execPath, [join(ROOT, 'scripts/docs-only-gate.mjs'), 'decide'], {
      env: { ...process.env, ...env, GITHUB_OUTPUT: out },
      encoding: 'utf8',
    });
    return Object.fromEntries(
      readFileSync(out, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
  }

  it('docs-only → post=true and contexts parse back to REQUIRED_CONTEXTS', () => {
    const o = runDecide({
      CHANGED_FILES: '.myrobots/26-07-22-roundup.md',
      CI_RUN_EXISTS: 'false',
      SAME_REPO: 'true',
    });
    expect(o.post).toBe('true');
    // The exact round-trip the workflow performs: JSON.parse(process.env.CONTEXTS).
    expect(JSON.parse(o.contexts)).toEqual(REQUIRED_CONTEXTS);
  });

  it('a code file → post=false (the workflow step never fires)', () => {
    const o = runDecide({
      CHANGED_FILES: '.myrobots/a.md\npackages/dsp/src/cube.ts',
      CI_RUN_EXISTS: 'false',
      SAME_REPO: 'true',
    });
    expect(o.post).toBe('false');
    expect(o.reason).toContain('G1 FAILED');
  });

  it('a real CI run → post=false', () => {
    const o = runDecide({
      CHANGED_FILES: '.myrobots/a.md',
      CI_RUN_EXISTS: 'true',
      SAME_REPO: 'true',
    });
    expect(o.post).toBe('false');
    expect(o.reason).toContain('G2 FAILED');
  });
});

// ---------------------------------------------------------------------------
// 3. NEGATIVE CONTROL — a code change can never be bypassed.
// ---------------------------------------------------------------------------

const CODE_FILES = [
  'packages/web/src/lib/audio/modules/adsr.ts',
  'packages/dsp/src/cube.ts',
  'packages/server/src/relay.ts',
  'e2e/tests/ai-smoke.spec.ts',
  'e2e/vrt/vrt-exemptions.ts',
  '.github/workflows/ci.yml',
  '.github/workflows/docs-only-gate.yml',
  'scripts/docs-only-gate.mjs',
  'package.json',
  'package-lock.json',
  'Taskfile.yml',
  '.gitignore',
  'packages/web/src/lib/docs/contract-lock.txt',
  'db/schema/001_init.sql',
  'e2e/vrt/__screenshots__/darwin/adsr.png',
  'art/baselines/moog911.f32',
  'CLAUDE.md.ts', // adversarial: .md is a substring, not the extension
  'docs.md/thing.ts', // adversarial: .md as a directory name
];

const DOC_FILES = [
  '.myrobots/26-07-22-roundup.md',
  '.myrobots/plans/dx7-and-polyphony.md',
  '.myrobots/previews/cellshade/input-wheel.png', // any file under .myrobots/**
  '.myrobots/FABLE_PERF_PLAN',
  'README.md',
  'CLAUDE.md',
  'docs/testing/README.md',
  'packages/web/README.md',
  'LICENSE',
];

describe('docs-only bypass: negative control — code changes are never bypassed', () => {
  it.each(CODE_FILES)('a PR touching %s is NOT docs-only', (file) => {
    expect(isDocsOnly([file])).toBe(false);
    expect(decideBypass({ changedFiles: [file], ciRunExists: false, sameRepo: true }).post).toBe(
      false,
    );
  });

  it.each(DOC_FILES)('a PR touching only %s IS docs-only', (file) => {
    expect(isDocsOnly([file])).toBe(true);
  });

  it('BOTH-TOUCHED: docs + one source file → no bypass, even before CI reports', () => {
    const mixed = [...DOC_FILES, 'packages/web/src/lib/audio/modules/adsr.ts'];
    // G1 alone stops it: the bypass workflow DOES fire on a mixed PR (path
    // filters are ANY-match), so this is the case that must not leak.
    const d = decideBypass({ changedFiles: mixed, ciRunExists: false, sameRepo: true });
    expect(d.post).toBe(false);
    expect(d.reason).toMatch(/G1 FAILED/);
    expect(nonDocFiles(mixed)).toEqual(['packages/web/src/lib/audio/modules/adsr.ts']);
  });

  it('BOTH-TOUCHED: G2 alone also stops it, independently of G1', () => {
    // Belt-and-braces: even if the matcher were wrong and G1 waved a mixed
    // changeset through, the presence of a real ci.yml run for the SHA blocks
    // the post. Both guards must pass; either one suffices to refuse.
    const d = decideBypass({
      changedFiles: ['.myrobots/plan.md'],
      ciRunExists: true,
      sameRepo: true,
    });
    expect(d.post).toBe(false);
    expect(d.reason).toMatch(/G2 FAILED/);
  });

  it('an empty / unresolvable file list is never bypassed', () => {
    expect(decideBypass({ changedFiles: [], ciRunExists: false, sameRepo: true }).post).toBe(false);
    expect(
      decideBypass({
        changedFiles: undefined as unknown as string[],
        ciRunExists: false,
        sameRepo: true,
      }).post,
    ).toBe(false);
  });

  it('a fork PR is never bypassed (its GITHUB_TOKEN cannot write statuses anyway)', () => {
    const d = decideBypass({
      changedFiles: ['.myrobots/plan.md'],
      ciRunExists: false,
      sameRepo: false,
    });
    expect(d.post).toBe(false);
    expect(d.reason).toMatch(/fork/);
  });

  it('the only path to post=true is docs-only AND no CI run AND same-repo', () => {
    for (const sameRepo of [true, false]) {
      for (const ciRunExists of [true, false]) {
        for (const files of [
          ['.myrobots/a.md'],
          ['.myrobots/a.md', 'packages/dsp/src/cube.ts'],
          [],
        ]) {
          const { post } = decideBypass({ changedFiles: files, ciRunExists, sameRepo });
          expect(post).toBe(sameRepo && !ciRunExists && isDocsOnly(files));
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Real historical changesets — the two PRs that motivated this.
// ---------------------------------------------------------------------------

describe('docs-only bypass: the live cases', () => {
  it('#1184 (only .myrobots/26-07-22-roundup.md) → bypass applies', () => {
    const d = decideBypass({
      changedFiles: ['.myrobots/26-07-22-roundup.md'],
      ciRunExists: false,
      sameRepo: true,
    });
    expect(d.post).toBe(true);
  });

  it('#1175 (the .myrobots corpus + .gitignore) → NO bypass, exactly as it behaved', () => {
    // #1175 merged fine precisely because .gitignore is not in paths-ignore, so
    // the real CI ran. The bypass must reproduce that: G1 rejects on .gitignore
    // and G2 rejects on the run GitHub actually started.
    const files = [
      '.gitignore',
      '.myrobots/26-07-22-roundup.md',
      '.myrobots/plans/mobile-view-2026-07-02.md',
      '.myrobots/previews/cellshade-rebuild-2026-07-11/input-wheel.png',
    ];
    expect(decideBypass({ changedFiles: files, ciRunExists: false, sameRepo: true }).post).toBe(
      false,
    );
    expect(decideBypass({ changedFiles: files, ciRunExists: true, sameRepo: true }).post).toBe(
      false,
    );
  });

  it('THIS PR (touches .github/** and scripts/**) → NO bypass, full suite runs', () => {
    const files = [
      '.github/workflows/docs-only-gate.yml',
      'scripts/docs-only-gate.mjs',
      'scripts/docs-only-gate.test.ts',
    ];
    expect(isDocsOnly(files)).toBe(false);
    expect(decideBypass({ changedFiles: files, ciRunExists: false, sameRepo: true }).post).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// The glob matcher + the env plumbing.
// ---------------------------------------------------------------------------

describe('docs-only bypass: glob semantics', () => {
  it('`**/*.md` matches nested AND root markdown', () => {
    expect(matchesGlob('README.md', '**/*.md')).toBe(true);
    expect(matchesGlob('docs/testing/README.md', '**/*.md')).toBe(true);
    expect(matchesGlob('a/b/c/d.md', '**/*.md')).toBe(true);
  });

  it('`**/*.md` does not match a non-markdown file', () => {
    expect(matchesGlob('src/a.mdx', '**/*.md')).toBe(false);
    expect(matchesGlob('src/md', '**/*.md')).toBe(false);
    expect(matchesGlob('CLAUDE.md.ts', '**/*.md')).toBe(false);
  });

  it('`*` does not cross a path separator', () => {
    expect(matchesGlob('a/b.md', '*.md')).toBe(false);
    expect(matchesGlob('b.md', '*.md')).toBe(true);
  });

  it('`.myrobots/**` matches everything under the dir and nothing outside it', () => {
    expect(matchesGlob('.myrobots/a.md', '.myrobots/**')).toBe(true);
    expect(matchesGlob('.myrobots/plans/deep/a.png', '.myrobots/**')).toBe(true);
    expect(matchesGlob('myrobots/a.md', '.myrobots/**')).toBe(false);
    expect(matchesGlob('x/.myrobots/a.md', '.myrobots/**')).toBe(false);
  });

  it('`LICENSE` is exact, not a prefix', () => {
    expect(matchesGlob('LICENSE', 'LICENSE')).toBe(true);
    expect(matchesGlob('LICENSES/mit.txt', 'LICENSE')).toBe(false);
    expect(matchesGlob('packages/web/LICENSE', 'LICENSE')).toBe(false);
  });
});

describe('docs-only bypass: env plumbing', () => {
  it('parses the workflow env into the decision input', () => {
    expect(
      inputFromEnv({
        CHANGED_FILES: '.myrobots/a.md\n\n  .myrobots/b.md  \n',
        CI_RUN_EXISTS: 'false',
        SAME_REPO: 'true',
      }),
    ).toEqual({
      changedFiles: ['.myrobots/a.md', '.myrobots/b.md'],
      ciRunExists: false,
      sameRepo: true,
    });
  });

  it('treats any non-"true" CI_RUN_EXISTS as absent but a literal "false" SAME_REPO as a fork', () => {
    expect(inputFromEnv({ CI_RUN_EXISTS: 'unknown' }).ciRunExists).toBe(false);
    expect(inputFromEnv({ CI_RUN_EXISTS: 'true' }).ciRunExists).toBe(true);
    expect(inputFromEnv({ SAME_REPO: 'false' }).sameRepo).toBe(false);
    expect(inputFromEnv({}).sameRepo).toBe(true);
  });
});
