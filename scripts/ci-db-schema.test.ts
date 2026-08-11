// scripts/ci-db-schema.test.ts
//
// Gate for the CI DATABASE SCHEMA APPLY (scripts/apply-db-schema.sh + every
// workflow step that calls it). Pure-unit, zero-flake, runs in the `unit` lane
// via `task test` → `task test:scripts`. No database required.
//
// THE BUG THIS EXISTS TO PREVENT
// ------------------------------
// Fourteen workflow steps each hand-spelled their schema apply as
// `psql "$URL" -f db/schema/001_init.sql -f db/schema/005_rackspace_mode.sql`.
// Migrations 002/003/004 appeared in NO list, so every CI lane ran against a
// database missing three tables — and nothing went red, because all three
// consumers degrade silently by design:
//
//   * journal.ts catches 42P01, warns once, returns → the relay drops to
//     snapshot-only durability. The journal/replay feature (the whole point of
//     004) was therefore exercised by ZERO CI runs while @collab stayed green.
//   * dashboard/+page.server.ts catches, warns, returns [] → saved-groups
//     coverage was vacuous; the page renders an empty library either way.
//
// That is the repo's recurring blind-gate shape: a FILTER applied before the
// check (here, a hand-copied file list) quietly redefines the check's subject,
// and the green run looks identical to a real one.
//
// WHAT THIS GATE ASSERTS
// ----------------------
//  1. COMPLETENESS BY CONSTRUCTION — the applier reads the DIRECTORY, so it is
//     not possible to add a migration and forget a lane. Asserted against the
//     real db/schema/ contents, not a list mirrored here.
//  2. DENY BY DEFAULT — no workflow may hand-roll `psql -f db/schema/…` again.
//     A new bespoke apply step is red on arrival.
//  3. NON-VACUOUS DISCOVERY — the scan must FIND apply steps. A regex that
//     silently matched nothing would pass every other assertion here, which is
//     precisely the failure mode being guarded against.
//  4. EPHEMERAL TARGETS ONLY — 002_feedback.sql opens with
//     `DROP TABLE IF EXISTS feedback CASCADE`. Shipping it to all 14 sites is
//     safe ONLY because every one targets a throwaway localhost `*_test`
//     service container. Point one at a real host and this goes red.
//  5. NO CONDITIONALLY-SKIPPED APPLY — a lane that sets a DB url and then skips
//     its schema step is the flake-check-3x `if: inputs.suite != 'unit'` bug.
//  6. FAIL-LOUD — ON_ERROR_STOP=1, because plain `psql -f a -f b` exits 0 after
//     an error in `a` and leaves a half-applied schema behind a green step.
//
// NEGATIVE CONTROLS run the checkers against synthetic inputs that SHOULD fail,
// so a checker that silently stopped matching anything cannot pass this file.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_DIR = join(ROOT, '.github/workflows');
const APPLIER = 'scripts/apply-db-schema.sh';

// ---------------------------------------------------------------------------
// Helpers — deliberately operate on raw text so they cannot be fooled by a
// YAML library normalising away the thing under test (quoting, anchors, etc).
// ---------------------------------------------------------------------------

/** Every `<n>_<name>.sql` in db/schema/, in the order the applier's glob
 *  yields them. Ground truth: the ARTIFACT, never a list restated here. */
