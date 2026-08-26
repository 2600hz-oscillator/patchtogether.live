#!/usr/bin/env bash
# Commit + push regenerated VRT baselines back to a branch.
# Called by .github/workflows/vrt-update.yml after `task vrt:update`.
#
#   vrt-commit-baselines.sh <branch>
#
# There is ONE baseline set and ONE capture job (the {platform} dimension was
# removed 2026-08-10), so this used to take a second `<platform-label>` argument
# and there used to be a sibling job racing it. The rebase below is kept anyway:
# a human can push to the branch while a ~30 min capture is running.
set -euo pipefail

REF="${1:?branch required}"

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

# The SHA that was pushed. `revalidate` reports it, and names it in the deadlock
# notice it comments on a stuck PR (#1694) — so "which commit never got a CI
# run" is stated rather than reconstructed from timestamps.
emit_sha() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "sha=$1" >>"$GITHUB_OUTPUT"
  fi
}

# The run page's verdict. "0 baselines committed" and "the capture never ran"
# look identical from a green run, and that ambiguity cost #1809 a round trip —
# so the outcome is STATED on the summary, not left to be inferred from a log.
# Harmless outside Actions, where GITHUB_STEP_SUMMARY is unset.
summarize() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '%s\n' "$@" >>"$GITHUB_STEP_SUMMARY"
  fi
}

git config user.name "vrt-baseline-bot"
git config user.email "vrt-baseline-bot@users.noreply.github.com"

git add e2e/vrt/__screenshots__
if git diff --cached --quiet; then
  echo "No VRT baseline changes — nothing to commit."
  echo "::warning::vrt-update captured ZERO baselines. The capture runs --update-snapshots=all, which rewrites on a BYTE difference, so zero means every scene IN SCOPE is byte-identical — investigate the scope rather than assuming there was nothing to do."
  summarize \
    "" \
    "### ZERO baselines committed" \
    "" \
    "This run rendered its scope and rewrote **nothing**. That is NOT proof there was nothing to do." \
    "" \
    "The capture runs \`--update-snapshots=all\`, which does not consult the baseline for the decision" \
    "and rewrites whenever the BYTES differ, so zero means every scene **in scope** is byte-identical to" \
    "its committed baseline. A scope that missed the changed cards looks exactly the same from here." \
    "" \
    "(Before 2026-08-26 this ran \`=changed\`, where zero ALSO covered a stale-but-under-tolerance" \
    "baseline that could not be regenerated at all without a \`git rm\` first. That mode is gone; a" \
    "\`git rm\` is no longer part of the accept path.)" \
    "" \
    "**Count what you predicted against what landed before reading this as success.**"
  emit_pushed false
  exit 0
fi

# DERIVED from what is staged — never a predicted or hand-typed number.
BASELINE_COUNT="$(git diff --cached --name-only | wc -l | tr -d ' ')"

git commit -m "chore(vrt): regenerate baselines [vrt-update workflow]"

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

# Somebody may have pushed to the branch during the capture; replay our commit
# on top of the latest remote state.
git fetch origin "${REF}"
git rebase "origin/${REF}"

git push origin "HEAD:${REF}"
# Set only AFTER a successful push (`set -e` aborts above on failure), so
# `pushed == 'true'` means the branch really moved. The SHA is read AFTER the
# rebase, so it is the commit that actually landed on the branch.
emit_pushed true
emit_sha "$(git rev-parse HEAD)"
summarize \
  "" \
  "### Committed ${BASELINE_COUNT} baseline file(s)" \
  "" \
  "Pushed to \`${REF}\` as \`$(git rev-parse HEAD)\`. Count this against what you predicted —" \
  "a capture rewrites only what FAILED its comparison, so a short count is a finding, not a formality."
echo "Pushed VRT baselines to ${REF} as $(git rev-parse HEAD)."
