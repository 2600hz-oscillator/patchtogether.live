// Probe: what colour is the CARD STRIPE in each committed vrt.spec.ts
// baseline? The stripe is `background: var(--cable-<domain>)`, so it is a
// direct read of which palette generation the baseline was captured under.
//
//   pre-#1159 audio stripe  = amber-ish (R > B)
//   post-#1159 audio stripe = teal   #38d3c8  (B > R)
//   post-#1159 video stripe = violet #b57bff
//   post-#1159 cv/pitch     = green  #7bd66a
//   post-#1159 poly         = pink   #ff7bc2
import { readFileSync, readdirSync } from 'node:fs';
import { PNG } from 'pngjs';
import { join } from 'node:path';

const dir = process.argv[2];
const CURRENT = {
  '#38d3c8': 'audio-teal',
  '#7bd66a': 'cv-green',
  '#9be08a': 'pitch-lgreen',
  '#f2c14e': 'gate-amber',
  '#b57bff': 'video-violet',
  '#c99bff': 'image-lviolet',
  '#a56bf0': 'monovideo-violet',
  '#ff7bc2': 'poly-pink',
  '#ff9dd4': 'keys-lpink',
};
const hex = (r, g, b) =>
  '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

function nearest(r, g, b) {
  let best = null, bd = 1e9;
  for (const k of Object.keys(CURRENT)) {
    const R = parseInt(k.slice(1, 3), 16), G = parseInt(k.slice(3, 5), 16), B = parseInt(k.slice(5, 7), 16);
    const d = (R - r) ** 2 + (G - g) ** 2 + (B - b) ** 2;
    if (d < bd) { bd = d; best = k; }
  }
  return { key: best, dist: Math.sqrt(bd) };
}

const rows = [];
for (const f of readdirSync(dir).filter((n) => n.endsWith('.png')).sort()) {
  const p = PNG.sync.read(readFileSync(join(dir, f)));
  // The stripe sits just inside the 1px card border, 2px tall. Sample the
  // brightest-chroma row among y=0..4 at mid-width.
  const x = p.width >> 1;
  let best = null;
  for (let y = 0; y < Math.min(6, p.height); y++) {
    const i = (p.width * y + x) << 2;
    const r = p.data[i], g = p.data[i + 1], b = p.data[i + 2];
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (!best || chroma > best.chroma) best = { y, r, g, b, chroma };
  }
  if (!best || best.chroma < 30) {
    rows.push({ f, note: 'no chromatic stripe row found (masked / no stripe)' });
    continue;
  }
  const n = nearest(best.r, best.g, best.b);
  rows.push({
    f,
    hex: hex(best.r, best.g, best.b),
    y: best.y,
    match: n.dist < 24 ? CURRENT[n.key] : `OFF-PALETTE (nearest ${CURRENT[n.key]} @ d=${n.dist.toFixed(0)})`,
    stale: n.dist >= 24,
  });
}
const stale = rows.filter((r) => r.stale);
for (const r of rows) {
  if (r.note) continue;
  console.log(`${r.stale ? 'STALE ' : '  ok  '} ${r.f.padEnd(28)} y=${r.y} ${r.hex}  ${r.match}`);
}
console.log(`\n${rows.filter((r) => !r.note).length} probed, ${stale.length} OFF the current cable palette`);
