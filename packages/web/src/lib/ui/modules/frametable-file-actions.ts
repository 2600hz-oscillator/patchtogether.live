// packages/web/src/lib/ui/modules/frametable-file-actions.ts
//
// The FRAMETABLE `.frametable.png` FILE actions, shared by the LEGACY CARD and
// the FACED shell cells so the two surfaces cannot drift.
//
// ⚠ WHY A SHARED MODULE RATHER THAN A SECOND IMPLEMENTATION. `shell-cells.ts`
// needs a file cell's `onFile` and an action cell's `onFire`, and
// `FrametableCard.svelte` already had both inline — roughly 120 lines of atlas
// encode, picker/download fallback, IndexedDB persistence and descriptor
// stamping. Re-implementing that beside the shell registry is how the SAVE on
// one surface starts writing a file the LOAD on the other cannot read, with
// nothing at runtime able to notice because each surface is self-consistent.
// This is the `milkdrop-preset-actions` / `wavecel-table-actions` shape: ONE
// module, imported by both.
//
// ⚠ THE ENGINE IS REACHED FROM PLAIN `.ts`, WHICH IS ALREADY THE NORM.
// `getActiveEngine()` is exported from `$lib/audio/engine-ref` and consumed from
// non-component modules today (`clipplayer.ts`, `push2-control.svelte.ts`,
// `milkdrop-preset-actions.ts`). The faceplate skill records that two
// independent agents invented a false blocker that a shell cell needs a platform
// PR to reach the engine; it does not.
//
// ⚠ WHAT IS *NOT* HERE, DELIBERATELY: the RE-HYDRATE. Restoring a saved table
// into the GPU ring after a reload is node-lifetime work, not view-lifetime
// work, so it moved into `frametableDef.factory` rather than into this module —
// see the FILE RE-HYDRATE block there. Putting it here would have kept it
// attached to whichever surface happened to call it, which is the bug promotion
// creates (#1531's rule).
//
// ⚠ THE TWO SAVES ARE DIFFERENT THINGS AND BOTH SHIP. The `saveTrig` press-pad
// snapshots the ring into an in-GPU slot for a VideoCube to read, and dies on
// reload. `saveFrametableFile` below writes a real lossless PNG atlas to disk.
// Neither substitutes for the other, and the def's `docs.controls` says so on
// both entries.

import { getActiveEngine } from '$lib/audio/engine-ref';
import { patch } from '$lib/graph/store';
import { setNodeParam } from '$lib/graph/mutate';
import type { VideoEngine } from '$lib/video/engine';
import {
  FRAMETABLE_ATLAS_COLS,
  FRAMETABLE_ATLAS_ROWS,
  FRAMETABLE_ATLAS_TILES,
  FRAMETABLE_FILE_ACCEPT,
  tileRect,
  atlasGeometry,
  atlasDimensions,
  flipRowsY,
  frametableFileName,
} from '$lib/video/frametable-atlas';
import {
  newFrametableFileId,
  putFrametableBlob,
  type FrametableFileMeta,
} from '$lib/video/frametable-file-store';
import { canSaveViaPicker } from '$lib/video/recorderbox-store';

/** The `accept` filter, re-exported from the ONE place that owns it so a caller
 *  never re-types the extension list. */
export { FRAMETABLE_FILE_ACCEPT };

/** The live video engine, or null before boot / mid-teardown. Never throws — a
 *  file cell must not take the faceplate down with it. */
function videoEngine(): VideoEngine | null {
  try {
    return getActiveEngine()?.getDomain<VideoEngine>('video') ?? null;
  } catch {
    return null;
  }
}

/** Stamp the tiny descriptor onto `node.data`. This is the ONLY half of a
 *  loaded/saved table that touches the Y.Doc — the multi-megabyte frame bytes
 *  live in IndexedDB, per browser, and never sync. */
function writeFileMeta(nodeId: string, meta: FrametableFileMeta): void {
  const target = patch.nodes[nodeId];
  if (!target) return;
  if (!target.data) target.data = {};
  (target.data as Record<string, unknown>).frametableFile = meta;
}

/**
 * Forward a decoded atlas to the factory over the external-source channel (so
 * `engine.ts` stays untouched) and FREEZE the ring.
 *
 * ⚠ THE FREEZE IS PART OF LOADING, NOT A CONVENIENCE. The ring keeps capturing
 * live input every frame; without it the table you just loaded is overwritten
 * frame by frame over the next ~2 seconds, and a player who loaded a table to
 * scan it would watch it dissolve. The card has always done this.
 */
function uploadAtlas(ve: VideoEngine, nodeId: string, source: CanvasImageSource & { width: number; height: number }): void {
  const c = document.createElement('canvas');
  c.width = source.width;
  c.height = source.height;
  const cx = c.getContext('2d');
  if (!cx) return;
  cx.drawImage(source, 0, 0);
  ve.attachExternalSource(nodeId, 'image', c);
  setNodeParam(nodeId, 'freeze', 1);
}

/**
 * Import a `.frametable.png` atlas: decode, validate the tile grid, detile it
 * into the 60-frame ring, and persist the bytes to this browser plus the
 * descriptor to the node.
 *
 * Returns the `{ status, error }` line `ShellFileCell` renders under the button.
 * ⚠ A REJECTED FILE REPORTS, IT DOES NOT THROW — the same outcomes the card's
 * own handler distinguishes (not an atlas / engine not ready / loaded), so the
 * two surfaces say the same thing about one file.
 */
