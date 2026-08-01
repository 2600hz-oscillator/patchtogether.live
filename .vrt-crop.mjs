// Crop the top N rows of one or more PNGs and stack them, magnified, so the
// stripe colour can be JUDGED by eye rather than trusted from a scalar.
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const out = process.argv[2];
const files = process.argv.slice(3);
const ROWS = 8;
const ZOOM = 8;
const W = Math.min(...files.map((f) => PNG.sync.read(readFileSync(f)).width), 120);
const o = new PNG({ width: W * ZOOM, height: ROWS * ZOOM * files.length });
for (let fi = 0; fi < files.length; fi++) {
  const p = PNG.sync.read(readFileSync(files[fi]));
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < W; x++) {
      const s = (p.width * y + x) << 2;
      for (let dy = 0; dy < ZOOM; dy++) {
        for (let dx = 0; dx < ZOOM; dx++) {
          const oy = fi * ROWS * ZOOM + y * ZOOM + dy;
          const ox = x * ZOOM + dx;
          const d = (o.width * oy + ox) << 2;
          o.data[d] = p.data[s];
          o.data[d + 1] = p.data[s + 1];
          o.data[d + 2] = p.data[s + 2];
          o.data[d + 3] = 255;
        }
      }
    }
  }
}
writeFileSync(out, PNG.sync.write(o));
console.log(`${out}: ${files.length} strips (top ${ROWS} rows, ${ZOOM}x), order = ${files.join(' | ')}`);
