// packages/web/src/lib/carl/catalog.ts
//
// In-browser catalog adapter for Rackspace Carl. Mirrors the shape used by
// e2e/chaos/lib/catalog.ts (so the personality file can stay structurally
// identical) but builds itself from the running module registries instead
// of a page.evaluate() round trip.
//
// Why duplicate the shape instead of importing AnyModuleDef directly? Two
// reasons:
//   1. Chaos Carl's personality.ts reasons about ports/params in a
//      simplified form (no svelte component refs, no AudioParam targets);
//      keeping the same trimmed shape makes the port from chaos a copy/
//      paste rather than a rewrite.
//   2. Future video-domain or meta-domain modules slot into the same
//      reduced shape — no special-case branching in personality.ts.

import { listModuleDefs } from '$lib/audio/module-registry';

export interface CatalogPort {
  id: string;
  cableType: string;
  paramTarget?: string;
  /**
   * Declared gate/trigger semantic (PortDef.edge). Post cable-collapse the
   * cableType is `cv` for BOTH pitch and gate/trigger ports, so this is how
   * the auto-wirers (Mike/Carl) tell a gate from a pitch — a gate/trigger
   * port has `edge` set; a pitch/cv-modulation port does not.
   */
  edge?: 'trigger' | 'gate';
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
 * Modules excluded from Carl picks. Mirror of chaos's NEVER_SPAWN, kept
 * trimmed to just the audioOut singleton — every other module's reader
 * tolerates an empty `data` object (see chaos PR #150 catalog note).
 */
const NEVER_SPAWN: ReadonlySet<string> = new Set([
  'audioOut',
]);

export function isCarlSpawnable(module: CatalogModule): boolean {
  return !NEVER_SPAWN.has(module.type);
}

/**
 * Build the catalog from the in-browser audio module registry. Called
 * once per Carl session — registry is static after app boot.
 *
 * NB: video / meta modules are intentionally excluded from v1. The chaos
 * runner's catalog has the same audio-only scope; adding video modules
 * needs port/cable-compat work in the personality scorer.
 */
export function buildCatalogFromRegistry(): Catalog {
  const defs = listModuleDefs();
  return defs.map((d) => ({
    type: d.type,
    category: d.category,
    inputs: d.inputs.map((p) => ({
      id: p.id,
      cableType: p.type,
      paramTarget: p.paramTarget,
      edge: p.edge,
    })),
    outputs: d.outputs.map((p) => ({
      id: p.id,
      cableType: p.type,
      edge: p.edge,
    })),
    params: d.params.map((p) => ({
      id: p.id,
      min: p.min,
      max: p.max,
      defaultValue: p.defaultValue,
    })),
  }));
}

export function getCatalogModule(catalog: Catalog, type: string): CatalogModule | undefined {
  return catalog.find((m) => m.type === type);
}
