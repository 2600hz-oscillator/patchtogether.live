import { readFileSync } from 'node:fs';
const log = readFileSync(process.argv[2], 'utf8');
const re = /✓\s+\d+\s+\[chromium-vrt\]\s+›\s+(\S+):\d+:\d+\s+›\s+.*?›\s+(.*?)\s+\((\d+(?:\.\d+)?)(m?s)\)\s*$/;
const rows = [];
for (const line of log.split('\n')) {
  const m = re.exec(line.replace(/\r$/, ''));
  if (!m) continue;
  const [, file, title, n, unit] = m;
  rows.push({ file, title, sec: unit === 'ms' ? Number(n) / 1000 : Number(n) });
}
const byFile = {};
for (const r of rows) byFile[r.file] = (byFile[r.file] ?? 0) + r.sec;
console.log('tests', rows.length, 'total', rows.reduce((a, b) => a + b.sec, 0).toFixed(1) + 's');
console.log(byFile);
console.log(JSON.stringify(rows.map((r) => [r.file, r.title, r.sec])));