export function schemaFiles(root = ROOT): string[] {
  return readdirSync(join(root, 'db/schema'))
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/** Workflow files, as [name, source] pairs. */
export function workflows(dir = WORKFLOW_DIR): Array<[string, string]> {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort()
    .map((f) => [f, readFileSync(join(dir, f), 'utf8')] as [string, string]);
}

export interface ApplyStep {
  workflow: string;
  /** The `jobs:` key that owns the step — '' if the scan cannot place it. */
  job: string;
  line: number;
  /** The env var the URL is read from, e.g. `DATABASE_URL`. */
  urlVar: string;
}

/** The `jobs:` key owning each line, or '' outside the jobs block. A job key is
 *  the only 2-space top-level mapping key under `jobs:`. This is what makes the
 *  coverage assertion below per-JOB rather than per-WORKFLOW — see the comment
 *  there for the hole that distinction closes. */
function jobOwnerByLine(src: string): string[] {
  const out: string[] = [];
  let inJobs = false;
  let job = '';
  for (const line of src.split('\n')) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      out.push('');
      continue;
    }
    if (inJobs && /^[A-Za-z]/.test(line)) inJobs = false; // dedent to a new top-level key
    if (inJobs) {
      const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
      if (m) job = m[1];
    }
    out.push(inJobs ? job : '');
  }
  return out;
}

/** Every call to the shared applier, across all workflows. */
export function applySteps(wfs = workflows()): ApplyStep[] {
  const found: ApplyStep[] = [];
  for (const [name, src] of wfs) {
    const owner = jobOwnerByLine(src);
    src.split('\n').forEach((line, i) => {
      const m = line.match(/apply-db-schema\.sh\s+"\$([A-Z_][A-Z0-9_]*)"/);
      if (m) found.push({ workflow: name, job: owner[i] ?? '', line: i + 1, urlVar: m[1] });
    });
  }
  return found;
}

/** `<workflow>::<job>` for every job that sets a test DB url in its own body.
 *  Measured 2026-08-10: no workflow sets one at workflow level, so a job-scoped
 *  scan is complete — and a workflow-level one appearing later shows up as a
 *  job with a url and no apply, which is the safe direction. */
export function jobsWithTestDbUrl(wfs = workflows()): string[] {
  const out: string[] = [];
  for (const [name, src] of wfs) {
    const owner = jobOwnerByLine(src);
    src.split('\n').forEach((line, i) => {
      if (!/^\s+(DATABASE_URL|PG_TEST_URL):/.test(line)) return;
      const job = owner[i] ?? '';
      if (job) out.push(`${name}::${job}`);
    });
  }
  return [...new Set(out)].sort();
}

export interface ConditionalApply extends ApplyStep {
  stepName: string;
  condition: string;
}

/** Apply steps that sit behind an `if:`. Walks back from the `run:` line to the
 *  owning `- name:` and collects any `if:` in between. */
export function conditionalApplySteps(wfs = workflows()): ConditionalApply[] {
  const found: ConditionalApply[] = [];
  for (const [name, src] of wfs) {
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      const m = line.match(/apply-db-schema\.sh\s+"\$([A-Z_][A-Z0-9_]*)"/);
      if (!m) return;
      let stepName = '';
      let condition = '';
      for (let j = i - 1; j >= 0 && j > i - 15; j--) {
        const nm = lines[j].match(/^\s*-\s*name:\s*(.+?)\s*$/);
        if (nm) {
          stepName = nm[1];
          break;
        }
        const ifm = lines[j].match(/^\s*if:\s*(.+?)\s*$/);
        if (ifm) condition = ifm[1];
      }
      if (condition) {
        found.push({ workflow: name, line: i + 1, urlVar: m[1], stepName, condition });
      }
    });
  }
  return found;
}

/** DENY BY DEFAULT. An apply step behind an `if:` is a bug unless the tests it
 *  guards are skipped by the SAME condition — keyed by the exact
 *  `<workflow>::<step name>` pair, never by filename, so a second conditional
 *  apply in an already-listed workflow is still red. */
export const CONDITIONAL_APPLY_EXEMPTIONS: Record<string, { condition: string; reason: string }> = {
  'ci.yml::Apply DB schema + emit manifest (for re-run)': {
    condition: "steps.agg.outputs.candidate_count != '0'",
    reason:
      'Prep for the behavioral RE-RUN block. Every step in that block — the ' +
      'artifact downloads, the browser install, and the re-run itself — carries ' +
      'this identical condition, so when it is false no test runs against the ' +
      'database at all. Skipping the schema here cannot produce a table-less ' +
      'test run, which is the hazard the rule exists for.',
  },
};

