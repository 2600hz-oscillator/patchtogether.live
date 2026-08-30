// packages/web/src/lib/ui/modules/videocube-slot-actions.ts
//
// The VIDEOCUBE per-slot INGEST actions, shared by the LEGACY CARD and the FACED
// shell cells so the two surfaces cannot drift.
//
// VIDEOCUBE stacks THREE 60-frame video rings — A (FLOOR), B (WALL/connector),
// C (CEILING) — and each slot is independently either LIVE (recording whatever
// is patched into `video_a`/`b`/`c`) or LOADED from a `.frametable.png` atlas.
// Those two controls per slot are SIX affordances that exist ONLY on
// `VideocubeCard.svelte`, and `migrated(type)` stops both surfaces rendering it —
// so without this module and the cells that call it, promoting VIDEOCUBE would
// leave the module with no way to choose what is IN the cube at all.
//
// ⚠ BOTH ACTIONS ARE ENGINE-ONLY, AND THAT DECIDES THE PROBE. Each hands a
// tagged element to `attachExternalSource` and the factory consumes it on the
// next draw; NOTHING is written to the graph, and v1 deliberately does not
// persist a descriptor (unlike FRAMETABLE, whose loads survive a reload). So
// `readParam`/`readData` are structurally blind to the work itself, exactly as
// they are to an audition — and `saveFrametableFile`'s outcome record is the
// pattern this reuses rather than reinvents. See `writeSlotOutcome`.
//
// ⚠ THE `.frametable.png` FORMAT IS FRAMETABLE'S, DELIBERATELY. A table saved
// out of a FRAMETABLE loads into any VIDEOCUBE slot — that is the "VideoCube-
// ready" claim frametable.ts's own header makes — so the accept filter and the
// geometry validator are IMPORTED from the one place that owns them rather than
// re-spelled here.

import { getActiveEngine } from '$lib/audio/engine-ref';
import { patch } from '$lib/graph/store';
import type { VideoEngine } from '$lib/video/engine';
import {
  FRAMETABLE_ATLAS_COLS,
  FRAMETABLE_ATLAS_ROWS,
  FRAMETABLE_FILE_ACCEPT,
  atlasGeometry,
} from '$lib/video/frametable-atlas';

export { FRAMETABLE_FILE_ACCEPT };

/** The three ring slots, in the order the solid stacks them. */
export type VideocubeSlot = 'a' | 'b' | 'c';
export const VIDEOCUBE_SLOTS: readonly VideocubeSlot[] = ['a', 'b', 'c'];
/** What each slot IS in the 3-D solid — the card's own captions. */
export const VIDEOCUBE_SLOT_LABEL: Readonly<Record<VideocubeSlot, string>> = {
  a: 'FLOOR', b: 'WALL', c: 'CEIL',
};

/** The live video engine, or null before boot / mid-teardown. Never throws — a
 *  slot picker must not take the faceplate down with it. */
function videoEngine(): VideoEngine | null {
  try {
    return getActiveEngine()?.getDomain<VideoEngine>('video') ?? null;
  } catch {
    return null;
  }
}

/** What the LAST slot press did. `ok: false` is recorded, never dropped. */
export interface VideocubeSlotOutcome {
  /** Monotonic per node — distinguishes two presses with the same outcome. */
  seq: number;
  slot: VideocubeSlot;
  source: 'live' | 'file';
  ok: boolean;
  error: string | null;
}

/**
 * Record the outcome of ONE slot press.
 *
 * ⚠ THE SAME ARGUMENT AS `frametable-file-actions.writeSaveOutcome`, and the
 * second adopter of it. Both slot actions reach the ENGINE and leave nothing in
 * the graph, so the observable has to be manufactured — and the audition
 * ledger's principle is the one to copy: a record is written on EVERY press,
 * including the ones that failed, because "never pressed" and "pressed and
 * reached nothing" are different failures.
 *
 * ⚠ NOT A `data-rev` COUNTER. It is written INSIDE the handler once the work has
 * been attempted, and it carries WHICH slot, WHICH source and the outcome — so a
 * dead button writes nothing at all, and a button that reached no engine writes
 * `ok: false` with the reason rather than silently bumping a number.
 *
 * ONE key for all six cells: `seq` is what guarantees a change, and each probe
 * snapshots immediately before its own press.
 */
