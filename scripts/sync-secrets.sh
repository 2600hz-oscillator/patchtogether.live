#!/usr/bin/env bash
#
# scripts/sync-secrets.sh — keep the web app and the Hocuspocus relay in
# secret-lockstep so anonymous invites never silently break.
#
# THE BUG THIS PREVENTS
# ---------------------
# Anonymous rackspace invites are HMAC-SHA256(INVITE_SECRET, rackspaceId)
# truncated to 16 hex chars. The WEB app MINTS them
# (packages/web/src/lib/server/invites.ts); the RELAY VERIFIES them at the WS
# handshake (packages/server/src/auth.ts → verifyInviteCode, called from
# onAuthenticate in packages/server/src/index.ts). If the relay's
# INVITE_SECRET (a Fly secret) drifts from the web app's (a Cloudflare Pages
# env var), EVERY anon guest is silently rejected at the handshake — red dot,
# `nodes 0` — while signed-in (Clerk JWT) users are unaffected, so it's easy
# to miss. This happened on dev. This script pushes the per-tier secrets to
# BOTH targets from one source of truth so they cannot drift.
#
# SOURCE OF TRUTH
# ---------------
#   ~/.config/patchtogether/cf.env   (override with PATCHTOGETHER_ENV_FILE)
# Keys consumed (per tier):
#   INVITE_SECRET_{DEV,AUTOTEST,PROD}     — the lockstep HMAC secret
#   CLERK_SECRET_KEY / CLERK_SECRET_KEY_LIVE — Clerk backend key (see notes)
#   FLY_PG_{DEV,AUTOTEST,PROD}_URL        — relay DATABASE_URL (Fly Postgres)
#   NEON_{DEV,AUTOTEST,PROD}_URL          — web DATABASE_URL (pooled Neon)
#
# TARGETS (per tier)
# ------------------
#   Relay  → Fly app   patchtogether-server[-dev|-autotest]   (flyctl secrets set)
#   Web    → CF Pages  patchtogether-live[-dev|-autotest]     (wrangler pages secret put)
#
# Which secrets each side gets (derived from the code that reads them):
#   Relay (packages/server/src):
#     INVITE_SECRET     — auth.ts getInviteSecret() (anon verify)        [LOCKSTEP]
#     CLERK_SECRET_KEY  — auth.ts verifyClerkJwt() (member verify)
#     DATABASE_URL      — db.ts getPool() (snapshot persist + membership) = Fly PG
#   Web (packages/web/src):
#     INVITE_SECRET     — lib/server/invites.ts getSecret() (anon mint)  [LOCKSTEP]
#     CLERK_SECRET_KEY  — hooks.server.ts / health (Clerk handler)
#     DATABASE_URL      — lib/server/db.ts (Neon HTTP) = pooled Neon URL
#   (PUBLIC_CLERK_PUBLISHABLE_KEY is a build-time VITE-style public var, not a
#    secret, and is NOT in cf.env — see "NOT MAPPED" below.)
#
# USAGE
#   scripts/sync-secrets.sh <dev|autotest|prod>            # DRY-RUN (default): prints names only
#   scripts/sync-secrets.sh <dev|autotest|prod> --apply    # actually push (dev/autotest)
#   scripts/sync-secrets.sh prod --apply --yes-prod        # prod requires the extra confirm flag
#
# SAFETY
#   - Default is DRY-RUN. Nothing is mutated without --apply.
#   - Secret VALUES are never echoed — only names + a redacted length/fingerprint.
#   - prod refuses to run without BOTH --apply AND --yes-prod.
#   - Run every command through flox:  flox activate -- scripts/sync-secrets.sh ...
#     (or via `task sync-secrets -- <tier> [--apply ...]`).

set -euo pipefail

ENV_FILE="${PATCHTOGETHER_ENV_FILE:-$HOME/.config/patchtogether/cf.env}"

