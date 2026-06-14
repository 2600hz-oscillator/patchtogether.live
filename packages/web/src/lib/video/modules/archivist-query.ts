// packages/web/src/lib/video/modules/archivist-query.ts
//
// ARCHIVIST pure cores — Internet Archive (archive.org) query building,
// response parsing, and per-type best-file selection. NO network, NO DOM:
// every function here is a pure transform so it can be unit-tested hard
// (see archivist-query.test.ts) and reused by the card + e2e mocks.
//
// Feasibility verified 2026-06-14 against the live endpoints — see
// .myrobots/plans/archivist-module-2026-06-14.md. Headline: search +
// metadata are CORS-open; image + audio served files are CORS-clean (real
// downstream outputs); VIDEO served files lack CORS on the final hop, so
// video is play-only (tainted texture, no clean `video` output).

/** The three user-facing media types + a combined "any". The archive.org
 *  `mediatype:` value for video is `movies`, NOT `video` — mapped below. */
export type ArchivistMediaType = 'image' | 'audio' | 'video' | 'any';

/** archive.org's own mediatype token for each of our types. */
export const ARCHIVE_MEDIATYPE: Record<Exclude<ArchivistMediaType, 'any'>, string> = {
  image: 'image',
  audio: 'audio',
  video: 'movies',
};

export const ARCHIVE_SEARCH_BASE = 'https://archive.org/advancedsearch.php';
export const ARCHIVE_METADATA_BASE = 'https://archive.org/metadata';
export const ARCHIVE_DOWNLOAD_BASE = 'https://archive.org/download';
export const ARCHIVE_DETAILS_BASE = 'https://archive.org/details';

/** A parsed search-result row (the subset of fields we request). */
export interface ArchivistDoc {
  identifier: string;
  title: string;
  /** archive.org mediatype token (`image` | `audio` | `movies` | …). */
  mediatype: string;
  /** Publication year, when the item carries one. */
  year?: number;
}

/** Inputs that build a search query. yearFrom/yearTo are optional; when one
 *  or both are set a `year:[A TO B]` clause is added (open-ended uses `*`). */
export interface QuerySpec {
  term: string;
  mediatype: ArchivistMediaType;
  yearFrom?: number | null;
  yearTo?: number | null;
}

/** Clamp a year to a sane archive.org range; returns null for non-finite. */
function sanitizeYear(y: number | null | undefined): number | null {
  if (y == null || !Number.isFinite(y)) return null;
  const n = Math.round(y);
  if (n < 1) return null;
  if (n > 3000) return 3000;
  return n;
}

/**
 * Build the Lucene-style `q=` string (UN-encoded — caller/`buildSearchUrl`
 * encodes). Combines: the free-text term, the `mediatype:` filter (omitted
 * for 'any'), an optional `year:[A TO B]` range, and ALWAYS excludes
 * access-restricted items so the player only ever sees publicly-streamable
 * content (verified: restricted items 401 on the file).
 *
 * An empty term with a mediatype still yields a valid "browse this type"
 * query (`mediatype:audio AND NOT access-restricted-item:true`).
 */
export function buildQueryString(spec: QuerySpec): string {
  const clauses: string[] = [];

  const term = spec.term.trim();
  if (term) {
    // Wrap multi-word terms so they're treated as a phrase-ish group; a
    // single bare word is fine as-is. We don't try to be a full Lucene
    // escaper — archive.org is permissive and the term is user free-text.
    clauses.push(term);
  }

  if (spec.mediatype !== 'any') {
    clauses.push(`mediatype:${ARCHIVE_MEDIATYPE[spec.mediatype]}`);
  }

  const from = sanitizeYear(spec.yearFrom);
  const to = sanitizeYear(spec.yearTo);
  if (from != null || to != null) {
    const a = from != null ? String(from) : '*';
    const b = to != null ? String(to) : '*';
    clauses.push(`year:[${a} TO ${b}]`);
  }

  // Always exclude restricted/lending/DMCA items (publicly-streamable only).
  clauses.push('NOT access-restricted-item:true');

  return clauses.join(' AND ');
}

/** Options for the search URL beyond the query. */
export interface SearchUrlOpts {
  rows?: number;
  /** When true, add `sort[]=random` so results vary each call. */
  random?: boolean;
  /** 1-based result page (advancedsearch uses `page`). */
  page?: number;
}

/**
 * Build the full advancedsearch.php URL. CORS-open, so the browser fetches
 * it directly (no proxy). Requests the minimal field set the card needs.
 */
