// Lush Garden atlas de-boxing v2.
// v1 missed most plates: Wikimedia scans ship with a 1-2px TRANSPARENT margin,
// so a border-ring "needs keying?" test says no while the full cream/dark card
// sits just inside. v2: BFS the transparent MOAT from the border, take the
// opaque FRONTIER adjacent to it; if the frontier is color-uniform it IS a
// backdrop -> flood it away (tolerance vs frontier median). Then drop small
// disconnected components (floating kanji captions / plate specks). Keep a
// genuine cutout untouched (frontier variance high -> skip).
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// Usage: node scripts/lushgarden-dekey.cjs <inAtlasDir> <outAtlasDir>
// (run from the repo root so the hoisted `sharp` resolves)
const IN = process.argv[2];
const OUT = process.argv[3];
if (!IN || !OUT) { console.error('usage: node scripts/lushgarden-dekey.cjs <in> <out>'); process.exit(1); }
const ROOT = path.dirname(OUT);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const manifest = JSON.parse(fs.readFileSync(path.join(IN, 'manifest.json'), 'utf8'));
const A_TH = 20; // alpha below this = transparent

function median(arr) { const s = [...arr].sort((a, b) => a - b); return s[(s.length / 2) | 0]; }

function dekey(data, w, h) {
  const N = w * h;
  const alpha = (p) => data[p * 4 + 3];

  // --- 1. moat: transparent region connected to the border (also seeds ON-border opaque handling)
  const inMoat = new Uint8Array(N);
  const q = [];
  const pushMoat = (p) => { if (!inMoat[p] && alpha(p) < A_TH) { inMoat[p] = 1; q.push(p); } };
  for (let x = 0; x < w; x++) { pushMoat(x); pushMoat((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { pushMoat(y * w); pushMoat(y * w + w - 1); }
  while (q.length) {
    const p = q.pop(); const x = p % w, y = (p / w) | 0;
    if (x > 0) pushMoat(p - 1); if (x < w - 1) pushMoat(p + 1);
    if (y > 0) pushMoat(p - w); if (y < h - 1) pushMoat(p + w);
  }

  // --- 2. frontier: opaque pixels on the border or adjacent to the moat
  const frontier = [];
  for (let p = 0; p < N; p++) {
    if (alpha(p) < A_TH) continue;
    const x = p % w, y = (p / w) | 0;
    const onBorder = x === 0 || y === 0 || x === w - 1 || y === h - 1;
    const nearMoat = (x > 0 && inMoat[p - 1]) || (x < w - 1 && inMoat[p + 1]) ||
                     (y > 0 && inMoat[p - w]) || (y < h - 1 && inMoat[p + w]);
    if (onBorder || nearMoat) frontier.push(p);
  }
  if (frontier.length < N * 0.002 || frontier.length < 40) return { keyed: false };

  // --- 3. uniform frontier = backdrop; varied frontier = genuine cutout edge
  const rs = frontier.map((p) => data[p * 4]), gs = frontier.map((p) => data[p * 4 + 1]), bs = frontier.map((p) => data[p * 4 + 2]);
  const mr = median(rs), mg = median(gs), mb = median(bs);
  const dev = frontier.reduce((a, p) => {
    const dr = data[p * 4] - mr, dg = data[p * 4 + 1] - mg, db = data[p * 4 + 2] - mb;
    return a + Math.sqrt(dr * dr + dg * dg + db * db);
  }, 0) / frontier.length;
  if (dev > 48) return { keyed: false }; // frontier is plant matter, not a card

  // --- 4. flood the backdrop from the frontier
  const TOL = 54;
  const near = (p) => {
    const dr = data[p * 4] - mr, dg = data[p * 4 + 1] - mg, db = data[p * 4 + 2] - mb;
    return Math.sqrt(dr * dr + dg * dg + db * db) < TOL;
  };
  const removed = new Uint8Array(N);
  const q2 = [];
  for (const p of frontier) if (near(p)) { removed[p] = 1; q2.push(p); }
  while (q2.length) {
    const p = q2.pop(); const x = p % w, y = (p / w) | 0;
    for (const np of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
      if (np < 0 || removed[np] || inMoat[np] || alpha(np) < A_TH || !near(np)) continue;
      removed[np] = 1; q2.push(np);
    }
  }
  for (let p = 0; p < N; p++) if (removed[p]) data[p * 4 + 3] = 0;

  // --- 5. component cleanup: drop floating caption glyphs / specks / frames
  cleanupComponents(data, w, h);

  // --- 6. 1px feather along the new cut
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (alpha(p) < A_TH) continue;
    const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
    if (nb.some((np) => np >= 0 && removed[np])) data[p * 4 + 3] = Math.min(data[p * 4 + 3], 128);
  }
  return { keyed: true };
}

/** Boxiness: fraction of the opaque-bbox perimeter that is opaque. A card
 *  touches ~100% of its bbox perimeter; a plant only tangent points. */
function metrics(data, w, h) {
  let minX = w, minY = h, maxX = -1, maxY = -1, cov = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[(y * w + x) * 4 + 3] > 25) {
      cov++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { cov: 0, perim: 0, fill: 0 };
  let per = 0, tot = 0;
  for (let x = minX; x <= maxX; x++) { tot += 2; if (data[(minY * w + x) * 4 + 3] > 25) per++; if (data[(maxY * w + x) * 4 + 3] > 25) per++; }
  for (let y = minY; y <= maxY; y++) { tot += 2; if (data[(y * w + minX) * 4 + 3] > 25) per++; if (data[(y * w + maxX) * 4 + 3] > 25) per++; }
  return { cov: cov / (w * h), perim: per / tot, fill: cov / ((maxX - minX + 1) * (maxY - minY + 1)) };
}

/** Fallback for frame-line cards the flood can't enter: key the image's MODE
 *  color globally (no connectivity), then rely on component cleanup to sweep
 *  frame-line remnants + captions. Only ever called on a still-boxy image, so
 *  a genuine cutout can't be hit. */
function globalModeKey(data, w, h) {
  const N = w * h;
  const hist = new Map();
  for (let p = 0; p < N; p++) {
    if (data[p * 4 + 3] < A_TH) continue;
    const k = ((data[p * 4] >> 3) << 10) | ((data[p * 4 + 1] >> 3) << 5) | (data[p * 4 + 2] >> 3);
    hist.set(k, (hist.get(k) || 0) + 1);
  }
  let mk = -1, mc = 0;
  for (const [k, c] of hist) if (c > mc) { mc = c; mk = k; }
  if (mk < 0) return;
  const mr = ((mk >> 10) << 3) + 4, mg = (((mk >> 5) & 31) << 3) + 4, mb = ((mk & 31) << 3) + 4;
  const TOL = 56;
  for (let p = 0; p < N; p++) {
    if (data[p * 4 + 3] < A_TH) continue;
    const dr = data[p * 4] - mr, dg = data[p * 4 + 1] - mg, db = data[p * 4 + 2] - mb;
    if (Math.sqrt(dr * dr + dg * dg + db * db) < TOL) data[p * 4 + 3] = 0;
  }
  cleanupComponents(data, w, h);
}

function cleanupComponents(data, w, h) {
  const N = w * h;
  const comp = new Int32Array(N).fill(-1);
  const stats = []; // {area, minX, minY, maxX, maxY}
  for (let p0 = 0; p0 < N; p0++) {
    if (data[p0 * 4 + 3] < A_TH || comp[p0] >= 0) continue;
    const id = stats.length;
    const s = { area: 0, minX: w, minY: h, maxX: 0, maxY: 0 };
    const st = [p0]; comp[p0] = id;
    while (st.length) {
      const p = st.pop(); s.area++;
      const x = p % w, y = (p / w) | 0;
      if (x < s.minX) s.minX = x; if (x > s.maxX) s.maxX = x;
      if (y < s.minY) s.minY = y; if (y > s.maxY) s.maxY = y;
      for (const np of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (np < 0 || comp[np] >= 0 || data[np * 4 + 3] < A_TH) continue;
        comp[np] = id; st.push(np);
      }
    }
    stats.push(s);
  }
  // A hollow FRAME/ring: bbox spans most of the image but the component fills
  // almost none of its own bbox. Drop those before the size filter so a frame
  // can't masquerade as the "largest" component.
  const isRing = stats.map((s) => {
    const bb = (s.maxX - s.minX + 1) * (s.maxY - s.minY + 1);
    return bb > 0.55 * N && s.area / bb < 0.18;
  });
  const largest = Math.max(0, ...stats.map((s, i) => (isRing[i] ? 0 : s.area)));
  const keep = stats.map((s, i) => !isRing[i] && s.area >= Math.max(120, largest * 0.08));
  for (let p = 0; p < N; p++) if (comp[p] >= 0 && !keep[comp[p]]) data[p * 4 + 3] = 0;
}

// Hand-curated denials: art drawn INTO the plate frame (Morning Glory woodblock
// series / Riley book pages) or photo cutouts with un-keyable white wedges —
// visually boxy in-garden even where the metrics pass.
const DENY = new Set(['flower-025', 'flower-063', 'flower-074', 'flower-076', 'flower-077', 'flower-098', 'flower-099', 'flower-085', 'flower-086', 'flower-093', 'tree-004', 'tree-009', 'tree-016']);

(async () => {
  const out = []; const dropped = []; let keyedCount = 0, rescued = 0;
  for (const e of manifest) {
    if (DENY.has(e.id)) { dropped.push({ id: e.id, deny: true }); continue; }
    const { data, info } = await sharp(path.join(IN, e.file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const r = dekey(data, info.width, info.height);
    if (r.keyed) keyedCount++;
    let m = metrics(data, info.width, info.height);
    if ((m.perim > 0.55 || m.fill > 0.85) && m.cov > 0.3) {
      globalModeKey(data, info.width, info.height);
      const m2 = metrics(data, info.width, info.height);
      if (m2.perim <= 0.55 && m2.fill <= 0.85 && m2.cov >= 0.04) rescued++;
      m = m2;
    }
    if (m.perim > 0.55 || m.fill > 0.85 || m.cov < 0.04) { dropped.push({ id: e.id, perim: +m.perim.toFixed(2), fill: +m.fill.toFixed(2), cov: +m.cov.toFixed(2) }); continue; }
    const buf = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
      .png({ palette: true, colors: 192, compressionLevel: 9, effort: 7 }).toBuffer();
    fs.writeFileSync(path.join(OUT, e.file), buf);
    const { borderBefore, borderAfter, ...clean } = e;
    out.push({ ...clean, alpha: true, matte: 'none', bytes: buf.length, coverage: +m.cov.toFixed(3) });
  }
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(out, null, 1));
  fs.copyFileSync(path.join(IN, 'ATTRIBUTION.md'), path.join(OUT, 'ATTRIBUTION.md'));
  const total = out.reduce((a, e) => a + e.bytes, 0);
  const counts = out.reduce((a, e) => ((a[e.kind] = (a[e.kind] || 0) + 1), a), {});
  console.log('KEPT', JSON.stringify(counts), out.length, `(${(total / 1e6).toFixed(2)}MB)`);
  console.log('KEYED', keyedCount, 'of', manifest.length);
  console.log('DROPPED', dropped.length, JSON.stringify(dropped));

  const cell = 96, cols = 12, rows = Math.ceil(out.length / cols);
  const composites = [];
  for (let i = 0; i < out.length; i++) {
    const t = await sharp(path.join(OUT, out[i].file)).resize(cell - 6, cell - 6, { fit: 'inside' }).png().toBuffer();
    composites.push({ input: t, left: (i % cols) * cell + 3, top: ((i / cols) | 0) * cell + 3 });
  }
  await sharp({ create: { width: cols * cell, height: rows * cell, channels: 4, background: { r: 24, g: 26, b: 30, alpha: 1 } } })
    .composite(composites).png().toFile(path.join(ROOT, 'contact-sheet.png'));
  console.log('contact sheet written');
})();
