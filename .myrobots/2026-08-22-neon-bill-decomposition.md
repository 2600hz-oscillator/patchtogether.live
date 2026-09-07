# Neon bill decomposition (#2095 Phase 1) — 2026-08-22

Measured via the Neon API (project `twilight-tree-01652938`, billing period Aug 1 → now,
fields reset at `quota_reset_at`). Consumption-history API is Scale-plan-gated; these are
the project/branch lifetime-this-period counters, which close against the owner's ~$1/day.

## Where the money goes

Bill ≈ **compute only**. Storage is 96.7 MB synthetic (≈ pennies/mo); history retention is
already 6 h. This month: **650,446 CU-s ≈ 180.7 CU-h ≈ $0.87/day** at ~$0.106/CU-h.

| driver | share | $/day | why it exists | change & cost |
|---|---|---|---|---|
| **dev branch** endpoint awake ~15.1 h/day | 54% | ~$0.47 | dev-site traffic + DEV relay snapshot persistence + (until fixed) deep health pings. NOT CI — @collab runs on localhost Postgres, never Neon | verify the dev uptime monitor hits shallow `/api/health` (no `?deep=1`); relay snapshot cadence is app-level |
| **production** endpoint — was awake **~23 h/day Aug 1–12**, near-0 since | 41% | ~$0.36 (period avg; **now ~$0** ) | a monitor pinging every 180 s vs the 300 s suspend window kept it 99% awake. The shallow-health fix (`?deep=1` opt-in) landed ~Aug 12 — the endpoint's `last_active` is Aug 12 | already fixed; September inherits the saving |
| **autotest** | 5% | ~$0.04 | nightly/preview deploys + smoke | leave |
| autoscale spikes above the 0.25 floor | ~14% of CU-s | ~$0.12 | max_cu was 8 on all endpoints | non-prod now capped at 2 (applied) |

## Changes APPLIED today (reversible, non-prod only)

- `ep-crimson-hat-aq0q6qn3` (dev) and `ep-plain-river-aqh90c7b` (autotest):
  `autoscaling_limit_max_cu 8 → 2`.
  Revert: `PATCH /projects/twilight-tree-01652938/endpoints/<id>` body
  `{"endpoint":{"autoscaling_limit_max_cu":8}}`.
- Wake-test after change: dev endpoint `start` → `active` ✓ (collab lane unaffected; CI
  uses localhost Postgres anyway).
- NOT possible on this plan: `suspend_timeout_seconds < 300` ("suspend interval is too
  short for your plan") — the 5-min window is the plan floor.
- PROD untouched (proposal only): same max_cu cap is safe; verify the prod uptime monitor
  stays on the shallow path.

## Expected outcome

Prod's always-on stretch ending (Aug 12) already removes ~40% of the run-rate. With dev's
monitor verified-shallow, the structural floor on this plan is roughly **$0.15–0.30/day**
(CI-free wakes × 5-min minimum windows). Below that requires fewer wakes (relay snapshot
batching) or a different home for dev/autotest (Phase 2).

# Phase 2 — self-host evaluation

**Workload reality:** 31 MB logical DB per tier, ~96 MB total; QPS is tens at peak
(rack/preset CRUD + auth lookups); the relay moves KB/s CRDT deltas; rackspaces cap at 4
users. This is three orders of magnitude below a single modern mini-PC's Postgres capacity.

**Capacity on symmetric gigabit:** Postgres at this size: thousands of simple QPS —
not the ceiling. The ceiling is the single-process Yjs relay: order **hundreds of
concurrent collaborators** (each rackspace KB/s, 4-user cap) before one process needs
splitting; bandwidth is irrelevant at 1 Gbps symmetric. Registered users: thousands.
Realistic tolerance: **mid-hundreds concurrent** — ~100× today's traffic.

**What self-hosting takes on:** backups (pg_dump cron + offsite copy), Postgres/OS
patching, availability (home power/ISP = the SLA; no failover), inbound exposure —
solved cleanly by Cloudflare Tunnel (no port-forward, no static IP needed), and a single
point of hardware failure.

**The one code seam:** CF Workers cannot speak raw TCP Postgres — today's Worker code
uses the Neon HTTP driver (memory: only that tag works). Self-hosted options, in order of
sanity: (a) move DB-touching API routes onto the self-hosted node process (relay box) and
have the Worker fetch it over the Tunnel; (b) self-host an HTTP→PG shim (PostgREST or a
Neon-proxy-compatible gateway) behind the Tunnel; (c) hybrid — keep prod on Neon, self-host
dev/autotest only (no seam change for prod).

**Recommendation:** run the spike as (c): move **dev + autotest** to a home box via CF
Tunnel + option (a), prove the backup/restore + uptime story for a quarter, and keep prod
on Neon meanwhile — at the post-fix run-rate (~$10/mo) prod's Neon bill buys managed
backups, PITR and zero ops for less than the electricity of caring about it. Revisit prod
migration only if the spike's availability record is clean.
