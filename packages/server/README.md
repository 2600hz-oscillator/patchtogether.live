# `@patchtogether.live/server`

Hocuspocus collaboration server: one process serves every rackspace, holding live Yjs docs + the per-rack connection-slot tracker in process memory.

For deploy mechanics see [`DEPLOY.md`](./DEPLOY.md). For multi-tier observability wiring see [`../../docs/observability/setup-betterstack.md`](../../docs/observability/setup-betterstack.md).

## HTTP routes

The relay's WS listener also serves three HTTP routes (same port; Hocuspocus' `Server.requestHandler` lets extensions intercept). All three are unauthenticated — the Fly machine is only addressable via the public `*.fly.dev` hostname, so they're effectively internal scrape targets.

| Path | Body | Use |
|---|---|---|
| `GET /health` | `{ "ok": true, "boot_id": "…" }` | Fly TCP/HTTP checks + live-smoke workflow + BetterStack uptime monitor. |
| `GET /metrics` | `MetricsSnapshot` JSON (see below) | BetterStack heartbeat + live-smoke RSS gate. |
| `GET /*` (anything else) | `OK` (Hocuspocus default) | n/a. |

### `MetricsSnapshot` shape

```jsonc
{
  "ts": 1716000000000,        // ms-epoch when the snapshot was built
  "boot_id": "abc-xyz",       // process-lifetime random id; flips on restart
  "uptime_s": 12345.678,
  "rss_mb": 142.3,            // process resident set size — gated by smoke alert
  "heap_used_mb": 78.2,
  "heap_total_mb": 96.0,
  "ext_mb": 4.1,
  "cpu_user_s": 3.21,
  "cpu_system_s": 0.42,
  "conns": 7,                 // live WS connections (Hocuspocus.getConnectionsCount)
  "rooms": 4,                 // live docs (Hocuspocus.getDocumentsCount)
  "persist_writes_per_min": 9 // count of afterStoreDocument calls in the last 60 s
}
```

## Environment variables

Standard config:

| Var | Default | Notes |
|---|---|---|
| `PORT` | `1235` | WS + HTTP routes share this port. `1234` is reserved on dev machines (Bitwig OSC). |
| `HOST` | `0.0.0.0` | |
| `INVITE_SECRET` | — | HMAC key shared with the web tier (anon invite codes). |
| `CLERK_SECRET_KEY` | — | Per-tier; see `DEPLOY.md`. |
| `DATABASE_URL` | — | Neon Postgres for Yjs snapshot persistence. |

Resource-alarm thresholds (added in the observability slice-1 PR):

| Var | Default | Notes |
|---|---|---|
| `RELAY_MEM_WARN_MB` | `384` | When `rss_mb > this`, the alarm interval logs a `warn` line every 30 s. |
| `RELAY_MEM_CRIT_MB` | `480` | When `rss_mb > this`, the alarm logs `error` AND the live-smoke workflow trips. Sized below the Fly machine's 512 MB cap so we get warning before the OOM-killer. |

The thresholds are enforced two ways:

1. **In-process:** a 30-s `setInterval` reads `process.memoryUsage().rss` and writes a tagged log line at the matching level. Fly logs surface in `flyctl logs --app patchtogether-server-…`.
2. **External:** the [Live Smoke Alert workflow](../../.github/workflows/live-smoke-alert.yml) scrapes `/metrics` every 10 minutes and opens a `[CRIT]` GitHub issue when `rss_mb > RELAY_MEM_CRIT_MB`.

To tune for a different Fly machine size, set both `RELAY_MEM_WARN_MB` and `RELAY_MEM_CRIT_MB` via `flyctl secrets set --app patchtogether-server-<tier> RELAY_MEM_WARN_MB=… RELAY_MEM_CRIT_MB=…` (they are intentionally not in the toml so a redeploy isn't needed to re-arm).

## Running tests

```bash
flox activate -- npm test --workspace=@patchtogether.live/server
flox activate -- npm run typecheck --workspace=@patchtogether.live/server
```

Tests cover: auth + capacity + heartbeat + reaper + snapshot config + DB shape + HTTP introspection (route shape + memory-alarm threshold logic).
