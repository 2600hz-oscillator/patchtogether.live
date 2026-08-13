import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/Users/2600hz/Documents/workspace/inet.modular/.claude/worktrees/wf_f09a5e8e-581-1';
const log = readFileSync(`${ROOT}/.ci-measure/vrt-strict.log`, 'utf8');

// `list` reporter line: "  ✓  12 [chromium-vrt] › vrt/vrt.spec.ts:64:5 › <describe> › <title> (5.1s)"
const re =
  /[✓✘]\s+\d+\s+\[chromium-vrt\]\s+›\s+(\S+?):\d+:\d+\s+›\s+.*?›\s+(.*?)\s+\((\d+(?:\.\d+)?)(m?s)\)\s*$/;

const tests = {};
for (const raw of log.split('\n')) {
  const m = re.exec(raw.replace(/\r$/, ''));
  if (!m) continue;
  const [, filePath, title, n, unit] = m;
  const file = filePath.replace(/^vrt\//, ''); // config testDir is e2e/vrt
  const sec = unit === 'ms' ? Number(n) / 1000 : Number(n);
  tests[`${file} :: ${title}`] = Number(sec.toFixed(3));
}

const total = Object.values(tests).reduce((a, b) => a + b, 0);
const out = {
  _comment:
    'Per-TEST cost in SECONDS for the REQUIRED vrt-strict lane (VRT_STRICT=1). Keyed "<spec file> :: <test title>". ' +
    'Consumed by scripts/vrt-shard-plan.mjs to bin-pack the lane across shards. ' +
    'Regenerate with `flox activate -- task vrt:strict:timings:accept -- <ci-run-id>`. Reviewed as a diff, never hand-edited.',
  _source: `ci.yml run 31736165616, job 94568963454 (vrt-strict, ubuntu-latest, all green): ${Object.keys(tests).length} tests, ${total.toFixed(1)} CPU-s`,
  _first_test_warmup_note:
    'The FIRST test of a run absorbs the vite dev-server cold boot. In this sample that is "adsr card matches baseline" at 17.1 s against a 4.7 s median for its siblings, i.e. ~12 s of the number belongs to the SHARD, not to adsr. Recorded as measured rather than smoothed; the effect is one bin biased by ~12 s and the coverage assertions, not the balance, are what make the split safe.',
  tests,
};
writeFileSync(`${ROOT}/e2e/vrt-strict-timings.generated.json`, JSON.stringify(out, null, 2) + '\n');
console.log('tests', Object.keys(tests).length, 'total', total.toFixed(1));
