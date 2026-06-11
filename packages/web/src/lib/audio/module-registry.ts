// packages/web/src/lib/audio/module-registry.ts
//
// Registry of ModuleDefs keyed by ModuleType. Each module def declares its
// domain (D18), ports, params, and a factory that materializes an instance.
//
// Module defs auto-register from `./modules/index.ts` on first import.

import type { ModuleDef, ModuleType, ParamDef, PortDef, Domain } from '$lib/graph/types';
import type { AudioModuleFactory } from './engine';

/**
 * Palette classification — the nested "Add module" picker grouping. Lives on
 * the def so adding a module needs NO edit to the shared module-categories
 * map (that append-edit was a top cross-PR conflict source). `top` is the
 * top-level palette row, `sub` the sub-folder within it. When omitted, the
 * module falls into the "Uncategorized" bucket (and the categories unit test
 * nudges the contributor to classify it). See $lib/ui/module-categories.ts.
 */
export interface PaletteCategory {
  top: string;
  sub: string;
}

/**
 * Module-grouping Phase 4 — exposed controls.
 *
 * A module declares its "exposable" controls so a containing group can opt
 * into surfacing them on the group's bar. Buttons (e.g. sequencer play/stop)
 * and knobs (e.g. TIMELORDE rate/swing) are the v1 kinds. The id is a stable
 * key the user-side group config saves; `paramId` names the underlying
 * number param the control writes to. Buttons read/write the same param as
 * a 0/1 toggle (>=0.5 = on); knobs reuse the same min/max/curve as the
 * ParamDef on the def.
 */
export interface ExposableControl {
  /** Stable id, unique within a single module def. Used as the key in
   *  GroupData.exposedControls entries; rename = data migration. */
  id: string;
  /** Display label shown next to the control on the group's bar. */
  label: string;
  /** What primitive renders this control. v1: 'button' or 'knob'. */
  kind: 'button' | 'knob';
  /** The underlying param this control reads/writes. Must reference an
   *  entry in this def's `params` array. */
  paramId: string;
}

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
   * When true, the canvas refuses to delete this module — singleton
   * "anchor" modules (TIMELORDE = the rack's system clock) MUST exist
   * for the rest of the rack to be coherent. Gate the delete affordance
   * on this in Canvas.svelte's deleteNode + the right-click "Delete"
   * entry. Defensive: even if a stray code path calls deleteNode on an
   * undeletable, the engine continues to function (the module just
   * comes back on next refresh via the rack-init auto-spawn path).
   */
  undeletable?: boolean;
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
   * Other viz-capable modules (wavviz, swolevco, warrenspectrum, …) leave
   * this UNSET for now; once their cards stabilize their canvas DOM
   * contract the flag flips on without further plumbing.
   */
  vizPassthrough?: boolean;
  /**
   * WebGL-attestation marker (semaphore scheme). When true, this AUDIO-domain
   * module's card renders via a real WebGL/WebGL2 context (CUBE / HYPERCUBE /
   * WAVESCULPT) — i.e. it is a GPU render path even though it lives in the
   * audio registry. The §12 coverage guard reads this flag to mechanically
   * include the module's source in the WebGL content-hash basis (instead of a
   * hand-maintained list), and CROSS-CHECKS it against a grep of the card
   * source for `getContext('webgl')` so the flag can't silently drift away from
   * reality (a flagged def whose card no longer renders WebGL, or a WebGL card
   * whose def forgot the flag, both fail the guard). Video-domain modules don't
   * need this — they are derived from `domain:'video'`. See
   * .myrobots/plans/webgl-attestation-semaphore.md (§-1 fix V3).
   */
  rendersWebGL?: boolean;
  /**
   * Attribution for modules that are direct ports of MIT-licensed open-source
   * DSP code. Rendered as a subdued disclaimer at the bottom of the module
   * card via <OssAttribution>. Set ONLY when the module's DSP/algorithm code
   * is a port of an upstream OSS project — modules merely "inspired by" or
   * named after an upstream module (no shared algorithm code) should NOT
   * carry this attribution. See packages/dsp/src/*.ts header comments for
   * the canonical port-vs-from-spec distinction.
   */
  ossAttribution?: { author: string };
  /**
   * Module-grouping Phase 4 — the set of controls a containing GROUP! can
   * opt into surfacing on its bar. When omitted/empty, the module has no
   * group-exposable controls (its UI lives entirely on its own card).
   * v1 coverage: sequencer play/stop + TIMELORDE knobs.
   */
  exposableControls?: readonly ExposableControl[];
  /**
   * Instruments v1 — atomic sequencer/score exposure marker. When true the
   * containing Instrument can show the FULL step-grid / score sheet as one
   * checkbox in the configure modal ("Show step sequence" / "Show score").
   * Per the spec: no partial exposure (no "show just step 5"). Other knobs
   * on the same module remain individually exposable via `exposableControls`.
   *
   * Set on: drumseqz, polyseqz, macseq, sequencer, score.
   */
  exposesSequence?: boolean;
  /**
   * Palette classification (nested Add-module picker grouping). Declared here
   * so the def is the single source of truth — no edit to the shared
   * module-categories map required. Omitted = Uncategorized.
   */
  palette?: PaletteCategory;
  /**
   * Card-component basename override (no '.svelte'), e.g. 'AudioinCard'.
   * ONLY needed when the default convention `PascalCase(type)+'Card'` doesn't
   * match the actual component filename. Resolved by $lib/ui/modules-card-map.
   */
  card?: string;
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
