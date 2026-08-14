// scripts/dev-server-ownership.test.ts
//
// A SERVER ANSWERING ON THE PORT IS NOT NECESSARILY *THIS WORKTREE'S* SERVER.
//
// CLAUDE.md already documents the "green sweep of the WRONG BRANCH" hazard for
// `task vrt`, which was fixed by routing every entry point through `vrt:run`.
// The SERVE path was never fixed. Measured 2026-08-11: `E2E_PORT=5261 task
// e2e:serve` printed "already UP — reusing" against a DIFFERENT WORKTREE'S dev
// server. Reproduced 2026-08-12 while writing this: port 5173 was served from
// `.claude/worktrees/agent-aaab2e553c711a296` while `dev-server.sh status` in
// another worktree reported a bare `UP` — after which every `e2e:one` /
// `vrt:one` would have exercised that other branch and reported against this
// one, because Playwright is handed `reuseExistingServer`.
//
// `scripts/dev-server.sh` now identifies the OWNER (the listening process's
// cwd, via lsof) rather than merely probing the socket, and REFUSES a port it
// does not own. This test drives the REAL script against REAL listeners — one
// launched with its cwd inside the repo, one with its cwd outside it — so both
// directions are asserted, not just the refusal.
//
// ⚠ THE TEST SETUP IS THE PART THAT WAS WRONG FIRST, and it is worth keeping
// the story. The initial version started `python3 -m http.server --directory
// /tmp` and expected "foreign" — but `--directory` changes what is SERVED, not
// the process cwd, so the listener genuinely WAS owned by this checkout and
// the guard was right to say so. The instrument was fine; the CONTROL was
// invalid, and it read exactly like a bug in the code. Hence `spawnListener`
// sets `cwd` explicitly, and `classifies by the listener's cwd, in BOTH
// directions` asserts the classification itself before any refusal leg leans
// on it — so a setup that stops producing a genuinely-foreign process fails
// loudly instead of quietly turning every refusal assertion vacuous.
//
// ── WHAT THIS TEST CANNOT SEE ───────────────────────────────────────────────
//  · It does not boot vite. The subject is the OWNERSHIP decision, which is
//    server-agnostic — any listener with a known cwd drives the same code
//    path. The real-vite legs were verified by hand on 2026-08-12: a dev
//    server booted in this worktree on port 5262 read `owner=ours`, `assert-up`
//    exited 0 and `start` reused it; the sibling worktree's 5173 read
//    `foreign:` and was refused by `status`, `assert-up` and `start`.
//  · It asserts the DECISION, not what Playwright then does with it. Nothing
//    here proves `e2e:one` actually calls `assert-up` — that is wiring in the
//    Taskfile, covered by `assert-up is on the e2e:one path` below reading the
//    Taskfile rather than by executing a Playwright run.

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, symlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'dev-server.sh');
/** A cwd that is definitively NOT inside this checkout. */
const OUTSIDE = tmpdir();

const spawned: ChildProcess[] = [];

