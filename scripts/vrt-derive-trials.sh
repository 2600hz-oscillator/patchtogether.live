#!/usr/bin/env bash
# scripts/vrt-derive-trials.sh — run the REAL VRT gate N times in N SEPARATE
# PLAYWRIGHT PROCESSES and report the per-scene pass/fail tally.
#
# ─────────────────────────────────────────────────────────────────────────
# WHY THIS EXISTS: `--repeat-each=N` IS NOT N TRIALS.
#
# Every mask in e2e/vrt/vrt-live-surfaces.ts used to be justified by a number
# of the form "n/10", produced by
#
#     npx playwright test --config=vrt/vrt.config.ts --repeat-each=10 --grep X
#
# That is ONE playwright process, ONE browser launch, ten tests. For any card
# whose non-determinism is LATCHED PER BROWSER LAUNCH rather than per test, it
# measures a single draw of the lottery ten times and prints "10/10" — a
# confident, plausible, false 100 %.
#
# MEASURED on timelorde, darwin, 2026-08-01, same card, same unmasked baseline:
#
#     --repeat-each=10, x4 invocations   40/40 PASS   (4 real trials, all lucky)
#     20 SEPARATE PROCESSES              13/20 PASS   (a 35 % failure rate)
#     16 separate processes, MASKED      16/16 PASS   (the control: the card,
#                                                      not the environment)
#
# The 40/40 is reproducible and it is wrong — it was used to argue the mask
# was unjustified. The instrument was invariant to exactly the dimension under
# test (process-to-process variation), which is CLAUDE.md's "VALIDATE THE
# INSTRUMENT" failure in its purest form.
#
# So: a mask derivation quotes THIS script's number, not --repeat-each's.
# --repeat-each remains fine for a card whose state is per-test (most of them);
# it is simply not something you can know in advance, which is why the
# derivation uses the instrument that is correct in BOTH cases.
#
#   scripts/vrt-derive-trials.sh <grep-pattern> [N=10]
#
#   VRT_UNMASKED=1 scripts/vrt-derive-trials.sh timelorde 20   # derivation mode
#   E2E_PORT=5591  scripts/vrt-derive-trials.sh 'scope' 10     # non-default port
set -uo pipefail

PATTERN="${1:?usage: vrt-derive-trials.sh <grep-pattern> [N]}"
N="${2:-10}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# E2E_PORT wins; else the per-worktree derived default (#1597) — same
# derivation as every other entry point (scripts/e2e-port.sh).
PORT="$(bash "$HERE/scripts/e2e-port.sh")"
OUT="$(mktemp -d)"

echo "vrt-derive-trials: pattern='$PATTERN'  trials=$N  port=$PORT  VRT_UNMASKED=${VRT_UNMASKED:-0}"
echo "  (N SEPARATE processes — see the header for why --repeat-each cannot answer this)"

green=0
red=0
for i in $(seq 1 "$N"); do
  if (cd "$HERE/e2e" && E2E_BASE_URL="http://localhost:$PORT" \
      npx playwright test --config=vrt/vrt.config.ts --grep "$PATTERN" \
      --reporter=line > "$OUT/run-$i.txt" 2>&1); then
    green=$((green + 1))
    printf '.'
  else
    red=$((red + 1))
    printf 'X'
  fi
done
printf '\n'

echo "PROCESS TALLY: $green/$N processes fully green, $red red"
echo
echo "PER-SCENE FAILURES (scene → how many of the $N processes it failed in):"
# The line reporter opens each failure with a numbered `  1) [project] › …`
# block. Anchoring on that (rather than on any line containing `›`) keeps the
# overwritten in-progress lines out of the tally.
grep -hE '^[[:space:]]*[0-9]+\) \[' "$OUT"/*.txt 2>/dev/null \
  | sed 's/\x1b\[[0-9;]*m//g' \
  | grep -oE '› [^›]+$' \
  | sed 's/^› //; s/[[:space:]]*$//' \
  | sort | uniq -c | sort -rn | head -40
echo
echo "DIFF SIZES seen (px / ratio):"
grep -h 'pixels (ratio' "$OUT"/*.txt 2>/dev/null \
  | sed 's/\x1b\[[0-9;]*m//g; s/^[[:space:]-]*//' \
  | sort | uniq -c | sort -rn | head -20
echo
echo "raw logs: $OUT"
