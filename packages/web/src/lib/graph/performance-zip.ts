// packages/web/src/lib/graph/performance-zip.ts
//
// PORTABLE Performance Bundle — a self-contained `.zip` of an ENTIRE rackspace
// so it can be moved to another MACHINE and reloaded for a live show.
//
// This is the cross-machine sibling of graph/performance-bundle.ts +
// performance-store.ts (the IndexedDB "Save/Load Local Performance"), which is
// same-browser-profile ONLY because it relies on FileSystemFileHandles that
// can't leave the machine. Here we carry the actual asset BYTES inside the zip.
//
// WHAT NEEDS OUT-OF-BAND BYTES (everything else is INLINE in the patch
// envelope and rides along for free — see performance-bundle.ts):
//   * the patch graph (nodes/edges/params/positions) — base64 Yjs update;
//   * PICTUREBOX images, TOYBOX layer images / custom shader / custom OBJ,
//     SAMSLOOP samples — all base64/text inline on node.data;
//   * CV routes, control-surface bindings, module custom names — node.data;
//   * MIDI Learn CC maps + device/gamepad descriptors — in the manifest.
// The ONE thing the envelope can't carry is a VIDEOBOX (or TOYBOX layer) VIDEO:
// the card holds it as an ephemeral object URL, only fileMeta (name/size/
// duration/handleId) is persisted. So the caller resolves those bytes at export
// time and we store them as separate (large) zip entries — exactly as
// video/toybox-preset-io.ts does for a single TOYBOX, generalised to the rack.
//
// PURE: no DOM and no Worker — so it is fully unit-testable + safe to call
// anywhere. Round-trips exactly.
//
// ── TWO BUILDERS, AND WHICH ONE TO USE ─────────────────────────────────────
//   * `buildPerformanceZip`  — whole-output `zipSync`. Keep using it where the
//     destination WANTS one buffer: the quicksave/IndexedDB preset slots
//     (preset-slot-store.ts) and the e2e capture hook have no stream to write
//     into, so materialising is not avoidable there.
//   * `streamPerformanceZip` — writes the archive straight into a sink
//     (`FileSystemWritableFileStream`) in bounded chunks, releasing each media
//     buffer as it is consumed. Use it for the FILE save path.
//
// ── ⚠ WHY THE FILE PATH IS NOT ALLOWED TO USE zipSync ──────────────────────
// The measurement, 4x50 MB of incompressible (video-like) entries, RSS sampled
// synchronously at the point of maximum liveness:
//
//   zipSync, default level    peak 706 MB  = 3.53x input   4344 ms BLOCKING
//   zipSync, media STOREd     peak 443 MB  = 2.22x input    371 ms blocking
//   streamPerformanceZip      peak 244 MB  = 1.22x input    355 ms, chunked
//
// The 3.53x is not compression scratch — it is a WHOLE SECOND COPY of the
// archive coexisting with the input, and downstream `savePerformanceZip` then
// made a THIRD (`new Blob([bytes])` on the no-picker path). At the 100 MB
// per-slot ceiling × 7 VIDEOVARISPEED slots that is how a save becomes an OOM.
//
// And the owner constraint is stricter than "don't crash": a save must never
// even TEMPORARILY disrupt output. 4.3 s of unbroken main-thread work is a
// projector freeze whatever the audio graph is doing — which is exactly why
// moving this to a Worker would have been the wrong fix: it hides the stall
// from an audio-only continuity gate while the duplication (and the OOM) is
// still there, and while the video outputs still freeze.
//
// ── ⚠ LEVEL 0 ON MEDIA IS NOT A TRADE-OFF ──────────────────────────────────
// `zipSync` defaulted to level-6 DEFLATE over MP4/WebM/PCM — all already
// compressed. Measured on 8 MB incompressible: level 6 = 86 ms and the output
// GREW (8390512 vs 8388608 bytes); level 0 = 14 ms. The 200 MB case above
// bought ZERO bytes for ~4 s of main-thread CPU. STORE for media, DEFLATE for
// `performance.json` (which is real, compressible JSON).
//
// ⚠ TWOTRACKS PCM IS THE ONE MEDIA ROLE THAT WOULD COMPRESS, AND IT IS STILL
// STORED. Measured on a realistic 20 s stereo 16-bit reel (3.66 MB): deflate
// saved 20.7% (0.76 MB) for 74 ms of unbroken main-thread work; store took
// 7 ms. A rack with two TWOTRACKS is four reels — ~300 ms of blocking for
// ~3 MB. Against the standing constraint that a save must never even
// TEMPORARILY disrupt output, 300 ms is a visible projector stutter and 3 MB is
// nothing, so the whole media set is STOREd. Revisit only with a measurement,
// not a hunch — and note a reel is bounded by the worklet's fixed buffer, so
// this cost does not grow with session length.

