// packages/web/src/lib/video/module-registry.ts
//
// Per-domain module registry for video modules — kept SEPARATE from the
// audio registry (packages/web/src/lib/audio/module-registry.ts) so the
// two domains can't accidentally collide on type ids and so each domain
// can carry its own def shape (audio defs reference an AudioContext-bound
// factory; video defs reference a WebGL2 context-bound factory).
//
// The Canvas's palette UI listing combines BOTH registries — audio first,
// then video — so users can spawn either kind from one search box.

import type { ModuleType, PortDef, ParamDef, Domain } from '$lib/graph/types';
import type { VideoModuleFactory } from './engine';

export interface VideoModuleDef {
  type: ModuleType;
  domain: 'video';
  label: string;
  category: string;
  inputs: PortDef[];
  outputs: PortDef[];
  params: readonly ParamDef[];
  schemaVersion: number;
  migrate?: (data: unknown, fromVersion: number) => unknown;
  factory: VideoModuleFactory;
  /** Optional hard cap on simultaneous instances (mirrors the audio side).
   *  Phase 0 modules don't enforce caps; Phase 1's INWARDS will (one
   *  webcam-using module max by default to avoid getUserMedia conflicts). */
  maxInstances?: number;
  /**
   * Module-grouping Phase 3A: see {@link AudioModuleDef#vizPassthrough}.
   * When set, this module renders an on-card visualization that can be
   * portaled into the parent GroupCard. No video modules opt in yet — the
   * flag exists here so cross-domain GroupCard projection can treat audio
   * + video viz uniformly when future video modules adopt it.
   */
  vizPassthrough?: boolean;
}

const registry = new Map<ModuleType, VideoModuleDef>();

export function registerVideoModule(def: VideoModuleDef): void {
  if (registry.has(def.type)) {
    console.warn(`[video module-registry] re-registering ${String(def.type)}`);
  }
  registry.set(def.type, def);
}

export function getVideoModuleDef(type: ModuleType): VideoModuleDef | undefined {
  return registry.get(type);
}

export function listVideoModuleDefs(): VideoModuleDef[] {
  return [...registry.values()];
}

// Re-export so callers can write `import type { Domain }` from this barrel
// without crossing into graph/types directly. Mirrors the audio registry.
export type { Domain };
