#!/usr/bin/env bash
# Commit + push regenerated VRT baselines for one platform back to a branch.
# Called by .github/workflows/vrt-update.yml after `task vrt:update`.
#
#   vrt-commit-baselines.sh <branch> <platform-label>
#
# The two platform jobs touch disjoint dirs (e2e/vrt/__screenshots__/**/linux/*
# vs **/darwin/*), so a rebase onto the latest remote state is always clean.
set -euo pipefail

REF="${1:?branch required}"
PLATFORM="${2:?platform label required}"

git config user.name "vrt-baseline-bot"
git config user.email "vrt-baseline-bot@users.noreply.github.com"

git add e2e/vrt/__screenshots__
if git diff --cached --quiet; then
  echo "No ${PLATFORM} VRT baseline changes — nothing to commit."
  exit 0
fi

git commit -m "chore(vrt): regenerate ${PLATFORM} baselines [vrt-update workflow]"

# The other platform job may have pushed in the meantime; replay our commit on
# top of the latest remote branch state (disjoint files → clean rebase).
git fetch origin "${REF}"
git rebase "origin/${REF}"

git push origin "HEAD:${REF}"
echo "Pushed ${PLATFORM} VRT baselines to ${REF}."
