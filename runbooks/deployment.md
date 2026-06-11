# Deployment

Two deploy targets per tier:

- **Web** → Cloudflare Pages (`wrangler pages deploy`)
- **Relay** → Fly.io (`flyctl deploy --config fly.<tier>.toml`)

Deploys are normally automatic via `.github/workflows/deploy.yml`. This doc covers
the triggers and the **exact by-hand commands** for a manual takeover.

## Tier map

| Tier | Web project | Web domain | Relay app | Relay host |
| --- | --- | --- | --- | --- |
| **prod** | `patchtogether-live` | `patchtogether.live` | `patchtogether-server` | `patchtogether-server.fly.dev` |
| **dev** | `patchtogether-live-dev` | `dev.patchtogether.live` | `patchtogether-server-dev` | `patchtogether-server-dev.fly.dev` |
| **autotest** | `patchtogether-live-autotest` | `autotest.patchtogether.live` | `patchtogether-server-autotest` | `patchtogether-server-autotest.fly.dev` |
| **PR preview** | `patchtogether-live-autotest` (branch `pr-<N>`) | `pr-<N>.patchtogether-live-autotest.pages.dev` | shares autotest relay | (autotest) |

## Triggers (automatic)

| Event | Web result | Relay result |
| --- | --- | --- |
| **PR opened / synced** | deploy to PR preview (autotest project, branch `pr-<N>`) | none (shares autotest relay) |
| **push to `main`** | deploy **autotest + dev** | deploy autotest + dev **only if** `packages/server/**` or `fly.*.toml` changed |
| **version bump on `main`** (package.json `.version` differs vs `HEAD~1`) | deploy **prod** | deploy prod relay (on version bump) |
| **`workflow_dispatch`** | deploy chosen tier(s) — escape hatch | same |

Notes:

- **Version-bump gates prod.** Routine merges deploy autotest+dev only. This
  prevents accidental prod deploys.
- **`workflow_dispatch` requires latest CI green** on the chosen branch
  (`verify-ci` job). Automatic push/version-bump deploys rely on branch protection
  having required CI to be green before merge.
- **Relay CD is change-gated** (`dorny/paths-filter`): web-only merges skip relay
  redeploy so live WS connections aren't dropped.
- **Relay deploy no-ops if `FLY_API_TOKEN` is unset** (steps exit 0 cleanly), so
  CI doesn't go red before the token is wired.

Dispatch a deploy via the CLI:

```sh
flox activate -- gh workflow run deploy.yml --ref <branch> -f target=autotest    # or dev / prod / autotest+dev
```

## By-hand deploy — WEB (Cloudflare Pages)

