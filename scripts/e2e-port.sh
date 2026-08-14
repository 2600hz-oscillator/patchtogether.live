#!/usr/bin/env bash
# scripts/e2e-port.sh — THE single derivation of this worktree's default e2e
# app port. Prints exactly one port number and nothing else.
#
# #1597: `task e2e:serve` used to default to the SHARED port 5173, so several
# agent worktrees all parked their long-lived dev servers on one port and every
# `reuseExistingServer` / warm-server consumer silently adopted whichever
# worktree got there first — including the attest paths, which then tested a
# SIBLING TREE'S code while hashing this one's. Deriving the default from the
# worktree's own path removes the collision at the source: two checkouts get
# two ports without anyone remembering to pass E2E_PORT.
#
# Contract (every consumer MUST resolve its default through this script — a
# knob only half the entry points honour is not isolation):
#   * An explicit E2E_PORT ALWAYS wins, verbatim.
#   * Otherwise: dev     → 5600 + (cksum(physical repo root) % 400)  [5600-5999]
#                preview → 4400 + (cksum(physical repo root) % 400)  [4400-4799]
#     - deterministic per checkout (same tree → same port, every invocation)
#     - never the old shared defaults (5173 / 4173), never Postgres (5432),
#       never the relay (1235)
#   * Mode: `preview` as $1, or E2E_PREVIEW=1 in the env; anything else = dev.
#
# The PHYSICAL path (`pwd -P`) is hashed so a symlinked checkout derives the
# same port as the tree the OS reports for it (matches dev-server.sh's
# ownership comparison). `cksum` is POSIX and dependency-free.
#
# TS consumers (e2e/worktree-port.ts) shell out to THIS script rather than
# re-implementing the hash — one derivation, zero drift.
set -euo pipefail

if [ -n "${E2E_PORT:-}" ]; then
  echo "$E2E_PORT"
  exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SUM="$(printf %s "$ROOT" | cksum | cut -d' ' -f1)"

MODE="dev"
if [ "${1:-}" = "preview" ] || [ "${E2E_PREVIEW:-0}" = "1" ]; then
  MODE="preview"
fi

if [ "$MODE" = "preview" ]; then
  echo $((4400 + SUM % 400))
else
  echo $((5600 + SUM % 400))
fi