function writeSlotOutcome(
  nodeId: string,
  slot: VideocubeSlot,
  source: 'live' | 'file',
  ok: boolean,
  error: string | null,
): void {
  const target = patch.nodes[nodeId];
  if (!target) return;
  if (!target.data) target.data = {};
  const data = target.data as Record<string, unknown>;
  const prev = data.videocubeSlot as VideocubeSlotOutcome | undefined;
  data.videocubeSlot = {
    seq: (prev?.seq ?? 0) + 1, slot, source, ok, error,
  } satisfies VideocubeSlotOutcome;
}

/**
 * Point a slot back at its LIVE video input.
 *
 * ⚠ THE MECHANISM IS A TAGGED 1x1 CLEAR ELEMENT, not a param or a message, and
 * it is the factory's own contract: `attachExternalSource` is the only channel
 * into a video node that `engine.ts` already provides, so the slot router reads
 * `dataset.videocubeSlot` to know WHICH ring and `dataset.videocubeClear` to
 * know that this is a RESET rather than an atlas. Re-spelling those dataset keys
 * anywhere else is how the card and the faceplate would start addressing
 * different slots.
 */
export function setVideocubeSlotLive(
  nodeId: string,
  slot: VideocubeSlot,
): { status: string | null; error: string | null } {
  const ve = videoEngine();
  if (!ve) {
    writeSlotOutcome(nodeId, slot, 'live', false, 'video engine not ready');
    return { status: null, error: 'video engine not ready' };
  }
  try {
    const c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    c.dataset.videocubeSlot = slot;
    c.dataset.videocubeClear = '1';
    ve.attachExternalSource(nodeId, 'image', c);
    writeSlotOutcome(nodeId, slot, 'live', true, null);
    return { status: 'live', error: null };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    writeSlotOutcome(nodeId, slot, 'live', false, error);
    return { status: null, error };
  }
}

/**
 * Load a `.frametable.png` atlas into one slot.
 *
 * Returns the `{ status, error }` line `ShellFileCell` renders under the button.
 * ⚠ A REJECTED FILE REPORTS, IT DOES NOT THROW — the same outcomes the card's
 * own handler distinguishes, so the two surfaces say the same thing about one
 * file.
 *
 * ⚠ SESSION-ONLY IN v1, and that is a real difference from FRAMETABLE rather
 * than an oversight: nothing is written to IndexedDB and no descriptor is
 * stamped on the node, so a reload returns the slot to LIVE. Stated here because
 * the obvious next reader will look for the re-hydrate that frametable's factory
 * has and correctly not find one.
 */
export async function loadVideocubeSlotFile(
  nodeId: string,
  slot: VideocubeSlot,
  file: File,
): Promise<{ status: string | null; error: string | null }> {
  const fail = (error: string) => {
    writeSlotOutcome(nodeId, slot, 'file', false, error);
    return { status: null, error };
  };
  try {
    const bmp = await createImageBitmap(file);
    const geo = atlasGeometry(bmp.width, bmp.height);
    if (!geo.valid) {
      bmp.close?.();
      return fail(`not a ${FRAMETABLE_ATLAS_COLS}x${FRAMETABLE_ATLAS_ROWS} frametable atlas`);
    }
    const ve = videoEngine();
    if (!ve) { bmp.close?.(); return fail('video engine not ready'); }
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const cx = c.getContext('2d');
    if (!cx) { bmp.close?.(); return fail('no 2d context'); }
    cx.drawImage(bmp, 0, 0);
    c.dataset.videocubeSlot = slot;
    ve.attachExternalSource(nodeId, 'image', c);
    bmp.close?.();
    writeSlotOutcome(nodeId, slot, 'file', true, null);
    return { status: `file · ${geo.frames}f`, error: null };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
