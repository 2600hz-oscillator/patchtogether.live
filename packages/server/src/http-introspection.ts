// packages/server/src/http-introspection.ts
//
// Hocuspocus extension that exposes two HTTP routes on the SAME listener
// the WS server uses (the Hocuspocus `Server` wraps `http.createServer`
// and the `onRequest` hook lets extensions reply before the default 200
// OK handler):
//
//   GET /health   — liveness probe. Returns 200 + `{ ok: true }`. Used by
//                   Fly health checks + the live-smoke-alert workflow.
//   GET /metrics  — JSON snapshot of process resources + Hocuspocus state.
//                   Scraped by BetterStack / the live-smoke workflow to
//                   catch relay memory blowouts BEFORE they OOM the Fly
//                   machine (per memory `project_observability_priority.md`
//                   — the relay OOM that went unalerted is the urgency).
//
// Auth: neither route is gated. `/health` has always been public on similar
// services; `/metrics` is intentionally lightweight (no secrets, just
// process counters) and serves as an internal scrape target — the Fly
// machine isn't reachable from the public internet without going through
// the app's domain, so anyone hitting it is already on the deploy path.
//
// Memory-alarm threshold: also drives the 30-s setInterval that logs a
// `warn` line when rss > RELAY_MEM_WARN_MB and an `error` line when
// rss > RELAY_MEM_CRIT_MB. This is the "alarm before OOM" half — the
// /metrics endpoint is the "scrape after the fact" half.

import type { Extension } from '@hocuspocus/server';

// Structural subset of @hocuspocus/server's Hocuspocus instance we need.
// Importing the deep d.ts path trips nodenext + verbatimModuleSyntax (see
// the same workaround in heartbeat.ts).
interface HocuspocusLike {
  getConnectionsCount(): number;
  getDocumentsCount(): number;
  /** Snapshot-store mode the relay resolved at boot — 'r2' (blobs in object
   *  storage, Postgres fallback), 'postgres' (durable rows), or 'memory'
   *  (process-local, lost on restart). Surfaced on /health + /metrics so a
   *  misconfigured prod relay serving a non-persistent rack is observable.
   *  See packages/server/src/snapshot-store.ts. */
  getPersistenceMode(): 'r2' | 'postgres' | 'memory';
  /** Count of uncaught exceptions the relay caught + stayed up through since
   *  boot. Optional so existing callers/tests need no change; absent → 0.
   *  See packages/server/src/relay-error-handlers.ts. */
  getUncaughtExceptions?(): number;
  /** Count of unhandled promise rejections caught since boot (see above). */
  getUnhandledRejections?(): number;
}

/** Process-level numbers that change at sub-second cadence. */
export interface MetricsSnapshot {
  ts: number;
  boot_id: string;
  /** Deploy version string from the SERVER_VERSION env (per-tier, e.g.
   *  '1.0.1-prod'); 'unknown' when unset. Lets a monitor / deploy smoke confirm
   *  WHICH build is live and detect a stale relay by a web↔relay version drift. */
  server_version: string;
  uptime_s: number;
  rss_mb: number;
  heap_used_mb: number;
  heap_total_mb: number;
  ext_mb: number;
  cpu_user_s: number;
  cpu_system_s: number;
  conns: number;
  rooms: number;
  persist_writes_per_min: number;
  /** Snapshot-store mode: 'r2' (blobs in object storage), 'postgres'
   *  (durable rows), or 'memory' (lost on restart). A prod relay reporting
   *  'memory' is serving a non-persistent rack. */
  persist_mode: 'r2' | 'postgres' | 'memory';
  /** Uncaught exceptions the relay caught + stayed up through since boot.
   *  Non-zero → pair with the tagged `event=relay_uncaught_exception` log line. */
  relay_uncaught_exceptions: number;
  /** Unhandled promise rejections caught since boot (see above; tag
   *  `event=relay_unhandled_rejection`). */
  relay_unhandled_rejections: number;
  /** Unified early-warning rollup over memory + caught exceptions, so a single
   *  Better Stack keyword uptime monitor (looking for `"alert_state":"ok"`)
   *  catches BOTH a pre-OOM memory climb AND any non-fatal exception — no log
   *  pipeline, no ClickHouse. Derived purely from the snapshot inputs:
   *   - 'crit' when rss > critMb OR either exception counter is > 0
   *   - 'warn' when warnMb < rss <= critMb (and no exceptions)
   *   - 'ok'   otherwise
   *  See `computeAlertState`. */
  alert_state: 'ok' | 'warn' | 'crit';
}

