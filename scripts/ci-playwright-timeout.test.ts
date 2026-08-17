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
// Playwright's `--global-timeout <ms>` makes it exit on its OWN terms first, so
// it still writes a report naming which tests were in flight.
//
// ── WHY THE FLAG AND NOT `globalTimeout` IN playwright.config.ts ────────────
// A config value is ONE number shared by EVERY Playwright job, and their
// ceilings differ (10 to 40 min on the tree today). Any single default
// therefore sits ABOVE some of them and can never fire there — a guard that is
// not guarding, i.e. the same shape as the bug it would be fixing. The precise
// spread is deliberately not written down here: it is derivable from the file
// this test parses, and a copy of it in prose is a number that drifts.
//
// It would also drag e2e/playwright.config.ts into a pure-CI change, and that
// file is in the WebGL attest basis (`STANDALONE_BASIS_FILES` in
// scripts/webgl-attest-lib.ts) — so a one-line config edit costs a real-GPU
// re-attest. `.github/workflows/ci.yml` is not. Verified 2026-08-03: reverting
// the config edit turned the attest gate green with no re-attest run. (It used
// to cost TWO re-attests; the collab basis went away with `collab-attest` on
// 2026-08-17.)
//
// So the guard is a CLI flag set per job, in the file where that job's ceiling
// is visible three lines up — and it is measurably the cheaper place to put it.
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
// It deliberately does NOT demand that every Playwright job be guarded. Only
// the e2e shard has ever died this way, and only its runtime was ever measured;
// a speculative guard on each of the others would be another number that must
// track a ceiling it cannot see. What it demands is: whatever IS set must be
// correct, and whatever is NOT set must be visible — which is what the
// UNGUARDED set below pins, in both directions.
//
// ── WHAT THIS GATE CANNOT SEE (stated, per the blind-gates rule) ────────────
//  · Guards are attributed at JOB scope, not step scope: a job with two
//    Playwright invocations and a guard on only one reads as "guarded".
//    webgl-smoke is the only such job today and it is UNGUARDED, so the hole
//    is currently empty — but it is a hole.
//  · A `--global-timeout` in a job that never invokes Playwright is invisible
//    (PW_JOBS filters it out). It would also be inert, so this is benign.
//  · Only `.github/workflows/ci.yml` is scanned. A Playwright invocation in
//    any other workflow (vrt-update.yml, …) is outside this gate entirely.
//
// The one blindness that CANNOT hide: if the guard regex ever stops matching,
// `e2e` falls into the UNGUARDED set and that test goes RED. The pinned set is
// simultaneously the parser's non-vacuity check for the guard pattern, so a
// broken scanner fails loudly instead of reporting "all guards are fine".

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
  /** every `--global-timeout <ms>` passed to a Playwright command in this job */
  guardsMs: number[];
  runsPlaywright: boolean;
}

/** Parse ci.yml well enough to answer: per job, its ceiling, its guards, and
 *  whether it runs Playwright. Deliberately a scanner rather than a YAML load —
 *  it must survive anchors/expressions the loader would choke on, and it has to
 *  read INSIDE a `run: |` block, which a loader hands back as one opaque string.
 *
 *  The guard lives on a backslash-continued line of the Playwright command, so
 *  the scan tracks that continuation window rather than the whole job: a stray
 *  `--global-timeout` elsewhere in the job is not a guard on this command.
 *  Comment lines are stripped first (`#` is a comment in BOTH the YAML and the
 *  shell here), so prose ABOUT the flag can never be mistaken for the flag. */