die() { echo "error: $*" >&2; exit 1; }
note() { echo "  $*"; }

# ── Args ────────────────────────────────────────────────────────────────────
TIER="${1:-}"
APPLY=0
YES_PROD=0
shift || true
for arg in "$@"; do
  case "$arg" in
    --apply)    APPLY=1 ;;
    --yes-prod) YES_PROD=1 ;;
    *) die "unknown arg: $arg" ;;
  esac
done

case "$TIER" in
  dev|autotest|prod) ;;
  "") die "missing tier. usage: sync-secrets.sh <dev|autotest|prod> [--apply] [--yes-prod]" ;;
  *) die "invalid tier '$TIER' (want dev|autotest|prod)" ;;
esac

if [[ "$TIER" == "prod" && "$APPLY" == "1" && "$YES_PROD" != "1" ]]; then
  die "refusing to apply to PROD without --yes-prod (extra confirmation required)"
fi

# ── Per-tier target names + source keys ──────────────────────────────────────
case "$TIER" in
  dev)
    FLY_APP="patchtogether-server-dev"
    CF_PROJECT="patchtogether-live-dev"
    INVITE_KEY="INVITE_SECRET_DEV"
    FLY_PG_KEY="FLY_PG_DEV_URL"
    NEON_KEY="NEON_DEV_URL"
    ;;
  autotest)
    FLY_APP="patchtogether-server-autotest"
    CF_PROJECT="patchtogether-live-autotest"
    INVITE_KEY="INVITE_SECRET_AUTOTEST"
    FLY_PG_KEY="FLY_PG_AUTOTEST_URL"
    NEON_KEY="NEON_AUTOTEST_URL"
    ;;
  prod)
    FLY_APP="patchtogether-server"
    CF_PROJECT="patchtogether-live"
    INVITE_KEY="INVITE_SECRET_PROD"
    FLY_PG_KEY="FLY_PG_PROD_URL"
    NEON_KEY="NEON_PROD_URL"
    ;;
esac

# Clerk: cf.env has CLERK_SECRET_KEY (test instance) + CLERK_SECRET_KEY_LIVE
# (live instance). prod uses the live key; dev/autotest use the test key.
if [[ "$TIER" == "prod" ]]; then
  CLERK_KEY="CLERK_SECRET_KEY_LIVE"
else
  CLERK_KEY="CLERK_SECRET_KEY"
fi

# ── Load source-of-truth env ─────────────────────────────────────────────────
[[ -f "$ENV_FILE" ]] || die "env file not found: $ENV_FILE (set PATCHTOGETHER_ENV_FILE to override)"

# Read a single KEY=value line from the env file without echoing the value or
# evaluating it as shell. Trailing comments after a value are unusual here, so
# we take the whole RHS verbatim.
read_env() {
  local key="$1"
  local line
  line=$(grep -E "^${key}=" "$ENV_FILE" | head -n1 || true)
  [[ -n "$line" ]] || return 1
  printf '%s' "${line#*=}"
}

# Redacted fingerprint so the operator can eyeball "did the value change?"
# without it ever hitting the terminal/logs in cleartext.
fingerprint() {
  local v="$1"
  local len="${#v}"
  local sha
  sha=$(printf '%s' "$v" | shasum -a 256 | cut -c1-8)
  printf 'len=%s sha256:%s…' "$len" "$sha"
}

# ── Resolve values ───────────────────────────────────────────────────────────
INVITE_SECRET_VAL="$(read_env "$INVITE_KEY")" || die "missing $INVITE_KEY in $ENV_FILE"
CLERK_SECRET_VAL="$(read_env "$CLERK_KEY")"    || die "missing $CLERK_KEY in $ENV_FILE"
FLY_PG_VAL="$(read_env "$FLY_PG_KEY")"         || die "missing $FLY_PG_KEY in $ENV_FILE"
NEON_VAL="$(read_env "$NEON_KEY")"             || die "missing $NEON_KEY in $ENV_FILE"

