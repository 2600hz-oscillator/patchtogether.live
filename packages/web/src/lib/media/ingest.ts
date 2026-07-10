// packages/web/src/lib/media/ingest.ts
//
// Drop-ingestion core for the media-loader view (/media). PURE + unit-testable:
// no DOM side effects, no globals — it takes a structural DataTransfer-like
// object (the real one from a drop event, or a mock in tests) and resolves it
// to a flat, classified list of media files.
//
// Handles:
//   - plain multi-file drops (DataTransfer.items → getAsFile, with a
//     DataTransfer.files fallback for environments without items support);
//   - FOLDER drops, recursively, via webkitGetAsEntry()/FileSystemEntry —
//     including mixed file+folder drops and nested directories;
//   - per-ENTRY failure isolation: a symlink/permission error on one entry
//     rejects THAT entry (name + reason) and keeps ingesting its siblings —
//     one broken file never poisons the whole drop;
//   - kind sniffing → 'video' | 'image' | 'audio' (MIME first, extension
//     fallback). Unsupported files are REPORTED in `rejected` (name + reason),
//     never silently dropped.
//
// The `*Like` structural interfaces exist because jsdom/vitest have no
// FileSystemEntry — unit tests build mock entry trees against these shapes,
// and the real browser objects satisfy them structurally.

// ---------------------------------------------------------------------------
// Kinds + sniffing
// ---------------------------------------------------------------------------

export type MediaKind = 'video' | 'image' | 'audio';

/** MIME prefix → kind. Checked FIRST — the browser's type is authoritative
 *  when it says something media-shaped. */
const MIME_PREFIX_TO_KIND: ReadonlyArray<readonly [string, MediaKind]> = [
  ['video/', 'video'],
  ['image/', 'image'],
  ['audio/', 'audio'],
];

/** Extension → kind fallback, for files with an empty or generic MIME
 *  (folder-traversal Files and Windows drops often report '' or
 *  'application/octet-stream'). The practical set we can actually preview. */
const EXT_TO_KIND: Readonly<Record<string, MediaKind>> = {
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  wav: 'audio',
  mp3: 'audio',
  ogg: 'audio',
  flac: 'audio',
  m4a: 'audio',
  aiff: 'audio',
};

/**
 * Classify a file by MIME type first, extension fallback second.
 * Returns null for anything we can't treat as media (the caller reports it).
 */
