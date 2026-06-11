# Integration: Fly.io (Hocuspocus relay)

**What it is:** Fly.io hosts the real-time collaboration relay — a stateful
**Hocuspocus** WebSocket server that synchronizes Yjs CRDT documents (rackspaces)
across users. **Dashboard:** <https://fly.io/dashboard>.

## How we use it

Three apps, one per web tier, each running **exactly one machine**:

| App | Tier | Config | Memory | Warm? |
| --- | --- | --- | --- | --- |
| `patchtogether-server` | prod | `fly.prod.toml` | 256 MB | yes (`min=1`, `auto_stop=off`) |
| `patchtogether-server-dev` | dev | `fly.dev.toml` | 1024 MB | yes (`min=1`, `auto_stop=off`) |
| `patchtogether-server-autotest` | autotest | `fly.autotest.toml` | 256 MB | no (`min=0`, `auto_stop=stop`) |

Built from `packages/server/Dockerfile` (multi-stage Node 22; final image ~80 MB).
Listens on internal port 8080 (HTTP + WS upgrade); port 443 (TLS) + 80
(force-https) front it. Per-app secrets keep a buggy autotest change from
cross-polluting prod or dev. Setup details: `packages/server/DEPLOY.md`.

### What the relay does (per `packages/server/src/index.ts`)

- **`onAuthenticate`** verifies the token (`clerk:<JWT>` or `anon:<16hex>`) and a
  post-auth access gate (`rack-access.ts`), then reserves 1 of **4** connection
  slots (`capacity.ts`).
- **`onLoadDocument`** restores the rackspace from a Postgres snapshot (or memory
  fallback) on first connect.
- Yjs updates fan out over the Hocuspocus sync protocol; **`onStoreDocument`**
  debounces a full-state snapshot to `rack_snapshots` (2 s normal, 5 s max,
  unload-immediately on last disconnect).
- A **heartbeat** extension broadcasts awareness ticks (1 Hz steady, 8 Hz burst on
  join) for shared-clock sync.
- A **reaper** (30 s) reconciles in-memory slots against live connections to free
  ghost slots from crashed tabs.
- `/health` + `/metrics` for liveness + observability (see
  [../observability.md](../observability.md)).
- A SIGTERM handler drains WS + flushes pending snapshots on redeploy.

## Deploy + verify

```sh
flox activate -- flyctl deploy --config fly.prod.toml     --remote-only
flox activate -- flyctl deploy --config fly.dev.toml      --remote-only
flox activate -- flyctl deploy --config fly.autotest.toml --remote-only
```

### THE SINGLE-MACHINE INVARIANT (critical)

The relay holds the **live Yjs doc + slot tracker in process memory**. Two
machines for one app = split-brain (users in the same rackspace never see each
other). After **every** deploy, verify exactly one machine:

```sh
flox activate -- flyctl machines list -a patchtogether-server          # exactly 1
flox activate -- flyctl machines list -a patchtogether-server-dev      # exactly 1
flox activate -- flyctl machines list -a patchtogether-server-autotest # exactly 1 (may be stopped)
```

Destroy extras immediately:

```sh
flox activate -- flyctl machines destroy <machine-id> --app patchtogether-server-<tier>
```

## Manage / inspect

```sh
flox activate -- flyctl status   -a patchtogether-server          # app status
flox activate -- flyctl logs     -a patchtogether-server          # stream logs
flox activate -- flyctl logs     -a patchtogether-server | grep -E 'relay_uncaught_exception|relay_unhandled_rejection'
flox activate -- flyctl logs     -a patchtogether-server | grep '\[relay-alarm\]'
flox activate -- flyctl secrets  list -a patchtogether-server     # names only
flox activate -- flyctl machine  restart <id> -a patchtogether-server   # graceful SIGTERM drain + cold boot

curl https://patchtogether-server.fly.dev/health
curl https://patchtogether-server.fly.dev/metrics
```

### Secrets

```sh
flox activate -- flyctl secrets set --app patchtogether-server \
  INVITE_SECRET=<...> CLERK_SECRET_KEY=<...> DATABASE_URL=<...>
# Tune memory thresholds without a redeploy:
flox activate -- flyctl secrets set --app patchtogether-server RELAY_MEM_WARN_MB=384 RELAY_MEM_CRIT_MB=480
```

Prefer the lockstep sync (`task sync-secrets -- <tier> --apply`) so web + relay
share `INVITE_SECRET` / `CLERK_SECRET_KEY` / `DATABASE_URL`. See
[../secrets-and-accounts.md](../secrets-and-accounts.md).

### First-time app setup (one-time per app)

```sh
flox activate -- flyctl auth login
flox activate -- flyctl apps create patchtogether-server
flox activate -- flyctl apps create patchtogether-server-dev
flox activate -- flyctl apps create patchtogether-server-autotest
# Attach Postgres BEFORE first prod deploy (see gotcha below), then set secrets.
```

## Environment / secrets reference

| Var | Where | Purpose |
| --- | --- | --- |
| `NODE_ENV=production` | `fly.*.toml [env]` | enables prod fail-fast + anon rack-existence checks |
| `PORT=8080` | `fly.*.toml [env]` | listen port |
| `INVITE_SECRET` | Fly secret | 32+ char HMAC; must match web tier |
| `CLERK_SECRET_KEY` | Fly secret | JWT verification; per-tier |
| `DATABASE_URL` | Fly secret | Postgres; **missing in prod = crash-loop** |
| `RELAY_MEM_WARN_MB` / `RELAY_MEM_CRIT_MB` | Fly secret (optional) | memory alarm thresholds (384/480 default) |
| `ALLOW_MEMORY_STORE=1` | Fly secret (optional) | escape hatch to allow ephemeral in-memory prod run (not recommended) |

## Gotchas

- **Single-machine invariant** — re-verify after every deploy (above). Fly can
  auto-start a second machine during peak/rollback; a second machine boots with an
  empty doc and never receives the first machine's updates ("works sometimes").
- **`DATABASE_URL` missing in prod = crash-loop.** With `NODE_ENV=production`, the
  relay exits(1) ("refusing to boot into in-memory snapshot store") and Fly
  restarts it repeatedly. Attach Postgres / set the secret **before** the first
  prod deploy.
- **`INVITE_SECRET` mismatch web↔relay** → anon tokens silently rejected (WS 1008
  close). If invites stop working after a rotation, confirm both Fly and CF were
  updated.
- **`CLERK_SECRET_KEY` missing/wrong** → all `clerk:` tokens fail (`reject
  (unauthorized)`); sign-in stops working.
- **Per-rack cap is 4** (`RACKSPACE_MAX_CONNECTIONS` in `capacity.ts`); the 5th
  joiner gets `rackspace-full`. Reaper interval is 30 s, so a crashed client's
  slot can linger up to 30 s.
- **Fly `hard_limit=200` conns** assumes ~50 active rackspaces × 4. Bump
  `hard_limit`/`soft_limit` in `fly.*.toml` if active rackspace count grows.
- **`boot_id` flips on restart** — observability keys on this to detect a redeploy;
  expect a `boot_id` change on every deploy.
- **Snapshots are full-state** (`Y.encodeStateAsUpdate`), not incremental — at
  scale they can grow large; watch `/metrics` `persist_writes_per_min` and Postgres
  write latency.
- **Relay horizontal scaling is not implemented** (slot tracker is per-process).
  Scaling to 2+ machines is a known Stage-B+ gap, not a current option.
- **Relay deploy no-ops without `FLY_API_TOKEN`** in CI (steps exit 0).
