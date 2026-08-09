// packages/web/src/lib/ui/modules-card-components.ts
//
// THE eager card-component glob, isolated in its own module so the SERVER
// build can drop it.
//
// It is the single heaviest thing in the repo's module graph: ~210
// `*Card.svelte` components and everything they transitively pull in
// (hls.js, butterchurn + presets, @grame/faustwasm, the video glitch
// renderers, module-docs.generated…). On the client that is exactly right —
// SvelteFlow renders cards synchronously, so they must all be resident.
//
// On the SERVER it is dead weight. The patch graph lives in a Yjs doc backed
// by IndexedDB/the relay, so a server render of `/r/[id]` has ZERO nodes and
// therefore renders ZERO cards; `nodeTypes` is handed to SvelteFlow and never
// indexed. `/rack` is `ssr = false` and never renders at all. Carrying the map
// anyway cost the Cloudflare Worker ~1.9 MiB gzipped against a 3 MiB ceiling.
//
// `vite.config.ts`'s `ssrDropCardComponents()` plugin replaces THIS FILE (and
// only this file) with `export const componentByName = {}` in the SSR build.
// The stub is a single empty object with no logic to drift, which is the whole
// reason the glob was split out here instead of being stubbed in place —
// `modules-card-map.ts` keeps every behaviour-bearing function, and those are
// bundled and tested normally on both sides.
//
// The seam is guarded by `modules-card-components.ssr-stub.test.ts` (the stub
// source and this module's public shape must agree) and by
// `modules-card-map.test.ts` (the real map, unstubbed, in the unit lane).

import type { Component } from 'svelte';

// Eagerly import every card component so SvelteFlow can render synchronously.
// Vite resolves the glob at build time; only `*Card.svelte` so sibling
// non-card components (ModuleTitle, OssAttribution, SequencerPageNav,
// VideoCanvasContextMenu) are excluded.
const CARD_MODULES = import.meta.glob<{ default: Component }>('./modules/*Card.svelte', {
  eager: true,
});

/** Map of card component BASENAME (e.g. 'AnalogVcoCard') → component. */
export const componentByName: Record<string, Component> = {};
for (const [path, mod] of Object.entries(CARD_MODULES)) {
  // path looks like './modules/AnalogVcoCard.svelte'
  const base = path.slice(path.lastIndexOf('/') + 1).replace(/\.svelte$/, '');
  componentByName[base] = mod.default;
}
