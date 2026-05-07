# patchtogether.live persistence

Stage B1+ stores rackspaces and Yjs document snapshots in **Neon Postgres**, accessed by:

- **SvelteKit web** (`@patchtogether.live/web`) on Cloudflare Workers — `@neondatabase/serverless`'s **HTTP** `neon` template tag (Workers can't drive raw `pg` sockets or the package's own WebSocket Pool — see the why-not section).
- **Hocuspocus server** (`@patchtogether.live/server`) on Fly.io — standard `pg.Pool` over TCP. Node runtime, no Workers oddities.

Schema lives in `db/schema/*.sql`. Apply in order; new files are append-only migrations.

## Per-tier topology

One Neon project (`patchtogether`), three branches:

| Tier | Neon branch | Cloudflare Pages | Hocuspocus app |
|---|---|---|---|
| prod | `production` | `patchtogether-live` | `patchtogether-server` |
| autotest | `autotest` | `patchtogether-live-autotest` | `patchtogether-server-autotest` |
| dev | `dev` | `patchtogether-live-dev` | `patchtogether-server-dev` |

Each branch has its own endpoint host (`ep-XXX.c-8.us-east-1.aws.neon.tech`). Same role/password inherited from the parent branch.

## Local dev

```bash
# One-time: install + init + start local Postgres (matches CI shape)
flox install postgresql
mkdir -p ~/.local/share/patchtogether-pg
flox activate -- initdb -D ~/.local/share/patchtogether-pg --auth=trust --username=postgres
sed -i.bak 's/^#port = 5432/port = 54320/' ~/.local/share/patchtogether-pg/postgresql.conf
flox activate -- pg_ctl -D ~/.local/share/patchtogether-pg -l ~/.local/share/patchtogether-pg/server.log start
flox activate -- psql -p 54320 -U postgres -c 'CREATE DATABASE patchtogether_dev;'

# Apply schema
flox activate -- psql -p 54320 -U postgres -d patchtogether_dev -f db/schema/001_init.sql

# Add to your shell or .env.local
export DATABASE_URL='postgresql://postgres:dev@localhost:54320/patchtogether_dev'
```

The web side reads `DATABASE_URL` under `vite dev`. The Neon HTTP API client also works against a local Postgres if you'd rather skip the local PG step entirely — point `DATABASE_URL` at the dev branch on Neon (see `~/.config/patchtogether/cf.env`).

## Provisioning a new Neon branch

API-driven so it scales to ephemeral tiers:

```bash
source ~/.config/patchtogether/cf.env  # NEON_API_KEY, NEON_PROJECT_ID

# Create branch off production
curl -X POST "https://console.neon.tech/api/v2/projects/${NEON_PROJECT_ID}/branches" \
  -H "Authorization: Bearer ${NEON_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"branch":{"name":"<tier>","parent_id":"<prod_branch_id>"},"endpoints":[{"type":"read_write"}]}'

# Get endpoint host from the response, then build the connection string:
# postgresql://neondb_owner:<pwd>@<endpoint-host>/neondb?sslmode=require

# Apply schema
flox activate -- psql "$DB_URL" -f db/schema/001_init.sql

# Set on Cloudflare Pages project + Fly Hocuspocus app:
curl -X PATCH ".../pages/projects/<proj>" \
  --data "{\"deployment_configs\":{\"production\":{\"env_vars\":{\"DATABASE_URL\":{\"type\":\"secret_text\",\"value\":\"$DB_URL\"}}}}}"
flyctl secrets set DATABASE_URL="$DB_URL" --app <hocuspocus-app>
```

Trigger a redeploy of the web tier afterward — env vars apply on next build, not existing deployments.

## Why not Fly Postgres + plain `pg` (the path we tried first)

CF Workers' `node:net` shim under `nodejs_compat` returns "proxy request failed" on any `pg.Client.connect()` — `pg` doesn't speak the `cloudflare:sockets` protocol. The Neon serverless package's WebSocket `Pool` also fails: CF's egress proxy 403s the outbound WS handshake. **Only the HTTP `neon` template tag works.** See `cf-workers-pg-blocker.md` in agent memory + `.myrobots/plans/workers-pg-blocker.md` for the full diagnosis trail.

The first iteration of B1 ran Fly Managed Postgres (3 instances, one per tier, with dedicated IPv4 + AAAA DNS). That whole stack is decommissioned post-Neon — no Fly Postgres in use today.

## Adding a migration

Bump the file number, write the SQL. Apply via `psql` against each Neon branch (build the connection string from `~/.config/patchtogether/cf.env`'s `NEON_*_DIRECT_URL` vars). Down migrations: out of scope for now — beta means we can drop and recreate during pre-launch.

## Code shape constraints

The HTTP API has no client-side multi-statement transactions. Anything that needs atomicity (insert rack + insert owner; check-then-insert capacity) must be one SQL statement, typically a CTE. See `packages/web/src/lib/server/rackspaces.ts` for examples.
