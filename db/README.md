# patchtogether.live persistence

Stage B1+ stores rackspaces and Yjs document snapshots in **Postgres on Fly Managed Postgres**, accessed by:

- **Hocuspocus server** (`@patchtogether.live/server`) — direct `pg.Pool` over Fly's internal network (~5ms)
- **SvelteKit web** (`@patchtogether.live/web`) on Cloudflare Workers — per-request `pg.Client` over a public Fly IPv6 (~150ms cross-cloud). The original plan was Cloudflare Hyperdrive (~30ms), but Hyperdrive requires TLS at the origin and Fly Postgres ships plain TCP. Fixing that is its own scope; we accept the latency for beta and revisit when RUM shows it mattering. See "Future: Hyperdrive" at the bottom.

Schema lives in `db/schema/*.sql`. Apply in order; new files are append-only migrations.

## Per-tier topology

Three tiers, each with its own Fly Postgres:

| Tier | Fly Postgres app | Cloudflare Pages | Hocuspocus app |
|---|---|---|---|
| prod | `patchtogether-pg` | `patchtogether-live` | `patchtogether-server` |
| autotest | `patchtogether-pg-autotest` | `patchtogether-live-autotest` | `patchtogether-server-autotest` |
| dev | `patchtogether-pg-dev` | `patchtogether-live-dev` | `patchtogether-server-dev` |

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

### Cloudflare Pages: DATABASE_URL

For each tier, allocate a public IPv6 on the Postgres app (Fly's free shared IPv4 only exposes 80/443; IPv6 is free and routable for any port), add a DNS record so the IP has a stable hostname, then set `DATABASE_URL` on the matching Cloudflare Pages project as `secret_text`:

```bash
# Per tier — example for dev:
flox activate -- flyctl ips allocate-v6 --app patchtogether-pg-dev
# Copy the returned IPv6, e.g. 2a09:8280:1::aaaa:bbbb:0

# DNS: pg-<tier>.patchtogether.live → that IPv6, AAAA, NOT proxied
curl -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -d '{"type":"AAAA","name":"pg-dev","content":"<IPv6>","ttl":1,"proxied":false}'

# Set DATABASE_URL on the matching CF Pages project
DB_URL='postgres://patchtogether_server_dev:<pwd>@pg-dev.patchtogether.live:5432/patchtogether_server_dev?sslmode=disable'
curl -X PATCH "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects/patchtogether-live-dev" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -d "{\"deployment_configs\":{\"production\":{\"env_vars\":{\"DATABASE_URL\":{\"type\":\"secret_text\",\"value\":\"${DB_URL}\"}}}}}"
```

Trigger a redeploy of the web tier afterward to pick up the new env (the env applies on next build, not on existing deployments).

## Future: Hyperdrive (deferred optimization)

The original plan used Cloudflare Hyperdrive between Workers and Fly Postgres for ~30ms latency vs the ~150ms direct connection. Hyperdrive requires TLS at the origin; Fly Postgres serves plain TCP. To unblock it later: either (a) configure Fly Postgres to terminate TLS on its public address (`stunnel`, custom certs, or Fly Tunnel), or (b) migrate to Neon Postgres (native Workers support, TLS by default). Revisit when RUM shows Worker→DB query latency dominating page-load p95.

## Adding a migration

Bump the file number, write the SQL. Apply via `psql` against each tier (proxy through `flyctl proxy 5432 --app patchtogether-pg-…`). Down migrations: out of scope for now — beta means we can drop and recreate during pre-launch.
