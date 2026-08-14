// scripts/worktree-identity.ts
//
// AN ATTEST MUST NEVER REUSE A SERVER IT DID NOT BOOT (#1597).
//
// The attest runners used to inherit e2e/playwright.config.ts's webServer with
// `reuseExistingServer: !CI` on the SHARED default port — so when any sibling
// worktree had a long-lived dev server there, the attest silently exercised
// THAT tree's app while hashing and attesting THIS tree's code. Observed as 5
// false failures on a fix branch (the sibling lacked the fix); the mirror
// image is a FALSE ATTESTATION, and nothing in the run output distinguishes it.
//
// This module gives the runners the two legs that close the hole:
//   1. `bootOwnAppServer()` — boot a fresh dev/preview server on a PER-RUN
//      EPHEMERAL port (never the shared default, `--strictPort` so a squatter
//      fails loudly), and hand back the E2E_BASE_URL to pass to Playwright
//      alongside E2E_SKIP_WEBSERVER=1.
//   2. `assertServerIsThisWorktree()` — the IDENTITY probe: the app's vite
//      plugin (packages/web/vite.config.ts, worktreeIdentity()) serves
//      `GET /__worktree` naming the checkout that booted the server; this
//      REFUSES, naming BOTH paths, when that is not the attesting worktree.
//      Called at boot AND again immediately before an attestation is written,
//      so a server replaced mid-run cannot mint one either.
//
// A server WITHOUT the endpoint is refused too — on an attest path "I cannot
// identify the server" and "the server is someone else's" get the same answer
// (fail loudly; never proceed unverified). scripts/dev-server.sh is more
// lenient (it falls back to lsof-cwd ownership) because the dev loop must keep
// working against a tree that predates the endpoint; an ATTESTATION must not.
//
// `scripts/` is hash-free in every attest basis, so this file's edits never
// force a re-attest.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, openSync, closeSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface WorktreeIdentity {
  root: string;
  commit: string;
  mode: string;
  pid?: number;
  startedAt?: string;
}

/** One probe of `GET <baseUrl>/__worktree`, with the failure CAUSE preserved —
 *  a timeout (alive-but-saturated server) and ECONNREFUSED (dead server) need
 *  opposite handling upstream, and `null` alone cannot carry the difference
 *  (#1632). */
