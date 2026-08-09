#!/usr/bin/env bash
# Emit one line per state change for PR #1421's required checks, then exit.
# Covers success AND every failure bucket, so a crash is never silent.
prev=""
for _ in $(seq 1 90); do
  cur=$(gh pr checks 1421 --json name,state 2>/dev/null \
    | jq -r '[.[] | select(.state != "SKIPPED")] | map("\(.name)=\(.state)") | sort | join(" ")' 2>/dev/null)
  if [ -z "$cur" ]; then cur="no-checks-yet"; fi
  if [ "$cur" != "$prev" ]; then
    echo "CI#1421 :: $(echo "$cur" | tr ' ' '\n' | grep -E "FAILURE|ERROR|CANCELLED|TIMED_OUT" | tr '\n' ' ')"
    pend=$(echo "$cur" | tr ' ' '\n' | grep -cE "PENDING|IN_PROGRESS|QUEUED")
    echo "CI#1421 pending=$pend  $(echo "$cur" | tr ' ' '\n' | grep -cE "SUCCESS") green"
    prev="$cur"
  fi
  if ! echo "$cur" | tr ' ' '\n' | grep -qE "PENDING|IN_PROGRESS|QUEUED|no-checks-yet"; then
    echo "CI#1421 FINAL: $cur"
    exit 0
  fi
  sleep 60
done
echo "CI#1421: TIMED OUT waiting"
