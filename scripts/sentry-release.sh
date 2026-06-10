#!/usr/bin/env bash
# scripts/sentry-release.sh
#
# Upload the web bundle's (hidden) source maps to Sentry and cut a release, so
# browser/Worker stack traces in Sentry are de-minified. Called by the web
# deploy jobs in .github/workflows/deploy.yml AFTER `task build`, BEFORE the
# wrangler `pages deploy`.
#
# GATED, exactly like the FLY_API_TOKEN relay-deploy pattern: if
# SENTRY_AUTH_TOKEN is unset this is a clean no-op (prints a ::warning:: and
# exits 0), so the pipeline stays green before Sentry is provisioned. Because
# the build only emits maps when VITE_SENTRY_SOURCEMAPS=1 (set alongside this in
# deploy.yml), there's nothing to upload until the token is wired anyway.
#
# Required when active:
#   SENTRY_AUTH_TOKEN  — GH secret; org-scoped token with project:releases +
#                        org:read (and project:read) scopes.
#   SENTRY_ORG         — Sentry org slug (defaults below; override via env).
#   SENTRY_PROJECT     — Sentry project slug (defaults below; override via env).
#   SENTRY_RELEASE     — release name; pass the same value baked as
#                        VITE_APP_VERSION so client events group by release.
#
# Public-safety: 'hidden' source maps carry NO `//# sourceMappingURL` comment,
# and we DELETE every *.map before this returns, so the deployed CF Pages bundle
# never serves source maps to the public — they live only inside Sentry.

set -euo pipefail

BUILD_DIR="${SENTRY_BUILD_DIR:-packages/web/.svelte-kit/cloudflare}"
SENTRY_ORG="${SENTRY_ORG:-patchtogether}"
SENTRY_PROJECT="${SENTRY_PROJECT:-patchtogether-web}"
RELEASE="${SENTRY_RELEASE:-}"

if [ -z "${SENTRY_AUTH_TOKEN:-}" ]; then
  echo "::warning::SENTRY_AUTH_TOKEN not set — skipping Sentry source-map upload + release. Wire the secret (Sentry → org token with project:releases) to enable de-minified stack traces. The deploy itself is unaffected."
  exit 0
fi

if [ -z "$RELEASE" ]; then
  echo "::warning::SENTRY_RELEASE empty — skipping Sentry release (expected the build's VITE_APP_VERSION). Deploy unaffected."
  exit 0
fi

if [ ! -d "$BUILD_DIR" ]; then
  echo "::error::Sentry release: build dir '$BUILD_DIR' not found — did 'task build' run first?"
  exit 1
fi

export SENTRY_AUTH_TOKEN SENTRY_ORG SENTRY_PROJECT

echo "Sentry release: $RELEASE (org=$SENTRY_ORG project=$SENTRY_PROJECT)"

# Pinned sentry-cli via npx (no global install). Each call is gated already.
SENTRY_CLI="npx --yes @sentry/cli@2"

$SENTRY_CLI releases new "$RELEASE"
$SENTRY_CLI releases set-commits "$RELEASE" --auto --ignore-missing
# Upload the hidden maps (sentry-cli pairs each .map with its emitted .js).
$SENTRY_CLI sourcemaps upload --release "$RELEASE" "$BUILD_DIR"
$SENTRY_CLI releases finalize "$RELEASE"

# Strip every source map from the bundle BEFORE it ships, so the public deploy
# never serves them. (hidden maps already carry no sourceMappingURL comment;
# this removes the files outright.)
MAP_COUNT=$(find "$BUILD_DIR" -name '*.map' | wc -l | tr -d ' ')
find "$BUILD_DIR" -name '*.map' -delete
echo "Sentry release done; deleted $MAP_COUNT source map(s) from $BUILD_DIR before deploy."
