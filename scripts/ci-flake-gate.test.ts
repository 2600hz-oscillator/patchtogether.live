// scripts/ci-flake-gate.test.ts
//
// SOURCE-LEVEL GATE: every CI job that RUNS Playwright must also run the FLAKE
// GATE. Deny-by-default, so a lane added later cannot escape silently.
//
// ── the defect this exists to prevent ──────────────────────────────────────
//
// `e2e/playwright.config.ts` sets `retries: 1` on CI. A test that fails and
// then passes is reported `flaky` and THE JOB IS GREEN. Two `main` push runs
// went red in one day (#1875, #1860) on a class that had been riding green PR
// runs the whole time, because the retry rescued it there and NOTHING consumed
// the signal — the audit was already PRINTING "A green job is hiding these"
// and no gate read it.
//
// Arming one lane would have been the same bug one level up: the flake gate
// itself becoming a thing that covers what someone remembered to wire. So the
// requirement is stated over the WORKFLOW, and this test is what makes it true
// of every lane rather than of the lanes that were fashionable that week.
//
// ── why a source gate ──────────────────────────────────────────────────────
//
// "Does this lane consume its retry signal?" is not recoverable from a run. A
// lane with no gate and a lane with a gate that never fired produce identical
// green output — the CLAUDE.md blind-gates question ("would its green run look
// any different if the answer were 'everything'?") answers itself here.
//
// ── ⚠ EXEMPTIONS CARRY A VERIFIED PRECONDITION, NOT A PROMISE ──────────────
//
// An exemption list of names is a ledger, and a ledger goes stale silently.
// Each entry below states the FACT that makes the gate unnecessary and PROVES
// it against the tree. If the fact stops being true — someone gives vrt-strict
// retries — the exemption does not quietly keep applying: this test goes RED
// and names it. That is "anchor to the ARTIFACT, not the list".

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CI_YML = fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url));
const VRT_CONFIG = fileURLToPath(new URL('../e2e/vrt/vrt.config.ts', import.meta.url));

export interface PwJob {
  name: string;
  /** Playwright invocations that actually RUN tests (a `--list` does not). */
  runningInvocations: number;
  /** `--list`-only invocations, which execute no test and can produce no flake. */
  listInvocations: number;
  /** the job runs scripts/e2e-report-audit.mjs with --fail-on-flaky */
  hasFlakeGate: boolean;
  /** any `--retries` passed on a Playwright command line in this job */
  cliRetries: number[];
}

/**
 * Scan ci.yml well enough to answer, per job: does it run Playwright, and does
 * it gate flakes?
 *
 * A scanner rather than a YAML load, for the reason the sibling die-mute gate
 * gives: it must read INSIDE a `run: |` block, which a loader returns as one
 * opaque string. Comments are stripped first — `#` is a comment in BOTH the
 * YAML and the shell here — so PROSE ABOUT the flag can never be mistaken for
 * the flag. (That is not hypothetical: this file's own header names
 * `--fail-on-flaky` several times.)
 */
export function parsePwJobs(src: string): PwJob[] {
  const jobs: PwJob[] = [];
  let cur: PwJob | null = null;
  let inPwCommand = false;
  let pwCommandText = '';

  const flushCommand = () => {
    if (!inPwCommand || !cur) return;
    if (/--list\b/.test(pwCommandText)) cur.listInvocations++;
    else cur.runningInvocations++;
    const r = /--retries[=\s]+(\d+)/.exec(pwCommandText);
    if (r) cur.cliRetries.push(Number(r[1]));
    inPwCommand = false;
    pwCommandText = '';
  };

  for (const raw of src.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const jobStart = /^ {2}([a-z0-9][a-z0-9-]*):\s*$/.exec(line);
    if (jobStart) {
      flushCommand();
      if (cur) jobs.push(cur);
      cur = {
        name: jobStart[1],
        runningInvocations: 0,
        listInvocations: 0,
        hasFlakeGate: false,
        cliRetries: [],
      };
      continue;
    }
    if (!cur) continue;
    const code = /^\s*#/.test(line) ? '' : line;

    // The audit call and its flag may sit on different continuation lines, so
    // the flag is attributed at JOB scope. Stated as a blind spot at the foot
    // of this file: a job with two audits, one of them unarmed, reads as armed.
    if (/--fail-on-flaky\b/.test(code)) cur.hasFlakeGate = true;

    if (/playwright\s+test\b/.test(code)) {
      flushCommand();
      inPwCommand = true;
      pwCommandText = '';
    }
    if (inPwCommand) pwCommandText += ' ' + code;
    if (!/\\\s*$/.test(code)) flushCommand();
  }
  flushCommand();
  if (cur) jobs.push(cur);
  return jobs;
}

