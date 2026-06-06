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
| Relay metrics | HTTPS uptime monitor (body match) | `https://patchtogether-server-dev.fly.dev/metrics` | body's `rss_mb > 480` for 3 consecutive scrapes |

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
   - Value: `480`
   - (Adjust if you also change `RELAY_MEM_CRIT_MB`.)
8. Save.

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
3. The current slice does NOT auto-ping this — leaving it as a follow-up TODO. To activate it, add the URL as `BETTERSTACK_HEARTBEAT_URL` to the relay's Fly secrets and a future PR can have the introspection extension `curl`-ping it every 60 s.

### 5. Repeat for production once the dev tier has soaked

After ~7 days of clean dev signal, duplicate the three monitors against:

- `https://patchtogether.live/api/health`
- `https://patchtogether-server.fly.dev/health`
- `https://patchtogether-server.fly.dev/metrics`

…and attach the same on-call policy.

---

## Manual-setup checklist (post-merge)

1. Create BetterStack account.
2. Add `dev.patchtogether.live/api/health` uptime monitor.
3. Add `patchtogether-server-dev.fly.dev/health` uptime monitor.
4. Add `patchtogether-server-dev.fly.dev/metrics` uptime monitor with body match `rss_mb < 480`.
5. Configure `Default` on-call schedule with `tmayshark@gmail.com`.
6. Create + attach `Slice-1 default` escalation policy (5 min → email).
7. Add `live-smoke-alert.yml` repo secret `DEV_BETA_GATE_PASS` (the `beta:…` dev pass per memory `reference_beta_gate_creds.md`).
8. (Optional) Repeat steps 2–6 against prod URLs after soak.
9. (Optional) Create heartbeat monitor + wire BETTERSTACK_HEARTBEAT_URL in a follow-up PR.

---

## Why the GH Action backstop still matters

Even with BetterStack live, the workflow at `.github/workflows/live-smoke-alert.yml` stays on. Reasons:

- **Independent failure path.** If BetterStack itself has an outage, GH Actions is still scraping.
- **Issue trail.** BetterStack pages but doesn't open a GitHub issue; the workflow does, creating a code-adjacent record + auto-linking to the run logs.
- **Free.** GH Actions free-tier covers 10-min cron forever.

Cost of double-coverage: ~6 GH Actions runner minutes per hour (well under the free quota for public repos).

---

## Future slices (NOT in this PR)

- **Sentry** for errors (web + worker).
- **Axiom** for log search.
- **Cloudflare Workers Analytics Engine** for per-route latency histograms.
- **Heartbeat auto-ping** from the relay's introspection extension (see step 4).
