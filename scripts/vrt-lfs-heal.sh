#!/usr/bin/env bash
# Verify every checked-out VRT baseline DECODES, and re-fetch the ones that
# don't — straight from the LFS server, bypassing whatever local store lied.
#
#   vrt-lfs-heal.sh
#
# Why this exists (2026-08-28, the corrupt-PNG saga's last act): LFS STORAGE is
# provably clean — every baseline decodes after a direct `git lfs pull` on a
# dev machine — yet CI runners keep MATERIALIZING corrupt PNGs at checkout:
#   * strict shards restore .git/lfs from an actions/cache and `git lfs pull`
#     trusts any object already present in the store — a cache entry saved by
#     a timeout-killed job serves truncated objects forever after, and the
#     pull smudges them into the worktree without a checksum look;
#   * capture shards saw corrupt EXPECTED files under plain `lfs: true`
#     checkouts too (run 33213636041 shard 1: "unrecognised content at end of
#     stream" on files whose LFS objects verify clean).
# Rather than keep chasing which layer lies, every consumer VERIFIES what it
# checked out and HEALS in place. Decode cost for the full set is seconds.
#
# Uses scripts/vrt-png-verify.mjs (the collector's decoder — signature, chunk
# walk, full IDAT inflate). Healed files are named with their sha256 so a
# recurrence is attributable. Exits non-zero only if a file stays corrupt
# after a direct re-fetch — at that point the lie is upstream and the job
# must not run against it.
set -euo pipefail

SHOTS="e2e/vrt/__screenshots__"

corrupt_list() {
  find "$SHOTS" -name '*.png' | node scripts/vrt-png-verify.mjs
}

CORRUPT="$(corrupt_list)"
if [ -z "$CORRUPT" ]; then
  echo "vrt-lfs-heal: all baselines decode clean."
  exit 0
fi

echo "::warning::vrt-lfs-heal: $(printf '%s\n' "$CORRUPT" | wc -l | tr -d ' ') corrupt baseline(s) materialized at checkout — healing via direct LFS re-fetch."
INCLUDES=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  echo "  corrupt: $f (sha256 $(shasum -a 256 "$f" 2>/dev/null | cut -d' ' -f1 || sha256sum "$f" | cut -d' ' -f1))"
  # Drop the poisoned object from the local store so the pull cannot trust it.
  OID="$(git lfs ls-files --long -I "$f" | awk '{print $1}' | head -1)"
  if [ -n "$OID" ]; then
    rm -f ".git/lfs/objects/${OID:0:2}/${OID:2:2}/${OID}"
  fi
  rm -f "$f"
  INCLUDES="${INCLUDES:+$INCLUDES,}$f"
done <<<"$CORRUPT"

# Restore pointers, then fetch the real objects from the server (sha-verified
# by git-lfs on a genuine download).
git checkout -- "$SHOTS"
git lfs pull --include "$INCLUDES"

STILL="$(corrupt_list)"
if [ -n "$STILL" ]; then
  echo "::error::vrt-lfs-heal: still corrupt after a direct re-fetch — the server-side object itself is bad. Refusing to run against it."
  printf '%s\n' "$STILL"
  exit 1
fi
echo "vrt-lfs-heal: healed all $(printf '%s\n' "$CORRUPT" | wc -l | tr -d ' ') file(s)."
