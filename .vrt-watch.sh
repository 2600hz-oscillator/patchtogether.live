#!/usr/bin/env bash
# Emit one line per verify-run outcome, exit when all three land or one fails.
f=/private/tmp/claude-501/-Users-2600hz-Documents-workspace-inet-modular/863e2150-11b4-4136-b9a7-0a6467685ca2/tasks/bbxr0ilyx.output
seen=0
while true; do
  n=$(grep -cE "VERIFY RUN [0-9] EXIT" "$f" 2>/dev/null || echo 0)
  if [ "$n" -gt "$seen" ]; then
    grep -E "VERIFY RUN [0-9] EXIT|passed|failed|flaky" "$f" 2>/dev/null | tail -6
    seen=$n
  fi
  if grep -qE "ALL 3 VERIFY RUNS CLEAN|VERIFY RUN [0-9] FAILED" "$f" 2>/dev/null; then
    echo "WATCH: terminal state reached"
    break
  fi
  sleep 45
done
