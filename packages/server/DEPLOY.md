# Deploying @patchtogether.live/server to Fly.io

The Hocuspocus collaboration server runs as three separate Fly apps — one per Cloudflare web tier — so a buggy server change can't cross-pollinate.

| Web tier (CF Pages) | Server tier (Fly app) | Hostname |
|---|---|---|
| `patchtogether-live` (prod) | `patchtogether-server` | `patchtogether-server.fly.dev` |
| `patchtogether-live-autotest` | `patchtogether-server-autotest` | `patchtogether-server-autotest.fly.dev` |
| `patchtogether-live-dev` | `patchtogether-server-dev` | `patchtogether-server-dev.fly.dev` |

## First-time setup (per app)

```bash
# Install flyctl once
curl -L https://fly.io/install.sh | sh

# One-time auth (opens browser)
flyctl auth login

# Create each app — `--no-deploy` so we can set secrets first
flyctl apps create patchtogether-server
flyctl apps create patchtogether-server-autotest
flyctl apps create patchtogether-server-dev
```

## Set per-app secrets

Each app needs `INVITE_SECRET` (must match the corresponding Cloudflare web project's value — anon invite codes won't validate otherwise) and `CLERK_SECRET_KEY` (same as web's, per tier).

Pull the values from `~/.config/patchtogether/cf.env` and the Cloudflare Pages project (run from the workspace root):

```bash
# Production
flyctl secrets set --app patchtogether-server \
  INVITE_SECRET="<value matching patchtogether-live's INVITE_SECRET>" \
  CLERK_SECRET_KEY="sk_live_..."

# Autotest
flyctl secrets set --app patchtogether-server-autotest \
  INVITE_SECRET="<value matching patchtogether-live-autotest's INVITE_SECRET>" \
  CLERK_SECRET_KEY="sk_test_..."

# Dev
flyctl secrets set --app patchtogether-server-dev \
  INVITE_SECRET="<value matching patchtogether-live-dev's INVITE_SECRET>" \
  CLERK_SECRET_KEY="sk_test_..."
```

The Cloudflare API redacts `secret_text` values, so look up the originals from the random strings generated when they were set (or rotate both sides at once: pick a new value, set on both Fly and Cloudflare, deploy).

## Deploy

```bash
# From workspace root
flyctl deploy --config fly.prod.toml
flyctl deploy --config fly.autotest.toml
flyctl deploy --config fly.dev.toml
```

Each command builds the Docker image (multi-stage, ~80MB final), pushes to Fly's registry, and rolls out. Takes ~3 min cold, ~30s with cache.

## Wire the web tier

Once the Fly app is up, set `VITE_SERVER_WS_URL` on its matching Cloudflare Pages project as `secret_text`:

```bash
# Pseudo-shell — actual call uses the CF API
PROJECT=patchtogether-live
URL="wss://patchtogether-server.fly.dev"
# ... PATCH the env_var into the project's production scope
```

Trigger a redeploy of the web tier (any push to the relevant branch, or `flyctl deploy` for fly tiers) to pick up the new env.

## Verify

```bash
# TCP connectivity
nc -zv patchtogether-server.fly.dev 443

# Open the app in a browser, sign in / use invite, open browser devtools
# Network tab — filter to WS. Should see one connection to the matching
# wss://...fly.dev/ URL with status 101 (switching protocols).
```

If the connection fails:
- Check `flyctl logs --app patchtogether-server` for `[hocuspocus] reject (...)` lines.
- Confirm `INVITE_SECRET` matches between web and server (HMAC mismatch → `unauthorized`).
- Confirm `CLERK_SECRET_KEY` is set (missing key → `unauthorized` for `clerk:` tokens).
