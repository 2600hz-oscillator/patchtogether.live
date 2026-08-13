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
import { mkdtempSync, writeFileSync } from 'node:fs';
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
