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

# Report whether this job actually PUSHED a baseline commit. The `revalidate`
# job close+reopens the PR to re-fire a real `pull_request` run, which costs a
# full ~25 min CI cycle plus visible PR churn — so it must be able to tell
# "captured new baselines" from "ran and rewrote nothing". Both are `success`
# from the job's point of view (Playwright only rewrites a snapshot whose
# comparison FAILS, so a sub-tolerance or still-exempt scene legitimately
# commits zero files), and `pushed=false` says so explicitly rather than by
# absence. Harmless outside Actions, where GITHUB_OUTPUT is unset.
emit_pushed() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "pushed=$1" >>"$GITHUB_OUTPUT"
  fi
}

git config user.name "vrt-baseline-bot"
git config user.email "vrt-baseline-bot@users.noreply.github.com"

git add e2e/vrt/__screenshots__
if git diff --cached --quiet; then
  echo "No ${PLATFORM} VRT baseline changes — nothing to commit."
  echo "::warning::vrt-update captured ZERO ${PLATFORM} baselines. Playwright only rewrites a snapshot whose comparison FAILS, so a sub-tolerance diff or a still-exempt scene writes nothing — investigate rather than assuming there was nothing to do."
  emit_pushed false
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
# Set only AFTER a successful push (`set -e` aborts above on failure), so
# `pushed == 'true'` means the branch really moved.
emit_pushed true
echo "Pushed ${PLATFORM} VRT baselines to ${REF}."