async function probeWorktreeIdentityOnce(
  baseUrl: string,
  timeoutMs: number,
): Promise<{ id: WorktreeIdentity | null; cause: string }> {
  try {
    const res = await fetch(new URL('/__worktree', baseUrl), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { id: null, cause: `HTTP ${res.status}` };
    const body = (await res.json()) as Partial<WorktreeIdentity>;
    if (typeof body.root !== 'string' || body.root.length === 0) {
      return { id: null, cause: 'body has no root field' };
    }
    return {
      id: {
        root: body.root,
        commit: typeof body.commit === 'string' ? body.commit : 'unknown',
        mode: typeof body.mode === 'string' ? body.mode : 'unknown',
        pid: typeof body.pid === 'number' ? body.pid : undefined,
        startedAt: typeof body.startedAt === 'string' ? body.startedAt : undefined,
      },
      cause: 'ok',
    };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    return { id: null, cause: err?.cause?.code ?? err?.name ?? String(e) };
  }
}

/** Fetch `GET <baseUrl>/__worktree`. Returns the parsed identity, or null when
 *  the endpoint is absent / not JSON / unreachable (the caller decides whether
 *  null is refusable — for an attest it is). */
export async function fetchWorktreeIdentity(
  baseUrl: string,
  timeoutMs = 5000,
): Promise<WorktreeIdentity | null> {
  try {
    const res = await fetch(new URL('/__worktree', baseUrl), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<WorktreeIdentity>;
    if (typeof body.root !== 'string' || body.root.length === 0) return null;
    return {
      root: body.root,
      commit: typeof body.commit === 'string' ? body.commit : 'unknown',
      mode: typeof body.mode === 'string' ? body.mode : 'unknown',
      pid: typeof body.pid === 'number' ? body.pid : undefined,
      startedAt: typeof body.startedAt === 'string' ? body.startedAt : undefined,
    };
  } catch {
    return null;
  }
}

/** Physical-path compare (symlinked checkouts must equal what the server
 *  reports for the same tree). Falls back to the raw string when realpath
 *  fails (path no longer exists — which can only compare unequal, the safe
 *  direction). */
function physical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** REFUSE (throw) unless the server at `baseUrl` identifies itself as booted
 *  from `repoRoot`. Returns the verified identity so callers can log/record
 *  it. `context` names the caller in the error (e.g. 'webgl:attest'). */
export async function assertServerIsThisWorktree(
  baseUrl: string,
  repoRoot: string,
  context: string,
): Promise<WorktreeIdentity> {
  const here = physical(repoRoot);
  // RETRY before refusing (#1632): the pre-write re-assert fires at the exact
  // moment a just-finished suite's teardown saturates the server's event loop
  // (keep-alive socket churn + plugin disposal), and a ONE-SHOT probe against
  // an alive-but-saturated server reads exactly like a dead one — four fully
  // green 52/52 collab runs were refused that way. A saturated server answers
  // on a later attempt; a dead one never does, so fail-closed is preserved.
  let id: WorktreeIdentity | null = null;
  let cause = 'unknown';
  for (let attempt = 1; attempt <= 3; attempt++) {
    ({ id, cause } = await probeWorktreeIdentityOnce(baseUrl, 5000));
    if (id !== null) break;
    console.error(
      `[${context}] identity probe attempt ${attempt}/3 failed (${cause})${attempt < 3 ? ' — retrying in 2s' : ''}`,
    );
    if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
  }
  if (id === null) {
    throw new Error(
      `${context}: the server at ${baseUrl} does not answer GET /__worktree (3 attempts; last ` +
        `cause: ${cause}), so it CANNOT be verified as this worktree's (${here}). It is either ` +
        `another checkout's server (one that predates the identity endpoint), not this repo's app ` +
        `at all, or dead. An unidentifiable server must never back an attestation — boot your own ` +
        `(bootOwnAppServer) or stop the squatter. [#1597, #1632]`,
    );
  }
  if (physical(id.root) !== here) {
    throw new Error(
      `${context}: WRONG-WORKTREE SERVER at ${baseUrl} — REFUSING.\n` +
        `  server was booted from : ${id.root} (commit ${id.commit}, mode ${id.mode})\n` +
        `  this checkout is       : ${here}\n` +
        `  Running against it would exercise THAT tree's app while attesting THIS tree's code — ` +
        `the #1597 false-attestation vector. Stop that server from its own worktree ` +
        `(flox activate -- task e2e:stop) or let the attest boot its own.`,
    );
  }
  return id;
}

/** A free ephemeral port from the OS, released just before we hand it to vite.
 *  `--strictPort` on the boot turns the tiny grab-race window into a loud
 *  failure instead of a silent bind-elsewhere. */
export async function freeEphemeralPort(): Promise<number> {
  return await new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}

export interface OwnAppServer {
  url: string;
  port: number;
  mode: 'dev' | 'preview';
  identity: WorktreeIdentity;
  child: ChildProcess;
  logFile: string;
  stop(): void;
}

/**
 * The spawn args and probe URL for an attest-owned app server — ONE function so
 * the two can never disagree about the interface.
 *
 * ⚠ `127.0.0.1` EXPLICITLY, both ends, never `localhost` (#1614). Measured on
 * macOS: `vite preview --port N` binds **[::1] ONLY** — `curl 127.0.0.1:N`
 * refuses while `[::1]:N` answers. A `localhost` URL then makes every identity
 * probe a per-lookup coin flip: Node's fetch resolves `localhost` each call,
 * and whichever family getaddrinfo returns first is the one undici connects
 * to. A 52/52-green collab attest was REFUSED at the pre-write re-assert this
 * way — boot-time lookups picked ::1 (probe passed), the pre-write lookup
 * picked 127.0.0.1 (ECONNREFUSED → null → refuse) — while chromium, which does
 * its own happy-eyeballs, served every spec without noticing. Passing
 * `--host 127.0.0.1` pins the server to one interface and the URL names that
 * same interface, so the probe is deterministic by construction. The refusal
 * was the gate failing CLOSED (correct!); this makes it also fail RARELY.
 */
export function serverBootPlan(
  mode: 'dev' | 'preview',
  port: number,
): { url: string; args: string[] } {
  const script = mode === 'preview' ? 'preview' : 'dev';
  return {
    url: `http://127.0.0.1:${port}`,
    args: [
      'run',
      script,
      '-w',
      'packages/web',
      '--',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
  };
}

/** Boot THIS worktree's app server (dev or preview) on a per-run ephemeral
 *  port, wait for it, and identity-verify it before returning. The caller
 *  passes `E2E_BASE_URL=<url>` + `E2E_SKIP_WEBSERVER=1` to Playwright so the
 *  config's reuse-happy webServer stays out of the picture entirely, and calls
 *  `stop()` in a finally. Preview mode requires the caller to have built the
 *  bundle first (mirrors `vite preview`'s own contract). */
export async function bootOwnAppServer(opts: {
  repoRoot: string;
  mode: 'dev' | 'preview';
  /** Boot-wait budget. Default mirrors playwright.config's webServer timeout. */
  timeoutMs?: number;
  /** Extra env for the server process (e.g. VITE_* toggles). */
  env?: Record<string, string>;
  /** Caller name for log lines + refusal messages. */
  context?: string;
}): Promise<OwnAppServer> {
  const { repoRoot, mode } = opts;
  const context = opts.context ?? 'attest';
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const port = await freeEphemeralPort();
  const { url, args } = serverBootPlan(mode, port);
  const logFile = join(mkdtempSync(join(tmpdir(), 'attest-app-server-')), `${mode}.log`);
  const logFd = openSync(logFile, 'a');
  console.log(`[${context}] booting OWN ${mode} server on ${url} (npm ${args.join(' ')}; logs → ${logFile})`);

  // detached → its own process group, so stop() can kill npm AND the vite it
  // spawned in one signal (kill(-pid)).
  const child = spawn('npm', args, {
    cwd: repoRoot,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', logFd, logFd],
    detached: true,
  });
  closeSync(logFd);

  let exited = false;
  child.on('exit', (code, signal) => {
    exited = true;
    // A server that dies MID-RUN dies silently otherwise (its own log just
    // stops), and the pre-write identity re-assert then reads as a squatter
    // refusal. Name the death loudly, with the signal, the moment it happens.
    console.error(
      `[${context}] ⚠ own ${mode} server (pid ${child.pid}) EXITED code=${code} signal=${signal} at ${new Date().toISOString()}`,
    );
  });

  const stop = () => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* group already gone */
    }
    setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, 5000).unref();
  };

  // Wait for HTTP, bounded. Any HTTP status counts as "up" (the beta gate 401s).
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (exited) {
      throw new Error(
        `[${context}] own ${mode} server exited before serving ${url} — tail of ${logFile}:\n` +
          tail(logFile, 20),
      );
    }
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      break;
    } catch {
      if (Date.now() > deadline) {
        stop();
        throw new Error(
          `[${context}] own ${mode} server never answered on ${url} within ${timeoutMs}ms — tail of ${logFile}:\n` +
            tail(logFile, 20),
        );
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // The identity leg — even a server we just booted is verified, so a
  // strictPort race (something else grabbed the port first) or a stale bundle
  // from another tree is refused rather than trusted.
  let identity: WorktreeIdentity;
  try {
    identity = await assertServerIsThisWorktree(url, repoRoot, context);
  } catch (e) {
    stop();
    throw e;
  }
  console.log(
    `[${context}] own ${mode} server verified: ${url} serves ${identity.root} (commit ${identity.commit.slice(0, 12)})`,
  );
  return { url, port, mode, identity, child, logFile, stop };
}

function tail(file: string, lines: number): string {
  try {
    return readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '(log unreadable)';
  }
}
