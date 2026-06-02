// packages/dsp/scripts/worklet-sha.mjs
//
// Shared, dependency-free helper for the worklet SHA pin.
//
// Worklet entries (packages/dsp/src/*.ts) are bundled by esbuild, which INLINES
// their relative `./lib/*` imports into dist/<name>.js. So the SHA pin must hash
// the entry AND every inlined lib file — otherwise a DSP change in lib/ (e.g.
// cube-dsp.ts's FOLD) leaves the entry source unchanged and the pin passes
// STALE while the bundled audio actually changed.
//
// Both the build (build.mjs:buildTs) and ART (art/setup/render.ts:
// moduleSourceSha) import this so the built .sha and ART's expected SHA agree.
// Keep it free of heavy deps (no esbuild / faustwasm) — render.ts imports it.

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname, basename } from 'node:path';

const RELATIVE_IMPORT = /from\s+['"](\.[^'"]+)['"]/g;

/**
 * Concatenate a worklet entry's source with every transitive relative `./lib/*`
 * import source. Entry first (so a stable head), then the rest sorted by path
 * tag for order-independence. Non-.ts imports (assets/json) are skipped — esbuild
 * handles those itself and they don't carry DSP logic.
 */
export async function combinedWorkletSource(entryPath) {
  const seen = new Set();
  const parts = [];
  async function visit(absPath) {
    let resolved = absPath;
    if (!resolved.endsWith('.ts')) resolved = `${resolved}.ts`;
    if (seen.has(resolved)) return;
    seen.add(resolved);
    let source;
    try {
      source = await readFile(resolved, 'utf8');
    } catch {
      return; // non-.ts import — skip
    }
    parts.push(`/* ${basename(dirname(resolved))}/${basename(resolved)} */\n${source}`);
    const dir = dirname(resolved);
    let m;
    while ((m = RELATIVE_IMPORT.exec(source)) !== null) {
      await visit(join(dir, m[1]));
    }
  }
  await visit(entryPath);
  const [head, ...rest] = parts;
  rest.sort();
  return [head, ...rest].join('\n');
}

/** Short (16-hex) SHA-256, matching build.mjs's shortSha. */
export function shortSha(str) {
  return createHash('sha256').update(str).digest('hex').slice(0, 16);
}
