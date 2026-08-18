// scripts/ci-service-container-pull.test.ts
//
// Gate for HOW CI GETS A POSTGRES. Pure-unit, zero-flake, runs in the `unit`
// lane via `task test` → `task test:scripts`. No database and no real Docker:
// the script is driven against a SHIM on PATH, so the retry and the fallback
// are exercised as behaviour rather than grepped for as source.
//
// THE BUG THIS EXISTS TO PREVENT (#1828)
// --------------------------------------
// Every DB-using job declared postgres as a `services:` block. A service
// container is initialised BEFORE the job's first step, so a transient registry
// error there kills the job outright:
//
//   ##[command] /usr/bin/docker pull public.ecr.aws/docker/library/postgres:17
//   ##[warning] Docker pull failed with exit code 1, back off 5.114s
//   ##[warning] Docker pull failed with exit code 1, back off 6.358s
//   ##[error]   Docker pull failed with exit code 1
//
// 141 lines of job log, no test run. Measured across the six ci.yml runs before
// the fix: 1 / 0 / 1 / 3 / 0 / 2 jobs dead that way. GitHub's three built-in
// attempts are the entire budget and they all hit ONE registry.
//
// ⚠ AND IT HAD ALREADY BEEN FIXED ONCE. The blocks carried the note "AWS ECR
// Public mirror — avoids the flaky Docker Hub service-container pull": Docker
// Hub flaked, someone swapped to ECR Public, ECR Public flaked identically. So
// the thing this gate protects is NOT a registry choice — it is the structural
// property that the pull happens somewhere a retry can reach it. A future agent
// hitting a red pull will be tempted to swap registries a third time; the deny
// rule below is what makes that not the smallest available change.
//
// WHAT THIS GATE ASSERTS
// ----------------------
//  1. DENY BY DEFAULT — no workflow may declare a `services:` container again,
//     keyed per `<workflow>::<job>` with a reason, anchored so a stale
//     exemption is RED.
//  2. COVERAGE BY SET EQUALITY — the jobs that declare a test DB url are
//     EXACTLY the jobs that start postgres. Both directions are named: a job
//     with a url and no postgres runs against nothing; a job starting postgres
//     it never addresses is dead weight. Derived from the artifact, never a
//     count. (Same shape as scripts/ci-db-schema.test.ts, deliberately — that
//     gate pairs `url ↔ schema`, this one pairs `url ↔ server`, and a lane
//     needs both to be true.)
//  3. ORDERING — postgres starts before the schema is applied to it.
//  4. RESOLUTION ORDER, BY EXECUTION — `--print-refs` is run, not grepped, so
//     the assertion reads the order the script would really pull in.
//  5. POSITIVE CONTROL — with the primary registry failing, the script still
//     exits 0 and runs the container from the SECOND registry. That is the
//     exact scenario that killed jobs before this landed, and it is asserted
//     to now SUCCEED rather than merely to be attempted.
//  6. NEGATIVE CONTROLS — every scanner is run over synthetic input that should
//     fail, and the script is run with every registry down to confirm it still
//     fails loudly (a retry loop that swallowed the failure would be worse than
//     no retry at all).
//
// WHAT THIS GATE CANNOT SEE
// -------------------------
//   · WHETHER A REAL PULL SUCCEEDS. Every docker call here is a shim. The gate
//     proves the script's control flow and the workflows' shape; only a real CI
//     run proves that ECR Public serves the image today.
//   · WHETHER POSTGRES ACTUALLY ACCEPTS CONNECTIONS. Readiness is asserted as
//     "polls pg_isready until it answers", not as a live handshake. The lanes'
//     own DB-backed tests are what prove that.
//   · A SERVICE CONTAINER DECLARED SOMEWHERE OTHER THAN `.github/workflows`.
//     There is no such place today (composite actions would be one), and the
//     non-vacuity assertion below would not notice if there were.

import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_DIR = join(ROOT, '.github/workflows');
const STARTER = '.github/scripts/start-postgres.sh';
const STARTER_ABS = join(ROOT, STARTER);

