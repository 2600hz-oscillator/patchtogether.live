#!/usr/bin/env node
// Read-only: cross-reference every DARWIN baseline against its LINUX sibling
// and the exemption tables, to answer ONE question — when the linux gate runs,
// which scenes have NO baseline (hard fail) vs a baseline that will be diffed?
//
// Scene id = PNG basename. Exemption key = `linux/<sceneId>`.
//
// ⚠ This script reads TWO of the FOUR mechanisms that take a scene dark on a
// platform (the shared pair Set + the spec-local pair Sets). It is blind to the
// blanket `test.skip(VRT_PLATFORM === 'linux', …)` in 8 specs and to the
// `darwinOnly` scene flag, so its bucket C UNDER-counts by 52. The complete
// enumeration — and the ratchet that gates on it — is
// e2e/vrt/vrt-platform-gaps.ts + the vrt-meta LINUX-DEFICIT ratchet. Prefer
// those; this stays for the per-scene FULL_MATCH lane breakdown they don't do.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SHOT = join(ROOT, 'e2e/vrt/__screenshots__');

// ⚠ STRIP COMMENTS FIRST. An apostrophe in prose ("the card's face") desyncs
// naive quote pairing and SILENTLY SWALLOWS real entries — the first version of
// this script reported 87 hard-fails where the repo's own audit said 0, because
// `linux/com-hsv` and friends were eaten by a match that started at a prose
// apostrophe. Negative control: the parsed count must equal
// `node scripts/vrt-exemptions-audit.mjs` (127).
function pairsFrom(file, konst = 'EXEMPT_BASELINE_PAIRS') {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const i = src.indexOf(`${konst} = new Set`);
  if (i < 0) return new Set();
  const tail = src.slice(i);
  const end = tail.indexOf('\n]);');
  const block = (end < 0 ? tail : tail.slice(0, end))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
  return new Set([...block.matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

const shared = pairsFrom('e2e/vrt/vrt-exemptions.ts');
// Specs carrying their OWN local pair set (not the shared table).
const local = new Set([
  ...pairsFrom('e2e/vrt/dashboard.spec.ts'),
  ...pairsFrom('e2e/vrt/groups.spec.ts'),
  ...pairsFrom('e2e/vrt/interactions.spec.ts'),
  ...pairsFrom('e2e/vrt/landing.spec.ts'),
]);
const exempt = new Set([...shared, ...local]);
// Negative control on the parser itself (see pairsFrom).
// 127 → 112 (2026-08-01): the 15-pair drain of already-committed linux
// baselines. Keep this in lockstep with `node scripts/vrt-exemptions-audit.mjs`.
const EXPECTED_SHARED_PAIRS = 112;
if (shared.size !== EXPECTED_SHARED_PAIRS) {
  console.error(`PARSER CHECK FAILED: shared EXEMPT_BASELINE_PAIRS parsed ${shared.size}, expected ${EXPECTED_SHARED_PAIRS} (vrt-exemptions-audit.mjs). If the Set legitimately changed size, update EXPECTED_SHARED_PAIRS; otherwise fix the parser before believing anything below.`);
  process.exit(2);
}

// Specs the FULL lane actually runs (vrt.config.ts FULL_MATCH).
const cfg = readFileSync(join(ROOT, 'e2e/vrt/vrt.config.ts'), 'utf8');
const full = new Set(
  [...cfg.slice(cfg.indexOf('const FULL_MATCH'), cfg.indexOf('const PROBE_MATCH')).matchAll(/'([^']+\.spec\.ts)'/g)].map((m) => m[1]),
);

const missing = [];
const willDiff = [];
const skipped = [];
const linuxOnly = [];

for (const spec of readdirSync(SHOT)) {
  const inLane = full.has(spec);
  const dDir = join(SHOT, spec, 'darwin');
  const lDir = join(SHOT, spec, 'linux');
  const dPngs = existsSync(dDir) ? readdirSync(dDir).filter((f) => f.endsWith('.png')) : [];
  const lPngs = existsSync(lDir) ? readdirSync(lDir).filter((f) => f.endsWith('.png')) : [];
  for (const png of dPngs) {
    const id = png.replace(/\.png$/, '');
    const rec = { spec, id, inLane };
    if (exempt.has(`linux/${id}`)) skipped.push(rec);
    else if (!lPngs.includes(png)) missing.push(rec);
    else willDiff.push(rec);
  }
  for (const png of lPngs) {
    if (!dPngs.includes(png)) linuxOnly.push({ spec, id: png.replace(/\.png$/, ''), inLane });
  }
}

const laneOnly = (a) => a.filter((r) => r.inLane);
console.log(`FULL_MATCH specs: ${full.size}`);
console.log(`\n=== A. NO linux baseline AND not exempt — HARD FAIL on the linux gate ===`);
console.log(`   in-lane: ${laneOnly(missing).length}   (out-of-lane: ${missing.length - laneOnly(missing).length})`);
for (const r of laneOnly(missing)) console.log(`   ✗ ${r.spec} :: ${r.id}`);
console.log(`\n=== B. linux baseline EXISTS and will be DIFFED (the tolerance-sensitive set) ===`);
console.log(`   in-lane: ${laneOnly(willDiff).length}   (out-of-lane: ${willDiff.length - laneOnly(willDiff).length})`);
console.log(`\n=== C. exempt on linux → test.skip()-ed, regen writes NOTHING ===`);
console.log(`   in-lane: ${laneOnly(skipped).length}`);
const withPng = laneOnly(skipped).filter((r) => existsSync(join(SHOT, r.spec, 'linux', `${r.id}.png`)));
console.log(`   …of which a linux PNG ALREADY exists (stale pair, silent coverage loss): ${withPng.length}`);
for (const r of withPng) console.log(`   ~ ${r.spec} :: ${r.id}`);
console.log(`\n=== D. linux PNG with no darwin sibling ===  ${linuxOnly.length}`);
for (const r of linuxOnly) console.log(`   ? ${r.spec} :: ${r.id} (inLane=${r.inLane})`);
