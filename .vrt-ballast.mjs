// Classify the linux/* EXEMPT_BASELINE_PAIRS entries that do NOT correspond to
// a darwin-baseline-without-a-linux-twin. Three very different situations hide
// in that bucket and they are not equally benign.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = new URL('./', import.meta.url).pathname.replace(/\/$/, '');
const VRT = join(REPO, 'e2e/vrt');
const SHOTS = join(VRT, '__screenshots__');
const SRC = readFileSync(join(VRT, 'vrt-exemptions.ts'), 'utf8');

function extractSet(name) {
  const s = SRC.indexOf(`export const ${name} = new Set<string>([`);
  const o = SRC.indexOf('[', s);
  let d = 0, i = o;
  for (; i < SRC.length; i++) { if (SRC[i] === '[') d++; else if (SRC[i] === ']') { d--; if (!d) break; } }
  const clean = SRC.slice(o, i).replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  return [...clean.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}
function exemptFromVrtKeys() {
  const s = SRC.indexOf('export const EXEMPT_FROM_VRT: Record<string, string> = {');
  const o = SRC.indexOf('{', SRC.indexOf('= {', s));
  let d = 0, i = o;
  for (; i < SRC.length; i++) { if (SRC[i] === '{') d++; else if (SRC[i] === '}') { d--; if (!d) break; } }
  const clean = SRC.slice(o + 1, i).replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/^(\s*)\/\/.*$/, '$1')).join('\n');
  return new Set([...clean.matchAll(/^\s{2}'?([A-Za-z0-9_]+)'?\s*:/gm)].map((m) => m[1]));
}

const linuxPairs = extractSet('EXEMPT_BASELINE_PAIRS').filter((p) => p.startsWith('linux/')).map((p) => p.slice(6));
const EXEMPT_VRT = exemptFromVrtKeys();

// index every committed baseline stem by platform
const have = { darwin: new Set(), linux: new Set() };
for (const spec of readdirSync(SHOTS)) {
  for (const plat of ['darwin', 'linux']) {
    const d = join(SHOTS, spec, plat);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) if (f.endsWith('.png')) have[plat].add(f.slice(0, -4));
  }
}

const buckets = { realGap: [], bothExist: [], neitherExists: [], neverQueried: [] };
// which stems does any spec actually pass to EXEMPT_BASELINE_PAIRS.has()?
// vrt-toybox.spec.ts never calls .has() at all — its linux/toybox-* keys are
// only ever interpolated into a skip MESSAGE.
const toyboxKeys = new Set(linuxPairs.filter((n) => n.startsWith('toybox-')));

for (const n of linuxPairs) {
  if (toyboxKeys.has(n)) { buckets.neverQueried.push(n); continue; }
  const d = have.darwin.has(n), l = have.linux.has(n);
  if (d && !l) buckets.realGap.push(n);
  else if (d && l) buckets.bothExist.push(n);
  else buckets.neitherExists.push(n);
}

console.log(`linux/* entries in EXEMPT_BASELINE_PAIRS: ${linuxPairs.length}\n`);
console.log(`A) REAL GAP (darwin baseline exists, linux missing) .......... ${buckets.realGap.length}`);
console.log(`B) BOTH baselines committed, yet the pair still SKIPS linux .. ${buckets.bothExist.length}`);
if (buckets.bothExist.length) {
  console.log(`     ${buckets.bothExist.join(', ')}`);
  console.log(`     -> the linux PNG is committed but never compared. Coverage silently off.`);
  const inExempt = buckets.bothExist.filter((n) => EXEMPT_VRT.has(n));
  console.log(`     (of these, ${inExempt.length} are ALSO in EXEMPT_FROM_VRT: ${inExempt.join(', ') || '—'})`);
}
console.log(`C) NEITHER platform has a baseline (module fully VRT-exempt) . ${buckets.neitherExists.length}`);
if (buckets.neitherExists.length) {
  console.log(`     ${buckets.neitherExists.join(', ')}`);
  const inExempt = buckets.neitherExists.filter((n) => EXEMPT_VRT.has(n));
  console.log(`     (of these, ${inExempt.length} are in EXEMPT_FROM_VRT — pair is redundant with the module-level exemption)`);
}
console.log(`D) key no spec ever queries (linux/toybox-*) ................. ${buckets.neverQueried.length}`);
if (buckets.neverQueried.length) console.log(`     ${buckets.neverQueried.join(', ')}`);