export function buildSearchUrl(spec: QuerySpec, opts: SearchUrlOpts = {}): string {
  const params = new URLSearchParams();
  params.set('q', buildQueryString(spec));
  for (const fl of ['identifier', 'title', 'year', 'mediatype']) {
    params.append('fl[]', fl);
  }
  if (opts.random) params.append('sort[]', 'random');
  params.set('rows', String(opts.rows ?? 50));
  params.set('page', String(opts.page ?? 1));
  params.set('output', 'json');
  return `${ARCHIVE_SEARCH_BASE}?${params.toString()}`;
}

/** Shape of the advancedsearch.php JSON we consume (subset). */
export interface RawSearchResponse {
  response?: {
    numFound?: number;
    start?: number;
    docs?: Array<{
      identifier?: unknown;
      title?: unknown;
      mediatype?: unknown;
      year?: unknown;
    }>;
  };
}

/**
 * Parse a search response into clean ArchivistDoc rows, dropping any doc
 * without a usable identifier. Tolerant of missing/odd fields (year may be
 * a string, title may be absent → fall back to identifier).
 */
export function parseSearchResponse(raw: RawSearchResponse): ArchivistDoc[] {
  const docs = raw?.response?.docs ?? [];
  const out: ArchivistDoc[] = [];
  for (const d of docs) {
    const identifier = typeof d.identifier === 'string' ? d.identifier : '';
    if (!identifier) continue;
    const title =
      typeof d.title === 'string' && d.title.length > 0 ? d.title : identifier;
    const mediatype = typeof d.mediatype === 'string' ? d.mediatype : '';
    let year: number | undefined;
    if (typeof d.year === 'number' && Number.isFinite(d.year)) year = d.year;
    else if (typeof d.year === 'string' && /^\d{1,4}$/.test(d.year)) year = Number(d.year);
    out.push({ identifier, title, mediatype, year });
  }
  return out;
}

