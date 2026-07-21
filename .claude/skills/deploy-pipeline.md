---
name: deploy-pipeline
description: How the deploy pipeline works. The 3 tiers (autotest / dev / prod), what triggers each, the verify-ci precheck, manual workflow dispatch, post-merge live smoke.
---

# Deploy pipeline

## Where the app runs

- **patchtogether.live** — production (Cloudflare Pages project
  `patchtogether-live`)
- **dev.patchtogether.live** — staging (CF project `patchtogether-live-dev`),
  beta-gated basic auth
- **autotest.patchtogether.live** — automated test tier (CF project
  `patchtogether-live-autotest`), used by chaos + live smoke runs, also
  beta-gated
- **PR-${num} preview** — ephemeral, per-PR CF Pages preview (on the autotest
  project's *Preview* scope). Intentionally **UNGATED** (no beta basic-auth):
  each PR is a new short-lived subdomain the browser can't remember creds for,
  so the deploy-preview job removes `BETA_GATE_PASS` from the Preview scope
  (`scripts/cf-clear-preview-beta-gate.sh`). dev/autotest/prod stay gated.

Multiplayer Y.Doc server runs on Fly.io (separate deploy):
- `patchtogether-server-autotest.fly.dev`
- `patchtogether-server-dev.fly.dev`
- production server (URL in `.env.production`)

## What triggers each deploy

Defined in `.github/workflows/deploy.yml`:

| Job | Trigger |
|-----|---------|
| `deploy-prod` | **Push to `main` with a `package.json:.version` bump** (auto — `detect-version-bump.outputs.bumped == 'true'`) **OR** manual `workflow_dispatch` with `target: prod` (gated on `verify-ci` success). Prod is gated by an explicit version bump — a normal main push does NOT deploy prod. |
| `deploy-pr-preview` | Every PR event (open, sync) |
| `deploy-autotest` | Every push to `main` (auto) OR manual dispatch with `target: autotest` |
| `deploy-dev` | Every push to `main` (auto) OR manual dispatch with `target: dev` |
| `smoke-live` | After successful `deploy-autotest`; runs `@smoke`-tagged e2e against the live URL |

**"Merge to dev" means merge to main** — there's no separate dev branch.
Main auto-deploys to dev (and to autotest).

## Manual deploy

```sh
flox activate -- gh workflow run Deploy --ref main \
  --field target=dev  # or autotest, prod
```

`verify-ci` precheck runs first and requires the latest `main` CI to be
SUCCESS. If main CI is red, the dispatch fails fast.

## Secrets the deploy needs

Repo-level secrets (`gh secret list -R 2600hz-oscillator/patchtogether.live`):

- `CLOUDFLARE_API_TOKEN` — Pages-deploy-scoped token (account-bound).
- `CLOUDFLARE_ACCOUNT_ID` — CF account ID. **This was missing throughout
  phase 1** and only surfaced when wrangler bumped from v3 → v4. v3 inferred
  the account from the API token; v4 makes a project-lookup API call first
  that requires explicit accountId. Symptom: `accounts//pages/projects/<name>`
  (double slash = empty accountId) → HTTP 7003. If you see that again, this
  secret is unset.
- `CLERK_SECRET_KEY` + `PUBLIC_CLERK_PUBLISHABLE_KEY` — auth.
- `AUTOTEST_BETA_GATE_PASS` — basic-auth password for autotest tier.
- `CHAOS_RACKSPACE_URL` — Carl/Mike chaos bots' target rackspace.

Beta-gate basic-auth creds for the staging tiers exist; the user has them
locally. Don't try to set them in committed files.

## Local CF API token

The user keeps a local CF API token at `~/.config/patchtogether/cf.env` for
ad-hoc operations. Never commit; don't print its contents. If you need
account ID to push a fresh deploy from your machine, grep it out of that
file but don't echo it to the chat.

## There is NO native packaging or code signing

Patchtogether.live is a SvelteKit web app. Wrangler bundles the build into
a Cloudflare Pages deployment — that's the entire "packaging" step.

There is no:
- macOS code signing
- App Store submission
- Notarization
- Native binary distribution

If you see "package and sign" mentioned in user context, it's likely about a
different app the user works on (the user mentioned `callsine` and
`p10trancer` in passing). Confirm before assuming.

## Post-merge smoke

After every push to `main`, the deploy workflow:
1. Builds the production bundle.
2. Deploys to autotest + dev in parallel.
3. Runs `task ci:smoke:live` against autotest URL.

If the smoke fails, the workflow run is marked FAILURE — but the deploy
already happened (Pages atomic deploy was committed before smoke ran).
That's intentional — you find out fast, you fix forward.

## Rolling back

CF Pages has built-in rollback to a prior deployment via the Pages dashboard.
Don't try to do this via the CLI for production unless the user asks — it's
a shared-system action.