export function sniffKind(name: string, mimeType?: string): MediaKind | null {
  const mime = (mimeType ?? '').toLowerCase();
  for (const [prefix, kind] of MIME_PREFIX_TO_KIND) {
    if (mime.startsWith(prefix)) return kind;
  }
  // Extension fallback. lastIndexOf > 0 also excludes dotfiles (`.DS_Store`
  // has no extension in the meaningful sense).
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return EXT_TO_KIND[name.slice(dot + 1).toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Structural types (real DOM objects satisfy these; tests mock them)
// ---------------------------------------------------------------------------

export interface FileSystemDirectoryReaderLike {
  readEntries(
    onSuccess: (entries: FileSystemEntryLike[]) => void,
    onError?: (err: unknown) => void,
  ): void;
}

export interface FileSystemEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  /** Present on file entries. May invoke onError (permission/symlink/IO). */
  file?(onSuccess: (file: File) => void, onError?: (err: unknown) => void): void;
  /** Present on directory entries. */
  createReader?(): FileSystemDirectoryReaderLike;
}

export interface DataTransferItemLike {
  kind: string;
  getAsFile(): File | null;
  webkitGetAsEntry?(): FileSystemEntryLike | null;
}

export interface DataTransferLike {
  items?: ArrayLike<DataTransferItemLike>;
  files?: ArrayLike<File>;
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface AcceptedMedia {
  file: File;
  kind: MediaKind;
  /** Path relative to the drop: `name.ext` for a bare file drop,
   *  `folder/sub/name.ext` for files inside a dropped folder. */
  relativePath: string;
}

export interface RejectedMedia {
  name: string;
  relativePath: string;
  /** Human-readable reason ('unsupported type …', 'file read failed: …'). */
  reason: string;
}

export interface IngestResult {
  accepted: AcceptedMedia[];
  rejected: RejectedMedia[];
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function errMsg(err: unknown): string {
  if (err && typeof err === 'object') {
    // Errors + DOMExceptions: prefer the message; permission/NotFound
    // DOMExceptions often ship an EMPTY message, so fall back to the name.
    const e = err as { message?: unknown; name?: unknown };
    if (typeof e.message === 'string' && e.message) return e.message;
    if (typeof e.name === 'string' && e.name) return e.name;
  }
  return String(err);
}

function classify(file: File, relativePath: string, out: IngestResult): void {
  const kind = sniffKind(file.name, file.type);
  if (kind) {
    out.accepted.push({ file, kind, relativePath });
  } else {
    out.rejected.push({
      name: file.name,
      relativePath,
      reason: `unsupported type (${file.type || 'unknown'})`,
    });
  }
}

/** Promisify FileSystemFileEntry.file() (success/error callback API). */
function entryFile(entry: FileSystemEntryLike): Promise<File> {
  return new Promise((resolve, reject) => {
    try {
      entry.file!(resolve, reject);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Drain a directory reader. readEntries returns results in BATCHES (Chromium
 * caps each call at 100 entries) — keep calling until an empty batch signals
 * the end, or the whole listing silently truncates at 100.
 */
async function readAllEntries(
  reader: FileSystemDirectoryReaderLike,
): Promise<FileSystemEntryLike[]> {
  const all: FileSystemEntryLike[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntryLike[]>((resolve, reject) => {
      try {
        reader.readEntries(resolve, reject);
      } catch (err) {
        reject(err);
      }
    });
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

/** Recursively ingest one FileSystemEntry. Failures are PER-ENTRY: a broken
 *  child lands in `rejected` and its siblings still ingest. */
async function ingestEntry(
  entry: FileSystemEntryLike,
  parentPath: string,
  out: IngestResult,
): Promise<void> {
  const path = parentPath ? `${parentPath}/${entry.name}` : entry.name;

  if (entry.isDirectory && entry.createReader) {
    let children: FileSystemEntryLike[];
    try {
      children = await readAllEntries(entry.createReader());
    } catch (err) {
      out.rejected.push({
        name: entry.name,
        relativePath: path,
        reason: `directory read failed: ${errMsg(err)}`,
      });
      return;
    }
    for (const child of children) {
      await ingestEntry(child, path, out);
    }
    return;
  }

  if (entry.isFile && entry.file) {
    let file: File;
    try {
      file = await entryFile(entry);
    } catch (err) {
      // Symlink targets, permission errors, files deleted mid-drop, … —
      // reject THIS entry, keep going.
      out.rejected.push({
        name: entry.name,
        relativePath: path,
        reason: `file read failed: ${errMsg(err)}`,
      });
      return;
    }
    classify(file, path, out);
    return;
  }

  out.rejected.push({
    name: entry.name,
    relativePath: path,
    reason: 'unsupported entry (neither readable file nor directory)',
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ingest a FileList (the hidden <input type="file"> / webkitdirectory browse
 * fallback). Synchronous — inputs hand us Files directly. For directory picks
 * the browser stamps `webkitRelativePath`; we preserve it so folder context
 * survives the browse path too.
 */
export function ingestFiles(files: ArrayLike<File>): IngestResult {
  const out: IngestResult = { accepted: [], rejected: [] };
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const rel =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    classify(file, rel, out);
  }
  return out;
}

/**
 * Ingest a drop event's DataTransfer: plain files, folders (recursive), or a
 * mix. Never throws for a bad entry — per-entry failures land in `rejected`.
 *
 * NOTE the two-phase shape: Chromium CLEARS DataTransfer.items as soon as the
 * drop handler yields to the event loop, so every webkitGetAsEntry()/
 * getAsFile() call happens SYNCHRONOUSLY up front; only the (async) traversal
 * of the snapshotted entries happens after.
 */
export async function ingestDrop(dt: DataTransferLike): Promise<IngestResult> {
  const out: IngestResult = { accepted: [], rejected: [] };

  // Phase 1 — synchronous snapshot (see NOTE above).
  const roots: Array<{ entry: FileSystemEntryLike | null; file: File | null }> = [];
  const items = dt.items;
  if (items && items.length > 0) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind !== 'file') continue; // strings/HTML fragments — not ours
      const entry =
        typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
      // getAsFile() must ALSO run synchronously, so resolve it here when the
      // entry API is unavailable (or returned null for a non-fs item).
      const file = entry ? null : item.getAsFile();
      if (entry || file) roots.push({ entry, file });
    }
  } else if (dt.files && dt.files.length > 0) {
    // items-less DataTransfer (older engines / some synthetic events).
    return ingestFiles(dt.files);
  }

  // Phase 2 — async traversal of the snapshot.
  for (const root of roots) {
    if (root.entry) {
      await ingestEntry(root.entry, '', out);
    } else if (root.file) {
      classify(root.file, root.file.name, out);
    }
  }
  return out;
}
