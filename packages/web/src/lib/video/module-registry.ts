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
// docs-hash-ignore:start  -- living-docs types; excluded from the attest hash so doc authoring is hash-neutral
import type { ControlFamily, ModuleDocs } from '$lib/graph/types';
// docs-hash-ignore:end
import type { VideoModuleFactory } from './engine';
import type { PaletteCategory } from '$lib/audio/module-registry';

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
  // docs-hash-ignore:start
  /** Living-docs: co-located AUTHORED prose. See ModuleDocs (audio side). */
  docs?: ModuleDocs;
  /** Living-docs: dynamic DOM-only control families. See ControlFamily. */
  controlFamilies?: readonly ControlFamily[];
  // docs-hash-ignore:end
  factory: VideoModuleFactory;
  /** Optional hard cap on simultaneous instances (mirrors the audio side).
   *  Phase 0 modules don't enforce caps; Phase 1's INWARDS will (one
   *  webcam-using module max by default to avoid getUserMedia conflicts). */
  maxInstances?: number;
  /** Owner-only instantiation: when set, only the rack OWNER may ADD this
   *  module to the rack (the palette hides it for non-owners + the spawn path
   *  refuses). DOOM sets this (round 5: host-only widget) — its multiplayer
   *  flow is "owner adds DOOM → starts a game → guests one-click hot-join", so
   *  a non-owner spawning their own DOOM node makes no sense in the one-shared-
   *  node model. Single-user / no-provider racks have a sole de-facto owner, so
   *  the gate only blocks an EXPLICIT non-owner (see canAddModule in
   *  $lib/doom/doom-gating). */
  ownerOnly?: boolean;
  /** Mirror of AudioModuleDef.undeletable — see that comment. No video
   *  module sets this today; the field is on this type so Canvas's
   *  union-typed defLookup can read `def.undeletable` without a
   *  per-domain branch. */
  undeletable?: boolean;
  /**
   * Module-grouping Phase 3A: see {@link AudioModuleDef#vizPassthrough}.
   * When set, this module renders an on-card visualization that can be
   * portaled into the parent GroupCard. No video modules opt in yet — the
   * flag exists here so cross-domain GroupCard projection can treat audio
   * + video viz uniformly when future video modules adopt it.
   */
  vizPassthrough?: boolean;
  /** Palette classification — see {@link PaletteCategory}. Omitted =
   *  Uncategorized. Lets a video module classify itself with no edit to the
   *  shared module-categories map. */
  palette?: PaletteCategory;
  /** Card-component basename override (no '.svelte'). Only needed when the
   *  `PascalCase(type)+'Card'` convention doesn't match the filename. */
  card?: string;
  /**
   * Fix E (offscreen-canvas render worker) — where this module's GL compute
   * runs. Defaults to `'main'` (the existing in-thread VideoEngine path, used
   * by every module). A module marked `'worker'` is a candidate to render in
   * the off-main-thread render worker as a *texture co-processor*: when the
   * `VITE_VIDEO_WORKER` flag is on AND the runtime supports worker WebGL2, the
   * VideoEngine installs a {@link WorkerProxyHandle} for it instead of running
   * the factory in the main GL context — the worker renders the node into its
   * own FBO and copies finished frames back as transferred ImageBitmaps into a
   * main-GL texture, so downstream + previews sample it exactly like a normal
   * node. With the flag OFF (the prod default) OR worker-unsupported, the
   * module renders on the main engine exactly as today — byte-identical.
   *
   * ONLY pure-GL, DOM-free factories are eligible (the worker has no DOM and
   * no AudioContext). See `.myrobots/plans/fixe-offscreen-canvas-plan-*.md`.
   */
  renderLocus?: 'main' | 'worker';
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
