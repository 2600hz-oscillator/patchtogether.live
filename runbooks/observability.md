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
the dev web `/api/health` + relay `/health` and `/metrics`. It keeps **exactly one
open GitHub issue per distinct alert**, reconciled on every run by
`scripts/alert-issues.mjs`:

| probe says | open issue for the key? | action |
| --- | --- | --- |
| check failing | no | **open** an issue (emails watchers) |
| check failing | yes | **edit** its stats block — last-seen + consecutive count. No notification. |
| check passing | yes | **comment** "recovered" + **close** |

The dedup key is `live-smoke/<web-url-host>/<check-id>` — e.g.
`live-smoke/dev.patchtogether.live/web-db-unreachable`. It is built only from the
environment and the probe's own branch identifier, never from the error text
(which embeds upstream HTTP bodies that vary per run), and it is carried in an
HTML-comment marker in the issue body so a human can retitle the issue freely.

Three properties worth knowing before you touch it, all unit-tested in
`scripts/alert-issues.test.ts`:

- **Dedup, not suppression.** There is no cooldown/backoff anywhere. A different
  check failing is a different key, so a genuinely new outage opens its own issue
  and notifies immediately, even in the middle of an existing incident.
- **An issue with no key marker is never touched** — human-filed issues cannot be
  edited, commented on, or auto-closed by the workflow.
- **A probe that produced no usable result closes nothing** and raises its own
  `probe-harness` alert. A monitor that cannot measure never reads as green.

Alert state lives in the issues themselves (first-seen / last-seen / consecutive
count), not in an artifact — artifacts expire and silently reset the state machine.

```sh
# Print the reconcile plan without writing any issue:
flox activate -- gh workflow run live-smoke-alert.yml -f dry_run=true

# Same, locally, against a captured probe log:
flox activate -- bash scripts/live-smoke-alert.sh > /tmp/smoke.out 2>&1
SMOKE_LOG=/tmp/smoke.out ALERT_DRY_RUN=1 flox activate -- node scripts/alert-issues.mjs reconcile
```

Adding a probe branch to `scripts/live-smoke-alert.sh` means adding its
`failures+=("id")` literal to `KNOWN_CHECK_IDS` (and a `CHECK_TITLES` phrase) in
`scripts/alert-issues.mjs` — the `unit` lane pins the two lists to each other.

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

## BetterStack — LIVE (set up 2026-06-10, verified 2026-08-11)

Better Stack is **not optional and not pending** — it is the primary alerting
path for both dev and prod, on top of the GitHub Actions backstop. As of
2026-08-11 there are **8 uptime monitors** (4 per tier: web `/api/health`, relay
`/health`, relay `/metrics`, and a `/metrics` keyword monitor on
`alert_state":"ok`) plus **2 heartbeats** (relay dev + relay prod, 60 s period /
240 s grace). All were `up` at last check.

Cadence is **180 s** for the six relay monitors and **1800 s** for the two
`/api/health` monitors — the latter deliberately slow so the poll does not keep
the Neon compute permanently awake. Notification is **email only**: no
escalation policy, no SMS, no phone.

The standing-up *procedure* is documented at:

> **[`docs/observability/setup-betterstack.md`](../docs/observability/setup-betterstack.md)**
> — but read the warning at the top of that file: it is a plan, and several of
> its numbers were never executed as written.

**The live inventory — monitor IDs, heartbeat IDs, on-call, dashboards — is not
in this repo.** It lives in the private infra-docs repo
(`runbooks/observability.md`), because it is operational detail tied to account
resources. Use a team-owned contact email; do not hard-code a personal address
into this repo.
