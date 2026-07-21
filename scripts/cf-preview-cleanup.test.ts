// scripts/cf-preview-cleanup.test.ts
//
// Unit coverage for the two CF Pages preview-pipeline scripts:
//   - cf-preview-cleanup.sh          — delete a closed PR's preview deployments
//   - cf-clear-preview-beta-gate.sh  — REMOVE BETA_GATE_PASS from the Preview
//                                      scope (PR previews are intentionally
//                                      ungated).
//
// The load-bearing logic in each is the CF API interaction:
//   * cleanup: LIST (paged, env=preview) → FILTER by
//     deployment_trigger.metadata.branch == pr-<N> → DELETE ?force=true,
//     tolerating per-deployment errors and "already gone".
//   * clear-gate: PATCH deployment_configs.preview.env_vars.BETA_GATE_PASS =
//     null, which deletes that key on the Preview scope (partial-merge PATCH).
//
// We drive the real scripts against a MOCK CF API (a local http server) so the
// branch-filter + request shapes are asserted deterministically, with no live
// Cloudflare calls. CF_API_BASE points the scripts at the mock.

import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLEANUP = join(__dirname, 'cf-preview-cleanup.sh');
const CLEARGATE = join(__dirname, 'cf-clear-preview-beta-gate.sh');

type ReqLog = { method: string; url: string; body: string };

interface MockOpts {
  // deployments returned by GET list (single page); each has id + branch.
  deployments?: { id: string; branch: string }[];
  // ids whose DELETE should fail (simulate "already gone" / aliased).
  failDeleteIds?: Set<string>;
  // make the LIST call fail with success:false.
  listFails?: boolean;
  // make the PATCH call fail with success:false.
  patchFails?: boolean;
}

