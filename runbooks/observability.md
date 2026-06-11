# Observability

The relay exposes two HTTP endpoints, runs a memory alarm, and is backstopped by a
GitHub Actions cron probe. Optional BetterStack adds faster paging on top.

## Endpoints

### Web tier — `GET /api/health`

Public (no auth — carved out of the beta gate). Reports **boolean presence** of
config plus an `INVITE_SECRET` fingerprint for drift detection. **Never returns
secret values.**

```sh
curl https://dev.patchtogether.live/api/health
```

Reports (shape; verify current fields in `packages/web/src/routes/api/health/+server.ts`):

- `CLERK_SECRET_KEY` present (true/false)
- `PUBLIC_CLERK_PUBLISHABLE_KEY` present (true/false)
- `INVITE_SECRET` fingerprint (length + short SHA-256 prefix — used to confirm web
  and relay share the same secret)

### Relay tier — `GET /health` and `GET /metrics`

Source: `packages/server/src/http-introspection.ts`.

```sh
curl https://patchtogether-server-dev.fly.dev/health    # {ok, boot_id, persist}
curl https://patchtogether-server-dev.fly.dev/metrics   # JSON snapshot
```

`/health` returns `{ ok: true, boot_id, persist: 'postgres' | 'memory' }`.
`persist: 'memory'` on a prod relay means it's serving a **non-persistent** rack —
a misconfiguration to catch.

`/metrics` returns a JSON snapshot including (verify exact fields in the source):

| Field | Meaning |
| --- | --- |
| `ts` | timestamp |
| `boot_id` | per-process id; flips on restart (observability keys on this) |
| `rss_mb`, `heap_used_mb` | memory |
| `conns`, `rooms` | live WebSocket connections / active rackspaces |
| `persist_writes_per_min` | snapshot persistence rate |
| `persist_mode` | `postgres` or `memory` |
| `relay_uncaught_exceptions`, `relay_unhandled_rejections` | process error counters |

## Memory alarm

Every 30 s the relay checks RSS against two thresholds (defaults; tunable via Fly
secrets without a redeploy):

| Threshold | Default | Effect |
| --- | --- | --- |
| `RELAY_MEM_WARN_MB` | 384 | logs a `warn` line every 30 s |
| `RELAY_MEM_CRIT_MB` | 480 | logs an `error` line; live-smoke opens a GH issue |

```sh
flox activate -- flyctl secrets set RELAY_MEM_WARN_MB=384 RELAY_MEM_CRIT_MB=480 -a patchtogether-server-dev
```

> The 256 MB Fly machines have 512 MB total, so these defaults leave a small
> margin before the OOM-killer. If you scale to larger machines, **retune** the
> thresholds or the warning becomes useless.

Process error guards (`packages/server/src/relay-error-handlers.ts`) catch
uncaught exceptions / unhandled rejections, emit a tagged log line
(`event=relay_uncaught_exception boot_id=…`), bump a counter, and keep the process
up. To find these in logs:

```sh
flox activate -- flyctl logs -a patchtogether-server-dev | grep -E 'relay_uncaught_exception|relay_unhandled_rejection'
flox activate -- flyctl logs -a patchtogether-server-dev | grep '\[relay-alarm\]'
```

## Live-smoke-alert workflow

`.github/workflows/live-smoke-alert.yml` runs on a cron (~every 10 min) and probes
the dev web `/api/health` + relay `/health` and `/metrics`. It opens a GitHub
issue on a health transition or sustained unhealth, and tracks state in an
artifact to avoid alert spam (a transition to "unhealthy" requires two consecutive
unhealthy probes, so a single transient hiccup doesn't fire).

```sh
# Force the alert path for testing (bypasses state):
flox activate -- gh workflow run live-smoke-alert.yml -f force_fire=true

# Inspect the persisted alert state:
flox activate -- gh run download <run-id> --name live-smoke-state --dir /tmp
```

Local dry-run (no GH issue):

```sh
flox activate -- bash scripts/live-smoke-alert.sh --dry-run     # honors WEB_URL / RELAY_URL / MEM_CRIT_MB overrides
```

Configurable via repo **Variables** (not secrets): `LIVE_SMOKE_WEB_URL`,
`LIVE_SMOKE_RELAY_URL`, `LIVE_SMOKE_CRIT_MB`. Beta-gate basic-auth creds for the
probe come from repo secrets (`DEV_BETA_GATE_PASS`, etc.) — see
[secrets-and-accounts.md](secrets-and-accounts.md).

## Deploy-time smoke

After an autotest deploy, `deploy.yml`'s `smoke-live` job runs `@smoke`-tagged e2e
+ `scripts/anon-handshake-smoke.mjs` against the live URL to catch
`INVITE_SECRET` drift and broken auth immediately. See [deployment.md](deployment.md).

## Chaos fuzzing

`chaos-24-7.yml` runs hourly against autotest via an invite link (log-only
invariants mode — findings are uploaded as artifacts, the job doesn't fail).
Review the `chaos-findings-<run-id>` artifact for invariant violations.

## BetterStack (optional, faster paging)

BetterStack is the **upgrade path** on top of the GitHub Actions backstop: 30 s
cadence (vs 10 min), per-channel escalation, and richer historical graphs. Setup
is a **manual operator step** documented here:

> **[`docs/observability/setup-betterstack.md`](../docs/observability/setup-betterstack.md)**

It monitors three surfaces: web dev `/api/health`, relay dev `/health`, and relay
dev `/metrics` (body match on `rss_mb` exceeding the critical threshold). Follow
that doc to create the account and the three monitors — use a team-owned contact
email (do not hard-code a personal address into the repo).
