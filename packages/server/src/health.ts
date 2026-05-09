// packages/server/src/health.ts
//
// /health endpoint payload + handler factory for the Hocuspocus server.
//
// Exposed as a sibling HTTP route on the same port Hocuspocus already
// owns — wired up via the `onRequest` extension hook in index.ts. Keeps
// us from binding a second port (Fly's TCP check probes only one port,
// and we want both BetterStack JSON-keyword + Fly TCP to use the same
// surface).
//
// Why expose mem + uptime + connection count + restart counter:
//   - mem_mb  — early signal before the 256MB Fly cap OOM-kills us
//   - uptime_s — confirms the process didn't just restart out from under
//                the monitor (an LLM agent reading this can spot crash-
//                looping pods at a glance)
//   - boot_id — pairs with logger.ts so a connect-then-disconnect within
//               the same boot_id is one process instance
//   - version — the server image version (set via env at build time so
//               the agent can confirm a deploy actually rolled out)
//
// Returns 200 when nothing's flagged. We do NOT return 5xx on degraded
// state today — Hocuspocus running but a doc store backing-down is a
// separate signal we'd want to add later. For now /health is "process
// alive and responsive."

import { getBootId } from './logger.js';

const startedAt = Date.now();
const SERVER_VERSION = process.env.SERVER_VERSION ?? 'unknown';

export interface HealthSnapshot {
  ok: true;
  status: 'healthy';
  version: string;
  boot_id: string;
  uptime_s: number;
  mem_mb: number;
  conns: number;
  ts: string;
}

export function healthSnapshot(connCount: number): HealthSnapshot {
  const memMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
  return {
    ok: true,
    status: 'healthy',
    version: SERVER_VERSION,
    boot_id: getBootId(),
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    mem_mb: memMb,
    conns: connCount,
    ts: new Date().toISOString(),
  };
}

/**
 * Handles GET /health on Hocuspocus's HTTP listener.
 *
 * Returns true if the request matched and was handled (caller should throw
 * an empty error to short-circuit Hocuspocus's default "OK" response).
 * Returns false if the URL doesn't match — caller lets the next hook (or
 * Hocuspocus's default) handle it.
 */
export function handleHealthRequest(
  req: { url?: string; method?: string },
  res: {
    writeHead: (code: number, headers: Record<string, string>) => void;
    end: (body: string) => void;
  },
  connCount: number,
): boolean {
  if ((req.method ?? 'GET').toUpperCase() !== 'GET') return false;
  // Match `/health` and `/health?…` and `/health/` to be forgiving with
  // monitors that append trailing slashes.
  const url = req.url ?? '/';
  const path = url.split('?')[0];
  if (path !== '/health' && path !== '/health/') return false;
  const body = JSON.stringify(healthSnapshot(connCount));
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
  return true;
}