/**
 * Jobs that run Playwright but are NOT required to carry the flake gate.
 *
 * `verify` proves the stated fact against the tree and MUST return null; any
 * string it returns is the reason this exemption is no longer valid, and the
 * test fails with it.
 */
const EXEMPT: ReadonlyArray<{
  readonly job: string;
  readonly why: string;
  readonly verify: () => string | null;
}> = [
  {
    job: 'vrt-strict-shard',
    why:
      'vrt-strict runs with retries: 0 — a VRT either matches its baseline or it does not, '
      + 'and retrying only delays surfacing the truth. With no retry there is no recovered '
      + 'flake to detect: a failure there is ALREADY a red job. A flake gate on this lane '
      + 'could never fire, and a gate that cannot fail is decoration.',
    verify: () => {
      if (!existsSync(VRT_CONFIG)) return `${VRT_CONFIG} no longer exists`;
      const src = readFileSync(VRT_CONFIG, 'utf8');
      const code = src
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      if (!/\bretries:\s*0\b/.test(code)) {
        return 'vrt/vrt.config.ts no longer declares `retries: 0` — the whole basis of this '
          + 'exemption. If vrt-strict now retries, it can hide a recovered flake and MUST '
          + 'carry the flake gate.';
      }
      return null;
    },
  },
];

const JOBS = parsePwJobs(readFileSync(CI_YML, 'utf8'));
const PW_JOBS = JOBS.filter((j) => j.runningInvocations > 0);