import { zipSync, unzipSync, strToU8, strFromU8, Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import type { PerformanceBundle } from './performance-bundle';

/** Reject any single bundled video larger than this on import. This is a
 *  per-FILE sanity guard, NOT a per-bundle cap: a perf with 7 VIDEOVARISPEED
 *  slots is intended to be large (the owner explicitly accepts large bundles),
 *  so we never cap the bundle total or silently drop a populated slot. The
 *  ceiling matches VIDEOVARISPEED_MAX_SLOT_BYTES (the per-slot load limit the
 *  card enforces) so any file the card ACCEPTED into a slot also survives the
 *  round-trip — a 50 MB cap (the old value) would have rejected a legal slot. */
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100 MB (== per-slot load cap)

export const PERFORMANCE_ZIP_FORMAT = 'pt-performance-v1';
const MANIFEST_JSON = 'performance.json';
const MEDIA_DIR = 'media/';

/** One out-of-band media asset, resolved to raw bytes for the zip. Two kinds:
 *  - 'video' — a loaded VIDEOBOX / VIDEOVARISPEED clip (the bytes are seeded
 *    back into the video-file-store under `handleId` so the card re-acquires it);
 *  - 'audio' — a TWOTRACKS reel tape (recorded PCM with no source file; the
 *    loader re-sends it to the reel's worklet via `load-tape`). The `handleId`
 *    encodes the reel (`<nodeId>:a` / `<nodeId>:b`) so the loader routes it. */
export interface PerformanceMedia {
  /** Patch node id this asset belongs to. */
  nodeId: string;
  /** The stable id under which the restore side seeds/routes the bytes. For
   *  VIDEOBOX/VIDEOVARISPEED this is the node's fileMeta.handleId (so the card's
   *  tryReloadFromHandle picks it up); for TWOTRACKS it is `<nodeId>:<reel>`. */
  handleId: string;
  /** Asset role. */
  role: 'video' | 'audio';
  /** Original filename (display + restored File name + in-zip path). */
  name: string;
  /** Raw asset bytes. */
  bytes: Uint8Array;
  /** Asset slot index (0..6) for the 7-slot VIDEOVARISPEED selector. Omitted /
   *  0 = the single-video slot (VIDEOBOX, or VIDEOVARISPEED slot 0). Restored
   *  into the matching slot so all 7 videos come back in the right positions. */
  slot?: number;
}

/** Everything needed to reconstruct a whole performance: the manifest (patch
 *  envelope + mappings) + the out-of-band media bytes. */
export interface PerformanceZipBundle {
  /** The existing PerformanceBundle manifest (graph envelope + assets +
   *  midiBindings + midiDevices + gamepadBindings). */
  bundle: PerformanceBundle;
  /** Out-of-band video bytes (empty if the rack has no loaded videos). */
  media: PerformanceMedia[];
  /** Epoch-ms stamp (caller supplies; this module never reads the clock). */
  savedAt?: number;
}

/** In-manifest descriptor for one stored media entry (the bytes live at `path`). */
interface MediaEntry {
  nodeId: string;
  handleId: string;
  role: 'video' | 'audio';
  name: string;
  path: string;
  /** Asset slot (0..6); omitted ⇒ 0 (single-video back-compat). */
  slot?: number;
}

interface PerformanceManifest {
  format: string;
  savedAt: number;
  bundle: PerformanceBundle;
  media: MediaEntry[];
}

/** Filesystem-safe in-zip filename fragment. */
function sanitize(name: string): string {
  return (name || 'video').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}

/**
 * ZIP ENTRY MOD-TIME — the one clock read this format used to have, and the
 * reason "deterministic for a fixed input" was FALSE of the container.
 *
 * `zipSync` stamps every entry's DOS mod-time from `Date.now()` when none is
 * supplied. DOS time has **2-second** granularity, so two builds of byte-
 * identical input straddling a 2 s boundary differ — in the mod-time low byte,
 * written TWICE PER ENTRY (once in the local file header, once in the central
 * directory). Measured directly: a 1-entry zip moves at offsets 10 and 67
 * (39 → 40 across a 2.5 s gap); this module's 2-entry test bundle moves at
 * 10, 723, 800 and 862.
 *
 * That made `performance-zip.test.ts`'s determinism leg a latent flake — it
 * passed whenever both `buildPerformanceZip` calls happened to land in the same
 * 2 s bucket, which is nearly always locally and less often on a loaded runner.
 * It is also a real defect beyond the test: a `.ptperf` saved twice from
 * identical state produced different bytes, so nothing downstream could
 * content-hash, dedupe or diff a bundle.
 *
 * Supplying the mtime from the input's own `savedAt` makes the archive a pure
 * function of its input while keeping a meaningful timestamp (production passes
 * `Date.now()`). The clamp exists because fflate hard-throws
 * `date not in range 1980-2099` — and it converts using LOCAL time, so a UTC
 * 1980-01-01 floor is already out of range west of Greenwich. 1981 gives a full
 * year of slack in either direction.
 */
const DOS_SAFE_MIN_MS = Date.UTC(1981, 0, 1);
const DOS_SAFE_MAX_MS = Date.UTC(2098, 0, 1);
function zipEntryMtime(savedAt: number): number {
  return Number.isFinite(savedAt) && savedAt >= DOS_SAFE_MIN_MS && savedAt <= DOS_SAFE_MAX_MS
    ? savedAt
    : DOS_SAFE_MIN_MS;
}

/** Deflate level for `performance.json` — real, compressible JSON. */
const MANIFEST_LEVEL = 6;
/** STORE for media: MP4/WebM/PCM are already compressed. See the header. */
const MEDIA_LEVEL = 0;

/** Plan the manifest + the in-zip path for every media entry. Shared by BOTH
 *  builders so the streaming archive and the buffered archive can never
 *  disagree about a path, an index, or a slot. */
function planEntries(input: PerformanceZipBundle): {
  manifestBytes: Uint8Array;
  mtime: number;
  paths: string[];
} {
  const media: MediaEntry[] = input.media.map((m, i) => ({
    nodeId: m.nodeId,
    handleId: m.handleId,
    role: m.role,
    name: m.name,
    // include role + `i` + handleId so two assets on the same node (e.g. a
    // TWOTRACKS reel a + reel b, or 7 VIDEOVARISPEED slots) and same-named clips
    // on different nodes don't collide. (`i` is the global media index, so the
    // path is unique even before considering handleId/slot.)
    path: `${MEDIA_DIR}${m.role}-${i}-${sanitize(m.handleId)}-${sanitize(m.name)}`,
    // Only emit slot when non-zero so a single-video manifest stays byte-identical
    // to the pre-multi-slot format (back-compat + deterministic).
    ...(m.slot && m.slot > 0 ? { slot: m.slot } : {}),
  }));
  const manifest: PerformanceManifest = {
    format: PERFORMANCE_ZIP_FORMAT,
    savedAt: input.savedAt ?? 0,
    bundle: input.bundle,
    media,
  };
  return {
    manifestBytes: strToU8(JSON.stringify(manifest)),
    mtime: zipEntryMtime(manifest.savedAt),
    paths: media.map((m) => m.path),
  };
}

/** Build the `.zip` bytes for a whole-rack performance bundle. Deterministic
 *  for a fixed input — no clock or random read anywhere, INCLUDING the zip
 *  container's own entry mod-times (see `zipEntryMtime`).
 *
 *  MATERIALISES THE WHOLE ARCHIVE. Correct for the quicksave/IndexedDB slots
 *  and the e2e capture hook, which need one buffer. The FILE save path uses
 *  `streamPerformanceZip` instead — see the header for the measured reason. */
export function buildPerformanceZip(input: PerformanceZipBundle): Uint8Array {
  const { manifestBytes, mtime, paths } = planEntries(input);
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 | 6 }]> = {};
  files[MANIFEST_JSON] = [manifestBytes, { level: MANIFEST_LEVEL }];
  input.media.forEach((m, i) => {
    // STORE: media is already-compressed MP4/WebM/PCM. Deflating it cost ~4 s
    // of blocked main thread per 200 MB and returned a slightly LARGER archive.
    files[paths[i]!] = [m.bytes, { level: MEDIA_LEVEL }];
  });
  return zipSync(files, { mtime });
}

