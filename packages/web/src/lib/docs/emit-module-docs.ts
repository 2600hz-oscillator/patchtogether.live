// packages/web/src/lib/docs/emit-module-docs.ts
//
// NODE-ONLY writer for `module-docs.generated.ts` — the render module the
// prerendered doc page (and Canvas's has-docs check) imports. The file is a
// BUILD ARTIFACT, not a committed source: it is regenerated from the live
// registry's co-located `def.docs` fields by the docs:ensure seam and is
// gitignored (see packages/web/.gitignore). The committed/PINNED artifact of
// the living-docs gate remains `contract-lock.txt` ONLY.
//
// Callers (the seams that guarantee the file exists before anything imports it):
//   - module-docs-ensure.test.ts — re-emits (write-if-changed) on every full
//     unit sweep and on every `task docs:ensure` (the dep of build /
//     build:web / dev / dev:full / typecheck).
//   - vitest.setup.docs.ts — fork-pool setupFiles fast-path: emits when the
//     artifact is MISSING, before any spec that imports it is collected.
//   - the ensureModuleDocs vite plugin (vite.config.ts) — direct `vite dev` /
//     `vite build` boots shell out to the vitest ensure spec when the file is
//     missing (fresh checkout / clean CI runner).
//
// MUST stay importable only from vitest FORK-POOL contexts (the setup file,
// the ensure spec): it uses node:fs, and the barrels' external `?url` worklet
// imports resolve in the fork pool but are DENIED in vitest globalSetup's
// vite-node context. App code imports the GENERATED file, never this.
//
// Determinism: serializeModuleDocsModule is pure over the registry (sorted
// types, sorted doc sub-keys, no timestamps) — gated by module-docs-ensure
// .test.ts, so the emit can never make two builds differ.

import { writeFileSync, readFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Side-effect barrels — register every module def before the registry read.
// Same pattern as contract-lock.test.ts / module-docs-lint.test.ts.
import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';

import { serializeModuleDocsModule } from './contract-signature';

export const MODULE_DOCS_GENERATED_PATH = fileURLToPath(
  new URL('./module-docs.generated.ts', import.meta.url),
);

/** Regenerate `module-docs.generated.ts` from the live registry.
 *  Write-if-changed (and via a same-dir temp + rename): an unchanged emit
 *  leaves the mtime alone so a watching `vite dev` doesn't reload, and a
 *  parallel reader can never observe a half-written module. */
export function emitModuleDocsModule(): { path: string; changed: boolean } {
  const content = serializeModuleDocsModule();
  let existing: string | null = null;
  try {
    existing = readFileSync(MODULE_DOCS_GENERATED_PATH, 'utf8');
  } catch {
    existing = null;
  }
  if (existing === content) return { path: MODULE_DOCS_GENERATED_PATH, changed: false };
  const tmp = `${MODULE_DOCS_GENERATED_PATH}.tmp-${process.pid}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, MODULE_DOCS_GENERATED_PATH);
  return { path: MODULE_DOCS_GENERATED_PATH, changed: true };
}
