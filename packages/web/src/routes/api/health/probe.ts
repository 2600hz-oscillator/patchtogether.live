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
  /** True iff the DB was REACHED and the probe query returned.
   *  ⚠ `null` when the probe DID NOT RUN (the shallow default — see `probed`).
   *  Deliberately NOT `false`: "unreachable" and "not asked" are different
   *  facts, and a consumer that conflates them either false-alarms or, worse,
   *  reads a skipped probe as a healthy one. */
  ok: boolean | null;
  /** Whether the DB query actually ran. FALSE on the shallow `/api/health`,
   *  which is polled every 3 minutes by uptime monitors and must not wake the
   *  database. The field is always PRESENT rather than omitted, so a consumer
   *  can tell "not probed" from "field vanished in a refactor". */
  probed?: boolean;
  /** Why the probe was skipped (only when `probed === false`). */
  skipped?: string;
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

/** The shallow result: the probe did not run, and says so explicitly.
 *
 *  ⚠ WHY THIS EXISTS — measured 2026-08-11. `/api/health` ran a real Neon query
 *  (commit d8726e96, 2026-07-18) and Better Stack polls it every 3 MINUTES on
 *  both prod and dev. Neon suspends idle compute after 300s, so a request every
 *  180s means the gap NEVER opens: both branches sat 99% awake from 2026-07-19
 *  onward, billing the 0.25 CU floor around the clock. Compute was 99.8% of the
 *  bill; storage was three cents. The databases were not working — they were
 *  merely forbidden to sleep. It also consumed the free allowance and caused the
 *  2026-07-29 HTTP 402 outage that 500'd every rackspace URL for ~24 hours.
 *
 *  So the frequently-polled path must not touch the database. Deep checks ask
 *  for it explicitly (`?deep=1`) on a cadence measured in tens of minutes. */
export function skippedDatabaseProbe(reason: string): DatabaseProbe {
  return { ok: null, probed: false, skipped: reason };
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
 *
 * ⚠ It is NOT run on the default `/api/health` — see `skippedDatabaseProbe`.
 */
export async function probeDatabase(
  hasUrl: boolean,
  deps: Partial<DbProbeDeps> = {},
): Promise<DatabaseProbe> {
  if (!hasUrl) return { ok: false, probed: true, error: 'database url unset (DATABASE_URL)' };
  const run = deps.queryModeColumnCount;
  if (!run) return { ok: false, probed: true, error: 'db probe query not wired' };
  const now = deps.now ?? Date.now;
  // ⚠ 2000 ms WAS RIGHT WHEN THE DB WAS ALWAYS AWAKE, AND IS WRONG NOW.
  //
  // The deep probe is opt-in (`?deep=1`) and its only regular caller is the
  // 10-minute live-smoke. 10 min > Neon's 300 s suspend, so EVERY deep probe
  // now lands on COLD compute by construction — the previous design never did,
  // because the 3-minute uptime poll kept the branch permanently awake. That is
  // the whole point of the change, and it moves this timeout from "generous"
  // to "load-bearing".
  //
  // Measured 2026-08-11 on an idle autotest branch (verified `state: idle`,
  // last active 50 min prior): cold 927 ms, warm 51 ms. 927 against 2000 fits,
  // but ~1.1 s of headroom against a CONTENDED cold start is not margin worth
  // trusting — and the failure mode is expensive in the wrong direction: a
  // timeout reports `status:'down'`, which opens an alert issue and pages, so
  // the cheap fix would manufacture false outages.
  //
  // 10 s costs nothing on the warm path (51 ms) and only ever matters on the
  // cold one. Neon's own scale-to-zero guidance puts cold starts in the
  // hundreds of ms; this is ~10x that.
  const timeoutMs = deps.timeoutMs ?? 10_000;
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
    return { ok: true, probed: true, schema: count > 0 ? 'current' : 'mode-missing', ms: now() - start };
  } catch (e) {
    return { ok: false, probed: true, ms: now() - start, error: e instanceof Error ? e.message : 'db probe failed' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
