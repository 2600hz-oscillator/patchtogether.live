// packages/web/src/lib/graph/vfpga-runner.ts
//
// Yjs mutator for the vfpga-runner host's loaded preset (node.data.vfpga). A
// preset change is a DISCRETE user action (selecting a VFPGA from the "load
// preset…" menu) — written IN PLACE inside one ydoc.transact(LOCAL_ORIGIN), so
// it rides Y.Doc out to rack-mates + lands on the undo stack. This is NOT a
// per-frame write (the render state attenuverters live in node.data.cvInputs via
// the shared toybox-cv-inputs mutators; the factory reads them live each frame —
// never written from draw()).

import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import { getVfpgaSpec } from '$lib/video/vfpga/registry';

/** The 0..1 host-slot value that maps to a spec param's `defaultValue` across its
 *  [min,max] (the inverse of the factory's `min + slot*(max-min)` mapping). Shared
 *  so the card, the engine factory, and this mutator seed the SAME default. */
export function specParamSlotDefault(p: { min: number; max: number; defaultValue: number }): number {
  if (p.max <= p.min) return 0;
  return Math.max(0, Math.min(1, (p.defaultValue - p.min) / (p.max - p.min)));
}

/** Set the loaded VFPGA id on `nodeId` IN PLACE + seed each of the newly-loaded
 *  spec's param slots (p1..p8) to that spec's DEFAULT value (as a 0..1 slot
 *  value), so a freshly-loaded VFPGA renders with its intended defaults rather
 *  than the host's generic 0 (= each param at its min → an inert bend). A discrete
 *  user action written in ONE transact (rides Y.Doc + the undo stack). No-op if
 *  the node is gone. */
export function setVfpgaSpec(nodeId: string, vfpgaId: string): void {
  ydoc.transact(() => {
    const target = patch.nodes[nodeId];
    if (!target) return;
    if (!target.data) (target as { data: Record<string, unknown> }).data = {};
    (target.data as { vfpga?: string }).vfpga = vfpgaId;
    // Seed the spec's param-slot defaults so the loaded VFPGA is immediately
    // active (the host slot bank is generic 0..1; the spec maps + defaults onto it).
    const spec = getVfpgaSpec(vfpgaId);
    if (spec?.params?.length) {
      if (!target.params) (target as { params: Record<string, number> }).params = {};
      const params = target.params as Record<string, number>;
      for (const p of spec.params) params[`p${p.slot}`] = specParamSlotDefault(p);
    }
  }, LOCAL_ORIGIN);
}

/** Read a node's loaded VFPGA id, or undefined when unset. */
export function readVfpgaSpec(node: { data?: unknown } | undefined): string | undefined {
  const d = node?.data as { vfpga?: string } | undefined;
  return typeof d?.vfpga === 'string' ? d.vfpga : undefined;
}