// ── STREAMING BUILDER — the file save path ────────────────────────────────

/** Minimal sink the streaming builder writes into: the structural subset of a
 *  `FileSystemWritableFileStream` (what `handle.createWritable()` returns).
 *  Narrow so a unit test can supply an in-memory capture — the same shape
 *  recorderbox's `ChunkSink` already uses for its OPFS→disk copy. */
export interface ZipChunkSink {
  write(chunk: Uint8Array): Promise<void> | void;
  close(): Promise<void> | void;
}

/** Cooperative cancellation — the structural subset of `AbortSignal`. */
export interface ZipAbortLike {
  readonly aborted: boolean;
}

/** Thrown when `signal.aborted` is observed mid-write. The save path catches
 *  THIS specifically to distinguish "user cancelled" (delete the partial file,
 *  report 'cancelled') from a real failure. */
export class PerformanceZipAborted extends Error {
  constructor() {
    super('Performance zip export was cancelled');
    this.name = 'PerformanceZipAborted';
  }
}

export interface StreamPerformanceZipOptions {
  /** Bytes pushed into the compressor per turn. 4 MiB matches recorderbox's
   *  COPY_CHUNK_BYTES: big enough that syscall overhead is noise, small enough
   *  that peak memory is the input plus one chunk. */
  chunkBytes?: number;
  /** Checked before every chunk. Aborting throws `PerformanceZipAborted`. */
  signal?: ZipAbortLike;
  /** Called after each sink write with the running output byte count. */
  onProgress?: (bytesWritten: number) => void;
  /**
   * Drop each media buffer as it is consumed (default TRUE).
   *
   * ⚠ THIS CONSUMES `input.media`: every entry's `bytes` is replaced with an
   * empty array once written. That is the point — it is the only way the
   * resolved video bytes can be reclaimed DURING the save rather than after
   * it, and it takes the measured peak from 2.2x the input to 1.2x. Pass
   * `false` when the caller still needs the bytes (a test, or a second write).
   */
  release?: boolean;
}

