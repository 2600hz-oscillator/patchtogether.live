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
  /**
   * Hard cap on simultaneous instances per rackspace. Singleton modules
   * (e.g. master mixer, master clock) set this to 1; omitted/undefined =
   * unlimited. Enforced at three layers: palette filter (UI), spawn guard
   * (Canvas), and engine.addNode (defensive — the only place that survives
   * multiplayer races).
   */
  maxInstances?: number;
  /**
   * Optional declaration that two ports form a stereo pair for normaling
   * purposes — when only the L side is patched, the engine virtually
   * duplicates the connection to R. Encoded as [leftPortId, rightPortId]
   * tuples. Inputs and outputs share the same set; the reconciler infers
   * direction from the port's def.
   */
  stereoPairs?: readonly (readonly [string, string])[];
  /**
   * Module-grouping Phase 3A: when set, this module renders an on-card
   * visualization (typically a <canvas>) that can be portaled into the
   * parent GroupCard so the group "becomes" the viz. SCOPE is the
   * pioneering case — the on-card 2D oscilloscope canvas is hoisted to
   * the GroupCard body when SCOPE is a member of a collapsed group.
   * Other viz-capable modules (vizvco, wavviz, swolevco, warrenspectrum,
   * wavecel, …) leave this UNSET for now; once their cards stabilize their
   * canvas DOM contract the flag flips on without further plumbing.
   */
  vizPassthrough?: boolean;
  factory: AudioModuleFactory;
}

/**
 * SyncedModuleDef — sibling subtype for time-driven modules whose state
 * derives deterministically from `(epoch, params, prng)`. Phase 0 of the
 * shared-state-sync plan; LFO is the proof-of-concept. Stateless modules
 * keep using plain AudioModuleDef.
 *
 * Implementations expose:
 *  - `computeStateAt(t_ms_since_epoch, params, prng) → state`
 *      Pure function. Two clients with the same epoch + params + prng
 *      seed call this with the same t_ms and get the same state.
 *  - `resyncOnReset` — true for modules whose worklet phase needs to be
 *      snapped back to zero on owner-driven epoch resets (LFO, sequencer).
 */
export interface SyncedModuleDef extends AudioModuleDef {
  computeStateAt(
    tMsSinceEpoch: number,
    params: Record<string, number>,
    prng: () => number,
  ): Record<string, number>;
  resyncOnReset: boolean;
}

/** Type-guard for treating an AudioModuleDef as a SyncedModuleDef. */
export function isSyncedModuleDef(def: AudioModuleDef): def is SyncedModuleDef {
  return typeof (def as Partial<SyncedModuleDef>).computeStateAt === 'function';
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
