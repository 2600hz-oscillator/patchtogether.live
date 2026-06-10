# Better Stack setup — decided stack

Status: **manual user step**. The code is the foundation (probes + `/metrics` +
request-id access logs + env-gated Sentry + GH Actions backstop); the steps below
wire the external services on top.

**Decided stack (this is what we run):**

- **Fly relay logs → Better Stack** via Fly's official **fly-log-shipper** app
  (a separate Fly app that holds the `LOGTAIL_SOURCE_TOKEN` and forwards all
  relay apps' logs). See §A.
- **Cloudflare web/Worker logs → Better Stack** via **Cloudflare Logpush** to a
  Better Stack Logs source. See §C.
- **SMS / phone escalation** on Better Stack's **paid Telemetry tier** with a
  **verified phone number** in the escalation policy. See §3.
- **Sentry** (browser + Worker) enabled via the **`PUBLIC_SENTRY_DSN`** env var
  per CF Pages tier — a total no-op until set. See §E.
- **Prod relay is now 512 MB** (`fly.prod.toml`), thresholds **warn 380 / crit
  440**. The `/metrics` body-match monitor below uses 440 for prod.
- **Provision the prod monitors NOW** (not after a 7-day dev soak) — see §5.

The GitHub Actions backstop (`.github/workflows/live-smoke-alert.yml`) runs every
10 minutes whether or not Better Stack is configured. Better Stack is the upgrade
path: faster cadence (30 s vs 10 min), a per-channel escalation policy (incl.
SMS), and richer historical graphs.

---

## What we're monitoring

Three surfaces, all wired through BetterStack's same Uptime + Heartbeats product:

| Surface | Type | URL | Paging trigger |
|---|---|---|---|
| Web dev tier | HTTPS uptime monitor | `https://dev.patchtogether.live/api/health` | 5 min sustained downtime |
| Relay dev tier | HTTPS uptime monitor | `https://patchtogether-server-dev.fly.dev/health` | 5 min sustained downtime |
| Relay metrics | HTTPS uptime monitor (body match) | `https://patchtogether-server-dev.fly.dev/metrics` | body's `rss_mb` over this tier's `RELAY_MEM_CRIT_MB` (dev 900 / **prod 440** / autotest 230) for 3 consecutive scrapes |

Why three: `/api/health` confirms the web tier is up but tells us nothing about the relay. `/health` on the relay confirms the WS server is accepting requests but says nothing about memory. `/metrics` is the canary for the **specific failure mode the slice-1 plan targets**: an unalerted relay OOM (see memory `project_observability_priority.md`).

---

## Step-by-step

### 1. Create a BetterStack account

- Go to <https://betterstack.com/> → Sign up. Use a team-owned email as the
  account contact. SMS/phone escalation (§3) needs the **paid Telemetry tier**.
- After signup you'll land in **Uptime**.

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
   - Value: this tier's `RELAY_MEM_CRIT_MB` — **900** for dev (1024 MB box), **440** for prod (now a **512 MB** box; warn 380 / crit 440), **230** for autotest (256 MB box). These live in `fly.<tier>.toml [env]`; keep the monitor value in step with them (they're two copies of one number — there's no single source of truth across the Better Stack UI and the Fly env).
8. Save.

> Note: `/api/health` now also reflects relay reachability in its body —
> `status: "healthy" | "degraded"` (degraded when the relay `/health` probe
> fails) plus a `version` and `deps.hocuspocus` block. A single monitor on the
> web `/api/health` body-matching `status == "healthy"` therefore catches a
> web-up-but-relay-down split too, if you prefer one monitor over three.

### 3. Wire the on-call destination (with SMS/phone escalation)

SMS + phone-call escalation requires Better Stack's **paid Telemetry tier**, and
the destination phone number must be **verified** in Better Stack first
(**On-call → Phone numbers → Add → verify via the code Better Stack texts**).
This is the decided escalation path — not email-only.

- **On-call → Schedules → Create schedule** → name `Default`, add the on-call
  person as the only member, 24×7 rotation.
- **Policies → Create policy** → name `Default escalation`:
   1. Immediately: notify the `Default` schedule by **email** (free, fast).
   2. Wait 5 min unacknowledged → escalate via **SMS** to the verified number.
   3. Wait 10 min unacknowledged → escalate via **phone call** to the verified
      number.
- Attach the policy to all monitors (Monitor → Settings → On-call & escalations)
  **and** to the log-based alert rules in §B.

### 4. (Recommended) Add a heartbeat

The uptime monitors catch "relay stopped responding". A heartbeat catches "the **metrics endpoint** stopped scraping" — e.g. if a future code change inadvertently disables the introspection extension while leaving `/health` intact.

1. **Heartbeats → Create heartbeat** → name `relay-dev-metrics`, expected interval **2 min**, grace **2 min**.
2. Save. Copy the heartbeat URL (looks like `https://uptime.betterstack.com/api/v1/heartbeat/<token>`).
3. The relay **auto-pings this now** (this PR): the introspection extension fires the heartbeat from its 30 s alarm interval (well inside the 2 min window) whenever `BETTERSTACK_HEARTBEAT_URL` is set. Activate it by setting that Fly secret per tier:
   ```sh
   flyctl secrets set -a patchtogether-server-dev BETTERSTACK_HEARTBEAT_URL='https://uptime.betterstack.com/api/v1/heartbeat/<token>'
   ```
   Unset → the relay simply doesn't ping (no-op), so this is safe to leave off until you've created the heartbeat.

### 5. Provision the PRODUCTION monitors now

**Decided:** stand up the prod monitors immediately — do **not** wait for a 7-day
dev soak. Duplicate the three monitors against the prod URLs:

- `https://patchtogether.live/api/health`
- `https://patchtogether-server.fly.dev/health`
- `https://patchtogether-server.fly.dev/metrics` — body match `rss_mb < 440`
  (prod is now a **512 MB** box; crit threshold 440).

…and attach the same `Default escalation` on-call policy (email → SMS → phone).

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

### A. Ship Fly relay logs → Better Stack Logs (fly-log-shipper)

**Decided:** use Fly's official **`fly-log-shipper`** app. Deploy it as a separate
Fly app that tails your org's logs and forwards them to Better Stack Logs. One
shipper covers all three relay apps. It reads the Better Stack source token from
its own secret (`LOGTAIL_SOURCE_TOKEN`).

1. In Better Stack: **Logs → Sources → Connect source → Fly.io** → copy the
   **source token** (this is the value the shipper sends to).
2. Deploy the shipper (one-time):
   ```sh
   # From an empty dir; fly-log-shipper is published as a Fly app template.
   flyctl launch --from https://github.com/superfly/fly-log-shipper --name patchtogether-log-shipper --no-deploy
   flyctl secrets set -a patchtogether-log-shipper \
     LOGTAIL_SOURCE_TOKEN='<betterstack-source-token>' \
     ACCESS_TOKEN='<fly-org-read-token>'   # flyctl tokens create org-read
   flyctl deploy -a patchtogether-log-shipper
   ```
   `LOGTAIL_SOURCE_TOKEN` points the shipper at the Better Stack source;
   `ACCESS_TOKEN` (a Fly **org-read** token) lets it tail every relay app's logs.

> Note: the in-process relay heartbeat (§4) uses its own `BETTERSTACK_HEARTBEAT_URL`
> secret set directly on each relay app — that's separate from the log shipper.

### B. Log-based alert rules (these are what page on the OOM)

In **Better Stack → Logs → Alerts**, create two rules against the relay source,
both routed to the **`Default escalation`** on-call policy (email → SMS → phone,
same destination as the uptime monitors):

| Rule | Match (substring/query) | Why |
|---|---|---|
| Relay memory CRIT | `[relay-alarm] CRIT` | reactive OOM page — fires the moment rss crosses crit, independent of the 30 s /metrics poll |
| Relay crash guard tripped | `event=relay_uncaught_exception` OR `event=relay_unhandled_rejection` | the relay stayed up but something threw — investigate before it compounds into an OOM |

### C. Ship Cloudflare web/Worker logs → Better Stack Logs (Logpush)

The web tier emits one structured access-log line per request (`msg:"request"`
with `request_id`, `status`, `ms` — see `hooks.server.ts`). **Decided:** forward
them via **Cloudflare Logpush** to a Better Stack Logs source so you can search by
`request_id` and alert on a 5xx rate.

1. Create a second Better Stack Logs source ("CF web") → copy its **ingest URL +
   token**.
2. In Cloudflare: **(Account or zone) → Analytics & Logs → Logpush → Create a
   Logpush job** → dataset **Workers Trace Events** (Pages Functions emit here)
   → destination **HTTP** → paste the Better Stack ingest URL + the
   `Authorization: Bearer <token>` header. Logpush requires a paid Workers/Pages
   plan for some datasets — provision it on the prod account.
3. Add a Better Stack Logs alert: `level=error` AND `msg=request` rate over N/min
   → route to the `Default escalation` policy.

### D. (Optional) Fly host-memory tripwire

As a second, independent OOM signal that fires even if the in-process 30 s alarm
is starved: in Fly's built-in metrics/Grafana
(`flyctl dashboard metrics -a patchtogether-server`), add an alert on machine
memory %. Config-only, no code.

### E. Sentry — browser + Worker error tracking (env-gated)

**Decided + shipped in code; activate by setting the DSN.** Sentry catches the
one thing Better Stack Logs covers poorly: source-mapped browser **and** Worker
stack traces. It is **fully env-gated** — with `PUBLIC_SENTRY_DSN` unset (local,
CI, every deploy before you provision it) the SDK never initializes and nothing
changes. The browser side uses `@sentry/svelte`; the Worker side uses
`@sentry/cloudflare` (the SvelteKit/Node server SDK does **not** bundle for the
CF Workers runtime — it pulls `@fastify/otel` → `minimatch` and fails the build,
see getsentry/sentry-javascript#16613, so we wire the Cloudflare SDK directly in
`src/lib/observability/sentry-server.ts`).

To activate:

1. Create a Sentry project (platform: **SvelteKit** / **Cloudflare**) → copy the
   **DSN**.
2. Set `PUBLIC_SENTRY_DSN` per Cloudflare Pages tier (Pages project → Settings →
   **Variables and Secrets**). It's a `PUBLIC_*` var (the browser needs it), but
   the same value also gates the Worker side via `hooks.server.ts`:
   - `patchtogether-live` (prod), `patchtogether-live-dev`,
     `patchtogether-live-autotest`. Use a **separate DSN/project per tier** (or
     one project — events are tagged with `environment` = prod/dev/autotest/
     preview, derived from the build's `VITE_APP_VERSION` suffix).
3. (Optional, for de-minified traces) Add a **`SENTRY_AUTH_TOKEN`** GitHub repo
   secret (Sentry org token with `project:releases` + `org:read`). The deploy
   workflow's "Sentry release (source maps)" step
   (`scripts/sentry-release.sh`) then uploads **hidden** source maps + cuts a
   release per prod/autotest/dev deploy. Without the token the step skips
   cleanly (`::warning::`, green) — exactly like the `FLY_API_TOKEN` relay gate.
   The maps are `'hidden'` (no `sourceMappingURL` comment) and are **deleted
   before `pages deploy`**, so the public bundle never serves source maps.
   Override `SENTRY_ORG` / `SENTRY_PROJECT` in `scripts/sentry-release.sh` if the
   slugs differ from the defaults.

Release health ties to `VITE_APP_VERSION` (already baked per tier in
`deploy.yml`), so Sentry groups issues by deploy automatically.

---

## Manual-setup checklist (post-merge)

1. Create a Better Stack account on the **paid Telemetry tier** (needed for the
   SMS/phone escalation below) and **verify the on-call phone number**.
2. Add the **dev AND prod** uptime monitors (provision prod now — §5):
   `*/api/health`, `*-server*.fly.dev/health`, `*-server*.fly.dev/metrics`
   (body match `rss_mb < RELAY_MEM_CRIT_MB`: dev 900 / **prod 440** (512 MB box)
   / autotest 230).
3. Configure the `Default` on-call schedule.
4. Create + attach the `Default escalation` policy (email → 5 min SMS → 10 min
   phone) to all monitors (§3).
5. Add `live-smoke-alert.yml` repo secret `DEV_BETA_GATE_PASS` (the `beta:…` dev pass per memory `reference_beta_gate_creds.md`).
6. Deploy **`fly-log-shipper`** + create the **Fly relay** Logs source → set
   `LOGTAIL_SOURCE_TOKEN` (+ a Fly org-read `ACCESS_TOKEN`) on the shipper (§A).
7. Create the two **log-based alert rules** (`[relay-alarm] CRIT`; `relay_uncaught_exception`/`relay_unhandled_rejection`) → `Default escalation` (§B). **This is the rule that actually pages on an OOM.**
8. Create the **CF web** Logs source + a **Cloudflare Logpush** job (Workers
   Trace Events → HTTP → Better Stack) for the web access logs (§C).
9. Create the `relay-dev-metrics` heartbeat → set `BETTERSTACK_HEARTBEAT_URL` as a Fly secret (the relay auto-pings it now — step 4 of the walkthrough).
10. Confirm `FLY_API_TOKEN` is a repo secret so relay CD deploys the new
    `fly.*.toml` (incl. prod **512 MB** + warn 380/crit 440 + http_checks +
    `SERVER_VERSION`).
11. **Sentry (§E):** create the project(s) → set `PUBLIC_SENTRY_DSN` on each CF
    Pages project (prod/dev/autotest). (Optional) add the `SENTRY_AUTH_TOKEN` GH
    secret for source-map upload.
12. (Optional) Add the Fly host-memory tripwire (§D).

---

## Why the GH Action backstop still matters

Even with BetterStack live, the workflow at `.github/workflows/live-smoke-alert.yml` stays on. Reasons:

- **Independent failure path.** If BetterStack itself has an outage, GH Actions is still scraping.
- **Issue trail.** BetterStack pages but doesn't open a GitHub issue; the workflow does, creating a code-adjacent record + auto-linking to the run logs.
- **Free.** GH Actions free-tier covers 10-min cron forever.

Cost of double-coverage: ~6 GH Actions runner minutes per hour (well under the free quota for public repos).

---

## Future slices (NOT yet wired)

- **Cloudflare Workers Analytics Engine** for per-route latency histograms.

> Done in code (previously listed here as future): **Sentry** browser + Worker
> error tracking (env-gated on `PUBLIC_SENTRY_DSN`, §E) with source-map upload +
> release health tied to `VITE_APP_VERSION`; the relay heartbeat
> auto-ping (step 4), per-tier memory thresholds (prod now **512 MB** warn
> 380/crit 440), Fly HTTP health checks,
> `SERVER_VERSION`/`VITE_APP_VERSION`, the web `/api/health` cross-tier probe +
> request-id access logs, and the log-shipping + log-based alert-rule runbook
> above. Better Stack **Logs** also supersedes the previously-listed "Axiom for
> log search".
