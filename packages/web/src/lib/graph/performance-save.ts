// packages/web/src/lib/graph/performance-save.ts
//
// Save the portable performance .zip bytes to a file the USER names — instead
// of force-downloading a fixed `performance.ptperf.zip`. Two paths, mirroring
// recorderbox-save-flow.ts:
//   * Chromium: showSaveFilePicker → the native Save dialog lets the user pick
//     the filename AND the location, then we stream the bytes to that handle.
//   * Firefox/Safari (no picker): window.prompt for a name, then <a download>
//     with that (sanitized, .zip-suffixed) name.
//
// Browser APIs (picker / prompt / download) are injected so this is fully
// unit-testable with fakes — no real picker, DOM, or filesystem needed.
//
// ── TWO ENTRY POINTS ───────────────────────────────────────────────────────
//   * `savePerformanceZip(bytes)`      — save an archive you already have.
//   * `savePerformanceZipStreaming(input)` — build the archive INTO the picked
//     file. Prefer it for the export flow: it never materialises the archive,
//     so the peak allocation is the resolved media plus one 4 MiB chunk
//     instead of the media plus a whole second copy of it (measured 3.53x →
//     1.22x of input; see performance-zip.ts's header).
//
// ── ⚠ PARTIAL-FILE CLEANUP, AND THE FILE WE MUST NOT DELETE ────────────────
// `createWritable()` writes to a swap file and only commits on `close()`, so
// `abort()` IS the partial-file cleanup for an overwrite: the user's existing
// file is left exactly as it was. We therefore NEVER call `handle.remove()` on
// a file that had content — a "cleanup" that deleted the show file someone
// chose to overwrite would be far worse than the stray file it tidied.
// The one file we do remove is the EMPTY one `showSaveFilePicker` creates when
// the user types a new name, because after an abort that leaves a 0-byte
// `.zip` looking like a saved performance.

import {
  buildPerformanceZip,
  streamPerformanceZip,
  PerformanceZipAborted,
  type PerformanceZipBundle,
  type ZipAbortLike,
} from './performance-zip';

