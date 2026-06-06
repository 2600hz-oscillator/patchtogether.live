// packages/web/src/lib/ui/modules-card-map.ts
//
// GLOB-DRIVEN module-card resolver. Builds the `{ moduleType: CardComponent }`
// map SvelteFlow consumes as its `nodeTypes`, WITHOUT a hand-maintained import
// list in Canvas.svelte (that append-edit was a top cross-PR conflict source).
//
// How a def resolves to a card:
//   1. If the def declares an explicit `card` (the component basename, e.g.
//      'AudioinCard'), that wins. Use this ONLY when the convention below
//      doesn't hold for your module — declaring it lives on the module's OWN
//      def file, so it still requires ZERO shared-file edits.
//   2. Otherwise the convention `PascalCase(type) + 'Card'` is used
//      (e.g. analogVco → AnalogVcoCard, reverb → ReverbCard). ~94% of modules
//      follow this, so the common case needs no `card` field at all.
//
// To add a module's card: drop `XyzCard.svelte` in this directory (matching
// the convention) — it is picked up automatically. No edit here, no edit in
// Canvas.svelte.

import type { Component } from 'svelte';

// Eagerly import every card component so SvelteFlow can render synchronously.
// Vite resolves the glob at build time; only `*Card.svelte` so sibling
// non-card components (ModuleTitle, OssAttribution, SequencerPageNav,
// VideoCanvasContextMenu) are excluded.
const CARD_MODULES = import.meta.glob<{ default: Component }>('./modules/*Card.svelte', {
  eager: true,
});

/** Map of card component BASENAME (e.g. 'AnalogVcoCard') → component. */
const componentByName: Record<string, Component> = {};
for (const [path, mod] of Object.entries(CARD_MODULES)) {
  // path looks like './modules/AnalogVcoCard.svelte'
  const base = path.slice(path.lastIndexOf('/') + 1).replace(/\.svelte$/, '');
  componentByName[base] = mod.default;
}

/** Convention: module type id → expected card component basename. */
export function conventionalCardName(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1) + 'Card';
}

/** A def shape carrying just what the card resolver needs. */
export interface CardDefLike {
  type: string;
  /** Optional explicit card-component basename override (no '.svelte'). */
  card?: string;
}

/**
 * Build the `{ moduleType: CardComponent }` map from the registered defs.
 * Defs whose card can't be resolved (no explicit `card`, no conventionally-
 * named component) are simply omitted — SvelteFlow falls back to its default
 * node renderer for those, and the unit test in modules-card-map.test.ts
 * fails loudly so the gap is caught before it ships. Meta cards that aren't
 * rendered as flow nodes the conventional way (e.g. GROUP) can opt out by
 * not having a matching component; callers add them explicitly if needed.
 */
export function buildNodeTypes(defs: readonly CardDefLike[]): Record<string, Component> {
  const out: Record<string, Component> = {};
  for (const def of defs) {
    const name = def.card ?? conventionalCardName(def.type);
    const comp = componentByName[name];
    if (comp) out[def.type] = comp;
  }
  return out;
}

/** All card component basenames discovered by the glob (for tests/diagnostics). */
export function knownCardNames(): string[] {
  return Object.keys(componentByName).sort();
}
