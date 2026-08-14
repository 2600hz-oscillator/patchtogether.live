// scripts/e2e-report-audit.mjs
//
// Surface FLAKY and SKIPPED tests from a merged Playwright JSON report (#1502).
//
// ── The two ways a green e2e job hides information ────────────────────────
//
// 1. RECOVERED FLAKES. `e2e/playwright.config.ts` sets `retries: 1` on CI, so a
//    test that fails then passes is reported as `flaky` and the JOB IS GREEN.
//    The config's own comment names live examples riding green main runs. The
//    attest scripts refuse on flaky; the e2e lane does not.
// 2. RUNTIME SKIPS. `scripts/test-ledger.mjs` deliberately excludes in-body
//    `test.skip(cond, …)` guards — they are env gates, not disables — so the
//    generated ledger cannot see them. Nothing else parses results for
//    `skipped` either. A capability probe that starts skipping everywhere
//    (a SwiftShader change, a missing DB) goes dark silently.
//
// Both are the same shape: the run knows, and nobody is told.
//
// This was not hypothetical. The `camera-input` regression in #1559 failed on
// three consecutive runs and was noticed by a human reading logs, not by any
// gate — while `retries: 1` meant each occurrence still had a chance to pass
// and vanish.
//
// ── What this does ────────────────────────────────────────────────────────
//
// Reads a merged JSON report and prints every flaky and skipped test with its
// file, title and (for skips) the reason Playwright recorded. Exits non-zero
// only when `--fail-on-flaky` is passed, so reporting can land before the lane
// is hardened — fixing the known flakes first is the sequence the issue asks
// for, and a gate that reddens on day one would just be reverted.

import { readFileSync, writeFileSync } from 'node:fs';
import { budgetViolations, classifySkipRow, AUDITED_LANES } from './e2e-skip-budget.mjs';

/**
 * @typedef {Object} Row
 * @property {string} file
 * @property {string} title
 * @property {string} [reason]  annotation text for a skip, when present
 * @property {string} [class]   placeholder | annotated | anonymous (skips)
 * @property {number} [retries] attempts made, for a flaky row
 */

/**
 * Walk a Playwright JSON report and collect flaky + skipped tests.
 *
 * Shape note: `suites` nest arbitrarily; each `specs[].tests[]` carries a
 * `status` ('expected' | 'unexpected' | 'flaky' | 'skipped') plus `results[]`.
 * We key off `test.status` because that is what Playwright itself uses for the
 * run summary — the same field the HTML report's counts come from.
 *
 * @param {unknown} report
 * @returns {{ flaky: Row[], skipped: Row[], total: number }}
 */
export function auditReport(report) {
  /** @type {Row[]} */ const flaky = [];
  /** @type {Row[]} */ const skipped = [];
  let total = 0;

  const walk = (suites, file) => {
    for (const s of suites ?? []) {
      const f = s.file ?? file;
      for (const spec of s.specs ?? []) {
        for (const t of spec.tests ?? []) {
          total++;
          const title = spec.title ?? '';
          if (t.status === 'flaky') {
            flaky.push({ file: f ?? '', title, retries: (t.results ?? []).length });
          } else if (t.status === 'skipped') {
            // Playwright records a reason as an annotation DESCRIPTION — on
            // type 'skip' for `test.skip(cond, 'reason')`, on type 'fixme' for
            // `test.fixme(cond, 'reason')` AND for a declaration-level
            // `test.fixme(title, { annotation: { … } }, fn)` details object.
            // The bare modifier annotation ({ type } with no description) is
            // appended alongside a details-object one, so we take the first
            // annotation that actually carries text. Without any, the skip is
            // anonymous — exactly the case worth surfacing.
            const ann = (t.annotations ?? []).find(
              (a) => (a.type === 'skip' || a.type === 'fixme') && a.description,
            );
            const row = { file: f ?? '', title, reason: ann?.description ?? '(no reason given)' };
            skipped.push({ ...row, class: classifySkipRow(row) });
          }
        }
      }
      walk(s.suites, f);
    }
  };
  walk(report?.suites, undefined);

  const byFileTitle = (a, b) => (a.file + a.title < b.file + b.title ? -1 : 1);
  return { flaky: flaky.sort(byFileTitle), skipped: skipped.sort(byFileTitle), total };
}

