#!/usr/bin/env bash
# PROVE A SHARDED RUN CAN GO BOTH WAYS.
#
#   POSITIVE control — a shard whose baselines MATCH is green, and the coverage
#                      check confirms it ran exactly its planned scenes.
#   NEGATIVE control — perturb ONE baseline in that shard: it goes RED, and
#                      names that scene.
#
# The baselines are authored by linux CI, so a native macOS render never matches
# them; the positive control therefore regenerates the handful of scenes in this
# micro-shard LOCALLY first, and everything is restored from a byte backup at
# the end (NOT via git, so no LFS round-trip is involved).
set -uo pipefail
ROOT=/Users/2600hz/Documents/workspace/inet.modular/.claude/worktrees/wf_f09a5e8e-581-1
BAK=$ROOT/.ci-measure/baseline-backup
cd "$ROOT"

# A 1-of-40 slice: ~3 scenes, enough to exercise the whole path cheaply.
node scripts/vrt-shard-plan.mjs 1 40 --list .ci-measure/vrt-list.json \
  --out .ci-measure/micro-planned.txt > .ci-measure/micro-grep.txt
echo "== micro-shard plan =="; cat .ci-measure/micro-planned.txt

rm -rf "$BAK"; mkdir -p "$BAK"
cp -R e2e/vrt/__screenshots__ "$BAK/"
echo "== backed up $(find "$BAK" -name '*.png' | wc -l | tr -d ' ') baseline PNGs =="

run() { # $1 = extra args, writes .ci-measure/micro-run.log, echoes exit code
  ( cd e2e && VRT_STRICT=1 npx playwright test --config=vrt/vrt.config.ts \
      --grep "$(cat "$ROOT/.ci-measure/micro-grep.txt")" $1 2>&1 ) | tee "$ROOT/.ci-measure/micro-run.log"
  return "${PIPESTATUS[0]}"
}

echo "== 1. regenerate this slice's baselines against the LOCAL renderer =="
run "--update-snapshots=changed" >/dev/null 2>&1
echo "   regen exit=$?"

echo "== 2. POSITIVE CONTROL: the shard should now be GREEN =="
run ""; POS=$?
node scripts/vrt-shard-coverage.mjs .ci-measure/micro-planned.txt .ci-measure/micro-run.log; POSCOV=$?
echo "   playwright exit=$POS  coverage exit=$POSCOV"

echo "== 3. NEGATIVE CONTROL: perturb ONE baseline of this shard =="
VICTIM=$(node -e '
  const fs=require("node:fs");
  const first=fs.readFileSync(".ci-measure/micro-planned.txt","utf8").trim().split("\n")[0];
  const [file,title]=first.split(" :: ");
  const name = file==="vrt.spec.ts" ? title.replace(/ card matches baseline$/,"") : title.split(":")[0];
  console.log(`e2e/vrt/__screenshots__/${file}/${name}.png`);
')
echo "   victim: $VICTIM"
ls -l "$VICTIM"
node -e '
  const fs=require("node:fs");
  const p=process.argv[1];
  const b=fs.readFileSync(p);
  // Corrupt a run of IDAT bytes well past the header: a REAL pixel change, not
  // a malformed file — the point is that the COMPARISON must fail, not the read.
  for(let i=2000;i<Math.min(b.length,20000);i++) b[i]=b[i]^0xff;
  fs.writeFileSync(p,b);
' "$VICTIM"

run ""; NEG=$?
node scripts/vrt-shard-coverage.mjs .ci-measure/micro-planned.txt .ci-measure/micro-run.log; NEGCOV=$?
echo "   playwright exit=$NEG  coverage exit=$NEGCOV"

echo "== 4. RESTORE =="
rm -rf e2e/vrt/__screenshots__
cp -R "$BAK/__screenshots__" e2e/vrt/
echo "--- git status for the baseline tree ---"
git status --porcelain e2e/vrt/__screenshots__
echo "--- untracked PNGs anywhere under e2e/vrt ---"
git status --porcelain --untracked-files=all e2e/vrt | grep -E '^\?\?.*\.png$' || echo "   (none)"

echo
echo "RESULT: positive playwright=$POS coverage=$POSCOV | negative playwright=$NEG coverage=$NEGCOV"
