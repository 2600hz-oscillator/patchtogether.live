// Classify every regenerated baseline: dimension change, diff magnitude, and
// WHERE the differing pixels sit. A pure font-metric shift moves TEXT rows;
// a content change moves large contiguous non-text regions or shifts hue.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { PNG } from 'pngjs';
import { join, dirname } from 'node:path';

const REPO = new URL('./', import.meta.url).pathname.replace(/\/$/, '');
const OLD = '/tmp/vrtold';
mkdirSync(OLD, { recursive: true });

const changed = execSync('git diff --name-only -- e2e/vrt/__screenshots__', {
  cwd: REPO,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\n')
  .filter(Boolean);

console.log(`regenerated baselines: ${changed.length}\n`);

const rows = [];
for (const rel of changed) {
  const oldPath = join(OLD, rel);
  mkdirSync(dirname(oldPath), { recursive: true });
  if (!existsSync(oldPath)) {
    execSync(`git show HEAD:${rel} | git lfs smudge > ${JSON.stringify(oldPath)}`, {
      cwd: REPO,
      shell: '/bin/bash',
    });
  }
  const a = PNG.sync.read(readFileSync(oldPath));
  const b = PNG.sync.read(readFileSync(join(REPO, rel)));
  if (a.width !== b.width || a.height !== b.height) {
    rows.push({ rel, kind: 'DIM', note: `${a.width}x${a.height} -> ${b.width}x${b.height}` });
    continue;
  }
  // Per-pixel diff at the gate's own per-channel threshold (0.1 → 25.5/255).
  let n = 0;
  const rowHist = new Uint32Array(a.height);
  const colHist = new Uint32Array(a.width);
  let maxChan = 0;
  let hueShift = 0; // pixels whose CHANNEL BALANCE changed (content/colour tell)
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (a.width * y + x) << 2;
      const dr = Math.abs(a.data[i] - b.data[i]);
      const dg = Math.abs(a.data[i + 1] - b.data[i + 1]);
      const db = Math.abs(a.data[i + 2] - b.data[i + 2]);
      const m = Math.max(dr, dg, db);
      if (m > 25) {
        n++;
        rowHist[y]++;
        colHist[x]++;
        if (m > maxChan) maxChan = m;
        // A text re-flow moves LUMINANCE (glyph on/off) roughly equally on all
        // channels. A genuine colour/content change moves the channels by very
        // different amounts.
        const spread = m - Math.min(dr, dg, db);
        if (spread > 40) hueShift++;
      }
    }
  }
  const total = a.width * a.height;
  const rowsHit = rowHist.filter((v) => v > 0).length;
  rows.push({
    rel,
    kind: 'PIX',
    n,
    ratio: n / total,
    dims: `${a.width}x${a.height}`,
    rowsHit,
    rowFrac: rowsHit / a.height,
    hueShift,
    hueFrac: n ? hueShift / n : 0,
    maxChan,
  });
}

rows.sort((x, y) => (y.ratio ?? 9) - (x.ratio ?? 9));
for (const r of rows) {
  if (r.kind === 'DIM') {
    console.log(`DIM-CHANGE  ${r.rel}  ${r.note}`);
  } else {
    console.log(
      `${r.rel}\n    ${r.dims}  diffPx=${r.n} (${(r.ratio * 100).toFixed(2)}% of card)  ` +
        `rowsTouched=${r.rowsHit}/${(r.rowsHit / r.rowFrac).toFixed(0)} (${(r.rowFrac * 100).toFixed(0)}%)  ` +
        `channelSpread>40: ${r.hueShift} (${(r.hueFrac * 100).toFixed(1)}% of diff px)  maxChanΔ=${r.maxChan}`,
    );
  }
}

const dim = rows.filter((r) => r.kind === 'DIM').length;
console.log(`\nsummary: ${rows.length} baselines regenerated, ${dim} with a DIMENSION change`);
writeFileSync(join(REPO, '.vrt-diffreview.json'), JSON.stringify(rows, null, 2));