/** Pluggable deps so tests can pin the clock + memory readings. */
export interface IntrospectionDeps {
  now(): number;
  /** Monotonic seconds since process boot. Mirrors `process.uptime()`. */
  uptime(): number;
  memoryUsage(): {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
  };
  cpuUsage(): { user: number; system: number };
  setInterval(fn: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(t: ReturnType<typeof setInterval>): void;
  log(level: 'info' | 'warn' | 'error', msg: string): void;
  /** Best-effort HTTP GET — used only for the Better Stack heartbeat ping.
   *  Injected so tests can assert the ping without real network; defaults to
   *  the global fetch. */
  fetch(url: string): Promise<unknown>;
}

const realDeps: IntrospectionDeps = {
  now: () => Date.now(),
  uptime: () => process.uptime(),
  memoryUsage: () => process.memoryUsage(),
  // `process.cpuUsage()` returns microseconds since boot when called with
  // no arg. We divide by 1e6 in the snapshot below to land on seconds.
  cpuUsage: () => process.cpuUsage(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (t) => clearInterval(t),
  // eslint-disable-next-line no-console
  log: (level, msg) => console[level](msg),
  fetch: (url) => fetch(url),
};

const BYTES_PER_MB = 1024 * 1024;
const ALARM_CHECK_INTERVAL_MS = 30_000;
const PERSIST_WINDOW_MS = 60_000;

/** Read thresholds from env (or fall back to defaults sized for the
 *  512 MB Fly machine — warn well below crit so we get a single noisy
 *  log line before the OOM-killer territory). */
export function readMemoryThresholds(
  env: Record<string, string | undefined> = process.env,
): { warnMb: number; critMb: number } {
  const parse = (raw: string | undefined, fallback: number): number => {
    if (raw == null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    warnMb: parse(env.RELAY_MEM_WARN_MB, 384),
    critMb: parse(env.RELAY_MEM_CRIT_MB, 480),
  };
}

/** Map an RSS reading to the log level it should fire at (or `null` for
 *  "below warn — quiet"). Pure for ease of testing. */
export function classifyMemory(
  rssMb: number,
  thresholds: { warnMb: number; critMb: number },
): 'warn' | 'error' | null {
  if (rssMb > thresholds.critMb) return 'error';
  if (rssMb > thresholds.warnMb) return 'warn';
  return null;
}

/** Unified `alert_state` for the /metrics rollup. Pure for unit-testing.
 *
 *  Reuses {@link classifyMemory} for the memory half ('error'→crit, 'warn',
 *  or null→ok), then escalates to 'crit' whenever either caught-exception
 *  counter is > 0 — so a single keyword monitor catches both a pre-OOM memory
 *  climb and any non-fatal exception. */
export function computeAlertState(
  rssMb: number,
  uncaughtExceptions: number,
  unhandledRejections: number,
  thresholds: { warnMb: number; critMb: number },
): 'ok' | 'warn' | 'crit' {
  if (uncaughtExceptions > 0 || unhandledRejections > 0) return 'crit';
  const mem = classifyMemory(rssMb, thresholds);
  if (mem === 'error') return 'crit';
  if (mem === 'warn') return 'warn';
  return 'ok';
}

export interface IntrospectionExtension extends Extension {
  /** Test-only: build a snapshot synchronously (skips the HTTP path). */
  _snapshot(): MetricsSnapshot;
  /** Test-only: invoke the alarm check once. */
  _alarmTick(): void;
  /** Test-only: invoke the Better Stack heartbeat ping once. */
  _pingHeartbeat(): Promise<void>;
}

/**
 * Build the extension. `hocuspocus` is the Hocuspocus instance the server
 * was configured with, used to read live conn/room counts.
 *
 * Memory thresholds default to env-derived values but can be overridden
 * for tests via `thresholdOverride`.
 */
export function createIntrospectionExtension(
  hocuspocus: HocuspocusLike,
  options: {
    deps?: Partial<IntrospectionDeps>;
    thresholdOverride?: { warnMb: number; critMb: number };
    env?: Record<string, string | undefined>;
    /** Reuse a process-wide boot id (so /health + /metrics agree with the
     *  tagged error-handler log lines). Falls back to a fresh per-instance id
     *  when omitted — that fallback keeps each independently-constructed
     *  extension distinct, which the unit tests rely on. */
    bootId?: string;
  } = {},
): IntrospectionExtension {
  const deps: IntrospectionDeps = { ...realDeps, ...(options.deps ?? {}) };
  const env = options.env ?? process.env;
  const thresholds = options.thresholdOverride ?? readMemoryThresholds(env);
  // Per-tier deploy version (set in fly.<tier>.toml [env]); surfaced on /health
  // + /metrics so a monitor / deploy smoke can confirm which build is live.
  const serverVersion = env.SERVER_VERSION ?? 'unknown';
  // Better Stack heartbeat: when set (Fly secret), the alarm interval pings it
  // so an alert fires if the introspection path silently dies while /health
  // still 200s. Unset → no-op (local/dev/CI unaffected).
  const heartbeatUrl = env.BETTERSTACK_HEARTBEAT_URL;

  // Persisted across the process lifetime — a fresh boot gets a new id,
  // so a downstream watcher can detect "the relay restarted" by id flip.
  const bootId = options.bootId ?? newBootId(deps);

  // Ring of persist-write timestamps inside the last PERSIST_WINDOW_MS.
  // Bounded by the persist cadence so memory usage stays trivial.
  let persistWrites: number[] = [];

  // 30-s alarm timer — only started once `start()` is called by the
  // extension lifecycle so tests that build the extension without an
  // active timer don't leak intervals.
  let alarmTimer: ReturnType<typeof setInterval> | null = null;

  function snapshot(): MetricsSnapshot {
    const mem = deps.memoryUsage();
    const cpu = deps.cpuUsage();
    const cutoff = deps.now() - PERSIST_WINDOW_MS;
    // Trim the ring opportunistically each scrape; cheap O(n) for n ~ tens.
    persistWrites = persistWrites.filter((t) => t >= cutoff);
    const rssMb = round(mem.rss / BYTES_PER_MB, 1);
    const uncaught = hocuspocus.getUncaughtExceptions?.() ?? 0;
    const unhandled = hocuspocus.getUnhandledRejections?.() ?? 0;
    return {
      ts: deps.now(),
      boot_id: bootId,
      server_version: serverVersion,
      uptime_s: round(deps.uptime(), 3),
      rss_mb: rssMb,
      heap_used_mb: round(mem.heapUsed / BYTES_PER_MB, 1),
      heap_total_mb: round(mem.heapTotal / BYTES_PER_MB, 1),
      ext_mb: round(mem.external / BYTES_PER_MB, 1),
      cpu_user_s: round(cpu.user / 1_000_000, 3),
      cpu_system_s: round(cpu.system / 1_000_000, 3),
      conns: hocuspocus.getConnectionsCount(),
      rooms: hocuspocus.getDocumentsCount(),
      persist_writes_per_min: persistWrites.length,
      persist_mode: hocuspocus.getPersistenceMode(),
      relay_uncaught_exceptions: uncaught,
      relay_unhandled_rejections: unhandled,
      alert_state: computeAlertState(rssMb, uncaught, unhandled, thresholds),
    };
  }

  function alarmTick(): void {
    const mem = deps.memoryUsage();
    const rssMb = round(mem.rss / BYTES_PER_MB, 1);
    const level = classifyMemory(rssMb, thresholds);
    if (level === null) return;
    const tag = level === 'error' ? 'CRIT' : 'warn';
    deps.log(
      level,
      `[relay-alarm] ${tag} rss=${rssMb}MB warn=${thresholds.warnMb}MB crit=${thresholds.critMb}MB ` +
        `boot_id=${bootId} uptime_s=${round(deps.uptime(), 0)}`,
    );
  }

  // Best-effort liveness ping to a Better Stack heartbeat. No-ops when the env
  // var is unset; swallows every error so a flaky heartbeat endpoint can never
  // disturb the relay. Fires from the same 30-s interval as the memory alarm
  // (well inside a 2-min heartbeat window).
  async function pingHeartbeat(): Promise<void> {
    if (!heartbeatUrl) return;
    try {
      await deps.fetch(heartbeatUrl);
    } catch {
      // Intentionally ignored — heartbeat is observability, never load-bearing.
    }
  }

  return {
    extensionName: 'http-introspection',

    async onConfigure() {
      // Boot the alarm timer here so it's tied to the server lifecycle.
      // We never stop it explicitly — the process exits with it.
      if (alarmTimer === null) {
        alarmTimer = deps.setInterval(() => {
          alarmTick();
          void pingHeartbeat();
        }, ALARM_CHECK_INTERVAL_MS);
      }
    },

    async onDestroy() {
      if (alarmTimer !== null) {
        deps.clearInterval(alarmTimer);
        alarmTimer = null;
      }
    },

    // Record a timestamp every time Hocuspocus stores a doc. Persist
    // throughput is a useful proxy for "is the rack actually active"
    // and pairs naturally with the conn/room counters.
    async afterStoreDocument() {
      persistWrites.push(deps.now());
      // Keep the ring trimmed even if /metrics isn't being scraped.
      const cutoff = deps.now() - PERSIST_WINDOW_MS;
      if (persistWrites.length > 0 && persistWrites[0]! < cutoff) {
        persistWrites = persistWrites.filter((t) => t >= cutoff);
      }
    },

    async onRequest(payload) {
      const url = payload.request.url ?? '/';
      // Strip query — `/metrics?fresh=1` should match.
      const path = url.split('?')[0];
      if (path === '/health') {
        payload.response.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        payload.response.end(
          JSON.stringify({
            ok: true,
            boot_id: bootId,
            server_version: serverVersion,
            persist: hocuspocus.getPersistenceMode(),
          }),
        );
        // Throw an empty error: Hocuspocus's Server.requestHandler treats
        // this as "an extension already replied, skip the default 200 OK".
        // (See the dist/hocuspocus-server.esm.js requestHandler: `if (error) throw error`
        // is preceded by a `catch` that does nothing on falsy error — but
        // crucially the catch returns BEFORE the default writeHead. Empty
        // string is falsy and skips the rethrow.)
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw '';
      }
      if (path === '/metrics') {
        const body = JSON.stringify(snapshot());
        payload.response.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        payload.response.end(body);
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw '';
      }
      // Any other path: do nothing → default 200 OK from Hocuspocus.
    },

    _snapshot() {
      return snapshot();
    },
    _alarmTick() {
      alarmTick();
    },
    _pingHeartbeat() {
      return pingHeartbeat();
    },
  };
}

/** Round to `digits` decimals. Avoids JSON noise from raw float math. */
function round(n: number, digits: number): number {
  const m = 10 ** digits;
  return Math.round(n * m) / m;
}

function newBootId(deps: Pick<IntrospectionDeps, 'now'>): string {
  // Short id — the deploy doesn't need cryptographic uniqueness, just
  // enough variation that a restart is obvious in the scrape stream.
  return `${deps.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const RELAY_MEM_ALARM_INTERVAL_MS = ALARM_CHECK_INTERVAL_MS;
export const RELAY_PERSIST_WINDOW_MS = PERSIST_WINDOW_MS;
