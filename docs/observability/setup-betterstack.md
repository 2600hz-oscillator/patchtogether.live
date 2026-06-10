# BetterStack setup — slice 1

Status: **manual user step**. The code in this PR is the foundation (probes + `/metrics` + GH Actions backstop); BetterStack adds paging on top.

The GitHub Actions backstop (`.github/workflows/live-smoke-alert.yml`) runs every 10 minutes whether or not BetterStack is configured. BetterStack is the upgrade path: faster cadence (30 s vs 10 min), a per-channel escalation policy, and richer historical graphs.

---

## What we're monitoring

Three surfaces, all wired through BetterStack's same Uptime + Heartbeats product:

| Surface | Type | URL | Paging trigger |
|---|---|---|---|
| Web dev tier | HTTPS uptime monitor | `https://dev.patchtogether.live/api/health` | 5 min sustained downtime |
| Relay dev tier | HTTPS uptime monitor | `https://patchtogether-server-dev.fly.dev/health` | 5 min sustained downtime |
| Relay metrics | HTTPS uptime monitor (body match) | `https://patchtogether-server-dev.fly.dev/metrics` | body's `rss_mb` over this tier's `RELAY_MEM_CRIT_MB` (dev 900 / prod 230) for 3 consecutive scrapes |

Why three: `/api/health` confirms the web tier is up but tells us nothing about the relay. `/health` on the relay confirms the WS server is accepting requests but says nothing about memory. `/metrics` is the canary for the **specific failure mode the slice-1 plan targets**: an unalerted relay OOM (see memory `project_observability_priority.md`).

---

## Step-by-step

### 1. Create a BetterStack account

- Go to <https://betterstack.com/> → Sign up. Use a team-owned email if possible; pull a free-tier seat with `tmayshark@gmail.com` as the contact for now.
- After signup you'll land in **Uptime**. The free tier covers 10 monitors and email alerts — enough for slice 1.

### 2. Add the three monitors

For each row in the table above:

1. **Uptime → Monitors → Create monitor**.
2. **URL or IP** → paste the URL.
3. **Type** → `HTTPS`.
4. **Check frequency** → 30 s (`/api/health` + `/health`) or 1 min (`/metrics`; the body-match is more expensive).
5. **Regions** → `Frankfurt + N. Virginia + Singapore` (3-of-3 must fail before paging — avoids false-positives from a single edge POP outage).
6. **Request settings** → leave method `GET`, no headers needed (the relay is unauthed; the web `/api/health` is in the beta-gate carve-out).
7. **Expected response** → for `/api/health` and `/health`: status `200`. For `/metrics`: open the **Advanced response checks** dialog and add:
   - Match type: **JSON**
   - Path: `$.rss_mb`
   - Condition: **less than**
   - Value: this tier's `RELAY_MEM_CRIT_MB` — **900** for dev (1024 MB box), **230** for prod (256 MB box). These live in `fly.<tier>.toml [env]`; keep the monitor value in step with them (they're two copies of one number — there's no single source of truth across the Better Stack UI and the Fly env).
8. Save.

> Note: `/api/health` now also reflects relay reachability in its body —
> `status: "healthy" | "degraded"` (degraded when the relay `/health` probe
> fails) plus a `version` and `deps.hocuspocus` block. A single monitor on the
> web `/api/health` body-matching `status == "healthy"` therefore catches a
> web-up-but-relay-down split too, if you prefer one monitor over three.

### 3. Wire the on-call destination

- **On-call → Schedules → Create schedule** → name `Default`, add yourself (`tmayshark@gmail.com`) as the only member, 24×7 rotation.
- **Policies → Create policy** → name `Slice-1 default`:
   1. Wait 5 min.
   2. Notify the `Default` schedule by **email**.
   3. (Future: add SMS as step 3 once we have a Twilio number.)
- Attach the policy to all three monitors (Monitor → Settings → On-call & escalations).

### 4. (Recommended) Add a heartbeat

The uptime monitors catch "relay stopped responding". A heartbeat catches "the **metrics endpoint** stopped scraping" — e.g. if a future code change inadvertently disables the introspection extension while leaving `/health` intact.

1. **Heartbeats → Create heartbeat** → name `relay-dev-metrics`, expected interval **2 min**, grace **2 min**.
2. Save. Copy the heartbeat URL (looks like `https://uptime.betterstack.com/api/v1/heartbeat/<token>`).
3. The relay **auto-pings this now** (this PR): the introspection extension fires the heartbeat from its 30 s alarm interval (well inside the 2 min window) whenever `BETTERSTACK_HEARTBEAT_URL` is set. Activate it by setting that Fly secret per tier:
   ```sh
   flyctl secrets set -a patchtogether-server-dev BETTERSTACK_HEARTBEAT_URL='https://uptime.betterstack.com/api/v1/heartbeat/<token>'
   ```
   Unset → the relay simply doesn't ping (no-op), so this is safe to leave off until you've created the heartbeat.

### 5. Repeat for production once the dev tier has soaked

After ~7 days of clean dev signal, duplicate the three monitors against:

- `https://patchtogether.live/api/health`
- `https://patchtogether-server.fly.dev/health`
- `https://patchtogether-server.fly.dev/metrics`

…and attach the same on-call policy.

---

## Log shipping + log-based alerting (the page-on-OOM/exception path)

Uptime monitors catch "stopped responding" and "rss too high right now". They do
**not** page on the relay's structured **error lines** — and that's the exact gap
that left the original relay OOM unalerted. The relay already emits these as
single-line, machine-parseable records to **stderr** (see
`packages/server/src/http-introspection.ts` + `relay-error-handlers.ts`):

- `[relay-alarm] CRIT rss=…MB …` — memory crossed `RELAY_MEM_CRIT_MB`.
- `event=relay_uncaught_exception level=error stays_up=true …`
- `event=relay_unhandled_rejection level=error …`

