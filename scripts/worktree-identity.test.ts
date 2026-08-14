// scripts/worktree-identity.test.ts
//
// The IDENTITY probe behind #1597: an attest must never run against a server
// it cannot prove is THIS worktree's. These tests drive the REAL
// `assertServerIsThisWorktree` / `fetchWorktreeIdentity` (the exact predicate
// the attest runners call — not a re-typed copy) against real HTTP listeners:
//
//   · WRONG-tree server  → REFUSES, naming BOTH paths (the negative control —
//     this is the leg that converts the silent false-attestation vector into a
//     loud refusal).
//   · RIGHT-tree server  → passes (the positive control — a guard that refuses
//     unconditionally would green every refusal leg above and be equally
//     broken).
//   · NO /__worktree     → REFUSES. On an attest path, "cannot identify" and
//     "someone else's" get the same answer. (scripts/dev-server.sh is the
//     lenient consumer — it falls back to lsof-cwd — and its leniency is
//     covered by dev-server-ownership.test.ts, not here.)
//
// ── WHAT THIS FILE CANNOT SEE ───────────────────────────────────────────────
//   · It does not boot vite, so it does not prove the /__worktree endpoint
//     exists in the app (that is the worktreeIdentity() plugin in
//     packages/web/vite.config.ts, exercised by any real `bootOwnAppServer`
//     boot — including every real attest run, which REFUSES if absent).
//   · It asserts the DECISION, not that the attest runners call it — that
//     wiring is asserted below by reading the runner sources (`the runners
//     actually call the guard`), the same anchored-to-the-artifact shape
//     dev-server-ownership.test.ts uses for the Taskfile.

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { assertServerIsThisWorktree, fetchWorktreeIdentity, serverBootPlan } from './worktree-identity';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** A real HTTP listener; `identity` null = 404 on /__worktree (endpoint absent),
 *  otherwise served as the plugin would serve it. */
async function listen(identity: Record<string, unknown> | null): Promise<string> {
  const server = createServer((req, res) => {
    if (identity !== null && (req.url ?? '').split('?')[0] === '/__worktree') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(identity));
      return;
    }
    if (identity === null && (req.url ?? '').split('?')[0] === '/__worktree') {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }
    res.end('ok');
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

describe('assertServerIsThisWorktree (#1597)', () => {
  it('REFUSES a wrong-tree server, naming BOTH paths', async () => {
    const foreignRoot = realpathSync(tmpdir()); // definitively not this checkout
    const url = await listen({ root: foreignRoot, commit: 'cafe1234', mode: 'dev' });
    const err = await assertServerIsThisWorktree(url, ROOT, 'test').then(
      () => null,
      (e: Error) => e,
    );
    expect(err, 'a server naming another tree MUST be refused').not.toBeNull();
    // Both paths, or the refusal is not actionable.
    expect(err!.message).toContain(foreignRoot);
    expect(err!.message).toContain(realpathSync(ROOT));
    expect(err!.message).toContain('WRONG-WORKTREE');
  });

  it('POSITIVE CONTROL: accepts a server naming THIS tree, and returns its identity', async () => {
    const url = await listen({ root: realpathSync(ROOT), commit: 'feed5678', mode: 'preview' });
    const id = await assertServerIsThisWorktree(url, ROOT, 'test');
    expect(id.commit).toBe('feed5678');
    expect(id.mode).toBe('preview');
  });

  it('REFUSES a server with NO /__worktree endpoint (unidentifiable ≠ trusted)', async () => {
    const url = await listen(null);
    const err = await assertServerIsThisWorktree(url, ROOT, 'test').then(
      () => null,
      (e: Error) => e,
    );
    expect(err, 'an unidentifiable server MUST be refused on an attest path').not.toBeNull();
    expect(err!.message).toContain('/__worktree');
    expect(err!.message).toContain(realpathSync(ROOT));
  });

  it('REFUSES a listener that answers 200 but is not the identity endpoint (a bare "ok" server)', async () => {
    // The dev-server-ownership suite spawns exactly this shape of listener; a
    // probe that mistook ANY 200 for an identity would pass it. Guard the
    // parse: non-JSON / no `root` → null → refusal.
    const server = createServer((_q, res) => res.end('ok'));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    const url = `http://127.0.0.1:${port}`;
    expect(await fetchWorktreeIdentity(url)).toBeNull();
    const err = await assertServerIsThisWorktree(url, ROOT, 'test').then(
      () => null,
      (e: Error) => e,
    );
    expect(err).not.toBeNull();
  });

  it('the three attest runners actually call the guard (anchored to the sources)', () => {
    // The refusal is worthless if nothing calls it. Read the runners rather
    // than trusting that the wiring still exists.
    for (const runner of ['webgl-attest.ts', 'collab-attest.ts', 'grand-attest.ts']) {
      const src = readFileSync(join(ROOT, 'scripts', runner), 'utf8');
      expect(src, `${runner} must boot its OWN app server`).toContain('bootOwnAppServer');
      expect(src, `${runner} must RE-VERIFY identity before writing`).toContain(
        'assertServerIsThisWorktree',
      );
      expect(src, `${runner} must keep the config webServer out (E2E_SKIP_WEBSERVER)`).toContain(
        'E2E_SKIP_WEBSERVER',
      );
    }
  });

  it('the app actually exposes the endpoint (anchored to vite.config.ts)', () => {
    // Belt for the "cannot see" note above: the plugin must exist and be
    // registered for BOTH dev and preview, or every identity probe in the
    // repo degrades to its fallback (or, on attest paths, refuses every run).
    const src = readFileSync(join(ROOT, 'packages/web/vite.config.ts'), 'utf8');
    expect(src).toContain("'/__worktree'");
    expect(src).toContain('configureServer');
    expect(src).toContain('configurePreviewServer');
    expect(src).toContain('worktreeIdentity()');
  });
});

describe('serverBootPlan — one interface, named explicitly, both ends (#1614)', () => {
  // Measured on macOS: `vite preview` binds [::1] ONLY, so a `localhost` URL
  // makes the identity probe a per-lookup address-family coin flip — a
  // 52/52-green collab attest was refused at the pre-write re-assert this way.
  // The plan function exists so the spawn args and the probe URL are built in
  // ONE place; these legs pin that they can never disagree again.
  it.each(['dev', 'preview'] as const)('%s: the URL and --host name the SAME literal interface', (mode) => {
    const plan = serverBootPlan(mode, 43210);
    expect(plan.url).toBe('http://127.0.0.1:43210');
    const hostIdx = plan.args.indexOf('--host');
    expect(hostIdx, `--host must be passed explicitly (args: ${plan.args.join(' ')})`).toBeGreaterThan(-1);
    expect(plan.args[hostIdx + 1]).toBe('127.0.0.1');
    // strictPort stays: a squatter on the chosen ephemeral port must fail the
    // boot loudly, never silently rebind.
    expect(plan.args).toContain('--strictPort');
    expect(plan.args).toContain(String(43210));
  });

  it('never says localhost — the resolver is the nondeterminism', () => {
    for (const mode of ['dev', 'preview'] as const) {
      const plan = serverBootPlan(mode, 5000);
      expect(plan.url).not.toContain('localhost');
      expect(plan.args.join(' ')).not.toContain('localhost');
    }
  });
});
