// scripts/ci-playwright-timeout.test.ts
//
// A PLAYWRIGHT RUN THAT OUTLIVES ITS JOB DESTROYS ITS OWN EVIDENCE.
//
// When Playwright is still running at a job's `timeout-minutes`, GitHub
// HARD-KILLS the runner — and that happens BEFORE the `if: always()` report
// upload. No blob report, no HTML report, and the raw log is purged later.
// What reaches a human is `cancelled` plus a duration.
//
// #1309's `e2e (shard 4/10)` did exactly that. Clearing the PR took
// elimination rather than evidence: merge base green at 9m49s, a concurrent
// run green at 9m41s, two local reproductions (3.0 min on dev, 1.5 min against
// the preview bundle with CI=1). Hours, to establish a green thing was green.
//
// `PW_GLOBAL_TIMEOUT_MS` (read by `globalTimeout` in e2e/playwright.config.ts)
// makes Playwright exit on its own terms first, so it still writes a report
// naming which tests were in flight.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// The guard is a number in ci.yml that must stay under ANOTHER number in
// ci.yml (`timeout-minutes`) that it cannot see. Nothing about the YAML
// enforces that. Raise a ceiling and forget the guard — or set a guard ABOVE
// its ceiling — and it silently never fires, which is a guard that is not
// guarding.
//
// That is not hypothetical drift, it is this repo's most-repeated bug:
//   · UNCHECKABLE_CEILING = 87, calibrated on a tree that had since moved
//   · a required-lane `--grep` left unanchored, so `filter` matched `resofilter`
//   · RAW_PARAM_WRITE bracket-only, catching 3 of 99 writes
// Each was a number or pattern that had to track something else by discipline.
// This test replaces the discipline with an assertion.
//
// It deliberately does NOT demand that every Playwright job be guarded. Five of
// the six have never died this way, and five speculative guards would be five
// more numbers to drift. What it demands is: whatever IS set must be correct,
// and whatever is NOT set must be visible.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CI_YML = fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url));

/** Margin between the guard and the job ceiling: checkout + flox + artifact
 *  download happen before Playwright starts, and the report upload happens
 *  after it stops. A guard that leaves no room for those is still a mute death. */
const MIN_MARGIN_MIN = 3;

interface Job {
  name: string;
  ceilingMin: number | null;
  /** every PW_GLOBAL_TIMEOUT_MS in scope for this job (job-level or step-level) */
  guardsMs: number[];
  runsPlaywright: boolean;
}

/** Parse ci.yml well enough to answer: per job, its ceiling, its guards, and
 *  whether it runs Playwright. Deliberately a scanner rather than a YAML load —
 *  it must survive anchors/expressions the loader would choke on, and the
 *  properties are all line-local. */
export function parseJobs(src: string): Job[] {
  const jobs: Job[] = [];
  let cur: Job | null = null;
  for (const line of src.split('\n')) {
    const jobStart = /^ {2}([a-z0-9][a-z0-9-]*):\s*$/.exec(line);
    if (jobStart) {
      if (cur) jobs.push(cur);
      cur = { name: jobStart[1], ceilingMin: null, guardsMs: [], runsPlaywright: false };
      continue;
    }
    if (!cur) continue;
    const to = /^\s*timeout-minutes:\s*(\d+)/.exec(line);
    if (to && cur.ceilingMin === null) cur.ceilingMin = Number(to[1]);
    const g = /PW_GLOBAL_TIMEOUT_MS:\s*'?(\d+)'?/.exec(line);
    if (g) cur.guardsMs.push(Number(g[1]));
    if (/playwright\s+test/.test(line)) cur.runsPlaywright = true;
  }
  if (cur) jobs.push(cur);
  return jobs;
}

const JOBS = parseJobs(readFileSync(CI_YML, 'utf8'));
const PW_JOBS = JOBS.filter((j) => j.runsPlaywright);