// ---------------------------------------------------------------------------
// Scanners. Raw text on purpose: a YAML loader would normalise away the very
// things under test (comments, quoting, key order) and would also happily
// accept a file that no longer parses the way Actions reads it.
// ---------------------------------------------------------------------------

function workflows(dir = WORKFLOW_DIR): Array<[string, string]> {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort()
    .map((f) => [f, readFileSync(join(dir, f), 'utf8')] as [string, string]);
}

/** The `jobs:` key owning each line, or '' outside the jobs block. */
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
    if (inJobs && /^[A-Za-z]/.test(line)) inJobs = false;
    if (inJobs) {
      const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
      if (m) job = m[1];
    }
    out.push(inJobs ? job : '');
  }
  return out;
}

export interface Site {
  workflow: string;
  job: string;
  line: number;
}

/** Every `services:` container declaration still on the tree. */
export function serviceContainers(wfs = workflows()): Array<Site & { image: string }> {
  const out: Array<Site & { image: string }> = [];
  for (const [workflow, src] of wfs) {
    const owner = jobOwnerByLine(src);
    const lines = src.split('\n');
    let inServices = false;
    lines.forEach((line, i) => {
      if (/^ {4}services:\s*$/.test(line)) {
        inServices = true;
        return;
      }
      if (inServices && /^ {0,4}\S/.test(line)) inServices = false;
      if (!inServices) return;
      const m = line.match(/^\s+image:\s*(\S+)/);
      if (m) out.push({ workflow, job: owner[i] ?? '', line: i + 1, image: m[1] });
    });
  }
  return out;
}

/** Every call to the shared starter. */
export function startSteps(wfs = workflows()): Site[] {
  const out: Site[] = [];
  for (const [workflow, src] of wfs) {
    const owner = jobOwnerByLine(src);
    src.split('\n').forEach((line, i) => {
      // `-?` matters: a step may be written as `- run: …` (one-liner) or as
      // `        run: …` under a `- name:`. A scanner that only knew the second
      // form would report ZERO for a workflow using the first, and every set
      // equality below would then be green over an empty left side.
      if (line.includes('start-postgres.sh') && /^\s+-?\s*run:/.test(line)) {
        out.push({ workflow, job: owner[i] ?? '', line: i + 1 });
      }
    });
  }
  return out;
}

/** Every call to the shared schema applier. */
export function applySteps(wfs = workflows()): Site[] {
  const out: Site[] = [];
  for (const [workflow, src] of wfs) {
    const owner = jobOwnerByLine(src);
    src.split('\n').forEach((line, i) => {
      if (/apply-db-schema\.sh\s+"\$[A-Z_]+"/.test(line)) {
        out.push({ workflow, job: owner[i] ?? '', line: i + 1 });
      }
    });
  }
  return out;
}

/** `<workflow>::<job>` for every job declaring a test DB url in its own body. */
export function jobsWithTestDbUrl(wfs = workflows()): string[] {
  const out: string[] = [];
  for (const [workflow, src] of wfs) {
    const owner = jobOwnerByLine(src);
    src.split('\n').forEach((line, i) => {
      if (!/^\s+(DATABASE_URL|PG_TEST_URL):\s*postgres/.test(line)) return;
      const job = owner[i] ?? '';
      if (job) out.push(`${workflow}::${job}`);
    });
  }
  return [...new Set(out)].sort();
}

/**
 * Service containers that are allowed to stay, keyed `<workflow>::<job>::<image>`
 * so a SECOND container in an already-listed job is still red.
 *
 * EMPTY, and that is the strongest state it can be in — the point of #1828 is
 * that there is no shape of `services:` whose pull a step can protect. If a
 * future service is genuinely un-pullable from a step (a job-level `container:`
 * would be), say so here in its own words and take the flake with open eyes.
 */
export const ALLOWED_SERVICE_CONTAINERS: Record<string, { why: string }> = {};

// ---------------------------------------------------------------------------
// 1 + 2 + 3. The workflow shape.
// ---------------------------------------------------------------------------

