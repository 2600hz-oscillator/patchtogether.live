#!/usr/bin/env bash
# scripts/e2e-shard-budget.sh — A SHARD'S HEADROOM IS INVISIBLE UNTIL IT IS GONE.
#
# `--global-timeout` is a cliff, not a gauge. A shard at 99 % of budget and a
# shard at 40 % produce byte-identical CI output — both say "success" — so the
# only signal that a lane is out of room is the day it runs out, and by then it
# is main that is red.
#
# 2026-08-11: e2e shard 3 finished at 892 s against a 900 s `--global-timeout`.
# EIGHT SECONDS of slack. #1470 consumed the headroom and #1454 landed on top;
# two individually-green PRs collided on a budget NEITHER COULD SEE, and the
# revert (#1476) had to establish it was contention rather than a wavesculpt
# defect before anyone could act.
#
# This wrapper times the Playwright invocation it is given, prints the result
# as a PERCENTAGE OF BUDGET on every run — so the number is in the log whether
# or not it is near the line — and fails the job before the cliff.
#
# ── THE BUDGET IS PARSED FROM THE COMMAND, NEVER RE-TYPED ───────────────────
# The threshold is derived from the SAME `--global-timeout` the run actually
# uses, read out of argv. A second copy of "900000" here would be a number that
# has to track another number by discipline — this repo's most-repeated bug
# class, and precisely what `scripts/ci-playwright-timeout.test.ts` exists to
# stop. There is exactly ONE budget literal, and it lives in ci.yml next to the
# `timeout-minutes` it must stay under.
#
# ⚠ If no `--global-timeout` is present the wrapper REFUSES rather than
# defaulting. A guard that silently invents its own budget when the real one is
# removed is a guard that stops guarding at the exact moment it matters.
#
# ── WHAT THIS CANNOT SEE (stated, per the blind-gates rule) ─────────────────
#  · It measures the PLAYWRIGHT STEP, not the job. The job also pays checkout +
#    flox + artifact upload — measured 2026-08-12 at ~150-170 s on top of the
#    step — and that overhead runs against `timeout-minutes`, a DIFFERENT
#    ceiling this wrapper does not read.
#  · It measures ONE run. Shard timings move with runner luck; a single sample
#    near the line is a warning, not a proof.
#  · It cannot tell WHY a shard grew. A slow row and a hundred slightly-slower
#    rows look the same from here.
#
# Usage:  e2e-shard-budget.sh -- <command with --global-timeout ...>

set -uo pipefail

# Fraction of the budget at which the run FAILS. Not a population count — a
# policy threshold, deliberately one number in one place. At 0.85 of a 900 s
# budget a shard must finish inside 765 s.
FAIL_FRACTION="${E2E_SHARD_BUDGET_FAIL_FRACTION:-0.85}"
# A softer line that only annotates, so a lane trending upward is visible in
# the log for a few cycles before it becomes a failure.
WARN_FRACTION="${E2E_SHARD_BUDGET_WARN_FRACTION:-0.70}"

if [ "${1:-}" != "--" ]; then
  echo "usage: $0 -- <command…>" >&2
  exit 2
fi
shift

if [ "$#" -eq 0 ]; then
  echo "[shard-budget] no command given" >&2
  exit 2
fi

# Derive the budget from the command we are about to run.
BUDGET_MS=""
prev=""
for arg in "$@"; do
  case "$arg" in
    --global-timeout=*) BUDGET_MS="${arg#--global-timeout=}" ;;
  esac
  if [ "$prev" = "--global-timeout" ]; then BUDGET_MS="$arg"; fi
  prev="$arg"
done

case "$BUDGET_MS" in
  '' | *[!0-9]*)
    echo "────────────────────────────────────────────────────────────" >&2
    echo "[shard-budget] REFUSING: no numeric --global-timeout in the wrapped command." >&2
    echo "[shard-budget] This wrapper derives its threshold from that flag so the two" >&2
    echo "[shard-budget] can never drift. Without it there is no budget to measure" >&2
    echo "[shard-budget] against, and guessing one would be worse than not guarding." >&2
    echo "────────────────────────────────────────────────────────────" >&2
    exit 2
    ;;
esac

START="$(date +%s)"
"$@"
CHILD_EXIT="$?"
END="$(date +%s)"

ELAPSED=$((END - START))
BUDGET_S=$((BUDGET_MS / 1000))
# Integer percent — avoids depending on bc/python being present on the runner.
# ⚠ Computed against the MILLISECOND budget, not BUDGET_S. Dividing the budget
# down to whole seconds first truncates it, and the truncation is not a rounding
# nicety: a 1250 ms budget became 1 s, so an 80 % run read as 100 % and failed.
# Real budgets are whole seconds and would never have shown it — the sub-second
# case in the test suite is what exposed it.
PCT=$((ELAPSED * 100000 / BUDGET_MS))
FAIL_PCT="$(awk -v f="$FAIL_FRACTION" 'BEGIN { printf "%d", f * 100 }')"
WARN_PCT="$(awk -v f="$WARN_FRACTION" 'BEGIN { printf "%d", f * 100 }')"
LABEL="${E2E_SHARD_BUDGET_LABEL:-playwright}"

echo "[shard-budget] ${LABEL}: ${ELAPSED}s of ${BUDGET_S}s budget (${PCT}%) — fail at ${FAIL_PCT}%, warn at ${WARN_PCT}%"

# ⚠ A REAL TEST FAILURE IS NEVER RELABELLED AS A BUDGET FAILURE. If the child
# failed, propagate ITS exit code: the diagnosis for "a test broke" and "this
# lane is out of room" are completely different, and a budget error printed
# over a genuine failure would send the next reader down the wrong path.
if [ "$CHILD_EXIT" -ne 0 ]; then
  echo "[shard-budget] wrapped command exited ${CHILD_EXIT}; reporting that, not the budget."
  exit "$CHILD_EXIT"
fi

if [ "$PCT" -ge "$FAIL_PCT" ]; then
  echo "::error title=e2e shard out of headroom::${LABEL} used ${ELAPSED}s of its ${BUDGET_S}s budget (${PCT}%), at or over the ${FAIL_PCT}% line."
  echo "────────────────────────────────────────────────────────────" >&2
  echo "[shard-budget] FAILING: ${ELAPSED}s / ${BUDGET_S}s = ${PCT}% (limit ${FAIL_PCT}%)." >&2
  echo "" >&2
  echo "  Every test here PASSED. What failed is the HEADROOM: at ${PCT}% this" >&2
  echo "  lane is close enough to its --global-timeout that an ordinary PR can" >&2
  echo "  push it over, and a shard that hits the timeout is killed mid-run." >&2
  echo "" >&2
  echo "  → move work off this shard, or make its slowest rows cheaper" >&2
  echo "  → or raise --global-timeout in ci.yml (it must stay under" >&2
  echo "    timeout-minutes with room for checkout + upload — enforced by" >&2
  echo "    scripts/ci-playwright-timeout.test.ts)" >&2
  echo "────────────────────────────────────────────────────────────" >&2
  exit 1
fi

if [ "$PCT" -ge "$WARN_PCT" ]; then
  echo "::warning title=e2e shard headroom shrinking::${LABEL} used ${ELAPSED}s of its ${BUDGET_S}s budget (${PCT}%); the lane fails at ${FAIL_PCT}%."
fi

exit 0
