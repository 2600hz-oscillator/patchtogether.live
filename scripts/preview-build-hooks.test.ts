// scripts/preview-build-hooks.test.ts
//
// A PREVIEW-SERVING LANE THAT BUILDS ITS OWN BUNDLE MUST BAKE THE TEST HOOKS.
//
// `VITE_E2E_HOOKS=1` is a Vite BUILD-time var. Without it, a prod build
// tree-shakes out the `__attachProvider` / `__ensureEngine` / `__patch`
// window globals (packages/web/src/lib/dev/test-hooks.ts), and every
// hook-driven spec hangs its FULL test budget in
// `waitForFunction(() => typeof window.__attachProvider === 'function')`
// with the app looking perfectly healthy in the page snapshot.
//
// Measured, #1500 (2026-08-13): collab-nightly.yml ran `task build:web`
// without the flag from its birth (#798, 2026-06-15). Every @collab spec
// hung 120 s + one retry ≈ 4 min/spec, so every shard needed ~52+ min of
// pure timeouts, the 30-min ceiling killed all four shards every night, and
// the workflow NEVER ONCE ran green — 6 `failure` conclusions then 57
// consecutive timeout-`cancelled`s. The same specs took 4m28s total in
// ci.yml's collab job the same day, because ci.yml's build-web bakes the
// flag. Taskfile `e2e:serve` had — and fixed — the identical bug locally.
// This was the THIRD copy of the same defect: the invariant lives in three
// files that cannot see each other, so it gets an assertion.
//
// THE RULE (derived from the artifact, not a hand-kept list): in EVERY
// workflow, a job that serves the preview bundle to Playwright
// (`E2E_USE_PREVIEW: '1'`) and builds that bundle INLINE (`task build:web`)
// must set `VITE_E2E_HOOKS: '1'` in the same job. A future nightly-shaped
// workflow born without the flag reds this test at PR time instead of
// timing out silently every night for two months.
//
// Also asserted, same seam, other side: the ci.yml job that PRODUCES the
// shared `web-preview-dist` artifact must bake the flag, because its
// consumers (the e2e shards + collab job) download the bundle and are
// structurally blind to how it was built.
//
// And the alert that #1500 proved blind: collab-nightly's `alert` job must
// fire on `!success()`. `if: failure()` cannot see a `timeout-minutes`
// kill — that concludes `cancelled` — so a lane whose primary observed
// failure mode IS the timeout-cancel alerted zero times in 57 dead nights.
// (Cancellation `if:` semantics are per-job and deliberate: merge-reports
// is `!cancelled()` (#1581), the vrt-strict aggregator is `always()`+exit 1.
// This one is an ALERT: anything not green must page.)
//
// ── WHAT THIS GATE CANNOT SEE (stated, per the blind-gates rule) ──────────
//  · Flag attribution is JOB-scoped, not step-scoped: a job with two web
//    builds where only one is flagged reads as safe. No such job exists
//    today; the hole is empty but it is a hole.
//  · A job that gets its bundle from anywhere OTHER than `task build:web`
//    inline or the web-preview-dist artifact (a new artifact name, a raw
//    `npm run build -w`) is outside the scan. Taskfile e2e:serve's own
//    `npm run build` is covered by its inline `VITE_E2E_HOOKS=1` prefix and
//    is not re-checked here.
//  · Whether the baked hooks actually WORK is the specs' job; this only
//    proves the build was asked to include them.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');

interface JobScan {
  file: string;
  job: string;
  servesPreview: boolean;
  buildsWebInline: boolean;
  bakesHooks: boolean;
  /** every `if:` expression on the job itself (first `if:` after the job line, before steps) */
  jobIf: string | null;
}

/**
 * Text scanner, deliberately not a YAML load (house convention — see
 * ci-playwright-timeout.test.ts): it must read inside `run: |` blocks and
 * survive `${{ }}` expressions. Comment lines are stripped FIRST so prose
 * about a flag can never be mistaken for the flag.
 */
