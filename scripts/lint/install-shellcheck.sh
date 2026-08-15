#!/usr/bin/env bash
#
# scripts/lint/install-shellcheck.sh — fetch the PINNED shellcheck binary.
#
# Same shape as the actionlint install in Taskfile.yml / ci.yml, deliberately:
# a pinned release download into node_modules/.cache, not a flox package. Two
# reasons. (1) Adding shellcheck to the flox manifest puts its closure on the
# critical path of EVERY flox-activating CI job, not just the lint lane. (2) The
# version is then identical on a laptop and on CI by construction — a linter
# whose version differs between the two produces findings one of them cannot
# reproduce, which is how a lint gate becomes something people route around.
#
# Prints the directory containing the binary on stdout, so a caller can put it
# on PATH (actionlint's --shellcheck integration needs to find it by name).
#
# Run through flox:  flox activate -- task lint:shell
set -euo pipefail

VER=0.11.0
CACHE="node_modules/.cache/shellcheck"
BIN="$CACHE/shellcheck"

if [ ! -x "$BIN" ] || ! "$BIN" --version 2>/dev/null | grep -q "version: $VER"; then
  mkdir -p "$CACHE"
  OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
  ARCH="$(uname -m)"
  case "$ARCH" in
    arm64) ARCH=aarch64 ;;
    amd64) ARCH=x86_64 ;;
  esac
  TARBALL="$(mktemp -t shellcheck.XXXXXX).tar.gz"
  # --retry-all-errors is load-bearing for the same reason it is on the
  # actionlint download (#1534): curl does NOT retry a 503 without it, because a
  # 503 is a well-formed HTTP response rather than a transport error. One
  # un-retried 503 from the releases CDN would redden a required job.
  curl -sSfL --retry 3 --retry-delay 2 --retry-all-errors --connect-timeout 10 \
    -o "$TARBALL" \
    "https://github.com/koalaman/shellcheck/releases/download/v${VER}/shellcheck-v${VER}.${OS}.${ARCH}.tar.gz"
  tar -xzf "$TARBALL" -C "$CACHE" --strip-components=1 "shellcheck-v${VER}/shellcheck"
  rm -f "$TARBALL"
fi

# Fail loudly rather than silently falling back to whatever shellcheck happens
# to be on PATH — a different version is a different gate.
"$BIN" --version | grep -q "version: $VER" || {
  echo "install-shellcheck: expected shellcheck $VER, got:" >&2
  "$BIN" --version >&2
  exit 1
}

printf '%s\n' "$PWD/$CACHE"
