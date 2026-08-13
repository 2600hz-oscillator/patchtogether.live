#!/usr/bin/env bash
set -euo pipefail
ROOT=/Users/2600hz/Documents/workspace/inet.modular/.claude/worktrees/wf_f09a5e8e-581-1
cd "$ROOT/e2e"
E2E_USE_PREVIEW=1 E2E_WEBGL_HEAVY=exclude npx playwright test --list --reporter=json 2>/dev/null \
  > "$ROOT/.ci-measure/e2e-list.json"
cd "$ROOT"
node -e '
const t=require("./e2e/e2e-timings.generated.json");
const j=require("./.ci-measure/e2e-list.json");
const f=new Set();(function w(ss){for(const s of ss||[]){for(const sp of s.specs||[])f.add(sp.file);w(s.suites);}})(j.suites);
const files=[...f].sort();
const known=Object.keys(t.files);
const unknown=files.filter(x=>!(x in t.files));
const stale=known.filter(x=>!f.has(x));
console.log("discovered=%d  measured=%d  UNKNOWN(new since accept)=%d  STALE(measured but gone)=%d",
  files.length, known.length, unknown.length, stale.length);
console.log("unknown:", unknown);
console.log("stale:", stale);
const med=(a)=>{const s=[...a].sort((x,y)=>x-y);const m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;};
const vals=Object.values(t.files);
console.log("median cost=%ss  unknown files are scheduled at that; their true cost is unmeasured", med(vals));
'
