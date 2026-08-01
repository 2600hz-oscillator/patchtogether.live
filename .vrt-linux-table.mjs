// FINAL linux-coverage table: per spec, darwin vs linux baseline counts, the
// gap, and WHICH mechanism declares the gap. Four mechanisms exist and only
// ONE of them is counted by the vrt-meta linux-deficit ratchet.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = new URL('./', import.meta.url).pathname.replace(/\/$/, '');
const VRT = join(REPO, 'e2e/vrt');
const SHOTS = join(VRT, '__screenshots__');
const EXSRC = readFileSync(join(VRT, 'vrt-exemptions.ts'), 'utf8');

function extractSet(name, src) {
  const start = src.indexOf(`const ${name} = new Set<string>([`);
  if (start < 0) return [];
  const open = src.indexOf('[', start);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') { depth--; if (depth === 0) break; }
  }
  const clean = src.slice(open, i)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  return [...clean.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const CENTRAL = new Set(extractSet('EXEMPT_BASELINE_PAIRS', EXSRC).filter((p) => p.startsWith('linux/')).map((p) => p.slice(6)));
const CENTRAL_ALL = extractSet('EXEMPT_BASELINE_PAIRS', EXSRC);
const STRICT = new Set(extractSet('STRICT_VRT_MODULES', EXSRC));

// classify each spec's declaration mechanism from its source
function mechanism(spec) {
  const p = join(VRT, spec);
  if (!existsSync(p)) return 'spec missing';
  const src = readFileSync(p, 'utf8');
  const m = [];
  if (/test\.skip\(\s*\n?\s*VRT_PLATFORM === 'linux'/.test(src) || /VRT_PLATFORM === 'linux',/.test(src))
    m.push('BLANKET test.skip(linux)');
  if (/^const EXEMPT_BASELINE_PAIRS = new Set/m.test(src)) m.push('LOCAL pairs set');
  if (/EXEMPT_BASELINE_PAIRS\s*}\s*from '\.\/vrt-exemptions'/.test(src) || /import \{[^}]*EXEMPT_BASELINE_PAIRS[^}]*\} from '\.\/vrt-exemptions'/.test(src))
    m.push('CENTRAL pairs set');
  if (/darwinOnly/.test(src)) m.push('scene darwinOnly');
  return m.length ? m.join(' + ') : 'none';
}
// composite scenes carry darwinOnly on the SCENE, not the spec
const COMPOSITE_SCENES = readFileSync(join(VRT, 'vrt-composite-scenes.ts'), 'utf8');
const darwinOnlyCount = (COMPOSITE_SCENES.match(/darwinOnly: true/g) ?? []).length;

const rows = [];
for (const spec of readdirSync(SHOTS).sort()) {
  const d = join(SHOTS, spec, 'darwin');
  const l = join(SHOTS, spec, 'linux');
  const dn = existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)) : [];
  const ln = existsSync(l) ? new Set(readdirSync(l).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4))) : new Set();
  const missing = dn.filter((n) => !ln.has(n));
  const viaCentral = missing.filter((n) => CENTRAL.has(n)).length;
  rows.push({
    spec, d: dn.length, l: ln.size, gap: missing.length,
    viaCentral, other: missing.length - viaCentral,
    mech: missing.length ? mechanism(spec) : '—',
    strict: spec === 'vrt.spec.ts',
  });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('SPEC', 38) + pad('darwin', 7) + pad('linux', 6) + pad('gap', 5) + pad('ratchet-counted', 16) + 'declared by');
console.log('-'.repeat(140));
let td = 0, tl = 0, tg = 0, tc = 0;
for (const r of rows) {
  td += r.d; tl += r.l; tg += r.gap; tc += r.viaCentral;
  console.log(
    pad(r.spec.replace('.spec.ts', ''), 38) + pad(r.d, 7) + pad(r.l, 6) + pad(r.gap, 5) +
      pad(r.gap ? `${r.viaCentral}/${r.gap}` : '—', 16) + r.mech,
  );
}
console.log('-'.repeat(140));
console.log(pad('TOTAL', 38) + pad(td, 7) + pad(tl, 6) + pad(tg, 5) + pad(`${tc}/${tg}`, 16));
console.log();
console.log(`central EXEMPT_BASELINE_PAIRS: ${CENTRAL_ALL.length} entries (${CENTRAL.size} linux/*, ${CENTRAL_ALL.length - CENTRAL.size} darwin/*)`);
console.log(`  -> of the ${CENTRAL.size} linux/* entries, only ${tc} map to an actually-missing linux baseline;`);
console.log(`     ${CENTRAL.size - tc} are ballast (modules with NO darwin baseline either, or keys no spec queries).`);
console.log(`vrt-meta ratchet counts all ${CENTRAL.size} linux/* entries and is BLIND to the other ${tg - tc} real gaps.`);
console.log(`composite scenes carrying darwinOnly: ${darwinOnlyCount}`);
console.log(`STRICT_VRT_MODULES: ${STRICT.size} — required lane is vrt.spec.ts ONLY (VRT_STRICT=1).`);
