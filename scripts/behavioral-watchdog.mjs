#!/usr/bin/env node
// scripts/behavioral-watchdog.mjs
//
// The aggregation + diff brain for the PUSH-ONLY `behavioral-watchdog` CI job
// (.github/workflows/ci.yml). The YAML stays THIN — download artifacts, merge
// blobs → JSON, re-run failing rows, open the issue — and delegates every
// non-trivial decision to the pure functions here so they can be UNIT-TESTED
// (scripts/behavioral-watchdog.test.ts) without a live CI run.
//
// Why this exists
// ---------------
// The `behavioral-coverage` job is `continue-on-error: true` (an informational
// tuning lane), so its GitHub JOB CONCLUSION always reports success even when
// real per-module behavioral assertions FAILED. A green umbrella therefore
// LIES about behavioral health. This watchdog reads the REAL result out of each
// shard's Playwright report, diffs it against a "last-green" baseline, re-runs
// only the failing rows once to reject infra blips (LFS-502 / SwiftShader
// timeouts), and — on a REPRODUCED regression of a previously-green module —
// screams (p0 issue + the existing email alert path) and exits non-zero, with
// an OPTIONAL, default-OFF auto-rollback PR.
//
// For collab it can't re-derive multi-user health from a hash gate, so it
// asserts the committed @collab attestation was produced with a REAL DATABASE
// (`databaseConfirmed: true`) — a green attestation built WITHOUT a DB is
// VACUOUS (memory `feedback_collab_tests_vacuous_without_db`) and gets flagged.
//
// CLI (invoked by ci.yml; all IO lives in the thin subcommands, all logic in
// the exported pure functions):
//
//   node scripts/behavioral-watchdog.mjs aggregate \
//        --behavioral <merged-report.json> [--collab <attestation.json>] \
//        [--baseline <last-green.json>]
//     → parse behavioral + collab, diff vs baseline → CANDIDATE newly-failing
//       (pre-reproduction). Writes GITHUB_OUTPUT + prints a JSON summary.
//
//   node scripts/behavioral-watchdog.mjs confirm \
//        --candidates "<space-separated ids>" --rerun <rerun-report.json>
//     → reproduced newly-failing = candidates ∩ (modules that failed AGAIN in
//       the targeted re-run). Writes GITHUB_OUTPUT.
//
//   node scripts/behavioral-watchdog.mjs snapshot \
//        --behavioral <merged-report.json> --out <last-green.json> [--sha <sha>]
//     → write the fresh last-green baseline (passing/failing module sets) for
//       the next run to diff against. Only called on a NON-firing run.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The behavioral per-module specs are titled
//   `<moduleType>: each declared input perturbs the module's observable output …`
// (per-module-per-port-behavioral.spec.ts). This marker distinguishes them from
// the sibling `RATCHET:` housekeeping test in the same file and from any future
// non-per-module test, so the aggregator only ever counts real module rows.
export const BEHAVIORAL_TITLE_MARK = 'each declared input perturbs';

// ───────────────────────── pure: behavioral report ─────────────────────────

/**
 * Recursively collect every spec object from a Playwright JSON report, at any
 * suite-nesting depth. Returns the raw spec objects (each has `.title`,
 * `.ok`, `.tests[]`).
 * @param {any} report a parsed Playwright JSON report (`--reporter json` or
 *   `merge-reports --reporter json`), OR a bare `{ suites: [...] }`.
 * @returns {any[]}
 */
export function collectSpecs(report) {
  const out = [];
  const walk = (suite) => {
    if (!suite || typeof suite !== 'object') return;
    for (const spec of suite.specs ?? []) out.push(spec);
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report?.suites ?? []) walk(suite);
  return out;
}

/** Module id = the text before the first `:` in a behavioral spec title. */
export function moduleIdFromTitle(title) {
  if (typeof title !== 'string') return null;
  const idx = title.indexOf(':');
  if (idx === -1) return null;
  const id = title.slice(0, idx).trim();
  return id.length ? id : null;
}

/**
 * Classify a single Playwright spec as passed | failed | skipped.
 * Playwright per-test `status` ∈ 'skipped' | 'expected' | 'unexpected' |
 * 'flaky'. A spec that passed on retry ('flaky') is NOT a failure. We fall back
 * to the spec-level `ok` boolean when a report omits per-test statuses.
 * @returns {'passed'|'failed'|'skipped'}
 */
