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

// ── ⚠ DOOM IS EXCLUDED BY NAME FROM THE FLAKE GATE (#1903) ─────────────────
//
// Three DOOM tests recovered flakes in the 96 h census (#1847: doom-audio-output
// x4, doom-late-join x1, doom-mp-real x1) and were DELIBERATELY LEFT UNPARKED —
// the owner reserved them for their own decision. They are therefore live tests
// that would trip this gate.
//
// The reason is mechanical, not preference. `video/modules/doom.ts` calls
// `runtime.runTic()` inside `surface.draw`, and `runTic` runs exactly one
// `dgpt_tick`, so DOOM's game clock IS the frame clock: one rendered frame is
// one game tic. Anything that changes DOOM's timing re-specifies how far the
// marine walks, in a suite that then asserts on where he ended up. Standing
// owner ruling: "do not [touch] doom in any way without specific approval".
//
// ⚠ EXCLUDED FROM FAILING THE JOB, NOT FROM BEING REPORTED. A DOOM flake still
// prints, under its own heading naming the ruling. A silent exclusion is the
// failure mode even when the exclusion is correct.
//
// ⚠ AND IT IS A *FLAKE* CARVE-OUT ONLY — IT DOES NOT REACH THE SKIP BUDGET.
// `budgetViolations()` below never consults `isDoomReserved`, so a DOOM row that
// SKIPPED still reddens an audited lane. That distinction is load-bearing since
// #2294 armed `--lane collab`: the eleven two-peer DOOM multiplayer tests live
// on that lane, and "they all skipped because the WASM/WAD provisioning broke"
// is precisely the regression the lane must go red for. A flake is DOOM's timing
// being DOOM; a skip is DOOM not having run.
const DOOM_SPEC = /(^|\/)doom-[^/]*\.spec\.ts$/;

/** True when a row belongs to an owner-reserved DOOM spec. */
export function isDoomReserved(file) {
  return DOOM_SPEC.test(String(file ?? ''));
}

/**
 * Split flaky rows into the ones that GATE and the ones that are owner-reserved.
 * Exported so the gate and its tests call the SAME predicate — a control that
 * re-implements the split proves nothing about the split.
 */
export function partitionFlaky(flaky) {
  return {
    gating: (flaky ?? []).filter((r) => !isDoomReserved(r.file)),
    doomReserved: (flaky ?? []).filter((r) => isDoomReserved(r.file)),
  };
}

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
  const { gating, doomReserved } = partitionFlaky(flaky);
  if (gating.length) {
    out.push(`### ✗ FLAKY — passed only on retry`, '');
    out.push(
      `**This run is RED because of these.** Each one FAILED at least once and then `
        + `passed on a retry, on THIS commit. Without the gate the job would report `
        + `SUCCESS and the flake would merge — which is how #1875 and #1860 took \`main\` `
        + `red twice in one day after riding green PR runs.`,
      '',
    );
    for (const r of gating) {
      out.push(`- \`${r.file}\` — ${r.title} _(${r.retries} attempts)_`);
    }
    out.push('');
    out.push(
      `**Fix it, or park it (#1847) — never merge it, and never re-run until green.** `
        + `A retry that rescues a test is the same evidence the green runs before a break `
        + `provided. Parking is \`test.fixme\` with a NAMED reason plus its `
        + `\`scripts/e2e-skip-budget.mjs\` entry, so the debt is greppable and not anonymous.`,
      '',
    );
  }
  if (doomReserved.length) {
    out.push(`### ⏸ DOOM — flaky, reported, NOT gating (owner-reserved)`, '');
    out.push(
      `DOOM's game clock IS its frame clock, so a timing change re-specifies how far `
        + `the marine walks. Standing owner ruling: do not touch DOOM without specific `
        + `approval. These are printed so the exclusion is visible, never silent — they `
        + `do NOT fail this job.`,
      '',
    );
    for (const r of doomReserved) {
      out.push(`- \`${r.file}\` — ${r.title} _(${r.retries} attempts)_`);
    }
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
  // ── ⚠ WHAT THIS GATE STRUCTURALLY CANNOT SEE ────────────────────────────
  // Stated inside the gate, because an unstated scope reads as full coverage.
  // A green run here does NOT mean "this commit has no nondeterminism".
  out.push(
    '',
    '<sub>Flake-gate scope: this reads ONE report from ONE job. It cannot see — '
      + '(a) a flake that recovers across a whole-JOB re-run rather than a test retry, '
      + 'because that is a second report nothing compares to the first; '
      + '(b) a test killed by the job or global timeout, which reports as a hard '
      + 'failure or as nothing at all, never as `flaky`; '
      + '(c) a test that failed BOTH attempts — that is a red job on its own merits, not a flake; '
      + '(d) nondeterminism that happened to pass twice, which is the whole population this '
      + 'gate is blind to by construction; and '
      + '(e) any lane whose Playwright invocation does not run this audit — which is why '
      + '`scripts/ci-flake-gate.test.ts` denies that at the source.</sub>',
  );
  return out.join('\n');
}

const isMain = process.argv[1]?.endsWith('e2e-report-audit.mjs');
if (isMain) {
  const argv = process.argv.slice(2);
  const path = argv.find((a) => !a.startsWith('--'));
  if (!path) {
    throw new Error(
      `usage: e2e-report-audit.mjs <merged-report.json> [--lane <${AUDITED_LANES.join('|')}>] `
        + '[--json-out <file>] [--fail-on-flaky]',
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
  if (process.argv.includes('--fail-on-flaky')) {
    const { gating, doomReserved } = partitionFlaky(audit.flaky);
    // One annotation PER TEST, not one for the population: a count tells you
    // there is a problem, a name tells you whose it is. GitHub surfaces these
    // on the job page, so the roster is readable without opening an artifact.
    for (const r of gating) {
      console.log(
        `::error file=${r.file}::FLAKE (${r.retries} attempts) — "${r.title}" failed then `
          + `passed on retry. Fix it or park it per #1847; never merge a flake.`,
      );
    }
    for (const r of doomReserved) {
      console.log(
        `::notice file=${r.file}::DOOM flake (${r.retries} attempts) — "${r.title}". `
          + `Owner-reserved, NOT gating. Do not touch DOOM without specific approval.`,
      );
    }
    if (gating.length > 0) {
      console.log(
        `::error::${gating.length} test(s) passed only on retry — a lane must not go `
          + `green on a recovered flake (#1903).`,
      );
      fail = true;
    }
  }
  if (fail) process.exit(1);
}