[[ "${#INVITE_SECRET_VAL}" -ge 32 ]] || die "$INVITE_KEY is < 32 chars; the relay/web both reject short secrets in prod"

# ── Plan ─────────────────────────────────────────────────────────────────────
MODE="DRY-RUN (no changes; pass --apply to push)"
[[ "$APPLY" == "1" ]] && MODE="APPLY (will mutate live secrets)"

echo "sync-secrets — tier=$TIER  mode=$MODE"
echo "  source : $ENV_FILE"
echo "  relay  : Fly app   $FLY_APP"
echo "  web    : CF Pages  $CF_PROJECT"
echo

echo "RELAY ($FLY_APP) secrets:"
note "INVITE_SECRET    <- $INVITE_KEY   ($(fingerprint "$INVITE_SECRET_VAL"))   [LOCKSTEP]"
note "CLERK_SECRET_KEY <- $CLERK_KEY    ($(fingerprint "$CLERK_SECRET_VAL"))"
note "DATABASE_URL     <- $FLY_PG_KEY   ($(fingerprint "$FLY_PG_VAL"))"
echo
echo "WEB ($CF_PROJECT) secrets:"
note "INVITE_SECRET    <- $INVITE_KEY   ($(fingerprint "$INVITE_SECRET_VAL"))   [LOCKSTEP]"
note "CLERK_SECRET_KEY <- $CLERK_KEY    ($(fingerprint "$CLERK_SECRET_VAL"))"
note "DATABASE_URL     <- $NEON_KEY     ($(fingerprint "$NEON_VAL"))"
echo

# Sanity: confirm the SAME invite secret feeds both sides (the whole point).
echo "LOCKSTEP CHECK: relay.INVITE_SECRET and web.INVITE_SECRET both <- $INVITE_KEY  ($(fingerprint "$INVITE_SECRET_VAL"))"
echo

if [[ "$APPLY" != "1" ]]; then
  echo "Dry-run complete. Re-run with --apply (and --yes-prod for prod) to push."
  exit 0
fi

# ── Apply ────────────────────────────────────────────────────────────────────
command -v flyctl  >/dev/null 2>&1 || die "flyctl not found on PATH"
command -v wrangler >/dev/null 2>&1 || die "wrangler not found on PATH"

echo ">> Pushing RELAY secrets to Fly app $FLY_APP"
# `flyctl secrets set` accepts multiple KEY=VALUE pairs and applies them in one
# atomic release (one restart), which is what we want for lockstep. Values are
# passed via argv; that's how flyctl's API works — they don't appear in this
# script's stdout.
flyctl secrets set \
  "INVITE_SECRET=$INVITE_SECRET_VAL" \
  "CLERK_SECRET_KEY=$CLERK_SECRET_VAL" \
  "DATABASE_URL=$FLY_PG_VAL" \
  --app "$FLY_APP"

echo ">> Pushing WEB secrets to CF Pages project $CF_PROJECT"
# wrangler pages secret put reads the value from stdin (so it's not in argv).
# Apply to BOTH production and preview environments so PR previews + the named
# branch deploy agree. --project-name selects the Pages project.
put_cf_secret() {
  local name="$1" value="$2"
  for cfenv in production preview; do
    printf '%s' "$value" | wrangler pages secret put "$name" \
      --project-name "$CF_PROJECT" --env "$cfenv"
  done
}
put_cf_secret INVITE_SECRET    "$INVITE_SECRET_VAL"
put_cf_secret CLERK_SECRET_KEY "$CLERK_SECRET_VAL"
put_cf_secret DATABASE_URL     "$NEON_VAL"

echo
echo "Done. Both targets now share INVITE_SECRET ($(fingerprint "$INVITE_SECRET_VAL"))."
echo "Verify end-to-end with the anon-handshake smoke:"
echo "  flox activate -- node scripts/anon-handshake-smoke.mjs $TIER"
