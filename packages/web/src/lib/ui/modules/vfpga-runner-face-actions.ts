// packages/web/src/lib/ui/modules/vfpga-runner-face-actions.ts
//
// The VFPGA-RUNNER preset actions, shared by the LEGACY CARD and the FACED
// shell cell so the two surfaces cannot drift.
//
// ⚠ WHY A SHARED MODULE RATHER THAN A SECOND IMPLEMENTATION. Loading a VFPGA is
// TWO writes that must happen together: `setVfpgaSpec` puts the id on
// `node.data` (and seeds the new spec's param-slot defaults), and a
// `__reloadVfpga` pulse tells the live engine handle to dispose the running GL
// pipeline and build the new one. `VfpgaRunnerCard.svelte` had both inline. A
// shell cell that reproduced only the first would write the id, leave the OLD
// effect compiled, and paint a picker that appears to work while the picture
// never changes — self-consistent on each surface and invisible at runtime.
// This is the `milkdrop-preset-actions` / `dx7-patch-actions` shape: ONE module,
// imported by both.
//
// ⚠ THE ENGINE IS REACHED FROM PLAIN `.ts`, WHICH IS ALREADY THE NORM.
// `getActiveEngine()` is exported from `$lib/audio/engine-ref` and consumed from
// non-component modules today (`clipplayer.ts`, `push2-control.svelte.ts`).

import type { ModuleNode } from '$lib/graph/types';
import type { SelectorOption } from '$lib/ui/controls';
import type { VideoEngine } from '$lib/video/engine';
import { getActiveEngine } from '$lib/audio/engine-ref';
import { listVfpgaSpecs, getVfpgaSpec, DEFAULT_VFPGA_ID } from '$lib/video/vfpga/registry';
import { setVfpgaSpec, readVfpgaSpec } from '$lib/graph/vfpga-runner';

/** The synthetic param id the factory treats as a HOT-SWAP PULSE rather than a
 *  value (`vfpga-runner.ts` setParam). Named once here so the card and the
 *  shell cell cannot spell it differently. */
export const VFPGA_RELOAD_PULSE = '__reloadVfpga';

/** The live video engine, or undefined before boot / mid-teardown. Never
 *  throws — a picker must not take the faceplate down with it. */
function videoEngine(): VideoEngine | undefined {
  try {
    return getActiveEngine()?.getDomain<VideoEngine>('video') ?? undefined;
  } catch {
    return undefined;
  }
}

/** Selector options: one entry per bundled VFPGA, valued by spec id and
 *  LABELLED by the spec's own name. The names are the whole reason this cell
 *  exists — nothing else on the faceplate says what is loaded. */
export function vfpgaPresetOptions(): SelectorOption<string>[] {
  return listVfpgaSpecs().map((s) => ({
    value: s.id,
    label: s.name,
    title: s.doc,
  }));
}

/** The loaded VFPGA id for a node, falling back to the default the factory
 *  itself falls back to — so the chip never paints an empty selection on a
 *  fresh spawn that has not written `node.data.vfpga` yet. */
export function vfpgaPresetValue(node: ModuleNode | undefined): string {
  const id = readVfpgaSpec(node);
  if (id && getVfpgaSpec(id)) return id;
  return DEFAULT_VFPGA_ID;
}

/**
 * LOAD a VFPGA into `nodeId` — the whole action, both halves.
 *
 * 1. `setVfpgaSpec` writes `node.data.vfpga` and seeds the new spec's
 *    param-slot defaults, in ONE `ydoc.transact` (rides Y.Doc + the undo stack).
 * 2. the `__reloadVfpga` pulse makes the live handle re-resolve the spec and
 *    rebuild its GL pipeline. Without it the id changes and the picture does
 *    not.
 *
 * No-op'ing the pulse when the engine is absent is deliberate: the factory
 * resolves the spec from live `node.data` at CONSTRUCTION too, so a node that
 * has not been built yet picks the new spec up when it is.
 */
export function selectVfpgaPreset(nodeId: string, vfpgaId: string): void {
  if (!getVfpgaSpec(vfpgaId)) return;
  setVfpgaSpec(nodeId, vfpgaId);
  try {
    videoEngine()?.setParam(nodeId, VFPGA_RELOAD_PULSE, 1);
  } catch {
    /* engine not ready — the factory resolves from node.data at construction */
  }
}
