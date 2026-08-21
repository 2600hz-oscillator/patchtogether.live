// packages/web/src/lib/ui/modules/milkdrop-preset-actions.ts
//
// The MILKDROP preset actions, shared by the LEGACY CARD and the FACED shell
// cells so the two surfaces cannot drift.
//
// ⚠ WHY A SHARED MODULE RATHER THAN A SECOND IMPLEMENTATION. `shell-cells.ts`
// needs a selector's options/value/onchange and a file cell's `onFile`, and the
// card already had all four inline. Re-implementing them beside the shell
// registry is how the picker on one surface starts listing something different
// from the picker on the other — with nothing at runtime able to notice, because
// each surface is self-consistent. This is the `wavecel-table-actions` /
// `dx7` shape: ONE module, imported by both.
//
// ⚠ THE ENGINE IS REACHED FROM PLAIN `.ts`, WHICH IS ALREADY THE NORM.
// `getActiveEngine()` is exported from `$lib/audio/engine-ref` and consumed from
// non-component modules today (`clipplayer.ts`, `push2-control.svelte.ts`). Two
// independent agents have previously invented a false blocker that a shell cell
// needs a platform PR to reach the engine; it does not.
//
// ⚠ EVERYTHING ROUTES THROUGH `presetSelect`. The picker does not hold its own
// selection: it writes the same param the PST fader, the PRESET CV jack and the
// NEXT trigger drive, which is what keeps them in sync and what makes the choice
// persist with the patch. A custom `.milk` import is the one exception — it is
// appended to the engine's in-session list and is deliberately NOT saved.

import type { ModuleNode } from '$lib/graph/types';
import type { SelectorOption } from '$lib/ui/controls';
import { getActiveEngine } from '$lib/audio/engine-ref';
import { patch } from '$lib/graph/store';
import { setNodeParam } from '$lib/graph/mutate';
import { milkdropDef, MILKDROP_CURATED_NAMES } from '$lib/video/modules/milkdrop';
import { convertMilkPreset, resolvePresetNames } from '$lib/video/milkdrop-preset-loader';
import type { VideoEngine } from '$lib/video/engine';

/** The live video engine, or undefined before boot / mid-teardown. Never
 *  throws — a picker must not take the faceplate down with it. */
function videoEngine(): VideoEngine | undefined {
  try {
    return getActiveEngine()?.getDomain<VideoEngine>('video') ?? undefined;
  } catch {
    return undefined;
  }
}

/** The engine's LIVE name list (curated, pack-drift-filtered, plus in-session
 *  customs), falling back to the curated names before the lazy preset chunk
 *  resolves — so the picker is never empty on a cold faceplate. */
export function milkdropPresetNames(nodeId: string): string[] {
  let live: string[] | undefined;
  try {
    live = videoEngine()?.read(nodeId, 'presetNames') as string[] | undefined;
  } catch {
    live = undefined;
  }
  return resolvePresetNames(live, MILKDROP_CURATED_NAMES);
}

/** Selector options: the preset NAMES, valued by their index in the live list.
 *  ⚠ The names are the whole reason this cell exists — the param addresses
 *  presets by index, so without the roster a faceplate could only ever paint an
 *  anonymous ~20-position control. */
export function milkdropPresetOptions(nodeId: string): SelectorOption<string>[] {
  // ⚠ THE OPTION'S VALUE IS THE NAME, NOT THE INDEX, and getting this wrong is
  // what made the first draft of this cell INERT. The shell compares an option's
  // `value` against whatever `value(node)` returns to decide which entry is
  // selected; returning a NAME from one and an INDEX from the other means the
  // two never match, so clicking an option changed the graph and the chip went
  // on displaying the old entry. `faces-parity` caught it by name — "choosing
  // another option changes the selection", expected "Flexi - mindblob [shiny
  // mix]", received "Geiss - Reaction Diffusion 2" — which is exactly the inert
  // cell that sweep exists to find. The dx7 selector is name-valued for the same
  // reason; the index stays an implementation detail of the write below.
  return milkdropPresetNames(nodeId).map((name) => ({ value: name, label: name }));
}

/** The selected preset's NAME — the picker's displayed value. Reads the param,
 *  clamped to the live list, so it agrees with whatever the knob/CV last wrote. */
export function milkdropPresetValue(node: ModuleNode | undefined): string {
  const names = milkdropPresetNames(node?.id ?? '');
  const raw = Number(node?.params?.presetSelect ?? 0);
  const idx = Math.max(0, Math.min(names.length - 1, Math.round(Number.isFinite(raw) ? raw : 0)));
  return names[idx] ?? '';
}

/** Picking a preset writes `presetSelect` — the SAME param the fader, the CV
 *  jack and the NEXT trigger drive. */
export function selectMilkdropPreset(nodeId: string, value: string | number): void {
  // Accepts the option's NAME (what the selector emits) or a raw index, and
  // resolves both to the numeric `presetSelect` the graph stores.
  const names = milkdropPresetNames(nodeId);
  const idx = typeof value === 'number' ? value : names.indexOf(value);
  if (!Number.isFinite(idx) || idx < 0) return;
  setNodeParam(nodeId, 'presetSelect', idx);
}

/**
 * Import a Winamp `.milk` preset: convert it in-browser, then hand it to the
 * engine's `loadCustomPreset` command, which appends it to the in-session list
 * and crossfades to it over MORPH seconds.
 *
 * Returns the `{ status, error }` line `ShellFileCell` renders under the button.
 * ⚠ A FAILED IMPORT REPORTS, IT DOES NOT THROW — the same three outcomes the
 * card's own handler distinguishes (engine not ready / converted and loaded /
 * could not parse), so the two surfaces say the same thing about one file.
 */
export async function loadMilkFile(
  nodeId: string,
  file: File,
): Promise<{ status: string | null; error: string | null }> {
  try {
    const text = await file.text();
    const preset = await convertMilkPreset(text);
    const loader = videoEngine()?.read(nodeId, 'loadCustomPreset') as
      | ((preset: unknown, name: string, blend: number) => number)
      | undefined;
    if (typeof loader !== 'function') {
      return { status: null, error: 'engine not ready — try again' };
    }
    const name = file.name.replace(/\.milk$/i, '');
    // MORPH is the crossfade the rest of the module already uses for a preset
    // change; read it live rather than re-typing a default.
    loader(preset, name, milkdropMorphOf(nodeId));
    return { status: `loaded ${name}`, error: null };
  } catch (e) {
    console.warn('[milkdrop] .milk import failed:', e);
    return { status: null, error: "couldn't load that .milk file" };
  }
}

/** The node's live MORPH value — the crossfade a preset change uses.
 *
 *  ⚠ READ FROM THE GRAPH, falling back to the DEF'S OWN DEFAULT, which is the
 *  same resolution the card's `p('morph')` performs. Not from the engine: a
 *  freshly spawned node has no engine-side value yet, and defaulting to a
 *  re-typed `0` there would make an import from the faceplate cut instantly
 *  while the identical import from the card crossfaded. */
function milkdropMorphOf(nodeId: string): number {
  const declared = milkdropDef.params?.find((p) => p.id === 'morph')?.defaultValue ?? 0;
  const live = patch.nodes[nodeId]?.params?.morph;
  return typeof live === 'number' && Number.isFinite(live) ? live : declared;
}

/** The `accept` filter, in ONE place so the card and the shell cell cannot
 *  disagree about what the picker offers. */
export const MILK_ACCEPT = '.milk';
