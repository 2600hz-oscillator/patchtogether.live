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
