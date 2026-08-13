#!/usr/bin/env bash
set -euo pipefail
ROOT=/Users/2600hz/Documents/workspace/inet.modular/.claude/worktrees/wf_f09a5e8e-581-1
cd "$ROOT/e2e"
count() {
  (VRT_STRICT=1 npx playwright test --config=vrt/vrt.config.ts --list --reporter=json --grep "$1" 2>/dev/null || true) \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{let n=0;try{const j=JSON.parse(d);(function w(ss){for(const s of ss||[]){if(s.specs)n+=s.specs.length;w(s.suites);}})(j.suites);}catch{n="ERR"}console.log(n);})'
}
for p in '^chromium-vrt' '^ ' '^vrt/vrt\.spec\.ts' '^\[' '^adsr' '^VRT' '^ VRT' 'chromium-vrt' 'vrt\.spec\.ts'; do
  printf '%-28s -> ' "$p"; count "$p"
done
