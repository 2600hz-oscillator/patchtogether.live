// packages/web/src/lib/ui/module-categories.ts
//
// Classification ORDERING + grouping logic for the nested "Add module"
// palette (2-level hierarchy):
//
//   Top                    Sub                Items
//   --------------------- ------------------ ------------------------
//   Audio modules         VCOs               ANALOGVCO, WAVETABLEVCO …
//                         Utility            ADSR, VCA, CARTESIAN …
//                         Effects            REVERB, CHARLOTTESECHOS …
//                         Mixing             MIXER, MIXMSTRS …
//                         End of chain       AUDIOOUT
//   Video modules         Sources            LINES, CAMERA, SHAPES …
//                         Processors         CHROMA, LUMA, COLORIZER …
//                         Utilities          V-MIXER, OUTPUT …
//   Hybrid                — (flat)           SCOPE, viz-VCOs, STICKY …
//
// WHERE A MODULE'S CATEGORY LIVES: on the module's OWN def, as a `palette:
// { top, sub }` field (AudioModuleDef / VideoModuleDef / MetaModuleDef).
// That is the single source of truth — adding a module needs NO edit here.
// `groupDefs()` + `categorizeDef()` read `def.palette` directly. The legacy
// `MODULE_CATEGORIES` hand-map below is now EMPTY (all entries migrated onto
// defs); it survives only as a fallback for `categorize(type)` callers and as
// a place a one-off override could live. The unit test next door asserts
// every registered def declares a palette, so a new module that forgets to
// classify itself fires loudly (and renders under Uncategorized meanwhile).
//
// This file still owns the canonical TOP_ORDER + SUB_ORDER (menu ordering)
// + the special flat-render rule (sub name == top name) — those are
// cross-cutting layout policy, not per-module data.

export type TopCategory =
  | 'Audio modules'
  | 'Video modules'
  | 'Games'
  | 'Ports'
  | 'Moog'
  | 'MIDI'
  | 'Hybrid'
  | 'Uncategorized';

export interface CategoryEntry {
  top: TopCategory;
  /** Sub-category label. For 'Hybrid', sub is unused (flat list); we
   *  set it to 'Hybrid' for the schema's shape uniformity.
   *
   *  Special rendering rule (ModulePalette): when a sub's name matches
   *  the top's name (e.g. Ports/Ports, Hybrid/Hybrid) those items
   *  render flat directly under the top-level row — no sub-header
   *  indirection. This lets a top-level group like Ports show
   *  high-profile entries (helm, hydrogen, cloudseed) at the top
   *  level alongside a labelled Mutable subfolder for the rest. */
  sub: string;
}

/** Canonical sub-category order per top category (drives menu order). */
export const SUB_ORDER: Record<TopCategory, readonly string[]> = {
  'Audio modules': ['VCOs', 'Utility', 'Effects', 'Mixing', 'End of chain'],
  'Video modules': ['Sources', 'Processors', 'Utilities'],
  // Games = playable game modules (emulators + in-house arcade ports) that
  // emit game-event CV/GATE. Two subs: Emulators (load an external game
  // engine / ROM — DOOM, SNES9X, Q*Bert) + Arcade (in-house ports —
  // NIBBLES, PONG, MODTRIS, FROGGER). SM64/SKIFREE are also games but
  // weren't in the move list; they stay in Hybrid for now.
  Games: ['Emulators', 'Arcade'],
  // Ports = "ports of external software / hardware synths". `Ports`
  // (matching the top name) renders flat at the top level —
  // hydrogen, helm, cloudseed are headline ports the user wants one
  // click away. `Mutable` is the MI archetype-port sublist.
  Ports: ['Ports', 'Mutable'],
  // Moog = the Moog System 55 / 35 clone family. Two sub-systems: SYS55
  // (the big modular) + SYS35. Modules shared by BOTH systems are listed
  // under SYS55 (resolved decision Q4 in .myrobots/MOOG/PLAN.md) — e.g.
  // the 921 VCO. Mirrors the Ports→Mutable nesting precedent above.
  Moog: ['SYS55', 'SYS35'],
  MIDI: ['MIDI'],
  Hybrid: ['Hybrid'],
  Uncategorized: ['Uncategorized'],
};