export function specOutcome(spec) {
  const tests = spec?.tests ?? [];
  const statuses = tests.map((t) => t?.status).filter(Boolean);
  if (statuses.length === 0) {
    return spec?.ok === false ? 'failed' : 'passed';
  }
  if (statuses.every((s) => s === 'skipped')) return 'skipped';
  if (statuses.some((s) => s === 'unexpected')) return 'failed';
  return 'passed'; // 'expected' or 'flaky' (recovered on retry)
}

/**
 * Parse a Playwright JSON report into the behavioral pass/fail picture.
 * Only specs whose title carries {@link BEHAVIORAL_TITLE_MARK} count. Skipped
 * rows (test.fixme exemptions) are excluded from BOTH the passed and failed
 * sets — they aren't evidence either way.
 * @returns {{ passed: boolean, total: number,
 *             passedModules: string[], failedModules: string[],
 *             skippedModules: string[] }}
 */
export function parseBehavioralReport(report) {
  const passed = new Set();
  const failed = new Set();
  const skipped = new Set();
  for (const spec of collectSpecs(report)) {
    const title = spec?.title;
    if (typeof title !== 'string' || !title.includes(BEHAVIORAL_TITLE_MARK)) continue;
    const id = moduleIdFromTitle(title);
    if (!id) continue;
    const outcome = specOutcome(spec);
    if (outcome === 'failed') failed.add(id);
    else if (outcome === 'skipped') skipped.add(id);
    else passed.add(id);
  }
  // A module that has BOTH a passing and a failing row (shouldn't happen — one
  // row per module — but be defensive) is treated as FAILED: any failure wins.
  for (const id of failed) passed.delete(id);
  const sortu = (s) => [...s].sort();
  return {
    passed: failed.size === 0,
    total: passed.size + failed.size,
    passedModules: sortu(passed),
    failedModules: sortu(failed),
    skippedModules: sortu(skipped),
  };
}

// ───────────────────────── pure: collab attestation ────────────────────────

/**
 * Parse the committed @collab attestation. The one robust signal we can assert
 * from CI is `databaseConfirmed` — that the owner's local attest run used a
 * REAL Postgres. A green attestation with `databaseConfirmed !== true` is
 * VACUOUS: the @collab lane proved nothing about multi-user behaviour.
 * @param {any|null} att parsed `ci-collab-attest/<hash>.json`, or null if none.
 * @returns {{ present: boolean, dbPresent: boolean, vacuous: boolean,
 *             passed: boolean, failed: (number|null), reason: string }}
 */
export function parseCollabAttestation(att) {
  if (!att || typeof att !== 'object') {
    return {
      present: false,
      dbPresent: false,
      vacuous: true,
      passed: false,
      failed: null,
      reason: 'no collab attestation file for the current collab content hash',
    };
  }
  const dbPresent = att.databaseConfirmed === true;
  const run = att.run && typeof att.run === 'object' ? att.run : {};
  const failed = typeof run.failed === 'number' ? run.failed : null;
  const ranTests = typeof run.passed === 'number' ? run.passed : 0;
  const passed = dbPresent && failed === 0 && ranTests > 0;
  let reason = 'ok';
  if (!dbPresent) reason = 'attestation produced WITHOUT a real DATABASE (databaseConfirmed !== true) → @collab ran VACUOUS';
  else if (failed && failed > 0) reason = `attestation records ${failed} failed @collab spec(s)`;
  else if (ranTests === 0) reason = 'attestation records zero passed @collab specs';
  return { present: true, dbPresent, vacuous: !dbPresent, passed, failed, reason };
}

// ───────────────────────── pure: diff vs last-green ─────────────────────────

/**
 * Newly-failing = a module that was GREEN at the last-green baseline and now
 * fails. We deliberately EXCLUDE:
 *   • chronic tolerated reds (in `baseline.failing`) — the informational lane
 *     has known-failing modules (grids/sequencer/adsr/…); those aren't news, and
 *   • never-observed / brand-new modules (not in `baseline.passing`) — a new
 *     module's own PR gates cover it; the watchdog only guards REGRESSIONS.
 * This keeps false-positives ≈ 0, which matters because a false p0 here could
 * trigger an auto-rollback of main.
 * @param {string[]} currentFailed
 * @param {{passing?: string[], failing?: string[]}|null} baseline
 * @returns {string[]}
 */
export function diffNewlyFailing(currentFailed, baseline) {
  const wasGreen = new Set(baseline?.passing ?? []);
  const wasRed = new Set(baseline?.failing ?? []);
  return [...new Set(currentFailed)].filter((m) => wasGreen.has(m) && !wasRed.has(m)).sort();
}

