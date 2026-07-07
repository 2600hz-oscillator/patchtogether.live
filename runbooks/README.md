# patchtogether.live — Operational Runbooks

Operator-facing documentation for running, building, testing, deploying, and
maintaining **patchtogether.live** — a browser-based collaborative modular synth
(30+ audio modules + 15+ video modules) with real-time multi-user sync.

> **Public-safety note:** This folder lives in a public repo. It contains **no
> secret values, no credentials, no account IDs, no connection strings, no
> usernames/emails**. Every secret is referred to by name only, with placeholders
> like `<CLOUDFLARE_API_TOKEN>`. Where a real value is needed, look it up in the
> relevant provider dashboard or the operator's local secrets file (see
> [secrets-and-accounts.md](secrets-and-accounts.md)).

---

## EMERGENCY TAKEOVER QUICKSTART

If you are taking over operations cold, here are the five things to know.

### 1. Where the app runs (tier map)

| Tier | Web (Cloudflare Pages) | Relay (Fly.io Hocuspocus) | DB branch |
| --- | --- | --- | --- |
| **prod** | `patchtogether.live` (project `patchtogether-live`) | `patchtogether-server.fly.dev` | Neon `production` branch |
| **dev** | `dev.patchtogether.live` (project `patchtogether-live-dev`) | `patchtogether-server-dev.fly.dev` | Neon `dev` branch |
| **autotest** | `autotest.patchtogether.live` (project `patchtogether-live-autotest`) | `patchtogether-server-autotest.fly.dev` | Neon `autotest` branch |
| **PR preview** | `pr-<N>.patchtogether-live-autotest.pages.dev` | shares autotest relay | shares autotest branch |

The browser does **all** the audio/video DSP locally (WebAudio + WASM). The
server side is thin: static SvelteKit on Cloudflare + a stateful Yjs relay on Fly
+ Postgres on Neon. See [architecture.md](architecture.md).

### 2. How to deploy each tier by hand

Deploys are normally automatic (see [deployment.md](deployment.md)), but to do it
manually you need `wrangler` (CF Pages) and `flyctl` (Fly) authenticated, plus
the per-tier build-time vars. Every command runs inside Flox: `flox activate -- …`.

```sh
# WEB (Cloudflare Pages) — from packages/web, after npm install + build:
#   VITE_SERVER_WS_URL must point at the matching relay tier (baked at build time)
wrangler pages deploy .svelte-kit/cloudflare --project-name=patchtogether-live          --branch=main   # prod
wrangler pages deploy .svelte-kit/cloudflare --project-name=patchtogether-live-dev      --branch=dev    # dev
wrangler pages deploy .svelte-kit/cloudflare --project-name=patchtogether-live-autotest --branch=main   # autotest

# RELAY (Fly) — from workspace root:
flyctl deploy --config fly.prod.toml     --remote-only   # prod
flyctl deploy --config fly.dev.toml      --remote-only   # dev
flyctl deploy --config fly.autotest.toml --remote-only   # autotest

# AFTER every relay deploy — VERIFY EXACTLY ONE MACHINE (split-brain guard):
flyctl machines list -a patchtogether-server | wc -l
```

Full step-by-step, including the version-bump-gates-prod rule and rollback, is in
[deployment.md](deployment.md).

### 3. How to check health

```sh
# Web tier (no auth needed on /api/health):
curl https://dev.patchtogether.live/api/health         # Clerk-env presence + INVITE_SECRET fingerprint

# Relay tier:
curl https://patchtogether-server-dev.fly.dev/health   # {ok, boot_id, persist}
curl https://patchtogether-server-dev.fly.dev/metrics  # rss_mb, conns, rooms, persist rate, error counters

# Relay logs:
flyctl logs -a patchtogether-server-dev
```

A cron workflow (`live-smoke-alert.yml`) probes dev every ~10 min and opens a
GitHub issue if the relay is unhealthy or memory-critical. See
[observability.md](observability.md).

### 4. Who the external providers are

| Provider | Role | Dashboard |
| --- | --- | --- |
| **Cloudflare Pages** | hosts the static web app (4 projects) | <https://dash.cloudflare.com> |
| **Fly.io** | hosts the 3 Hocuspocus relay apps | <https://fly.io/dashboard> |
| **Neon** | serverless Postgres (per-tier branches) | <https://console.neon.tech> |
| **Clerk** | authentication / identity | <https://dashboard.clerk.com> |
| **GitHub Actions** | CI/CD | <https://github.com> repo → Actions |

Details and what we use each for: [secrets-and-accounts.md](secrets-and-accounts.md)
and the per-provider docs under [integrations/](integrations/).

### 5. Where secrets live

There is **no secret value in this repo.** Secrets live in three places:

- **GitHub Actions secrets** (deploy tokens) — repo → Settings → Secrets and variables → Actions.
- **Cloudflare Pages** project Variables + Secrets (per project, production/preview scope).
- **Fly.io** per-app secrets (`flyctl secrets set -a <app> …`).

The operator's local **source of truth** is `~/.config/patchtogether/cf.env`
(gitignored, never committed). `scripts/sync-secrets.sh` reads it and pushes the
lockstep secrets (`INVITE_SECRET`, `CLERK_SECRET_KEY`, `DATABASE_URL`) to both Fly
and Cloudflare so they never drift. Full inventory:
[secrets-and-accounts.md](secrets-and-accounts.md).

---

## Index

| Doc | What it covers |
| --- | --- |
| [architecture.md](architecture.md) | System overview + data-flow diagram, tier domains |
| [local-development.md](local-development.md) | Flox, Taskfile, running locally, DSP/Faust + WASM artifacts |
| [build.md](build.md) | Full build pipeline: SvelteKit/Vite, adapter-cloudflare, DSP dist, DOOM WASM |
| [testing.md](testing.md) | Unit / E2E / VRT / ART / behavioral / collab layers, running, sharding, flake discipline |
| [ci.md](ci.md) | Every GitHub Actions workflow, required checks, **how to read a failure** |
| [deployment.md](deployment.md) | Tier map + triggers + exact by-hand deploy commands, rollback, single-machine invariant |
| [observability.md](observability.md) | `/health` + `/metrics`, memory alarm, live-smoke-alert, BetterStack pointer |
| [secrets-and-accounts.md](secrets-and-accounts.md) | Table of every secret/env var (values redacted) + every external account |
| [integrations/cloudflare.md](integrations/cloudflare.md) | Cloudflare Pages deep dive |
| [integrations/clerk.md](integrations/clerk.md) | Clerk auth deep dive |
| [integrations/fly.md](integrations/fly.md) | Fly relay (Hocuspocus) deep dive |
| [integrations/neon-postgres.md](integrations/neon-postgres.md) | Neon Postgres deep dive |

---

## Conventions used in these docs

- **Every command runs through Flox:** prefix with `flox activate -- …`. Running
  git outside Flox can make git-LFS operations hang.
- **`task` = go-task**, configured by `Taskfile.yml` at the repo root.
- Placeholders in angle brackets (`<CLOUDFLARE_API_TOKEN>`) mean "substitute the
  real value from the dashboard / your local secrets file."
- When a detail can't be confirmed from the repo, the doc says "verify in the
  `<provider>` dashboard" rather than guessing.
