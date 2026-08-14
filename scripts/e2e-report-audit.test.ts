// scripts/e2e-report-audit.test.ts
//
// Guards the flaky/skip surfacing (#1502).
//
// The thing being defended: a green e2e job currently hides two classes —
// tests that passed only on retry (`retries: 1` on CI), and tests that skipped
// at runtime. Both are invisible to every existing gate. So the audit must
// actually FIND them; an auditor that reports "0 flaky" on a report containing
// flakes is worse than none, because it converts an unknown into a false
// assurance.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// @ts-expect-error — plain .mjs with JSDoc types, no declaration file
import { auditReport, formatSummary } from './e2e-report-audit.mjs';

/** A minimal report in Playwright's real JSON shape, incl. nested suites. */
const report = {
  suites: [
    {
      file: 'a.spec.ts',
      specs: [
        { title: 'passes', tests: [{ status: 'expected', results: [{}] }] },
        { title: 'recovers on retry', tests: [{ status: 'flaky', results: [{}, {}] }] },
        {
          title: 'gated on a DB',
          tests: [{ status: 'skipped', annotations: [{ type: 'skip', description: 'needs DATABASE_URL' }] }],
        },
      ],
      suites: [
        {
          file: 'b.spec.ts',
          specs: [
            { title: 'nested flake', tests: [{ status: 'flaky', results: [{}, {}] }] },
            { title: 'anonymous skip', tests: [{ status: 'skipped' }] },
          ],
        },
      ],
    },
  ],
};

describe('the audit finds what a green job hides', () => {
  const audit = auditReport(report);

  it('finds flaky tests, including in NESTED suites', () => {
    // Nesting matters: a walker that only reads the top level would miss most
    // of a real report and still print a confident "0 flaky".
    expect(audit.flaky.map((r: { title: string }) => r.title).sort()).toEqual([
      'nested flake',
      'recovers on retry',
    ]);
  });

  it('finds runtime skips and carries their REASON', () => {
    const reasons = Object.fromEntries(
      audit.skipped.map((r: { title: string; reason: string }) => [r.title, r.reason]),
    );
    expect(reasons['gated on a DB']).toBe('needs DATABASE_URL');
    // An unexplained skip is the more suspicious kind, so it must not be
    // silently rendered as blank.
    expect(reasons['anonymous skip']).toBe('(no reason given)');
  });

  it('does not mistake a passing test for either', () => {
    expect(audit.flaky.some((r: { title: string }) => r.title === 'passes')).toBe(false);
    expect(audit.skipped.some((r: { title: string }) => r.title === 'passes')).toBe(false);
    expect(audit.total).toBe(5);
  });

  it('reports cleanly when there is nothing to report', () => {
    const clean = auditReport({ suites: [{ file: 'x.spec.ts', specs: [{ title: 'ok', tests: [{ status: 'expected' }] }] }] });
    expect(clean.flaky).toEqual([]);
    expect(formatSummary(clean)).toContain('No flaky or skipped tests');
  });

  it('names every finding in the summary — a count alone is not actionable', () => {
    const s = formatSummary(audit);
    expect(s).toContain('recovers on retry');
    expect(s).toContain('nested flake');
    expect(s).toContain('needs DATABASE_URL');
  });

  it('survives an empty or malformed report rather than throwing', () => {
    // A crash here would take down the merge-reports job for a reporting step,
    // which is a worse outcome than saying nothing.
    expect(auditReport({}).total).toBe(0);
    expect(auditReport({ suites: [] }).total).toBe(0);
  });
});

// ── THE GATE ITSELF, EXERCISED BEFORE IT IS ARMED ──────────────────────────
//
// `--fail-on-flaky` is the switch ci.yml will eventually pass, and until it
// does, NOTHING runs this code path — the flag was added, tested by eye and
// left dark. That is the shape CLAUDE.md warns about: "a gate that cannot fail
// on CI is decoration", and the day it IS armed is the worst day to discover
// the exit code never worked.
//
// So this drives the real CLI, in a subprocess, on both sides of the decision:
// the same fixture must exit 1 with the flag and 0 without it, and exit 0 with
// the flag when there is nothing to find. A one-sided check ("it exits 1")
// would pass just as happily on a script that always exits 1.
describe('the --fail-on-flaky exit path (armed by ci.yml only after the tail is drained)', () => {
  const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'e2e-report-audit.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'e2e-audit-'));

  const withFlake = join(dir, 'flaky.json');
  writeFileSync(
    withFlake,
    JSON.stringify({
      suites: [
        {
          file: 'a.spec.ts',
          specs: [
            { title: 'ok', tests: [{ status: 'expected', results: [{}] }] },
            { title: 'recovers on retry', tests: [{ status: 'flaky', results: [{}, {}] }] },
          ],
        },
      ],
    }),
  );

  const clean = join(dir, 'clean.json');
  writeFileSync(
    clean,
    JSON.stringify({
      suites: [{ file: 'a.spec.ts', specs: [{ title: 'ok', tests: [{ status: 'expected', results: [{}] }] }] }],
    }),
  );

  /** @returns the process exit status and its combined output. */
  const run = (args: string[]): { code: number; out: string } => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' }) };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  };

  it('FAILS the process on a recovered flake, and names it', () => {
    const { code, out } = run([withFlake, '--fail-on-flaky']);
    expect(code, `the CLI must exit non-zero. Output:\n${out}`).toBe(1);
    expect(out).toContain('recovers on retry');
    // The annotation is what turns a red job into a red LINE in the GitHub UI.
    expect(out).toContain('::error::');
  });

  it('NEGATIVE CONTROL (flag off): the same report is report-only', () => {
    // This is the state ci.yml is in today. If this ever starts failing, the
    // lane has been armed by accident rather than by decision.
    const { code, out } = run([withFlake]);
    expect(code, `report-only must not fail the job. Output:\n${out}`).toBe(0);
    expect(out).toContain('recovers on retry');
  });

  it('NEGATIVE CONTROL (nothing to find): the flag alone does not fail a clean run', () => {
    const { code, out } = run([clean, '--fail-on-flaky']);
    expect(code, `a clean report must pass even when armed. Output:\n${out}`).toBe(0);
    expect(out).toContain('No flaky or skipped tests');
  });
});

