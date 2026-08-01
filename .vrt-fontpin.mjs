// One-shot codemod: add pinVrtFonts/awaitVrtFonts around every `page.goto`
// + `waitForLoadState('networkidle')` pair in the listed VRT specs.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = new URL('./e2e/vrt/', import.meta.url).pathname;

const FILES = [
  'cellshade-composite.spec.ts',
  'interactions.spec.ts',
  'cube-adsr-composite.spec.ts',
  'groups.spec.ts',
  'playhead.spec.ts',
  'mirrorpool-composite.spec.ts',
  'vrt-clap.spec.ts',
  'vrt-colourofmagic.spec.ts',
  'vrt-karplus-tomtom-states.spec.ts',
  'pentemelodica-composite.spec.ts',
  'vrt-composite.spec.ts',
  'vrt-scope-modes.spec.ts',
  'vrt-synesthesia-video.spec.ts',
  'vrt-wavesculpt-walls.spec.ts',
  'vrt-tidy-vco.spec.ts',
  'vrt-posterbox-states.spec.ts',
  'vrt-quadralogical.spec.ts',
  'vrt-toybox.spec.ts',
  'vrt-synesthesia-composite.spec.ts',
  'vrt-wavesculpt-blink.spec.ts',
];

let totalSites = 0;
for (const f of FILES) {
  const p = join(DIR, f);
  let src = readFileSync(p, 'utf8');
  if (src.includes('awaitVrtFonts')) {
    console.log(`SKIP (already pinned): ${f}`);
    continue;
  }

  const lines = src.split('\n');
  const out = [];
  let sites = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const gotoM = /^(\s*)await page\.goto\(/.exec(line);
    const nextIsSettle =
      lines[i + 1] !== undefined &&
      /^\s*await page\.waitForLoadState\('networkidle'\);\s*$/.test(lines[i + 1]);
    if (gotoM && nextIsSettle) {
      const ind = gotoM[1];
      // Pin BEFORE navigation (addInitScript → the @font-face lands before
      // first paint), await AFTER the load settles (faces decoded + applied).
      out.push(`${ind}await pinVrtFonts(page);`);
      out.push(line);
      out.push(lines[i + 1]);
      out.push(`${ind}await awaitVrtFonts(page);`);
      i++; // consumed the waitForLoadState line
      sites++;
      continue;
    }
    out.push(line);
  }
  if (sites === 0) {
    console.log(`!! NO SITES: ${f}`);
    continue;
  }
  src = out.join('\n');

  // Insert the import right after the LAST top-level import line.
  const importLines = [...src.matchAll(/^import .*?;$/gms)];
  const last = importLines[importLines.length - 1];
  const at = last.index + last[0].length;
  src = src.slice(0, at) + `\nimport { pinVrtFonts, awaitVrtFonts } from './_fonts';` + src.slice(at);

  writeFileSync(p, src);
  totalSites += sites;
  console.log(`${f}: ${sites} nav site(s)`);
}
console.log(`\nTOTAL nav sites patched: ${totalSites}`);
