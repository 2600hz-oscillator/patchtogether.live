// packages/web/src/lib/ui/modules/mappy-map-actions.ts
//
// THE VENUE-MAP ACTIONS — export and import MAPPY's projector alignment, as ONE
// action seam called by the legacy card, the faceplate's ranked cells and the
// MAP body alike.
//
// ⚠ WHY THIS FILE EXISTS RATHER THAN A SECOND COPY IN THE BODY. The
// module-surfaces rule is that one-shot behaviour lives in one plain TypeScript
// action both surfaces call (`livecode` is the reference shape). The Blob/URL/
// file-read glue used to live inside `MappyCard.svelte`; promotion stops that
// component rendering on both default surfaces, so a body that re-implemented
// the download would be a SECOND implementation of the venue file format with
// nothing holding the two together. The PURE half (serialize / parse / validate
// / apply) was already shared — `mappy-map-io.ts` — and this is the browser half
// beside it.
//
// ⚠ THE AUDITION SEAM IS `file-export`, NOT `engine-message`. An export reaches
// no engine and no worklet; recording it as an engine message would make the
// ledger lie about what was touched, and a probe watching `engine-message` on
// this node would then be satisfied by something else entirely. samsloop's
// `downloadSamsloopSample` is the precedent and the same `delivered` convention
// applies: `delivered` means THE SEAM WAS REACHED, not that a venue had been
// aligned first — faces-parity presses this button on a BARE RACK, where the
// honest answer for a freshly-spawned mappy (one full-frame surface) is a real
// export of exactly that layout.

import { patch } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import { serializeMap, parseMap, applyMap } from './mappy-map-io';
import { applyMapLayout, getSurfaceCount } from './mappy-edit';
import { recordAudition } from './audition-ledger';
import { recordMappyMapOutcome } from './mappy-map-outcome.svelte';

/** The live node, or undefined when the store has no such id. */
function liveNode(nodeId: string): ModuleNode | undefined {
  return patch?.nodes?.[nodeId] as ModuleNode | undefined;
}

/** The status/error pair a `ShellFileCell` renders under its button, and that
 *  the card flashes in `mappy-map-status`. One shape, two surfaces. */
export interface MappyMapStatus {
  status: string | null;
  error: string | null;
}

const plural = (n: number): string => `${n} surface${n === 1 ? '' : 's'}`;

/**
 * EXPORT the venue map — the surface COUNT plus every surface's four corners
 * and FIT/CROP mode — as a downloaded `.json`.
 *
 * Returns the status line to show, so the caller decides where it is painted
 * (the card flashes it for 4 s; the shell's action cell has no status line of
 * its own, which is why the MAP body paints one).
 */
export function exportMappyMap(nodeId: string): MappyMapStatus {
  const node = liveNode(nodeId);
  if (!node) {
    // The seam was reached and found NOTHING — the ledger's own definition of
    // an undelivered press.
    return report(nodeId, { status: null, error: 'export failed' }, false);
  }
  try {
    // ⚠ The count comes from the PARAM (via the shared reader), never from a
    // `node.data.surfaceCount` mirror — that mirror is gone, and reading it
    // would export `1` for every rack. See mappy-map-io's `serializeMap`.
    const map = serializeMap(
      node.data as { surfaces?: unknown } | undefined,
      getSurfaceCount(node),
    );
    const json = JSON.stringify(map, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mappy-map-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on the next tick so the click has surely started the download.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return report(nodeId, { status: `exported ${plural(map.count)}`, error: null }, true);
  } catch {
    return report(nodeId, { status: null, error: 'export failed' }, false);
  }
}

/** Record the audition AND publish the outcome, then hand the caller the same
 *  pair. ⚠ BOTH LEDGERS, ALWAYS: `delivered` answers "did the press reach the
 *  seam" for the parity sweep, and the outcome answers "what happened" for the
 *  player — a press that reached the seam and found nothing to export is
 *  `delivered: true` with a message, which is why they cannot be one field. */
function report(
  nodeId: string,
  r: MappyMapStatus,
  delivered: boolean,
): MappyMapStatus {
  recordAudition({ nodeId, seam: 'file-export', delivered });
  recordMappyMapOutcome(nodeId, r);
  return r;
}

/**
 * IMPORT a venue map from a picked file. REPLACES the current layout — count,
 * every surface's corners, every surface's FIT — through the in-place Yjs seam.
 *
 * A foreign / garbage / future-version file is REJECTED and mutates NOTHING;
 * the reason is returned as `error` so both surfaces can say what was wrong
 * instead of failing silently.
 *
 * `async` because `ShellFileCell.onFile` is declared as returning a promise and
 * `File.text()` is one.
 */
export async function importMappyMapFile(nodeId: string, file: File): Promise<MappyMapStatus> {
  let text: string;
  try {
    text = await file.text();
  } catch {
    const r = { status: null, error: 'could not read file' };
    recordMappyMapOutcome(nodeId, r);
    return r;
  }
  const parsed = parseMap(text);
  if (!parsed.ok) {
    // ⚠ Do NOT mutate on a foreign/garbage file — the whole point of the
    // kind/version tag. The layout on screen is the one the player aligned.
    const r = { status: null, error: `not a MAPPY map: ${parsed.error}` };
    recordMappyMapOutcome(nodeId, r);
    return r;
  }
  const layout = applyMap(parsed.map);
  applyMapLayout(nodeId, layout);
  const r = { status: `imported ${plural(layout.count)}`, error: null };
  recordMappyMapOutcome(nodeId, r);
  return r;
}