/**
 * Reproduced set = candidates that FAILED AGAIN in the targeted re-run. A break
 * counts only if it reproduces (rejects LFS-502 / SwiftShader-timeout blips).
 * @param {string[]} candidates the newly-failing candidates from the first pass
 * @param {string[]} rerunFailed modules that failed in the re-run report
 * @returns {string[]}
 */
export function reproducedFailures(candidates, rerunFailed) {
  const again = new Set(rerunFailed);
  return [...new Set(candidates)].filter((m) => again.has(m)).sort();
}

/** Build a Playwright `--grep` regex that selects exactly these module rows. */
export function buildGrep(modules) {
  const ids = [...new Set(modules)].filter(Boolean);
  if (ids.length === 0) return '';
  const escaped = ids.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Titles are `<id>: each declared input perturbs …`; anchor on the marker so
  // a short id can't accidentally match a longer id's title as a substring.
  return `(${escaped.join('|')}): ${BEHAVIORAL_TITLE_MARK}`;
}

// ───────────────────────────── CLI plumbing ────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    }
  }
  return args;
}

function readJsonOrNull(path) {
  if (!path || path === true) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    console.error(`[behavioral-watchdog] could not read/parse ${path}: ${e.message}`);
    return null;
  }
}

/** Append `key=value` lines to $GITHUB_OUTPUT when running under Actions. */
function setOutputs(kv) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const lines = Object.entries(kv)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');
  writeFileSync(file, lines + '\n', { flag: 'a' });
}

function cmdAggregate(args) {
  const behavioral = parseBehavioralReport(readJsonOrNull(args.behavioral) ?? {});
  const collab = parseCollabAttestation(readJsonOrNull(args.collab));
  const baseline = readJsonOrNull(args.baseline); // may be null (bootstrap)
  const candidates = diffNewlyFailing(behavioral.failedModules, baseline);

  const summary = {
    behavioral_passed: behavioral.passed,
    behavioral_total: behavioral.total,
    failed_modules: behavioral.failedModules,
    passed_modules: behavioral.passedModules,
    candidate_newly_failing: candidates,
    baseline_present: baseline != null,
    collab,
  };
  console.log(JSON.stringify(summary, null, 2));

  setOutputs({
    behavioral_passed: String(behavioral.passed),
    failed_count: String(behavioral.failedModules.length),
    failed_modules: behavioral.failedModules.join(' '),
    candidate_count: String(candidates.length),
    candidate_modules: candidates.join(' '),
    candidate_grep: buildGrep(candidates),
    collab_db_present: String(collab.dbPresent),
    collab_vacuous: String(collab.vacuous),
    collab_passed: String(collab.passed),
    collab_reason: collab.reason,
  });
  return 0;
}

function cmdConfirm(args) {
  const candidates = String(args.candidates === true ? '' : args.candidates || '')
    .split(/\s+/)
    .filter(Boolean);
  const rerun = parseBehavioralReport(readJsonOrNull(args.rerun) ?? {});
  const reproduced = reproducedFailures(candidates, rerun.failedModules);
  const summary = {
    candidates,
    rerun_failed: rerun.failedModules,
    newly_failing: reproduced, // reproduced regressions of previously-green modules
  };
  console.log(JSON.stringify(summary, null, 2));
  setOutputs({
    newly_failing: reproduced.join(' '),
    newly_failing_count: String(reproduced.length),
  });
  return 0;
}

function cmdSnapshot(args) {
  const behavioral = parseBehavioralReport(readJsonOrNull(args.behavioral) ?? {});
  const out = {
    sha: args.sha === true || !args.sha ? null : args.sha,
    updatedAt: new Date().toISOString(),
    passing: behavioral.passedModules,
    failing: behavioral.failedModules,
  };
  const dest = args.out === true || !args.out ? 'ci/behavioral-last-green.json' : args.out;
  writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
  console.log(`[behavioral-watchdog] wrote baseline → ${dest} (${out.passing.length} green, ${out.failing.length} red)`);
  return 0;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  switch (cmd) {
    case 'aggregate': return cmdAggregate(args);
    case 'confirm': return cmdConfirm(args);
    case 'snapshot': return cmdSnapshot(args);
    default:
      console.error(`usage: behavioral-watchdog.mjs <aggregate|confirm|snapshot> [--flags]`);
      return 2;
  }
}

// Only run the CLI when executed directly — importing for unit tests must be a
// no-op (no argv parsing, no process.exit).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
