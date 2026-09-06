#!/usr/bin/env bash
# packages/web/scripts/prove-ssr-identical.sh
#
# THE NEGATIVE CONTROL for vite.config.ts's `ssrDropBrowserOnlyGraph()` plugin.
# (Its card-glob occupant retired with the card fleet; <Canvas> and /dev/** remain.)
#
# That plugin replaces the eager `*Card.svelte` glob with `{}` in the SSR build,
# on the claim that the SERVER never renders a card (the patch graph is a Yjs
# doc backed by IndexedDB + the relay, so a server render has zero nodes and
# hands SvelteFlow a `nodeTypes` map it never indexes). This script TESTS that
# claim rather than asserting it:
#
#   1. force `/rack` — the smallest route that mounts <Canvas> — to `ssr = true`
#      so the server renders Canvas on demand;
#   2. build + serve the real Cloudflare Worker twice, once with the plugin and
#      once with `PT_SSR_KEEP_CARDS=1`, and fetch `/rack` from each;
#   3. normalise per-build asset hashes and diff.
#
# An empty diff means the ~210 card components contribute NOTHING to server
# HTML. A non-empty diff means the server HAS started rendering cards, the
# plugin is no longer safe, and the fix is not to relax the normalisation.
#
# ⚠ WHY `wrangler pages dev` AND NOT THE PRERENDERER OR `vite preview`.
# `Canvas.js` cannot be loaded by Node at all: it does
# `import { FaustMonoAudioWorkletNode } from '@grame/faustwasm'`, and under
# Node's strict ESM resolution that package provides no such named export
# ("SyntaxError: does not provide an export named"). Any Node-hosted SSR of a
# Canvas route is therefore a 500. The deployed Worker is fine because wrangler
# esbuild-BUNDLES it, and esbuild's CJS interop resolves the same specifier. So
# the only place this comparison means anything is inside the bundled Worker —
# which is also exactly the artifact whose size we are cutting.
#
# That failure mode is also why the script asserts `data-testid="canvas-root"`
# is present in BOTH responses before diffing. Two identical error pages diff
# clean, and a vacuous pass here would be worse than no test.
#
# Run from the repo root:
#   flox activate -- bash packages/web/scripts/prove-ssr-identical.sh
set -euo pipefail

WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROUTE="$WEB/src/routes/rack/+page.ts"
PORT="${PROVE_PORT:-8791}"
OUT="${TMPDIR:-/tmp}/pt-ssr-proof"
rm -rf "$OUT"; mkdir -p "$OUT"

cp "$ROUTE" "$OUT/rack.+page.ts.orig"
cleanup() {
  cp "$OUT/rack.+page.ts.orig" "$ROUTE"
  [ -n "${WPID:-}" ] && kill "$WPID" 2>/dev/null || true
}
trap cleanup EXIT

# `/rack` is client-only in production (`ssr = false`). Flip ONLY that flag, so
# the Worker server-renders the exact same <Canvas ...> invocation that
# `/r/[id]` — the real SSR'd Canvas route — renders on every request.
sed 's/^export const ssr = false;$/export const ssr = true;/' \
  "$OUT/rack.+page.ts.orig" > "$ROUTE"
grep -q '^export const ssr = true;$' "$ROUTE" \
  || { echo "could not flip ssr in $ROUTE"; exit 1; }

# Three things legitimately differ between any two builds and are normalised:
# per-build asset hashes, the CSP nonce, and SvelteKit's `__sveltekit_<rand>`
# hydration namespace (a fresh random identifier per build — it was the ONLY
# difference the first time this ran, at 16302 vs 16303 bytes).
norm() {
  sed -E \
    -e 's#(/_app/immutable/[A-Za-z0-9_/.-]*/[A-Za-z0-9_-]+)\.[A-Za-z0-9_-]{8}\.(js|css)#\1.HASH.\2#g' \
    -e 's/nonce="[^"]*"/nonce="NONCE"/g' \
    -e 's/nonce-[A-Za-z0-9+\/=_-]+/nonce-NONCE/g' \
    -e 's/__sveltekit_[a-z0-9]+/__sveltekit_NS/g' \
    "$1"
}

capture() {  # $1 = label, $2 = PT_SSR_KEEP_CARDS value
  local label="$1" keep="$2"
  echo "=== build ($label, PT_SSR_KEEP_CARDS=$keep)"
  ( cd "$WEB" && PT_SSR_KEEP_CARDS="$keep" npx vite build >"$OUT/$label.build.log" 2>&1 ) \
    || { echo "BUILD FAILED"; tail -40 "$OUT/$label.build.log"; exit 1; }

  echo "=== serve  ($label) — wrangler pages dev :$PORT"
  ( cd "$WEB" && npx wrangler pages dev .svelte-kit/cloudflare \
      --port "$PORT" --ip 127.0.0.1 >"$OUT/$label.serve.log" 2>&1 ) &
  WPID=$!
  for _ in $(seq 1 60); do
    sleep 1
    curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  done
  curl -fsS "http://127.0.0.1:$PORT/rack" -o "$OUT/$label.html" || {
    echo "fetch /rack failed"; tail -30 "$OUT/$label.serve.log"; exit 1; }
  kill "$WPID" 2>/dev/null || true; wait "$WPID" 2>/dev/null || true; WPID=

  grep -q 'data-testid="canvas-root"' "$OUT/$label.html" || {
    echo "PROBE INVALID ($label): /rack did not server-render Canvas."
    echo "Two error pages would diff clean; refusing a vacuous pass."
    head -40 "$OUT/$label.html"; exit 1; }

  norm "$OUT/$label.html" > "$OUT/$label.norm.html"
  echo "    $(wc -c <"$OUT/$label.html") bytes, canvas-root present"
}

capture with-plugin 0
capture negative-control 1

echo
if diff -u "$OUT/negative-control.norm.html" "$OUT/with-plugin.norm.html" > "$OUT/ssr.diff"; then
  echo "PASS — Canvas's SERVER HTML is byte-identical with and without the ~210 card components."
  echo "       $(wc -c <"$OUT/with-plugin.norm.html") normalised bytes, 0 differing lines."
else
  echo "FAIL — server HTML differs. The server IS rendering cards; see $OUT/ssr.diff"
  head -60 "$OUT/ssr.diff"
  exit 1
fi