describe('every Playwright lane consumes its retry signal (#1903)', () => {
  it('the scan is not vacuous — it found the lanes it is supposed to gate', () => {
    // ⚠ A BARE GREEN HERE WOULD BE INDISTINGUISHABLE FROM A BROKEN PARSER. If
    // ci.yml is restructured so the scanner stops recognising jobs, every
    // assertion below passes over an empty set.
    //
    // Anchored to NAMES, never to a population size — a floor on how many lanes
    // exist is a count, and it would sit one deletion away from its population.
    const names = PW_JOBS.map((j) => j.name);
    expect(names, 'the e2e lane must be recognised as running Playwright').toContain('e2e');
    expect(names).toContain('collab');
    expect(names).toContain('behavioral-smoke');
    expect(names).toContain('webgl-smoke');
  });

  it('every Playwright-running job gates flakes, or is exempt on a VERIFIED fact', () => {
    const exemptNames = new Set(EXEMPT.map((e) => e.job));
    const ungated = PW_JOBS.filter((j) => !j.hasFlakeGate && !exemptNames.has(j.name)).map(
      (j) => `${j.name} (${j.runningInvocations} Playwright invocation(s), no --fail-on-flaky)`,
    );
    expect(
      ungated,
      'A lane that runs Playwright with retries and does not audit its report will go GREEN '
        + 'on a recovered flake — the exact hole that took main red twice in one day (#1875, '
        + '#1860). Add a step running scripts/e2e-report-audit.mjs <report> --fail-on-flaky, '
        + 'or add a NAMED exemption whose verify() proves the lane cannot produce a flake.',
    ).toEqual([]);
  });

  it('every exemption still names a real job AND its stated fact still holds', () => {
    const problems: string[] = [];
    for (const e of EXEMPT) {
      // Anchored to the artifact: an exemption naming a job that no longer runs
      // Playwright is RED, not silently satisfied.
      if (!PW_JOBS.some((j) => j.name === e.job)) {
        problems.push(`${e.job}: exempted, but no such Playwright-running job exists in ci.yml`);
        continue;
      }
      const bad = e.verify();
      if (bad) problems.push(`${e.job}: ${bad}`);
      expect(e.why.length, `${e.job}: an exemption must carry a real reason`).toBeGreaterThan(40);
    }
    expect(problems).toEqual([]);
  });

  it('the exempt lane really does pass no --retries on the command line', () => {
    // The config says `retries: 0`; a CLI `--retries=N` would override it and
    // silently re-open the hole the exemption assumes shut.
    for (const e of EXEMPT) {
      const job = PW_JOBS.find((j) => j.name === e.job);
      expect(job?.cliRetries ?? [], `${e.job} passes --retries, overriding the config`).toEqual([]);
    }
  });

  // ── CONTROLS, both directions, permanent ─────────────────────────────────

  it('NEGATIVE CONTROL: an ungated Playwright lane is detected', () => {
    const fixture = [
      '  newlane:',
      '    steps:',
      '      - name: Run specs',
      '        run: |',
      '          flox activate -- npx --workspace e2e playwright test \\',
      '            --reporter=list',
    ].join('\n');
    const parsed = parsePwJobs(fixture);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].runningInvocations, 'the scanner must see the invocation').toBe(1);
    expect(parsed[0].hasFlakeGate, 'an ungated lane must NOT read as gated').toBe(false);
  });

  it('POSITIVE CONTROL: a gated Playwright lane is accepted', () => {
    const fixture = [
      '  newlane:',
      '    steps:',
      '      - name: Run specs',
      '        run: |',
      '          flox activate -- npx --workspace e2e playwright test \\',
      '            --reporter=list,json',
      '      - name: Flake gate',
      '        run: |',
      '          flox activate -- node scripts/e2e-report-audit.mjs r.json --fail-on-flaky',
    ].join('\n');
    const parsed = parsePwJobs(fixture);
    expect(parsed[0].hasFlakeGate, 'a wired lane must read as gated').toBe(true);
  });

  it('CONTROL: a --list discovery invocation is not counted as a test run', () => {
    // Discovery runs no test and can produce no flake. If this stopped being
    // true the gate would demand an audit of a step that has nothing to audit.
    const fixture = [
      '  discovery:',
      '    steps:',
      '      - run: |',
      '          npx playwright test --list --reporter=json',
    ].join('\n');
    const parsed = parsePwJobs(fixture);
    expect(parsed[0].listInvocations).toBe(1);
    expect(parsed[0].runningInvocations).toBe(0);
  });

  it('CONTROL: prose mentioning the flag does not count as wiring it', () => {
    // This file and ci.yml both discuss `--fail-on-flaky` in comments. A
    // scanner that read comments would certify an unwired lane as wired.
    const fixture = [
      '  commented:',
      '    steps:',
      '      # we should really add --fail-on-flaky here one day',
      '      - run: |',
      '          npx playwright test --reporter=list',
    ].join('\n');
    const parsed = parsePwJobs(fixture);
    expect(parsed[0].hasFlakeGate, 'a comment is not an implementation').toBe(false);
  });
});

// ── ⚠ WHAT THIS GATE IS STRUCTURALLY UNABLE TO SEE ─────────────────────────
//
//  · It attributes the audit at JOB scope. A job with two Playwright
//    invocations and an audit of only ONE of them reads as gated. webgl-smoke
//    is the only such job today and BOTH of its runs are audited, so the hole
//    is currently empty — but it is a hole. (The sibling die-mute gate has the
//    same shape and says so.)
//  · It reads ONLY .github/workflows/ci.yml. Playwright invocations in
//    vrt-update.yml, e2e-flake-purge.yml, flake-check-3x.yml and the rest are
//    outside it entirely. Those are dispatch/diagnostic lanes that gate no
//    merge, which is why the requirement is not stated over them — not because
//    they were checked and found clean.
//  · It proves the audit is CALLED, never that the report it reads describes
//    the run. A wrong path would fail loudly at runtime (the audit throws on a
//    missing file), which is the only reason that is tolerable here.
//  · ⚠ IT SAYS NOTHING ABOUT WHETHER A GATED LANE BLOCKS A MERGE. `collab` is
//    armed by this rule but is DELIBERATELY OFF THE UMBRELLA (informational,
//    task #69), so a collab flake reddens the collab job and does not block the
//    PR. That is a property of the umbrella's needs+env+if triple — asserted by
//    scripts/ci-umbrella-parity.test.ts, not here — and arming a lane is
//    explicitly not the same act as requiring it.
//  · It cannot see whether a lane's retries make a flake POSSIBLE, except
//    through the exemptions' explicit verify().
