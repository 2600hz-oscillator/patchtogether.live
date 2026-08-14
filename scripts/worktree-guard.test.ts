// scripts/worktree-guard.test.ts
//
// The worktree guard's CLASSIFIER, tested against real git worktrees in a
// scratch repo (#1571).
//
// WHY THIS EXISTS. The guard's "abandoned" classification once read three
// LIVE agents as removable: a read-only investigation phase is byte-for-byte
// the shape of abandonment (clean tree, zero commits, no writes), and the
// more carefully an agent reads before touching anything, the more abandoned
// its worktree looks. Force-removing them cost ~35 minutes of unrecoverable
// diagnosis each. The classifier now refuses "abandoned" on ANY sign of life:
//   1. a lock naming an ALIVE pid          → live (never removed);
//   2. a lock with NO parseable pid        → at-risk (unidentifiable ≠ dead —
//      the same refusal shape as the attest's unidentifiable-server rule).
// (A third, atime-based "recently read" rule was built, measured and DROPPED:
// APFS bumps atime on read only while atime < mtime, so the signal
// structurally cannot fire after any prior read — see the guard's header.)
//
// These legs run the REAL script over REAL `git worktree` state — a scratch
// repo in tmp, real locks, a real live process — because the incident was a
// classification of real porcelain output, and a mock of `git worktree list`
// would test the mock. Per #1571's acceptance, the live-pid leg is negative-
// controlled in BOTH directions: hold a lock from a live process → refusal;
// kill the process → it reaps.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'worktree-guard.sh');

let repo: string;
let sleeper: ChildProcess;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Run the guard in a mode and capture its report. Never throws on the
 *  guard's own exit codes — the OUTPUT is the subject. */
function runGuard(mode: string, env: Record<string, string> = {}): string {
  try {
    return execFileSync('bash', [GUARD, mode], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

/** Write a lock the way `git worktree lock` records it, with our reason. */
function lockWorktree(name: string, reason: string): void {
  git(repo, 'worktree', 'lock', '--reason', reason, join(repo, '..', name));
}

/** Make every file in a worktree COLD (atime+mtime pushed into the past) so
 *  the freshness leg cannot mask the leg under test. */
function chill(dir: string): void {
  const past = new Date(Date.now() - 6 * 3600 * 1000);
  const walk = (d: string) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      if (f.name === '.git') continue;
      const p = join(d, f.name);
      if (f.isDirectory()) walk(p);
      else utimesSync(p, past, past);
    }
  };
  walk(dir);
}

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'wt-guard-'));
  repo = join(base, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  git(repo, 'config', 'user.email', 'guard-test@example.invalid');
  git(repo, 'config', 'user.name', 'guard test');
  writeFileSync(join(repo, 'a.txt'), 'hello\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  // A REAL origin (bare, in tmp) so worktree branches can be genuinely
  // pushed and `@{upstream}` resolves — faking the remote-tracking ref with
  // update-ref is not enough for --set-upstream-to.
  execFileSync('git', ['init', '-q', '--bare', join(base, 'origin.git')]);
  git(repo, 'remote', 'add', 'origin', join(base, 'origin.git'));
  // A live process to name in locks — the "agent".
  sleeper = spawn('sleep', ['600'], { stdio: 'ignore' });
});

afterAll(() => {
  sleeper?.kill('SIGKILL');
  rmSync(join(repo, '..'), { recursive: true, force: true });
});

describe('worktree-guard classification (#1571) — liveness beats tidiness', () => {
  it('a clean, pushed worktree whose lock names a LIVE pid is LIVE — never auto-removable', () => {
    git(repo, 'worktree', 'add', '-q', join(repo, '..', 'wt-live'), '-b', 'wt-live');
    lockWorktree('wt-live', `agent test pid ${sleeper.pid}`);
    chill(join(repo, '..', 'wt-live'));

    const out = runGuard('report');
    expect(out).toContain(`live agent pid ${sleeper.pid}`);
    expect(out).toMatch(/live: [1-9]/);

    // clean must NOT remove it — run it and confirm the worktree survives.
    runGuard('clean');
    const list = git(repo, 'worktree', 'list');
    expect(list, 'clean removed a LIVE worktree — this is the #1571 incident').toContain('wt-live');
  });

  it("…and the SAME worktree reaps once the pid is dead (the classifier reads liveness, not the lock's existence)", async () => {
    // Negative control in the other direction, per the acceptance: kill the
    // process, the classification flips. A fresh sleeper keeps the other legs
    // (which still need a live pid) independent of this one.
    const doomed = spawn('sleep', ['600'], { stdio: 'ignore' });
    git(repo, 'worktree', 'add', '-q', join(repo, '..', 'wt-dies'), '-b', 'wt-dies');
    lockWorktree('wt-dies', `agent test pid ${doomed.pid}`);
    chill(join(repo, '..', 'wt-dies'));

    expect(runGuard('report')).toContain(`live agent pid ${doomed.pid}`);

    // ⚠ AWAIT THE REAP, not just the kill: `kill -0` SUCCEEDS on a zombie,
    // and a killed-but-unreaped child is exactly that until node handles the
    // SIGCHLD. Waiting for the 'exit' event guarantees the pid is genuinely
    // gone from the process table before the guard reads it.
    await new Promise<void>((r) => {
      doomed.once('exit', () => r());
      doomed.kill('SIGKILL');
    });
    // Without an upstream, unpushed reads "noup" and the worktree is at-risk
    // rather than SAFE — correct in itself (nothing to verify against), so
    // PUSH it for real to make it genuinely reapable.
    git(join(repo, '..', 'wt-dies'), 'push', '-q', '-u', 'origin', 'wt-dies');
    chill(join(repo, '..', 'wt-dies'));

    const out = runGuard('report');
    expect(out).toContain('abandoned (dead pid');
    runGuard('clean');
    expect(git(repo, 'worktree', 'list')).not.toContain('wt-dies');
  });

  it('a lock with NO parseable pid is AT-RISK — unidentifiable is not dead', () => {
    git(repo, 'worktree', 'add', '-q', join(repo, '..', 'wt-nopid'), '-b', 'wt-nopid');
    lockWorktree('wt-nopid', 'manual hold, no process recorded');
    chill(join(repo, '..', 'wt-nopid'));

    const out = runGuard('report');
    expect(out).toContain('NO parseable pid');
    runGuard('clean');
    expect(
      git(repo, 'worktree', 'list'),
      'clean removed a worktree it could not identify — refusal must beat tidiness',
    ).toContain('wt-nopid');
  });
});