describe('CI Playwright jobs cannot die mute', () => {
  it('the scan is not vacuous — it found Playwright jobs and their ceilings', () => {
    // ⚠ A BARE GREEN HERE WOULD BE INDISTINGUISHABLE FROM A BROKEN PARSER.
    // If ci.yml is restructured so the scanner stops recognising jobs, every
    // assertion below passes over an empty set. Floor it.
    expect(PW_JOBS.length, 'no Playwright-invoking job found — the scanner is broken').toBeGreaterThanOrEqual(4);
    const noCeiling = PW_JOBS.filter((j) => j.ceilingMin === null).map((j) => j.name);
    expect(noCeiling.join(', '), 'a Playwright job has no timeout-minutes the scanner could read').toBe('');
  });

  it('every guard that IS set sits under its job ceiling with margin', () => {
    const bad: string[] = [];
    for (const j of PW_JOBS) {
      for (const ms of j.guardsMs) {
        const guardMin = ms / 60_000;
        const ceiling = j.ceilingMin!;
        if (guardMin > ceiling - MIN_MARGIN_MIN) {
          bad.push(
            `${j.name}: guard ${guardMin}m vs ceiling ${ceiling}m — needs ≤ ${ceiling - MIN_MARGIN_MIN}m. ` +
              (guardMin >= ceiling
                ? 'At or above the ceiling it can NEVER fire: the job dies first and takes the report with it.'
                : 'Too little room for checkout + artifact download + report upload.'),
          );
        }
      }
    }
    expect(bad.join('\n'), 'a PW_GLOBAL_TIMEOUT_MS cannot fire before its job is killed').toBe('');
  });

  it('the UNGUARDED Playwright jobs are declared, not silently absent', () => {
    // Guarding a lane is opt-in — but the SET of unguarded lanes is pinned, so
    // adding a Playwright job without deciding either way is red rather than
    // quiet. If you guard one of these, delete it here in the same commit.
    const UNGUARDED = ['behavioral-coverage', 'behavioral-smoke', 'behavioral-watchdog', 'collab', 'webgl-smoke'];
    const actual = PW_JOBS.filter((j) => j.guardsMs.length === 0).map((j) => j.name).sort();
    expect(
      actual,
      'the set of Playwright jobs running WITHOUT a global timeout changed. ' +
        'Each one can still die mute at its ceiling — that is a deliberate trade ' +
        '(a guard is another number that must track a ceiling it cannot see), ' +
        'but it must be a CHOICE. Guard it, or add it here with a reason.',
    ).toEqual(UNGUARDED);
  });

  it('NEGATIVE CONTROL: the margin check actually fires', () => {
    // Every assertion above passes today. Prove the important one can fail —
    // otherwise "green" says nothing about whether it is looking.
    const rigged = parseJobs(
      [
        '  fake-job:',
        '    timeout-minutes: 10',
        '    env:',
        "      PW_GLOBAL_TIMEOUT_MS: '900000'", // 15m guard under a 10m ceiling
        '    steps:',
        '      - run: npx playwright test',
      ].join('\n'),
    );
    const j = rigged[0];
    expect(j.runsPlaywright).toBe(true);
    expect(j.ceilingMin).toBe(10);
    expect(j.guardsMs).toEqual([900_000]);
    // 15m > 10m - 3m → must be caught
    expect(j.guardsMs[0] / 60_000 > j.ceilingMin! - MIN_MARGIN_MIN).toBe(true);
  });

  it('NEGATIVE CONTROL: a guard comfortably under its ceiling passes', () => {
    // The other direction — so the check is not simply always-true.
    const ok = parseJobs(
      ['  fine-job:', '    timeout-minutes: 20', '    env:', "      PW_GLOBAL_TIMEOUT_MS: '900000'", '    steps:', '      - run: npx playwright test'].join('\n'),
    )[0];
    expect(ok.guardsMs[0] / 60_000 > ok.ceilingMin! - MIN_MARGIN_MIN).toBe(false);
  });
});
