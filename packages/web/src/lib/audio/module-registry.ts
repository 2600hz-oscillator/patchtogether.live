// packages/web/src/lib/audio/module-registry.ts
//
// Registry of ModuleDefs keyed by ModuleType. Each module def declares its
// domain (D18), ports, params, and a factory that materializes an instance.
//
// Module defs auto-register from `./modules/index.ts` on first import.

import type { ModuleDef, ModuleType, ParamDef, PortDef, Domain } from '$lib/graph/types';
import type { AudioModuleFactory } from './engine';

/** Audio-domain module def carries an audio factory. */
export interface AudioModuleDef {
  type: ModuleType;
  domain: 'audio';
  label: string;
  category: string;
  inputs: PortDef[];
  outputs: PortDef[];
  params: readonly ParamDef[];
  schemaVersion: number;
  migrate?: (data: unknown, fromVersion: number) => unknown;
  factory: AudioModuleFactory;
}

/** Discriminated union; future video module defs add another arm. */
export type AnyModuleDef = AudioModuleDef;

const registry = new Map<ModuleType, AnyModuleDef>();

export function registerModule(def: AnyModuleDef): void {
  if (registry.has(def.type)) {
    console.warn(`[module-registry] re-registering ${def.type}`);
  }
  registry.set(def.type, def);
}

export function getModuleDef(type: ModuleType): AnyModuleDef | undefined {
  return registry.get(type);
}

export function listModuleDefs(): AnyModuleDef[] {
  return [...registry.values()];
}

export function listModuleDefsByCategory(): Record<string, AnyModuleDef[]> {
  const out: Record<string, AnyModuleDef[]> = {};
  for (const def of registry.values()) {
    (out[def.category] ??= []).push(def);
  }
  return out;
}

// Re-export type helpers for ergonomics.
export type { Domain, ModuleDef };