export function scanJobs(file: string, src: string): JobScan[] {
  const jobs: JobScan[] = [];
  let cur: JobScan | null = null;
  let inSteps = false;
  for (const raw of src.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^\s*#/.test(line)) continue; // comments are not code
    const jobStart = /^ {2}([a-z0-9][a-z0-9_-]*):\s*$/.exec(line);
    if (jobStart) {
      if (cur) jobs.push(cur);
      cur = {
        file,
        job: jobStart[1],
        servesPreview: false,
        buildsWebInline: false,
        bakesHooks: false,
        jobIf: null,
      };
      inSteps = false;
      continue;
    }
    if (!cur) continue;
    if (/^ {4}steps:\s*$/.test(line)) inSteps = true;
    const ifLine = /^ {4}if:\s*(.+?)\s*$/.exec(line);
    if (ifLine && !inSteps && cur.jobIf === null) cur.jobIf = ifLine[1];
    if (/E2E_USE_PREVIEW:\s*['"]?1['"]?/.test(line)) cur.servesPreview = true;
    if (/task build:web\b/.test(line)) cur.buildsWebInline = true;
    if (/VITE_E2E_HOOKS:\s*['"]?1['"]?/.test(line)) cur.bakesHooks = true;
  }
  if (cur) jobs.push(cur);
  return jobs;
}

/** The predicate the gate AND its negative control both call. */
export function hookOffenders(jobs: JobScan[]): JobScan[] {
  return jobs.filter((j) => j.servesPreview && j.buildsWebInline && !j.bakesHooks);
}

const ALL_JOBS: JobScan[] = readdirSync(WORKFLOWS_DIR)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .flatMap((f) => scanJobs(f, readFileSync(join(WORKFLOWS_DIR, f), 'utf8')));

describe('preview-serving lanes bake the E2E hooks at build time', () => {
  it('the scan is not vacuous — it can see the jobs that motivated it', () => {
    // ⚠ A bare green over an empty set is indistinguishable from a broken
    // parser. Anchor to the two artifacts this gate exists for: the job shape
    // that produced #1500, and the shared-bundle producer in ci.yml.
    const nightly = ALL_JOBS.find((j) => j.file === 'collab-nightly.yml' && j.job === 'collab-shard');
    expect(nightly, 'collab-nightly.yml collab-shard not found — the scanner or the workflow moved').toBeDefined();
    expect(nightly!.servesPreview, 'collab-shard no longer reads as E2E_USE_PREVIEW — scanner broken or lane redesigned').toBe(true);
    expect(nightly!.buildsWebInline, 'collab-shard no longer reads as building web inline — scanner broken or lane redesigned').toBe(true);
  });

  it('every job that serves preview AND builds web inline bakes VITE_E2E_HOOKS (units: build-time env, not runtime)', () => {
    const offenders = hookOffenders(ALL_JOBS).map((j) => `${j.file} → ${j.job}`);
    expect(
      offenders,
      'these jobs build the preview bundle WITHOUT VITE_E2E_HOOKS=1: every ' +
        'hook-driven spec they run will hang its full test budget waiting for ' +
        'window.__attachProvider (the #1500 signature: healthy page snapshot, ' +
        '"Test timeout of 120000ms exceeded", every shard timeout-cancelled). ' +
        'Add VITE_E2E_HOOKS: \'1\' to the build step env.',
    ).toEqual([]);
  });

  it('the web-preview-dist PRODUCER bakes the hooks its consumers cannot check', () => {
    // The e2e shards + collab job download this artifact; a gate that read
    // only the consumers would prove nothing about the build (two-sided
    // contract, one side asserted here at the producer).
    const ciSrc = readFileSync(join(WORKFLOWS_DIR, 'ci.yml'), 'utf8');
    const producer = scanJobs('ci.yml', ciSrc).find((j) => j.job === 'build-web');
    expect(producer, 'ci.yml build-web job not found — if it was renamed, re-point this and the consumers').toBeDefined();
    expect(
      producer!.bakesHooks,
      'ci.yml build-web no longer sets VITE_E2E_HOOKS=1 — every preview-consuming ' +
        'Playwright lane (e2e shards, collab) would hang exactly like #1500.',
    ).toBe(true);
  });

  it("collab-nightly's alert fires on !success(), not the cancellation-blind failure()", () => {
    const alert = ALL_JOBS.find((j) => j.file === 'collab-nightly.yml' && j.job === 'alert');
    expect(alert, 'collab-nightly.yml alert job not found — a nightly without an alert path rots unwatched (#1500)').toBeDefined();
    expect(
      alert!.jobIf ?? '',
      'the alert must fire on ANY non-green nightly. A job killed by its own ' +
        'timeout-minutes concludes `cancelled`, not `failure`, so `if: failure()` ' +
        'was structurally blind to the hung-shard case — 57 dead nights, zero ' +
        'alerts (#1500).',
    ).toMatch(/!\s*success\(\)/);
  });

  it('NEGATIVE CONTROL: the hook check catches the #1500 shape (and clears the fixed one)', () => {
    // Permanent both-directions control calling the SAME predicate the gate
    // calls — a scanner that stops seeing the defect must fail here, loudly,
    // instead of greening over it.
    const rigged = (hooksLine: string) =>
      scanJobs(
        'rigged.yml',
        [
          '  nightly-shape:',
          '    runs-on: ubuntu-latest',
          '    env:',
          "      E2E_USE_PREVIEW: '1'",
          '    steps:',
          '      - name: Build web',
          ...(hooksLine ? ['        env:', `          ${hooksLine}`] : []),
          '        run: flox activate -- task build:web',
        ].join('\n'),
      );
    const broken = rigged('');
    expect(hookOffenders(broken).map((j) => j.job)).toEqual(['nightly-shape']);
    const fixed = rigged("VITE_E2E_HOOKS: '1'");
    expect(hookOffenders(fixed)).toEqual([]);
  });

  it('NEGATIVE CONTROL: the alert-if check would catch a regression to failure()', () => {
    const rigged = scanJobs(
      'rigged.yml',
      ['  alert:', '    runs-on: ubuntu-latest', '    needs: collab-shard', '    if: failure()', '    steps:', '      - run: echo page'].join('\n'),
    );
    const alert = rigged.find((j) => j.job === 'alert')!;
    expect(alert.jobIf).toBe('failure()');
    expect(/!\s*success\(\)/.test(alert.jobIf!)).toBe(false); // the blind form fails the live assertion's pattern
  });
});