export function parseJobs(src: string): Job[] {
  const jobs: Job[] = [];
  let cur: Job | null = null;
  let inPwCommand = false;
  for (const raw of src.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const jobStart = /^ {2}([a-z0-9][a-z0-9-]*):\s*$/.exec(line);
    if (jobStart) {
      if (cur) jobs.push(cur);
      cur = { name: jobStart[1], ceilingMin: null, guardsMs: [], runsPlaywright: false };
      inPwCommand = false;
      continue;
    }
    if (!cur) continue;
    // A commented-out line is not code — in the YAML or in the run-block shell.
    const code = /^\s*#/.test(line) ? '' : line;

    const to = /^\s*timeout-minutes:\s*(\d+)/.exec(code);
    if (to && cur.ceilingMin === null) cur.ceilingMin = Number(to[1]);

    if (/playwright\s+test/.test(code)) {
      cur.runsPlaywright = true;
      inPwCommand = true;
    }
    if (inPwCommand) {
      const g = /--global-timeout[=\s]+(\d+)/.exec(code);
      if (g) cur.guardsMs.push(Number(g[1]));
    }
    // A shell command ends at the first line without a trailing backslash.
    if (!/\\\s*$/.test(code)) inPwCommand = false;
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
    // assertion below passes over an empty set.
    //
    // Anchored to the NAME the whole file is about, never to a population size.
    // This used to be `PW_JOBS.length >= 4`, chosen when six jobs invoked
    // Playwright. The 2026-08-17 burn deleted behavioral-coverage and
    // behavioral-watchdog and took that to five — a vacuity floor one deletion
    // away from sitting ON its population, which is a ratchet whatever it was
    // in intent (CLAUDE.md, "NEVER hand-type a population count"). A name is
    // checkable against the artifact and cannot go stale by arithmetic.
    expect(
      PW_JOBS.map((j) => j.name),
      'the Playwright-job scan cannot see `e2e` — the scanner is broken, not the file',
    ).toContain('e2e');
    const noCeiling = PW_JOBS.filter((j) => j.ceilingMin === null).map((j) => j.name);
    expect(noCeiling.join(', '), 'a Playwright job has no timeout-minutes the scanner could read').toBe('');
    // The guard side needs its own floor: the ceiling scan above could be
    // perfect while the `--global-timeout` regex matched nothing at all.
    const guarded = PW_JOBS.filter((j) => j.guardsMs.length > 0).map((j) => j.name);
    expect(
      guarded.length,
      'the --global-timeout scan found ZERO guards — either every guard was deleted, ' +
        'or the flag was reformatted out of the scanner\'s reach (units in MILLISECONDS, ' +
        'on a backslash-continued line of the `playwright test` command).',
    ).toBeGreaterThanOrEqual(1);
  });

  it('every guard that IS set sits under its job ceiling with margin', () => {
    const bad: string[] = [];
    for (const j of PW_JOBS) {
      for (const ms of j.guardsMs) {
        const guardMin = ms / 60_000;
        const ceiling = j.ceilingMin!;
        if (guardMin > ceiling - MIN_MARGIN_MIN) {
          bad.push(
            `${j.name}: guard ${guardMin}m (${ms} ms) vs ceiling ${ceiling}m — needs ≤ ${ceiling - MIN_MARGIN_MIN}m. ` +
              (guardMin >= ceiling
                ? 'At or above the ceiling it can NEVER fire: the job dies first and takes the report with it.'
                : 'Too little room for checkout + artifact download + report upload.'),
          );
        }
      }
    }
    expect(bad.join('\n'), 'a --global-timeout cannot fire before its job is killed').toBe('');
  });

  it('the UNGUARDED Playwright jobs are declared, not silently absent', () => {
    // Guarding a lane is opt-in — but the SET of unguarded lanes is pinned, so
    // adding a Playwright job without deciding either way is red rather than
    // quiet. If you guard one of these, delete it here in the same commit.
    // This is ALSO the parser's negative control against the live file: a guard
    // regex that stops matching drops `e2e` back into this list and reddens.
    // Shrunk 2026-08-17: `behavioral-coverage` and `behavioral-watchdog` were
    // DELETED (informational lanes that could not block a merge), not guarded.
    // Derived from the surviving jobs, not edited by hand from the old list.
    const UNGUARDED = ['behavioral-smoke', 'collab', 'webgl-smoke'];
    const actual = PW_JOBS.filter((j) => j.guardsMs.length === 0).map((j) => j.name).sort();
    expect(
      actual,
      'the set of Playwright jobs running WITHOUT a global timeout changed. ' +
        'Each one can still die mute at its ceiling — that is a deliberate trade ' +
        '(a guard is another number that must track a ceiling it cannot see, and ' +
        'only the e2e shard runtime was ever measured), but it must be a CHOICE. ' +
        'Guard it, or add it here with a reason. If `e2e` appears here, the guard ' +
        'was removed OR the --global-timeout scan broke — check ci.yml before ' +
        'editing this list.',
    ).toEqual(UNGUARDED);
  });

  it('NEGATIVE CONTROL: the margin check actually fires', () => {
    // Every assertion above passes today. Prove the important one can fail —
    // otherwise "green" says nothing about whether it is looking.
    const rigged = parseJobs(
      [
        '  fake-job:',
        '    timeout-minutes: 10',
        '    steps:',
        '      - run: |',
        '          npx --workspace e2e playwright test \\',
        '            --global-timeout 900000 \\', // 15m guard under a 10m ceiling
        '            --reporter=blob',
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
      [
        '  fine-job:',
        '    timeout-minutes: 20',
        '    steps:',
        '      - run: |',
        '          npx --workspace e2e playwright test \\',
        '            --global-timeout 900000 \\',
        '            --reporter=blob',
      ].join('\n'),
    )[0];
    expect(ok.guardsMs).toEqual([900_000]);
    expect(ok.guardsMs[0] / 60_000 > ok.ceilingMin! - MIN_MARGIN_MIN).toBe(false);
  });
});