function startMock(opts: MockOpts): Promise<{ server: Server; base: string; reqs: ReqLog[] }> {
  const reqs: ReqLog[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      reqs.push({ method: req.method ?? '', url: req.url ?? '', body });
      const send = (code: number, obj: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const url = req.url ?? '';

      // PATCH /accounts/x/pages/projects/<p>  → set preview env
      if (req.method === 'PATCH' && /\/pages\/projects\/[^/]+$/.test(url.split('?')[0])) {
        if (opts.patchFails) return send(200, { success: false, errors: [{ message: 'nope' }] });
        return send(200, { success: true, result: { name: 'p' } });
      }

      // GET …/deployments?env=preview&page=N → list
      if (req.method === 'GET' && url.includes('/deployments?')) {
        if (opts.listFails) return send(200, { success: false, errors: [{ message: 'denied' }] });
        const page = Number(new URL('http://x' + url).searchParams.get('page') ?? '1');
        // All deployments on page 1; empty thereafter (signals end of list).
        const result =
          page === 1
            ? (opts.deployments ?? []).map((d) => ({
                id: d.id,
                deployment_trigger: { metadata: { branch: d.branch } },
              }))
            : [];
        return send(200, { success: true, result });
      }

      // DELETE …/deployments/<id>?force=true
      const delMatch = url.match(/\/deployments\/([^/?]+)\?force=true/);
      if (req.method === 'DELETE' && delMatch) {
        const id = delMatch[1];
        if (opts.failDeleteIds?.has(id)) {
          return send(200, { success: false, errors: [{ message: 'already gone' }] });
        }
        return send(200, { success: true, result: null });
      }

      send(404, { success: false, errors: [{ message: 'unexpected route ' + url }] });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}`, reqs });
    });
  });
}

// Run the script ASYNCHRONOUSLY (not execFileSync): the mock CF API runs in
// THIS process, so a synchronous spawn would block the event loop and curl
// would never get a response (deadlock).
async function run(
  script: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ status: number; stdout: string }> {
  try {
    const { stdout } = await execFileAsync('bash', [script, ...args], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    return { status: 0, stdout };
  } catch (e) {
    const err = e as { code?: number; stdout?: string | Buffer };
    return { status: err.code ?? 1, stdout: String(err.stdout ?? '') };
  }
}

let mock: Awaited<ReturnType<typeof startMock>> | undefined;
afterEach(() => {
  mock?.server.close();
  mock = undefined;
});

const CREDS = { CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acct' };

describe('cf-preview-cleanup.sh', () => {
  it('deletes ONLY deployments whose branch matches the target pr-<N>', async () => {
    mock = await startMock({
      deployments: [
        { id: 'a1', branch: 'pr-786' },
        { id: 'b2', branch: 'pr-999' }, // different PR — must NOT be deleted
        { id: 'c3', branch: 'pr-786' },
        { id: 'd4', branch: 'main' }, // production branch — must NOT be deleted
      ],
    });
    const r = await run(CLEANUP, ['pr-786'], { ...CREDS, CF_API_BASE: mock.base });
    expect(r.status).toBe(0);

    const deletes = mock.reqs.filter((q) => q.method === 'DELETE');
    const deletedIds = deletes.map((q) => q.url.match(/\/deployments\/([^/?]+)/)?.[1]).sort();
    expect(deletedIds).toEqual(['a1', 'c3']);
    // Every delete uses force=true.
    expect(deletes.every((q) => q.url.includes('force=true'))).toBe(true);
    // Lists the PREVIEW scope.
    expect(mock.reqs.some((q) => q.method === 'GET' && q.url.includes('env=preview'))).toBe(true);
  });

  it('is a no-op (exit 0) when no deployment matches the branch', async () => {
    mock = await startMock({ deployments: [{ id: 'x', branch: 'pr-1' }] });
    const r = await run(CLEANUP, ['pr-786'], { ...CREDS, CF_API_BASE: mock.base });
    expect(r.status).toBe(0);
    expect(mock.reqs.some((q) => q.method === 'DELETE')).toBe(false);
    expect(r.stdout).toMatch(/nothing to delete/i);
  });

  it('tolerates a per-deployment DELETE failure without going red', async () => {
    mock = await startMock({
      deployments: [
        { id: 'a1', branch: 'pr-5' },
        { id: 'a2', branch: 'pr-5' },
      ],
      failDeleteIds: new Set(['a1']),
    });
    const r = await run(CLEANUP, ['pr-5'], { ...CREDS, CF_API_BASE: mock.base });
    expect(r.status).toBe(0); // overall still succeeds
    expect(mock.reqs.filter((q) => q.method === 'DELETE').length).toBe(2);
    expect(r.stdout).toMatch(/could not delete a1/);
    expect(r.stdout).toMatch(/deleted a2/);
  });

  it('tolerates a LIST failure (warn + exit 0, no deletes)', async () => {
    mock = await startMock({ listFails: true });
    const r = await run(CLEANUP, ['pr-5'], { ...CREDS, CF_API_BASE: mock.base });
    expect(r.status).toBe(0);
    expect(mock.reqs.some((q) => q.method === 'DELETE')).toBe(false);
    expect(r.stdout).toMatch(/list deployments failed/i);
  });

  it('no-ops (exit 0) without creds, hitting NO API', async () => {
    mock = await startMock({ deployments: [{ id: 'a', branch: 'pr-5' }] });
    const r = await run(CLEANUP, ['pr-5'], { CF_API_BASE: mock.base }); // no token/acct
    expect(r.status).toBe(0);
    expect(mock.reqs.length).toBe(0);
  });

  it('exits 2 on a usage error (missing branch arg)', async () => {
    const r = await run(CLEANUP, [], { ...CREDS });
    expect(r.status).toBe(2);
  });
});

describe('cf-clear-preview-beta-gate.sh', () => {
  it('PATCHes BETA_GATE_PASS = null to remove it from the preview scope', async () => {
    mock = await startMock({});
    const r = await run(CLEARGATE, [], { ...CREDS, CF_API_BASE: mock.base });
    expect(r.status).toBe(0);
    const patch = mock.reqs.find((q) => q.method === 'PATCH');
    expect(patch).toBeDefined();
    const body = JSON.parse(patch!.body);
    // null value on the Preview scope key = "delete this env var". Partial
    // PATCH, so it targets ONLY the preview scope (not production).
    expect(body.deployment_configs.preview.env_vars).toHaveProperty('BETA_GATE_PASS', null);
  });

  it('no-ops (exit 0, no PATCH) when CF creds are unset', async () => {
    mock = await startMock({});
    const r = await run(CLEARGATE, [], { CF_API_BASE: mock.base }); // no token/acct
    expect(r.status).toBe(0);
    expect(mock.reqs.some((q) => q.method === 'PATCH')).toBe(false);
  });

  it('tolerates a PATCH failure (warn + exit 0) — safe default: preview stays gated', async () => {
    mock = await startMock({ patchFails: true });
    const r = await run(CLEARGATE, [], { ...CREDS, CF_API_BASE: mock.base });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/could not PATCH preview env/i);
  });
});
