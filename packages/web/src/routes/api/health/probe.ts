// packages/web/src/routes/api/health/probe.ts
//
// Pure, dependency-injected helpers for the web /api/health cross-tier relay
// probe. Deliberately free of $env / SvelteKit imports so they unit-test
// headlessly (probe.test.ts) — the +server.ts handler wires the real build-time
// env + global fetch around them. This gives uptime monitors a SINGLE web
// endpoint whose `status` also reflects relay reachability, the cross-tier
// signal the bare web /api/health lacked.

export interface HocuspocusProbe {
  ok: boolean;
  /** Round-trip time in ms (only on a completed fetch). */
  ms?: number;
  /** Human-readable failure reason (only when !ok). Never a secret. */
  error?: string;
}

/** Translate the relay's WS URL to its HTTP /health URL.
 *  `wss://host[:port]` → `https://host[:port]/health`; `ws://` → `http://…`. */
export function wsToHealthUrl(wsUrl: string): string {
  const base = wsUrl.replace(/^ws/, 'http').replace(/\/+$/, '');
  return `${base}/health`;
}

export interface ProbeDeps {
  fetch: typeof fetch;
  now: () => number;
  timeoutMs: number;
}

/**
 * Probe the relay's /health with a hard timeout. NEVER throws — a failure is
 * reported as `{ ok:false, error }` so the web /api/health endpoint can stay
 * HTTP 200 (degraded state lives in the body, not the status code, for
 * backward-compat with existing uptime monitors + @smoke tests).
 *
 * An unset relay URL is reported as a degraded reason, not an exception, so a
 * local/dev deploy without VITE_SERVER_WS_URL renders cleanly.
 */
export async function probeHocuspocus(
  wsUrl: string | undefined,
  deps: Partial<ProbeDeps> = {},
): Promise<HocuspocusProbe> {
  if (!wsUrl) return { ok: false, error: 'relay url unset (VITE_SERVER_WS_URL)' };
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? 1500;
  const url = wsToHealthUrl(wsUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = now();
  try {
    const res = await doFetch(url, { signal: controller.signal });
    const ms = now() - start;
    if (!res.ok) return { ok: false, ms, error: `relay /health status ${res.status}` };
    return { ok: true, ms };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'relay probe failed' };
  } finally {
    clearTimeout(timer);
  }
}

export interface DatabaseProbe {
  /** True iff the DB was REACHED and the probe query returned. */
  ok: boolean;
  /** Migration currency (only when reachable): 'mode-missing' = the pre-005
   *  schema-drift class that 500'd every racks.mode read for a week
   *  (deploy-before-migrate) while `db:'configured'` still said 200. */
  schema?: 'current' | 'mode-missing';
  /** Round-trip time in ms (only on a completed query). */
  ms?: number;
  /** Human-readable failure reason (only when !ok). Never a secret. */
  error?: string;
}

export interface DbProbeDeps {
  /** Runs the migration-marker query and resolves to the number of rows
   *  matching the racks.mode information_schema lookup (1 = column present /
   *  005 applied, 0 = pre-005), or REJECTS if the DB is unreachable. The
   *  +server.ts wires this to the real Neon `sql()`; tests inject a fake. */
  queryModeColumnCount: () => Promise<number>;
  now: () => number;
  timeoutMs: number;
}

/**
 * Probe the Postgres tier with a REAL read — an information_schema lookup for
 * the racks.mode column (the marker for migration 005). NEVER throws: an
 * unreachable DB is `{ ok:false, error }`; a reachable-but-pre-005 DB is
 * `{ ok:true, schema:'mode-missing' }`. This is the signal the presence-only
 * `DATABASE_URL ? 'configured'` check LACKED — it returned 200 while every
 * racks.mode read 500'd for a week. Bounded so a stuck DB can't hang the health
 * endpoint (the query may keep running in the background if the timeout wins,
 * but the probe returns); information_schema is chosen over `SELECT mode` so the
 * probe is data-independent and never itself trips the mode()-aggregate 42809.
 */
export async function probeDatabase(
  hasUrl: boolean,
  deps: Partial<DbProbeDeps> = {},
): Promise<DatabaseProbe> {
  if (!hasUrl) return { ok: false, error: 'database url unset (DATABASE_URL)' };
  const run = deps.queryModeColumnCount;
  if (!run) return { ok: false, error: 'db probe query not wired' };
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? 2000;
  const start = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const count = await Promise.race<number>([
      run(),
      new Promise<number>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`db probe timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    return { ok: true, schema: count > 0 ? 'current' : 'mode-missing', ms: now() - start };
  } catch (e) {
    return { ok: false, ms: now() - start, error: e instanceof Error ? e.message : 'db probe failed' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
