// PRECISE stale-palette probe.
//
// A card that declares `<div class="stripe" style="background: var(--cable-X)">`
// has a stripe whose colour is FIXED by tokens.css. So the committed baseline's
// top stripe MUST equal that token's hex. Any baseline that doesn't was
// captured before the token's current value and is STALE — regardless of
// whether the VRT gate passes it.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { PNG } from 'pngjs';
import { join } from 'node:path';

const REPO = new URL('./', import.meta.url).pathname.replace(/\/$/, '');
const CARDS = join(REPO, 'packages/web/src/lib/ui/modules');
const TOKENS_SRC = readFileSync(join(REPO, 'packages/web/src/lib/styles/tokens.css'), 'utf8');

const TOKEN = {};
for (const m of TOKENS_SRC.matchAll(/--cable-([A-Za-z-]+):\s*(#[0-9a-fA-F]{6})/g)) {
  TOKEN[m[1]] = m[2].toLowerCase();
}

// card file -> declared cable token
const declared = new Map();
for (const f of readdirSync(CARDS).filter((n) => n.endsWith('Card.svelte'))) {
  const src = readFileSync(join(CARDS, f), 'utf8');
  const m = /<div class="stripe" style="background: var\(--cable-([A-Za-z-]+)\);?"/.exec(src);
  if (m) declared.set(f, m[1]);
}

// card file -> module id, via the card-map test's registry
const MAPSRC = readFileSync(
  join(REPO, 'packages/web/src/lib/ui/modules-card-map.test.ts'),
  'utf8',
);
// fall back to filename heuristic: FooBarCard.svelte -> fooBar
function idFor(file) {
  const stem = file.replace(/Card\.svelte$/, '');
  return stem.charAt(0).toLowerCase() + stem.slice(1);
}

const DIRS = process.argv.slice(2);
const hex = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

for (const dir of DIRS) {
  console.log(`\n=== ${dir.replace(REPO + '/', '')} ===`);
  let checked = 0, stale = 0;
  for (const [file, tok] of [...declared].sort()) {
    const want = TOKEN[tok];
    if (!want) continue;
    const png = join(dir, idFor(file) + '.png');
    if (!existsSync(png)) continue;
    const p = PNG.sync.read(readFileSync(png));
    const x = p.width >> 1;
    // find the row in y=0..5 closest to the declared token
    let best = null;
    for (let y = 0; y < Math.min(6, p.height); y++) {
      const i = (p.width * y + x) << 2;
      const r = p.data[i], g = p.data[i + 1], b = p.data[i + 2];
      const R = parseInt(want.slice(1, 3), 16), G = parseInt(want.slice(3, 5), 16), B = parseInt(want.slice(5, 7), 16);
      const d = Math.sqrt((R - r) ** 2 + (G - g) ** 2 + (B - b) ** 2);
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      if (chroma < 25) continue; // background row, not the stripe
      if (!best || d < best.d) best = { y, r, g, b, d };
    }
    checked++;
    if (!best) {
      console.log(`  ?      ${idFor(file).padEnd(24)} no chromatic stripe row (masked?)  want --cable-${tok} ${want}`);
      continue;
    }
    if (best.d > 12) {
      stale++;
      console.log(
        `  STALE  ${idFor(file).padEnd(24)} baseline ${hex(best.r, best.g, best.b)}  !=  --cable-${tok} ${want}  (Δ=${best.d.toFixed(0)})`,
      );
    }
  }
  console.log(`  -> ${checked} cards with a token-pinned stripe; ${stale} STALE`);
}
