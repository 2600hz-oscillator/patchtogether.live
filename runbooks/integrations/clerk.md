# Integration: Clerk (authentication)

**What it is:** Clerk provides authentication and identity (session JWTs).
**Dashboard:** <https://dashboard.clerk.com>.

## How we use it

- Clerk issues **session JWTs**. Both web (`packages/web/src/hooks.server.ts`) and
  relay (`packages/server/src/auth.ts`) verify them **locally** with
  `@clerk/backend` `verifyToken` — typically no per-request network call to Clerk.
- **Per-tier instances:** dev / autotest / PR-preview use a **test** Clerk
  instance; prod uses (or will use) a **live** instance. Each tier carries its own
  `PUBLIC_CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY`.
- **Conditional handler:** `hooks.server.ts` exports
  `handle = sequence(betaGate, conditionalClerk, setCoopCoepHeaders)`.
  `conditionalClerk` only runs Clerk on auth-relevant route prefixes
  (`/dashboard`, `/r/`, `/api/`, `/sign-in`, `/sign-up`); other routes get a
  no-op signed-out auth. `/api/health` (and `/api/test/`) are carved out entirely.
- **Client provider scoping:** `ClerkProvider` is mounted **only on auth routes**
  (`+layout.svelte`). The synth canvas routes run without it so COOP/COEP
  isolation (needed for `SharedArrayBuffer`) isn't broken by Clerk's cross-origin
  scripts.
- **Home-auth fallback:** for the `/` route, `src/lib/server/home-auth.ts` reads
  the `__session` cookie and verifies it locally (no Clerk handshake), to avoid
  rate-limiting parallel anonymous requests.

### Auth gates

- `/dashboard` loader redirects to `/sign-in` if not signed in.
- `/r/[id]` loader allows: authed members, anon via valid HMAC invite, else
  redirect to sign-in.
- `/api/rackspaces*` endpoints return 401 if `locals.auth().userId` is missing.

### Companion: anonymous invites (`INVITE_SECRET`)

Anonymous access uses a deterministic
`HMAC-SHA256(INVITE_SECRET, rackspaceId)` (first 16 hex chars), minted by web
(`src/lib/server/invites.ts`) and verified by both web and relay. URL form:
`/r/<id>?invite=<16-hex>`. This is separate from Clerk but managed alongside it
(both are lockstep secrets). See [neon-postgres.md](neon-postgres.md) and
[../secrets-and-accounts.md](../secrets-and-accounts.md).

## Manage / rotate / inspect

### Verify configuration

```sh
curl https://dev.patchtogether.live/api/health   # shows CLERK_SECRET_KEY / PUBLIC_CLERK_PUBLISHABLE_KEY presence (booleans only)
```

### Set keys

- **Web (Cloudflare Pages):** dashboard → Pages project → Variables and Secrets.
  `CLERK_SECRET_KEY` = secret_text; `PUBLIC_CLERK_PUBLISHABLE_KEY` = plain var.
  (Clerk env is deliberately NOT in `wrangler.toml` so each project can use a
  different instance.)
- **Relay (Fly):** `flyctl secrets set --app patchtogether-server[-dev|-autotest]
  CLERK_SECRET_KEY=<...> INVITE_SECRET=<...>`.

### Rotate `CLERK_SECRET_KEY`

1. Create a new API key in the Clerk dashboard.
2. Set it on the Cloudflare Pages project (production + preview scopes).
3. Set it on the three Fly relay apps via `flyctl secrets set`.
4. Trigger a redeploy of web + relay (any main push, or `workflow_dispatch`).
5. Old sessions become invalid immediately after rotation.

Use `task sync-secrets -- <tier> --apply` to push the secret to both web + relay
in lockstep.

### Rotate `INVITE_SECRET`

1. Generate a new 32+ char random string.
2. Set on the Cloudflare Pages project and on the three Fly apps.
3. Redeploy. **All outstanding `/r/<id>?invite=<code>` links become invalid**
   (invite codes are deterministic; there's no per-rackspace revocation — only a
   global secret rotation).

## Gotchas

- **Clerk env is all-or-nothing.** Both `CLERK_SECRET_KEY` AND
  `PUBLIC_CLERK_PUBLISHABLE_KEY` must be set for auth to work. If either is missing
  on an auth-requiring route, the handler returns **503 "Auth not configured"**
  (by design — expected on prod until launch). Partial config is treated as
  misconfiguration.
- **`INVITE_SECRET` must be ≥ 32 chars** or the code throws outside dev. CF Pages
  prod isn't `NODE_ENV=development`, so a missing/short secret fails loudly on the
  first anon-invite request.
- **`INVITE_SECRET` must match web ↔ relay** or every anon guest is **silently
  rejected** at the WS handshake (red dot, "nodes 0"); Clerk users are unaffected,
  so it's easy to miss. `anon-handshake-smoke.mjs` catches this post-deploy.
- **ClerkProvider breaks COOP/COEP** — that's why it's mounted only on auth routes
  and never on the synth canvas.
- **Per-tier keys differ** (test vs live). Setting a prod live key on a test tier
  (or vice versa) silently breaks JWT verification.
- **CF API redacts `secret_text`** — you cannot read the old key back before
  rotating; keep your source-of-truth local.
- **Relay deploy no-ops without `FLY_API_TOKEN`** — relay won't get the rotated
  key until the token is wired and a relay deploy runs.
- **Membership not enforced at the WS layer (known gap):** the relay's
  `verifyToken` accepts any authed `userId`; the rackspace membership gate lives in
  the HTTP `/r/[id]` loader. (Documented as post-Stage-B work.)
