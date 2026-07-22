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

# `task vrt:update` runs build prereqs (dsp:build, test:emit-manifest) and the
# Playwright capture, which can leave OTHER tracked files modified in the working
# tree (regenerated annotations/build inputs). The baseline bot commits SCREENSHOTS
# ONLY (staged above), so any remaining unstaged change is incidental — but it makes
# the rebase below abort with "cannot rebase: You have unstaged changes". Log what it
# is (so we can see if something ought to be committed too) and discard it to give
# the rebase a clean tree.
if ! git diff --quiet; then
  echo "::group::vrt-baseline-bot: discarding incidental unstaged changes (not baselines)"
  git status --short
  echo "::endgroup::"
  git checkout -- .
fi

# The other platform job may have pushed in the meantime; replay our commit on
# top of the latest remote branch state (disjoint files → clean rebase).
git fetch origin "${REF}"
git rebase "origin/${REF}"

git push origin "HEAD:${REF}"
echo "Pushed ${PLATFORM} VRT baselines to ${REF}."