// ── #1502 remainder: reason resolution + the per-lane skip budget CLI ───────

describe('reason resolution reads BOTH annotation types, and classifies rows', () => {
  const r = auditReport({
    suites: [
      {
        file: 'q.spec.ts',
        specs: [
          {
            // declaration fixme with a details-object annotation: Playwright
            // appends the bare modifier annotation ({type:'fixme'} with no
            // description) ALONGSIDE the described one — measured on 1.59.1.
            title: 'quarantined with details annotation',
            tests: [{
              status: 'skipped',
              annotations: [
                { type: 'fixme', description: 'task #999: quarantined for the probe' },
                { type: 'fixme' },
              ],
            }],
          },
          {
            title: 'runtime fixme guard',
            tests: [{ status: 'skipped', annotations: [{ type: 'fixme', description: 'renderer says no' }] }],
          },
          {
            title: 'sweep row [SKIPPED: exempt — see map]',
            tests: [{ status: 'skipped', annotations: [{ type: 'fixme' }] }],
          },
        ],
      },
    ],
  });
  const byTitle = Object.fromEntries(
    audit_rows(r).map((x: { title: string; reason: string; class: string }) => [x.title, x]),
  );
  function audit_rows(a: { skipped: unknown[] }) { return a.skipped as { title: string; reason: string; class: string }[]; }

  it('takes the described annotation over the bare modifier one (fixme included)', () => {
    expect(byTitle['quarantined with details annotation']!.reason).toBe('task #999: quarantined for the probe');
    expect(byTitle['runtime fixme guard']!.reason).toBe('renderer says no');
  });

  it('classifies title-marker placeholders as out of budget scope, described rows as annotated', () => {
    expect(byTitle['sweep row [SKIPPED: exempt — see map]']!.class).toBe('placeholder');
    expect(byTitle['quarantined with details annotation']!.class).toBe('annotated');
  });
});

describe('the --lane skip-budget exit path (armed in merge-reports + merge-behavioral-reports)', () => {
  const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'e2e-report-audit.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'e2e-audit-lane-'));

  const skipReport = (reason: string | null) => ({
    suites: [
      {
        file: 'es9-hardware.spec.ts',
        specs: [
          {
            title: 'connects to the real bridge and reports the ES-9',
            tests: [{
              status: 'skipped',
              annotations: reason ? [{ type: 'skip', description: reason }] : [{ type: 'skip' }],
            }],
          },
        ],
      },
    ],
  });

  const run = (args: string[]): { code: number; out: string } => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' }) };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  };

  const budgeted = join(dir, 'budgeted.json');
  writeFileSync(
    budgeted,
    JSON.stringify(skipReport('hardware-in-the-loop: needs a real ES-9 + es9-bridge on ws://127.0.0.1:9209 (opt in with ES9_HW=1)')),
  );
  const anonymous = join(dir, 'anonymous.json');
  writeFileSync(anonymous, JSON.stringify(skipReport(null)));
  const unknown = join(dir, 'unknown.json');
  writeFileSync(unknown, JSON.stringify(skipReport('a reason the budget has never heard of')));

  it('exits 0 on a budgeted (spec, reason) row in its lane, and says the budget held', () => {
    const { code, out } = run([budgeted, '--lane', 'e2e']);
    expect(code, `budgeted skip must not fail the lane. Output:\n${out}`).toBe(0);
    expect(out).toContain('Skip budget: every runtime skip matches a named');
  });

  it('exits 1 on a reasonless row, with the ::error:: annotation naming the budget', () => {
    const { code, out } = run([anonymous, '--lane', 'e2e']);
    expect(code, `an anonymous skip must red the lane audit. Output:\n${out}`).toBe(1);
    expect(out).toContain('::error::');
    expect(out).toContain('reasonless skip');
  });

  it('exits 1 on an unknown reason; NEGATIVE CONTROL: without --lane the same report is report-only', () => {
    expect(run([unknown, '--lane', 'e2e']).code).toBe(1);
    // Same file, no lane: the pre-budget report-only behaviour is preserved.
    const { code, out } = run([unknown]);
    expect(code, `report-only must not fail. Output:\n${out}`).toBe(0);
  });

  it('writes the machine-readable artifact (with violations) even when exiting 1', () => {
    const jsonOut = join(dir, 'audit-out.json');
    const { code } = run([anonymous, '--lane', 'e2e', '--json-out', jsonOut]);
    expect(code).toBe(1);
    const parsed = JSON.parse(readFileSync(jsonOut, 'utf8'));
    expect(parsed.lane).toBe('e2e');
    expect(parsed.violations.length).toBe(1);
    expect(parsed.violations[0].violation).toMatch(/reasonless/);
  });

  it('rejects an unknown --lane loudly instead of auditing against nothing', () => {
    const { code, out } = run([budgeted, '--lane', 'vrt']);
    expect(code).not.toBe(0);
    expect(out).toContain('--lane must be one of');
  });
});
