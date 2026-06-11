# Integration: Cloudflare Pages

**What it is:** Cloudflare Pages hosts the static SvelteKit web app on the Workers
runtime. **Dashboard:** <https://dash.cloudflare.com>.

## How we use it

Four Pages projects (one per tier; PR previews share the autotest project):

| Project | Tier | Domain |
| --- | --- | --- |
| `patchtogether-live` | prod | `patchtogether.live` |
| `patchtogether-live-dev` | dev | `dev.patchtogether.live` |
| `patchtogether-live-autotest` | autotest + PR previews | `autotest.patchtogether.live`, `pr-<N>.patchtogether-live-autotest.pages.dev` |

- **Adapter:** `@sveltejs/adapter-cloudflare` (`packages/web/svelte.config.js`).
  The app is effectively fully client-rendered; SvelteKit hooks run as edge
  middleware (`packages/web/src/hooks.server.ts`).
- **Config:** `packages/web/wrangler.toml` — `pages_build_output_dir =
  .svelte-kit/cloudflare`, `compatibility_flags = ["nodejs_compat"]`. The `name`
  is a placeholder, overridden by `--project-name` on every deploy.
- **Deploy command** (see [../deployment.md](../deployment.md)):
  `wrangler pages deploy .svelte-kit/cloudflare --project-name=<project> --branch=<branch>`.

### Why `nodejs_compat`

`@grame/faustwasm`'s ESM build does `await import('fs')` / `await import('url')` at
module-eval time. Those paths are unreachable in browser code but the bundler must
still resolve them. `nodejs_compat` makes the bundle build cleanly. **It does NOT
provide raw TCP sockets** — see the Neon constraint below.

### COOP/COEP for SharedArrayBuffer

The audio engine needs `SharedArrayBuffer`, which requires
`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy:
require-corp`. These are set in **both** `packages/web/_headers` (production) and
`hooks.server.ts`'s `setCoopCoepHeaders` (dev/edge), as belt-and-suspenders. The
synth/canvas routes (`/`, `/r/*`) declare isolation; auth/docs routes deliberately
don't, so Clerk's cross-origin scripts load (COEP would block them).

## Environment variables

Two classes:

- **Build-time `VITE_*`** — baked into the client bundle at build (see
  [../build.md](../build.md)). Changing them in the CF dashboard does **nothing**;
  you must rebuild. These include `VITE_SERVER_WS_URL`, `VITE_E2E_HOOKS`,
  `VITE_VIDEO_WORKER`.
- **Runtime (CF Pages Variables + Secrets)** — read on the server at request time
  via SvelteKit `$env/dynamic/private` (which maps to `platform.env`). These
  include `DATABASE_URL`, `INVITE_SECRET`, `CLERK_SECRET_KEY` (secret),
  `PUBLIC_CLERK_PUBLISHABLE_KEY` (plain var), `BETA_GATE_PASS`/`BETA_GATE_USER`.

Each project has its own dashboard-scoped Variables + Secrets (production +
preview scopes). Full inventory: [../secrets-and-accounts.md](../secrets-and-accounts.md).

## Manage / inspect / rotate

```sh
# List / set secrets per project (applies to production + preview scopes):
flox activate -- wrangler pages secret list --project-name=patchtogether-live-dev
flox activate -- wrangler pages secret put  INVITE_SECRET --project-name=patchtogether-live-dev --env production

# Live logs from a deployment:
flox activate -- wrangler tail --project-name=patchtogether-live

# Health check:
curl https://dev.patchtogether.live/api/health
```

Prefer the lockstep sync script over setting CF secrets piecemeal (it pushes the
same value to Fly relay + CF web atomically):

```sh
flox activate -- task sync-secrets -- dev --apply
```

**Rotating a secret:** set the new value via `wrangler pages secret put` (or the
dashboard) for both `production` and `preview` scopes, set the matching value on
the Fly relay, then **rebuild + redeploy** (CF Pages env is read at runtime, but
`VITE_*`-derived behaviors and a fresh deploy ensure consistency). Use
`sync-secrets.sh` to keep web↔relay aligned. See the
[Clerk](clerk.md) and [Neon](neon-postgres.md) docs for the rotation steps
specific to those secrets.

## Database constraint (critical)

**On the Workers runtime, only Neon's HTTP driver works.** Raw `pg` TCP sockets
fail, and Neon's WebSocket Pool gets 403'd by CF's egress proxy. The web tier uses
`@neondatabase/serverless`'s `neon` template tag, and multi-statement operations
are rewritten as single CTE statements. Do **not** add a `pg` import expecting
`nodejs_compat` to give it sockets — it won't. See [neon-postgres.md](neon-postgres.md).

`DATABASE_URL` must be read via `$env/dynamic/private`, NOT `process.env`
(`process.env` is undefined on Workers and silently falls back to localhost →
"Direct IP access not allowed" errors). See `packages/web/src/lib/server/db.ts`.

## Gotchas

- **`VITE_*` are build-time only** — dashboard env changes don't reach the bundle;
  rebuild + redeploy.
- **`DATABASE_URL` via `$env/dynamic/private` only** — `process.env` is undefined
  on Workers.
- **`nodejs_compat` ≠ TCP sockets** — it's only for the faustwasm `import('fs'|'url')`
  bundle resolution.
- **PR previews land on the autotest project** — they inherit the test Clerk
  instance + autotest relay so the full auth flow works in review.
- **CF API redacts `secret_text`** — you cannot read back an old secret value via
  the API before rotating; keep the source-of-truth in your local secrets file.
- **`RACKSPACE_SEED_ENABLED`** (enables `POST /api/test/seed-rackspace`) must be
  set **only** on autotest (or local dev). Enabling it elsewhere lets anyone mint
  rackspaces without auth.