afterEach(() => {
  for (const p of spawned.splice(0)) {
    try {
      p.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

async function which(bin: string): Promise<string> {
  const { stdout } = await execFileAsync('bash', ['-c', `command -v ${bin}`]);
  return stdout.trim();
}

beforeAll(async () => {
  // dev-server.sh already depends on lsof (its `stop` fallback uses it), and
  // both macOS and ubuntu-latest ship it. State the dependency as an assertion
  // rather than skipping around it: without lsof the ownership guard is
  // INOPERATIVE, and silently skipping would hide that.
  await expect(which('lsof'), 'dev-server.sh ownership checking requires lsof').resolves.toBeTruthy();
});

/** A free ephemeral port, released before we hand it to the listener. */
async function freePort(): Promise<number> {
  return await new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}

/** Start a trivial HTTP listener whose PROCESS CWD is exactly `cwd`.
 *  The cwd is the ownership FALLBACK signal dev-server.sh reads (for servers
 *  that predate the /__worktree endpoint), so it is set explicitly rather
 *  than inherited. `identityRoot`, when given, makes the listener answer
 *  GET /__worktree the way the worktreeIdentity() vite plugin does — the
 *  PRIMARY signal (#1597), which names the tree whose CODE is served rather
 *  than where the process happens to sit. */
async function spawnListener(port: number, cwd: string, identityRoot?: string): Promise<void> {
  const identity = identityRoot ? JSON.stringify({ root: identityRoot, commit: 'test', mode: 'dev' }) : null;
  const code =
    `require('http').createServer((q,s)=>{` +
    `if(${JSON.stringify(identity)}!==null&&q.url.split('?')[0]==='/__worktree'){s.setHeader('content-type','application/json');s.end(${JSON.stringify(identity)});return}` +
    `s.end('ok')}).listen(${port},'127.0.0.1')`;
  const child = spawn(process.execPath, ['-e', code], { cwd, stdio: 'ignore' });
  spawned.push(child);
  // Poll until it answers, bounded. A fixed sleep would be a different
  // assertion on every machine.
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await execFileAsync('curl', ['-sS', '-o', '/dev/null', '--max-time', '2', `http://localhost:${port}`]);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`listener on port ${port} never answered`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function runScript(args: string[], env: Record<string, string>): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync('bash', [SCRIPT, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('dev-server.sh refuses a port it does not own', () => {
  it('classifies by the listener cwd, in BOTH directions', async () => {
    // Asserted FIRST, because every refusal leg below is meaningless if the
    // "foreign" listener is not actually foreign. This is the leg that failed
    // when the setup was wrong (see the header note).
    const mine = await freePort();
    await spawnListener(mine, ROOT);
    const ours = await runScript(['status'], { E2E_PORT: String(mine) });
    expect(ours.stdout, 'a listener whose cwd is this checkout must read as ours').toContain('owner=ours');

    const theirs = await freePort();
    await spawnListener(theirs, OUTSIDE);
    const foreign = await runScript(['status'], { E2E_PORT: String(theirs) });
    expect(foreign.stdout, 'a listener whose cwd is OUTSIDE this checkout must read as foreign').toContain(
      'owner=foreign:',
    );
  });

  it('IDENTITY beats cwd — refusing direction: a listener SERVING another tree is refused even with its cwd in this checkout', async () => {
    // #1597's actual hazard is what tree the CODE comes from, not where the
    // process sits. A server that answers /__worktree with a foreign root is
    // refused outright — the cwd fallback never gets a say.
    const port = await freePort();
    await spawnListener(port, ROOT, OUTSIDE); // cwd ours; identity foreign
    const r = await runScript(['assert-up'], { E2E_PORT: String(port) });
    expect(r.code, 'identity naming another tree must refuse regardless of cwd').not.toBe(0);
    expect(r.stderr).toContain('REFUSING to run against');
    expect(r.stderr).toContain(OUTSIDE);
  });

  it('IDENTITY beats cwd — accepting direction: a listener SERVING this tree is ours even with its cwd elsewhere', async () => {
    // The mirror control: without it the refusing leg would pass equally well
    // against a probe that refused whenever /__worktree answered at all.
    const port = await freePort();
    const { realpathSync } = await import('node:fs');
    await spawnListener(port, OUTSIDE, realpathSync(ROOT)); // cwd foreign; identity ours
    const r = await runScript(['assert-up'], { E2E_PORT: String(port) });
    expect(r.code, "identity naming THIS tree must be accepted regardless of cwd").toBe(0);
    expect(r.stderr).not.toContain('REFUSING');
  });

  it('assert-up REFUSES a foreign port — the leg that gates e2e:one / vrt:one', async () => {
    const port = await freePort();
    await spawnListener(port, OUTSIDE);
    const r = await runScript(['assert-up'], { E2E_PORT: String(port) });
    expect(r.code, 'assert-up must FAIL on a server this checkout does not own').not.toBe(0);
    expect(r.stderr).toContain('REFUSING to run against');
    // It has to name WHOSE it is, or the message is not actionable.
    expect(r.stderr).toContain('serves tree');
  });

  it('start REFUSES to reuse a foreign port instead of silently adopting it', async () => {
    const port = await freePort();
    await spawnListener(port, OUTSIDE);
    const r = await runScript(['start'], { E2E_PORT: String(port) });
    expect(r.code, "start must not report success against another worktree's server").not.toBe(0);
    expect(r.stderr).toContain('REFUSING to reuse');
    expect(r.stdout).not.toContain('reusing, not re-booting');
  });

  it('stop does NOT kill a foreign server — the destructive direction', async () => {
    const port = await freePort();
    await spawnListener(port, OUTSIDE);
    const r = await runScript(['stop'], { E2E_PORT: String(port) });
    expect(r.stderr).toContain('NOT killing port');
    // The listener must STILL answer. This is the assertion that matters: the
    // measured failure was a sibling worktree's dev server being reaped.
    await expect(
      execFileAsync('curl', ['-sS', '-o', '/dev/null', '--max-time', '2', `http://localhost:${port}`]),
    ).resolves.toBeTruthy();
  });

  it('POSITIVE CONTROL: it does NOT refuse a port this checkout owns', async () => {
    // Without this, every assertion above would pass equally well against a
    // script that refused unconditionally — a different, equally broken tool.
    const port = await freePort();
    await spawnListener(port, ROOT);
    const r = await runScript(['assert-up'], { E2E_PORT: String(port) });
    expect(r.code, "assert-up must SUCCEED on this checkout's own server").toBe(0);
    expect(r.stderr).not.toContain('REFUSING');
  });

  it('the override is honoured, and announces itself rather than passing silently', async () => {
    const port = await freePort();
    await spawnListener(port, OUTSIDE);
    const r = await runScript(['assert-up'], { E2E_PORT: String(port), E2E_ALLOW_FOREIGN_SERVER: '1' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('E2E_ALLOW_FOREIGN_SERVER=1');
  });

  it('with NO lsof it proceeds UNVERIFIED and says so — not silently, not blocked', async () => {
    // "The instrument says I don't know" and "there is no instrument" are
    // different facts that get opposite handling, so the second needs its own
    // leg. Build a PATH holding the externals the script needs and NOT lsof.
    // ⚠ Emptying PATH outright asserts NOTHING: `dirname` is external and runs
    // on the script's very first line (`ROOT=...`), so under `set -e` it dies
    // before reaching any ownership logic and stderr comes back EMPTY — which
    // is indistinguishable from "the guard said nothing". Measured while
    // writing this test — twice: the first attempt also omitted `bash`, so
    // Node could not launch the script AT ALL and returned the same empty
    // stderr. Two different total failures produced byte-identical output to
    // the "guard is silent" case, which is exactly why the tool list is
    // explicit and why this leg asserts an exit code as well as a message.
    const bin = mkdtempSync(join(tmpdir(), 'no-lsof-'));
    for (const tool of ['bash', 'env', 'dirname', 'curl', 'sed', 'head', 'cat', 'tail', 'mkdir', 'rm']) {
      symlinkSync(await which(tool), join(bin, tool));
    }

    const port = await freePort();
    await spawnListener(port, OUTSIDE);
    const r = await runScript(['assert-up'], { E2E_PORT: String(port), PATH: bin });
    expect(r.stderr, 'a missing instrument must be announced, not silently treated as "fine"').toContain(
      'CANNOT VERIFY',
    );
    expect(r.code, 'a missing instrument must not BLOCK the dev loop').toBe(0);
  });

  it('assert-up is on the e2e:one path — the guard is actually wired in', async () => {
    // The refusal is worthless if nothing calls it. Read the Taskfile rather
    // than trusting that the wiring still exists.
    const taskfile = readFileSync(join(ROOT, 'Taskfile.yml'), 'utf8');
    expect(taskfile, 'e2e:one must still call dev-server.sh assert-up').toContain('dev-server.sh assert-up');
  });
});
