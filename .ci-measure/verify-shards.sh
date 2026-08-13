#!/usr/bin/env bash
# END-TO-END check of the shard selector against the REAL Playwright: for each
# shard, does `--grep <planned pattern>` list exactly the planned tests?
set -euo pipefail
ROOT=/Users/2600hz/Documents/workspace/inet.modular/.claude/worktrees/wf_f09a5e8e-581-1
cd "$ROOT"
N=${1:-4}

VRT_STRICT=1 node --version >/dev/null
for k in $(seq 1 "$N"); do
  node scripts/vrt-shard-plan.mjs "$k" "$N" --list .ci-measure/vrt-list.json \
    --out ".ci-measure/planned-$k.txt" > ".ci-measure/grep-$k.txt"
  ( cd e2e && VRT_STRICT=1 npx playwright test --config=vrt/vrt.config.ts --list \
      --reporter=json --grep "$(cat "$ROOT/.ci-measure/grep-$k.txt")" 2>/dev/null ) \
    > ".ci-measure/listed-$k.json"
  node -e '
    const fs=require("node:fs");
    const k=process.argv[1];
    const j=JSON.parse(fs.readFileSync(`.ci-measure/listed-${k}.json`,"utf8"));
    const got=[];(function w(ss){for(const s of ss||[]){for(const sp of s.specs||[])got.push(`${sp.file} :: ${sp.title}`);w(s.suites);}})(j.suites);
    const want=fs.readFileSync(`.ci-measure/planned-${k}.txt`,"utf8").trim().split("\n");
    const miss=want.filter(x=>!got.includes(x)), extra=got.filter(x=>!want.includes(x));
    console.log(`shard ${k}: planned=${want.length} playwright-selected=${got.length} missing=${miss.length} extra=${extra.length}`);
    if(miss.length||extra.length){console.error({miss,extra});process.exit(1);}
  ' "$k"
done

echo "--- union across all $N shards ---"
cat .ci-measure/planned-*.txt | sort > .ci-measure/union.txt
node -e '
  const fs=require("node:fs");
  const union=fs.readFileSync(".ci-measure/union.txt","utf8").trim().split("\n");
  const all=Object.keys(JSON.parse(fs.readFileSync("e2e/vrt-strict-timings.generated.json","utf8")).tests).sort();
  console.log("union=%d discovered=%d dupes=%d", union.length, all.length, union.length-new Set(union).size);
  const miss=all.filter(x=>!union.includes(x)), extra=union.filter(x=>!all.includes(x));
  console.log("missing=%j extra=%j", miss, extra);
  if(miss.length||extra.length||union.length!==new Set(union).size) process.exit(1);
'
