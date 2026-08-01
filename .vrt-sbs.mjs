// Build a BEFORE | AFTER side-by-side for one regenerated baseline so the
// change can be JUDGED, not inferred from a scalar. (The channel-spread
// heuristic is confounded by geometric shift — a coloured element moving 4px
// looks exactly like a colour change to it. Only the eye settles this.)
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { PNG } from 'pngjs';
import { join, dirname, basename } from 'node:path';

const REPO = new URL('./', import.meta.url).pathname.replace(/\/$/, '');
const rel = process.argv[2];
const out = process.argv[3] ?? '/tmp/vrtsbs/' + basename(rel);
const oldPath = join('/tmp/vrtold', rel);
mkdirSync(dirname(oldPath), { recursive: true });
mkdirSync(dirname(out), { recursive: true });
if (!existsSync(oldPath)) {
  execSync(`git show HEAD:${rel} | git lfs smudge > ${JSON.stringify(oldPath)}`, {
    cwd: REPO,
    shell: '/bin/bash',
  });
}
const a = PNG.sync.read(readFileSync(oldPath));
const b = PNG.sync.read(readFileSync(join(REPO, rel)));
const GAP = 12;
const W = a.width + GAP + b.width;
const H = Math.max(a.height, b.height);
const o = new PNG({ width: W, height: H });
o.data.fill(255);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (W * y + x) << 2;
    let src = null, sx = 0;
    if (x < a.width && y < a.height) { src = a; sx = x; }
    else if (x >= a.width + GAP && x - a.width - GAP < b.width && y < b.height) { src = b; sx = x - a.width - GAP; }
    if (src) {
      const j = (src.width * y + sx) << 2;
      o.data[i] = src.data[j];
      o.data[i + 1] = src.data[j + 1];
      o.data[i + 2] = src.data[j + 2];
      o.data[i + 3] = 255;
    } else {
      o.data[i] = 255; o.data[i + 1] = 0; o.data[i + 2] = 255; o.data[i + 3] = 255;
    }
  }
}
writeFileSync(out, PNG.sync.write(o));
console.log(`${out}  (LEFT=HEAD ${a.width}x${a.height}  RIGHT=new ${b.width}x${b.height})`);