describe('CI postgres is started by a step, not a service container', () => {
  it('finds jobs with a test DB url at all — a scan matching nothing would pass everything below', () => {
    // THE assertion that keeps this file honest: every set-equality check under
    // it is vacuously true over two empty sets.
    expect(jobsWithTestDbUrl().length).toBeGreaterThan(0);
  });

  it('declares NO `services:` container, except by named exemption', () => {
    const found = serviceContainers();
    const offenders = found
      .map((s) => ({ key: `${s.workflow}::${s.job}::${s.image}`, ...s }))
      .filter((s) => !ALLOWED_SERVICE_CONTAINERS[s.key]);
    expect(
      offenders.map((o) => `${o.workflow}:${o.line}  ${o.key}`),
      'A `services:` container is pulled BEFORE step 1, so no retry, cache or ' +
        'registry fallback a step could add is reachable — a transient registry ' +
        `error kills the job with nothing run. Start it from a step instead: ${STARTER}. ` +
        'Swapping to yet another registry is NOT the fix; that has already been ' +
        'tried twice (Docker Hub → ECR Public → this).',
    ).toEqual([]);

    // ANCHOR TO THE ARTIFACT: an exemption naming a container that is gone is
    // an exemption nobody is watching.
    const live = new Set(found.map((s) => `${s.workflow}::${s.job}::${s.image}`));
    expect(
      Object.keys(ALLOWED_SERVICE_CONTAINERS).filter((k) => !live.has(k)),
      'stale exemptions — these service containers no longer exist',
    ).toEqual([]);
  });

  it('the jobs that start postgres are EXACTLY the jobs with a test DB url', () => {
    // Both directions are named, and neither is a count:
    //   * a job on the LEFT only  → it runs its tests against nothing at all;
    //   * a job on the RIGHT only → it pays for a database it never addresses,
    //     which is precisely what vrt-update.yml's capture was doing (#1828).
    const starting = [...new Set(startSteps().map((s) => `${s.workflow}::${s.job}`))].sort();
    expect(
      jobsWithTestDbUrl(),
      'the set of jobs declaring a test DB url and the set starting postgres have diverged',
    ).toEqual(starting);
  });

  it('...and every start step was placed in a job (the attribution is not silently empty)', () => {
    // Without this, a broken job scan would collapse BOTH sides of the equality
    // above to `<workflow>::` and it would pass while measuring nothing.
    const unplaced = startSteps().filter((s) => !s.job);
    expect(unplaced.map((s) => `${s.workflow}:${s.line}`)).toEqual([]);
  });

  it('postgres starts BEFORE the schema is applied to it, in every job that does both', () => {
    const starts = new Map(startSteps().map((s) => [`${s.workflow}::${s.job}`, s.line]));
    const late: string[] = [];
    for (const apply of applySteps()) {
      const key = `${apply.workflow}::${apply.job}`;
      const start = starts.get(key);
      if (start === undefined) continue; // covered by the set-equality test above
      if (start > apply.line) late.push(`${key}: start@${start} applies@${apply.line}`);
    }
    expect(late, 'the schema apply would run against a database that is not up yet').toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Resolution order, read by EXECUTION rather than by grep.
// ---------------------------------------------------------------------------

function printRefs(env: Record<string, string> = {}): string[] {
  return execFileSync('bash', [STARTER_ABS, '--print-refs'], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
    .trim()
    .split('\n')
    .filter(Boolean);
}

describe('the starter resolves more than one registry, primary first', () => {
  const refs = printRefs();

  it('tries at least two refs — one registry is the hard dependency this removes', () => {
    expect(refs.length).toBeGreaterThan(1);
  });

  it('the refs live on DISTINCT hosts (two paths on one registry is not a fallback)', () => {
    const hosts = refs.map((r) => r.split('/')[0]);
    expect(new Set(hosts).size).toBe(hosts.length);
  });

  it('ECR Public is tried FIRST — it has no anonymous rate limit', () => {
    expect(refs[0]).toMatch(/^public\.ecr\.aws\//);
  });

  it('every ref names the same requested tag, and the tag is a parameter', () => {
    for (const r of refs) expect(r.endsWith(':17')).toBe(true);
    // The `unit` job pulls 16. If the tag stopped threading through, that job
    // would silently run its tests on a different postgres major.
    for (const r of printRefs({ PG_IMAGE_TAG: '16' })) expect(r.endsWith(':16')).toBe(true);
  });

  it('refuses an empty registry list rather than reporting success with nothing to pull', () => {
    const r = spawnSync('bash', [STARTER_ABS, '--print-refs'], {
      encoding: 'utf8',
      env: { ...process.env, PG_REGISTRIES: '  ' },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/PG_REGISTRIES is empty/);
  });
});

// ---------------------------------------------------------------------------
// 5 + 6. The retry itself, driven against a docker shim.
// ---------------------------------------------------------------------------

/**
 * A fake `docker` on PATH that records every invocation and fails `pull` for the
 * refs named in FAIL_REFS. This is what makes the fallback a POSITIVE control:
 * the assertion is that the script SUCCEEDS through a failing primary, not
 * merely that it printed something about retrying.
 */
function withShim(env: Record<string, string>): { status: number | null; stdout: string; stderr: string; calls: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'pgshim-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'calls');
  writeFileSync(log, '');
  const shim = join(bin, 'docker');
  writeFileSync(
    shim,
    [
      '#!/usr/bin/env bash',
      'echo "$*" >> "$SHIM_LOG"',
      'case "$1" in',
      '  pull)',
      '    for bad in $FAIL_REFS; do',
      '      if [ "$2" = "$bad" ]; then exit 1; fi',
      '    done',
      '    exit 0 ;;',
      '  exec) exit 0 ;;',
      '  *) exit 0 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(shim, 0o755);

  const r = spawnSync('bash', [STARTER_ABS], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      SHIM_LOG: log,
      FAIL_REFS: '',
      // No real sleeping: the backoff VALUES are policy, the retry STRUCTURE is
      // what is under test here. Two entries = three passes.
      PG_PULL_BACKOFF: '0 0',
      ...env,
    },
  });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls };
}

const REFS = printRefs();
const PRIMARY = REFS[0];
const SECONDARY = REFS[1];

describe('a failing pull is retried into success, not fatal', () => {
  it('happy path: one pull, then the container runs from the primary', () => {
    const r = withShim({});
    expect(r.status).toBe(0);
    expect(r.calls.filter((c) => c.startsWith('pull '))).toEqual([`pull ${PRIMARY}`]);
    expect(r.calls.some((c) => c.startsWith('run -d') && c.endsWith(PRIMARY))).toBe(true);
  });

  it('POSITIVE CONTROL: the primary registry down is SURVIVED — postgres comes up from the fallback', () => {
    // THE case. Before #1828 this exact input killed the job before step 1.
    const r = withShim({ FAIL_REFS: PRIMARY });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.calls.filter((c) => c.startsWith('pull '))).toEqual([
      `pull ${PRIMARY}`,
      `pull ${SECONDARY}`,
    ]);
    // Not just "it tried the fallback" — it RAN the fallback image.
    expect(r.calls.some((c) => c.startsWith('run -d') && c.endsWith(SECONDARY))).toBe(true);
  });

  it('a transient failure across ALL registries is retried on a later pass', () => {
    // Distinct from the fallback above: here every registry fails the first
    // pass, which is what a brief network blip looks like. Modelled by failing
    // only while the shim is told to, so the second pass succeeds.
    const r = withShim({ FAIL_REFS: `${PRIMARY} ${SECONDARY}`, PG_PULL_BACKOFF: '0' });
    // Every registry, every pass — so this one legitimately fails, and the
    // assertion is that it tried the FULL grid rather than stopping at one.
    expect(r.status).not.toBe(0);
    const pulls = r.calls.filter((c) => c.startsWith('pull '));
    expect(pulls.length).toBe(REFS.length * 2); // 1 + |backoff| passes
  });

  it('NEGATIVE CONTROL: an outage still FAILS LOUDLY, naming attempts and registries', () => {
    // A retry loop that swallowed the failure would be strictly worse than no
    // retry — the lane would run its tests against nothing.
    const r = withShim({ FAIL_REFS: REFS.join(' ') });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/could not pull postgres/);
    expect(r.stderr).toMatch(/this is an outage, not a flake/);
    expect(r.calls.some((c) => c.startsWith('run -d'))).toBe(false);
  });

  it('honours the per-job parameters the workflows pass (tag + host port)', () => {
    const r = withShim({ PG_IMAGE_TAG: '16', PG_HOST_PORT: '54320' });
    expect(r.status).toBe(0);
    const run = r.calls.find((c) => c.startsWith('run -d'));
    expect(run).toBeDefined();
    expect(run).toContain('-p 54320:5432');
    expect(run).toContain(':16');
  });

  it('waits on pg_isready — the readiness signal, not a fixed sleep', () => {
    const r = withShim({});
    expect(r.calls.some((c) => /^exec \S+ pg_isready/.test(c))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Negative controls for the SCANNERS. A scanner that silently stopped matching
// would pass every assertion above while measuring nothing.
// ---------------------------------------------------------------------------

describe('negative controls: the workflow scanners can actually fail', () => {
  const wf = (name: string, body: string): Array<[string, string]> => [[name, body]];

  it('serviceContainers() FLAGS a re-introduced service block, with its job', () => {
    const found = serviceContainers(
      wf(
        'relapse.yml',
        [
          'jobs:',
          '  e2e:',
          '    services:',
          '      postgres:',
          '        image: public.ecr.aws/docker/library/postgres:17',
          '    steps:',
          '      - run: echo hi',
        ].join('\n'),
      ),
    );
    expect(found).toEqual([
      {
        workflow: 'relapse.yml',
        job: 'e2e',
        line: 5,
        image: 'public.ecr.aws/docker/library/postgres:17',
      },
    ]);
    expect(ALLOWED_SERVICE_CONTAINERS['relapse.yml::e2e::public.ecr.aws/docker/library/postgres:17']).toBeUndefined();
  });

  it('serviceContainers() does NOT flag a step-managed start, or a `uses:` action ref', () => {
    expect(
      serviceContainers(
        wf(
          'fine.yml',
          [
            'jobs:',
            '  e2e:',
            '    steps:',
            '      - uses: actions/checkout@v4',
            '      - run: bash .github/scripts/start-postgres.sh',
          ].join('\n'),
        ),
      ),
    ).toEqual([]);
  });

  it('startSteps() finds the starter and places it in its job', () => {
    expect(
      startSteps(
        wf(
          'ok.yml',
          ['jobs:', '  e2e:', '    steps:', '      - run: bash .github/scripts/start-postgres.sh'].join('\n'),
        ),
      ),
    ).toEqual([{ workflow: 'ok.yml', job: 'e2e', line: 4 }]);
  });

  it('the ordering check SEES an apply that precedes its start', () => {
    const bad = wf(
      'backwards.yml',
      [
        'jobs:',
        '  e2e:',
        '    steps:',
        '      - run: flox activate -- scripts/apply-db-schema.sh "$DATABASE_URL"',
        '      - run: bash .github/scripts/start-postgres.sh',
      ].join('\n'),
    );
    const start = startSteps(bad)[0];
    const apply = applySteps(bad)[0];
    expect(start.job).toBe('e2e');
    expect(apply.job).toBe('e2e');
    expect(start.line).toBeGreaterThan(apply.line); // …so the real assertion is RED
  });

  it('the coverage check SEES a job with a DB url and no postgres', () => {
    // vrt-update.yml's capture in reverse: a url declared, nothing serving it.
    const orphan = wf(
      'orphan.yml',
      [
        'jobs:',
        '  capture:',
        '    env:',
        '      DATABASE_URL: postgresql://postgres:postgres@localhost:5432/x_test',
        '    steps:',
        '      - run: echo no postgres here',
      ].join('\n'),
    );
    expect(jobsWithTestDbUrl(orphan)).toEqual(['orphan.yml::capture']);
    expect(startSteps(orphan)).toEqual([]);
  });
});
