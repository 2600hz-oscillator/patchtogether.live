// packages/web/src/lib/media/library.svelte.ts
//
// The CENTRALIZED media library — the single place every loaded media file
// lands, and THE SEAM future consumers read. The media-loader view's output
// panel lists `mediaLibrary.items`; later consumers (e.g. rack modules that
// want a dropped clip as a source) read the same array. Svelte 5 runes store
// (`.svelte.ts` — runes only compile in Svelte modules, hence not a bare
// `library.ts`), singleton per page, matching the codebase's store convention
// (cf. video-aspect-store.svelte.ts).
//
// ── Public seam (consumers) ────────────────────────────────────────────────
//   mediaLibrary.items                 reactive MediaItem[] — read it inside
//                                      $derived/effects and you re-render on
//                                      add/remove/clear AND on per-item status
//                                      flips ('probing' → 'ready'/'failed').
//   mediaLibrary.add(accepted)         ingest.ts AcceptedMedia[] → AddResult
//                                      (what was added vs. duplicate-skipped).
//   mediaLibrary.remove(id) / .clear() lifecycle; both REVOKE object URLs.
//   mediaLibrary.get(id)               single-item lookup.
//   item.objectUrl                     a live object URL for <video>/<img>/
//                                      <audio> src — valid until remove/clear.
//                                      Consumers must NOT revoke it themselves;
//                                      the library owns the URL lifecycle.
//
// ── Behavior ───────────────────────────────────────────────────────────────
//   - Stable ids (`media-N`, monotonic per page) — safe as keyed-each keys and
//     as references handed to future consumers.
//   - Duplicate detection by (name, size, lastModified): a re-dropped file is
//     SKIPPED with a notice in AddResult.skipped, never double-added.
//   - Object-URL lifecycle: created on add, revoked on remove/clear. Nothing
//     else may revoke (leaked object URLs pin whole files in memory).
//   - Async metadata probing per kind (video: duration+dimensions, image:
//     dimensions, audio: duration): items are listed IMMEDIATELY with
//     status 'probing', then flip to 'ready' (meta filled) or 'failed'
//     (probeError set, item still usable — the browser may still play it).
//
// DELIBERATELY NOT HERE (yet): persistence (items live for the page session),
// rack-output integration, upload. Those arrive with the real UI.
//
// Construction is injectable (URL factory + probe) so unit tests run in plain
// node with spies; the exported singleton wires the real browser APIs.

import type { AcceptedMedia, MediaKind } from './ingest';
import { probeMedia, type ProbedMeta } from './probe';

export type { ProbedMeta };

export type MediaItemStatus = 'probing' | 'ready' | 'failed';

export interface MediaItem {
  readonly id: string;
  readonly file: File;
  readonly kind: MediaKind;
  /** Path relative to the drop (folder context), e.g. `loops/kick.wav`. */
  readonly relativePath: string;
  readonly name: string;
  readonly size: number;
  readonly lastModified: number;
  /** Live object URL for previews/players. Owned by the library. */
  readonly objectUrl: string;
  status: MediaItemStatus;
  meta: ProbedMeta;
  /** Set when status === 'failed' (the probe's failure reason). */
  probeError?: string;
}

export interface SkippedDuplicate {
  name: string;
  relativePath: string;
  reason: string;
}

export interface AddResult {
  added: MediaItem[];
  skipped: SkippedDuplicate[];
}

export interface MediaLibraryOptions {
  /** Object-URL factory — defaults to URL.createObjectURL. */
  createObjectUrl?: (file: File) => string;
  /** Object-URL disposal — defaults to URL.revokeObjectURL. */
  revokeObjectUrl?: (url: string) => void;
  /** Metadata probe — defaults to the DOM-based probeMedia. */
  probe?: (kind: MediaKind, objectUrl: string, file: File) => Promise<ProbedMeta>;
}

