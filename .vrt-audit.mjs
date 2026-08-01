import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('./e2e/vrt/__screenshots__/', import.meta.url).pathname;
const specs = readdirSync(ROOT).sort();
const rows = [];
for (const s of specs) {
  const d = join(ROOT, s, 'darwin');
  const l = join(ROOT, s, 'linux');
  const dn = existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.png')) : [];
  const ln = existsSync(l) ? readdirSync(l).filter((f) => f.endsWith('.png')) : [];
  const onlyDarwin = dn.filter((f) => !ln.includes(f));
  const onlyLinux = ln.filter((f) => !dn.includes(f));
  rows.push({ spec: s, darwin: dn.length, linux: ln.length, onlyDarwin, onlyLinux });
}
let td = 0, tl = 0;
for (const r of rows) {
  td += r.darwin; tl += r.linux;
  const gap = r.darwin - r.linux;
  console.log(
    `${r.spec.padEnd(40)} darwin=${String(r.darwin).padStart(3)} linux=${String(r.linux).padStart(3)} gap=${String(gap).padStart(3)}`,
  );
  if (r.onlyDarwin.length && r.linux > 0)
    console.log(`    darwin-only names: ${r.onlyDarwin.join(', ')}`);
  if (r.onlyLinux.length) console.log(`    LINUX-ONLY names: ${r.onlyLinux.join(', ')}`);
}
console.log(`\nTOTAL darwin=${td} linux=${tl} gap=${td - tl}`);
