import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  new URL('./e2e/vrt/vrt-exemptions.ts', import.meta.url).pathname,
  'utf8',
);

function extractSet(name) {
  const start = SRC.indexOf(`export const ${name} = new Set<string>([`);
  if (start < 0) throw new Error(`no ${name}`);
  const open = SRC.indexOf('[', start);
  let depth = 0, i = open;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '[') depth++;
    else if (SRC[i] === ']') {
      depth--;
      if (depth === 0) break;
    }
  }
  const body = SRC.slice(open, i);
  // strip comments so commented-out entries don't count
  const clean = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
  return [...clean.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

function extractRecordKeys(name) {
  const start = SRC.indexOf(`export const ${name}: Record<string, string> = {`);
  if (start < 0) throw new Error(`no ${name}`);
  const open = SRC.indexOf('{', SRC.indexOf('= {', start));
  let depth = 0, i = open;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  const body = SRC.slice(open + 1, i);
  const clean = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/^(\s*)\/\/.*$/, '$1'))
    .join('\n');
  // top-level keys only: `  key: '...'` or `  'key': '...'`
  return [...clean.matchAll(/^\s{2}'?([A-Za-z0-9_]+)'?\s*:/gm)].map((m) => m[1]);
}

const pairs = extractSet('EXEMPT_BASELINE_PAIRS');
const strict = extractSet('STRICT_VRT_MODULES');
const exemptVrt = extractRecordKeys('EXEMPT_FROM_VRT');

const linuxPairs = pairs.filter((p) => p.startsWith('linux/')).map((p) => p.slice(6));
const darwinPairs = pairs.filter((p) => p.startsWith('darwin/')).map((p) => p.slice(7));

console.log(`EXEMPT_BASELINE_PAIRS total=${pairs.length} linux=${linuxPairs.length} darwin=${darwinPairs.length}`);
console.log(`EXEMPT_FROM_VRT modules=${exemptVrt.length}`);
console.log(`STRICT_VRT_MODULES=${strict.length}`);
console.log();

// Per-spec gap analysis, cross-referenced against the linux exemptions.
const ROOT = new URL('./e2e/vrt/__screenshots__/', import.meta.url).pathname;
const linuxSet = new Set(linuxPairs);
const strictSet = new Set(strict);

const report = [];
for (const spec of readdirSync(ROOT).sort()) {
  const d = join(ROOT, spec, 'darwin');
  const l = join(ROOT, spec, 'linux');
  const dn = existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.png')).map((f) => f.replace(/\.png$/, '')) : [];
  const ln = existsSync(l) ? new Set(readdirSync(l).filter((f) => f.endsWith('.png')).map((f) => f.replace(/\.png$/, ''))) : new Set();
  const missing = dn.filter((n) => !ln.has(n));
  const exempted = missing.filter((n) => linuxSet.has(n));
  const unexplained = missing.filter((n) => !linuxSet.has(n));
  const strictNames = dn.filter((n) => strictSet.has(n));
  report.push({ spec, d: dn.length, l: ln.size, missing, exempted, unexplained, strictNames });
}

let tm = 0, te = 0, tu = 0;
for (const r of report) {
  tm += r.missing.length; te += r.exempted.length; tu += r.unexplained.length;
  if (r.missing.length === 0) continue;
  console.log(
    `${r.spec}  darwin=${r.d} linux=${r.l}  missing=${r.missing.length}  exempt=${r.exempted.length}  UNEXPLAINED=${r.unexplained.length}`,
  );
  if (r.unexplained.length) console.log(`   unexplained: ${r.unexplained.join(', ')}`);
}
console.log(`\nTOTALS missing=${tm} exempt-declared=${te} UNEXPLAINED=${tu}`);

// vrt.spec.ts is the only STRICT-lane spec. Which strict modules lack linux?
const vrt = report.find((r) => r.spec === 'vrt.spec.ts');
const strictMissingLinux = vrt.missing.filter((n) => strictSet.has(n));
console.log(`\nSTRICT_VRT_MODULES with darwin baseline: ${vrt.strictNames.length} / ${strict.length}`);
console.log(`STRICT modules MISSING a linux baseline: ${strictMissingLinux.length}` +
  (strictMissingLinux.length ? ` → ${strictMissingLinux.join(', ')}` : ''));
const strictNoDarwin = strict.filter((n) => !vrt.strictNames.includes(n));
console.log(`STRICT modules missing a DARWIN baseline: ${strictNoDarwin.length}` +
  (strictNoDarwin.length ? ` → ${strictNoDarwin.join(', ')}` : ''));

// linux/* exemptions that no longer correspond to a missing baseline (stale)
const allMissing = new Set(report.flatMap((r) => r.missing));
const staleLinuxExempt = linuxPairs.filter((n) => !allMissing.has(n));
console.log(`\nlinux/* exemption entries with NO corresponding missing baseline (stale or non-baseline id): ${staleLinuxExempt.length}`);
if (staleLinuxExempt.length) console.log(`   ${staleLinuxExempt.join(', ')}`);