Nothing ships those off Fly today. This section closes that.

### A. Ship Fly relay logs → Better Stack Logs

Two ways; pick one in the guided setup:

1. **`fly-log-shipper` app (recommended).** Deploy Fly's official log-shipper as a
   separate app that tails your org's logs and forwards them to Better Stack
   Logs. It reads a Better Stack source token from its own secret. One shipper
   covers all three relay apps.
2. **Better Stack "Fly.io" log source.** In Better Stack: **Logs → Sources →
   Connect source → Fly.io**; follow its instructions (also uses the shipper
   under the hood). Copy the **source token**.

Either way the token is set as a Fly secret on the relay app(s):

```sh
flyctl secrets set -a patchtogether-server-dev LOGTAIL_SOURCE_TOKEN='<betterstack-source-token>'
```

### B. Log-based alert rules (these are what page on the OOM)

In **Better Stack → Logs → Alerts**, create two rules against the relay source,
both routed to the **Default** on-call schedule (same destination as the uptime
monitors):

| Rule | Match (substring/query) | Why |
|---|---|---|
| Relay memory CRIT | `[relay-alarm] CRIT` | reactive OOM page — fires the moment rss crosses crit, independent of the 30 s /metrics poll |
| Relay crash guard tripped | `event=relay_uncaught_exception` OR `event=relay_unhandled_rejection` | the relay stayed up but something threw — investigate before it compounds into an OOM |

### C. Ship Cloudflare web/Worker logs → Better Stack Logs

The web tier now emits one structured access-log line per request
(`msg:"request"` with `request_id`, `status`, `ms` — see `hooks.server.ts`).
Forward them so you can search by `request_id` and alert on a 5xx rate:

1. Create a second Better Stack Logs source ("CF web") → copy its token.
2. Forward CF logs into it — pick in the guided setup:
   - **Tail-worker (free):** a tiny Worker bound via `tail_consumers` that POSTs
     each log event to the Better Stack Logs HTTP ingest. No plan upgrade.
   - **Logpush:** cleaner, but some log datasets require a paid Workers/Pages
     plan.
3. (Optional) Add a Better Stack Logs alert: `level=error` AND `msg=request`
   rate over N/min → on-call.

### D. (Optional) Fly host-memory tripwire

As a second, independent OOM signal that fires even if the in-process 30 s alarm
is starved: in Fly's built-in metrics/Grafana
(`flyctl dashboard metrics -a patchtogether-server`), add an alert on machine
memory %. Config-only, no code.

---

## Manual-setup checklist (post-merge)

1. Create BetterStack account.
2. Add `dev.patchtogether.live/api/health` uptime monitor.
3. Add `patchtogether-server-dev.fly.dev/health` uptime monitor.
4. Add `patchtogether-server-dev.fly.dev/metrics` uptime monitor with body match `rss_mb < RELAY_MEM_CRIT_MB` (dev 900 / prod 230).
5. Configure `Default` on-call schedule with `tmayshark@gmail.com`.
6. Create + attach `Slice-1 default` escalation policy (5 min → email).
7. Add `live-smoke-alert.yml` repo secret `DEV_BETA_GATE_PASS` (the `beta:…` dev pass per memory `reference_beta_gate_creds.md`).
8. Create the **Fly relay** Logs source → set `LOGTAIL_SOURCE_TOKEN` as a Fly secret on each relay app (log shipping §A).
9. Create the two **log-based alert rules** (`[relay-alarm] CRIT`; `relay_uncaught_exception`/`relay_unhandled_rejection`) → Default on-call (§B). **This is the rule that actually pages on an OOM.**
10. Create the **CF web** Logs source + forwarder (tail-worker or Logpush) for the web access logs (§C).
11. Create the `relay-dev-metrics` heartbeat → set `BETTERSTACK_HEARTBEAT_URL` as a Fly secret (the relay auto-pings it now — step 4 of the walkthrough).
12. Confirm `FLY_API_TOKEN` is a repo secret so relay CD actually deploys the new `fly.*.toml` (http_checks + per-tier thresholds + `SERVER_VERSION`).
13. (Optional) Add the Fly host-memory tripwire (§D).
14. (Optional) Repeat steps 2–11 against prod URLs after ~7 days of clean dev soak.

---

## Why the GH Action backstop still matters

Even with BetterStack live, the workflow at `.github/workflows/live-smoke-alert.yml` stays on. Reasons:

- **Independent failure path.** If BetterStack itself has an outage, GH Actions is still scraping.
- **Issue trail.** BetterStack pages but doesn't open a GitHub issue; the workflow does, creating a code-adjacent record + auto-linking to the run logs.
- **Free.** GH Actions free-tier covers 10-min cron forever.

Cost of double-coverage: ~6 GH Actions runner minutes per hour (well under the free quota for public repos).

---

## Future slices (NOT in this PR)

- **Sentry** for errors (web + Worker) — source-mapped browser/edge stack
  traces + release health (tied to `VITE_APP_VERSION`). The one gap Better Stack
  Logs covers poorly. Ships as a small follow-up PR; init is gated on
  `PUBLIC_SENTRY_DSN` so it's a no-op until you provision the account.
- **Cloudflare Workers Analytics Engine** for per-route latency histograms.

> Done in this PR (previously listed here as future): the relay heartbeat
> auto-ping (step 4), per-tier memory thresholds, Fly HTTP health checks,
> `SERVER_VERSION`/`VITE_APP_VERSION`, the web `/api/health` cross-tier probe +
> request-id access logs, and the log-shipping + log-based alert-rule runbook
> above. Better Stack **Logs** also supersedes the previously-listed "Axiom for
> log search".