/** Top-level rendering order. */
export const TOP_ORDER: readonly TopCategory[] = [
  'Audio modules',
  'Video modules',
  'Games',
  'Ports',
  'Moog',
  'MIDI',
  'Hybrid',
  'Uncategorized',
];

/**
 * Legacy hand-maintained classification map — now EMPTY. Every module
 * classifies itself via its def's `palette` field (the single source of
 * truth); `groupDefs()` + `categorizeDef()` read that directly. This map is
 * kept only as a fallback for `categorize(type)` and as a spot a deliberate
 * one-off override could be parked. Do NOT re-populate it per-module — that
 * append-edit is the cross-PR conflict the per-def palette removed.
 */
export const MODULE_CATEGORIES: Record<string, CategoryEntry> = {};

/** Look up a module's category by type id, falling back to Uncategorized.
 *  Prefer {@link categorizeDef} where you have the def — it reads the def's
 *  own `palette` field (the single source of truth) and only falls back to
 *  this legacy hand-map for any def that hasn't declared one yet. */
export function categorize(type: string): CategoryEntry {
  return MODULE_CATEGORIES[type] ?? { top: 'Uncategorized', sub: 'Uncategorized' };
}

/**
 * Resolve a def's palette category. The def's own `palette` field wins (set
 * on the module def — no shared-file edit), then the legacy MODULE_CATEGORIES
 * hand-map (kept only as a migration safety net), then Uncategorized.
 *
 * The narrowing to TopCategory/sub is a runtime cast: `palette.top` is a
 * plain string on the def, but groupDefs + the categories test validate it
 * against TOP_ORDER / SUB_ORDER, so a bad value surfaces loudly rather than
 * silently mis-bucketing.
 */
export function categorizeDef(def: DefLike): CategoryEntry {
  if (def.palette) {
    return { top: def.palette.top as TopCategory, sub: def.palette.sub };
  }
  return categorize(def.type);
}

/** Minimal def shape the palette grouping helper needs. `palette` is the
 *  per-def classification (preferred over the legacy MODULE_CATEGORIES map). */
export interface DefLike {
  type: string;
  label: string;
  palette?: { top: string; sub: string };
}

export interface GroupedTop<D extends DefLike> {
  top: TopCategory;
  subs: Array<{ name: string; defs: D[] }>;
}

/**
 * Bucket a flat list of defs into nested [top → sub → defs] order,
 * preserving the canonical TOP_ORDER + SUB_ORDER and dropping empty
 * buckets. Unknown sub-categories (defensive) are appended after the
 * canonical ones, sorted alphabetically.
 */
export function groupDefs<D extends DefLike>(defs: readonly D[]): GroupedTop<D>[] {
  const byTop: Record<TopCategory, Record<string, D[]>> = {
    'Audio modules': {},
    'Video modules': {},
    Games: {},
    Ports: {},
    Moog: {},
    MIDI: {},
    Hybrid: {},
    Uncategorized: {},
  };
  for (const def of defs) {
    const { top, sub } = categorizeDef(def);
    // Defensive: a def with a palette.top outside TOP_ORDER would index a
    // missing bucket; fall it into Uncategorized rather than crash.
    const bucket = byTop[top as TopCategory] ?? byTop.Uncategorized;
    (bucket[sub] ??= []).push(def);
  }

  const out: GroupedTop<D>[] = [];
  for (const top of TOP_ORDER) {
    const subs = byTop[top];
    const subNames = new Set(Object.keys(subs));
    const ordered: Array<{ name: string; defs: D[] }> = [];
    for (const sub of SUB_ORDER[top]) {
      const list = subs[sub];
      if (list && list.length > 0) {
        ordered.push({ name: sub, defs: list });
        subNames.delete(sub);
      }
    }
    for (const sub of [...subNames].sort()) {
      const list = subs[sub];
      if (list && list.length > 0) ordered.push({ name: sub, defs: list });
    }
    if (ordered.length > 0) out.push({ top, subs: ordered });
  }
  return out;
}
