# Integration: Neon Postgres

**What it is:** Neon is serverless Postgres. **Dashboard:** <https://console.neon.tech>.

## How we use it — two drivers, one database family

| Tier | Driver | Why |
| --- | --- | --- |
| **Web** (Cloudflare Workers) | Neon **HTTP** (`@neondatabase/serverless` `neon` template tag) | raw `pg` TCP + Neon WebSocket Pool both fail on Workers |
| **Relay** (Fly.io) | standard `pg.Pool` over **TCP** | runs on Node on Fly, where TCP works |

Per-tier isolation via **Neon branches**: `dev`, `autotest`, `production`
(each a separate endpoint URL). `DATABASE_URL` is set as a secret on each
deployment target. Web resolves it via SvelteKit `$env/dynamic/private`
(`packages/web/src/lib/server/db.ts`); the relay reads it from Fly secrets
(`packages/server/src/db.ts`).

### Schema (append-only migrations)

| File | Tables |
| --- | --- |
| `db/schema/001_init.sql` | `racks` (owner + name), `rack_members` (user_id + role), `rack_snapshots` (Yjs `bytea`) |
| `db/schema/002_feedback.sql` | `feedback` (suggestion/bug, patch snapshot) |
| `db/schema/003_saved_groups.sql` | `saved_groups` (per-user JSONB library) |

Migrations are **append-only** during beta (no down-migrations). New changes bump
the file number (`004_*.sql`) and are applied to each branch in order. Ops guide:
`db/README.md`.

### Persistence flow

- Relay `onLoadDocument` restores `rack_snapshots.yjs_state`; `onStoreDocument`
  upserts the full encoded state (debounced — see [fly.md](fly.md)).
- `isRackspaceMember()` / `rackspaceExists()` gate access. In **in-memory mode**
  (no `DATABASE_URL`, local/e2e) both return true so Playwright contexts can join
  without standing up Postgres.

## Manage / inspect

```sh
# Inspect recent snapshots (do NOT print yjs_state — it's binary; show size only):
psql "<DATABASE_URL>" -c "SELECT rack_id, octet_length(yjs_state) AS bytes, updated_at \
  FROM rack_snapshots ORDER BY updated_at DESC LIMIT 10;"

# Members of a rack:
psql "<DATABASE_URL>" -c "SELECT r.id, r.name, m.user_id, m.role, m.joined_at \
  FROM racks r JOIN rack_members m ON r.id = m.rack_id WHERE r.id = '<rack_id>';"

# Relay persistence mode (postgres vs memory):
curl https://patchtogether-server-dev.fly.dev/health
```

> Substitute `<DATABASE_URL>` from your local secrets file / the Neon dashboard.
> Never paste a real connection string into the repo, a PR, or a chat.

## Provision a new Neon branch

(Reference — exact API shape may change; **verify in the Neon dashboard / API
docs**.) Use the Neon console to create a branch off the production parent and
read the endpoint connection string from the dashboard, then apply schema:

```sh
flox activate -- psql "<NEON_BRANCH_URL>" -f db/schema/001_init.sql
flox activate -- psql "<NEON_BRANCH_URL>" -f db/schema/002_feedback.sql
flox activate -- psql "<NEON_BRANCH_URL>" -f db/schema/003_saved_groups.sql
```

Then set `DATABASE_URL` on the matching CF Pages project (web) and Fly app
(relay), preferably via `task sync-secrets`.

## Rotate the Postgres password

1. In the Neon console (project → branch → connection strings), regenerate the
   password. **All branches share the parent's role/password**, so this affects
   every tier.
2. Rebuild the `DATABASE_URL` connection string(s).
3. Push the new `DATABASE_URL` to **all** targets — CF Pages (web, Neon HTTP) and
   Fly (relay). Use `task sync-secrets -- <tier> --apply`.
4. Redeploy / let the new value take effect.

## Local dev

The relay falls back to in-memory mode and web to a localhost dev DB when
`DATABASE_URL` is unset, so most local work needs no DB. To stand one up on the
non-standard port **54320** (avoids 5432 collisions):

```sh
flox activate -- initdb -D ~/.local/share/patchtogether-pg --auth=trust --username=postgres
# set port 54320 in postgresql.conf, then:
flox activate -- pg_ctl -D ~/.local/share/patchtogether-pg -l ~/.local/share/patchtogether-pg/server.log start
flox activate -- psql -p 54320 -U postgres -c 'CREATE DATABASE patchtogether_dev;'
flox activate -- psql -p 54320 -U postgres -d patchtogether_dev -f db/schema/001_init.sql   # repeat for 002, 003

export DATABASE_URL='postgresql://postgres:<dev-pw>@localhost:54320/patchtogether_dev'
flox activate -- npm run dev
```

The localhost fallback is hardcoded to **port 54320** — if you run Postgres on the
default 5432, the web tier won't find it.

## Gotchas

- **CF Workers can only use Neon HTTP.** Raw `pg.Client` and Neon WebSocket Pool
  both fail (cryptic "proxy request failed" / egress-403). The web tier is locked
  into Neon HTTP.
- **No client-side transactions over HTTP.** Each `sql()` call is one round-trip;
  multi-statement ops must be a single SQL statement (CTEs, `ON CONFLICT`).
  `sql.transaction([lock, cte])` is the only way to serialize concurrent ops — used
  for per-rack `pg_advisory_xact_lock` to keep concurrent joins from busting the
  4-slot cap (`packages/web/src/lib/server/rackspaces.ts`; proven by the
  `neon-pg-shim` test).
- **Relay snapshot errors are silently swallowed** (auth timeout, transient
  connection drop, FK on ephemeral test racks) — they retry on the next debounce
  (≤5 s staleness). Intentional: a dropped snapshot is recoverable, a crash isn't.
- **The pg pool `error` listener is mandatory** (`packages/server/src/db.ts`).
  Without it, an idle-connection backend error crashes Node. Don't remove it.
- **Prod fail-fast only fires if `NODE_ENV=production`.** A prod binary run locally
  needs `NODE_ENV` set manually to exercise the guard.
- **Persistence mode is captured at module load** (`USE_MEMORY = !DATABASE_URL`).
  Changing `DATABASE_URL` at runtime has no effect.
- **Branches share role/password** — rotating the password requires updating
  `DATABASE_URL` on all three tiers (web Neon HTTP + relay pool).
- **Schema is append-only** — no down-migration path during beta; plan changes
  carefully.
- **Rack IDs are bearer tokens** (share-by-URL); they are not cryptographically
  random by design. Anyone with the URL can attempt to join.