/** Any workflow line that still applies a schema file by hand. */
export function rawPsqlApplies(wfs = workflows()): Array<{ workflow: string; line: number; text: string }> {
  const found: Array<{ workflow: string; line: number; text: string }> = [];
  for (const [name, src] of wfs) {
    src.split('\n').forEach((line, i) => {
      if (/psql\b/.test(line) && /db\/schema\//.test(line)) {
        found.push({ workflow: name, line: i + 1, text: line.trim() });
      }
    });
  }
  return found;
}

/** Value of a `KEY: <url>` env assignment, per workflow, for the url vars the
 *  apply steps read. Returns every assignment found (a workflow may set the
 *  same var in several jobs). */
export function urlAssignments(varName: string, wfs = workflows()): Array<{ workflow: string; url: string }> {
  const out: Array<{ workflow: string; url: string }> = [];
  const re = new RegExp(`^\\s*${varName}:\\s*(\\S+)\\s*$`);
  for (const [name, src] of wfs) {
    for (const line of src.split('\n')) {
      const m = line.match(re);
      if (m) out.push({ workflow: name, url: m[1] });
    }
  }
  return out;
}

/** True when a URL points at a throwaway local test database. */
export function isEphemeralTestUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const localHost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  const testDb = /_test$/.test(parsed.pathname.replace(/^\//, ''));
  return localHost && testDb;
}

// ---------------------------------------------------------------------------
// 1. The applier is complete BY CONSTRUCTION.
// ---------------------------------------------------------------------------

describe('apply-db-schema.sh applies the whole directory', () => {
  const src = readFileSync(join(ROOT, APPLIER), 'utf8');

  it('globs db/schema/*.sql rather than naming files (so a new migration needs no workflow edit)', () => {
    expect(src).toMatch(/db\/schema\/\*\.sql/);
    // The moment it names ANY specific migration it has reacquired the list
    // that caused the bug.
    const named = src.match(/\b\d{3}_[a-z_]+\.sql\b/g) ?? [];
    const inComments = src
      .split('\n')
      .filter((l) => l.trim().startsWith('#'))
      .join('\n');
    for (const f of named) {
      expect(inComments, `${f} is named in EXECUTABLE code, not just a comment`).toContain(f);
    }
  });

  it('refuses to report success when the glob matches nothing', () => {
    // Without this, deleting db/schema/ would make every lane green instantly.
    expect(src).toMatch(/\$\{#files\[@\]\}\s*-eq\s*0/);
    expect(src).toMatch(/exit 1/);
  });

  it('runs psql with ON_ERROR_STOP=1 (plain `psql -f` exits 0 on SQL errors)', () => {
    expect(src).toMatch(/ON_ERROR_STOP=1/);
  });

  it('uses `set -euo pipefail` so a failing migration fails the step', () => {
    expect(src).toMatch(/set -euo pipefail/);
  });

  it('every migration is zero-padded so lexical glob order == numeric order', () => {
    // 002/004 carry FKs into 001; 005 ALTERs a 001 table. Order is load-bearing,
    // and the applier gets it from the shell glob, which sorts lexically. A
    // `10_x.sql` would silently sort before `2_x.sql`.
    for (const f of schemaFiles()) {
      expect(f, `${f} must be NNN_name.sql for glob order to equal apply order`).toMatch(
        /^\d{3}_[a-z0-9_]+\.sql$/,
      );
    }
  });

  it('there is at least one migration to apply (anchors every assertion above)', () => {
    expect(schemaFiles().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2 + 3. Deny by default, and prove the scan actually found something.
// ---------------------------------------------------------------------------

describe('every workflow applies the schema through the shared applier', () => {
  const steps = applySteps();

  it('finds apply steps at all — a scan that matched nothing would pass silently', () => {
    // THE assertion that keeps this file honest. Every other check below is
    // vacuously true over an empty list.
    expect(steps.length).toBeGreaterThan(0);
  });

  it('the jobs that apply the schema are EXACTLY the jobs with a test DB url', () => {
    // ⚠ THIS REPLACES A HAND-TYPED `expect(steps.length).toBe(14)` (2026-08-10),
    // and the replacement is strictly stronger rather than merely count-free.
    //
    // The literal existed because the coverage check below keys on WORKFLOW: a
    // workflow with two DB-using jobs stayed "applying" after one of them lost
    // its apply step, and only the total moved. That is not hypothetical — it is
    // exactly what happened when vrt-update.yml's two-platform matrix collapsed
    // to one capture job (#1458): the per-workflow check stayed green and the
    // literal was the only thing that noticed, which is the wrong instrument
    // noticing for the wrong reason.
    //
    // Keyed per JOB and asserted as a SET, both directions are named:
    //   * a job that gains a test DB url and no apply → appears on the left;
    //   * a job that loses its apply step             → appears on the left;
    //   * an apply against no declared url            → appears on the right.
    // Measured today: 13 jobs, 13 applies, a perfect 1:1. A count could only
    // ever have said "13".
    const applying = [...new Set(steps.map((s) => `${s.workflow}::${s.job}`))].sort();
    expect(
      jobsWithTestDbUrl(),
      'the set of jobs declaring a test DB url and the set applying the schema have ' +
        'diverged. A job on the left but not the right runs tests against a table-less ' +
        'database; one on the right but not the left applies to a url it never sets.',
    ).toEqual(applying);
  });

  it('...and every apply step was placed in a job (the attribution is not silently empty)', () => {
    // The set equality above compares `workflow::job` keys. If `jobOwnerByLine`
    // ever stopped resolving, EVERY key would collapse to `workflow::` on both
    // sides and the assertion would pass while measuring nothing.
    const unplaced = steps.filter((s) => !s.job).map((s) => `${s.workflow}:${s.line}`);
    expect(unplaced, 'apply steps the job scan could not place').toEqual([]);
  });

  it('no workflow hand-rolls `psql -f db/schema/…` any more', () => {
    const raw = rawPsqlApplies();
    expect(
      raw,
      'Hand-rolled schema applies reintroduce the missing-migration bug. Use ' +
        `${APPLIER}:\n` + raw.map((r) => `  ${r.workflow}:${r.line}  ${r.text}`).join('\n'),
    ).toEqual([]);
  });

  it('every workflow that defines a test DATABASE_URL also applies the schema', () => {
    // The flake-check-3x bug in general form: a lane can have a database, run
    // tests against it, and never create a table.
    const withDb = workflows().filter(([, src]) => /^\s*(DATABASE_URL|PG_TEST_URL):/m.test(src));
    const applying = new Set(steps.map((s) => s.workflow));
    const missing = withDb.map(([n]) => n).filter((n) => !applying.has(n));
    expect(
      missing,
      `these workflows set a test DB url but never apply the schema: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('no apply step is conditionally skipped, except by NAMED exemption', () => {
    // An `if:` on an apply step means SOME configuration of that workflow can
    // run tests against a table-less database — that was live on
    // flake-check-3x's unit suite (`if: inputs.suite != 'unit'`).
    //
    // It is legitimate ONLY when the tests that follow are gated on the SAME
    // expression, so "no schema" implies "no tests". That is not something a
    // regex can decide in general, so it is declared per instance and the
    // declaration is checked against the artifact.
    const conditional = conditionalApplySteps();
    for (const step of conditional) {
      const key = `${step.workflow}::${step.stepName}`;
      const exempt = CONDITIONAL_APPLY_EXEMPTIONS[key];
      expect(
        exempt,
        `${step.workflow}:${step.line} — apply step "${step.stepName}" is behind ` +
          `\`if: ${step.condition}\`. Either drop the condition, or add a ${key} ` +
          'entry to CONDITIONAL_APPLY_EXEMPTIONS explaining why no test can run ' +
          'when it is false.',
      ).toBeDefined();
      // The exemption's whole argument is "the tests are gated identically".
      // Pin the expression so a later widening of the apply's condition (or
      // narrowing of the tests') re-opens the question.
      expect(
        step.condition,
        `${key}: the exemption was written for \`${exempt?.condition}\` but the ` +
          `step now reads \`${step.condition}\` — re-check that the guarded tests ` +
          'are still skipped whenever the schema apply is.',
      ).toBe(exempt?.condition);
    }

    // ANCHOR TO THE ARTIFACT: an exemption naming a step that no longer exists
    // is an exemption nobody is watching.
    const live = new Set(conditional.map((s) => `${s.workflow}::${s.stepName}`));
    const stale = Object.keys(CONDITIONAL_APPLY_EXEMPTIONS).filter((k) => !live.has(k));
    expect(stale, `stale exemptions — these steps are gone or no longer conditional: ${stale.join(', ')}`).toEqual([]);

    // RATCHET BOTH WAYS: a ceiling can only trip by growing, so assert the
    // slack is zero too.
    expect(conditional.length).toBeLessThanOrEqual(Object.keys(CONDITIONAL_APPLY_EXEMPTIONS).length);
    expect(Object.keys(CONDITIONAL_APPLY_EXEMPTIONS).length - conditional.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. The precondition that makes shipping a DESTRUCTIVE migration safe.
// ---------------------------------------------------------------------------

describe('every apply target is a throwaway local test database', () => {
  it('002_feedback.sql really is destructive (the reason this check exists)', () => {
    // If this stops being true the check below is over-strict rather than
    // load-bearing — and someone should be told, not left guessing.
    const sql = readFileSync(join(ROOT, 'db/schema/002_feedback.sql'), 'utf8');
    expect(sql).toMatch(/DROP TABLE IF EXISTS feedback CASCADE/);
  });

  it('every url var the apply steps read resolves to localhost + a *_test database', () => {
    const vars = [...new Set(applySteps().map((s) => s.urlVar))];
    expect(vars.length).toBeGreaterThan(0);
    for (const v of vars) {
      const assignments = urlAssignments(v);
      expect(assignments.length, `no assignment found for $${v}`).toBeGreaterThan(0);
      for (const a of assignments) {
        expect(
          isEphemeralTestUrl(a.url),
          `${a.workflow}: $${v} = ${a.url} is not a throwaway localhost *_test database. ` +
            'db/schema/002_feedback.sql DROPs a table on apply — pointing a schema ' +
            'apply at a real environment would destroy data.',
        ).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 5. NEGATIVE CONTROLS — perturb what each checker claims to measure and
//    confirm the number moves. A checker blind to its own subject returns a
//    clean result no matter what the code does.
// ---------------------------------------------------------------------------

describe('negative controls: the checkers can actually fail', () => {
  it('rawPsqlApplies() FLAGS a hand-rolled apply', () => {
    const synthetic: Array<[string, string]> = [
      ['evil.yml', '      - name: Apply DB schema\n        run: psql "$DATABASE_URL" -f db/schema/001_init.sql\n'],
    ];
    expect(rawPsqlApplies(synthetic)).toHaveLength(1);
  });

  it('rawPsqlApplies() does NOT flag the shared applier', () => {
    const synthetic: Array<[string, string]> = [
      ['ok.yml', '        run: flox activate -- scripts/apply-db-schema.sh "$DATABASE_URL"\n'],
    ];
    expect(rawPsqlApplies(synthetic)).toEqual([]);
  });

  it('applySteps() finds the applier and reads back the right url var AND job', () => {
    const synthetic: Array<[string, string]> = [
      [
        'ok.yml',
        [
          'jobs:',
          '  build:',
          '    steps:',
          '      - name: Apply DB schema',
          '        run: flox activate -- scripts/apply-db-schema.sh "$PG_TEST_URL"',
        ].join('\n'),
      ],
    ];
    expect(applySteps(synthetic)).toEqual([
      { workflow: 'ok.yml', job: 'build', line: 5, urlVar: 'PG_TEST_URL' },
    ]);
  });

  it('NEGATIVE CONTROL: the per-JOB scan sees a second job that lost its apply', () => {
    // THE case a per-WORKFLOW check is structurally unable to see, and the
    // reason the literal `14` existed. Two DB-using jobs in one file; only one
    // applies. Per workflow this file is "applying" and green.
    const synthetic: Array<[string, string]> = [
      [
        'two-jobs.yml',
        [
          'jobs:',
          '  alpha:',
          '    env:',
          '      DATABASE_URL: postgresql://postgres:postgres@localhost:5432/x_test',
          '    steps:',
          '      - run: flox activate -- scripts/apply-db-schema.sh "$DATABASE_URL"',
          '  beta:',
          '    env:',
          '      DATABASE_URL: postgresql://postgres:postgres@localhost:5432/x_test',
          '    steps:',
          '      - run: echo no schema here',
        ].join('\n'),
      ],
    ];
    expect(jobsWithTestDbUrl(synthetic)).toEqual(['two-jobs.yml::alpha', 'two-jobs.yml::beta']);
    const applying = applySteps(synthetic).map((s) => `${s.workflow}::${s.job}`);
    expect(applying).toEqual(['two-jobs.yml::alpha']);
    // …so the real assertion would be RED, naming beta.
    expect(jobsWithTestDbUrl(synthetic)).not.toEqual(applying);
  });

  it('isEphemeralTestUrl() REJECTS a real host and a non-test database', () => {
    expect(isEphemeralTestUrl('postgresql://postgres:postgres@localhost:5432/patchtogether_test')).toBe(true);
    expect(isEphemeralTestUrl('postgres://postgres:postgres@127.0.0.1:54320/patchtogether_test')).toBe(true);
    // A real Neon branch — the case that would destroy data.
    expect(isEphemeralTestUrl('postgresql://u:p@ep-twilight-tree-01652938.us-east-2.aws.neon.tech/main')).toBe(false);
    // Local, but the PRODUCTION database name.
    expect(isEphemeralTestUrl('postgresql://postgres:postgres@localhost:5432/patchtogether')).toBe(false);
    expect(isEphemeralTestUrl('not-a-url')).toBe(false);
  });

  it('conditionalApplySteps() FLAGS an apply behind an `if:` and reads back its condition', () => {
    const synthetic: Array<[string, string]> = [
      [
        'sneaky.yml',
        [
          '      - name: Apply DB schema',
          "        if: inputs.suite != 'unit'",
          '        run: flox activate -- scripts/apply-db-schema.sh "$DATABASE_URL"',
        ].join('\n'),
      ],
    ];
    const found = conditionalApplySteps(synthetic);
    expect(found).toHaveLength(1);
    expect(found[0].stepName).toBe('Apply DB schema');
    expect(found[0].condition).toBe("inputs.suite != 'unit'");
    // ...and it is NOT on the exemption list, so the real assertion would fail.
    expect(CONDITIONAL_APPLY_EXEMPTIONS['sneaky.yml::Apply DB schema']).toBeUndefined();
  });

  it('conditionalApplySteps() does NOT flag an unconditional apply', () => {
    const synthetic: Array<[string, string]> = [
      [
        'fine.yml',
        ['      - name: Apply DB schema', '        run: flox activate -- scripts/apply-db-schema.sh "$DATABASE_URL"'].join(
          '\n',
        ),
      ],
    ];
    expect(conditionalApplySteps(synthetic)).toEqual([]);
  });

  it('schemaFiles() reads the directory, so an unwired migration cannot hide', () => {
    const files = schemaFiles();
    // The three that were missing from every CI lane before this landed.
    expect(files).toContain('002_feedback.sql');
    expect(files).toContain('003_saved_groups.sql');
    expect(files).toContain('004_rack_update_journal.sql');
  });
});
