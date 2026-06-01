#!/usr/bin/env bash
#
# scripts/worktree-guard.sh — enforce the repository's worktree cap.
#
# REPOSITORY STANDARD: never keep more than WORKTREE_CAP (default 10) git
# worktrees. Hundreds of abandoned `isolation: worktree` agent checkouts
# accumulate otherwise (dead lock + node_modules each) and bury the few that
# are actually in flight. Run this BEFORE creating a new worktree.
#
# MODES
#   report            (default) classify every worktree; change nothing.
#   clean             prune gone + remove ABANDONED worktrees (see below).
#   enforce [N]       clean, then exit 3 if still over the cap (N overrides
#                     WORKTREE_CAP) and print the worktrees needing a human.
#
# WHAT IS SAFE TO AUTO-REMOVE ("abandoned")
#   A worktree whose Claude-agent lock process is DEAD *and* which has no
#   uncommitted changes and no unpushed commits — nothing in it exists only on
#   disk, so removing it loses no work (the branch ref + any pushed commits
#   survive). Prunable (directory already gone) worktrees are removed too.
#
# WHAT IS LEFT FOR A HUMAN ("at-risk")
#   Dead-lock worktrees with dirty files, unpushed commits, or no upstream to
#   verify against — and any worktree with a LIVE agent. enforce() lists these
#   so you can work through them; it never deletes them.
#
# Run through flox:  flox activate -- task worktree:guard
set -uo pipefail

CAP="${WORKTREE_CAP:-10}"
MODE="${1:-report}"
if [ "$MODE" = "enforce" ] && [ -n "${2:-}" ]; then CAP="$2"; fi

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "not a git repo" >&2; exit 1; }
cd "$ROOT"
git fetch origin --quiet 2>/dev/null || true

# The PRIMARY (main) worktree is always the first entry in the porcelain list,
# regardless of which linked worktree we're invoked from. Never remove it.
PRIMARY="$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')"

SAFE=()    # path|why            — auto-removable (abandoned / gone)
ATRISK=()  # path|why            — dead but holds work; needs a human
LIVE=()    # path|why            — a running agent; leave alone
IDLE=()    # path|why            — unlocked (manual / primary excluded); counts but not auto-removed

path=""; head=""; branch=""; locked=0; lockreason=""; prunable=0; bare=0
flush() {
  [ -z "$path" ] && return
  if [ "$bare" = "1" ] || [ "$path" = "$PRIMARY" ]; then _reset; return; fi
  local pid alive dirty unpushed label
  label="${branch:-detached}"
  if [ "$prunable" = "1" ]; then SAFE+=("$path|gone: $label"); _reset; return; fi
  # Extract the lock's pid specifically (the agent-id hash also contains
  # digits, so match the `pid N` token, not the first number we see). pid<=1
  # is never a real agent (kill -0 0 would falsely succeed on the group).
  pid="$(printf '%s' "$lockreason" | grep -oE 'pid [0-9]+' | grep -oE '[0-9]+' | head -1)"
  alive=0
  if [ "$locked" = "1" ] && [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null && kill -0 "$pid" 2>/dev/null; then alive=1; fi
  dirty="$(git -C "$path" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  unpushed="$(git -C "$path" rev-list --count '@{upstream}..HEAD' 2>/dev/null)"
  [ -z "$unpushed" ] && unpushed="noup"
  if [ "$alive" = "1" ]; then
    LIVE+=("$path|live agent pid $pid: $label")
  elif [ "$locked" = "1" ] && [ "$dirty" = "0" ] && [ "$unpushed" = "0" ]; then
    SAFE+=("$path|abandoned (clean, pushed): $label")
  elif [ "$locked" = "1" ]; then
    ATRISK+=("$path|dead lock, dirty=$dirty unpushed=$unpushed: $label")
  else
    IDLE+=("$path|unlocked, dirty=$dirty unpushed=$unpushed: $label")
  fi
  _reset
}
_reset() { path=""; head=""; branch=""; locked=0; lockreason=""; prunable=0; bare=0; }

while IFS= read -r line; do
  case "$line" in
    "worktree "*) flush; path="${line#worktree }" ;;
    "HEAD "*)     head="${line#HEAD }" ;;
    "branch "*)   branch="${line#branch refs/heads/}" ;;
    "detached")   branch="detached" ;;
    "bare")       bare=1 ;;
    "locked"*)    locked=1; lockreason="${line#locked}" ;;
    "prunable"*)  prunable=1 ;;
  esac
done < <(git worktree list --porcelain)
flush

count() { git worktree list | tail -n +2 | wc -l | tr -d ' '; } # exclude primary (first line)

remove_safe() {
  git worktree prune -v 2>/dev/null || true
  # Guard the iteration: macOS bash 3.2 treats "${arr[@]}" on an empty array as
  # an unbound-variable error under `set -u`.
  [ "${#SAFE[@]}" -gt 0 ] || return 0
  local e p
  for e in "${SAFE[@]}"; do
    p="${e%%|*}"
    git worktree unlock "$p" 2>/dev/null || true
    git worktree remove --force "$p" 2>/dev/null || true
  done
}

print_manual() {
  local e
  if [ "${#ATRISK[@]}" -gt 0 ]; then
    echo "  needs a human (dead lock, but holds uncommitted/unpushed work):"
    for e in "${ATRISK[@]}"; do echo "    - ${e#*|}"; done
  fi
  if [ "${#IDLE[@]}" -gt 0 ]; then
    echo "  unlocked (manual checkouts — remove yourself if done):"
    for e in "${IDLE[@]}"; do echo "    - ${e#*|}"; done
  fi
  if [ "${#LIVE[@]}" -gt 0 ]; then
    echo "  live agents (in flight — leave alone):"
    for e in "${LIVE[@]}"; do echo "    - ${e#*|}"; done
  fi
}

echo "worktrees: $(count) non-primary (cap $CAP)"
echo "  auto-removable: ${#SAFE[@]} | at-risk: ${#ATRISK[@]} | idle/manual: ${#IDLE[@]} | live: ${#LIVE[@]}"

case "$MODE" in
  report)
    print_manual
    ;;
  clean)
    remove_safe
    echo "cleaned. now $(count) non-primary worktrees."
    ;;
  enforce)
    remove_safe
    n="$(count)"
    echo "after clean: $n non-primary worktrees (cap $CAP)."
    if [ "$n" -gt "$CAP" ]; then
      echo ""
      echo "OVER CAP by $((n - CAP)). Auto-clean can't go further without risking work:"
      print_manual
      echo ""
      echo "Resolve the above (push/commit/discard, then 'git worktree remove'), or raise"
      echo "WORKTREE_CAP, before creating another worktree."
      exit 3
    fi
    echo "under cap — OK to create a new worktree."
    ;;
  *)
    echo "usage: worktree-guard.sh [report|clean|enforce [N]]" >&2
    exit 2
    ;;
esac
