// Module catalog for the chaos runner — populated at chaos boot by reading
// the live registry from the running browser. This eliminates drift between
// the catalog used by chaos and the registry the engine actually consults.
//
// The runner calls `loadCatalog(page)` once after `ensureEngineBooted`. From
// then on, personalities and invariants use the returned `Catalog` value.

import type { Page } from '@playwright/test';

export interface CatalogPort {
  id: string;
  cableType: string;        // 'audio' | 'cv' | 'gate' | 'pitch' (extensible)
  paramTarget?: string;
}

export interface CatalogParam {
  id: string;
  min: number;
  max: number;
  defaultValue: number;
}

export interface CatalogModule {
  type: string;
  category: string;
  inputs: CatalogPort[];
  outputs: CatalogPort[];
  params: CatalogParam[];
}

export type Catalog = readonly CatalogModule[];

/**
 * Modules excluded from chaos picks — usually because they're singletons
 * (audioOut), have side effects we don't want a fuzzer hammering, or
 * are still shaking out (drum modules with pitched gate semantics).
 *
 * Carl can still ROUTE to these (they're in the catalog) but personalities
 * filter `addNode` picks via `isChaosSpawnable`.
 */
const NEVER_SPAWN: ReadonlySet<string> = new Set([
  'audioOut',     // singleton sink; pre-spawned for tests, never random-added
  'scope',        // visualization only; chaos doesn't need to spam scopes
  'sequencer',    // its `data.steps` shape is non-trivial; defer to a later pass
  'cartesian',    // sequencer-shaped; same reason
]);

export function isChaosSpawnable(module: CatalogModule): boolean {
  return !NEVER_SPAWN.has(module.type);
}

export async function loadCatalog(page: Page): Promise<Catalog> {
  const raw = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __listModuleDefs?: () => Array<{
        type: string;
        category: string;
        inputs: Array<{ id: string; type: string; paramTarget?: string }>;
        outputs: Array<{ id: string; type: string }>;
        params: ReadonlyArray<{ id: string; min: number; max: number; defaultValue: number }>;
      }>;
    };
    if (typeof w.__listModuleDefs !== 'function') {
      throw new Error('__listModuleDefs not exposed — Canvas.svelte must register it (DEV only)');
    }
    return w.__listModuleDefs().map((d) => ({
      type: d.type,
      category: d.category,
      inputs: d.inputs.map((p) => ({ id: p.id, cableType: p.type, paramTarget: p.paramTarget })),
      outputs: d.outputs.map((p) => ({ id: p.id, cableType: p.type })),
      params: d.params.map((p) => ({ id: p.id, min: p.min, max: p.max, defaultValue: p.defaultValue })),
    }));
  });
  return raw as Catalog;
}

export function getCatalogModule(catalog: Catalog, type: string): CatalogModule | undefined {
  return catalog.find((m) => m.type === type);
}
