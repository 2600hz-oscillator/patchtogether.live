// packages/web/src/lib/video/recorderbox-save-flow.ts
//
// Pure-ish save-FLOW glue shared by RecorderboxCard, factored out of the
// component so it's unit-testable without a Svelte harness:
//
//   * promptSaveDestination — prompt for the OUTPUT path at recording START
//     (the Record toggle is the user gesture). Returns a FileSystemFileHandle
//     (Chromium), null (Firefox/Safari → download later), or 'cancel' (user
//     dismissed the picker → do NOT start recording).
//   * streamToHandle — open a writable on a destination handle + stream an OPFS
//     scratch into it in chunks (correct name at the chosen path).
//
// Browser APIs are injected (showSaveFilePicker, the streaming copy) so the
// node unit tests drive them with fakes — no real OPFS / picker needed.

import {
  sanitizeRecordingFilename,
  canSaveViaPicker,
  streamOpfsToWritable,
  type ChunkSink,
} from './recorderbox-store';

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
