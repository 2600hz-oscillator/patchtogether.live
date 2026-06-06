// packages/web/src/lib/meta/module-registry.ts
//
// Registry for "meta" domain modules — cards that live in the patch graph
// but DO NOT bind to any engine (no audio nodes, no video FBOs). The first
// inhabitant is STICKY (paper-style sticky note). The reconciler skips
// any node whose domain === 'meta' so these defs intentionally carry no
// factory.
//
// Kept separate from the audio + video registries because those carry
// engine-factory shape; meta defs share only the palette/persistence
// surface (label, category, schemaVersion, optional migrate).

import type { ModuleType, PortDef, ParamDef, Domain } from '$lib/graph/types';
import type { PaletteCategory } from '$lib/audio/module-registry';

export interface MetaModuleDef {
  type: ModuleType;
  domain: 'meta';
  label: string;
  category: string;
  /** Always empty — meta modules have no ports. Declared for parity with
   *  AudioModuleDef / VideoModuleDef so the palette + io-spec helpers can
   *  iterate uniformly. */
  inputs: PortDef[];
  outputs: PortDef[];
  params: readonly ParamDef[];
  schemaVersion: number;
  migrate?: (data: unknown, fromVersion: number) => unknown;
  maxInstances?: number;
  /** Mirror of AudioModuleDef.undeletable — no meta module sets this
   *  today; field present so Canvas's union-typed defLookup can read
   *  it uniformly. */
  undeletable?: boolean;
  /** Palette classification — see {@link PaletteCategory}. Omitted =
   *  Uncategorized. */
  palette?: PaletteCategory;
  /** Card-component basename override (no '.svelte'). Only needed when the
   *  `PascalCase(type)+'Card'` convention doesn't match the filename. */
  card?: string;
}

const registry = new Map<ModuleType, MetaModuleDef>();

export function registerMetaModule(def: MetaModuleDef): void {
  if (registry.has(def.type)) {
    console.warn(`[meta module-registry] re-registering ${String(def.type)}`);
  }
  registry.set(def.type, def);
}

export function getMetaModuleDef(type: ModuleType): MetaModuleDef | undefined {
  return registry.get(type);
}

export function listMetaModuleDefs(): MetaModuleDef[] {
  return [...registry.values()];
}

export type { Domain };
