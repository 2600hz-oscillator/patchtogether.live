# patchtogether.live persistence

Stage B1+ stores rackspaces and Yjs document snapshots in **Postgres on Fly Managed Postgres**, accessed by:

- **Hocuspocus server** (`@patchtogether.live/server`) — direct `pg.Pool` over Fly's internal network (~5ms)
- **SvelteKit web** (`@patchtogether.live/web`) on Cloudflare Workers — `pg.Client` per request via **Cloudflare Hyperdrive** (~30–50ms via Hyperdrive's edge connection pool, vs ~150ms naïve cross-cloud)

Schema lives in `db/schema/*.sql`. Apply in order; new files are append-only migrations.

## Per-tier topology

Three tiers, each with its own Fly Postgres + Hyperdrive binding:

| Tier | Fly Postgres app | Cloudflare Hyperdrive | Cloudflare Pages |
|---|---|---|---|
| prod | `patchtogether-pg` | `patchtogether-pg` | `patchtogether-live` |
| autotest | `patchtogether-pg-autotest` | `patchtogether-pg-autotest` | `patchtogether-live-autotest` |
| dev | `patchtogether-pg-dev` | `patchtogether-pg-dev` | `patchtogether-live-dev` |

## Local dev

```bash
# One-time: install + init + start local Postgres
flox install postgresql
mkdir -p ~/.local/share/patchtogether-pg
flox activate -- initdb -D ~/.local/share/patchtogether-pg --auth=trust --username=postgres
sed -i.bak 's/^#port = 5432/port = 54320/' ~/.local/share/patchtogether-pg/postgresql.conf
flox activate -- pg_ctl -D ~/.local/share/patchtogether-pg -l ~/.local/share/patchtogether-pg/server.log start
flox activate -- psql -p 54320 -U postgres -c 'CREATE DATABASE patchtogether_dev;'
flox activate -- psql -p 54320 -U postgres -c 'CREATE DATABASE patchtogether_test;'

# Apply schema
flox activate -- psql -p 54320 -U postgres -d patchtogether_dev -f db/schema/001_init.sql

# Add to your shell or .env.local
export DATABASE_URL='postgresql://postgres:dev@localhost:54320/patchtogether_dev'
```

The web side reads `DATABASE_URL` under `vite dev`. The wrangler.toml's
`[[hyperdrive]]` `localConnectionString` covers `wrangler pages dev` if you
ever use it.

## First-time provisioning per tier (Fly + Cloudflare Hyperdrive)

### Fly Postgres

```bash
# Cheapest single-node config; bump if/when needed.
flox activate -- flyctl postgres create \
  --name patchtogether-pg-dev \
  --region iad \
  --vm-size shared-cpu-1x \
  --volume-size 1 \
  --initial-cluster-size 1
# When prompted, save the generated connection string somewhere safe — Fly
# only shows it once. The shape is:
#   postgres://postgres:<pwd>@patchtogether-pg-dev.flycast:5432
```

Attach to the corresponding Hocuspocus app (sets `DATABASE_URL` as a Fly secret):

```bash
flox activate -- flyctl postgres attach \
  --app patchtogether-server-dev \
  patchtogether-pg-dev
```

Apply the schema (Fly proxy + psql):

```bash
flox activate -- flyctl proxy 5432 --app patchtogether-pg-dev &
PROXY=$!
flox activate -- psql "$FLY_PG_CONN_STRING" -f db/schema/001_init.sql
kill $PROXY
```

Repeat per tier with the corresponding `-autotest` and `<no-suffix>` (prod) names.

### Cloudflare Hyperdrive

For each tier, create a Hyperdrive instance pointing at the matching Fly Postgres external URL (NOT the `.flycast` internal one — Hyperdrive lives outside Fly's net):

```bash
# Get the external URL from `flyctl status --app patchtogether-pg-dev` →
# look for the external IPv4 + the credentials saved during create.
flox activate -- npx wrangler hyperdrive create patchtogether-pg-dev \
  --connection-string='postgresql://postgres:<pwd>@<external-ip>:5432/postgres'
# Copy the returned id (32 hex chars).
```

Then update the matching Cloudflare Pages project's binding to that id (via dashboard or `wrangler.toml` per-env stanza). The `[[hyperdrive]]` block in `packages/web/wrangler.toml` declares the binding name (`HYPERDRIVE`) but the per-tier `id` lives in the Pages project's Bindings panel since that's how Cloudflare Pages currently handles per-env binding overrides.

## Adding a migration

Bump the file number, write the SQL. Apply via `psql` against each tier (proxy through `flyctl proxy 5432 --app patchtogether-pg-…`). Down migrations: out of scope for now — beta means we can drop and recreate during pre-launch.
