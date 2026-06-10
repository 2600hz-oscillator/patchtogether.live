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
