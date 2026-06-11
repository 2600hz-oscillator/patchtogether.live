# Architecture

patchtogether.live is a browser-first collaborative modular synthesizer. The
heavy lifting (audio DSP via Faust/WebAudio worklets, video via WebGL, retro
emulator modules via WASM) all runs **in the user's browser**. The server side is
deliberately thin: a static web bundle, a stateful real-time sync relay, a
database, and an auth provider.

## Components

| Component | Tech | Where it runs |
| --- | --- | --- |
| Web app | SvelteKit + Vite, `@sveltejs/adapter-cloudflare` | Cloudflare Pages (Workers runtime) |
| Real-time relay | Hocuspocus (Yjs CRDT over WebSocket) | Fly.io (single machine per tier) |
| Database | Postgres | Neon (web tier, HTTP driver) + Fly Postgres path for relay (TCP) |
| Auth | Clerk (session JWTs) | Clerk-hosted; verified locally in web + relay |
| DSP | Faust `.dsp` → WASM + TS AudioWorklets | client browser |
| Emulator modules | Emscripten-compiled C (DOOM, SNES9X, …) → WASM | client browser |

## Data-flow diagram

```
                        ┌──────────────────────────────────────────────┐
                        │                  BROWSER                       │
                        │  SvelteKit SPA  ·  WebAudio worklets (Faust    │
                        │  WASM)  ·  WebGL video  ·  emulator WASM        │
                        │  Yjs doc (local CRDT replica of the rackspace) │
                        └───────┬───────────────────────┬───────────────┘
                                │ HTTPS                  │ WSS (Yjs sync)
                                │ (page + /api/*)        │ token: clerk:<JWT>
                                │                        │   or anon:<16hex>
                                ▼                        ▼
        ┌─────────────────────────────────┐   ┌────────────────────────────────┐
        │   CLOUDFLARE PAGES (web tier)    │   │   FLY.IO  (Hocuspocus relay)    │
        │   SvelteKit on Workers runtime   │   │   ONE machine per tier          │
        │   · hooks.server.ts:             │   │   · onAuthenticate (Clerk/HMAC) │
        │       beta-gate, conditional     │   │   · per-rack slot cap (max 4)   │
        │       Clerk, COOP/COEP headers   │   │   · in-memory live Yjs doc      │
        │   · /api/health, /api/rackspaces │   │   · /health, /metrics           │
        └───────┬─────────────────┬────────┘   └─────────────────┬──────────────┘
                │ verifyToken      │ Neon HTTP                    │ snapshot persist
                │ (local, no       │ (@neondatabase/serverless)   │ (pg over TCP /
                │  network call)   ▼                              │  Fly Postgres path)
                │          ┌───────────────┐                      │
                │          │     NEON      │◄─────────────────────┘
                │          │   Postgres    │   rack_snapshots (Yjs bytea),
                │          │ (per-tier     │   racks, rack_members, feedback,
                │          │   branches)   │   saved_groups
                │          └───────────────┘
                ▼
        ┌───────────────┐
        │     CLERK     │   session JWT issuance + verification keys
        │ (auth/identity)│  (verified via @clerk/backend, mostly offline)
        └───────────────┘
```

### Key flows

- **Loading a rackspace** (`/r/<id>`): the SvelteKit route loader checks Clerk
  membership *or* an HMAC-verified anonymous invite code, then the browser opens a
  WebSocket to the relay tier baked into the bundle (`VITE_SERVER_WS_URL`).
- **Collaboration**: the relay holds the **canonical live Yjs document in process
  memory** and fans out CRDT updates to all connected clients in that rackspace.
  It debounces snapshots to Postgres (`rack_snapshots`).
- **Auth**: Clerk issues a session JWT. Both web (`hooks.server.ts`) and relay
  (`packages/server/src/auth.ts`) verify it locally with `@clerk/backend`
  `verifyToken` — typically no round-trip to Clerk per request.
- **Anonymous invites**: a deterministic `HMAC-SHA256(INVITE_SECRET, rackspaceId)`
  (first 16 hex chars). Minted by web (`src/lib/server/invites.ts`), verified by
  both web and relay. The secret **must be identical** across web and relay tiers
  or every anon guest is silently rejected.

## Why these constraints exist

- **Single-machine relay (critical):** the live Yjs doc and the connection-slot
  tracker live in process memory. Two machines = two divergent copies of the same
  rackspace = users never see each other ("split-brain"). Each tier's Fly config
  enforces exactly one warm machine. See [integrations/fly.md](integrations/fly.md).
- **Neon HTTP-only on Cloudflare Workers:** raw `pg` TCP sockets don't work on the
  Workers runtime, and Neon's WebSocket Pool gets 403'd by the CF egress proxy.
  Only Neon's HTTP `neon` template tag works, so multi-statement operations are
  rewritten as single CTE statements. See
  [integrations/neon-postgres.md](integrations/neon-postgres.md).
- **COOP/COEP isolation:** the audio engine needs `SharedArrayBuffer`, which
  requires `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy:
  require-corp`. Clerk's cross-origin client scripts break COEP, so `ClerkProvider`
  is mounted **only on auth routes**, never on the synth canvas routes.

## Tier domains (summary)

| Tier | Web domain | Relay host |
| --- | --- | --- |
| prod | `patchtogether.live` | `patchtogether-server.fly.dev` |
| dev | `dev.patchtogether.live` | `patchtogether-server-dev.fly.dev` |
| autotest | `autotest.patchtogether.live` | `patchtogether-server-autotest.fly.dev` |
| PR preview | `pr-<N>.patchtogether-live-autotest.pages.dev` | (shares autotest relay) |

Per-tier behavior and triggers: [deployment.md](deployment.md).

## Source-of-truth files

| Concern | File |
| --- | --- |
| Web server hooks (beta-gate, Clerk, headers) | `packages/web/src/hooks.server.ts` |
| Web DB (Neon HTTP) | `packages/web/src/lib/server/db.ts` |
| Anon invite HMAC | `packages/web/src/lib/server/invites.ts` |
| Relay entry point | `packages/server/src/index.ts` |
| Relay auth | `packages/server/src/auth.ts` |
| Relay slot cap | `packages/server/src/capacity.ts` |
| Relay DB (pg pool) | `packages/server/src/db.ts` |
| Fly configs | `fly.prod.toml`, `fly.dev.toml`, `fly.autotest.toml` |
| CF Pages config | `packages/web/wrangler.toml` |
| DB schema | `db/schema/001_init.sql`, `002_feedback.sql`, `003_saved_groups.sql` |