function dupeKey(file: File): string {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

export class MediaLibrary {
  /** The reactive item list — the seam consumers read (see module header). */
  items = $state<MediaItem[]>([]);

  private nextId = 1;
  private keys = new Set<string>();
  private readonly createObjectUrl: (file: File) => string;
  private readonly revokeObjectUrl: (url: string) => void;
  private readonly probe: (
    kind: MediaKind,
    objectUrl: string,
    file: File,
  ) => Promise<ProbedMeta>;

  constructor(opts: MediaLibraryOptions = {}) {
    this.createObjectUrl = opts.createObjectUrl ?? ((f) => URL.createObjectURL(f));
    this.revokeObjectUrl = opts.revokeObjectUrl ?? ((u) => URL.revokeObjectURL(u));
    this.probe = opts.probe ?? ((kind, url) => probeMedia(kind, url));
  }

  get count(): number {
    return this.items.length;
  }

  get(id: string): MediaItem | undefined {
    return this.items.find((i) => i.id === id);
  }

  /**
   * Add ingested media (ingest.ts output). Duplicates — same name+size+
   * lastModified as an item already in the library OR earlier in this same
   * batch — are skipped with a notice. Each added item starts 'probing'; its
   * probe settles asynchronously (status flips reactively).
   */
  add(entries: AcceptedMedia[]): AddResult {
    const added: MediaItem[] = [];
    const skipped: SkippedDuplicate[] = [];
    for (const entry of entries) {
      const key = dupeKey(entry.file);
      if (this.keys.has(key)) {
        skipped.push({
          name: entry.file.name,
          relativePath: entry.relativePath,
          reason: 'already in library (same name, size and modification time)',
        });
        continue;
      }
      this.keys.add(key);
      const id = `media-${this.nextId++}`;
      const objectUrl = this.createObjectUrl(entry.file);
      this.items.push({
        id,
        file: entry.file,
        kind: entry.kind,
        relativePath: entry.relativePath,
        name: entry.file.name,
        size: entry.file.size,
        lastModified: entry.file.lastModified,
        objectUrl,
        status: 'probing',
        meta: {},
      });
      // Read back through the $state proxy so probe-settle mutations below
      // (and any caller mutations) are reactive.
      const item = this.items[this.items.length - 1];
      added.push(item);
      void this.runProbe(id, entry.kind, objectUrl, entry.file);
    }
    return { added, skipped };
  }

  /** Remove one item; revokes its object URL(s). Returns false for unknown ids. */
  remove(id: string): boolean {
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx < 0) return false;
    const item = this.items[idx];
    this.revokeObjectUrl(item.objectUrl);
    if (item.meta.posterUrl) this.revokeObjectUrl(item.meta.posterUrl);
    this.keys.delete(dupeKey(item.file));
    this.items.splice(idx, 1);
    return true;
  }

  /** Remove everything; revokes every object URL (posters included). */
  clear(): void {
    for (const item of this.items) {
      this.revokeObjectUrl(item.objectUrl);
      if (item.meta.posterUrl) this.revokeObjectUrl(item.meta.posterUrl);
    }
    this.keys.clear();
    this.items = [];
  }

  private async runProbe(
    id: string,
    kind: MediaKind,
    objectUrl: string,
    file: File,
  ): Promise<void> {
    let meta: ProbedMeta | null = null;
    let failure: string | null = null;
    try {
      meta = await this.probe(kind, objectUrl, file);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    // Look the item up NOW — it may have been removed (URL already revoked)
    // while the probe was in flight; in that case there is nothing to update
    // — but a poster URL the probe minted for the ghost item must still be
    // revoked here, or it leaks (nobody else ever sees it).
    const item = this.get(id);
    if (!item) {
      if (meta?.posterUrl) this.revokeObjectUrl(meta.posterUrl);
      return;
    }
    if (meta) {
      item.meta = meta;
      item.status = 'ready';
    } else {
      item.status = 'failed';
      item.probeError = failure ?? 'probe failed';
    }
  }
}

/** Test seam / multi-instance factory. */
export function createMediaLibrary(opts: MediaLibraryOptions = {}): MediaLibrary {
  return new MediaLibrary(opts);
}

/** The page-wide singleton — the "centralized place". */
export const mediaLibrary = createMediaLibrary();
