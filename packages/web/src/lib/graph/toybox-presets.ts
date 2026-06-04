// packages/web/src/lib/graph/toybox-presets.ts
//
// TOYBOX Phase 6 — Yjs mutator that loads a bundled PRESET into node.data.
//
// A preset (manifest `presets[]`, toybox-content.ts:ToyboxPreset) fully
// specifies the patch: `layers` (LAYER_COUNT entries), the combine GRAPH
// ({nodes,edges}), and `cvRoutes` (cv1..cv8 → target/param). Loading one
// replaces all three fields on the live node so the factory renders the
// preset's composite next frame and rack-mates see it via Y.Doc.
//
// CRITICAL (the in-place trap, same as toybox-combine.ts / control-surface /
// [[yjs-save-load-real-ydoc]]): once node.data.layers / .combine.nodes /
// .cvRoutes have synced, their entries are live Y types. We must NOT rebuild +
// reassign an array that already holds live Y types by spreading them into a
// fresh array (Yjs throws "Type already integrated"). Instead we:
//   - CLEAR each array IN PLACE (splice to length 0) then PUSH fresh PLAIN
//     objects (deep-cloned from the preset, which is plain JSON), and
//   - CLEAR the cvRoutes map IN PLACE (delete every key) then SET fresh plain
//     entries.
// The preset data itself is plain JSON from the manifest, so the clones we push
// are always fresh plain objects — never an already-integrated Y type.
//
// Reads/writes go through the patch proxy inside ONE LOCAL_ORIGIN transaction.

import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import {
  LAYER_COUNT,
  getPreset,
  type ToyboxLayer,
  type ToyboxPreset,
} from '$lib/video/toybox-content';

/** Deep-clone plain JSON (presets are plain JSON, so this is total + safe). */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Ensure `node.data[key]` is an array, then replace its contents IN PLACE with
 * fresh plain clones of `items` (splice to 0, then push). Never reassigns the
 * array reference if it already exists (so a live Y.Array stays the same Y
 * type — we only mutate its contents).
 */
function replaceArrayInPlace(
  data: Record<string, unknown>,
  key: string,
  items: unknown[],
): void {
  if (!Array.isArray(data[key])) data[key] = [];
  const arr = data[key] as unknown[];
  arr.splice(0, arr.length); // clear in place
  for (const item of items) arr.push(clone(item)); // push fresh plain clones
}

/**
 * Apply a preset's layers/combine/cvRoutes onto a node's live data IN PLACE.
 * Exported (without the Yjs transaction wrapper) so unit tests can drive it on
 * a plain `data` object AND so loadToyboxPreset can call it inside its txn.
 *
 * - layers: cleared + repopulated with LAYER_COUNT plain clones.
 * - combine: ensures node.data.combine.{nodes,edges} exist, then clears +
 *   repopulates each array in place with plain clones of the preset graph.
 * - cvRoutes: cleared (every existing key deleted) then set to fresh plain
 *   entries from the preset.
 */
export function applyPresetToData(
  data: Record<string, unknown>,
  preset: ToyboxPreset,
): void {
  // --- layers (exactly LAYER_COUNT) ---
  const layers = clone(preset.layers).slice(0, LAYER_COUNT) as ToyboxLayer[];
  while (layers.length < LAYER_COUNT) {
    layers.push({ kind: 'off', contentId: null, params: {} });
  }
  replaceArrayInPlace(data, 'layers', layers);

  // --- combine GRAPH ({nodes,edges}) ---
  if (!data.combine || typeof data.combine !== 'object') data.combine = {};
  const combine = data.combine as Record<string, unknown>;
  replaceArrayInPlace(combine, 'nodes', preset.combine.nodes ?? []);
  replaceArrayInPlace(combine, 'edges', preset.combine.edges ?? []);

  // --- cvRoutes (flat map) ---
  if (!data.cvRoutes || typeof data.cvRoutes !== 'object') data.cvRoutes = {};
  const routes = data.cvRoutes as Record<string, unknown>;
  // Clear every existing key in place (delete, never reassign the map).
  for (const k of Object.keys(routes)) delete routes[k];
  for (const [port, target] of Object.entries(preset.cvRoutes ?? {})) {
    routes[port] = clone(target);
  }
}

/**
 * Apply a (already-resolved) preset onto the live node IN PLACE, inside one Yjs
 * transaction tagged LOCAL_ORIGIN. Returns true if the node existed. Separated
 * from loadToyboxPreset (which fetches the manifest) so callers/tests that
 * already hold a preset object can drive the Yjs write directly without fetch.
 */
export function applyPresetToNode(nodeId: string, preset: ToyboxPreset): boolean {
  let applied = false;
  ydoc.transact(() => {
    const target = patch.nodes[nodeId];
    if (!target) return;
    if (!target.data) (target as { data: Record<string, unknown> }).data = {};
    applyPresetToData(target.data as Record<string, unknown>, preset);
    applied = true;
  }, LOCAL_ORIGIN);
  return applied;
}

/**
 * Load a bundled preset by id into the live node (cv routes + layers + combine).
 * Lazily fetches the manifest (so presets resolve even before the card has
 * awaited the catalog), then mutates node.data IN PLACE inside one Yjs
 * transaction. Resolves true if the preset was found + applied, false otherwise.
 *
 * The card's content/model GLSL/OBJ fetches are lazy in the factory, so we do
 * NOT need to pre-fetch them here — but the card prefetches referenced content
 * after this resolves (see ToyboxCard.loadPreset) for snappier first paint.
 */
export async function loadToyboxPreset(nodeId: string, presetId: string): Promise<boolean> {
  let preset: ToyboxPreset | undefined;
  try {
    preset = await getPreset(presetId);
  } catch {
    // The manifest fetch can throw in non-browser envs (no global fetch / a
    // relative URL with no base). Treat as "preset not loadable" → false.
    return false;
  }
  if (!preset) return false;
  return applyPresetToNode(nodeId, preset);
}
