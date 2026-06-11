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

/** Set the loaded VFPGA id on `nodeId` IN PLACE. Creates node.data first if
 *  absent. Setting a single scalar key integrates cleanly. No-op if the node
 *  is gone. */
export function setVfpgaSpec(nodeId: string, vfpgaId: string): void {
  ydoc.transact(() => {
    const target = patch.nodes[nodeId];
    if (!target) return;
    if (!target.data) (target as { data: Record<string, unknown> }).data = {};
    (target.data as { vfpga?: string }).vfpga = vfpgaId;
  }, LOCAL_ORIGIN);
}

/** Read a node's loaded VFPGA id, or undefined when unset. */
export function readVfpgaSpec(node: { data?: unknown } | undefined): string | undefined {
  const d = node?.data as { vfpga?: string } | undefined;
  return typeof d?.vfpga === 'string' ? d.vfpga : undefined;
}