/** Default chunk size for the streaming build (matches recorderbox). */
export const ZIP_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Write a whole-rack performance `.zip` STRAIGHT INTO `sink`, never
 * materialising the archive.
 *
 * Returns the total bytes written. Closes the sink on success; on abort or
 * failure it does NOT close — the caller owns the partial-file cleanup, since
 * only the caller knows whether the destination can be removed.
 *
 * ⚠ THE OUTPUT IS NOT BYTE-IDENTICAL TO `buildPerformanceZip`, and cannot be:
 * a streaming writer does not know an entry's CRC or compressed size before it
 * writes the local header, so it emits DATA DESCRIPTORS after each entry
 * (+16 bytes per entry). Both archives are valid zips, both round-trip through
 * `parsePerformanceZip`, and each is deterministic for a fixed input — the
 * round-trip equivalence is what the test asserts, not the container bytes.
 *
 * BACKPRESSURE IS REAL: fflate's `Zip` hands chunks back synchronously, so
 * they are queued and drained with `await sink.write(...)` between pushes. The
 * queue therefore holds at most one chunk's worth of output, and a slow disk
 * slows the producer instead of growing a buffer behind it.
 */
export async function streamPerformanceZip(
  input: PerformanceZipBundle,
  sink: ZipChunkSink,
  opts: StreamPerformanceZipOptions = {},
): Promise<number> {
  const chunkBytes = Math.max(1, opts.chunkBytes ?? ZIP_CHUNK_BYTES);
  const release = opts.release !== false;
  const { manifestBytes, mtime, paths } = planEntries(input);

  const pending: Uint8Array[] = [];
  let failure: Error | null = null;
  const zip = new Zip((err, chunk) => {
    if (err) {
      failure ??= err instanceof Error ? err : new Error(String(err));
      return;
    }
    if (chunk && chunk.length > 0) pending.push(chunk);
  });

  let written = 0;
  /** Drain everything fflate has produced, awaiting the sink for backpressure. */
  const drain = async (): Promise<void> => {
    while (pending.length > 0) {
      const chunk = pending.shift()!;
      await sink.write(chunk);
      written += chunk.length;
      opts.onProgress?.(written);
    }
    if (failure) throw failure;
  };

  const checkAbort = (): void => {
    if (opts.signal?.aborted) throw new PerformanceZipAborted();
  };

  /** Push one entry through the compressor in bounded chunks. */
  const writeEntry = async (path: string, bytes: Uint8Array, level: 0 | 6): Promise<void> => {
    const f = level === 0 ? new ZipPassThrough(path) : new ZipDeflate(path, { level });
    f.mtime = mtime;
    zip.add(f);
    if (bytes.length === 0) {
      f.push(new Uint8Array(0), true);
      await drain();
      return;
    }
    for (let off = 0; off < bytes.length; off += chunkBytes) {
      checkAbort();
      const end = Math.min(off + chunkBytes, bytes.length);
      f.push(bytes.subarray(off, end), end >= bytes.length);
      await drain();
    }
  };

  checkAbort();
  await writeEntry(MANIFEST_JSON, manifestBytes, MANIFEST_LEVEL);
  for (let i = 0; i < input.media.length; i++) {
    const m = input.media[i]!;
    await writeEntry(paths[i]!, m.bytes, MEDIA_LEVEL);
    // Release AFTER the entry is fully pushed: the whole point of streaming is
    // that a 100 MB slot stops being resident the moment it has been written.
    if (release) m.bytes = EMPTY_BYTES;
  }
  zip.end();
  await drain();
  await sink.close();
  return written;
}

