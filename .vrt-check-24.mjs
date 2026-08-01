// STEP 1 of the linux regen: does any of the 24 linux baselines under the four
// font-pinned specs sit in EXEMPT_BASELINE_PAIRS as `linux/<scene>`?
//
// This is THE trap. A listed pair is test.skip()-ed UNCONDITIONALLY, so
// `--update-snapshots` writes NOTHING for it and the dispatch comes back green
// having captured zero. Drain first, dispatch second.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO = new URL('./', import.meta.url).pathname.replace(/\/$/, '');
const VRT = join(REPO, 'e2e/vrt');
const SRC = readFileSync(join(VRT, 'vrt-exemptions.ts'), 'utf8');

const s = SRC.indexOf('export const EXEMPT_BASELINE_PAIRS = new Set<string>([');
const o = SRC.indexOf('[', s);
let d = 0, i = o;
for (; i < SRC.length; i++) { if (SRC[i] === '[') d++; else if (SRC[i] === ']') { d--; if (!d) break; } }
const clean = SRC.slice(o, i).replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
const PAIRS = new Set([...clean.matchAll(/'([^']+)'/g)].map((m) => m[1]));

const SPECS = ['playhead', 'vrt-clap', 'vrt-composite', 'vrt-karplus-tomtom-states'];
let total = 0, listed = 0;
for (const spec of SPECS) {
  const dir = join(VRT, '__screenshots__', `${spec}.spec.ts`, 'linux');
  const stems = readdirSync(dir).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)).sort();
  console.log(`\n${spec}.spec.ts  (${stems.length} linux baselines)`);
  for (const stem of stems) {
    total++;
    const key = `linux/${stem}`;
    const hit = PAIRS.has(key);
    if (hit) listed++;
    console.log(`  ${hit ? 'EXEMPT !!' : '  ok     '} ${stem}`);
  }
}
console.log(`\n${total} linux baselines checked; ${listed} listed in EXEMPT_BASELINE_PAIRS.`);
console.log(
  listed
    ? `-> DRAIN REQUIRED: remove those ${listed} pairs + lower the vrt-meta ceiling by ${listed} in the SAME commit, push, THEN dispatch.`
    : `-> No drain needed. These are COMMITTED-and-will-MISMATCH, which --update-snapshots rewrites on failure.`,
);
