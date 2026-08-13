#!/usr/bin/env bash
# NEGATIVE CONTROL, take 2 — the 1-of-40 slice happened to land on the one test
# in the lane with no PNG baseline (the audio-freeze negative control), so there
# was nothing to perturb. Pin the slice to two scenes that DO have baselines.
set -uo pipefail
ROOT=/Users/2600hz/Documents/workspace/inet.modular/.claude/worktrees/wf_f09a5e8e-581-1
BAK=$ROOT/.ci-measure/baseline-backup2
cd "$ROOT"

printf 'vrt.spec.ts :: vca card matches baseline\nworkflow-shell-faces.spec.ts :: face-vca-compact: the compact lane tile matches baseline\n' \
  > .ci-measure/micro2-planned.txt
printf '(?: vca card matches baseline| face-vca-compact: the compact lane tile matches baseline)$\n' \
  > .ci-measure/micro2-grep.txt
VICTIM="e2e/vrt/__screenshots__/vrt.spec.ts/vca.png"

rm -rf "$BAK"; mkdir -p "$BAK"; cp -R e2e/vrt/__screenshots__ "$BAK/"

run() {
  ( cd e2e && VRT_STRICT=1 npx playwright test --config=vrt/vrt.config.ts \
      --grep "$(cat "$ROOT/.ci-measure/micro2-grep.txt")" $1 2>&1 ) | tee "$ROOT/.ci-measure/micro2-run.log"
  return "${PIPESTATUS[0]}"
}

echo "== 1. regenerate the two baselines against the LOCAL renderer =="
run "--update-snapshots=changed" >/dev/null 2>&1; echo "   regen exit=$?"

echo "== 2. POSITIVE CONTROL =="
run "" >/dev/null 2>&1; POS=$?
node scripts/vrt-shard-coverage.mjs .ci-measure/micro2-planned.txt .ci-measure/micro2-run.log; POSCOV=$?
echo "   playwright exit=$POS  coverage exit=$POSCOV"

echo "== 3. NEGATIVE CONTROL: perturb $VICTIM =="
node -e '
  const fs=require("node:fs"), zlib=require("node:zlib"), p=process.argv[1];
  // Decode the PNG far enough to know its dimensions, then write a valid PNG of
  // the SAME size whose pixels differ — a real image difference, not a corrupt
  // file, so the failure is the COMPARISON and not the read.
  const b=fs.readFileSync(p), w=b.readUInt32BE(16), h=b.readUInt32BE(20);
  const raw=Buffer.alloc(h*(1+w*3));
  for(let y=0;y<h;y++){ raw[y*(1+w*3)]=0; for(let x=0;x<w;x++){ const o=y*(1+w*3)+1+x*3; raw[o]=255; raw[o+1]=0; raw[o+2]=255; } }
  const crcT=[...Array(256)].map((_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;return c>>>0;});
  const crc=(buf)=>{let c=0xffffffff;for(const v of buf)c=crcT[(c^v)&0xff]^(c>>>8);return (c^0xffffffff)>>>0;};
  const chunk=(type,data)=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const td=Buffer.concat([Buffer.from(type),data]);const cr=Buffer.alloc(4);cr.writeUInt32BE(crc(td));return Buffer.concat([len,td,cr]);};
  const ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(w,0); ihdr.writeUInt32BE(h,4); ihdr[8]=8; ihdr[9]=2;
  fs.writeFileSync(p, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR",ihdr), chunk("IDAT",zlib.deflateSync(raw)), chunk("IEND",Buffer.alloc(0))]));
  console.log(`   rewrote ${p} as a solid magenta ${w}x${h} PNG`);
' "$VICTIM"

run "" >/dev/null 2>&1; NEG=$?
node scripts/vrt-shard-coverage.mjs .ci-measure/micro2-planned.txt .ci-measure/micro2-run.log; NEGCOV=$?
echo "   playwright exit=$NEG  coverage exit=$NEGCOV"
grep -E '^\s*[✘✗]|Screenshot comparison failed|pixels' .ci-measure/micro2-run.log | head -6

echo "== 4. RESTORE =="
rm -rf e2e/vrt/__screenshots__; cp -R "$BAK/__screenshots__" e2e/vrt/
git status --porcelain e2e/vrt/__screenshots__ | head
git status --porcelain --untracked-files=all e2e/vrt | grep -E '^\?\?.*\.png$' || echo "   no untracked PNGs"

echo
echo "RESULT: positive playwright=$POS coverage=$POSCOV | negative playwright=$NEG coverage=$NEGCOV"
