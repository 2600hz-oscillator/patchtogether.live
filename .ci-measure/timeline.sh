#!/usr/bin/env bash
set -euo pipefail
RUN=${1:-31736165616}
gh api "repos/:owner/:repo/actions/runs/$RUN" -q '.run_started_at' > /tmp/_t0
gh api "repos/:owner/:repo/actions/runs/$RUN/jobs" --paginate --jq '.jobs[] | [.name, .started_at, .completed_at, .conclusion] | @tsv' \
 | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
 const rows=d.trim().split("\n").map(l=>l.split("\t"));
 const t0=Math.min(...rows.filter(r=>r[3]!=="skipped").map(r=>Date.parse(r[1])));
 const out=rows.map(([n,s,c,k])=>({n,k,start:(Date.parse(s)-t0)/60000,end:(Date.parse(c)-t0)/60000}))
  .filter(r=>r.k!=="skipped").sort((a,b)=>a.end-b.end);
 for(const r of out) console.log(r.end.toFixed(2).padStart(6), r.start.toFixed(2).padStart(6), (r.end-r.start).toFixed(2).padStart(6), r.n);
});'