/** Human-readable summary, suitable for $GITHUB_STEP_SUMMARY. */
export function formatSummary({ flaky, skipped, total }, violations = null) {
  const out = [];
  const placeholders = skipped.filter((r) => r.class === 'placeholder');
  const surfaced = skipped.filter((r) => r.class !== 'placeholder');
  out.push(`## e2e result audit`, '');
  out.push(
    `${total} test result(s) · **${flaky.length} flaky** · **${skipped.length} skipped** `
      + `(${placeholders.length} exemption placeholders · ${surfaced.length} runtime)`,
    '',
  );
  if (flaky.length) {
    out.push(`### Flaky — passed only on retry`, '');
    out.push(`A green job is hiding these. Each one failed at least once on this run.`, '');
    for (const r of flaky) out.push(`- \`${r.file}\` — ${r.title} _(${r.retries} attempts)_`);
    out.push('');
  }
  if (surfaced.length) {
    out.push(`### Skipped at runtime`, '');
    out.push(`Skips are not passes. A probe that starts skipping everywhere goes dark silently.`, '');
    for (const r of surfaced) out.push(`- \`${r.file}\` — ${r.title} — _${r.reason}_`);
    out.push('');
  }
  if (violations != null) {
    if (violations.length) {
      out.push(`### ✗ SKIP-BUDGET VIOLATIONS`, '');
      out.push(
        `Deny-by-default: every non-placeholder skip must match a NAMED (spec, reason) entry in `
          + `\`scripts/e2e-skip-budget.mjs\` for this lane.`,
        '',
      );
      for (const v of violations) out.push(`- \`${v.file}\` — ${v.title} — ${v.violation}`);
      out.push('');
    } else {
      out.push(`Skip budget: every runtime skip matches a named (spec, reason) entry. ✓`, '');
    }
  }
  if (!flaky.length && !skipped.length) out.push('No flaky or skipped tests. ✓');
  return out.join('\n');
}

const isMain = process.argv[1]?.endsWith('e2e-report-audit.mjs');
if (isMain) {
  const argv = process.argv.slice(2);
  const path = argv.find((a) => !a.startsWith('--'));
  if (!path) {
    throw new Error(
      'usage: e2e-report-audit.mjs <merged-report.json> [--lane <e2e|behavioral>] [--json-out <file>] [--fail-on-flaky]',
    );
  }
  const flagValue = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const lane = flagValue('--lane');
  if (lane !== undefined && !AUDITED_LANES.includes(lane)) {
    throw new Error(`--lane must be one of ${AUDITED_LANES.join('|')}, got '${lane}'`);
  }
  const audit = auditReport(JSON.parse(readFileSync(path, 'utf8')));
  // Without --lane the audit is report-only (the pre-budget behaviour); with it
  // the deny-by-default skip budget gates the lane's rows.
  const violations = lane !== undefined ? budgetViolations(audit.skipped, lane) : null;
  const summary = formatSummary(audit, violations);
  console.log(summary);
  const jsonOut = flagValue('--json-out');
  if (jsonOut) {
    // Machine-readable artifact: uploaded by ci.yml so a red audit is
    // inspectable without replaying the merge (#1502).
    writeFileSync(jsonOut, JSON.stringify({ lane: lane ?? null, ...audit, violations }, null, 2) + '\n');
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    // eslint-disable-next-line no-undef
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  }
  let fail = false;
  if (violations != null && violations.length > 0) {
    console.log(
      `::error::${violations.length} skip-budget violation(s) in lane '${lane}' — a runtime skip without a NAMED (spec, reason) budget entry. See scripts/e2e-skip-budget.mjs.`,
    );
    fail = true;
  }
  if (process.argv.includes('--fail-on-flaky') && audit.flaky.length > 0) {
    console.log(`::error::${audit.flaky.length} test(s) passed only on retry — a required lane must not go green on a recovered flake.`);
    fail = true;
  }
  if (fail) process.exit(1);
}
