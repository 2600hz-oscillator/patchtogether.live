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
import { auditReport, formatSummary, isDoomReserved, partitionFlaky } from './e2e-report-audit.mjs';

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

// ── THE GATE ITSELF ────────────────────────────────────────────────────────
//
// `--fail-on-flaky` is now ARMED on every retrying Playwright lane in ci.yml
// (#1903). It was written and left dark for a long time, which is the shape
// CLAUDE.md warns about — "a gate that cannot fail on CI is decoration" — and
// the day it is armed is the worst day to discover the exit code never worked.
//
// So this drives the real CLI, in a subprocess, on both sides of the decision:
// the same fixture must exit 1 with the flag and 0 without it, and exit 0 with
// the flag when there is nothing to find. A one-sided check ("it exits 1")
// would pass just as happily on a script that always exits 1.
describe('the --fail-on-flaky exit path (armed on every retrying lane, #1903)', () => {
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
    // The flag, not the parser, is what gates. A lane can still audit without
    // arming — and if arming ever becomes implicit, this goes red.
    const { code, out } = run([withFlake]);
    expect(code, `report-only must not fail the job. Output:\n${out}`).toBe(0);
    expect(out).toContain('recovers on retry');
  });

  it('NEGATIVE CONTROL (nothing to find): the flag alone does not fail a clean run', () => {
    const { code, out } = run([clean, '--fail-on-flaky']);
    expect(code, `a clean report must pass even when armed. Output:\n${out}`).toBe(0);
    expect(out).toContain('No flaky or skipped tests');
  });

  // ── ⚠ DOOM: EXCLUDED FROM GATING, NOT FROM REPORTING ────────────────────
  //
  // Three DOOM tests recovered flakes in the 96 h census (#1847) and were
  // deliberately left UNPARKED — the owner reserved them. They are live tests
  // that would otherwise trip this gate, and touching DOOM's timing
  // re-specifies how far the marine walks, so they are excluded BY NAME.
  //
  // Both directions are pinned, because the dangerous failure is not "DOOM
  // fails the job" — it is the exclusion QUIETLY WIDENING until it swallows a
  // real flake. So: a DOOM-only report must pass AND still print, and a report
  // with DOOM *and* a normal flake must still fail on the normal one.

  const doomOnly = join(dir, 'doom-only.json');
  writeFileSync(
    doomOnly,
    JSON.stringify({
      suites: [
        {
          file: 'doom-audio-output.spec.ts',
          specs: [{ title: 'pistol SFX reach a downstream scope', tests: [{ status: 'flaky', results: [{}, {}] }] }],
        },
      ],
    }),
  );

  const doomPlusReal = join(dir, 'doom-plus-real.json');
  writeFileSync(
    doomPlusReal,
    JSON.stringify({
      suites: [
        {
          file: 'doom-late-join.spec.ts',
          specs: [{ title: 'B hot-drops into the current map', tests: [{ status: 'flaky', results: [{}, {}] }] }],
        },
        {
          file: 'workflow-shell.spec.ts',
          specs: [{ title: 'a normal flake', tests: [{ status: 'flaky', results: [{}, {}] }] }],
        },
      ],
    }),
  );

  it('does NOT fail on an owner-reserved DOOM flake, but DOES print it', () => {
    const { code, out } = run([doomOnly, '--fail-on-flaky']);
    expect(code, `DOOM is owner-reserved and must not gate. Output:\n${out}`).toBe(0);
    // Visible, never silent — a silent exclusion is the failure mode even when
    // the exclusion is correct.
    expect(out).toContain('doom-audio-output.spec.ts');
    expect(out).toContain('::notice');
    expect(out, 'a DOOM row must not be annotated as a gating error').not.toContain('::error::');
  });

  it('POSITIVE CONTROL: the DOOM carve-out does not swallow a co-occurring real flake', () => {
    // The exclusion is per ROW, not per REPORT. If it were per report, one DOOM
    // flake would grant the whole run an amnesty — which is exactly how a
    // reasonable-looking filter quietly redefines a gate's subject.
    const { code, out } = run([doomPlusReal, '--fail-on-flaky']);
    expect(code, `a non-DOOM flake must still fail the job. Output:\n${out}`).toBe(1);
    expect(out).toContain('workflow-shell.spec.ts');
    expect(out).toContain('doom-late-join.spec.ts');
  });

  it('the DOOM predicate matches DOOM specs and nothing else', () => {
    // Anchored to shape, both directions: a pattern that matched everything and
    // a pattern that matched nothing would both leave the gate looking healthy.
    expect(isDoomReserved('e2e/tests/doom-mp-real.spec.ts')).toBe(true);
    expect(isDoomReserved('doom-late-join.spec.ts')).toBe(true);
    expect(isDoomReserved('e2e/tests/workflow-shell.spec.ts')).toBe(false);
    // ⚠ Not every file with "doom" in the name is a reserved DOOM spec.
    expect(isDoomReserved('e2e/tests/kingdoom-face.spec.ts')).toBe(false);
    expect(isDoomReserved('')).toBe(false);
  });

  it('partitionFlaky splits rows rather than reports', () => {
    const rows = [
      { file: 'doom-mp-real.spec.ts', title: 'd', retries: 2 },
      { file: 'clipplayer-edit-launch.spec.ts', title: 'c', retries: 2 },
    ];
    const { gating, doomReserved } = partitionFlaky(rows);
    expect(gating.map((r) => r.file)).toEqual(['clipplayer-edit-launch.spec.ts']);
    expect(doomReserved.map((r) => r.file)).toEqual(['doom-mp-real.spec.ts']);
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

describe('the --lane skip-budget exit path (armed PER SHARD in the e2e job)', () => {
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

// ── the collab lane's skip audit (#2294) ───────────────────────────────────
//
// THE DEFECT: the collab job ran `e2e-report-audit.mjs <report> --fail-on-flaky`
// with NO `--lane`, and `--lane collab` was REJECTED by this very CLI
// ("--lane must be one of e2e|behavioral"). Violations are only computed when a
// lane is given, so the deny-by-default skip budget was inert on the one lane
// that carries the eleven two-peer DOOM multiplayer tests. All eleven are
// guarded by `test.skip` on DOOM WASM / DOOM1.WAD presence, and the WAD is
// fetched over the network from a third-party mirror inside that job — so
// "provisioning broke, everything stood down" and "everything passed" were the
// same green job.
//
// This drives the REAL CLI in a subprocess with the EXACT argv ci.yml now uses,
// on both sides of the decision. A one-sided "it exits 1" would pass on a script
// that always exits 1, and — more to the point here — an audit that could not
// fail is the precise class the issue exists to kill.
describe('the collab lane skip audit (#2294): the ci.yml argv, both directions', () => {
  const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'e2e-report-audit.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'collab-audit-'));

  const run = (args: string[]): { code: number; out: string } => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' }) };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  };

  /** A collab-lane report: 2 passes plus the skipped rows described. */
  const collabReport = (
    skips: { file: string; title: string; reason: string | null }[],
  ) => ({
    suites: [
      {
        file: 'awareness.spec.ts',
        specs: [{ title: 'both contexts converge to memberCount==2', tests: [{ status: 'expected', results: [{}] }] }],
        suites: skips.map((s) => ({
          file: s.file,
          specs: [{
            title: s.title,
            tests: [{
              status: 'skipped',
              annotations: s.reason ? [{ type: 'skip', description: s.reason }] : [{ type: 'skip' }],
            }],
          }],
        })),
      },
    ],
  });

  const write = (name: string, body: unknown) => {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(body));
    return p;
  };

  // The lane's expected shape since the S2 legacy-removal inversion: ZERO
  // runtime skips. (It measured 50 passed / 1 skipped on 2026-09-01, the 1
  // being in-card-title's task #101 quarantine — that spec was deleted as
  // legacy-card coverage and the collab budget is now empty, so a clean run
  // has no skip rows at all.)
  const asMeasured = write('collab-as-measured.json', collabReport([]));

  // THE INDUCED REGRESSION: the DOOM asset guard fires, so the multiplayer
  // tests stand down. This is the exact shape a broken WAD fetch produces.
  const doomWentDark = write(
    'collab-doom-went-dark.json',
    collabReport([
      { file: 'doom-mp-real.spec.ts', title: 'owner hosts + launches MP as P1', reason: 'DOOM WASM / WAD missing' },
      {
        file: 'doom-mp-lockstep-sharedstate.spec.ts',
        title: 'two peers in a FRESH coop game share IDENTICAL gamestate',
        reason: 'DOOM WASM / WAD missing — run build-doom-wasm.sh + fetch DOOM1.WAD',
      },
    ]),
  );

  const anonymous = write(
    'collab-anonymous.json',
    collabReport([{ file: 'shared-rack-sync.spec.ts', title: 'full flow', reason: null }]),
  );

  it('accepts `--lane collab` at all — the flag this issue is named for', () => {
    const { code, out } = run([asMeasured, '--lane', 'collab', '--fail-on-flaky']);
    expect(code, `the lane as measured must audit clean. Output:\n${out}`).toBe(0);
    expect(out).toContain('Skip budget: every runtime skip matches a named');
  });

  it('⚠ REDS the lane when the DOOM multiplayer tests silently stand down', () => {
    const { code, out } = run([doomWentDark, '--lane', 'collab', '--fail-on-flaky']);
    expect(code, `a DOOM asset skip must red the collab lane. Output:\n${out}`).toBe(1);
    expect(out).toContain('::error::');
    expect(out).toContain('skip-budget violation');
    expect(out).toContain('doom-mp-real.spec.ts');
    expect(out).toContain('doom-mp-lockstep-sharedstate.spec.ts');
  });

  it('THE BEFORE PICTURE: the identical report is GREEN without --lane, which is what shipped', () => {
    // Not a hypothetical regression — this is the literal pre-#2294 command
    // line, reproduced. It prints the skips and exits 0, which is how eleven
    // multiplayer tests could go dark behind a green job.
    const { code, out } = run([doomWentDark, '--fail-on-flaky']);
    expect(code, `the old argv must still be report-only. Output:\n${out}`).toBe(0);
    expect(out, 'the rows were always PRINTED — nothing consumed them').toContain('doom-mp-real.spec.ts');
    expect(out).not.toContain('SKIP-BUDGET VIOLATIONS');
  });

  it('REDS a reasonless collab skip, naming it', () => {
    const { code, out } = run([anonymous, '--lane', 'collab', '--fail-on-flaky']);
    expect(code, `an anonymous skip must red the collab lane. Output:\n${out}`).toBe(1);
    expect(out).toContain('reasonless skip');
  });

  it('the DOOM *flake* carve-out is untouched and does NOT extend to skips', () => {
    // Both halves in one place, because the tempting "fix" for a red collab lane
    // is to reuse the flake exclusion for skips — which would silently restore
    // the hole. A DOOM flake still passes; a DOOM skip still fails.
    const doomFlake = write('collab-doom-flake.json', {
      suites: [{
        file: 'doom-late-join.spec.ts',
        specs: [{ title: 'B hot-drops into the current map', tests: [{ status: 'flaky', results: [{}, {}] }] }],
      }],
    });
    expect(run([doomFlake, '--lane', 'collab', '--fail-on-flaky']).code).toBe(0);
    expect(run([doomWentDark, '--lane', 'collab', '--fail-on-flaky']).code).toBe(1);
  });

  it('⚠ SCOPE, STATED: an EMPTY report audits clean — the audit is not proof a run happened', () => {
    // The @collab-vacuous-without-DB trap in reverse. The audit never asks how
    // many tests ran, so a lane whose Playwright step collapsed (no DB, no
    // relay) produces no skipped rows and no violations. What keeps that from
    // being a green job is upstream, not here: the Playwright step itself fails,
    // and a MISSING report makes this CLI throw rather than pass.
    const empty = write('collab-empty.json', { suites: [] });
    expect(run([empty, '--lane', 'collab', '--fail-on-flaky']).code).toBe(0);
    const { code, out } = run([join(dir, 'no-such-report.json'), '--lane', 'collab', '--fail-on-flaky']);
    expect(code, `a missing report must throw, never audit nothing. Output:\n${out}`).not.toBe(0);
    expect(out).toMatch(/ENOENT|no such file/);
  });
});
