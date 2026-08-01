// Second pass: drop a one-line rationale above the FIRST pinVrtFonts call in
// each patched spec so the call isn't cargo-cult at the read site.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = new URL('./e2e/vrt/', import.meta.url).pathname;
const COMMENT = [
  '// Pin the bundled Inter/JetBrains Mono BEFORE the first navigation and',
  '// await their decode after load — the app resolves card text through',
  '// GENERIC stacks (system-ui / ui-monospace) that fontconfig picks',
  "// nondeterministically, and document.fonts.ready can't see them. Without",
  '// this the captured text metrics differ run-to-run and platform-to-platform.',
  '// Full root cause: e2e/vrt/_fonts.ts.',
];

for (const f of readdirSync(DIR).filter((n) => n.endsWith('.spec.ts'))) {
  const p = join(DIR, f);
  const src = readFileSync(p, 'utf8');
  if (!src.includes('await pinVrtFonts(page);')) continue;
  const lines = src.split('\n');
  const idx = lines.findIndex((l) => /^\s*await pinVrtFonts\(page\);\s*$/.test(l));
  if (idx < 0) continue;
  // Already commented (vrt.spec.ts and the other pre-existing users carry
  // their own writeup) — leave them alone.
  if (lines[idx - 1].trim().startsWith('//') || lines[idx - 1].trim().startsWith('*')) {
    console.log(`SKIP (has comment): ${f}`);
    continue;
  }
  const ind = /^(\s*)/.exec(lines[idx])[1];
  lines.splice(idx, 0, ...COMMENT.map((c) => ind + c));
  writeFileSync(p, lines.join('\n'));
  console.log(`commented: ${f}`);
}