export async function loadFrametableFile(
  nodeId: string,
  file: File,
): Promise<{ status: string | null; error: string | null }> {
  try {
    const bmp = await createImageBitmap(file);
    const geo = atlasGeometry(bmp.width, bmp.height);
    if (!geo.valid) {
      bmp.close?.();
      return {
        status: null,
        error: `not a ${FRAMETABLE_ATLAS_COLS}x${FRAMETABLE_ATLAS_ROWS} frametable atlas (${bmp.width}x${bmp.height})`,
      };
    }
    const ve = videoEngine();
    if (!ve) {
      bmp.close?.();
      return { status: null, error: 'video engine not ready — try again' };
    }
    uploadAtlas(ve, nodeId, bmp);
    bmp.close?.();
    const fid = newFrametableFileId();
    const meta: FrametableFileMeta = {
      id: fid, name: file.name, cols: geo.cols, rows: geo.rows,
      tileW: geo.tileW, tileH: geo.tileH, frames: geo.frames, size: file.size,
    };
    await putFrametableBlob(fid, file, file.name);
    writeFileMeta(nodeId, meta);
    return { status: `loaded ${geo.frames} frames ${geo.tileW}x${geo.tileH}`, error: null };
  } catch (e) {
    console.warn('[frametable] atlas import failed:', e);
    return { status: null, error: "couldn't load that .frametable.png" };
  }
}

/**
 * Save the current 60-frame ring as a lossless `.frametable.png` atlas: read the
 * layers back in chronological order, tile them into one contact sheet, write it
 * to disk, keep a copy in this browser and stamp the descriptor onto the node.
 *
 * ⚠ THE DESCRIPTOR WRITE IS THE OBSERVABLE, and that is why it is last. A file
 * write leaves nothing in the graph a gate could read — the browser's download
 * is outside the page entirely — so `node.data.frametableFile` is the only
 * evidence the press did anything, and it is what the faced SAVE cell's
 * `{ kind: 'data', key: 'frametableFile', expect: 'changed' }` probe reads.
 * Writing it BEFORE the disk write would make the probe green on a save that
 * never happened, which is the revision-only-probe pathology one kind over.
 */
export async function saveFrametableFile(
  nodeId: string,
): Promise<{ status: string | null; error: string | null }> {
  try {
    const ve = videoEngine();
    if (!ve) return { status: null, error: 'video engine not ready' };
    const rb = ve.read(nodeId, 'ringReadback') as
      | { w: number; h: number; layers: number; chrono: Uint8Array[] }
      | undefined;
    if (!rb || !rb.chrono || rb.chrono.length < FRAMETABLE_ATLAS_TILES) {
      return { status: null, error: 'ring not ready' };
    }
    const blob = await encodeAtlasBlob(rb.w, rb.h, rb.chrono);
    if (!blob) return { status: null, error: 'PNG encode failed' };
    const name = frametableFileName();
    await saveBlobToDisk(blob, name);
    const fid = newFrametableFileId();
    await putFrametableBlob(fid, blob, name);
    writeFileMeta(nodeId, {
      id: fid, name, cols: FRAMETABLE_ATLAS_COLS, rows: FRAMETABLE_ATLAS_ROWS,
      tileW: rb.w, tileH: rb.h, frames: FRAMETABLE_ATLAS_TILES, size: blob.size,
    });
    return { status: `saved ${name}`, error: null };
  } catch (err) {
    // AbortError = the user cancelled the picker — not an error to surface.
    if (err instanceof DOMException && err.name === 'AbortError') return { status: null, error: null };
    return { status: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Tile the chronological readback into an UPRIGHT PNG atlas (flip each
 *  bottom-origin readback tile). Pure canvas — NO codec (CI/SwiftShader-safe). */
function encodeAtlasBlob(w: number, h: number, chrono: Uint8Array[]): Promise<Blob | null> {
  const { width, height } = atlasDimensions(w, h);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const cx = canvas.getContext('2d');
  if (!cx) return Promise.resolve(null);
  for (let c = 0; c < FRAMETABLE_ATLAS_TILES; c++) {
    const src = chrono[c];
    if (!src || src.length < w * h * 4) continue;
    const upright = flipRowsY(src, w, h); // GL bottom-origin → top-origin (upright)
    const img = new ImageData(upright, w, h);
    const { sx, sy } = tileRect(c, w, h);
    cx.putImageData(img, sx, sy);
  }
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
}

async function saveBlobToDisk(blob: Blob, name: string): Promise<void> {
  if (canSaveViaPicker()) {
    const picker = (globalThis as unknown as {
      showSaveFilePicker: (o: unknown) => Promise<{ createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }> }>;
    }).showSaveFilePicker;
    try {
      const handle = await picker({
        suggestedName: name,
        types: [{ description: 'FrameTable atlas', accept: { 'image/png': ['.frametable.png', '.png'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err) {
      // User cancel bubbles up (handled by the caller); other picker failures
      // fall through to the <a download> blob path.
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
    }
  }
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