Requires `wrangler` authenticated (`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`
in env) and the **build-time** `VITE_SERVER_WS_URL` pointed at the matching relay
(it's baked into the bundle — see [build.md](build.md)).

```sh
cd packages/web
flox activate -- npm install
# Build with the correct per-tier WS URL (and VITE_E2E_HOOKS=1 for non-prod):
#   prod     → wss://patchtogether-server.fly.dev          (no VITE_E2E_HOOKS)
#   dev      → wss://patchtogether-server-dev.fly.dev      (VITE_E2E_HOOKS=1)
#   autotest → wss://patchtogether-server-autotest.fly.dev (VITE_E2E_HOOKS=1)
flox activate -- VITE_SERVER_WS_URL=<ws-url> VITE_E2E_HOOKS=<0|1> npm run build

# Deploy (the build output dir is .svelte-kit/cloudflare):
flox activate -- wrangler pages deploy .svelte-kit/cloudflare --project-name=patchtogether-live          --branch=main   # prod
flox activate -- wrangler pages deploy .svelte-kit/cloudflare --project-name=patchtogether-live-dev      --branch=dev    # dev
flox activate -- wrangler pages deploy .svelte-kit/cloudflare --project-name=patchtogether-live-autotest --branch=main   # autotest
flox activate -- wrangler pages deploy .svelte-kit/cloudflare --project-name=patchtogether-live-autotest --branch=pr-<N> # PR preview
```

> The `--project-name` overrides the placeholder `name` in `wrangler.toml`. Each
> deploy re-bundles `_worker.js` with esbuild, so it needs both the
> `.svelte-kit/` output **and** `node_modules` present.

## By-hand deploy — RELAY (Fly)

Requires `flyctl` authenticated (`FLY_API_TOKEN`). Run from the **workspace root**:

```sh
flox activate -- flyctl deploy --config fly.prod.toml     --remote-only   # prod
flox activate -- flyctl deploy --config fly.dev.toml      --remote-only   # dev
flox activate -- flyctl deploy --config fly.autotest.toml --remote-only   # autotest
```

### ALWAYS verify the single-machine invariant after a relay deploy

The relay holds the **live Yjs doc + connection-slot tracker in process memory**.
Two machines for one app = split-brain: users in the same rackspace land on
different machines and never sync. After every deploy:

```sh
flox activate -- flyctl machines list -a patchtogether-server          # must show exactly 1
flox activate -- flyctl machines list -a patchtogether-server-dev      # must show exactly 1
flox activate -- flyctl machines list -a patchtogether-server-autotest # exactly 1 (may be stopped)
```

If any app has more than one machine, destroy the extras immediately:

```sh
flox activate -- flyctl machines destroy <machine-id> --app patchtogether-server-<tier>
```

Config per tier (from `fly.<tier>.toml`):

| Tier | `auto_stop_machines` | `min_machines_running` | memory |
| --- | --- | --- | --- |
| prod | off | 1 (stays warm) | 256 MB |
| dev | off | 1 (stays warm, dogfooding) | 1024 MB |
| autotest | stop (scales to zero) | 0 (cold-start ok) | 256 MB |

See [integrations/fly.md](integrations/fly.md) for full relay details.

## Post-deploy validation

```sh
# Web health (no auth on /api/health):
curl https://dev.patchtogether.live/api/health

# Relay health + metrics:
curl https://patchtogether-server-dev.fly.dev/health
curl https://patchtogether-server-dev.fly.dev/metrics

# Anon-invite handshake (catches INVITE_SECRET drift web↔relay):
flox activate -- node scripts/anon-handshake-smoke.mjs <tier>
flox activate -- task smoke:anon-handshake          # task wrapper
```

The `deploy.yml` `smoke-live` job runs `@smoke`-tagged e2e + the anon-handshake
guard against autotest right after deploy. See [observability.md](observability.md).

## Secrets must be in lockstep before deploy

`INVITE_SECRET`, `CLERK_SECRET_KEY`, and `DATABASE_URL` must match between the web
tier (CF Pages) and the relay tier (Fly), or anon invites silently fail and auth
breaks. Push the canonical values from the operator's local source-of-truth:

```sh
flox activate -- task sync-secrets -- dev                      # dry-run (default)
flox activate -- task sync-secrets -- dev --apply             # apply to dev + autotest
flox activate -- task sync-secrets -- prod --apply --yes-prod # prod (extra confirmation)
```

See [secrets-and-accounts.md](secrets-and-accounts.md).

## Rollback

There is no one-button rollback wired in the repo; rollback means redeploying a
known-good version.

- **Web (CF Pages):** the Cloudflare Pages dashboard keeps a deployment history
  per project; you can "Rollback to this deployment" from the dashboard, or
  re-run the by-hand deploy from a known-good commit/branch. *Verify the exact
  rollback affordance in the Cloudflare Pages dashboard.*
- **Relay (Fly):** redeploy the previous good image. `flyctl releases -a <app>`
  lists releases; `flyctl deploy` from the previous good commit rebuilds it. *Verify
  the release-rollback affordance in the Fly dashboard / `flyctl` for your version.*
- **Prod gating:** because prod only deploys on a version bump, a bad prod deploy
  is rolled back by deploying a corrected build (and after every relay redeploy,
  re-verify the single-machine invariant).

## Long-lived video branch

`feat/video-domain` has its own workflow (`deploy-video-branch.yml`) that deploys
to the **dev tier only** on push, giving a stable URL without touching prod.
