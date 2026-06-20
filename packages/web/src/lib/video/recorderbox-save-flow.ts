// packages/web/src/lib/video/recorderbox-save-flow.ts
//
// Pure-ish save-FLOW glue shared by RecorderboxCard, factored out of the
// component so it's unit-testable without a Svelte harness:
//
//   * promptSaveFolder — pick a DESTINATION FOLDER ONCE (showDirectoryPicker).
//     This is the model the no-prompt save + GoPro chunking unify around: pick a
//     folder once → auto-write FILENAME-CHUNK#-DATETIME chunks into it with zero
//     further prompts. Returns a FileSystemDirectoryHandle (Chromium), null
//     (no picker → download fallback), or 'cancel' (user dismissed).
//   * fileExistsInDir — the OVERWRITE check: does a file with this exact name
//     already exist in the folder? (the ONLY remaining prompt — a safety net).
//   * fileHandleInDir — resolve (create) a writable file handle inside the
//     folder for a chunk name.
//   * promptSaveDestination — LEGACY single-file picker (kept as a fallback +
//     for the existing recovery flow). Returns a FileSystemFileHandle, null, or
//     'cancel'.
//   * streamToHandle — open a writable on a destination handle + stream an OPFS
//     scratch into it in chunks (correct name at the chosen path).
//
// Browser APIs are injected (showSaveFilePicker / showDirectoryPicker, the
// streaming copy) so the node unit tests drive them with fakes — no real OPFS /
// picker needed.

import {
  sanitizeRecordingFilename,
  canSaveViaPicker,
  canPickDirectory,
  streamOpfsToWritable,
  type ChunkSink,
} from './recorderbox-store';

// ---------------------------------------------------------------------------
// DIRECTORY-handle save model (Tweak 1 no-prompt + Tweak 3 chunking)
// ---------------------------------------------------------------------------

/** The structural subset of showDirectoryPicker we use. */
export type DirPicker = (o?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;

/** Result of asking the user for a destination FOLDER at recording START.
 *   * handle   → Chromium: auto-write chunks into it, no further prompts.
 *   * null     → no showDirectoryPicker (Firefox/Safari): download fallback.
 *   * 'cancel' → user dismissed the picker: caller must NOT start recording. */
export type SaveFolder = FileSystemDirectoryHandle | null | 'cancel';

/**
 * Prompt for the destination FOLDER at the START of recording (the Record toggle
 * is the user gesture). This is picked ONCE; subsequent records + every rolling
 * chunk write into it silently. Feature-detects showDirectoryPicker; on a
 * no-picker browser returns null so the caller falls back to <a download>. Any
 * picker rejection (incl. the user's AbortError dismissal) → 'cancel' so the
 * caller reverts the Record toggle.
 *
 * `picker`/`hasPicker` are injectable for tests; default to the real globals.
 */
export async function promptSaveFolder(
  deps: { picker?: DirPicker; hasPicker?: () => boolean } = {},
): Promise<SaveFolder> {
  const hasPicker = deps.hasPicker ?? canPickDirectory;
  if (!hasPicker()) return null;
  const picker =
    deps.picker ?? (globalThis as unknown as { showDirectoryPicker: DirPicker }).showDirectoryPicker;
  try {
    return await picker({ id: 'recorderbox', mode: 'readwrite' });
  } catch {
    // AbortError (dismiss) or any other rejection → treat as cancel.
    return 'cancel';
  }
}

/**
 * The OVERWRITE check: does a file with this EXACT name already exist in `dir`?
 * `getFileHandle(name, { create:false })` resolves if it exists, throws
 * NotFoundError otherwise. Because chunk names carry a unique DATETIME this is a
 * genuine safety net (real collisions are near-impossible), not per-save friction.
 * Never throws — an unreadable directory resolves false (don't block recording on
 * a flaky probe).
 */
export async function fileExistsInDir(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<boolean> {
  try {
    await (dir as unknown as {
      getFileHandle: (n: string, o?: { create?: boolean }) => Promise<FileSystemFileHandle>;
    }).getFileHandle(name, { create: false });
    return true;
  } catch {
    return false; // NotFoundError → does not exist (or unreadable → don't block).
  }
}

/** Resolve (creating) a writable file handle for `name` inside `dir` — the
 *  per-chunk destination the recorder writes each finalized chunk to. */
export async function fileHandleInDir(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemFileHandle> {
  return (dir as unknown as {
    getFileHandle: (n: string, o?: { create?: boolean }) => Promise<FileSystemFileHandle>;
  }).getFileHandle(name, { create: true });
}

/** The structural subset of showSaveFilePicker we use. */
export type SaveFilePicker = (o: {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileSystemFileHandle>;

/** Result of asking the user where to save AT START.
 *   * handle   → Chromium: stream to it on stop / recovery.
 *   * null     → Firefox/Safari (no picker): record to OPFS, download on stop.
 *   * 'cancel' → user dismissed the picker: caller must NOT start recording. */
export type SaveDestination = FileSystemFileHandle | null | 'cancel';

/**
 * Prompt for the save destination at the START of recording. Feature-detects
 * showSaveFilePicker; on a no-picker browser returns null so the caller records
 * to OPFS and downloads at stop. Any picker rejection (incl. the user's
 * AbortError dismissal) → 'cancel' so the caller reverts the Record toggle
 * rather than starting a recording with nowhere to land.
 *
 * `picker`/`hasPicker` are injectable for tests; default to the real globals.
 */
export async function promptSaveDestination(
  filename: string,
  deps: { picker?: SaveFilePicker; hasPicker?: () => boolean } = {},
): Promise<SaveDestination> {
  const hasPicker = deps.hasPicker ?? canSaveViaPicker;
  if (!hasPicker()) return null;
  const safeName = sanitizeRecordingFilename(filename, 'mp4');
  const picker =
    deps.picker ?? (globalThis as unknown as { showSaveFilePicker: SaveFilePicker }).showSaveFilePicker;
  try {
    return await picker({
      suggestedName: safeName,
      types: [{ description: 'MPEG-4 video', accept: { 'video/mp4': ['.mp4'] } }],
    });
  } catch {
    // AbortError (dismiss) or any other rejection → treat as cancel.
    return 'cancel';
  }
}

/**
 * Open a writable on `handle` and STREAM the OPFS scratch at `opfsPath` into it
 * in bounded chunks. Returns the total bytes written. The streaming copy is
 * injectable (defaults to the real `streamOpfsToWritable`) so tests can assert
 * chunked delivery without real OPFS.
 */
export async function streamToHandle(
  opfsPath: string,
  handle: FileSystemFileHandle,
  deps: {
    stream?: (path: string, sink: ChunkSink) => Promise<number>;
  } = {},
): Promise<number> {
  const stream = deps.stream ?? streamOpfsToWritable;
  const writable = await (handle as unknown as {
    createWritable: () => Promise<{
      write: (d: BufferSource | Blob) => Promise<void>;
      close: () => Promise<void>;
    }>;
  }).createWritable();
  const sink: ChunkSink = {
    write: (c) => writable.write(c),
    close: () => writable.close(),
  };
  return stream(opfsPath, sink);
}
