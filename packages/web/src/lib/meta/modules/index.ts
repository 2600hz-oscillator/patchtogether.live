// packages/web/src/lib/meta/modules/index.ts
//
// Auto-registers EVERY meta-domain module on first import — GLOB-DRIVEN.
// Symmetric with the audio + video barrels.
//
// Adding a meta module no longer requires editing this file: drop a new
// `packages/web/src/lib/meta/modules/<name>.ts` exporting a
// `<name>Def: MetaModuleDef` (domain 'meta', no engine factory) and it is
// picked up automatically via Vite's `import.meta.glob`.

import { registerMetaModule, type MetaModuleDef } from '$lib/meta/module-registry';
import { exposeModuleSpecsForTests } from '$lib/dev/module-specs';

// `!` patterns exclude `*.test.ts` (whose top-level describe()/it() must not
// be re-registered via this side-effect import) and the index barrel itself.
const MODULE_MODULES = import.meta.glob<Record<string, unknown>>(
  ['./*.ts', '!./*.test.ts', '!./index.ts'],
  { eager: true },
);

/** Meta defs carry NO engine factory (the reconciler skips domain==='meta'),
 *  so we discriminate on `domain === 'meta'` + a string `type`. */
function looksLikeMetaDef(v: unknown): v is MetaModuleDef {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.type !== 'string') return false;
  return o.domain === 'meta';
}

/** Collect every meta def, deduped by type, sorted by type id. */
export function collectMetaDefs(): MetaModuleDef[] {
  const byType = new Map<string, MetaModuleDef>();
  for (const mod of Object.values(MODULE_MODULES)) {
    for (const [exportName, value] of Object.entries(mod)) {
      if (!exportName.endsWith('Def')) continue;
      if (!looksLikeMetaDef(value)) continue;
      if (!byType.has(value.type)) byType.set(value.type, value);
    }
  }
  return [...byType.values()].sort((a, b) => a.type.localeCompare(b.type));
}

let registered = false;

export function registerMetaModules(): void {
  if (registered) return;
  registered = true;
  for (const def of collectMetaDefs()) {
    registerMetaModule(def);
  }
  // Refresh the published spec snapshot so window.__moduleSpecs picks up the
  // meta defs the same way the audio + video barrels do.
  exposeModuleSpecsForTests();
}

registerMetaModules();
