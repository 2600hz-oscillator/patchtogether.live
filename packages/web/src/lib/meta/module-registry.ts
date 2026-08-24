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
   * THE CURATED FACEPLATE. Declared for parity with AudioModuleDef /
   * VideoModuleDef — AUTHORING ONE **IS** PROMOTION to STRICT_FACES, exactly
   * as it is for the other two registries.
   *
   * ⚠ WHY THIS ARRIVED LATE, AND WHY NOTHING WAS RED WHILE IT WAS MISSING.
   * `noUserControl` above was already added "so the face lints can read
   * `def.noUserControl` uniformly across all three registries" — the meta
   * registry had been extended for the face system's benefit by somebody
   * thinking about the face lints, and it stopped one field short of the field
   * that lets a meta module HAVE a face. `svelte-check` refuses `face:` on a
   * meta def outright, so no meta module could be promoted however good its
   * design; and the promotion anchor (module-face-lint.test.ts, "every module
   * that declares a `face` is in STRICT_FACES") reads
   * `def.face && !STRICT_FACES.has(def.type)`, which for a meta def is
   * `undefined && …` — PERMANENTLY FALSE. A whole DOMAIN sat outside the face
   * system with every gate green: the exact "what is this gate structurally
   * unable to see, and would its green run look any different if the answer
   * were 'everything'?" shape.
   *
   * `meta-face-precursor.test.ts` is the negative control that keeps this from
   * landing as a decorative type change — it drives a fixture meta def in BOTH
   * directions through `listMetaModuleDefs()` and the anchor's own predicate.
   *
   * ⚠ THERE IS DELIBERATELY NO `docs?` FIELD BESIDE THIS ONE, and adding one is
   * a SEPARATE decision with a coupling that must land in the same diff — see
   * the note in `$lib/docs/strict-docs.ts` above the matrixMix line. In short:
   * `module-manifest.ts` globs `../audio/modules/*.ts` + `../video/modules/*.ts`
   * and has NO meta glob, so a meta `docs` field would be authored into a
   * manifest that never reads it; and `e2e/tests/module-annotate.spec.ts` uses
   * matrixMix as its "undocumented module" fixture, protected today by the
   * mechanical impossibility of documenting a meta def rather than by anyone's
   * restraint. Adding `docs?` removes that protection and must re-point the
   * fixture in the same commit.
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