/** The structural subset of showSaveFilePicker we use. */
export type ZipSavePicker = (o: {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileSystemFileHandle>;

/** Suggested default the dialog pre-fills (the user is free to change it). */
export const DEFAULT_PERF_ZIP_NAME = 'performance.ptperf.zip';

export type ZipSaveOutcome = 'saved' | 'cancelled';

/** Filesystem-safe name ending in `.zip`. Replaces whitespace + the chars
 *  Windows/macOS reject with `_`, drops leading dots, caps length, and
 *  guarantees the `.zip` extension. */
export function ensureZipName(name: string): string {
  const cleaned = (name ?? '')
    .trim()
    .replace(/\s+/g, '_') // whitespace → underscore
    .replace(/[/\\?%*:|"<>]+/g, '_') // path separators + reserved chars → underscore
    .replace(/^\.+/, '') // no leading dots (hidden / traversal)
    .replace(/_+/g, '_') // collapse runs
    .slice(0, 120)
    .replace(/^_+|_+$/g, ''); // trim stray underscores
  const base = cleaned.length > 0 ? cleaned : 'performance';
  return /\.zip$/i.test(base) ? base : `${base}.zip`;
}

interface SaveDeps {
  /** Override the suggested default name. */
  suggestedName?: string;
  /** Inject the picker; `null` forces the prompt+download fallback; `undefined`
   *  feature-detects `globalThis.showSaveFilePicker`. */
  picker?: ZipSavePicker | null;
  /** Inject the name prompt (defaults to `window.prompt`). */
  prompt?: (message: string, def: string) => string | null;
  /** Inject the anchor-download (defaults to a Blob + <a download>). */
  download?: (bytes: Uint8Array, name: string) => void;
}

/**
 * Save `bytes` as a performance `.zip` under a user-chosen filename. Returns
 * 'saved' or 'cancelled' (the user dismissed the picker / prompt) — never
 * throws for a normal cancel.
 */
export async function savePerformanceZip(bytes: Uint8Array, deps: SaveDeps = {}): Promise<ZipSaveOutcome> {
  const suggested = deps.suggestedName ?? DEFAULT_PERF_ZIP_NAME;
  const picker =
    deps.picker !== undefined
      ? deps.picker
      : typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function'
        ? ((globalThis as unknown as { showSaveFilePicker: ZipSavePicker }).showSaveFilePicker)
        : null;

  if (picker) {
    let handle: FileSystemFileHandle;
    try {
      handle = await picker({
        suggestedName: suggested,
        types: [{ description: 'Performance bundle', accept: { 'application/zip': ['.zip'] } }],
      });
    } catch {
      // AbortError (dialog dismissed) or any other rejection → treat as cancel.
      return 'cancelled';
    }
    const writable = await (handle as unknown as {
      createWritable: () => Promise<{ write: (d: BufferSource) => Promise<void>; close: () => Promise<void> }>;
    }).createWritable();
    await writable.write(bytes as unknown as BufferSource);
    await writable.close();
    return 'saved';
  }

  // Fallback: ask for a name, then anchor-download it.
  const promptFn =
    deps.prompt ?? ((m: string, d: string) => (typeof window !== 'undefined' ? window.prompt(m, d) : d));
  const chosen = promptFn('Save performance as:', suggested);
  if (chosen === null) return 'cancelled'; // user hit Cancel
  const name = ensureZipName(chosen);
  (deps.download ?? defaultDownload)(bytes, name);
  return 'saved';
}

// ── STREAMING SAVE ─────────────────────────────────────────────────────────

/** The structural subset of `FileSystemWritableFileStream` we use. `abort` is
 *  optional because older implementations (and simple test fakes) lack it. */
interface WritableLike {
  write(d: BufferSource | Uint8Array): Promise<void> | void;
  close(): Promise<void> | void;
  abort?: () => Promise<void> | void;
}

/** The structural subset of `FileSystemFileHandle` the streaming path needs. */
interface SaveHandleLike {
  createWritable: (o?: { keepExistingData?: boolean }) => Promise<WritableLike>;
  getFile?: () => Promise<{ size: number }>;
  /** Chromium 110+. Absent elsewhere — cleanup degrades to `abort()` alone. */
  remove?: () => Promise<void>;
}

export interface StreamSaveDeps extends SaveDeps {
  /** Cooperative cancellation, checked between chunks. */
  signal?: ZipAbortLike;
  /** Running output byte count, for a progress readout. */
  onProgress?: (bytesWritten: number) => void;
}

/**
 * Build the performance `.zip` DIRECTLY INTO the file the user picks.
 *
 * Returns 'saved', or 'cancelled' when the user dismissed the dialog/prompt OR
 * aborted mid-write. A cancelled write leaves no half-file behind: the swap
 * file is discarded by `abort()`, and a freshly-created empty target is removed
 * (see the header for the file we deliberately do NOT remove).
 *
 * ⚠ THE NO-PICKER FALLBACK STILL MATERIALISES. Firefox/Safari have no
 * streaming-to-disk API at all, so that path builds the buffer and
 * anchor-downloads it exactly as before. This is stated rather than hidden: the
 * memory win is real on Chromium — where the picker, the ES-9 rig and the show
 * machines live — and absent elsewhere.
 */
export async function savePerformanceZipStreaming(
  input: PerformanceZipBundle,
  deps: StreamSaveDeps = {},
): Promise<ZipSaveOutcome> {
  const suggested = deps.suggestedName ?? DEFAULT_PERF_ZIP_NAME;
  const picker =
    deps.picker !== undefined
      ? deps.picker
      : typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function'
        ? ((globalThis as unknown as { showSaveFilePicker: ZipSavePicker }).showSaveFilePicker)
        : null;

  if (!picker) {
    // No stream target exists — build the buffer and hand it to the fallback.
    // `onProgress` still fires once with the final size, so a caller reporting
    // "saved N KB" is not silently wrong on Firefox/Safari.
    const bytes = buildPerformanceZip(input);
    const outcome = await savePerformanceZip(bytes, deps);
    if (outcome === 'saved') deps.onProgress?.(bytes.length);
    return outcome;
  }

  let handle: SaveHandleLike;
  try {
    handle = (await picker({
      suggestedName: suggested,
      types: [{ description: 'Performance bundle', accept: { 'application/zip': ['.zip'] } }],
    })) as unknown as SaveHandleLike;
  } catch {
    return 'cancelled'; // AbortError (dialog dismissed) or any other rejection
  }

  // Was the target already carrying data? Only a target that was EMPTY when we
  // picked it is safe to remove on failure.
  let wasEmpty = false;
  try {
    wasEmpty = ((await handle.getFile?.())?.size ?? 0) === 0;
  } catch {
    wasEmpty = false; // unknown ⇒ treat as "has content", i.e. never remove
  }

  const writable = await handle.createWritable();
  try {
    await streamPerformanceZip(input, writable, {
      signal: deps.signal,
      onProgress: deps.onProgress,
    });
    return 'saved';
  } catch (e) {
    await discardPartial(writable, handle, wasEmpty);
    if (e instanceof PerformanceZipAborted) return 'cancelled';
    throw e;
  }
}

/** Roll back a failed/cancelled streaming write. Best-effort throughout: a
 *  cleanup that throws would mask the error that caused it. */
async function discardPartial(
  writable: WritableLike,
  handle: SaveHandleLike,
  wasEmpty: boolean,
): Promise<void> {
  try {
    // Discards the swap file. For an overwrite this is the whole cleanup: the
    // user's existing file is never touched.
    if (typeof writable.abort === 'function') await writable.abort();
    else await writable.close();
  } catch {
    /* already closed / not abortable */
  }
  if (!wasEmpty) return; // ⚠ never delete a file that had content
  try {
    await handle.remove?.();
  } catch {
    /* no remove() on this browser — the 0-byte file survives, harmlessly */
  }
}

function defaultDownload(bytes: Uint8Array, name: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* already revoked */
    }
  }, 60_000);
}
