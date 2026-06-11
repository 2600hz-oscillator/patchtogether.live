# Secrets & Accounts Inventory

**Names and purposes only — NO values.** This document never contains a real
secret, username, email, token, account ID, or connection string. Substitute real
values from the relevant provider dashboard or the operator's local secrets file.

## Source of truth

The operator maintains a local, gitignored secrets file at
`~/.config/patchtogether/cf.env` (override with `PATCHTOGETHER_ENV_FILE`).
`scripts/sync-secrets.sh` reads it and pushes the lockstep secrets to both Fly
(relay) and Cloudflare Pages (web), preventing drift:

```sh
flox activate -- task sync-secrets -- dev                      # dry-run: print names + fingerprints
flox activate -- task sync-secrets -- dev --apply             # push to dev + autotest
flox activate -- task sync-secrets -- prod --apply --yes-prod # prod (extra confirmation)
```

There is **no** fallback to a cloud secrets manager — back up `cf.env` before
changing it.

## Secret / env-var table

"Where it lives" abbreviations: **GH** = GitHub Actions secret (workflow-only),
**CF** = Cloudflare Pages Variables/Secrets (per project), **Fly** = Fly app
secret, **build** = baked into the web bundle at build time, **runtime** = read on
the server at request time, **local** = operator's `cf.env` / `.env.local`.

| Name | Where it lives | Purpose | Notes |
| --- | --- | --- | --- |
| `INVITE_SECRET` | CF (runtime) + Fly + local | HMAC-SHA256 key for anonymous invite codes | **≥ 32 chars**; must match web ↔ relay or anon guests silently rejected. Per-tier values. |
| `CLERK_SECRET_KEY` | CF (runtime) + Fly + GH (smoke) + local | Clerk backend key for JWT verification | test instance for dev/autotest, live for prod. All-or-nothing with the publishable key. |
| `PUBLIC_CLERK_PUBLISHABLE_KEY` | CF (Variable, public) | Clerk frontend key | public; per-tier. |
| `DATABASE_URL` | CF (runtime, Neon HTTP) + Fly (TCP) + local | Postgres connection string | web uses Neon HTTP, relay uses TCP — **different strings**. Missing in prod relay = crash-loop. |
| `BETA_GATE_PASS` | CF (runtime) + GH (smoke) + local | basic-auth password for deployed tiers | unset = gate disabled (local dev). Different per tier. |
| `BETA_GATE_USER` | CF (Variable) + local | basic-auth username | defaults to a placeholder `<beta-user>` if unset. |
| `VITE_SERVER_WS_URL` | build | Hocuspocus relay WS URL per tier | baked at build; changing it in the dashboard does nothing. |
| `VITE_E2E_HOOKS` | build | exposes in-page test globals (`__patch`/`__ydoc`/…) | `1` on autotest/dev/preview; **never prod**. |
| `VITE_VIDEO_WORKER` | build | enable WebGL video worker | build-time toggle. |
| `RACKSPACE_SEED_ENABLED` | CF (runtime) | enable `POST /api/test/seed-rackspace` | **autotest only** (or local dev). Security risk elsewhere. |
| `RELAY_MEM_WARN_MB` | Fly (optional) | memory warn threshold | default 384; tunable without redeploy. |
| `RELAY_MEM_CRIT_MB` | Fly (optional) | memory crit threshold | default 480; fires live-smoke alert. |
| `ALLOW_MEMORY_STORE` | Fly (optional) | allow ephemeral in-memory prod run | escape hatch; `1` only. Not recommended. |
| `ALLOW_LOCALHOST_DB` | CF (optional) | use localhost DB on a deployed worker | rare debugging only. |
| `NODE_ENV` | Fly `[env]` / process | `production` on all tiers | triggers prod fail-fast + anon rack-existence checks. |
| `PORT` / `HOST` | Fly `[env]` | relay listen port/bind | 8080 on Fly; 1235 locally. |
| `CLOUDFLARE_API_TOKEN` | GH | wrangler Pages deploy token | workflow-only; scoped to Pages deploy. |
| `CLOUDFLARE_ACCOUNT_ID` | GH | Cloudflare account id | workflow-only. |
| `FLY_API_TOKEN` | GH | flyctl relay deploy token | optional — relay deploy no-ops if unset. |
| `GITHUB_TOKEN` | GH (auto-injected) | `gh` CLI / branch checks in CI | provided by Actions. |
| `AUTOTEST_BETA_GATE_PASS` | GH | basic-auth pass for autotest smoke | smoke-live job. |
| `AUTOTEST_INVITE_SECRET` | GH | canonical autotest `INVITE_SECRET` for smoke cross-check | smoke-live job. |
| `DEV_BETA_GATE_PASS` | GH | basic-auth pass for dev | live-smoke-alert. |
| `CHAOS_RACKSPACE_URL` | GH | invite-link URL for chaos bot | chaos-24-7. |
| `LIVE_SMOKE_WEB_URL` / `LIVE_SMOKE_RELAY_URL` / `LIVE_SMOKE_CRIT_MB` | GH Variables (optional) | live-smoke probe targets/threshold | non-secret config. |