/** numFound from a raw response (0 when absent). */
export function parseNumFound(raw: RawSearchResponse): number {
  const n = raw?.response?.numFound;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/**
 * Pick a random doc from a result page using an injectable RNG (default
 * Math.random) so tests are deterministic. Returns null for an empty list.
 */
export function pickRandomDoc(
  docs: readonly ArchivistDoc[],
  rng: () => number = Math.random,
): ArchivistDoc | null {
  if (docs.length === 0) return null;
  const i = Math.min(docs.length - 1, Math.floor(rng() * docs.length));
  return docs[i] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────
// Metadata → best-file selection (per type)
// ─────────────────────────────────────────────────────────────────────────

/** A file entry from the metadata API (subset). */
export interface ArchiveFile {
  name: string;
  format?: string;
  source?: string; // original | derivative | metadata
}

export interface RawMetadataResponse {
  server?: unknown;
  dir?: unknown;
  metadata?: {
    title?: unknown;
    'access-restricted-item'?: unknown;
    identifier?: unknown;
  };
  is_dark?: unknown;
  files?: Array<{ name?: unknown; format?: unknown; source?: unknown }>;
}

export interface ParsedMetadata {
  server: string;
  dir: string;
  title: string;
  identifier: string;
  restricted: boolean;
  files: ArchiveFile[];
}

/** Parse the metadata response into a clean shape (drops malformed files). */
export function parseMetadata(raw: RawMetadataResponse, fallbackId = ''): ParsedMetadata {
  const server = typeof raw?.server === 'string' ? raw.server : '';
  const dir = typeof raw?.dir === 'string' ? raw.dir : '';
  const m = raw?.metadata ?? {};
  const title = typeof m.title === 'string' ? m.title : fallbackId;
  const identifier = typeof m.identifier === 'string' ? m.identifier : fallbackId;
  const restricted =
    m['access-restricted-item'] === true ||
    m['access-restricted-item'] === 'true' ||
    raw?.is_dark === true ||
    raw?.is_dark === 'true';
  const files: ArchiveFile[] = [];
  for (const f of raw?.files ?? []) {
    const name = typeof f.name === 'string' ? f.name : '';
    if (!name) continue;
    files.push({
      name,
      format: typeof f.format === 'string' ? f.format : undefined,
      source: typeof f.source === 'string' ? f.source : undefined,
    });
  }
  return { server, dir, title, identifier, restricted, files };
}

/** Per-type preferred extensions, best first. */
const PREFERRED_EXT: Record<Exclude<ArchivistMediaType, 'any'>, string[]> = {
  // jpg/png/gif/webp — real picture derivatives.
  image: ['.jpg', '.jpeg', '.png', '.gif', '.webp'],
  // mp3 first (universal VBR MP3 derivative, seekable + small); then ogg.
  // flac/wav last (large — only if nothing lighter exists).
  audio: ['.mp3', '.ogg', '.oga', '.m4a', '.flac', '.wav'],
  // mp4 (h.264) first; webm/ogv as fallbacks.
  video: ['.mp4', '.m4v', '.webm', '.ogv'],
};

/** System/sidecar files we never want to present as the primary media. */
function isSystemFile(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.startsWith('__ia_thumb') ||
    lower.endsWith('_thumb.jpg') ||
    lower.endsWith('_thumb.png') ||
    lower.endsWith('.torrent') ||
    lower.endsWith('_files.xml') ||
    lower.endsWith('_meta.xml') ||
    lower.endsWith('_meta.sqlite') ||
    lower.endsWith('_reviews.xml') ||
    lower.endsWith('.afpk') ||
    lower.endsWith('_spectrogram.png') ||
    lower.endsWith('.itemimage.jpg')
  );
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

/**
 * Pick the best streamable file for a given media type from a metadata file
 * list. Skips system/sidecar + metadata-source files, then ranks by the
 * per-type preferred-extension order (earlier = better). Returns null if no
 * playable file of the type exists.
 *
 * For 'any', the caller should resolve the concrete type from the doc's
 * mediatype first; this function requires a concrete type.
 */
export function pickBestFile(
  files: readonly ArchiveFile[],
  type: Exclude<ArchivistMediaType, 'any'>,
): ArchiveFile | null {
  const prefs = PREFERRED_EXT[type];
  let best: ArchiveFile | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const f of files) {
    if (isSystemFile(f.name)) continue;
    if (f.source === 'metadata') continue;
    const rank = prefs.indexOf(extOf(f.name));
    if (rank < 0) continue; // not a playable ext for this type
    if (rank < bestRank) {
      bestRank = rank;
      best = f;
    }
  }
  return best;
}

/** Map an archive.org mediatype token to our concrete ArchivistMediaType
 *  (movies → video). Returns null for types we don't handle (texts, etc.). */
export function concreteTypeFromMediatype(
  mt: string,
): Exclude<ArchivistMediaType, 'any'> | null {
  switch (mt) {
    case 'image':
      return 'image';
    case 'audio':
    case 'etree': // Live Music Archive (audio)
      return 'audio';
    case 'movies':
      return 'video';
    default:
      return null;
  }
}

/** Build the canonical download URL for an item file (the /download/ path
 *  302-redirects to the CDN; the browser follows it). Each path segment is
 *  encoded (filenames can contain spaces / unicode). */
export function buildDownloadUrl(identifier: string, fileName: string): string {
  const id = encodeURIComponent(identifier);
  // Preserve `/` in nested filenames (some items nest under a subdir) but
  // encode each segment.
  const file = fileName.split('/').map(encodeURIComponent).join('/');
  return `${ARCHIVE_DOWNLOAD_BASE}/${id}/${file}`;
}

/** Build a direct CDN URL from parsed metadata (server+dir), preferred when
 *  available since it skips the 302 hop. Falls back to the /download/ URL
 *  when server/dir are missing. */
export function buildFileUrl(meta: ParsedMetadata, fileName: string): string {
  if (meta.server && meta.dir) {
    const file = fileName.split('/').map(encodeURIComponent).join('/');
    return `https://${meta.server}${meta.dir}/${file}`;
  }
  return buildDownloadUrl(meta.identifier, fileName);
}

/** Build the human-facing archive.org details page URL (attribution link). */
export function buildDetailsUrl(identifier: string): string {
  return `${ARCHIVE_DETAILS_BASE}/${encodeURIComponent(identifier)}`;
}

export const METADATA_URL = (id: string): string =>
  `${ARCHIVE_METADATA_BASE}/${encodeURIComponent(id)}`;

/**
 * Whether a concrete media type can deliver a CLEAN downstream output (the
 * served file carries CORS on the final hop). image + audio = yes; video =
 * no (play-only). Single source of truth so the card + docs + tests agree.
 */
export function hasCleanOutput(type: Exclude<ArchivistMediaType, 'any'>): boolean {
  return type === 'image' || type === 'audio';
}
