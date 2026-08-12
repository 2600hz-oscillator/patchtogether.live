// scripts/e2e-shard-budget.test.ts
//
// A SHARD'S HEADROOM IS INVISIBLE UNTIL IT IS GONE.
//
// `--global-timeout` is a cliff, not a gauge: a shard at 99 % of budget and one
// at 40 % produce byte-identical CI output. 2026-08-11 e2e shard 3 finished at
// 892 s against a 900 s budget — EIGHT SECONDS of slack — after #1470 consumed
// the headroom and #1454 landed on top. Two individually-green PRs collided on
// a budget neither could see, and #1476 had to prove it was contention rather
// than a wavesculpt defect before anyone could act.
//
// scripts/e2e-shard-budget.sh wraps the Playwright call, prints the run as a
// percentage of budget on EVERY run, and fails before the cliff. This test
// drives the REAL script.
//
// ⚠ THE BUDGET IS PARSED FROM THE WRAPPED COMMAND, NOT RE-TYPED. That is the
// whole design: a second copy of the number would be a literal that has to
// track another literal by discipline, which is the drift class this repo
// keeps getting bitten by. `derives the budget from the flag` and
// `REFUSES when there is no --global-timeout` are the two legs that hold it.
//
// ── WHAT THIS TEST CANNOT SEE ───────────────────────────────────────────────
//  · It uses a stand-in command, not Playwright. The subject is the budget
//    arithmetic and the exit-code policy, both command-agnostic.
//  · Timings here are deliberately coarse (whole seconds against tiny budgets)
//    so the assertions are about CROSSING A LINE, not about precise durations.
//    A wall-clock stopwatch is the correct instrument for a wall-clock budget —
//    unlike a renderer-dependent wait, which must be counted in frames.

import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, chmodSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'e2e-shard-budget.sh');

/** A stand-in for `playwright test`: sleeps, exits with a chosen code, and
 *  ignores argv entirely (so the flags we pass exist purely to be parsed). */
function fakeCommand(sleepSec: number, exitCode: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'shard-budget-'));
  const p = join(dir, 'fake-playwright.sh');
  writeFileSync(p, `#!/usr/bin/env bash\nsleep ${sleepSec}\nexit ${exitCode}\n`);
  chmodSync(p, 0o755);
  return p;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function runWrapper(args: string[], env: Record<string, string> = {}): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync('bash', [SCRIPT, '--', ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('e2e-shard-budget.sh', () => {
  it('derives the budget from the wrapped command, in both flag spellings', async () => {
    const fake = fakeCommand(0, 0);
    const spaced = await runWrapper([fake, '--global-timeout', '10000']);
    expect(spaced.stdout, 'space-separated form').toMatch(/of 10s budget/);
    const equals = await runWrapper([fake, '--global-timeout=10000']);
    expect(equals.stdout, '=-separated form').toMatch(/of 10s budget/);
  });

  it('prints the percentage on EVERY run, not only near the line', async () => {
    // The gauge is the point. A guard that only speaks when it fails leaves
    // the trend invisible, which is how 892/900 arrived unannounced.
    const r = await runWrapper([fakeCommand(0, 0), '--global-timeout', '20000']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\d+s of 20s budget \(\d+%\)/);
  });

  // ⚠ THE BAND TESTS MOVE THE THRESHOLD, NOT THE CLOCK.
  //
  // The wrapper times with `date +%s`, i.e. WHOLE SECONDS — ample for a 1020 s
  // budget (0.1 % granularity) but useless for authoring a test around a
  // sub-second budget. The first version of these legs slept 1 s against a
  // 1.25 s budget expecting 80 %; a 1 s sleep measures as 1 OR 2 seconds
  // depending on where the boundary falls, so it read 160 % and failed
  // intermittently. Placing the BANDS around a coarse measurement instead of
  // trying to measure precisely makes every leg deterministic, and exercises
  // exactly the same arithmetic.
  it('FAILS a run at or over the threshold even though the command SUCCEEDED', async () => {
    // The measured failure mode: every test passes, the lane is still out of
    // room, and CI says "success".
    const r = await runWrapper([fakeCommand(1, 0), '--global-timeout', '10000'], {
      E2E_SHARD_BUDGET_FAIL_FRACTION: '0.05',
    });
    expect(r.code, 'over budget must fail').not.toBe(0);
    expect(r.stdout).toContain('::error');
    expect(r.stderr).toContain('Every test here PASSED');
  });

  it('PASSES a run comfortably under the threshold', async () => {
    // The other direction — otherwise the check could simply be always-true.
    const r = await runWrapper([fakeCommand(0, 0), '--global-timeout', '60000']);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('::error');
    expect(r.stdout).not.toContain('::warning');
  });

  it('warns — but does not fail — inside the warn band', async () => {
    // Proves the two thresholds are genuinely distinct rather than one line
    // wearing two names: over the warn fraction, under the fail fraction.
    const r = await runWrapper([fakeCommand(1, 0), '--global-timeout', '10000'], {
      E2E_SHARD_BUDGET_WARN_FRACTION: '0.05',
      E2E_SHARD_BUDGET_FAIL_FRACTION: '0.95',
    });
    expect(r.code, 'the warn band must not fail the job').toBe(0);
    expect(r.stdout).toContain('::warning');
    expect(r.stdout).not.toContain('::error');
  });

  it('the DEFAULT policy is fail at 85% / warn at 70%', async () => {
    // The bands above are injected, so the SHIPPED numbers need their own leg —
    // otherwise every threshold assertion here would pass against a wrapper
    // whose defaults had drifted to anything at all.
    const r = await runWrapper([fakeCommand(0, 0), '--global-timeout', '10000']);
    expect(r.stdout).toContain('fail at 85%, warn at 70%');
  });

  it('NEVER relabels a real test failure as a budget failure', async () => {
    // A budget error printed over a genuine failure sends the next reader
    // down the wrong path — and the two diagnoses are completely different.
    // Over budget AND non-zero child: the CHILD's code must win.
    const r = await runWrapper([fakeCommand(1, 3), '--global-timeout', '10000'], {
      E2E_SHARD_BUDGET_FAIL_FRACTION: '0.05',
    });
    expect(r.code, "the child's exit code must be propagated verbatim").toBe(3);
    expect(r.stdout).not.toContain('::error title=e2e shard out of headroom');
  });

  it('REFUSES when there is no --global-timeout to derive a budget from', async () => {
    // A guard that invents a default when the real budget is deleted stops
    // guarding at the exact moment it matters.
    const r = await runWrapper([fakeCommand(0, 0)]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('REFUSING');
  });

  it('is actually WIRED IN — ci.yml routes the e2e shard through it', async () => {
    // The arithmetic above is worthless if nothing calls the wrapper. Read the
    // workflow rather than trusting the wiring persists.
    const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci, 'the e2e shard command must run through the budget wrapper').toContain(
      'bash scripts/e2e-shard-budget.sh --',
    );
    // ...and the wrapper must be able to SEE a budget in that same command,
    // or it will refuse at runtime rather than at review time.
    const shardStep = ci.slice(ci.indexOf('bash scripts/e2e-shard-budget.sh --'));
    expect(shardStep.slice(0, 400), 'the wrapped command must still carry --global-timeout').toMatch(
      /--global-timeout[=\s]+\d+/,
    );
  });
});