/** Shared zero-length placeholder for released media buffers. */
const EMPTY_BYTES = new Uint8Array(0);

/** Parse a performance `.zip` back into a bundle. Throws a user-surfaceable
 *  message on an empty/corrupt/foreign zip. Oversized videos are rejected;
 *  referenced-but-missing media is skipped (the node falls back to re-link). */
export function parsePerformanceZip(zip: ArrayBuffer | Uint8Array): PerformanceZipBundle {
  const bytes = zip instanceof Uint8Array ? zip : new Uint8Array(zip);
  if (bytes.length === 0) throw new Error('Performance zip is empty');
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (e) {
    throw new Error(`Performance zip is corrupt: ${e instanceof Error ? e.message : String(e)}`);
  }
  const mj = entries[MANIFEST_JSON];
  if (!mj) {
    throw new Error('Performance zip is missing performance.json (not a performance bundle?)');
  }
  let manifest: PerformanceManifest;
  try {
    manifest = JSON.parse(strFromU8(mj)) as PerformanceManifest;
  } catch (e) {
    throw new Error(`performance.json is invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (manifest.format !== PERFORMANCE_ZIP_FORMAT) {
    throw new Error(
      `Performance bundle format '${manifest.format}' is unsupported (expected ${PERFORMANCE_ZIP_FORMAT})`,
    );
  }
  if (!manifest.bundle || typeof manifest.bundle !== 'object') {
    throw new Error('performance.json has no `bundle` manifest');
  }
  const media: PerformanceMedia[] = [];
  for (const m of manifest.media ?? []) {
    const mbytes = entries[m.path];
    if (!mbytes) continue; // referenced media missing → skip (node re-links)
    // The 50 MB cap guards the heavy out-of-band VIDEO assets. TWOTRACKS audio
    // tapes are bounded by the worklet's fixed buffer (≈20 s stereo, well under
    // the cap) but we apply the same ceiling defensively to any bundled asset.
    if (mbytes.length > MAX_VIDEO_BYTES) {
      throw new Error(
        `Bundled ${m.role} '${m.name}' is ${(mbytes.length / 1048576).toFixed(0)} MB — exceeds the ${(MAX_VIDEO_BYTES / 1048576).toFixed(0)} MB limit`,
      );
    }
    media.push({
      nodeId: m.nodeId,
      handleId: m.handleId,
      role: m.role,
      name: m.name,
      bytes: mbytes,
      // slot absent in older manifests ⇒ 0 (the single-video slot).
      slot: typeof m.slot === 'number' ? m.slot : 0,
    });
  }
  // A `mode` stamp written by the two-shell era is simply IGNORED here (and
  // `PerformanceManifest` no longer declares it): there is one rack shell, so
  // there is nothing for it to select. Old zips still load — the extra manifest
  // key is inert, exactly as an old loader treated it when it was added.
  return { bundle: manifest.bundle, media, savedAt: manifest.savedAt };
}

/** True if `bytes` looks like a performance zip (cheap pre-check — peeks for
 *  the performance.json entry). */
export function isPerformanceZip(zip: ArrayBuffer | Uint8Array): boolean {
  try {
    const bytes = zip instanceof Uint8Array ? zip : new Uint8Array(zip);
    if (bytes.length === 0) return false;
    const entries = unzipSync(bytes);
    return !!entries[MANIFEST_JSON];
  } catch {
    return false;
  }
}