### Local-only source keys in `cf.env`

These exist in the operator's local secrets file as the source the sync script
reads; they are **not** stored in the repo:

`INVITE_SECRET_{DEV,AUTOTEST,PROD}`, `CLERK_SECRET_KEY` / `CLERK_SECRET_KEY_LIVE`,
`NEON_{DEV,AUTOTEST,PROD}_URL` (web Neon HTTP), `FLY_PG_{DEV,AUTOTEST,PROD}_URL`
(relay Postgres path).

## Inspect what's set (names only — values are redacted by the providers)

```sh
flox activate -- flyctl secrets list -a patchtogether-server
flox activate -- flyctl secrets list -a patchtogether-server-dev
flox activate -- flyctl secrets list -a patchtogether-server-autotest
flox activate -- wrangler pages secret list --project-name=patchtogether-live
flox activate -- wrangler pages secret list --project-name=patchtogether-live-dev
flox activate -- wrangler pages secret list --project-name=patchtogether-live-autotest
flox activate -- gh secret list                          # GitHub Actions secrets (names only)
```

## External accounts / services

| Provider | What it does | Dashboard |
| --- | --- | --- |
| **Cloudflare Pages** | hosts the static web app (4 projects: prod / dev / autotest / PR-preview) | <https://dash.cloudflare.com> |
| **Fly.io** | hosts the 3 Hocuspocus relay apps (single machine each) | <https://fly.io/dashboard> |
| **Neon** | serverless Postgres (per-tier branches; HTTP for web, TCP for relay) | <https://console.neon.tech> |
| **Clerk** | authentication / identity (test instance for non-prod, live for prod) | <https://dashboard.clerk.com> |
| **GitHub Actions** | CI/CD pipeline + repo secrets | repo → Settings → Secrets and variables → Actions |
| **BetterStack** (optional) | uptime/heartbeat monitoring + paging | <https://betterstack.com> (see [observability.md](observability.md)) |
| **AWS ECR Public** | Docker image mirror for CI Postgres (avoids Docker Hub rate limits) | public read, no secret |
| **ibiblio / distro mirror** | CI fetch of the shareware DOOM1.WAD (SHA-verified) | public, no secret |
| **git-LFS** | tracks `.f32` ART baselines, `.png` VRT screenshots, `.wasm` assets | no separate account; uses GitHub |

## Critical lockstep + safety rules

- **`INVITE_SECRET` must match web ↔ relay per tier.** Drift = every anon guest
  silently rejected at the WS handshake. Always push via `sync-secrets.sh` and
  verify with `task smoke:anon-handshake`.
- **`CLERK_SECRET_KEY` differs by tier** (test vs live). Wrong-tier key silently
  breaks JWT verification.
- **`DATABASE_URL` is two different strings** (Neon HTTP for web, Postgres TCP for
  relay) — not interchangeable.
- **GitHub Actions secrets are workflow-only** — they never reach app code.
- **`VITE_E2E_HOOKS` and `RACKSPACE_SEED_ENABLED` must never be enabled on prod.**
- **`cf.env` is gitignored and never committed.** Back it up before edits.
- **CF / Fly redact secret values** on read-back — keep the source-of-truth local;
  you can't recover an old value from the provider before rotating.

## Public-safety reminder

This repo is public. If you ever need to show a real value in a runbook, **don't**
— use a placeholder (`<CLOUDFLARE_API_TOKEN>`, `<beta-user>`, `<owner-email>`) and
point to the dashboard. The PR that adds these runbooks was self-scrubbed for
leaked credentials (see the PR description).
