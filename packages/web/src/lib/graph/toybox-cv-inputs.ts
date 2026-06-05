// packages/web/src/lib/graph/toybox-cv-inputs.ts
//
// TOYBOX — Yjs mutator for the per-input modulation-shaping map
// (node.data.cvInputs). Each of the 6 generic modulation inputs (cv1..cv6) has
// a bipolar SCALE (attenuverter, −1..+1) and an OFFSET (0..1), edited by the
// card's CV section knobs.
//
// WHY a SIBLING map (not on the cvRoutes entry): the OFFSET must act as a manual
// control value even when a port has NO route — and a null/absent route has
// nowhere to hang a scale/offset. So cvInputs is independent of cvRoutes; a port
// can carry a scale/offset with no route, and a route survives a scale/offset
// edit (and vice-versa).
//
// CRITICAL ([[yjs-save-load-real-ydoc]] in-place trap): mutate cvInputs IN
// PLACE inside ONE ydoc.transact(LOCAL_ORIGIN) — set a single key (or a single
// scalar field on a live entry), never rebuild-and-reassign the whole map. The
// map is a flat Record<portId, {scale, offset}>; setting one port's value to a
// fresh plain object, or setting a scalar field on a live entry, integrates
// cleanly.

import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import {
  DEFAULT_INPUT_SCALE,
  DEFAULT_INPUT_OFFSET,
  type CvInputs,
} from '$lib/video/toybox-cv-routes';

/** Run `fn` against the node's live cvInputs map inside a Yjs transaction,
 *  creating an empty map in place first if absent. */
function mutateCvInputs(nodeId: string, fn: (inputs: CvInputs) => void): void {
  ydoc.transact(() => {
    const target = patch.nodes[nodeId];
    if (!target) return;
    if (!target.data) (target as { data: Record<string, unknown> }).data = {};
    const data = target.data as { cvInputs?: CvInputs };
    if (!data.cvInputs || typeof data.cvInputs !== 'object') {
      data.cvInputs = {} as CvInputs;
    }
    fn(data.cvInputs);
  }, LOCAL_ORIGIN);
}

/** Read a node's live cvInputs map (empty object when absent). */
export function readCvInputs(node: { data?: unknown } | undefined): CvInputs {
  const d = node?.data as { cvInputs?: CvInputs } | undefined;
  return d?.cvInputs && typeof d.cvInputs === 'object' ? d.cvInputs : {};
}

/**
 * Set one input's bipolar SCALE (attenuverter, −1..+1) IN PLACE. Mutates the
 * existing entry's `scale` scalar when present (integrates cleanly — no spread
 * of a live Y type); else creates a fresh entry carrying the scale + default
 * offset.
 */
export function setCvScale(nodeId: string, portId: string, scale: number): void {
  mutateCvInputs(nodeId, (inputs) => {
    const entry = inputs[portId];
    if (entry && typeof entry === 'object') {
      entry.scale = scale; // in-place scalar set on the live entry
      return;
    }
    inputs[portId] = { scale, offset: DEFAULT_INPUT_OFFSET };
  });
}

/**
 * Set one input's OFFSET (0..1, the manual / no-cable control value) IN PLACE.
 * Same in-place discipline as setCvScale.
 */
export function setCvOffset(nodeId: string, portId: string, offset: number): void {
  mutateCvInputs(nodeId, (inputs) => {
    const entry = inputs[portId];
    if (entry && typeof entry === 'object') {
      entry.offset = offset; // in-place scalar set on the live entry
      return;
    }
    inputs[portId] = { scale: DEFAULT_INPUT_SCALE, offset };
  });
}

/**
 * Set BOTH scale + offset for one input at once IN PLACE (used by presets /
 * test seeding). Writes a fresh plain object for the port (never spreads a live
 * Y entry).
 */
export function setCvInput(
  nodeId: string,
  portId: string,
  scale: number,
  offset: number,
): void {
  mutateCvInputs(nodeId, (inputs) => {
    inputs[portId] = { scale, offset };
  });
}
