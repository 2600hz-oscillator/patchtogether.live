// Registry for "meta" domain modules — cards that live in the patch graph
// but DO NOT bind to any engine (no audio nodes, no video FBOs). The first
// inhabitant is STICKY (paper-style sticky note). The reconciler skips
// any node whose domain === 'meta' so these defs intentionally carry no
// factory.
//
// Kept separate from the audio + video registries because those carry
// engine-factory shape; meta defs share only the palette/persistence
// surface (label, category, ports).

import type {
  ModuleType,
  PortDef,
  ParamDef,
  Domain,
  RackSize,
  NoUserControlParam,
  ControlFamily,
  ModuleFace,
} from '$lib/graph/types';
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
  /** #1726 — params this module deliberately gives the player NO control over.
   *  Declared for parity with AudioModuleDef / VideoModuleDef so the face lints
   *  can read `def.noUserControl` uniformly across all three registries; no
   *  meta module declares one today (meta defs have no ports, so any entry
   *  would have to be `writer: 'internal'`). See NoUserControlParam. */
  noUserControl?: readonly NoUserControlParam[];
  /**
   * Declaring a face requires STRICT_FACES promotion, as in the audio/video
   * registries. module-face-lint tests that meta defs reach the promotion check.
   *
   * Adding docs to meta defs also requires teaching module-manifest.ts to read
   * them and replacing module-annotate.spec.ts's undocumented matrixMix fixture;
   * the manifest currently globs only audio and video defs.
   */
  face?: ModuleFace;
  /**
   * CARD CONTROLS WITH NO BACKING PARAM, declared as families so a face can
   * RANK them — the dx7 / videocube / kria convention.
   *
   * ⚠ IT IS NOT OPTIONAL DECORATION FOR THIS DOMAIN, IT IS THE ONLY ROUTE. A
   * meta def declares `params: []` BY CONSTRUCTION (no engine, no ports), so
   * every key its `face.order` can ever hold is a NON-param key — and
   * `module-face-lint` legitimizes a non-param key exactly two ways: a
   * `<familyId>-{n}` template whose prefix is a family DECLARED here, or an
   * entry in a committed `<type>.legend.json` (an annotated-VRT artifact three
   * modules have). The dock render-plan parity check independently refuses any
   * other static as "a DEAD static cell". So without this field a meta face can
   * rank NOTHING, and `face?` alone would have been a promotion route to a
   * blank tile.
   *
   * Each `testidPrefix` is asserted to appear in real card source by
   * `module-docs-lint` ("controlFamilies match the card — no drift"), which
   * already enumerates the meta registry, so a family declared here cannot
   * drift off the surface it names.
   */
  controlFamilies?: readonly ControlFamily[];
  /** Rack HEIGHT tier ('1u' | '3u') — a def-declared size WINS over the bulk
   *  RACK_SIZE_DEFAULTS map (see Canvas.svelte rackSizeByType). */
  size?: RackSize;
  /** Width in 1u square tiles (default 1) — see ModuleDef.hp. */
  hp?: number;
  maxInstances?: number;
  /** Mirror of AudioModuleDef.undeletable — no meta module sets this
   *  today; field present so Canvas's union-typed defLookup can read
   *  it uniformly. */
  undeletable?: boolean;
  /** Palette classification — see {@link PaletteCategory}. Omitted =
   *  Uncategorized. */
  palette?: PaletteCategory;
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
